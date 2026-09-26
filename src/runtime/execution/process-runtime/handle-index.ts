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

import { readForgeInstanceIdentity } from '../../../../packages/kernel/identity/api/index';
import { mutateControlPlaneRecord, readControlPlaneRecord } from '../../control-plane/persistence/sqlite-store';

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
  workId?: string;
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

export function recordProcessHandleIndexEntry(
  controllerHome: string,
  input: Omit<ProcessHandleIndexEntry, 'schemaVersion' | 'recordedAt' | 'updatedAt'> & { now?: string },
): ProcessHandleIndexEntry | undefined {
  const processId = boundedId(input.processId);
  if (!processId) return undefined;
  const now = input.now ?? new Date().toISOString();
  const principalId = boundedId(input.principalId);
  const workId = boundedId(input.workId);
  const commandId = boundedId(input.commandId);
  try {
    const record = mutateControlPlaneRecord<ProcessHandleIndexEntry>(controllerHome, {
      namespace: PROCESS_HANDLE_INDEX_NAMESPACE,
      scope: PROCESS_HANDLE_INDEX_SCOPE,
      key: processId,
      schemaVersion: PROCESS_HANDLE_INDEX_SCHEMA_VERSION,
      action: 'process_handle_index_record',
      mutate: (current) => ({
        schemaVersion: PROCESS_HANDLE_INDEX_SCHEMA_VERSION,
        processId,
        lane: input.lane,
        target: input.target,
        ...(principalId ? { principalId } : {}),
        ...(current?.value.principalId && !principalId ? { principalId: current.value.principalId } : {}),
        ...(workId ? { workId } : {}),
        ...(commandId ? { commandId } : {}),
        recordedAt: current?.value.recordedAt ?? now,
        updatedAt: now,
      }),
    });
    return record.value;
  } catch {
    // A locator projection must never block an already-authorized process.
    return undefined;
  }
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
    if (!value || value.schemaVersion !== PROCESS_HANDLE_INDEX_SCHEMA_VERSION || value.processId !== key) return undefined;
    if (!value.target || value.target.schemaVersion !== 1) return undefined;
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
