import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  listWorkContracts,
  workSemanticView,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

/**
 * Bounded read-only legacy Work history for audit/migration only.
 * Open legacy records remain visible because old releases may have persisted them;
 * their stored state never grants current execution, progress, or lifecycle authority.
 */
export function callRhWorkListProjection(
  store: WorkContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (operation !== 'list') return undefined;
  const limit = Math.max(1, Math.min(Math.trunc(typeof args.limit === 'number' ? args.limit : 50), 100));
  const historyLimit = Math.min(limit, 50);
  const openLegacyRecords = listWorkContracts({ ...store, state: 'active', limit });
  const recentTerminalHistory = [
    ...listWorkContracts({ ...store, state: 'completed', limit: historyLimit }),
    ...listWorkContracts({ ...store, state: 'cancelled', limit: historyLimit }),
  ]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, historyLimit);
  const compact = (work: Parameters<typeof workSemanticView>[0]) => {
    const semantic = workSemanticView(work);
    return {
      workId: semantic.workId,
      revision: semantic.revision,
      semanticScope: semantic.semanticScope,
      objective: semantic.objective.slice(0, 240),
      state: semantic.state,
      ...(semantic.requirementId ? { requirementId: semantic.requirementId } : {}),
      ...(semantic.requirementRevision ? { requirementRevision: semantic.requirementRevision } : {}),
      ...(semantic.planId ? { planId: semantic.planId } : {}),
      ...(semantic.planRevision ? { planRevision: semantic.planRevision } : {}),
      ...(semantic.semanticParentWorkId ? { semanticParentWorkId: semantic.semanticParentWorkId } : {}),
      dependencyCount: semantic.dependsOnWorkIds?.length ?? 0,
      resultRefCount: semantic.resultRefs.length,
      createdAt: semantic.createdAt,
      updatedAt: semantic.updatedAt,
    };
  };
  return result(buildFacadeResult({
    summary: `${openLegacyRecords.length} open legacy and ${recentTerminalHistory.length} recent terminal Work record(s) retained read-only for audit/migration.`,
    data: {
      readOnlyLegacy: true,
      openLegacyRecords: openLegacyRecords.map(compact),
      recentTerminalHistory: recentTerminalHistory.map(compact),
      bounded: true,
      limit,
      historyLimit,
      detailOperation: 'get',
    },
  }) as unknown as Record<string, unknown>);
}
