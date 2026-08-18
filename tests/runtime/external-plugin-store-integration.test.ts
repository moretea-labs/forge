import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { installExternalPluginRegistration, type ExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import { createExternalPluginAdapter } from '../../src/runtime/plugins/external-adapter';
import { registerRepository } from '../../src/cli/repositories/registry';
import { getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { finalizeGoalWorkloop, startGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
import { buildResendPluginManifest, executeResendPluginAction } from '../../src/runtime/plugins/resend-adapter';
import { createFirstPartyPluginAdapterMap } from '../../src/runtime/plugins/first-party-registry';
import { DEFAULT_REPORT_SINKS } from '../../src/runtime/personal-assistant/reporting-runtime';
import { getPluginActionCapabilitySchema } from '../../src/runtime/control-plane/facade/capability-registry';
import { buildPluginManagementManifest } from '../../src/runtime/plugins/plugin-management-adapter';
import {
  findActivePluginCapabilityAuthorization,
  recordPluginCapabilityAuthorization,
} from '../../src/runtime/plugins/capability-authorization-grants';
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
  clearAssistantPluginManifestCacheForTest,
  controllerPluginRepository,
  executeAssistantPluginAction,
  getAssistantPluginManifest,
  listAssistantPluginManifests,
  submitAssistantPluginAction,
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

async function startExternalProviderFixture(root: string, socketPath: string, logPath: string, driftPath?: string): Promise<void> {
  const scriptPath = join(root, 'provider.cjs');
  writeFileSync(scriptPath, `
const fs = require('fs');
const net = require('net');
const socketPath = process.argv[2];
const logPath = process.argv[3];
const driftPath = process.argv[4];
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
        id: 'desktop_operator', name: 'Forge Desktop Operator', version: fs.existsSync(driftPath) ? '0.2.0' : '0.1.0',
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
  const child = spawn(process.execPath, [scriptPath, socketPath, logPath, ...(driftPath ? [driftPath] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('plugin management external registration lifecycle', () => {
  test('previews, installs, probes, executes, updates, disables, and removes through typed plugin actions', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plugin-management-'));
    roots.push(controllerHome);
    const socketPath = join(controllerHome, 'provider.sock');
    const logPath = join(controllerHome, 'provider.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);
    const repository = controllerPluginRepository(controllerHome);
    const registration = {
      pluginId: 'desktop_operator', providerPluginId: 'desktop_operator', displayName: 'Forge Desktop Operator', provider: 'local-macos',
      pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller' as const, enabled: true,
      transport: { kind: 'unix_socket_jsonl' as const, socketPath, healthTimeoutMs: 1_000, actionTimeoutMs: 2_000 },
      permissions: [{ scope: 'desktop.observe', mode: 'read' as const, description: 'Observe desktop.', granted: true, required: true }],
      capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
      actions: [{ actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly' as const, confirmation: 'none' as const, defaultTimeoutMs: 500, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    };

    const manager = getAssistantPluginManifest(controllerHome, repository, 'plugin_management');
    expect(manager.health).toMatchObject({ state: 'ready', ready: true });
    expect(manager.actions.map((action) => action.actionId)).toEqual(expect.arrayContaining([
      'preview_registration', 'install_registration', 'list_registrations', 'get_registration', 'disable_registration', 'remove_registration',
    ]));

    const preview = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'preview_registration', requestId: 'plugin-management-preview', args: { registration }, origin: { surface: 'mcp', actor: 'test' },
    });
    expect((preview.result!.result as Record<string, unknown>).preview).toMatchObject({ pluginId: 'desktop_operator', currentRevision: 0, nextRevision: 1, wouldChange: true });

    const installed = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'install_registration', requestId: 'plugin-management-install', args: { registration, expected_revision: 0 },
      confirmAuthorization: true, confirmationText: 'install external registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((installed.result!.result as Record<string, unknown>).registration).toMatchObject({ pluginId: 'desktop_operator', revision: 1, enabled: true });

    const listed = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'list_registrations', requestId: 'plugin-management-list', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(((listed.result!.result as Record<string, unknown>).registrations as Array<{ pluginId: string }>).map((entry) => entry.pluginId)).toContain('desktop_operator');
    const externalManifest = getAssistantPluginManifest(controllerHome, repository, 'desktop_operator');
    expect(externalManifest.health).toMatchObject({ state: 'ready', ready: true });
    const action = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'desktop_operator', actionId: 'desktop_status', requestId: 'plugin-management-execute', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(action.result!.result).toMatchObject({ observed: true });

    const updatedRegistration = { ...registration, displayName: 'Forge Desktop Operator Updated' };
    const updated = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'install_registration', requestId: 'plugin-management-update', args: { registration: updatedRegistration, expected_revision: 1 },
      confirmAuthorization: true, confirmationText: 'update external registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((updated.result!.result as Record<string, unknown>).registration).toMatchObject({ revision: 2, displayName: 'Forge Desktop Operator Updated' });
    await expect(submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'install_registration', requestId: 'plugin-management-stale-update',
      args: { registration: { ...updatedRegistration, displayName: 'Stale writer' }, expected_revision: 1 },
      confirmAuthorization: true, confirmationText: 'stale update', origin: { surface: 'mcp', actor: 'test' },
    })).rejects.toThrow('EXTERNAL_PLUGIN_REGISTRATION_REVISION_CONFLICT');

    const disabled = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'disable_registration', requestId: 'plugin-management-disable', args: { plugin_id: 'desktop_operator', expected_revision: 2 },
      confirmAuthorization: true, confirmationText: 'disable external registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((disabled.result!.result as Record<string, unknown>).registration).toMatchObject({ revision: 3, enabled: false });
    expect(getAssistantPluginManifest(controllerHome, repository, 'desktop_operator').enabled).toBe(false);

    const removed = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'remove_registration', requestId: 'plugin-management-remove', args: { plugin_id: 'desktop_operator', expected_revision: 3 },
      confirmAuthorization: true, confirmationText: 'remove-external-plugin-registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((removed.result!.result as Record<string, unknown>).removed).toMatchObject({ pluginId: 'desktop_operator', revision: 3 });
    const after = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'list_registrations', requestId: 'plugin-management-list-after-remove', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect((after.result!.result as Record<string, unknown>).registrations).toEqual([]);
  });
});

describe('plugin capability authorization management', () => {
  test('lists/revokes only the current principal and keeps strong confirmation non-reusable', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-capability-management-'));
    roots.push(controllerHome);
    const base = {
      repoId: 'repo-test', pluginId: 'ios', capabilityId: 'ios-physical-device',
      target: { kind: 'ios-physical-device', id: 'CORE-DEVICE-1', identityFingerprint: 'fingerprint-1' }, scopes: ['ios.device'],
    };
    const owned = recordPluginCapabilityAuthorization(controllerHome, {
      ...base, ownerScope: 'mcp:principal:test-user', riskCeiling: 'workspace_write',
    });
    recordPluginCapabilityAuthorization(controllerHome, {
      ...base, ownerScope: 'mcp:principal:other-user', target: { ...base.target, id: 'CORE-DEVICE-2' }, riskCeiling: 'workspace_write',
    });
    const repository = controllerPluginRepository(controllerHome);
    const listed = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'list_capability_authorizations', requestId: 'capability-list', args: {},
      origin: { surface: 'mcp', actor: 'principal:test-user' },
    });
    expect(((listed.result?.result as { authorizations: Array<{ grantId: string }> }).authorizations).map((entry) => entry.grantId)).toEqual([owned.grantId]);
    await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'plugin_management', actionId: 'revoke_capability_authorization', requestId: 'capability-revoke',
      args: { grant_id: owned.grantId, reason: 'user revoked test grant' }, origin: { surface: 'mcp', actor: 'principal:test-user' },
    });
    expect(findActivePluginCapabilityAuthorization(controllerHome, {
      ...base, ownerScope: 'mcp:principal:test-user', risk: 'workspace_write',
    })).toBeUndefined();
    const manifest = buildPluginManagementManifest();
    expect(getPluginActionCapabilitySchema('plugin.plugin_management.revoke_capability_authorization', [manifest])?.authorizationReuse).toMatchObject({ mode: 'exact_target_persistent_when_adapter_supported' });
    expect(getPluginActionCapabilitySchema('plugin.plugin_management.remove_registration', [manifest])).toMatchObject({ confirmation: 'strong_confirmation', authorizationReuse: { mode: 'not_reusable' } });
  });
});

describe('external plugin reusable authorization targets', () => {
  test('maps Desktop Operator interaction ids to a verified stable application identity and fails closed when missing', async () => {
    const registration: ExternalPluginRegistration = {
      schemaVersion: 1, revision: 1, pluginId: 'desktop_operator', providerPluginId: 'desktop_operator', displayName: 'Forge Desktop Operator', provider: 'local-macos',
      pluginVersion: '0.2.1', protocolVersion: '1.0', scope: 'controller', enabled: true,
      transport: { kind: 'unix_socket_jsonl', socketPath: '/tmp/desktop.sock', maxRequestBytes: 1_048_576, maxResponseBytes: 1_048_576, healthTimeoutMs: 2_000, actionTimeoutMs: 30_000 },
      permissions: [{ scope: 'desktop.interact', mode: 'write', description: 'Interact with one desktop app.', granted: true, required: true }],
      capabilities: [{ capabilityId: 'desktop.interact', title: 'Desktop interaction', description: 'Interact with one desktop app.', scopes: ['desktop.interact'], actions: ['desktop_press'] }],
      actions: [{ actionId: 'desktop_press', title: 'Press', description: 'Press one element.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 10_000, cancellable: true, idempotent: false, scopes: ['desktop.interact'], resourceClaims: [{ resource: 'provider-state', mode: 'write' }], argumentsSchema: { type: 'object', properties: { interaction_id: { type: 'string' } }, required: ['interaction_id'], additionalProperties: false } }],
      legacyIdentities: [], registrationFingerprint: 'f'.repeat(64), installedAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
    };
    const providerManifest = { id: 'desktop_operator', name: 'Forge Desktop Operator', version: '0.2.1', protocolVersion: '1.0', mode: 'external', scope: 'controller', provider: 'local-macos', capabilities: ['desktop.interact'], actions: ['desktop_press'] };
    const adapter = createExternalPluginAdapter(registration, {
      call: async (options) => options.method === 'manifest' ? providerManifest : { sessions: [{ interactionId: 'desk_123', bundleIdentifier: 'com.example.Editor', appName: 'Editor' }] },
    });
    const input = (interactionId: string) => ({ controllerHome: '/tmp/controller', repoId: '__controller__', repoRoot: '/tmp/controller', pluginId: 'desktop_operator', actionId: 'desktop_press', requestId: `desktop-auth-${interactionId}`, args: { interaction_id: interactionId }, origin: { surface: 'mcp', actor: 'principal:test-user' } } as const);
    const resolved = await adapter.resolveAuthorizationContext?.(input('desk_123'));
    expect(resolved?.target).toMatchObject({ kind: 'desktop-application', id: 'com.example.Editor' });
    expect(resolved?.target.identityFingerprint).toHaveLength(64);
    const missing = createExternalPluginAdapter(registration, { call: async (options) => options.method === 'manifest' ? providerManifest : { sessions: [] } });
    await expect(missing.resolveAuthorizationContext?.(input('desk_missing'))).rejects.toThrow('EXTERNAL_PLUGIN_AUTHORIZATION_TARGET_UNAVAILABLE');
  });
});

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
    const driftPath = join(controllerHome, 'provider-drift');
    await startExternalProviderFixture(controllerHome, socketPath, logPath, driftPath);
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
    await executeAssistantPluginAction({
      controllerHome, repoId: repository.repoId, repoRoot: repository.canonicalRoot, pluginId: 'desktop_operator', actionId: 'desktop_status',
      requestId: 'external-hotpath-2', args: {}, origin: { surface: 'mcp' }, timeoutMs: 1_000,
    });
    clearAssistantPluginManifestCacheForTest();
    writeFileSync(driftPath, 'drift');
    await expect(executeAssistantPluginAction({
      controllerHome, repoId: repository.repoId, repoRoot: repository.canonicalRoot, pluginId: 'desktop_operator', actionId: 'desktop_status',
      requestId: 'external-hotpath-drift', args: {}, origin: { surface: 'mcp' }, timeoutMs: 1_000,
    })).rejects.toThrow('EXTERNAL_PLUGIN_VERSION_MISMATCH');
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['manifest', 'health', 'execute', 'execute', 'manifest', 'manifest', 'manifest']);
  });

  test('built-in adapters retain precedence over colliding external registration IDs in Phase 1', () => {
    const fx = fixture();
    installExternalPluginRegistration(fx.controllerHome, {
      pluginId: 'local_system', providerPluginId: 'desktop_operator', displayName: 'External Collision', provider: 'local-macos', pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller',
      transport: { kind: 'unix_socket_jsonl', socketPath: fx.socketPath, healthTimeoutMs: 100 },
      permissions: [], capabilities: [], actions: [],
    });
    const manifests = listAssistantPluginManifests(fx.controllerHome, fx.repository, { forceRefresh: true });
    const localSystem = manifests.find((manifest) => manifest.pluginId === 'local_system');
    expect(localSystem?.displayName).toBe('Local System Assistant');
    expect(manifests.filter((manifest) => manifest.pluginId === 'local_system')).toHaveLength(1);
  });
});

describe('Resend first-party plugin', () => {
  test('binds a successful typed remote-write receipt to an external-effect-only Work', async () => {
    const repoRoot = resendFixture();
    const controllerHome = join(repoRoot, '.controller');
    const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' });
    expect(initialized.status).toBe(0);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'remote-effect-fixture' });
    await executeResendPluginAction({
      controllerHome, repoId: repository.repoId, repoRoot, pluginId: 'resend', actionId: 'configure', requestId: 'remote-effect-configure',
      args: { enabled: true, provider: 'mock', from_email: 'forge@example.test', from_name: 'Forge' },
      origin: { surface: 'mcp', actor: 'test' },
    });

    const started = startGoalWorkloop({
      workStore: { controllerHome, repoId: repository.repoId },
      handoffStore: { controllerHome, repoId: repository.repoId },
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
    }, {
      objective: 'Send one remote-effect acceptance email.',
      acceptanceCriteria: ['The typed remote email action succeeds.'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      modeInput: {
        scopeClear: true, mutation: true, requiresExternalEffect: true, remoteWrite: true, risk: 'remote_write',
        requiresRecovery: false, requiresWorker: false, requiresApproval: false,
      },
    });
    const workId = String((started.data as { work?: { workId?: string } }).work?.workId ?? '');
    expect(workId).toBeTruthy();
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)).toMatchObject({
      status: 'running', workKind: 'remote_effect', checks: [],
    });

    const submitted = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'resend', actionId: 'send_email', requestId: 'remote-effect-send', workId,
      args: { to: ['recipient@example.test'], subject: 'Remote effect receipt', text: 'receipt acceptance' },
      confirmAuthorization: true, confirmationText: 'send-resend-email',
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(submitted.receipt).toMatchObject({ status: 'succeeded', workId });
    expect(submitted.result?.work).toMatchObject({ workId, workKind: 'remote_effect', completionOutcome: 'completed_remote', status: 'completed' });
    const completed = getWorkContract({ controllerHome, repoId: repository.repoId }, workId)!;
    expect(completed).toMatchObject({
      status: 'completed', workKind: 'remote_effect', completionOutcome: 'completed_remote', evidenceState: 'valid', dispatchState: 'terminal',
      completionReceipt: { source: 'remote_effect', receiptId: submitted.receipt.receiptId, pluginId: 'resend', actionId: 'send_email' },
    });
    expect(completed.evidenceRefs.some((evidence) => evidence.evidenceId === submitted.receipt.receiptId)).toBe(true);
    const finalized = finalizeGoalWorkloop({
      workStore: { controllerHome, repoId: repository.repoId },
      handoffStore: { controllerHome, repoId: repository.repoId },
      repoId: repository.repoId,
    }, { workId });
    expect(finalized).toMatchObject({ status: 'ok', data: { finalStatus: 'completed', idempotent: true } });

    const deduplicated = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'resend', actionId: 'send_email', requestId: 'remote-effect-send', workId,
      args: { to: ['recipient@example.test'], subject: 'Remote effect receipt', text: 'receipt acceptance' },
      confirmAuthorization: true, confirmationText: 'send-resend-email',
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(deduplicated.deduplicated).toBe(true);
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.evidenceRefs.filter((evidence) => evidence.evidenceId === submitted.receipt.receiptId)).toHaveLength(1);
  });

  test('refuses to bind a remote-write plugin receipt to a repository-change Work before the external effect runs', async () => {
    const repoRoot = resendFixture();
    const controllerHome = join(repoRoot, '.controller');
    expect(spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'remote-effect-kind-guard' });
    await executeResendPluginAction({
      controllerHome, repoId: repository.repoId, repoRoot, pluginId: 'resend', actionId: 'configure', requestId: 'remote-effect-guard-configure',
      args: { enabled: true, provider: 'mock', from_email: 'forge@example.test' }, origin: { surface: 'mcp', actor: 'test' },
    });
    const started = startGoalWorkloop({
      workStore: { controllerHome, repoId: repository.repoId }, handoffStore: { controllerHome, repoId: repository.repoId }, repoId: repository.repoId, checkoutId: repository.activeCheckoutId,
    }, {
      objective: 'Repository-only Work must not be completed by a remote receipt.', acceptanceCriteria: [], allowedPaths: [], forbiddenPaths: [], checks: [],
      modeInput: { scopeClear: true, mutation: true, requiresExternalEffect: false, remoteWrite: false, requiresRecovery: false, requiresWorker: false, requiresApproval: false },
    });
    const workId = String((started.data as { work?: { workId?: string } }).work?.workId ?? '');
    await expect(submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'resend', actionId: 'send_email', requestId: 'remote-effect-kind-guard-send', workId,
      args: { to: ['recipient@example.test'], subject: 'must not send', text: 'guard' },
      confirmAuthorization: true, confirmationText: 'send-resend-email', origin: { surface: 'mcp', actor: 'test' },
    })).rejects.toThrow('WORK_PLUGIN_RECEIPT_BINDING_KIND_MISMATCH');
    expect(getWorkContract({ controllerHome, repoId: repository.repoId }, workId)?.status).toBe('running');
  });

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
