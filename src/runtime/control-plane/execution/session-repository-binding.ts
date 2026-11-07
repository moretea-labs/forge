import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { resolveRepositorySelection } from '../../../cli/repositories/registry';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { updateExecutionSession } from './session-store';
import { requireSession, sessionIdentityFor } from './session-execution-support';

function requireExplicitRepoId(args: Record<string, unknown>): string {
  const value = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (!value) throw new Error('REPOSITORY_ID_REQUIRED: repository selection must be explicit for session binding');
  return value;
}

export function currentPermissionSnapshotVersion(controllerHome: string, repoId: string): number {
  return readRepositoryAccessPolicy(controllerHome, repoId).revision;
}

/** Session binding owns repository/checkout focus only; it never binds task or Work identity. */
export function bindSessionRepository(ctx: McpExecutionContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = resolveRepositorySelection({
    repoId: requireExplicitRepoId(args),
    checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
    controllerHome: ctx.controllerHome,
    allowSoleRepository: false,
  });
  const permissionSnapshotVersion = currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId);
  const repositoryBinding = {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    canonicalRoot: repository.canonicalRoot,
    branch: repository.checkouts.find((entry) => entry.checkoutId === repository.activeCheckoutId)?.branch ?? null,
  };
  const switching = session.activeRepositoryId !== undefined
    && (session.activeRepositoryId !== repository.repoId || session.activeCheckoutId !== repository.activeCheckoutId);
  const alreadyBound = session.activeRepositoryId === repository.repoId
    && session.activeCheckoutId === repository.activeCheckoutId
    && session.permissionSnapshotVersion === permissionSnapshotVersion
    && !session.goalDelegation;
  if (alreadyBound) return { session, repository: repositoryBinding, switched: false };

  const next = updateExecutionSession(ctx.controllerHome, sessionIdentityFor(ctx, args), {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: repository.activeCheckoutId,
    goalDelegation: undefined,
    permissionSnapshotVersion,
    lastValidatedAt: new Date().toISOString(),
  });
  return { session: next, repository: repositoryBinding, switched: switching };
}
