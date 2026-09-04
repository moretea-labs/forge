import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkContract, getWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { workContractStorePath } from '../../packages/kernel/work/infrastructure/work-contract-store';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord, ProcessCheckExecutionIdentity } from '../../src/runtime/execution/process-runtime/types';
import { hasCurrentWorkValidationAuthority, markWorkValidationPending, reconcilePendingWorkValidations, reconcileWorkValidation } from '../../src/runtime/gateway/mcp/work-validation-reconciler';
import {
  effectiveVerificationEvidence,
  verificationInputFingerprint,
  workspaceValidationFingerprint,
  workValidationInputFingerprint,
} from '../../src/runtime/control-plane/execution/verification-evidence';
import type { VerificationRecord } from '../../src/runtime/control-plane/facade/types'; import { execFileSync } from 'child_process'; import { controllerCheckExecutionIdentity, currentControllerCheckRevision } from '../../src/cli/controller/check-runner'; import { materializeWorkVerificationSnapshot } from '../../src/runtime/control-plane/execution/work-verification-snapshot';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(status: 'succeeded' | 'failed' | 'timed_out', options: {
  createProcess?: boolean;
  checkId?: string;
  worktreePath?: string;
  checkExecution?: ProcessCheckExecutionIdentity;
  bindingCheckExecution?: ProcessCheckExecutionIdentity;
} = {}) {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-'));
  roots.push(controllerHome);
  const now = '2026-08-03T00:00:00.000Z';
  const repoId = 'repo-validation';
  const checkoutId = 'checkout-validation';
  const workId = `work-validation-${status}-${options.createProcess === false ? 'missing' : 'recorded'}`;
  const processId = `proc-validation-${status}-${options.createProcess === false ? 'missing' : 'recorded'}`;
  const checkId = options.checkId ?? 'check-validation';
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
    worktreePath: options.worktreePath ?? '/tmp/work-validation',
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
      processes: {
        [checkId]: {
          processId,
          requestId: 'request-validation',
          ...((options.bindingCheckExecution ?? options.checkExecution)
            ? { checkExecution: { ...(options.bindingCheckExecution ?? options.checkExecution)! } }
            : {}),
        },
      },
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
    ...(options.checkExecution ? { checkExecution: { ...options.checkExecution } } : {}),
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
  test('returns a successful terminal check across MCP transport rotation and advances Work review', () => {
    const fx = fixture('succeeded');
    const rotatedHandle = { ...fx.handle, sessionId: 'session-validation-next' };
    const result = reconcileWorkValidation(fx.controllerHome, rotatedHandle);
    expect(result).toMatchObject({ outcome: 'passed', changed: true, handle: { state: 'editing' } });
    expect(result.handle.finalization.validation).toBe('done');
    expect(result.handle.validationRun).toBeUndefined();
    expect(result.handle.validatedInputFingerprint).toBe('validation-fingerprint');
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'review', evidenceState: 'valid' });

    const repeated = reconcileWorkValidation(fx.controllerHome, result.handle);
    expect(repeated).toMatchObject({ outcome: 'not_validating', changed: false, handle: { state: 'editing' } });
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'review', evidenceState: 'valid' });
  });
  test('accepts the producer cacheKey for the exact Work verification snapshot after authority-only worktree drift', () => {
    const snapshotControllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-cache-key-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-cache-key-repo-'));
    roots.push(snapshotControllerHome, repoRoot);
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ scripts: { 'check:validation': 'node -e \"process.exit(0)\"' } }, null, 2));
    writeFileSync(join(repoRoot, 'owned.ts'), 'export const owned = 1;\n');
    writeFileSync(join(repoRoot, 'authority.ts'), 'export const authority = 1;\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'authority.ts'), 'export const authority = 2;\n');

    const snapshot = materializeWorkVerificationSnapshot({
      controllerHome: snapshotControllerHome,
      repoId: 'repo-validation-cache-key-snapshot',
      sourceRoot: repoRoot,
      scope: { workId: 'work-validation-cache-key-snapshot', allowedPaths: ['owned.ts', 'package.json'], forbiddenPaths: ['authority.ts'] },
    });
    const checkId = 'package:check:validation';
    const producer = controllerCheckExecutionIdentity(snapshot.root, checkId, 30_000);
    const recomputedConsumer = controllerCheckExecutionIdentity(repoRoot, checkId, 30_000);
    expect(producer.cacheKey).not.toBe(recomputedConsumer.cacheKey);
    const checkExecution: ProcessCheckExecutionIdentity = {
      ...producer,
      scopeKey: 'checkout:checkout-validation|work:work-validation-cache-key',
    };
    const fx = fixture('succeeded', {
      checkId,
      worktreePath: repoRoot,
      checkExecution,
      bindingCheckExecution: checkExecution,
    });

    const result = reconcileWorkValidation(fx.controllerHome, fx.handle);
    expect(result).toMatchObject({ outcome: 'passed', changed: true, handle: { state: 'editing' } });
    expect(result.summary).toBeUndefined();
  });

  test('rejects a receipt whose persisted Work snapshot cacheKey does not match the producer record', () => {
    const checkExecution: ProcessCheckExecutionIdentity = {
      schemaVersion: 1,
      checkId: 'check-validation',
      cacheKey: '3b2cfd0ed1eeb8fe98220671',
      revision: 'snapshot-revision',
      definitionDigest: 'definition-digest',
      environmentFingerprint: 'environment-fingerprint',
      timeoutMs: 30_000,
      reuseScope: 'checkout',
      scopeKey: 'checkout:checkout-validation|work:work-validation',
    };
    const fx = fixture('succeeded', {
      checkExecution,
      bindingCheckExecution: { ...checkExecution, cacheKey: 'f4a10b27228da26d8a7442f7' },
    });

    const result = reconcileWorkValidation(fx.controllerHome, fx.handle);
    expect(result).toMatchObject({ outcome: 'infrastructure_failure', changed: true, handle: { state: 'failed' } });
    expect(result.summary).toContain('PROCESS_CHECK_RECEIPT_IDENTITY_MISMATCH');
    expect(result.summary).toContain('check cacheKey');
  });
  test('verification snapshot metadata does not change Check content identity', () => { const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-controller-')); const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-repo-')); roots.push(controllerHome, repoRoot); writeFileSync(join(repoRoot, 'source.ts'), 'export const value = 1;\n'); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot }); execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot }); execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot }); execFileSync('git', ['add', '.'], { cwd: repoRoot }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot }); const sourceIdentity = currentControllerCheckRevision(repoRoot); const snapshot = materializeWorkVerificationSnapshot({ controllerHome, repoId: 'repo-validation-snapshot', sourceRoot: repoRoot, scope: { workId: 'work-validation-snapshot', allowedPaths: ['**'], forbiddenPaths: [] } }); expect(existsSync(join(snapshot.root, '.ai/harness/controller/work-verification-snapshot.json'))).toBe(true); expect(currentControllerCheckRevision(snapshot.root)).toBe(sourceIdentity); });
  test('verification snapshot normalizes tracked regular-file modes independently of process umask', () => {
    if (process.platform === 'win32') return;
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-mode-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-mode-repo-'));
    roots.push(controllerHome, repoRoot);
    writeFileSync(join(repoRoot, 'script.sh'), '#!/bin/sh\necho ok\n');
    writeFileSync(join(repoRoot, 'doc.md'), 'mode fixture\n');
    chmodSync(join(repoRoot, 'script.sh'), 0o755);
    chmodSync(join(repoRoot, 'doc.md'), 0o644);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });

    // Reproduce a source checkout created under umask=0002. Git does not track
    // the group-write bit, so this must not leak into the verification clone.
    chmodSync(join(repoRoot, 'script.sh'), 0o775);
    chmodSync(join(repoRoot, 'doc.md'), 0o664);
    const snapshot = materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-mode-snapshot',
      sourceRoot: repoRoot,
      scope: { workId: 'work-validation-mode-snapshot', allowedPaths: ['**'], forbiddenPaths: [] },
    });

    expect(statSync(join(snapshot.root, 'script.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(snapshot.root, 'doc.md')).mode & 0o777).toBe(0o644);
    expect(statSync(join(repoRoot, 'script.sh')).mode & 0o777).toBe(0o775);
    expect(statSync(join(repoRoot, 'doc.md')).mode & 0o777).toBe(0o664);
  });

  test('verification snapshot provisions an isolated Controller Home inside the candidate namespace', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-host-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-isolated-home-repo-'));
    roots.push(controllerHome, repoRoot);
    writeFileSync(join(repoRoot, 'source.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    const snapshot = materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-isolated-home',
      sourceRoot: repoRoot,
      scope: { workId: 'work-validation-isolated-home', allowedPaths: ['**'], forbiddenPaths: [] },
    });
    expect(snapshot.isolatedControllerHome).toBe(join(snapshot.root, '.git', 'forge-candidate-controller'));
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: snapshot.root, encoding: 'utf8' })).not.toContain('forge-candidate-controller');
    expect(snapshot.isolatedControllerHome).not.toBe(controllerHome);
    expect(existsSync(snapshot.isolatedControllerHome)).toBe(true);
  });
  test('verification snapshot treats empty allowed paths as an unfenced Work scope while preserving forbidden exclusions', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-unfenced-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-unfenced-repo-'));
    roots.push(controllerHome, repoRoot);
    writeFileSync(join(repoRoot, 'owned.ts'), 'export const owned = 1;\n');
    writeFileSync(join(repoRoot, 'forbidden.ts'), 'export const forbidden = 1;\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'owned.ts'), 'export const owned = 2;\n');
    writeFileSync(join(repoRoot, 'forbidden.ts'), 'export const forbidden = 2;\n');

    const snapshot = materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-unfenced',
      sourceRoot: repoRoot,
      scope: { workId: 'work-validation-unfenced', allowedPaths: [], forbiddenPaths: ['forbidden.ts'] },
    });
    expect(snapshot.includedPaths).toEqual(['owned.ts']);
    expect(snapshot.excludedPaths).toEqual(['forbidden.ts']);
    expect(readFileSync(join(snapshot.root, 'owned.ts'), 'utf8')).toContain('owned = 2');
    expect(readFileSync(join(snapshot.root, 'forbidden.ts'), 'utf8')).toContain('forbidden = 1');
  });

  test('verification snapshot keeps explicit allowed paths as a positive ownership fence', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-fenced-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-fenced-repo-'));
    roots.push(controllerHome, repoRoot);
    writeFileSync(join(repoRoot, 'owned.ts'), 'export const owned = 1;\n');
    writeFileSync(join(repoRoot, 'outside.ts'), 'export const outside = 1;\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'owned.ts'), 'export const owned = 2;\n');
    writeFileSync(join(repoRoot, 'outside.ts'), 'export const outside = 2;\n');

    expect(() => materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-fenced',
      sourceRoot: repoRoot,
      scope: { workId: 'work-validation-fenced', allowedPaths: ['owned.ts'], forbiddenPaths: [] },
    })).toThrow(/WORK_VERIFICATION_PATH_OWNERSHIP_AMBIGUOUS: outside\.ts/);
  });

  test('verification snapshot safely reuses primary worktree dependencies only when dependency metadata is unchanged', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-validation-deps-controller-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-validation-deps-repo-'));
    const worktreeParent = mkdtempSync(join(tmpdir(), 'forge-work-validation-deps-worktree-parent-'));
    const worktreeRoot = join(worktreeParent, 'worktree');
    roots.push(controllerHome, repoRoot, worktreeParent);
    writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repoRoot, 'package.json'), '{\"name\":\"fixture\",\"private\":true}\n');
    writeFileSync(join(repoRoot, 'bun.lock'), '# stable dependency lock\n');
    mkdirSync(join(repoRoot, 'node_modules', 'fixture-dependency'), { recursive: true });
    writeFileSync(join(repoRoot, 'node_modules', 'fixture-dependency', 'marker.txt'), 'primary dependency cache\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['add', '.gitignore', 'package.json', 'bun.lock'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'work/dependency-reuse', worktreeRoot], { cwd: repoRoot });
    expect(existsSync(join(worktreeRoot, 'node_modules'))).toBe(false);

    const reused = materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-dependency-reuse',
      sourceRoot: worktreeRoot,
      scope: { workId: 'work-validation-dependency-reuse', allowedPaths: ['**'], forbiddenPaths: [] },
    });
    expect(existsSync(join(reused.root, 'node_modules', 'fixture-dependency', 'marker.txt'))).toBe(true);
    expect(realpathSync(join(reused.root, 'node_modules'))).toBe(realpathSync(join(repoRoot, 'node_modules')));

    symlinkSync(join(repoRoot, 'node_modules'), join(worktreeRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const reusedFromManagedLink = materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-dependency-reuse',
      sourceRoot: worktreeRoot,
      scope: { workId: 'work-validation-dependency-reuse-linked', allowedPaths: ['package.json'], forbiddenPaths: [] },
    });
    expect(realpathSync(join(reusedFromManagedLink.root, 'node_modules'))).toBe(realpathSync(join(repoRoot, 'node_modules')));
    rmSync(join(worktreeRoot, 'node_modules'), { recursive: true, force: true });

    writeFileSync(join(worktreeRoot, 'package.json'), '{\"name\":\"fixture\",\"private\":true,\"dependencies\":{\"new-package\":\"1.0.0\"}}\n');
    const changed = materializeWorkVerificationSnapshot({
      controllerHome,
      repoId: 'repo-validation-dependency-reuse',
      sourceRoot: worktreeRoot,
      scope: { workId: 'work-validation-dependency-changed', allowedPaths: ['package.json'], forbiddenPaths: [] },
    });
    expect(existsSync(join(changed.root, 'node_modules'))).toBe(false);
  });

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
    expect(contractFor(fx)).toMatchObject({ status: 'running', phase: 'review', evidenceState: 'valid' });
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

  test('reads an in-flight legacy Work that predates the first-class review checkpoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-review-phase-migration-'));
    roots.push(root);
    const workId = 'work-legacy-review-phase';
    createWorkContract({ root }, {
      workId,
      repoId: 'repo-legacy-review-phase',
      mode: 'goal_workloop',
      objective: 'Continue an in-flight Work across a Runtime schema upgrade.',
      acceptanceCriteria: ['Durable Work remains readable after adding the review phase.'],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
    });

    const storePath = workContractStorePath({ root });
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as { contracts: Array<Record<string, any>> };
    const legacy = persisted.contracts[0]!;
    legacy.phase = 'delivery';
    legacy.phaseEvidence.implementation.state = 'satisfied';
    legacy.phaseEvidence.verification.state = 'satisfied';
    delete legacy.phaseEvidence.review;
    legacy.phaseEvidence.delivery.state = 'active';
    legacy.phaseEvidence.cleanup.state = 'pending';
    writeFileSync(storePath, `${JSON.stringify(persisted, null, 2)}\
`);

    const migrated = getWorkContract({ root }, workId)!;
    expect(migrated.phase).toBe('delivery');
    expect(migrated.phaseEvidence.review.state).toBe('skipped');
    expect(migrated.phaseEvidence.review.summary).toContain('compatibility-skipped without synthesizing Controller approval');
    expect(migrated.implementationReviews).toEqual([]);
    expect(migrated.phaseEvidence.delivery.state).toBe('active');
  });

  test('upgrades a persisted legacy-inferred pending review after the Work already advanced past review', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-work-review-phase-pending-migration-'));
    roots.push(root);
    const workId = 'work-legacy-pending-review-phase';
    createWorkContract({ root }, {
      workId,
      repoId: 'repo-legacy-pending-review-phase',
      mode: 'goal_workloop',
      objective: 'Read a Work that persisted legacy review evidence before first-class review existed.',
      acceptanceCriteria: ['Only legacy-inferred pending review evidence is compatibility-upgraded.'],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
    });

    const storePath = workContractStorePath({ root });
    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as { contracts: Array<Record<string, any>> };
    const legacy = persisted.contracts[0]!;
    legacy.phase = 'delivery';
    legacy.phaseEvidence.implementation.state = 'satisfied';
    legacy.phaseEvidence.verification.state = 'satisfied';
    legacy.phaseEvidence.review = {
      ...legacy.phaseEvidence.review,
      state: 'pending',
      source: 'legacy_inferred',
      summary: 'Legacy review remained pending before the review checkpoint existed.',
    };
    legacy.phaseEvidence.delivery.state = 'active';
    legacy.phaseEvidence.cleanup.state = 'pending';
    writeFileSync(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    const migrated = getWorkContract({ root }, workId)!;
    expect(migrated.phaseEvidence.review.state).toBe('skipped');
    expect(migrated.phaseEvidence.review.source).toBe('legacy_inferred');
    expect(migrated.phaseEvidence.review.summary).toContain('before that checkpoint existed');
  });
});
