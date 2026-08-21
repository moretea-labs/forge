import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { readRuntimeGeneration } from '../../src/runtime/control-plane/runtime-generation';
import {
  activateExclusiveWorkAdmission,
  readWorkAdmissionPolicy,
} from '../../src/runtime/control-plane/facade/work-admission-policy';
import {
  acceptSubmittedWorkContract,
  createWorkContract,
  updateWorkContract,
} from '../../src/runtime/control-plane/facade/work-contract-store';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { RuntimeReadinessState } from '../../src/runtime/root/readiness';
import {
  assertRuntimeMayWrite,
  clearRuntimeWriteClaimForTests,
  getRuntimeWriteClaim,
} from '../../src/runtime/root/write-fence';
import { observeRuntimeStatus, writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import {
  CanonicalForgeRuntime,
  type CanonicalRuntimeDependencies,
} from '../../src/runtime/root/runtime';
import type { CanonicalRuntimeConfig } from '../../src/runtime/root/types';
import { startConfiguredRuntimeLocalBridge } from '../../src/runtime/root/local-bridge';
import { closeRuntimeMcpTransportResources } from '../../src/runtime/root/mcp-transport';
import {
  loadMcpServiceRuntimeState,
  writeMcpServiceLocalConfig,
  writeMcpServiceRuntimeState,
} from '../../src/cli/mcp/auth';

test('Runtime MCP shutdown withdraws the listener before bounded session drain', async () => {
  const order: string[] = [];
  const neverSettles = new Promise<void>(() => undefined);
  const startedAt = performance.now();
  await closeRuntimeMcpTransportResources({
    closeListener: async () => { order.push('listener'); },
    closeSessions: [async () => {
      order.push('session');
      await neverSettles;
    }],
    sessionCloseTimeoutMs: 15,
  });
  expect(order).toEqual(['listener', 'session']);
  expect(performance.now() - startedAt).toBeLessThan(250);
});

interface Fixture {
  root: string;
  controllerHome: string;
  repositoryRoot: string;
  manifestPath: string;
  config: CanonicalRuntimeConfig;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  clearRuntimeWriteClaimForTests();
});

function createFixture(overrides: Partial<CanonicalRuntimeConfig> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'forge-single-runtime-'));
  const controllerHome = join(root, 'controller');
  const repositoryRoot = join(root, 'repository');
  mkdirSync(repositoryRoot, { recursive: true });
  const manifestPath = join(root, 'release.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'release-test-1',
    artifactIdentity: 'sha256:test-artifact',
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: resolve(controllerHome),
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: '2026-08-05T00:00:00.000Z',
  }), 'utf8');
  const config: CanonicalRuntimeConfig = {
    controllerHome,
    repositoryRoot,
    releaseManifestPath: manifestPath,
    host: '127.0.0.1',
    port: 0,
    authToken: 'test-runtime-token-0123456789',
    schedulerReadyTimeoutMs: 5_000,
    ...overrides,
  };
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, controllerHome, repositoryRoot, manifestPath, config };
}

function workInput(workId: string, repoId = 'repo-test') {
  return {
    workId,
    repoId,
    mode: 'direct_control' as const,
    objective: `Execute ${workId}`,
    acceptanceCriteria: ['Work remains bounded.'],
    constraints: { requireHandoffOnAmbiguity: true },
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    checks: ['test'],
    requestedBy: 'chatgpt' as const,
  };
}

async function callRepositoryList(endpoint: string, token: string): Promise<Record<string, unknown>> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'canonical-runtime-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain('repository_list');
    expect(names).not.toContain('controller_ready');
    const result = await client.callTool({ name: 'repository_list', arguments: {} });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function inertScheduler() {
  let stopped = false;
  return {
    ready: Promise.resolve(),
    done: new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!stopped) return;
        clearInterval(timer);
        resolve();
      }, 5);
      timer.unref?.();
    }),
    stop: async () => { stopped = true; },
  };
}

describe('canonical single Runtime', () => {
  test('readiness exposes one boolean while module observations remain diagnostic evidence', () => {
    const state = new RuntimeReadinessState(() => '2026-08-05T00:00:00.000Z');
    const starting = state.snapshot();
    expect(starting.ready).toBe(false);
    expect(starting.diagnostics).toEqual({
      database: { outcome: 'not_observed' },
      scheduler: { outcome: 'not_observed' },
      releaseCoherence: { outcome: 'not_observed' },
      mcpEndToEnd: { outcome: 'not_observed' },
    });
    expect('lifecycle' in starting).toBe(false);
    expect('degraded' in starting).toBe(false);
    expect('partial' in starting).toBe(false);
    expect(() => state.markReady()).toThrow('RUNTIME_READINESS_INCOMPLETE');
  });

  test('one process serves authenticated initialize, bounded tools/list, bootstrap call, and SQLite readiness', async () => {
    const fixture = createFixture({ exclusiveWorkId: 'WORK-P0' });
    const runtime = new CanonicalForgeRuntime(fixture.config);
    cleanups.push(() => runtime.stop('TEST_CLEANUP'));
    await runtime.start();

    expect(runtime.readiness()).toMatchObject({
      ready: true,
      diagnostics: {
        database: { outcome: 'pass' },
        scheduler: { outcome: 'pass' },
        releaseCoherence: { outcome: 'pass' },
        mcpEndToEnd: { outcome: 'pass' },
      },
    });
    const endpoint = runtime.endpoint();
    expect(endpoint).toBeTruthy();
    const repositoryList = await callRepositoryList(endpoint!, fixture.config.authToken);
    expect(Array.isArray(repositoryList.repositories)).toBe(true);

    const unauthorized = await fetch(endpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauthorized.status).toBe(401);
  }, 20_000);

  test('control-plane audit lookup index is created so inspection stays bounded', () => {
    const fixture = createFixture();
    inspectControlPlaneDatabase(fixture.controllerHome);
    const db = new Database(join(fixture.controllerHome, 'control-plane.sqlite'));
    try {
      const rows = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'control_plane_audit_lookup'",
      ).all();
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('Runtime Root rotates an exact source snapshot on every startup', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'runtime-source-snapshot-one' });
    const dependencies: Partial<CanonicalRuntimeDependencies> = {
      startScheduler: () => inertScheduler(),
      startTransport: async () => ({
        endpoint: 'http://127.0.0.1:9876/mcp',
        host: '127.0.0.1',
        port: 9876,
        close: async () => undefined,
      }),
      runMcpProbe: async () => undefined,
    };
    const first = new CanonicalForgeRuntime(fixture.config, dependencies);
    cleanups.push(() => first.stop('TEST_CLEANUP'));
    await first.start();

    const firstGeneration = readRuntimeGeneration(fixture.controllerHome);
    expect(firstGeneration).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      controllerHome: resolve(fixture.controllerHome),
      source: {
        repoRoot: resolve(fixture.repositoryRoot),
        canonicalRoot: realpathSync(fixture.repositoryRoot),
        branch: null,
        dirty: false,
      },
    });
    await first.stop('TEST_RESTART');

    const second = new CanonicalForgeRuntime({
      ...fixture.config,
      runtimeInstanceId: 'runtime-source-snapshot-two',
    }, dependencies);
    cleanups.push(() => second.stop('TEST_CLEANUP'));
    await second.start();

    const secondGeneration = readRuntimeGeneration(fixture.controllerHome);
    expect(secondGeneration?.revision).toBe(2);
    expect(secondGeneration?.generation).not.toBe(firstGeneration?.generation);
  });

  test('does not start a standalone Browser Automation helper even when a legacy release manifest declares one', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'runtime-browser-helper-retired' });
    let schedulerStarted = false;
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      loadReleaseManifest: () => ({
        schemaVersion: 1,
        releaseId: 'release-test-1',
        artifactIdentity: 'sha256:test-artifact',
        entrypoint: 'forge-runtime',
        browserAutomationHelperEntrypoint: 'browser-automation-helper',
        browserAutomationHelperArtifactIdentity: `sha256:${'a'.repeat(64)}`,
        browserAutomationHelperContractIdentity: `sha256:${'b'.repeat(64)}`,
        arguments: [],
        configurationSchemaVersion: 1,
        controllerHome: resolve(fixture.controllerHome),
        databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
        workerProtocolVersion: 1,
        createdAt: '2026-08-05T00:00:00.000Z',
      }),
      startScheduler: () => {
        schedulerStarted = true;
        return inertScheduler();
      },
      startLocalBridge: async () => undefined,
      startTransport: async () => ({
        endpoint: 'http://127.0.0.1:9876/mcp',
        host: '127.0.0.1',
        port: 9876,
        close: async () => undefined,
      }),
      runMcpProbe: async () => undefined,
    });
    cleanups.push(() => runtime.stop('TEST_CLEANUP'));
    await runtime.start();
    expect(schedulerStarted).toBe(true);
  });

  test('canonical Runtime owns the configured embedded Local Bridge lifecycle', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'runtime-embedded-local-bridge' });
    let localBridgeStarted = false;
    let localBridgeClosed = false;
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      startScheduler: () => inertScheduler(),
      startLocalBridge: async (input) => {
        localBridgeStarted = true;
        expect(input).toEqual({
          controllerHome: fixture.controllerHome,
          repositoryRoot: fixture.repositoryRoot,
        });
        return {
          endpoint: 'http://127.0.0.1:8766/',
          close: async () => { localBridgeClosed = true; },
        };
      },
      startTransport: async () => ({
        endpoint: 'http://127.0.0.1:9876/mcp',
        host: '127.0.0.1',
        port: 9876,
        close: async () => undefined,
      }),
      runMcpProbe: async () => undefined,
    });

    await runtime.start();
    expect(localBridgeStarted).toBe(true);
    expect(localBridgeClosed).toBe(false);
    await runtime.stop('TEST_LOCAL_BRIDGE_CLOSE');
    expect(localBridgeClosed).toBe(true);
  });

  test('configured embedded Local Bridge publishes live same-process evidence', async () => {
    const fixture = createFixture();
    spawnSync('git', ['init', '-b', 'main'], { cwd: fixture.repositoryRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: fixture.repositoryRoot, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'forge-test@example.invalid'], { cwd: fixture.repositoryRoot, encoding: 'utf8' });
    writeFileSync(join(fixture.repositoryRoot, 'README.md'), '# fixture\n', 'utf8');
    spawnSync('git', ['add', 'README.md'], { cwd: fixture.repositoryRoot, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'test fixture'], { cwd: fixture.repositoryRoot, encoding: 'utf8' });
    writeMcpServiceLocalConfig(fixture.controllerHome, {
      version: 1,
      localController: { enabled: true, mode: 'embedded', host: '127.0.0.1', port: 0 },
    });
    writeMcpServiceRuntimeState(fixture.controllerHome, {
      version: 1,
      repo: fixture.repositoryRoot,
      startedAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      status: 'running',
      tunnelMode: 'none',
      server: {
        endpoint: 'http://127.0.0.1:8765/mcp',
        running: true,
        healthy: true,
        restartCount: 0,
      },
    });

    const bridge = await startConfiguredRuntimeLocalBridge({
      controllerHome: fixture.controllerHome,
      repositoryRoot: fixture.repositoryRoot,
    });
    expect(bridge).toBeTruthy();
    cleanups.push(() => bridge?.close());
    const health = await fetch(new URL('/health', bridge!.endpoint)).then((response) => response.json()) as Record<string, unknown>;
    expect(health).toMatchObject({
      status: 'ok',
      localOnly: true,
      mode: 'embedded',
    });
    expect(health.repoRoot).toBeUndefined();
    expect(loadMcpServiceRuntimeState(fixture.controllerHome)?.localController).toMatchObject({
      endpoint: bridge!.endpoint,
      running: true,
      mode: 'embedded',
      pid: process.pid,
    });

    await bridge!.close();
    expect(loadMcpServiceRuntimeState(fixture.controllerHome)?.localController?.running).toBe(false);
  });

  test('source snapshot failure stops startup before mutable services are admitted', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'runtime-source-snapshot-failure' });
    let databaseInspected = false;
    let schedulerStarted = false;
    let transportStarted = false;
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      rotateRuntimeGeneration: () => {
        throw new Error('injected source snapshot failure');
      },
      inspectDatabase: () => {
        databaseInspected = true;
        throw new Error('database should not be inspected');
      },
      startScheduler: () => {
        schedulerStarted = true;
        return inertScheduler();
      },
      startTransport: async () => {
        transportStarted = true;
        throw new Error('transport should not start');
      },
    });

    await expect(runtime.start()).rejects.toThrow('injected source snapshot failure');
    expect(databaseInspected).toBe(false);
    expect(schedulerStarted).toBe(false);
    expect(transportStarted).toBe(false);
    expect(getRuntimeWriteClaim()).toBeUndefined();
    expect(readRuntimeGeneration(fixture.controllerHome)).toBeUndefined();
    expect(runtime.lastExit?.reasonCode).toBe('RUNTIME_SOURCE_SNAPSHOT_FAILED');
    expect(runtime.readiness()).toMatchObject({
      ready: false,
      diagnostics: {
        releaseCoherence: {
          outcome: 'fail',
          reasonCode: 'RUNTIME_SOURCE_SNAPSHOT_FAILED',
        },
      },
    });
  });

  test('write-claim failure remains a release-coherence failure after source snapshot succeeds', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'runtime-write-claim-failure' });
    let databaseInspected = false;
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      bindWriteClaim: () => {
        throw new Error('injected write claim failure');
      },
      inspectDatabase: () => {
        databaseInspected = true;
        throw new Error('database should not be inspected');
      },
    });

    await expect(runtime.start()).rejects.toThrow('injected write claim failure');
    expect(databaseInspected).toBe(false);
    expect(getRuntimeWriteClaim()).toBeUndefined();
    expect(readRuntimeGeneration(fixture.controllerHome)?.revision).toBe(1);
    expect(runtime.lastExit?.reasonCode).toBe('RELEASE_COHERENCE_FAILED');
    expect(runtime.readiness()).toMatchObject({
      ready: false,
      diagnostics: {
        releaseCoherence: {
          outcome: 'fail',
          reasonCode: 'RELEASE_COHERENCE_FAILED',
        },
      },
    });
  });

  test('Runtime Root publishes one instance-bound status projection and removes it on exit', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'runtime-status-test' });
    const stoppedLightweightHomes: string[] = [];
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      startScheduler: () => inertScheduler(),
      startTransport: async () => ({
        endpoint: 'http://127.0.0.1:9876/mcp',
        host: '127.0.0.1',
        port: 9876,
        close: async () => undefined,
      }),
      runMcpProbe: async () => undefined,
      stopLightweightProcesses: async (controllerHome) => {
        stoppedLightweightHomes.push(controllerHome);
        return 0;
      },
    });
    cleanups.push(() => runtime.stop('TEST_CLEANUP'));

    await runtime.start();
    expect(getRuntimeWriteClaim()).toMatchObject({
      controllerHome: resolve(fixture.controllerHome),
      runtimeInstanceId: 'runtime-status-test',
      ownerPid: process.pid,
    });
    expect(assertRuntimeMayWrite('scheduler_write', fixture.controllerHome)).toMatchObject({ allowed: true });
    expect(observeRuntimeStatus(fixture.controllerHome, () => '2026-08-05T00:00:01.000Z')).toMatchObject({
      running: true,
      ready: true,
      stale: false,
      snapshot: {
        runtimeInstanceId: 'runtime-status-test',
        releaseId: 'release-test-1',
        artifactIdentity: 'sha256:test-artifact',
        endpoint: 'http://127.0.0.1:9876/mcp',
      },
    });

    await runtime.stop('TEST_STOP');
    expect(stoppedLightweightHomes).toEqual([fixture.controllerHome]);
    expect(getRuntimeWriteClaim()).toBeUndefined();
    expect(observeRuntimeStatus(fixture.controllerHome, () => '2026-08-05T00:00:02.000Z')).toEqual({
      schemaVersion: 1,
      running: false,
      ready: false,
      stale: false,
      reasonCodes: ['RUNTIME_NOT_RUNNING'],
      observedAt: '2026-08-05T00:00:02.000Z',
    });
  });

  test('a stale or identity-mismatched ready projection never reports Runtime ready', () => {
    const fixture = createFixture();
    const owner = acquireRuntimeOwnership(fixture.controllerHome, 'runtime-real-owner');
    cleanups.push(() => owner.release());
    writeRuntimeStatusSnapshot(fixture.controllerHome, {
      schemaVersion: 1,
      runtimeInstanceId: 'runtime-forged-status',
      pid: process.pid,
      releaseId: 'release-test-1',
      artifactIdentity: 'sha256:test-artifact',
      endpoint: 'http://127.0.0.1:9876/mcp',
      readiness: {
        ready: true,
        reasonCodes: [],
        diagnostics: {
          database: { outcome: 'pass' },
          scheduler: { outcome: 'pass' },
          releaseCoherence: { outcome: 'pass' },
          mcpEndToEnd: { outcome: 'pass' },
        },
        observedAt: '2026-08-05T00:00:00.000Z',
      },
      startedAt: owner.record.acquiredAt,
      updatedAt: '2026-08-05T00:00:00.000Z',
    });

    expect(observeRuntimeStatus(fixture.controllerHome)).toMatchObject({
      running: false,
      ready: false,
      stale: true,
      reasonCodes: ['RUNTIME_STATUS_STALE'],
      snapshot: { runtimeInstanceId: 'runtime-forged-status' },
    });
  });

  test('duplicate active Runtime ownership is rejected without port inference', () => {
    const fixture = createFixture();
    const first = acquireRuntimeOwnership(fixture.controllerHome, 'runtime-one');
    cleanups.push(() => first.release());
    expect(() => acquireRuntimeOwnership(fixture.controllerHome, 'runtime-two'))
      .toThrow('RUNTIME_OWNERSHIP_CONFLICT');
  });

  test('exclusive Work admission persists and blocks ordinary create/continue', () => {
    const fixture = createFixture();
    inspectControlPlaneDatabase(fixture.controllerHome);
    createWorkContract(
      { controllerHome: fixture.controllerHome, repoId: 'repo-test' },
      workInput('WORK-HISTORICAL'),
    );
    const submittedInput = {
      requestId: 'request-before-isolation',
      repoId: 'repo-test',
      semanticKey: 'repository.status:readonly',
      operation: {
        name: 'repository_status',
        semanticKey: 'repository.status:readonly',
        argumentHash: 'sha256:test-status',
        mode: 'readonly' as const,
        idempotent: true,
        replayable: true,
        resourceClaims: [],
      },
    };
    const acceptedBeforeIsolation = acceptSubmittedWorkContract(fixture.controllerHome, submittedInput);
    activateExclusiveWorkAdmission(fixture.controllerHome, {
      allowedWorkId: 'WORK-P0',
      reason: 'P0 migration',
    });
    expect(readWorkAdmissionPolicy(fixture.controllerHome)).toMatchObject({
      mode: 'exclusive_work',
      allowedWorkId: 'WORK-P0',
      allowReadOnlyDiagnostics: true,
    });
    expect(() => createWorkContract(
      { controllerHome: fixture.controllerHome, repoId: 'repo-test' },
      workInput('WORK-ORDINARY'),
    )).toThrow('WORK_ADMISSION_BLOCKED');
    expect(() => updateWorkContract(
      { controllerHome: fixture.controllerHome, repoId: 'repo-test' },
      'WORK-HISTORICAL',
      { status: 'blocked' },
    )).toThrow('WORK_ADMISSION_BLOCKED');
    expect(updateWorkContract(
      { controllerHome: fixture.controllerHome, repoId: 'repo-test' },
      'WORK-HISTORICAL',
      { status: 'cancelled' },
    ).status).toBe('cancelled');
    const acceptedRetry = acceptSubmittedWorkContract(fixture.controllerHome, submittedInput);
    expect(acceptedRetry.deduplicated).toBe(true);
    expect(acceptedRetry.contract.workId).toBe(acceptedBeforeIsolation.contract.workId);
    const p0 = createWorkContract(
      { controllerHome: fixture.controllerHome, repoId: 'repo-test' },
      workInput('WORK-P0'),
    );
    expect(updateWorkContract(
      { controllerHome: fixture.controllerHome, repoId: 'repo-test' },
      p0.workId,
      { continuationPrompt: 'Continue the P0 migration.' },
    ).continuationPrompt).toContain('P0');
  });

  test('missing explicit Runtime parameters fail closed', async () => {
    const fixture = createFixture();
    expect(() => new CanonicalForgeRuntime({ ...fixture.config, authToken: '' }))
      .toThrow('RUNTIME_CONFIG_REQUIRED: authToken');
    expect(() => new CanonicalForgeRuntime({
      ...fixture.config,
      repositoryRoot: join(fixture.root, 'missing-repository'),
    })).toThrow('RUNTIME_CONFIG_INVALID: repositoryRoot');
    writeFileSync(fixture.manifestPath, JSON.stringify({
      schemaVersion: 1,
      releaseId: 'bad',
      artifactIdentity: 'sha256:bad',
      entrypoint: 'forge-runtime',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome: join(fixture.root, 'other-home'),
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: 1,
      createdAt: '2026-08-05T00:00:00.000Z',
    }), 'utf8');
    const runtime = new CanonicalForgeRuntime(fixture.config);
    await expect(runtime.start()).rejects.toThrow('RELEASE_MANIFEST_CONTROLLER_HOME_MISMATCH');
  });

  test('SQLite initialization failure stops the whole Runtime', async () => {
    const fixture = createFixture();
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      inspectDatabase: () => { throw new Error('injected sqlite open failure'); },
    });
    await expect(runtime.start()).rejects.toThrow('injected sqlite open failure');
    expect(runtime.readiness()).toMatchObject({
      ready: false,
      diagnostics: { database: { outcome: 'fail', reasonCode: 'DATABASE_UNAVAILABLE' } },
    });
    expect(runtime.lastExit?.reasonCode).toBe('DATABASE_UNAVAILABLE');
  });

  test('Scheduler initialization failure stops the whole Runtime', async () => {
    const fixture = createFixture();
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      startScheduler: () => ({
        ready: Promise.reject(new Error('injected scheduler failure')),
        done: new Promise<void>(() => undefined),
        stop: async () => undefined,
      }),
    });
    await expect(runtime.start()).rejects.toThrow('injected scheduler failure');
    expect(runtime.readiness()).toMatchObject({
      ready: false,
      diagnostics: { scheduler: { outcome: 'fail', reasonCode: 'SCHEDULER_INITIALIZATION_FAILED' } },
    });
    expect(runtime.lastExit?.reasonCode).toBe('SCHEDULER_INITIALIZATION_FAILED');
  });

  test('MCP listener failure stops Scheduler and the complete Runtime', async () => {
    const fixture = createFixture();
    let schedulerStopped = false;
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      startScheduler: () => ({
        ...inertScheduler(),
        stop: async () => { schedulerStopped = true; },
      }),
      startTransport: async () => { throw new Error('injected listener failure'); },
    });
    await expect(runtime.start()).rejects.toThrow('injected listener failure');
    expect(schedulerStopped).toBe(true);
    expect(runtime.lastExit?.reasonCode).toBe('MCP_LISTENER_FAILED');
    expect(runtime.readiness().ready).toBe(false);
  });

  test('a fatal Scheduler runtime error shuts down the complete Runtime', async () => {
    const fixture = createFixture();
    let rejectScheduler!: (error: Error) => void;
    let transportClosed = false;
    const schedulerDone = new Promise<void>((_resolve, reject) => { rejectScheduler = reject; });
    const overrides: Partial<CanonicalRuntimeDependencies> = {
      startScheduler: () => ({
        ready: Promise.resolve(),
        done: schedulerDone,
        stop: async () => undefined,
      }),
      startTransport: async () => ({
        endpoint: 'http://127.0.0.1:1/mcp',
        host: '127.0.0.1',
        port: 1,
        close: async () => { transportClosed = true; },
      }),
      runMcpProbe: async () => undefined,
    };
    const runtime = new CanonicalForgeRuntime(fixture.config, overrides);
    await runtime.start();
    rejectScheduler(new Error('injected scheduler stall'));
    await Promise.race([
      runtime.waitForStopped(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime did not stop')), 2_000)),
    ]);
    expect(transportClosed).toBe(true);
    expect(runtime.lastExit?.reasonCode).toBe('SCHEDULER_STALLED');
    expect(runtime.readiness()).toMatchObject({
      ready: false,
      diagnostics: { scheduler: { outcome: 'fail', reasonCode: 'SCHEDULER_STALLED' } },
    });
  });

  test('ordered shutdown closes MCP ingress before Scheduler and releases Controller Home ownership', async () => {
    const fixture = createFixture();
    const stopped: string[] = [];
    const scheduler = inertScheduler();
    const runtime = new CanonicalForgeRuntime(fixture.config, {
      startScheduler: () => ({
        ...scheduler,
        stop: async () => {
          stopped.push('scheduler');
          await scheduler.stop();
        },
      }),
      startTransport: async () => ({
        endpoint: 'http://127.0.0.1:1/mcp',
        host: '127.0.0.1',
        port: 1,
        close: async () => { stopped.push('transport'); },
      }),
      runMcpProbe: async () => undefined,
      stopLightweightProcesses: async () => {
        stopped.push('lightweight');
        return 0;
      },
      stopContextReadHelpers: async () => { stopped.push('context-read-helpers'); },
    });
    await runtime.start();
    await runtime.stop('TEST_SHUTDOWN');
    expect(stopped).toEqual(['transport', 'lightweight', 'context-read-helpers', 'scheduler']);
    expect(runtime.readiness().ready).toBe(false);
    const replacement = acquireRuntimeOwnership(fixture.controllerHome, 'replacement-runtime');
    replacement.release();
  });
});
