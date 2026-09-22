import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyEditOperations, beginEditSession, finalizeEditSession } from '../../src/cli/editing/edit-session';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { registerRepository } from '../../src/cli/repositories/registry';
import { ensureRepositoryRuntimeStorageBinding } from '../../src/cli/repositories/runtime-storage';
import { commitSelectedPaths } from '../../src/cli/repositories/selected-path-actions';
import { repositoryGitStatus } from '../../src/cli/repositories/structured-git';
import { acceptReviewedDirectEditWorkReconciliation, completeReviewedDirectEditWorkAfterCommit, hasReviewedDirectEditReconciliationOwnership, isFailedReviewedDirectEditWorkRecovery, prepareReviewedDirectEditWorkCommit, reconcileFinalizedDirectEditWorksAfterCommit, type ReviewedDirectEditWorkCommitPlan } from '../../src/runtime/control-plane/execution/direct-edit-work-completion';
import { implementationReviewContentFingerprint } from '../../src/runtime/control-plane/execution/implementation-review-content';
import { implementationReviewCommittedBaseRevision } from '../../src/runtime/control-plane/execution/work-finalization-service';
import { createWorkContract, getWorkContract, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../src/runtime/control-plane/facade/work-implementation-review';
import { acceptPlanStepEvidence, approvePlanContract, claimPlanStepForWork, createPlanContract, getPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import type { VerificationRecord } from '../../src/runtime/control-plane/facade/types';
import { writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { commandFingerprint, verificationInputFingerprint, workspaceValidationFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';


const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(requirementId?: string, workKind: 'repository_change' | 'remote_effect' = 'repository_change') {
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
  ensureRepositoryRuntimeStorageBinding(repository, 'edit-sessions', controllerHome);
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
    workKind,
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

  test('projects a Plan-bound Direct Edit delivery to semantic validation without auto-accepting the Plan step', () => {
    const fx = fixture();
    const planId = 'plan-direct-edit-delivery';
    const stepId = 'direct-step';
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const planStore = { controllerHome: fx.controllerHome, repoId: fx.repoId };
    createPlanContract(planStore, {
      planId,
      repoId: fx.repoId,
      scopeKey: 'direct-edit-plan-delivery',
      sourceRevision,
      goal: 'Deliver one Plan step through Direct Edit Work completion.',
      steps: [{
        id: stepId,
        objective: 'Commit the reviewed direct edit.',
        dependencies: [],
        authoritativeFiles: ['src/example.ts'],
        allowedPaths: ['src/**'],
        forbiddenPaths: [],
        checks: ['package:check:type'],
        acceptanceCriteria: ['Machine delivery reaches semantic validation before Controller acceptance.'],
      }],
    });
    approvePlanContract(planStore, planId);
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      planId,
      planStepId: stepId,
      planSourceRevision: sourceRevision,
    });
    claimPlanStepForWork(planStore, { planId, stepId, workId: fx.workId, sourceRevision });
    expect(getPlanContract(planStore, planId)?.steps[0]).toMatchObject({ status: 'executing', workId: fx.workId });

    approveCurrentDirectEditCandidate(fx);
    let commitPlan: ReviewedDirectEditWorkCommitPlan | undefined;
    const committed = commitSelectedPaths(fx.controllerHome, fx.repository, {
      paths: ['src/example.ts'],
      message: 'reviewed plan-bound direct edit',
      beforeCommitGuard: ({ stagedPaths, currentHead }) => {
        commitPlan = prepareReviewedDirectEditWorkCommit({
          controllerHome: fx.controllerHome,
          repository: fx.repository,
          stagedPaths,
          currentHead,
        });
      },
    });
    expect(committed.commit?.ok).toBe(true);
    completeReviewedDirectEditWorkAfterCommit({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      plan: commitPlan!,
      fallbackBranch: 'main',
    });

    const validating = getPlanContract(planStore, planId)!;
    expect(validating.status).toBe('verifying');
    expect(validating.steps[0]).toMatchObject({ status: 'validating', workId: fx.workId });
    const accepted = acceptPlanStepEvidence(planStore, {
      planId,
      stepId,
      reviewer: 'controller-test',
      rationale: 'The reviewed Direct Edit delivery satisfies the Plan step acceptance criteria.',
      acceptedSourceRevision: committed.commit?.after?.head ?? undefined,
    });
    expect(accepted.status).toBe('finalized');
    expect(accepted.steps[0]).toMatchObject({ status: 'completed', workId: fx.workId });
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
        failureCode: 'WORK_HANDLE_HEAD_CHANGED',
        lastError: 'diagnostic text may change without changing recovery authority',
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
    expect(isFailedReviewedDirectEditWorkRecovery(failedWork, {
      ...handle,
      finalization: {
        ...handle.finalization,
        failureCode: undefined,
        lastError: 'WORK_HANDLE_HEAD_CHANGED: misleading diagnostic only',
      },
    })).toBe(false);
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

  test('repairs stale pre-mutation Direct ownership from the exact reviewed commit without absorbing target-only history', () => {
    const fx = fixture();
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\ntarget-only advance\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'target-only advance'], { cwd: fx.repoRoot });
    const candidateParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    const ownedPaths = ['src/example.ts', ...Array.from({ length: 8 }, (_, index) => `src/owned-${index + 2}.ts`)];
    for (const [index, path] of ownedPaths.slice(1).entries()) {
      writeFileSync(join(fx.repoRoot, path), `export const owned${index + 2} = true;\n`);
    }
    execFileSync('git', ['add', '--', ...ownedPaths], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'exact work commit'], { cwd: fx.repoRoot });
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['remote', 'add', 'origin', '.'], { cwd: fx.repoRoot });
    execFileSync('git', ['config', 'branch.main.remote', 'origin'], { cwd: fx.repoRoot });
    execFileSync('git', ['config', 'branch.main.merge', 'refs/heads/main'], { cwd: fx.repoRoot });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', candidateParent], { cwd: fx.repoRoot });

    const checkId = 'package:check:type';
    const status = repositoryGitStatus(fx.repository);
    const verificationWorkspaceFingerprint = workspaceValidationFingerprint(fx.repoRoot, status);
    const checkRef = verificationRecord({
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      workId: fx.workId,
      checkId,
      requestedChecks: [checkId],
      sourceRevision: targetRevision,
      workspaceFingerprint: verificationWorkspaceFingerprint,
      receiptId: 'receipt-stale-pre-mutation-ownership',
      commandId: 'command-stale-pre-mutation-ownership',
      recordedAt: '2026-09-05T00:00:00.000Z',
    });
    const pollutedReviewPaths = ['README.md', ...ownedPaths];
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks: [checkId],
      checkRefs: [checkRef],
    });
    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      phase: 'verification',
      status: 'running',
      state: 'satisfied',
      summary: 'Exact historical check receipt is current at the candidate revision.',
    });
    requestWorkImplementationReview(
      { controllerHome: fx.controllerHome, repoId: fx.repoId },
      fx.workId,
      'Historical exact candidate is ready for ownership-repair review.',
    );
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      schemaVersion: 1,
      reviewId: 'REV-stale-pre-mutation-ownership',
      workId: fx.workId,
      reviewerPrincipalId: 'principal-reviewer',
      decision: 'approved',
      rationale: 'Historical review was source-bound but its changed-path attribution included target-only history.',
      findings: [],
      sourceRevision: targetRevision,
      workspaceFingerprint: implementationReviewContentFingerprint(fx.repoRoot, pollutedReviewPaths),
      verificationWorkspaceFingerprint,
      changedPaths: pollutedReviewPaths,
      changedPathDigest: implementationReviewChangedPathDigest(pollutedReviewPaths),
      acceptanceCriteriaSummary: 'Exact historical candidate reviewed.',
      verificationEvidence: [{ evidenceId: checkRef.receipt!.receiptId, digest: checkRef.receipt!.resultDigest }],
      architectureEvidence: [],
      recordedAt: '2026-09-05T00:01:00.000Z',
    });
    const now = new Date().toISOString();
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId: fx.workId,
      workContractId: fx.workId,
      sessionId: 'historical-session',
      principalId: 'principal-test',
      repositoryId: fx.repoId,
      checkoutId: fx.checkoutId,
      worktreePath: fx.repoRoot,
      branch: 'main',
      deliveryTargetBranch: 'main',
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: baseRevision,
      managedWorktree: false,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    });

    expect(execFileSync('git', ['rev-parse', `${targetRevision}^`], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe(candidateParent);
    const result = acceptReviewedDirectEditWorkReconciliation({
      ...reconciliationInput(fx, targetRevision),
      comparedPaths: ownedPaths,
      rationale: 'Exact reviewed candidate commit is already integrated; stale pre-mutation WorkHandle ownership incorrectly retained the earlier base.',
    });

    expect(result.receipt.changedPaths).toEqual([...ownedPaths].sort((left, right) => left.localeCompare(right)));
    expect(result.receipt.changedPaths).toHaveLength(9);
    expect(result.receipt.changedPaths).not.toContain('README.md');
    expect(result.receipt.targetRevision).toBe(targetRevision);
    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    expect(completed.status).toBe('completed');
    expect(completed.scopeEvidence?.actualChangedPaths).toEqual([...ownedPaths].sort((left, right) => left.localeCompare(right)));
  });

  test('reconciles an exact content-equivalent Direct commit from an advanced durable baseline without absorbing later target-only history', () => {
    const fx = fixture();
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    const originalBase = work.baseRevision!;

    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\npre-mutation target advance\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'pre-mutation target advance'], { cwd: fx.repoRoot });
    const deliveryBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    expect(deliveryBase).not.toBe(originalBase);

    const reviewedPaths = ['src/example.ts'];
    const preCommitStatus = repositoryGitStatus(fx.repository);
    const preCommitContentFingerprint = implementationReviewContentFingerprint(fx.repoRoot, reviewedPaths);
    const preCommitVerificationFingerprint = workspaceValidationFingerprint(fx.repoRoot, preCommitStatus);
    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      phase: 'verification', status: 'running', state: 'satisfied',
      summary: 'The exact dirty workspace is ready for pre-commit review.',
    });
    requestWorkImplementationReview(
      { controllerHome: fx.controllerHome, repoId: fx.repoId },
      fx.workId,
      'Review the exact content before it is materialized as a commit.',
    );
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      schemaVersion: 1,
      reviewId: 'REV-advanced-durable-baseline-precommit',
      workId: fx.workId,
      reviewerPrincipalId: 'principal-reviewer',
      decision: 'approved',
      rationale: 'The exact pre-commit content is approved at the durable pre-mutation baseline.',
      findings: [],
      sourceRevision: deliveryBase,
      workspaceFingerprint: preCommitContentFingerprint,
      verificationWorkspaceFingerprint: preCommitVerificationFingerprint,
      changedPaths: reviewedPaths,
      changedPathDigest: implementationReviewChangedPathDigest(reviewedPaths),
      acceptanceCriteriaSummary: 'Exact content-equivalent materialization is approved.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt: '2026-09-08T00:00:00.000Z',
    });
    const now = new Date().toISOString();
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId: fx.workId,
      workContractId: fx.workId,
      sessionId: 'advanced-baseline-session',
      principalId: 'principal-test',
      repositoryId: fx.repoId,
      checkoutId: fx.checkoutId,
      worktreePath: fx.repoRoot,
      branch: 'main',
      deliveryTargetBranch: 'main',
      baseCommit: originalBase,
      deliveryBaseCommit: deliveryBase,
      expectedHead: deliveryBase,
      managedWorktree: false,
      permissionSnapshotVersion: 1,
      state: 'editing',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    });

    execFileSync('git', ['add', '--', 'src/example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'materialize exact reviewed content'], { cwd: fx.repoRoot });
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    expect(execFileSync('git', ['diff', '--name-only', deliveryBase, targetRevision], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe('src/example.ts');

    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\npre-mutation target advance\nlater unrelated target history\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'later unrelated target history'], { cwd: fx.repoRoot });
    const currentTargetHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    expect(currentTargetHead).not.toBe(targetRevision);

    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      phase: 'verification', status: 'running', state: 'satisfied',
      summary: 'Later target history invalidated the current target-relative review projection.',
    });
    requestWorkImplementationReview(
      { controllerHome: fx.controllerHome, repoId: fx.repoId },
      fx.workId,
      'Record the later target-relative review as blocked without erasing the exact prior approval.',
    );
    const currentStatus = repositoryGitStatus(fx.repository);
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      schemaVersion: 1,
      reviewId: 'REV-later-target-projection-blocked',
      workId: fx.workId,
      reviewerPrincipalId: 'principal-reviewer',
      decision: 'blocked',
      rationale: 'The current target has later unrelated history; recover only the explicit reviewed commit.',
      findings: [],
      sourceRevision: currentTargetHead,
      workspaceFingerprint: implementationReviewContentFingerprint(fx.repoRoot, reviewedPaths),
      verificationWorkspaceFingerprint: workspaceValidationFingerprint(fx.repoRoot, currentStatus),
      changedPaths: reviewedPaths,
      changedPathDigest: implementationReviewChangedPathDigest(reviewedPaths),
      acceptanceCriteriaSummary: 'Do not absorb later target-only history.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt: '2026-09-08T00:01:00.000Z',
    });

    const result = acceptReviewedDirectEditWorkReconciliation({
      ...reconciliationInput(fx, targetRevision),
      comparedPaths: reviewedPaths,
      rationale: 'The explicit target revision exactly materializes the approved pre-commit content from the durable delivery baseline.',
    });
    expect(result.receipt.targetRevision).toBe(targetRevision);
    expect(result.receipt.changedPaths).toEqual(reviewedPaths);
    expect(result.reconciliation.observedTargetRevision).toBe(targetRevision);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim()).toBe(currentTargetHead);
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.status).toBe('completed');
  });

  test('rejects advanced-baseline recovery when later target history changes reviewed content', () => {
    const fx = fixture();
    const work = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)!;
    const originalBase = work.baseRevision!;

    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\npre-mutation target advance\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'pre-mutation target advance'], { cwd: fx.repoRoot });
    const deliveryBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const reviewedPaths = ['src/example.ts'];
    const preCommitStatus = repositoryGitStatus(fx.repository);
    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      phase: 'verification', status: 'running', state: 'satisfied', summary: 'Pre-commit review boundary.',
    });
    requestWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, 'Review exact pre-commit bytes.');
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      schemaVersion: 1,
      reviewId: 'REV-advanced-baseline-content-drift',
      workId: fx.workId,
      reviewerPrincipalId: 'principal-reviewer',
      decision: 'approved',
      rationale: 'Approve only the original exact bytes.',
      findings: [],
      sourceRevision: deliveryBase,
      workspaceFingerprint: implementationReviewContentFingerprint(fx.repoRoot, reviewedPaths),
      verificationWorkspaceFingerprint: workspaceValidationFingerprint(fx.repoRoot, preCommitStatus),
      changedPaths: reviewedPaths,
      changedPathDigest: implementationReviewChangedPathDigest(reviewedPaths),
      acceptanceCriteriaSummary: 'Exact bytes only.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt: '2026-09-08T00:02:00.000Z',
    });
    const now = new Date().toISOString();
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1, workId: fx.workId, workContractId: fx.workId,
      sessionId: 'advanced-baseline-drift-session', principalId: 'principal-test',
      repositoryId: fx.repoId, checkoutId: fx.checkoutId, worktreePath: fx.repoRoot,
      branch: 'main', deliveryTargetBranch: 'main', baseCommit: originalBase,
      deliveryBaseCommit: deliveryBase, expectedHead: deliveryBase, managedWorktree: false,
      permissionSnapshotVersion: 1, state: 'editing', createdAt: now, updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    });
    execFileSync('git', ['add', '--', 'src/example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'materialize exact reviewed content'], { cwd: fx.repoRoot });
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    writeFileSync(join(fx.repoRoot, 'src/example.ts'), 'export const value = 999;\n');
    execFileSync('git', ['add', '--', 'src/example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'later reviewed-path drift'], { cwd: fx.repoRoot });

    expect(() => acceptReviewedDirectEditWorkReconciliation({
      ...reconciliationInput(fx, targetRevision),
      comparedPaths: reviewedPaths,
      rationale: 'This must fail because current reviewed bytes no longer match the approved content fingerprint.',
    })).toThrow(/DIRECT_EDIT_WORK_RECONCILIATION_/);
    expect(getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId)?.status).not.toBe('completed');
  });

  test('does not use parent-based ownership repair after Direct mutation lifecycle has started', () => {
    const fx = fixture();
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\ntarget-only advance\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'target-only advance'], { cwd: fx.repoRoot });
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const checkId = 'package:check:type';
    const status = repositoryGitStatus(fx.repository);
    const verificationWorkspaceFingerprint = workspaceValidationFingerprint(fx.repoRoot, status);
    const checkRef = verificationRecord({
      repoId: fx.repoId,
      checkoutId: fx.checkoutId,
      workId: fx.workId,
      checkId,
      requestedChecks: [checkId],
      sourceRevision: targetRevision,
      workspaceFingerprint: verificationWorkspaceFingerprint,
      receiptId: 'receipt-post-mutation-ownership',
      commandId: 'command-post-mutation-ownership',
      recordedAt: '2026-09-05T00:00:00.000Z',
    });
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      checks: [checkId],
      checkRefs: [checkRef],
    });
    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      phase: 'verification',
      status: 'running',
      state: 'satisfied',
      summary: 'Exact historical check receipt is current at the candidate revision.',
    });
    requestWorkImplementationReview(
      { controllerHome: fx.controllerHome, repoId: fx.repoId },
      fx.workId,
      'Historical exact candidate is ready for ownership-repair review.',
    );
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      schemaVersion: 1,
      reviewId: 'REV-post-mutation-ownership',
      workId: fx.workId,
      reviewerPrincipalId: 'principal-reviewer',
      decision: 'approved',
      rationale: 'Source-bound review.',
      findings: [],
      sourceRevision: targetRevision,
      workspaceFingerprint: implementationReviewContentFingerprint(fx.repoRoot, ['README.md', 'src/example.ts']),
      verificationWorkspaceFingerprint,
      changedPaths: ['README.md', 'src/example.ts'],
      changedPathDigest: implementationReviewChangedPathDigest(['README.md', 'src/example.ts']),
      acceptanceCriteriaSummary: 'Exact historical candidate reviewed.',
      verificationEvidence: [{ evidenceId: checkRef.receipt!.receiptId, digest: checkRef.receipt!.resultDigest }],
      architectureEvidence: [],
      recordedAt: '2026-09-05T00:01:00.000Z',
    });
    const now = new Date().toISOString();
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId: fx.workId,
      workContractId: fx.workId,
      sessionId: 'historical-session',
      principalId: 'principal-test',
      repositoryId: fx.repoId,
      checkoutId: fx.checkoutId,
      worktreePath: fx.repoRoot,
      branch: 'main',
      deliveryTargetBranch: 'main',
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: targetRevision,
      managedWorktree: false,
      permissionSnapshotVersion: 1,
      state: 'editing',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    });

    expect(() => acceptReviewedDirectEditWorkReconciliation({
      ...reconciliationInput(fx, targetRevision),
      comparedPaths: ['src/example.ts'],
    })).toThrow('DIRECT_EDIT_WORK_RECONCILIATION_PATH_COMPARISON_MISMATCH');
  });

  test('does not use parent-based ownership repair when the latest approved review is not bound to the target commit', () => {
    const fx = fixture();
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\ntarget-only advance\n');
    execFileSync('git', ['add', '--', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'target-only advance'], { cwd: fx.repoRoot });
    const reviewedRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      phase: 'verification',
      status: 'running',
      state: 'satisfied',
      summary: 'No registered checks are required for this review-identity negative case.',
    });
    requestWorkImplementationReview(
      { controllerHome: fx.controllerHome, repoId: fx.repoId },
      fx.workId,
      'A different historical revision is reviewed.',
    );
    const reviewPaths = ['README.md'];
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      schemaVersion: 1,
      reviewId: 'REV-wrong-target-ownership',
      workId: fx.workId,
      reviewerPrincipalId: 'principal-reviewer',
      decision: 'approved',
      rationale: 'This approved review intentionally identifies the target parent, not the requested target commit.',
      findings: [],
      sourceRevision: reviewedRevision,
      workspaceFingerprint: implementationReviewContentFingerprint(fx.repoRoot, reviewPaths),
      verificationWorkspaceFingerprint: workspaceValidationFingerprint(fx.repoRoot, repositoryGitStatus(fx.repository)),
      changedPaths: reviewPaths,
      changedPathDigest: implementationReviewChangedPathDigest(reviewPaths),
      acceptanceCriteriaSummary: 'Different historical revision reviewed.',
      verificationEvidence: [],
      architectureEvidence: [],
      recordedAt: '2026-09-05T00:01:00.000Z',
    });
    const now = new Date().toISOString();
    writeWorkHandle(fx.controllerHome, {
      schemaVersion: 1,
      workId: fx.workId,
      workContractId: fx.workId,
      sessionId: 'historical-session',
      principalId: 'principal-test',
      repositoryId: fx.repoId,
      checkoutId: fx.checkoutId,
      worktreePath: fx.repoRoot,
      branch: 'main',
      deliveryTargetBranch: 'main',
      baseCommit: baseRevision,
      deliveryBaseCommit: baseRevision,
      expectedHead: baseRevision,
      managedWorktree: false,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    });

    expect(() => acceptReviewedDirectEditWorkReconciliation({
      ...reconciliationInput(fx, targetRevision),
      comparedPaths: ['src/example.ts'],
    })).toThrow('DIRECT_EDIT_WORK_RECONCILIATION_PATH_COMPARISON_MISMATCH');
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

  test('keeps completed Work authoritative when downstream Plan projection is unavailable', () => {
    const fx = fixture();
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
      planId: 'plan-direct-edit-missing-record',
      planStepId: 'missing-step',
      planSourceRevision: sourceRevision,
    });
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    acceptReviewedDirectEditWorkReconciliation({
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

    const completed = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId);
    expect(completed).toMatchObject({ status: 'completed', completionOutcome: 'completed_changed' });
    expect(completed?.evidenceRefs.some((evidence) => evidence.title === 'plan step delivery projection pending'
      && (evidence.summary ?? '').includes('plan contract not found: plan-direct-edit-missing-record'))).toBe(true);
  });

  test('narrowly reconciles an already-delivered effect Work only with exact validation, remote containment, and a clean source tree', () => {
    const fx = fixture(undefined, 'remote_effect');
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['remote', 'add', 'origin', '.'], { cwd: fx.repoRoot });
    execFileSync('git', ['config', 'branch.main.remote', 'origin'], { cwd: fx.repoRoot });
    execFileSync('git', ['config', 'branch.main.merge', 'refs/heads/main'], { cwd: fx.repoRoot });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', baseRevision], { cwd: fx.repoRoot });
    const checks = ['package:check:release-published'];
    updateWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoId }, fx.workId, {
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
    const fx = fixture(undefined, 'remote_effect');
    commitExample(fx.repoRoot);
    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
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


describe('managed implementation-review delivery baseline', () => {
  test('preserves the original delivery base after Forge has merged the exact candidate even when deliveryBaseCommit equals baseCommit', () => {
    const fx = fixture();
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '-qb', 'work/review-equal-base'], { cwd: fx.repoRoot });
    writeFileSync(join(fx.repoRoot, 'src', 'example.ts'), 'export const reviewed = true;\n');
    execFileSync('git', ['add', 'src/example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'reviewed equal-base candidate'], { cwd: fx.repoRoot });
    const candidateHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '-q', 'main'], { cwd: fx.repoRoot });
    execFileSync('git', ['merge', '--ff-only', 'work/review-equal-base'], { cwd: fx.repoRoot });

    const preDeliveryHandle = {
      workId: 'work-review-equal-base', managedWorktree: true, deliveryTargetBranch: 'main',
      baseCommit: baseRevision, deliveryBaseCommit: baseRevision,
    };
    expect(implementationReviewCommittedBaseRevision(
      { canonicalRoot: fx.repoRoot, defaultBranch: 'main' }, preDeliveryHandle, baseRevision, candidateHead, 'main',
    )).toBe(candidateHead);

    const mergedHandle = { ...preDeliveryHandle, state: 'merged' as const };
    expect(implementationReviewCommittedBaseRevision(
      { canonicalRoot: fx.repoRoot, defaultBranch: 'main' }, mergedHandle, baseRevision, candidateHead, 'main',
    )).toBe(baseRevision);
  });

  test('preserves the durable delivery base after the target catches the exact reviewed candidate', () => {
    const fx = fixture();
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    writeFileSync(join(fx.repoRoot, 'README.md'), '# Test\ntarget advance\n');
    execFileSync('git', ['add', 'README.md'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'target advance'], { cwd: fx.repoRoot });
    const deliveryBaseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '-qb', 'work/review-baseline'], { cwd: fx.repoRoot });
    writeFileSync(join(fx.repoRoot, 'src', 'example.ts'), 'export const reviewed = true;\n');
    execFileSync('git', ['add', 'src/example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'reviewed candidate'], { cwd: fx.repoRoot });
    const candidateHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();

    execFileSync('git', ['checkout', '-q', 'main'], { cwd: fx.repoRoot });
    execFileSync('git', ['merge', '--ff-only', 'work/review-baseline'], { cwd: fx.repoRoot });

    const handle = {
      workId: 'work-review-baseline', managedWorktree: true, deliveryTargetBranch: 'main',
      baseCommit: baseRevision, deliveryBaseCommit,
    };
    expect(implementationReviewCommittedBaseRevision(
      { canonicalRoot: fx.repoRoot, defaultBranch: 'main' }, handle, baseRevision, candidateHead, 'main',
    )).toBe(deliveryBaseCommit);

    execFileSync('git', ['checkout', '-q', 'work/review-baseline'], { cwd: fx.repoRoot });
    writeFileSync(join(fx.repoRoot, 'src', 'example.ts'), 'export const reviewed = 2;\n');
    execFileSync('git', ['add', 'src/example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'next candidate'], { cwd: fx.repoRoot });
    const nextCandidateHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    expect(implementationReviewCommittedBaseRevision(
      { canonicalRoot: fx.repoRoot, defaultBranch: 'main' }, handle, baseRevision, nextCandidateHead, 'main',
    )).toBe(candidateHead);
  });
});
