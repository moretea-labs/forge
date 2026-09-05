import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getEditSession, listEditSessions, type EditSession } from '../../../cli/editing/edit-session';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { runProcess } from '../../../effects/process-runner';
import { getWorkContract, recordWorkImplementationReview, updateWorkContract } from '../../../../packages/kernel/work/api/index';
import { completeWorkWithReceipt } from './work-completion-authority';
import { isDirectEditWorkCompletionReceipt, isTerminalWorkContractStatus, type DirectEditWorkCompletionReceipt, type WorkContract, type WorkReconciliationRecord } from '../facade/types';
import { historicalVerificationEvidenceAtRevision, workspaceValidationFingerprint } from './verification-evidence';
import { readWorkHandle, type WorkHandleState } from './work-handle-store';
import { assertWorkPathsWithinScope, findWorkPathScopeViolation } from './work-path-scope';
import { implementationReviewContentFingerprint, implementationReviewIndexFingerprint } from './implementation-review-content';
import { transferWorkVerificationAcrossContentEquivalentCommit } from './work-verification-service';
import {
  assertImplementationReviewPreDeliveryBoundary,
  authoritativeImplementationReviewVerificationEvidence,
  deriveImplementationReviewAcrossCommit,
  latestImplementationReview,
  normalizeImplementationReviewChangedPaths,
  type ImplementationReviewCandidateIdentity,
} from '../../../../packages/kernel/work/api/index';

export interface DirectEditWorkCompletionReconciliation {
  completedWorkIds: string[];
  examinedSessionIds: string[];
  skipped: Array<{ sessionId: string; workId?: string; reason: string }>;
  targetBranch?: string;
  targetRevision?: string;
}

function git(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcess('git', args, { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 4 * 1024 * 1024 });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.error || '' };
}

function changedPaths(session: EditSession): string[] {
  return Array.from(new Set(session.operations.map((operation) => operation.path).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function latestOperations(session: EditSession): Map<string, EditSession['operations'][number]> {
  const latest = new Map<string, EditSession['operations'][number]>();
  for (const operation of session.operations) latest.set(operation.path, operation);
  return latest;
}

function revisionMismatches(repoRoot: string, revision: string, session: EditSession): string[] {
  const mismatches: string[] = [];
  for (const operation of latestOperations(session).values()) {
    const object = `${revision}:${operation.path}`;
    if (operation.type === 'delete') {
      if (git(repoRoot, ['cat-file', '-e', object]).ok) mismatches.push(operation.path);
      continue;
    }
    const content = git(repoRoot, ['show', object]);
    if (!content.ok || !operation.afterSha256 || createHash('sha256').update(content.stdout).digest('hex') !== operation.afterSha256) {
      mismatches.push(operation.path);
    }
  }
  return mismatches;
}

function requestedChecksPassed(session: EditSession): boolean {
  return session.requestedChecks.every((checkId) => session.checkResults.some((result) => result.checkId === checkId && result.ok));
}


function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeImplementationReviewChangedPaths(left);
  const b = normalizeImplementationReviewChangedPaths(right);
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

export interface ReviewedDirectEditWorkCommitPlan {
  workId: string;
  editSessionId: string;
  changedPaths: string[];
  preCommitCandidate: ImplementationReviewCandidateIdentity;
  preCommitContentFingerprint: string;
}

/**
 * Resolve and gate the only Work-bound Direct Edit candidate whose complete
 * reviewed path set is staged. This runs from selected-paths' beforeCommitGuard,
 * after exact index discovery and before the first physical commit side effect.
 */
export function prepareReviewedDirectEditWorkCommit(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  stagedPaths: string[];
  currentHead: string | null;
}): ReviewedDirectEditWorkCommitPlan | undefined {
  const stagedPaths = normalizeImplementationReviewChangedPaths(input.stagedPaths);
  const overlapping = listEditSessions(input.repository.canonicalRoot, 200)
    .map((summary) => getEditSession(input.repository.canonicalRoot, summary.sessionId))
    .filter((session) => session.status === 'finalized' && Boolean(session.workId))
    .filter((session) => changedPaths(session).some((path) => stagedPaths.includes(path)));
  if (overlapping.length === 0) return undefined;
  if (overlapping.length !== 1) {
    throw new Error(`DIRECT_EDIT_WORK_COMMIT_AMBIGUOUS: staged paths overlap ${overlapping.length} finalized Work-bound Edit Sessions`);
  }
  const session = overlapping[0]!;
  const paths = changedPaths(session);
  if (!samePaths(paths, stagedPaths)) {
    throw new Error('DIRECT_EDIT_WORK_COMMIT_SCOPE_MISMATCH: commit must materialize the complete reviewed Work path set with no mixed paths');
  }
  if (session.repoId && session.repoId !== input.repository.repoId) throw new Error('DIRECT_EDIT_WORK_COMMIT_REPOSITORY_MISMATCH');
  if (session.checkoutId && session.checkoutId !== input.repository.activeCheckoutId) throw new Error('DIRECT_EDIT_WORK_COMMIT_CHECKOUT_MISMATCH');
  const workId = session.workId!;
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repository.repoId }, workId);
  if (!work || work.completionReceipt || isTerminalWorkContractStatus(work.status)) throw new Error(`DIRECT_EDIT_WORK_COMMIT_WORK_NOT_ACTIVE: ${workId}`);
  if (work.checkoutId && work.checkoutId !== input.repository.activeCheckoutId) throw new Error('DIRECT_EDIT_WORK_COMMIT_WORK_CHECKOUT_MISMATCH');
  assertWorkPathsWithinScope(work, paths, {
    forbidden: 'DIRECT_EDIT_WORK_COMMIT_FORBIDDEN_PATH',
    outOfScope: 'DIRECT_EDIT_WORK_COMMIT_PATH_OUT_OF_SCOPE',
  });
  const status = repositoryGitStatus(input.repository);
  const sourceRevision = status.head?.trim();
  if (!sourceRevision) throw new Error('DIRECT_EDIT_WORK_COMMIT_SOURCE_REVISION_REQUIRED');
  if (!input.currentHead?.trim() || sourceRevision !== input.currentHead.trim()) {
    throw new Error('DIRECT_EDIT_WORK_COMMIT_SOURCE_REVISION_CHANGED');
  }
  const latestReview = latestImplementationReview(work.implementationReviews);
  if (!latestReview) throw new Error(`WORK_IMPLEMENTATION_REVIEW_REQUIRED: ${workId}`);
  const contentFingerprint = implementationReviewContentFingerprint(input.repository.canonicalRoot, paths);
  const indexFingerprint = implementationReviewIndexFingerprint(input.repository.canonicalRoot, paths);
  if (contentFingerprint !== indexFingerprint) {
    throw new Error('DIRECT_EDIT_WORK_COMMIT_INDEX_CONTENT_MISMATCH: staged index must equal the exact approved review content');
  }
  const verification = authoritativeImplementationReviewVerificationEvidence({
    repoId: input.repository.repoId,
    workId,
    requiredCheckIds: work.checks,
    records: work.checkRefs,
    sourceRevision,
    workspaceFingerprint: latestReview.verificationWorkspaceFingerprint,
  });
  if (verification.missingCheckIds.length > 0) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_VERIFICATION_REQUIRED: ${verification.missingCheckIds.join(', ')}`);
  }
  const candidate: ImplementationReviewCandidateIdentity = {
    sourceRevision,
    workspaceFingerprint: contentFingerprint,
    verificationWorkspaceFingerprint: latestReview.verificationWorkspaceFingerprint,
    changedPaths: paths,
    verificationEvidence: verification.evidence,
    architectureEvidence: latestReview.architectureEvidence,
  };
  assertImplementationReviewPreDeliveryBoundary({
    repoId: input.repository.repoId,
    workId,
    workKind: work.workKind,
    reviews: work.implementationReviews,
    candidate,
    requiredCheckIds: work.checks,
    verificationRecords: work.checkRefs,
  });
  return { workId, editSessionId: session.sessionId, changedPaths: paths, preCommitCandidate: candidate, preCommitContentFingerprint: contentFingerprint };
}

/** Complete the exact pre-gated Direct Edit Work after the physical commit. */
export function completeReviewedDirectEditWorkAfterCommit(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  plan: ReviewedDirectEditWorkCommitPlan;
  fallbackBranch?: string;
}): DirectEditWorkCompletionReconciliation {
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repository.repoId }, input.plan.workId);
  if (!work || work.completionReceipt || isTerminalWorkContractStatus(work.status)) {
    throw new Error(`DIRECT_EDIT_WORK_COMMIT_WORK_NOT_ACTIVE: ${input.plan.workId}`);
  }
  const postStatus = repositoryGitStatus(input.repository);
  const targetRevision = postStatus.head?.trim();
  if (!targetRevision || targetRevision === input.plan.preCommitCandidate.sourceRevision) {
    throw new Error('DIRECT_EDIT_WORK_COMMIT_TARGET_REVISION_REQUIRED');
  }
  const actualCommittedPaths = comparedRevisionPaths(input.repository.canonicalRoot, input.plan.preCommitCandidate.sourceRevision, targetRevision);
  if (!samePaths(actualCommittedPaths, input.plan.changedPaths)) {
    throw new Error('DIRECT_EDIT_WORK_COMMIT_RESULT_SCOPE_MISMATCH');
  }
  const targetBranch = postStatus.branch?.trim() || input.fallbackBranch?.trim();
  if (!targetBranch) throw new Error('DIRECT_EDIT_WORK_COMMIT_TARGET_BRANCH_REQUIRED');
  const postVerificationWorkspaceFingerprint = workspaceValidationFingerprint(input.repository.canonicalRoot, postStatus);
  const transfer = transferWorkVerificationAcrossContentEquivalentCommit({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.plan.workId,
    preCommitSourceRevision: input.plan.preCommitCandidate.sourceRevision,
    preCommitWorkspaceFingerprint: input.plan.preCommitCandidate.verificationWorkspaceFingerprint,
    postCommitSourceRevision: targetRevision,
    postCommitWorkspaceFingerprint: postVerificationWorkspaceFingerprint,
  });
  if (transfer.invalidatedCheckIds.length > 0) {
    throw new Error(`DIRECT_EDIT_WORK_COMMIT_REVALIDATION_REQUIRED: ${transfer.invalidatedCheckIds.join(', ')}`);
  }
  const afterTransfer = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repository.repoId }, input.plan.workId)!;
  const postVerification = authoritativeImplementationReviewVerificationEvidence({
    repoId: input.repository.repoId,
    workId: input.plan.workId,
    requiredCheckIds: afterTransfer.checks,
    records: afterTransfer.checkRefs,
    sourceRevision: targetRevision,
    workspaceFingerprint: postVerificationWorkspaceFingerprint,
  });
  if (postVerification.missingCheckIds.length > 0) {
    throw new Error(`DIRECT_EDIT_WORK_COMMIT_REVALIDATION_REQUIRED: ${postVerification.missingCheckIds.join(', ')}`);
  }
  const postContentFingerprint = implementationReviewContentFingerprint(input.repository.canonicalRoot, input.plan.changedPaths);
  const postCandidate: ImplementationReviewCandidateIdentity = {
    sourceRevision: targetRevision,
    workspaceFingerprint: postContentFingerprint,
    verificationWorkspaceFingerprint: postVerificationWorkspaceFingerprint,
    changedPaths: input.plan.changedPaths,
    verificationEvidence: postVerification.evidence,
    architectureEvidence: input.plan.preCommitCandidate.architectureEvidence ?? [],
  };
  const recordedAt = new Date().toISOString();
  const derivedReview = deriveImplementationReviewAcrossCommit({
    workId: input.plan.workId,
    reviews: afterTransfer.implementationReviews,
    proof: {
      preCommitCandidate: input.plan.preCommitCandidate,
      postCommitCandidate: postCandidate,
      preCommitDirtyPaths: input.plan.changedPaths,
      committedPaths: actualCommittedPaths,
      preCommitContentDigest: input.plan.preCommitContentFingerprint,
      postCommitContentDigest: postContentFingerprint,
      postCommitVerificationAuthority: {
        repoId: input.repository.repoId,
        workId: input.plan.workId,
        requiredCheckIds: afterTransfer.checks,
        records: afterTransfer.checkRefs,
      },
    },
    derivedReviewId: `REV-commit-${createHash('sha256').update(`${input.plan.workId}\0${targetRevision}\0${input.plan.preCommitContentFingerprint}`).digest('hex').slice(0, 20)}`,
    recordedAt,
  });
  recordWorkImplementationReview({ controllerHome: input.controllerHome, repoId: input.repository.repoId }, input.plan.workId, derivedReview);
  const receipt: DirectEditWorkCompletionReceipt = {
    schemaVersion: 1,
    receiptId: `REC-direct-edit-work-${createHash('sha256').update(`${input.repository.repoId}\0${input.plan.workId}\0${input.plan.editSessionId}\0${targetRevision}`).digest('hex').slice(0, 20)}`,
    source: 'direct_edit_work',
    workId: input.plan.workId,
    editSessionId: input.plan.editSessionId,
    targetBranch,
    targetRevision,
    sourceRevision: targetRevision,
    baseRevision: input.plan.preCommitCandidate.sourceRevision,
    changedPaths: input.plan.changedPaths,
    delivery: { kind: 'commit', status: 'integrated', strategy: 'edit_session_commit', reachable: true, recordedAt },
    cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
    verifiedAt: recordedAt,
    recordedAt,
  };
  completeWorkWithReceipt(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.plan.workId,
    receipt,
    'completed_changed',
    'repository_change',
  );
  return {
    completedWorkIds: [input.plan.workId],
    examinedSessionIds: [input.plan.editSessionId],
    skipped: [],
    targetBranch,
    targetRevision,
  };
}

export function reconcileFinalizedDirectEditWorksAfterCommit(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  committedPaths: string[];
  fallbackBranch?: string;
  limit?: number;
}): DirectEditWorkCompletionReconciliation {
  const targetRevisionResult = git(input.repoRoot, ['rev-parse', '--verify', 'HEAD']);
  const targetRevision = targetRevisionResult.ok ? targetRevisionResult.stdout.trim() : undefined;
  const branchResult = git(input.repoRoot, ['branch', '--show-current']);
  const targetBranch = branchResult.ok && branchResult.stdout.trim()
    ? branchResult.stdout.trim()
    : input.fallbackBranch?.trim();
  const committedPathSet = new Set(input.committedPaths);
  const examinedSessionIds: string[] = [];
  const skipped: DirectEditWorkCompletionReconciliation['skipped'] = [];
  for (const summary of listEditSessions(input.repoRoot, input.limit ?? 200)) {
    const session = getEditSession(input.repoRoot, summary.sessionId);
    if (session.status !== 'finalized' || !session.workId) continue;
    if (session.repoId && session.repoId !== input.repoId) continue;
    if (session.checkoutId && session.checkoutId !== input.checkoutId) continue;
    const paths = changedPaths(session);
    if (paths.length === 0 || !paths.some((path) => committedPathSet.has(path))) continue;
    examinedSessionIds.push(session.sessionId);
    skipped.push({
      sessionId: session.sessionId,
      workId: session.workId,
      reason: 'postcommit_completion_authority_retired_use_precommit_review_gate_or_explicit_historical_reconciliation',
    });
  }
  // Historical helper intentionally never completes new Work. New delivery must
  // pass prepareReviewedDirectEditWorkCommit() before commit and
  // completeReviewedDirectEditWorkAfterCommit() afterward. Already-delivered
  // recovery remains explicit through acceptReviewedDirectEditWorkReconciliation,
  // whose completion receipt is cross-bound to a durable reconciliationId.
  return { completedWorkIds: [], examinedSessionIds, skipped, targetBranch, targetRevision };
}

export interface ReviewedDirectEditWorkReconciliationInput {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  workId: string;
  targetBranch: string;
  targetRevision: string;
  comparedPaths: string[];
  reviewer: string;
  rationale: string;
  cleanupOwnershipProof: string;
  reviewedAt?: string;
}

function exactCommit(repoRoot: string, revision: string, label: string): string {
  const result = git(repoRoot, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (!result.ok || !result.stdout.trim()) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_${label}_INVALID`);
  return result.stdout.trim();
}

function assertRemoteContainmentIfApplicable(repoRoot: string, targetBranch: string, targetRevision: string): void {
  const remoteResult = git(repoRoot, ['config', '--get', `branch.${targetBranch}.remote`]);
  const remote = remoteResult.ok ? remoteResult.stdout.trim() : '';
  if (!remote || remote === '.') return;
  const mergeResult = git(repoRoot, ['config', '--get', `branch.${targetBranch}.merge`]);
  const mergeRef = mergeResult.ok ? mergeResult.stdout.trim() : '';
  if (!mergeRef.startsWith('refs/heads/')) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_REMOTE_TRACKING_REQUIRED');
  const remoteRef = `refs/remotes/${remote}/${mergeRef.slice('refs/heads/'.length)}`;
  const remoteRevision = git(repoRoot, ['rev-parse', '--verify', `${remoteRef}^{commit}`]);
  if (!remoteRevision.ok || !remoteRevision.stdout.trim()) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_REMOTE_TRACKING_REQUIRED');
  if (!git(repoRoot, ['merge-base', '--is-ancestor', targetRevision, remoteRevision.stdout.trim()]).ok) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_REMOTE_CONTAINMENT_REQUIRED');
  }
}

function comparedRevisionPaths(repoRoot: string, baseRevision: string, targetRevision: string): string[] {
  const result = git(repoRoot, ['diff', '--name-only', '-z', baseRevision, targetRevision]);
  if (!result.ok) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_CHANGED_PATHS_UNAVAILABLE');
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizedComparedPaths(paths: string[]): string[] {
  const normalized = [...new Set(paths.map((path) => path.trim()))].sort((left, right) => left.localeCompare(right));
  if (normalized.length === 0 || normalized.length > 100 || normalized.some((path) => !path || path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_PATHS_INVALID');
  }
  return normalized;
}

function unresolvedRepositorySourcePaths(repoRoot: string): string[] {
  const tracked = [
    git(repoRoot, ['diff', '--name-only', '-z']),
    git(repoRoot, ['diff', '--cached', '--name-only', '-z']),
  ];
  if (tracked.some((result) => !result.ok)) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_EFFECT_SOURCE_STATUS_UNAVAILABLE');
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!untracked.ok) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_EFFECT_SOURCE_STATUS_UNAVAILABLE');
  return [...new Set([
    ...tracked.flatMap((result) => result.stdout.split('\0').filter(Boolean)),
    ...untracked.stdout.split('\0').filter((path) => path && !path.startsWith('.ai/harness/')),
  ])].sort((left, right) => left.localeCompare(right));
}

export function isFailedReviewedDirectEditWorkRecovery(
  work: WorkContract,
  handle?: WorkHandleState,
): handle is WorkHandleState {
  return work.workKind === 'repository_change'
    && work.status === 'failed'
    && handle?.managedWorktree === false
    && handle.state === 'failed'
    && handle.finalization.validation === 'failed'
    && String(handle.finalization.lastError ?? handle.failureReason ?? '').includes('WORK_HANDLE_HEAD_CHANGED');
}

function isStalePreMutationDirectOwnershipRecovery(
  work: WorkContract,
  handle: WorkHandleState | undefined,
  input: { repoRoot: string; checkoutId: string; targetBranch: string; targetRevision: string },
): handle is WorkHandleState {
  const baseRevision = work.baseRevision?.trim();
  const target = input.targetRevision.trim();
  const targetBranch = input.targetBranch.trim();
  if (
    work.workKind !== 'repository_change'
    || isTerminalWorkContractStatus(work.status)
    || !baseRevision
    || !target
    || !targetBranch
    || !handle
    || handle.managedWorktree
    || handle.state !== 'prepared'
    || handle.repositoryId !== work.repoId
    || handle.checkoutId !== input.checkoutId
    || resolve(handle.worktreePath) !== resolve(input.repoRoot)
    || handle.branch !== targetBranch
    || (handle.deliveryTargetBranch !== undefined && handle.deliveryTargetBranch !== targetBranch)
  ) return false;

  const handleBase = handle.baseCommit?.trim();
  const deliveryBase = (handle.deliveryBaseCommit ?? handle.baseCommit)?.trim();
  const expectedHead = handle.expectedHead?.trim();
  if (!handleBase || handleBase !== baseRevision || deliveryBase !== baseRevision || expectedHead !== baseRevision) return false;

  const review = latestImplementationReview(work.implementationReviews);
  return review?.decision === 'approved' && review.sourceRevision.trim() === target;
}

export function hasReviewedDirectEditReconciliationOwnership(input: {
  work: WorkContract;
  handle?: WorkHandleState;
  activeOwnerPrincipal?: string;
  callerPrincipal: string;
}): boolean {
  const callerPrincipal = input.callerPrincipal.trim();
  if (!callerPrincipal) return false;
  const activeOwnerPrincipal = input.activeOwnerPrincipal?.trim();
  if (activeOwnerPrincipal) return activeOwnerPrincipal === callerPrincipal;
  return isFailedReviewedDirectEditWorkRecovery(input.work, input.handle)
    && input.handle.principalId.trim() === callerPrincipal;
}

/**
 * Explicitly close a historically delivered Direct Edit Work whose original
 * edit-session binding was missed. This is never inferred: the caller must
 * supply the exact accepted revision and the complete reviewed path set.
 */
export function acceptReviewedDirectEditWorkReconciliation(input: ReviewedDirectEditWorkReconciliationInput): {
  workId: string;
  reconciliation: WorkReconciliationRecord;
  receipt: DirectEditWorkCompletionReceipt;
} {
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  if (!work || work.repoId !== input.repoId) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_WORK_NOT_FOUND: ${input.workId}`);
  if (work.checkoutId && work.checkoutId !== input.checkoutId) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CHECKOUT_MISMATCH: ${input.workId}`);
  if (work.completionReceipt) {
    const completionReceipt = work.completionReceipt;
    if (isDirectEditWorkCompletionReceipt(completionReceipt) && completionReceipt.reconciliationId) {
      const existing = work.reconciliations.find((entry) => entry.reconciliationId === completionReceipt.reconciliationId);
      if (existing) return { workId: work.workId, reconciliation: existing, receipt: completionReceipt };
    }
    throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_WORK_TERMINAL: ${input.workId}`);
  }
  const currentHandle = readWorkHandle(input.controllerHome, input.repoId, input.workId);
  const failedReviewedRecovery = isFailedReviewedDirectEditWorkRecovery(work, currentHandle);
  const stalePreMutationOwnershipRecovery = isStalePreMutationDirectOwnershipRecovery(work, currentHandle, {
    repoRoot: input.repoRoot,
    checkoutId: input.checkoutId,
    targetBranch: input.targetBranch,
    targetRevision: input.targetRevision,
  });
  const historicalEffectRecovery = !currentHandle
    && !isTerminalWorkContractStatus(work.status)
    && (work.workKind === 'local_effect' || work.workKind === 'remote_effect');
  if ((isTerminalWorkContractStatus(work.status) && !failedReviewedRecovery)
    || (work.workKind !== 'repository_change' && !historicalEffectRecovery)) {
    throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_WORK_NOT_ELIGIBLE: ${input.workId}`);
  }
  if ((historicalEffectRecovery || stalePreMutationOwnershipRecovery) && work.checks.length === 0) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_REQUIRED');
  }
  if (!work.baseRevision?.trim()) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_BASE_REVISION_MISSING');

  const baseRevision = exactCommit(input.repoRoot, work.baseRevision, 'BASE_REVISION');
  const targetRevision = exactCommit(input.repoRoot, input.targetRevision.trim(), 'TARGET_REVISION');
  const targetBranch = input.targetBranch.trim();
  if (!targetBranch) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_BRANCH_REQUIRED');
  if (!git(input.repoRoot, ['merge-base', '--is-ancestor', baseRevision, targetRevision]).ok) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_NOT_DESCENDANT');
  }
  if (!git(input.repoRoot, ['merge-base', '--is-ancestor', targetRevision, targetBranch]).ok) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_UNREACHABLE');
  }
  // Ordinary historical reconciliation must prove remote containment. The stale
  // pre-mutation ownership repair is different: it repairs an active Direct Work
  // already contained by the current local target branch, matching normal local
  // finalize semantics without turning push state into a second ownership gate.
  if (!stalePreMutationOwnershipRecovery) assertRemoteContainmentIfApplicable(input.repoRoot, targetBranch, targetRevision);

  const comparedPaths = normalizedComparedPaths(input.comparedPaths);
  let comparisonBaseRevision = baseRevision;
  if (failedReviewedRecovery || stalePreMutationOwnershipRecovery) {
    const targetParent = exactCommit(input.repoRoot, `${targetRevision}^`, 'TARGET_PARENT_REVISION');
    if (!git(input.repoRoot, ['merge-base', '--is-ancestor', baseRevision, targetParent]).ok) {
      throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_PARENT_NOT_DESCENDANT');
    }
    comparisonBaseRevision = targetParent;
  }
  const actualPaths = comparedRevisionPaths(input.repoRoot, comparisonBaseRevision, targetRevision);
  if (comparedPaths.length !== actualPaths.length || comparedPaths.some((path, index) => path !== actualPaths[index])) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_PATH_COMPARISON_MISMATCH');
  }
  assertWorkPathsWithinScope(work, comparedPaths, {
    forbidden: 'DIRECT_EDIT_WORK_RECONCILIATION_FORBIDDEN_PATH',
    outOfScope: 'DIRECT_EDIT_WORK_RECONCILIATION_PATH_OUT_OF_SCOPE',
  });
  const dirty = git(input.repoRoot, ['status', '--porcelain=v1', '--', ...comparedPaths]);
  if (!dirty.ok || dirty.stdout.trim()) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_OWNED_PATHS_DIRTY');
  if (historicalEffectRecovery) {
    const separateOwnedWorktree = Boolean(work.worktreeRef?.trim())
      && resolve(work.worktreeRef!) !== resolve(input.repoRoot)
      && existsSync(work.worktreeRef!);
    if (separateOwnedWorktree) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_EFFECT_CLEANUP_REQUIRED');
    if (unresolvedRepositorySourcePaths(input.repoRoot).length > 0) {
      throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_EFFECT_SOURCE_DELTA_UNRESOLVED');
    }
  }

  let verifiedAt = new Date().toISOString();
  for (const checkId of work.checks) {
    const candidates = historicalVerificationEvidenceAtRevision(work.checkRefs, {
      sourceRevision: targetRevision,
      repoId: input.repoId,
      workId: work.workId,
      checkoutId: work.checkoutId,
      checkId,
      requestedChecks: work.checks,
    }).filter((entry) => entry.current && entry.record.outcome === 'valid_pass');
    const distinctReceipts = new Map(candidates.map((entry) => [entry.record.receipt!.receiptId, entry]));
    if (distinctReceipts.size === 0) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_STALE: ${checkId}`);
    if (distinctReceipts.size > 1) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_AMBIGUOUS: ${checkId}`);
    const current = [...distinctReceipts.values()][0]!;
    verifiedAt = current.record.completedAt ?? current.record.recordedAt ?? verifiedAt;
  }

  const reviewer = input.reviewer.trim();
  const rationale = input.rationale.trim();
  const cleanupOwnershipProof = input.cleanupOwnershipProof.trim();
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (!reviewer || !rationale || !cleanupOwnershipProof || Number.isNaN(Date.parse(reviewedAt))) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_REVIEW_METADATA_INVALID');
  }
  const reconciliationId = `RECNC-${createHash('sha256').update([input.repoId, input.workId, baseRevision, targetRevision, comparedPaths.join('\0'), reviewer, reviewedAt].join('\0')).digest('hex').slice(0, 16)}`;
  const reconciliation: WorkReconciliationRecord = {
    schemaVersion: 1,
    reconciliationId,
    originalExpectedRevision: targetRevision,
    observedTargetRevision: targetRevision,
    baseRevision,
    targetBranch,
    reachable: true,
    method: 'owned_path_tree',
    comparedPaths,
    reviewer: reviewer.slice(0, 200),
    reviewedAt,
    unrecoverableStages: ['receipt'],
    cleanupOwnershipProof: cleanupOwnershipProof.slice(0, 2_000),
    rationale: rationale.slice(0, 2_000),
    outcome: 'accepted_equivalence',
  };
  updateWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId, {
    reconciliations: [reconciliation, ...work.reconciliations.filter((entry) => entry.reconciliationId !== reconciliationId)],
  });

  const recordedAt = new Date().toISOString();
  const receipt: DirectEditWorkCompletionReceipt = {
    schemaVersion: 1,
    receiptId: `REC-direct-edit-reconciled-${createHash('sha256').update(`${input.repoId}\0${input.workId}\0${reconciliationId}\0${targetRevision}`).digest('hex').slice(0, 20)}`,
    source: 'direct_edit_work',
    workId: input.workId,
    reconciliationId,
    targetBranch,
    targetRevision,
    sourceRevision: targetRevision,
    baseRevision,
    changedPaths: comparedPaths,
    delivery: { kind: 'commit', status: 'integrated', strategy: 'already_integrated', reachable: true, recordedAt },
    cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
    verifiedAt,
    recordedAt,
  };
  completeWorkWithReceipt(
    { controllerHome: input.controllerHome, repoId: input.repoId },
    input.workId,
    receipt,
    'completed_changed',
    'repository_change',
  );
  return { workId: input.workId, reconciliation, receipt };
}
