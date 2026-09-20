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
  'continue',
  'verify',
  'review',
  'repair',
  'finalize',
  'stop',
  'delegate',
  'controller_claim',
  'controller_release',
  'controller_disposition',
  'controller_get_owner',
  'launcher_start',
  'requirement_create',
  'requirement_promote_candidate',
  'requirement_continue',
  'plan_create',
  'plan_get',
  'plan_list',
  'plan_approve',
  'plan_accept_step',
  'plan_supersede',
  'schedule_create',
  'schedule_list',
  'schedule_get',
  'schedule_pause',
  'schedule_resume',
  'schedule_delete',
  'schedule_trigger',
  'workflow_execute',
  'workflow_reconcile',
  'outcome_record',
  'experience_record',
] as const;

export type RhWorkOperation = (typeof RH_WORK_OPERATIONS)[number];

export function isRhWorkOperation(operation: string): operation is RhWorkOperation {
  return (RH_WORK_OPERATIONS as readonly string[]).includes(operation);
}
