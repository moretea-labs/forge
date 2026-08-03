import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { bindTaskToWork, createIssue, getIssue, planIssue, updateTask } from '../../src/cli/controller/issue-store';
import { createWorkContract, getWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { projectControllerTaskFromWork } from '../../src/runtime/control-plane/facade/work-task-projection';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import {
  acceptVerifiedTaskFromControllerWork,
  acceptVerifiedTaskFromReviewedWorkReconciliation,
  recordControllerWorkReconciliation,
} from '../../src/runtime/control-plane/execution/work-task-receipt';
import { verificationInputFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';
import { WORK_PHASES } from '../../src/runtime/control-plane/facade/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function fixture(options: { changed?: boolean; equivalentHistoricalWork?: boolean } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-work-receipt-'));
  roots.push(repoRoot);
  git(repoRoot, ['init', '-b', 'main']);
  writeFileSync(join(repoRoot, 'package.json'), '{"name":"work-receipt-fixture"}\n');
  git(repoRoot, ['add', 'package.json']);
  git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'base']);
  const baseCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  if (options.changed !== false) {
    writeFileSync(join(repoRoot, 'feature.txt'), 'implemented\n');
    git(repoRoot, ['add', 'feature.txt']);
    git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'implementation']);
  }
  const observedTargetRevision = git(repoRoot, ['rev-parse', 'HEAD']);
  let expectedHead = observedTargetRevision;
  if (options.equivalentHistoricalWork) {
    git(repoRoot, ['checkout', '-b', 'historical-work', baseCommit]);
    writeFileSync(join(repoRoot, 'feature.txt'), 'implemented\n');
    git(repoRoot, ['add', 'feature.txt']);
    git(repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'historical implementation']);
    expectedHead = git(repoRoot, ['rev-parse', 'HEAD']);
    git(repoRoot, ['checkout', 'main']);
  }
  const controllerHome = join(repoRoot, '.controller-home');
  const repoId = 'repo-work-receipt';
  const workId = 'work_completed_fixture';
  const issue = createIssue(repoRoot, {
    title: 'Controller Work receipt',
    tasks: [{ title: 'Implement change', objective: 'Change one tracked file.', allowedPaths: ['feature.txt'], risk: 'medium' }],
    allowDuplicate: true,
  });
  const verifiedAt = new Date().toISOString();
  updateTask(repoRoot, issue.id, 'T1', {
    status: 'verified',
    verification: {
      integratedRevision: observedTargetRevision,
      checkResults: [],
      commandEvidence: [{ command: ['test', '-f', 'feature.txt'], ok: true, exitCode: 0, executedAt: verifiedAt, source: 'reported' }],
      acceptanceResults: [],
      reviewer: 'test',
      verifiedAt,
    },
  });
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    mode: 'goal_workloop',
    objective: 'Implement the verified Task.',
    acceptanceCriteria: [],
    constraints: { requireHandoffOnAmbiguity: true },
    allowedPaths: ['feature.txt'],
    forbiddenPaths: [],
    checks: [],
    requestedBy: 'chatgpt',
    status: options.equivalentHistoricalWork ? 'failed' : 'completed',
  });
  const handle: WorkHandleState = {
    schemaVersion: 1,
    workId,
    sessionId: 'session-test',
    principalId: 'principal-test',
    repositoryId: repoId,
    checkoutId: 'checkout-work',
    worktreePath: join(repoRoot, 'removed-worktree'),
    branch: 'feature/work-receipt',
    sourceCheckoutId: 'checkout-main',
    managedWorktree: true,
    workContractId: workId,
    baseCommit,
    expectedHead,
    permissionSnapshotVersion: 1,
    state: 'cleaned',
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
    finalization: {
      validation: 'done',
      commit: 'done',
      merge: 'done',
      branchCleanup: 'done',
      worktreeCleanup: 'done',
    },
  };
  writeWorkHandle(controllerHome, handle);
  return { repoRoot, controllerHome, repoId, workId, issueId: issue.id, baseCommit, expectedHead, observedTargetRevision, handle };
}

describe('controller Work Task completion receipt', () => {
  test('uses four bounded technical Work phases', () => {
    expect(WORK_PHASES).toEqual(['implementation', 'verification', 'delivery', 'cleanup']);
    const fx = fixture();
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.phase).toBe('cleanup');
  });

  test('does not allow a status write to manufacture terminal Work without a receipt', () => {
    const fx = fixture();
    expect(() => updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, { status: 'completed' })).toThrow(/WORK_COMPLETION_RECEIPT_REQUIRED/);
  });

  test('binds a completed cleaned Work to the exact verified Task and accepts it', () => {
    const fx = fixture();
    const result = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    });
    const task = result.issue.tasks.find((entry) => entry.id === 'T1')!;
    expect(task.status).toBe('done');
    expect(result.receipt).toMatchObject({
      source: 'controller_work',
      workId: fx.workId,
      issueId: fx.issueId,
      taskId: 'T1',
      targetBranch: 'main',
      targetRevision: fx.expectedHead,
      baseRevision: fx.baseCommit,
      changedPaths: ['feature.txt'],
      delivery: { status: 'integrated', reachable: true },
      cleanup: { status: 'complete' },
    });
    const retried = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    });
    expect(retried.receipt.receiptId).toBe(result.receipt.receiptId);
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.completionReceipt).toMatchObject({ workId: fx.workId, targetRevision: fx.expectedHead });
  });

  test('treats a Work-bound Task status and contract fields as a derived compatibility projection', () => {
    const fx = fixture();
    bindTaskToWork(fx.repoRoot, fx.issueId, 'T1', fx.workId);
    expect(() => updateTask(fx.repoRoot, fx.issueId, 'T1', { status: 'cancelled' })).toThrow(/TASK_STATUS_WORK_OWNED/);
    expect(() => planIssue(fx.repoRoot, fx.issueId, [{ title: 'Replan', objective: 'Replace the bound execution contract.' }])).toThrow(/TASK_PLAN_WORK_OWNED/);

    const task = getIssue(fx.repoRoot, fx.issueId).tasks[0]!;
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    const projected = projectControllerTaskFromWork(task, work);
    expect(projected).toMatchObject({
      workId: fx.workId,
      objective: work.objective,
      allowedPaths: work.allowedPaths,
      forbiddenPaths: work.forbiddenPaths,
      checks: work.checks,
      acceptanceCriteria: work.acceptanceCriteria,
      risk: 'medium',
      status: 'done',
    });

    const accepted = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    });
    expect(accepted.issue.tasks[0]!.status).toBe('done');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.completionReceipt?.workId).toBe(fx.workId);
  });

  test('fails closed on revision mismatch without changing Task status', () => {
    const fx = fixture();
    updateTask(fx.repoRoot, fx.issueId, 'T1', {
      verification: {
        ...getIssue(fx.repoRoot, fx.issueId).tasks[0]!.verification!,
        integratedRevision: fx.baseCommit,
      },
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    })).toThrow(/REVISION_MISMATCH/);
    expect(getIssue(fx.repoRoot, fx.issueId).tasks[0]!.status).toBe('verified');
  });

  test('fails closed when cleanup evidence is incomplete', () => {
    const fx = fixture();
    writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      state: 'merged',
      finalization: { ...fx.handle.finalization, worktreeCleanup: 'pending' },
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    })).toThrow(/FINALIZATION_INCOMPLETE/);
    expect(getIssue(fx.repoRoot, fx.issueId).tasks[0]!.status).toBe('verified');
  });

  test('rejects a required check whose exact revision is stale', () => {
    const fx = fixture();
    const checkId = 'package:test';
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks: [checkId],
      checkRefs: [{
        checkId,
        outcome: 'valid_pass',
        summary: 'passed on the base revision',
        recordedAt: new Date().toISOString(),
        sourceRevision: fx.baseCommit,
        verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: fx.baseCommit, checkId, requestedChecks: [checkId] }),
      }],
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    })).toThrow(/CHECK_EVIDENCE_STALE/);
    expect(getIssue(fx.repoRoot, fx.issueId).tasks[0]!.status).toBe('verified');
  });

  test('emits an idempotent no-change receipt only with explicit clean proof', () => {
    const fx = fixture({ changed: false });
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      workKind: 'completed_no_change',
      dispatchState: 'terminal',
      evidenceState: 'valid',
      completionOutcome: 'completed_no_change',
      evidenceRefs: [{ title: 'objective-specific no-change proof', summary: 'The required repository state was observed at the exact target revision.', detailLevel: 'summary' }],
    });
    writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      state: 'prepared',
      baseCommit: fx.expectedHead,
      finalization: {
        validation: 'done', commit: 'skipped', merge: 'skipped', branchCleanup: 'skipped', worktreeCleanup: 'skipped',
      },
    });
    const result = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome, repoId: fx.repoId, repoRoot: fx.repoRoot, issueId: fx.issueId, taskId: 'T1', workId: fx.workId,
    });
    expect(result.receipt).toMatchObject({
      changedPaths: [],
      delivery: { kind: 'no_change', strategy: 'no_change', status: 'integrated' },
    });
    expect(acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome, repoId: fx.repoId, repoRoot: fx.repoRoot, issueId: fx.issueId, taskId: 'T1', workId: fx.workId,
    }).receipt.receiptId).toBe(result.receipt.receiptId);
  });

  test('accepts a reviewed equivalent integration without inventing failed Work stages', () => {
    const fx = fixture({ equivalentHistoricalWork: true });
    writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      state: 'failed',
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending', lastError: 'historical runtime was interrupted' },
    });
    const result = acceptVerifiedTaskFromReviewedWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
      method: 'reviewed_patch_identity',
      outcome: 'accepted_equivalence',
      comparedPaths: ['feature.txt'],
      reviewer: 'test reviewer',
      reviewedAt: '2026-08-01T00:00:00.000Z',
      unrecoverableStages: ['validation', 'commit', 'merge', 'branch_cleanup', 'worktree_cleanup'],
      cleanupOwnershipProof: 'The historical branch and worktree are not controller-owned live resources.',
      rationale: 'Reviewed the two independent patches; both produce the accepted feature content.',
    });
    expect(result.receipt).toMatchObject({
      sourceRevision: fx.expectedHead,
      targetRevision: fx.observedTargetRevision,
      changedPaths: ['feature.txt'],
      delivery: { strategy: 'already_integrated', reachable: true },
    });
    expect(result.issue.tasks[0]!.status).toBe('done');
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    expect(contract.status).toBe('failed');
    expect(contract.reconciliations).toHaveLength(1);
    expect(contract.reconciliations[0]).toMatchObject({
      outcome: 'accepted_equivalence',
      originalExpectedRevision: fx.expectedHead,
      observedTargetRevision: fx.observedTargetRevision,
      reachable: true,
    });
  });

  test('records rejected reconciliation without accepting the Task', () => {
    const fx = fixture({ equivalentHistoricalWork: true });
    const recorded = recordControllerWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
      method: 'owned_path_tree',
      outcome: 'rejected_equivalence',
      comparedPaths: ['feature.txt'],
      reviewer: 'test reviewer',
      unrecoverableStages: ['merge'],
      cleanupOwnershipProof: 'No controller-owned worktree remains.',
      rationale: 'The reviewer rejected the historical equivalence claim.',
    });
    expect(recorded.record.outcome).toBe('rejected_equivalence');
    expect(getIssue(fx.repoRoot, fx.issueId).tasks[0]!.status).toBe('verified');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!.reconciliations).toHaveLength(1);
  });
});
