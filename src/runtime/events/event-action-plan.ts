import {
  matchEventPolicy,
  validateEventEnvelopeV1,
  validateEventPolicyModelDecision,
  validateEventPolicyV1,
  type EventEnvelopeV1,
  type EventPolicyModelDecision,
  type EventPolicyPermission,
  type EventPolicyV1,
} from '../../../packages/kernel/events';

export type EventActionPlanDisposition =
  | 'no_action'
  | 'review_required'
  | 'approval_required'
  | 'eligible_for_dispatch';

export interface EventActionPlanV1 {
  schemaVersion: 1;
  eventId: string;
  policyId: string;
  policyRevision: number;
  decisionMode: 'deterministic' | 'model';
  disposition: EventActionPlanDisposition;
  action?: {
    actionId: string;
    permission: EventPolicyPermission;
    requiresApproval: boolean;
  };
  decision?: {
    outcome: EventPolicyModelDecision['outcome'];
    confidence: number;
    evidenceRefs: string[];
  };
  authorizationState: 'not_authorized';
  execution: 'not_executed';
}

function noExecutionPlan(
  policy: EventPolicyV1,
  eventId: string,
  disposition: 'no_action' | 'review_required',
  decision?: EventPolicyModelDecision,
): EventActionPlanV1 {
  return {
    schemaVersion: 1,
    eventId,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    decisionMode: policy.decision.mode,
    disposition,
    ...(decision
      ? {
          decision: {
            outcome: decision.outcome,
            confidence: decision.confidence,
            evidenceRefs: [...decision.evidenceRefs],
          },
        }
      : {}),
    authorizationState: 'not_authorized',
    execution: 'not_executed',
  };
}

function actionPlan(
  policy: EventPolicyV1,
  eventId: string,
  actionId: string,
  decision?: EventPolicyModelDecision,
): EventActionPlanV1 {
  const action = policy.allowedActions.find((candidate) => candidate.actionId === actionId);
  if (!action) throw new Error('EVENT_ACTION_PLAN_ACTION_NOT_ALLOWED');
  return {
    schemaVersion: 1,
    eventId,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    decisionMode: policy.decision.mode,
    disposition: action.requiresApproval ? 'approval_required' : 'eligible_for_dispatch',
    action: { ...action },
    ...(decision
      ? {
          decision: {
            outcome: decision.outcome,
            confidence: decision.confidence,
            evidenceRefs: [...decision.evidenceRefs],
          },
        }
      : {}),
    authorizationState: 'not_authorized',
    execution: 'not_executed',
  };
}

/**
 * Converts a matched policy and optional schema-validated model proposal into a
 * fixed action plan. This grants no permission and performs no dispatch.
 */
export function compileEventActionPlan(
  policyInput: EventPolicyV1,
  envelopeInput: EventEnvelopeV1,
  modelDecision?: unknown,
): EventActionPlanV1 {
  const policy = validateEventPolicyV1(policyInput);
  const envelope = validateEventEnvelopeV1(envelopeInput);
  if (!matchEventPolicy(policy, envelope).matched) throw new Error('EVENT_POLICY_NOT_MATCHED');

  if (policy.decision.mode === 'deterministic') {
    if (modelDecision !== undefined) throw new Error('EVENT_ACTION_PLAN_MODEL_DECISION_UNEXPECTED');
    if (policy.allowedActions.length === 0) return noExecutionPlan(policy, envelope.eventId, 'no_action');
    if (policy.allowedActions.length !== 1) throw new Error('EVENT_POLICY_DETERMINISTIC_ACTION_AMBIGUOUS');
    const action = policy.allowedActions[0];
    if (!action) throw new Error('EVENT_POLICY_DETERMINISTIC_ACTION_MISSING');
    return actionPlan(policy, envelope.eventId, action.actionId);
  }

  if (modelDecision === undefined) throw new Error('EVENT_ACTION_PLAN_MODEL_DECISION_REQUIRED');
  const decision = validateEventPolicyModelDecision(policy, envelope, modelDecision);
  if (decision.outcome === 'ignore') return noExecutionPlan(policy, envelope.eventId, 'no_action', decision);
  if (decision.outcome === 'needs_review')
    return noExecutionPlan(policy, envelope.eventId, 'review_required', decision);
  if (!decision.actionId) throw new Error('EVENT_ACTION_PLAN_ACTION_REQUIRED');
  return actionPlan(policy, envelope.eventId, decision.actionId, decision);
}
