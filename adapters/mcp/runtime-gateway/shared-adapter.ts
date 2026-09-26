import { listRepositories, resolveRepositorySelection } from '../../../src/cli/repositories/registry';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';

/** Transport selection only. Repository ownership remains in Repository Registry. */
export function selected(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>) {
  return resolveRepositorySelection({
    repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
    checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
    explicitPath: ctx.explicitRepository?.canonicalRoot,
    controllerHome: ctx.controllerHome,
    allowSoleRepository: true,
  });
}

export function repositoryRootForRepoId(controllerHome: string, repoId: string): string | undefined {
  return listRepositories(controllerHome).find((repository) => repository.repoId === repoId)?.canonicalRoot;
}

/**
 * Repository selection for tools whose semantics can be instance-scoped.
 *
 * An explicitly named repository (or the MCP server's default repository
 * context) stays authoritative and fails closed when invalid. When the caller
 * names none, a sole enabled repository is used; zero or several repositories
 * yield undefined so the caller can serve the ForgeInstance-level answer
 * instead of inventing a repository.
 */
export function selectedOptional(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): ReturnType<typeof selected> | undefined {
  const explicitRepoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  const explicitCheckoutId = typeof args.checkout_id === 'string' ? args.checkout_id.trim() : '';
  if (explicitRepoId || explicitCheckoutId || ctx.explicitRepository) return selected(ctx, args);
  const enabled = listRepositories(ctx.controllerHome).filter((record) => record.enabled);
  return enabled.length === 1 ? selected(ctx, args) : undefined;
}

export function expectedRevision(args: Record<string, unknown>, key = 'expected_revision'): number | undefined {
  return typeof args[key] === 'number' ? Math.trunc(args[key] as number) : undefined;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : [];
}
