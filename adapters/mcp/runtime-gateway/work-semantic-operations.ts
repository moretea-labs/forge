import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  getWorkContract,
  listWorkSemanticRevisionRecords,
  reviseWorkSemanticContext,
  workSemanticView,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

const RH_WORK_SEMANTIC_OPERATIONS = new Set(['work_get', 'work_revise']);

export async function callRhWorkSemanticOperation(
  store: WorkContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!RH_WORK_SEMANTIC_OPERATIONS.has(operation)) return undefined;
  const workId = String(args.work_id ?? '').trim();
  if (operation === 'work_get') {
    const work = workId ? getWorkContract(store, workId) : undefined;
    if (!work) return result(buildFacadeResult({
      status: 'not_found', summary: `Work ${workId || '(missing)'} not found.`, data: { workId },
    }) as unknown as Record<string, unknown>, true);
    const semantic = workSemanticView(work);
    return result(buildFacadeResult({
      summary: `Work ${semantic.workId} retrieved at semantic revision ${semantic.revision}.`,
      data: {
        work: semantic,
        ...(args.detail_level === 'detail' ? { revisionHistory: listWorkSemanticRevisionRecords(store, semantic.workId, 100) } : {}),
      },
      detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
    }) as unknown as Record<string, unknown>);
  }

  const expectedRevision = Number(args.expected_revision);
  try {
    const revised = reviseWorkSemanticContext(store, workId, {
      expectedRevision,
      ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
      ...(args.work_state === 'open' || args.work_state === 'completed' || args.work_state === 'cancelled' ? { state: args.work_state } : {}),
      ...(typeof args.requirement_revision === 'number' ? { requirementRevision: args.requirement_revision } : {}),
      ...(typeof args.plan_revision === 'number' ? { planRevision: args.plan_revision } : {}),
      ...(Array.isArray(args.work_result_refs) ? { resultRefs: args.work_result_refs.map(String) } : {}),
    });
    const semantic = workSemanticView(revised);
    return result(buildFacadeResult({
      summary: `Work ${semantic.workId} revised atomically to semantic revision ${semantic.revision}.`,
      data: { work: semantic, expectedRevision, semanticRevision: semantic.revision },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    const current = workId ? getWorkContract(store, workId) : undefined;
    return result(buildFacadeResult({
      status: 'blocked', summary: error instanceof Error ? error.message : String(error),
      data: { workId, expectedRevision, ...(current ? { currentWork: workSemanticView(current) } : {}) },
    }) as unknown as Record<string, unknown>, true);
  }
}
