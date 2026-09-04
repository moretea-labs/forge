import type { ControllerRoundRelayStatus } from '../../controller/api/index';
import type { WorkContractStatus } from '../../work/api/index';

/**
 * Read-only lifecycle facts consumed by the Goal Progression projector.
 * These are projections of existing authorities, never a persistence schema.
 */
export type ProgressionRequirementState = 'planned' | 'active' | 'waiting_for_user' | 'done' | 'cancelled';
export type ProgressionPlanStatus =
  | 'draft'
  | 'reviewing'
  | 'approved'
  | 'executing'
  | 'replanning'
  | 'verifying'
  | 'ready_to_finalize'
  | 'finalized'
  | 'superseded'
  | 'cancelled'
  | 'invalidated_by_drift';
export type ProgressionPlanStepStatus = 'pending' | 'ready' | 'executing' | 'validating' | 'completed';

export interface ProgressionRequirementSnapshot {
  requirementId: string;
  state: ProgressionRequirementState;
  revision: number;
}

export interface ProgressionPlanStepSnapshot {
  id: string;
  dependencies: readonly string[];
  status: ProgressionPlanStepStatus;
  workId?: string;
}

export interface ProgressionPlanSnapshot {
  planId: string;
  requirementId?: string;
  sourceRevision: string;
  status: ProgressionPlanStatus;
  steps: readonly ProgressionPlanStepSnapshot[];
}

export interface ProgressionWorkSnapshot {
  workId: string;
  requirementId?: string;
  planId?: string;
  planStepId?: string;
  status: WorkContractStatus;
}

export interface ProgressionControllerRoundSnapshot {
  originWorkId: string;
  status: ControllerRoundRelayStatus;
  roundCount: number;
}

export interface AutonomousGoalProgressionSnapshot {
  requirement: ProgressionRequirementSnapshot;
  plan: ProgressionPlanSnapshot;
  currentSourceRevision: string;
  works: readonly ProgressionWorkSnapshot[];
  controllerRounds?: readonly ProgressionControllerRoundSnapshot[];
}

export const AUTONOMOUS_GOAL_PROGRESSION_ACTIONS = [
  'continue_current_work',
  'wait_current_work',
  'request_controller_acceptance',
  'start_next_plan_step',
  'wait_dependency',
  'request_replan',
  'wait_for_user',
  'goal_complete',
  'blocked_invalid_state',
] as const;
export type AutonomousGoalProgressionAction = (typeof AUTONOMOUS_GOAL_PROGRESSION_ACTIONS)[number];

export const AUTONOMOUS_GOAL_PROGRESSION_REASONS = [
  'REQUIREMENT_ALREADY_DONE',
  'REQUIREMENT_WAITING_FOR_USER',
  'REQUIREMENT_CANCELLED',
  'PLAN_REQUIREMENT_MISMATCH',
  'PLAN_SOURCE_DRIFT',
  'PLAN_REPLAN_REQUIRED',
  'PLAN_TERMINAL_INVALID',
  'PLAN_NOT_EXECUTABLE',
  'PLAN_EMPTY',
  'PLAN_STEP_ID_DUPLICATE',
  'PLAN_DEPENDENCY_INVALID',
  'PLAN_STEP_WORK_MISSING',
  'WORK_IDENTITY_MISMATCH',
  'WORK_FAILED_REPLAN',
  'WORK_BLOCKED',
  'CONTROLLER_ROUND_IN_FLIGHT',
  'CONTROLLER_ROUND_WAITING_FOR_USER',
  'CONTROLLER_ROUND_TERMINAL_CONTRADICTION',
  'WORK_READY_TO_CONTINUE',
  'MACHINE_COMPLETE_REQUIRES_CONTROLLER_ACCEPTANCE',
  'NEXT_PLAN_STEP_READY',
  'PLAN_DEPENDENCY_WAIT',
  'MULTIPLE_READY_PLAN_STEPS',
  'PLAN_STEP_READINESS_NOT_PROJECTED',
  'ALL_PLAN_STEPS_ACCEPTED',
] as const;
export type AutonomousGoalProgressionReason = (typeof AUTONOMOUS_GOAL_PROGRESSION_REASONS)[number];

export interface AutonomousGoalProgressionDecision {
  schemaVersion: 1;
  kind: AutonomousGoalProgressionAction;
  reasonCode: AutonomousGoalProgressionReason;
  requirementId: string;
  planId: string;
  planStepId?: string;
  workId?: string;
  dependencyStepIds?: string[];
  /** Stable replay identity derived only from the immutable input snapshot + decision. */
  idempotencyKey: string;
}
