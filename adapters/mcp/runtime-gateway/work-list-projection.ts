import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  listWorkContracts,
  workSemanticView,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

/**
 * Bounded read-only collection projection for current and recent terminal semantic Work.
 * Collection reads are separate from the semantic start/get/revise/complete
 * mutation adapter so listing can never widen or gate semantic completion.
 */
export function callRhWorkListProjection(
  store: WorkContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (operation !== 'list') return undefined;
  const limit = Math.max(1, Math.min(Math.trunc(typeof args.limit === 'number' ? args.limit : 50), 100));
  const historyLimit = Math.min(limit, 50);
  const works = listWorkContracts({ ...store, state: 'active', limit });
  const recentHistory = [
    ...listWorkContracts({ ...store, state: 'completed', limit: historyLimit }),
    ...listWorkContracts({ ...store, state: 'cancelled', limit: historyLimit }),
  ]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, historyLimit);
  return result(buildFacadeResult({
    summary: `${works.length} current and ${recentHistory.length} recent terminal semantic Work(s) in this repository.`,
    data: {
      works: works.map(workSemanticView),
      recentHistory: recentHistory.map(workSemanticView),
      bounded: true,
    },
  }) as unknown as Record<string, unknown>);
}
