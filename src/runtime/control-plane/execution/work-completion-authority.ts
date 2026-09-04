import { completeRequirementFromWork } from '../persistence/requirement-store';
import {
  appendWorkEvidence,
  recordWorkCompletionReceipt,
  type WorkContractStoreOptions,
} from '../../../../packages/kernel/work/api/index';
import type { WorkContract, WorkKind } from '../facade/types';
import { completePlanStepForWork } from '../facade/plan-contract-store';

export interface WorkRequirementProjectionResult {
  attempted: boolean;
  ok: boolean;
  warning?: string;
}

export interface WorkPlanProjectionResult {
  attempted: boolean;
  ok: boolean;
  warning?: string;
}

/**
 * Project one already-terminal Work receipt into Requirement semantic review.
 * Work completion remains authoritative; Requirement projection is downstream
 * and must never turn a durable completion receipt back into a failed Work.
 */
export function projectRequirementDeliveryFromCompletedWork(
  options: WorkContractStoreOptions,
  work: WorkContract,
): WorkRequirementProjectionResult {
  if (!work.requirementId || !options.controllerHome) return { attempted: false, ok: true };
  try {
    completeRequirementFromWork(
      { controllerHome: options.controllerHome },
      { requirementId: work.requirementId, work },
    );
    return { attempted: true, ok: true };
  } catch (error) {
    const warning = `Work completion remains authoritative; Requirement projection could not be applied: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000);
    try {
      appendWorkEvidence(options, work.workId, {
        title: 'requirement completion projection pending',
        summary: warning,
        detailLevel: 'summary',
      });
    } catch {
      // The completion receipt is already canonical and durable. Diagnostic
      // persistence is downstream and cannot invalidate terminal Work state.
    }
    return { attempted: true, ok: false, warning };
  }
}

/**
 * Project one already-terminal Work receipt into Plan semantic validation.
 * Work completion remains authoritative; Plan projection is downstream and
 * must never turn a durable completion receipt back into a failed Work.
 */
export function projectPlanDeliveryFromCompletedWork(
  options: WorkContractStoreOptions,
  work: WorkContract,
): WorkPlanProjectionResult {
  if (!work.planId?.trim() || !work.planStepId?.trim() || !options.controllerHome || !options.repoId) {
    return { attempted: false, ok: true };
  }
  try {
    completePlanStepForWork(
      { controllerHome: options.controllerHome, repoId: options.repoId },
      { planId: work.planId, stepId: work.planStepId, work },
    );
    return { attempted: true, ok: true };
  } catch (error) {
    const warning = `Work completion remains authoritative; Plan projection could not be applied: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000);
    try {
      appendWorkEvidence(options, work.workId, {
        title: 'plan step delivery projection pending',
        summary: warning,
        detailLevel: 'summary',
      });
    } catch {
      // The completion receipt is already canonical and durable. Diagnostic
      // persistence is downstream and cannot invalidate terminal Work state.
    }
    return { attempted: true, ok: false, warning };
  }
}

/** Record the canonical Work completion fact, then update downstream semantic review state. */
export function completeWorkWithReceipt(
  options: WorkContractStoreOptions,
  workId: string,
  receipt: NonNullable<WorkContract['completionReceipt']>,
  completionOutcome: NonNullable<WorkContract['completionOutcome']>,
  completionWorkKind?: WorkKind,
): WorkContract {
  const recorded = recordWorkCompletionReceipt(options, workId, receipt, completionOutcome, completionWorkKind);
  projectRequirementDeliveryFromCompletedWork(options, recorded);
  projectPlanDeliveryFromCompletedWork(options, recorded);
  return recorded;
}
