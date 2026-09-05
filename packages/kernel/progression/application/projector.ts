import { createHash } from 'crypto';
import type {
  AutonomousGoalProgressionAction,
  AutonomousGoalProgressionDecision,
  AutonomousGoalProgressionReason,
  AutonomousGoalProgressionSnapshot,
  ProgressionControllerRoundSnapshot,
  ProgressionPlanStepSnapshot,
  ProgressionWorkSnapshot,
} from '../domain/types';

const EXECUTABLE_PLAN_STATUSES = new Set(['approved', 'executing', 'verifying', 'ready_to_finalize']);
const ACTIVE_WORK_STATUSES = new Set(['open', 'running', 'ready']);
const IN_FLIGHT_ROUND_STATUSES = new Set(['pending_release', 'dispatching', 'dispatched', 'claimed', 'waiting']);

function stableSnapshot(snapshot: AutonomousGoalProgressionSnapshot): unknown {
  return {
    requirement: snapshot.requirement,
    plan: {
      planId: snapshot.plan.planId,
      requirementId: snapshot.plan.requirementId,
      sourceRevision: snapshot.plan.sourceRevision,
      status: snapshot.plan.status,
      steps: snapshot.plan.steps.map((step) => ({
        id: step.id,
        dependencies: [...step.dependencies],
        status: step.status,
        workId: step.workId,
      })),
    },
    currentSourceRevision: snapshot.currentSourceRevision,
    works: [...snapshot.works]
      .map((work) => ({ ...work }))
      .sort((left, right) => left.workId.localeCompare(right.workId)),
    controllerRounds: [...(snapshot.controllerRounds ?? [])]
      .map((round) => ({ ...round }))
      .sort((left, right) => left.originWorkId.localeCompare(right.originWorkId) || left.roundCount - right.roundCount),
    schedules: [...(snapshot.schedules ?? [])]
      .map((schedule) => ({ ...schedule }))
      .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId)),
  };
}

function decision(
  snapshot: AutonomousGoalProgressionSnapshot,
  kind: AutonomousGoalProgressionAction,
  reasonCode: AutonomousGoalProgressionReason,
  detail: Pick<AutonomousGoalProgressionDecision, 'planStepId' | 'workId' | 'dependencyStepIds'> = {},
): AutonomousGoalProgressionDecision {
  const identityInput = JSON.stringify({
    snapshot: stableSnapshot(snapshot),
    decision: { kind, reasonCode, ...detail },
  });
  return {
    schemaVersion: 1,
    kind,
    reasonCode,
    requirementId: snapshot.requirement.requirementId,
    planId: snapshot.plan.planId,
    ...detail,
    idempotencyKey: `goal-progression:v1:${createHash('sha256').update(identityInput).digest('hex').slice(0, 32)}`,
  };
}

function latestRoundForWork(
  rounds: readonly ProgressionControllerRoundSnapshot[] | undefined,
  workId: string,
): ProgressionControllerRoundSnapshot | undefined {
  return (rounds ?? [])
    .filter((round) => round.originWorkId === workId)
    .reduce<ProgressionControllerRoundSnapshot | undefined>(
      (latest, round) => !latest || round.roundCount > latest.roundCount ? round : latest,
      undefined,
    );
}

function boundWork(
  snapshot: AutonomousGoalProgressionSnapshot,
  step: ProgressionPlanStepSnapshot,
): ProgressionWorkSnapshot | undefined {
  if (!step.workId) return undefined;
  return snapshot.works.find((work) => work.workId === step.workId);
}

function invalidDependency(
  steps: readonly ProgressionPlanStepSnapshot[],
): { stepId: string; dependencyIds: string[] } | undefined {
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    const missing = step.dependencies.filter((dependencyId) => dependencyId === step.id || !ids.has(dependencyId));
    if (missing.length > 0) return { stepId: step.id, dependencyIds: [...missing] };
  }
  return undefined;
}

/**
 * Pure Goal-level progression projection. It never writes lifecycle state and
 * never equates machine delivery with Controller semantic acceptance.
 */
export function projectAutonomousGoalProgression(
  snapshot: AutonomousGoalProgressionSnapshot,
): AutonomousGoalProgressionDecision {
  const { requirement, plan } = snapshot;

  if (requirement.state === 'done') return decision(snapshot, 'goal_complete', 'REQUIREMENT_ALREADY_DONE');
  if (requirement.state === 'waiting_for_user') return decision(snapshot, 'wait_for_user', 'REQUIREMENT_WAITING_FOR_USER');
  if (requirement.state === 'cancelled') return decision(snapshot, 'blocked_invalid_state', 'REQUIREMENT_CANCELLED');
  if (plan.requirementId && plan.requirementId !== requirement.requirementId) {
    return decision(snapshot, 'blocked_invalid_state', 'PLAN_REQUIREMENT_MISMATCH');
  }

  // A terminal Work may legitimately advance repository source A -> B before
  // Controller semantic acceptance advances Plan.sourceRevision to B. Only that
  // exact Work completion target may cross the drift boundary. Any later C is
  // unrelated drift and still requires explicit re-evaluation.
  const validatingDelivery = plan.steps
    .filter((step) => step.status === 'executing' || step.status === 'validating')
    .map((step) => ({ step, work: boundWork(snapshot, step) }))
    .find(({ work }) => work?.status === 'completed'
      && work.baseRevision === plan.sourceRevision
      && work.completionTargetRevision === snapshot.currentSourceRevision);
  const expectedDeliveryAdvance = Boolean(validatingDelivery && plan.sourceRevision !== snapshot.currentSourceRevision);
  if (plan.sourceRevision !== snapshot.currentSourceRevision && !expectedDeliveryAdvance) {
    return decision(snapshot, 'request_replan', 'PLAN_SOURCE_DRIFT');
  }
  if (plan.status === 'replanning' || plan.status === 'invalidated_by_drift') return decision(snapshot, 'request_replan', 'PLAN_REPLAN_REQUIRED');
  if (plan.status === 'finalized') {
    if (!plan.steps.every((step) => step.status === 'completed')) {
      return decision(snapshot, 'blocked_invalid_state', 'PLAN_COMPLETION_STATE_CONTRADICTION');
    }
    return decision(snapshot, 'request_requirement_acceptance', 'PLAN_FINALIZED_REQUIRES_REQUIREMENT_ACCEPTANCE');
  }
  if (plan.status === 'superseded' || plan.status === 'cancelled') return decision(snapshot, 'blocked_invalid_state', 'PLAN_TERMINAL_INVALID');
  if (!EXECUTABLE_PLAN_STATUSES.has(plan.status)) return decision(snapshot, 'blocked_invalid_state', 'PLAN_NOT_EXECUTABLE');
  if (plan.steps.length === 0) return decision(snapshot, 'blocked_invalid_state', 'PLAN_EMPTY');

  const ids = new Set(plan.steps.map((step) => step.id));
  if (ids.size !== plan.steps.length) return decision(snapshot, 'blocked_invalid_state', 'PLAN_STEP_ID_DUPLICATE');
  const badDependency = invalidDependency(plan.steps);
  if (badDependency) {
    return decision(snapshot, 'blocked_invalid_state', 'PLAN_DEPENDENCY_INVALID', {
      planStepId: badDependency.stepId,
      dependencyStepIds: badDependency.dependencyIds,
    });
  }

  for (const step of plan.steps) {
    if (step.status !== 'executing' && step.status !== 'validating') continue;
    const work = boundWork(snapshot, step);
    if (!work) return decision(snapshot, 'blocked_invalid_state', 'PLAN_STEP_WORK_MISSING', { planStepId: step.id, workId: step.workId });
    if (work.planId !== plan.planId || work.planStepId !== step.id || (work.requirementId && work.requirementId !== requirement.requirementId)) {
      return decision(snapshot, 'blocked_invalid_state', 'WORK_IDENTITY_MISMATCH', { planStepId: step.id, workId: work.workId });
    }
    if ((work.status === 'completed' || work.status === 'failed' || work.status === 'cancelled') && step.status === 'executing') {
      return decision(snapshot, 'blocked_invalid_state', 'PLAN_STEP_TERMINAL_WORK_RECONCILIATION_REQUIRED', { planStepId: step.id, workId: work.workId });
    }
    if (work.status === 'failed' || work.status === 'cancelled') {
      return decision(snapshot, 'request_replan', 'WORK_FAILED_REPLAN', { planStepId: step.id, workId: work.workId });
    }
    if (work.status === 'blocked') return decision(snapshot, 'wait_current_work', 'WORK_BLOCKED', { planStepId: step.id, workId: work.workId });
    if (work.status === 'completed') {
      return decision(snapshot, 'request_controller_acceptance', 'MACHINE_COMPLETE_REQUIRES_CONTROLLER_ACCEPTANCE', {
        planStepId: step.id,
        workId: work.workId,
      });
    }
    if (ACTIVE_WORK_STATUSES.has(work.status)) {
      const round = latestRoundForWork(snapshot.controllerRounds, work.workId);
      if (round?.status === 'waiting_for_user') {
        return decision(snapshot, 'wait_for_user', 'CONTROLLER_ROUND_WAITING_FOR_USER', { planStepId: step.id, workId: work.workId });
      }
      if (round?.status === 'goal_complete') {
        return decision(snapshot, 'blocked_invalid_state', 'CONTROLLER_ROUND_TERMINAL_CONTRADICTION', { planStepId: step.id, workId: work.workId });
      }
      if (round && (IN_FLIGHT_ROUND_STATUSES.has(round.status) || round.status === 'blocked' || round.status === 'failed')) {
        return decision(snapshot, 'wait_current_work', 'CONTROLLER_ROUND_IN_FLIGHT', { planStepId: step.id, workId: work.workId });
      }
      return decision(snapshot, 'continue_current_work', 'WORK_READY_TO_CONTINUE', { planStepId: step.id, workId: work.workId });
    }
  }

  if (plan.steps.every((step) => step.status === 'completed')) {
    return decision(snapshot, 'blocked_invalid_state', 'PLAN_COMPLETION_STATE_CONTRADICTION');
  }

  const completedIds = new Set(plan.steps.filter((step) => step.status === 'completed').map((step) => step.id));
  const dependencyReady = plan.steps.filter((step) =>
    step.status !== 'completed'
    && step.dependencies.every((dependencyId) => completedIds.has(dependencyId)),
  );
  const explicitReady = dependencyReady.filter((step) => step.status === 'ready');

  if (explicitReady.length === 1) {
    return decision(snapshot, 'start_next_plan_step', 'NEXT_PLAN_STEP_READY', { planStepId: explicitReady[0].id });
  }
  if (explicitReady.length > 1) {
    return decision(snapshot, 'blocked_invalid_state', 'MULTIPLE_READY_PLAN_STEPS', {
      dependencyStepIds: explicitReady.map((step) => step.id),
    });
  }
  const readinessNotProjected = dependencyReady.find((step) => step.status === 'pending');
  if (readinessNotProjected) {
    return decision(snapshot, 'blocked_invalid_state', 'PLAN_STEP_READINESS_NOT_PROJECTED', { planStepId: readinessNotProjected.id });
  }

  const blocked = plan.steps.find((step) => step.status !== 'completed');
  return decision(snapshot, 'wait_dependency', 'PLAN_DEPENDENCY_WAIT', {
    planStepId: blocked?.id,
    dependencyStepIds: blocked?.dependencies.filter((dependencyId) => !completedIds.has(dependencyId)) ?? [],
  });
}
