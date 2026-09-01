import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { appendWorkEvidence, getWorkContract, updateWorkContract } from '../../../../packages/kernel/work/api/index';
import { admitPreparedRepositoryWorkContract } from '../facade/repository-work-admission';
import { isTerminalWorkContractStatus, type WorkReconciliationRecord } from '../facade/types';
import { claimControllerSession, getControllerSession, resumeControllerSession } from '../facade/controller-session-store';
import { updateExecutionSession, type ExecutionSessionContext } from './session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle } from './validation';
import { assertExecutionIdentity, executionIdentityFromCoordinates } from './execution-identity';
import { withWorkPrepareRequest } from './work-prepare-request-store';
import { markWorkHandleFailed, newWorkId, readWorkHandle, transitionWorkHandle, writeWorkHandle, type WorkFinalizationStages, type WorkHandleState } from './work-handle-store';
import { assertWorkPathsWithinScope } from './work-path-scope';
import { createGoalDelegation } from '../governance/authorization';
import { compactHandle, contractFor, findWorkHandle, gitChangedPaths, gitCommit, gitHead, gitMergeBase, identityFor, requireSession, selectWorkFinalizationTarget } from './work-execution-support';

function requireExplicitRepoId(args: Record<string, unknown>): string {
  const value = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (!value) throw new Error('REPOSITORY_ID_REQUIRED: repository selection must be explicit for session binding');
  return value;
}

function selectedRepository(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, args: Record<string, unknown>, allowSession = true) {
  const requested = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
  const selectedRepoId = requested ?? (allowSession ? session.activeRepositoryId : undefined);
  if (!selectedRepoId) throw new Error('SESSION_REPOSITORY_REQUIRED: bind a repository before using this work tool');
  if (session.activeRepositoryId && requested && session.activeRepositoryId !== requested) {
    throw new Error('SESSION_REPOSITORY_MISMATCH: call session_bind_repository before switching repositories');
  }
  return resolveRepositorySelection({ repoId: selectedRepoId, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : session.activeCheckoutId, controllerHome: ctx.controllerHome, allowSoleRepository: false });
}

function initialStage(): WorkFinalizationStages {
  return { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' };
}

/**
 * A previous finalization request may have validated a Work and explicitly
 * skipped every effectful stage without delivering or cleaning anything. That
 * is retryable preparation history, not an irreversible finalization boundary.
 * Any done/failed effectful stage or retained finalization error stays fenced.
 */
export function workHeadAdoptionFinalizationIsRetryable(stages: WorkFinalizationStages): boolean {
  if (stages.validation === 'failed' || stages.lastError) return false;
  return [stages.commit, stages.merge, stages.branchCleanup, stages.worktreeCleanup]
    .every((stage) => stage === 'pending' || stage === 'skipped');
}

function normalizedRequiredString(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' && args[key].trim() ? args[key].trim() : undefined;
}

function boundedStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, limit) : [];
}

function workPrepareFingerprint(input: {
  repoId: string;
  requestedCheckoutId?: string;
  isolation: 'reuse' | 'new_worktree' | 'auto';
  objective: string;
  goalId?: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  checks: string[];
  baseRef?: string;
  needsDependencies: boolean;
}): string {
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, operation: 'work_prepare', ...input })).digest('hex');
}

function claimPreparedWorkOwnership(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  handle: WorkHandleState,
  args: Record<string, unknown>,
): void {
  const workIdValue = handle.workContractId ?? handle.workId;
  const controllerId = typeof args.controller_id === 'string' && args.controller_id.trim()
    ? args.controller_id.trim()
    : session.principalId;
  claimControllerSession({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, {
    workId: workIdValue,
    controllerId,
    controllerType: 'chatgpt',
    sessionId: session.sessionId,
    principalId: session.principalId,
    controllerInstanceId: session.controllerInstanceId,
    leaseMs: 3_600_000,
  });
}

function claimHeadAdoptionOwnership(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  handle: WorkHandleState,
  args: Record<string, unknown>,
): void {
  const workIdValue = handle.workContractId ?? handle.workId;
  const controllerId = normalizedRequiredString(args, 'controller_id') ?? session.principalId;
  if (controllerId !== session.principalId) {
    throw new Error('WORK_CONTROLLER_IDENTITY_MISMATCH: controller_id must match the authenticated principal');
  }
  const options = { controllerHome: ctx.controllerHome, repoId: handle.repositoryId };
  const current = getControllerSession(options, workIdValue);
  const input = {
    workId: workIdValue,
    controllerId,
    controllerType: current?.controllerType ?? 'chatgpt' as const,
    sessionId: session.sessionId,
    principalId: session.principalId,
    controllerInstanceId: session.controllerInstanceId,
    expectedClaimGeneration: current?.claimGeneration ?? 0,
    leaseMs: 3_600_000,
  };
  const claimed = current
    ? resumeControllerSession(options, input)
    : claimControllerSession(options, input);
  if (
    claimed.controllerId !== controllerId
    || claimed.sessionId !== session.sessionId
    || claimed.principalId !== session.principalId
    || claimed.controllerInstanceId !== session.controllerInstanceId
    || (claimed.claimGeneration ?? 0) < 1
  ) {
    throw new Error('WORK_HEAD_ADOPTION_OWNERSHIP_FENCE_MISMATCH');
  }
}

function adoptExistingWorkHead(
  ctx: MultiRepositoryMcpToolContext,
  session: ExecutionSessionContext,
  repository: RepositoryRecord,
  handle: WorkHandleState,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const previousInput = normalizedRequiredString(args, 'expected_previous_head');
  const candidateInput = normalizedRequiredString(args, 'adopt_candidate_head');
  if (!previousInput && !candidateInput) return undefined;
  if (!previousInput || !candidateInput) {
    throw new Error('WORK_HEAD_ADOPTION_ARGUMENTS_REQUIRED: expected_previous_head and adopt_candidate_head must be provided together');
  }
  const requestedCheckoutId = normalizedRequiredString(args, 'checkout_id');
  if (!requestedCheckoutId) throw new Error('WORK_HEAD_ADOPTION_CHECKOUT_REQUIRED: checkout_id must be explicit');
  if (repository.repoId !== handle.repositoryId) throw new Error('WORK_HEAD_ADOPTION_REPOSITORY_MISMATCH');
  if (requestedCheckoutId !== handle.checkoutId || repository.activeCheckoutId !== handle.checkoutId) {
    throw new Error(`WORK_HEAD_ADOPTION_CHECKOUT_MISMATCH: expected ${handle.checkoutId}, found ${requestedCheckoutId}`);
  }
  if (!handle.managedWorktree) throw new Error('WORK_HEAD_ADOPTION_MANAGED_WORKTREE_REQUIRED');
  if (handle.principalId !== session.principalId) throw new Error('WORK_HANDLE_PRINCIPAL_MISMATCH: work handle belongs to another principal');
  if (handle.state !== 'prepared' && handle.state !== 'editing') {
    throw new Error(`WORK_HEAD_ADOPTION_STATE_INVALID: ${handle.state}`);
  }
  if (!workHeadAdoptionFinalizationIsRetryable(handle.finalization)) {
    throw new Error('WORK_HEAD_ADOPTION_FINALIZATION_ALREADY_STARTED');
  }

  const registered = getRepository(handle.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const registeredCheckout = registered.checkouts.find((entry) => entry.checkoutId === handle.checkoutId);
  if (!registeredCheckout || registeredCheckout.lifecycle !== 'active' || registeredCheckout.worktree !== true) {
    throw new Error('WORK_HEAD_ADOPTION_CHECKOUT_NOT_ACTIVE_MANAGED');
  }
  const worktreeRepository = selectRepositoryCheckout(registered, handle.checkoutId);
  const guarded = assertExecutionIdentity({
    controllerHome: ctx.controllerHome,
    identity: executionIdentityFromCoordinates({
      repositoryId: handle.repositoryId,
      checkoutId: handle.checkoutId,
      canonicalRoot: handle.worktreePath,
      workId: handle.workId,
      worktreePath: handle.worktreePath,
      branch: handle.branch,
    }),
    cwd: handle.worktreePath,
    requestedRepoId: repository.repoId,
    requestedCheckoutId,
  });
  const status = repositoryGitStatus(worktreeRepository);
  if (!status.clean) throw new Error('WORK_HEAD_ADOPTION_WORKTREE_DIRTY');

  const previousHead = gitCommit(handle.worktreePath, previousInput, 'PREVIOUS_HEAD');
  const candidateHead = gitCommit(handle.worktreePath, candidateInput, 'CANDIDATE_HEAD');
  const authoritativePrevious = handle.expectedHead ? gitCommit(handle.worktreePath, handle.expectedHead, 'AUTHORITATIVE_PREVIOUS_HEAD') : undefined;
  if (!authoritativePrevious || authoritativePrevious !== previousHead) {
    throw new Error(`WORK_HEAD_ADOPTION_PREVIOUS_HEAD_MISMATCH: expected ${authoritativePrevious ?? 'missing'}, found ${previousHead}`);
  }
  if (guarded.currentHead !== candidateHead || status.head !== candidateHead) {
    throw new Error(`WORK_HEAD_ADOPTION_CANDIDATE_NOT_CURRENT: expected current HEAD ${candidateHead}, found ${guarded.currentHead ?? status.head ?? 'missing'}`);
  }
  if (previousHead === candidateHead) throw new Error('WORK_HEAD_ADOPTION_SUCCESSOR_REQUIRED');
  const ancestry = spawnSync('git', ['-C', handle.worktreePath, 'merge-base', '--is-ancestor', previousHead, candidateHead], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (ancestry.status !== 0 || ancestry.error) throw new Error('WORK_HEAD_ADOPTION_NOT_DESCENDANT');

  const contract = contractFor(ctx, handle);
  if (!contract || contract.repoId !== handle.repositoryId) throw new Error('WORK_HEAD_ADOPTION_CONTRACT_MISSING');
  if (isTerminalWorkContractStatus(contract.status) || contract.completionReceipt) {
    throw new Error('WORK_HEAD_ADOPTION_CONTRACT_TERMINAL');
  }
  // expectedHead can predate unrelated commits that landed on the source checkout
  // before this Work was rebased. Scope adoption to the candidate's unique delta
  // from the current source-checkout merge-base; otherwise those target-branch
  // commits are incorrectly attributed to the Work and fail its allow-list.
  const sourceRepository = selectWorkFinalizationTarget(registered, handle);
  const sourceHead = handle.sourceCheckoutId && handle.sourceCheckoutId !== handle.checkoutId
    ? repositoryGitStatus(sourceRepository).head
    : undefined;
  const scopeBaseHead = sourceHead ? gitMergeBase(handle.worktreePath, sourceHead, candidateHead) : previousHead;
  const changedPaths = gitChangedPaths(handle.worktreePath, scopeBaseHead, candidateHead);
  assertWorkPathsWithinScope(contract, changedPaths, {
    forbidden: 'WORK_HEAD_ADOPTION_FORBIDDEN_PATH',
    outOfScope: 'WORK_HEAD_ADOPTION_PATH_OUT_OF_SCOPE',
  });

  claimHeadAdoptionOwnership(ctx, session, handle, args);

  const reviewedAt = new Date().toISOString();
  const reconciliationId = `RECNC-${createHash('sha256').update([
    handle.repositoryId, handle.workId, previousHead, candidateHead, handle.checkoutId, handle.branch,
  ].join('\0')).digest('hex').slice(0, 16)}`;
  const reconciliation: WorkReconciliationRecord = {
    schemaVersion: 1,
    reconciliationId,
    originalExpectedRevision: previousHead,
    observedTargetRevision: candidateHead,
    baseRevision: gitCommit(handle.worktreePath, handle.baseCommit ?? previousHead, 'BASE_HEAD'),
    targetBranch: handle.branch,
    reachable: true,
    method: 'exact_commit',
    comparedPaths: changedPaths,
    reviewer: session.principalId.slice(0, 200),
    reviewedAt,
    unrecoverableStages: [],
    cleanupOwnershipProof: `No cleanup was performed; managed checkout ${handle.checkoutId} remains owned by Work finalizer.`,
    rationale: 'Adopted an exact clean successor commit after repository, checkout, worktree, branch, controller ownership, ancestry, and WorkContract path-scope verification. This reconciliation is not completion evidence.',
    outcome: 'accepted_equivalence',
  };

  const adopted = transitionWorkHandle(ctx.controllerHome, handle, 'editing', {
    deliveryBaseCommit: scopeBaseHead,
    expectedHead: candidateHead,
    failureReason: undefined,
    finalization: initialStage(),
    validationRun: undefined,
    validatedInputFingerprint: undefined,
  });
  try {
    updateWorkContract({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, contract.workId, {
      evidenceState: contract.checkRefs.length === 0
        ? contract.evidenceState
        : contract.evidenceState === 'valid' || contract.evidenceState === 'stale'
          ? 'stale'
          : 'partial',
      reconciliations: [reconciliation, ...contract.reconciliations.filter((entry) => entry.reconciliationId !== reconciliationId)],
    });
    appendWorkEvidence({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, contract.workId, {
      title: 'audited WorkHandle successor HEAD adoption',
      summary: `${previousHead} -> ${candidateHead}; ${changedPaths.length} candidate-unique path(s) from scope base ${scopeBaseHead} remained within the WorkContract allow-list. Historical validation and completion receipts were not rewritten.`,
      detailLevel: 'summary',
    });
  } catch (error) {
    try {
      writeWorkHandle(ctx.controllerHome, { ...handle, recordRevision: adopted.recordRevision });
    } catch (rollbackError) {
      throw new Error(`WORK_HEAD_ADOPTION_AUDIT_WRITE_FAILED_AND_ROLLBACK_FAILED: ${String(error)}; ${String(rollbackError)}`);
    }
    throw error;
  }
  const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: handle.repositoryId,
    activeCheckoutId: handle.checkoutId,
    activeWorkId: handle.workId,
    permissionSnapshotVersion: handle.permissionSnapshotVersion,
    lastValidatedAt: reviewedAt,
  });
  return {
    session: nextSession,
    work: compactHandle(adopted),
    reused: true,
    adopted: true,
    adoption: { previousHead, candidateHead, changedPaths, reconciliationId },
    controllerClaimed: true,
  };
}

function invalidateActiveWork(ctx: MultiRepositoryMcpToolContext, session: ExecutionSessionContext, reason: string): void {
  if (!session.activeRepositoryId || !session.activeWorkId) return;
  const handle = readWorkHandle(ctx.controllerHome, session.activeRepositoryId, session.activeWorkId);
  if (!handle || handle.state === 'cleaned') return;
  const contract = contractFor(ctx, handle);
  if (contract?.status === 'completed') return;
  markWorkHandleFailed(ctx.controllerHome, handle, reason);
}

export function bindSessionRepository(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = resolveRepositorySelection({ repoId: requireExplicitRepoId(args), checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome: ctx.controllerHome, allowSoleRepository: false });
  const switching = session.activeRepositoryId !== undefined && (session.activeRepositoryId !== repository.repoId || session.activeCheckoutId !== repository.activeCheckoutId);
  if (switching) invalidateActiveWork(ctx, session, 'explicit repository or checkout switch invalidated the previous active work handle');
  const next = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: repository.activeCheckoutId,
    activeWorkId: undefined,
    goalDelegation: undefined,
    permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId),
    lastValidatedAt: new Date().toISOString(),
  });
  return { session: next, repository: { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, canonicalRoot: repository.canonicalRoot, branch: repository.checkouts.find((entry) => entry.checkoutId === repository.activeCheckoutId)?.branch ?? null }, switched: switching };
}

export function prepareWork(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = selectedRepository(ctx, session, args, true);
  if (!session.activeRepositoryId) {
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: repository.activeCheckoutId, permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId) });
  }
  const existingId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (existingId) {
    const existing = readWorkHandle(ctx.controllerHome, repository.repoId, existingId)
      ?? findWorkHandle(ctx, session, { ...args, work_id: existingId, repo_id: repository.repoId });
    if (existing.principalId !== session.principalId) throw new Error('WORK_HANDLE_ACCESS_DENIED');
    const adopted = adoptExistingWorkHead(ctx, session, repository, existing, args);
    if (adopted) return adopted;
    validateWorkHandle(ctx.controllerHome, existing, identityFor(ctx, args), 'cheap', 'inspect');
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: existing.repositoryId, activeCheckoutId: existing.checkoutId, activeWorkId: existing.workId, permissionSnapshotVersion: existing.permissionSnapshotVersion });
    claimPreparedWorkOwnership(ctx, session, existing, args);
    return { session: requireSession(ctx, args), work: compactHandle(existing), reused: true, controllerClaimed: true };
  }

  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new Error('WORK_PREPARE_REQUEST_ID_REQUIRED: new work preparation requires request_id');
  const isolation = args.isolation === 'reuse' || args.isolation === 'new_worktree' || args.isolation === 'auto' ? args.isolation : 'auto';
  const objective = String(args.objective ?? 'Controller-managed repository work').trim().slice(0, 2_000);
  const goalId = typeof args.goal_id === 'string' && args.goal_id.trim() ? args.goal_id.trim() : undefined;
  const acceptanceCriteria = boundedStringArray(args.acceptance_criteria, 20);
  const allowedPaths = boundedStringArray(args.allowed_paths, 50);
  const checks = boundedStringArray(args.checks, 30);
  const baseRef = typeof args.base_ref === 'string' && args.base_ref.trim() ? args.base_ref.trim() : undefined;
  const requestedCheckoutId = typeof args.checkout_id === 'string' && args.checkout_id.trim() ? args.checkout_id.trim() : undefined;
  const needsDependencies = args.needs_dependencies === true;
  const baseCheckoutId = repository.activeCheckoutId;
  const baseStatus = repositoryGitStatus(repository);
  if (isolation === 'reuse' && !baseStatus.clean) throw new Error('WORKTREE_DIRTY: reuse was requested but the selected checkout is dirty; choose new_worktree or auto');
  const useWorktree = isolation === 'new_worktree' || (isolation === 'auto' && !baseStatus.clean);
  const policy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
  const fingerprint = workPrepareFingerprint({
    repoId: repository.repoId,
    requestedCheckoutId,
    isolation,
    objective,
    goalId,
    acceptanceCriteria,
    allowedPaths,
    checks,
    baseRef,
    needsDependencies,
  });

  return withWorkPrepareRequest({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    sessionId: session.sessionId,
    principalId: session.principalId,
    requestId,
    fingerprint,
    proposedWorkId: newWorkId(),
  }, (request, requestReused) => {
    const createdWorkId = request.workId;
    const existingHandle = readWorkHandle(ctx.controllerHome, repository.repoId, createdWorkId);
    if (existingHandle) {
      if (existingHandle.principalId !== session.principalId || existingHandle.sessionId !== session.sessionId) {
        throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${requestId}`);
      }
      const existingContract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
      if (!existingContract) throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} has a Work handle without its WorkContract`);
      const terminal = isTerminalWorkContractStatus(existingContract.status)
        && !(existingContract.status === 'failed' && request.status === 'claimed');
      if (terminal) {
        return {
          session: requireSession(ctx, args),
          work: compactHandle(existingHandle),
          reused: true,
          terminal: true,
          workContractStatus: existingContract.status,
          controllerClaimed: false,
        };
      }
      if (existingContract.status === 'open' || existingContract.status === 'failed') {
        updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId, { status: 'running', worktreeRef: existingHandle.worktreePath });
      }
      const delegation = createGoalDelegation({
        sessionId: session.sessionId,
        repositoryId: repository.repoId,
        workId: createdWorkId,
        goalId,
        allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
        deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
        permissionSnapshotVersion: policy.revision,
        source: 'gpt_risk_delegate',
      });
      const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: existingHandle.checkoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
      claimPreparedWorkOwnership(ctx, nextSession, existingHandle, args);
      return { session: nextSession, work: compactHandle(existingHandle), reused: true, isolation: existingHandle.managedWorktree ? 'isolated' : 'current', controllerClaimed: true };
    }

    let contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
    if (contract?.requestId && contract.requestId !== requestId) throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${requestId}`);
    if (request.status === 'prepared') {
      throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} completed without a readable Work handle`);
    }
    if (contract && (contract.status === 'completed' || contract.status === 'cancelled')) {
      throw new Error(`WORK_PREPARE_REQUEST_TERMINAL: ${requestId} belongs to ${contract.status} Work ${createdWorkId}`);
    }
    if (!contract) {
      contract = admitPreparedRepositoryWorkContract(
        { controllerHome: ctx.controllerHome, repoId: repository.repoId },
        {
          workId: createdWorkId,
          repoId: repository.repoId,
          objective,
          acceptanceCriteria,
          allowedPaths,
          checks,
          accessMode: policy.mode,
          isolated: useWorktree,
          requestedBy: 'chatgpt',
          requestId,
        },
      );
    }
    const delegation = createGoalDelegation({
      sessionId: session.sessionId,
      repositoryId: repository.repoId,
      workId: createdWorkId,
      goalId,
      allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
      deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
      permissionSnapshotVersion: policy.revision,
      source: 'gpt_risk_delegate',
    });
    try {
      const workspace = useWorktree
        ? ensureManagedWorkspace(ctx.controllerHome, repository, {
          requestId: createdWorkId,
          title: objective,
          baseRef,
          prepareDependencies: needsDependencies,
        })
        : { mode: 'current' as const, checkoutId: baseCheckoutId, root: repository.canonicalRoot, branch: baseStatus.branch ?? 'detached', baseRevision: baseStatus.head ?? undefined, managed: false };
      const refreshed = getRepository(repository.repoId, ctx.controllerHome);
      const checkout = selectRepositoryCheckout(refreshed, workspace.checkoutId);
      const branch = workspace.branch || repositoryGitStatus(checkout).branch;
      if (!branch) throw new Error('WORKTREE_DETACHED: selected worktree has no branch');
      const head = gitHead(checkout.canonicalRoot);
      const handle: WorkHandleState = {
        schemaVersion: 1, workId: createdWorkId, sessionId: session.sessionId, principalId: session.principalId,
        repositoryId: repository.repoId, checkoutId: checkout.activeCheckoutId, worktreePath: checkout.canonicalRoot, branch,
        sourceCheckoutId: baseCheckoutId, managedWorktree: workspace.managed, workContractId: contract.workId, goalId, delegationVersion: delegation.version,
        baseCommit: workspace.baseRevision ?? head, deliveryBaseCommit: workspace.baseRevision ?? head, expectedHead: head, permissionSnapshotVersion: policy.revision,
        state: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalization: initialStage(),
        cleanupResponsibility: { owner: 'work_finalizer', registeredAt: new Date().toISOString() },
      };
      writeWorkHandle(ctx.controllerHome, handle);
      updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId, { status: 'running', worktreeRef: checkout.canonicalRoot });
      const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: checkout.activeCheckoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
      claimPreparedWorkOwnership(ctx, nextSession, handle, args);
      return { session: nextSession, work: compactHandle(handle), reused: requestReused, isolation: workspace.mode, controllerClaimed: true };
    } catch (error) {
      updateWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, contract.workId, { status: 'failed' });
      throw error;
    }
  });
}
