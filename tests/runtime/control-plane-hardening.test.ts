import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { readForgeRuntimeStatus, schedulerHeartbeatSnapshotHealthy } from '../../src/runtime/control-plane/runtime-status-client';
import { createExecutionJob, executionJobRoot } from '../../src/runtime/execution/jobs/store';
import { operationReceiptMatchesJobOwnership, type OperationReceipt } from '../../src/runtime/execution/jobs/receipt-store';
import { TERMINAL_JOB_STATUSES, type ExecutionJob } from '../../src/runtime/execution/jobs/types';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';
import { workHasActiveExecution } from '../../src/runtime/execution/work-activity';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
import { appendWorkEvidence, createWorkContract, getWorkContract, recordWorkCompletionReceipt } from '../../src/runtime/control-plane/facade/work-contract-store';
import { stopGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { createHandoffItem, getHandoffItem, listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { claimControllerSession, controllerSessionBlocksRecovery, getControllerSession, releaseControllerSession, resumeControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { invalidateExecutionSession, startExecutionSession } from '../../src/runtime/control-plane/execution/session-store';
import {
  acknowledgeControllerRoundClaim,
  beginInitialControllerRoundDispatch,
  buildControllerRoundRelayPrompt,
  claimStalledControllerRoundRelays,
  finishControllerRoundRelayDispatch,
  parseControllerDispositionCompatibilityCapability,
  submitControllerRoundDisposition,
} from '../../src/runtime/control-plane/facade/controller-round-relay';
import { getExternalControllerLaunchReservation } from '../../src/runtime/control-plane/launcher/launch-reservation-store';
import { awaitExternalControllerWake, classifyChatgptWakeFailure, evaluateSchedule, externalControllerWakeTimeoutMs } from '../../src/runtime/workflow/schedules/engine';
import { applyScheduleRetryableFailure } from '../../src/runtime/workflow/schedules/settlement';
import { createSchedule, getSchedule, recordScheduleOccurrenceHandoff, saveOccurrence, saveSchedule } from '../../src/runtime/workflow/schedules/store';
import {
  buildSchedulerHealthSnapshot,
  normalizeSchedulerConfig,
  restoreSchedulerState,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';
import {
  consumeSchedulerDispatchCapacity,
  createSchedulerDispatchCapacity,
  schedulerAgentProvider,
  schedulerDispatchCapacityAllows,
} from '../../src/runtime/control-plane/global-scheduler/dispatch-capacity';
import { selectExecutionJobDispatchRepositories } from '../../src/runtime/control-plane/dispatch-priority';
import { selectSchedulerProjectionRefreshTargets } from '../../src/runtime/control-plane/global-scheduler/projection-refresh';
import { evaluateSchedulerWorkerExitCandidate } from '../../src/runtime/control-plane/global-scheduler/worker-exit-decision';
import { reconcileSchedulerWorkerExit } from '../../src/runtime/control-plane/global-scheduler/worker-exit-reconciler';
import { runSchedulerDurableAdmission } from '../../src/runtime/control-plane/global-scheduler/durable-admission';
import { RepoActorRegistry } from '../../src/runtime/control-plane/repo-actor/registry';

const roots: string[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function passingDiagnostics() {
  return {
    database: { outcome: 'pass' as const },
    scheduler: { outcome: 'pass' as const },
    releaseCoherence: { outcome: 'pass' as const },
    mcpEndToEnd: { outcome: 'pass' as const },
  };
}

describe('control-plane hardening', () => {
  test('normalizes Scheduler configuration outside the runtime lifecycle constructor', () => {
    expect(normalizeSchedulerConfig({
      maxWorkers: 0,
      pollIntervalMs: 1,
      idleBackoffMaxMs: 100,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 500,
      minFreeMemoryMb: 1,
      maxLoadPerCpu: 0,
    }, {})).toMatchObject({
      maxWorkers: 1,
      pollIntervalMs: 50,
      idleBackoffMaxMs: 250,
      heartbeatIntervalMs: 25,
      heartbeatTimeoutMs: 1_000,
      minFreeMemoryMb: 64,
      maxLoadPerCpu: 0.25,
    });

    expect(normalizeSchedulerConfig({}, {
      FORGE_MAX_WORKERS: '7',
      FORGE_IDLE_BACKOFF_MAX_MS: '3000',
      FORGE_SCHEDULER_HEARTBEAT_INTERVAL_MS: '2000',
      FORGE_SCHEDULER_HEARTBEAT_TIMEOUT_MS: '4000',
    })).toMatchObject({
      maxWorkers: 7,
      idleBackoffMaxMs: 3_000,
      heartbeatIntervalMs: 2_000,
      heartbeatTimeoutMs: 12_000,
    });
  });

  test('does not hide a per-repository worker ceiling below the scheduler worker budget', () => {
    const actors = new RepoActorRegistry('/tmp/forge-repo-actor-config-test', { maxConcurrentWorkers: 7 });
    expect(actors.get('repo-a').config.maxConcurrentWorkers).toBe(7);
  });

  test('isolates Scheduler state restoration and snapshot serialization from lifecycle mutation', () => {
    const sourceScanAt = Date.parse('2026-08-20T12:34:56.000Z');
    expect(restoreSchedulerState({
      schemaVersion: 1,
      updatedAt: '2026-08-20T13:00:00.000Z',
      lastSourceScanAt: '2026-08-20T12:34:56.000Z',
      lastSourceScanRepoCount: 3,
      sourceScansAvoided: 5,
      lastRepoDispatch: {
        'repo-a': 42,
        'repo-invalid': Number.NaN,
      },
    })).toEqual({
      lastSourceScanAt: sourceScanAt,
      lastSourceScanRepoCount: 3,
      sourceScansAvoided: 5,
      lastRepoDispatch: [['repo-a', 42]],
    });

    expect(buildSchedulerHealthSnapshot({
      loopStartedAt: '2026-08-20T12:00:00.000Z',
      lastHeartbeatAt: '2026-08-20T12:59:58.000Z',
      heartbeatTimeoutMs: 60_000,
      lastTickAt: '2026-08-20T12:59:58.000Z',
      lastDispatchAt: '2026-08-20T12:59:00.000Z',
      lastReconcileAt: undefined,
      lastSourceScanAt: sourceScanAt,
      lastSourceScanRepoCount: 3,
      sourceScansAvoided: 5,
      lastRepoDispatch: new Map([['repo-a', 42]]),
    }, Date.parse('2026-08-20T13:00:00.000Z'))).toEqual({
      schemaVersion: 1,
      updatedAt: '2026-08-20T13:00:00.000Z',
      loopStartedAt: '2026-08-20T12:00:00.000Z',
      lastHeartbeatAt: '2026-08-20T12:59:58.000Z',
      heartbeatTimeoutMs: 60_000,
      lastTickAt: '2026-08-20T12:59:58.000Z',
      lastDispatchAt: '2026-08-20T12:59:00.000Z',
      lastReconcileAt: undefined,
      lastSourceScanAt: '2026-08-20T12:34:56.000Z',
      lastSourceScanRepoCount: 3,
      sourceScansAvoided: 5,
      lastRepoDispatch: { 'repo-a': 42 },
    });
  });

  test('isolates Scheduler dispatch capacity accounting from the dispatch lock', () => {
    const executionJob = (input: {
      jobId: string;
      type: ExecutionJob['type'];
      status: ExecutionJob['status'];
      agent?: 'codex' | 'claude' | 'github-copilot';
    }) => ({
      jobId: input.jobId,
      repoId: 'repo-a',
      type: input.type,
      status: input.status,
      payload: { operation: 'test', arguments: input.agent ? { agent: input.agent } : {} },
    }) as ExecutionJob;
    const active = [
      executionJob({ jobId: 'check-running', type: 'check', status: 'running' }),
      executionJob({ jobId: 'codex-running', type: 'agent-run', status: 'running', agent: 'codex' }),
      executionJob({ jobId: 'claude-dispatched', type: 'dispatch-task', status: 'dispatched', agent: 'claude' }),
    ];
    const limits = {
      maxWorkers: 4,
      maxHeavyChecks: 2,
      maxAgentProcesses: 3,
      maxCodexProcesses: 2,
      maxClaudeProcesses: 1,
      maxGitHubProcesses: 1,
    };
    const capacity = createSchedulerDispatchCapacity(active, limits, false);
    expect(capacity.workers).toBe(1);
    expect(capacity.heavyChecks).toBe(1);
    expect(capacity.agents).toBe(1);
    expect(Object.fromEntries(capacity.providers)).toEqual({ codex: 1, claude: 0, 'github-copilot': 1 });
    expect(schedulerAgentProvider(executionJob({ jobId: 'default-agent', type: 'agent-run', status: 'queued' }))).toBe('codex');
    expect(schedulerDispatchCapacityAllows(capacity, executionJob({
      jobId: 'claude-waiting', type: 'agent-run', status: 'queued', agent: 'claude',
    }))).toBe(false);
    const codexWaiting = executionJob({ jobId: 'codex-waiting', type: 'agent-run', status: 'queued', agent: 'codex' });
    expect(schedulerDispatchCapacityAllows(capacity, codexWaiting)).toBe(true);
    consumeSchedulerDispatchCapacity(capacity, codexWaiting);
    expect(capacity.workers).toBe(0);
    expect(capacity.agents).toBe(0);
    expect(capacity.providers.get('codex')).toBe(0);

    const pressured = createSchedulerDispatchCapacity([], limits, true);
    expect(pressured.workers).toBe(1);
    expect(pressured.heavyChecks).toBe(1);
    expect(pressured.agents).toBe(0);
    expect([...pressured.providers.values()]).toEqual([0, 0, 0]);
  });

  test('keeps durable admission observation and schedule advancement outside the dispatch lock', async () => {
    const calls: string[] = [];
    const jobs = [
      { repoId: 'repo-a', jobId: 'queued', status: 'queued', type: 'repository-command', payload: { operation: 'test' } },
      { repoId: 'repo-a', jobId: 'running', status: 'running', type: 'repository-command', payload: { operation: 'test' } },
      { repoId: 'repo-b', jobId: 'observed', status: 'queued', type: 'repository-command', payload: { operation: 'test' }, timings: { schedulerObservedAt: '2026-08-21T00:00:00.000Z' } },
    ] as ExecutionJob[];
    const dependencies = {
      listActiveJobs: () => jobs,
      markSchedulerObserved: (_controllerHome: string, repoId: string, jobId: string) => {
        calls.push(`observe:${repoId}:${jobId}`);
        return jobs.find((job) => job.jobId === jobId)!;
      },
      tickSchedules: async (_controllerHome: string, repoIds: string[]) => {
        calls.push(`schedule:${repoIds.join(',')}`);
        return [];
      },
    };

    expect(await runSchedulerDurableAdmission({
      controllerHome: '/tmp/controller',
      repositoryIds: ['repo-a', 'repo-b'],
      nowMs: 60_000,
      lastScheduleTickAt: 0,
    }, dependencies)).toEqual({ scheduleTicked: true });
    expect(calls).toEqual([
      'observe:repo-a:queued',
      'schedule:repo-a,repo-b',
    ]);

    calls.length = 0;
    expect(await runSchedulerDurableAdmission({
      controllerHome: '/tmp/controller',
      repositoryIds: ['repo-a', 'repo-b'],
      nowMs: 70_000,
      lastScheduleTickAt: 60_000,
    }, dependencies)).toEqual({ scheduleTicked: false });
    expect(calls).toEqual(['observe:repo-a:queued']);
  });

  test('isolates per-repository Scheduler priority and fairness ordering from the dispatch lock', () => {
    const now = Date.parse('2026-08-21T00:00:00.000Z');
    const job = (input: {
      repoId: string;
      jobId: string;
      priority: ExecutionJob['priority'];
      queuedAt: string;
      status?: ExecutionJob['status'];
    }) => ({
      repoId: input.repoId,
      jobId: input.jobId,
      priority: input.priority,
      queuedAt: input.queuedAt,
      createdAt: input.queuedAt,
      status: input.status ?? 'queued',
      type: 'repository-command',
      payload: { operation: 'test' },
    }) as ExecutionJob;
    const active = [
      job({ repoId: 'repo-a', jobId: 'a-newer', priority: 'P1', queuedAt: '2026-08-20T23:59:00.000Z' }),
      job({ repoId: 'repo-a', jobId: 'a-older', priority: 'P1', queuedAt: '2026-08-20T23:58:00.000Z' }),
      job({ repoId: 'repo-b', jobId: 'b-top', priority: 'P0', queuedAt: '2026-08-20T23:59:30.000Z' }),
      job({ repoId: 'repo-c', jobId: 'c-top', priority: 'P1', queuedAt: '2026-08-20T23:57:00.000Z' }),
      job({ repoId: 'repo-terminal', jobId: 'done', priority: 'P0', queuedAt: '2026-08-20T20:00:00.000Z', status: 'succeeded' }),
    ];

    expect(selectExecutionJobDispatchRepositories(active, now, new Map([
      ['repo-a', 100],
      ['repo-c', 50],
    ]))).toEqual(['repo-b', 'repo-c', 'repo-a']);
  });

  test('isolates Scheduler projection refresh target selection from tick side effects', () => {
    const repository = (repoId: string): RepositoryRecord => ({
      schemaVersion: 1,
      repoId,
      displayName: repoId,
      localRoot: `/tmp/${repoId}`,
      canonicalRoot: `/tmp/${repoId}`,
      activeCheckoutId: 'checkout-main',
      checkouts: [],
      repositoryType: 'git',
      enabled: true,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      lastSeenAt: '2026-08-21T00:00:00.000Z',
      configurationPath: `/tmp/${repoId}/.ai/harness/repository.json`,
      stateStorageStrategy: 'controller-home',
    });
    const repoA = repository('repo-a');
    const repoB = repository('repo-b');
    const repoC = repository('repo-c');

    const targets = selectSchedulerProjectionRefreshTargets(
      [repoA, repoB, repoC],
      [repoB],
      ['repo-a', 'repo-missing', 'repo-b', 'repo-missing'],
    );

    expect(targets.repositories.map((entry) => entry.repoId)).toEqual(['repo-b', 'repo-a']);
    expect(targets.rebuildRepoIds).toEqual(['repo-missing']);
  });

  test('isolates Scheduler worker-exit candidate fencing and terminal classification from exit side effects', () => {
    const lifecycle = {
      executable: '/runtime/worker',
      args: [],
      cwd: '/repo',
      environment: {},
      ownerPid: 10,
      workerPid: 20,
      attempt: 2,
      maxAttempts: 3,
      spawnedAt: '2026-08-21T00:00:00.000Z',
      startupState: 'registered' as const,
    };
    const diagnosticLifecycle = {
      ...lifecycle,
      exitedAt: '2026-08-21T00:00:01.000Z',
      exitCode: 1,
      signal: null,
      stderr: 'boom',
      stderrTruncated: false,
      startupState: 'exited' as const,
    };
    const activeJob = {
      repoId: 'repo-a',
      jobId: 'job-a',
      attempt: 2,
      maxAttempts: 3,
      workerPid: 20,
      status: 'running',
      workerLifecycle: lifecycle,
      leaseRefs: [],
    } as unknown as ExecutionJob;

    expect(evaluateSchedulerWorkerExitCandidate({
      job: activeJob,
      attempt: 1,
      childPid: 20,
      lifecycle,
      diagnosticLifecycle,
    })).toEqual({ kind: 'ignore', reason: 'attempt_mismatch' });
    expect(evaluateSchedulerWorkerExitCandidate({
      job: activeJob,
      attempt: 2,
      childPid: 21,
      lifecycle,
      diagnosticLifecycle,
    })).toEqual({ kind: 'ignore', reason: 'pid_mismatch' });

    const active = evaluateSchedulerWorkerExitCandidate({
      job: activeJob,
      attempt: 2,
      childPid: 20,
      lifecycle,
      diagnosticLifecycle,
    });
    expect(active.kind).toBe('active');
    if (active.kind === 'active') {
      expect(active.lifecycle).toMatchObject({ startupState: 'exited', stderr: 'boom', workerPid: 20 });
    }

    const terminal = evaluateSchedulerWorkerExitCandidate({
      job: { ...activeJob, status: 'succeeded' } as ExecutionJob,
      attempt: 2,
      childPid: 20,
      lifecycle,
      diagnosticLifecycle,
    });
    expect(terminal.kind).toBe('terminal');
    if (terminal.kind === 'terminal') {
      expect(terminal.job.status).toBe('succeeded');
      expect(terminal.lifecycle).toMatchObject({ startupState: 'exited', stderr: 'boom' });
    }
  });

  test('preserves Scheduler worker-exit side-effect ordering outside GlobalScheduler', () => {
    const lifecycle = {
      executable: '/runtime/worker',
      args: [],
      cwd: '/repo',
      environment: {},
      ownerPid: 10,
      workerPid: 20,
      attempt: 2,
      maxAttempts: 3,
      spawnedAt: '2026-08-21T00:00:00.000Z',
      startupState: 'registered' as const,
    };
    const diagnosticLifecycle = {
      ...lifecycle,
      exitedAt: '2026-08-21T00:00:01.000Z',
      exitCode: 1,
      signal: null,
      stderr: 'boom',
      stderrTruncated: false,
      startupState: 'exited' as const,
    };
    const activeJob = {
      repoId: 'repo-a',
      jobId: 'job-a',
      attempt: 2,
      maxAttempts: 3,
      workerPid: 20,
      status: 'running',
      workerLifecycle: lifecycle,
      leaseRefs: ['lease-a'],
    } as unknown as ExecutionJob;
    const input = {
      controllerHome: '/controller',
      repoId: 'repo-a',
      jobId: 'job-a',
      attempt: 2,
      childPid: 20,
      lifecycle,
      diagnosticLifecycle,
      exitCode: 1,
      signal: null,
      stderr: 'boom',
      stderrTruncated: false,
    };

    const terminalCalls: string[] = [];
    reconcileSchedulerWorkerExit(input, {
      getJob: () => ({ ...activeJob, status: 'succeeded' } as ExecutionJob),
      recoverReceipt: () => { throw new Error('must not recover terminal job'); },
      persistTerminalLifecycle: () => { terminalCalls.push('terminal'); return true; },
      updateJob: () => { throw new Error('must not update terminal job directly'); },
      releaseLeases: () => { throw new Error('must not release terminal job leases'); },
      transitionJob: () => { throw new Error('must not transition terminal job'); },
      rebuildProjection: () => { throw new Error('must not rebuild outside terminal persistence'); },
    });
    expect(terminalCalls).toEqual(['terminal']);

    const recoveredCalls: string[] = [];
    reconcileSchedulerWorkerExit(input, {
      getJob: () => activeJob,
      recoverReceipt: () => {
        recoveredCalls.push('recover');
        return { ...activeJob, status: 'succeeded' } as ExecutionJob;
      },
      persistTerminalLifecycle: () => false,
      updateJob: (_home, _repoId, _jobId, updater) => {
        recoveredCalls.push('update');
        return updater({ ...activeJob, status: 'succeeded' } as ExecutionJob);
      },
      releaseLeases: () => { throw new Error('must not release recovered job leases'); },
      transitionJob: () => { throw new Error('must not transition recovered job'); },
      rebuildProjection: () => { recoveredCalls.push('projection'); },
    });
    expect(recoveredCalls).toEqual(['recover', 'update', 'projection']);

    const failureCalls: string[] = [];
    let reads = 0;
    let transitionedStatus: string | undefined;
    reconcileSchedulerWorkerExit(input, {
      getJob: () => {
        reads += 1;
        failureCalls.push(`read-${reads}`);
        return activeJob;
      },
      recoverReceipt: () => { failureCalls.push('recover'); return undefined; },
      persistTerminalLifecycle: () => false,
      updateJob: () => { throw new Error('must not update abnormal exit directly'); },
      releaseLeases: () => { failureCalls.push('release'); },
      transitionJob: (_home, _repoId, _jobId, status) => {
        transitionedStatus = status;
        failureCalls.push('transition');
        return activeJob;
      },
      rebuildProjection: () => { failureCalls.push('projection'); },
    });
    expect(failureCalls).toEqual(['read-1', 'recover', 'read-2', 'release', 'transition', 'projection']);
    expect(transitionedStatus).toBe('queued');
  });

  test('projects canonical Runtime ownership through the transitional daemon status shape', () => {
    const controllerHome = temp('forge-runtime-status-');
    const ownership = acquireRuntimeOwnership(controllerHome, 'runtime-test');
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    try {
      writeRuntimeStatusSnapshot(controllerHome, {
        schemaVersion: 1,
        runtimeInstanceId: 'runtime-test',
        pid: process.pid,
        releaseId: 'release-test',
        artifactIdentity: 'artifact-test',
        endpoint: 'http://127.0.0.1:0/mcp',
        startedAt,
        updatedAt: new Date().toISOString(),
        readiness: {
          ready: true,
          reasonCodes: [],
          diagnostics: passingDiagnostics(),
          observedAt: new Date().toISOString(),
        },
      });

      expect(readForgeRuntimeStatus(controllerHome)).toMatchObject({
        status: 'ready',
        pid: process.pid,
        startedAt,
        instanceId: 'runtime-test',
        gatewaySeparated: false,
        workerIsolation: true,
        degraded: false,
        restartRequired: false,
      });
    } finally {
      ownership.release();
    }
  });

  test('reports unavailable instead of creating a Controller process', () => {
    const controllerHome = temp('forge-runtime-unavailable-');
    expect(readForgeRuntimeStatus(controllerHome)).toMatchObject({
      status: 'unavailable',
      restartRequired: false,
    });
  });

  test('uses the Scheduler-published heartbeat timeout and a safe legacy fallback', () => {
    const now = Date.now();
    const base = {
      schemaVersion: 1 as const,
      updatedAt: new Date(now).toISOString(),
      loopStartedAt: new Date(now - 120_000).toISOString(),
      lastRepoDispatch: {},
    };
    expect(schedulerHeartbeatSnapshotHealthy({
      ...base,
      lastTickAt: new Date(now - 20_000).toISOString(),
    }, now)).toBe(true);
    expect(schedulerHeartbeatSnapshotHealthy({
      ...base,
      lastHeartbeatAt: new Date(now - 20_000).toISOString(),
      heartbeatTimeoutMs: 30_000,
    }, now)).toBe(true);
    expect(schedulerHeartbeatSnapshotHealthy({
      ...base,
      lastHeartbeatAt: new Date(now - 31_000).toISOString(),
      heartbeatTimeoutMs: 30_000,
    }, now)).toBe(false);
  });

  test('OperationReceipt recovery is bound to canonical Runtime and whole-release identity', () => {
    const lifecycle = {
      executable: '/runtime/worker',
      args: [],
      cwd: '/repo',
      environment: {},
      ownerPid: 10,
      workerPid: 20,
      runtimeInstanceId: 'runtime-a',
      releaseAuthorityRevision: 4,
      releaseId: 'release-a',
      artifactIdentity: 'artifact-a',
      workerProtocolVersion: 2,
      attempt: 1,
      maxAttempts: 3,
      spawnedAt: '2026-08-06T00:00:00.000Z',
      startupState: 'spawned' as const,
    };
    const job = {
      repoId: 'repo-a',
      jobId: 'job-a',
      attempt: 1,
      workerPid: 20,
      workerLifecycle: lifecycle,
      leaseRefs: [],
    } as unknown as ExecutionJob;
    const receipt: OperationReceipt = {
      schemaVersion: 1,
      repoId: 'repo-a',
      jobId: 'job-a',
      attempt: 1,
      state: 'completed',
      workerPid: 20,
      runtimeInstanceId: 'runtime-a',
      releaseAuthorityRevision: 4,
      releaseId: 'release-a',
      artifactIdentity: 'artifact-a',
      workerProtocolVersion: 2,
      startedAt: '2026-08-06T00:00:00.000Z',
      completedAt: '2026-08-06T00:00:01.000Z',
      outcome: 'succeeded',
    };

    expect(operationReceiptMatchesJobOwnership(receipt, job)).toBe(true);
    for (const mismatch of [
      { runtimeInstanceId: 'runtime-b' },
      { releaseAuthorityRevision: 5 },
      { releaseId: 'release-b' },
      { artifactIdentity: 'artifact-b' },
      { workerProtocolVersion: 3 },
    ]) {
      expect(operationReceiptMatchesJobOwnership({ ...receipt, ...mismatch }, job)).toBe(false);
    }
    expect(operationReceiptMatchesJobOwnership(receipt, {
      ...job,
      workerLifecycle: { ...lifecycle, runtimeInstanceId: undefined },
    } as ExecutionJob)).toBe(false);

    const legacyReceipt = { ...receipt };
    delete legacyReceipt.runtimeInstanceId;
    delete legacyReceipt.releaseAuthorityRevision;
    delete legacyReceipt.releaseId;
    delete legacyReceipt.artifactIdentity;
    delete legacyReceipt.workerProtocolVersion;
    expect(operationReceiptMatchesJobOwnership(legacyReceipt, job)).toBe(false);
    const legacyJob = {
      ...job,
      workerLifecycle: {
        ...lifecycle,
        runtimeInstanceId: undefined,
        releaseAuthorityRevision: undefined,
        releaseId: undefined,
        artifactIdentity: undefined,
        workerProtocolVersion: undefined,
      },
    } as ExecutionJob;
    expect(operationReceiptMatchesJobOwnership(legacyReceipt, legacyJob)).toBe(true);
  });

  test('refuses new ExecutionJobs for approval-wait and controller-scope recovery paths', () => {
    const controllerHome = temp('forge-job-retired-');
    expect(() => createExecutionJob(controllerHome, {
      repoId: 'repo-test',
      checkoutId: 'checkout-test',
      type: 'mcp-tool',
      requestId: `request-${Date.now()}`,
      semanticKey: `test:${Date.now()}`,
      origin: { surface: 'system', actor: 'test' },
      payload: { operation: 'controller_ready', target: 'runtime', profile: 'controller', arguments: {} },
      resourceClaims: [],
    })).toThrow(/EXECUTION_JOB_RETIRED/);
    expect(TERMINAL_JOB_STATUSES.has('waiting_for_approval')).toBe(false);
  });
});


describe('scheduled external Controller wake', () => {
  test('classifies only explicit readiness failures as retryable while keeping consent and unknown failures fail-closed', () => {
    expect(classifyChatgptWakeFailure('PLUGIN_BROWSER_ATTACH_UNAVAILABLE: Chrome attach failed')).toBe('retryable_readiness');
    expect(classifyChatgptWakeFailure('HTTP 502 from primary connector')).toBe('retryable_readiness');
    expect(classifyChatgptWakeFailure('CONTROLLER_WAKE_TOTAL_TIMEOUT: external Controller dispatch exceeded 120000ms.')).toBe('retryable_readiness');
    expect(classifyChatgptWakeFailure('CONTROLLER_RELAY_LAUNCH_BLOCKED: repeated_state:2>=2')).toBe('semantic_wait');
    expect(classifyChatgptWakeFailure('CHATGPT_AUTOMATION_LOGIN_REQUIRED')).toBe('user_action_required');
    expect(classifyChatgptWakeFailure('PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED')).toBe('user_action_required');
    expect(classifyChatgptWakeFailure('PLUGIN_CONFIGURATION_INVALID')).toBe('ordinary_failure');
  });

  test('bounds a whole external Controller wake instead of multiplying timeout across browser substeps', async () => {
    expect(externalControllerWakeTimeoutMs(undefined)).toBe(60_000);
    expect(externalControllerWakeTimeoutMs(1)).toBe(5_000);
    expect(externalControllerWakeTimeoutMs(600_000)).toBe(120_000);
    await expect(awaitExternalControllerWake(new Promise<never>(() => {}), 5)).rejects.toThrow('CONTROLLER_WAKE_TOTAL_TIMEOUT');
  });

  test('does not treat an old unexpired Controller lease as work, while a live Work Process remains authoritative', () => {
    const root = temp('forge-controller-liveness-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'liveness@example.test'], ['config', 'user.name', 'Liveness Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'liveness\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-liveness' });
    const workId = 'WORK-CONTROLLER-LIVENESS';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop',
      objective: 'Verify continuation liveness semantics.', acceptanceCriteria: ['Idle leases do not masquerade as execution.'],
      allowedPaths: ['**/*'], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const observedNow = Date.now();
    const staleAt = new Date(observedNow - 10 * 60_000).toISOString();
    const staleStore = { controllerHome, repoId: repository.repoId, now: () => staleAt };
    const staleOwner = claimControllerSession(staleStore, {
      workId, controllerId: 'stale-controller', controllerType: 'chatgpt', sessionId: 'stale-session-without-execution-context',
      principalId: 'stale-principal', controllerInstanceId: 'runtime-stale', leaseMs: 60 * 60_000,
    });
    expect(Date.parse(staleOwner.leaseExpiresAt)).toBeGreaterThan(observedNow);
    expect(controllerSessionBlocksRecovery({ controllerHome, repoId: repository.repoId }, workId, { nowMs: observedNow, graceMs: 5 * 60_000 })).toBe(false);

    const processNow = new Date(observedNow).toISOString();
    createProcessRecord({
      schemaVersion: 1, processId: 'proc-live-work-liveness', repoId: repository.repoId, checkoutId: repository.activeCheckoutId, workId,
      commandId: 'live-work-liveness', controllerHome, status: 'running', route: 'managed',
      command: { kind: 'argv', executable: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], cwd: repoRoot }, resourceClaims: [],
      interactiveWaitMs: 0, timeoutMs: 30_000, maxOutputBytes: 1_024, startedAt: processNow, updatedAt: processNow, terminalFenceToken: 1,
    } satisfies ManagedProcessRecord);
    expect(workHasActiveExecution(controllerHome, repository.repoId, workId)).toBe(true);
  });

  test('retryable continuation failure backs off once, then honours the declared failure circuit breaker', () => {
    const root = temp('forge-schedule-retryable-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'retry@example.test'], ['config', 'user.name', 'Retry Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'retry\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'schedule-retryable' });
    const schedule = createSchedule(controllerHome, {
      requestId: 'retryable-schedule', repoId: repository.repoId, name: 'retryable continuation', enabled: true,
      trigger: { type: 'interval', everyMinutes: 10 },
      policy: { maxActiveOccurrences: 1, maxFailures: 2, cooldownMinutes: 1, dailyBudgetMinutes: 600, shadowMode: false, backoffBaseMinutes: 1, backoffMaxMinutes: 5 },
      action: { operation: 'external_controller_wake', target: 'runtime', arguments: { work_id: 'WORK-RETRY', controller_type: 'chatgpt' } }, stopConditions: [],
    });
    saveOccurrence(controllerHome, { schemaVersion: 1, revision: 0, occurrenceId: 'OCC-RETRY-1', scheduleId: schedule.scheduleId, repoId: repository.repoId, windowKey: '1', status: 'running', decision: 'execute', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const retry = applyScheduleRetryableFailure(controllerHome, schedule.scheduleId, repository.repoId, 'OCC-RETRY-1', { outcome: 'failed', decision: 'execute', reason: 'HTTP 502' });
    expect(retry.schedule.enabled).toBe(true);
    expect(retry.schedule.consecutiveFailures).toBe(1);
    expect(retry.schedule.pausedReason).toBeUndefined();
    expect(retry.schedule.nextEligibleAt).toBeTruthy();
    expect(retry.schedule.policy.dailyBudgetMinutes).toBe(60);
    expect(retry.schedule.policy.cooldownMinutes).toBe(10);

    saveOccurrence(controllerHome, { schemaVersion: 1, revision: 0, occurrenceId: 'OCC-RETRY-2', scheduleId: schedule.scheduleId, repoId: repository.repoId, windowKey: '2', status: 'running', decision: 'execute', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const terminalRetry = applyScheduleRetryableFailure(controllerHome, schedule.scheduleId, repository.repoId, 'OCC-RETRY-2', { outcome: 'failed', decision: 'execute', reason: 'HTTP 502' });
    expect(terminalRetry.schedule.enabled).toBe(false);
    expect(terminalRetry.schedule.consecutiveFailures).toBe(2);
    expect(terminalRetry.schedule.pausedReason).toBe('Maximum consecutive failures reached.');

    saveSchedule(controllerHome, { ...getSchedule(controllerHome, repository.repoId, schedule.scheduleId), enabled: true, consecutiveFailures: 1, pausedReason: undefined });
    saveOccurrence(controllerHome, { schemaVersion: 1, revision: 0, occurrenceId: 'OCC-RETRY-3', scheduleId: schedule.scheduleId, repoId: repository.repoId, windowKey: '3', status: 'running', decision: 'execute', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const semanticWait = applyScheduleRetryableFailure(controllerHome, schedule.scheduleId, repository.repoId, 'OCC-RETRY-3', { outcome: 'skipped', decision: 'nothing_to_do', reason: 'repeated_state:2>=2', countFailure: false });
    expect(semanticWait.schedule.enabled).toBe(true);
    expect(semanticWait.schedule.consecutiveFailures).toBe(1);

    saveSchedule(controllerHome, { ...semanticWait.schedule, enabled: false, pausedReason: 'Explicit maintenance pause.' });
    saveOccurrence(controllerHome, { schemaVersion: 1, revision: 0, occurrenceId: 'OCC-RETRY-4', scheduleId: schedule.scheduleId, repoId: repository.repoId, windowKey: '4', status: 'running', decision: 'execute', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const explicitPause = applyScheduleRetryableFailure(controllerHome, schedule.scheduleId, repository.repoId, 'OCC-RETRY-4', { outcome: 'failed', decision: 'execute', reason: 'HTTP 502' });
    expect(explicitPause.schedule.enabled).toBe(false);
    expect(explicitPause.schedule.pausedReason).toBe('Explicit maintenance pause.');
  });

  test('acknowledges a dispatched ChatGPT round only after an exact Work claim and only recovers liveness when that claimed round is abandoned', () => {
    const root = temp('forge-controller-relay-claim-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'relay\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-claim' });
    const workId = 'WORK-RELAY-CLAIM';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Collect evidence and let ChatGPT decide semantic acceptance.',
      acceptanceCriteria: ['ChatGPT explicitly decides completion.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-test' },
    });
    expect(opened.status).toBe('dispatching');
    const scheduledPrompt = buildControllerRoundRelayPrompt(store, opened, { exactOriginWork: true });
    expect(scheduledPrompt).toContain(`Claim and advance only origin Work ${workId}.`);
    expect(scheduledPrompt).toContain('Do not select, start, delegate, or resume a sibling Work');
    expect(scheduledPrompt).not.toContain('select, start, or claim the appropriate Work');
    const dispatched = finishControllerRoundRelayDispatch(store, {
      workId,
      ok: true,
      browserSessionId: 'browser-test',
      conversationUrl: 'https://chatgpt.com/c/relay-test',
    });
    expect(dispatched?.status).toBe('dispatched');

    startExecutionSession(controllerHome, {
      sessionId: 'chatgpt-session',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
    });
    const session = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    const claimed = acknowledgeControllerRoundClaim(store, { workId, session });
    expect(claimed).toMatchObject({
      status: 'claimed',
      controllerId: 'chatgpt-controller',
      sessionId: 'chatgpt-session',
      claimGeneration: session.claimGeneration,
    });
    expect(claimed?.claimedAt).toBeTruthy();
    expect(claimed?.status).not.toBe('goal_complete');
    expect(acknowledgeControllerRoundClaim(store, { workId, session })?.claimedAt).toBe(claimed?.claimedAt);

    const afterGrace = Date.parse(claimed!.claimedAt!) + 2 * 60_000;
    expect(Date.parse(session.leaseExpiresAt)).toBeGreaterThan(afterGrace);
    expect(getControllerSession(store, workId)?.sessionId).toBe(session.sessionId);
    const recovered = claimStalledControllerRoundRelays(store, { nowMs: afterGrace, graceMs: 60_000 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'dispatching',
      lastError: 'CONTROLLER_RELAY_CLAIMED_ROUND_UNCLOSED',
    });
    expect(recovered[0]?.claimedAt).toBeUndefined();
    expect(recovered[0]?.status).not.toBe('goal_complete');

    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    startExecutionSession(controllerHome, {
      sessionId: 'chatgpt-session-next',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
    });
    const nextSession = resumeControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-next',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: nextSession })?.status).toBe('claimed');
    const waiting = submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: nextSession.controllerId,
        principalId: nextSession.principalId ?? nextSession.controllerId,
        controllerInstanceId: nextSession.controllerInstanceId ?? 'runtime-test',
        sessionId: nextSession.sessionId,
      },
      disposition: 'wait',
      relayScopeId: recovered[0]!.relayScopeId,
      reason: 'ChatGPT reviewed the evidence and explicitly chose to wait.',
    });
    expect(waiting.status).toBe('waiting');
    expect(waiting.disposition).toBe('wait');
    releaseControllerSession(store, workId, nextSession.controllerId);
    expect(claimStalledControllerRoundRelays(store, { nowMs: afterGrace + 2 * 60_000, graceMs: 60_000 })).toEqual([]);
  });

  test('keeps persistent scheduled Work running when a stale stop races after a successful bounded no-op claim', () => {
    const root = temp('forge-controller-relay-persistent-noop-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'persistent scheduled no-op\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-persistent-noop' });
    const workId = 'WORK-RELAY-PERSISTENT-NOOP';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Run one bounded scheduled health probe and remain persistent for the next occurrence.',
      acceptanceCriteria: ['A successful no-op occurrence returns the relay to waiting without terminalizing Work.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:persistent-noop', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-persistent-noop' },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    startExecutionSession(controllerHome, {
      sessionId: 'chatgpt-session-current',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
    });
    const session = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-current',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session })?.status).toBe('claimed');

    appendWorkEvidence(store, workId, {
      title: 'bounded scheduled health probe succeeded',
      summary: 'One bounded no-op occurrence completed successfully and produced no repository changes.',
      detailLevel: 'summary',
    });

    const staleStop = stopGoalWorkloop({
      workStore: store,
      handoffStore: store,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      principalId: 'forge-scheduler',
      controllerInstanceId: 'runtime-test',
    }, {
      workId,
      reason: 'stale occurrence cleanup must not cancel persistent scheduled Work',
    });
    expect(staleStop.status).toBe('blocked');
    expect(staleStop.summary).toContain('WORK_TERMINALIZATION_ACTIVE_CONTROLLER_FENCE');
    expect(getWorkContract(store, workId)?.status).toBe('running');

    const waiting = submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: session.controllerId,
        principalId: session.principalId ?? session.controllerId,
        controllerInstanceId: session.controllerInstanceId ?? 'runtime-test',
        sessionId: session.sessionId,
      },
      disposition: 'wait',
      relayScopeId: opened.relayScopeId,
      reason: 'Successful bounded no-op occurrence remains persistent for the next schedule.',
    });
    expect(waiting.status).toBe('waiting');
    expect(waiting.disposition).toBe('wait');
    expect(getWorkContract(store, workId)?.status).toBe('running');
  });

  test('starts a fresh repeated-state budget for a later external wake while same-chain suppression remains fail-closed', () => {
    const root = temp('forge-controller-relay-fresh-external-wake-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'stable periodic work state\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-fresh-external-wake' });
    const workId = 'WORK-RELAY-FRESH-EXTERNAL-WAKE';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Run bounded periodic maintenance whose mechanical Work state may remain unchanged between occurrences.',
      acceptanceCriteria: ['A later explicit occurrence gets a fresh relay budget without weakening same-chain fencing.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const first = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-1' },
    });
    expect(first).toMatchObject({ status: 'dispatching', roundCount: 1, repeatedStateCount: 0 });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const firstSession = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-1',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    acknowledgeControllerRoundClaim(store, { workId, session: firstSession });
    expect(submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: firstSession.controllerId,
        principalId: firstSession.principalId ?? firstSession.controllerId,
        controllerInstanceId: firstSession.controllerInstanceId ?? 'runtime-test',
        sessionId: firstSession.sessionId,
      },
      disposition: 'wait',
      relayScopeId: first.relayScopeId,
    }).status).toBe('waiting');
    releaseControllerSession(store, workId, firstSession.controllerId);

    const second = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-2' },
    });
    expect(second).toMatchObject({ status: 'dispatching', roundCount: 1, repeatedStateCount: 0 });
    expect(() => beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-duplicate' },
    })).toThrow(/CONTROLLER_RELAY_ROUND_ALREADY_OPEN/);

    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const secondSession = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-2',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    acknowledgeControllerRoundClaim(store, { workId, session: secondSession });
    const continuing = submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: secondSession.controllerId,
        principalId: secondSession.principalId ?? secondSession.controllerId,
        controllerInstanceId: secondSession.controllerInstanceId ?? 'runtime-test',
        sessionId: secondSession.sessionId,
      },
      disposition: 'continue_immediately',
      relayScopeId: second.relayScopeId,
    });
    expect(continuing).toMatchObject({ status: 'pending_release', roundCount: 2, repeatedStateCount: 1 });
    releaseControllerSession(store, workId, secondSession.controllerId);
    const recovered = claimStalledControllerRoundRelays(store, {
      nowMs: Date.parse(continuing.updatedAt) + 2 * 60_000,
      graceMs: 60_000,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: 'dispatching', roundCount: 2, repeatedStateCount: 1 });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    startExecutionSession(controllerHome, {
      sessionId: 'chatgpt-session-3',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
    });
    const thirdSession = resumeControllerSession(store, {
      workId,
      controllerId: secondSession.controllerId,
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-3',
      principalId: secondSession.principalId ?? secondSession.controllerId,
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    acknowledgeControllerRoundClaim(store, { workId, session: thirdSession });
    const blocked = submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: thirdSession.controllerId,
        principalId: thirdSession.principalId ?? thirdSession.controllerId,
        controllerInstanceId: thirdSession.controllerInstanceId ?? 'runtime-test',
        sessionId: thirdSession.sessionId,
      },
      disposition: 'continue_immediately',
      relayScopeId: second.relayScopeId,
    });
    expect(blocked).toMatchObject({ status: 'blocked', repeatedStateCount: 2, blockedReason: 'repeated_state:2>=2' });
  });

  test('starts a fresh launch-failure budget for a later external wake after the prior closed chain exhausted it', () => {
    const root = temp('forge-controller-relay-fresh-failure-budget-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'fresh failure budget\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-fresh-failure-budget' });
    const workId = 'WORK-RELAY-FRESH-FAILURE-BUDGET';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop',
      objective: 'Allow a later scheduled wake to recover after a transient launcher failure exhausted the prior relay chain.',
      acceptanceCriteria: ['A new explicit wake gets a fresh relay-local failure budget.'],
      allowedPaths: ['**/*'], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const first = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-failed' },
      maxFailures: 1,
    });
    expect(first).toMatchObject({ status: 'dispatching', consecutiveFailures: 0, maxFailures: 1 });
    const failed = finishControllerRoundRelayDispatch(store, { workId, ok: false, error: 'HTTP 502' });
    expect(failed).toMatchObject({ status: 'failed', consecutiveFailures: 1, maxFailures: 1 });

    const second = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-retry' },
      maxFailures: 1,
    });
    expect(second).toMatchObject({ status: 'dispatching', consecutiveFailures: 0, maxFailures: 1, roundCount: 1, repeatedStateCount: 0 });
    expect(second.blockedReason).toBeUndefined();
    expect(() => beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-duplicate' },
      maxFailures: 1,
    })).toThrow(/CONTROLLER_RELAY_ROUND_ALREADY_OPEN/);
  });

  test('recovers continue_immediately when the controller lease is released before pending_release can enter dispatching', () => {
    const root = temp('forge-controller-relay-release-gap-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'relay release gap\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-release-gap' });
    const workId = 'WORK-RELAY-RELEASE-GAP';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Continue across a crash between controller lease release and relay dispatch transition.',
      acceptanceCriteria: ['A durable continue_immediately disposition remains recoverable after lease release.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-test' },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    startExecutionSession(controllerHome, {
      sessionId: 'chatgpt-session',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
    });
    const session = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    acknowledgeControllerRoundClaim(store, { workId, session });
    const pending = submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: session.controllerId,
        principalId: session.principalId ?? session.controllerId,
        controllerInstanceId: session.controllerInstanceId ?? 'runtime-test',
        sessionId: session.sessionId,
      },
      disposition: 'continue_immediately',
      relayScopeId: opened.relayScopeId,
    });
    expect(pending.status).toBe('pending_release');
    const afterGrace = Date.parse(pending.updatedAt) + 2 * 60_000;
    expect(Date.parse(session.leaseExpiresAt)).toBeGreaterThan(afterGrace);
    invalidateExecutionSession(controllerHome, session.sessionId, 'mcp_transport_transport_close');
    expect(getControllerSession(store, workId)?.sessionId).toBe(session.sessionId);
    const recovered = claimStalledControllerRoundRelays(store, { nowMs: afterGrace, graceMs: 60_000 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'dispatching',
      roundCount: pending.roundCount,
      repeatedStateCount: pending.repeatedStateCount,
      lastError: 'CONTROLLER_RELAY_RELEASE_TRANSITION_INCOMPLETE',
    });
  });

  test('recovers a dispatching relay after the launcher transition stalls without consuming another round budget', () => {
    const root = temp('forge-controller-relay-dispatch-gap-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'relay dispatch gap\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-dispatch-gap' });
    const workId = 'WORK-RELAY-DISPATCH-GAP';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Recover a controller round when Runtime stalls after marking launcher dispatch in progress.',
      acceptanceCriteria: ['Recovery reuses the already-budgeted controller round.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const dispatching = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-test' },
    });
    expect(dispatching.status).toBe('dispatching');
    const afterGrace = Date.parse(dispatching.updatedAt) + 2 * 60_000;
    const recovered = claimStalledControllerRoundRelays(store, { nowMs: afterGrace, graceMs: 60_000 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'dispatching',
      roundCount: dispatching.roundCount,
      repeatedStateCount: dispatching.repeatedStateCount,
      lastError: 'CONTROLLER_RELAY_DISPATCH_TRANSITION_INCOMPLETE',
    });
  });

  test('does not recover a Requirement relay while any linked active Work still has real execution beyond the prompt snapshot limit', () => {
    const root = temp('forge-controller-relay-requirement-owner-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'relay requirement owner\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-requirement-owner' });
    const requirementId = 'REQ-RELAY-OWNER-BEYOND-SNAPSHOT';
    createRequirement({ controllerHome, now: () => '2026-08-25T00:00:00.000Z' }, {
      requirementId,
      title: 'Requirement relay owner fencing',
      outcomeStatement: 'A relay must not recover while any linked active Work still has real active execution.',
    });
    const workIds = Array.from({ length: 9 }, (_, index) => `WORK-RELAY-REQ-${index + 1}`);
    for (const [index, workId] of workIds.entries()) {
      createWorkContract({
        controllerHome,
        repoId: repository.repoId,
        now: () => `2026-08-25T00:00:${String(index).padStart(2, '0')}.000Z`,
      }, {
        workId,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        requirementId,
        mode: 'goal_workloop',
        objective: `Requirement relay Work ${index + 1}.`,
        acceptanceCriteria: ['Preserve Requirement-wide active execution fencing.'],
        allowedPaths: ['**/*'],
        forbiddenPaths: [],
        checks: [],
        constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
        requestedBy: 'chatgpt',
        status: 'running',
      });
    }
    const store = { controllerHome, repoId: repository.repoId };
    const originWorkId = workIds.at(-1)!;
    const opened = beginInitialControllerRoundDispatch(store, {
      workId: originWorkId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-test' },
    });
    const dispatched = finishControllerRoundRelayDispatch(store, { workId: originWorkId, ok: true });
    expect(dispatched?.status).toBe('dispatched');
    const processNow = new Date().toISOString();
    createProcessRecord({
      schemaVersion: 1,
      processId: 'proc-requirement-linked-live-work',
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      workId: workIds[0]!,
      commandId: 'requirement-linked-live-work',
      controllerHome,
      status: 'running',
      route: 'managed',
      command: { kind: 'argv', executable: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], cwd: repoRoot },
      resourceClaims: [],
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      startedAt: processNow,
      updatedAt: processNow,
      terminalFenceToken: 1,
    } satisfies ManagedProcessRecord);

    const afterGrace = Date.parse(dispatched!.dispatchedAt!) + 2 * 60_000;
    expect(opened.relayScopeId).toBe(`requirement:${requirementId}`);
    expect(claimStalledControllerRoundRelays(store, { nowMs: afterGrace, graceMs: 60_000 })).toEqual([]);
  });

  test('migrates a claimed ChatGPT relay only to the exact live same-principal controller session after runtime rotation', () => {
    const root = temp('forge-controller-relay-runtime-migration-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'relay migration\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-runtime-migration' });
    const workId = 'WORK-RELAY-RUNTIME-MIGRATION';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Continue one claimed ChatGPT round across a canonical Runtime restart.',
      acceptanceCriteria: ['Only the exact live same-principal controller lease can migrate the relay claim.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-a', sessionId: 'occurrence-test' },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const original = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-a',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-a',
      leaseMs: 5 * 60_000,
    });
    const claimed = acknowledgeControllerRoundClaim(store, { workId, session: original });
    expect(claimed).toMatchObject({ status: 'claimed', sessionId: 'chatgpt-session-a', controllerInstanceId: 'runtime-a' });
    expect(acknowledgeControllerRoundClaim(store, { workId, session: original })?.claimedAt).toBe(claimed?.claimedAt);

    const rotated = resumeControllerSession(store, {
      workId,
      controllerId: original.controllerId,
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-b',
      principalId: original.principalId ?? original.controllerId,
      controllerInstanceId: 'runtime-b',
      expectedClaimGeneration: original.claimGeneration,
      leaseMs: 5 * 60_000,
    });
    expect(() => acknowledgeControllerRoundClaim(store, {
      workId,
      session: { ...rotated, principalId: 'different-principal' },
    })).toThrow(/CONTROLLER_RELAY_CLAIM_IDENTITY_MISMATCH/);
    expect(() => acknowledgeControllerRoundClaim(store, {
      workId,
      session: { ...rotated, controllerId: 'different-controller' },
    })).toThrow(/CONTROLLER_RELAY_CLAIM_IDENTITY_MISMATCH/);

    const migrated = acknowledgeControllerRoundClaim(store, { workId, session: rotated });
    expect(migrated).toMatchObject({
      status: 'claimed',
      controllerId: original.controllerId,
      principalId: original.principalId,
      controllerInstanceId: 'runtime-b',
      sessionId: 'chatgpt-session-b',
      claimGeneration: rotated.claimGeneration,
    });
    expect(migrated?.claimedAt).not.toBe(claimed?.claimedAt);

    const waiting = submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: rotated.controllerId,
        principalId: rotated.principalId ?? rotated.controllerId,
        controllerInstanceId: rotated.controllerInstanceId ?? 'runtime-b',
        sessionId: rotated.sessionId,
      },
      disposition: 'wait',
      relayScopeId: opened.relayScopeId,
      reason: 'Same principal continued on the new canonical Runtime.',
    });
    expect(waiting).toMatchObject({ status: 'waiting', disposition: 'wait', controllerInstanceId: 'runtime-b', sessionId: 'chatgpt-session-b' });
  });

  test('parses only the fenced frozen-schema controller disposition compatibility capability', () => {
    expect(parseControllerDispositionCompatibilityCapability(
      'repair',
      'controller.disposition:continue_immediately:goal:work-compat',
    )).toEqual({ disposition: 'continue_immediately', relayScopeId: 'goal:work-compat' });
    expect(parseControllerDispositionCompatibilityCapability('continue', 'controller.disposition:wait:goal:work-compat')).toBeUndefined();
    expect(parseControllerDispositionCompatibilityCapability('repair', 'schedule.delete:SCH-1')).toBeUndefined();
    expect(() => parseControllerDispositionCompatibilityCapability('repair', 'controller.disposition:invalid:goal:work-compat')).toThrow(/CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID/);
    expect(() => parseControllerDispositionCompatibilityCapability('repair', 'controller.disposition:goal_complete:')).toThrow(/CONTROLLER_RELAY_DISPOSITION_COMPATIBILITY_INVALID/);
  });

  test('allows only the exact same-principal ChatGPT authority to record goal_complete after release/reclaim runtime rotation', () => {
    const root = temp('forge-controller-relay-terminal-disposition-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'relay@example.test'], ['config', 'user.name', 'Relay Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'relay terminal\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'controller-relay-terminal-disposition' });
    const workId = 'WORK-RELAY-TERMINAL-DISPOSITION';
    createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      mode: 'goal_workloop',
      objective: 'Finalize physical Work before the controller records semantic completion.',
      acceptanceCriteria: ['The same claimed controller round can still record goal_complete.'],
      allowedPaths: ['**/*'],
      forbiddenPaths: [],
      checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'completed_no_change',
      status: 'running',
    });
    const store = { controllerHome, repoId: repository.repoId };
    const opened = beginInitialControllerRoundDispatch(store, {
      workId,
      identity: { controllerId: 'schedule:test', principalId: 'forge-scheduler', controllerInstanceId: 'runtime-test', sessionId: 'occurrence-test' },
    });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const session = claimControllerSession(store, {
      workId,
      controllerId: 'chatgpt-controller',
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-original',
      principalId: 'chatgpt-principal',
      controllerInstanceId: 'runtime-test',
      leaseMs: 5 * 60_000,
    });
    expect(acknowledgeControllerRoundClaim(store, { workId, session })?.status).toBe('claimed');
    releaseControllerSession(store, workId, session.controllerId);
    const rotated = claimControllerSession(store, {
      workId,
      controllerId: session.controllerId,
      controllerType: 'chatgpt',
      sessionId: 'chatgpt-session-rotated',
      principalId: session.principalId ?? session.controllerId,
      controllerInstanceId: 'runtime-rotated',
      leaseMs: 5 * 60_000,
    });
    expect(rotated.claimGeneration).toBe(session.claimGeneration);
    expect(getControllerSession(store, workId)).toMatchObject({
      controllerId: session.controllerId,
      principalId: session.principalId,
      controllerInstanceId: 'runtime-rotated',
      sessionId: 'chatgpt-session-rotated',
    });

    const recordedAt = '2026-08-24T09:00:00.000Z';
    recordWorkCompletionReceipt(store, workId, {
      schemaVersion: 1,
      receiptId: 'receipt-relay-terminal-disposition',
      source: 'controller_work',
      issueId: 'relay-terminal',
      taskId: workId,
      workId,
      targetBranch: 'main',
      targetRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
      changedPaths: [],
      delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
      cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
      verifiedAt: recordedAt,
      recordedAt,
    }, 'completed_no_change', 'completed_no_change');
    expect(getControllerSession(store, workId)?.controllerInstanceId).toBe('runtime-rotated');
    releaseControllerSession(store, workId, rotated.controllerId);
    expect(getControllerSession(store, workId)).toBeUndefined();
    const postFinalizeIdentity = {
      controllerId: rotated.controllerId,
      principalId: rotated.principalId ?? rotated.controllerId,
      controllerInstanceId: 'runtime-after-finalize',
      sessionId: 'chatgpt-session-after-finalize',
    };

    expect(() => submitControllerRoundDisposition(store, {
      workId: 'WORK-RELAY-TERMINAL-DIFFERENT',
      identity: postFinalizeIdentity,
      disposition: 'goal_complete',
      relayScopeId: opened.relayScopeId,
    })).toThrow(/WORK_NOT_FOUND/);
    expect(() => submitControllerRoundDisposition(store, {
      workId,
      identity: postFinalizeIdentity,
      disposition: 'goal_complete',
      relayScopeId: 'goal:different-work',
    })).toThrow(/CONTROLLER_RELAY_SCOPE_MISMATCH/);
    expect(() => submitControllerRoundDisposition(store, {
      workId,
      identity: { ...postFinalizeIdentity, controllerId: 'different-controller' },
      disposition: 'goal_complete',
      relayScopeId: opened.relayScopeId,
    })).toThrow(/CONTROLLER_RELAY_CLAIM_CONTROLLER_MISMATCH/);
    expect(() => submitControllerRoundDisposition(store, {
      workId,
      identity: { ...postFinalizeIdentity, principalId: 'different-principal' },
      disposition: 'goal_complete',
      relayScopeId: opened.relayScopeId,
    })).toThrow(/CONTROLLER_RELAY_CLAIM_PRINCIPAL_MISMATCH/);
    expect(() => submitControllerRoundDisposition(store, {
      workId,
      identity: postFinalizeIdentity,
      disposition: 'wait',
      relayScopeId: opened.relayScopeId,
    })).toThrow(/CONTROLLER_RELAY_WORK_TERMINAL: completed/);

    const completed = submitControllerRoundDisposition(store, {
      workId,
      identity: postFinalizeIdentity,
      disposition: 'goal_complete',
      relayScopeId: opened.relayScopeId,
      reason: 'Physical finalization completed before semantic round disposition after Runtime rotation.',
    });
    expect(completed).toMatchObject({
      status: 'goal_complete',
      disposition: 'goal_complete',
      relayScopeId: opened.relayScopeId,
      controllerId: rotated.controllerId,
      principalId: rotated.principalId ?? rotated.controllerId,
      controllerInstanceId: 'runtime-after-finalize',
      sessionId: 'chatgpt-session-after-finalize',
      claimGeneration: rotated.claimGeneration,
    });
    expect(() => submitControllerRoundDisposition(store, {
      workId,
      identity: {
        controllerId: rotated.controllerId,
        principalId: rotated.principalId ?? rotated.controllerId,
        controllerInstanceId: rotated.controllerInstanceId ?? 'runtime-rotated',
        sessionId: rotated.sessionId,
      },
      disposition: 'goal_complete',
      relayScopeId: opened.relayScopeId,
    })).toThrow(/CONTROLLER_RELAY_ROUND_NOT_CLAIMED: goal_complete/);
  });

  test('separates explicit manual triggers from interval and cron timer windows while preserving retry identity', async () => {
    const root = temp('forge-schedule-manual-identity-');
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repoId = 'repo-schedule-manual-identity';
    const base = {
      repoId,
      enabled: true,
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: true },
      action: { operation: 'controller_context', resourceClaims: [] },
      stopConditions: [] as string[],
    };

    for (const [name, trigger] of [
      ['interval', { type: 'interval' as const, everyMinutes: 360 }],
      ['cron', { type: 'cron' as const, cronExpression: '* * * * *', timezone: 'UTC' }],
    ] as const) {
      const schedule = createSchedule(controllerHome, {
        ...base,
        requestId: `schedule-manual-identity-${name}`,
        name: `manual identity ${name}`,
        trigger,
      });
      const timer = await evaluateSchedule(controllerHome, schedule, false, { source: 'timer' });
      const timerRetry = await evaluateSchedule(controllerHome, schedule, false, { source: 'timer' });
      expect(timer?.occurrenceId).toBeTruthy();
      expect(timerRetry?.occurrenceId).toBe(timer?.occurrenceId);

      const manual = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: `manual-${name}-request` });
      const manualRetry = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: `manual-${name}-request` });
      expect(manual?.occurrenceId).toBeTruthy();
      expect(manual?.occurrenceId).not.toBe(timer?.occurrenceId);
      expect(manual?.windowKey).toBe(`manual:manual-${name}-request`);
      expect(manualRetry?.occurrenceId).toBe(manual?.occurrenceId);

      const nextManual = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: `manual-${name}-request-2` });
      expect(nextManual?.occurrenceId).not.toBe(manual?.occurrenceId);
    }
  });

  test('scopes continuation stop conditions to the target Work instead of historical repository noise', async () => {
    const root = temp('forge-schedule-stop-scope-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'scope@example.test'], ['config', 'user.name', 'Scope Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'scope\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'schedule-stop-scope' });
    const workId = 'WORK-SCHEDULE-STOP-SCOPE';
    const work = createWorkContract({ controllerHome, repoId: repository.repoId }, { workId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop', objective: 'Continue only this Work.', acceptanceCriteria: ['bounded continuation'], allowedPaths: ['**/*'], forbiddenPaths: [], checks: [], constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running' });
    const records = join(executionJobRoot(controllerHome, repository.repoId), 'records');
    mkdirSync(records, { recursive: true });
    const oldAt = new Date(Date.parse(work.createdAt) - 86_400_000).toISOString();
    writeFileSync(join(records, 'OLD-UNRELATED.json'), JSON.stringify({ schemaVersion: 1, revision: 1, jobId: 'OLD-UNRELATED', repoId: repository.repoId, type: 'repository-tool', status: 'failed', priority: 'normal', requestId: 'old-unrelated', semanticKey: 'old-unrelated', payload: { operation: 'legacy' }, origin: { surface: 'system' }, resourceClaims: [], dependencies: [], leaseRefs: [], createdAt: oldAt, updatedAt: oldAt, queuedAt: oldAt, attempt: 1, maxAttempts: 1, error: { code: 'NETWORK_TIMEOUT', message: 'historical external timeout', retryable: true }, evidenceIds: [] }));
    const schedule = createSchedule(controllerHome, { requestId: 'schedule-stop-scope-request', repoId: repository.repoId, name: 'scoped continuation', enabled: true, trigger: { type: 'manual' }, policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: true }, action: { operation: 'external_controller_wake', target: 'runtime', arguments: { work_id: workId, controller_type: 'codex' } }, stopConditions: ['human_review_required', 'external_blocker'] });
    const first = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'old-noise' });
    expect(first?.decision).toBe('would_execute');

    const browserSchedule = createSchedule(controllerHome, { requestId: 'browser-schedule-stop-scope-request', repoId: repository.repoId, name: 'scoped browser watcher', enabled: true, trigger: { type: 'manual' }, policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: true }, action: { operation: 'browser_probe', target: 'runtime', arguments: { work_id: workId, controller_type: 'chatgpt', probe_session_id: 'browser-scope-test', wake_on_change: true, keepalive_only: false } }, stopConditions: ['human_review_required', 'external_blocker'] });
    const browserFirst = await evaluateSchedule(controllerHome, browserSchedule, true, { source: 'manual', eventId: 'browser-old-noise' });
    expect(browserFirst?.decision).toBe('would_execute');

    createHandoffItem({ controllerHome, repoId: repository.repoId }, { id: 'HND-WORK-SCOPE', repoId: repository.repoId, workId, title: 'Current Work needs controller review', severity: 'needs_review', creationReason: 'ambiguous_outcome', reason: 'Current Work needs semantic review.', summary: 'Bounded controller review required.', currentState: { repoId: repository.repoId, workId, statusSummary: 'reviewable' }, attemptedActions: [], evidenceRefs: [], recommendedDecision: 'Review current Work.', recommendedPrompt: 'Review current Work.', suggestedNextActions: [] });
    const second = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'controller-review-handoff' });
    expect(second?.decision).toBe('would_execute');

    createHandoffItem({ controllerHome, repoId: repository.repoId }, { id: 'HND-WORK-HUMAN', repoId: repository.repoId, workId, title: 'Current Work requires authorization', severity: 'needs_review', creationReason: 'policy_approval_required', reason: 'Explicit user authorization is required.', summary: 'Human approval required before continuation.', currentState: { repoId: repository.repoId, workId, statusSummary: 'approval required' }, attemptedActions: [], evidenceRefs: [], recommendedDecision: 'Request approval.', recommendedPrompt: 'Request explicit approval.', suggestedNextActions: [] });
    const third = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'human-review-handoff' });
    expect(third).toMatchObject({ decision: 'stopped', status: 'skipped' });
    expect(third?.reason).toContain('HND-WORK-HUMAN');
  });

  test('deduplicates recurring infrastructure handoffs by failure class and resolves them after recovery', () => {
    const root = temp('forge-schedule-handoff-dedup-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'handoff@example.test'], ['config', 'user.name', 'Handoff Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'handoff\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'schedule-handoff-dedup' });
    const schedule = createSchedule(controllerHome, { requestId: 'schedule-handoff-dedup-request', repoId: repository.repoId, name: 'dedup schedule failures', enabled: true, trigger: { type: 'manual' }, policy: { maxActiveOccurrences: 1, maxFailures: 10, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: false }, action: { operation: 'runtime_maintenance_apply', target: 'runtime', arguments: {} }, stopConditions: [] });
    const otherSchedule = createSchedule(controllerHome, { requestId: 'schedule-handoff-other-request', repoId: repository.repoId, name: 'other schedule failures', enabled: true, trigger: { type: 'manual' }, policy: { maxActiveOccurrences: 1, maxFailures: 10, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: false }, action: { operation: 'runtime_maintenance_apply', target: 'runtime', arguments: { scope: 'other' } }, stopConditions: [] });
    const at = new Date().toISOString();
    const occurrence = (occurrenceId: string, scheduleId = schedule.scheduleId, status: 'failed' | 'succeeded' = 'failed') => saveOccurrence(controllerHome, {
      schemaVersion: 1, revision: 0, occurrenceId, scheduleId, repoId: repository.repoId, windowKey: occurrenceId,
      status, decision: 'execute', createdAt: at, updatedAt: at,
      reason: status === 'succeeded' ? 'Recovered.' : 'Failed.',
    });
    const handoffInput = (reason: string) => ({
      title: 'Scheduled operation failed', summary: 'Repeated infrastructure failure.', reason,
      creationReason: 'repeated_infrastructure_failure' as const,
      blockingDecision: 'Repair the infrastructure blocker.', recommendedDecision: 'Repair and retrigger.',
      recommendedPrompt: 'Repair the schedule infrastructure blocker.', statusSummary: 'Schedule blocked.',
      blockedBy: ['infrastructure'], attemptedActions: ['schedule-test'],
    });

    const legacy = createHandoffItem({ controllerHome, repoId: repository.repoId }, {
      id: 'schedule-OCC-legacy-failure', repoId: repository.repoId, title: 'Legacy schedule failure', severity: 'blocked',
      creationReason: 'repeated_infrastructure_failure', reason: 'CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE: legacy',
      summary: 'Legacy occurrence-specific handoff.', currentState: { repoId: repository.repoId, taskId: schedule.scheduleId, statusSummary: 'blocked' },
      attemptedActions: [`schedule:${schedule.scheduleId}`, 'occurrence:legacy'], evidenceRefs: [], blockingDecision: 'Repair browser readiness.',
      recommendedDecision: 'Repair.', recommendedPrompt: 'Repair.', suggestedNextActions: [],
    });
    const first = recordScheduleOccurrenceHandoff(controllerHome, schedule, occurrence('OCC-dedup-1'), handoffInput('CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE: first'));
    const second = recordScheduleOccurrenceHandoff(controllerHome, schedule, occurrence('OCC-dedup-2'), handoffInput('CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE: second'));
    expect(first.handoffId).toBe(legacy.id);
    expect(second.handoffId).toBe(legacy.id);

    const distinct = recordScheduleOccurrenceHandoff(controllerHome, schedule, occurrence('OCC-dedup-3'), handoffInput('PLUGIN_BROWSER_NATIVE_OPERATION_FAILED: timeout'));
    const distinctAgain = recordScheduleOccurrenceHandoff(controllerHome, schedule, occurrence('OCC-dedup-4'), handoffInput('PLUGIN_BROWSER_NATIVE_OPERATION_FAILED: another timeout'));
    expect(distinct.handoffId).toBeTruthy();
    expect(distinctAgain.handoffId).toBe(distinct.handoffId);
    expect(distinct.handoffId).not.toBe(legacy.id);

    const other = recordScheduleOccurrenceHandoff(controllerHome, otherSchedule, occurrence('OCC-other-1', otherSchedule.scheduleId), handoffInput('CHATGPT_AUTOMATION_INTELLIGENCE_CONTROL_UNAVAILABLE: other schedule'));
    const beforeRecovery = listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'active', limit: 100 });
    expect(beforeRecovery.filter((item) => item.currentState?.taskId === schedule.scheduleId && item.creationReason === 'repeated_infrastructure_failure')).toHaveLength(2);
    expect(beforeRecovery.some((item) => item.id === other.handoffId)).toBe(true);

    occurrence('OCC-dedup-recovered', schedule.scheduleId, 'succeeded');
    const afterRecovery = listHandoffItems({ controllerHome, repoId: repository.repoId, status: 'active', limit: 100 });
    expect(afterRecovery.filter((item) => item.currentState?.taskId === schedule.scheduleId && item.creationReason === 'repeated_infrastructure_failure')).toHaveLength(0);
    expect(afterRecovery.some((item) => item.id === other.handoffId)).toBe(true);
    expect(getHandoffItem({ controllerHome, repoId: repository.repoId }, legacy.id)?.status).toBe('resolved');
    expect(getHandoffItem({ controllerHome, repoId: repository.repoId }, distinct.handoffId!)?.status).toBe('resolved');
  });

  test('fails a scheduled external Controller wake that exits before exact Work claim and releases its reservation', async () => {
    const root = temp('forge-schedule-wake-'), controllerHome = join(root, 'controller'), repoRoot = join(root, 'repo');
    ensureControllerHome(controllerHome); mkdirSync(repoRoot, { recursive: true });
    const runtimeOwner = acquireRuntimeOwnership(controllerHome, 'runtime-schedule-wake');
    const runtimeService = forgeRuntimeServicePaths(controllerHome);
    mkdirSync(runtimeService.serviceRoot, { recursive: true });
    const runtimeTokenPath = join(controllerHome, 'mcp', 'runtime-token');
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
    writeFileSync(runtimeTokenPath, 'schedule-wake-token\n', { mode: 0o600 });
    writeFileSync(runtimeService.configPath, JSON.stringify({ schemaVersion: 1, controllerHome, repositoryRoot: repoRoot, host: '127.0.0.1', port: 9876, authTokenFile: runtimeTokenPath }));
    const runtimeObservedAt = new Date().toISOString();
    writeRuntimeStatusSnapshot(controllerHome, {
      schemaVersion: 1, runtimeInstanceId: runtimeOwner.record.runtimeInstanceId, pid: runtimeOwner.record.pid,
      releaseId: 'release-schedule-wake', artifactIdentity: 'artifact-schedule-wake', endpoint: 'http://127.0.0.1:9876/mcp',
      readiness: { ready: true, reasonCodes: [], diagnostics: passingDiagnostics(), observedAt: runtimeObservedAt },
      startedAt: runtimeObservedAt, updatedAt: runtimeObservedAt,
    });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'wake@example.test'], ['config', 'user.name', 'Wake Test']] as string[][]) execFileSync('git', args, { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'README.md'), 'wake\n'); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'schedule-wake' }), workId = 'WORK-SCHEDULE-WAKE';
    const fakeController = join(repoRoot, 'fake-controller.sh');
    writeFileSync(fakeController, '#!/bin/sh\nsleep 2\n'); chmodSync(fakeController, 0o755);
    createWorkContract({ controllerHome, repoId: repository.repoId }, { workId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop', objective: 'Continue a bounded goal from a scheduled external Controller wake.', acceptanceCriteria: ['external controller was launched'], allowedPaths: ['**/*'], forbiddenPaths: [], checks: [], constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running' });
    const schedule = createSchedule(controllerHome, { requestId: 'schedule-wake-request', repoId: repository.repoId, name: 'continue bounded work', enabled: true, trigger: { type: 'manual' }, policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: false }, action: { operation: 'external_controller_wake', target: 'runtime', arguments: { work_id: workId, controller_type: 'codex', executable: fakeController } }, stopConditions: [] });
    const failedWake = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual' });
    expect(failedWake).toMatchObject({ status: 'failed', decision: 'execute' });
    expect(failedWake?.reason).toContain('external Controller exited before exact Work claim became live');
    expect(getControllerSession({ controllerHome, repoId: repository.repoId }, workId)).toBeUndefined();
    expect(getExternalControllerLaunchReservation({ controllerHome, repoId: repository.repoId }, workId)).toBeUndefined();
    expect(failedWake?.handoffId).toBeTruthy();
    runtimeOwner.release();
  });
});
