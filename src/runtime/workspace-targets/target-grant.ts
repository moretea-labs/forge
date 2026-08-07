import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { controllerSystemRoot } from '../../cli/repositories/controller-home';
import {
  ControllerLockContentionError,
  withControllerLock,
} from '../../cli/repositories/locks';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export type WorkspaceTargetAccess = 'read_only' | 'read_write';
export type WorkspaceTargetOperation = 'read' | 'write';
export type WorkspaceTargetGitKind =
  | 'none'
  | 'repository_root'
  | 'linked_worktree_root'
  | 'within_repository';

export interface WorkspaceTargetGitIdentity {
  kind: WorkspaceTargetGitKind;
  repositoryRoot?: string;
  markerPath?: string;
}

/**
 * Persisted target grant. The first five fields are the historical schema-v1
 * record. New identity and access fields remain optional for compatibility.
 */
export interface WorkspaceTargetGrant {
  targetKey: string;
  rootPath: string;
  createdAt: string;
  expiresAt: string;
  reason: string;
  access?: WorkspaceTargetAccess;
  ownerScope?: string;
  controllerInstanceId?: string;
  workspaceId?: string;
  identityFingerprint?: string;
  git?: WorkspaceTargetGitIdentity;
}

export interface ActiveWorkspaceTargetGrant extends WorkspaceTargetGrant {
  access: WorkspaceTargetAccess;
  ownerScope: string;
  workspaceId: string;
  identityFingerprint: string;
  git: WorkspaceTargetGitIdentity;
}

interface WorkspaceTargetGrantStore {
  schemaVersion: 1;
  targets: WorkspaceTargetGrant[];
}

export interface AuthorizeWorkspaceTargetGrantInput {
  targetKey: string;
  rootPath: string;
  expiresInMinutes?: number;
  reason: string;
  access?: WorkspaceTargetAccess;
  ownerScope: string;
  controllerInstanceId?: string;
  now?: Date;
}

export interface ResolveWorkspaceTargetPathOptions {
  ownerScope: string;
  mustExist?: boolean;
  kind?: 'file' | 'directory';
  operation?: WorkspaceTargetOperation;
  at?: Date;
}

export interface ResolvedWorkspaceTargetPath {
  target: ActiveWorkspaceTargetGrant;
  root: string;
  path: string;
  relativePath: string;
}

export type WorkspaceTargetGrantErrorCode =
  | 'TARGET_ROOT_INVALID'
  | 'TARGET_KEY_REQUIRED'
  | 'TARGET_REASON_REQUIRED'
  | 'TARGET_STORE_CORRUPT'
  | 'TARGET_STORE_BUSY'
  | 'TARGET_IDENTITY_MISMATCH'
  | 'TARGET_OWNER_SCOPE_REQUIRED'
  | 'TARGET_OWNER_MISMATCH'
  | 'TARGET_UNAVAILABLE'
  | 'PATH_OUTSIDE_TARGET'
  | 'SYMLINK_ESCAPE'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_DIRECTORY'
  | 'PATH_NOT_FILE'
  | 'TARGET_ACCESS_DENIED';

export class WorkspaceTargetGrantError extends Error {
  constructor(
    public readonly code: WorkspaceTargetGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceTargetGrantError';
  }
}

function targetRoot(controllerHome: string): string {
  const root = join(controllerSystemRoot(controllerHome), 'local-system');
  mkdirSync(root, { recursive: true });
  return root;
}

/** Existing local_system storage remains the sole target-grant authority. */
export function workspaceTargetGrantStorePath(controllerHome: string): string {
  return join(targetRoot(controllerHome), 'targets.json');
}

function persistedString(
  value: unknown,
  field: string,
  index: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`targets[${index}].${field} must be a non-empty string`);
  }
  return value;
}

function validatePersistedGrant(value: unknown, index: number): WorkspaceTargetGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`targets[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const createdAt = persistedString(record.createdAt, 'createdAt', index);
  const expiresAt = persistedString(record.expiresAt, 'expiresAt', index);
  const createdMs = Date.parse(createdAt);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || expiresMs < createdMs) {
    throw new Error(`targets[${index}] has an invalid timestamp range`);
  }
  if (record.access !== undefined
    && record.access !== 'read_only'
    && record.access !== 'read_write') {
    throw new Error(`targets[${index}].access is invalid`);
  }
  const optionalStrings = [
    'ownerScope',
    'controllerInstanceId',
    'workspaceId',
    'identityFingerprint',
  ] as const;
  for (const field of optionalStrings) {
    if (record[field] !== undefined) persistedString(record[field], field, index);
  }
  if (record.git !== undefined) {
    if (!record.git || typeof record.git !== 'object' || Array.isArray(record.git)) {
      throw new Error(`targets[${index}].git must be an object`);
    }
    const git = record.git as Record<string, unknown>;
    if (!['none', 'repository_root', 'linked_worktree_root', 'within_repository']
      .includes(String(git.kind))) {
      throw new Error(`targets[${index}].git.kind is invalid`);
    }
    if (git.repositoryRoot !== undefined) {
      persistedString(git.repositoryRoot, 'git.repositoryRoot', index);
    }
    if (git.markerPath !== undefined) {
      persistedString(git.markerPath, 'git.markerPath', index);
    }
  }
  return {
    targetKey: persistedString(record.targetKey, 'targetKey', index),
    rootPath: persistedString(record.rootPath, 'rootPath', index),
    createdAt,
    expiresAt,
    reason: persistedString(record.reason, 'reason', index),
    ...(record.access !== undefined ? { access: record.access as WorkspaceTargetAccess } : {}),
    ...(record.ownerScope !== undefined ? { ownerScope: record.ownerScope as string } : {}),
    ...(record.controllerInstanceId !== undefined
      ? { controllerInstanceId: record.controllerInstanceId as string }
      : {}),
    ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId as string } : {}),
    ...(record.identityFingerprint !== undefined
      ? { identityFingerprint: record.identityFingerprint as string }
      : {}),
    ...(record.git !== undefined ? { git: record.git as WorkspaceTargetGitIdentity } : {}),
  };
}

function loadStore(controllerHome: string): WorkspaceTargetGrantStore {
  const path = workspaceTargetGrantStorePath(controllerHome);
  if (!existsSync(path)) return { schemaVersion: 1, targets: [] };
  try {
    const store = readJsonFile<WorkspaceTargetGrantStore>(path);
    if (store.schemaVersion !== 1 || !Array.isArray(store.targets)) {
      throw new Error('invalid target grant store schema');
    }
    return {
      schemaVersion: 1,
      targets: store.targets.map((target, index) => validatePersistedGrant(target, index)),
    };
  } catch (error) {
    if (error instanceof WorkspaceTargetGrantError) throw error;
    throw new WorkspaceTargetGrantError(
      'TARGET_STORE_CORRUPT',
      `Target grant store is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function saveStore(controllerHome: string, store: WorkspaceTargetGrantStore): void {
  writeJsonAtomic(workspaceTargetGrantStorePath(controllerHome), store);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function findExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new WorkspaceTargetGrantError(
        'PATH_OUTSIDE_TARGET',
        'No existing parent directory was found for the target path.',
      );
    }
    current = parent;
  }
  return current;
}

function detectGitIdentity(canonicalRoot: string): WorkspaceTargetGitIdentity {
  let cursor = canonicalRoot;
  while (true) {
    const markerPath = join(cursor, '.git');
    try {
      const marker = lstatSync(markerPath);
      const markerKind = marker.isSymbolicLink() ? statSync(markerPath) : marker;
      if (cursor === canonicalRoot) {
        return {
          kind: markerKind.isDirectory() ? 'repository_root' : 'linked_worktree_root',
          repositoryRoot: cursor,
          markerPath,
        };
      }
      return {
        kind: 'within_repository',
        repositoryRoot: cursor,
        markerPath,
      };
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return { kind: 'none' };
      cursor = parent;
    }
  }
}

function identity(
  canonicalRoot: string,
  ownerScope: string,
  access: WorkspaceTargetAccess,
): { workspaceId: string; identityFingerprint: string } {
  const identityFingerprint = createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: 1,
      authority: 'controllerHome/system/local-system/targets.json',
      canonicalRoot,
      ownerScope,
      access,
    }))
    .digest('hex');
  return {
    workspaceId: `workspace_${identityFingerprint.slice(0, 24)}`,
    identityFingerprint,
  };
}

function canonicalRoot(rootPath: string): string {
  if (!isAbsolute(rootPath) || !existsSync(rootPath)) {
    throw new WorkspaceTargetGrantError(
      'TARGET_ROOT_INVALID',
      'Target root must be an existing absolute directory.',
    );
  }
  const canonical = realpathSync(rootPath);
  if (!statSync(canonical).isDirectory()) {
    throw new WorkspaceTargetGrantError(
      'TARGET_ROOT_INVALID',
      'Target root must be an existing absolute directory.',
    );
  }
  return canonical;
}

function enrichGrant(grant: WorkspaceTargetGrant): ActiveWorkspaceTargetGrant {
  const rootPath = canonicalRoot(grant.rootPath);
  const access = grant.access ?? 'read_write';
  const ownerScope = grant.ownerScope?.trim() || 'legacy:shared';
  const derived = identity(rootPath, ownerScope, access);
  if ((grant.workspaceId && grant.workspaceId !== derived.workspaceId)
    || (grant.identityFingerprint
      && grant.identityFingerprint !== derived.identityFingerprint)) {
    throw new WorkspaceTargetGrantError(
      'TARGET_IDENTITY_MISMATCH',
      `Target ${grant.targetKey} identity does not match its canonical authorization facts.`,
    );
  }
  return {
    ...grant,
    rootPath,
    access,
    ownerScope,
    workspaceId: derived.workspaceId,
    identityFingerprint: derived.identityFingerprint,
    git: detectGitIdentity(rootPath),
  };
}

export function listActiveWorkspaceTargetGrants(
  controllerHome: string,
  at = new Date(),
  ownerScope?: string,
): ActiveWorkspaceTargetGrant[] {
  const current = at.getTime();
  const expectedOwner = ownerScope?.trim();
  return loadStore(controllerHome).targets
    .filter((target) => Date.parse(target.expiresAt) > current)
    .flatMap((target) => {
      try {
        return [enrichGrant(target)];
      } catch (error) {
        if (error instanceof WorkspaceTargetGrantError
          && error.code === 'TARGET_ROOT_INVALID') return [];
        throw error;
      }
    })
    .filter((target) => !expectedOwner
      || target.ownerScope === 'legacy:shared'
      || target.ownerScope === expectedOwner)
    .sort((left, right) => left.targetKey.localeCompare(right.targetKey));
}

export function authorizeWorkspaceTargetGrant(
  controllerHome: string,
  input: AuthorizeWorkspaceTargetGrantInput,
): ActiveWorkspaceTargetGrant {
  const ownerScope = input.ownerScope.trim();
  if (!ownerScope) {
    throw new WorkspaceTargetGrantError(
      'TARGET_OWNER_SCOPE_REQUIRED',
      'Target owner scope is required.',
    );
  }
  const rawTargetKey = input.targetKey.trim();
  if (!rawTargetKey) {
    throw new WorkspaceTargetGrantError('TARGET_KEY_REQUIRED', 'Target key is required.');
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new WorkspaceTargetGrantError('TARGET_REASON_REQUIRED', 'Target reason is required.');
  }
  const rootPath = canonicalRoot(input.rootPath);
  const access = input.access ?? 'read_write';
  const targetKey = sanitizeFileComponent(rawTargetKey);
  const createdAt = (input.now ?? new Date()).toISOString();
  const requestedExpiry = typeof input.expiresInMinutes === 'number'
    && Number.isFinite(input.expiresInMinutes)
    ? Math.trunc(input.expiresInMinutes)
    : 480;
  const expiresInMinutes = Math.max(1, Math.min(requestedExpiry, 1_440));
  const derived = identity(rootPath, ownerScope, access);
  const target: ActiveWorkspaceTargetGrant = {
    targetKey,
    rootPath,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + expiresInMinutes * 60_000).toISOString(),
    reason,
    access,
    ownerScope,
    ...(input.controllerInstanceId?.trim()
      ? { controllerInstanceId: input.controllerInstanceId.trim() }
      : {}),
    ...derived,
    git: detectGitIdentity(rootPath),
  };

  try {
    return withControllerLock(
      controllerHome,
      { scope: 'global', resource: 'local-system-target-grants' },
      `workspace-target-grant:${ownerScope}`,
      () => {
        const store = loadStore(controllerHome);
        store.targets = store.targets.filter((entry) => {
          if (entry.targetKey !== targetKey) return true;
          const existingOwner = entry.ownerScope?.trim() || 'legacy:shared';
          return existingOwner !== ownerScope && existingOwner !== 'legacy:shared';
        });
        store.targets.push(target);
        saveStore(controllerHome, store);
        return target;
      },
      5_000,
    );
  } catch (error) {
    if (error instanceof ControllerLockContentionError) {
      throw new WorkspaceTargetGrantError(
        'TARGET_STORE_BUSY',
        `Target grant store is busy: ${error.message}`,
      );
    }
    throw error;
  }
}

export function getActiveWorkspaceTargetGrant(
  controllerHome: string,
  targetKey: string,
  at = new Date(),
  ownerScope?: string,
): ActiveWorkspaceTargetGrant {
  const rawTargetKey = targetKey.trim();
  if (!rawTargetKey) {
    throw new WorkspaceTargetGrantError('TARGET_KEY_REQUIRED', 'Target key is required.');
  }
  const normalizedTargetKey = sanitizeFileComponent(rawTargetKey);
  const expectedOwner = ownerScope?.trim();
  const active = listActiveWorkspaceTargetGrants(controllerHome, at);
  const target = active.find((entry) => entry.targetKey === normalizedTargetKey
    && (!expectedOwner
      || entry.ownerScope === 'legacy:shared'
      || entry.ownerScope === expectedOwner));
  if (target) return target;
  if (expectedOwner && active.some((entry) => entry.targetKey === normalizedTargetKey)) {
    throw new WorkspaceTargetGrantError(
      'TARGET_OWNER_MISMATCH',
      `Target ${normalizedTargetKey} belongs to a different owner scope.`,
    );
  }
  throw new WorkspaceTargetGrantError(
    'TARGET_UNAVAILABLE',
    `Target ${normalizedTargetKey} is missing or expired.`,
  );
}

export function resolveWorkspaceTargetPath(
  controllerHome: string,
  targetKey: string,
  relativePath: string | undefined,
  options: ResolveWorkspaceTargetPathOptions,
): ResolvedWorkspaceTargetPath {
  const ownerScope = options.ownerScope.trim();
  if (!ownerScope) {
    throw new WorkspaceTargetGrantError(
      'TARGET_OWNER_SCOPE_REQUIRED',
      'Target owner scope is required for path resolution.',
    );
  }
  const target = getActiveWorkspaceTargetGrant(
    controllerHome,
    targetKey,
    options.at ?? new Date(),
    ownerScope,
  );
  const operation = options.operation ?? 'read';
  if (operation === 'write' && target.access !== 'read_write') {
    throw new WorkspaceTargetGrantError(
      'TARGET_ACCESS_DENIED',
      `Target ${targetKey} is read-only.`,
    );
  }

  const raw = (relativePath ?? '').trim();
  if (raw.includes('\0') || isAbsolute(raw)) {
    throw new WorkspaceTargetGrantError(
      'PATH_OUTSIDE_TARGET',
      'Path must be relative to the authorized target.',
    );
  }

  const root = canonicalRoot(target.rootPath);
  const candidate = resolve(root, raw || '.');
  if (!inside(root, candidate)) {
    throw new WorkspaceTargetGrantError(
      'PATH_OUTSIDE_TARGET',
      'Path traversal outside the authorized target is not allowed.',
    );
  }

  const ancestor = realpathSync(findExistingAncestor(candidate));
  if (!inside(root, ancestor)) {
    throw new WorkspaceTargetGrantError(
      'SYMLINK_ESCAPE',
      'A path component resolves outside the authorized target.',
    );
  }

  if (existsSync(candidate)) {
    const canonical = realpathSync(candidate);
    if (!inside(root, canonical)) {
      throw new WorkspaceTargetGrantError(
        'SYMLINK_ESCAPE',
        'The requested path resolves outside the authorized target.',
      );
    }
    if (options.kind === 'directory' && !statSync(canonical).isDirectory()) {
      throw new WorkspaceTargetGrantError(
        'PATH_NOT_DIRECTORY',
        'The requested path is not a directory.',
      );
    }
    if (options.kind === 'file' && !statSync(canonical).isFile()) {
      throw new WorkspaceTargetGrantError(
        'PATH_NOT_FILE',
        'The requested path is not a file.',
      );
    }
    return { target, root, path: canonical, relativePath: relative(root, canonical) };
  }

  if (options.mustExist) {
    throw new WorkspaceTargetGrantError(
      'PATH_NOT_FOUND',
      `Path ${raw || '.'} does not exist.`,
    );
  }
  return { target, root, path: candidate, relativePath: relative(root, candidate) };
}

export function resolveWorkspaceTargetCwd(
  controllerHome: string,
  targetKey: string,
  ownerScope: string,
  relativePath = '.',
  operation: WorkspaceTargetOperation = 'read',
  at?: Date,
): ResolvedWorkspaceTargetPath {
  return resolveWorkspaceTargetPath(controllerHome, targetKey, relativePath, {
    mustExist: true,
    kind: 'directory',
    operation,
    ownerScope,
    at,
  });
}
