/**
 * Canonical Process/Operation storage scope.
 *
 * Repository placement is optional context for a process, never its address
 * space. A process whose target is the Forge instance itself (host-local
 * command, controller-global operation, ephemeral workspace command) is stored
 * in the instance partition and is addressed by its process handle only.
 *
 * Scope keys are stable partition identifiers:
 *   - repository scope key is the registered repository id (unchanged on disk)
 *   - instance scope key is `instance`, which cannot collide with a registered
 *     repository id (`repo_*`) or workspace id (`workspace_*`)
 */

import { join } from 'path';
import {
  isWorkspaceScopeKey,
  repositoryControllerRoot,
  workspaceScopeRoot,
} from '../../../cli/repositories/controller-home';
import {
  forgeInstanceExecutionTarget,
  repositoryExecutionTarget,
  resolveProcessExecutionTarget,
  workspaceExecutionTarget,
  type ProcessExecutionTarget,
} from './handle-index';

export const FORGE_INSTANCE_PROCESS_SCOPE_KEY = 'instance';
/** Reserved prefix for workspace process scopes; registered repository ids are `repo_*`. */
export { WORKSPACE_SCOPE_PREFIX as WORKSPACE_PROCESS_SCOPE_PREFIX } from '../../../cli/repositories/controller-home';

export interface RepositoryProcessScope {
  schemaVersion: 1;
  kind: 'repository';
  repositoryId: string;
  checkoutId?: string;
}

export interface ForgeInstanceProcessScope {
  schemaVersion: 1;
  kind: 'forge_instance';
  forgeInstanceId?: string;
}

/**
 * An arbitrary workspace target has no repository semantics, so its processes
 * live in a workspace partition instead of a repository partition.
 */
export interface WorkspaceProcessScope {
  schemaVersion: 1;
  kind: 'workspace';
  workspaceId: string;
}

export type ProcessScope = RepositoryProcessScope | ForgeInstanceProcessScope | WorkspaceProcessScope;

function requireSegment(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(code);
  return normalized;
}

export function repositoryProcessScope(repositoryId: string, checkoutId?: string): RepositoryProcessScope {
  const repository = requireSegment(repositoryId, 'PROCESS_SCOPE_REPOSITORY_ID_REQUIRED');
  if (repository === FORGE_INSTANCE_PROCESS_SCOPE_KEY) throw new Error('PROCESS_SCOPE_REPOSITORY_ID_RESERVED');
  if (isWorkspaceScopeKey(repository)) throw new Error('PROCESS_SCOPE_REPOSITORY_ID_RESERVED');
  const checkout = checkoutId?.trim();
  return { schemaVersion: 1, kind: 'repository', repositoryId: repository, ...(checkout ? { checkoutId: checkout } : {}) };
}

export function forgeInstanceProcessScope(forgeInstanceId?: string): ForgeInstanceProcessScope {
  const instanceId = forgeInstanceId?.trim();
  return { schemaVersion: 1, kind: 'forge_instance', ...(instanceId ? { forgeInstanceId: instanceId } : {}) };
}

export function workspaceProcessScope(workspaceId: string): WorkspaceProcessScope {
  return { schemaVersion: 1, kind: 'workspace', workspaceId: requireSegment(workspaceId, 'PROCESS_SCOPE_WORKSPACE_ID_REQUIRED') };
}

/** Stable storage/attachment partition key for one process scope. */
export function processScopeKey(scope: ProcessScope): string {
  if (scope.kind === 'forge_instance') return FORGE_INSTANCE_PROCESS_SCOPE_KEY;
  if (scope.kind === 'workspace') return requireSegment(scope.workspaceId, 'PROCESS_SCOPE_WORKSPACE_ID_REQUIRED');
  if (isWorkspaceScopeKey(scope.repositoryId)) throw new Error('PROCESS_SCOPE_REPOSITORY_ID_RESERVED');
  return requireSegment(scope.repositoryId, 'PROCESS_SCOPE_REPOSITORY_ID_REQUIRED');
}

/**
 * Normalize a scope key supplied by a caller. A bare repository id keeps its
 * established meaning as the repository scope key; `instance` selects the
 * ForgeInstance partition.
 */
export function normalizeProcessScopeKey(value: string): string {
  const key = requireSegment(value, 'PROCESS_SCOPE_KEY_REQUIRED');
  return key;
}

export function processScopeFromKey(key: string): ProcessScope {
  const normalized = normalizeProcessScopeKey(key);
  if (normalized === FORGE_INSTANCE_PROCESS_SCOPE_KEY) return forgeInstanceProcessScope();
  if (isWorkspaceScopeKey(normalized)) return workspaceProcessScope(normalized);
  return repositoryProcessScope(normalized);
}

export function isForgeInstanceProcessScopeKey(key: string): boolean {
  return key.trim() === FORGE_INSTANCE_PROCESS_SCOPE_KEY;
}

/** An arbitrary workspace target is addressed by its workspace id, never by a repository id. */
export function isWorkspaceProcessScopeKey(key: string): boolean {
  return isWorkspaceScopeKey(key);
}

/** True when the scope key addresses a registered repository partition. */
export function isRepositoryProcessScopeKey(key: string): boolean {
  const normalized = key.trim();
  return normalized.length > 0
    && normalized !== FORGE_INSTANCE_PROCESS_SCOPE_KEY
    && !isWorkspaceProcessScopeKey(normalized);
}

/**
 * Controller-Home root for one process scope. Repository scopes keep their
 * existing per-repository layout; instance and workspace scopes own ordinary
 * sibling partitions so non-repository processes never require a synthetic
 * repository identity.
 */
export function processScopeRoot(controllerHome: string, scopeKey: string): string {
  const key = normalizeProcessScopeKey(scopeKey);
  if (isForgeInstanceProcessScopeKey(key)) return join(controllerHome, FORGE_INSTANCE_PROCESS_SCOPE_KEY);
  if (isWorkspaceProcessScopeKey(key)) return workspaceScopeRoot(controllerHome, key);
  return repositoryControllerRoot(controllerHome, key);
}

/** Read-only legacy location for workspace-scoped facts written before the workspace partition existed. */
export function legacyWorkspaceScopeRoot(controllerHome: string, scopeKey: string): string | undefined {
  const key = normalizeProcessScopeKey(scopeKey);
  return isWorkspaceProcessScopeKey(key) ? repositoryControllerRoot(controllerHome, key) : undefined;
}

/** Handle-index target for one scope, pinned to the serving ForgeInstance when available. */
export function processScopeExecutionTarget(controllerHome: string, scope: ProcessScope): ProcessExecutionTarget {
  if (scope.kind === 'repository') return repositoryExecutionTarget(controllerHome, scope.repositoryId, scope.checkoutId);
  if (scope.kind === 'workspace') return workspaceExecutionTarget(controllerHome, scope.workspaceId);
  return forgeInstanceExecutionTarget(controllerHome);
}

/**
 * Scope key recorded for one process handle. The Process Runtime owns this
 * instance-level index, so attachment resolves the target from the handle
 * instead of scanning repositories or replaying placement inputs.
 */
export function processScopeKeyForHandle(controllerHome: string, processId: string): string | undefined {
  const target = resolveProcessExecutionTarget(controllerHome, processId);
  if (!target) return undefined;
  if (target.scope === 'forge_instance') return FORGE_INSTANCE_PROCESS_SCOPE_KEY;
  if (target.scope === 'workspace') return target.workspaceId;
  return target.repositoryId;
}
