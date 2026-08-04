import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent } from '../../shared/json-files';
import { listControlPlaneRecords, readOrImportControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';

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

export interface WorkFinalizationStages {
  validation: 'pending' | 'done' | 'failed';
  commit: 'pending' | 'done' | 'skipped' | 'failed';
  merge: 'pending' | 'done' | 'skipped' | 'failed';
  branchCleanup: 'pending' | 'done' | 'skipped' | 'failed';
  worktreeCleanup: 'pending' | 'done' | 'skipped' | 'failed';
  lastError?: string;
}

export interface WorkValidationRunState {
  fingerprint: string;
  head: string;
  workspaceFingerprint: string;
  requestedChecks: string[];
  resumeState: WorkHandleStateName;
  processes: Record<string, { processId: string; requestId: string }>;
}

export interface WorkHandleState {
  schemaVersion: 1;
  /** SQLite envelope revision used for compare-and-swap lifecycle writes. */
  recordRevision?: number;
  workId: string;
  sessionId: string;
  principalId: string;
  repositoryId: string;
  checkoutId: string;
  worktreePath: string;
  branch: string;
  sourceCheckoutId?: string;
  goalId?: string;
  delegationVersion?: number;
  managedWorktree: boolean;
  workContractId?: string;
  baseCommit?: string;
  expectedHead?: string;
  permissionSnapshotVersion: number;
  state: WorkHandleStateName;
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
  /** Durable terminal cleanup progress. It is intentionally independent from completion/verification receipts. */
  cleanupReceipt?: WorkCleanupReceipt;
}

function workHandlePath(controllerHome: string, handle: Pick<WorkHandleState, 'repositoryId' | 'workId'>): string {
  return join(repositoryControllerRoot(controllerHome, handle.repositoryId), 'work-handles', `${sanitizeFileComponent(handle.workId)}.json`);
}

function now(): string {
  return new Date().toISOString();
}

export function newWorkId(): string {
  return `work_${randomUUID().replace(/-/g, '')}`;
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

export function writeWorkHandle(controllerHome: string, handle: WorkHandleState): WorkHandleState {
  const { recordRevision, ...persistedHandle } = handle;
  const updated: Omit<WorkHandleState, 'recordRevision'> = { ...persistedHandle, updatedAt: now() };
  const record = writeControlPlaneRecord(controllerHome, {
    namespace: 'execution_work_handle',
    scope: updated.repositoryId,
    key: sanitizeFileComponent(updated.workId),
    schemaVersion: updated.schemaVersion,
    value: updated,
    action: 'work_handle_write',
    ...(recordRevision !== undefined ? { expectedRevision: recordRevision } : {}),
  });
  return { ...record.value, recordRevision: record.revision };
}

const TRANSITIONS: Record<WorkHandleStateName, readonly WorkHandleStateName[]> = {
  prepared: ['editing', 'validating', 'committed', 'failed', 'failed_terminal_cleanup'],
  editing: ['validating', 'committed', 'merged', 'failed', 'failed_terminal_cleanup'],
  validating: ['editing', 'committed', 'merged', 'failed', 'failed_terminal_cleanup'],
  committed: ['validating', 'merged', 'cleaned', 'failed', 'failed_terminal_cleanup'],
  merged: ['cleaned', 'failed', 'failed_terminal_cleanup'],
  failed_terminal_cleanup: ['failed_terminal_cleanup', 'cleaned'],
  cleaned: [],
  failed: ['validating', 'editing', 'committed', 'merged', 'cleaned', 'failed_terminal_cleanup'],
};

export function transitionWorkHandle(
  controllerHome: string,
  handle: WorkHandleState,
  nextState: WorkHandleStateName,
  patch: Partial<Pick<WorkHandleState, 'failureReason' | 'expectedHead' | 'finalization' | 'validationRun' | 'validatedInputFingerprint' | 'cleanupReceipt'>> = {},
): WorkHandleState {
  if (handle.state !== nextState && !TRANSITIONS[handle.state].includes(nextState)) {
    throw new Error(`WORK_HANDLE_LIFECYCLE_INVALID: cannot transition ${handle.state} -> ${nextState}`);
  }
  return writeWorkHandle(controllerHome, {
    ...handle,
    ...patch,
    state: nextState,
    ...(nextState === 'failed' && !patch.failureReason ? { failureReason: handle.failureReason ?? 'work handle failed' } : {}),
  });
}

export function markWorkHandleFailed(controllerHome: string, handle: WorkHandleState, reason: string): WorkHandleState {
  return writeWorkHandle(controllerHome, {
    ...handle,
    state: 'failed',
    failureReason: reason.slice(0, 1_000),
  });
}
