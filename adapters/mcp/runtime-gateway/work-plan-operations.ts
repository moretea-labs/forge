import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import {
  approvePlanContractAsync,
  buildFacadeResult,
  getPlanContract,
  listPlanContracts,
  summarizePlanContract,
  supersedePlanContract,
  type PlanContractStoreOptions,
} from '../../../src/runtime/control-plane/facade';
import { result } from './result-adapter';

const RH_WORK_LIGHTWEIGHT_PLAN_OPERATIONS = new Set([
  'plan_list',
  'plan_get',
  'plan_approve',
  'plan_supersede',
]);

export function isRhWorkLightweightPlanOperation(operation: string): boolean {
  return RH_WORK_LIGHTWEIGHT_PLAN_OPERATIONS.has(operation);
}

export async function callRhWorkPlanOperation(
  store: PlanContractStoreOptions,
  operation: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  if (!isRhWorkLightweightPlanOperation(operation)) return undefined;

  if (operation === 'plan_list') {
    const plans = listPlanContracts({ ...store, status: 'active', limit: typeof args.limit === 'number' ? args.limit : 20 });
    const facade = buildFacadeResult({
      summary: `${plans.length} active PlanContract(s) in this repository.`,
      data: { plans: plans.map(summarizePlanContract), bounded: true },
    });
    return result(facade as unknown as Record<string, unknown>);
  }

  if (operation === 'plan_get') {
    const plan = getPlanContract(store, String(args.plan_id ?? ''));
    const facade = plan
      ? buildFacadeResult({
          summary: `PlanContract ${plan.planId} retrieved.`,
          data: { plan: args.detail_level === 'detail' ? plan : summarizePlanContract(plan) },
          detailLevel: args.detail_level === 'detail' ? 'detail' : 'summary',
        })
      : buildFacadeResult({
          status: 'not_found',
          summary: `PlanContract ${String(args.plan_id ?? '')} not found.`,
          data: { planId: String(args.plan_id ?? '') },
        });
    return result(facade as unknown as Record<string, unknown>, !plan);
  }

  try {
    if (operation === 'plan_approve') {
      const plan = await approvePlanContractAsync(store, String(args.plan_id ?? ''));
      const facade = buildFacadeResult({
        summary: `PlanContract ${plan.planId} approved at source revision ${plan.sourceRevision}; execution remains explicit.`,
        data: { plan: summarizePlanContract(plan), executionStarted: false },
      });
      return result(facade as unknown as Record<string, unknown>);
    }

    const plan = supersedePlanContract(store, String(args.plan_id ?? ''), String(args.superseded_by ?? ''));
    const facade = buildFacadeResult({
      summary: `PlanContract ${plan.planId} superseded by ${plan.supersededBy}.`,
      data: { plan: summarizePlanContract(plan) },
    });
    return result(facade as unknown as Record<string, unknown>);
  } catch (error) {
    const facade = buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'PlanContract operation failed.',
      data: { operation, executionStarted: false },
    });
    return result(facade as unknown as Record<string, unknown>, true);
  }
}
