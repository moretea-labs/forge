import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  buildReviewArtifactIndex,
  ensureReviewArtifactRoots,
  prepareBrowserReviewPacket,
  prepareIosReviewPacket,
} from '../../../src/runtime/safe-tooling';
import { result } from './result-adapter';
import { selected } from './shared-adapter';

/** Transport-only compatibility adapter for review/transfer artifacts. */
export function callArtifactAdapter(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  switch (name) {
    case 'review_artifacts_prepare': {
      const repository = selected(ctx, args);
      return result(ensureReviewArtifactRoots(repository));
    }
    case 'review_artifacts_index': {
      const repository = selected(ctx, args);
      return result(buildReviewArtifactIndex(repository, { limit: args.limit }) as unknown as Record<string, unknown>);
    }
    case 'browser_review_packet': {
      const repository = selected(ctx, args);
      return result(prepareBrowserReviewPacket(repository, { limit: args.limit }) as unknown as Record<string, unknown>);
    }
    case 'ios_review_packet': {
      const repository = selected(ctx, args);
      return result(prepareIosReviewPacket(repository, { limit: args.limit }) as unknown as Record<string, unknown>);
    }
    default:
      return undefined;
  }
}
