import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  applyExternalFilesystemGrant,
  listExternalFilesystemTargets,
  previewExternalFilesystemGrant,
  readExternalFilesystemSnapshot,
} from '../../../src/runtime/safe-tooling';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

/** Transport-only compatibility adapter for explicit external-filesystem capabilities. */
export function callFilesystemAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  switch (name) {
    case 'external_filesystem_targets_list': {
      const repository = selected(ctx, args);
      return result(listExternalFilesystemTargets(repository.canonicalRoot));
    }
    case 'external_filesystem_grant_preview': {
      const repository = selected(ctx, args);
      return result(previewExternalFilesystemGrant(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
    }
    case 'external_filesystem_grant_apply': {
      const repository = selected(ctx, args);
      return result(applyExternalFilesystemGrant(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
    }
    case 'external_filesystem_text_snapshot': {
      const repository = selected(ctx, args);
      return result(readExternalFilesystemSnapshot(repository.canonicalRoot, args) as unknown as Record<string, unknown>);
    }
    default:
      return undefined;
  }
}
