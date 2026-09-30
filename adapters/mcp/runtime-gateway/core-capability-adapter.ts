import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { commitSelectedPaths, selectedPathDiff, stageSelectedPaths } from '../../../src/cli/repositories/selected-path-actions';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function callCoreCapabilityAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (name !== 'capability_execute') return undefined;
  const capabilityId = typeof args.capability_id === 'string' ? args.capability_id.trim() : '';
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  const input = object(args.arguments);

  try {
    if (capabilityId !== 'repository.git') {
      return result({ error: { code: 'CORE_CAPABILITY_UNSUPPORTED', message: `Unsupported core capability: ${capabilityId || '<empty>'}` } }, true);
    }
    const repository = selected(ctx, args);
    switch (action) {
      case 'diff_paths':
        return result({
          ...selectedPathDiff(repository, {
            paths: input.paths,
            staged: input.staged === true,
            maxBytes: typeof input.max_bytes === 'number' ? input.max_bytes : undefined,
          }),
        });
      case 'stage_paths': {
        const staged = stageSelectedPaths(ctx.controllerHome, repository, { paths: input.paths });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...staged,
        }, staged.execution.ok !== true);
      }
      case 'commit_paths': {
        const committed = commitSelectedPaths(ctx.controllerHome, repository, {
          paths: input.paths,
          message: input.message,
        });
        return result({
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          ...committed,
        }, Boolean(committed.error));
      }
      default:
        return result({ error: { code: 'CORE_CAPABILITY_ACTION_UNSUPPORTED', message: `Unsupported repository.git action: ${action || '<empty>'}` } }, true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1];
    return result({ error: { code: structuredCode ?? 'CORE_CAPABILITY_FAILED', message } }, true);
  }
}
