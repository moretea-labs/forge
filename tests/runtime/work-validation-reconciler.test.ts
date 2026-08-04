import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';
import { reconcileWorkValidation } from '../../src/runtime/gateway/mcp/work-validation-reconciler';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(status: 'succeeded' | 'failed' | 'timed_out'): {
  controllerHome: string;
  handle: WorkHandleState;
  process: ManagedProcessRecord;
} {
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-work-validation-'));
  roots.push(controllerHome);
  const now = new Date().toISOString();
  const processId = `proc-${status}`;
  const handle = writeWorkHandle(controllerHome, {
    schemaVersion: 1,
    workId: 'work-validation',
    sessionId: 'session-validation',
    principalId: 'principal-validation',
    repositoryId: 'repo-validation',
    checkoutId: 'checkout-validation',
    worktreePath: '/tmp/work-validation',
    branch: 'work/validation',
    managedWorktree: false,
    permissionSnapshotVersion: 1,
    state: 'validating',
    createdAt: now,
    updatedAt: now,
    finalization: {
      validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending',
    },
    validationRun: {
      fingerprint: 'validation-fingerprint',
      head: 'abc123',
      requestedChecks: ['check-validation'],
      resumeState: 'editing',
      processes: { 'check-validation': { processId, requestId: 'request-validation' } },
    },
  });
  const process: ManagedProcessRecord = {
    schemaVersion: 1,
    processId,
    repoId: handle.repositoryId,
    checkoutId: handle.checkoutId,
    workId: handle.workId,
    controllerHome,
    status,
    route: 'managed',
    commandId: 'command-validation',
    command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: handle.worktreePath },
    origin: {
      surface: 'check',
      checkId: 'check-validation',
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
    terminalFenceToken: 1,
    terminalWritten: true,
    exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 1 : undefined,
    timedOut: status === 'timed_out',
  };
  return { controllerHome, handle, process };
}

describe('Work validation receipt convergence', () => {
  test('returns a successful terminal check to the prior Work phase', () => {
    const fx = fixture('succeeded');
    createProcessRecord(fx.process);
    const result = reconcileWorkValidation(fx.controllerHome, fx.handle);
    expect(result.outcome).toBe('passed');
    expect(result.handle.state).toBe('editing');
    expect(result.handle.finalization.validation).toBe('done');
    expect(result.handle.validationRun).toBeUndefined();
  });

  test('acceptance failure is terminal for the Work', () => {
    const fx = fixture('failed');
    createProcessRecord(fx.process);
    const result = reconcileWorkValidation(fx.controllerHome, fx.handle);
    expect(result.outcome).toBe('failed');
    expect(result.handle.state).toBe('failed');
    expect(result.handle.finalization.validation).toBe('failed');
  });

  test('timeout and missing records return to a retryable phase', () => {
    const timedOut = fixture('timed_out');
    createProcessRecord(timedOut.process);
    const timedOutResult = reconcileWorkValidation(timedOut.controllerHome, timedOut.handle);
    expect(timedOutResult.outcome).toBe('infrastructure_failure');
    expect(timedOutResult.handle.state).toBe('editing');
    expect(timedOutResult.handle.finalization.validation).toBe('pending');
    expect(timedOutResult.handle.validationRun).toBeUndefined();

    const missing = fixture('succeeded');
    const missingResult = reconcileWorkValidation(missing.controllerHome, missing.handle);
    expect(missingResult.outcome).toBe('infrastructure_failure');
    expect(missingResult.handle.state).toBe('editing');
    expect(missingResult.handle.validationRun).toBeUndefined();
  });
});
