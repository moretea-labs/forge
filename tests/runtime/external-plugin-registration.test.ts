import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getExternalPluginRegistration,
  installExternalPluginRegistration,
  listExternalPluginRegistrations,
  type ExternalPluginRegistrationInput,
} from '../../src/runtime/plugins/external-registration';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-external-plugin-reg-'));
  roots.push(root);
  return root;
}

function registration(overrides: Partial<ExternalPluginRegistrationInput> = {}): ExternalPluginRegistrationInput {
  return {
    pluginId: 'desktop_operator',
    providerPluginId: 'desktop_operator',
    displayName: 'Forge Desktop Operator',
    provider: 'local-macos',
    pluginVersion: '0.1.0',
    protocolVersion: '1.0',
    scope: 'controller',
    enabled: true,
    transport: { kind: 'unix_socket_jsonl', socketPath: '/tmp/forge-desktop-operator.sock' },
    permissions: [
      { scope: 'desktop.observe', mode: 'read', description: 'Observe desktop state.', granted: true, required: true },
      { scope: 'desktop.interact', mode: 'write', description: 'Interact with desktop UI.', granted: true, required: false },
    ],
    capabilities: [
      { capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop UI.', scopes: ['desktop.observe'], actions: ['desktop_status'] },
      { capabilityId: 'desktop-interact', title: 'Desktop interact', description: 'Interact with desktop UI.', scopes: ['desktop.interact'], actions: ['desktop_press'] },
    ],
    actions: [
      { actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 2_000, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { actionId: 'desktop_press', title: 'Desktop press', description: 'Press one element.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10_000, cancellable: true, idempotent: false, scopes: ['desktop.interact'], resourceClaims: [{ resource: 'workspace', mode: 'write' }], argumentsSchema: { type: 'object' } },
    ],
    ...overrides,
  };
}

describe('external plugin registration store', () => {
  test('persists a normalized trusted registration with a stable fingerprint', () => {
    const controllerHome = home();
    const stored = installExternalPluginRegistration(controllerHome, registration(), { now: new Date('2026-08-08T00:00:00.000Z') });
    expect(stored).toMatchObject({ schemaVersion: 1, revision: 1, pluginId: 'desktop_operator', displayName: 'Forge Desktop Operator', scope: 'controller' });
    expect(stored.registrationFingerprint).toHaveLength(64);
    expect(getExternalPluginRegistration(controllerHome, 'desktop_operator')).toEqual(stored);
    expect(listExternalPluginRegistrations(controllerHome)).toEqual([stored]);
  });

  test('persists verified LaunchAgent lifecycle identity and reserves lifecycle policy ids for Forge', () => {
    const controllerHome = home();
    const lifecycle = { kind: 'verified_user_launch_agent' as const, label: 'com.moretea.desktop-operator', expectedProgramContains: 'forge-desktop-operator' };
    const stored = installExternalPluginRegistration(controllerHome, registration({ lifecycle }));
    expect(stored.lifecycle).toEqual(lifecycle);
    expect(() => installExternalPluginRegistration(controllerHome, registration({
      lifecycle,
      permissions: [...registration().permissions, { scope: 'external-provider.lifecycle', mode: 'write', description: 'reserved', granted: true, required: false }],
    }))).toThrow('EXTERNAL_PLUGIN_LIFECYCLE_SCOPE_RESERVED');
    expect(() => installExternalPluginRegistration(controllerHome, registration({
      lifecycle,
      actions: [...registration().actions, { actionId: 'provider_restart', title: 'Reserved', description: 'reserved', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 1_000, cancellable: true, idempotent: false, scopes: ['desktop.interact'], resourceClaims: [], argumentsSchema: { type: 'object' } }],
    }))).toThrow('EXTERNAL_PLUGIN_LIFECYCLE_ACTION_RESERVED');
  });

  test('uses optimistic revision checks for trusted registration replacement', () => {
    const controllerHome = home();
    installExternalPluginRegistration(controllerHome, registration(), { now: new Date('2026-08-08T00:00:00.000Z') });
    expect(() => installExternalPluginRegistration(controllerHome, registration({ pluginVersion: '0.2.0' }), { expectedRevision: 0 })).toThrow('EXTERNAL_PLUGIN_REGISTRATION_REVISION_CONFLICT');
    const updated = installExternalPluginRegistration(controllerHome, registration({ pluginVersion: '0.2.0' }), { expectedRevision: 1, now: new Date('2026-08-08T00:01:00.000Z') });
    expect(updated.revision).toBe(2);
    expect(updated.pluginVersion).toBe('0.2.0');
  });

  test('rejects relative sockets and policy-incomplete capability/action contracts', () => {
    const controllerHome = home();
    expect(() => installExternalPluginRegistration(controllerHome, registration({
      transport: { kind: 'unix_socket_jsonl', socketPath: 'relative.sock' },
    }))).toThrow('EXTERNAL_PLUGIN_SOCKET_PATH_INVALID');
    expect(() => installExternalPluginRegistration(controllerHome, registration({
      capabilities: [{ capabilityId: 'broken', title: 'Broken', description: 'Broken.', scopes: ['desktop.observe'], actions: ['missing_action'] }],
    }))).toThrow('EXTERNAL_PLUGIN_CAPABILITY_ACTION_UNKNOWN');
  });

  test('requires strong confirmation for destructive actions and consistent read-only risk', () => {
    const controllerHome = home();
    expect(() => installExternalPluginRegistration(controllerHome, registration({
      actions: [{ actionId: 'destroy', title: 'Destroy', description: 'Destroy.', readOnly: false, risk: 'destructive', confirmation: 'authorization', defaultTimeoutMs: 1_000, cancellable: false, idempotent: false, scopes: ['desktop.interact'], resourceClaims: [], argumentsSchema: { type: 'object' } }],
      capabilities: [],
    }))).toThrow('EXTERNAL_PLUGIN_DESTRUCTIVE_CONFIRMATION_REQUIRED');
    expect(() => installExternalPluginRegistration(controllerHome, registration({
      actions: [{ actionId: 'bad_read', title: 'Bad read', description: 'Bad read.', readOnly: true, risk: 'workspace_write', confirmation: 'none', defaultTimeoutMs: 1_000, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object' } }],
      capabilities: [],
    }))).toThrow('EXTERNAL_PLUGIN_ACTION_RISK_INVALID');
  });
});
