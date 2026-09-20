import { createHash } from 'crypto';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  controllerSessionBlocksRecovery,
  getControllerRoundRelay,
  getControllerSession,
  getControllerWorkBinding,
  getRetainedControllerSession,
  resumeControllerRoundOccurrence,
} from '../../../../packages/kernel/controller/api/index';
import { projectAutonomousGoalProgression, type ProgressionWorkSnapshot } from '../../../../packages/kernel/progression/api/index';
import { currentTaskSemanticProjectionForWork, getWorkContract, listWorkContracts } from '../../../../packages/kernel/work/api/index';
import { workHasActiveExecution } from '../../execution/work-activity';
import { listPlanContracts } from '../facade/plan-contract-store';
import { readRequirement } from '../persistence/requirement-store';
import { assertAutomatedOperationAllowed } from '../governance/external-effects';
import { controllerHostForScheduledBinding } from '../../root/scheduled-controller-composition';
import {
  ensureWorkflowSupervisorEnrollmentForWork,
  workflowSupervisorBoundaryForWork,
} from '../../root/workflow-supervisor-composition';

const DEFAULT_MAX_CONTINUATIONS = 2;
const RUNNABLE_WORK_STATUSES = new Set(['open', 'running', 'ready']);

export interface SchedulerAutonomousContinuationResult {
  scanned: number;
  eligible: number;
  dispatched: number;
  supervisorEnrolled: number;
  failed: number;
  skippedByReason: Record<string, number>;
}

export interface SchedulerAutonomousContinuationDependencies {
  hasActiveExecution?: typeof workHasActiveExecution;
  authorizeWake?: typeof assertAutomatedOperationAllowed;
  boundaryForWork?: typeof workflowSupervisorBoundaryForWork;
  ensureSupervisorEnrollment?: typeof ensureWorkflowSupervisorEnrollmentForWork;
  hostForBinding?: typeof controllerHostForScheduledBinding;
  resumeOccurrence?: typeof resumeControllerRoundOccurrence;
}

function skip(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function planlessOccurrenceId(workId: string, updatedAt: string): string {
  const digest = createHash('sha256').update(workId + '\0' + updatedAt).digest('hex').slice(0, 32);
  return 'work-liveness:v1:' + digest;
}

function workSnapshot(work: NonNullable<ReturnType<typeof getWorkContract>>): ProgressionWorkSnapshot {
  const currentTask = currentTaskSemanticProjectionForWork(work);
  return {
    workId: currentTask.workId,
    requirementId: currentTask.requirementId,
    planId: currentTask.planId,
    planStepId: currentTask.planStepId,
    status: work.status,
    baseRevision: work.baseRevision,
    completionTargetRevision: work.completionReceipt && 'targetRevision' in work.completionReceipt
      ? work.completionReceipt.targetRevision
      : undefined,
  };
}

/**
 * Materialize already-authorized Work continuation. This is deliberately a
 * reconciliation hook, not a second planner:
 *
 * - Plan-bound Work must be selected by projectAutonomousGoalProgression.
 * - Planless Work receives only a mechanical liveness wake when its own Work,
 *   Requirement and ControllerRound authorities expose no wait/terminal state.
 * - ControllerRound remains the provider-effect/idempotency fence.
 * - Workflow Supervisor remains the outer ChatGPT-turn owner when enrolled.
 *
 * Current Plan source is intentionally frozen at plan.sourceRevision here.
 * Baseline drift is an admission/replan concern, not a reason to interrupt an
 * already-running isolated Work halfway through its execution.
 */
export async function runSchedulerAutonomousContinuationReconciliation(input: {
  controllerHome: string;
  nowMs: number;
  repositories: readonly Pick<RepositoryRecord, 'repoId' | 'canonicalRoot' | 'localRoot'>[];
  maxContinuations?: number;
  dependencies?: SchedulerAutonomousContinuationDependencies;
}): Promise<SchedulerAutonomousContinuationResult> {
  const maxContinuations = Math.max(1, Math.min(Math.trunc(input.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS), 8));
  const hasActiveExecution = input.dependencies?.hasActiveExecution ?? workHasActiveExecution;
  const authorizeWake = input.dependencies?.authorizeWake ?? assertAutomatedOperationAllowed;
  const boundaryForWork = input.dependencies?.boundaryForWork ?? workflowSupervisorBoundaryForWork;
  const ensureSupervisorEnrollment = input.dependencies?.ensureSupervisorEnrollment ?? ensureWorkflowSupervisorEnrollmentForWork;
  const hostForBinding = input.dependencies?.hostForBinding ?? controllerHostForScheduledBinding;
  const resumeOccurrence = input.dependencies?.resumeOccurrence ?? resumeControllerRoundOccurrence;

  let scanned = 0;
  let eligible = 0;
  let dispatched = 0;
  let supervisorEnrolled = 0;
  let failed = 0;
  let materialized = 0;
  const skippedByReason: Record<string, number> = {};

  for (const repository of input.repositories) {
    if (materialized >= maxContinuations) break;
    const store = { controllerHome: input.controllerHome, repoId: repository.repoId };
    let works: ReturnType<typeof listWorkContracts>;
    let plans: ReturnType<typeof listPlanContracts>;
    try {
      works = listWorkContracts({ ...store, status: 'active', limit: 100 });
      plans = listPlanContracts({ ...store, status: 'active', limit: 100 });
    } catch (error) {
      failed += 1;
      console.error('[forge liveness] failed to read current Work/Plan authority for ' + repository.repoId + ':', error);
      continue;
    }
    const plansById = new Map(plans.map((plan) => [plan.planId, plan] as const));

    for (const work of works) {
      if (materialized >= maxContinuations) break;
      scanned += 1;
      if (!RUNNABLE_WORK_STATUSES.has(work.status)) { skip(skippedByReason, 'work_status:' + work.status); continue; }
      if (hasActiveExecution(input.controllerHome, repository.repoId, work.workId)) { skip(skippedByReason, 'active_execution'); continue; }

      const liveOwner = getControllerSession(store, work.workId);
      if (liveOwner && controllerSessionBlocksRecovery(store, work.workId, { nowMs: input.nowMs })) {
        skip(skippedByReason, 'active_controller_session');
        continue;
      }

      const currentTask = currentTaskSemanticProjectionForWork(work);
      let occurrenceId: string;
      let relayScopeId = currentTask.requirementId ? 'requirement:' + currentTask.requirementId : undefined;
      let continuationHint = 'Resume exact Work ' + currentTask.workId + '; scheduler observed no active execution or live Controller owner and no explicit wait.';

      if (currentTask.planId) {
        const plan = plansById.get(currentTask.planId);
        if (!plan) { skip(skippedByReason, 'current_plan_missing'); continue; }
        const requirementRecord = plan.requirementId
          ? readRequirement({ controllerHome: input.controllerHome }, plan.requirementId)
          : undefined;
        if (plan.requirementId && !requirementRecord) { skip(skippedByReason, 'requirement_missing'); continue; }

        const planWorks = plan.steps
          .flatMap((step) => step.workId ? [getWorkContract(store, step.workId)] : [])
          .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
        const controllerRounds = planWorks.flatMap((candidate) => {
          const round = getControllerRoundRelay(store, candidate.workId);
          return round ? [{ originWorkId: round.originWorkId, status: round.status, roundCount: round.roundCount }] : [];
        });
        const progression = projectAutonomousGoalProgression({
          requirement: {
            requirementId: plan.requirementId ?? work.requirementId ?? 'plan:' + plan.planId,
            state: requirementRecord?.value.state ?? 'active',
            revision: requirementRecord?.revision ?? 0,
          },
          plan: {
            planId: plan.planId,
            requirementId: plan.requirementId,
            sourceRevision: plan.sourceRevision,
            status: plan.status,
            steps: plan.steps.map((step) => ({
              id: step.id,
              dependencies: step.dependencies,
              status: step.status,
              workId: step.workId,
            })),
          },
          currentSourceRevision: plan.sourceRevision,
          works: planWorks.map(workSnapshot),
          controllerRounds,
        });
        if (progression.kind !== 'continue_current_work' || progression.workId !== work.workId) {
          skip(skippedByReason, 'progression:' + progression.reasonCode);
          continue;
        }
        occurrenceId = progression.idempotencyKey;
        relayScopeId = plan.requirementId ? 'requirement:' + plan.requirementId : relayScopeId;
        continuationHint = 'Resume exact Work ' + work.workId + '; Goal Progression returned ' + progression.reasonCode + ' for ' + plan.planId + '/' + (progression.planStepId ?? 'current-step') + '.';
      } else {
        const requirementRecord = work.requirementId
          ? readRequirement({ controllerHome: input.controllerHome }, work.requirementId)
          : undefined;
        if (work.requirementId && !requirementRecord) { skip(skippedByReason, 'requirement_missing'); continue; }
        const requirementState = requirementRecord?.value.state;
        if (requirementState === 'waiting_for_user') { skip(skippedByReason, 'requirement_waiting_for_user'); continue; }
        if (requirementState === 'done' || requirementState === 'cancelled') { skip(skippedByReason, 'requirement:' + requirementState); continue; }
        if (getControllerRoundRelay(store, work.workId)) { skip(skippedByReason, 'controller_round_present'); continue; }
        occurrenceId = planlessOccurrenceId(work.workId, work.updatedAt);
      }

      const retainedSession = getRetainedControllerSession(store, work.workId);
      if (!retainedSession) { skip(skippedByReason, 'retained_controller_session_missing'); continue; }
      if (retainedSession.controllerType === 'human') { skip(skippedByReason, 'human_controller'); continue; }
      const bindingRecord = getControllerWorkBinding(store, work.workId);
      if (!bindingRecord) { skip(skippedByReason, 'controller_binding_missing'); continue; }
      if (bindingRecord.binding.hostKind !== retainedSession.controllerType) { skip(skippedByReason, 'controller_binding_kind_mismatch'); continue; }

      eligible += 1;
      try {
        authorizeWake('external_controller_wake', {
          work_id: work.workId,
          controller_type: retainedSession.controllerType,
          relay_scope_id: relayScopeId,
          recovery_reason: 'ownerless_work_ready_to_continue',
        });

        if (retainedSession.controllerType === 'chatgpt') {
          const boundary = boundaryForWork(store, work.workId);
          if (boundary.status === 'outer_turn') {
            const enrollment = await ensureSupervisorEnrollment(store, work.workId, {
              schedulerRecoveryKey: occurrenceId,
            });
            if (enrollment.status === 'enrolled') {
              supervisorEnrolled += 1;
              materialized += 1;
            } else {
              skip(skippedByReason, 'workflow_supervisor:' + enrollment.status);
            }
            continue;
          }
        }

        const host = hostForBinding(
          {
            controllerHome: input.controllerHome,
            repoId: repository.repoId,
            repoRoot: repository.canonicalRoot ?? repository.localRoot,
          },
          bindingRecord.binding,
        );
        const resumed = await resumeOccurrence(
          store,
          {
            occurrenceId,
            workId: work.workId,
            controllerBindingId: bindingRecord.binding.bindingId,
            relayScopeId,
            continuationHint,
          },
          host,
        );
        if (resumed.outcome === 'dispatched') {
          dispatched += 1;
          materialized += 1;
        } else {
          skip(skippedByReason, 'controller_resume:' + resumed.outcome);
        }
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        console.error('[forge liveness] autonomous continuation failed for ' + repository.repoId + '/' + work.workId + ':', reason);
      }
    }
  }

  return { scanned, eligible, dispatched, supervisorEnrolled, failed, skippedByReason };
}
