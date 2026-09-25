import { existsSync } from 'fs';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { getWorkContract, listWorkContracts } from '../../../packages/kernel/work/api/index';
import { readWorkHandle } from '../../../src/runtime/control-plane/execution/work-handle-store';
import { buildFacadeResult, getPlanContract, summarizePlanContract } from '../../../src/runtime/control-plane/facade';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { result } from './result-adapter';

const PLAN_STEP_TECHNICAL_RETRY_PREFIX = 'plan.step.retry:';

type PlanRepairRepository = { repoId: string };

/**
 * Frozen rh_work compatibility entry for the retired "technical retry" of one
 * terminal Plan-bound Work. Plan items are authored working memory, so this
 * entry is a read-only compatibility report: it never clears a Plan item
 * binding, never authorizes a replacement admission and never writes Plan
 * state. Retrying the same objective is an ordinary new capability call.
 */
export function callRhWorkPlanRepairOperation(
  ctx: MultiRepositoryMcpToolContext,
  repository: PlanRepairRepository,
  operation: string,
  args: Record<string, unknown>,
): CallToolResult | undefined {
  if (operation !== 'repair' || typeof args.capability_id !== 'string') return undefined;
  const capability = args.capability_id.trim();
  if (!capability.startsWith(PLAN_STEP_TECHNICAL_RETRY_PREFIX)) return undefined;
  const workId = capability.slice(PLAN_STEP_TECHNICAL_RETRY_PREFIX.length).trim();
  if (!workId) return undefined;

  const store = { controllerHome: ctx.controllerHome, repoId: repository.repoId };
  const explicitWorkId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (!explicitWorkId || explicitWorkId !== workId) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: `PLAN_STEP_TECHNICAL_RETRY_SCOPE_MISMATCH: capability targets ${workId}; exact work_id is required.`,
      data: { workId, repaired: false },
    }) as unknown as Record<string, unknown>, true);
  }

  try {
    const work = getWorkContract(store, workId);
    if (!work) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_WORK_NOT_FOUND: ${workId}`);
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!reason) throw new Error('PLAN_STEP_TECHNICAL_RETRY_REASON_REQUIRED');
    const handle = readWorkHandle(ctx.controllerHome, repository.repoId, workId);
    const cleanupComplete = Boolean(handle
      && handle.managedWorktree
      && handle.state === 'cleaned'
      && handle.finalization.branchCleanup === 'done'
      && handle.finalization.worktreeCleanup === 'done'
      && handle.cleanupReceipt?.complete === true
      && handle.baseCommit
      && handle.expectedHead === handle.baseCommit
      && !existsSync(handle.worktreePath));
    const conflicting = work.planId && work.planStepId
      ? listWorkContracts({ ...store, status: 'active', limit: 200 })
          .filter((candidate) => candidate.planId === work.planId && candidate.planStepId === work.planStepId)
      : [];
    const plan = work.planId ? getPlanContract(store, work.planId) : undefined;
    const planItem = plan && work.planStepId ? plan.steps.find((candidate) => candidate.id === work.planStepId) : undefined;
    return result(buildFacadeResult({
      summary: `PLAN_STEP_TECHNICAL_RETRY_RETIRED: Plan item ${work.planId ?? 'none'}/${work.planStepId ?? 'none'} is authored working memory for terminal Work ${work.workId}; Forge did not mutate it. Request the retry as an ordinary capability call, or revise the Plan explicitly with expected_revision when the authored progress changed.`,
      data: {
        workId: work.workId,
        planId: work.planId ?? null,
        planStepId: work.planStepId ?? null,
        terminalWorkStatus: work.status,
        cleanupComplete,
        activeWorkConflicts: conflicting.map((candidate) => candidate.workId),
        reasonRetainedForAudit: reason,
        repaired: false,
        replacementWorkCreated: false,
        compatibilityNoop: true,
        ...(plan ? { plan: summarizePlanContract(plan) } : {}),
        ...(planItem ? { planItemStatus: planItem.status } : {}),
      },
      suggestedNextActions: plan
        ? [{ label: 'Read current Plan', tool: 'rh_work', operation: 'plan_get', payload: { plan_id: plan.planId }, risk: 'readonly', confidence: 'high' }]
        : [],
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'PLAN_STEP_TECHNICAL_RETRY_FAILED',
      data: { workId, repaired: false },
    }) as unknown as Record<string, unknown>, true);
  }
}
