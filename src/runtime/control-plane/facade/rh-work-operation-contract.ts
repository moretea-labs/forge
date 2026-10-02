/*
 * Stable rh_work operation ABI.
 *
 * The MCP input schema and server-generated SuggestedNextAction validation must
 * consume this single registry. Keeping separate handwritten operation lists
 * lets the Runtime advertise transitions that a client contract cannot express,
 * or reject valid lifecycle actions that the schema already exposes.
 */
export const RH_WORK_OPERATIONS = [
  'start',
  'repair',
  'get',
  'revise',
  'complete',
  'launcher_start',
  'requirement_create',
  'requirement_get',
  'requirement_revise',
  'requirement_promote_candidate',
  'plan_create',
  'plan_get',
  'plan_revise',
  'plan_list',
  'schedule_create',
  'schedule_list',
  'schedule_get',
  'schedule_pause',
  'schedule_resume',
  'schedule_delete',
  'schedule_trigger',
  'workflow_execute',
  'workflow_reconcile',
  'learning_record',
  'learning_feedback',
  'outcome_record',
  'experience_record',
] as const;

/**
 * There is intentionally no legacy lifecycle operation set.  A Runtime that
 * has rolled over to Thin Forge rejects the former verify/review/finalize and
 * controller-claim vocabulary instead of silently translating it.
 */

export const RH_WORK_MODEL_OPERATIONS = [
  'start',
  'repair',
  'get',
  'revise',
  'complete',
  'launcher_start',
  'requirement_create',
  'requirement_get',
  'requirement_revise',
  'requirement_promote_candidate',
  'plan_create',
  'plan_get',
  'plan_revise',
  'plan_list',
  'schedule_create',
  'schedule_list',
  'schedule_get',
  'schedule_pause',
  'schedule_resume',
  'schedule_delete',
  'schedule_trigger',
  'workflow_execute',
  'workflow_reconcile',
  'learning_record',
  'learning_feedback',
  'outcome_record',
  'experience_record',
] as const;

export type RhWorkOperation = (typeof RH_WORK_OPERATIONS)[number];

export function isRhWorkOperation(operation: string): operation is RhWorkOperation {
  return (RH_WORK_OPERATIONS as readonly string[]).includes(operation);
}

export function isRhWorkAcceptedOperation(operation: string): boolean {
  return isRhWorkOperation(operation);
}
