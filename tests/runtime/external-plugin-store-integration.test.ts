import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
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
