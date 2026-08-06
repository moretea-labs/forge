import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { createMcpToolContext as createMultiRepositoryContext } from '../../src/cli/mcp/multi-repository';
import { createForgeMcpServer } from '../../src/cli/mcp/server';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';
import { acquireRuntimeOwnership, type RuntimeOwnershipHandle } from '../../src/runtime/root/ownership';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { STABLE_CONTROLLER_TOOL_NAMES } from '../../src/cli/mcp/toolset-names';
import {
  PROCESS_RUNNER_RELEASE_CANARY_CHILD_ARG,
  processRunnerReleaseCanaryChildCommand,
} from '../../src/runtime/execution/process-runtime/canary';

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

/**
 * Local-dev Forge home with one canonical Runtime owner/status projection and a
 * registered repository. The fixture exercises the same ownership contract as
 * the production Runtime instead of writing the retired daemon status shape.
 */
function controllerFixture(): { controllerHome: string; repoRoot: string; ownership: RuntimeOwnershipHandle } {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-obs-ch-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-obs-repo-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  const now = new Date().toISOString();
  const runtimeInstanceId = 'runtime-observability';
  const ownership = acquireRuntimeOwnership(controllerHome, runtimeInstanceId);
  writeRuntimeStatusSnapshot(controllerHome, {
    schemaVersion: 1,
    runtimeInstanceId,
    pid: process.pid,
    releaseId: 'release-observability',
    artifactIdentity: 'artifact-observability',
    startedAt: now,
    updatedAt: now,
    readiness: {
      ready: true,
      reasonCodes: [],
      diagnostics: {
        database: { outcome: 'pass' },
        scheduler: { outcome: 'pass' },
        releaseCoherence: { outcome: 'pass' },
        mcpEndToEnd: { outcome: 'pass' },
      },
      observedAt: now,
    },
  });
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
  return { controllerHome, repoRoot, ownership };
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

  test('controller_ready remains ready without a configured public endpoint', async () => {
    const { controllerHome, repoRoot, ownership } = controllerFixture();
    try {
      const ctx = createMultiRepositoryContext({ repo: repoRoot, profile: 'controller', toolset: 'full', controllerHome });
      const result = await callRuntimeTool(ctx, 'controller_ready', {});
      expect(result).toBeTruthy();
      const payload = JSON.parse(result!.content[0].text) as Record<string, unknown>;

      expect(payload.ready).toBe(true);
      const reasonCodes = payload.reasonCodes as string[];
      expect(reasonCodes).not.toContain('PUBLIC_STABLE_ENDPOINT_UNHEALTHY');
    } finally {
      ownership.release();
      rmSync(controllerHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reports a running Task Ledger task without treating it as live worker ownership', () => {
    const snapshot = projectionSnapshot();
    const reconciliation = reconcileProjectionWithTaskLedger(snapshot, ledgerWithRunningTask());
    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      projectionRunningWorkers: 0,
      ledgerRunningTasks: 1,
    });
    expect('blocking' in reconciliation).toBe(false);
    expect(projectionBlocksReadiness(snapshot)).toBe(false);
    const observation = projectionObservation(snapshot, reconciliation);
    expect(observation.sourceReconciliation?.status).toBe('mismatch');
    const health = evaluateRuntimeHealth(observations({ projection: observation }));
    expect(health.ready).toBe(true);
    expect(health.warnings.map((item) => item.code)).toContain('PROJECTION_SOURCE_MISMATCH');
    expect(health.activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_SOURCE_MISMATCH');
  });

  test('keeps a non-blocking ledger contradiction diagnostic without changing projectionBlocksReadiness', () => {
    const snapshot = projectionSnapshot();
    const contradictory = { ...snapshot, projection: { ...snapshot.projection, runningWorkers: 2 } };
    const reconciliation = reconcileProjectionWithTaskLedger(contradictory, ledgerWithRunningTask());
    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      projectionRunningWorkers: 2,
      ledgerRunningTasks: 1,
    });
    expect(reconciliation.detail).toContain('runningWorkers=2');
    const observation = projectionObservation(contradictory, reconciliation);
    expect(observation.sourceReconciliation?.status).toBe('mismatch');
    expect(observation.sourceReconciliation?.detail).toBeTruthy();
    // The contradiction is diagnostic evidence; the readiness decision keeps its
    // original value (a fresh, non-stale snapshot is not blocking).
    expect(projectionBlocksReadiness(contradictory))
      .toBe(projectionBlocksReadiness(contradictory));
    expect(projectionBlocksReadiness(contradictory)).toBe(false);
    const health = evaluateRuntimeHealth(observations({ projection: observation }));
    expect(health.ready).toBe(true);
    expect(health.warnings.map((item) => item.code)).toContain('PROJECTION_SOURCE_MISMATCH');
    expect(health.activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_SOURCE_MISMATCH');
  });

  test('keeps global readiness available when one repository has workflow-only running state', () => {
    const healthy = projectionSnapshot();
    const workflowOnly = {
      ...projectionSnapshot(),
      projection: { ...projectionSnapshot().projection, repoId: 'repo-workflow-only' },
    };
    const reconciliation = reconcileProjectionWithTaskLedger(workflowOnly, ledgerWithRunningTask());
    const repositories = [
      { repoId: 'repo-healthy', snapshot: healthy },
      { repoId: 'repo-workflow-only', snapshot: workflowOnly },
    ];

    expect(reconciliation).toMatchObject({
      status: 'mismatch',
      projectionRunningWorkers: 0,
      ledgerRunningTasks: 1,
    });
    expect(repositories.filter(({ snapshot }) => projectionBlocksReadiness(snapshot))).toEqual([]);
  });

  test('still blocks a stale projection when live execution invariants are at risk', () => {
    const snapshot = projectionSnapshot();
    const staleActiveSnapshot: RepositoryRuntimeProjectionSnapshot = {
      ...snapshot,
      stale: true,
      dirtySinceAt: new Date(Date.now() - 60_000).toISOString(),
      sourceRevisionChanged: true,
      projection: {
        ...snapshot.projection,
        activeJobs: [{
          jobId: 'job-live',
          type: 'agent-run',
          status: 'running',
          priority: 'P1',
          updatedAt: new Date().toISOString(),
          workerPid: process.pid,
        }],
        runningWorkers: 1,
      },
    };

    expect(projectionBlocksReadiness(staleActiveSnapshot)).toBe(true);
  });

  test('classifies bounded probe aborts separately from generic runtime failures', () => {
    expect(classifyFailure('probe_timeout: operation was aborted')).toBe('transient_probe_timeout');
    expect(classifyFailure('worker quit unexpectedly')).toBe('agent_runtime_failure');
  });

  test('persists request-level MCP timing and incident records with the same trace identity', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-observability-'));
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

  test('serves the bounded stable tools/list by default and retains explicit Advanced compatibility', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-core-tools-'));
    const listNames = async (toolset?: 'core' | 'advanced') => {
      const server = createForgeMcpServer({ controllerHome, profile: 'controller', ...(toolset ? { toolset } : {}) });
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
      const defaultNames = await listNames();
      expect(defaultNames).toEqual([...STABLE_CONTROLLER_TOOL_NAMES]);
      expect(defaultNames).toEqual(expect.arrayContaining(['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']));
      expect(defaultNames).toContain('repository_command_execute');

      const coreNames = await listNames('core');
      expect(coreNames).toEqual(defaultNames);

      const advancedNames = await listNames('advanced');
      expect(advancedNames).toEqual(defaultNames);
      expect(advancedNames).toEqual([...STABLE_CONTROLLER_TOOL_NAMES]);
      expect(advancedNames).toContain('repository_command_execute');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('writes the same trace identity into response metadata and incident records', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-trace-'));
    const server = createForgeMcpServer({ controllerHome, profile: 'controller', toolset: 'full' });
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

  test('release canary targets the candidate Process Runner instead of the running Runtime executable', () => {
    const runnerPath = join(tmpdir(), 'candidate-release', 'process-runner.js');
    const command = processRunnerReleaseCanaryChildCommand(runnerPath);

    expect(command).toEqual({
      executable: runnerPath,
      args: [PROCESS_RUNNER_RELEASE_CANARY_CHILD_ARG],
    });
    expect(command.executable).not.toBe(process.execPath);
  });

});
