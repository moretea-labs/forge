import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { listRecoverableProcessRecords } from '../../execution/process-runtime/store';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { activateWorkContract, failWorkContract, getWorkContract } from '../../../../packages/kernel/work/api/index';
import { admitPreparedRepositoryWorkContract, materializeRepositoryWorkPlacement } from '../facade/repository-work-admission';
import { isTerminalSemanticWorkState } from '../facade/types';
import { updateExecutionSession, type ExecutionSessionContext } from './session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle } from './validation';
import { withWorkPrepareRequest } from './work-prepare-request-store';
import { markWorkHandleFailed, newWorkId, readWorkHandle, relocateWorkHandlePlacementAtomically, writeWorkHandle, type WorkFinalizationStages, type WorkHandleState } from './work-handle-store';
import { createGoalDelegation } from '../governance/authorization';
import { compactHandle, contractFor, findWorkHandle, gitHead, gitIsAncestor, identityFor, requireSession } from './work-execution-support';

function requireExplicitRepoId(args: Record<string, unknown>): string {
  const value = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (!value) throw new Error('REPOSITORY_ID_REQUIRED: repository selection must be explicit for session binding');
  return value;
}

function selectedRepository(ctx: McpExecutionContext, session: ExecutionSessionContext, args: Record<string, unknown>, allowSession = true) {
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



function boundedStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, limit) : [];
}

function requestedWorkPrepareIsolation(args: Record<string, unknown>): 'reuse' | 'new_worktree' | 'auto' | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, 'isolation')) return undefined;
  return args.isolation === 'reuse' || args.isolation === 'new_worktree' || args.isolation === 'auto' ? args.isolation : 'auto';
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

function invalidateActiveWork(ctx: McpExecutionContext, session: ExecutionSessionContext, reason: string): void {
  if (!session.activeRepositoryId || !session.activeWorkId) return;
  const handle = readWorkHandle(ctx.controllerHome, session.activeRepositoryId, session.activeWorkId);
  if (!handle || handle.state === 'cleaned') return;
  const contract = contractFor(ctx, handle);
  if (contract?.semanticState === 'completed') return;
  markWorkHandleFailed(ctx.controllerHome, handle, reason);
}

export function bindSessionRepository(ctx: McpExecutionContext, args: Record<string, unknown>): Record<string, unknown> {
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

function gitPathSet(root: string, args: string[], code: string): Set<string> {
  const result = spawnSync('git', ['-C', root, ...args, '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error(`${code}: ${result.error?.message ?? result.stderr?.trim() ?? `git ${args.join(' ')} failed`}`);
  return new Set(String(result.stdout ?? '').split('\0').map((value) => value.trim()).filter(Boolean));
}

function currentDirtyPaths(root: string): Set<string> {
  const paths = new Set<string>();
  for (const path of gitPathSet(root, ['diff', '--name-only'], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PATHS_UNAVAILABLE')) paths.add(path);
  for (const path of gitPathSet(root, ['diff', '--cached', '--name-only'], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PATHS_UNAVAILABLE')) paths.add(path);
  for (const path of gitPathSet(root, ['ls-files', '--others', '--exclude-standard'], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PATHS_UNAVAILABLE')) paths.add(path);
  return paths;
}

function adoptExplicitSuccessorHead(
  ctx: McpExecutionContext,
  args: Record<string, unknown>,
  repository: ReturnType<typeof selectedRepository>,
  existing: WorkHandleState,
): WorkHandleState | undefined {
  const expectedPreviousHead = typeof args.expected_previous_head === 'string' ? args.expected_previous_head.trim() : '';
  const adoptCandidateHead = typeof args.adopt_candidate_head === 'string' ? args.adopt_candidate_head.trim() : '';
  if (!expectedPreviousHead && !adoptCandidateHead) return undefined;
  if (!expectedPreviousHead || !adoptCandidateHead) {
    throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_PAIR_REQUIRED: expected_previous_head and adopt_candidate_head must be supplied together');
  }
  // A failed validation attempt may need an explicit, audited successor
  // adoption before it can retry against the current checkout. Keep its
  // failed state: only a fresh valid check may restore execution authority.
  const retryableValidationFailure = existing.state === 'failed'
    && existing.finalization.validation === 'failed';
  if (existing.state !== 'prepared' && existing.state !== 'editing' && !retryableValidationFailure) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_STATE_INVALID: ${existing.state}`);
  }
  if (existing.expectedHead !== expectedPreviousHead) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_PREVIOUS_HEAD_MISMATCH: expected ${existing.expectedHead ?? 'missing'}, received ${expectedPreviousHead}`);
  }
  if (existing.repositoryId !== repository.repoId || existing.checkoutId !== repository.activeCheckoutId) {
    throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_CHECKOUT_MISMATCH');
  }
  const root = existing.worktreePath;
  const currentHead = gitHead(root);
  if (!currentHead || currentHead !== adoptCandidateHead) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_CURRENT_HEAD_MISMATCH: expected ${adoptCandidateHead}, found ${currentHead ?? 'missing'}`);
  }
  if (!gitIsAncestor(root, expectedPreviousHead, adoptCandidateHead)) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_NONLINEAR: ${expectedPreviousHead} is not an ancestor of ${adoptCandidateHead}`);
  }
  const changedPaths = gitPathSet(root, ['diff', '--name-only', `${expectedPreviousHead}..${adoptCandidateHead}`], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIFF_UNAVAILABLE');
  const dirtyPaths = currentDirtyPaths(root);
  if (existing.managedWorktree) {
    if (dirtyPaths.size > 0) {
      throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_MANAGED_DIRTY: ${[...dirtyPaths].sort().slice(0, 20).join(',')}`);
    }
    const blockingProcesses = listRecoverableProcessRecords(ctx.controllerHome, existing.repositoryId)
      .filter((record) => record.workId === existing.workId)
      .map((record) => record.processId)
      .sort();
    if (blockingProcesses.length > 0) {
      throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_ACTIVE_PROCESS: ${blockingProcesses.slice(0, 20).join(',')}`);
    }
  } else {
    const overlap = [...changedPaths].filter((path) => dirtyPaths.has(path)).sort();
    if (overlap.length > 0) {
      throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_OVERLAP: ${overlap.slice(0, 20).join(',')}`);
    }
  }
  const candidate: WorkHandleState = {
    ...existing,
    // Successor adoption advances the Work candidate, not the delivery target.
    // Preserve the canonical delivery base until authorized delivery or rebase.
    expectedHead: adoptCandidateHead,
    validationRun: undefined,
    validatedInputFingerprint: undefined,
    finalization: initialStage(),
    failureReason: undefined,
  };
  validateWorkHandle(ctx.controllerHome, candidate, identityFor(ctx, args), 'cheap', 'inspect');
  return writeWorkHandle(ctx.controllerHome, candidate);
}

function relocateExistingWorkToManagedCheckout(
  ctx: McpExecutionContext,
  args: Record<string, unknown>,
  session: ExecutionSessionContext,
  repository: ReturnType<typeof selectedRepository>,
  existing: WorkHandleState,
): Record<string, unknown> {
  const prior = typeof args.expected_previous_head === 'string' ? args.expected_previous_head.trim() : '';
  const candidate = typeof args.adopt_candidate_head === 'string' ? args.adopt_candidate_head.trim() : '';
  const baseRef = typeof args.base_ref === 'string' ? args.base_ref.trim() : '';
  if (!prior || !candidate || baseRef !== candidate || !/^[0-9a-f]{40}$/.test(candidate)) {
    throw new Error('WORK_RELOCATION_EXACT_HEADS_REQUIRED: supply expected_previous_head and matching base_ref/adopt_candidate_head');
  }
  if (existing.principalId !== session.principalId) throw new Error('WORK_HANDLE_ACCESS_DENIED');
  if (existing.expectedHead !== prior && !(existing.managedWorktree && existing.expectedHead === candidate)) {
    throw new Error('WORK_RELOCATION_PREVIOUS_HEAD_MISMATCH');
  }
  if (existing.managedWorktree) {
    if (existing.expectedHead !== candidate) throw new Error('WORK_RELOCATION_ALREADY_ISOLATED');
    validateWorkHandle(ctx.controllerHome, existing, identityFor(ctx, args), 'cheap', 'inspect');
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
      activeRepositoryId: existing.repositoryId, activeCheckoutId: existing.checkoutId,
      activeWorkId: existing.workId, permissionSnapshotVersion: existing.permissionSnapshotVersion,
    });
    return { session: requireSession(ctx, args), work: compactHandle(existing), reused: true, relocated: true };
  }
  if (existing.state !== 'prepared' && existing.state !== 'editing') throw new Error('WORK_RELOCATION_STATE_INVALID');
  if (existing.finalization.validation !== 'pending' || existing.finalization.commit !== 'pending' || existing.finalization.merge !== 'pending'
      || existing.finalization.worktreeCleanup !== 'pending' || existing.finalization.branchCleanup !== 'pending'
      || existing.cleanupReceipt || existing.validatedInputFingerprint || existing.validationRun) {
    throw new Error('WORK_RELOCATION_FINALIZATION_IN_PROGRESS');
  }
  const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: existing.repositoryId }, existing.workId);
  if (!contract || contract.semanticState !== 'open' || contract.completionReceipt || contract.completionOutcome
      || contract.checkoutId !== existing.checkoutId) throw new Error('WORK_RELOCATION_CONTRACT_MISMATCH');
  if (existing.checkoutId !== repository.activeCheckoutId || existing.worktreePath !== repository.canonicalRoot
      || existing.branch !== repositoryGitStatus(repository).branch) throw new Error('WORK_RELOCATION_SOURCE_MISMATCH');
  if (!gitIsAncestor(existing.worktreePath, prior, candidate)) throw new Error('WORK_RELOCATION_NONLINEAR');
  const changedPaths = gitPathSet(existing.worktreePath, ['diff', '--name-only', prior + '..' + candidate], 'WORK_RELOCATION_DIFF_UNAVAILABLE');
  const dirtyPaths = currentDirtyPaths(existing.worktreePath);
  const overlap = [...changedPaths].filter((path) => dirtyPaths.has(path));
  if (overlap.length) throw new Error('WORK_RELOCATION_DIRTY_OVERLAP: ' + overlap.sort().join(','));
  if (listRecoverableProcessRecords(ctx.controllerHome, existing.repositoryId).some((record) => record.workId === existing.workId)) {
    throw new Error('WORK_RELOCATION_ACTIVE_PROCESS');
  }
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new Error('WORK_RELOCATION_REQUEST_ID_REQUIRED');
  // A deterministic request identity makes physical worktree creation safe to
  // resume after a process crash before the authoritative database transaction.
  const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
    requestId: 'relocate:' + existing.workId + ':' + candidate,
    title: 'Relocate existing Work to managed checkout',
    associatedWorkId: existing.workId,
    baseRef: candidate,
    prepareDependencies: false,
  });
  if (!workspace.managed || !workspace.checkoutId || !workspace.root || !workspace.branch) {
    throw new Error('WORK_RELOCATION_TARGET_NOT_MANAGED');
  }
  const selectedTarget = resolveRepositorySelection({
    repoId: existing.repositoryId, checkoutId: workspace.checkoutId,
    controllerHome: ctx.controllerHome, allowSoleRepository: false,
  });
  const targetStatus = repositoryGitStatus(selectedTarget);
  if (!targetStatus.clean || targetStatus.head !== candidate || targetStatus.branch !== workspace.branch
      || workspace.checkoutId === existing.checkoutId || selectedTarget.canonicalRoot !== workspace.root) {
    throw new Error('WORK_RELOCATION_TARGET_CHANGED');
  }
  const refreshed = relocateWorkHandlePlacementAtomically(ctx.controllerHome, existing, {
    checkoutId: workspace.checkoutId, root: workspace.root,
    branch: workspace.branch, head: candidate,
  });
  updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: refreshed.repositoryId, activeCheckoutId: refreshed.checkoutId,
    activeWorkId: refreshed.workId, permissionSnapshotVersion: refreshed.permissionSnapshotVersion,
  });
  return { session: requireSession(ctx, args), work: compactHandle(refreshed), relocated: true,
    previousCheckoutId: existing.checkoutId, previousHead: prior, currentHead: candidate };
}

export function prepareWork(ctx: McpExecutionContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = selectedRepository(ctx, session, args, true);
  if (!session.activeRepositoryId) {
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: repository.activeCheckoutId, permissionSnapshotVersion: currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId) });
  }
  const existingId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (args.relocate_to_new_worktree === true && !existingId) throw new Error('WORK_RELOCATION_EXISTING_WORK_ID_REQUIRED');
  const requestedIsolation = requestedWorkPrepareIsolation(args);
  if (existingId) {
    const existing = readWorkHandle(ctx.controllerHome, repository.repoId, existingId)
      ?? findWorkHandle(ctx, session, { ...args, work_id: existingId, repo_id: repository.repoId });
    if (existing.principalId !== session.principalId) throw new Error('WORK_HANDLE_ACCESS_DENIED');
    if (args.relocate_to_new_worktree === true) {
      if (requestedIsolation !== undefined) throw new Error('WORK_RELOCATION_ISOLATION_CONFLICT');
      return relocateExistingWorkToManagedCheckout(ctx, args, session, repository, existing);
    }
    if (requestedIsolation !== undefined) {
      const requestedWorkspaceMode = requestedIsolation === 'reuse' ? 'current' : 'isolated';
      const existingWorkspaceMode = existing.managedWorktree ? 'isolated' : 'current';
      if (requestedWorkspaceMode !== existingWorkspaceMode) {
        throw new Error(`WORK_PREPARE_PLACEMENT_CONFLICT: ${existingId}; existing=${existingWorkspaceMode}; requested=${requestedWorkspaceMode}`);
      }
    }
    const adopted = adoptExplicitSuccessorHead(ctx, args, repository, existing);
    const active = adopted ?? existing;
    if (!adopted) validateWorkHandle(ctx.controllerHome, active, identityFor(ctx, args), 'cheap', 'inspect');
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: active.repositoryId, activeCheckoutId: active.checkoutId, activeWorkId: active.workId, permissionSnapshotVersion: active.permissionSnapshotVersion });
    return {
      session: requireSession(ctx, args),
      work: compactHandle(active),
      reused: true,
      ...(adopted ? { adoptedSuccessor: { previousHead: existing.expectedHead, currentHead: adopted.expectedHead } } : {}),
    };
  }

  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new Error('WORK_PREPARE_REQUEST_ID_REQUIRED: new work preparation requires request_id');
  const isolation = requestedWorkPrepareIsolation(args) ?? 'auto';
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
  const deliveryTargetBranch = baseStatus.branch;
  if (!deliveryTargetBranch) throw new Error(`WORK_DELIVERY_TARGET_DETACHED: source checkout ${baseCheckoutId} has no branch`);
  if (isolation === 'reuse' && !baseStatus.clean) throw new Error('WORKTREE_DIRTY: reuse was requested but the selected checkout is dirty; choose new_worktree or auto');
  // A repository Work freezes its start revision on its own checkout. Sharing the
  // canonical checkout is an explicit model choice (`reuse`), never the auto path.
  const useWorktree = isolation !== 'reuse';
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
      const existingContract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
      if (!existingContract) throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} has a Work handle without its WorkContract`);
      const terminal = isTerminalSemanticWorkState(existingContract.semanticState);
      if (terminal) {
        return {
          session: requireSession(ctx, args),
          work: compactHandle(existingHandle),
          reused: true,
          terminal: true,
          workContractStatus: existingContract.semanticState,
        };
      }
      if (existingContract.semanticState === 'open') {
        activateWorkContract(
          { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          createdWorkId,
          { phase: 'implementation', summary: 'Prepared Work resumed on the existing WorkHandle.', worktreeRef: existingHandle.worktreePath },
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
      const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: existingHandle.checkoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
      return { session: nextSession, work: compactHandle(existingHandle), reused: true, isolation: existingHandle.managedWorktree ? 'isolated' : 'current' };
    }

    let contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
    if (contract?.requestId && contract.requestId !== requestId) throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${requestId}`);
    if (request.status === 'prepared') {
      throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} completed without a readable Work handle`);
    }
    if (contract && (contract.semanticState === 'completed' || contract.semanticState === 'cancelled')) {
      throw new Error(`WORK_PREPARE_REQUEST_TERMINAL: ${requestId} belongs to ${contract.semanticState} Work ${createdWorkId}`);
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
          associatedWorkId: createdWorkId,
          baseRef,
          prepareDependencies: needsDependencies,
        })
        : { mode: 'current' as const, checkoutId: baseCheckoutId, root: repository.canonicalRoot, branch: baseStatus.branch ?? 'detached', baseRevision: baseStatus.head ?? undefined, managed: false };
      if (workspace.managed) {
        const materialized = materializeRepositoryWorkPlacement(
          { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          contract.workId,
          () => workspace,
        );
        if (!materialized) throw new Error(`WORK_PLACEMENT_MATERIALIZATION_LOST: ${contract.workId}`);
        contract = materialized;
      }
      const refreshed = getRepository(repository.repoId, ctx.controllerHome);
      const checkout = selectRepositoryCheckout(refreshed, workspace.checkoutId);
      if (workspace.managed && (
        contract.checkoutId !== checkout.activeCheckoutId
        || contract.worktreeRef !== checkout.canonicalRoot
      )) {
        throw new Error(`WORK_PLACEMENT_IDENTITY_DRIFT: contract=${contract.checkoutId ?? 'missing'}:${contract.worktreeRef ?? 'missing'}; checkout=${checkout.activeCheckoutId}:${checkout.canonicalRoot}`);
      }
      const branch = workspace.branch || repositoryGitStatus(checkout).branch;
      if (!branch) throw new Error('WORKTREE_DETACHED: selected worktree has no branch');
      const head = gitHead(checkout.canonicalRoot);
      const handle: WorkHandleState = {
        schemaVersion: 1, workId: createdWorkId, sessionId: session.sessionId, principalId: session.principalId,
        repositoryId: repository.repoId, checkoutId: checkout.activeCheckoutId, worktreePath: checkout.canonicalRoot, branch,
        sourceCheckoutId: baseCheckoutId, deliveryTargetBranch, managedWorktree: workspace.managed, workContractId: contract.workId, goalId, delegationVersion: delegation.version,
        baseCommit: workspace.baseRevision ?? head, deliveryBaseCommit: workspace.baseRevision ?? head, expectedHead: head, permissionSnapshotVersion: policy.revision,
        state: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalization: initialStage(),
        cleanupResponsibility: { owner: 'work_finalizer', registeredAt: new Date().toISOString() },
      };
      writeWorkHandle(ctx.controllerHome, handle);
      activateWorkContract(
        { controllerHome: ctx.controllerHome, repoId: repository.repoId },
        contract.workId,
        { phase: 'implementation', summary: 'Repository Work preparation completed and execution ownership is active.', worktreeRef: checkout.canonicalRoot },
      );
      const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: checkout.activeCheckoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
      return { session: nextSession, work: compactHandle(handle), reused: requestReused, isolation: workspace.mode };
    } catch (error) {
      failWorkContract(
        { controllerHome: ctx.controllerHome, repoId: repository.repoId },
        contract.workId,
        { phase: 'implementation', summary: `Repository Work preparation failed: ${error instanceof Error ? error.message : String(error)}` },
      );
      throw error;
    }
  });
}
