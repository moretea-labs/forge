/*
 * Stable rh_project operation ABI.
 *
 * The MCP input schema and server-generated SuggestedNextAction validation must
 * consume this single registry. Keeping separate handwritten operation lists
 * lets the Runtime advertise transitions that a client contract cannot express,
 * or reject valid lifecycle actions that the schema already exposes.
 */
export const RH_PROJECT_OPERATIONS = [
  'repair',
  'launcher_start',
  'project_create',
  'project_list',
  'project_get',
  'project_revise',
  'project_attach_requirement',
  'requirement_create',
  'requirement_list',
  'requirement_manifest',
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
] as const;

/**
 * There is intentionally no legacy lifecycle or historical Work operation set.
 * A Runtime that has rolled over to Thin Forge rejects the former
 * verify/review/finalize, controller-claim, and list/get/get_contract
 * vocabulary instead of silently translating it or advertising read-only Work.
 */

/** Model-facing rh_project enum is identical to the accepted operation registry. */
export const RH_PROJECT_MODEL_OPERATIONS = RH_PROJECT_OPERATIONS;

export type RhProjectOperation = (typeof RH_PROJECT_OPERATIONS)[number];

export function isRhProjectOperation(operation: string): operation is RhProjectOperation {
  return (RH_PROJECT_OPERATIONS as readonly string[]).includes(operation);
}

export function isRhProjectAcceptedOperation(operation: string): boolean {
  return isRhProjectOperation(operation);
}
