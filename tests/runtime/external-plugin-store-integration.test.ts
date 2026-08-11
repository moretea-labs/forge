import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import { buildResendPluginManifest, executeResendPluginAction } from '../../src/runtime/plugins/resend-adapter';
import { createFirstPartyPluginAdapterMap } from '../../src/runtime/plugins/first-party-registry';
import { DEFAULT_REPORT_SINKS } from '../../src/runtime/personal-assistant/reporting-runtime';
import {
  completeResendOAuthLogin,
  getResendOAuthAccessToken,
  prepareResendOAuthLogin,
  resetResendOAuthRuntimeForTest,
  setResendCredentialStoreAdapterForTest,
  type ResendCredentialStoreAdapter,
} from '../../src/runtime/safe-tooling/resend-oauth';
import {
  assistantPluginScope,
  controllerPluginRepository,
  executeAssistantPluginAction,
  getAssistantPluginManifest,
  listAssistantPluginManifests,
} from '../../src/runtime/plugins/store';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(enabled = true) {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-external-store-'));
  roots.push(controllerHome);
  const socketPath = join(controllerHome, 'missing-desktop.sock');
  installExternalPluginRegistration(controllerHome, {
    pluginId: 'desktop_operator',
    providerPluginId: 'desktop_operator',
    displayName: 'Forge Desktop Operator',
    provider: 'local-macos',
    pluginVersion: '0.1.0',
    protocolVersion: '1.0',
    scope: 'controller',
    enabled,
    transport: { kind: 'unix_socket_jsonl', socketPath, healthTimeoutMs: 100, actionTimeoutMs: 500 },
    permissions: [{ scope: 'desktop.observe', mode: 'read', description: 'Observe desktop.', granted: true, required: true }],
    capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
    actions: [{ actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 500, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  return { controllerHome, socketPath, repository: controllerPluginRepository(controllerHome) };
}

async function startExternalProviderFixture(root: string, socketPath: string, logPath: string): Promise<void> {
  const scriptPath = join(root, 'provider.cjs');
  writeFileSync(scriptPath, `
const fs = require('fs');
const net = require('net');
const socketPath = process.argv[2];
const logPath = process.argv[3];
try { fs.unlinkSync(socketPath); } catch (_) {}
const server = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const newline = buffer.indexOf('\\n');
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    fs.appendFileSync(logPath, request.method + '\\n');
    let result;
    if (request.method === 'manifest') {
      result = {
        id: 'desktop_operator', name: 'Forge Desktop Operator', version: '0.1.0',
        protocolVersion: '1.0', mode: 'external', scope: 'controller', provider: 'local-macos',
        capabilities: ['desktop-observe'], actions: ['desktop_status'],
      };
    } else if (request.method === 'health') {
      result = { state: 'ready', warnings: [] };
    } else {
      result = { observed: true };
    }
    socket.end(JSON.stringify({ id: request.id, ok: true, result }) + '\\n');
  });
});
server.listen(socketPath, () => process.stdout.write('ready\\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, [scriptPath, socketPath, logPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('external provider fixture did not start')), 5_000);
    child.once('error', reject);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('ready\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function resendFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-resend-plugin-'));
  roots.push(repoRoot);
  return repoRoot;
}

function memoryResendCredentialStore(): ResendCredentialStoreAdapter & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    available: () => true,
    read: (service, account) => values.get(`${service}:${account}`),
    write: (service, account, value) => { values.set(`${service}:${account}`, value); },
  };
}

function resendAction(repoRoot: string, actionId: string, args: Record<string, unknown> = {}, requestId = `req_${actionId}`) {
  return executeResendPluginAction({
    controllerHome: join(repoRoot, '.controller'),
    repoId: 'repo_test',
    repoRoot,
    pluginId: 'resend',
    actionId,
    requestId,
    args,
    origin: { surface: 'mcp', actor: 'test' },
  });
}

describe('external plugin store integration', () => {
  test('lists trusted external registrations through the existing plugin surface with truthful degraded health', () => {
    const fx = fixture();
    const manifests = listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    const external = manifests.find((manifest) => manifest.pluginId === 'desktop_operator');
    expect(external).toBeDefined();
    expect(external).toMatchObject({
      pluginId: 'desktop_operator',
      displayName: 'Forge Desktop Operator',
      enabled: true,
      lifecycle: { state: 'degraded' },
      health: { ready: false, probed: true },
    });
    expect(assistantPluginScope('desktop_operator', fx.controllerHome)).toBe('controller');
  });

  test('get uses the same external adapter registration rather than a second manifest authority', () => {
    const fx = fixture();
    listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    const manifest = getAssistantPluginManifest(fx.controllerHome, fx.repository, 'desktop_operator');
    expect(manifest.authority.sourceOfTruth[0]).toContain('controllerHome:system/plugins/external/registrations/desktop_operator.json');
    expect(manifest.actions.map((action) => action.actionId)).toEqual(['desktop_status']);
  });

  test('execute resolves a disabled external registration and fails as disabled rather than plugin-not-found', async () => {
    const fx = fixture(false);
    const manifest = getAssistantPluginManifest(fx.controllerHome, fx.repository, 'desktop_operator');
    expect(manifest).toMatchObject({ enabled: false, lifecycle: { state: 'disabled' }, health: { probed: false } });
    await expect(executeAssistantPluginAction({
      controllerHome: fx.controllerHome,
      repoId: fx.repository.repoId,
      repoRoot: fx.repository.canonicalRoot,
      pluginId: 'desktop_operator',
      actionId: 'desktop_status',
      requestId: 'external-store-disabled-1',
      args: {},
      origin: { surface: 'mcp' },
      timeoutMs: 500,
    })).rejects.toThrow('EXTERNAL_PLUGIN_DISABLED');
  });

  test('reuses a fresh live manifest validation on the external action hot path', async () => {
    if (process.platform === 'win32') return;
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-external-hotpath-'));
    roots.push(controllerHome);
    const socketPath = join(controllerHome, 'desktop.sock');
    const logPath = join(controllerHome, 'provider.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);
    installExternalPluginRegistration(controllerHome, {
      pluginId: 'desktop_operator', providerPluginId: 'desktop_operator', displayName: 'Forge Desktop Operator',
      provider: 'local-macos', pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller', enabled: true,
      transport: { kind: 'unix_socket_jsonl', socketPath, healthTimeoutMs: 1_000, actionTimeoutMs: 1_000 },
      permissions: [{ scope: 'desktop.observe', mode: 'read', description: 'Observe desktop.', granted: true, required: true }],
      capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
      actions: [{ actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 1_000, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    });
    const repository = controllerPluginRepository(controllerHome);
    const manifest = getAssistantPluginManifest(controllerHome, repository, 'desktop_operator');
    expect(manifest.health.ready).toBe(true);
    const result = await executeAssistantPluginAction({
      controllerHome,
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
      pluginId: 'desktop_operator',
      actionId: 'desktop_status',
      requestId: 'external-hotpath-1',
      args: {},
      origin: { surface: 'mcp' },
      timeoutMs: 1_000,
    });
    expect(result.result).toMatchObject({ observed: true });
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['manifest', 'health', 'execute']);
  });

  test('built-in adapters retain precedence over colliding external registration IDs in Phase 1', () => {
    const fx = fixture();
    installExternalPluginRegistration(fx.controllerHome, {
      pluginId: 'desktop', providerPluginId: 'desktop_operator', displayName: 'External Collision', provider: 'local-macos', pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller',
      transport: { kind: 'unix_socket_jsonl', socketPath: fx.socketPath, healthTimeoutMs: 100 },
      permissions: [], capabilities: [], actions: [],
    });
    const manifests = listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    const desktop = manifests.find((manifest) => manifest.pluginId === 'desktop');
    expect(desktop?.displayName).toBe('Forge Desktop');
    expect(manifests.filter((manifest) => manifest.pluginId === 'desktop')).toHaveLength(1);
  });
});

describe('Resend first-party plugin', () => {
  test('is registered with strongly confirmed delivery and environment-only credentials', () => {
    const repoRoot = resendFixture();
    const manifest = buildResendPluginManifest(0, undefined, repoRoot);
    expect(createFirstPartyPluginAdapterMap().has('resend')).toBe(true);
    expect(manifest.enabled).toBe(false);
    expect(manifest.authority.sourceOfTruth).toContain('env:FORGE_RESEND_API_KEY|RESEND_API_KEY');
    expect(manifest.actions.find((candidate) => candidate.actionId === 'create_domain')?.confirmation).toBe('authorization');
    const send = manifest.actions.find((candidate) => candidate.actionId === 'send_email');
    expect(send?.confirmation).toBe('strong_confirmation');
    expect(send?.requiredConfirmationText).toBe('send-resend-email');
    expect(DEFAULT_REPORT_SINKS.find((sink) => sink.kind === 'resend_email')?.enabled).toBe(false);
  });

  test('persists only non-secret defaults and derives SMTP readiness from domain verification', async () => {
    const repoRoot = resendFixture();
    await resendAction(repoRoot, 'configure', {
      enabled: true,
      provider: 'mock',
      sending_domain: 'updates.example.com',
      from_email: 'forge@updates.example.com',
      from_name: 'Forge',
    });
    const configText = readFileSync(join(repoRoot, '.forge/plugins/resend.json'), 'utf8');
    expect(configText).toContain('updates.example.com');
    expect(configText).not.toContain('apiKey');
    expect(configText).not.toContain('password');

    const smtp = await resendAction(repoRoot, 'smtp_status');
    expect(smtp.ready).toBe(true);
    expect(smtp.domainStatus).toBe('verified');
    expect((smtp.smtp as Record<string, unknown>).host).toBe('smtp.resend.com');
    expect((smtp.smtp as Record<string, unknown>).username).toBe('resend');
  });

  test('adds the mandatory User-Agent to direct Resend API requests', async () => {
    const repoRoot = resendFixture();
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.FORGE_RESEND_API_KEY;
    let observedUserAgent: string | undefined;
    process.env.FORGE_RESEND_API_KEY = 're_test_key';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedUserAgent = headers.get('User-Agent') ?? undefined;
      return new Response(JSON.stringify({ object: 'list', has_more: false, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await resendAction(repoRoot, 'configure', { enabled: true, provider: 'resend-api' });
      await resendAction(repoRoot, 'list_domains');
      expect(observedUserAgent).toBe('Forge-Resend-Plugin/1.0.0');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.FORGE_RESEND_API_KEY;
      else process.env.FORGE_RESEND_API_KEY = originalKey;
    }
  });

  test('uses Resend OAuth PKCE with rotating Keychain refresh credentials and never returns token material', async () => {
    const repoRoot = resendFixture();
    const controllerHome = join(repoRoot, '.controller');
    const store = memoryResendCredentialStore();
    const originalFetch = globalThis.fetch;
    const originalForgeKey = process.env.FORGE_RESEND_API_KEY;
    const originalResendKey = process.env.RESEND_API_KEY;
    setResendCredentialStoreAdapterForTest(store);
    delete process.env.FORGE_RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    let refreshCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/oauth/register')) return Response.json({ client_id: 'client-123', scope: 'full_access' });
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
    try {
      const prepared = await prepareResendOAuthLogin(controllerHome);
      expect(prepared.pkce).toBe(true);
      expect(prepared.dynamicClientRegistration).toBe(true);
      expect(JSON.stringify(prepared)).not.toContain('codeVerifier');
      const authorizationUrl = new URL(String(prepared.authorizationUrl));
      expect(authorizationUrl.searchParams.get('scope')).toBe('full_access');
      const state = authorizationUrl.searchParams.get('state');
      const completed = await completeResendOAuthLogin(controllerHome, { state: state ?? undefined, code: 'authorization-code' });
      expect(completed.authenticated).toBe(true);
      expect(JSON.stringify(completed)).not.toContain('access-1');
      expect(JSON.stringify(completed)).not.toContain('refresh-1');
      setResendCredentialStoreAdapterForTest(store);
      const refreshed = await getResendOAuthAccessToken();
      expect(refreshed?.token).toBe('access-2');
      expect(refreshCalls).toBe(1);
      expect([...store.values.values()].some((value) => value.includes('refresh-2'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      resetResendOAuthRuntimeForTest();
      if (originalForgeKey === undefined) delete process.env.FORGE_RESEND_API_KEY; else process.env.FORGE_RESEND_API_KEY = originalForgeKey;
      if (originalResendKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalResendKey;
    }
  });

  test('stores a sending-only SMTP key in Keychain and uses an idempotency key for live sends', async () => {
    const repoRoot = resendFixture();
    const store = memoryResendCredentialStore();
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.FORGE_RESEND_API_KEY;
    setResendCredentialStoreAdapterForTest(store);
    process.env.FORGE_RESEND_API_KEY = 're_admin_test';
    let observedIdempotencyKey: string | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api-keys')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.permission).toBe('sending_access');
        return Response.json({ id: 'smtp-key-id', token: 're_smtp_secret' });
      }
      if (url.endsWith('/domains')) return Response.json({ data: [{ id: 'domain-1', name: 'updates.example.com', status: 'verified' }] });
      if (url.endsWith('/emails')) {
        observedIdempotencyKey = new Headers(init?.headers).get('Idempotency-Key') ?? undefined;
        return Response.json({ id: 'email-123' });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      await resendAction(repoRoot, 'configure', { enabled: true, provider: 'resend-api', sending_domain: 'updates.example.com', from_email: 'forge@updates.example.com' });
      const provisioned = await resendAction(repoRoot, 'provision_smtp_credential', { name: 'Forge SMTP' });
      expect(provisioned.stored).toBe(true);
      expect(JSON.stringify(provisioned)).not.toContain('re_smtp_secret');
      expect([...store.values.values()].some((value) => value.includes('re_smtp_secret'))).toBe(true);
      const smtp = await resendAction(repoRoot, 'smtp_status');
      expect(smtp.ready).toBe(true);
      const sent = await resendAction(repoRoot, 'send_email', { to: ['receiver@example.com'], subject: 'Daily report', text: 'Status OK' }, 'daily-report-2026-08-09');
      expect(sent.status).toBe('sent');
      expect(observedIdempotencyKey).toBe('forge-resend-daily-report-2026-08-09');
    } finally {
      globalThis.fetch = originalFetch;
      resetResendOAuthRuntimeForTest();
      if (originalKey === undefined) delete process.env.FORGE_RESEND_API_KEY; else process.env.FORGE_RESEND_API_KEY = originalKey;
    }
  });

  test('returns a sent receipt and lets callers verify the provider event', async () => {
    const repoRoot = resendFixture();
    await resendAction(repoRoot, 'configure', {
      enabled: true,
      provider: 'mock',
      sending_domain: 'updates.example.com',
      from_email: 'forge@updates.example.com',
    });
    const sent = await resendAction(repoRoot, 'send_email', {
      to: ['recipient@example.com'],
      subject: 'Forge daily report test',
      text: 'Runtime ready.',
    });
    expect(sent.status).toBe('sent');
    expect(sent.emailId).toBe('email_mock');

    const receipt = await resendAction(repoRoot, 'get_email', { email_id: sent.emailId });
    expect(receipt.status).toBe('sent');
  });
});
