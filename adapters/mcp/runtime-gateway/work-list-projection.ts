import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  listWorkContracts,
  workSemanticView,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

/**
 * Bounded read-only collection projection for current semantic Work.
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
  const works = listWorkContracts({ ...store, state: 'active', limit });
  return result(buildFacadeResult({
    summary: `${works.length} current semantic Work(s) in this repository.`,
    data: { works: works.map(workSemanticView), bounded: true },
  }) as unknown as Record<string, unknown>);
}
