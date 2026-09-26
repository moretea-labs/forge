import { commandExecutionScopeKey, type RepositoryCommandScopeTarget } from '../../../cli/repositories/command-scope';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import type { ResolvedExecutionIdentity } from './execution-identity';
import { readWorkHandle, transitionWorkHandle } from './work-handle-store';

export type WorkHeadSettlementReason =
  | 'settled'
  | 'no_work'
  | 'command_not_successful'
  | 'work_handle_missing'
  | 'identity_mismatch'
  | 'terminal_handle'
  | 'branch_changed'
  | 'head_unavailable'
  | 'head_unchanged'
  | 'concurrent_lifecycle_write';

export interface WorkHeadSettlementResult {
  settled: boolean;
  reason: WorkHeadSettlementReason;
  previousHead?: string;
  currentHead?: string;
}

/**
 * Settle the one legitimate post-command Work HEAD transition without weakening
 * the pre-command execution identity fence. The immutable execution identity is
 * the authority captured before spawn; a concurrent lifecycle writer or branch
 * drift must not be adopted after the command returns.
 */
export function settleWorkHandleExpectedHeadAfterRepositoryCommand(input: {
  controllerHome: string;
  repository: RepositoryCommandScopeTarget;
  executionIdentity: ResolvedExecutionIdentity;
  workId?: string;
  ok?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
}): WorkHeadSettlementResult {
  const workId = input.workId?.trim();
  if (!workId) return { settled: false, reason: 'no_work' };
  if (input.ok !== true || input.cancelled === true || input.timedOut === true) {
    return { settled: false, reason: 'command_not_successful' };
  }
  const originalHandle = readWorkHandle(input.controllerHome, commandExecutionScopeKey(input.repository), workId);
  if (!originalHandle) return { settled: false, reason: 'work_handle_missing' };
  const sameStaticExecutionIdentity = (handle: typeof originalHandle): boolean => (
    handle.repositoryId === input.executionIdentity.repositoryId
    && handle.checkoutId === input.executionIdentity.checkoutId
    && handle.workId === input.executionIdentity.workId
    && handle.branch === input.executionIdentity.branch
  );
  if (!sameStaticExecutionIdentity(originalHandle)) return { settled: false, reason: 'identity_mismatch' };
  if (originalHandle.state === 'merged' || originalHandle.state === 'cleaned' || originalHandle.state === 'failed_terminal_cleanup') {
    return { settled: false, reason: 'terminal_handle' };
  }
  // A Work head settlement only runs for a Work-bound (repository) command, so
  // the scope target is a registered repository record at this point.
  const status = repositoryGitStatus(input.repository as RepositoryRecord);
  if (!status.branch || status.branch !== originalHandle.branch) {
    return { settled: false, reason: 'branch_changed', previousHead: originalHandle.expectedHead, currentHead: status.head ?? undefined };
  }
  const currentHead = status.head?.trim();
  if (!currentHead) return { settled: false, reason: 'head_unavailable', previousHead: originalHandle.expectedHead };
  const originalAuthorityHead = input.executionIdentity.expectedHead;
  if (originalHandle.expectedHead === currentHead) {
    if (originalAuthorityHead !== undefined && originalAuthorityHead !== currentHead) {
      return { settled: true, reason: 'settled', previousHead: originalAuthorityHead, currentHead };
    }
    return { settled: false, reason: 'head_unchanged', previousHead: originalHandle.expectedHead, currentHead };
  }
  if (originalAuthorityHead !== undefined && originalHandle.expectedHead !== originalAuthorityHead) {
    return { settled: false, reason: 'identity_mismatch', previousHead: originalHandle.expectedHead, currentHead };
  }
  try {
    transitionWorkHandle(input.controllerHome, originalHandle, originalHandle.state, { expectedHead: currentHead });
    return { settled: true, reason: 'settled', previousHead: originalHandle.expectedHead, currentHead };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('CONTROL_PLANE_REVISION_CONFLICT')) throw error;
  }

  // One concurrent lifecycle write is allowed to win the first CAS. Re-read the
  // exact Work authority and converge only when identity/branch are unchanged.
  const refreshedHandle = readWorkHandle(input.controllerHome, commandExecutionScopeKey(input.repository), workId);
  if (!refreshedHandle) return { settled: false, reason: 'work_handle_missing', previousHead: originalHandle.expectedHead, currentHead };
  if (!sameStaticExecutionIdentity(refreshedHandle)) {
    return { settled: false, reason: 'identity_mismatch', previousHead: refreshedHandle.expectedHead, currentHead };
  }
  if (refreshedHandle.expectedHead !== currentHead && originalAuthorityHead !== undefined && refreshedHandle.expectedHead !== originalAuthorityHead) {
    return { settled: false, reason: 'identity_mismatch', previousHead: refreshedHandle.expectedHead, currentHead };
  }
  if (refreshedHandle.state === 'merged' || refreshedHandle.state === 'cleaned' || refreshedHandle.state === 'failed_terminal_cleanup') {
    return { settled: false, reason: 'terminal_handle', previousHead: refreshedHandle.expectedHead, currentHead };
  }
  if (refreshedHandle.expectedHead === currentHead) {
    return { settled: true, reason: 'settled', previousHead: originalHandle.expectedHead, currentHead };
  }
  try {
    transitionWorkHandle(input.controllerHome, refreshedHandle, refreshedHandle.state, { expectedHead: currentHead });
    return { settled: true, reason: 'settled', previousHead: refreshedHandle.expectedHead, currentHead };
  } catch (error) {
    if (error instanceof Error && error.message.includes('CONTROL_PLANE_REVISION_CONFLICT')) {
      return { settled: false, reason: 'concurrent_lifecycle_write', previousHead: refreshedHandle.expectedHead, currentHead };
    }
    throw error;
  }
}
