import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { listRepositories, repositoryCheckoutLifecycle, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { getControllerSession } from '../../../../packages/kernel/controller/api/index';
import { getWorkContract, resumeRetainedCancelledWorkContract, transitionWorkContractPhase, updateWorkContract } from '../../../../packages/kernel/work/api/index';
import { gitCommitAtRef, gitWorktreeSnapshot } from './work-lifecycle-audit';
import { findWorkPathScopeViolation } from './work-path-scope';
import { readWorkHandle, writeWorkHandle, type WorkHandleState } from './work-handle-store';

export interface RetainedWorkResumeIdentity {
  principalId: string;
  sessionId: string;
  controllerInstanceId: string;
}

export interface ReauthorizeRetainedCancelledWorkInput {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  identity: RetainedWorkResumeIdentity;
  requestedBy?: string;
  approvalConfirmed?: boolean;
  prepareDependencies?: boolean;
}

export interface EnsureRunningRepositoryWorkCheckoutInput {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  identity: RetainedWorkResumeIdentity;
  prepareDependencies?: boolean;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(root: string, args: string[], timeoutMs = 30_000): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

function normalizedPaths(value: readonly string[]): string[] {
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function restoreArchivedBlockedDeliveryCheckout(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  work: NonNullable<ReturnType<typeof getWorkContract>>;
  handle: WorkHandleState;
  identity: RetainedWorkResumeIdentity;
  prepareDependencies?: boolean;
}): { reconstructedCheckout: boolean } | undefined {
  const { controllerHome, repository, work, handle, identity } = input;
  const receipt = handle.cleanupReceipt;
  if (handle.state !== 'cleaned' || receipt?.terminalOutcome !== 'blocked_terminal') return undefined;
  if (work.completionReceipt || work.completionOutcome || work.status !== 'blocked' || work.phase !== 'delivery') {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_LIFECYCLE_CONFLICT: ${work.workId}`);
  }
  if (!['none', 'partial', 'valid', 'stale'].includes(work.evidenceState)) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_EVIDENCE_CONFLICT: ${work.workId}:${work.evidenceState}`);
  }
  if (!receipt.complete
    || receipt.partial
    || receipt.blockers.length > 0
    || receipt.branchCleanup.status !== 'archived'
    || (receipt.branchCleanup.uniqueCommits ?? 0) < 1
    || !['removed', 'already_removed'].includes(receipt.worktree.status)
    || !['removed', 'already_removed'].includes(receipt.checkoutRegistry.status)
    || handle.finalization.validation !== 'done'
    || handle.finalization.commit !== 'done'
    || handle.finalization.merge !== 'failed') {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_EVIDENCE_INCOMPLETE: ${work.workId}`);
  }
  if (receipt.workId !== work.workId || receipt.repoId !== repository.repoId || receipt.branch !== handle.branch) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_IDENTITY_MISMATCH: ${work.workId}`);
  }
  if (handle.principalId !== identity.principalId) {
    throw new Error(`WORK_CONTINUE_HANDLE_PRINCIPAL_MISMATCH: ${work.workId}`);
  }
  const candidateRevision = handle.expectedHead?.trim();
  const baseRevisionRaw = work.baseRevision?.trim() || handle.baseCommit?.trim();
  const targetBranch = receipt.targetBranch?.trim();
  const bundlePath = receipt.preservation.bundlePath?.trim();
  const bundleSha256 = receipt.preservation.bundleSha256?.trim();
  if (!candidateRevision || !baseRevisionRaw || !targetBranch || !bundlePath || !bundleSha256) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_AUTHORITY_REQUIRED: ${work.workId}`);
  }
  if (handle.deliveryTargetBranch?.trim() && handle.deliveryTargetBranch.trim() !== targetBranch) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_TARGET_MISMATCH: ${work.workId}`);
  }
  const expectedBundlePath = resolve(join(
    repositoryControllerRoot(controllerHome, repository.repoId),
    'cleanup-artifacts',
    work.workId,
    'branch.bundle',
  ));
  if (resolve(bundlePath) !== expectedBundlePath || !existsSync(bundlePath)) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_BUNDLE_PATH_INVALID: ${work.workId}`);
  }
  const actualBundleSha256 = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
  if (actualBundleSha256 !== bundleSha256) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_BUNDLE_DIGEST_MISMATCH: ${work.workId}`);
  }
  const verified = git(repository.canonicalRoot, ['bundle', 'verify', bundlePath], 60_000);
  if (!verified.ok) throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_BUNDLE_INVALID: ${work.workId}: ${verified.stderr}`);
  const heads = git(repository.canonicalRoot, ['bundle', 'list-heads', bundlePath]);
  if (!heads.ok) throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_BUNDLE_HEADS_UNAVAILABLE: ${work.workId}`);
  const archivedRef = `refs/heads/${handle.branch}`;
  const archivedHead = heads.stdout.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 2))
    .find(([, ref]) => ref === archivedRef)?.[0];
  if (!archivedHead || archivedHead !== candidateRevision) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_BUNDLE_HEAD_MISMATCH: ${work.workId}`);
  }

  let candidateCommit = gitCommitAtRef(repository.canonicalRoot, candidateRevision);
  if (!candidateCommit) {
    const fetched = git(repository.canonicalRoot, ['fetch', '--no-write-fetch-head', bundlePath, archivedRef], 60_000);
    if (!fetched.ok) throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_IMPORT_FAILED: ${work.workId}: ${fetched.stderr}`);
    candidateCommit = gitCommitAtRef(repository.canonicalRoot, candidateRevision);
  }
  if (candidateCommit !== candidateRevision) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_CANDIDATE_MISSING: ${work.workId}`);
  }
  const baseRevision = gitCommitAtRef(repository.canonicalRoot, baseRevisionRaw);
  if (!baseRevision) throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_BASE_MISSING: ${work.workId}`);
  if (git(repository.canonicalRoot, ['merge-base', '--is-ancestor', candidateRevision, targetBranch]).ok) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_ALREADY_INTEGRATED: ${work.workId}`);
  }
  const changed = git(repository.canonicalRoot, ['diff', '--name-only', `${baseRevision}..${candidateRevision}`]);
  if (!changed.ok) throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_DIFF_UNAVAILABLE: ${work.workId}`);
  const changedPaths = normalizedPaths(changed.stdout.split(/\r?\n/));
  if (changedPaths.length === 0) throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_ZERO_DELTA: ${work.workId}`);
  const scopeViolation = findWorkPathScopeViolation(work, changedPaths);
  if (scopeViolation) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_SCOPE_VIOLATION: ${scopeViolation.kind}:${scopeViolation.path}`);
  }
  const recordedChangedPaths = normalizedPaths(work.scopeEvidence?.actualChangedPaths ?? []);
  if (recordedChangedPaths.length > 0 && JSON.stringify(recordedChangedPaths) !== JSON.stringify(changedPaths)) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_PATH_IDENTITY_MISMATCH: ${work.workId}`);
  }

  const branchName = `work/resume-archived-${work.workId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 34)}-${candidateRevision.slice(0, 12)}`;
  const existingResumeBranch = gitCommitAtRef(repository.canonicalRoot, `refs/heads/${branchName}`);
  if (existingResumeBranch && existingResumeBranch !== candidateRevision) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_RECONSTRUCTION_BRANCH_CONFLICT: ${work.workId}`);
  }
  const workspace = ensureManagedWorkspace(controllerHome, repository, {
    requestId: `${work.workId}:archived-delivery-recovery:${candidateRevision}`,
    title: `${work.objective} archived delivery recovery`,
    branchName,
    baseRef: candidateRevision,
    prepareDependencies: input.prepareDependencies === true,
  });
  if (!workspace.managed || !workspace.checkoutId || !workspace.root || !workspace.branch) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_RECONSTRUCTION_FAILED: ${work.workId}`);
  }
  const refreshedRepository = listRepositories(controllerHome, { includeRemoved: true })
    .find((candidate) => candidate.repoId === repository.repoId);
  if (!refreshedRepository) throw new Error(`WORK_CONTINUE_REPOSITORY_MISSING: ${work.workId}`);
  const reconstructed = selectRepositoryCheckout(refreshedRepository, workspace.checkoutId);
  const reconstructedStatus = repositoryGitStatus(reconstructed);
  if (!reconstructedStatus.clean || reconstructedStatus.head !== candidateRevision || reconstructedStatus.branch !== workspace.branch) {
    throw new Error(`WORK_CONTINUE_ARCHIVED_DELIVERY_RECONSTRUCTION_REVISION_MISMATCH: ${work.workId}`);
  }

  const at = new Date().toISOString();
  const store = { controllerHome, repoId: repository.repoId };
  updateWorkContract(store, work.workId, {
    checkoutId: workspace.checkoutId,
    worktreeRef: workspace.root,
    controllerInstanceId: identity.controllerInstanceId,
    continuationPrompt: `Continue work ${repository.repoId}: ${work.objective.slice(0, 500)}. Forge rehydrated exact archived candidate ${candidateRevision}; rerun verification/review before delivery.`,
  });
  transitionWorkContractPhase(store, work.workId, {
    phase: 'verification',
    status: 'running',
    state: 'active',
    summary: `Archived candidate ${candidateRevision} was rehydrated from verified blocked-terminal preservation; fresh verification is required before delivery.`,
  });
  if (work.evidenceState === 'partial' || work.evidenceState === 'valid') {
    updateWorkContract(store, work.workId, { evidenceState: 'stale' });
  }
  writeWorkHandle(controllerHome, {
    ...handle,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
    checkoutId: workspace.checkoutId,
    worktreePath: workspace.root,
    branch: workspace.branch,
    sourceCheckoutId: repository.activeCheckoutId,
    deliveryTargetBranch: handle.deliveryTargetBranch?.trim() || targetBranch,
    managedWorktree: true,
    baseCommit: baseRevision,
    deliveryBaseCommit: baseRevision,
    expectedHead: candidateRevision,
    state: 'validating',
    validatedInputFingerprint: undefined,
    failureReason: undefined,
    cleanupReceipt: undefined,
    finalization: { validation: 'pending', commit: 'done', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    updatedAt: at,
  });
  return { reconstructedCheckout: true };
}

/**
 * Re-establish the checkout binding for a still-running isolated Work only
 * when durable and Git evidence prove that the missing checkout carried no
 * repository delta. Any dirty, divergent, committed, or cleaned evidence
 * fails closed so recovery never becomes permission to discard source.
 */
export function ensureRunningRepositoryWorkCheckout(
  input: EnsureRunningRepositoryWorkCheckoutInput,
): { reconstructedCheckout: boolean } {
  const { controllerHome, repository, workId, identity } = input;
  const store = { controllerHome, repoId: repository.repoId };
  const work = getWorkContract(store, workId);
  if (!work || ['cancelled', 'completed', 'failed'].includes(work.status)) return { reconstructedCheckout: false };
  if (work.workKind !== 'repository_change' || work.worktreePolicy.required !== true) return { reconstructedCheckout: false };

  const recordedCheckoutId = work.checkoutId?.trim();
  const recordedWorktree = work.worktreeRef?.trim();
  if (!recordedCheckoutId || !recordedWorktree) return { reconstructedCheckout: false };

  const registryRepository = listRepositories(controllerHome, { includeRemoved: true })
    .find((candidate) => candidate.repoId === repository.repoId);
  if (!registryRepository) throw new Error(`WORK_CONTINUE_REPOSITORY_MISSING: ${workId}`);
  const checkoutRecord = registryRepository.checkouts.find((candidate) => candidate.checkoutId === recordedCheckoutId);
  const checkoutActive = checkoutRecord ? repositoryCheckoutLifecycle(checkoutRecord) === 'active' : false;
  const worktreePresent = existsSync(recordedWorktree);
  if (checkoutActive && worktreePresent) return { reconstructedCheckout: false };
  if (checkoutActive) throw new Error(`WORK_CONTINUE_CHECKOUT_PRESERVATION_AMBIGUOUS: ${workId}`);

  const handle = readWorkHandle(controllerHome, repository.repoId, workId);
  if (!handle) throw new Error(`WORK_CONTINUE_HANDLE_REQUIRED: ${workId}`);
  if (handle.repositoryId !== repository.repoId || (handle.workContractId && handle.workContractId !== workId)) {
    throw new Error(`WORK_CONTINUE_HANDLE_IDENTITY_MISMATCH: ${workId}`);
  }
  if (handle.principalId !== identity.principalId) throw new Error(`WORK_CONTINUE_HANDLE_PRINCIPAL_MISMATCH: ${workId}`);
  if (handle.checkoutId !== recordedCheckoutId || resolve(handle.worktreePath) !== resolve(recordedWorktree)) {
    throw new Error(`WORK_CONTINUE_CHECKOUT_OWNERSHIP_MISMATCH: ${workId}`);
  }
  const archivedDelivery = restoreArchivedBlockedDeliveryCheckout({
    controllerHome, repository, work, handle, identity, prepareDependencies: input.prepareDependencies,
  });
  if (archivedDelivery) return archivedDelivery;
  if (['committed', 'merged', 'cleaned', 'failed_terminal_cleanup'].includes(handle.state)
    || handle.finalization.commit === 'done'
    || handle.finalization.merge === 'done'
    || handle.cleanupReceipt?.complete === true) {
    throw new Error(`WORK_CONTINUE_DELIVERY_OR_CLEANUP_CONFLICT: ${workId}`);
  }

  const actualChangedPaths = work.scopeEvidence?.actualChangedPaths;
  if (!actualChangedPaths || actualChangedPaths.length !== 0
    || work.checks.length !== 0
    || work.checkRefs.length !== 0
    || work.evidenceState !== 'none') {
    throw new Error(`WORK_CONTINUE_ZERO_DELTA_PROOF_REQUIRED: ${workId}`);
  }
  const recordedBase = work.baseRevision?.trim();
  if (!recordedBase) throw new Error(`WORK_CONTINUE_BASE_REVISION_REQUIRED: ${workId}`);
  const baseRevision = gitCommitAtRef(repository.canonicalRoot, recordedBase);
  if (!baseRevision) throw new Error(`WORK_CONTINUE_BASE_REVISION_MISSING: ${workId}`);
  const handleBase = handle.baseCommit ? gitCommitAtRef(repository.canonicalRoot, handle.baseCommit) : undefined;
  const handleHead = handle.expectedHead ? gitCommitAtRef(repository.canonicalRoot, handle.expectedHead) : undefined;
  if ((handle.baseCommit && handleBase !== baseRevision) || (handle.expectedHead && handleHead !== baseRevision)) {
    throw new Error(`WORK_CONTINUE_REVISION_AMBIGUOUS: ${workId}`);
  }
  if (handle.branch) {
    const historicalBranchHead = gitCommitAtRef(repository.canonicalRoot, `refs/heads/${handle.branch}`);
    if (historicalBranchHead && historicalBranchHead !== baseRevision) {
      throw new Error(`WORK_CONTINUE_UNIQUE_COMMIT_CONFLICT: ${workId}`);
    }
  }
  if (worktreePresent) {
    const retainedSnapshot = gitWorktreeSnapshot(recordedWorktree);
    if (!retainedSnapshot || !retainedSnapshot.clean || retainedSnapshot.head !== baseRevision || (handle.branch && retainedSnapshot.branch !== handle.branch)) {
      throw new Error(`WORK_CONTINUE_ZERO_DELTA_PHYSICAL_CONFLICT: ${workId}`);
    }
  }

  const branchName = `work/resume-${workId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 42)}-${baseRevision.slice(0, 12)}`;
  const existingResumeBranch = gitCommitAtRef(repository.canonicalRoot, `refs/heads/${branchName}`);
  if (existingResumeBranch && existingResumeBranch !== baseRevision) {
    throw new Error(`WORK_CONTINUE_RECONSTRUCTION_BRANCH_CONFLICT: ${workId}`);
  }
  const workspace = ensureManagedWorkspace(controllerHome, repository, {
    requestId: `${workId}:active-checkout-recovery:${baseRevision}`,
    title: `${work.objective} checkout recovery`,
    branchName,
    baseRef: baseRevision,
    prepareDependencies: input.prepareDependencies === true,
  });
  if (!workspace.managed || !workspace.checkoutId || !workspace.root || !workspace.branch) {
    throw new Error(`WORK_CONTINUE_RECONSTRUCTION_FAILED: ${workId}`);
  }
  const refreshedRepository = listRepositories(controllerHome, { includeRemoved: true })
    .find((candidate) => candidate.repoId === repository.repoId);
  if (!refreshedRepository) throw new Error(`WORK_CONTINUE_REPOSITORY_MISSING: ${workId}`);
  const reconstructed = selectRepositoryCheckout(refreshedRepository, workspace.checkoutId);
  const reconstructedStatus = repositoryGitStatus(reconstructed);
  if (!reconstructedStatus.clean || reconstructedStatus.head !== baseRevision || reconstructedStatus.branch !== workspace.branch) {
    throw new Error(`WORK_CONTINUE_RECONSTRUCTION_REVISION_MISMATCH: ${workId}`);
  }

  updateWorkContract(store, workId, {
    checkoutId: workspace.checkoutId,
    worktreeRef: workspace.root,
    baseRevision,
    controllerInstanceId: identity.controllerInstanceId,
    continuationPrompt: `Continue work ${repository.repoId}: ${work.objective.slice(0, 500)}. The prior managed checkout was absent; Forge reconstructed an exact zero-delta checkout at ${baseRevision}.`,
  });
  const updatedAt = new Date().toISOString();
  writeWorkHandle(controllerHome, {
    ...handle,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
    checkoutId: workspace.checkoutId,
    worktreePath: workspace.root,
    branch: workspace.branch,
    sourceCheckoutId: repository.activeCheckoutId,
    managedWorktree: true,
    baseCommit: baseRevision,
    deliveryBaseCommit: baseRevision,
    expectedHead: baseRevision,
    state: 'prepared',
    validatedInputFingerprint: undefined,
    failureReason: undefined,
    cleanupReceipt: undefined,
    finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    updatedAt,
  });
  return { reconstructedCheckout: true };
}

/**
 * Canonical orchestration authority for explicitly re-authorizing the exact
 * retained cancelled repository Work. Transport adapters provide authenticated
 * identity and typed user intent only; they must not duplicate these lifecycle,
 * ownership, zero-delta, or reconstruction rules.
 */
export function reauthorizeRetainedCancelledRepositoryWork(
  input: ReauthorizeRetainedCancelledWorkInput,
): { reconstructedCheckout: boolean } {
  const { controllerHome, repository, workId, identity } = input;
  const store = { controllerHome, repoId: repository.repoId };
  let work = getWorkContract(store, workId);
  if (!work || work.status !== 'cancelled') return { reconstructedCheckout: false };
  if (input.approvalConfirmed !== true || input.requestedBy !== 'user') {
    throw new Error(`WORK_CANCELLED_RESUME_REAUTHORIZATION_REQUIRED: ${workId}; use exact work_id with requested_by=user and approval_confirmed=true`);
  }
  if (!work.principalId?.trim() || work.principalId.trim() !== identity.principalId) {
    throw new Error(`WORK_CANCELLED_RESUME_PRINCIPAL_MISMATCH: ${workId}`);
  }
  const owner = getControllerSession(store, workId);
  if (owner && (owner.principalId?.trim() || owner.controllerId) !== identity.principalId) {
    throw new Error(`WORK_CANCELLED_RESUME_CONTROLLER_OWNERSHIP_MISMATCH: ${workId}`);
  }
  if (work.completionReceipt || work.completionOutcome) throw new Error(`WORK_CANCELLED_RESUME_COMPLETION_CONFLICT: ${workId}`);
  if (work.reconciliations.length > 0) throw new Error(`WORK_CANCELLED_RESUME_DELIVERY_HISTORY_AMBIGUOUS: ${workId}`);
  if (work.phase !== 'cleanup' || work.phaseEvidence.cleanup.state !== 'skipped' || work.phaseEvidence.cleanup.source !== 'recorded') {
    throw new Error(`WORK_CANCELLED_RESUME_HISTORY_AMBIGUOUS: ${workId}`);
  }
  if (work.workKind !== 'repository_change' || work.worktreePolicy.required !== true) {
    throw new Error(`WORK_CANCELLED_RESUME_ISOLATED_REPOSITORY_WORK_REQUIRED: ${workId}`);
  }

  let handle = readWorkHandle(controllerHome, repository.repoId, workId);
  if (handle) {
    if (handle.repositoryId !== repository.repoId || (handle.workContractId && handle.workContractId !== workId)) {
      throw new Error(`WORK_CANCELLED_RESUME_HANDLE_IDENTITY_MISMATCH: ${workId}`);
    }
    if (handle.principalId !== identity.principalId) throw new Error(`WORK_CANCELLED_RESUME_HANDLE_PRINCIPAL_MISMATCH: ${workId}`);
    if (['committed', 'merged', 'cleaned', 'failed_terminal_cleanup'].includes(handle.state)
      || handle.finalization.commit === 'done'
      || handle.finalization.merge === 'done'
      || handle.cleanupReceipt?.complete === true) {
      throw new Error(`WORK_CANCELLED_RESUME_DELIVERY_OR_CLEANUP_CONFLICT: ${workId}`);
    }
  }

  const registryRepository = listRepositories(controllerHome, { includeRemoved: true })
    .find((candidate) => candidate.repoId === repository.repoId);
  if (!registryRepository) throw new Error(`WORK_CANCELLED_RESUME_REPOSITORY_MISSING: ${workId}`);
  const recordedCheckoutId = work.checkoutId?.trim();
  const recordedWorktree = work.worktreeRef?.trim();
  const checkoutRecord = recordedCheckoutId
    ? registryRepository.checkouts.find((candidate) => candidate.checkoutId === recordedCheckoutId)
    : undefined;
  const checkoutActive = checkoutRecord?.lifecycle === 'active';
  const worktreePresent = Boolean(recordedWorktree && existsSync(recordedWorktree));

  if (checkoutActive && worktreePresent && recordedCheckoutId && recordedWorktree) {
    const retained = selectRepositoryCheckout(registryRepository, recordedCheckoutId);
    if (resolve(retained.canonicalRoot) !== resolve(recordedWorktree)) {
      throw new Error(`WORK_CANCELLED_RESUME_CHECKOUT_REUSED: ${workId}`);
    }
    if (!handle) throw new Error(`WORK_CANCELLED_RESUME_HANDLE_REQUIRED: ${workId}`);
    if (handle.checkoutId !== recordedCheckoutId || resolve(handle.worktreePath) !== resolve(recordedWorktree)) {
      throw new Error(`WORK_CANCELLED_RESUME_CHECKOUT_OWNERSHIP_MISMATCH: ${workId}`);
    }
    const status = repositoryGitStatus(retained);
    if (!status.branch || status.branch !== handle.branch) throw new Error(`WORK_CANCELLED_RESUME_BRANCH_OWNERSHIP_MISMATCH: ${workId}`);
    writeWorkHandle(controllerHome, {
      ...handle,
      principalId: identity.principalId,
      sessionId: identity.sessionId,
      updatedAt: new Date().toISOString(),
    });
    resumeRetainedCancelledWorkContract(store, workId, {
      principalId: identity.principalId,
      controllerInstanceId: identity.controllerInstanceId,
      summary: 'Explicit current user re-authorized the same retained cancelled Work; exact managed checkout ownership was revalidated.',
    });
    return { reconstructedCheckout: false };
  }

  if (checkoutActive) throw new Error(`WORK_CANCELLED_RESUME_PRESERVATION_AMBIGUOUS: ${workId}`);
  if (!recordedCheckoutId || !recordedWorktree || !handle) throw new Error(`WORK_CANCELLED_RESUME_HANDLE_REQUIRED: ${workId}`);

  const actualChangedPaths = work.scopeEvidence?.actualChangedPaths;
  if (!actualChangedPaths || actualChangedPaths.length !== 0
    || work.checks.length !== 0
    || work.checkRefs.length !== 0
    || work.evidenceState !== 'none') {
    throw new Error(`WORK_CANCELLED_RESUME_ZERO_DELTA_PROOF_REQUIRED: ${workId}`);
  }
  const recordedBase = work.baseRevision?.trim();
  if (!recordedBase) throw new Error(`WORK_CANCELLED_RESUME_BASE_REVISION_REQUIRED: ${workId}`);
  const baseRevision = gitCommitAtRef(repository.canonicalRoot, recordedBase);
  if (!baseRevision) throw new Error(`WORK_CANCELLED_RESUME_BASE_REVISION_MISSING: ${workId}`);
  const handleBase = handle.baseCommit ? gitCommitAtRef(repository.canonicalRoot, handle.baseCommit) : undefined;
  const handleHead = handle.expectedHead ? gitCommitAtRef(repository.canonicalRoot, handle.expectedHead) : undefined;
  if ((handle.baseCommit && handleBase !== baseRevision) || (handle.expectedHead && handleHead !== baseRevision)) {
    throw new Error(`WORK_CANCELLED_RESUME_REVISION_AMBIGUOUS: ${workId}`);
  }
  if (handle.checkoutId !== recordedCheckoutId || resolve(handle.worktreePath) !== resolve(recordedWorktree)) {
    throw new Error(`WORK_CANCELLED_RESUME_CHECKOUT_OWNERSHIP_MISMATCH: ${workId}`);
  }
  if (handle.branch) {
    const historicalBranchHead = gitCommitAtRef(repository.canonicalRoot, `refs/heads/${handle.branch}`);
    if (historicalBranchHead && historicalBranchHead !== baseRevision) {
      throw new Error(`WORK_CANCELLED_RESUME_UNIQUE_COMMIT_CONFLICT: ${workId}`);
    }
  }
  if (worktreePresent) {
    const retainedSnapshot = gitWorktreeSnapshot(recordedWorktree);
    if (!retainedSnapshot || !retainedSnapshot.clean || retainedSnapshot.head !== baseRevision || (handle.branch && retainedSnapshot.branch !== handle.branch)) {
      throw new Error(`WORK_CANCELLED_RESUME_ZERO_DELTA_PHYSICAL_CONFLICT: ${workId}`);
    }
  }

  const branchName = `work/resume-${workId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 42)}-${baseRevision.slice(0, 12)}`;
  const existingResumeBranch = gitCommitAtRef(repository.canonicalRoot, `refs/heads/${branchName}`);
  if (existingResumeBranch && existingResumeBranch !== baseRevision) {
    throw new Error(`WORK_CANCELLED_RESUME_RECONSTRUCTION_BRANCH_CONFLICT: ${workId}`);
  }
  const workspace = ensureManagedWorkspace(controllerHome, repository, {
    requestId: `${workId}:explicit-user-resume:${baseRevision}`,
    title: `${work.objective} explicit user resume`,
    branchName,
    baseRef: baseRevision,
    prepareDependencies: input.prepareDependencies === true,
  });
  if (!workspace.managed || !workspace.checkoutId || !workspace.root || !workspace.branch) {
    throw new Error(`WORK_CANCELLED_RESUME_RECONSTRUCTION_FAILED: ${workId}`);
  }
  const refreshedRepository = listRepositories(controllerHome, { includeRemoved: true })
    .find((candidate) => candidate.repoId === repository.repoId);
  if (!refreshedRepository) throw new Error(`WORK_CANCELLED_RESUME_REPOSITORY_MISSING: ${workId}`);
  const reconstructed = selectRepositoryCheckout(refreshedRepository, workspace.checkoutId);
  const reconstructedStatus = repositoryGitStatus(reconstructed);
  if (!reconstructedStatus.clean || reconstructedStatus.head !== baseRevision || reconstructedStatus.branch !== workspace.branch) {
    throw new Error(`WORK_CANCELLED_RESUME_RECONSTRUCTION_REVISION_MISMATCH: ${workId}`);
  }

  work = updateWorkContract(store, workId, {
    checkoutId: workspace.checkoutId,
    worktreeRef: workspace.root,
    baseRevision,
    controllerInstanceId: identity.controllerInstanceId,
  });
  const now = new Date().toISOString();
  handle = writeWorkHandle(controllerHome, {
    ...handle,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
    checkoutId: workspace.checkoutId,
    worktreePath: workspace.root,
    branch: workspace.branch,
    sourceCheckoutId: repository.activeCheckoutId,
    managedWorktree: true,
    baseCommit: baseRevision,
    deliveryBaseCommit: baseRevision,
    expectedHead: baseRevision,
    state: 'prepared',
    validatedInputFingerprint: undefined,
    failureReason: undefined,
    cleanupReceipt: undefined,
    finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    updatedAt: now,
  });
  resumeRetainedCancelledWorkContract(store, workId, {
    principalId: identity.principalId,
    controllerInstanceId: identity.controllerInstanceId,
    summary: 'Explicit current user re-authorized the same cancelled Work; prior managed checkout was absent and a fresh isolated checkout was reconstructed at the exact zero-delta base revision.',
    checkoutId: workspace.checkoutId,
    worktreeRef: workspace.root,
  });
  return { reconstructedCheckout: true };
}
