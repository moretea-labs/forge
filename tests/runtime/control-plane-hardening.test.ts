import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { readForgeRuntimeStatus, schedulerHeartbeatSnapshotHealthy } from '../../src/runtime/control-plane/runtime-status-client';
import { createExecutionJob, executionJobRoot } from '../../src/runtime/execution/jobs/store';
import { operationReceiptMatchesJobOwnership, type OperationReceipt } from '../../src/runtime/execution/jobs/receipt-store';
import { TERMINAL_JOB_STATUSES, type ExecutionJob } from '../../src/runtime/execution/jobs/types';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { createHandoffItem, getHandoffItem, listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { getControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { getExternalControllerLaunchReservation } from '../../src/runtime/control-plane/launcher/launch-reservation-store';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { createSchedule, recordScheduleOccurrenceHandoff, saveOccurrence } from '../../src/runtime/workflow/schedules/store';
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

    createHandoffItem({ controllerHome, repoId: repository.repoId }, { id: 'HND-WORK-SCOPE', repoId: repository.repoId, workId, title: 'Current Work needs review', severity: 'needs_review', creationReason: 'ambiguous_outcome', reason: 'Current Work is blocked.', summary: 'Bounded review required.', currentState: { repoId: repository.repoId, workId, statusSummary: 'blocked' }, attemptedActions: [], evidenceRefs: [], recommendedDecision: 'Review current Work.', recommendedPrompt: 'Review current Work.', suggestedNextActions: [] });
    const second = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'current-handoff' });
    expect(second).toMatchObject({ decision: 'stopped', status: 'skipped' });
    expect(second?.reason).toContain('HND-WORK-SCOPE');
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

  test('launches one bounded Work and suppresses duplicate active ownership', async () => {
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
    createWorkContract({ controllerHome, repoId: repository.repoId }, { workId, repoId: repository.repoId, checkoutId: repository.activeCheckoutId, mode: 'goal_workloop', objective: 'Continue a bounded goal from a scheduled external Controller wake.', acceptanceCriteria: ['external controller was launched'], allowedPaths: ['**/*'], forbiddenPaths: [], checks: [], constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running' });
    const schedule = createSchedule(controllerHome, { requestId: 'schedule-wake-request', repoId: repository.repoId, name: 'continue bounded work', enabled: true, trigger: { type: 'manual' }, policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: false }, action: { operation: 'external_controller_wake', target: 'runtime', arguments: { work_id: workId, controller_type: 'codex', executable: '/usr/bin/true' } }, stopConditions: [] });
    expect(await evaluateSchedule(controllerHome, schedule, true, { source: 'manual' })).toMatchObject({ status: 'succeeded', decision: 'execute' });
    expect(getControllerSession({ controllerHome, repoId: repository.repoId }, workId)).toBeUndefined();
    expect(getExternalControllerLaunchReservation({ controllerHome, repoId: repository.repoId }, workId)?.controllerType).toBe('codex');
    expect(await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'duplicate-wake' })).toMatchObject({ decision: 'nothing_to_do', status: 'skipped' });
    const duplicate = await evaluateSchedule(controllerHome, schedule, true, { source: 'manual', eventId: 'second' }); expect(duplicate).toMatchObject({ decision: 'nothing_to_do' }); expect(duplicate?.reason).toContain('pending external Controller launch');
    runtimeOwner.release();
  });
});
