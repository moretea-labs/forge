import { describe, expect, test } from 'bun:test';
import { createExternalPluginAdapter } from '../../src/runtime/plugins/external-adapter';
import type { ExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import type { ExternalUnixSocketCallOptions } from '../../src/runtime/plugins/external-unix-socket';

function registration(overrides: Partial<ExternalPluginRegistration> = {}): ExternalPluginRegistration {
  return {
    schemaVersion: 1,
    revision: 1,
    pluginId: 'desktop_operator',
    providerPluginId: 'desktop_operator',
    displayName: 'Forge Desktop Operator',
    provider: 'local-macos',
    pluginVersion: '0.1.0',
    protocolVersion: '1.0',
    scope: 'controller',
    enabled: true,
    transport: { kind: 'unix_socket_jsonl', socketPath: '/tmp/desktop.sock', maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, healthTimeoutMs: 2_000, actionTimeoutMs: 30_000 },
    permissions: [{ scope: 'desktop.observe', mode: 'read', description: 'Observe desktop.', granted: true, required: true }],
    capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
    actions: [{ actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 2_000, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object' } }],
    legacyIdentities: [],
    registrationFingerprint: 'f'.repeat(64),
    installedAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...overrides,
  };
}

function providerManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'desktop_operator',
    name: 'Forge Desktop Operator',
    version: '0.1.0',
    protocolVersion: '1.0',
    mode: 'external',
    scope: 'controller',
    provider: 'local-macos',
    capabilities: ['desktop.status'],
    actions: ['desktop_status'],
    ...overrides,
  };
}

describe('external plugin adapter', () => {
  test('derives ready Forge manifest policy from registration while provider proves identity and health', () => {
    const adapter = createExternalPluginAdapter(registration(), {
      now: () => new Date('2026-08-08T01:00:00.000Z'),
      probe: (options) => options.method === 'manifest'
        ? providerManifest()
        : { state: 'ready', warnings: [], accessibilityTrusted: true },
    });
    const manifest = adapter.buildManifest(0);
    expect(manifest).toMatchObject({
      pluginId: 'desktop_operator',
      displayName: 'Forge Desktop Operator',
      enabled: true,
      lifecycle: { state: 'enabled' },
      health: { state: 'ready', ready: true, probed: true },
      actions: [{ actionId: 'desktop_status', risk: 'readonly', confirmation: 'none' }],
    });
    expect(manifest.authority.sourceOfTruth[0]).toContain('controllerHome:system/plugins/external/registrations/desktop_operator.json');
  });

  test('keeps provider transport/identity failure visible as degraded health instead of hiding the plugin', () => {
    const adapter = createExternalPluginAdapter(registration(), {
      now: () => new Date('2026-08-08T01:00:00.000Z'),
      probe: () => { throw new Error('EXTERNAL_PLUGIN_SOCKET_UNAVAILABLE: missing socket'); },
    });
    const manifest = adapter.buildManifest(0);
    expect(manifest.lifecycle.state).toBe('degraded');
    expect(manifest.health.ready).toBe(false);
    expect(manifest.health.errors[0]).toContain('EXTERNAL_PLUGIN_SOCKET_UNAVAILABLE');
  });

  test('fails provider identity/version/action drift before execution', async () => {
    const calls: ExternalUnixSocketCallOptions[] = [];
    const adapter = createExternalPluginAdapter(registration(), {
      call: async (options) => {
        calls.push(options);
        return providerManifest({ version: '0.2.0' });
      },
    });
    await expect(adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_status', requestId: 'request-1', args: {}, origin: { surface: 'mcp' },
    })).rejects.toThrow('EXTERNAL_PLUGIN_VERSION_MISMATCH');
    expect(calls).toHaveLength(1);
  });

  test('injects and executes registration-bound provider lifecycle without calling a stopped provider', async () => {
    const lifecycle = { kind: 'verified_user_launch_agent' as const, label: 'com.moretea.desktop-operator', expectedProgramContains: 'forge-desktop-operator' };
    const lifecycleCalls: string[] = [];
    const providerCalls: ExternalUnixSocketCallOptions[] = [];
    const adapter = createExternalPluginAdapter(registration({ lifecycle }), {
      probe: () => { throw new Error('provider is currently stopped'); },
      call: async (options) => { providerCalls.push(options); throw new Error('provider should not be called for lifecycle actions'); },
      startVerifiedUserLaunchAgent: (label, expected) => { lifecycleCalls.push(`start:${label}:${expected}`); return { started: true }; },
      stopVerifiedUserLaunchAgent: (label, expected) => { lifecycleCalls.push(`stop:${label}:${expected}`); return { stopped: true }; },
      restartVerifiedUserLaunchAgent: (label, expected) => { lifecycleCalls.push(`restart:${label}:${expected}`); return { restarted: true }; },
    });
    const manifest = adapter.buildManifest(0);
    expect(manifest.lifecycle.state).toBe('degraded');
    expect(manifest.permissions).toContainEqual(expect.objectContaining({ scope: 'external-provider.lifecycle', mode: 'write' }));
    expect(manifest.capabilities).toContainEqual(expect.objectContaining({ capabilityId: 'external-provider-lifecycle' }));
    expect(manifest.actions.map((action) => action.actionId)).toEqual(expect.arrayContaining(['provider_start', 'provider_stop', 'provider_restart']));

    expect(await adapter.executeAction({ controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'provider_start', requestId: 'lifecycle-1', args: {}, origin: { surface: 'mcp' } })).toEqual({ started: true });
    expect(await adapter.executeAction({ controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'provider_restart', requestId: 'lifecycle-2', args: {}, origin: { surface: 'mcp' } })).toEqual({ restarted: true });
    expect(lifecycleCalls).toEqual([
      'start:com.moretea.desktop-operator:forge-desktop-operator',
      'restart:com.moretea.desktop-operator:forge-desktop-operator',
    ]);
    expect(providerCalls).toHaveLength(0);
  });

  test('routes supported execution only after provider manifest validation', async () => {
    const calls: ExternalUnixSocketCallOptions[] = [];
    const adapter = createExternalPluginAdapter(registration(), {
      call: async (options) => {
        calls.push(options);
        return options.method === 'manifest' ? providerManifest() : { observed: true };
      },
    });
    const result = await adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_status', requestId: 'request-2', args: {}, origin: { surface: 'mcp' },
    });
    expect(result).toEqual({ observed: true });
    expect(calls.map((entry) => entry.method)).toEqual(['manifest', 'execute']);
    expect(calls[1]?.params).toEqual({ action: 'desktop_status', arguments: {} });
  });

  test('reuses same-call live provider identity proof without a duplicate manifest round trip', async () => {
    const calls: ExternalUnixSocketCallOptions[] = [];
    const adapter = createExternalPluginAdapter(registration(), {
      call: async (options) => {
        calls.push(options);
        return { observed: true };
      },
    });
    const result = await adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_status', requestId: 'request-3', args: {}, origin: { surface: 'mcp' }, providerIdentityPrevalidated: true,
    });
    expect(result).toEqual({ observed: true });
    expect(calls.map((entry) => entry.method)).toEqual(['execute']);
    expect(adapter.shouldRefreshManifestAfterAction?.('desktop_status')).toBe(false);
    expect(adapter.shouldRefreshManifestAfterAction?.('provider_restart')).toBe(true);
  });
});
