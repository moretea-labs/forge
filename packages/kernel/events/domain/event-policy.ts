import type { EventEnvelopeV1 } from './event-envelope';

export type EventPolicyPermission = 'read' | 'workspace_write' | 'external_write' | 'destructive';
export interface EventPolicyV1 {
  schemaVersion: 1;
  policyId: string;
  revision: number;
  enabled: boolean;
  match: { sources: string[]; providers?: string[]; eventTypes?: string[]; scopeKinds?: string[] };
  decision: {
    mode: 'deterministic' | 'model';
    modelProfileId?: string;
    minimumConfidence?: number;
    instructionTemplateId?: string;
  };
  allowedActions: Array<{ actionId: string; permission: EventPolicyPermission; requiresApproval: boolean }>;
  budget: { timeoutMs: number; maxInputBytes: number; maxOutputTokens: number };
  failure: { onTimeout: 'hold' | 'skip'; onInvalidDecision: 'hold' | 'quarantine' };
}
export interface EventPolicyModelDecision {
  schemaVersion: 1;
  eventId: string;
  outcome: 'act' | 'ignore' | 'needs_review';
  actionId?: string;
  confidence: number;
  rationale: string;
  evidenceRefs: string[];
}
export type EventPolicyMatchResult =
  | { matched: true; policyId: string; revision: number }
  | { matched: false; reason: 'disabled' | 'source' | 'provider' | 'event_type' | 'scope_kind' };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_ID = /^[a-z][a-z0-9_.:-]{1,127}$/;
const PERMISSIONS = new Set<EventPolicyPermission>(['read', 'workspace_write', 'external_write', 'destructive']);
function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new Error(code);
}
function strings(v: unknown, required: boolean, code: string): string[] | undefined {
  if (v === undefined && !required) return undefined;
  if (
    !Array.isArray(v) ||
    v.length === 0 ||
    v.some((x) => typeof x !== 'string' || !IDENTIFIER.test(x)) ||
    new Set(v).size !== v.length
  )
    throw new Error(code);
  return [...v] as string[];
}
function validateMatch(value: unknown): EventPolicyV1['match'] {
  if (!record(value)) throw new Error('EVENT_POLICY_MATCH_INVALID');
  exact(value, ['sources', 'providers', 'eventTypes', 'scopeKinds'], 'EVENT_POLICY_MATCH_FIELD_UNSUPPORTED');
  const sources = strings(value.sources, true, 'EVENT_POLICY_SOURCES_INVALID')!;
  const providers = strings(value.providers, false, 'EVENT_POLICY_PROVIDERS_INVALID');
  const eventTypes = strings(value.eventTypes, false, 'EVENT_POLICY_EVENT_TYPES_INVALID');
  const scopeKinds = strings(value.scopeKinds, false, 'EVENT_POLICY_SCOPE_KINDS_INVALID');
  return {
    sources,
    ...(providers ? { providers } : {}),
    ...(eventTypes ? { eventTypes } : {}),
    ...(scopeKinds ? { scopeKinds } : {}),
  };
}

function validateModelDecision(value: Record<string, unknown>): EventPolicyV1['decision'] {
  const profile = value.modelProfileId;
  const confidence = value.minimumConfidence;
  const template = value.instructionTemplateId;
  if (typeof profile !== 'string' || !IDENTIFIER.test(profile)) throw new Error('EVENT_POLICY_MODEL_PROFILE_REQUIRED');
  if (
    confidence !== undefined &&
    (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  )
    throw new Error('EVENT_POLICY_CONFIDENCE_INVALID');
  if (template !== undefined && (typeof template !== 'string' || !IDENTIFIER.test(template)))
    throw new Error('EVENT_POLICY_INSTRUCTION_TEMPLATE_INVALID');
  return {
    mode: 'model',
    modelProfileId: profile,
    ...(typeof confidence === 'number' ? { minimumConfidence: confidence } : {}),
    ...(typeof template === 'string' ? { instructionTemplateId: template } : {}),
  };
}

function validateDecision(value: unknown): EventPolicyV1['decision'] {
  if (!record(value)) throw new Error('EVENT_POLICY_DECISION_INVALID');
  exact(
    value,
    ['mode', 'modelProfileId', 'minimumConfidence', 'instructionTemplateId'],
    'EVENT_POLICY_DECISION_FIELD_UNSUPPORTED',
  );
  if (value.mode === 'deterministic') {
    if (
      value.modelProfileId !== undefined ||
      value.minimumConfidence !== undefined ||
      value.instructionTemplateId !== undefined
    )
      throw new Error('EVENT_POLICY_DETERMINISTIC_MODEL_SETTINGS_UNSUPPORTED');
    return { mode: 'deterministic' };
  }
  if (value.mode !== 'model') throw new Error('EVENT_POLICY_DECISION_MODE_INVALID');
  return validateModelDecision(value);
}

function validateActions(value: unknown): EventPolicyV1['allowedActions'] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('EVENT_POLICY_ACTIONS_INVALID');
  const actions = value.map((action) => {
    if (!record(action)) throw new Error('EVENT_POLICY_ACTION_INVALID');
    exact(action, ['actionId', 'permission', 'requiresApproval'], 'EVENT_POLICY_ACTION_FIELD_UNSUPPORTED');
    if (typeof action.actionId !== 'string' || !ACTION_ID.test(action.actionId))
      throw new Error('EVENT_POLICY_ACTION_ID_INVALID');
    if (typeof action.permission !== 'string' || !PERMISSIONS.has(action.permission as EventPolicyPermission))
      throw new Error('EVENT_POLICY_PERMISSION_INVALID');
    if (typeof action.requiresApproval !== 'boolean') throw new Error('EVENT_POLICY_APPROVAL_INVALID');
    return {
      actionId: action.actionId,
      permission: action.permission as EventPolicyPermission,
      requiresApproval: action.requiresApproval,
    };
  });
  if (new Set(actions.map((action) => action.actionId)).size !== actions.length)
    throw new Error('EVENT_POLICY_ACTION_DUPLICATE');
  return actions;
}

function validateBudget(value: unknown): EventPolicyV1['budget'] {
  if (!record(value)) throw new Error('EVENT_POLICY_BUDGET_INVALID');
  exact(value, ['timeoutMs', 'maxInputBytes', 'maxOutputTokens'], 'EVENT_POLICY_BUDGET_FIELD_UNSUPPORTED');
  const bounds = { timeoutMs: [100, 120000], maxInputBytes: [256, 2000000], maxOutputTokens: [16, 16384] } as const;
  for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
    const candidate = value[key];
    const [min, max] = bounds[key];
    if (!Number.isSafeInteger(candidate) || Number(candidate) < min || Number(candidate) > max)
      throw new Error('EVENT_POLICY_BUDGET_RANGE_INVALID:' + key);
  }
  return {
    timeoutMs: Number(value.timeoutMs),
    maxInputBytes: Number(value.maxInputBytes),
    maxOutputTokens: Number(value.maxOutputTokens),
  };
}

function validateFailure(value: unknown): EventPolicyV1['failure'] {
  if (!record(value)) throw new Error('EVENT_POLICY_FAILURE_INVALID');
  exact(value, ['onTimeout', 'onInvalidDecision'], 'EVENT_POLICY_FAILURE_FIELD_UNSUPPORTED');
  if (value.onTimeout !== 'hold' && value.onTimeout !== 'skip')
    throw new Error('EVENT_POLICY_TIMEOUT_BEHAVIOR_INVALID');
  if (value.onInvalidDecision !== 'hold' && value.onInvalidDecision !== 'quarantine')
    throw new Error('EVENT_POLICY_INVALID_DECISION_BEHAVIOR_INVALID');
  return { onTimeout: value.onTimeout, onInvalidDecision: value.onInvalidDecision };
}

export function validateEventPolicyV1(value: unknown): EventPolicyV1 {
  if (!record(value)) throw new Error('EVENT_POLICY_INVALID');
  exact(
    value,
    ['schemaVersion', 'policyId', 'revision', 'enabled', 'match', 'decision', 'allowedActions', 'budget', 'failure'],
    'EVENT_POLICY_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== 1) throw new Error('EVENT_POLICY_SCHEMA_VERSION_UNSUPPORTED');
  if (typeof value.policyId !== 'string' || !IDENTIFIER.test(value.policyId))
    throw new Error('EVENT_POLICY_ID_INVALID');
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error('EVENT_POLICY_REVISION_INVALID');
  if (typeof value.enabled !== 'boolean') throw new Error('EVENT_POLICY_ENABLED_INVALID');
  return {
    schemaVersion: 1,
    policyId: value.policyId,
    revision: Number(value.revision),
    enabled: value.enabled,
    match: validateMatch(value.match),
    decision: validateDecision(value.decision),
    allowedActions: validateActions(value.allowedActions),
    budget: validateBudget(value.budget),
    failure: validateFailure(value.failure),
  };
}
export function matchEventPolicy(input: EventPolicyV1, envelope: EventEnvelopeV1): EventPolicyMatchResult {
  const p = validateEventPolicyV1(input);
  if (!p.enabled) return { matched: false, reason: 'disabled' };
  if (!p.match.sources.includes(envelope.source)) return { matched: false, reason: 'source' };
  if (p.match.providers && !p.match.providers.includes(envelope.provider))
    return { matched: false, reason: 'provider' };
  if (p.match.eventTypes && !p.match.eventTypes.includes(envelope.eventType))
    return { matched: false, reason: 'event_type' };
  if (p.match.scopeKinds && !p.match.scopeKinds.includes(envelope.scope.kind))
    return { matched: false, reason: 'scope_kind' };
  return { matched: true, policyId: p.policyId, revision: p.revision };
}
function validateDecisionAction(policy: EventPolicyV1, value: Record<string, unknown>): void {
  if (value.outcome !== 'act') {
    if (value.actionId !== undefined) throw new Error('EVENT_POLICY_MODEL_ACTION_UNEXPECTED');
    return;
  }
  if (typeof value.actionId !== 'string' || !policy.allowedActions.some((action) => action.actionId === value.actionId))
    throw new Error('EVENT_POLICY_MODEL_ACTION_NOT_ALLOWED');
  if (typeof value.confidence === 'number' && value.confidence < (policy.decision.minimumConfidence ?? 0))
    throw new Error('EVENT_POLICY_MODEL_CONFIDENCE_BELOW_THRESHOLD');
}

/** Model output is a proposal only: it cannot carry target, permission, approval or arbitrary arguments. */
export function validateEventPolicyModelDecision(
  policyInput: EventPolicyV1,
  envelope: EventEnvelopeV1,
  value: unknown,
): EventPolicyModelDecision {
  const p = validateEventPolicyV1(policyInput);
  if (p.decision.mode !== 'model') throw new Error('EVENT_POLICY_MODEL_DECISION_NOT_ENABLED');
  if (!matchEventPolicy(p, envelope).matched) throw new Error('EVENT_POLICY_NOT_MATCHED');
  if (!record(value)) throw new Error('EVENT_POLICY_MODEL_DECISION_INVALID');
  exact(
    value,
    ['schemaVersion', 'eventId', 'outcome', 'actionId', 'confidence', 'rationale', 'evidenceRefs'],
    'EVENT_POLICY_MODEL_DECISION_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== 1 || value.eventId !== envelope.eventId)
    throw new Error('EVENT_POLICY_MODEL_EVENT_ID_MISMATCH');
  if (!['act', 'ignore', 'needs_review'].includes(String(value.outcome)))
    throw new Error('EVENT_POLICY_MODEL_OUTCOME_INVALID');
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  )
    throw new Error('EVENT_POLICY_MODEL_CONFIDENCE_INVALID');
  validateDecisionAction(p, value);
  if (typeof value.rationale !== 'string' || !value.rationale.trim() || value.rationale.length > 2000)
    throw new Error('EVENT_POLICY_MODEL_RATIONALE_INVALID');
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length > 32 ||
    value.evidenceRefs.some((x) => typeof x !== 'string' || x.length > 512)
  )
    throw new Error('EVENT_POLICY_MODEL_EVIDENCE_INVALID');
  return {
    schemaVersion: 1,
    eventId: envelope.eventId,
    outcome: value.outcome as EventPolicyModelDecision['outcome'],
    ...(typeof value.actionId === 'string' ? { actionId: value.actionId } : {}),
    confidence: value.confidence,
    rationale: value.rationale,
    evidenceRefs: [...value.evidenceRefs] as string[],
  };
}
