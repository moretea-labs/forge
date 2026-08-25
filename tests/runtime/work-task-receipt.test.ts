import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { bindTaskToWork, createIssue, getIssue, getIssueReadView, planIssue, updateTask } from '../../src/cli/controller/issue-store';
import { createWorkContract, getWorkContract, transitionWorkContractPhase, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { projectControllerTaskFromWork } from '../../src/runtime/control-plane/facade/work-task-projection';
import { finalizeGoalWorkloop } from '../../src/runtime/control-plane/facade/goal-workloop';
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

function fixture(options: { changed?: boolean; equivalentHistoricalWork?: boolean; requirementId?: string } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-work-receipt-'));
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
  const controllerHome = join(repoRoot, '_ops', 'controller-home');
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
    ...(options.requirementId ? { requirementId: options.requirementId } : {}),
    status: options.equivalentHistoricalWork ? 'failed' : 'running',
    phase: 'cleanup',
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
  test('uses four bounded technical Work phases with one Work-owned checkpoint map', () => {
    expect(WORK_PHASES).toEqual(['implementation', 'verification', 'delivery', 'cleanup']);
    const fx = fixture();
    const options = { controllerHome: fx.controllerHome, repoId: fx.repoId };
    const initial = getWorkContract(options, fx.workId)!;
    expect(initial.phase).toBe('cleanup');
    expect(initial.phaseEvidence).toMatchObject({
      implementation: { state: 'satisfied' },
      verification: { state: 'satisfied' },
      delivery: { state: 'satisfied' },
      cleanup: { state: 'active' },
    });
    expect(() => updateWorkContract(options, fx.workId, { phase: 'verification' })).toThrow(/WORK_PHASE_REQUIRES_TRANSITION_API/);
    const rewound = transitionWorkContractPhase(options, fx.workId, {
      phase: 'verification',
      status: 'running',
      state: 'active',
      summary: 'Re-run exact verification after delivery drift.',
    });
    expect(rewound.phaseEvidence).toMatchObject({
      implementation: { state: 'satisfied' },
      verification: { state: 'active' },
      delivery: { state: 'pending' },
      cleanup: { state: 'pending' },
    });
    const blocked = updateWorkContract(options, fx.workId, { status: 'blocked' });
    expect(blocked.phase).toBe('verification');
    expect(blocked.phaseEvidence.verification.state).toBe('active');
  });

  test('does not allow generic writes to manufacture terminal Work or inject a receipt', () => {
    const fx = fixture();
    expect(() => updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, { status: 'completed' })).toThrow(/WORK_COMPLETION_REQUIRES_RECORD_API/);
    expect(() => updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      status: 'completed',
      completionOutcome: 'completed_changed',
      completionReceipt: {
        schemaVersion: 1,
        receiptId: 'forged-receipt',
        source: 'controller_work',
        issueId: fx.issueId,
        taskId: 'T1',
        workId: fx.workId,
        targetBranch: 'main',
        targetRevision: fx.expectedHead,
        changedPaths: ['feature.txt'],
        delivery: { kind: 'commit', status: 'integrated', strategy: 'already_integrated', reachable: true, recordedAt: new Date().toISOString() },
        cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt: new Date().toISOString() },
        verifiedAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
      },
    })).toThrow(/WORK_COMPLETION_REQUIRES_RECORD_API/);
  });

  test('binds a completed cleaned Work to the exact verified Task even when Requirement projection is unavailable', () => {
    const fx = fixture({ requirementId: 'REQ-task-receipt-missing-record' });
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
    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId);
    expect(completed?.completionReceipt).toMatchObject({ workId: fx.workId, targetRevision: fx.expectedHead });
    expect(completed?.evidenceRefs.some((evidence) => evidence.title === 'requirement completion projection pending' && (evidence.summary ?? '').includes('REQUIREMENT_NOT_FOUND'))).toBe(true);
  });

  test('keeps audited successor paths as immutable Work delivery scope when target history also contains unrelated changes', () => {
    const fx = fixture({ changed: false });
    writeFileSync(join(fx.repoRoot, 'unrelated.txt'), 'other work\n');
    git(fx.repoRoot, ['add', 'unrelated.txt']);
    git(fx.repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'unrelated target advance']);
    const priorTargetHead = git(fx.repoRoot, ['rev-parse', 'HEAD']);

    writeFileSync(join(fx.repoRoot, 'feature.txt'), 'implemented\n');
    git(fx.repoRoot, ['add', 'feature.txt']);
    git(fx.repoRoot, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'adopted work successor']);
    const targetRevision = git(fx.repoRoot, ['rev-parse', 'HEAD']);
    expect(git(fx.repoRoot, ['diff', '--name-only', fx.baseCommit, targetRevision]).split('\n').sort()).toEqual(['feature.txt', 'unrelated.txt']);

    const task = getIssue(fx.repoRoot, fx.issueId).tasks.find((entry) => entry.id === 'T1')!;
    updateTask(fx.repoRoot, fx.issueId, 'T1', {
      verification: { ...task.verification!, integratedRevision: targetRevision },
    });
    writeWorkHandle(fx.controllerHome, { ...fx.handle, expectedHead: targetRevision });
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      reconciliations: [{
        schemaVersion: 1,
        reconciliationId: 'RECNC-successor-scope',
        originalExpectedRevision: priorTargetHead,
        observedTargetRevision: targetRevision,
        baseRevision: fx.baseCommit,
        targetBranch: 'main',
        reachable: true,
        method: 'exact_commit',
        comparedPaths: ['feature.txt'],
        reviewer: 'test reviewer',
        reviewedAt: '2026-08-25T00:00:00.000Z',
        unrecoverableStages: [],
        cleanupOwnershipProof: 'Managed cleanup remains owned by the Work finalizer.',
        rationale: 'The audited successor delta contains only the Work-owned feature path.',
        outcome: 'accepted_equivalence',
      }],
    });

    const result = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    });
    expect(result.receipt.changedPaths).toEqual(['feature.txt']);
    expect(result.receipt.changedPaths).not.toContain('unrelated.txt');
    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    expect(completed.scopeEvidence?.actualChangedPaths).toEqual(['feature.txt']);
  });

  test('treats a Work-bound Task status and contract fields as a derived compatibility projection', () => {
    const fx = fixture();
    bindTaskToWork(fx.repoRoot, fx.issueId, 'T1', fx.workId, fx.repoId);
    expect(() => updateTask(fx.repoRoot, fx.issueId, 'T1', { status: 'cancelled' })).toThrow(/TASK_STATUS_WORK_OWNED/);
    expect(() => updateTask(fx.repoRoot, fx.issueId, 'T1', {
      verification: getIssue(fx.repoRoot, fx.issueId).tasks[0]!.verification,
    })).toThrow(/TASK_VERIFICATION_WORK_OWNED/);
    expect(() => planIssue(fx.repoRoot, fx.issueId, [{ title: 'Replan', objective: 'Replace the bound execution contract.' }])).toThrow(/TASK_PLAN_WORK_OWNED/);

    const task = getIssue(fx.repoRoot, fx.issueId).tasks[0]!;
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    const projected = getIssueReadView(fx.repoRoot, fx.issueId, 'full').tasks[0]!;
    expect(projected).toMatchObject({
      workId: fx.workId,
      objective: work.objective,
      allowedPaths: work.allowedPaths,
      forbiddenPaths: work.forbiddenPaths,
      checks: work.checks,
      acceptanceCriteria: work.acceptanceCriteria,
      risk: 'medium',
      status: 'cleanup_pending',
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
    const completedWork = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    expect(completedWork.completionReceipt?.workId).toBe(fx.workId);
    expect(completedWork.phaseEvidence).toMatchObject({
      implementation: { state: 'satisfied' },
      verification: { state: 'satisfied' },
      delivery: { state: 'satisfied', receiptId: completedWork.completionReceipt?.receiptId },
      cleanup: { state: 'satisfied', receiptId: completedWork.completionReceipt?.receiptId },
    });
  });

  test('does not downgrade a reviewed done Task from historical failed Work evidence', () => {
    const fx = fixture({ equivalentHistoricalWork: true });
    updateTask(fx.repoRoot, fx.issueId, 'T1', { status: 'done' });
    bindTaskToWork(fx.repoRoot, fx.issueId, 'T1', fx.workId, fx.repoId);
    const task = getIssue(fx.repoRoot, fx.issueId).tasks[0]!;
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    expect(work.status).toBe('failed');
    expect(projectControllerTaskFromWork(task, work).status).toBe('done');
  });

  test('fails closed when a Task is bound to another Work identity', () => {
    const fx = fixture();
    bindTaskToWork(fx.repoRoot, fx.issueId, 'T1', 'work_other', fx.repoId);
    expect(getIssueReadView(fx.repoRoot, fx.issueId, 'full').tasks[0]).toMatchObject({
      workId: 'work_other',
      status: 'launch_blocked',
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      repoRoot: fx.repoRoot,
      issueId: fx.issueId,
      taskId: 'T1',
      workId: fx.workId,
    })).toThrow(/TASK_WORK_MISMATCH/);
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

  test('finalizes from a current pass while preserving an older failure for the same check', () => {
    const fx = fixture();
    const checkId = 'package:test';
    const options = { controllerHome: fx.controllerHome, repoId: fx.repoId };
    updateWorkContract(options, fx.workId, {
      checks: [checkId],
      checkRefs: [
        {
          checkId, outcome: 'valid_fail', summary: 'historical failure', recordedAt: '2026-08-11T00:00:00.000Z',
          sourceRevision: fx.baseCommit,
          verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: fx.baseCommit, checkId, requestedChecks: [checkId] }),
        },
        {
          checkId, outcome: 'valid_pass', summary: 'current pass', recordedAt: '2026-08-11T00:01:00.000Z',
          sourceRevision: fx.expectedHead,
          verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: fx.expectedHead, checkId, requestedChecks: [checkId] }),
        },
      ],
    });

    const accepted = acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome, repoId: fx.repoId, repoRoot: fx.repoRoot,
      issueId: fx.issueId, taskId: 'T1', workId: fx.workId,
    });
    expect(accepted.receipt.targetRevision).toBe(fx.expectedHead);
    const completed = getWorkContract(options, fx.workId)!;
    expect(completed.status).toBe('completed');
    expect(completed.checkRefs.map((record) => [record.outcome, record.sourceRevision])).toEqual([
      ['valid_fail', fx.baseCommit],
      ['valid_pass', fx.expectedHead],
    ]);

    const finalized = finalizeGoalWorkloop({
      workStore: options,
      handoffStore: options,
      repoId: fx.repoId,
      sourceRevision: fx.expectedHead,
    }, { workId: fx.workId });
    expect(finalized.status).toBe('ok');
    expect((finalized.data as { finalStatus?: string }).finalStatus).toBe('completed');
  });

  test('does not let a current failure satisfy required finalization evidence', () => {
    const fx = fixture();
    const checkId = 'package:test';
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks: [checkId],
      checkRefs: [{
        checkId, outcome: 'valid_fail', summary: 'current failure', recordedAt: new Date().toISOString(),
        sourceRevision: fx.expectedHead,
        verificationInputFingerprint: verificationInputFingerprint({ sourceRevision: fx.expectedHead, checkId, requestedChecks: [checkId] }),
      }],
    });
    expect(() => acceptVerifiedTaskFromControllerWork({
      controllerHome: fx.controllerHome, repoId: fx.repoId, repoRoot: fx.repoRoot,
      issueId: fx.issueId, taskId: 'T1', workId: fx.workId,
    })).toThrow(/CHECK_EVIDENCE_STALE/);
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
      evidenceState: 'valid',
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

  test('accepts a reviewed equivalent integration without letting missing Requirement projection invent failed Work stages', () => {
    const fx = fixture({ equivalentHistoricalWork: true, requirementId: 'REQ-reviewed-task-missing-record' });
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
    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId);
    expect(completed?.status).toBe('completed');
    expect(completed?.evidenceRefs.some((evidence) => evidence.title === 'requirement completion projection pending' && (evidence.summary ?? '').includes('REQUIREMENT_NOT_FOUND'))).toBe(true);
    const contract = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    expect(contract.status).toBe('completed');
    expect(contract.completionReceipt?.receiptId).toBe(result.receipt.receiptId);
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
