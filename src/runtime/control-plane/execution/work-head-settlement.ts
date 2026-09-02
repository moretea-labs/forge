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
  repository: RepositoryRecord;
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
  const handle = readWorkHandle(input.controllerHome, input.repository.repoId, workId);
  if (!handle) return { settled: false, reason: 'work_handle_missing' };
  if (
    handle.repositoryId !== input.executionIdentity.repositoryId
    || handle.checkoutId !== input.executionIdentity.checkoutId
    || handle.workId !== input.executionIdentity.workId
    || handle.branch !== input.executionIdentity.branch
    || (input.executionIdentity.expectedHead !== undefined && handle.expectedHead !== input.executionIdentity.expectedHead)
  ) return { settled: false, reason: 'identity_mismatch' };
  if (handle.state === 'merged' || handle.state === 'cleaned' || handle.state === 'failed_terminal_cleanup') {
    return { settled: false, reason: 'terminal_handle' };
  }
  const status = repositoryGitStatus(input.repository);
  if (!status.branch || status.branch !== handle.branch) {
    return { settled: false, reason: 'branch_changed', previousHead: handle.expectedHead, currentHead: status.head ?? undefined };
  }
  const currentHead = status.head?.trim();
  if (!currentHead) return { settled: false, reason: 'head_unavailable', previousHead: handle.expectedHead };
  if (currentHead === handle.expectedHead) {
    return { settled: false, reason: 'head_unchanged', previousHead: handle.expectedHead, currentHead };
  }
  try {
    transitionWorkHandle(input.controllerHome, handle, handle.state, { expectedHead: currentHead });
    return { settled: true, reason: 'settled', previousHead: handle.expectedHead, currentHead };
  } catch (error) {
    if (error instanceof Error && error.message.includes('CONTROL_PLANE_REVISION_CONFLICT')) {
      return { settled: false, reason: 'concurrent_lifecycle_write', previousHead: handle.expectedHead, currentHead };
    }
    throw error;
  }
}
