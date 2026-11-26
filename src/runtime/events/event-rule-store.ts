import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import {
  evaluateEventRule,
  validateEventRuleV1,
  type EventEnvelopeV1,
  type EventRuleEvaluationContext,
  type EventRuleEvaluationResult,
  type EventRuleV1,
} from '../../../packages/kernel/events';

const NAMESPACE = 'event_rule';
const SCOPE = 'global';
// Event execution must never silently ignore rules beyond the configuration-list page.
const MAX_EVALUATED_EVENT_RULES = 1_000;

export function createEventRule(controllerHome: string, input: unknown): ControlPlaneRecord<EventRuleV1> {
  const rule = validateEventRuleV1(input);
  if (rule.revision !== 1) throw new Error('EVENT_RULE_CREATE_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: rule.ruleId,
    schemaVersion: 1,
    value: rule,
    action: 'event_rule_created',
    expectedRevision: null,
  });
}

export function readEventRule(controllerHome: string, ruleId: string): ControlPlaneRecord<EventRuleV1> | undefined {
  const record = readControlPlaneRecord<unknown>(controllerHome, NAMESPACE, SCOPE, ruleId);
  if (!record) return undefined;
  const value = validateEventRuleV1(record.value);
  if (value.ruleId !== record.key || value.ruleId !== ruleId) throw new Error('EVENT_RULE_KEY_MISMATCH');
  return { ...record, value };
}

export function listEventRules(controllerHome: string, limit = 256): ControlPlaneRecord<EventRuleV1>[] {
  return listControlPlaneRecords<unknown>(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    limit: Math.max(1, Math.min(Math.trunc(limit), MAX_EVALUATED_EVENT_RULES + 1)),
  }).map((record) => {
    const value = validateEventRuleV1(record.value);
    if (value.ruleId !== record.key) throw new Error('EVENT_RULE_KEY_MISMATCH');
    return { ...record, value };
  });
}

export function updateEventRule(
  controllerHome: string,
  ruleId: string,
  expectedRecordRevision: number,
  mutate: (current: EventRuleV1) => EventRuleV1,
): ControlPlaneRecord<EventRuleV1> {
  const current = readEventRule(controllerHome, ruleId);
  if (!current) throw new Error('EVENT_RULE_NOT_FOUND: ' + ruleId);
  if (current.revision !== expectedRecordRevision) throw new Error('EVENT_RULE_REVISION_CONFLICT');
  const next = validateEventRuleV1(mutate(structuredClone(current.value)));
  if (next.ruleId !== ruleId) throw new Error('EVENT_RULE_ID_IMMUTABLE');
  if (next.revision !== current.value.revision + 1) throw new Error('EVENT_RULE_LOGICAL_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: ruleId,
    schemaVersion: 1,
    value: next,
    action: 'event_rule_updated',
    expectedRevision: current.revision,
  });
}

export interface EventRuleMatch {
  ruleId: string;
  recordRevision: number;
  evaluation: Extract<EventRuleEvaluationResult, { matched: true }>;
}

/** Evaluate persisted rules only. This performs no action dispatch. */
export function evaluatePersistedEventRules(
  controllerHome: string,
  envelope: EventEnvelopeV1,
  context: EventRuleEvaluationContext,
): EventRuleMatch[] {
  // Fetch one beyond the execution cap. A truncated subset could silently
  // skip a matching rule, so refuse evaluation rather than act on partial policy.
  const records = listEventRules(controllerHome, MAX_EVALUATED_EVENT_RULES + 1);
  if (records.length > MAX_EVALUATED_EVENT_RULES) throw new Error('EVENT_RULE_EVALUATION_CAPACITY_EXCEEDED');
  const matches: EventRuleMatch[] = [];
  for (const record of records) {
    const evaluation = evaluateEventRule(record.value, envelope, context);
    if (!evaluation.matched || evaluation.actions.length === 0) continue;
    matches.push({ ruleId: record.value.ruleId, recordRevision: record.revision, evaluation });
  }
  return matches.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}
