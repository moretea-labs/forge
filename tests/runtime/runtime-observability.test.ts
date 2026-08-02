import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'http';
import { join } from 'path';
import { tmpdir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { classifyFailure } from '../../src/runtime/recovery/classifier';
import { evaluateRuntimeHealth, type RuntimeHealthObservations } from '../../src/runtime/health';
import {
  projectionBlocksReadiness,
  projectionObservation,
  reconcileProjectionWithTaskLedger,
  type RepositoryRuntimeProjectionSnapshot,
} from '../../src/runtime/projections/materialized-view';
import type { TaskLedgerProjection } from '../../src/cli/controller/task-ledger';
import { recordMcpIncident, recordMcpTiming } from '../../src/runtime/diagnostics/mcp-timing';
import {
  probeSupervisorGatewayHealth,
  supervisorGatewayHealthDecision,
} from '../../src/runtime/supervisor/supervisor-runtime';
import { SUPERVISOR_RELEASE_ENTRYPOINTS, supervisorReleaseClosureMissing } from '../../src/runtime/supervisor/paths';
import { publishSupervisorRelease, stageSupervisorRelease, verifySupervisorReleaseExecutionCanary } from '../../src/runtime/supervisor/installer';
import { STANDALONE_RECOVERY_REQUIRED_RELEASE_FILES } from '../../src/runtime/standalone-recovery/core';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { createMcpToolContext as createMultiRepositoryContext } from '../../src/cli/mcp/multi-repository';
import { createRepoHarnessMcpServer } from '../../src/cli/mcp/server';
import { createStableIngressRouter } from '../../src/runtime/supervisor/ingress-router';
import { StableIngressSessionStore } from '../../src/runtime/supervisor/ingress-session-store';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';

function observations(overrides: Partial<RuntimeHealthObservations> = {}): RuntimeHealthObservations {
  return {
    daemon: { status: 'ready', heartbeatAgeMs: 0 },
    scheduler: { status: 'ready', heartbeatAgeMs: 0 },
    workers: { queueDepth: 0, runningWorkers: 0, activeLeases: 0 },
    projection: { readable: true, persisted: true },
    localBridge: {
      enabled: false,
      requiredForReadiness: false,
      mode: 'disabled',
      endpointReachable: true,
      expectedSurface: true,
    },
    runtimeStorage: { readable: true, ready: true },
    ...overrides,
  };
}

function projectionSnapshot(): RepositoryRuntimeProjectionSnapshot {
  return {
    projection: {
      schemaVersion: 1,
      repoId: 'repo-1',
      generatedAt: new Date(0).toISOString(),
      revision: 1,
      releaseFrozen: false,
      activeJobs: [],
      queueDepth: 0,
      runningWorkers: 0,
      activeLeases: 0,
      currentAttention: [],
      attention: [],
    },
    stale: false,
    persisted: true,
  };
}

function ledgerWithRunningTask(): TaskLedgerProjection {
  return {
    schemaVersion: 2,
    generatedAt: new Date(0).toISOString(),
    source: 'controller-task-ledger',
    counts: { running: 1 },
    declaredCounts: { running: 1 },
    archivedCounts: {},
    issueCount: 1,
    archivedIssueCount: 0,
    status: {
      kind: 'active_work',
      severity: 'info',
      label: 'Work in progress',
      reason: 'fixture',
      nextAction: 'fixture',
    },
    issues: [{
      id: 'I1',
      title: 'Fixture',
      isCurrent: true,
      taskCounts: { running: 1 },
      tasks: [{
        issueId: 'I1',
        taskId: 'T3',
        title: 'Running task',
        effectiveStatus: 'running',
        retryable: false,
        requiresExplicitRetry: false,
        dispatchable: false,
        queueable: false,
        multipleActiveRuns: false,
        allowedPaths: [],
        checks: [],
        runIds: [],
      }],
    }],
    attention: [],
    readyTasks: [],
    queueableTasks: [],
    recentEvents: [],
    suggestedNextActions: [],
    contextContract: {
      strategy: 'fixture',
      rawCodeRequiredForImplementation: true,
      notes: [],
    },
  };
}

async function withEnvironment(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Local-dev controller home: a live-PID daemon record (test process) and a
 * registered repository, so `controller_ready` evaluates readiness without a
 * real Controller Daemon process. Scheduler/projection files are intentionally
 * absent: the evaluator degrades those to warnings, not blockers.
 */
function controllerFixture(): { controllerHome: string; repoRoot: string } {
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-obs-ch-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-obs-repo-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(controllerHome, 'daemon'), { recursive: true });
  const now = new Date().toISOString();
  writeJsonAtomic(join(controllerHome, 'daemon', 'state.json'), {
    schemaVersion: 1,
    status: 'ready',
    pid: process.pid,
    startedAt: now,
  });
  writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`);
  // A fresh Scheduler heartbeat keeps the live daemon record `ready` instead of
  // falling into the startup-grace window with a stale heartbeat.
  mkdirSync(join(controllerHome, 'scheduler'), { recursive: true });
  writeJsonAtomic(join(controllerHome, 'scheduler', 'state.json'), {
    schemaVersion: 1,
    updatedAt: now,
    loopStartedAt: now,
    lastHeartbeatAt: now,
    lastTickAt: now,
    lastDispatchAt: now,
    lastRepoDispatch: {},
  });
  return { controllerHome, repoRoot };
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

describe('runtime observability', () => {
  test('keeps readiness true while exposing an unknown external endpoint', () => {
    const health = evaluateRuntimeHealth(observations({
      externalReachability: { status: 'unknown', detail: 'public endpoint probe is not configured' },
    }));

    expect(health.ready).toBe(true);
    expect(health.components.externalReachability).toMatchObject({ state: 'warning', ready: true });
    expect(health.warnings.map((item) => item.code)).toContain('EXTERNAL_ENDPOINT_UNKNOWN');
  });

  test('blocks readiness for a known unhealthy external endpoint', () => {
    const health = evaluateRuntimeHealth(observations({
      externalReachability: { status: 'unhealthy', detail: 'probe_timeout' },
    }));

    expect(health.ready).toBe(false);
    expect(health.activeBlockers.map((item) => item.code)).toContain('EXTERNAL_ENDPOINT_UNHEALTHY');
  });

  test('controller_ready with no public endpoint env keeps local development ready and unknown', async () => {
    const { controllerHome, repoRoot } = controllerFixture();
    try {
      await withEnvironment({ REPO_HARNESS_SUPERVISOR_PUBLIC_HEALTH_ENDPOINT: undefined }, async () => {
        const ctx = createMultiRepositoryContext({ repo: repoRoot, profile: 'controller', toolset: 'full', controllerHome });
        const result = await callRuntimeTool(ctx, 'controller_ready', {});
        expect(result).toBeTruthy();
        const payload = JSON.parse(result!.content[0].text) as Record<string, unknown>;

        expect(payload.ready).toBe(true);
        expect(payload.externalEndpoint).toMatchObject({ status: 'unknown' });
        const externalReachability = (payload.health as { components: Record<string, unknown> }).components
          .externalReachability as { state: string; ready: boolean };
        expect(externalReachability).toMatchObject({ state: 'warning', ready: true });
        const reasons = payload.reasons as Array<{ code: string }>;
        expect(reasons.map((item) => item.code)).not.toContain('PUBLIC_STABLE_ENDPOINT_UNHEALTHY');
      });
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('controller_ready blocks with PUBLIC_STABLE_ENDPOINT_UNHEALTHY when the configured endpoint is unhealthy', async () => {
    const { controllerHome, repoRoot } = controllerFixture();
    try {
      const now = new Date().toISOString();
      mkdirSync(join(controllerHome, 'supervisor'), { recursive: true });
      writeJsonAtomic(join(controllerHome, 'supervisor', 'state.json'), {
        schemaVersion: 1,
        supervisor: { pid: process.pid, epoch: 1, startedAt: now },
        desiredState: 'running',
        observedState: 'degraded',
        activeSlot: 'blue',
        activeGeneration: 'gen-1',
        controllerDaemon: { state: 'running', slot: 'blue', generation: 'gen-1', pid: process.pid },
        gatewayHost: { state: 'running', slot: 'blue', generation: 'gen-1', pid: process.pid },
        ingress: { state: 'running', activeUpstreamSlot: 'blue', activeUpstreamPort: 43210, pid: process.pid, consecutiveFailures: 0 },
        restartBudget: {},
        externalEndpointHealthy: false,
        externalEndpointLastCheckedAt: now,
        externalEndpointLastDetail: 'probe_timeout: fixture upstream unreachable',
        updatedAt: now,
      });
      await withEnvironment({
        REPO_HARNESS_SUPERVISOR_PUBLIC_HEALTH_ENDPOINT: 'http://127.0.0.1:9/ready',
      }, async () => {
        const ctx = createMultiRepositoryContext({ repo: repoRoot, profile: 'controller', toolset: 'full', controllerHome });
        const result = await callRuntimeTool(ctx, 'controller_ready', {});
        expect(result).toBeTruthy();
        const payload = JSON.parse(result!.content[0].text) as Record<string, unknown>;

        expect(payload.ready).toBe(false);
        expect(payload.externalEndpoint).toMatchObject({ status: 'unhealthy' });
        const reasons = payload.reasons as Array<{ code: string }>;
        expect(reasons.map((item) => item.code)).toContain('PUBLIC_STABLE_ENDPOINT_UNHEALTHY');
      });
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('detects a running Task Ledger task missing from the runtime projection', () => {
    const snapshot = projectionSnapshot();
    const reconciliation = reconcileProjectionWithTaskLedger(snapshot, ledgerWithRunningTask());
    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      blocking: true,
      projectionRunningWorkers: 0,
      ledgerRunningTasks: 1,
    });
    // The ledger-running/zero-worker gap is a bounded readiness blocker.
    expect(projectionBlocksReadiness(snapshot, reconciliation)).toBe(true);
    const observation = projectionObservation(snapshot, reconciliation);
    expect(observation.sourceReconciliation?.status).toBe('mismatch');
    const health = evaluateRuntimeHealth(observations({ projection: observation }));
    expect(health.ready).toBe(false);
    expect(health.activeBlockers.map((item) => item.code)).toContain('PROJECTION_SOURCE_MISMATCH');
  });

  test('keeps a non-blocking ledger contradiction diagnostic without changing projectionBlocksReadiness', () => {
    const snapshot = projectionSnapshot();
    const contradictory = { ...snapshot, projection: { ...snapshot.projection, runningWorkers: 2 } };
    const reconciliation = reconcileProjectionWithTaskLedger(contradictory, ledgerWithRunningTask());
    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      blocking: false,
      projectionRunningWorkers: 2,
      ledgerRunningTasks: 1,
    });
    expect(reconciliation.detail).toContain('runningWorkers=2');
    const observation = projectionObservation(contradictory, reconciliation);
    expect(observation.sourceReconciliation?.status).toBe('mismatch');
    expect(observation.sourceReconciliation?.detail).toBeTruthy();
    // The contradiction is diagnostic evidence; the readiness decision keeps its
    // original value (a fresh, non-stale snapshot is not blocking).
    expect(projectionBlocksReadiness(contradictory, reconciliation))
      .toBe(projectionBlocksReadiness(contradictory));
    expect(projectionBlocksReadiness(contradictory, reconciliation)).toBe(false);
    const health = evaluateRuntimeHealth(observations({ projection: observation }));
    expect(health.ready).toBe(true);
    expect(health.warnings.map((item) => item.code)).toContain('PROJECTION_SOURCE_MISMATCH');
    expect(health.activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_SOURCE_MISMATCH');
  });

  test('classifies supervisor probe aborts separately from generic runtime failures', () => {
    expect(classifyFailure('probe_timeout: operation was aborted')).toBe('transient_probe_timeout');
    expect(classifyFailure('worker quit unexpectedly')).toBe('agent_runtime_failure');
  });

  test('counts deadline probe timeouts but never preemption aborts against the recovery budget', async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Deadline abort: the internal timer fires and aborts the fetch.
      globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;
      const deadline = await probeSupervisorGatewayHealth('http://127.0.0.1:9/ready', 25);
      expect(deadline.healthy).toBe(false);
      expect(deadline.failureClass).toBe('probe_timeout');
      expect(deadline.timedOut).toBe(true);
      const counted = supervisorGatewayHealthDecision(2, false, deadline.failureClass === 'probe_cancelled');
      expect(counted.consecutiveFailures).toBe(3);
      expect(counted.shouldRecover).toBe(false);

      // Preemption abort: the caller aborts before the deadline; the timer never fired.
      globalThis.fetch = (() => Promise.reject(
        Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      )) as unknown as typeof fetch;
      const preempted = await probeSupervisorGatewayHealth('http://127.0.0.1:9/ready', 5_000);
      expect(preempted.healthy).toBe(false);
      expect(preempted.failureClass).toBe('probe_cancelled');
      expect(preempted.timedOut).toBeUndefined();
      const unchanged = supervisorGatewayHealthDecision(2, false, preempted.failureClass === 'probe_cancelled');
      expect(unchanged.consecutiveFailures).toBe(2);
      expect(unchanged.shouldRecover).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('persists request-level MCP timing and incident records with the same trace identity', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-observability-'));
    try {
      const traceId = 'trace-fixture';
      const requestId = 'request-fixture';
      recordMcpTiming(controllerHome, {
        tool: 'controller_ready',
        traceId,
        requestId,
        outcome: 'error',
        errorCode: 'PUBLIC_STABLE_ENDPOINT_UNHEALTHY',
        totalToolDurationMs: 12,
      });
      recordMcpIncident(controllerHome, {
        traceId,
        requestId,
        tool: 'controller_ready',
        kind: 'tool_error',
        code: 'PUBLIC_STABLE_ENDPOINT_UNHEALTHY',
        message: 'fixture',
      });
      const timing = JSON.parse(readFileSync(join(controllerHome, 'audit', 'mcp-timings.jsonl'), 'utf8')) as Record<string, unknown>;
      const incident = JSON.parse(readFileSync(join(controllerHome, 'audit', 'mcp-incidents.jsonl'), 'utf8')) as Record<string, unknown>;
      expect(timing).toMatchObject({ traceId, requestId, outcome: 'error' });
      expect(incident).toMatchObject({ traceId, requestId, code: 'PUBLIC_STABLE_ENDPOINT_UNHEALTHY' });
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('serves a bounded Core tools/list by default and retains explicit Advanced compatibility', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-core-tools-'));
    const listNames = async (toolset?: 'core' | 'advanced') => {
      const server = createRepoHarnessMcpServer({ controllerHome, profile: 'controller', ...(toolset ? { toolset } : {}) });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: `runtime-tools-${toolset ?? 'default'}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(clientTransport);
      try {
        return (await client.listTools()).tools.map((tool) => tool.name);
      } finally {
        await client.close();
        await server.close();
      }
    };
    try {
      const coreNames = await listNames();
      expect(coreNames.length).toBeLessThan(25);
      expect(coreNames).toEqual(expect.arrayContaining(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']));
      expect(coreNames).not.toContain('repository_command_execute');
      expect(coreNames).not.toContain('controller_rollout');

      const advancedNames = await listNames('advanced');
      expect(advancedNames.length).toBe(133);
      expect(advancedNames).toContain('repository_command_execute');
      expect(advancedNames).toContain('controller_rollout');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('writes the same trace identity into response metadata and incident records', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-trace-'));
    const server = createRepoHarnessMcpServer({ controllerHome, profile: 'controller', toolset: 'full' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'runtime-observability', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'no_such_runtime_tool', arguments: {} });
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      const meta = structured?.responseMeta as Record<string, unknown> | undefined;
      expect(meta?.traceId).toBeTruthy();
      const traceId = String(meta!.traceId);
      const incidents = readFileSync(join(controllerHome, 'audit', 'mcp-incidents.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as { traceId: string; code: string });
      expect(incidents.some((entry) => entry.traceId === traceId && entry.code === 'TOOL_NOT_FOUND')).toBe(true);
      const timings = readFileSync(join(controllerHome, 'audit', 'mcp-timings.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line) as { traceId: string });
      expect(timings.some((entry) => entry.traceId === traceId)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('detects missing and empty executables in an immutable release closure', () => {
    const releasePath = mkdtempSync(join(tmpdir(), 'repo-harness-closure-'));
    try {
      writeFileSync(join(releasePath, 'supervisor.js'), '// supervisor\n');
      expect(supervisorReleaseClosureMissing(releasePath))
        .toEqual(SUPERVISOR_RELEASE_ENTRYPOINTS.filter((entry) => entry !== 'supervisor.js'));
      expect(supervisorReleaseClosureMissing(releasePath)).toContain('process-runner.js');
      writeFileSync(join(releasePath, 'process-runner.js'), '// runner\n');
      expect(supervisorReleaseClosureMissing(releasePath)).not.toContain('process-runner.js');
      writeFileSync(join(releasePath, 'daemon.js'), '');
      expect(supervisorReleaseClosureMissing(releasePath)).toContain('daemon.js');
      for (const entry of SUPERVISOR_RELEASE_ENTRYPOINTS) {
        writeFileSync(join(releasePath, entry), `// ${entry}\n`);
      }
      expect(supervisorReleaseClosureMissing(releasePath)).toEqual([]);
    } finally {
      rmSync(releasePath, { recursive: true, force: true });
    }
  });

  test('keeps standalone recovery and Supervisor release entrypoint contracts aligned', () => {
    expect([...STANDALONE_RECOVERY_REQUIRED_RELEASE_FILES]).toEqual([...SUPERVISOR_RELEASE_ENTRYPOINTS]);
  });

  test('atomically stages a complete release whose bundled process runner passes a real canary', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-stage-release-'));
    try {
      const staged = stageSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        sourceRoot: process.cwd(),
        allowDirtyRuntimeSourceForTests: true,
      });
      expect(supervisorReleaseClosureMissing(staged.releasePath)).toEqual([]);
      const canary = verifySupervisorReleaseExecutionCanary({
        releasePath: staged.releasePath,
        cwd: process.cwd(),
      });
      expect(canary).toMatchObject({ exitCode: 0, commandExecutedOnce: true });
      const manifest = JSON.parse(readFileSync(join(staged.releasePath, 'manifest.json'), 'utf8')) as {
        artifacts?: Record<string, { sha256?: string }>;
        capabilities?: string[];
      };
      expect(manifest.artifacts?.['process-runner.js']?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.capabilities).toContain('process_runner_canary');
      expect(readdirSync(join(controllerHome, 'supervisor', 'releases')).some((name) => name.includes('.staging-'))).toBe(false);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('publishSupervisorRelease refuses a release with an incomplete execution surface', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-publish-'));
    try {
      const releasePath = join(controllerHome, 'supervisor', 'releases', 'fixture-rev');
      mkdirSync(releasePath, { recursive: true });
      for (const entry of ['supervisor.js', 'repo-harness.js', 'daemon.js']) {
        writeFileSync(join(releasePath, entry), `// ${entry}\n`);
      }
      writeFileSync(join(releasePath, 'manifest.json'), JSON.stringify({
        schemaVersion: 2,
        releaseRevision: 'fixture-rev',
        sourceCommit: 'deadbeef',
        cleanWorkspace: true,
        artifactHash: 'fixture',
      }));
      expect(() => publishSupervisorRelease({
        controllerHome,
        repoRoot: process.cwd(),
        releasePath,
        allowUnreproducibleReleaseForTests: false,
      })).toThrow(/SUPERVISOR_RELEASE_CLOSURE_INCOMPLETE/);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('controller_ready blocks a release whose execution surface is incomplete', async () => {
    const { controllerHome, repoRoot } = controllerFixture();
    try {
      const releasePath = join(controllerHome, 'supervisor', 'releases', 'fixture-rev');
      mkdirSync(releasePath, { recursive: true });
      for (const entry of ['supervisor.js', 'repo-harness.js', 'daemon.js']) {
        writeFileSync(join(releasePath, entry), `// ${entry}\n`);
      }
      symlinkSync(releasePath, join(controllerHome, 'supervisor', 'current'), 'dir');
      await withEnvironment({ REPO_HARNESS_SUPERVISOR_PUBLIC_HEALTH_ENDPOINT: undefined }, async () => {
        const ctx = createMultiRepositoryContext({ repo: repoRoot, profile: 'controller', toolset: 'full', controllerHome });
        const result = await callRuntimeTool(ctx, 'controller_ready', {});
        expect(result).toBeTruthy();
        const payload = JSON.parse(result!.content[0].text) as Record<string, unknown>;
        expect(payload.ready).toBe(false);
        expect(payload.releaseClosure).toMatchObject({
          complete: false,
          missing: expect.arrayContaining(['process-runner.js']),
        });
        const reasons = payload.reasons as Array<{ code: string }>;
        expect(reasons.map((item) => item.code)).toContain('RELEASE_CLOSURE_INCOMPLETE');
      });
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('returns MCP_SESSION_MIGRATION_PENDING when session migration hits an upstream 502', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ingress-'));
    const failingUpstream = createHttpServer((_request, response) => {
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'upstream unavailable' }));
    });
    const failingPort = await listen(failingUpstream);
    const sessionStorePath = join(controllerHome, 'supervisor', 'ingress-sessions.json');
    const store = new StableIngressSessionStore(sessionStorePath);
    const externalSessionId = 'ext-session-migration';
    store.put({
      externalSessionId,
      backendSessionId: 'backend-old',
      route: '/mcp',
      initializeBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      contentType: 'application/json',
      upstream: { host: '127.0.0.1', port: 1, key: 'old:1' },
    });
    const router = await createStableIngressRouter({
      host: '127.0.0.1',
      port: 0,
      rescueHost: '127.0.0.1',
      rescuePort: 1,
      upstream: () => ({ host: '127.0.0.1', port: failingPort, key: `new:${failingPort}` }),
      sessionStorePath,
    });
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
      const response = await new Promise<{ statusCode: number; body: string }>((resolvePromise, rejectPromise) => {
        const request = httpRequest({
          host: router.host,
          port: router.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': externalSessionId,
            'content-length': body.length,
          },
        }, (upstreamResponse) => {
          const chunks: Buffer[] = [];
          upstreamResponse.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          upstreamResponse.once('end', () => resolvePromise({
            statusCode: upstreamResponse.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        request.once('error', rejectPromise);
        request.end(body);
      });
      expect(response.statusCode).toBe(503);
      const parsed = JSON.parse(response.body) as { error: { code: string } };
      expect(parsed.error.code).toBe('MCP_SESSION_MIGRATION_PENDING');
    } finally {
      await router.close();
      await closeServer(failingUpstream);
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });
});
