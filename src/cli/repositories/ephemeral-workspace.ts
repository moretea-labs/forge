import { createHash } from 'crypto';
import { existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { RepositoryRecord } from './types';

export interface EphemeralWorkspaceCoordinates {
  workspaceId: string;
  checkoutId: string;
  canonicalRoot: string;
}

export interface EphemeralWorkspaceTarget extends EphemeralWorkspaceCoordinates {
  repository: RepositoryRecord;
}

export function ephemeralWorkspaceCoordinates(rootInput: string): EphemeralWorkspaceCoordinates {
  const raw = rootInput.trim();
  if (!raw) throw new Error('EPHEMERAL_WORKSPACE_ROOT_REQUIRED: workspace_root is required');
  if (raw.includes('\0')) throw new Error('EPHEMERAL_WORKSPACE_ROOT_INVALID: workspace_root contains a null byte');
  if (!isAbsolute(raw)) throw new Error('EPHEMERAL_WORKSPACE_ROOT_INVALID: workspace_root must be absolute');
  if (!existsSync(raw)) throw new Error(`EPHEMERAL_WORKSPACE_ROOT_MISSING: ${raw}`);
  const canonicalRoot = realpathSync(raw);
  if (!statSync(canonicalRoot).isDirectory()) throw new Error('EPHEMERAL_WORKSPACE_ROOT_INVALID: workspace_root must be a directory');
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 24);
  return {
    workspaceId: `workspace_${digest}`,
    checkoutId: `workspace_checkout_${digest}`,
    canonicalRoot,
  };
}

export function resolveEphemeralWorkspaceTarget(rootInput: string, controllerHome: string): EphemeralWorkspaceTarget {
  const coordinates = ephemeralWorkspaceCoordinates(rootInput);
  const now = new Date().toISOString();
  const repository: RepositoryRecord = {
    schemaVersion: 1,
    repoId: coordinates.workspaceId,
    displayName: `Ephemeral Workspace (${coordinates.canonicalRoot.split(/[\\/]/).at(-1) || 'root'})`,
    localRoot: coordinates.canonicalRoot,
    canonicalRoot: coordinates.canonicalRoot,
    activeCheckoutId: coordinates.checkoutId,
    checkouts: [{
      checkoutId: coordinates.checkoutId,
      localRoot: coordinates.canonicalRoot,
      canonicalRoot: coordinates.canonicalRoot,
      worktree: false,
      branch: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      lifecycle: 'active',
    }],
    repositoryType: 'unknown',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    configurationPath: join(controllerHome, 'ephemeral-workspaces', `${coordinates.workspaceId}.json`),
    stateStorageStrategy: 'controller-home',
  };
  return { ...coordinates, repository };
}
