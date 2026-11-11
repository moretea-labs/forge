import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { dirname, join } from 'path';
import { installExternalPluginRegistration, type ExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import { createExternalPluginAdapter } from '../../src/runtime/plugins/external-adapter';
import { registerRepository } from '../../src/cli/repositories/registry';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import { __resetLiveMonitorsForTests, spawnManagedProcess, waitForProcess } from '../../src/runtime/execution/process-runtime';
import { withControllerLockAsync } from '../../src/cli/repositories/locks';
import { getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { callRhWorkSemanticOperation } from '../../adapters/mcp/runtime-gateway/work-semantic-operations';
import { buildResendPluginManifest, executeResendPluginAction } from '../../src/runtime/plugins/resend-adapter';
import { executeAssistantPluginActionApplication } from '../../src/runtime/plugins/action-application';
import { buildMimeMessage, GMAIL_AUTOMATION_CAPABILITY_ID, GMAIL_OWNER_NOTIFICATION_CAPABILITY_ID, GMAIL_PLUGIN_ID } from '../../src/runtime/plugins/gmail-adapter';
import { controllerPluginConfigPath } from '../../src/runtime/plugins/config-store';
import { writeMacKeychainGenericPassword } from '../../src/runtime/safe-tooling/mac-keychain-write';
import { createFirstPartyPluginAdapterMap } from '../../src/runtime/plugins/first-party-registry';
import { getPluginActionCapabilitySchema } from '../../src/runtime/control-plane/facade/capability-registry';
import { buildPluginManagementManifest } from '../../src/runtime/plugins/plugin-management-adapter';
import {
  findActivePluginCapabilityAuthorization,
  pluginCapabilityAuthorizationOwnerScope,
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
  executeControllerScopedPluginAction,
  getControllerPluginManifest,
  listControllerPluginManifests,
  submitControllerPluginAction,
  submitAssistantPluginAction,
  readPluginActionReceiptForRequest,
  browserRemoteResourceKey,
} from '../../src/runtime/plugins/store';
import { resourceClaimsConflict } from '../../src/runtime/resources/claims/conflicts';
import { listActiveLeases } from '../../src/runtime/resources/leases/store';
import { controllerSystemRoot, ensureControllerHome, FORGE_INSTANCE_SCOPE_KEY } from '../../src/effects/controller-home';
import { createRecoveryConfig, restartPrimaryConnector } from '../../src/runtime/standalone-recovery/core';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { ensureActiveRuntimeRelease } from '../../src/runtime/root/release-store';
import { bindRuntimeWriteClaim, clearRuntimeWriteClaimForTests } from '../../src/runtime/root/write-fence';

describe('Browser and Computer native remote resource claims', () => {
  const claim = (pluginId: string, args: Record<string, unknown> | undefined, requestId?: string) => ({
    resourceKey: browserRemoteResourceKey(pluginId, args, requestId),
    mode: 'exclusive' as const,
  });

  test('Computer and Browser share one exact session claim while distinct sessions remain independent', () => {
    const computerA = claim('computer', { session_id: 'session-a' }, 'computer-a');
    const browserA = claim('browser', { session_id: 'session-a' }, 'browser-a');
    const computerB = claim('computer', { session_id: 'session-b' }, 'computer-b');

    expect(computerA.resourceKey).toBe(browserA.resourceKey);
    expect(resourceClaimsConflict(computerA, browserA)).toBe(true);
    expect(resourceClaimsConflict(computerA, computerB)).toBe(false);
  });

  test('fresh requests and exact native tab identities are scoped without a provider-global lock', () => {
    const freshA = claim('computer', undefined, 'fresh-a');
    const freshB = claim('computer', undefined, 'fresh-b');
    expect(resourceClaimsConflict(freshA, freshB)).toBe(false);

    const nativeTab = { native_browser_product: 'chrome', native_window_id: '7', native_tab_id: '11' };
    const computerTab = claim('computer', nativeTab, 'computer-tab');
    const browserTab = claim('browser', nativeTab, 'browser-tab');
    const anotherWindow = claim('computer', { ...nativeTab, native_window_id: '8' }, 'other-window');
    const anotherTab = claim('computer', { ...nativeTab, native_tab_id: '12' }, 'other-tab');

    expect(computerTab.resourceKey).toBe(browserTab.resourceKey);
    expect(resourceClaimsConflict(computerTab, browserTab)).toBe(true);
    expect(resourceClaimsConflict(computerTab, anotherWindow)).toBe(false);
    expect(resourceClaimsConflict(computerTab, anotherTab)).toBe(false);

    const partialTabComputer = claim('computer', {
      native_browser_product: 'chrome', native_tab_id: '11', session_id: 'session-a',
    }, 'partial-computer');
    const partialTabBrowser = claim('browser', {
      native_browser_product: 'chrome', native_tab_id: '11', session_id: 'session-a',
    }, 'partial-browser');
    const partialTabOtherSession = claim('computer', {
      native_browser_product: 'chrome', native_tab_id: '11', session_id: 'session-b',
    }, 'partial-other-session');
    const partialTabMissingProduct = claim('computer', {
      native_window_id: '7', native_tab_id: '11', session_id: 'session-a',
    }, 'partial-missing-product');
    const partialTabFreshA = claim('computer', { native_browser_product: 'chrome', native_tab_id: '11' }, 'partial-fresh-a');
    const partialTabFreshB = claim('computer', { native_browser_product: 'chrome', native_tab_id: '11' }, 'partial-fresh-b');
    const partialTabUnknown = claim('computer', { native_tab_id: '11' });

    // A tab id alone is not a canonical native identity: preserve session fencing,
    // otherwise isolate by request or fail closed when even that identity is absent.
    expect(partialTabComputer.resourceKey).toBe(partialTabBrowser.resourceKey);
    expect(partialTabComputer.resourceKey).toBe(partialTabMissingProduct.resourceKey);
    expect(resourceClaimsConflict(partialTabComputer, partialTabBrowser)).toBe(true);
    expect(resourceClaimsConflict(partialTabComputer, partialTabOtherSession)).toBe(false);
    expect(resourceClaimsConflict(partialTabFreshA, partialTabFreshB)).toBe(false);
    expect(partialTabUnknown.resourceKey).toBe('provider-state:browser');
  });

  test('native active-tab selection stays product-scoped and unknown browser effects fail closed globally', () => {
    const chromeActive = claim('computer', { native_active_tab: true, native_browser_product: 'chrome' }, 'chrome-active');
    const sameChromeActive = claim('browser', { native_active_tab: true, native_browser_product: 'chrome' }, 'other-chrome-active');
    const vivaldiActive = claim('computer', { native_active_tab: true, native_browser_product: 'vivaldi' }, 'vivaldi-active');
    const unknownComputer = claim('computer', undefined);
    const unknownBrowser = claim('browser', undefined);

    expect(chromeActive.resourceKey).toBe(sameChromeActive.resourceKey);
    expect(resourceClaimsConflict(chromeActive, sameChromeActive)).toBe(true);
    expect(resourceClaimsConflict(chromeActive, vivaldiActive)).toBe(false);
    expect(unknownComputer.resourceKey).toBe('provider-state:browser');
    expect(unknownComputer.resourceKey).toBe(unknownBrowser.resourceKey);
  });
});

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  clearRuntimeWriteClaimForTests();
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(enabled = true, exposure?: 'product' | 'provider', includeSlowMutation = false, slowMutationTimeoutMs = 2_000) {
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
    ...(exposure ? { exposure } : {}),
    transport: { kind: 'unix_socket_jsonl', socketPath, healthTimeoutMs: 100, actionTimeoutMs: slowMutationTimeoutMs },
    permissions: [{ scope: 'desktop.observe', mode: 'read', description: 'Observe desktop.', granted: true, required: true }],
    capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
    actions: [
      { actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 500, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ...(includeSlowMutation ? [{ actionId: 'desktop_mutate_slow', title: 'Slow mutation', description: 'Slow resource-claimed mutation fixture.', readOnly: false, risk: 'workspace_write' as const, confirmation: 'authorization' as const, defaultTimeoutMs: slowMutationTimeoutMs, cancellable: true, idempotent: false, scopes: ['desktop.observe'], resourceClaims: [{ resource: 'provider-state' as const, mode: 'write' as const }], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } }] : []),
    ],
  });
  return { controllerHome, socketPath };
}

async function startExternalProviderFixture(root: string, socketPath: string, logPath: string, driftPath?: string, pluginId = 'desktop_operator', mutationDelayMs = 250): Promise<void> {
  const scriptPath = join(root, 'provider.cjs');
  writeFileSync(scriptPath, `
const fs = require('fs');
const net = require('net');
const socketPath = process.argv[2];
const logPath = process.argv[3];
const driftPath = process.argv[4];
const providerPluginId = ${JSON.stringify(pluginId)};
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
        id: providerPluginId, name: 'Forge Desktop Operator', version: fs.existsSync(driftPath) ? '0.2.0' : '0.1.0',
        protocolVersion: '1.0', mode: 'external', scope: 'controller', provider: 'local-macos',
        capabilities: ['desktop-observe'], actions: ['desktop_status', 'desktop_mutate_slow'],
      };
    } else if (request.method === 'health') {
      result = { state: 'ready', warnings: [] };
    } else {
      result = { observed: true };
      if (request.params && request.params.action === 'desktop_mutate_slow') {
        return setTimeout(() => socket.end(JSON.stringify({ id: request.id, ok: true, result }) + '\\n'), ${mutationDelayMs});
      }
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

describe('macOS Keychain secret-safe write transport', () => {
  test.skipIf(process.platform !== 'darwin')('writes quoted dummy secret to an isolated Keychain without credential argv', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-isolated-keychain-'));
    roots.push(root);
    const keychain = join(root, 'isolated.keychain');
    const created = spawnSync('/usr/bin/security', ['create-keychain', '-p', 'dummy-test-only', keychain], { stdio: 'ignore' });
    expect(created.status).toBe(0);
    const dummy = JSON.stringify({ token: 'fake value with spaces and "quotes"', fragment: 'back\\\\slash' });
    writeMacKeychainGenericPassword('forge.test-credential', 'dummy', dummy, keychain);
    const readback = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'forge.test-credential', '-a', 'dummy', '-w', keychain], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(readback.status).toBe(0);
    expect(readback.stdout.trim()).toBe(dummy);
    // macOS security -i may exit 0 for an invalid subcommand destination.
    // A non-existent Keychain must never appear as a successful store.
    expect(() => writeMacKeychainGenericPassword('forge.test-credential', 'dummy', dummy, join(root, 'missing.keychain'))).toThrow('MAC_KEYCHAIN_WRITE_FAILED');
    expect(() => writeMacKeychainGenericPassword('forge.test-credential', 'dummy', 'line1\nline2', keychain)).toThrow('MAC_KEYCHAIN_ARGUMENT_INVALID');
  });
});

describe('plugin action resource replay fencing', () => {
  test('successful provider effect survives old-Runtime lease cleanup fencing and the successor reclaims immediately', async () => {
    const { controllerHome, socketPath } = fixture(true, undefined, true);
    const logPath = join(controllerHome, 'provider-cutover-fence.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);
    const manifestPath = join(controllerHome, 'runtime-cutover-fixture.manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      releaseId: 'release-cutover-fixture',
      artifactIdentity: 'artifact-cutover-fixture',
      entrypoint: 'forge-runtime',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome,
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: 1,
      createdAt: new Date().toISOString(),
    }));
    const oldOwner = acquireRuntimeOwnership(controllerHome, 'runtime-plugin-old');
    const authority = ensureActiveRuntimeRelease(controllerHome, manifestPath);
    bindRuntimeWriteClaim({ controllerHome, owner: oldOwner.record, authority });

    const first = submitControllerPluginAction(controllerHome, {
      pluginId: 'desktop_operator', actionId: 'desktop_mutate_slow', requestId: 'cutover-fenced-cleanup-first',
      args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    oldOwner.release();
    const replacement = acquireRuntimeOwnership(controllerHome, 'runtime-plugin-new');
    const completed = await first;
    expect(completed.receipt.status).toBe('succeeded');

    clearRuntimeWriteClaimForTests();
    bindRuntimeWriteClaim({ controllerHome, owner: replacement.record, authority });
    const second = await submitControllerPluginAction(controllerHome, {
      pluginId: 'desktop_operator', actionId: 'desktop_mutate_slow', requestId: 'cutover-fenced-cleanup-second',
      args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(second.receipt.status).toBe('succeeded');
    const executes = readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line === 'execute');
    expect(executes).toHaveLength(2);
    replacement.release();
  });

  test('a slow provider effect renews its exact lease until a single terminal receipt', async () => {
    const { controllerHome, socketPath } = fixture(true, undefined, true, 8_000);
    const logPath = join(controllerHome, 'provider-slow-lease.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath, undefined, 'desktop_operator', 6_500);
    const first = submitControllerPluginAction(controllerHome, {
      pluginId: 'desktop_operator', actionId: 'desktop_mutate_slow', requestId: 'slow-provider-lease-heartbeat',
      args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    let initial = listActiveLeases(controllerHome, FORGE_INSTANCE_SCOPE_KEY);
    for (let attempt = 0; initial.length === 0 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      initial = listActiveLeases(controllerHome, FORGE_INSTANCE_SCOPE_KEY);
    }
    expect(initial).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 5_300));
    const current = listActiveLeases(controllerHome, FORGE_INSTANCE_SCOPE_KEY);
    expect(current).toHaveLength(1);
    expect(current[0]?.leaseId).toBe(initial[0]?.leaseId);
    expect(Date.parse(current[0]!.expiresAt)).toBeGreaterThan(Date.parse(initial[0]!.expiresAt));
    const completed = await first;
    expect(completed.receipt.status).toBe('succeeded');
    expect(listActiveLeases(controllerHome, FORGE_INSTANCE_SCOPE_KEY)).toHaveLength(0);
    expect(readFileSync(logPath, 'utf8').trim().split(String.fromCharCode(10)).filter((line) => line === 'execute')).toHaveLength(1);
  });

  test('a lease expiring after dispatch produces one unknown receipt, never a false definitive failure', async () => {
    const { controllerHome, socketPath } = fixture(true, undefined, true);
    const logPath = join(controllerHome, 'provider-expired-lease.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);
    const request = {
      pluginId: 'desktop_operator', actionId: 'desktop_mutate_slow', requestId: 'expired-after-provider-dispatch',
      args: {}, origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const pending = submitControllerPluginAction(controllerHome, request);
    let held = listActiveLeases(controllerHome, FORGE_INSTANCE_SCOPE_KEY);
    for (let attempt = 0; held.length === 0 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      held = listActiveLeases(controllerHome, FORGE_INSTANCE_SCOPE_KEY);
    }
    expect(held).toHaveLength(1);
    writeFileSync(join(controllerSystemRoot(controllerHome), 'execution-leases', 'active', `${held[0]!.leaseId}.json`),
      JSON.stringify({ ...held[0], expiresAt: new Date(0).toISOString() }));
    const result = await pending;
    expect(result.receipt).toMatchObject({
      status: 'failed', effectOutcome: 'outcome_unknown',
      error: { code: 'PLUGIN_RESOURCE_LEASE_CLEANUP_UNKNOWN' },
    });
    const repeated = await submitControllerPluginAction(controllerHome, request);
    expect(repeated.deduplicated).toBe(true);
    expect(repeated.receipt.receiptId).toBe(result.receipt.receiptId);
    expect(readFileSync(logPath, 'utf8').trim().split(String.fromCharCode(10)).filter((line) => line === 'execute')).toHaveLength(1);
  });

  test('concurrent same-request replay contends instead of executing the non-idempotent action twice', async () => {
    const { controllerHome, socketPath } = fixture(true, undefined, true);
    const logPath = join(controllerHome, 'provider-replay.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);

    const request = {
      pluginId: 'desktop_operator',
      actionId: 'desktop_mutate_slow',
      requestId: 'same-request-resource-replay',
      args: {},
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const first = submitControllerPluginAction(controllerHome, request);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(submitControllerPluginAction(controllerHome, request))
      .rejects.toThrow('PLUGIN_RESOURCE_CONTENTION');
    const completed = await first;
    expect(completed.receipt.status).toBe('succeeded');

    const replayed = await submitControllerPluginAction(controllerHome, request);
    expect(replayed.deduplicated).toBe(true);
    expect(replayed.receipt.receiptId).toBe(completed.receipt.receiptId);
    const executes = readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line === 'execute');
    expect(executes).toHaveLength(1);

  });

  test('resource contention reports the existing provider owner and lease expiry before dispatch', async () => {
    const { controllerHome, socketPath } = fixture(true, undefined, true);
    const logPath = join(controllerHome, 'provider-owner-expiry.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);
    const first = submitControllerPluginAction(controllerHome, {
      pluginId: 'desktop_operator', actionId: 'desktop_mutate_slow', requestId: 'provider-state-owner-first',
      args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    let contention: unknown;
    try {
      await submitControllerPluginAction(controllerHome, {
        pluginId: 'desktop_operator', actionId: 'desktop_mutate_slow', requestId: 'provider-state-owner-second',
        args: {}, origin: { surface: 'mcp', actor: 'test' },
      });
    } catch (error) {
      contention = error;
    }
    let completed: Awaited<typeof first>;
    try {
      const blocker = (contention as { details: { blockers: Array<Record<string, unknown>> } }).details.blockers[0]!;
      expect(typeof blocker.expiresAt).toBe('string');
      expect(blocker.expiresAt).not.toBe('');
      const expiry = Number(blocker.expiresAt) || Date.parse(String(blocker.expiresAt));
      expect(Number.isFinite(expiry)).toBe(true);
      expect(expiry).toBeGreaterThan(Date.now());
      expect(blocker).not.toHaveProperty('fencingToken');
      expect(blocker.ownerIdentityDigest).toMatch(/^[0-9a-f]{64}$/);
      const message = (contention as Error).message;
      // The managed Process route retains stderr, not arbitrary error.details.
      expect(message).toContain(`Blocking ${blocker.resourceKey}`);
      expect(message).toContain(`owner=${blocker.ownerJobId}`);
      expect(message).toContain(`lease=${blocker.leaseId}`);
      expect(message).toContain(`expiresAt=${blocker.expiresAt}`);
      expect(message).toContain(`ownerDigest=${blocker.ownerIdentityDigest}`);
      expect(message).not.toContain('fencingToken');
      expect(contention).toMatchObject({
        code: 'PLUGIN_RESOURCE_CONTENTION',
        retryable: true,
        details: {
          blockers: [{
            resourceKey: 'provider-state:desktop_operator',
            ownerJobId: expect.stringContaining('plugin:provider-state-owner-first:'),
            leaseId: expect.any(String),
            mode: 'write',
          }],
        },
      });
    } finally {
      completed = await first;
    }

    expect(completed.receipt.status).toBe('succeeded');
    const executes = readFileSync(logPath, 'utf8').trim().split(String.fromCharCode(10)).filter((line) => line === 'execute');
    expect(executes).toHaveLength(1);
  });

  test('process loss after provider dispatch reconciles the same request as unknown without duplicate effects', async () => {
    const { controllerHome, socketPath } = fixture(true, undefined, true);
    const logPath = join(controllerHome, 'provider-crash-replay.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);
    const request = {
      pluginId: 'desktop_operator',
      actionId: 'desktop_mutate_slow',
      requestId: 'provider-effect-crash-before-receipt',
      args: {},
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    // The provider appends its effect to disk before the delayed reply. Kill
    // only the client process, leaving the provider running for reconciliation.
    const scriptPath = join(controllerHome, 'crash-client.ts');
    writeFileSync(scriptPath, [
      'import { submitControllerPluginAction } from ' + JSON.stringify(join(process.cwd(), 'src/runtime/plugins/store.ts')) + ';',
      'await submitControllerPluginAction(' + JSON.stringify(controllerHome) + ', ' + JSON.stringify(request) + ');',
    ].join('\n'));
    const child = spawn(process.execPath, [scriptPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let dispatched = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (existsSync(logPath) && readFileSync(logPath, 'utf8').split('\n').includes('execute')) {
        dispatched = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(dispatched, stderr).toBe(true);
    expect(child.kill('SIGKILL')).toBe(true);
    expect((await exit).signal).toBe('SIGKILL');

    const reconciled = readPluginActionReceiptForRequest(controllerHome, request.requestId);
    expect(reconciled?.effectOutcome).toBe('outcome_unknown');
    expect(reconciled?.error?.code).toBe('PLUGIN_ACTION_OUTCOME_UNKNOWN');

    const replay = await submitControllerPluginAction(controllerHome, request);
    expect(replay.deduplicated).toBe(true);
    expect(reconciled).toBeDefined();
    expect(replay.receipt.receiptId).toBe(reconciled!.receiptId);
    expect(replay.receipt.effectOutcome).toBe('outcome_unknown');
    await expect(submitControllerPluginAction(controllerHome, { ...request, actionId: 'desktop_status' }))
      .rejects.toThrow('REQUEST_ID_CONFLICT');
    expect(readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line === 'execute')).toHaveLength(1);
  }, 15_000);

  test('Process observation interruption preserves Plugin Action identity through Recovery Connector restart orchestration', async () => {
    const { controllerHome, socketPath } = fixture(true, undefined, true);
    const logPath = join(controllerHome, 'process-plugin-interruption.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);

    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-plugin-process-repo-'));
    roots.push(repoRoot);
    expect(spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.email', 'forge@example.test'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    writeFileSync(join(repoRoot, 'README.md'), 'cross-surface interruption fixture' + String.fromCharCode(10));
    expect(spawnSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    ensureControllerHome(controllerHome);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'plugin-process-interruption-test' });

    const requestId = 'process-plugin-interrupted-observation';
    const request = {
      pluginId: 'desktop_operator',
      actionId: 'desktop_mutate_slow',
      requestId,
      args: {},
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const resultPath = join(controllerHome, 'process-plugin-result.json');
    const scriptPath = join(controllerHome, 'process-plugin-client.ts');
    writeFileSync(scriptPath, [
      "import { writeFileSync } from 'node:fs';",
      'import { submitControllerPluginAction } from ' + JSON.stringify(join(process.cwd(), 'src/runtime/plugins/store.ts')) + ';',
      'const result = await submitControllerPluginAction(' + JSON.stringify(controllerHome) + ', ' + JSON.stringify(request) + ');',
      'writeFileSync(' + JSON.stringify(resultPath) + ', JSON.stringify({ receiptId: result.receipt.receiptId, status: result.receipt.status, deduplicated: result.deduplicated }));',
    ].join(String.fromCharCode(10)));

    const command = { kind: 'argv' as const, executable: process.execPath, args: [scriptPath], cwd: repoRoot };
    const signal = new AbortController();
    const execution = spawnManagedProcess({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      executionIdentity: executionIdentityForRepository(repository),
      command,
      interactiveWaitMs: 10_000,
      timeoutMs: 15_000,
      signal: signal.signal,
      origin: { surface: 'command', toolName: 'execute_command', requestId },
    });

    const dispatchDeadline = Date.now() + 5_000;
    let dispatched = false;
    while (Date.now() < dispatchDeadline) {
      if (existsSync(logPath) && readFileSync(logPath, 'utf8').split(String.fromCharCode(10)).includes('execute')) {
        dispatched = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(dispatched).toBe(true);
    signal.abort();
    const interrupted = await execution;
    expect(interrupted).toMatchObject({ completed: false, status: 'running', observationInterrupted: true, requestId });

    // Drop only the observing Controller monitor; the independent Runner and provider keep executing.
    __resetLiveMonitorsForTests();

    const connectorPlistPath = join(controllerHome, 'connector.plist');
    writeFileSync(connectorPlistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
    const recoveryConfig = createRecoveryConfig(controllerHome, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway', plistPath: connectorPlistPath },
    });
    const connectorCommands: string[][] = [];
    let reconnectCalls = 0;
    const healthyVerify = () => ({
      ok: true,
      at: new Date().toISOString(),
      runtime: { ok: true, running: true, ready: true, stale: false, reasonCodes: [] },
      releases: { coherent: true },
      probes: {
        runtime_status: { ok: true, detail: 'live' },
        active_gateway: { ok: true, detail: 'HTTP 200' },
        mcp_initialize: { ok: true, detail: 'HTTP 200' },
      },
    });
    // Exercise the real Recovery orchestration with deterministic launchd/reconnect adapters; do not touch the host Connector service.
    const connectorRestart = await restartPrimaryConnector(recoveryConfig, {
      requestId: 'recovery-gateway:process-plugin-connector-restart',
      forceHealthyRestart: true,
      platform: 'darwin',
      currentUid: async () => 501,
      verifyLocal: async () => healthyVerify(),
      repairConnectorBinding: async () => ({ ok: true, attempted: false, noOp: true, detail: 'binding already current' }),
      probeConnectorLocal: async () => ({ ok: true, detail: 'local Connector reachable' }),
      probeConnectorOwnership: async () => ({ ok: true, detail: 'configured service owns listener' }),
      reconnect: async () => {
        reconnectCalls += 1;
        if (reconnectCalls > 1) expect(connectorCommands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
        await Bun.sleep(75);
        return { ok: true, detail: 'public MCP reachable', verify: healthyVerify() };
      },
      runCommand: async (name, args) => {
        connectorCommands.push([name, ...args]);
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
    });
    expect(connectorRestart).toMatchObject({ ok: true, attempted: true, serviceTarget: 'gui/501/com.moretea.forge.mcp-gateway' });
    expect(connectorCommands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
    expect(reconnectCalls).toBe(2);

    const replay = await spawnManagedProcess({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      executionIdentity: executionIdentityForRepository(repository),
      command,
      interactiveWaitMs: 0,
      timeoutMs: 15_000,
      origin: { surface: 'command', toolName: 'execute_command', requestId },
    });
    expect(replay.processId).toBe(interrupted.processId);
    expect(replay.deduplicated).toBe(true);

    const terminal = await waitForProcess(controllerHome, repository.repoId, replay.processId, { timeoutMs: 5_000 });
    expect(terminal).toMatchObject({ completed: true, status: 'succeeded', ok: true });
    expect(existsSync(resultPath)).toBe(true);
    const childResult = JSON.parse(readFileSync(resultPath, 'utf8')) as { receiptId: string; status: string; deduplicated: boolean };
    const receipt = readPluginActionReceiptForRequest(controllerHome, requestId);
    expect(receipt).toMatchObject({ requestId, status: 'succeeded' });
    expect(childResult).toMatchObject({ receiptId: receipt!.receiptId, status: 'succeeded', deduplicated: false });

    const pluginReplay = await submitControllerPluginAction(controllerHome, request);
    expect(pluginReplay.deduplicated).toBe(true);
    expect(pluginReplay.receipt.receiptId).toBe(receipt!.receiptId);
    expect(readFileSync(logPath, 'utf8').trim().split(String.fromCharCode(10)).filter((line) => line === 'execute')).toHaveLength(1);
  }, 20_000);

});

describe('scheduled Gmail automation capability', () => {
  test('requires an explicit configured-mailbox grant and deduplicates owner notifications', async () => {
    clearAssistantPluginManifestCacheForTest();
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-gmail-automation-home-'));
    roots.push(controllerHome);
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-gmail-automation-repo-'));
    roots.push(repoRoot);
    expect(spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    writeFileSync(join(repoRoot, 'README.md'), 'gmail automation fixture\\n');
    expect(spawnSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.test', 'commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' }).status).toBe(0);
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'gmail-automation-test' });
    const context = { controllerHome, repoId: repository.repoId, repoRoot: repository.canonicalRoot };
    const configPath = controllerPluginConfigPath(context.controllerHome, 'gmail');
    mkdirSync(dirname(configPath), { recursive: true });
    const ownerEmail = 'owner@example.test';
    const mimeConfig = { schemaVersion: 1 as const, enabled: true, provider: 'mock' as const, accountEmail: ownerEmail };
    const mimeArgs = { to: ['user@example.test'], subject: 'Synthetic test', body_text: 'No email is sent.' };
    expect(buildMimeMessage(mimeArgs, mimeConfig)).toContain('To: user@example.test');
    for (const header of ['to', 'cc', 'bcc'] as const) {
      expect(() => buildMimeMessage({ ...mimeArgs, [header]: ['user@example.test\r\nX-Injected: yes'] }, mimeConfig)).toThrow('PLUGIN_ACTION_ARGUMENT_INVALID');
    }
    expect(() => buildMimeMessage(mimeArgs, { ...mimeConfig, accountEmail: 'owner@example.test\r\nX-Injected: yes' })).toThrow('PLUGIN_ACTION_ARGUMENT_INVALID');
    writeFileSync(configPath, JSON.stringify({ enabled: true, provider: 'mock', accountEmail: ownerEmail }, null, 2));
    const origin = { surface: 'mcp' as const, actor: 'plugin_action_execute' as const };

    await expect(submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'send_owner_notification',
      requestId: 'gmail-notification-without-grant',
      args: { subject: '[Forge] Test notification', body_text: 'This must not send before authorization.' },
      origin,
    })).rejects.toThrow('PLUGIN_CAPABILITY_GRANT_REQUIRED');
    await expect(submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'archive_scheduled_message',
      requestId: 'gmail-archive-without-grant',
      args: { message_id: 'fixture-message' },
      origin,
    })).rejects.toThrow('PLUGIN_CAPABILITY_GRANT_REQUIRED');

    const grantQuery = {
      ownerScope: pluginCapabilityAuthorizationOwnerScope(origin),
      repoId: 'controller:global',
      pluginId: GMAIL_PLUGIN_ID,
      capabilityId: GMAIL_OWNER_NOTIFICATION_CAPABILITY_ID,
      target: {
        kind: 'gmail-mailbox' as const,
        id: ownerEmail,
        identityFingerprint: `gmail-profile:${ownerEmail}`,
      },
      scopes: ['gmail.send'],
      risk: 'remote_write' as const,
    };
    await expect(submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'authorize_owner_notifications',
      requestId: 'gmail-owner-email-grant-missing-confirmation',
      args: {},
      origin,
    })).rejects.toThrow('PLUGIN_CONFIRMATION_REQUIRED');
    expect(findActivePluginCapabilityAuthorization(controllerHome, grantQuery)).toBeUndefined();

    await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'authorize_owner_notifications',
      requestId: 'gmail-owner-email-grant',
      args: {},
      origin,
      confirmAuthorization: true,
      confirmationText: 'authorize-owner-notifications',
    });
    const grant = findActivePluginCapabilityAuthorization(controllerHome, grantQuery);
    expect(grant).toBeDefined();
    expect(findActivePluginCapabilityAuthorization(controllerHome, {
      ...grantQuery, capabilityId: GMAIL_AUTOMATION_CAPABILITY_ID, scopes: ['gmail.modify'],
    })).toBeUndefined();

    const args = { subject: '[Forge] Test notification', body_text: 'Persistent receipt deduplication acceptance.' };
    const systemOrigin = { surface: 'system' as const, correlationId: 'gmail-system-notification-once' };
    const first = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'send_owner_notification',
      requestId: 'gmail-system-notification-once',
      args,
      origin: systemOrigin,
      authorizationGrantRefs: [grant!.grantId],
    });
    const second = await submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'send_owner_notification',
      requestId: 'gmail-system-notification-once',
      args,
      origin: systemOrigin,
      authorizationGrantRefs: [grant!.grantId],
    });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(first.manifest.actions.find((action) => action.actionId === 'send_message')?.confirmation).toBe('strong_confirmation');
    const scheduledCapability = first.manifest.capabilities.find((capability) => capability.capabilityId === GMAIL_AUTOMATION_CAPABILITY_ID);
    expect(scheduledCapability?.actions).toEqual(['authorize_scheduled_gmail_automation', 'archive_scheduled_message']);
    const ownerCapability = first.manifest.capabilities.find((capability) => capability.capabilityId === GMAIL_OWNER_NOTIFICATION_CAPABILITY_ID);
    expect(ownerCapability?.actions).toEqual(['authorize_owner_notifications', 'send_owner_notification']);
    expect(ownerCapability?.actions).not.toContain('send_message');

    await expect(submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'send_owner_notification',
      requestId: 'gmail-notification-arbitrary-recipient',
      args: { subject: '[Forge] Invalid recipient', body_text: 'Must reject extra recipient fields.', to: ['attacker@example.com'] },
      origin: systemOrigin,
      authorizationGrantRefs: [grant!.grantId],
    })).rejects.toThrow();
    await expect(submitAssistantPluginAction(controllerHome, repository, {
      pluginId: GMAIL_PLUGIN_ID,
      actionId: 'send_message',
      requestId: 'gmail-general-send-without-strong-confirmation',
      args: { to: ['attacker@example.com'], subject: 'Not authorized', body_text: 'Must remain strongly confirmed.' },
      origin,
    })).rejects.toThrow();
    clearAssistantPluginManifestCacheForTest();
  });
});

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
    const pluginId = 'external_desktop_fixture';
    await startExternalProviderFixture(controllerHome, socketPath, logPath, undefined, pluginId);
    const registration = {
      pluginId, providerPluginId: pluginId, displayName: 'Forge Desktop Operator', provider: 'local-macos',
      pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller' as const, enabled: true,
      transport: { kind: 'unix_socket_jsonl' as const, socketPath, healthTimeoutMs: 1_000, actionTimeoutMs: 2_000 },
      permissions: [{ scope: 'desktop.observe', mode: 'read' as const, description: 'Observe desktop.', granted: true, required: true }],
      capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_status'] }],
      actions: [{ actionId: 'desktop_status', title: 'Desktop status', description: 'Read status.', readOnly: true, risk: 'readonly' as const, confirmation: 'none' as const, defaultTimeoutMs: 500, cancellable: true, idempotent: true, scopes: ['desktop.observe'], resourceClaims: [], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    };

    const manager = getControllerPluginManifest(controllerHome, 'plugin_management');
    expect(manager.health).toMatchObject({ state: 'ready', ready: true });
    expect(manager.actions.map((action) => action.actionId)).toEqual(expect.arrayContaining([
      'preview_registration', 'install_registration', 'list_registrations', 'get_registration', 'disable_registration', 'remove_registration',
    ]));

    const preview = await submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'preview_registration', requestId: 'plugin-management-preview', args: { registration }, origin: { surface: 'mcp', actor: 'test' },
    });
    expect((preview.result!.result as Record<string, unknown>).preview).toMatchObject({ pluginId, currentRevision: 0, nextRevision: 1, wouldChange: true });

    const installed = await submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'install_registration', requestId: 'plugin-management-install', args: { registration, expected_revision: 0 },
      confirmAuthorization: true, confirmationText: 'install external registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((installed.result!.result as Record<string, unknown>).registration).toMatchObject({ pluginId, revision: 1, enabled: true });

    const listed = await submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'list_registrations', requestId: 'plugin-management-list', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(((listed.result!.result as Record<string, unknown>).registrations as Array<{ pluginId: string }>).map((entry) => entry.pluginId)).toContain(pluginId);
    const externalManifest = getControllerPluginManifest(controllerHome, pluginId);
    expect(externalManifest.health).toMatchObject({ state: 'ready', ready: true });
    const action = await submitControllerPluginAction(controllerHome, {
      pluginId, actionId: 'desktop_status', requestId: 'plugin-management-execute', args: {}, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(action.result!.result).toMatchObject({ observed: true });

    const updatedRegistration = { ...registration, displayName: 'Forge Desktop Operator Updated' };
    const updated = await submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'install_registration', requestId: 'plugin-management-update', args: { registration: updatedRegistration, expected_revision: 1 },
      confirmAuthorization: true, confirmationText: 'update external registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((updated.result!.result as Record<string, unknown>).registration).toMatchObject({ revision: 2, displayName: 'Forge Desktop Operator Updated' });
    await expect(submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'install_registration', requestId: 'plugin-management-stale-update',
      args: { registration: { ...updatedRegistration, displayName: 'Stale writer' }, expected_revision: 1 },
      confirmAuthorization: true, confirmationText: 'stale update', origin: { surface: 'mcp', actor: 'test' },
    })).rejects.toThrow('EXTERNAL_PLUGIN_REGISTRATION_REVISION_CONFLICT');

    const disabled = await submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'disable_registration', requestId: 'plugin-management-disable', args: { plugin_id: pluginId, expected_revision: 2 },
      confirmAuthorization: true, confirmationText: 'disable external registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((disabled.result!.result as Record<string, unknown>).registration).toMatchObject({ revision: 3, enabled: false });
    expect(getControllerPluginManifest(controllerHome, pluginId).enabled).toBe(false);

    const removed = await submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'remove_registration', requestId: 'plugin-management-remove', args: { plugin_id: pluginId, expected_revision: 3 },
      confirmAuthorization: true, confirmationText: 'remove-external-plugin-registration', origin: { surface: 'mcp', actor: 'test' },
    });
    expect((removed.result!.result as Record<string, unknown>).removed).toMatchObject({ pluginId, revision: 3 });
    const after = await submitControllerPluginAction(controllerHome, {
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
      pluginId: 'ios', capabilityId: 'ios-physical-device',
      target: { kind: 'ios-physical-device', id: 'CORE-DEVICE-1', identityFingerprint: 'fingerprint-1' }, scopes: ['ios.device'],
    };
    const owned = recordPluginCapabilityAuthorization(controllerHome, {
      ...base, ownerScope: 'mcp:principal:test-user', riskCeiling: 'workspace_write',
    });
    recordPluginCapabilityAuthorization(controllerHome, {
      ...base, ownerScope: 'mcp:principal:other-user', target: { ...base.target, id: 'CORE-DEVICE-2' }, riskCeiling: 'workspace_write',
    });
    const listed = await submitControllerPluginAction(controllerHome, {
      pluginId: 'plugin_management', actionId: 'list_capability_authorizations', requestId: 'capability-list', args: {},
      origin: { surface: 'mcp', actor: 'principal:test-user' },
    });
    expect(((listed.result?.result as { authorizations: Array<{ grantId: string }> }).authorizations).map((entry) => entry.grantId)).toEqual([owned.grantId]);
    await submitControllerPluginAction(controllerHome, {
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
    const input = (interactionId: string) => ({ controllerHome: '/tmp/controller', repoId: FORGE_INSTANCE_SCOPE_KEY, repoRoot: '/tmp/controller', pluginId: 'desktop_operator', actionId: 'desktop_press', requestId: `desktop-auth-${interactionId}`, args: { interaction_id: interactionId }, origin: { surface: 'mcp', actor: 'principal:test-user' } } as const);
    const resolved = await adapter.resolveAuthorizationContext?.(input('desk_123'));
    expect(resolved?.target).toMatchObject({ kind: 'desktop-application', id: 'com.example.Editor' });
    expect(resolved?.target.identityFingerprint).toHaveLength(64);
    const missing = createExternalPluginAdapter(registration, { call: async (options) => options.method === 'manifest' ? providerManifest : { sessions: [] } });
    await expect(missing.resolveAuthorizationContext?.(input('desk_missing'))).rejects.toThrow('EXTERNAL_PLUGIN_AUTHORIZATION_TARGET_UNAVAILABLE');
  });
});

describe('external plugin store integration', () => {
  test('resolves the built-in browser adapter from controller scope for ChatGPT continuation', () => {
    const fx = fixture();
    expect(assistantPluginScope('browser', fx.controllerHome)).toBe('controller');
    expect(getControllerPluginManifest(fx.controllerHome, 'browser').pluginId).toBe('browser');
  });

  test('lists trusted external registrations through the existing plugin surface with truthful degraded health', () => {
    const fx = fixture();
    const manifests = listControllerPluginManifests(fx.controllerHome, { forceRefresh: true });
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

  test('keeps provider-only registrations exactly addressable but out of the normal product list', () => {
    const fx = fixture(true, 'provider');
    const manifests = listControllerPluginManifests(fx.controllerHome, { forceRefresh: true });
    expect(manifests.some((manifest) => manifest.pluginId === 'desktop_operator')).toBe(false);
    expect(manifests.some((manifest) => manifest.pluginId === 'computer')).toBe(true);
    expect(assistantPluginScope('desktop_operator', fx.controllerHome)).toBe('controller');
    expect(getControllerPluginManifest(fx.controllerHome, 'desktop_operator').pluginId).toBe('desktop_operator');
  });

  test('get uses the same external adapter registration rather than a second manifest authority', () => {
    const fx = fixture();
    listControllerPluginManifests(fx.controllerHome, { forceRefresh: true });
    const manifest = getControllerPluginManifest(fx.controllerHome, 'desktop_operator');
    expect(manifest.authority.sourceOfTruth[0]).toContain('controllerHome:system/plugins/external/registrations/desktop_operator.json');
    expect(manifest.actions.map((action) => action.actionId)).toEqual(['desktop_status']);
  });

  test('keeps preferStored discovery cache invalidation-driven instead of expiring after the live identity window', async () => {
    if (process.platform === 'win32') return;
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-external-stored-cache-'));
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
    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    Date.now = () => fakeNow;
    try {
      clearAssistantPluginManifestCacheForTest();
      const storedOnly = listControllerPluginManifests(controllerHome, { preferStored: true, fallbackToLive: false });
      expect(storedOnly).toHaveLength(0);
      expect(existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : '').toBe('');

      clearAssistantPluginManifestCacheForTest();
      listControllerPluginManifests(controllerHome, { preferStored: true });
      const initialCalls = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
      expect(initialCalls).toBeGreaterThan(0);

      fakeNow += 6_000;
      listControllerPluginManifests(controllerHome, { preferStored: true });
      const afterWallClockExpiry = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
      expect(afterWallClockExpiry).toBe(initialCalls);

      clearAssistantPluginManifestCacheForTest();
      listControllerPluginManifests(controllerHome, { preferStored: true });
      const afterExplicitInvalidation = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).length;
      expect(afterExplicitInvalidation).toBeGreaterThan(initialCalls);
    } finally {
      Date.now = realDateNow;
      clearAssistantPluginManifestCacheForTest();
    }
  });

  test('controller-scoped Computer provider effect is independent of its own derived projection refresh lock', async () => {
    if (process.platform === 'win32') return;
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-external-projection-lock-'));
    roots.push(controllerHome);
    const socketPath = join(controllerHome, 'desktop.sock');
    const logPath = join(controllerHome, 'provider.log');
    await startExternalProviderFixture(controllerHome, socketPath, logPath);
    installExternalPluginRegistration(controllerHome, {
      pluginId: 'desktop_operator', providerPluginId: 'desktop_operator', displayName: 'Forge Desktop Operator',
      provider: 'local-macos', pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller', enabled: true,
      transport: { kind: 'unix_socket_jsonl', socketPath, healthTimeoutMs: 1_000, actionTimeoutMs: 1_000 },
      permissions: [{ scope: 'desktop.observe', mode: 'read', description: 'Observe desktop.', granted: true, required: true }],
      capabilities: [{ capabilityId: 'desktop-observe', title: 'Desktop observe', description: 'Observe desktop.', scopes: ['desktop.observe'], actions: ['desktop_mutate_slow'] }],
      actions: [{
        actionId: 'desktop_mutate_slow', title: 'Slow mutation', description: 'Provider-state mutation.', readOnly: false, risk: 'workspace_write',
        confirmation: 'authorization', defaultTimeoutMs: 2_000, cancellable: true, idempotent: false, scopes: ['desktop.observe'],
        resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
        argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
    });
    await withControllerLockAsync(
      controllerHome,
      { scope: 'task', repoId: FORGE_INSTANCE_SCOPE_KEY, taskId: 'projection-refresh' },
      'projection-refresh:test-held',
      async () => {
        const result = await submitControllerPluginAction(controllerHome, {
            pluginId: 'desktop_operator',
            actionId: 'desktop_mutate_slow',
            requestId: 'projection-lock-provider-action',
            args: {},
            origin: { surface: 'mcp' },
            timeoutMs: 1_000,
          },
        );
        expect(result.result?.result).toMatchObject({ observed: true });
      },
      undefined,
      0,
    );
    expect(readFileSync(logPath, 'utf8')).toContain('execute');
  });

  test('execute resolves a disabled external registration and fails as disabled rather than plugin-not-found', async () => {
    const fx = fixture(false);
    const manifest = getControllerPluginManifest(fx.controllerHome, 'desktop_operator');
    expect(manifest).toMatchObject({ enabled: false, lifecycle: { state: 'disabled' }, health: { probed: false } });
    await expect(executeControllerScopedPluginAction({
      controllerHome: fx.controllerHome,
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
    const manifest = getControllerPluginManifest(controllerHome, 'desktop_operator');
    expect(manifest.health.ready).toBe(true);
    const result = await executeControllerScopedPluginAction({
      controllerHome,
      pluginId: 'desktop_operator',
      actionId: 'desktop_status',
      requestId: 'external-hotpath-1',
      args: {},
      origin: { surface: 'mcp' },
      timeoutMs: 1_000,
    });
    expect(result.result).toMatchObject({ observed: true });
    await executeControllerScopedPluginAction({
      controllerHome, pluginId: 'desktop_operator', actionId: 'desktop_status',
      requestId: 'external-hotpath-2', args: {}, origin: { surface: 'mcp' }, timeoutMs: 1_000,
    });
    const realDateNow = Date.now;
    const expiredLiveWindow = realDateNow() + 6_000;
    writeFileSync(driftPath, 'drift');
    Date.now = () => expiredLiveWindow;
    try {
      await expect(executeControllerScopedPluginAction({
        controllerHome, pluginId: 'desktop_operator', actionId: 'desktop_status',
        requestId: 'external-hotpath-drift', args: {}, origin: { surface: 'mcp' }, timeoutMs: 1_000,
      })).rejects.toThrow('EXTERNAL_PLUGIN_VERSION_MISMATCH');
    } finally {
      Date.now = realDateNow;
    }
    expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['manifest', 'health', 'execute', 'execute', 'manifest', 'manifest', 'manifest']);
  });

  test('built-in adapters retain precedence over colliding external registration IDs in Phase 1', () => {
    const fx = fixture();
    installExternalPluginRegistration(fx.controllerHome, {
      pluginId: 'local_system', providerPluginId: 'desktop_operator', displayName: 'External Collision', provider: 'local-macos', pluginVersion: '0.1.0', protocolVersion: '1.0', scope: 'controller',
      transport: { kind: 'unix_socket_jsonl', socketPath: fx.socketPath, healthTimeoutMs: 100 },
      permissions: [], capabilities: [], actions: [],
    });
    const manifests = listControllerPluginManifests(fx.controllerHome, { forceRefresh: true });
    const localSystem = manifests.find((manifest) => manifest.pluginId === 'local_system');
    expect(localSystem?.displayName).toBe('Local System Assistant');
    expect(manifests.filter((manifest) => manifest.pluginId === 'local_system')).toHaveLength(1);
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
    expect(send?.remoteEffectWorkCompletion).toBe('terminal');
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
    const configText = readFileSync(controllerPluginConfigPath(join(repoRoot, '.controller'), 'resend'), 'utf8');
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
      const longPrefix = 'same-prefix-'.repeat(24);
      await resendAction(repoRoot, 'send_email', { to: ['receiver@example.com'], subject: 'Long identity A', text: 'Status OK' }, `${longPrefix}a`);
      const firstLongKey = observedIdempotencyKey;
      await resendAction(repoRoot, 'send_email', { to: ['receiver@example.com'], subject: 'Long identity B', text: 'Status OK' }, `${longPrefix}b`);
      expect(observedIdempotencyKey).not.toBe(firstLongKey);
      expect(observedIdempotencyKey?.length).toBeLessThanOrEqual(256);
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
