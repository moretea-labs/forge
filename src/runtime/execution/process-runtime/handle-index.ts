/**
 * Instance-level Process handle index.
 *
 * Process attachment (get/wait/logs/cancel) resolves the concrete execution
 * target from the returned handle identity instead of replaying the original
 * placement inputs or scanning every repository partition. The index lives in
 * Controller Home, so it is a ForgeInstance-level locator: repository/checkout
 * placement is target metadata, never the address space of the process itself.
 *
 * This is a rebuildable locator projection. The Process Runtime record and its
 * exit receipt remain the only outcome evidence; a missing or stale index entry
 * degrades attachment convenience and never becomes a capability gate.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import { repositoryControllerRoot, workspaceScopeRoot } from '../../../effects/controller-home';
import {
  deleteControlPlaneRecord,
  mutateControlPlaneRecord,
  purgeExpiredRebuildableControlPlaneRecord,
  readControlPlaneRecord,
  scanControlPlaneRecordsWithMaintenanceCursor,
} from '../../control-plane/persistence/sqlite-store';

export const PROCESS_HANDLE_INDEX_NAMESPACE = 'process_handle_index';
const PROCESS_HANDLE_INDEX_SCOPE = 'instance';
const PROCESS_HANDLE_INDEX_SCHEMA_VERSION = 1;

export type ProcessExecutionTargetScope = 'forge_instance' | 'repository' | 'workspace';

/** Typed execution target for one process handle. Repository placement is optional context. */
export interface ProcessExecutionTarget {
  schemaVersion: 1;
  scope: ProcessExecutionTargetScope;
  forgeInstanceId?: string;
  repositoryId?: string;
  /** Workspace scope id when the target is an arbitrary workspace without repository semantics. */
  workspaceId?: string;
  checkoutId?: string;
}

export interface ProcessHandleIndexEntry {
  schemaVersion: 1;
  processId: string;
  lane: 'lightweight' | 'managed';
  target: ProcessExecutionTarget;
  /** Authenticated principal that owns the handle; opaque ids never authorize by themselves. */
  principalId?: string;
  commandId?: string;
  recordedAt: string;
  updatedAt: string;
}

function boundedId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

export function forgeInstanceIdFor(controllerHome: string): string | undefined {
  return readForgeInstanceIdentity(controllerHome)?.instanceId;
}

export function forgeInstanceExecutionTarget(controllerHome: string): ProcessExecutionTarget {
  const forgeInstanceId = forgeInstanceIdFor(controllerHome);
  return { schemaVersion: 1, scope: 'forge_instance', ...(forgeInstanceId ? { forgeInstanceId } : {}) };
}

export function repositoryExecutionTarget(
  controllerHome: string,
  repositoryId: string,
  checkoutId?: string,
): ProcessExecutionTarget {
  const forgeInstanceId = forgeInstanceIdFor(controllerHome);
  const repository = boundedId(repositoryId);
  if (!repository) throw new Error('PROCESS_EXECUTION_TARGET_REPOSITORY_REQUIRED');
  const checkout = boundedId(checkoutId);
  return {
    schemaVersion: 1,
    scope: 'repository',
    ...(forgeInstanceId ? { forgeInstanceId } : {}),
    repositoryId: repository,
    ...(checkout ? { checkoutId: checkout } : {}),
  };
}

/** Target for an arbitrary workspace: no repository identity is created or implied. */
export function workspaceExecutionTarget(controllerHome: string, workspaceId: string): ProcessExecutionTarget {
  const workspace = boundedId(workspaceId);
  if (!workspace) throw new Error('PROCESS_EXECUTION_TARGET_WORKSPACE_REQUIRED');
  const forgeInstanceId = forgeInstanceIdFor(controllerHome);
  return {
    schemaVersion: 1,
    scope: 'workspace',
    ...(forgeInstanceId ? { forgeInstanceId } : {}),
    workspaceId: workspace,
  };
}

function sameProcessExecutionTarget(left: ProcessExecutionTarget, right: ProcessExecutionTarget): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.scope === right.scope &&
    left.forgeInstanceId === right.forgeInstanceId &&
    left.repositoryId === right.repositoryId &&
    left.workspaceId === right.workspaceId &&
    left.checkoutId === right.checkoutId
  );
}

function processRecordPathForHandle(controllerHome: string, entry: ProcessHandleIndexEntry): string | undefined {
  const processId = boundedId(entry.processId);
  if (!processId) return undefined;
  // Mirror processScopeRoot without importing process-scope (it depends on this module).
  if (entry.target.scope === 'repository') {
    const repositoryId = boundedId(entry.target.repositoryId);
    if (!repositoryId) return undefined;
    return join(repositoryControllerRoot(controllerHome, repositoryId), 'processes', `${processId}.json`);
  }
  if (entry.target.scope === 'workspace') {
    const workspaceId = boundedId(entry.target.workspaceId);
    if (!workspaceId) return undefined;
    return join(workspaceScopeRoot(controllerHome, workspaceId), 'processes', `${processId}.json`);
  }
  return join(controllerHome, 'instance', 'processes', `${processId}.json`);
}

export function recordProcessHandleIndexEntry(
  controllerHome: string,
  input: Omit<ProcessHandleIndexEntry, 'schemaVersion' | 'recordedAt' | 'updatedAt'> & { now?: string },
): ProcessHandleIndexEntry | undefined {
  const processId = boundedId(input.processId);
  if (!processId) return undefined;
  const now = input.now ?? new Date().toISOString();
  const principalId = boundedId(input.principalId);
  const commandId = boundedId(input.commandId);
  try {
    const record = mutateControlPlaneRecord<ProcessHandleIndexEntry>(controllerHome, {
      namespace: PROCESS_HANDLE_INDEX_NAMESPACE,
      scope: PROCESS_HANDLE_INDEX_SCOPE,
      key: processId,
      schemaVersion: PROCESS_HANDLE_INDEX_SCHEMA_VERSION,
      action: 'process_handle_index_record',
      skipWriteWhenMutationReturnsCurrent: true,
      mutate: (current) => {
        const currentValue = current?.value;
        const nextPrincipal = principalId ?? (currentValue?.principalId ? currentValue.principalId : undefined);
        const nextCommand = commandId ?? currentValue?.commandId;
        if (
          current &&
          current.schemaVersion === PROCESS_HANDLE_INDEX_SCHEMA_VERSION &&
          currentValue &&
          currentValue.processId === processId &&
          currentValue.lane === input.lane &&
          sameProcessExecutionTarget(currentValue.target, input.target) &&
          currentValue.principalId === nextPrincipal &&
          currentValue.commandId === nextCommand
        ) {
          // Locator identity unchanged: keep the current value object so the
          // control-plane writer skips revision/audit amplification (#377).
          return currentValue;
        }
        return {
          schemaVersion: PROCESS_HANDLE_INDEX_SCHEMA_VERSION,
          processId,
          lane: input.lane,
          target: input.target,
          ...(nextPrincipal ? { principalId: nextPrincipal } : {}),
          ...(nextCommand ? { commandId: nextCommand } : {}),
          recordedAt: currentValue?.recordedAt ?? now,
          updatedAt: now,
        };
      },
    });
    return record.value;
  } catch {
    // A locator projection must never block an already-authorized process.
    return undefined;
  }
}

/** Remove a rebuildable process handle locator after its Process record is gone. */
export function deleteProcessHandleIndexEntry(controllerHome: string, processId: string): boolean {
  const key = boundedId(processId);
  if (!key) return false;
  try {
    return deleteControlPlaneRecord(controllerHome, {
      namespace: PROCESS_HANDLE_INDEX_NAMESPACE,
      scope: PROCESS_HANDLE_INDEX_SCOPE,
      key,
      action: 'process_handle_index_delete',
    });
  } catch {
    return false;
  }
}

/**
 * Bound stale handle-index rows whose Process record is already gone. This is a
 * rebuildable locator GC only; missing entries never authorize or block attachment.
 */
export function gcOrphanedProcessHandleIndexEntries(
  controllerHome: string,
  options: { olderThanMs: number; maxRows?: number; nowMs?: number } = { olderThanMs: 7 * 24 * 60 * 60_000 },
): { examined: number; removed: number } {
  const olderThanMs = Math.max(0, Math.trunc(options.olderThanMs));
  const maxRows = Math.max(1, Math.min(Math.trunc(options.maxRows ?? 500), 5_000));
  const cutoffMs = (options.nowMs ?? Date.now()) - olderThanMs;
  const records = scanControlPlaneRecordsWithMaintenanceCursor<ProcessHandleIndexEntry>(controllerHome, {
    namespace: PROCESS_HANDLE_INDEX_NAMESPACE,
    cursorName: 'process_handle_index_gc',
    limit: maxRows,
  }).filter((record) => record.scope === PROCESS_HANDLE_INDEX_SCOPE);
  let examined = 0;
  let removed = 0;
  for (const record of records) {
    examined += 1;
    const updatedMs = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedMs) || updatedMs > cutoffMs) continue;
    const entry = record.value;
    if (!entry || entry.schemaVersion !== PROCESS_HANDLE_INDEX_SCHEMA_VERSION) continue;
    const processPath = processRecordPathForHandle(controllerHome, entry);
    if (processPath && existsSync(processPath)) continue;
    try {
      if (purgeExpiredRebuildableControlPlaneRecord(controllerHome, {
        namespace: PROCESS_HANDLE_INDEX_NAMESPACE,
        scope: record.scope,
        key: record.key,
        expectedRevision: record.revision,
      })) removed += 1;
    } catch {
      // A refreshed locator won the race with this stale scan. Leave the
      // current authority intact and let a later maintenance sweep re-evaluate.
    }
  }
  return { examined, removed };
}

export function readProcessHandleIndexEntry(
  controllerHome: string,
  processId: string,
): ProcessHandleIndexEntry | undefined {
  const key = boundedId(processId);
  if (!key) return undefined;
  try {
    const record = readControlPlaneRecord<ProcessHandleIndexEntry>(
      controllerHome,
      PROCESS_HANDLE_INDEX_NAMESPACE,
      PROCESS_HANDLE_INDEX_SCOPE,
      key,
    );
    const value = record?.value;
    if (!value || value.schemaVersion !== PROCESS_HANDLE_INDEX_SCHEMA_VERSION || value.processId !== key)
      return undefined;
    if (value.target?.schemaVersion !== 1) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Resolve the concrete execution target recorded for one process handle. */
export function resolveProcessExecutionTarget(
  controllerHome: string,
  processId: string,
): ProcessExecutionTarget | undefined {
  return readProcessHandleIndexEntry(controllerHome, processId)?.target;
}

/**
 * Principal that owns one process handle, when recorded. Opaque handle ids
 * locate a record; they never authorize attachment on their own.
 */
export function processHandlePrincipalId(controllerHome: string, processId: string): string | undefined {
  return readProcessHandleIndexEntry(controllerHome, processId)?.principalId;
}

/** Compatibility narrowing: the repository placement recorded for a process, when it has one. */
export function resolveProcessRepositoryTarget(
  controllerHome: string,
  processId: string,
): { repositoryId: string; checkoutId?: string } | undefined {
  const target = resolveProcessExecutionTarget(controllerHome, processId);
  if (!target?.repositoryId) return undefined;
  return { repositoryId: target.repositoryId, ...(target.checkoutId ? { checkoutId: target.checkoutId } : {}) };
}
