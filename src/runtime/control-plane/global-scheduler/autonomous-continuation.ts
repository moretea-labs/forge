import { createHash } from 'crypto';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  controllerSessionBlocksRecovery,
  getControllerRoundRelay,
  getControllerSession,
  getControllerWorkBinding,
  getRetainedControllerSession,
  prepareControllerRoundOccurrence,
  resumeControllerRoundOccurrence,
} from '../../../../packages/kernel/controller/api/index';
import { projectAutonomousGoalProgression, type ProgressionWorkSnapshot } from '../../../../packages/kernel/progression/api/index';
import { currentTaskSemanticProjectionForWork, getWorkContract, listWorkContracts } from '../../../../packages/kernel/work/api/index';
import { workHasActiveExecution } from '../../execution/work-activity';
import { listPlanContracts } from '../facade/plan-contract-store';
import { readRequirement } from '../persistence/requirement-store';
import { createHandoffItem, getHandoffItem } from '../facade/handoff-inbox-store';
import { assertAutomatedOperationAllowed } from '../governance/external-effects';
import { controllerHostForScheduledBinding, ensureScheduledControllerBindingForWork } from '../../root/scheduled-controller-composition';
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
  ensureBinding?: typeof ensureScheduledControllerBindingForWork;
  prepareOccurrence?: typeof prepareControllerRoundOccurrence;
  resumeOccurrence?: typeof resumeControllerRoundOccurrence;
}

function skip(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

export type SchedulerProviderFailureDisposition = 'outcome_unknown' | 'wait_for_user' | 'retryable' | 'failed';

export function classifySchedulerProviderFailure(reason: string | undefined): SchedulerProviderFailureDisposition {
  const normalized = (reason ?? '').toUpperCase();
  if (normalized.includes('OUTCOME_UNKNOWN') || normalized.includes('MESSAGE_DELIVERY_TIMED_OUT') || normalized.includes('RESPONSE_STREAM_UNAVAILABLE')) return 'outcome_unknown';
  if (normalized.includes('EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED') || normalized.includes('AUTHORIZATION_REQUIRED') || normalized.includes('AUTHENTICATION_REQUIRED') || normalized.includes('LOGIN_REQUIRED') || normalized.includes('PERMISSION_REQUIRED') || normalized.includes('CONSENT_REQUIRED') || normalized.includes('CAPABILITY_GRANT')) return 'wait_for_user';
  if (normalized.includes('CONTROLLER_HOST_KIND_MISMATCH') || normalized.includes('CHATGPT_CONTROLLER_BINDING_NOT_FOUND') || normalized.includes('CONTROLLER_ROUND_CONTEXT_STALE') || normalized.includes('CHATGPT_CONTROLLER_ROUND_AUTHORITY_INCOMPLETE')) return 'failed';
  return 'retryable';
}

function schedulerProviderUserHandoffId(repoId: string, workId: string, relayScopeId: string, authorityId: string): string {
  return 'hnd-scheduler-provider-auth-' + createHash('sha256').update([repoId, workId, relayScopeId, authorityId].join('\n')).digest('hex').slice(0, 20);
}

export function ensureSchedulerProviderUserActionHandoff(
  options: { controllerHome: string; repoId: string },
  input: { workId: string; relayScopeId: string; authorityId: string; reason: string },
): string {
  const id = schedulerProviderUserHandoffId(options.repoId, input.workId, input.relayScopeId, input.authorityId);
  const existing = getHandoffItem(options, id);
  if (existing) return existing.id;
  return createHandoffItem(options, {
    id, repoId: options.repoId, workId: input.workId,
    title: 'Provider authorization required for autonomous continuation',
    severity: 'needs_review', reason: input.reason, creationReason: 'missing_authorization',
    summary: 'Autonomous continuation is waiting for one explicit provider authentication, consent, permission, or capability grant.',
    currentState: { repoId: options.repoId, workId: input.workId, statusSummary: 'waiting for provider authorization', blockedBy: [input.reason] },
    evidenceRefs: [], blockingDecision: 'Complete the required provider authorization.',
    recommendedDecision: 'Authorize the existing provider capability, then resolve this Handoff; Forge will continue the same durable Work automatically.',
    recommendedPrompt: `Authorize provider access for ${input.workId}; no manual continue message is required after the Handoff resolves.`,
    suggestedNextActions: [],
  }).id;
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
  const ensureBinding = input.dependencies?.ensureBinding ?? ensureScheduledControllerBindingForWork;
  const prepareOccurrence = input.dependencies?.prepareOccurrence ?? prepareControllerRoundOccurrence;
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
        const existingRound = getControllerRoundRelay(store, work.workId);
        occurrenceId = existingRound?.status === 'failed' && existingRound.occurrenceId
          ? existingRound.occurrenceId
          : progression.idempotencyKey;
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
        const existingRound = getControllerRoundRelay(store, work.workId);
        if (existingRound && existingRound.status !== 'failed') { skip(skippedByReason, 'controller_round_present'); continue; }
        occurrenceId = existingRound?.occurrenceId ?? planlessOccurrenceId(work.workId, work.updatedAt);
      }

      const retainedSession = getRetainedControllerSession(store, work.workId);
      if (!retainedSession) { skip(skippedByReason, 'retained_controller_session_missing'); continue; }
      if (retainedSession.controllerType === 'human') { skip(skippedByReason, 'human_controller'); continue; }
      let binding = getControllerWorkBinding(store, work.workId)?.binding;
      if (!binding) {
        try {
          binding = ensureBinding(store, { workId: work.workId, session: retainedSession, scheduleName: 'autonomous-work-liveness', args: {} });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          skip(skippedByReason, 'controller_binding_recovery_failed:' + reason.split(':', 1)[0]);
          continue;
        }
      }
      if (binding.hostKind !== retainedSession.controllerType) { skip(skippedByReason, 'controller_binding_kind_mismatch'); continue; }

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
            // Supervisor owns the outer ChatGPT submit, but ControllerRound still
            // owns the lower continuation. Materialize that round first so
            // enrollment never depends on a previous Work having left one behind.
            const prepared = prepareOccurrence(store, {
              occurrenceId,
              workId: work.workId,
              controllerBindingId: binding.bindingId,
              relayScopeId,
              continuationHint,
            });
            if (prepared.outcome !== 'dispatched') {
              skip(skippedByReason, 'controller_prepare:' + prepared.outcome);
              continue;
            }
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

        const rawHost = hostForBinding(
          {
            controllerHome: input.controllerHome,
            repoId: repository.repoId,
            repoRoot: repository.canonicalRoot ?? repository.localRoot,
          },
          binding,
        );
        const host = {
          resume: async (controllerBinding: typeof binding, roundContext: Parameters<typeof rawHost.resume>[1]) => {
            const result = await rawHost.resume(controllerBinding, roundContext);
            if (result.accepted || result.waitForUser || result.recoverable) return result;
            const disposition = classifySchedulerProviderFailure(result.reason);
            if (disposition === 'outcome_unknown') throw new Error(`CONTROLLER_HOST_PROVIDER_DISPATCH_OUTCOME_UNKNOWN:${result.reason ?? 'provider outcome unknown'}`);
            if (disposition === 'wait_for_user') {
              const handoffId = ensureSchedulerProviderUserActionHandoff(store, {
                workId: roundContext.workId, relayScopeId: roundContext.relayScopeId,
                authorityId: roundContext.authorityId, reason: result.reason ?? 'provider authorization required',
              });
              return { ...result, waitForUser: true, handoffId };
            }
            if (disposition === 'retryable') return { ...result, recoverable: true };
            return result;
          },
        };
        const resumed = await resumeOccurrence(
          store,
          {
            occurrenceId,
            workId: work.workId,
            controllerBindingId: binding.bindingId,
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
