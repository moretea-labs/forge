import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  getWorkContract,
  workSemanticView,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../../../src/runtime/control-plane/facade';
import { getPlanContract, currentPlanSemanticRevision, getPlanSemanticRevisionRecord, planSemanticView } from '../../../src/runtime/control-plane/facade/plan-contract-store';
import { readRequirement, currentRequirementSemanticRevision, getRequirementRevisionRecord, requirementSemanticView } from '../../../src/runtime/control-plane/persistence/requirement-store';
import { buildWorkContinuationSnapshot } from '../../../src/runtime/control-plane/facade/work-continuation';
import { result } from './result-adapter';
import { projectWorkExecutionEvidence } from './work-detail-projection';

const RH_WORK_SEMANTIC_OPERATIONS = new Set(['get', 'get_contract']);

/**
 * Historical Work remains readable for audit/migration only. Requirement and
 * Plan heads are projected so callers can understand which durable semantic
 * authorities the retired Work referenced without reviving its lifecycle.
 */
function versionBinding(store: WorkContractStoreOptions, work: NonNullable<ReturnType<typeof getWorkContract>>, detail: boolean) {
  const req = work.requirementId && store.controllerHome
    ? readRequirement({ controllerHome: store.controllerHome }, work.requirementId)?.value
    : undefined;
  const plan = work.planId ? getPlanContract(store, work.planId) : undefined;
  const reqHead = req ? requirementSemanticView(req) : undefined;
  const planHead = plan ? planSemanticView(plan) : undefined;
  const reqAdopted = detail && reqHead && work.requirementRevision !== reqHead.revision
    ? getRequirementRevisionRecord({ controllerHome: store.controllerHome! }, work.requirementId!, work.requirementRevision!)
    : undefined;
  const planAdopted = detail && planHead && work.planRevision !== planHead.revision
    ? getPlanSemanticRevisionRecord(store, work.planId!, work.planRevision!)
    : undefined;
  return {
    ...(work.requirementId ? { requirement: {
      id: work.requirementId,
      adoptedRevision: work.requirementRevision,
      currentRevision: reqHead?.revision,
      updateAvailable: Boolean(reqHead && work.requirementRevision !== reqHead.revision),
      ...(detail ? { current: reqHead, adopted: reqAdopted ?? (work.requirementRevision === reqHead?.revision ? reqHead : undefined) } : {}),
    } } : {}),
    ...(work.planId ? { plan: {
      id: work.planId,
      adoptedRevision: work.planRevision,
      currentRevision: planHead?.revision,
      updateAvailable: Boolean(planHead && work.planRevision !== planHead.revision),
      ...(detail ? { current: planHead, adopted: planAdopted ?? (work.planRevision === planHead?.revision ? planHead : undefined) } : {}),
    } } : {}),
  };
}

export async function callRhWorkSemanticOperation(
  store: WorkContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
  _repositoryPlacement?: 'current' | 'isolated',
): Promise<CallToolResult | undefined> {
  if (!RH_WORK_SEMANTIC_OPERATIONS.has(operation)) return undefined;

  const workId = String(args.work_id ?? '').trim();
  const work = workId ? getWorkContract(store, workId) : undefined;
  if (!work) {
    return result(buildFacadeResult({
      status: 'not_found',
      summary: `Historical Work ${workId || '(missing)'} not found.`,
      data: { workId },
    }) as unknown as Record<string, unknown>, true);
  }

  if (operation === 'get_contract') {
    return result(buildFacadeResult({
      summary: `Historical WorkContract ${work.workId} retrieved read-only; lifecycle writes are retired.`,
      data: { workContract: work, readOnlyLegacy: true },
    }) as unknown as Record<string, unknown>);
  }

  const semantic = workSemanticView(work);
  const detail = args.detail_level === 'detail';
  return result(buildFacadeResult({
    summary: `Historical Work ${semantic.workId} retrieved read-only at semantic revision ${semantic.revision}.`,
    data: {
      work: semantic,
      readOnlyLegacy: true,
      versionBinding: versionBinding(store, work, detail),
      ...(detail ? {
        executionEvidence: projectWorkExecutionEvidence(work),
        continuation: buildWorkContinuationSnapshot(work),
      } : {}),
    },
    detailLevel: detail ? 'detail' : 'summary',
  }) as unknown as Record<string, unknown>);
}
