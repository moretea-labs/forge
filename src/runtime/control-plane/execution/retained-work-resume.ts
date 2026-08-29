import { existsSync } from 'fs';
import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { listRepositories, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { getControllerSession } from '../facade/controller-session-store';
import { getWorkContract, resumeRetainedCancelledWorkContract, updateWorkContract } from '../facade/work-contract-store';
import { gitCommitAtRef, gitWorktreeSnapshot } from './work-lifecycle-audit';
import { readWorkHandle, writeWorkHandle } from './work-handle-store';

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
