export const REQUIREMENT_STATES = ['planned', 'active', 'waiting_for_user', 'done', 'cancelled'] as const;
export type RequirementState = (typeof REQUIREMENT_STATES)[number];

export const REQUIREMENT_STATE_TRANSITIONS: Readonly<Record<RequirementState, readonly RequirementState[]>> = {
  planned: ['planned', 'active', 'waiting_for_user', 'cancelled'],
  active: ['active', 'waiting_for_user', 'done', 'cancelled'],
  waiting_for_user: ['waiting_for_user', 'planned', 'active', 'done', 'cancelled'],
  done: ['done', 'cancelled'],
  cancelled: ['cancelled'],
};

export const PLAN_CONTRACT_STATUSES = [
  'draft',
  'inspecting',
  'reviewing',
  'approved',
  'executing',
  'replanning',
  'verifying',
  'ready_to_finalize',
  'finalized',
  'superseded',
  'cancelled',
  'invalidated_by_drift',
] as const;
export type PlanContractStatus = (typeof PLAN_CONTRACT_STATUSES)[number];

export const TERMINAL_PLAN_CONTRACT_STATUSES: readonly PlanContractStatus[] = [
  'finalized',
  'superseded',
  'cancelled',
  'invalidated_by_drift',
];

export function isTerminalPlanContractStatus(status: PlanContractStatus): boolean {
  return TERMINAL_PLAN_CONTRACT_STATUSES.includes(status);
}

export const PLAN_STEP_STATUSES = ['pending', 'ready', 'executing', 'validating', 'completed'] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];
