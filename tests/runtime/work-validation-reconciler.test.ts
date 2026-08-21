import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkContract, getWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';
import { hasCurrentWorkValidationAuthority, markWorkValidationPending, reconcilePendingWorkValidations, reconcileWorkValidation } from '../../src/runtime/gateway/mcp/work-validation-reconciler';
import {
  effectiveVerificationEvidence,
  verificationInputFingerprint,
  workspaceValidationFingerprint,
  workValidationInputFingerprint,
} from '../../src/runtime/control-plane/execution/verification-evidence';
import type { VerificationRecord } from '../../src/runtime/control-plane/facade/types'; import { execFileSync } from 'child_process'; import { currentControllerCheckRevision } from '../../src/cli/controller/check-runner'; import { materializeWorkVerificationSnapshot } from '../../src/runtime/control-plane/execution/work-verification-snapshot';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(status: 'succeeded' | 'failed' | 'timed_out', options: { createProcess?: boolean } = {}) {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-'));
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
      workspaceFingerprint: 'workspace-fingerprint',
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
  test('returns a successful terminal check across MCP transport rotation and advances Work delivery', () => {
    const fx = fixture('succeeded');
    const rotatedHandle = { ...fx.handle, sessionId: 'session-validation-next' };
    const result = reconcileWorkValidation(fx.controllerHome, rotatedHandle);
    expect(result).toMatchObject({ outcome: 'passed', changed: true, handle: { state: 'editing' } });
    expect(result.handle.finalization.validation).toBe('done');
    expect(result.handle.validationRun).toBeUndefined();
    expect(result.handle.validatedInputFingerprint).toBe('validation-fingerprint');
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'delivery', evidenceState: 'valid' });

    const repeated = reconcileWorkValidation(fx.controllerHome, result.handle);
    expect(repeated).toMatchObject({ outcome: 'not_validating', changed: false, handle: { state: 'editing' } });
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'delivery', evidenceState: 'valid' });
  });
  test('verification snapshot metadata does not change Check content identity', () => { const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-controller-')); const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-repo-')); roots.push(controllerHome, repoRoot); writeFileSync(join(repoRoot, 'source.ts'), 'export const value = 1;\n'); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot }); execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot }); execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot }); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot }); const sourceIdentity = currentControllerCheckRevision(repoRoot); const snapshot = materializeWorkVerificationSnapshot({ controllerHome, repoId: 'repo-validation-snapshot', sourceRoot: repoRoot, scope: { workId: 'work-validation-snapshot', allowedPaths: ['**'], forbiddenPaths: [] } }); expect(existsSync(join(snapshot.root, '.ai/harness/controller/work-verification-snapshot.json'))).toBe(true); expect(currentControllerCheckRevision(snapshot.root)).toBe(sourceIdentity); });
  test('verification snapshot removes empty parent directories for tracked deletions', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-delete-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-delete-repo-'));
    roots.push(controllerHome, repoRoot);
    const retiredRoot = join(repoRoot, 'retired', 'authority');
    mkdirSync(retiredRoot, { recursive: true });
    writeFileSync(join(retiredRoot, 'store.ts'), 'export const retired = true;\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    rmSync(join(repoRoot, 'retired'), { recursive: true, force: true });

    const snapshot = materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-delete-snapshot',
      sourceRoot: repoRoot,
      scope: { workId: 'work-validation-delete-snapshot', allowedPaths: ['**'], forbiddenPaths: [] },
    });

    expect(existsSync(join(snapshot.root, 'retired'))).toBe(false);
  });
  test('background reconciliation settles completed long-check receipts without a polling tool call', () => {
    const fx = fixture('succeeded');
    const summary = reconcilePendingWorkValidations(fx.controllerHome, fx.repoId);
    expect(summary).toMatchObject({
      repositoryId: fx.repoId,
      validating: 1,
      changed: 1,
      passed: 1,
      running: 0,
      failed: 0,
      infrastructureFailure: 0,
      errors: [],
    });
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'delivery', evidenceState: 'valid' });
  });

  test('accepted check failure is terminal for WorkHandle and WorkContract verification', () => {
    const fx = fixture('failed');
    const result = reconcileWorkValidation(fx.controllerHome, fx.handle);
    expect(result).toMatchObject({ outcome: 'failed', changed: true, handle: { state: 'failed' } });
    expect(result.handle.finalization.validation).toBe('failed');
    expect(contractFor(fx)).toMatchObject({ status: 'failed', phase: 'cleanup', evidenceState: 'failed' });
  });

  test('authorizes delivery only for valid evidence bound to the exact current input', () => {
    const valid = {
      finalizationValidation: 'done' as const,
      validatedInputFingerprint: 'workspace-current',
      evidenceState: 'valid',
      expectedFingerprint: 'workspace-current',
    };
    expect(hasCurrentWorkValidationAuthority(valid)).toBe(true);
    expect(hasCurrentWorkValidationAuthority({ ...valid, expectedFingerprint: 'workspace-changed' })).toBe(false);
    expect(hasCurrentWorkValidationAuthority({ ...valid, evidenceState: 'stale' })).toBe(false);
    expect(hasCurrentWorkValidationAuthority({ ...valid, finalizationValidation: 'pending' })).toBe(false);
  });

  test('a changed-input revalidation marks prior valid evidence stale without rewriting receipts', () => {
    const fx = fixture('succeeded');
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, { evidenceState: 'valid' });

    markWorkValidationPending(fx.controllerHome, fx.handle);
    expect(contractFor(fx)).toMatchObject({ evidenceState: 'stale' });

    markWorkValidationPending(fx.controllerHome, fx.handle);
    expect(contractFor(fx)).toMatchObject({ evidenceState: 'stale' });
  });

  test('timeout and missing Process records keep validation infrastructure retryable', () => {
    const timedOut = fixture('timed_out');
    const timedOutResult = reconcileWorkValidation(timedOut.controllerHome, timedOut.handle);
    expect(timedOutResult).toMatchObject({ outcome: 'infrastructure_failure', handle: { state: 'failed' } });
    expect(timedOutResult.handle.finalization.validation).toBe('failed'); expect(timedOutResult.handle.validationRun).toBeUndefined();
    expect(contractFor(timedOut)).toMatchObject({ status: 'running', phase: 'verification', evidenceState: 'partial' });

    const missing = fixture('succeeded', { createProcess: false });
    const missingResult = reconcileWorkValidation(missing.controllerHome, missing.handle);
    expect(missingResult).toMatchObject({ outcome: 'infrastructure_failure', handle: { state: 'failed' } });
    expect(missingResult.handle.validationRun).toBeUndefined();
    expect(contractFor(missing)).toMatchObject({ status: 'running', phase: 'verification', evidenceState: 'partial' });
  });
});

function workspaceStatus(path: string, porcelain = ` M ${path}`) {
  return {
    head: 'abc123',
    branch: 'work/validation-integrity',
    porcelain,
    staged: [],
    unstaged: [path],
    untracked: [],
  };
}

describe('workspace-bound validation identity', () => {
  test('changes when file content changes without a HEAD or status-shape change', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verification-evidence-'));
    roots.push(root);
    const path = 'source.ts';
    writeFileSync(join(root, path), 'export const value = 1;\n');
    const first = workspaceValidationFingerprint(root, workspaceStatus(path));

    writeFileSync(join(root, path), 'export const value = 2;\n');
    const second = workspaceValidationFingerprint(root, workspaceStatus(path));

    expect(second).not.toBe(first);
    expect(workspaceValidationFingerprint(root, workspaceStatus(path))).toBe(second);
  });

  test('decodes Git quoted paths before hashing exact content', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verification-evidence-'));
    roots.push(root);
    const path = 'space name.txt';
    const quoted = '"space name.txt"';
    writeFileSync(join(root, path), 'first\n');
    const first = workspaceValidationFingerprint(root, workspaceStatus(quoted, `?? ${quoted}`));

    writeFileSync(join(root, path), 'second\n');
    expect(workspaceValidationFingerprint(root, workspaceStatus(quoted, `?? ${quoted}`))).not.toBe(first);
  });

  test('fails closed when Git status output is truncated', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verification-evidence-'));
    roots.push(root);
    expect(() => workspaceValidationFingerprint(root, {
      ...workspaceStatus('source.ts'),
      porcelain: '[output truncated after 524288 bytes]',
    })).toThrow('WORK_VALIDATION_STATUS_TRUNCATED');
  });

  test('binds reusable receipts to workspace content and a stable check set', () => {
    const requestedChecks = ['check:b', 'check:a'];
    const firstWork = workValidationInputFingerprint('abc123', 'workspace-one', requestedChecks);
    expect(firstWork).toBe(workValidationInputFingerprint('abc123', 'workspace-one', [...requestedChecks].reverse()));
    expect(firstWork).not.toBe(workValidationInputFingerprint('abc123', 'workspace-two', requestedChecks));

    const record: VerificationRecord = {
      checkId: 'check:a',
      outcome: 'valid_pass',
      summary: 'passed',
      recordedAt: '2026-08-04T00:00:00.000Z',
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-one',
      verificationInputFingerprint: verificationInputFingerprint({
        sourceRevision: 'abc123',
        workspaceFingerprint: 'workspace-one',
        checkId: 'check:a',
        requestedChecks,
      }),
    };
    expect(effectiveVerificationEvidence([record], {
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-one',
      checkId: 'check:a',
      requestedChecks,
    })[0]).toMatchObject({ current: true });
    expect(effectiveVerificationEvidence([record], {
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-two',
      checkId: 'check:a',
      requestedChecks,
    })[0]).toMatchObject({ current: false, staleReason: 'workspace content changed' });
    expect(effectiveVerificationEvidence([record], {
      sourceRevision: 'abc123',
      workspaceFingerprint: 'workspace-one',
      checkId: 'check:a',
      requestedChecks: ['check:a'],
    })[0]).toMatchObject({ current: false, staleReason: 'verification inputs changed' });
  });
});
