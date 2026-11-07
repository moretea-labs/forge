import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { updateExecutionSession } from './session-store';
import { requireSession, sessionIdentityFor } from './session-execution-support';

export function currentPermissionSnapshotVersion(controllerHome: string, repoId: string): number {
  return readRepositoryAccessPolicy(controllerHome, repoId).revision;
}

export interface SessionRepositoryBinding {
  repoId: string;
  checkoutId: string;
  canonicalRoot: string;
  branch: string | null;
}

/** Session binding owns repository/checkout focus only; repository selection is resolved by the adapter boundary. */
export function bindSessionRepository(
  ctx: McpExecutionContext,
  args: Record<string, unknown>,
  repository: SessionRepositoryBinding,
): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const permissionSnapshotVersion = currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId);
  const switching = session.activeRepositoryId !== undefined
    && (session.activeRepositoryId !== repository.repoId || session.activeCheckoutId !== repository.checkoutId);
  const alreadyBound = session.activeRepositoryId === repository.repoId
    && session.activeCheckoutId === repository.checkoutId
    && session.permissionSnapshotVersion === permissionSnapshotVersion
    && !session.goalDelegation;
  if (alreadyBound) return { session, repository, switched: false };

  const next = updateExecutionSession(ctx.controllerHome, sessionIdentityFor(ctx, args), {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: repository.checkoutId,
    goalDelegation: undefined,
    permissionSnapshotVersion,
    lastValidatedAt: new Date().toISOString(),
  });
  return { session: next, repository, switched: switching };
}
