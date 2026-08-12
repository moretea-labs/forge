import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { readForgeRuntimeStatus, schedulerHeartbeatSnapshotHealthy } from '../../src/runtime/control-plane/runtime-status-client';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';
import { operationReceiptMatchesJobOwnership, type OperationReceipt } from '../../src/runtime/execution/jobs/receipt-store';
import { TERMINAL_JOB_STATUSES, type ExecutionJob } from '../../src/runtime/execution/jobs/types';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { getControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { getExternalControllerLaunchReservation } from '../../src/runtime/control-plane/launcher/launch-reservation-store';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { createSchedule } from '../../src/runtime/workflow/schedules/store';

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
