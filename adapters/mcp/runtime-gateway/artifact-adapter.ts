import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { writeControllerTaskLedgerArtifacts } from '../../../src/cli/controller/task-ledger';
import { prepareTransferArtifacts } from '../../../src/cli/repositories/selected-path-actions';
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
    case 'prepare_transfer_artifacts': {
      const repository = selected(ctx, args);
      const transfer = prepareTransferArtifacts(repository, { reason: args.reason });
      const taskLedger = writeControllerTaskLedgerArtifacts(repository.canonicalRoot, { reason: args.reason });
      return result({
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        ...transfer,
        taskLedger: taskLedger.projection,
        artifacts: [...transfer.artifacts, ...taskLedger.artifacts],
      });
    }
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
