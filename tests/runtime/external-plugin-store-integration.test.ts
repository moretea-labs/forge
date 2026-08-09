import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import { buildResendPluginManifest, executeResendPluginAction } from '../../src/runtime/plugins/resend-adapter';
import { createFirstPartyPluginAdapterMap } from '../../src/runtime/plugins/first-party-registry';
import { DEFAULT_REPORT_SINKS } from '../../src/runtime/personal-assistant/reporting-runtime';
import {
  assistantPluginScope,
  controllerPluginRepository,
  executeAssistantPluginAction,
  getAssistantPluginManifest,
  listAssistantPluginManifests,
} from '../../src/runtime/plugins/store';

const roots: string[] = [];
afterEach(() => {
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

function resendFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-resend-plugin-'));
  roots.push(repoRoot);
  return repoRoot;
}

function resendAction(repoRoot: string, actionId: string, args: Record<string, unknown> = {}) {
  return executeResendPluginAction({
    controllerHome: join(repoRoot, '.controller'),
    repoId: 'repo_test',
    repoRoot,
    pluginId: 'resend',
    actionId,
    requestId: `req_${actionId}`,
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
