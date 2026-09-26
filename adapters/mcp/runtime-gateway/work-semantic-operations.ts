import { createHash, randomUUID } from 'crypto';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  createWorkContract,
  getWorkContract,
  listWorkSemanticRevisionRecords,
  reviseWorkSemanticContext,
  workSemanticView,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

const RH_WORK_SEMANTIC_OPERATIONS = new Set(['start', 'work_get', 'work_revise', 'work_complete']);

function semanticWorkId(store: WorkContractStoreOptions, args: Record<string, unknown>): string {
  const explicit = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (explicit) return explicit;
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (requestId) {
    const digest = createHash('sha256').update(`${store.repoId}\0${requestId}`).digest('hex').slice(0, 12);
    return `work-semantic-${digest}`;
  }
  return `work-semantic-${randomUUID().slice(0, 12)}`;
}

function semanticCreateMatches(existing: ReturnType<typeof getWorkContract>, args: Record<string, unknown>, requestId: string): boolean {
  if (!existing) return false;
  const objective = String(args.objective ?? '').trim();
  const requirementId = typeof args.requirement_id === 'string' ? args.requirement_id.trim() : '';
  const planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
  return existing.objective === objective
    && (existing.requirementId ?? '') === requirementId
    && (existing.planId ?? '') === planId
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
      const created = createWorkContract(store, {
        workId,
        repoId: store.repoId ?? '',
        objective,
        acceptanceCriteria: [],
        constraints: { requireHandoffOnAmbiguity: true },
        workKind: 'repository_change',
        lifecycleRole: 'primary',
        requestedBy: 'chatgpt',
        allowedPaths: [],
        forbiddenPaths: [],
        checks: [],
        ...(typeof args.requirement_id === 'string' && args.requirement_id.trim() ? { requirementId: args.requirement_id.trim() } : {}),
        ...(typeof args.requirement_revision === 'number' ? { requirementRevision: args.requirement_revision } : {}),
        ...(typeof args.plan_id === 'string' && args.plan_id.trim() ? { planId: args.plan_id.trim() } : {}),
        ...(typeof args.plan_revision === 'number' ? { planRevision: args.plan_revision } : {}),
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
  const targetState = operation === 'work_complete'
    ? 'completed'
    : (args.work_state === 'open' || args.work_state === 'completed' || args.work_state === 'cancelled' ? args.work_state : undefined);
  try {
    const revised = reviseWorkSemanticContext(store, workId, {
      expectedRevision,
      ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
      ...(targetState ? { state: targetState } : {}),
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
