import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyEditOperations, beginEditSession, finalizeEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { registerRepository } from '../../src/cli/repositories/registry';
import { commitSelectedPaths } from '../../src/cli/repositories/selected-path-actions';
import { repositoryGitStatus } from '../../src/cli/repositories/structured-git';
import { acceptReviewedDirectEditWorkReconciliation, completeReviewedDirectEditWorkAfterCommit, hasReviewedDirectEditReconciliationOwnership, isFailedReviewedDirectEditWorkRecovery, prepareReviewedDirectEditWorkCommit, reconcileFinalizedDirectEditWorksAfterCommit, type ReviewedDirectEditWorkCommitPlan } from '../../src/runtime/control-plane/execution/direct-edit-work-completion';
import { implementationReviewContentFingerprint } from '../../src/runtime/control-plane/execution/implementation-review-content';
import { createWorkContract, getWorkContract, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../src/runtime/control-plane/facade/work-implementation-review';
import type { VerificationRecord } from '../../src/runtime/control-plane/facade/types';
import type { WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { commandFingerprint, verificationInputFingerprint, workspaceValidationFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(requirementId?: string) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-direct-edit-work-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-direct-edit-work-home-'));
  roots.push(repoRoot, controllerHome);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# Test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });

  const repository = registerRepository({ path: repoRoot, controllerHome });
  const repoId = repository.repoId;
  const checkoutId = repository.activeCheckoutId;
  const workId = 'work-direct-edit-work';
  createWorkContract({ controllerHome, repoId }, {
    workId,
    repoId,
    checkoutId,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    mode: 'direct_control',
    objective: 'Complete a standalone Direct Edit through WorkContract authority.',
    acceptanceCriteria: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    checks: [],
    constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    ...(requirementId ? { requirementId } : {}),
    status: 'running',
  });
  const session = beginEditSession(repoRoot, {
    purpose: 'Standalone Direct Edit',
    allowedPaths: ['src/**'],
    binding: { workId, repoId, checkoutId, principalId: 'principal-test' },
  });
  applyEditOperations(repoRoot, getMcpPolicy('controller'), session.sessionId, [
    { type: 'create', path: 'src/example.ts', content: 'export const value = 1;\n' },
  ], {
    binding: { workId, repoId, checkoutId, principalId: 'principal-test' },
  });
  finalizeEditSession(repoRoot, session.sessionId, {
    reviewer: 'test',
    binding: { workId, repoId, checkoutId, principalId: 'principal-test' },
  });
  return { repoRoot, controllerHome, repository, repoId, checkoutId, workId, sessionId: session.sessionId };
}

function commitExample(repoRoot: string, content?: string) {
  if (content !== undefined) writeFileSync(join(repoRoot, 'src/example.ts'), content);
  execFileSync('git', ['add', '--', 'src/example.ts'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'direct edit'], { cwd: repoRoot });
}

function verificationRecord(input: {
  repoId: string;
  checkoutId: string;
  workId: string;
  checkId: string;
  requestedChecks: string[];
  sourceRevision: string;
  workspaceFingerprint: string;
  receiptId: string;
  commandId: string;
  recordedAt: string;
  outcome?: VerificationRecord['outcome'];
  verificationInputFingerprintOverride?: string;
  commandFingerprintOverride?: string;
}): VerificationRecord {
  const outcome = input.outcome ?? 'valid_pass';
  const passed = outcome === 'valid_pass';
  return {
    checkId: input.checkId,
    outcome,
    summary: `fixture ${outcome}`,
    recordedAt: input.recordedAt,
    sourceRevision: input.sourceRevision,
    workspaceFingerprint: input.workspaceFingerprint,
    verificationInputFingerprint: input.verificationInputFingerprintOverride ?? verificationInputFingerprint({
      sourceRevision: input.sourceRevision,
      workspaceFingerprint: input.workspaceFingerprint,
      checkId: input.checkId,
      requestedChecks: input.requestedChecks,
    }),
    commandFingerprint: input.commandFingerprintOverride ?? commandFingerprint(input.checkId, input.commandId),
    startedAt: input.recordedAt,
    completedAt: input.recordedAt,
    receipt: {
      schemaVersion: 1,
      receiptId: input.receiptId,
      resultDigest: `digest-${input.receiptId}`,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      workId: input.workId,
      checkId: input.checkId,
      processId: `process-${input.receiptId}`,
      commandId: input.commandId,
      status: passed ? 'passed' : 'failed',
      runtimeStatus: passed ? 'succeeded' : 'failed',
      ok: passed,
      exitCode: passed ? 0 : 1,
      timedOut: false,
      cancelled: false,
      artifactPath: `.ai/harness/checks/${input.receiptId}.json`,
      summary: `fixture ${outcome}`,
      startedAt: input.recordedAt,
      finishedAt: input.recordedAt,
    },
  };
}

function reconciliationInput(fx: ReturnType<typeof fixture>, targetRevision: string) {
  return {
    controllerHome: fx.controllerHome,
    repoId: fx.repoId,
    checkoutId: fx.checkoutId,
    repoRoot: fx.repoRoot,
    workId: fx.workId,
    targetBranch: 'main',
    targetRevision,
    comparedPaths: ['src/example.ts'],
    reviewer: 'reviewer-test',
    rationale: 'The exact owned path tree is already integrated at the accepted target revision.',
    cleanupOwnershipProof: 'This current-checkout Work owns no managed branch or worktree cleanup.',
  };
}

function approveCurrentDirectEditCandidate(fx: ReturnType<typeof fixture>): void {
  const status = repositoryGitStatus(fx.repository);
  const sourceRevision = status.head!;
  const changedPaths = ['src/example.ts'];
  const reviewContentFingerprint = implementationReviewContentFingerprint(fx.repoRoot, changedPaths);
  const verificationWorkspaceFingerprint = workspaceValidationFingerprint(fx.repoRoot, status);
  transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
    phase: 'verification',
    status: 'running',
    state: 'satisfied',
    summary: 'No registered checks are required; exact candidate verification is satisfied.',
  });
  requestWorkImplementationReview(
    { controllerHome: fx.controllerHome, repoId: fx.repoId },
    fx.workId,
    'Exact Direct Edit candidate is ready for Controller review.',
  );
  recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
    schemaVersion: 1,
    reviewId: 'REV-direct-edit-approved',
    workId: fx.workId,
    reviewerPrincipalId: 'principal-reviewer',
    decision: 'approved',
    rationale: 'Exact Direct Edit implementation and source-bound candidate reviewed.',
    findings: [],
    sourceRevision,
    workspaceFingerprint: reviewContentFingerprint,
    verificationWorkspaceFingerprint,
    changedPaths,
    changedPathDigest: implementationReviewChangedPathDigest(changedPaths),
    acceptanceCriteriaSummary: 'Standalone Direct Edit acceptance reviewed.',
    verificationEvidence: [],
    architectureEvidence: [],
    recordedAt: new Date().toISOString(),
  });
}

describe('standalone Direct Edit Work completion', () => {
  test('authorizes ownerless failed reviewed recovery only for the exact historical WorkHandle principal', () => {
    const fx = fixture();
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    const failedWork = { ...work, workKind: 'repository_change' as const, status: 'failed' as const };
    const now = new Date().toISOString();
    const handle: WorkHandleState = {
      schemaVersion: 1,
      workId: fx.workId,
      workContractId: fx.workId,
      sessionId: 'historical-session',
      principalId: 'historical-principal',
      repositoryId: fx.repoId,
      checkoutId: fx.checkoutId,
      worktreePath: fx.repoRoot,
      branch: 'main',
      managedWorktree: false,
      permissionSnapshotVersion: 1,
      state: 'failed',
      createdAt: now,
      updatedAt: now,
      finalization: {
        validation: 'failed',
        commit: 'pending',
        merge: 'pending',
        branchCleanup: 'pending',
        worktreeCleanup: 'pending',
        lastError: 'WORK_HANDLE_HEAD_CHANGED: expected old, found current',
      },
    };

    expect(isFailedReviewedDirectEditWorkRecovery(failedWork, handle)).toBe(true);
    expect(hasReviewedDirectEditReconciliationOwnership({
      work: failedWork,
      handle,
      callerPrincipal: 'historical-principal',
    })).toBe(true);
    expect(hasReviewedDirectEditReconciliationOwnership({
      work: failedWork,
      handle,
      callerPrincipal: 'foreign-principal',
    })).toBe(false);
    expect(hasReviewedDirectEditReconciliationOwnership({
      work: failedWork,
      handle,
      activeOwnerPrincipal: 'active-foreign-principal',
      callerPrincipal: 'historical-principal',
    })).toBe(false);
    expect(isFailedReviewedDirectEditWorkRecovery({ ...failedWork, status: 'cancelled' }, handle)).toBe(false);
    expect(isFailedReviewedDirectEditWorkRecovery(failedWork, { ...handle, managedWorktree: true })).toBe(false);
  });

  test('commits an exact approved Direct Edit candidate, derives review authority across the commit, and completes the Work', () => {
    const fx = fixture();
    const changedPaths = ['src/example.ts'];
    approveCurrentDirectEditCandidate(fx);

    let plan: ReviewedDirectEditWorkCommitPlan | undefined;
    const committed = commitSelectedPaths(fx.controllerHome, fx.repository, {
      paths: changedPaths,
      message: 'reviewed direct edit',
      beforeCommitGuard: ({ stagedPaths, currentHead }) => {
        plan = prepareReviewedDirectEditWorkCommit({
          controllerHome: fx.controllerHome,
          repository: fx.repository,
          stagedPaths,
          currentHead,
        });
      },
    });
    expect(committed.error).toBeUndefined();
    expect(committed.commit?.ok).toBe(true);
    expect(plan).toBeDefined();

    const completion = completeReviewedDirectEditWorkAfterCommit({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      plan: plan!,
      fallbackBranch: 'main',
    });
    expect(completion.completedWorkIds).toEqual([fx.workId]);
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    expect(work.status).toBe('completed');
    expect(work.completionReceipt).toMatchObject({
      source: 'direct_edit_work',
      workId: fx.workId,
      editSessionId: fx.sessionId,
      changedPaths,
      delivery: { status: 'integrated', reachable: true },
    });
    expect(work.implementationReviews).toHaveLength(2);
    expect(work.implementationReviews[1]).toMatchObject({
      decision: 'approved',
      derivedFromReviewId: 'REV-direct-edit-approved',
      derivation: 'content_equivalent_commit',
      sourceRevision: committed.commit?.after?.head,
    });
  });

  test('blocks a Work-bound selected-path commit before Git mutation when implementation review is missing', () => {
    const fx = fixture();
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    expect(() => commitSelectedPaths(fx.controllerHome, fx.repository, {
      paths: ['src/example.ts'],
      message: 'must not commit without review',
      beforeCommitGuard: ({ stagedPaths, currentHead }) => {
        prepareReviewedDirectEditWorkCommit({ controllerHome: fx.controllerHome, repository: fx.repository, stagedPaths, currentHead });
      },
    })).toThrow(/WORK_IMPLEMENTATION_REVIEW_REQUIRED/);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe(headBefore);
  });

  test('blocks a reviewed Direct Edit before Git mutation when filesystem content becomes stale', () => {
    const fx = fixture();
    approveCurrentDirectEditCandidate(fx);
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    writeFileSync(join(fx.repoRoot, 'src/example.ts'), 'export const value = 2;\n');
    expect(() => commitSelectedPaths(fx.controllerHome, fx.repository, {
      paths: ['src/example.ts'],
      message: 'must not commit stale review',
      beforeCommitGuard: ({ stagedPaths, currentHead }) => {
        prepareReviewedDirectEditWorkCommit({ controllerHome: fx.controllerHome, repository: fx.repository, stagedPaths, currentHead });
      },
    })).toThrow(/WORK_IMPLEMENTATION_REVIEW_STALE/);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe(headBefore);
  });

  test('blocks a mixed selected-path commit before Git mutation when it contains paths outside the reviewed Work candidate', () => {
    const fx = fixture();
    approveCurrentDirectEditCandidate(fx);
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    writeFileSync(join(fx.repoRoot, 'README.md'), '# unrelated mixed change\n');
    expect(() => commitSelectedPaths(fx.controllerHome, fx.repository, {
      paths: ['src/example.ts', 'README.md'],
      message: 'must not mix reviewed Work with unrelated path',
      beforeCommitGuard: ({ stagedPaths, currentHead }) => {
        prepareReviewedDirectEditWorkCommit({ controllerHome: fx.controllerHome, repository: fx.repository, stagedPaths, currentHead });
      },
    })).toThrow('DIRECT_EDIT_WORK_COMMIT_SCOPE_MISMATCH: commit must materialize the complete reviewed Work path set with no mixed paths');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe(headBefore);
  });

  test('retires postcommit completion authority so new Direct Edit delivery cannot bypass precommit implementation review', () => {
    const fx = fixture();
    commitExample(fx.repoRoot);

    const reconciliation = reconcileFinalizedDirectEditWorksAfterCommit({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      committedPaths: ['src/example.ts'],
      fallbackBranch: 'main',
    });

    expect(reconciliation.completedWorkIds).toEqual([]);
    expect(reconciliation.skipped).toContainEqual({
      sessionId: fx.sessionId,
      workId: fx.workId,
      reason: 'postcommit_completion_authority_retired_use_precommit_review_gate_or_explicit_historical_reconciliation',
    });
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId);
    expect(work?.status).toBe('running');
    expect(work?.completionReceipt).toBeUndefined();
  });

  test('closes historically delivered Work even when Requirement completion projection is unavailable', () => {
    const fx = fixture('REQ-direct-edit-missing-record');
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    const result = acceptReviewedDirectEditWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      workId: fx.workId,
      targetBranch: 'main',
      targetRevision,
      comparedPaths: ['src/example.ts'],
      reviewer: 'reviewer-test',
      rationale: 'The exact owned path tree is already integrated at the accepted target revision.',
      cleanupOwnershipProof: 'This current-checkout Work owns no managed branch or worktree cleanup.',
    });

    expect(result.reconciliation).toMatchObject({ method: 'owned_path_tree', outcome: 'accepted_equivalence', comparedPaths: ['src/example.ts'] });
    expect(result.receipt).toMatchObject({ source: 'direct_edit_work', reconciliationId: result.reconciliation.reconciliationId, targetRevision });
    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId);
    expect(completed).toMatchObject({ status: 'completed', completionOutcome: 'completed_changed' });
    expect(completed?.evidenceRefs.some((evidence) => evidence.title === 'requirement completion projection pending' && (evidence.summary ?? '').includes('REQUIREMENT_NOT_FOUND'))).toBe(true);
  });

  test('narrowly reconciles an already-delivered effect Work only with exact validation, remote containment, and a clean source tree', () => {
    const fx = fixture();
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['remote', 'add', 'origin', '.'], { cwd: fx.repoRoot });
    execFileSync('git', ['config', 'branch.main.remote', 'origin'], { cwd: fx.repoRoot });
    execFileSync('git', ['config', 'branch.main.merge', 'refs/heads/main'], { cwd: fx.repoRoot });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', baseRevision], { cwd: fx.repoRoot });
    const checks = ['package:check:release-published'];
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      workKind: 'remote_effect',
      checks,
      checkRefs: [verificationRecord({
        repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId,
        checkId: checks[0]!, requestedChecks: checks, sourceRevision: targetRevision,
        workspaceFingerprint: 'workspace-release', receiptId: 'release-published',
        commandId: 'release-published-command', recordedAt: '2026-08-30T01:00:00.000Z',
      })],
    });

    expect(() => acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision)))
      .toThrow('DIRECT_EDIT_WORK_RECONCILIATION_REMOTE_CONTAINMENT_REQUIRED');

    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', targetRevision], { cwd: fx.repoRoot });
    const result = acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision));
    expect(result.receipt).toMatchObject({ source: 'direct_edit_work', targetRevision, changedPaths: ['src/example.ts'] });
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)).toMatchObject({
      status: 'completed', workKind: 'repository_change', completionOutcome: 'completed_changed',
    });
  });

  test('refuses historical effect reconciliation without bound validation receipts or while any source delta remains unresolved', () => {
    const fx = fixture();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, { workKind: 'remote_effect' });
    expect(() => acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision)))
      .toThrow('DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_REQUIRED');

    const checks = ['package:check:release-published'];
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks,
      checkRefs: [verificationRecord({
        repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId,
        checkId: checks[0]!, requestedChecks: checks, sourceRevision: targetRevision,
        workspaceFingerprint: 'workspace-release', receiptId: 'release-published-cleanliness',
        commandId: 'release-published-cleanliness-command', recordedAt: '2026-08-30T01:00:00.000Z',
      })],
    });
    writeFileSync(join(fx.repoRoot, 'unresolved.txt'), 'unresolved\n');
    expect(() => acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision)))
      .toThrow('DIRECT_EDIT_WORK_RECONCILIATION_EFFECT_SOURCE_DELTA_UNRESOLVED');
  });

  test('selects exact historical verification receipts even when newer same-check receipts exist', () => {
    const fx = fixture();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\nlater main change\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'later main'], { cwd: fx.repoRoot });
    const laterRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const checks = ['package:check:type', 'package:check:task'];
    const historicalWorkspace = 'workspace-historical';
    const laterWorkspace = 'workspace-later';
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks,
      checkRefs: [
        verificationRecord({ repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId, checkId: checks[1]!, requestedChecks: checks, sourceRevision: laterRevision, workspaceFingerprint: laterWorkspace, receiptId: 'later-task', commandId: 'later-task-command', recordedAt: '2026-08-25T02:00:00.000Z' }),
        verificationRecord({ repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId, checkId: checks[0]!, requestedChecks: checks, sourceRevision: laterRevision, workspaceFingerprint: laterWorkspace, receiptId: 'later-type', commandId: 'later-type-command', recordedAt: '2026-08-25T01:59:00.000Z' }),
        verificationRecord({ repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId, checkId: checks[1]!, requestedChecks: checks, sourceRevision: targetRevision, workspaceFingerprint: historicalWorkspace, receiptId: 'historical-task', commandId: 'historical-task-command', recordedAt: '2026-08-25T01:01:00.000Z' }),
        verificationRecord({ repoId: fx.repoId, checkoutId: fx.checkoutId, workId: fx.workId, checkId: checks[0]!, requestedChecks: checks, sourceRevision: targetRevision, workspaceFingerprint: historicalWorkspace, receiptId: 'historical-type', commandId: 'historical-type-command', recordedAt: '2026-08-25T01:00:00.000Z' }),
      ],
    });

    const result = acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision));

    expect(result.receipt.targetRevision).toBe(targetRevision);
    expect(result.receipt.verifiedAt).toBe('2026-08-25T01:01:00.000Z');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.status).toBe('completed');
  });

  test('rejects historical verification evidence from the wrong revision or a failed/superseded result', () => {
    for (const variant of ['wrong_revision', 'valid_fail', 'superseded'] as const) {
      const fx = fixture();
      commitExample(fx.repoRoot);
      const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
      const checks = ['package:check:type'];
      const baseRevision = execFileSync('git', ['rev-parse', `${targetRevision}^`], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
      updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
        checks,
        checkRefs: [verificationRecord({
          repoId: fx.repoId,
          checkoutId: fx.checkoutId,
          workId: fx.workId,
          checkId: checks[0]!,
          requestedChecks: checks,
          sourceRevision: variant === 'wrong_revision' ? baseRevision : targetRevision,
          workspaceFingerprint: 'workspace-historical',
          receiptId: `receipt-${variant}`,
          commandId: `command-${variant}`,
          recordedAt: '2026-08-25T01:00:00.000Z',
          outcome: variant === 'wrong_revision' ? 'valid_pass' : variant,
        })],
      });

      expect(() => acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision)))
        .toThrow('DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_STALE');
    }
  });

  test('rejects historical evidence when persisted verification or command identity no longer matches', () => {
    for (const variant of ['verification', 'command'] as const) {
      const fx = fixture();
      commitExample(fx.repoRoot);
      const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
      const checks = ['package:check:type'];
      updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
        checks,
        checkRefs: [verificationRecord({
          repoId: fx.repoId,
          checkoutId: fx.checkoutId,
          workId: fx.workId,
          checkId: checks[0]!,
          requestedChecks: checks,
          sourceRevision: targetRevision,
          workspaceFingerprint: 'workspace-historical',
          receiptId: `receipt-${variant}`,
          commandId: `command-${variant}`,
          recordedAt: '2026-08-25T01:00:00.000Z',
          ...(variant === 'verification' ? { verificationInputFingerprintOverride: 'changed-verification-inputs' } : { commandFingerprintOverride: 'changed-command-identity' }),
        })],
      });

      expect(() => acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision)))
        .toThrow('DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_STALE');
    }
  });

  test('rejects ambiguous distinct valid historical receipts for the same check and revision', () => {
    const fx = fixture();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const checks = ['package:check:type'];
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks,
      checkRefs: ['first', 'second'].map((suffix) => verificationRecord({
        repoId: fx.repoId,
        checkoutId: fx.checkoutId,
        workId: fx.workId,
        checkId: checks[0]!,
        requestedChecks: checks,
        sourceRevision: targetRevision,
        workspaceFingerprint: 'workspace-historical',
        receiptId: `receipt-${suffix}`,
        commandId: `command-${suffix}`,
        recordedAt: '2026-08-25T01:00:00.000Z',
      })),
    });

    expect(() => acceptReviewedDirectEditWorkReconciliation(reconciliationInput(fx, targetRevision)))
      .toThrow('DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_AMBIGUOUS');
  });

  test('rejects reviewed reconciliation unless the supplied path set is exact', () => {
    const fx = fixture();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    expect(() => acceptReviewedDirectEditWorkReconciliation({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      workId: fx.workId,
      targetBranch: 'main',
      targetRevision,
      comparedPaths: ['src/other.ts'],
      reviewer: 'reviewer-test',
      rationale: 'Invalid incomplete review set.',
      cleanupOwnershipProof: 'No managed cleanup remains.',
    })).toThrow('DIRECT_EDIT_WORK_RECONCILIATION_PATH_COMPARISON_MISMATCH');
  });

  test('does not complete a finalized edit whose paths escape the durable Work scope', () => {
    const fx = fixture();
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      allowedPaths: ['docs/**'],
    });
    commitExample(fx.repoRoot);

    const reconciliation = reconcileFinalizedDirectEditWorksAfterCommit({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      committedPaths: ['src/example.ts'],
      fallbackBranch: 'main',
    });

    expect(reconciliation.completedWorkIds).toEqual([]);
    expect(reconciliation.skipped).toContainEqual({
      sessionId: fx.sessionId,
      workId: fx.workId,
      reason: 'postcommit_completion_authority_retired_use_precommit_review_gate_or_explicit_historical_reconciliation',
    });
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.status).toBe('running');
  });

  test('does not complete Work when the committed content no longer matches the finalized edit', () => {
    const fx = fixture();
    commitExample(fx.repoRoot, 'export const value = 2;\n');

    const reconciliation = reconcileFinalizedDirectEditWorksAfterCommit({
      controllerHome: fx.controllerHome,
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      repoRoot: fx.repoRoot,
      committedPaths: ['src/example.ts'],
      fallbackBranch: 'main',
    });

    expect(reconciliation.completedWorkIds).toEqual([]);
    expect(reconciliation.skipped[0]?.reason).toBe('postcommit_completion_authority_retired_use_precommit_review_gate_or_explicit_historical_reconciliation');
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.status).toBe('running');
  });
});
