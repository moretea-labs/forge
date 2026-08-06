import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
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
  CanonicalRepoHarnessRuntime,
  type CanonicalRuntimeDependencies,
} from '../../src/runtime/root/runtime';
import type { CanonicalRuntimeConfig } from '../../src/runtime/root/types';

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
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-single-runtime-'));
  const controllerHome = join(root, 'controller');
  const repositoryRoot = join(root, 'repository');
  mkdirSync(repositoryRoot, { recursive: true });
  const manifestPath = join(root, 'release.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'release-test-1',
    artifactIdentity: 'sha256:test-artifact',
    entrypoint: 'repo-harness-runtime',
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

async function callControllerReady(endpoint: string, token: string): Promise<Record<string, unknown>> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'canonical-runtime-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('controller_ready');
    const result = await client.callTool({ name: 'controller_ready', arguments: {} });
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

  test('one process serves authenticated initialize, tools/list, Controller call, and SQLite read', async () => {
    const fixture = createFixture({ exclusiveWorkId: 'WORK-P0' });
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config);
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
    const snapshot = await callControllerReady(endpoint!, fixture.config.authToken);
    expect((snapshot.database as Record<string, unknown>).integrity).toBe('ok');
    expect((snapshot.readiness as Record<string, unknown>).ready).toBe(true);

    const unauthorized = await fetch(endpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauthorized.status).toBe(401);
  }, 20_000);

  test('Runtime Root publishes one instance-bound status projection and removes it on exit', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'runtime-status-test' });
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config, {
      startScheduler: () => inertScheduler(),
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
    expect(() => new CanonicalRepoHarnessRuntime({ ...fixture.config, authToken: '' }))
      .toThrow('RUNTIME_CONFIG_REQUIRED: authToken');
    expect(() => new CanonicalRepoHarnessRuntime({
      ...fixture.config,
      repositoryRoot: join(fixture.root, 'missing-repository'),
    })).toThrow('RUNTIME_CONFIG_INVALID: repositoryRoot');
    writeFileSync(fixture.manifestPath, JSON.stringify({
      schemaVersion: 1,
      releaseId: 'bad',
      artifactIdentity: 'sha256:bad',
      entrypoint: 'repo-harness-runtime',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome: join(fixture.root, 'other-home'),
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: 1,
      createdAt: '2026-08-05T00:00:00.000Z',
    }), 'utf8');
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config);
    await expect(runtime.start()).rejects.toThrow('RELEASE_MANIFEST_CONTROLLER_HOME_MISMATCH');
  });

  test('SQLite initialization failure stops the whole Runtime', async () => {
    const fixture = createFixture();
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config, {
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
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config, {
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
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config, {
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
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config, overrides);
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
    const runtime = new CanonicalRepoHarnessRuntime(fixture.config, {
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
    });
    await runtime.start();
    await runtime.stop('TEST_SHUTDOWN');
    expect(stopped).toEqual(['transport', 'scheduler']);
    expect(runtime.readiness().ready).toBe(false);
    const replacement = acquireRuntimeOwnership(fixture.controllerHome, 'replacement-runtime');
    replacement.release();
  });
});
