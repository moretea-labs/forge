import { describe, expect, test } from 'bun:test';
import { resolveBootstrapCapabilityProviders } from '../../src/runtime/control-plane/bootstrap';
import type { AssistantPluginManifest } from '../../src/runtime/plugins/types';

function manifest(input: { pluginId: string; capabilityId: string; ready: boolean }): AssistantPluginManifest {
  return {
    schemaVersion: 1, manifestVersion: 1, revision: 1, pluginId: input.pluginId, provider: input.pluginId,
    displayName: input.pluginId, pluginVersion: '1.0.0', authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: [] },
    enabled: true, lifecycle: { state: 'enabled' }, health: { state: input.ready ? 'ready' : 'degraded', checkedAt: '2026-09-03T00:00:00.000Z', ready: input.ready, probed: true, errors: [], warnings: [] },
    permissions: [], capabilities: [{ capabilityId: input.capabilityId, title: 'capability', description: 'test', scopes: [], actions: [] }], actions: [], updatedAt: '2026-09-03T00:00:00.000Z',
  };
}

describe('V2 bootstrap semantic capability provider resolution', () => {
  test('prefers a ready installed provider over catalog installation', () => {
    const result = resolveBootstrapCapabilityProviders({
      capabilityIntents: ['computer.observe.v1'],
      installedManifests: [manifest({ pluginId: 'native_computer', capabilityId: 'computer.observe.v1', ready: true })],
      catalog: [{ id: 'desktop_operator', name: 'Desktop Operator', compatible: true, platforms: ['darwin'], semanticCapabilities: ['computer.observe.v1'] }],
    });
    expect(result[0]).toMatchObject({ status: 'ready', providerId: 'native_computer' });
  });

  test('repairs an installed degraded provider before selecting a second provider', () => {
    const result = resolveBootstrapCapabilityProviders({
      capabilityIntents: ['computer.input.v1'],
      installedManifests: [manifest({ pluginId: 'existing_provider', capabilityId: 'computer.input.v1', ready: false })],
      catalog: [{ id: 'desktop_operator', name: 'Desktop Operator', compatible: true, platforms: ['darwin'], semanticCapabilities: ['computer.input.v1'] }],
    });
    expect(result[0]).toMatchObject({ status: 'repairable', providerId: 'existing_provider' });
  });

  test('selects a compatible official provider or reports unsupported without inventing one', () => {
    const catalog = [{ id: 'desktop_operator', name: 'Desktop Operator', compatible: true, platforms: ['darwin' as const], semanticCapabilities: ['computer.capture.v1'] }];
    expect(resolveBootstrapCapabilityProviders({ capabilityIntents: ['computer.capture.v1'], installedManifests: [], catalog })[0]).toMatchObject({ status: 'installable', providerId: 'desktop_operator' });
    expect(resolveBootstrapCapabilityProviders({ capabilityIntents: ['knowledge.telepathy.v9'], installedManifests: [], catalog })[0]).toMatchObject({ status: 'unsupported' });
  });
});
