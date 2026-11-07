import { existsSync } from 'fs';
import { join } from 'path';
import { scopedOperationRoot } from '../../../effects/controller-home';
import { readJsonFile, sanitizeFileComponent } from '../../shared/json-files';
import type { ProcessCheckExecutionIdentity } from '../../evidence/process-check-execution';
import { listControlPlaneRecords, readOrImportControlPlaneRecord } from '../persistence/sqlite-store';

export const WORK_HANDLE_STATES = [
  'prepared',
  'editing',
  'validating',
  'committed',
  'merged',
  'failed_terminal_cleanup',
  'cleaned',
  'failed',
] as const;
export type WorkHandleStateName = (typeof WORK_HANDLE_STATES)[number];

export type WorkTerminalOutcome =
  | 'failed'
  | 'cancelled'
  | 'completed_cleanup'
  | 'blocked_terminal'
  | 'validation_failed'
  | 'infrastructure_failed';

export interface WorkCleanupReceipt {
  schemaVersion: 1;
  receiptId: string;
  repoId: string;
  checkoutId: string;
  workId: string;
  branch: string;
  targetBranch: string;
  terminalOutcome: WorkTerminalOutcome;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  verification: {
    mode: 'cleanup_only';
    checksRun: string[];
  };
  processes: {
    examined: string[];
    terminated: string[];
    blocking: string[];
    allTerminal: boolean;
  };
  ownership: {
    controllerLease: 'pending' | 'released' | 'already_released';
    processLeases: 'pending' | 'released' | 'partial';
  };
  preservation: {
    status: 'not_needed' | 'checkpointed' | 'patch_archived' | 'failed';
    checkpointCommit?: string;
    patchArchivePath?: string;
    patchArchiveSha256?: string;
    bundlePath?: string;
    bundleSha256?: string;
    bundleRetirement?: {
      status: 'eligible' | 'removed' | 'not_needed';
      reason: 'no_source_delta' | 'target_and_remote_content_contained';
      protectedRevision: string;
      targetRevision?: string;
      remoteRevision?: string;
      comparedPaths: string[];
      provedAt: string;
      removedAt?: string;
    };
    recoveryInstructions?: string;
  };
  worktree: {
    path: string;
    status: 'pending' | 'removed' | 'already_removed' | 'retained' | 'failed';
    reason?: string;
  };
  branchCleanup: {
    branch: string;
    status: 'pending' | 'deleted' | 'already_deleted' | 'retained' | 'archived' | 'failed';
    uniqueCommits?: number;
    reason?: string;
  };
  checkoutRegistry: {
    status: 'pending' | 'removed' | 'already_removed' | 'failed';
    reason?: string;
  };
  prune: {
    status: 'pending' | 'done' | 'failed';
    reason?: string;
  };
  complete: boolean;
  partial: boolean;
  blockers: string[];
}

export type WorkFinalizationFailureCode =
  | 'WORK_HANDLE_HEAD_CHANGED'
  | 'WORK_TARGET_ADVANCE_LINEAR_HISTORY_VIOLATION';

export interface WorkFinalizationStages {
  validation: 'pending' | 'done' | 'failed';
  commit: 'pending' | 'done' | 'skipped' | 'failed';
  merge: 'pending' | 'done' | 'skipped' | 'failed';
  branchCleanup: 'pending' | 'done' | 'skipped' | 'failed';
  worktreeCleanup: 'pending' | 'done' | 'skipped' | 'failed';
  /** Typed recovery classification. lastError remains diagnostic text only. */
  failureCode?: WorkFinalizationFailureCode;
  lastError?: string;
}

export interface WorkValidationRunState {
  fingerprint: string;
  head: string;
  workspaceFingerprint: string;
  requestedChecks: string[];
  resumeState: WorkHandleStateName;
  processes: Record<string, {
    processId: string;
    requestId: string;
    /** Exact producer-side Check identity for this Work verification snapshot. */
    checkExecution?: ProcessCheckExecutionIdentity;
  }>;
}

export interface WorkHandleState {
  schemaVersion: 1;
  /** Historical SQLite envelope revision retained for read compatibility. */
  recordRevision?: number;
  workId: string;
  sessionId: string;
  principalId: string;
  repositoryId: string;
  checkoutId: string;
  worktreePath: string;
  branch: string;
  sourceCheckoutId?: string;
  /** Canonical branch this repository-change Work is authorized to deliver into. Absent only for legacy handles. */
  deliveryTargetBranch?: string;
  goalId?: string;
  delegationVersion?: number;
  managedWorktree: boolean;
  workContractId?: string;
  baseCommit?: string;
  /** Latest canonical target HEAD incorporated into this Work candidate. Legacy records fall back to baseCommit. */
  deliveryBaseCommit?: string;
  expectedHead?: string;
  permissionSnapshotVersion: number;
  state: WorkHandleStateName;
  /**
   * Dirty baseline captured when a current-checkout Work was prepared on a
   * dirty shared checkout. Paths the Work did not author stay attributable to
   * their pre-Work state; bounded with `baselineDirtyPathCount` holding the
   * full count when the list was truncated.
   */
  baselineDirtyPaths?: string[];
  baselineDirtyPathCount?: number;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  finalization: WorkFinalizationStages;
  validationRun?: WorkValidationRunState;
  /** Exact successful validation input; finalization must recompute and match it. */
  validatedInputFingerprint?: string;
  /** Every managed checkout creator registers the Work finalizer as cleanup owner. */
  cleanupResponsibility?: {
    owner: 'work_finalizer';
    registeredAt: string;
  };
  /**
   * Explicit terminal resource disposition. This is separate from finalization
   * stage `skipped`, which is too ambiguous in legacy records to prove that a
   * controller intentionally retained a managed branch/worktree.
   */
  terminalResourceDisposition?: {
    mode: 'retained_by_request';
    retainWorktree: boolean;
    retainBranch: boolean;
    recordedAt: string;
  };
  /** Durable terminal cleanup progress. It is intentionally independent from completion/verification receipts. */
  cleanupReceipt?: WorkCleanupReceipt;
}

export function resolveWorkDeliveryTargetBranch(
  handle: Pick<WorkHandleState, 'workId' | 'deliveryTargetBranch'>,
  repositoryDefaultBranch?: string,
  explicitTargetBranch?: string,
): string {
  const bound = handle.deliveryTargetBranch?.trim();
  const explicit = explicitTargetBranch?.trim();
  if (bound) {
    if (explicit && explicit !== bound) {
      throw new Error(
        `WORK_DELIVERY_TARGET_BRANCH_MISMATCH: work ${handle.workId} is bound to ${bound}; omit target_branch or use ${bound}, not ${explicit}`,
      );
    }
    return bound;
  }
  return explicit || repositoryDefaultBranch?.trim() || 'main';
}

function workHandlePath(controllerHome: string, handle: Pick<WorkHandleState, 'repositoryId' | 'workId'>): string {
  return join(scopedOperationRoot(controllerHome, handle.repositoryId), 'work-handles', `${sanitizeFileComponent(handle.workId)}.json`);
}

export function readWorkHandle(controllerHome: string, repositoryId: string, workId: string): WorkHandleState | undefined {
  const path = workHandlePath(controllerHome, { repositoryId, workId });
  const record = readOrImportControlPlaneRecord<WorkHandleState>(controllerHome, {
    namespace: 'execution_work_handle',
    scope: repositoryId,
    key: sanitizeFileComponent(workId),
    schemaVersion: 1,
    readLegacy: () => existsSync(path) ? readJsonFile<WorkHandleState>(path) : undefined,
  });
  const handle = record?.value;
  if (!handle || !record) return undefined;
  if (handle.workId !== workId || handle.repositoryId !== repositoryId) throw new Error('WORK_HANDLE_IDENTITY_MISMATCH');
  return { ...handle, recordRevision: record.revision };
}

export function listWorkHandles(controllerHome: string, repositoryId: string, limit = 5_000): WorkHandleState[] {
  return listControlPlaneRecords<WorkHandleState>(controllerHome, {
    namespace: 'execution_work_handle',
    scope: repositoryId,
    limit: Math.max(1, limit),
  }).map((record) => ({ ...record.value, recordRevision: record.revision }));
}

/**
 * List historical WorkHandles with fail-closed behavior when the SQLite hard cap (5000) is
 * reached. Cleanup/recovery readers use this only to avoid acting on incomplete legacy inventory.
 * This function grants no Work lifecycle or repository mutation authority.
 */
export function listWorkHandlesFailClosed(
  controllerHome: string,
  repositoryId: string,
): WorkHandleState[] {
  const handles = listWorkHandles(controllerHome, repositoryId, 5_000);
  // SQLite caps inventory at 5,000. Reaching the cap cannot prove absence of
  // newer physical Writers or complete resource ownership; reject rather than
  // infer safety from truncated inventory.
  if (handles.length === 5_000) {
    throw new Error('WORK_HANDLE_OWNERSHIP_SCAN_INCOMPLETE');
  }
  return handles;
}
