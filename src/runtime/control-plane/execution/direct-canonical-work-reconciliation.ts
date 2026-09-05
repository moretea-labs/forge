import { spawnSync } from 'child_process';
import { realpathSync } from 'fs';
import type { RepositoryGitStatusSnapshot } from '../../../cli/repositories/structured-git';
import type { WorkHandleState } from './work-handle-store';

export function gitIsAncestor(root: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`WORK_TARGET_ADVANCE_ANCESTRY_UNAVAILABLE: ${ancestor} -> ${descendant}`);
  }
  return result.status === 0;
}

export type DirectCanonicalPreMutationReason =
  | 'not_prepared'
  | 'not_direct_target'
  | 'path_mismatch'
  | 'branch_mismatch'
  | 'workspace_dirty'
  | 'revision_unavailable'
  | 'delivery_identity_not_pristine'
  | 'no_target_advance'
  | 'target_history_rewritten'
  | 'alignable';

export interface DirectCanonicalPreMutationInspection {
  alignable: boolean;
  reason: DirectCanonicalPreMutationReason;
  previousDeliveryBase?: string;
  targetHead?: string;
}

/**
 * Decide whether a Direct canonical Work may cross its first repository-mutation
 * boundary. Before that boundary the shared checkout must still be clean, so any
 * linear target advancement is unambiguously target-owned rather than Work-owned.
 * The caller persists the accepted base movement and the prepared -> editing
 * transition together before allowing repository bytes to change.
 */
export function inspectDirectCanonicalPreMutationReconciliation(input: {
  handle: WorkHandleState;
  root: string;
  targetBranch: string;
  status: RepositoryGitStatusSnapshot;
  freshlyMaterialized: boolean;
}): DirectCanonicalPreMutationInspection {
  const empty = (reason: DirectCanonicalPreMutationReason): DirectCanonicalPreMutationInspection => ({
    alignable: false,
    reason,
  });
  if (input.handle.state !== 'prepared') return empty('not_prepared');
  if (input.handle.managedWorktree || input.handle.branch !== input.targetBranch) return empty('not_direct_target');
  try {
    if (realpathSync(input.root) !== realpathSync(input.handle.worktreePath)) return empty('path_mismatch');
  } catch {
    return empty('path_mismatch');
  }
  if (input.status.branch !== input.targetBranch) return empty('branch_mismatch');
  if (!input.status.clean) return empty('workspace_dirty');

  const previousDeliveryBase = input.handle.deliveryBaseCommit ?? input.handle.baseCommit;
  const expectedHead = input.handle.expectedHead;
  const targetHead = input.status.head ?? undefined;
  if (!previousDeliveryBase || !expectedHead || !targetHead) return empty('revision_unavailable');
  if (
    expectedHead !== previousDeliveryBase
    && !(input.freshlyMaterialized && expectedHead === targetHead)
  ) {
    return { ...empty('delivery_identity_not_pristine'), previousDeliveryBase, targetHead };
  }
  if (targetHead === previousDeliveryBase) {
    return { ...empty('no_target_advance'), previousDeliveryBase, targetHead };
  }
  if (!gitIsAncestor(input.root, previousDeliveryBase, targetHead)) {
    return { ...empty('target_history_rewritten'), previousDeliveryBase, targetHead };
  }
  return {
    alignable: true,
    reason: 'alignable',
    previousDeliveryBase,
    targetHead,
  };
}
