import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeResendPluginAction } from '../../src/runtime/plugins/resend-adapter';
import {
  completeResendOAuthLogin,
  getResendOAuthAccessToken,
  prepareResendOAuthLogin,
  resetResendOAuthRuntimeForTest,
  setResendCredentialStoreAdapterForTest,
  type ResendCredentialStoreAdapter,
} from '../../src/runtime/safe-tooling/resend-oauth';

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const originalForgeKey = process.env.FORGE_RESEND_API_KEY;
const originalResendKey = process.env.RESEND_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetResendOAuthRuntimeForTest();
  if (originalForgeKey === undefined) delete process.env.FORGE_RESEND_API_KEY;
  else process.env.FORGE_RESEND_API_KEY = originalForgeKey;
  if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendKey;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { repoRoot: string; controllerHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-resend-oauth-'));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  const controllerHome = join(root, 'controller');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(controllerHome, { recursive: true });
  return { repoRoot, controllerHome };
}

function memoryCredentialStore(): ResendCredentialStoreAdapter & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    available: () => true,
    read: (service, account) => values.get(`${service}:${account}`),
    write: (service, account, value) => { values.set(`${service}:${account}`, value); },
  };
}

function pluginAction(repoRoot: string, controllerHome: string, actionId: string, args: Record<string, unknown>, requestId = `test-${actionId}`) {
  return executeResendPluginAction({
    controllerHome,
    repoId: 'repo-test',
    repoRoot,
    pluginId: 'resend',
    actionId,
    requestId,
    args,
    origin: { surface: 'mcp', actor: 'test' },
  });
}

describe('Resend OAuth + SMTP credentials', () => {
  test('uses dynamic registration + PKCE and stores rotating refresh credentials without returning tokens', async () => {
    const { controllerHome } = fixture();
    const store = memoryCredentialStore();
    setResendCredentialStoreAdapterForTest(store);
    delete process.env.FORGE_RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    let refreshCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/oauth/register')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.token_endpoint_auth_method).toBe('none');
        expect(body.scope).toBe('full_access');
        return Response.json({ client_id: 'client-123', scope: 'full_access' });
      }
      if (url.endsWith('/oauth/token')) {
        const body = new URLSearchParams(String(init?.body ?? ''));
        if (body.get('grant_type') === 'authorization_code') {
          expect(body.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
          return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900, scope: 'full_access' });
        }
        refreshCalls += 1;
        expect(body.get('refresh_token')).toBe('refresh-1');
        return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900, scope: 'full_access' });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const prepared = await prepareResendOAuthLogin(controllerHome);
    expect(prepared.readyToOpenBrowser).toBe(true);
    expect(prepared.pkce).toBe(true);
    expect(prepared.dynamicClientRegistration).toBe(true);
    expect(JSON.stringify(prepared)).not.toContain('codeVerifier');
    expect(JSON.stringify(prepared)).not.toContain('refresh-');
    const authorizationUrl = new URL(String(prepared.authorizationUrl));
    expect(authorizationUrl.origin).toBe('https://api.resend.com');
    expect(authorizationUrl.pathname).toBe('/oauth/authorize');
    expect(authorizationUrl.searchParams.get('scope')).toBe('full_access');
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const completed = await completeResendOAuthLogin(controllerHome, { state: state ?? undefined, code: 'authorization-code' });
    expect(completed.authenticated).toBe(true);
    expect(completed.refreshCredentialStored).toBe(true);
    expect(JSON.stringify(completed)).not.toContain('access-1');
    expect(JSON.stringify(completed)).not.toContain('refresh-1');

    // Reset only the in-memory access cache so the next lookup proves refresh-token rotation.
    setResendCredentialStoreAdapterForTest(store);
    const refreshed = await getResendOAuthAccessToken();
    expect(refreshed?.token).toBe('access-2');
    expect(refreshCalls).toBe(1);
    const storedJson = [...store.values.values()].find((value) => value.includes('refresh-2'));
    expect(storedJson).toContain('client-123');
  });

  test('provisions a sending-only SMTP key directly into the credential store and sends idempotently', async () => {
    const { repoRoot, controllerHome } = fixture();
    const store = memoryCredentialStore();
    setResendCredentialStoreAdapterForTest(store);
    process.env.FORGE_RESEND_API_KEY = 're_admin_test';
    delete process.env.RESEND_API_KEY;
    let observedIdempotencyKey: string | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api-keys')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.permission).toBe('sending_access');
        return Response.json({ id: 'smtp-key-id', token: 're_smtp_secret' });
      }
      if (url.endsWith('/domains')) {
        return Response.json({ object: 'list', data: [{ id: 'domain-1', name: 'updates.example.com', status: 'verified' }] });
      }
      if (url.endsWith('/emails')) {
        observedIdempotencyKey = new Headers(init?.headers).get('Idempotency-Key') ?? undefined;
        return Response.json({ id: 'email-123' });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    await pluginAction(repoRoot, controllerHome, 'configure', {
      enabled: true,
      provider: 'resend-api',
      sending_domain: 'updates.example.com',
      from_email: 'forge@updates.example.com',
      from_name: 'Forge',
    });
    const provisioned = await pluginAction(repoRoot, controllerHome, 'provision_smtp_credential', { name: 'Forge SMTP' });
    expect(provisioned.stored).toBe(true);
    expect(provisioned.apiKeyId).toBe('smtp-key-id');
    expect(JSON.stringify(provisioned)).not.toContain('re_smtp_secret');
    expect([...store.values.values()].some((value) => value.includes('re_smtp_secret'))).toBe(true);

    const smtp = await pluginAction(repoRoot, controllerHome, 'smtp_status', {});
    expect(smtp.ready).toBe(true);
    expect(JSON.stringify(smtp)).not.toContain('re_smtp_secret');

    const sent = await pluginAction(repoRoot, controllerHome, 'send_email', {
      to: ['receiver@example.com'], subject: 'Daily report', text: 'Status OK',
    }, 'daily-report-2026-08-09');
    expect(sent.status).toBe('sent');
    expect(sent.emailId).toBe('email-123');
    expect(observedIdempotencyKey).toBe('forge-resend-daily-report-2026-08-09');
  });
});
