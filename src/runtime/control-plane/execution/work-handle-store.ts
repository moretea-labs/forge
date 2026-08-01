import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent } from '../../shared/json-files';
import { readOrImportControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';

export const WORK_HANDLE_STATES = ['prepared', 'editing', 'validating', 'committed', 'merged', 'cleaned', 'failed'] as const;
export type WorkHandleStateName = (typeof WORK_HANDLE_STATES)[number];

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
  requestedChecks: string[];
  resumeState: WorkHandleStateName;
  processes: Record<string, { processId: string; requestId: string }>;
}

export interface WorkHandleState {
  schemaVersion: 1;
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
  if (!handle) return undefined;
  if (handle.workId !== workId || handle.repositoryId !== repositoryId) throw new Error('WORK_HANDLE_IDENTITY_MISMATCH');
  return handle;
}

export function writeWorkHandle(controllerHome: string, handle: WorkHandleState): WorkHandleState {
  const updated = { ...handle, updatedAt: now() };
  writeControlPlaneRecord(controllerHome, {
    namespace: 'execution_work_handle',
    scope: updated.repositoryId,
    key: sanitizeFileComponent(updated.workId),
    schemaVersion: updated.schemaVersion,
    value: updated,
    action: 'work_handle_write',
  });
  return updated;
}

const TRANSITIONS: Record<WorkHandleStateName, readonly WorkHandleStateName[]> = {
  prepared: ['editing', 'validating', 'committed', 'failed'],
  editing: ['validating', 'committed', 'merged', 'failed'],
  validating: ['editing', 'committed', 'merged', 'failed'],
  committed: ['validating', 'merged', 'cleaned', 'failed'],
  merged: ['cleaned', 'failed'],
  cleaned: [],
  failed: ['validating', 'editing', 'committed', 'merged', 'cleaned'],
};

export function transitionWorkHandle(
  controllerHome: string,
  handle: WorkHandleState,
  nextState: WorkHandleStateName,
  patch: Partial<Pick<WorkHandleState, 'failureReason' | 'expectedHead' | 'finalization' | 'validationRun'>> = {},
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
