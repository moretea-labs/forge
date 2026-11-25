import type { EventEnvelopeV1 } from './event-envelope';

export type EventRuleScalar = null | string | number | boolean;
export type EventRuleJson = EventRuleScalar | EventRuleJson[] | { [key: string]: EventRuleJson };

export type EventRuleCondition =
  | {
      kind: 'fact';
      key: string;
      operator:
        | 'exists'
        | 'equals'
        | 'not_equals'
        | 'contains'
        | 'starts_with'
        | 'ends_with'
        | 'in'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte';
      value?: EventRuleScalar | EventRuleScalar[];
    }
  | { kind: 'all' | 'any'; conditions: EventRuleCondition[] }
  | { kind: 'not'; condition: EventRuleCondition };

export type EventRuleInputBinding =
  | { kind: 'literal'; value: EventRuleJson }
  | {
      kind: 'event';
      path:
        | 'eventId'
        | 'source'
        | 'provider'
        | 'eventType'
        | 'occurredAt'
        | 'receivedAt'
        | 'scope.kind'
        | 'scope.id'
        | 'subject.kind'
        | 'subject.id'
        | 'correlationId'
        | 'causationId';
    }
  | { kind: 'fact'; key: string };

export interface EventRuleActionCallV1 {
  actionRef: string;
  inputs?: Record<string, EventRuleInputBinding>;
}

export interface EventRuleRouteV1 {
  routeId: string;
  when?: EventRuleCondition;
  action: EventRuleActionCallV1;
}

export interface EventRuleV1 {
  schemaVersion: 1;
  ruleId: string;
  revision: number;
  enabled: boolean;
  trigger: {
    sources: string[];
    providers?: string[];
    eventTypes?: string[];
    scopeKinds?: string[];
  };
  condition?: EventRuleCondition;
  routing: 'all_matching' | 'first_matching';
  routes: EventRuleRouteV1[];
  failure: {
    onConditionError: 'hold' | 'skip';
    onRouteError: 'hold' | 'quarantine';
  };
}

export interface EventRuleEvaluationContext {
  facts: Record<string, EventRuleScalar>;
}

export interface EventRuleResolvedAction {
  routeId: string;
  actionRef: string;
  inputs: Record<string, EventRuleJson>;
}

export type EventRuleEvaluationResult =
  | { matched: false; reason: 'disabled' | 'source' | 'provider' | 'event_type' | 'scope_kind' | 'condition' }
  | { matched: true; ruleId: string; revision: number; actions: EventRuleResolvedAction[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FACT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const EVENT_PATHS = new Set([
  'eventId',
  'source',
  'provider',
  'eventType',
  'occurredAt',
  'receivedAt',
  'scope.kind',
  'scope.id',
  'subject.kind',
  'subject.id',
  'correlationId',
  'causationId',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(code);
}
function strings(value: unknown, required: boolean, code: string): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || !ID.test(item)) ||
    new Set(value).size !== value.length
  )
    throw new Error(code);
  return [...value] as string[];
}
function assertJson(value: unknown, depth = 0): asserts value is EventRuleJson {
  if (depth > 16) throw new Error('EVENT_RULE_JSON_DEPTH_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (!record(value)) throw new Error('EVENT_RULE_JSON_INVALID');
  for (const [key, entry] of Object.entries(value)) {
    if (!ID.test(key)) throw new Error('EVENT_RULE_JSON_KEY_INVALID');
    assertJson(entry, depth + 1);
  }
}

function validateConditionGroup(value: Record<string, unknown>, depth: number): EventRuleCondition {
  exact(value, ['kind', 'conditions'], 'EVENT_RULE_CONDITION_FIELD_UNSUPPORTED');
  if (!Array.isArray(value.conditions) || value.conditions.length < 1 || value.conditions.length > 32)
    throw new Error('EVENT_RULE_CONDITION_GROUP_INVALID');
  return {
    kind: value.kind as 'all' | 'any',
    conditions: value.conditions.map((item) => validateCondition(item, depth + 1)),
  };
}

function validateFactCondition(value: Record<string, unknown>): EventRuleCondition {
  exact(value, ['kind', 'key', 'operator', 'value'], 'EVENT_RULE_CONDITION_FIELD_UNSUPPORTED');
  if (typeof value.key !== 'string' || !FACT.test(value.key)) throw new Error('EVENT_RULE_FACT_KEY_INVALID');
  const operator = String(value.operator);
  if (
    ![
      'exists',
      'equals',
      'not_equals',
      'contains',
      'starts_with',
      'ends_with',
      'in',
      'gt',
      'gte',
      'lt',
      'lte',
    ].includes(operator)
  )
    throw new Error('EVENT_RULE_OPERATOR_INVALID');
  if (operator === 'exists') {
    if (value.value !== undefined) throw new Error('EVENT_RULE_EXISTS_VALUE_UNSUPPORTED');
    return { kind: 'fact', key: value.key, operator: 'exists' };
  }
  if (operator === 'in') {
    const inputValue = value.value;
    if (!Array.isArray(inputValue) || inputValue.length < 1 || inputValue.length > 64)
      throw new Error('EVENT_RULE_IN_VALUE_INVALID');
    for (const item of inputValue) assertJson(item);
    if (inputValue.some((item) => item !== null && !['string', 'number', 'boolean'].includes(typeof item)))
      throw new Error('EVENT_RULE_IN_VALUE_INVALID');
    return { kind: 'fact', key: value.key, operator: 'in', value: [...inputValue] as EventRuleScalar[] };
  }
  const inputValue = value.value;
  if (
    inputValue === undefined ||
    Array.isArray(inputValue) ||
    (inputValue !== null && !['string', 'number', 'boolean'].includes(typeof inputValue))
  )
    throw new Error('EVENT_RULE_CONDITION_VALUE_INVALID');
  return {
    kind: 'fact',
    key: value.key,
    operator: operator as Extract<EventRuleCondition, { kind: 'fact' }>['operator'],
    value: inputValue as EventRuleScalar,
  };
}

function validateCondition(value: unknown, depth = 0): EventRuleCondition {
  if (depth > 12 || !record(value) || typeof value.kind !== 'string') throw new Error('EVENT_RULE_CONDITION_INVALID');
  if (value.kind === 'all' || value.kind === 'any') return validateConditionGroup(value, depth);
  if (value.kind === 'not') {
    exact(value, ['kind', 'condition'], 'EVENT_RULE_CONDITION_FIELD_UNSUPPORTED');
    return { kind: 'not', condition: validateCondition(value.condition, depth + 1) };
  }
  if (value.kind !== 'fact') throw new Error('EVENT_RULE_CONDITION_KIND_INVALID');
  return validateFactCondition(value);
}

function validateBinding(value: unknown): EventRuleInputBinding {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('EVENT_RULE_BINDING_INVALID');
  if (value.kind === 'literal') {
    exact(value, ['kind', 'value'], 'EVENT_RULE_BINDING_FIELD_UNSUPPORTED');
    assertJson(value.value);
    return { kind: 'literal', value: structuredClone(value.value) };
  }
  if (value.kind === 'event') {
    exact(value, ['kind', 'path'], 'EVENT_RULE_BINDING_FIELD_UNSUPPORTED');
    if (typeof value.path !== 'string' || !EVENT_PATHS.has(value.path))
      throw new Error('EVENT_RULE_EVENT_PATH_INVALID');
    return { kind: 'event', path: value.path as Extract<EventRuleInputBinding, { kind: 'event' }>['path'] };
  }
  if (value.kind === 'fact') {
    exact(value, ['kind', 'key'], 'EVENT_RULE_BINDING_FIELD_UNSUPPORTED');
    if (typeof value.key !== 'string' || !FACT.test(value.key)) throw new Error('EVENT_RULE_FACT_KEY_INVALID');
    return { kind: 'fact', key: value.key };
  }
  throw new Error('EVENT_RULE_BINDING_KIND_INVALID');
}

function validateTrigger(value: unknown): EventRuleV1['trigger'] {
  if (!record(value)) throw new Error('EVENT_RULE_TRIGGER_INVALID');
  exact(value, ['sources', 'providers', 'eventTypes', 'scopeKinds'], 'EVENT_RULE_TRIGGER_FIELD_UNSUPPORTED');
  const sources = strings(value.sources, true, 'EVENT_RULE_SOURCES_INVALID')!;
  const providers = strings(value.providers, false, 'EVENT_RULE_PROVIDERS_INVALID');
  const eventTypes = strings(value.eventTypes, false, 'EVENT_RULE_EVENT_TYPES_INVALID');
  const scopeKinds = strings(value.scopeKinds, false, 'EVENT_RULE_SCOPE_KINDS_INVALID');
  return {
    sources,
    ...(providers ? { providers } : {}),
    ...(eventTypes ? { eventTypes } : {}),
    ...(scopeKinds ? { scopeKinds } : {}),
  };
}

function validateRoute(raw: unknown, routeIds: Set<string>): EventRuleRouteV1 {
  if (!record(raw)) throw new Error('EVENT_RULE_ROUTE_INVALID');
  exact(raw, ['routeId', 'when', 'action'], 'EVENT_RULE_ROUTE_FIELD_UNSUPPORTED');
  if (typeof raw.routeId !== 'string' || !ID.test(raw.routeId) || routeIds.has(raw.routeId))
    throw new Error('EVENT_RULE_ROUTE_ID_INVALID');
  routeIds.add(raw.routeId);
  if (!record(raw.action)) throw new Error('EVENT_RULE_ACTION_INVALID');
  exact(raw.action, ['actionRef', 'inputs'], 'EVENT_RULE_ACTION_FIELD_UNSUPPORTED');
  if (typeof raw.action.actionRef !== 'string' || !ID.test(raw.action.actionRef))
    throw new Error('EVENT_RULE_ACTION_REF_INVALID');
  let inputs: Record<string, EventRuleInputBinding> | undefined;
  if (raw.action.inputs !== undefined) {
    if (!record(raw.action.inputs) || Object.keys(raw.action.inputs).length > 64)
      throw new Error('EVENT_RULE_ACTION_INPUTS_INVALID');
    inputs = Object.fromEntries(
      Object.entries(raw.action.inputs).map(([key, binding]) => {
        if (!ID.test(key)) throw new Error('EVENT_RULE_ACTION_INPUT_KEY_INVALID');
        return [key, validateBinding(binding)];
      }),
    );
  }
  return {
    routeId: raw.routeId,
    ...(raw.when === undefined ? {} : { when: validateCondition(raw.when) }),
    action: { actionRef: raw.action.actionRef, ...(inputs ? { inputs } : {}) },
  };
}

function validateFailure(value: unknown): EventRuleV1['failure'] {
  if (!record(value)) throw new Error('EVENT_RULE_FAILURE_INVALID');
  exact(value, ['onConditionError', 'onRouteError'], 'EVENT_RULE_FAILURE_FIELD_UNSUPPORTED');
  if (value.onConditionError !== 'hold' && value.onConditionError !== 'skip')
    throw new Error('EVENT_RULE_CONDITION_FAILURE_INVALID');
  if (value.onRouteError !== 'hold' && value.onRouteError !== 'quarantine')
    throw new Error('EVENT_RULE_ROUTE_FAILURE_INVALID');
  return { onConditionError: value.onConditionError, onRouteError: value.onRouteError };
}

export function validateEventRuleV1(value: unknown): EventRuleV1 {
  if (!record(value)) throw new Error('EVENT_RULE_INVALID');
  exact(
    value,
    ['schemaVersion', 'ruleId', 'revision', 'enabled', 'trigger', 'condition', 'routing', 'routes', 'failure'],
    'EVENT_RULE_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== 1) throw new Error('EVENT_RULE_SCHEMA_VERSION_UNSUPPORTED');
  if (typeof value.ruleId !== 'string' || !ID.test(value.ruleId)) throw new Error('EVENT_RULE_ID_INVALID');
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error('EVENT_RULE_REVISION_INVALID');
  if (typeof value.enabled !== 'boolean') throw new Error('EVENT_RULE_ENABLED_INVALID');
  if (value.routing !== 'all_matching' && value.routing !== 'first_matching')
    throw new Error('EVENT_RULE_ROUTING_INVALID');
  if (!Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > 64)
    throw new Error('EVENT_RULE_ROUTES_INVALID');
  const routeIds = new Set<string>();
  return {
    schemaVersion: 1,
    ruleId: value.ruleId,
    revision: Number(value.revision),
    enabled: value.enabled,
    trigger: validateTrigger(value.trigger),
    ...(value.condition === undefined ? {} : { condition: validateCondition(value.condition) }),
    routing: value.routing,
    routes: value.routes.map((route) => validateRoute(route, routeIds)),
    failure: validateFailure(value.failure),
  };
}

function factCondition(
  condition: Extract<EventRuleCondition, { kind: 'fact' }>,
  facts: Record<string, EventRuleScalar>,
): boolean {
  const exists = Object.hasOwn(facts, condition.key);
  if (condition.operator === 'exists') return exists;
  if (!exists) return false;
  const actual = facts[condition.key];
  const expected = condition.value;
  switch (condition.operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'starts_with':
      return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected);
    case 'ends_with':
      return typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected);
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    default:
      return false;
  }
}
export function evaluateEventRuleCondition(
  condition: EventRuleCondition,
  facts: Record<string, EventRuleScalar>,
): boolean {
  if (condition.kind === 'fact') return factCondition(condition, facts);
  if (condition.kind === 'not') return !evaluateEventRuleCondition(condition.condition, facts);
  if (condition.kind === 'all') return condition.conditions.every((item) => evaluateEventRuleCondition(item, facts));
  return condition.conditions.some((item) => evaluateEventRuleCondition(item, facts));
}
function eventPath(
  envelope: EventEnvelopeV1,
  path: Extract<EventRuleInputBinding, { kind: 'event' }>['path'],
): EventRuleJson {
  switch (path) {
    case 'eventId':
      return envelope.eventId;
    case 'source':
      return envelope.source;
    case 'provider':
      return envelope.provider;
    case 'eventType':
      return envelope.eventType;
    case 'occurredAt':
      return envelope.occurredAt;
    case 'receivedAt':
      return envelope.receivedAt;
    case 'scope.kind':
      return envelope.scope.kind;
    case 'scope.id':
      return envelope.scope.id;
    case 'subject.kind':
      return envelope.subject.kind;
    case 'subject.id':
      return envelope.subject.id;
    case 'correlationId':
      return envelope.correlationId ?? null;
    case 'causationId':
      return envelope.causationId ?? null;
  }
}
function resolveBinding(
  binding: EventRuleInputBinding,
  envelope: EventEnvelopeV1,
  facts: Record<string, EventRuleScalar>,
): EventRuleJson {
  if (binding.kind === 'literal') return structuredClone(binding.value);
  if (binding.kind === 'event') return eventPath(envelope, binding.path);
  return Object.hasOwn(facts, binding.key) ? facts[binding.key]! : null;
}
export function evaluateEventRule(
  input: EventRuleV1,
  envelope: EventEnvelopeV1,
  context: EventRuleEvaluationContext,
): EventRuleEvaluationResult {
  const rule = validateEventRuleV1(input);
  if (!rule.enabled) return { matched: false, reason: 'disabled' };
  if (!rule.trigger.sources.includes(envelope.source)) return { matched: false, reason: 'source' };
  if (rule.trigger.providers && !rule.trigger.providers.includes(envelope.provider))
    return { matched: false, reason: 'provider' };
  if (rule.trigger.eventTypes && !rule.trigger.eventTypes.includes(envelope.eventType))
    return { matched: false, reason: 'event_type' };
  if (rule.trigger.scopeKinds && !rule.trigger.scopeKinds.includes(envelope.scope.kind))
    return { matched: false, reason: 'scope_kind' };
  if (rule.condition && !evaluateEventRuleCondition(rule.condition, context.facts))
    return { matched: false, reason: 'condition' };
  const actions: EventRuleResolvedAction[] = [];
  for (const route of rule.routes) {
    if (route.when && !evaluateEventRuleCondition(route.when, context.facts)) continue;
    actions.push({
      routeId: route.routeId,
      actionRef: route.action.actionRef,
      inputs: Object.fromEntries(
        Object.entries(route.action.inputs ?? {}).map(([key, binding]) => [
          key,
          resolveBinding(binding, envelope, context.facts),
        ]),
      ),
    });
    if (rule.routing === 'first_matching') break;
  }
  return { matched: true, ruleId: rule.ruleId, revision: rule.revision, actions };
}
