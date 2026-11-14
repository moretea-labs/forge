import { createHash } from 'crypto';
import { existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import type { RepositoryCommandScopeTarget } from './command-scope';

export interface EphemeralWorkspaceCoordinates {
  workspaceId: string;
  checkoutId: string;
  canonicalRoot: string;
}

export interface EphemeralWorkspaceTarget extends EphemeralWorkspaceCoordinates {
  /**
   * Typed command target for an arbitrary workspace: it carries the workspace
   * scope key and root, and no repository identity at all.
   */
  commandTarget: RepositoryCommandScopeTarget;
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

/**
 * `controllerHome` is retained for call-site compatibility; an arbitrary
 * workspace owns no controller-scoped repository record.
 */
export function resolveEphemeralWorkspaceTarget(rootInput: string, _controllerHome?: string): EphemeralWorkspaceTarget {
  const coordinates = ephemeralWorkspaceCoordinates(rootInput);
  return {
    ...coordinates,
    commandTarget: {
      canonicalRoot: coordinates.canonicalRoot,
      workspaceScopeKey: coordinates.workspaceId,
      // The workspace's own checkout coordinate, never a repository checkout id.
      activeCheckoutId: coordinates.checkoutId,
      enabled: true,
    },
  };
}
