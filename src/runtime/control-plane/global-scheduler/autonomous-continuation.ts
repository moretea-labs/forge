import { createHash } from 'crypto';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  controllerRoundBlockerClass,
  controllerSessionBlocksRecovery,
  getControllerRoundRelay,
  getControllerSession,
  getRetainedControllerSession,
} from '../../../../packages/kernel/controller/api/index';
import {
  currentTaskSemanticProjectionForWork,
  listWorkContracts,
  semanticWorkState,
  workSemanticView,
} from '../../../../packages/kernel/work/api/index';
import { workHasActiveExecution } from '../../execution/work-activity';
import { readRequirement } from '../persistence/requirement-store';
import { assertAutomatedOperationAllowed } from '../governance/external-effects';
import {
  controllerHostForScheduledBinding,
  ensureScheduledControllerBindingForWork,
} from '../../root/scheduled-controller-composition';
import { ensureWorkflowSupervisorEnrollmentForWork } from '../../root/workflow-supervisor-composition';
import { reconcileControllerProgression } from '../../root/controller-progression-composition';
import { prepareControllerRoundOccurrence, resumeControllerRoundOccurrence } from '../../../../packages/kernel/controller/api/index';
import { ensureControllerDispositionContinuation } from '../../workflow/schedules/work-continuation';
import { deriveForgeActionableFailureCode, maybeRegisterForgeActionableFailureRepair } from '../../diagnostics/incident-repair';

const DEFAULT_MAX_CONTINUATIONS = 2;

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
  ensureSupervisorEnrollment?: typeof ensureWorkflowSupervisorEnrollmentForWork;
  hostForBinding?: typeof controllerHostForScheduledBinding;
  ensureBinding?: typeof ensureScheduledControllerBindingForWork;
  prepareOccurrence?: typeof prepareControllerRoundOccurrence;
  resumeOccurrence?: typeof resumeControllerRoundOccurrence;
}

function skip(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function planlessOccurrenceId(workId: string, semanticRevision: number): string {
  const digest = createHash('sha256').update(workId + '\0semantic:' + semanticRevision).digest('hex').slice(0, 32);
  return 'work-liveness:v2:' + digest;
}

function livenessMayReconcileExistingRound(record: ReturnType<typeof getControllerRoundRelay>): boolean {
  if (!record) return true;
  if (record.status === 'waiting') return true;
  if (record.status === 'dispatching') return true;
  if (record.status === 'dispatched') return true;
  return record.status === 'blocked' && controllerRoundBlockerClass(record) === 'provider_dispatch_outcome_unknown';
}

/**
 * Single Scheduler liveness scanner. Scheduler selects only which open Work
 * needs another mechanical opportunity; reconcileControllerProgression owns the
 * stateless composition of existing authorities.
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
    try {
      works = listWorkContracts({ ...store, status: 'active', limit: 100 });
    } catch (error) {
      failed += 1;
      console.error('[forge liveness] failed to read current Work authority for ' + repository.repoId + ':', error);
      continue;
    }

    for (const work of works) {
      if (materialized >= maxContinuations) break;
      scanned += 1;
      if (semanticWorkState(work) !== 'open') { skip(skippedByReason, 'semantic_work_terminal'); continue; }
      if (hasActiveExecution(input.controllerHome, repository.repoId, work.workId)) { skip(skippedByReason, 'active_execution'); continue; }

      const liveOwner = getControllerSession(store, work.workId);
      if (liveOwner && controllerSessionBlocksRecovery(store, work.workId, { nowMs: input.nowMs })) {
        skip(skippedByReason, 'active_controller_session');
        continue;
      }

      const currentTask = currentTaskSemanticProjectionForWork(work);
      const relayScopeId = currentTask.requirementId ? 'requirement:' + currentTask.requirementId : undefined;
      const continuationHint = 'Resume exact Work ' + currentTask.workId + '; scheduler observed no active execution or live Controller owner and no unresolved semantic blocker.';

      const requirementRecord = work.requirementId
        ? readRequirement({ controllerHome: input.controllerHome }, work.requirementId)
        : undefined;
      if (work.requirementId && !requirementRecord) { skip(skippedByReason, 'requirement_missing'); continue; }
      const requirementState = requirementRecord?.value.state;
      if (requirementState === 'waiting_for_user') { skip(skippedByReason, 'requirement_waiting_for_user'); continue; }
      if (requirementState === 'done' || requirementState === 'cancelled') { skip(skippedByReason, 'requirement:' + requirementState); continue; }

      const existingRound = getControllerRoundRelay(store, work.workId);
      if (!livenessMayReconcileExistingRound(existingRound)) {
        skip(skippedByReason, `controller_round_${existingRound!.status}`);
        continue;
      }
      const occurrenceId = existingRound?.occurrenceId
        ?? planlessOccurrenceId(work.workId, workSemanticView(work).revision);

      const retainedSession = getRetainedControllerSession(store, work.workId);
      if (!retainedSession) { skip(skippedByReason, 'retained_controller_session_missing'); continue; }
      if (retainedSession.controllerType === 'human') { skip(skippedByReason, 'human_controller'); continue; }

      eligible += 1;
      try {
        authorizeWake('external_controller_wake', {
          work_id: work.workId,
          controller_type: retainedSession.controllerType,
          relay_scope_id: relayScopeId,
          recovery_reason: 'ownerless_work_ready_to_continue',
        });

        const progression = await reconcileControllerProgression(
          {
            controllerHome: input.controllerHome,
            repoId: repository.repoId,
            repoRoot: repository.canonicalRoot ?? repository.localRoot,
          },
          {
            occurrenceId,
            workId: work.workId,
            relayScopeId,
            continuationHint,
            scheduleName: 'autonomous-work-liveness',
          },
          {
            ...(input.dependencies?.ensureSupervisorEnrollment
              ? { ensureSupervisorEnrollment: input.dependencies.ensureSupervisorEnrollment }
              : {}),
            ...(input.dependencies?.ensureBinding ? { ensureBinding: input.dependencies.ensureBinding } : {}),
            ...(input.dependencies?.prepareOccurrence ? { prepareOccurrence: input.dependencies.prepareOccurrence } : {}),
            ...(input.dependencies?.resumeOccurrence ? { resumeOccurrence: input.dependencies.resumeOccurrence } : {}),
            ...(input.dependencies?.hostForBinding ? { hostForBinding: input.dependencies.hostForBinding } : {}),
          },
        );

        if (progression.status === 'chatgpt_enrolled') {
          supervisorEnrolled += 1;
          materialized += 1;
          continue;
        }
        if (progression.status === 'provider_dispatched') {
          // The occurrence identity is the dedupe fence. A reused dispatched
          // relay is already complete; reporting it as a fresh dispatch makes
          // repeated scheduler scans look like new progress even though no
          // provider call occurred.
          if (progression.reused) {
            skip(skippedByReason, 'controller_progression:already_dispatched');
            continue;
          }
          dispatched += 1;
          materialized += 1;
          continue;
        }
        if (progression.status === 'wait_for_user') {
          const settledRound = getControllerRoundRelay(store, work.workId);
          if (settledRound?.status === 'waiting_for_user' && settledRound.handoffId) {
            ensureControllerDispositionContinuation(input.controllerHome, repository.repoId, settledRound);
          }
        }
        if (progression.status === 'chatgpt_not_enrolled') {
          skip(skippedByReason, 'workflow_supervisor:' + progression.supervisorEnrollment.status);
        } else {
          skip(skippedByReason, 'controller_progression:' + progression.status);
        }
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        if (retainedSession.controllerType !== 'chatgpt') {
          try {
            maybeRegisterForgeActionableFailureRepair({
              controllerHome: input.controllerHome,
              now: () => input.nowMs,
              observation: {
                observationId: `progression:liveness:${repository.repoId}:${work.workId}:${input.nowMs}`,
                source: 'progression',
                code: deriveForgeActionableFailureCode('SCHEDULER_AUTONOMOUS_CONTINUATION_FAILED', reason),
                message: reason,
                at: new Date(input.nowMs).toISOString(),
                repoId: repository.repoId,
                workId: work.workId,
              },
            });
          } catch {}
        }
        console.error('[forge liveness] autonomous continuation failed for ' + repository.repoId + '/' + work.workId + ':', reason);
      }
    }
  }

  return { scanned, eligible, dispatched, supervisorEnrolled, failed, skippedByReason };
}
