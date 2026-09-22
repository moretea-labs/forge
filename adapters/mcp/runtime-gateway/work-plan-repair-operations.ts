import { existsSync } from 'fs';
import type { CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import { getWorkContract, listWorkContracts } from '../../../packages/kernel/work/api/index';
import { readWorkHandle } from '../../../src/runtime/control-plane/execution/work-handle-store';
import { buildFacadeResult, repairPlanStepForTechnicalRetry, summarizePlanContract } from '../../../src/runtime/control-plane/facade';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { result } from './result-adapter';

const PLAN_STEP_TECHNICAL_RETRY_PREFIX = 'plan.step.retry:';

type PlanRepairRepository = { repoId: string };

/**
 * Frozen rh_work compatibility entry for an explicit technical retry of one
 * terminal Plan-bound Work. Canonical retry admission and Plan mutation remain
 * owned by repairPlanStepForTechnicalRetry.
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
    if (!cleanupComplete) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_CLEANUP_INCOMPLETE: ${workId}`);
    const conflicting = work.planId && work.planStepId
      ? listWorkContracts({ ...store, status: 'active', limit: 200 })
          .filter((candidate) => candidate.planId === work.planId && candidate.planStepId === work.planStepId)
      : [];
    if (conflicting.length > 0) throw new Error(`PLAN_STEP_TECHNICAL_RETRY_ACTIVE_WORK_CONFLICT: ${conflicting.map((candidate) => candidate.workId).join(',')}`);
    const repairedPlan = repairPlanStepForTechnicalRetry(store, { work, cleanupComplete, reason });
    return result(buildFacadeResult({
      summary: `Plan step ${work.planId}/${work.planStepId} was restored for an explicit technical retry after terminal Work ${work.workId}; no Work was revived or created.`,
      data: { workId: work.workId, plan: summarizePlanContract(repairedPlan), repaired: true, replacementWorkCreated: false },
    }) as unknown as Record<string, unknown>);
  } catch (error) {
    return result(buildFacadeResult({
      status: 'blocked',
      summary: error instanceof Error ? error.message : 'PLAN_STEP_TECHNICAL_RETRY_FAILED',
      data: { workId, repaired: false },
    }) as unknown as Record<string, unknown>, true);
  }
}
