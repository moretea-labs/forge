import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readForgeRuntimeStatus,
  schedulerHeartbeatSnapshotHealthy,
} from '../../src/runtime/control-plane/runtime-status-client';
import { executionJobRoot } from '../../src/runtime/execution/jobs/store';
import {
  operationReceiptMatchesJobOwnership,
  type OperationReceipt,
} from '../../src/runtime/execution/jobs/receipt-store';
import { TERMINAL_JOB_STATUSES, type ExecutionJob } from '../../src/runtime/execution/jobs/types';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/runtime/repositories/registry';
import {
  assertCommandPathOperandsStayInRepository,
  assertRepositoryCommandInputAllowed,
} from '../../src/runtime/repositories/command-scope';
import type { RepositoryRecord } from '../../src/core/repository/types';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { createHandoffItem } from '../../src/runtime/control-plane/facade/handoff-inbox-store';
import { recordUserRequest } from '../../packages/kernel/identity/api/index';
import {
  invalidateExecutionSession,
  readExecutionSession,
  startExecutionSession,
  updateExecutionSession,
} from '../../src/runtime/control-plane/execution/session-store';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { applyScheduleRetryableFailure } from '../../packages/kernel/scheduler/api/index';
import {
  createSchedule,
  getOccurrence,
  getSchedule,
  reclaimStaleCreatedOccurrences,
  saveOccurrence,
  saveSchedule,
  updateSchedule,
} from '../../src/runtime/workflow/schedules/store';
import {
  buildSchedulerHealthSnapshot,
  normalizeSchedulerConfig,
} from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { selectSchedulerProjectionRefreshTargets } from '../../src/runtime/control-plane/global-scheduler/projection-refresh';
import { evaluateSchedulerWorkerExitCandidate } from '../../src/runtime/control-plane/global-scheduler/worker-exit-decision';
import { reconcileSchedulerWorkerExit } from '../../src/runtime/control-plane/global-scheduler/worker-exit-reconciler';
import { shouldWakeForSchedulerEvent } from '../../src/runtime/control-plane/global-scheduler/wake-signal';

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

describe('repository command managed-worktree authority', () => {
  test('Forge source topology rejects branch and writable worktree creation while allowing main inspection', () => {
    const policy = { singleCanonicalBranchOnly: true };
    for (const command of [
      ['git', 'switch', '-c', 'feature/parallel'],
      ['git', 'checkout', '-b', 'feature/parallel'],
      ['git', 'branch', 'feature/parallel'],
      ['git', 'worktree', 'add', '-b', 'feature/parallel', '_ref/parallel', 'HEAD'],
      'git switch feature/parallel',
      'git worktree add --detach _ref/read-only HEAD',
      'git push origin feature/parallel',
      'git push origin feature/parallel:main',
      'git fetch origin feature/parallel',
      'git fetch origin',
      'git fetch origin main --prune',
      'git config alias.new !git-branch',
      'git remote update',
      'git remote set-url origin https://example.invalid/repo.git',
      'git symbolic-ref refs/heads/feature/parallel refs/heads/main',
      'git stash branch feature/parallel',
      'git fetch origin main:refs/heads/main',
      'git pull origin main',
      'git remote update',
      'git remote prune origin',
      'git remote set-url origin https://example.invalid/moretea-labs/forge.git',
      'git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*',
      'git config alias.bad !git-branch',
      'git symbolic-ref refs/heads/feature/parallel refs/heads/main',
      'git stash branch feature/parallel',
      ['bash', '-lc', 'git branch feature/parallel'],
      ['env', 'GIT_OPTIONAL_LOCKS=0', 'git', 'worktree', 'add', '_ref/parallel', 'main'],
      'GIT_DIR=/tmp/foreign/.git git switch -c feature/parallel',
      'sudo git checkout -b feature/parallel',
      ['timeout', '5s', 'git', 'branch', 'feature/parallel'],
      ['powershell', '-Command', 'git branch feature/parallel'],
      ['git', '-c', 'alias.bad=!git branch feature/parallel', 'bad'],
      'git update-ref refs/heads/feature/parallel 0123456789abcdef',
    ]) {
      expect(() => assertRepositoryCommandInputAllowed(command, policy)).toThrow('SOURCE_BRANCH_POLICY_MAIN_ONLY');
    }
    expect(() => assertRepositoryCommandInputAllowed('git switch main', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git branch --show-current', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git worktree list --porcelain', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git push origin main', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git push origin main:main', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git push origin refs/heads/main', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git push origin +refs/heads/main', policy)).toThrow(
      'SOURCE_BRANCH_POLICY_MAIN_ONLY',
    );
    expect(() =>
      assertRepositoryCommandInputAllowed(
        'git push origin --force-with-lease=refs/heads/main +refs/heads/main',
        policy,
      ),
    ).toThrow('SOURCE_BRANCH_POLICY_MAIN_ONLY');
    expect(() => assertRepositoryCommandInputAllowed('git fetch origin main', policy)).not.toThrow();
    expect(() =>
      assertRepositoryCommandInputAllowed('git fetch origin +refs/heads/main:refs/remotes/origin/main', policy),
    ).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git remote -v', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git config --get remote.origin.url', policy)).not.toThrow();
    expect(() =>
      assertRepositoryCommandInputAllowed(['bash', '-lc', 'git branch --show-current'], policy),
    ).not.toThrow();
  });

  test('managed repository commands cannot bypass branch policy through wrappers, aliases, or refspecs', () => {
    const policy = { managedBranchCreationOnly: true, defaultBranch: 'main' };
    for (const command of [
      'git branch feature/parallel',
      ['bash', '-lc', 'git switch -c feature/parallel'],
      ['env', 'GIT_OPTIONAL_LOCKS=0', 'git', 'worktree', 'add', '_ref/parallel', 'main'],
      'sudo git checkout -b feature/parallel',
      ['timeout', '5s', 'git', 'branch', 'feature/parallel'],
      'git -c alias.new=!git-branch feature/parallel new',
      'git push origin feature/parallel:main',
      'git push origin main:feature/parallel',
      'git fetch origin feature/parallel:refs/remotes/origin/main',
      'git fetch origin main:refs/heads/feature/parallel',
      'git fetch origin',
    ]) {
      expect(() => assertRepositoryCommandInputAllowed(command, policy)).toThrow(
        'GIT_BRANCH_CREATION_REQUIRES_MANAGED_API',
      );
    }
    expect(() => assertRepositoryCommandInputAllowed('git status --short', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git branch --show-current', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git fetch origin main', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git push origin main', policy)).not.toThrow();
    expect(() => assertRepositoryCommandInputAllowed('git push origin main:main', policy)).not.toThrow();
  });

  test('normal Git worktree creation has no Work prerequisite but keeps repository path policy', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-requirement-git-')));
    try {
      const inside = join(root, '_ref', 'parallel');
      const outside = join(tmpdir(), 'forge-ungranted-external-worktree');
      const command = ['git', 'worktree', 'add', '-b', 'feat/parallel', inside, 'HEAD'];
      expect(() => assertRepositoryCommandInputAllowed(command)).not.toThrow();
      expect(() =>
        assertCommandPathOperandsStayInRepository(assertRepositoryCommandInputAllowed(command), root, root),
      ).not.toThrow();
      expect(() =>
        assertRepositoryCommandInputAllowed('git worktree add -b feat/parallel _ref/parallel HEAD'),
      ).not.toThrow();
      expect(() =>
        assertCommandPathOperandsStayInRepository(
          assertRepositoryCommandInputAllowed(['git', 'worktree', 'add', outside]),
          root,
          root,
        ),
      ).toThrow('COMMAND_SCOPE_DENIED');
      expect(() => assertRepositoryCommandInputAllowed(['git', 'worktree', 'list', '--porcelain'])).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('control-plane hardening', () => {
  test('does not turn ambiguous Scheduler directory events into a self-trigger loop', () => {
    expect(shouldWakeForSchedulerEvent(null, 7, 7)).toBe(false);
    expect(shouldWakeForSchedulerEvent(null, 7, 8)).toBe(true);
    expect(shouldWakeForSchedulerEvent('state.json.tmp', 7, 7)).toBe(false);
    expect(shouldWakeForSchedulerEvent('wake-signal.json', 7, 7)).toBe(true);
  });

  test('normalizes Scheduler configuration outside the runtime lifecycle constructor', () => {
    expect(
      normalizeSchedulerConfig(
        {
          maxWorkers: 0,
          pollIntervalMs: 1,
          idleBackoffMaxMs: 100,
          heartbeatIntervalMs: 10,
          heartbeatTimeoutMs: 500,
          minFreeMemoryMb: 1,
          maxLoadPerCpu: 0,
        },
        {},
      ),
    ).toMatchObject({
      maxWorkers: 1,
      pollIntervalMs: 50,
      idleBackoffMaxMs: 250,
      heartbeatIntervalMs: 25,
      heartbeatTimeoutMs: 1_000,
      minFreeMemoryMb: 64,
      maxLoadPerCpu: 0.25,
    });

    expect(
      normalizeSchedulerConfig(
        {},
        {
          FORGE_MAX_WORKERS: '7',
          FORGE_IDLE_BACKOFF_MAX_MS: '3000',
          FORGE_SCHEDULER_HEARTBEAT_INTERVAL_MS: '2000',
          FORGE_SCHEDULER_HEARTBEAT_TIMEOUT_MS: '4000',
        },
      ),
    ).toMatchObject({
      maxWorkers: 7,
      idleBackoffMaxMs: 3_000,
      heartbeatIntervalMs: 2_000,
      heartbeatTimeoutMs: 12_000,
    });
  });

  test('serializes Scheduler health without retired Git polling state', () => {
    expect(
      buildSchedulerHealthSnapshot(
        {
          loopStartedAt: '2026-08-20T12:00:00.000Z',
          lastHeartbeatAt: '2026-08-20T12:59:58.000Z',
          heartbeatTimeoutMs: 60_000,
          lastTickAt: '2026-08-20T12:59:58.000Z',
          lastDispatchAt: '2026-08-20T12:59:00.000Z',
          lastReconcileAt: undefined,
        },
        Date.parse('2026-08-20T13:00:00.000Z'),
      ),
    ).toEqual({
      schemaVersion: 1,
      updatedAt: '2026-08-20T13:00:00.000Z',
      loopStartedAt: '2026-08-20T12:00:00.000Z',
      lastHeartbeatAt: '2026-08-20T12:59:58.000Z',
      heartbeatTimeoutMs: 60_000,
      lastTickAt: '2026-08-20T12:59:58.000Z',
      lastDispatchAt: '2026-08-20T12:59:00.000Z',
      lastReconcileAt: undefined,
    });
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

    expect(
      evaluateSchedulerWorkerExitCandidate({
        job: activeJob,
        attempt: 1,
        childPid: 20,
        lifecycle,
        diagnosticLifecycle,
      }),
    ).toEqual({ kind: 'ignore', reason: 'attempt_mismatch' });
    expect(
      evaluateSchedulerWorkerExitCandidate({
        job: activeJob,
        attempt: 2,
        childPid: 21,
        lifecycle,
        diagnosticLifecycle,
      }),
    ).toEqual({ kind: 'ignore', reason: 'pid_mismatch' });

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
      getJob: () => ({ ...activeJob, status: 'succeeded' }) as ExecutionJob,
      recoverReceipt: () => {
        throw new Error('must not recover terminal job');
      },
      persistTerminalLifecycle: () => {
        terminalCalls.push('terminal');
        return true;
      },
      updateJob: () => {
        throw new Error('must not update terminal job directly');
      },
      releaseLeases: () => {
        throw new Error('must not release terminal job leases');
      },
      transitionJob: () => {
        throw new Error('must not transition terminal job');
      },
      rebuildProjection: () => {
        throw new Error('must not rebuild outside terminal persistence');
      },
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
      releaseLeases: () => {
        throw new Error('must not release recovered job leases');
      },
      transitionJob: () => {
        throw new Error('must not transition recovered job');
      },
      rebuildProjection: () => {
        recoveredCalls.push('projection');
      },
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
      recoverReceipt: () => {
        failureCalls.push('recover');
        return undefined;
      },
      persistTerminalLifecycle: () => false,
      updateJob: () => {
        throw new Error('must not update abnormal exit directly');
      },
      releaseLeases: () => {
        failureCalls.push('release');
      },
      transitionJob: (_home, _repoId, _jobId, status) => {
        transitionedStatus = status;
        failureCalls.push('transition');
        return activeJob;
      },
      rebuildProjection: () => {
        failureCalls.push('projection');
      },
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
    expect(
      schedulerHeartbeatSnapshotHealthy(
        {
          ...base,
          lastTickAt: new Date(now - 20_000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
    expect(
      schedulerHeartbeatSnapshotHealthy(
        {
          ...base,
          lastHeartbeatAt: new Date(now - 20_000).toISOString(),
          heartbeatTimeoutMs: 30_000,
        },
        now,
      ),
    ).toBe(true);
    expect(
      schedulerHeartbeatSnapshotHealthy(
        {
          ...base,
          lastHeartbeatAt: new Date(now - 31_000).toISOString(),
          heartbeatTimeoutMs: 30_000,
        },
        now,
      ),
    ).toBe(false);
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
    expect(
      operationReceiptMatchesJobOwnership(receipt, {
        ...job,
        workerLifecycle: { ...lifecycle, runtimeInstanceId: undefined },
      } as ExecutionJob),
    ).toBe(false);

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


});
