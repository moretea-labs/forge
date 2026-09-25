import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { getRepository, listRepositories, RepositoryCheckoutSelectionError, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { reconcileWorkValidation } from './work-validation-reconciler';
import { appendWorkEvidence, getWorkContract, transitionWorkContractPhase } from '../../../../packages/kernel/work/api/index';
import { resolveLegacyWorkContractIdentity } from './execution-identity';
import type { ExecutionSessionContext, SessionIdentity } from './session-store';
import { currentControllerInstanceId, requireExecutionSession, updateExecutionSession } from './session-store';
import type { WorkHandleState, WorkTerminalOutcome } from './work-handle-store';
import { readWorkHandle, writeWorkHandle } from './work-handle-store';
import { cleanupTerminalWork } from './work-terminal-cleanup';
import { spawnSync } from 'child_process';
import { writeControllerResult } from '../../evidence/result-store';


const MAX_INLINE_RESULT_BYTES = 64 * 1024;

export function makeBoundedWorkResult(ctx: McpExecutionContext, session: ExecutionSessionContext, repoId: string, workIdValue: string | undefined, kind: 'inspection' | 'command' | 'validation' | 'finalization' | 'generic', value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_INLINE_RESULT_BYTES) return value;
  const started = performance.now();
  const stored = writeControllerResult({ controllerHome: ctx.controllerHome, repoId, sessionId: session.sessionId, principalId: session.principalId, workId: workIdValue, kind, value });
  return {
    summary: { itemCount: Array.isArray(value.items) ? value.items.length : undefined, truncated: true, warnings: ['Full result is available through the secure result reference.'] },
    items: Array.isArray(value.items) ? value.items.slice(0, 25) : { preview: serialized.slice(0, 16_384) },
    resultRef: stored.resultRef,
    resultId: stored.resultId,
    byteLength: stored.byteLength,
    _resultPersistenceMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

export function principalFor(ctx: McpExecutionContext): string {
  return ctx.principalId?.trim() || `controller-issued:${ctx.controllerInstanceId ?? currentControllerInstanceId()}`;
}

export function identityFor(ctx: McpExecutionContext, args: Record<string, unknown>): SessionIdentity {
  return {
    sessionId: typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : ctx.sessionId,
    principalId: principalFor(ctx),
    controllerInstanceId: ctx.controllerInstanceId ?? currentControllerInstanceId(),
  };
}

export function requireSession(ctx: McpExecutionContext, args: Record<string, unknown>): ExecutionSessionContext {
  return requireExecutionSession(ctx.controllerHome, identityFor(ctx, args));
}

export function compactHandle(handle: WorkHandleState): Record<string, unknown> {
  return {
    workId: handle.workId, sessionId: handle.sessionId, repoId: handle.repositoryId, checkoutId: handle.checkoutId,
    worktreePath: handle.worktreePath, branch: handle.branch, sourceCheckoutId: handle.sourceCheckoutId, deliveryTargetBranch: handle.deliveryTargetBranch, goalId: handle.goalId, delegationVersion: handle.delegationVersion,
    workContractId: handle.workContractId, baseCommit: handle.baseCommit, deliveryBaseCommit: handle.deliveryBaseCommit, expectedHead: handle.expectedHead,
    permissionSnapshotVersion: handle.permissionSnapshotVersion, state: handle.state, managedWorktree: handle.managedWorktree,
    createdAt: handle.createdAt, updatedAt: handle.updatedAt, finalization: handle.finalization,
    ...(handle.failureReason ? { failureReason: handle.failureReason } : {}),
    ...(handle.cleanupResponsibility ? { cleanupResponsibility: handle.cleanupResponsibility } : {}),
    ...(handle.terminalResourceDisposition ? { terminalResourceDisposition: handle.terminalResourceDisposition } : {}),
    ...(handle.cleanupReceipt ? { cleanupReceipt: handle.cleanupReceipt } : {}),
  };
}

export function gitRevision(root: string, revision: string): string | undefined {
  const output = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  return output.status === 0 && typeof output.stdout === 'string' && output.stdout.trim() ? output.stdout.trim() : undefined;
}

export function gitHead(root: string): string | undefined {
  return gitRevision(root, 'HEAD');
}

export function gitCommit(root: string, revision: string, label: string): string {
  const output = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${revision}^{commit}`], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (output.status !== 0 || output.error || typeof output.stdout !== 'string' || !output.stdout.trim()) {
    throw new Error(`WORK_HEAD_ADOPTION_${label}_INVALID: ${revision}`);
  }
  return output.stdout.trim();
}

export function gitChangedPaths(root: string, previousHead: string, candidateHead: string): string[] {
  const output = spawnSync('git', ['-C', root, 'diff', '--name-only', '-z', previousHead, candidateHead], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (output.status !== 0 || output.error || typeof output.stdout !== 'string') {
    throw new Error('WORK_HEAD_ADOPTION_CHANGED_PATHS_UNAVAILABLE');
  }
  return [...new Set(output.stdout.split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function gitMergeBase(root: string, leftHead: string, rightHead: string): string {
  const output = spawnSync('git', ['-C', root, 'merge-base', leftHead, rightHead], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (output.status !== 0 || output.error || typeof output.stdout !== 'string' || !output.stdout.trim()) {
    throw new Error('WORK_HEAD_ADOPTION_SCOPE_BASE_UNAVAILABLE');
  }
  return output.stdout.trim();
}

export function selectWorkFinalizationTarget(
  repository: ReturnType<typeof getRepository>,
  handle: Pick<WorkHandleState, 'sourceCheckoutId' | 'checkoutId'>,
) {
  const preferredCheckoutId = handle.sourceCheckoutId?.trim();
  if (preferredCheckoutId) {
    try {
      return selectRepositoryCheckout(repository, preferredCheckoutId, { allowArchived: true });
    } catch (error) {
      // Legacy Work can outlive the registry entry for the source checkout after
      // an earlier partial cleanup. Git refs/worktree administration are
      // repository-common operations, so fall back only for a typed missing or
      // removed source checkout; all other errors fail closed.
      const unavailable = error instanceof RepositoryCheckoutSelectionError
        && (error.code === 'CHECKOUT_NOT_FOUND' || (error.code === 'CHECKOUT_NOT_ACTIVE' && error.lifecycle === 'removed'));
      if (!unavailable) throw error;
    }
  }
  return repository;
}

export function workReturnCheckoutId(
  ctx: McpExecutionContext,
  handle: Pick<WorkHandleState, 'repositoryId' | 'sourceCheckoutId' | 'checkoutId'>,
  fallbackCheckoutId?: string,
): string | undefined {
  const repository = getRepository(handle.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const target = selectWorkFinalizationTarget(repository, handle);
  return target.activeCheckoutId ?? repository.activeCheckoutId ?? fallbackCheckoutId;
}

export function contractFor(ctx: McpExecutionContext, handle: WorkHandleState) {
  // WorkContract is the semantic lifecycle authority. Legacy WorkHandles can
  // predate the explicit workContractId binding, but their exact workId is the
  // same stable authority key inside the same repository. Falling back only to
  // that exact id keeps cleanup fail-closed without inventing a second lookup or
  // fuzzy ownership rule.
  const workContractId = handle.workContractId?.trim() || handle.workId;
  return getWorkContract({ controllerHome: ctx.controllerHome, repoId: handle.repositoryId }, workContractId);
}

export function findWorkHandle(
  ctx: McpExecutionContext,
  session: ExecutionSessionContext,
  args: Record<string, unknown>,
): WorkHandleState {
  const requested = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  const workIdValue = requested || session.activeWorkId || '';
  if (!workIdValue) throw new Error('WORK_ID_REQUIRED: provide work_id or call work_prepare first');
  const requestedRepoId = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
  const requestedCheckoutId = typeof args.checkout_id === 'string' && args.checkout_id.trim()
    ? args.checkout_id.trim()
    : undefined;
  const repoCandidates = [
    requestedRepoId,
    session.activeRepositoryId,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  for (const repositoryId of repoCandidates) {
    const handle = readWorkHandle(ctx.controllerHome, repositoryId, workIdValue);
    if (!handle) continue;
    if (requestedCheckoutId && handle.checkoutId !== requestedCheckoutId) {
      throw new Error(
        `WORK_HANDLE_CHECKOUT_DRIFT: work ${workIdValue} is bound to checkout ${handle.checkoutId}, not ${requestedCheckoutId}`,
      );
    }
    return handle;
  }
  const matches = listRepositories(ctx.controllerHome, { includeRemoved: true })
    .map((repository) => readWorkHandle(ctx.controllerHome, repository.repoId, workIdValue))
    .filter((handle): handle is WorkHandleState => Boolean(handle));
  // Legacy incomplete identity: only a unique exact WorkHandle match may execute.
  return resolveLegacyWorkContractIdentity({
    workId: workIdValue,
    repoId: requestedRepoId,
    checkoutId: requestedCheckoutId,
    candidates: matches,
  });
}

export function workForSession(
  ctx: McpExecutionContext,
  session: ExecutionSessionContext,
  args: Record<string, unknown>,
  options: { reconcileValidation?: boolean } = {},
): WorkHandleState {
  let handle = findWorkHandle(ctx, session, args);
  if (handle.principalId !== session.principalId) {
    throw new Error('WORK_HANDLE_PRINCIPAL_MISMATCH: work handle belongs to another principal');
  }
  if (options.reconcileValidation !== false) handle = reconcileWorkValidation(ctx.controllerHome, handle).handle;
  if (
    session.activeRepositoryId !== handle.repositoryId
    || session.activeCheckoutId !== handle.checkoutId
    || session.activeWorkId !== handle.workId
  ) {
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
      activeRepositoryId: handle.repositoryId,
      activeCheckoutId: handle.checkoutId,
      activeWorkId: handle.workId,
      permissionSnapshotVersion: handle.permissionSnapshotVersion,
      lastValidatedAt: new Date().toISOString(),
    });
  }
  return handle;
}

export function terminalCleanupOutcome(
  ctx: McpExecutionContext,
  handle: WorkHandleState,
): WorkTerminalOutcome | undefined {
  if (handle.cleanupReceipt) return handle.cleanupReceipt.terminalOutcome;
  const contract = contractFor(ctx, handle);
  if (contract?.status === 'cancelled') return 'cancelled';
  if (contract?.status === 'completed') return 'completed_cleanup';
  const reason = `${handle.failureReason ?? ''} ${handle.finalization.lastError ?? ''}`.toLowerCase();
  if (contract?.status === 'blocked' && reason.includes('terminal')) return 'blocked_terminal';
  // `failed` is a retryable execution-handle state (its transition table allows
  // failed -> validating/editing). Do not reinterpret it as terminal cleanup
  // unless the durable Work itself is terminal. `failed_terminal_cleanup` is
  // the explicit point of no return for resource cleanup reconciliation.
  if (contract?.status === 'failed' || handle.state === 'failed_terminal_cleanup') {
    if (reason.includes('infrastructure') || reason.includes('timed out') || reason.includes('unavailable')) {
      return 'infrastructure_failed';
    }
    if (handle.finalization.validation === 'failed') return 'validation_failed';
    return 'failed';
  }
  return undefined;
}

export async function reconcileTerminalCleanup(
  ctx: McpExecutionContext,
  session: ExecutionSessionContext,
  handle: WorkHandleState,
  args: Record<string, unknown>,
  outcome: WorkTerminalOutcome,
): Promise<Record<string, unknown>> {
  const wasComplete = handle.cleanupReceipt?.complete === true;
  let cleanupHandle = handle;
  const retained = handle.terminalResourceDisposition?.mode === 'retained_by_request'
    ? handle.terminalResourceDisposition
    : undefined;
  if (retained) {
    cleanupHandle = writeWorkHandle(ctx.controllerHome, {
      ...handle,
      terminalResourceDisposition: undefined,
      finalization: {
        ...handle.finalization,
        branchCleanup: retained.retainBranch === true && args.delete_branch !== false ? 'pending' : handle.finalization.branchCleanup,
        worktreeCleanup: retained.retainWorktree === true ? 'pending' : handle.finalization.worktreeCleanup,
      },
    });
    appendWorkEvidence(
      { controllerHome: ctx.controllerHome, repoId: cleanupHandle.repositoryId },
      cleanupHandle.workContractId ?? cleanupHandle.workId,
      {
        title: 'terminal retention consumed by explicit cleanup request',
        summary: 'An explicit cleanup=true request consumed the durable retained_by_request resource disposition; automatic maintenance did not infer this authorization from skipped cleanup stages.',
        detailLevel: 'summary',
      },
    );
  }
  const cleaned = await cleanupTerminalWork({
    controllerHome: ctx.controllerHome,
    handle: cleanupHandle,
    targetBranch: typeof args.target_branch === 'string' ? args.target_branch : undefined,
    deleteBranch: args.delete_branch !== false,
    terminalOutcome: outcome,
    failureReason: handle.failureReason ?? handle.finalization.lastError,
  });
  // ControllerSession is explicit continuation state, not a Work cleanup
  // resource. Keep the legacy receipt projection inert until its final schema
  // deletion; cleanup never claims or releases Controller authority.
  cleaned.receipt.ownership.controllerLease = 'already_released';
  const persisted = writeWorkHandle(ctx.controllerHome, {
    ...cleaned.handle,
    cleanupReceipt: cleaned.receipt,
  });
  updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeWorkId: undefined,
    activeCheckoutId: workReturnCheckoutId(ctx, persisted, session.activeCheckoutId),
  });
  if (cleaned.receipt.complete && !wasComplete) {
    appendWorkEvidence(
      { controllerHome: ctx.controllerHome, repoId: persisted.repositoryId },
      persisted.workContractId ?? persisted.workId,
      {
        title: 'terminal cleanup receipt',
        summary: `Cleanup ${cleaned.receipt.receiptId} completed for ${outcome}; Work outcome was preserved and no completion receipt was fabricated.`,
        detailLevel: 'summary',
      },
    );
  }
  if (cleaned.receipt.complete) {
    const terminalContract = getWorkContract(
      { controllerHome: ctx.controllerHome, repoId: persisted.repositoryId },
      persisted.workContractId ?? persisted.workId,
    );
    if (terminalContract && (terminalContract.status === 'cancelled' || terminalContract.status === 'failed') && terminalContract.phase !== 'cleanup') {
      transitionWorkContractPhase(
        { controllerHome: ctx.controllerHome, repoId: persisted.repositoryId },
        terminalContract.workId,
        {
          phase: 'cleanup',
          status: terminalContract.status,
          state: 'satisfied',
          summary: `Terminal cleanup ${cleaned.receipt.receiptId} completed; terminal Work status ${terminalContract.status} was preserved.`,
          evidenceRefs: terminalContract.evidenceRefs,
        },
      );
    }
  }
  return {
    work: compactHandle(persisted),
    stages: persisted.finalization,
    completed: false,
    cleanupCompleted: cleaned.receipt.complete,
    cleanupPartial: cleaned.receipt.partial,
    cleanupRetained: cleaned.receipt.worktree.status === 'retained' || cleaned.receipt.branchCleanup.status === 'retained',
    failurePreserved: true,
    cleanupReceipt: cleaned.receipt,
    idempotent: wasComplete,
  };
}
