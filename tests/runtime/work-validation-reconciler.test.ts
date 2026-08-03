import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';
import { reconcileWorkValidation } from '../../src/runtime/gateway/mcp/work-validation-reconciler';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(status: 'succeeded' | 'failed' | 'timed_out', options: { createProcess?: boolean } = {}) {
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-work-validation-'));
  roots.push(controllerHome);
  const now = '2026-08-03T00:00:00.000Z';
  const repoId = 'repo-validation';
  const checkoutId = 'checkout-validation';
  const workId = `work-validation-${status}-${options.createProcess === false ? 'missing' : 'recorded'}`;
  const processId = `proc-validation-${status}-${options.createProcess === false ? 'missing' : 'recorded'}`;
  const checkId = 'check-validation';
  createWorkContract({ controllerHome, repoId, now: () => now }, {
    workId,
    repoId,
    mode: 'direct_control',
    objective: 'Converge validation from durable Process receipts.',
    acceptanceCriteria: ['Validation outcome is persisted exactly once.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [checkId],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });
  const handle = writeWorkHandle(controllerHome, {
    schemaVersion: 1,
    workId,
    workContractId: workId,
    sessionId: 'session-validation',
    principalId: 'principal-validation',
    repositoryId: repoId,
    checkoutId,
    worktreePath: '/tmp/work-validation',
    branch: 'work/validation',
    managedWorktree: false,
    permissionSnapshotVersion: 1,
    state: 'validating',
    createdAt: now,
    updatedAt: now,
    finalization: {
      validation: 'pending',
      commit: 'pending',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    },
    validationRun: {
      fingerprint: 'validation-fingerprint',
      head: 'abc123',
      requestedChecks: [checkId],
      resumeState: 'editing',
      processes: { [checkId]: { processId, requestId: 'request-validation' } },
    },
  });
  const process: ManagedProcessRecord = {
    schemaVersion: 1,
    processId,
    repoId,
    checkoutId,
    workId,
    controllerHome,
    status,
    route: 'managed',
    commandId: 'command-validation',
    command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: handle.worktreePath },
    origin: {
      surface: 'check',
      checkId,
      requestId: 'request-validation',
      executionSessionId: handle.sessionId,
    },
    resourceClaims: [],
    interactiveWaitMs: 0,
    timeoutMs: 30_000,
    maxOutputBytes: 1_024,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
    terminalFenceToken: 41,
    terminalWritten: true,
    leaseReleaseState: 'released',
    leasesReleased: true,
    exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 1 : undefined,
    timedOut: status === 'timed_out',
  };
  if (options.createProcess !== false) createProcessRecord(process);
  return { controllerHome, repoId, workId, handle };
}

function contractFor(fx: ReturnType<typeof fixture>) {
  return getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
}

describe('Work validation receipt convergence', () => {
  test('returns a successful terminal check to the prior WorkHandle state and advances Work delivery', () => {
    const fx = fixture('succeeded');
    const result = reconcileWorkValidation(fx.controllerHome, fx.handle);
    expect(result).toMatchObject({ outcome: 'passed', changed: true, handle: { state: 'editing' } });
    expect(result.handle.finalization.validation).toBe('done');
    expect(result.handle.validationRun).toBeUndefined();
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'delivery', evidenceState: 'valid' });

    const repeated = reconcileWorkValidation(fx.controllerHome, result.handle);
    expect(repeated).toMatchObject({ outcome: 'not_validating', changed: false, handle: { state: 'editing' } });
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'delivery', evidenceState: 'valid' });
  });

  test('accepted check failure is terminal for WorkHandle and WorkContract verification', () => {
    const fx = fixture('failed');
    const result = reconcileWorkValidation(fx.controllerHome, fx.handle);
    expect(result).toMatchObject({ outcome: 'failed', changed: true, handle: { state: 'failed' } });
    expect(result.handle.finalization.validation).toBe('failed');
    expect(contractFor(fx)).toMatchObject({ status: 'failed', phase: 'verification', evidenceState: 'failed' });
  });

  test('timeout and missing Process records return to a retryable Work state', () => {
    const timedOut = fixture('timed_out');
    const timedOutResult = reconcileWorkValidation(timedOut.controllerHome, timedOut.handle);
    expect(timedOutResult).toMatchObject({ outcome: 'infrastructure_failure', handle: { state: 'editing' } });
    expect(timedOutResult.handle.finalization.validation).toBe('pending');
    expect(timedOutResult.handle.validationRun).toBeUndefined();
    expect(contractFor(timedOut)).toMatchObject({ status: 'running', phase: 'implementation', evidenceState: 'partial' });

    const missing = fixture('succeeded', { createProcess: false });
    const missingResult = reconcileWorkValidation(missing.controllerHome, missing.handle);
    expect(missingResult).toMatchObject({ outcome: 'infrastructure_failure', handle: { state: 'editing' } });
    expect(missingResult.handle.validationRun).toBeUndefined();
    expect(contractFor(missing)).toMatchObject({ status: 'running', phase: 'implementation', evidenceState: 'partial' });
  });
});
