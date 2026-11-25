import { describe, expect, test } from 'bun:test';
import {
  createEventEnvelope,
  matchEventPolicy,
  validateEventPolicyModelDecision,
  validateEventPolicyV1,
} from '../../packages/kernel/events';
const event = createEventEnvelope({
  eventId: 'mail:account-1:message-42',
  source: 'agentmail.watch',
  provider: 'agentmail',
  eventType: 'mail.watch.matched',
  occurredAt: '2026-11-25T10:00:00.000Z',
  receivedAt: '2026-11-25T10:00:03.000Z',
  scope: { kind: 'account', id: 'account-1' },
  subject: { kind: 'mail.message', id: 'message-42' },
  idempotencyKey: 'mail-event-42',
  payloadRef: {
    store: 'provider',
    key: 'agentmail://event/42',
    mediaType: 'application/json',
    schemaVersion: 1,
    digest: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 100 },
  },
});
const policy = {
  schemaVersion: 1 as const,
  policyId: 'mail-triage',
  revision: 3,
  enabled: true,
  match: {
    sources: ['agentmail.watch'],
    providers: ['agentmail'],
    eventTypes: ['mail.watch.matched'],
    scopeKinds: ['account'],
  },
  decision: {
    mode: 'model' as const,
    modelProfileId: 'fast-classifier',
    minimumConfidence: 0.8,
    instructionTemplateId: 'mail-triage-v1',
  },
  allowedActions: [
    { actionId: 'mail.label', permission: 'workspace_write' as const, requiresApproval: false },
    { actionId: 'mail.send_reply', permission: 'external_write' as const, requiresApproval: true },
  ],
  budget: { timeoutMs: 5000, maxInputBytes: 32000, maxOutputTokens: 256 },
  failure: { onTimeout: 'hold' as const, onInvalidDecision: 'quarantine' as const },
};
describe('Event Policy v1', () => {
  test('validates a versioned policy and reusable profile reference', () => {
    expect(validateEventPolicyV1(policy)).toEqual(policy);
  });
  test('matches source/provider/type/scope deterministically', () => {
    expect(matchEventPolicy(policy, event)).toEqual({ matched: true, policyId: 'mail-triage', revision: 3 });
    expect(matchEventPolicy({ ...policy, enabled: false }, event)).toEqual({ matched: false, reason: 'disabled' });
    expect(matchEventPolicy({ ...policy, match: { ...policy.match, sources: ['github.issue_watch'] } }, event)).toEqual(
      { matched: false, reason: 'source' },
    );
    expect(matchEventPolicy({ ...policy, match: { ...policy.match, providers: ['github'] } }, event)).toEqual({
      matched: false,
      reason: 'provider',
    });
    expect(
      matchEventPolicy({ ...policy, match: { ...policy.match, eventTypes: ['github.issue.open_changed'] } }, event),
    ).toEqual({ matched: false, reason: 'event_type' });
    expect(matchEventPolicy({ ...policy, match: { ...policy.match, scopeKinds: ['repository'] } }, event)).toEqual({
      matched: false,
      reason: 'scope_kind',
    });
  });
  test('accepts only explicitly allowed actions', () => {
    const decision = validateEventPolicyModelDecision(policy, event, {
      schemaVersion: 1,
      eventId: event.eventId,
      outcome: 'act',
      actionId: 'mail.label',
      confidence: 0.91,
      rationale: 'Matches configured triage intent.',
      evidenceRefs: ['provider://event/42'],
    });
    expect(decision.actionId).toBe('mail.label');
    expect(() =>
      validateEventPolicyModelDecision(policy, event, {
        schemaVersion: 1,
        eventId: event.eventId,
        outcome: 'act',
        actionId: 'shell.exec',
        confidence: 0.99,
        rationale: 'arbitrary execution',
        evidenceRefs: [],
      }),
    ).toThrow('EVENT_POLICY_MODEL_ACTION_NOT_ALLOWED');
  });
  test('rejects model attempts to widen target, permission or arguments', () => {
    expect(() =>
      validateEventPolicyModelDecision(policy, event, {
        schemaVersion: 1,
        eventId: event.eventId,
        outcome: 'act',
        actionId: 'mail.label',
        confidence: 0.99,
        rationale: 'label',
        evidenceRefs: [],
        target: { id: '*' },
        permission: 'admin',
        arguments: { all: true },
      }),
    ).toThrow('EVENT_POLICY_MODEL_DECISION_FIELD_UNSUPPORTED');
  });
  test('holds low confidence and rejects event identity mismatch', () => {
    expect(() =>
      validateEventPolicyModelDecision(policy, event, {
        schemaVersion: 1,
        eventId: event.eventId,
        outcome: 'act',
        actionId: 'mail.label',
        confidence: 0.4,
        rationale: 'uncertain',
        evidenceRefs: [],
      }),
    ).toThrow('EVENT_POLICY_MODEL_CONFIDENCE_BELOW_THRESHOLD');
    expect(() =>
      validateEventPolicyModelDecision(policy, event, {
        schemaVersion: 1,
        eventId: 'other',
        outcome: 'ignore',
        confidence: 0.99,
        rationale: 'different event',
        evidenceRefs: [],
      }),
    ).toThrow('EVENT_POLICY_MODEL_EVENT_ID_MISMATCH');
  });
  test('requires model profile and bounds budgets and permissions', () => {
    expect(() => validateEventPolicyV1({ ...policy, decision: { mode: 'model' } })).toThrow(
      'EVENT_POLICY_MODEL_PROFILE_REQUIRED',
    );
    expect(() => validateEventPolicyV1({ ...policy, budget: { ...policy.budget, timeoutMs: 0 } })).toThrow(
      'EVENT_POLICY_BUDGET_RANGE_INVALID:timeoutMs',
    );
    expect(() =>
      validateEventPolicyV1({
        ...policy,
        allowedActions: [{ ...policy.allowedActions[0], permission: 'admin' as never }],
      }),
    ).toThrow('EVENT_POLICY_PERMISSION_INVALID');
    expect(() =>
      validateEventPolicyV1({
        ...policy,
        allowedActions: [{ actionId: 'mail.send_reply', permission: 'external_write', requiresApproval: false }],
      }),
    ).toThrow('EVENT_POLICY_SENSITIVE_ACTION_APPROVAL_REQUIRED');
  });
});
