import { describe, expect, test } from 'bun:test';
import { createExternalPluginAdapter } from '../../src/runtime/plugins/external-adapter';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
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

  test('tolerates retired Forge-only pointer actions in a legacy Desktop Operator registration', async () => {
    const base = registration();
    const legacy = registration({
      actions: [
        ...base.actions,
        { ...base.actions[0]!, actionId: 'desktop_pointer_click', title: 'Legacy pointer click', readOnly: false, risk: 'workspace_write', confirmation: 'authorization' },
        { ...base.actions[0]!, actionId: 'desktop_foreground_pointer_click', title: 'Legacy foreground pointer click', readOnly: false, risk: 'workspace_write', confirmation: 'authorization' },
      ],
    });
    const calls: ExternalUnixSocketCallOptions[] = [];
    const adapter = createExternalPluginAdapter(legacy, {
      call: async (options) => {
        calls.push(options);
        return options.method === 'manifest' ? providerManifest() : { observed: true };
      },
    });
    const result = await adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_status', requestId: 'legacy-pointer-registration', args: {}, origin: { surface: 'mcp' },
    });
    expect(result).toEqual({ observed: true });
    expect(calls.map((entry) => entry.method)).toEqual(['manifest', 'execute']);
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

  test('executes Forge-composed foreground pointer interaction through the shared verified activation fallback and a fresh visual revision', async () => {
    const base = registration();
    const foregroundAction = {
      ...base.actions[0]!,
      actionId: 'desktop_foreground_pointer_click',
      title: 'Foreground pointer click',
      description: 'Composite action owned by Forge.',
      readOnly: false,
      risk: 'workspace_write' as const,
      confirmation: 'authorization' as const,
      scopes: ['desktop.interact', 'desktop.capture'],
    };
    const calls: ExternalUnixSocketCallOptions[] = [];
    const fallbackTargets: Array<{ bundleId?: string; appName?: string }> = [];
    let statusReads = 0;
    let sessionOpenCalls = 0;
    const adapter = createExternalPluginAdapter(registration({ actions: [...base.actions, foregroundAction] }), {
      activateAndVerifyFrontmostApplication: async (target) => {
        fallbackTargets.push(target);
        return {
          activated: true, verified: true, bundleId: 'com.google.Chrome', appName: 'Google Chrome',
          activationCommand: ['/usr/bin/open', '-b', 'com.google.Chrome'],
          frontmostQueryCommand: ['/usr/bin/lsappinfo', 'info'],
        };
      },
      call: async (options) => {
        calls.push(options);
        if (options.method === 'manifest') {
          return providerManifest({ actions: ['desktop_status', 'desktop_session_open', 'desktop_screenshot', 'desktop_pointer_click'] });
        }
        const params = options.params as { action?: string; arguments?: Record<string, unknown> } | undefined;
        switch (params?.action) {
          case 'desktop_status':
            statusReads += 1;
            return statusReads === 1
              ? { sessions: [{ interactionId: 'desk-source', bundleIdentifier: 'com.google.Chrome', appName: 'Google Chrome' }], applications: [] }
              : { sessions: [], applications: [{ active: true, terminated: false, bundle_id: 'com.google.Chrome', name: 'Google Chrome' }] };
          case 'desktop_session_open':
            sessionOpenCalls += 1;
            if (sessionOpenCalls === 1) {
              expect(params.arguments).toEqual({ bundle_id: 'com.google.Chrome', launch: false, activate: true });
              throw new AssistantPluginError('APP_ACTIVATION_FAILED', 'Target application did not become frontmost', { retryable: true });
            }
            expect(params.arguments).toEqual({ bundle_id: 'com.google.Chrome', launch: false, activate: false });
            return { interactionId: 'desk-active' };
          case 'desktop_screenshot':
            expect(params.arguments).toMatchObject({ interaction_id: 'desk-active', scope: 'window', window_id: 4159 });
            return { visual_revision: 7, windowId: 4159, artifactPath: '/tmp/shot.png' };
          case 'desktop_pointer_click':
            expect(params.arguments).toEqual({ interaction_id: 'desk-active', window_id: 4159, visual_revision: 7, x: 1663, y: 179 });
            return { clicked: true };
          default:
            throw new Error(`unexpected provider action: ${String(params?.action)}`);
        }
      },
    });

    const result = await adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator',
      actionId: 'desktop_foreground_pointer_click', requestId: 'foreground-click-1',
      args: { interaction_id: 'desk-source', window_id: 4159, x: 1663, y: 179, label: 'bookmarks-organize' },
      origin: { surface: 'mcp' },
    });

    expect(fallbackTargets).toEqual([{ bundleId: 'com.google.Chrome', appName: undefined }]);
    expect(result).toMatchObject({ interactionId: 'desk-active', activationVerified: true, windowId: 4159, visualRevision: 7, click: { clicked: true } });
    expect(calls.slice(1).map((entry) => (entry.params as { action?: string } | undefined)?.action)).toEqual([
      'desktop_status', 'desktop_session_open', 'desktop_session_open', 'desktop_screenshot', 'desktop_pointer_click',
    ]);
  });

  test('re-establishes exact verified foreground at the desktop_key action boundary before sending the key chord', async () => {
    const base = registration();
    const keyAction = {
      ...base.actions[0]!, actionId: 'desktop_key', title: 'Press desktop keys', description: 'Foreground-bound key action.',
      readOnly: false, risk: 'workspace_write' as const, confirmation: 'authorization' as const, scopes: ['desktop.interact'],
    };
    const calls: ExternalUnixSocketCallOptions[] = [];
    const proofTargets: Array<{ bundleId?: string; appName?: string }> = [];
    const adapter = createExternalPluginAdapter(registration({ actions: [...base.actions, keyAction] }), {
      activateAndVerifyFrontmostApplication: async (target) => {
        proofTargets.push(target);
        return { activated: true, verified: true, bundleId: 'com.liguangming.Shadowrocket', appName: 'Shadowrocket', activationCommand: ['/usr/bin/open'], frontmostQueryCommand: ['/usr/bin/lsappinfo'] };
      },
      call: async (options) => {
        calls.push(options);
        if (options.method === 'manifest') return providerManifest({ actions: ['desktop_status', 'desktop_session_open', 'desktop_key'] });
        const params = options.params as { action?: string; arguments?: Record<string, unknown> } | undefined;
        if (params?.action === 'desktop_status') {
          return { sessions: [{ interactionId: 'desk-shadow-source', bundleIdentifier: 'com.liguangming.Shadowrocket', appName: 'Shadowrocket' }] };
        }
        if (params?.action === 'desktop_session_open') {
          expect(params.arguments).toEqual({ bundle_id: 'com.liguangming.Shadowrocket', launch: false, activate: true });
          return { interactionId: 'desk-shadow-active' };
        }
        if (params?.action === 'desktop_key') {
          expect(params.arguments).toEqual({ interaction_id: 'desk-shadow-active', keys: ['ESC'] });
          return { pressed: true };
        }
        throw new Error(`unexpected provider action: ${String(params?.action)}`);
      },
    });

    const result = await adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_key', requestId: 'foreground-key-1',
      args: { interaction_id: 'desk-shadow-source', keys: ['ESC'] }, origin: { surface: 'mcp' },
    });

    expect(result).toEqual({ pressed: true });
    expect(proofTargets).toEqual([{ bundleId: 'com.liguangming.Shadowrocket', appName: undefined }]);
    expect(calls.slice(1).map((entry) => (entry.params as { action?: string } | undefined)?.action)).toEqual([
      'desktop_status', 'desktop_session_open', 'desktop_key',
    ]);
  });

  test('recovers APP_ACTIVATION_FAILED by rebinding first and then requiring exact independent frontmost proof', async () => {
    const base = registration();
    const sessionOpenAction = {
      ...base.actions[0]!, actionId: 'desktop_session_open', title: 'Open desktop session', description: 'Open session.',
      readOnly: false, risk: 'workspace_write' as const, confirmation: 'authorization' as const, scopes: ['desktop.session'],
    };
    const providerArgs: Record<string, unknown>[] = [];
    const fallbackTargets: Array<{ bundleId?: string; appName?: string }> = [];
    let opens = 0;
    const adapter = createExternalPluginAdapter(registration({ actions: [...base.actions, sessionOpenAction] }), {
      activateAndVerifyFrontmostApplication: async (target) => {
        fallbackTargets.push(target);
        return { activated: true, verified: true, bundleId: 'com.vivaldi.Vivaldi', appName: 'Vivaldi', activationCommand: ['/usr/bin/open', '-b', 'com.vivaldi.Vivaldi'], frontmostQueryCommand: ['/usr/bin/lsappinfo', 'info'] };
      },
      call: async (options) => {
        if (options.method === 'manifest') return providerManifest({ actions: ['desktop_status', 'desktop_session_open'] });
        const params = options.params as { action?: string; arguments?: Record<string, unknown> } | undefined;
        if (params?.action === 'desktop_session_open') {
          providerArgs.push(params.arguments ?? {});
          opens += 1;
          if (opens === 1) throw new AssistantPluginError('APP_ACTIVATION_FAILED', 'Target application did not become frontmost', { retryable: true });
          return { interactionId: 'desk-vivaldi' };
        }
        if (params?.action === 'desktop_status') return { applications: [{ active: true, terminated: false, bundle_id: 'com.vivaldi.Vivaldi', name: 'Vivaldi' }] };
        throw new Error(`unexpected provider action: ${String(params?.action)}`);
      },
    });

    const result = await adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_session_open', requestId: 'activate-fallback-success',
      args: { bundle_id: 'com.vivaldi.Vivaldi', launch: false, activate: true }, origin: { surface: 'mcp' },
    });

    expect(result).toEqual({ interactionId: 'desk-vivaldi' });
    expect(fallbackTargets).toEqual([{ bundleId: 'com.vivaldi.Vivaldi', appName: undefined }]);
    expect(providerArgs).toEqual([
      { bundle_id: 'com.vivaldi.Vivaldi', launch: false, activate: true },
      { bundle_id: 'com.vivaldi.Vivaldi', launch: false, activate: false },
    ]);
  });

  test('fails closed when APP_ACTIVATION_FAILED fallback cannot independently verify frontmost identity', async () => {
    const base = registration();
    const sessionOpenAction = { ...base.actions[0]!, actionId: 'desktop_session_open', title: 'Open desktop session', readOnly: false, risk: 'workspace_write' as const, confirmation: 'authorization' as const };
    let providerOpenCalls = 0;
    const adapter = createExternalPluginAdapter(registration({ actions: [...base.actions, sessionOpenAction] }), {
      activateAndVerifyFrontmostApplication: async () => {
        throw new AssistantPluginError('DESKTOP_FALLBACK_ACTIVATION_NOT_CONFIRMED', 'wrong app remained frontmost', { retryable: true });
      },
      call: async (options) => {
        if (options.method === 'manifest') return providerManifest({ actions: ['desktop_status', 'desktop_session_open'] });
        const params = options.params as { action?: string } | undefined;
        if (params?.action === 'desktop_session_open') {
          providerOpenCalls += 1;
          if (providerOpenCalls === 1) {
            throw new AssistantPluginError('APP_ACTIVATION_FAILED', 'Target application did not become frontmost', { retryable: true });
          }
          return { interactionId: 'desk-fallback-failure' };
        }
        throw new Error(`unexpected provider action: ${String(params?.action)}`);
      },
    });

    const promise = adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_session_open', requestId: 'activate-fallback-failure',
      args: { bundle_id: 'com.google.Chrome', launch: false, activate: true }, origin: { surface: 'mcp' },
    });
    await expect(promise).rejects.toThrow('DESKTOP_ACTIVATION_FALLBACK_FAILED');
    expect(providerOpenCalls).toBe(2);
  });

  test('rejects false-positive fallback proof when its verified identity does not match the exact requested application', async () => {
    const base = registration();
    const sessionOpenAction = { ...base.actions[0]!, actionId: 'desktop_session_open', title: 'Open desktop session', readOnly: false, risk: 'workspace_write' as const, confirmation: 'authorization' as const };
    let opens = 0;
    const adapter = createExternalPluginAdapter(registration({ actions: [...base.actions, sessionOpenAction] }), {
      activateAndVerifyFrontmostApplication: async () => ({ activated: true, verified: true, bundleId: 'com.apple.dt.Xcode', appName: 'Xcode', activationCommand: ['/usr/bin/open'], frontmostQueryCommand: ['/usr/bin/lsappinfo'] }),
      call: async (options) => {
        if (options.method === 'manifest') return providerManifest({ actions: ['desktop_status', 'desktop_session_open'] });
        const params = options.params as { action?: string } | undefined;
        if (params?.action === 'desktop_session_open') {
          opens += 1;
          if (opens === 1) throw new AssistantPluginError('APP_ACTIVATION_FAILED', 'Target application did not become frontmost', { retryable: true });
          return { interactionId: 'desk-rebound' };
        }
        throw new Error(`unexpected provider action: ${String(params?.action)}`);
      },
    });

    await expect(adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator', actionId: 'desktop_session_open', requestId: 'activate-fallback-false-positive',
      args: { bundle_id: 'com.google.Chrome', launch: false, activate: true }, origin: { surface: 'mcp' },
    })).rejects.toThrow('DESKTOP_ACTIVATION_FALLBACK_FAILED');
  });

  test('independently proves exact system frontmost identity after the provider reports activated-session success', async () => {
    const base = registration();
    const sessionOpenAction = {
      ...base.actions[0]!,
      actionId: 'desktop_session_open',
      title: 'Open desktop session',
      description: 'Open session.',
      readOnly: false,
      risk: 'workspace_write' as const,
      confirmation: 'authorization' as const,
      scopes: ['desktop.session'],
    };
    const proofTargets: Array<{ bundleId?: string; appName?: string }> = [];
    const providerActions: string[] = [];
    const adapter = createExternalPluginAdapter(registration({ actions: [...base.actions, sessionOpenAction] }), {
      activateAndVerifyFrontmostApplication: async (target) => {
        proofTargets.push(target);
        return { activated: true, verified: true, bundleId: 'com.vivaldi.Vivaldi', appName: 'Vivaldi', activationCommand: ['/usr/bin/open'], frontmostQueryCommand: ['/usr/bin/lsappinfo'] };
      },
      call: async (options) => {
        if (options.method === 'manifest') return providerManifest({ actions: ['desktop_status', 'desktop_session_open'] });
        const params = options.params as { action?: string } | undefined;
        providerActions.push(String(params?.action ?? ''));
        if (params?.action === 'desktop_session_open') return { interactionId: 'desk-new' };
        throw new Error(`unexpected provider action: ${String(params?.action)}`);
      },
    });

    const result = await adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator',
      actionId: 'desktop_session_open', requestId: 'activate-independently-proven',
      args: { bundle_id: 'com.vivaldi.Vivaldi', launch: false, activate: true }, origin: { surface: 'mcp' },
    });

    expect(result).toEqual({ interactionId: 'desk-new' });
    expect(proofTargets).toEqual([{ bundleId: 'com.vivaldi.Vivaldi', appName: undefined }]);
    expect(providerActions).toEqual(['desktop_session_open']);
  });

  test('fails activated desktop session open when independent system frontmost proof cannot be established', async () => {
    const base = registration();
    const sessionOpenAction = {
      ...base.actions[0]!,
      actionId: 'desktop_session_open',
      title: 'Open desktop session',
      description: 'Open session.',
      readOnly: false,
      risk: 'workspace_write' as const,
      confirmation: 'authorization' as const,
      scopes: ['desktop.session'],
    };
    const adapter = createExternalPluginAdapter(registration({ actions: [...base.actions, sessionOpenAction] }), {
      activateAndVerifyFrontmostApplication: async () => {
        throw new AssistantPluginError('DESKTOP_FALLBACK_ACTIVATION_NOT_CONFIRMED', 'wrong app remained frontmost', { retryable: true });
      },
      call: async (options) => {
        if (options.method === 'manifest') return providerManifest({ actions: ['desktop_status', 'desktop_session_open'] });
        const params = options.params as { action?: string } | undefined;
        if (params?.action === 'desktop_session_open') return { interactionId: 'desk-new' };
        throw new Error(`unexpected provider action: ${String(params?.action)}`);
      },
    });

    await expect(adapter.executeAction({
      controllerHome: '/tmp/home', repoId: 'repo', repoRoot: '/tmp/repo', pluginId: 'desktop_operator',
      actionId: 'desktop_session_open', requestId: 'activate-unconfirmed',
      args: { bundle_id: 'com.vivaldi.Vivaldi', launch: false, activate: true }, origin: { surface: 'mcp' },
    })).rejects.toThrow('DESKTOP_ACTIVATION_NOT_CONFIRMED');
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
