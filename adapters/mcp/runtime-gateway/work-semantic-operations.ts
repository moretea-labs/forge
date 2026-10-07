import { createHash, randomUUID } from 'crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  createWorkSemanticContext,
  getWorkContract,
  listWorkSemanticRevisionRecords,
  readWorkContractStore,
  normalizeWorkObjectiveRelationIds,
  projectWorkObjectiveGraph,
  reviseWorkSemanticContext,
  workSemanticView,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { buildWorkContinuationSnapshot } from '../../../src/runtime/control-plane/facade/work-continuation';
import { result } from './result-adapter';
import { projectWorkExecutionEvidence } from './work-detail-projection';
import { readWorkHandle } from '../../../src/runtime/control-plane/execution/work-handle-store';
import { reconcileSingleTerminalWorkCleanup } from '../../../src/runtime/control-plane/execution/work-terminal-cleanup';

const RH_WORK_SEMANTIC_OPERATIONS = new Set(['start', 'get', 'revise', 'complete']);

export function semanticWorkId(store: WorkContractStoreOptions, args: Record<string, unknown>): string {
  const explicit = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (explicit) return explicit;
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (requestId) {
    const scopeKey = store.scopeKey?.trim() || store.repoId?.trim() || 'semantic';
    const digest = createHash('sha256').update(`${scopeKey}\0${requestId}`).digest('hex').slice(0, 12);
    return `work-semantic-${digest}`;
  }
  return `work-semantic-${randomUUID().slice(0, 12)}`;
}

function semanticCreateMatches(existing: ReturnType<typeof getWorkContract>, args: Record<string, unknown>, requestId: string): boolean {
  if (!existing) return false;
  const objective = String(args.objective ?? '').trim();
  const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
  const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
  const semanticParentWorkId = typeof args.semantic_parent_work_id === 'string' ? args.semantic_parent_work_id.trim() : '';
  const dependsOnWorkIds = normalizeWorkObjectiveRelationIds(Array.isArray(args.depends_on_work_ids) ? args.depends_on_work_ids.map(String) : []).sort();
  const existingDependencies = normalizeWorkObjectiveRelationIds(existing.dependsOnWorkIds).sort();
  return existing.objective === objective
    && (existing.requirementId ?? '') === requirementId
    && (existing.planId ?? '') === planId
    && (existing.semanticParentWorkId ?? '') === semanticParentWorkId
    && existingDependencies.length === dependsOnWorkIds.length
    && existingDependencies.every((id, index) => id === dependsOnWorkIds[index])
    && (existing.requestId ?? '') === requestId;
}

export async function callRhWorkSemanticOperation(
  store: WorkContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!RH_WORK_SEMANTIC_OPERATIONS.has(operation)) return undefined;
  const workId = operation === 'start' ? semanticWorkId(store, args) : String(args.work_id ?? '').trim();
  if (operation === 'start') {
    const objective = String(args.objective ?? '').trim();
    if (!objective) return result(buildFacadeResult({
      status: 'blocked', summary: 'WORK_OBJECTIVE_REQUIRED', data: { workId },
    }) as unknown as Record<string, unknown>, true);
    const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
    const existing = getWorkContract(store, workId);
    if (existing) {
      if (!semanticCreateMatches(existing, args, requestId)) return result(buildFacadeResult({
        status: 'blocked',
        summary: `WORK_SEMANTIC_CREATE_CONFLICT: ${workId}`,
        data: { workId, currentWork: workSemanticView(existing) },
      }) as unknown as Record<string, unknown>, true);
      return result(buildFacadeResult({
        summary: `Work ${workId} already exists; semantic create was deduplicated.`,
        data: { work: workSemanticView(existing), deduplicated: true },
      }) as unknown as Record<string, unknown>);
    }
    try {
      const created = createWorkSemanticContext(store, {
        workId,
        objective,
        requestedBy: 'chatgpt',
        ...(typeof args.requirement_id === 'string' && args.requirement_id.trim() ? { requirementId: args.requirement_id.trim() } : {}),
        ...(typeof args.requirement_revision === 'number' ? { requirementRevision: args.requirement_revision } : {}),
        ...(typeof args.plan_id === 'string' && args.plan_id.trim() ? { planId: args.plan_id.trim() } : {}),
        ...(typeof args.plan_revision === 'number' ? { planRevision: args.plan_revision } : {}),
        ...(typeof args.semantic_parent_work_id === 'string' ? { semanticParentWorkId: args.semantic_parent_work_id } : {}),
        ...(Array.isArray(args.depends_on_work_ids) ? { dependsOnWorkIds: args.depends_on_work_ids.map(String) } : {}),
        ...(requestId ? { requestId } : {}),
      });
      return result(buildFacadeResult({
        summary: `Work ${workId} created as semantic context.`,
        data: { work: workSemanticView(created), deduplicated: false },
      }) as unknown as Record<string, unknown>);
    } catch (error) {
      const raced = getWorkContract(store, workId);
      if (raced && semanticCreateMatches(raced, args, requestId)) return result(buildFacadeResult({
        summary: `Work ${workId} already exists; semantic create was deduplicated.`,
        data: { work: workSemanticView(raced), deduplicated: true },
      }) as unknown as Record<string, unknown>);
      return result(buildFacadeResult({
        status: 'blocked',
        summary: error instanceof Error ? error.message : String(error),
        data: { workId },
      }) as unknown as Record<string, unknown>, true);
    }
  }
  if (operation === 'get') {
    const work = workId ? getWorkContract(store, workId) : undefined;
    if (!work) return result(buildFacadeResult({
      status: 'not_found', summary: `Work ${workId || '(missing)'} not found.`, data: { workId },
    }) as unknown as Record<string, unknown>, true);
    const semantic = workSemanticView(work);
    const detail = args.detail_level === 'detail';
    const revisionHistory = detail ? listWorkSemanticRevisionRecords(store, semantic.workId, 100) : [];
    const objectiveGraph = detail ? projectWorkObjectiveGraph(
      readWorkContractStore(store).contracts.map(workSemanticView),
      listWorkSemanticRevisionRecords(store, undefined, 200),
      semantic.workId,
    ) : undefined;
    return result(buildFacadeResult({
      summary: `Work ${semantic.workId} retrieved at semantic revision ${semantic.revision}.`,
      data: {
        work: semantic,
        ...(detail ? {
          revisionHistory,
          objectiveGraph,
          executionEvidence: projectWorkExecutionEvidence(work),
          continuation: buildWorkContinuationSnapshot(work),
        } : {}),
      },
      detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
    }) as unknown as Record<string, unknown>);
  }

  const expectedRevision = Number(args.expected_revision);
  const targetState = operation === 'complete'
    ? 'completed'
    : (args.work_state === 'open' || args.work_state === 'completed' || args.work_state === 'cancelled' ? args.work_state : undefined);
  try {
    const revised = reviseWorkSemanticContext(store, workId, {
      expectedRevision,
      ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
      ...(targetState ? { state: targetState } : {}),
      ...(typeof args.requirement_revision === 'number' ? { requirementRevision: args.requirement_revision } : {}),
      ...(typeof args.plan_revision === 'number' ? { planRevision: args.plan_revision } : {}),
      ...(operation === 'revise' && typeof args.semantic_parent_work_id === 'string' ? { semanticParentWorkId: args.semantic_parent_work_id } : {}),
      ...(operation === 'revise' && Array.isArray(args.depends_on_work_ids) ? { dependsOnWorkIds: args.depends_on_work_ids.map(String) } : {}),
      ...(Array.isArray(args.work_result_refs) ? { resultRefs: args.work_result_refs.map(String) } : {}),
    });
    const semantic = workSemanticView(revised);
    let resourceReconciliation: Awaited<ReturnType<typeof reconcileSingleTerminalWorkCleanup>> | undefined;
    if (
      operation === 'complete'
      && store.controllerHome
      && revised.repoId?.trim()
      && readWorkHandle(store.controllerHome, revised.repoId, revised.workId)
    ) {
      try {
        resourceReconciliation = await reconcileSingleTerminalWorkCleanup(
          store.controllerHome,
          revised.repoId,
          revised.workId,
        );
      } catch (error) {
        resourceReconciliation = {
          status: 'blocked',
          workId: revised.workId,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return result(buildFacadeResult({
      summary: `Work ${semantic.workId} revised atomically to semantic revision ${semantic.revision}.`,
      data: {
        work: semantic,
        expectedRevision,
        semanticRevision: semantic.revision,
        ...(resourceReconciliation ? { resourceReconciliation } : {}),
      },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    const current = workId ? getWorkContract(store, workId) : undefined;
    return result(buildFacadeResult({
      status: 'blocked', summary: error instanceof Error ? error.message : String(error),
      data: { workId, expectedRevision, ...(current ? { currentWork: workSemanticView(current) } : {}) },
    }) as unknown as Record<string, unknown>, true);
  }
}
