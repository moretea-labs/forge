import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { listRecoverableProcessRecords } from '../../execution/process-runtime/store';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { activateWorkContract, failWorkContract, getWorkContract } from '../../../../packages/kernel/work/api/index';
import { admitPreparedRepositoryWorkContract } from '../facade/repository-work-admission';
import { isTerminalSemanticWorkState } from '../facade/types';
import { updateExecutionSession, type ExecutionSessionContext } from './session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle } from './validation';
import { withWorkPrepareRequest } from './work-prepare-request-store';
import { markWorkHandleFailed, newWorkId, readWorkHandle, writeWorkHandle, type WorkFinalizationStages, type WorkHandleState } from './work-handle-store';
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
  if (existing.state !== 'prepared' && existing.state !== 'editing') {
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
    deliveryBaseCommit: adoptCandidateHead,
    expectedHead: adoptCandidateHead,
    validationRun: undefined,
    validatedInputFingerprint: undefined,
    finalization: initialStage(),
    failureReason: undefined,
  };
  validateWorkHandle(ctx.controllerHome, candidate, identityFor(ctx, args), 'cheap', 'inspect');
  return writeWorkHandle(ctx.controllerHome, candidate);
}

export function prepareWork(ctx: McpExecutionContext, args: Record<string, unknown>): Record<string, unknown> {
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
