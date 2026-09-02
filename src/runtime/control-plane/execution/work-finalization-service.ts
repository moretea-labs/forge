import { listControllerChecks } from '../../../cli/controller/check-runner';
import type { ControllerCheck } from '../../../cli/controller/check-runner';
import type { CompletionReceipt } from '../../../cli/controller/types';
import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { globMatches } from '../../../cli/mcp/paths';
import { withControllerLock } from '../../../cli/repositories/locks';
import { getRepository, selectRepositoryCheckout, setRepositoryCheckoutLifecycle } from '../../../cli/repositories/registry';
import { repositoryGitCommit, repositoryGitDeleteBranch, repositoryGitFinishWorkflow, repositoryGitRebaseOnto, repositoryGitStatus } from '../../../cli/repositories/structured-git';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { hasCurrentWorkValidationAuthority, markWorkValidationPending, projectWorkValidationOutcome } from './work-validation-reconciler';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { withControllerSessionTerminalizationFence } from '../../../../packages/kernel/controller/api/index';
import type { VerificationRecord } from '../facade/types';
import { appendVerificationRecord, appendWorkEvidence, listWorkContracts, recordWorkImplementationReview, transitionWorkContractPhase, updateWorkContract } from '../../../../packages/kernel/work/api/index';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { assertResolvedAuthorization, decideAuthorization } from '../governance/authorization';
import { updateExecutionSession } from './session-store';
import { validateWorkHandle } from './validation';
import { implementationReviewContentFingerprint } from './implementation-review-content';
import { transferWorkVerificationAcrossContentEquivalentCommit } from './work-verification-service';
import {
  assertImplementationReviewPreDeliveryBoundary,
  authoritativeImplementationReviewVerificationEvidence,
  deriveImplementationReviewAcrossCommit,
  latestImplementationReview,
  normalizeImplementationReviewChangedPaths,
  type ImplementationReviewCandidateIdentity,
} from '../../../../packages/kernel/work/api/index';
import { effectiveVerificationEvidence, verificationInputFingerprint, workspaceValidationFingerprint, workValidationInputFingerprint } from './verification-evidence';
import { completeWorkWithReceipt } from './work-completion-authority';
import { adoptWorkHandleSuccessorCandidate, markWorkHandleFailed, readWorkHandle, transitionWorkHandle, workDeliveryBaseRevision, writeWorkHandle } from './work-handle-store';
import type { WorkFinalizationStages, WorkHandleState } from './work-handle-store';
import { findWorkPathScopeViolation } from './work-path-scope';
import type { WorkRemoteDeliveryReceipt } from './work-remote-delivery';
import { pushExactWorkRemoteDelivery } from './work-remote-delivery';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import { basename, resolve } from 'path';
import { assertWorkControllerOwnership, compactHandle, contractFor, gitChangedPaths, gitCommit, gitHead, gitMergeBase, gitRevision, identityFor, reconcileTerminalCleanup, releasePreparedWorkOwnership, requireSession, selectWorkFinalizationTarget, terminalCleanupOutcome, workForSession, workReturnCheckoutId } from './work-execution-support';

function gitIsAncestor(root: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`WORK_TARGET_ADVANCE_ANCESTRY_UNAVAILABLE: ${ancestor} -> ${descendant}`);
  }
  return result.status === 0;
}

export interface WorkTargetAdvanceInspection {
  relation: 'candidate_contains_target' | 'target_contains_candidate' | 'diverged_clean' | 'diverged_conflict';
  candidateHead: string;
  targetHead: string;
  mergeBase: string;
  candidateChangedPaths: string[];
  targetChangedPaths: string[];
  mergedTree?: string;
  detail?: string;
}

export function inspectWorkTargetAdvance(root: string, candidateRevision: string, targetRevision: string): WorkTargetAdvanceInspection {
  const candidateHead = gitCommit(root, candidateRevision, 'TARGET_ADVANCE_CANDIDATE');
  const targetHead = gitCommit(root, targetRevision, 'TARGET_ADVANCE_TARGET');
  if (gitIsAncestor(root, targetHead, candidateHead)) {
    return {
      relation: 'candidate_contains_target', candidateHead, targetHead, mergeBase: targetHead,
      candidateChangedPaths: gitChangedPaths(root, targetHead, candidateHead), targetChangedPaths: [],
    };
  }
  if (gitIsAncestor(root, candidateHead, targetHead)) {
    return {
      relation: 'target_contains_candidate', candidateHead, targetHead, mergeBase: candidateHead,
      candidateChangedPaths: [], targetChangedPaths: gitChangedPaths(root, candidateHead, targetHead),
    };
  }
  const mergeBase = gitMergeBase(root, candidateHead, targetHead);
  const candidateChangedPaths = gitChangedPaths(root, mergeBase, candidateHead);
  const targetChangedPaths = gitChangedPaths(root, mergeBase, targetHead);
  const preflight = spawnSync('git', ['-C', root, 'merge-tree', '--write-tree', candidateHead, targetHead], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 512 * 1024,
  });
  if (preflight.error || (preflight.status !== 0 && preflight.status !== 1)) {
    throw new Error(`WORK_TARGET_ADVANCE_PREFLIGHT_UNAVAILABLE: ${preflight.error?.message ?? preflight.stderr ?? 'merge-tree failed'}`);
  }
  if (preflight.status === 0) {
    const mergedTree = typeof preflight.stdout === 'string' ? preflight.stdout.trim().split(/\s+/)[0] : undefined;
    return {
      relation: 'diverged_clean', candidateHead, targetHead, mergeBase, candidateChangedPaths, targetChangedPaths,
      ...(mergedTree ? { mergedTree } : {}),
    };
  }
  const detail = `${preflight.stdout ?? ''}\n${preflight.stderr ?? ''}`.trim().slice(0, 1_000);
  return { relation: 'diverged_conflict', candidateHead, targetHead, mergeBase, candidateChangedPaths, targetChangedPaths, ...(detail ? { detail } : {}) };
}

export function targetAdvanceLinearMergeCommits(root: string, targetRevision: string, candidateRevision: string): string[] {
  const targetHead = gitCommit(root, targetRevision, 'TARGET_ADVANCE_LINEAR_TARGET');
  const candidateHead = gitCommit(root, candidateRevision, 'TARGET_ADVANCE_LINEAR_CANDIDATE');
  const output = spawnSync('git', ['-C', root, 'rev-list', '--merges', `${targetHead}..${candidateHead}`], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 512 * 1024,
  });
  if (output.status !== 0 || output.error || typeof output.stdout !== 'string') {
    throw new Error('WORK_TARGET_ADVANCE_LINEAR_HISTORY_UNAVAILABLE: could not inspect candidate merge history');
  }
  return output.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizedReadScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

function pathIsWithinReadScope(path: string, scope: string): boolean {
  const normalized = normalizedReadScope(scope);
  return normalized === '.' || path === normalized || path.startsWith(`${normalized}/`);
}

function stableCheckDefinition(check: ControllerCheck | undefined): string | undefined {
  if (!check) return undefined;
  return JSON.stringify({
    id: check.id,
    command: check.command,
    cwd: check.cwd,
    timeoutMs: check.timeoutMs,
    source: check.source,
    effects: check.effects ?? null,
  });
}

export interface TargetAdvanceValidationTransferPlan {
  transferredRecords: VerificationRecord[];
  reusableCheckIds: string[];
  invalidatedCheckIds: string[];
}

export function planTargetAdvanceValidationAuthority(input: {
  checkIds: string[];
  checkRefs: VerificationRecord[];
  checksBefore: ControllerCheck[];
  checksAfter: ControllerCheck[];
  candidateHead: string;
  candidateWorkspaceFingerprint: string;
  integratedHead: string;
  integratedWorkspaceFingerprint: string;
  targetChangedPaths: string[];
  recordedAt?: string;
}): TargetAdvanceValidationTransferPlan {
  const beforeById = new Map(input.checksBefore.map((check) => [check.id, check]));
  const afterById = new Map(input.checksAfter.map((check) => [check.id, check]));
  const transferredRecords: VerificationRecord[] = [];
  const reusableCheckIds: string[] = [];
  const invalidatedCheckIds: string[] = [];
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  for (const checkId of input.checkIds) {
    const before = beforeById.get(checkId);
    const after = afterById.get(checkId);
    const reads = before?.effects?.reads;
    const definitionUnchanged = stableCheckDefinition(before) !== undefined
      && stableCheckDefinition(before) === stableCheckDefinition(after);
    const readsGitHistory = before?.effects?.git !== undefined;
    const targetTouchesReadScope = !reads || reads.length === 0
      || input.targetChangedPaths.some((path) => reads.some((scope) => pathIsWithinReadScope(path, scope)));
    const sourcePass = effectiveVerificationEvidence(input.checkRefs, {
      sourceRevision: input.candidateHead,
      workspaceFingerprint: input.candidateWorkspaceFingerprint,
      checkId,
      requestedChecks: input.checkIds,
    }).find((entry) => entry.current && entry.record.outcome === 'valid_pass' && Boolean(entry.record.receipt))?.record;
    if (!definitionUnchanged || readsGitHistory || targetTouchesReadScope || !sourcePass) {
      invalidatedCheckIds.push(checkId);
      continue;
    }
    const transferred: VerificationRecord = {
      ...sourcePass,
      summary: `Validation authority transferred across target advancement because target-only changes did not intersect check ${checkId} read inputs.`,
      recordedAt,
      sourceRevision: input.integratedHead,
      workspaceFingerprint: input.integratedWorkspaceFingerprint,
      verificationInputFingerprint: verificationInputFingerprint({
        sourceRevision: input.integratedHead,
        workspaceFingerprint: input.integratedWorkspaceFingerprint,
        checkId,
        requestedChecks: input.checkIds,
      }),
      evidenceRef: {
        title: checkId,
        summary: `Reused prior valid receipt after proving target-only path changes do not affect this check's declared inputs.`,
        detailLevel: 'summary',
      },
    };
    transferredRecords.push(transferred);
    reusableCheckIds.push(checkId);
  }
  return { transferredRecords, reusableCheckIds, invalidatedCheckIds };
}

export function targetAdvanceWorkScopeViolation(
  scope: { allowedPaths: string[]; forbiddenPaths: string[] } | undefined,
  changedPaths: string[],
): { kind: 'forbidden' | 'out_of_scope'; path: string } | undefined {
  if (!scope) return undefined;
  const violation = findWorkPathScopeViolation(scope, changedPaths);
  return violation ? { kind: violation.kind, path: violation.path } : undefined;
}

function replaceTargetAdvanceScopeEvidence(
  ctx: McpExecutionContext,
  contract: NonNullable<ReturnType<typeof contractFor>>,
  actualChangedPaths: string[],
): void {
  updateWorkContract({ controllerHome: ctx.controllerHome, repoId: contract.repoId }, contract.workId, {
    scopeEvidence: {
      initialLikelyPaths: contract.scopeEvidence?.initialLikelyPaths ?? contract.allowedPaths,
      inspectedPaths: contract.scopeEvidence?.inspectedPaths ?? [],
      actualChangedPaths: [...new Set(actualChangedPaths)].sort((left, right) => left.localeCompare(right)).slice(0, 500),
      recordedAt: new Date().toISOString(),
    },
  });
}

export interface DirectTargetDeliveryInspection {
  integrated: boolean;
  reason: 'not_direct_target' | 'path_mismatch' | 'branch_mismatch' | 'dirty' | 'revision_unavailable' | 'not_reachable' | 'integrated';
  expectedHead?: string;
  targetHead?: string;
}

/**
 * Direct-edit Work may already be executing on the delivery branch. In that
 * case Git merge is not a delivery operation at all: the Work commit is
 * integrated once its exact expected revision remains reachable from the
 * target branch. Keep this proof deliberately strict so a feature Work or a
 * dirty/mismatched checkout still follows the normal fail-closed merge path.
 */
export function inspectDirectTargetDelivery(
  root: string,
  worktreePath: string,
  managedWorktree: boolean,
  workBranch: string,
  targetBranch: string,
  expectedRevision: string | undefined,
): DirectTargetDeliveryInspection {
  if (managedWorktree || workBranch !== targetBranch) return { integrated: false, reason: 'not_direct_target' };
  try {
    if (realpathSync(root) !== realpathSync(worktreePath)) return { integrated: false, reason: 'path_mismatch' };
  } catch {
    return { integrated: false, reason: 'path_mismatch' };
  }
  const branch = spawnSync('git', ['-C', root, 'branch', '--show-current'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (branch.status !== 0 || typeof branch.stdout !== 'string' || branch.stdout.trim() !== targetBranch) {
    return { integrated: false, reason: 'branch_mismatch' };
  }
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (status.status !== 0 || typeof status.stdout !== 'string' || status.stdout.trim()) {
    return { integrated: false, reason: 'dirty' };
  }
  const expectedHead = expectedRevision ? gitRevision(root, expectedRevision) : undefined;
  const targetHead = gitRevision(root, targetBranch);
  if (!expectedHead || !targetHead) return { integrated: false, reason: 'revision_unavailable' };
  if (!gitIsAncestor(root, expectedHead, targetHead)) {
    return { integrated: false, reason: 'not_reachable', expectedHead, targetHead };
  }
  return { integrated: true, reason: 'integrated', expectedHead, targetHead };
}

function exactCommitChangedPaths(repoRoot: string, revision: string): string[] {
  const result = spawnSync('git', ['-C', repoRoot, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', revision], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error(`WORK_COMPLETION_RECEIPT_COMMIT_PATHS_UNAVAILABLE: ${revision}`);
  }
  return Array.from(new Set(result.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function workOwnedDirtyPaths(
  contract: { allowedPaths: string[]; forbiddenPaths: string[] } | undefined,
  status: ReturnType<typeof repositoryGitStatus>,
): { dirtyPaths: string[]; ownedPaths: string[] } {
  const dirtyPaths = [...new Set([...status.staged, ...status.unstaged, ...status.untracked])]
    .sort((left, right) => left.localeCompare(right));
  if (!contract) return { dirtyPaths, ownedPaths: dirtyPaths };
  const ownedPaths = dirtyPaths.filter((path) => {
    if (contract.forbiddenPaths.some((pattern) => globMatches(pattern, path))) return false;
    return contract.allowedPaths.length === 0 || contract.allowedPaths.some((pattern) => globMatches(pattern, path));
  });
  return { dirtyPaths, ownedPaths };
}


function currentWorkReviewChangedPaths(
  repository: RepositoryRecord,
  handle: WorkHandleState,
  contract: NonNullable<ReturnType<typeof contractFor>>,
): string[] {
  const status = repositoryGitStatus(repository);
  const { dirtyPaths, ownedPaths } = workOwnedDirtyPaths(contract, status);
  if (dirtyPaths.length !== ownedPaths.length) {
    const unowned = dirtyPaths.filter((path) => !ownedPaths.includes(path));
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_UNOWNED_DIRTY_PATH: ${unowned.join(', ')}`);
  }
  const head = status.head?.trim();
  const base = workDeliveryBaseRevision(handle) ?? contract.baseRevision;
  const committedPaths = head && base && head !== base
    ? gitChangedPaths(repository.canonicalRoot, base, head)
    : [];
  const observed = normalizeImplementationReviewChangedPaths([...committedPaths, ...ownedPaths]);
  const scopeViolation = findWorkPathScopeViolation(contract, observed);
  if (scopeViolation) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_SCOPE_VIOLATION: ${scopeViolation.kind}:${scopeViolation.path}`);
  }
  return observed;
}

function assertPhysicalImplementationReviewGate(input: {
  ctx: McpExecutionContext;
  repository: RepositoryRecord;
  handle: WorkHandleState;
  contract: NonNullable<ReturnType<typeof contractFor>>;
  /** Use the exact strict verification identity observed before repository staging. */
  verificationWorkspaceFingerprint?: string;
}): ImplementationReviewCandidateIdentity {
  const status = repositoryGitStatus(input.repository);
  const sourceRevision = status.head?.trim();
  if (!sourceRevision) throw new Error('WORK_IMPLEMENTATION_REVIEW_SOURCE_IDENTITY_REQUIRED');
  const changedPaths = currentWorkReviewChangedPaths(input.repository, input.handle, input.contract);
  const verificationWorkspaceFingerprint = input.verificationWorkspaceFingerprint?.trim()
    || workspaceValidationFingerprint(input.repository.canonicalRoot, status);
  const workspaceFingerprint = implementationReviewContentFingerprint(input.repository.canonicalRoot, changedPaths);
  const verification = authoritativeImplementationReviewVerificationEvidence({
    repoId: input.contract.repoId,
    workId: input.contract.workId,
    requiredCheckIds: input.contract.checks,
    records: input.contract.checkRefs,
    sourceRevision,
    workspaceFingerprint: verificationWorkspaceFingerprint,
  });
  if (verification.missingCheckIds.length > 0) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_VERIFICATION_REQUIRED: ${verification.missingCheckIds.join(', ')}`);
  }
  const candidate: ImplementationReviewCandidateIdentity = {
    sourceRevision,
    workspaceFingerprint,
    verificationWorkspaceFingerprint,
    changedPaths,
    verificationEvidence: verification.evidence,
    architectureEvidence: [],
  };
  assertImplementationReviewPreDeliveryBoundary({
    repoId: input.contract.repoId,
    workId: input.contract.workId,
    workKind: input.contract.workKind,
    reviews: input.contract.implementationReviews,
    candidate,
    requiredCheckIds: input.contract.checks,
    verificationRecords: input.contract.checkRefs,
  });
  return candidate;
}

/**
 * A successful branch-cleanup retry can run after the reviewed worktree has
 * already been removed. In that state filesystem content cannot be re-hashed,
 * but the Work branch commit is immutable. Re-bind the shared review boundary
 * to that exact branch HEAD and recompute current Work-bound verification
 * evidence before deleting the ref. Cancelled/failed cleanup uses separate
 * recovery authority and never calls this successful-delivery gate.
 */
function assertPhysicalBranchCleanupImplementationReviewGate(input: {
  target: RepositoryRecord;
  handle: WorkHandleState;
  contract: NonNullable<ReturnType<typeof contractFor>>;
}): void {
  const branchHead = gitRevision(input.target.canonicalRoot, input.handle.branch);
  if (!branchHead) throw new Error('WORK_IMPLEMENTATION_REVIEW_BRANCH_SOURCE_REQUIRED');
  if (input.handle.expectedHead && branchHead !== input.handle.expectedHead) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_BRANCH_SOURCE_CHANGED');
  }
  const review = latestImplementationReview(input.contract.implementationReviews);
  if (!review) throw new Error('WORK_IMPLEMENTATION_REVIEW_REQUIRED');
  if (review.sourceRevision !== branchHead) throw new Error('WORK_IMPLEMENTATION_REVIEW_STALE: branch source revision changed');
  const verification = authoritativeImplementationReviewVerificationEvidence({
    repoId: input.contract.repoId,
    workId: input.contract.workId,
    requiredCheckIds: input.contract.checks,
    records: input.contract.checkRefs,
    sourceRevision: branchHead,
    workspaceFingerprint: review.verificationWorkspaceFingerprint,
  });
  if (verification.missingCheckIds.length > 0) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_VERIFICATION_REQUIRED: ${verification.missingCheckIds.join(', ')}`);
  }
  assertImplementationReviewPreDeliveryBoundary({
    repoId: input.contract.repoId,
    workId: input.contract.workId,
    workKind: input.contract.workKind,
    reviews: input.contract.implementationReviews,
    candidate: {
      sourceRevision: branchHead,
      workspaceFingerprint: review.workspaceFingerprint,
      verificationWorkspaceFingerprint: review.verificationWorkspaceFingerprint,
      changedPaths: review.changedPaths,
      verificationEvidence: verification.evidence,
      architectureEvidence: review.architectureEvidence,
    },
    requiredCheckIds: input.contract.checks,
    verificationRecords: input.contract.checkRefs,
  });
}

export interface TargetDirtyWorkOwnershipInspection {
  owned: boolean;
  dirtyPaths: string[];
  owners: Record<string, string>;
  unownedPaths: string[];
  ambiguousPaths: string[];
}

/**
 * Positive ownership proof for dirty content preserved in a shared canonical
 * target checkout. Exact observed Work scope wins; a unique explicit allow-list
 * is the fallback. Repository-wide/legacy scope is never enough to move another
 * Work's dirty content through target integration.
 */
export function inspectTargetDirtyWorkOwnership(input: {
  dirtyPaths: string[];
  targetCheckoutId: string;
  currentWorkId: string;
  activeWorks: Array<{
    workId: string;
    checkoutId?: string;
    allowedPaths: string[];
    forbiddenPaths: string[];
    scopeEvidence?: { actualChangedPaths: string[] };
  }>;
}): TargetDirtyWorkOwnershipInspection {
  const dirtyPaths = [...new Set(input.dirtyPaths.map((path) => path.trim()).filter(Boolean))].sort();
  const candidates = input.activeWorks.filter((work) =>
    work.workId !== input.currentWorkId
    && work.checkoutId === input.targetCheckoutId,
  );
  const owners: Record<string, string> = {};
  const unownedPaths: string[] = [];
  const ambiguousPaths: string[] = [];
  for (const path of dirtyPaths) {
    const exactOwners = candidates.filter((work) => work.scopeEvidence?.actualChangedPaths?.includes(path));
    const scopedOwners = exactOwners.length > 0 ? exactOwners : candidates.filter((work) =>
      work.allowedPaths.length > 0
      && !work.forbiddenPaths.some((pattern) => globMatches(pattern, path))
      && work.allowedPaths.some((pattern) => globMatches(pattern, path)),
    );
    const ownerIds = [...new Set(scopedOwners.map((work) => work.workId))].sort();
    if (ownerIds.length === 1) owners[path] = ownerIds[0];
    else if (ownerIds.length === 0) unownedPaths.push(path);
    else ambiguousPaths.push(path);
  }
  return {
    owned: dirtyPaths.length > 0 && unownedPaths.length === 0 && ambiguousPaths.length === 0,
    dirtyPaths,
    owners,
    unownedPaths,
    ambiguousPaths,
  };
}

export interface DirectCanonicalTargetAdvanceInspection {
  reconcilable: boolean;
  reason:
    | 'not_direct_target'
    | 'path_mismatch'
    | 'branch_mismatch'
    | 'revision_unavailable'
    | 'target_not_current'
    | 'not_descendant'
    | 'explicit_scope_required'
    | 'owned_dirty_required'
    | 'unrelated_dirty_paths'
    | 'target_touches_work_path'
    | 'fresh_verification_required'
    | 'fresh_verification_missing'
    | 'reconcilable';
  previousHead?: string;
  targetHead?: string;
  dirtyPaths: string[];
  targetChangedPaths: string[];
  workspaceFingerprint?: string;
  freshCheckIds: string[];
}

/**
 * Direct canonical Work is intentionally stricter than managed-worktree delivery:
 * the shared checkout may contain preserved dirty content owned by another Work.
 * Reconcile a stale expectedHead only when the target advanced linearly, every
 * current dirty path is positively owned by this Work, target-only commits do not
 * touch those dirty paths, and exact current source/workspace verification exists.
 * The caller may then move only delivery identity; this function never attributes
 * target-only commits or unrelated dirty paths to the Work.
 */
export function inspectDirectCanonicalTargetAdvanceReconciliation(input: {
  root: string;
  worktreePath: string;
  managedWorktree: boolean;
  workBranch: string;
  targetBranch: string;
  expectedRevision?: string;
  status: ReturnType<typeof repositoryGitStatus>;
  scope?: { allowedPaths: string[]; forbiddenPaths: string[] };
  checkIds: string[];
  checkRefs: VerificationRecord[];
}): DirectCanonicalTargetAdvanceInspection {
  const empty = (reason: DirectCanonicalTargetAdvanceInspection['reason']): DirectCanonicalTargetAdvanceInspection => ({
    reconcilable: false,
    reason,
    dirtyPaths: [],
    targetChangedPaths: [],
    freshCheckIds: [],
  });
  if (input.managedWorktree || input.workBranch !== input.targetBranch) return empty('not_direct_target');
  try {
    if (realpathSync(input.root) !== realpathSync(input.worktreePath)) return empty('path_mismatch');
  } catch {
    return empty('path_mismatch');
  }
  const branch = spawnSync('git', ['-C', input.root, 'branch', '--show-current'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (branch.status !== 0 || typeof branch.stdout !== 'string' || branch.stdout.trim() !== input.targetBranch) {
    return empty('branch_mismatch');
  }
  const previousHead = input.expectedRevision ? gitRevision(input.root, input.expectedRevision) : undefined;
  const targetHead = gitRevision(input.root, input.targetBranch);
  const currentHead = input.status.head ? gitRevision(input.root, input.status.head) : undefined;
  if (!previousHead || !targetHead || !currentHead) return empty('revision_unavailable');
  const base = {
    previousHead,
    targetHead,
    dirtyPaths: [] as string[],
    targetChangedPaths: [] as string[],
    freshCheckIds: [] as string[],
  };
  if (targetHead !== currentHead) return { ...base, reconcilable: false, reason: 'target_not_current' };
  if (targetHead === previousHead || !gitIsAncestor(input.root, previousHead, targetHead)) {
    return { ...base, reconcilable: false, reason: 'not_descendant' };
  }
  // Positive allow-list ownership is required here. An empty allow-list means
  // repository-wide scope and cannot distinguish another Work's preserved dirty
  // content in a shared canonical checkout.
  if (!input.scope || input.scope.allowedPaths.length === 0) {
    return { ...base, reconcilable: false, reason: 'explicit_scope_required' };
  }
  const { dirtyPaths, ownedPaths } = workOwnedDirtyPaths(input.scope, input.status);
  const dirtyBase = { ...base, dirtyPaths };
  if (dirtyPaths.length === 0 || ownedPaths.length === 0) {
    return { ...dirtyBase, reconcilable: false, reason: 'owned_dirty_required' };
  }
  if (ownedPaths.length !== dirtyPaths.length) {
    return { ...dirtyBase, reconcilable: false, reason: 'unrelated_dirty_paths' };
  }
  const targetChangedPaths = gitChangedPaths(input.root, previousHead, targetHead);
  const targetBase = { ...dirtyBase, targetChangedPaths };
  const dirtySet = new Set(dirtyPaths);
  if (targetChangedPaths.some((path) => dirtySet.has(path))) {
    return { ...targetBase, reconcilable: false, reason: 'target_touches_work_path' };
  }
  const workspaceFingerprint = workspaceValidationFingerprint(input.root, input.status);
  const declaredCheckIds = [...new Set(input.checkIds)].sort((left, right) => left.localeCompare(right));
  const candidateCheckIds = declaredCheckIds.length > 0
    ? declaredCheckIds
    : [...new Set(input.checkRefs.map((record) => record.checkId).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  if (candidateCheckIds.length === 0) {
    return { ...targetBase, workspaceFingerprint, reconcilable: false, reason: 'fresh_verification_required' };
  }
  const freshCheckIds = candidateCheckIds.filter((checkId) => effectiveVerificationEvidence(input.checkRefs, {
    sourceRevision: targetHead,
    workspaceFingerprint,
    checkId,
    // Contract-declared checks share one validation-input identity. When the
    // contract has no declared checks, rh_work verify can still append an
    // explicit focused check receipt; such evidence is bound to its one-check
    // request and must be evaluated with that exact requested-check set.
    requestedChecks: declaredCheckIds.length > 0 ? declaredCheckIds : [checkId],
  }).some((entry) => entry.current
    && entry.record.outcome === 'valid_pass'
    && entry.record.receipt?.ok === true
    && entry.record.receipt.status === 'passed'
    && entry.record.receipt.runtimeStatus === 'succeeded'));
  const freshVerificationSatisfied = declaredCheckIds.length > 0
    ? freshCheckIds.length === declaredCheckIds.length
    : freshCheckIds.length > 0;
  if (!freshVerificationSatisfied) {
    return { ...targetBase, workspaceFingerprint, freshCheckIds, reconcilable: false, reason: 'fresh_verification_missing' };
  }
  return {
    ...targetBase,
    workspaceFingerprint,
    freshCheckIds,
    reconcilable: true,
    reason: 'reconcilable',
  };
}

export interface ManagedWorkSuccessorAdoptionInspection {
  adoptable: boolean;
  reason:
    | 'not_managed_worktree'
    | 'path_mismatch'
    | 'branch_mismatch'
    | 'workspace_dirty'
    | 'revision_unavailable'
    | 'no_head_change'
    | 'descendant_progress'
    | 'target_not_advanced'
    | 'target_history_rewritten'
    | 'target_not_candidate_ancestor'
    | 'non_linear_candidate'
    | 'scope_violation'
    | 'adoptable';
  previousHead?: string;
  previousDeliveryBase?: string;
  candidateHead?: string;
  targetHead?: string;
  candidateChangedPaths: string[];
  detail?: string;
}

/**
 * Inspect a manually conflict-repaired managed Work candidate before changing
 * WorkHandle authority. This is intentionally narrower than ordinary
 * descendant progress: canonical target must have advanced linearly from the
 * recorded delivery base, and the rewritten clean candidate must contain that
 * exact target with only Work-scoped target-relative changes.
 */
export function inspectManagedWorkSuccessorAdoption(input: {
  root: string;
  worktreePath: string;
  managedWorktree: boolean;
  workBranch: string;
  targetBranch: string;
  expectedRevision?: string;
  deliveryBaseRevision?: string;
  status: ReturnType<typeof repositoryGitStatus>;
  scope?: { allowedPaths: string[]; forbiddenPaths: string[] };
}): ManagedWorkSuccessorAdoptionInspection {
  const empty = (reason: ManagedWorkSuccessorAdoptionInspection['reason'], detail?: string): ManagedWorkSuccessorAdoptionInspection => ({
    adoptable: false,
    reason,
    candidateChangedPaths: [],
    ...(detail ? { detail } : {}),
  });
  if (!input.managedWorktree) return empty('not_managed_worktree');
  try {
    if (realpathSync(input.root) !== realpathSync(input.worktreePath)) return empty('path_mismatch');
  } catch {
    return empty('path_mismatch');
  }
  const branch = spawnSync('git', ['-C', input.root, 'branch', '--show-current'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (branch.status !== 0 || String(branch.stdout ?? '').trim() !== input.workBranch) return empty('branch_mismatch');
  if (!input.status.clean) return empty('workspace_dirty');

  const previousHead = input.expectedRevision ? gitRevision(input.root, input.expectedRevision) : undefined;
  const previousDeliveryBase = input.deliveryBaseRevision ? gitRevision(input.root, input.deliveryBaseRevision) : undefined;
  const candidateHead = input.status.head ? gitRevision(input.root, input.status.head) : undefined;
  const targetHead = gitRevision(input.root, input.targetBranch);
  if (!previousHead || !previousDeliveryBase || !candidateHead || !targetHead) return empty('revision_unavailable');
  const base = { previousHead, previousDeliveryBase, candidateHead, targetHead, candidateChangedPaths: [] as string[] };
  if (candidateHead === previousHead) return { ...base, adoptable: false, reason: 'no_head_change' };
  if (gitIsAncestor(input.root, previousHead, candidateHead)) return { ...base, adoptable: false, reason: 'descendant_progress' };
  if (targetHead === previousDeliveryBase) return { ...base, adoptable: false, reason: 'target_not_advanced' };
  if (!gitIsAncestor(input.root, previousDeliveryBase, targetHead)) {
    return { ...base, adoptable: false, reason: 'target_history_rewritten' };
  }
  if (!gitIsAncestor(input.root, targetHead, candidateHead)) {
    return { ...base, adoptable: false, reason: 'target_not_candidate_ancestor' };
  }
  const mergeCommits = targetAdvanceLinearMergeCommits(input.root, targetHead, candidateHead);
  if (mergeCommits.length > 0) {
    return { ...base, adoptable: false, reason: 'non_linear_candidate', detail: mergeCommits.slice(0, 8).join(', ') };
  }
  const candidateChangedPaths = gitChangedPaths(input.root, targetHead, candidateHead);
  if (!input.scope) {
    return { ...base, candidateChangedPaths, adoptable: false, reason: 'scope_violation', detail: 'WorkContract scope unavailable' };
  }
  const scopeViolation = findWorkPathScopeViolation(input.scope, candidateChangedPaths);
  if (scopeViolation) {
    return {
      ...base,
      candidateChangedPaths,
      adoptable: false,
      reason: 'scope_violation',
      detail: `${scopeViolation.kind}:${scopeViolation.path}`,
    };
  }
  return { ...base, candidateChangedPaths, adoptable: true, reason: 'adoptable' };
}

export function completionReceiptChangedPaths(repoRoot: string, baseRevision: string, deliveryRevision: string): string[] {
  const result = spawnSync('git', ['-C', repoRoot, 'diff', '--name-only', `${baseRevision}..${deliveryRevision}`], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error(`WORK_COMPLETION_RECEIPT_CHANGED_PATHS_UNAVAILABLE: ${baseRevision}..${deliveryRevision}`);
  }
  return Array.from(new Set(result.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function completionReceiptForFinalizedWork(
  ctx: McpExecutionContext,
  handle: WorkHandleState,
  contract: ReturnType<typeof contractFor>,
  args: Record<string, unknown>,
): CompletionReceipt {
  const repository = getRepository(handle.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const target = selectWorkFinalizationTarget(repository, handle);
  const targetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : repository.defaultBranch || 'main';
  const targetRevision = gitRevision(target.canonicalRoot, targetBranch);
  if (!targetRevision) throw new Error(`WORK_COMPLETION_RECEIPT_TARGET_REQUIRED: target branch ${targetBranch} is unavailable`);
  const noChange = args.completion_outcome === 'completed_no_change';
  // Delivery authority is always the Work's own revision, never the target
  // branch's newest HEAD. The target may have advanced because of unrelated
  // concurrent Work; targetRevision records integration identity, while
  // deliveryRevision owns path attribution and reachability proof.
  const deliveryRevision = handle.expectedHead ?? handle.baseCommit;
  if (!deliveryRevision) throw new Error('WORK_COMPLETION_RECEIPT_SOURCE_REQUIRED: Work delivery revision is unavailable');
  const reachable = deliveryRevision === targetRevision || spawnSync('git', ['-C', target.canonicalRoot, 'merge-base', '--is-ancestor', deliveryRevision, targetBranch], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }).status === 0;
  if (!reachable) throw new Error(`WORK_COMPLETION_RECEIPT_DELIVERY_NOT_PROVEN: ${deliveryRevision} is not reachable from ${targetBranch}`);
  const deliveryBaseRevision = workDeliveryBaseRevision(handle);
  const changedPaths = noChange
    ? []
    : !handle.managedWorktree && handle.finalization.commit === 'done'
      ? exactCommitChangedPaths(target.canonicalRoot, deliveryRevision)
      : deliveryBaseRevision
        ? completionReceiptChangedPaths(target.canonicalRoot, deliveryBaseRevision, deliveryRevision)
        : (() => { throw new Error('WORK_COMPLETION_RECEIPT_BASE_REQUIRED: Work delivery provenance base is unavailable'); })();
  const recordedAt = new Date().toISOString();
  const retainsExplicitDeliveryBranch = args.merge !== true && targetBranch === handle.branch;
  const warnings = [
    ...(handle.finalization.branchCleanup === 'skipped' && !retainsExplicitDeliveryBranch ? [{ code: 'cleanup_retained_by_request' as const, message: 'Branch cleanup was skipped by the finalization request.', resourceKind: 'branch' as const, resourceId: handle.branch, recordedAt }] : []),
    ...(handle.finalization.worktreeCleanup === 'skipped' && handle.managedWorktree ? [{ code: 'cleanup_retained_by_request' as const, message: 'Managed worktree cleanup was skipped by the finalization request.', resourceKind: 'worktree' as const, resourceId: handle.worktreePath, recordedAt }] : []),
  ];
  return {
    schemaVersion: 1,
    receiptId: `REC-controller_work-${createHash('sha256').update(`${handle.workId}\0${targetRevision}`).digest('hex').slice(0, 16)}`,
    source: 'controller_work',
    issueId: contract?.issueId ?? 'work',
    taskId: contract?.taskId ?? handle.workId,
    workId: handle.workId,
    targetBranch,
    targetRevision,
    sourceRevision: deliveryRevision,
    baseRevision: handle.baseCommit,
    changedPaths,
    delivery: {
      kind: noChange ? 'no_change' : 'commit',
      status: 'integrated',
      strategy: noChange ? 'no_change' : handle.finalization.commit === 'done' ? 'edit_session_commit' : 'already_integrated',
      reachable: true,
      recordedAt,
    },
    cleanup: {
      status: warnings.length > 0 ? 'maintenance_warning' : 'complete',
      warnings,
      blockers: [],
      recordedAt,
    },
    verifiedAt: recordedAt,
    recordedAt,
  };
}

function runCleanup(targetRoot: string, worktreePath: string): { ok: boolean; message?: string } {
  if (targetRoot === worktreePath) return { ok: true };
  if (!existsSync(worktreePath)) return { ok: true, message: 'managed worktree already removed' };
  const status = repositoryGitStatus({ repoId: 'cleanup', activeCheckoutId: 'cleanup', canonicalRoot: worktreePath, localRoot: worktreePath, checkouts: [], schemaVersion: 1, displayName: basename(worktreePath), repositoryType: 'git', enabled: true, createdAt: '', updatedAt: '', lastSeenAt: '', configurationPath: '', stateStorageStrategy: 'controller-home' });
  if (!status.clean) return { ok: false, message: 'managed worktree is dirty; cleanup preserved it' };
  const process = spawnSync('git', ['-C', targetRoot, 'worktree', 'remove', worktreePath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return process.status === 0 ? { ok: true } : { ok: false, message: String(process.stderr ?? 'git worktree remove failed').trim() };
}

/**
 * Reconcile a stale Work Handle only for a cleanup-only request whose exact
 * branch HEAD is already reachable from the requested target branch.
 *
 * Two bounded recovery cases are supported:
 * 1. an older controller committed/merged successfully but failed before
 *    recording the finalization stages; and
 * 2. a terminal cancelled WorkContract owns an unchanged, clean duplicate
 *    worktree created by an idempotency defect.
 *
 * Missing worktrees are accepted only when this handle already recorded a
 * successful worktree cleanup. This lets a retry finish branch cleanup after a
 * crash without turning a missing checkout into proof of safety.
 */
export function inspectCleanupOnlyMergedHead(
  ctx: McpExecutionContext,
  current: WorkHandleState,
  args: Record<string, unknown>,
): { currentHead: string; cancelledContract: boolean; worktreeMissing: boolean } | undefined {
  if (args.cleanup !== true || args.commit === true || args.merge === true || !current.managedWorktree) return undefined;
  const contract = contractFor(ctx, current);
  const cancelledContract = contract?.status === 'cancelled';

  const repository = getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const target = selectWorkFinalizationTarget(repository, current);
  const targetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : repository.defaultBranch || 'main';
  const branchHeadResult = spawnSync('git', ['-C', target.canonicalRoot, 'rev-parse', '--verify', `refs/heads/${current.branch}`], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  const branchHead = branchHeadResult.status === 0 ? String(branchHeadResult.stdout ?? '').trim() : '';
  // A previous cleanup attempt may already have deleted the Work branch before
  // completion-receipt persistence failed. Only the exact durable expectedHead
  // may replace that missing ref, and only after branchCleanup itself is durably
  // recorded done.
  const currentHead = branchHead
    || (current.finalization.branchCleanup === 'done' ? current.expectedHead ?? '' : '');
  if (!currentHead) return undefined;
  const merged = spawnSync('git', ['-C', target.canonicalRoot, 'merge-base', '--is-ancestor', currentHead, targetBranch], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (merged.status !== 0) return undefined;

  const worktreeMissing = !existsSync(current.worktreePath);
  if (worktreeMissing) {
    const integratedDeliveryRecorded = current.state === 'merged'
      || current.state === 'cleaned'
      || current.finalization.merge === 'done';
    if (current.finalization.worktreeCleanup !== 'done') return undefined;
    if (!cancelledContract && !integratedDeliveryRecorded) return undefined;
    return { currentHead, cancelledContract, worktreeMissing: true };
  }

  const worktree = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true });
  if (!repositoryGitStatus(worktree).clean) return undefined;
  const worktreeHead = gitHead(worktree.canonicalRoot);
  if (!worktreeHead || worktreeHead !== currentHead) return undefined;
  const currentBranch = spawnSync('git', ['-C', worktree.canonicalRoot, 'branch', '--show-current'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (currentBranch.status !== 0 || String(currentBranch.stdout ?? '').trim() !== current.branch) return undefined;
  if (current.expectedHead && currentHead !== current.expectedHead && cancelledContract) return undefined;
  return { currentHead, cancelledContract, worktreeMissing: false };
}

interface FailedCleanupProof {
  currentHead: string;
  worktreeMissing: boolean;
  targetBranch: string;
}

/**
 * Prove that a failed Work owns an unchanged, clean managed worktree whose
 * branch is already contained in the target branch. This authorizes resource
 * cleanup only; it never proves successful verification or delivery.
 */
function failedCleanupOnlyHead(
  ctx: McpExecutionContext,
  current: WorkHandleState,
  args: Record<string, unknown>,
): FailedCleanupProof | undefined {
  if (
    current.state !== 'failed'
    || args.cleanup !== true
    || args.commit === true
    || args.merge === true
    || !current.managedWorktree
  ) return undefined;
  const contract = contractFor(ctx, current);
  if (contract?.status !== 'failed') return undefined;

  const expectedHead = current.expectedHead ?? current.baseCommit;
  if (!expectedHead) return undefined;
  const repository = getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const target = selectWorkFinalizationTarget(repository, current);
  const targetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : repository.defaultBranch || 'main';
  const merged = spawnSync('git', ['-C', target.canonicalRoot, 'merge-base', '--is-ancestor', expectedHead, targetBranch], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (merged.status !== 0) return undefined;

  const worktreeMissing = !existsSync(current.worktreePath);
  if (worktreeMissing) {
    return current.finalization.worktreeCleanup === 'done'
      ? { currentHead: expectedHead, worktreeMissing: true, targetBranch }
      : undefined;
  }

  const worktree = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true });
  if (resolve(worktree.canonicalRoot) !== resolve(current.worktreePath)) return undefined;
  if (!repositoryGitStatus(worktree).clean) return undefined;
  if (gitHead(worktree.canonicalRoot) !== expectedHead) return undefined;
  const currentBranch = spawnSync('git', ['-C', worktree.canonicalRoot, 'branch', '--show-current'], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (currentBranch.status !== 0 || String(currentBranch.stdout ?? '').trim() !== current.branch) return undefined;
  return { currentHead: expectedHead, worktreeMissing: false, targetBranch };
}

type RetryableFinalizationStage = 'commit' | 'merge' | 'branchCleanup' | 'worktreeCleanup';

function requestedFailedFinalizationRetry(
  stages: WorkFinalizationStages,
  wants: { commit: boolean; merge: boolean; cleanup: boolean },
): RetryableFinalizationStage | undefined {
  if (stages.validation === 'failed') return undefined;
  if (wants.commit && stages.commit === 'failed') return 'commit';
  if (wants.merge && stages.merge === 'failed') return 'merge';
  if (wants.cleanup && stages.worktreeCleanup === 'failed') return 'worktreeCleanup';
  if (wants.cleanup && stages.branchCleanup === 'failed') return 'branchCleanup';
  return undefined;
}

function retryPhaseForFinalizationStage(stage: RetryableFinalizationStage): 'delivery' | 'cleanup' {
  return stage === 'commit' || stage === 'merge' ? 'delivery' : 'cleanup';
}

function retryHandleStateForFinalization(stages: WorkFinalizationStages): WorkHandleState['state'] {
  if (stages.merge === 'done') return 'merged';
  if (stages.commit === 'done') return 'committed';
  return 'validating';
}

export function resetFinalizationStagesForRequest(
  stages: WorkFinalizationStages,
  wants: { commit: boolean; merge: boolean; cleanup: boolean },
  options: { managedWorktree?: boolean; deleteBranchRequested?: boolean; retainedByRequest?: boolean; workspaceDirty?: boolean } = {},
): WorkFinalizationStages {
  const next = { ...stages };
  let reset = false;
  if (next.validation === 'failed') {
    next.validation = 'pending';
    reset = true;
  }
  if (wants.commit && next.commit === 'failed') {
    next.commit = 'pending';
    reset = true;
  }
  if (wants.merge && next.merge === 'failed') {
    next.merge = 'pending';
    reset = true;
  }
  if (wants.cleanup && next.worktreeCleanup === 'failed') {
    next.worktreeCleanup = 'pending';
    reset = true;
  }
  if (wants.cleanup && next.branchCleanup === 'failed') {
    next.branchCleanup = 'pending';
    reset = true;
  }
  // A Work may be semantically repaired and revalidated after an earlier delivery
  // attempt already marked commit/merge done. Exact validation of a dirty current
  // workspace proves there is new Work-owned content still requiring delivery;
  // re-arm only the requested Git stages instead of letting cleanup discard it.
  if (options.workspaceDirty === true && wants.commit && next.commit === 'done') {
    next.commit = 'pending';
    reset = true;
    if (wants.merge && next.merge === 'done') next.merge = 'pending';
  }
  // A prior finalize(cleanup=false) intentionally records managed resources as
  // skipped/retained. A later explicit cleanup=true is a new resource-disposal
  // request, not an idempotent replay of the earlier retention decision. Re-arm
  // only cleanup stages that are applicable to this managed Work; commit/merge
  // skipped states keep their original delivery semantics.
  if (wants.cleanup && options.retainedByRequest === true && options.managedWorktree === true && next.worktreeCleanup === 'skipped') {
    next.worktreeCleanup = 'pending';
    reset = true;
  }
  if (wants.cleanup && options.retainedByRequest === true && options.managedWorktree === true && options.deleteBranchRequested === true && next.branchCleanup === 'skipped') {
    next.branchCleanup = 'pending';
    reset = true;
  }
  if (reset) delete next.lastError;
  return next;
}

function finalizationComplete(stages: WorkFinalizationStages): boolean {
  return stages.validation === 'done'
    && stages.commit !== 'pending'
    && stages.merge !== 'pending'
    && stages.branchCleanup !== 'pending'
    && stages.worktreeCleanup !== 'pending'
    && stages.commit !== 'failed'
    && stages.merge !== 'failed'
    && stages.branchCleanup !== 'failed'
    && stages.worktreeCleanup !== 'failed'
    && !stages.lastError;
}

function finalStateForStages(stages: WorkFinalizationStages, fallback: WorkHandleState['state']): WorkHandleState['state'] {
  if (stages.worktreeCleanup === 'done') return 'cleaned';
  if (stages.merge === 'done') return 'merged';
  if (stages.commit === 'done') return 'committed';
  return fallback === 'failed' ? 'editing' : fallback;
}

function currentWorkValidationInput(
  repository: RepositoryRecord,
  handle: WorkHandleState,
  requestedChecks: string[],
): { head: string; workspaceFingerprint: string; fingerprint: string; clean: boolean } {
  const status = repositoryGitStatus(repository);
  const head = status.head ?? handle.expectedHead ?? handle.baseCommit ?? 'unknown';
  const workspaceFingerprint = workspaceValidationFingerprint(repository.canonicalRoot, status);
  return {
    head,
    workspaceFingerprint,
    fingerprint: workValidationInputFingerprint(head, workspaceFingerprint, requestedChecks),
    clean: status.clean,
  };
}

export async function finalizeWork(ctx: McpExecutionContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = requireSession(ctx, args);
  let current = workForSession(ctx, session, args, { allowClaimedTerminalCleanup: args.cleanup !== false });
  const requestedWants = { commit: args.commit === true, merge: args.merge === true, cleanup: args.cleanup === true };
  const retryStage = current.state === 'failed'
    ? requestedFailedFinalizationRetry(current.finalization, requestedWants)
    : undefined;
  const retryContract = retryStage ? contractFor(ctx, current) : undefined;
  if (
    retryStage
    && retryContract?.status === 'failed'
    && !retryContract.completionOutcome
    && !retryContract.completionReceipt
  ) {
    transitionWorkContractPhase(
      { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
      retryContract.workId,
      {
        phase: retryPhaseForFinalizationStage(retryStage),
        status: 'running',
        state: 'active',
        summary: `Retrying previously failed Work finalization stage ${retryStage}.`,
      },
    );
  }
  const terminalOutcome = terminalCleanupOutcome(ctx, current);
  if (terminalOutcome && args.cleanup !== false) {
    return await reconcileTerminalCleanup(ctx, session, current, args, terminalOutcome);
  }
  const terminalizationOwner = assertWorkControllerOwnership(ctx, session, current, args);
  if (terminalOutcome && args.cleanup === false) {
    const recordedAt = new Date().toISOString();
    current = withControllerLock(
      ctx.controllerHome,
      { scope: 'worktree', repoId: current.repositoryId, worktreeId: current.checkoutId },
      `work-finalize:${current.workId}:retain-terminal-resources`,
      () => {
        const fresh = readWorkHandle(ctx.controllerHome, current.repositoryId, current.workId) ?? current;
        return writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          finalization: {
            ...fresh.finalization,
            validation: fresh.finalization.validation === 'failed' ? 'failed' : 'done',
            commit: fresh.finalization.commit === 'pending' ? 'skipped' : fresh.finalization.commit,
            merge: fresh.finalization.merge === 'pending' ? 'skipped' : fresh.finalization.merge,
            branchCleanup: 'skipped',
            worktreeCleanup: 'skipped',
            lastError: fresh.finalization.validation === 'failed' ? fresh.finalization.lastError : undefined,
          },
          terminalResourceDisposition: {
            mode: 'retained_by_request',
            retainWorktree: fresh.managedWorktree,
            retainBranch: true,
            recordedAt,
          },
        });
      },
      10_000,
    );
    appendWorkEvidence(
      { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
      current.workContractId ?? current.workId,
      {
        title: 'terminal resources retained by request',
        summary: `Controller explicitly retained ${current.managedWorktree ? 'the managed worktree and ' : ''}local branch after terminal Work; automatic terminal cleanup must not reclaim them.`,
        detailLevel: 'summary',
      },
    );
    releasePreparedWorkOwnership(ctx, current);
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
      activeWorkId: undefined,
      activeCheckoutId: current.sourceCheckoutId ?? session.activeCheckoutId,
    });
    return {
      work: compactHandle(current),
      stages: current.finalization,
      completed: true,
      cleanupCompleted: false,
      cleanupRetained: true,
      cleanupPending: false,
      idempotent: true,
    };
  }
  if (current.state === 'cleaned') {
    const terminalContract = contractFor(ctx, current);
    if (
      terminalContract?.status === 'failed'
      && current.finalization.validation === 'failed'
      && current.finalization.worktreeCleanup === 'done'
    ) {
      releasePreparedWorkOwnership(ctx, current);
      updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
        activeWorkId: undefined,
        activeCheckoutId: workReturnCheckoutId(ctx, current, session.activeCheckoutId),
      });
      return {
        idempotent: true,
        work: compactHandle(current),
        stages: current.finalization,
        completed: false,
        cleanupCompleted: true,
        failurePreserved: true,
      };
    }
    validateWorkHandle(ctx.controllerHome, current, identityFor(ctx, args), 'none', 'finalize');
    return { idempotent: true, work: compactHandle(current) };
  }
  const identity = identityFor(ctx, args);
  const requestedOutcome = args.completion_outcome === 'completed_no_change' || args.completion_outcome === 'completed_changed'
    ? args.completion_outcome
    : undefined;
  const noChangeProof = typeof args.no_change_evidence === 'string' ? args.no_change_evidence.trim().slice(0, 1_000) : '';
  if (requestedOutcome === 'completed_no_change' && (!noChangeProof || args.commit === true || args.merge === true)) {
    throw new Error('WORK_NO_CHANGE_PROOF_REQUIRED: completed_no_change requires objective-specific evidence and forbids commit/merge');
  }
  const wants = requestedWants;
  const explicitTargetBranch = typeof args.target_branch === 'string' && args.target_branch.trim()
    ? args.target_branch.trim()
    : undefined;
  // With merge=false an explicitly selected Work branch is the delivery target,
  // not a disposable feature branch. Keep the ref reachable for the receipt.
  const retainExplicitWorkTargetBranch = !wants.merge && explicitTargetBranch === current.branch;
  const deleteBranchRequested = args.delete_branch !== false && !retainExplicitWorkTargetBranch;
  const noChangeFastPath = requestedOutcome === 'completed_no_change'
    && !wants.commit
    && !wants.merge
    && current.state !== 'failed';

  const transact = (label: string, update: (fresh: WorkHandleState) => WorkHandleState): WorkHandleState =>
    withControllerLock(ctx.controllerHome, { scope: 'worktree', repoId: current.repositoryId, worktreeId: current.checkoutId }, `work-finalize:${current.workId}:${label}`, () => {
      const fresh = readWorkHandle(ctx.controllerHome, current.repositoryId, current.workId) ?? current;
      return update(fresh);
    }, 10_000);

  const failStage = (stage: keyof WorkFinalizationStages, reason: string): Record<string, unknown> => {
    current = transact(`fail:${String(stage)}`, (fresh) => {
      const finalization = { ...fresh.finalization, [stage]: 'failed', lastError: reason } as WorkFinalizationStages;
      return markWorkHandleFailed(ctx.controllerHome, { ...fresh, finalization }, reason);
    });
    if (current.workContractId) {
      if (stage === 'validation') {
        updateWorkContract({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId, { status: 'failed' });
      } else if (stage === 'commit' || stage === 'merge' || stage === 'branchCleanup' || stage === 'worktreeCleanup') {
        transitionWorkContractPhase(
          { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
          current.workContractId,
          {
            phase: retryPhaseForFinalizationStage(stage),
            status: 'blocked',
            state: 'blocked',
            summary: `Retryable Work finalization stage ${stage} failed: ${reason}`,
          },
        );
      }
    }
    markRepositoryProjectionDirty(ctx.controllerHome, current.repositoryId, `finalize:${current.workId}:${String(stage)}-failed`);
    return { work: compactHandle(current), stages: current.finalization, completed: false };
  };

  const failedCleanupRequested = current.state === 'failed'
    && wants.cleanup
    && !wants.commit
    && !wants.merge
    && retryStage === undefined;
  const failedCleanupProof = failedCleanupRequested
    ? failedCleanupOnlyHead(ctx, current, args)
    : undefined;
  if (failedCleanupRequested && !failedCleanupProof) {
    throw new Error('WORK_FAILED_CLEANUP_UNSAFE: failed Work cleanup requires exact checkout/branch ownership and an unchanged clean controller-owned managed worktree whose exact HEAD is already contained in the target branch');
  }

  if (!failedCleanupRequested && !noChangeFastPath) {
    current = transact('begin', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      state: fresh.state === 'failed' ? retryHandleStateForFinalization(fresh.finalization) : fresh.state,
      failureReason: undefined,
      finalization: resetFinalizationStagesForRequest(fresh.finalization, wants, {
        managedWorktree: fresh.managedWorktree,
        deleteBranchRequested,
        retainedByRequest: fresh.terminalResourceDisposition?.mode === 'retained_by_request',
      }),
      ...(wants.cleanup && fresh.terminalResourceDisposition?.mode === 'retained_by_request' ? { terminalResourceDisposition: undefined } : {}),
    }));
  }

  const approvalRequestId = typeof args.approval_request_id === 'string' ? args.approval_request_id.trim() : '';
  const resolvedAuthorization = approvalRequestId
    ? assertResolvedAuthorization({ controllerHome: ctx.controllerHome, repositoryId: current.repositoryId, approvalRequestId, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, permissionSnapshotVersion: current.permissionSnapshotVersion, command: 'work_finalize' })
    : undefined;
  const gitAuthorization = resolvedAuthorization
    ? { decision: 'allow', source: 'user_confirmation', reason: 'The user resolved the exact finalization approval request.' } as const
    : decideAuthorization({
      controllerHome: ctx.controllerHome,
      accessMode: readRepositoryAccessPolicy(ctx.controllerHome, current.repositoryId).mode,
      risk: 'local_git',
      repositoryId: current.repositoryId,
      currentRepositoryId: current.repositoryId,
      workId: current.workId,
      boundWorkId: current.workId,
      goalId: current.goalId,
      boundGoalId: current.goalId,
      sessionId: session.sessionId,
      principalId: session.principalId,
      permissionSnapshotVersion: current.permissionSnapshotVersion,
      delegation: session.goalDelegation,
      command: 'work_finalize',
    });
  if (gitAuthorization.decision !== 'allow') return { authorization: gitAuthorization, work: compactHandle(current), stages: current.finalization };

  // A conflict-repaired managed candidate rewrites commit identity, so the
  // normal descendant-HEAD fence cannot authorize it. Re-adopt only an exact,
  // clean, scope-contained candidate that has reconciled the linearly advanced
  // target. The transition returns before delivery, so the successor must gain
  // current-source verification/review authority before merge can resume.
  if (wants.merge && current.managedWorktree && current.expectedHead) {
    const repository = getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true });
    const worktree = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true });
    const target = selectWorkFinalizationTarget(repository, current);
    const targetBranch = explicitTargetBranch ?? target.defaultBranch ?? 'main';
    const contract = contractFor(ctx, current);
    const adoption = inspectManagedWorkSuccessorAdoption({
      root: worktree.canonicalRoot,
      worktreePath: current.worktreePath,
      managedWorktree: current.managedWorktree,
      workBranch: current.branch,
      targetBranch,
      expectedRevision: current.expectedHead,
      deliveryBaseRevision: workDeliveryBaseRevision(current),
      status: repositoryGitStatus(worktree),
      scope: contract ? { allowedPaths: contract.allowedPaths, forbiddenPaths: contract.forbiddenPaths } : undefined,
    });
    if (adoption.adoptable && adoption.candidateHead && adoption.targetHead) {
      const previousHead = current.expectedHead;
      current = transact('managed-successor-adopted', (fresh) => adoptWorkHandleSuccessorCandidate(
        ctx.controllerHome,
        fresh,
        { candidateHead: adoption.candidateHead!, targetHead: adoption.targetHead! },
      ));
      if (contract) {
        transitionWorkContractPhase(
          { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
          contract.workId,
          {
            phase: 'verification',
            status: 'running',
            state: 'active',
            summary: `Conflict-repaired successor ${adoption.candidateHead} adopted after canonical ${targetBranch} advanced to ${adoption.targetHead}; current-source verification is required before delivery resumes.`,
          },
        );
      }
      appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
        title: 'managed Work successor candidate adopted',
        summary: `WorkHandle authority moved ${previousHead} -> ${adoption.candidateHead} only after proving clean exact checkout ownership, canonical target ancestry at ${adoption.targetHead}, linear candidate history, and ${adoption.candidateChangedPaths.length} scope-contained target-relative path(s). Validation/delivery authority was re-armed; no canonical target mutation occurred.`,
        detailLevel: 'summary',
      });
      markWorkValidationPending(ctx.controllerHome, current);
      return {
        work: compactHandle(current),
        stages: current.finalization,
        completed: false,
        successorAdopted: true,
        continuation: `WORK_SUCCESSOR_REVALIDATION_REQUIRED: successor ${adoption.candidateHead} is now the exact Work candidate after target ${adoption.targetHead}; verify/review this source revision before retrying delivery`,
      };
    }
  }

  // A direct Work can share canonical main with another Work's preserved dirty
  // delta. If main advanced after this Work was prepared, keep the global
  // execution-identity fence strict and reconcile only here, where delivery
  // ownership plus exact current verification can be proven together.
  if (wants.commit && !current.managedWorktree && current.expectedHead) {
    const repository = getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true });
    const worktree = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true });
    const target = selectWorkFinalizationTarget(repository, current);
    const targetBranch = explicitTargetBranch ?? repository.defaultBranch ?? 'main';
    const contract = contractFor(ctx, current);
    const advance = inspectDirectCanonicalTargetAdvanceReconciliation({
      root: target.canonicalRoot,
      worktreePath: current.worktreePath,
      managedWorktree: current.managedWorktree,
      workBranch: current.branch,
      targetBranch,
      expectedRevision: current.expectedHead,
      status: repositoryGitStatus(worktree),
      scope: contract ? { allowedPaths: contract.allowedPaths, forbiddenPaths: contract.forbiddenPaths } : undefined,
      checkIds: contract?.checks ?? [],
      checkRefs: contract?.checkRefs ?? [],
    });
    if (advance.reconcilable && advance.targetHead) {
      const previousHead = current.expectedHead;
      current = transact('direct-canonical-target-advance-reconciled', (fresh) => writeWorkHandle(ctx.controllerHome, {
        ...fresh,
        deliveryBaseCommit: advance.targetHead,
        expectedHead: advance.targetHead,
        failureReason: undefined,
      }));
      appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
        title: 'direct canonical target advancement reconciled',
        summary: `Canonical ${targetBranch} advanced linearly ${previousHead} -> ${advance.targetHead}. ${advance.targetChangedPaths.length} target-only path(s) were disjoint from all ${advance.dirtyPaths.length} positively Work-owned dirty path(s), and fresh exact verification bound [${advance.freshCheckIds.join(', ')}] to source ${advance.targetHead} plus workspace ${advance.workspaceFingerprint?.slice(0, 16) ?? 'unknown'}. Delivery identity advanced without adopting target-only commits or unrelated dirty paths.`,
        detailLevel: 'summary',
      });
    }
  }

  if (failedCleanupProof) {
    const preservedFailure = current.failureReason ?? current.finalization.lastError ?? 'Work validation failed.';
    current = transact('failed-cleanup-begin', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      state: 'failed',
      failureReason: preservedFailure,
      finalization: {
        ...fresh.finalization,
        validation: 'failed',
        commit: fresh.finalization.commit === 'pending' ? 'skipped' : fresh.finalization.commit,
        merge: fresh.finalization.merge === 'pending' ? 'skipped' : fresh.finalization.merge,
        branchCleanup: deleteBranchRequested ? fresh.finalization.branchCleanup : 'skipped',
        lastError: preservedFailure,
      },
    }));

    if (!failedCleanupProof.worktreeMissing && current.finalization.worktreeCleanup !== 'done') {
      const target = selectWorkFinalizationTarget(
        getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true }),
        current,
      );
      const cleanup = runCleanup(target.canonicalRoot, current.worktreePath);
      if (!cleanup.ok) {
        throw new Error(`WORK_FAILED_CLEANUP_UNSAFE: ${cleanup.message ?? 'managed worktree cleanup failed'}`);
      }
      current = transact('failed-worktree-cleanup-done', (fresh) => {
        setRepositoryCheckoutLifecycle({
          controllerHome: ctx.controllerHome,
          repoId: fresh.repositoryId,
          checkoutId: fresh.checkoutId,
          lifecycle: 'removed',
          reason: `Failed Work ${fresh.workId} cleanup completed without changing delivery state.`,
        });
        markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:failed-worktree`);
        return writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          state: 'failed',
          failureReason: preservedFailure,
          finalization: { ...fresh.finalization, worktreeCleanup: 'done', lastError: preservedFailure },
        });
      });
    }

    if (deleteBranchRequested && current.finalization.branchCleanup !== 'done') {
      const target = selectWorkFinalizationTarget(
        getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true }),
        current,
      );
      const deleted = repositoryGitDeleteBranch(ctx.controllerHome, target, {
        branch: current.branch,
        force: false,
        authorizationDecision: gitAuthorization,
        sessionId: session.sessionId,
        principalId: session.principalId,
        workId: current.workId,
        goalId: current.goalId,
      });
      if (deleted.execution.authorizationDecision?.decision === 'user_confirmation_required') {
        return { authorization: deleted.execution.authorizationDecision, work: compactHandle(current), stages: current.finalization };
      }
      if (deleted.execution.status !== 'executed' || deleted.execution.ok !== true) {
        current = transact('failed-branch-cleanup-failed', (fresh) => writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          state: 'failed',
          failureReason: preservedFailure,
          finalization: {
            ...fresh.finalization,
            branchCleanup: 'failed',
            lastError: String(deleted.execution.stderr || 'feature branch cleanup failed').slice(0, 1_000),
          },
        }));
        return {
          work: compactHandle(current),
          stages: current.finalization,
          completed: false,
          cleanupCompleted: false,
          failurePreserved: true,
        };
      }
      current = transact('failed-branch-cleanup-done', (fresh) => {
        markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:failed-branch`);
        return writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          state: 'failed',
          failureReason: preservedFailure,
          finalization: { ...fresh.finalization, branchCleanup: 'done', lastError: preservedFailure },
        });
      });
    }

    current = transact('failed-cleanup-complete', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'cleaned', {
      failureReason: preservedFailure,
      finalization: {
        ...fresh.finalization,
        validation: 'failed',
        commit: fresh.finalization.commit === 'pending' ? 'skipped' : fresh.finalization.commit,
        merge: fresh.finalization.merge === 'pending' ? 'skipped' : fresh.finalization.merge,
        branchCleanup: deleteBranchRequested ? fresh.finalization.branchCleanup : 'skipped',
        worktreeCleanup: 'done',
        lastError: preservedFailure,
      },
    }));
    appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
      title: 'failed work cleanup completed',
      summary: `Controller preserved the failed Work outcome while removing its unchanged clean managed worktree and ${deleteBranchRequested ? 'removing' : 'retaining'} the local branch after proving ${failedCleanupProof.currentHead} is contained in ${failedCleanupProof.targetBranch}.`,
      detailLevel: 'summary',
    });
    releasePreparedWorkOwnership(ctx, current);
    updateExecutionSession(ctx.controllerHome, identity, {
      activeWorkId: undefined,
      activeCheckoutId: current.sourceCheckoutId ?? session.activeCheckoutId,
    });
    return {
      work: compactHandle(current),
      stages: current.finalization,
      completed: false,
      cleanupCompleted: true,
      failurePreserved: true,
      idempotent: false,
    };
  }

  const contractAtStart = contractFor(ctx, current);
  const cancelledCleanupRequested = contractAtStart?.status === 'cancelled'
    && wants.cleanup
    && !wants.commit
    && !wants.merge;
  const cleanupReconciliation = requestedOutcome === 'completed_no_change'
    ? undefined
    : inspectCleanupOnlyMergedHead(ctx, current, args);
  if (cancelledCleanupRequested && !cleanupReconciliation) {
    throw new Error('WORK_CANCELLED_CLEANUP_UNSAFE: cancelled Work cleanup requires an unchanged clean managed worktree (or a previously recorded cleanup) and a branch HEAD already contained in the target branch');
  }
  if (cleanupReconciliation) {
    current = transact('cleanup-reconcile-merged-head', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      expectedHead: cleanupReconciliation.currentHead,
      state: 'merged',
      failureReason: undefined,
      finalization: {
        ...fresh.finalization,
        validation: cleanupReconciliation.worktreeMissing ? 'done' : fresh.finalization.validation,
        // Exact target containment proves an already-committed candidate. A
        // previous GIT_NOTHING_STAGED failure is superseded rather than kept as
        // a permanent failed stage after successful delivery.
        commit: fresh.finalization.commit === 'done' ? 'done' : 'skipped',
        merge: 'done',
        branchCleanup: deleteBranchRequested
          ? (fresh.finalization.branchCleanup === 'done' ? 'done' : 'pending')
          : 'skipped',
        lastError: undefined,
      },
    }));
  }

  const changedCleanupOnly = wants.cleanup
    && !wants.commit
    && !wants.merge
    && requestedOutcome !== 'completed_no_change'
    && current.state !== 'merged'
    && current.state !== 'cleaned';
  if (changedCleanupOnly && !cleanupReconciliation) {
    throw new Error('WORK_CLEANUP_DELIVERY_NOT_PROVEN: cleanup-only completion requires the exact Work branch HEAD to already be contained in the target branch before any managed worktree is removed');
  }

  const terminalCleanupOnly = Boolean(cleanupReconciliation && wants.cleanup && !wants.commit && !wants.merge);
  let exactValidationInput: ReturnType<typeof currentWorkValidationInput> | undefined;
  if (terminalCleanupOnly) {
    current = transact('terminal-cleanup-validation-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      finalization: { ...fresh.finalization, validation: 'done', lastError: undefined },
    }));
  } else {
    let validatedRepository: RepositoryRecord;
    try {
      validatedRepository = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize').worktreeRepository;
    } catch (error) {
      return failStage('validation', error instanceof Error ? error.message : String(error));
    }
    const validationContract = contractFor(ctx, current);
    if (!validationContract) throw new Error(`WORK_VALIDATION_CONTRACT_MISSING: ${current.workContractId ?? current.workId}`);
    const validationInput = currentWorkValidationInput(validatedRepository, current, validationContract.checks);
    exactValidationInput = validationInput;
    if (validationContract.checks.length === 0) {
      if (!noChangeFastPath) {
        current = transact('validation-no-checks', (fresh) => writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          validatedInputFingerprint: validationInput.fingerprint,
          finalization: { ...fresh.finalization, validation: 'done', lastError: undefined },
        }));
      }
      projectWorkValidationOutcome(ctx.controllerHome, current, 'passed', 'No validation checks were required.');
    } else if (!hasCurrentWorkValidationAuthority({
      finalizationValidation: current.finalization.validation,
      validatedInputFingerprint: current.validatedInputFingerprint,
      evidenceState: validationContract.evidenceState,
      expectedFingerprint: validationInput.fingerprint,
    })) {
      current = transact('validation-required', (fresh) => writeWorkHandle(ctx.controllerHome, {
        ...fresh,
        validatedInputFingerprint: undefined,
        finalization: { ...fresh.finalization, validation: 'pending', lastError: undefined },
      }));
      markWorkValidationPending(ctx.controllerHome, current);
      throw new Error('WORK_VALIDATION_REQUIRED: run work_validate against the exact current workspace before finalization');
    }
    if (!validationInput.clean && wants.commit && current.finalization.commit === 'done') {
      current = transact('rearm-delivery-after-validated-repair', (fresh) => writeWorkHandle(ctx.controllerHome, {
        ...fresh,
        state: 'validating',
        failureReason: undefined,
        finalization: resetFinalizationStagesForRequest(fresh.finalization, wants, {
          managedWorktree: fresh.managedWorktree,
          deleteBranchRequested,
          retainedByRequest: fresh.terminalResourceDisposition?.mode === 'retained_by_request',
          workspaceDirty: true,
        }),
      }));
    }
    if (wants.merge && !wants.commit && !validationInput.clean) {
      throw new Error('WORK_MERGE_UNCOMMITTED_CHANGES: commit the validated workspace before merging');
    }
  }

  if (noChangeFastPath) {
    if (!exactValidationInput?.clean) {
      throw new Error('WORK_NO_CHANGE_DIRTY: completed_no_change cannot retain an owned dirty worktree');
    }
    const noChangeFinalization: WorkFinalizationStages = {
      ...current.finalization,
      validation: 'done',
      commit: 'skipped',
      merge: 'skipped',
      branchCleanup: wants.cleanup && deleteBranchRequested ? 'pending' : 'skipped',
      lastError: undefined,
    };
    // Collapse the no-op Git stages into the same durable lifecycle write used
    // to enter/establish the delivery boundary. Physical cleanup remains
    // separately persisted because it has real side effects and crash semantics.
    if (current.state === 'prepared') {
      current = transact('no-change-validated', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'validating', {
        finalization: noChangeFinalization,
        validatedInputFingerprint: exactValidationInput.fingerprint,
        failureReason: undefined,
      }));
    } else if (current.state === 'editing' || current.state === 'validating' || current.state === 'committed') {
      current = transact('no-change-delivery-integrated', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'merged', {
        finalization: noChangeFinalization,
        validatedInputFingerprint: exactValidationInput.fingerprint,
        failureReason: undefined,
      }));
    }
  }

  if (wants.commit && current.finalization.commit === 'pending') {
    const validated = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize');
    const contract = contractFor(ctx, current);
    if (contract?.constraints.allowCommit === false) throw new Error('WORK_COMMIT_NOT_ALLOWED: WorkContract disallows commit');
    const status = repositoryGitStatus(validated.worktreeRepository);
    const { dirtyPaths, ownedPaths: commitPaths } = workOwnedDirtyPaths(contract, status);
    if (dirtyPaths.length > 0 && commitPaths.length === 0) {
      throw new Error(`WORK_COMMIT_NO_OWNED_DIRTY_PATHS: ${current.workId} has ${dirtyPaths.length} dirty path(s), but none are owned by its WorkContract path scope`);
    }
    if (!contract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
    const preCommitReviewCandidate = assertPhysicalImplementationReviewGate({
      ctx,
      repository: validated.worktreeRepository,
      handle: current,
      contract,
      verificationWorkspaceFingerprint: exactValidationInput?.workspaceFingerprint,
    });
    const reviewedCommitPaths = normalizeImplementationReviewChangedPaths(preCommitReviewCandidate.changedPaths);
    const exactCommitPaths = normalizeImplementationReviewChangedPaths(commitPaths);
    if (JSON.stringify(reviewedCommitPaths) !== JSON.stringify(exactCommitPaths)) {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_COMMIT_SCOPE_MISMATCH: commit must materialize the complete reviewed Work path set');
    }
    const committed = repositoryGitCommit(ctx.controllerHome, validated.worktreeRepository, { message: String(args.message ?? `Complete ${current.workId}`), paths: commitPaths, allowEmpty: false, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
    const pendingAuthorization = [committed.stage, committed.commit].find((execution) => execution?.authorizationDecision?.decision === 'user_confirmation_required')?.authorizationDecision;
    if (pendingAuthorization) return { authorization: pendingAuthorization, work: compactHandle(current), stages: current.finalization };
    if (!committed.committed) return { ...failStage('commit', committed.error?.message ?? 'commit failed'), commit: committed };
    const checks = contract?.checks ?? [];
    const committedValidatedWorkspaceFingerprint = exactValidationInput && committed.after.clean
      ? workspaceValidationFingerprint(validated.worktreeRepository.canonicalRoot, committed.before)
      : undefined;
    const validationPreservedAcrossCommit = Boolean(
      checks.length > 0
      && exactValidationInput
      && committedValidatedWorkspaceFingerprint === exactValidationInput.workspaceFingerprint
    );
    const committedHead = gitHead(validated.worktreeRepository.canonicalRoot);
    if (!committedHead) throw new Error('WORK_COMMIT_HEAD_REQUIRED: committed revision is unavailable');
    const postCommitInput = currentWorkValidationInput(validated.worktreeRepository, { ...current, expectedHead: committedHead }, checks);
    current = transact('commit-done', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'committed', {
      expectedHead: committedHead,
      finalization: {
        ...fresh.finalization,
        validation: checks.length ? (validationPreservedAcrossCommit ? 'done' : 'pending') : 'done',
        commit: 'done',
        lastError: undefined,
      },
      validatedInputFingerprint: checks.length
        ? (validationPreservedAcrossCommit ? postCommitInput.fingerprint : undefined)
        : postCommitInput.fingerprint,
      failureReason: undefined,
    }));
    if (checks.length && !validationPreservedAcrossCommit) {
      markWorkValidationPending(ctx.controllerHome, current);
      return {
        work: compactHandle(current),
        stages: current.finalization,
        completed: false,
        continuation: 'WORK_COMMITTED_REVALIDATION_REQUIRED: committed content changed from the exact validated workspace; run work_validate on the committed HEAD before merge or completion',
      };
    }
    if (validationPreservedAcrossCommit && exactValidationInput) {
      const transfer = transferWorkVerificationAcrossContentEquivalentCommit({
        controllerHome: ctx.controllerHome,
        repository: validated.worktreeRepository,
        workId: current.workContractId ?? current.workId,
        preCommitSourceRevision: preCommitReviewCandidate.sourceRevision,
        preCommitWorkspaceFingerprint: preCommitReviewCandidate.verificationWorkspaceFingerprint,
        postCommitSourceRevision: postCommitInput.head,
        postCommitWorkspaceFingerprint: postCommitInput.workspaceFingerprint,
      });
      if (transfer.invalidatedCheckIds.length > 0) {
        current = transact('commit-review-revalidation-required', (fresh) => writeWorkHandle(ctx.controllerHome, {
          ...fresh,
          finalization: { ...fresh.finalization, validation: 'pending', lastError: undefined },
          validatedInputFingerprint: undefined,
        }));
        markWorkValidationPending(ctx.controllerHome, current);
        return {
          work: compactHandle(current),
          stages: current.finalization,
          completed: false,
          continuation: `WORK_COMMITTED_REVALIDATION_REQUIRED: content-equivalent verification transfer invalidated [${transfer.invalidatedCheckIds.join(', ')}]`,
        };
      }
      const transferredContract = contractFor(ctx, current);
      if (!transferredContract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
      const postVerification = authoritativeImplementationReviewVerificationEvidence({
        repoId: transferredContract.repoId,
        workId: transferredContract.workId,
        requiredCheckIds: transferredContract.checks,
        records: transferredContract.checkRefs,
        sourceRevision: postCommitInput.head,
        workspaceFingerprint: postCommitInput.workspaceFingerprint,
      });
      if (postVerification.missingCheckIds.length > 0) {
        throw new Error(`WORK_IMPLEMENTATION_REVIEW_TRANSFER_VERIFICATION_REQUIRED: ${postVerification.missingCheckIds.join(', ')}`);
      }
      const postContentFingerprint = implementationReviewContentFingerprint(
        validated.worktreeRepository.canonicalRoot,
        preCommitReviewCandidate.changedPaths,
      );
      const committedPaths = exactCommitChangedPaths(validated.worktreeRepository.canonicalRoot, committedHead);
      const postCandidate: ImplementationReviewCandidateIdentity = {
        sourceRevision: postCommitInput.head,
        workspaceFingerprint: postContentFingerprint,
        verificationWorkspaceFingerprint: postCommitInput.workspaceFingerprint,
        changedPaths: preCommitReviewCandidate.changedPaths,
        verificationEvidence: postVerification.evidence,
        architectureEvidence: preCommitReviewCandidate.architectureEvidence ?? [],
      };
      const recordedAt = new Date().toISOString();
      const derivedReview = deriveImplementationReviewAcrossCommit({
        workId: transferredContract.workId,
        reviews: transferredContract.implementationReviews,
        proof: {
          preCommitCandidate: preCommitReviewCandidate,
          postCommitCandidate: postCandidate,
          preCommitDirtyPaths: commitPaths,
          committedPaths,
          preCommitContentDigest: preCommitReviewCandidate.workspaceFingerprint,
          postCommitContentDigest: postContentFingerprint,
          postCommitVerificationAuthority: {
            repoId: transferredContract.repoId,
            workId: transferredContract.workId,
            requiredCheckIds: transferredContract.checks,
            records: transferredContract.checkRefs,
          },
        },
        derivedReviewId: `REV-commit-${createHash('sha256').update(`${transferredContract.workId}\0${postCommitInput.head}\0${postContentFingerprint}`).digest('hex').slice(0, 20)}`,
        recordedAt,
      });
      recordWorkImplementationReview({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, transferredContract.workId, derivedReview);
      appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, transferredContract.workId, {
        title: 'verification and implementation-review authority preserved across content-equivalent commit',
        summary: `The exact reviewed Work content was committed as ${postCommitInput.head}; ${transfer.reusableCheckIds.length}/${checks.length} non-Git-sensitive Process receipt(s) and review ${derivedReview.reviewId} were transferred without creating a second authority.`,
        detailLevel: 'summary',
      });
    } else if (checks.length === 0) {
      const transferredContract = contractFor(ctx, current);
      if (!transferredContract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
      const postContentFingerprint = implementationReviewContentFingerprint(validated.worktreeRepository.canonicalRoot, preCommitReviewCandidate.changedPaths);
      const postCandidate: ImplementationReviewCandidateIdentity = {
        sourceRevision: postCommitInput.head,
        workspaceFingerprint: postContentFingerprint,
        verificationWorkspaceFingerprint: postCommitInput.workspaceFingerprint,
        changedPaths: preCommitReviewCandidate.changedPaths,
        verificationEvidence: [],
        architectureEvidence: preCommitReviewCandidate.architectureEvidence ?? [],
      };
      const recordedAt = new Date().toISOString();
      const derivedReview = deriveImplementationReviewAcrossCommit({
        workId: transferredContract.workId,
        reviews: transferredContract.implementationReviews,
        proof: {
          preCommitCandidate: preCommitReviewCandidate,
          postCommitCandidate: postCandidate,
          preCommitDirtyPaths: commitPaths,
          committedPaths: exactCommitChangedPaths(validated.worktreeRepository.canonicalRoot, committedHead),
          preCommitContentDigest: preCommitReviewCandidate.workspaceFingerprint,
          postCommitContentDigest: postContentFingerprint,
          postCommitVerificationAuthority: {
            repoId: transferredContract.repoId,
            workId: transferredContract.workId,
            requiredCheckIds: [],
            records: transferredContract.checkRefs,
          },
        },
        derivedReviewId: `REV-commit-${createHash('sha256').update(`${transferredContract.workId}\0${postCommitInput.head}\0${postContentFingerprint}`).digest('hex').slice(0, 20)}`,
        recordedAt,
      });
      recordWorkImplementationReview({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, transferredContract.workId, derivedReview);
      projectWorkValidationOutcome(ctx.controllerHome, current, 'passed', 'No validation checks were required after commit.');
    }
  } else if (!wants.commit && current.finalization.commit === 'pending') {
    const committedRepository = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize').worktreeRepository;
    const committedStatus = repositoryGitStatus(committedRepository);
    const alreadyMaterializedCommit = Boolean(
      committedStatus.clean
      && committedStatus.head
      && current.expectedHead
      && current.baseCommit
      && committedStatus.head === current.expectedHead
      && committedStatus.head !== current.baseCommit,
    );
    current = alreadyMaterializedCommit
      ? transact('commit-already-materialized', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'committed', {
          finalization: { ...fresh.finalization, commit: 'done', lastError: undefined },
          failureReason: undefined,
        }))
      : transact('commit-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, commit: 'skipped' } }));
  }

  if (wants.merge && current.finalization.merge === 'pending' && current.finalization.commit === 'done') {
    const repository = getRepository(current.repositoryId, ctx.controllerHome);
    const target = selectWorkFinalizationTarget(repository, current);
    const targetBranch = explicitTargetBranch ?? repository.defaultBranch ?? 'main';
    const directTarget = inspectDirectTargetDelivery(
      target.canonicalRoot,
      current.worktreePath,
      current.managedWorktree,
      current.branch,
      targetBranch,
      current.expectedHead,
    );
    if (directTarget.integrated) {
      current = transact('direct-target-delivery-integrated', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'merged', {
        finalization: { ...fresh.finalization, merge: 'done', branchCleanup: 'skipped', lastError: undefined },
        failureReason: undefined,
      }));
      appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
        title: 'direct target delivery already integrated',
        summary: `Work ${current.workId} runs directly on ${targetBranch}; exact delivery revision ${directTarget.expectedHead} is reachable from current target ${directTarget.targetHead}, so no self-merge or target-branch deletion is required.`,
        detailLevel: 'summary',
      });
    }
  }

  if (wants.merge && current.finalization.merge === 'pending') {
    const mergeValidated = validateWorkHandle(ctx.controllerHome, current, identity, 'full', 'finalize');
    if (mergeValidated.currentHead && mergeValidated.currentHead !== current.expectedHead) {
      current = transact('merge-adopt-work-delivery-head', (fresh) => writeWorkHandle(ctx.controllerHome, {
        ...fresh,
        expectedHead: mergeValidated.currentHead,
        failureReason: undefined,
      }));
    }
    const contract = contractFor(ctx, current);
    if (contract?.constraints.allowMerge === false) throw new Error('WORK_MERGE_NOT_ALLOWED: WorkContract disallows merge');
    if (!contract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
    // Re-read the exact Work candidate immediately before any merge-path mutation
    // (including target-advance rebase). The finalizer is an independent physical
    // gate; semantic finalize authority is not trusted as a cached boolean.
    assertPhysicalImplementationReviewGate({
      ctx, repository: mergeValidated.worktreeRepository, handle: current, contract,
    });
    const target = selectWorkFinalizationTarget(getRepository(current.repositoryId, ctx.controllerHome), current);
    const deleteAfterWorktreeCleanup = current.managedWorktree && deleteBranchRequested;
    const targetBranch = explicitTargetBranch ?? target.defaultBranch ?? 'main';
    const activeMergeHead = retryStage === 'merge' ? gitRevision(target.canonicalRoot, 'MERGE_HEAD') : undefined;
    if (!activeMergeHead && current.managedWorktree && current.expectedHead) {
      const targetHead = gitRevision(target.canonicalRoot, targetBranch);
      if (targetHead) {
        const advance = inspectWorkTargetAdvance(mergeValidated.worktreeRepository.canonicalRoot, current.expectedHead, targetHead);
        if (advance.relation === 'diverged_conflict') {
          if (contract) {
            transitionWorkContractPhase(
              { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
              contract.workId,
              {
                phase: 'delivery',
                status: 'blocked',
                state: 'blocked',
                summary: `Target branch ${targetBranch} advanced to ${advance.targetHead} and conflicts with candidate ${advance.candidateHead}; canonical target was not mutated.`,
              },
            );
          }
          return {
            work: compactHandle(current),
            stages: current.finalization,
            completed: false,
            blocked: true,
            recoverable: true,
            error: {
              code: 'WORK_TARGET_ADVANCE_CONFLICT',
              message: `Target branch ${targetBranch} advanced and cannot be integrated cleanly into the isolated Work candidate. Canonical target was left unchanged.${advance.detail ? ` ${advance.detail}` : ''}`,
            },
            continuation: 'WORK_TARGET_ADVANCE_REVIEW_REQUIRED: inspect the target/candidate conflict, repair only inside the managed Work checkout, then revalidate before retrying finalize.',
          };
        }
        if (advance.relation === 'candidate_contains_target') {
          const nonLinearCommits = targetAdvanceLinearMergeCommits(
            mergeValidated.worktreeRepository.canonicalRoot,
            advance.targetHead,
            advance.candidateHead,
          );
          if (nonLinearCommits.length > 0) {
            return failStage('merge', `WORK_TARGET_ADVANCE_LINEAR_HISTORY_VIOLATION: candidate already contains merge commit(s) above reconciled target ${advance.targetHead}: ${nonLinearCommits.slice(0, 8).join(', ')}`);
          }
          const scopeViolation = targetAdvanceWorkScopeViolation(contract, advance.candidateChangedPaths);
          if (scopeViolation) {
            return failStage('merge', `WORK_TARGET_ADVANCE_SCOPE_VIOLATION: Work-owned ${scopeViolation.kind} path ${scopeViolation.path}`);
          }
          if (contract) replaceTargetAdvanceScopeEvidence(ctx, contract, advance.candidateChangedPaths);
          current = transact('target-advance-provenance-confirmed', (fresh) => writeWorkHandle(ctx.controllerHome, {
            ...fresh,
            deliveryBaseCommit: advance.targetHead,
          }));
        }
        if (advance.relation === 'diverged_clean') {
          const preIntegrationScopeViolation = targetAdvanceWorkScopeViolation(contract, advance.candidateChangedPaths);
          if (preIntegrationScopeViolation) {
            return failStage('merge', `WORK_TARGET_ADVANCE_SCOPE_VIOLATION: Work-owned ${preIntegrationScopeViolation.kind} path ${preIntegrationScopeViolation.path}`);
          }
          const checks = contract?.checks ?? [];
          const candidateInput = currentWorkValidationInput(mergeValidated.worktreeRepository, current, checks);
          const checksBefore = checks.length > 0 ? listControllerChecks(mergeValidated.worktreeRepository.canonicalRoot) : [];
          const integrated = repositoryGitRebaseOnto(ctx.controllerHome, mergeValidated.worktreeRepository, {
            onto: advance.targetHead,
            upstream: advance.mergeBase,
            abortOnFailure: true,
            authorizationDecision: gitAuthorization,
            sessionId: session.sessionId,
            principalId: session.principalId,
            workId: current.workId,
            goalId: current.goalId,
          });
          if (!integrated.rebased) {
            if (contract) {
              transitionWorkContractPhase(
                { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
                contract.workId,
                {
                  phase: 'delivery',
                  status: 'blocked',
                  state: 'blocked',
                  summary: `Linear target-advance integration failed inside the isolated Work checkout; canonical ${targetBranch} was not mutated.`,
                },
              );
            }
            return {
              work: compactHandle(current),
              stages: current.finalization,
              completed: false,
              blocked: true,
              recoverable: integrated.restored,
              error: {
                code: 'WORK_TARGET_ADVANCE_LINEAR_INTEGRATION_FAILED',
                message: integrated.restored
                  ? 'Target advancement could not be rebased safely; the isolated Work checkout was restored to its original candidate HEAD.'
                  : 'Target advancement rebase failed and exact checkout restoration could not be proven; inspect the isolated Work checkout before retrying.',
              },
              continuation: 'WORK_TARGET_ADVANCE_REVIEW_REQUIRED: inspect the isolated Work checkout and retry only after its exact branch/HEAD/cleanliness are proven.',
            };
          }
          const integratedHead = gitHead(mergeValidated.worktreeRepository.canonicalRoot);
          if (!integratedHead || !gitIsAncestor(mergeValidated.worktreeRepository.canonicalRoot, advance.targetHead, integratedHead)) {
            return failStage('merge', `WORK_TARGET_ADVANCE_LINEAR_ANCESTRY_MISMATCH: target ${advance.targetHead} is not an ancestor of ${integratedHead ?? 'unavailable'}`);
          }
          const mergeCommits = targetAdvanceLinearMergeCommits(
            mergeValidated.worktreeRepository.canonicalRoot,
            advance.targetHead,
            integratedHead,
          );
          const integratedTree = spawnSync('git', ['-C', mergeValidated.worktreeRepository.canonicalRoot, 'rev-parse', '--verify', `${integratedHead}^{tree}`], {
            encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
          });
          if (mergeCommits.length > 0) {
            return failStage('merge', `WORK_TARGET_ADVANCE_LINEAR_HISTORY_VIOLATION: integrated candidate contains merge commit(s): ${mergeCommits.slice(0, 8).join(', ')}`);
          }
          if (
            !advance.mergedTree
            || integratedTree.status !== 0
            || integratedTree.error
            || typeof integratedTree.stdout !== 'string'
            || integratedTree.stdout.trim() !== advance.mergedTree
          ) {
            return failStage('merge', `WORK_TARGET_ADVANCE_LINEAR_TREE_MISMATCH: rebased candidate tree does not equal the preflight clean integration tree ${advance.mergedTree ?? 'unavailable'}`);
          }
          const workOwnedChangedPaths = gitChangedPaths(mergeValidated.worktreeRepository.canonicalRoot, advance.targetHead, integratedHead);
          const postIntegrationScopeViolation = targetAdvanceWorkScopeViolation(contract, workOwnedChangedPaths);
          if (postIntegrationScopeViolation) {
            return failStage('merge', `WORK_TARGET_ADVANCE_SCOPE_VIOLATION: integrated Work-owned ${postIntegrationScopeViolation.kind} path ${postIntegrationScopeViolation.path}`);
          }
          const integratedInput = currentWorkValidationInput(
            mergeValidated.worktreeRepository,
            { ...current, expectedHead: integratedHead },
            checks,
          );
          const checksAfter = checks.length > 0 ? listControllerChecks(mergeValidated.worktreeRepository.canonicalRoot) : [];
          const transferPlan = contract
            ? planTargetAdvanceValidationAuthority({
                checkIds: checks,
                checkRefs: contract.checkRefs,
                checksBefore,
                checksAfter,
                candidateHead: advance.candidateHead,
                candidateWorkspaceFingerprint: candidateInput.workspaceFingerprint,
                integratedHead,
                integratedWorkspaceFingerprint: integratedInput.workspaceFingerprint,
                targetChangedPaths: advance.targetChangedPaths,
              })
            : { transferredRecords: [], reusableCheckIds: [], invalidatedCheckIds: checks };
          for (const record of transferPlan.transferredRecords) {
            appendVerificationRecord({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, record);
          }
          if (contract) replaceTargetAdvanceScopeEvidence(ctx, contract, workOwnedChangedPaths);
          const validationPreserved = transferPlan.invalidatedCheckIds.length === 0;
          current = transact('target-advance-integrated', (fresh) => transitionWorkHandle(
            ctx.controllerHome,
            fresh,
            validationPreserved ? 'committed' : 'validating',
            {
              deliveryBaseCommit: advance.targetHead,
              expectedHead: integratedHead,
              failureReason: undefined,
              finalization: { ...fresh.finalization, validation: validationPreserved ? 'done' : 'pending', merge: 'pending', lastError: undefined },
              validationRun: undefined,
              validatedInputFingerprint: validationPreserved ? integratedInput.fingerprint : undefined,
            },
          ));
          appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
            title: 'target advancement linearly integrated into isolated Work candidate',
            summary: `Canonical ${targetBranch} at ${advance.targetHead} advanced independently. Forge rebased Work candidate ${advance.candidateHead} onto it as ${integratedHead} with no merge commits; Work scope is ${workOwnedChangedPaths.length} target-relative path(s). Validation authority transferred for ${transferPlan.reusableCheckIds.length}/${checks.length} check(s); ${transferPlan.invalidatedCheckIds.length} check(s) require fresh evidence.`,
            detailLevel: 'summary',
          });
          if (!validationPreserved) {
            markWorkValidationPending(ctx.controllerHome, current);
            return {
              work: compactHandle(current),
              stages: current.finalization,
              completed: false,
              continuation: `WORK_COMMITTED_REVALIDATION_REQUIRED: target branch ${targetBranch} changed inputs for [${transferPlan.invalidatedCheckIds.join(', ')}]; unaffected check evidence was transferred to ${integratedHead} and may be reused`,
            };
          }
          projectWorkValidationOutcome(ctx.controllerHome, current, 'passed', checks.length === 0
            ? 'Target advancement was linearly integrated and no validation checks were required.'
            : `Target advancement was linearly integrated; all ${checks.length} check result(s) retained authority because target-only changes did not affect their declared inputs.`);
        }
      }
    }
    const deliveryContract = contractFor(ctx, current);
    if (!deliveryContract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
    try {
      const deliveryRepository = selectRepositoryCheckout(
        getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true }),
        current.checkoutId,
        { allowArchived: true },
      );
      assertPhysicalImplementationReviewGate({
        ctx, repository: deliveryRepository, handle: current, contract: deliveryContract,
      });
    } catch (error) {
      return {
        work: compactHandle(current),
        stages: current.finalization,
        completed: false,
        blocked: true,
        recoverable: true,
        error: {
          code: 'WORK_IMPLEMENTATION_REVIEW_REQUIRED',
          message: error instanceof Error ? error.message : String(error),
        },
        continuation: 'WORK_IMPLEMENTATION_REVIEW_REQUIRED: target integration changed the Work delivery candidate; verify/review the exact current candidate before mutating the canonical target.',
      };
    }
    let merged: ReturnType<typeof repositoryGitFinishWorkflow>;
    if (activeMergeHead) {
      const expectedMergeHead = current.expectedHead ? gitRevision(target.canonicalRoot, current.expectedHead) : undefined;
      const featureHead = gitRevision(target.canonicalRoot, current.branch);
      const currentBranchResult = spawnSync('git', ['-C', target.canonicalRoot, 'branch', '--show-current'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      });
      const currentBranchName = currentBranchResult.status === 0 && typeof currentBranchResult.stdout === 'string'
        ? currentBranchResult.stdout.trim()
        : '';
      if (!expectedMergeHead || activeMergeHead !== expectedMergeHead || featureHead !== expectedMergeHead || currentBranchName !== targetBranch) {
        return failStage(
          'merge',
          `WORK_MERGE_HEAD_OWNERSHIP_MISMATCH: retry may conclude only Work ${current.workId} merge head ${expectedMergeHead ?? 'unavailable'} from ${current.branch} while on ${targetBranch}; observed MERGE_HEAD ${activeMergeHead}, feature ${featureHead ?? 'unavailable'}, branch ${currentBranchName || 'unavailable'}`,
        );
      }
      const unmerged = spawnSync('git', ['-C', target.canonicalRoot, 'diff', '--name-only', '--diff-filter=U'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      });
      if (unmerged.status !== 0 || unmerged.error || typeof unmerged.stdout !== 'string') {
        return failStage('merge', 'WORK_MERGE_CONFLICT_STATE_UNAVAILABLE: unable to prove that the owned merge has no unmerged paths');
      }
      if (unmerged.stdout.trim()) {
        return failStage('merge', `WORK_MERGE_CONFLICTS_UNRESOLVED: resolve and stage all paths before retrying finalize (${unmerged.stdout.trim().split('\n').filter(Boolean).join(', ')})`);
      }
      const beforeConclude = repositoryGitStatus(target);
      const concluded = repositoryGitCommit(ctx.controllerHome, target, {
        message: `Merge ${current.branch} into ${targetBranch}`,
        allowEmpty: true,
        authorizationDecision: gitAuthorization,
        sessionId: session.sessionId,
        principalId: session.principalId,
        workId: current.workId,
        goalId: current.goalId,
      });
      if (!concluded.committed || !concluded.commit) {
        return failStage('merge', concluded.error?.message ?? 'WORK_MERGE_CONCLUDE_FAILED: git commit did not conclude the owned merge');
      }
      const concludedSecondParent = gitRevision(target.canonicalRoot, 'HEAD^2');
      if (concludedSecondParent !== expectedMergeHead || gitRevision(target.canonicalRoot, 'MERGE_HEAD')) {
        return failStage('merge', `WORK_MERGE_CONCLUSION_OWNERSHIP_MISMATCH: concluded merge must retain ${expectedMergeHead} as its second parent and clear MERGE_HEAD`);
      }
      const steps: ReturnType<typeof repositoryGitFinishWorkflow>['steps'] = [{ name: 'conclude_owned_merge', execution: concluded.commit }];
      if (!deleteAfterWorktreeCleanup && deleteBranchRequested) {
        const deleted = repositoryGitDeleteBranch(ctx.controllerHome, target, { branch: current.branch, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
        steps.push({ name: 'delete_feature_branch', execution: deleted.execution });
        if (deleted.execution.status !== 'executed' || deleted.execution.ok !== true) {
          return failStage('merge', deleted.execution.stderr || 'WORK_MERGE_BRANCH_CLEANUP_FAILED: owned merge concluded but feature branch deletion failed');
        }
      }
      merged = {
        repoId: target.repoId,
        checkoutId: target.activeCheckoutId,
        featureBranch: current.branch,
        targetBranch,
        before: beforeConclude,
        steps,
        after: repositoryGitStatus(target),
        completed: true,
      };
      appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
        title: 'owned resolved merge concluded',
        summary: `Finalizer retry proved MERGE_HEAD ${activeMergeHead} belongs to the exact Work delivery head, found no unmerged paths, and concluded the existing merge instead of replaying git merge.`,
        detailLevel: 'summary',
      });
    } else {
      const integrationLockKey = { scope: 'task' as const, repoId: current.repositoryId, taskId: `target-integration:${targetBranch}` };
      try {
        merged = withControllerLock(
          ctx.controllerHome,
          integrationLockKey,
          `work-finalize-target:${current.workId}`,
          () => {
            const lockedTargetStatus = repositoryGitStatus(target);
            const lockedDirtyPaths = [...new Set([
              ...lockedTargetStatus.staged,
              ...lockedTargetStatus.unstaged,
              ...lockedTargetStatus.untracked,
            ])].sort();
            let preserveDirtyTargetPaths: string[] | undefined;
            if (lockedDirtyPaths.length > 0) {
              const ownership = inspectTargetDirtyWorkOwnership({
                dirtyPaths: lockedDirtyPaths,
                targetCheckoutId: target.activeCheckoutId,
                currentWorkId: current.workId,
                activeWorks: listWorkContracts({ controllerHome: ctx.controllerHome, repoId: current.repositoryId, status: 'active', limit: 200 }),
              });
              if (!ownership.owned) {
                const detail = [
                  ownership.unownedPaths.length ? `unowned=[${ownership.unownedPaths.join(', ')}]` : '',
                  ownership.ambiguousPaths.length ? `ambiguous=[${ownership.ambiguousPaths.join(', ')}]` : '',
                ].filter(Boolean).join(' ');
                throw new Error(`WORK_TARGET_DIRTY_OWNERSHIP_REQUIRED: target ${targetBranch} has dirty path(s) that cannot be attributed uniquely to another active Work. ${detail}`.trim());
              }
              preserveDirtyTargetPaths = ownership.dirtyPaths;
              appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, current.workContractId ?? current.workId, {
                title: 'concurrent target dirty ownership preserved',
                summary: `Target ${targetBranch} retained ${ownership.dirtyPaths.length} dirty path(s) owned by other active Work while this Work entered only the target-branch mutation critical section.`,
                detailLevel: 'summary',
              });
            }
            return repositoryGitFinishWorkflow(ctx.controllerHome, target, {
              featureBranch: current.branch,
              targetBranch: explicitTargetBranch,
              deleteBranch: !deleteAfterWorktreeCleanup && deleteBranchRequested,
              noFf: args.no_ff === true,
              preserveDirtyTargetPaths,
              authorizationDecision: gitAuthorization,
              sessionId: session.sessionId,
              principalId: session.principalId,
              workId: current.workId,
              goalId: current.goalId,
            });
          },
          30_000,
          5_000,
        );
      } catch (error) {
        return failStage('merge', error instanceof Error ? error.message : String(error));
      }
    }
    const pendingAuthorization = merged.steps.find((step) => step.execution.authorizationDecision?.decision === 'user_confirmation_required')?.execution.authorizationDecision;
    if (pendingAuthorization) return { authorization: pendingAuthorization, work: compactHandle(current), stages: current.finalization };
    if (!merged.completed) return { ...failStage('merge', merged.error?.message ?? 'merge failed'), merge: merged };
    current = transact('merge-done', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'merged', {
      finalization: { ...fresh.finalization, merge: 'done', branchCleanup: !deleteBranchRequested ? 'skipped' : deleteAfterWorktreeCleanup ? 'pending' : 'done', lastError: undefined },
      failureReason: undefined,
    }));
  } else if (!wants.merge && current.finalization.merge === 'pending') {
    current = transact('merge-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, {
      ...fresh,
      finalization: {
        ...fresh.finalization,
        merge: 'skipped',
        branchCleanup: requestedOutcome === 'completed_no_change' && wants.cleanup && deleteBranchRequested ? 'pending' : 'skipped',
      },
    }));
  }

  let remoteDelivery: WorkRemoteDeliveryReceipt | undefined;
  const remoteDeliveryRequired = args.remote_write === true
    || contractFor(ctx, current)?.constraints.remoteDeliveryRequired === true;
  if (remoteDeliveryRequired && requestedOutcome !== 'completed_no_change') {
    const repository = getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true });
    const target = selectWorkFinalizationTarget(repository, current);
    const targetBranch = explicitTargetBranch ?? repository.defaultBranch ?? 'main';
    const targetRevision = gitRevision(target.canonicalRoot, targetBranch);
    if (!targetRevision) throw new Error(`WORK_REMOTE_DELIVERY_TARGET_REQUIRED: target branch ${targetBranch} is unavailable`);
    const authorityRepository = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true });
    const remoteDeliveryContract = contractFor(ctx, current);
    if (!remoteDeliveryContract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
    assertPhysicalImplementationReviewGate({
      ctx, repository: authorityRepository, handle: current, contract: remoteDeliveryContract,
    });
    remoteDelivery = await pushExactWorkRemoteDelivery({
      controllerHome: ctx.controllerHome,
      repository: authorityRepository,
      workId: current.workId,
      targetBranch,
      targetRevision,
    });
    appendWorkEvidence(
      { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
      current.workContractId ?? current.workId,
      {
        title: 'remote delivery verified before Work terminalization',
        summary: remoteDelivery.pushed
          ? `Exact integrated revision ${remoteDelivery.targetRevision} was pushed to origin/${targetBranch} while Work ${current.workId} still held active delivery authority.`
          : `origin/${targetBranch} already contained exact integrated revision ${remoteDelivery.targetRevision}; remote delivery was verified idempotently before Work terminalization.`,
        detailLevel: 'summary',
      },
    );
  }

  if (
    requestedOutcome === 'completed_no_change'
    && current.finalization.validation === 'done'
    && current.finalization.commit === 'skipped'
    && current.finalization.merge === 'skipped'
    && current.state !== 'merged'
    && current.state !== 'cleaned'
  ) {
    // `merged` is the WorkHandle's durable integrated-delivery boundary. A
    // no-change completion has no Git merge, but it must cross that boundary
    // before physical cleanup so an earlier failure preserves retryability.
    if (current.state === 'prepared') {
      current = transact('no-change-validation-state', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'validating', {
        finalization: fresh.finalization,
        failureReason: undefined,
      }));
    }
    if (current.state === 'editing' || current.state === 'validating' || current.state === 'committed') {
      current = transact('no-change-delivery-integrated', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, 'merged', {
        finalization: fresh.finalization,
        failureReason: undefined,
      }));
    } else if (current.state !== 'merged') {
      throw new Error(`WORK_NO_CHANGE_DELIVERY_STATE_INVALID: cannot establish no-change delivery from ${current.state}`);
    }
  }

  if (wants.cleanup && current.finalization.worktreeCleanup === 'pending') {
    const contract = contractFor(ctx, current);
    if (contract?.constraints.allowCleanup === false) throw new Error('WORK_CLEANUP_NOT_ALLOWED: WorkContract disallows cleanup');
    if (!current.managedWorktree) {
      current = transact('worktree-cleanup-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, worktreeCleanup: 'skipped' } }));
    } else {
      const cleanupContract = contractFor(ctx, current);
      if (!cleanupContract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
      if (cleanupContract.status !== 'cancelled' && cleanupContract.status !== 'failed') {
        const cleanupRepository = selectRepositoryCheckout(
          getRepository(current.repositoryId, ctx.controllerHome, { includeRemoved: true }),
          current.checkoutId,
          { allowArchived: true },
        );
        assertPhysicalImplementationReviewGate({
          ctx, repository: cleanupRepository, handle: current, contract: cleanupContract,
        });
      }
      const target = selectWorkFinalizationTarget(getRepository(current.repositoryId, ctx.controllerHome), current);
      const cleanup = runCleanup(target.canonicalRoot, current.worktreePath);
      if (!cleanup.ok) return failStage('worktreeCleanup', cleanup.message ?? 'worktree cleanup failed');
      current = transact('worktree-cleanup-done', (fresh) => {
        setRepositoryCheckoutLifecycle({ controllerHome: ctx.controllerHome, repoId: fresh.repositoryId, checkoutId: fresh.checkoutId, lifecycle: 'removed', reason: `Work ${fresh.workId} cleanup completed.` });
        markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:worktree`);
        return writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, worktreeCleanup: 'done', lastError: undefined } });
      });
    }
  } else if (!wants.cleanup && current.finalization.worktreeCleanup === 'pending') {
    current = transact('worktree-cleanup-skipped', (fresh) => writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, worktreeCleanup: 'skipped' } }));
  }

  if (
    wants.cleanup
    && current.finalization.branchCleanup === 'pending'
    && (current.finalization.merge === 'done' || requestedOutcome === 'completed_no_change')
  ) {
    const target = selectWorkFinalizationTarget(getRepository(current.repositoryId, ctx.controllerHome), current);
    const branchCleanupContract = contractFor(ctx, current);
    if (!branchCleanupContract) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${current.workId}`);
    if (branchCleanupContract.status !== 'cancelled' && branchCleanupContract.status !== 'failed') {
      assertPhysicalBranchCleanupImplementationReviewGate({ target, handle: current, contract: branchCleanupContract });
    }
    const deleted = repositoryGitDeleteBranch(ctx.controllerHome, target, { branch: current.branch, force: false, authorizationDecision: gitAuthorization, sessionId: session.sessionId, principalId: session.principalId, workId: current.workId, goalId: current.goalId });
    if (deleted.execution.authorizationDecision?.decision === 'user_confirmation_required') return { authorization: deleted.execution.authorizationDecision, work: compactHandle(current), stages: current.finalization };
    if (deleted.execution.status !== 'executed' || deleted.execution.ok !== true) return failStage('branchCleanup', deleted.execution.stderr || 'feature branch cleanup failed');
    current = transact('branch-cleanup-done', (fresh) => {
      markRepositoryProjectionDirty(ctx.controllerHome, fresh.repositoryId, `cleanup:${fresh.workId}:branch`);
      return writeWorkHandle(ctx.controllerHome, { ...fresh, finalization: { ...fresh.finalization, branchCleanup: 'done', lastError: undefined } });
    });
  }

  const complete = finalizationComplete(current.finalization);
  if (complete) {
    const finalState = finalStateForStages(current.finalization, current.state);
    current = transact('complete', (fresh) => transitionWorkHandle(ctx.controllerHome, fresh, finalState, { finalization: current.finalization, failureReason: undefined }));
    const completedContract = contractFor(ctx, current);
    if (completedContract?.status === 'cancelled') {
      appendWorkEvidence(
        { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
        completedContract.workId,
        {
          title: 'cancelled work cleanup completed',
          summary: 'Controller verified terminal ownership, a clean or previously removed managed worktree, and a branch HEAD already contained in the target branch before deleting retained workspace references.',
          detailLevel: 'summary',
        },
      );
    } else {
      const workId = current.workContractId ?? current.workId;
      const completionContract = contractFor(ctx, current);
      if (!completionContract) throw new Error(`WORK_COMPLETION_CONTRACT_MISSING: ${workId}`);
      if (requestedOutcome === 'completed_no_change') {
        appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: current.repositoryId }, workId, {
          title: 'objective-specific no-change proof',
          summary: noChangeProof,
          detailLevel: 'summary',
        });
      }
      const receipt = completionReceiptForFinalizedWork(ctx, current, completionContract, args);
      const ownerPrincipal = terminalizationOwner.principalId?.trim() || terminalizationOwner.controllerId;
      const ownerInstanceId = terminalizationOwner.controllerInstanceId?.trim() || '';
      const ownerClaimGeneration = terminalizationOwner.claimGeneration;
      if (!ownerInstanceId || typeof ownerClaimGeneration !== 'number' || ownerClaimGeneration < 1) {
        throw new Error(`WORK_CONTROLLER_TERMINALIZATION_AUTHORITY_INVALID: ${workId}`);
      }
      const fencedCompletion = withControllerSessionTerminalizationFence(
        { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
        {
          workId,
          actor: `work-finalize-completion:${terminalizationOwner.controllerId}:${ownerInstanceId}`,
          authority: {
            controllerId: terminalizationOwner.controllerId,
            controllerType: terminalizationOwner.controllerType,
            principalId: ownerPrincipal,
            controllerInstanceId: ownerInstanceId,
            claimGeneration: ownerClaimGeneration,
          },
        },
        () => completeWorkWithReceipt(
          { controllerHome: ctx.controllerHome, repoId: current.repositoryId },
          workId,
          receipt,
          requestedOutcome === 'completed_no_change' ? 'completed_no_change' : 'completed_changed',
          requestedOutcome === 'completed_no_change' ? 'completed_no_change' : 'repository_change',
        ),
      );
      if (!fencedCompletion.allowed) {
        throw new Error(`WORK_TERMINALIZATION_AUTHORITY_FENCED: ${workId}:${fencedCompletion.reason}`);
      }
    }
    // Successful WorkContract completion always ends controller ownership.
    // Physical branch/worktree retention is represented by finalization stages
    // and completion-receipt warnings; it must not keep a mutation owner live.
    releasePreparedWorkOwnership(ctx, current);
    updateExecutionSession(ctx.controllerHome, identity, {
      activeWorkId: undefined,
      activeCheckoutId: current.sourceCheckoutId ?? session.activeCheckoutId,
    });
  }
  return { work: compactHandle(current), stages: current.finalization, completed: complete, ...(remoteDelivery ? { remoteDelivery } : {}), idempotent: !wants.commit && !wants.merge && !wants.cleanup && current.finalization.validation === 'done' };
}

// WORK_FINALIZATION_SERVICE_END
