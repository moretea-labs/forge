import { describe, expect, test } from 'bun:test';
import { createEventEnvelope, type EventPolicyV1 } from '../../packages/kernel/events';
import { compileEventActionPlan } from '../../src/runtime/events/event-action-plan';

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
function policy(overrides: Partial<EventPolicyV1> = {}): EventPolicyV1 {
  return {
    schemaVersion: 1,
    policyId: 'mail-triage',
    revision: 1,
    enabled: true,
    match: { sources: ['agentmail.watch'], providers: ['agentmail'], eventTypes: ['mail.watch.matched'] },
    decision: { mode: 'model', modelProfileId: 'fast', minimumConfidence: 0.8 },
    allowedActions: [
      { actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false },
      { actionId: 'mail.send_reply', permission: 'external_write', requiresApproval: true },
    ],
    budget: { timeoutMs: 5000, maxInputBytes: 32000, maxOutputTokens: 256 },
    failure: { onTimeout: 'hold', onInvalidDecision: 'quarantine' },
    ...overrides,
  };
}

describe('Event Action Plan', () => {
  test('compiles an allowed model action without granting authorization', () => {
    expect(
      compileEventActionPlan(policy(), event, {
        schemaVersion: 1,
        eventId: event.eventId,
        outcome: 'act',
        actionId: 'mail.label',
        confidence: 0.93,
        rationale: 'Matches triage rule.',
        evidenceRefs: ['provider://event/42'],
      }),
    ).toEqual({
      schemaVersion: 1,
      eventId: event.eventId,
      policyId: 'mail-triage',
      policyRevision: 1,
      decisionMode: 'model',
      disposition: 'eligible_for_dispatch',
      action: { actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false },
      decision: { outcome: 'act', confidence: 0.93, evidenceRefs: ['provider://event/42'] },
      authorizationState: 'not_authorized',
      execution: 'not_executed',
    });
  });

  test('forces external writes to stop at approval_required', () => {
    const plan = compileEventActionPlan(policy(), event, {
      schemaVersion: 1,
      eventId: event.eventId,
      outcome: 'act',
      actionId: 'mail.send_reply',
      confidence: 0.96,
      rationale: 'Reply is appropriate.',
      evidenceRefs: [],
    });
    expect(plan).toMatchObject({
      disposition: 'approval_required',
      action: { actionId: 'mail.send_reply', permission: 'external_write', requiresApproval: true },
      authorizationState: 'not_authorized',
      execution: 'not_executed',
    });
  });

  test('keeps ignore and needs_review outcomes non-executable', () => {
    expect(
      compileEventActionPlan(policy(), event, {
        schemaVersion: 1,
        eventId: event.eventId,
        outcome: 'ignore',
        confidence: 0.95,
        rationale: 'No action.',
        evidenceRefs: [],
      }).disposition,
    ).toBe('no_action');
    expect(
      compileEventActionPlan(policy(), event, {
        schemaVersion: 1,
        eventId: event.eventId,
        outcome: 'needs_review',
        confidence: 0.6,
        rationale: 'Ambiguous.',
        evidenceRefs: [],
      }).disposition,
    ).toBe('review_required');
  });

  test('supports deterministic zero/one-action policies and rejects ambiguous multi-action policies', () => {
    expect(
      compileEventActionPlan(policy({ decision: { mode: 'deterministic' }, allowedActions: [] }), event).disposition,
    ).toBe('no_action');
    expect(
      compileEventActionPlan(
        policy({
          decision: { mode: 'deterministic' },
          allowedActions: [{ actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false }],
        }),
        event,
      ).disposition,
    ).toBe('eligible_for_dispatch');
    expect(() => compileEventActionPlan(policy({ decision: { mode: 'deterministic' } }), event)).toThrow(
      'EVENT_POLICY_DETERMINISTIC_ACTION_AMBIGUOUS',
    );
  });

  test('rejects missing model decisions and policies that do not match the event', () => {
    expect(() => compileEventActionPlan(policy(), event)).toThrow('EVENT_ACTION_PLAN_MODEL_DECISION_REQUIRED');
    expect(() =>
      compileEventActionPlan(policy({ match: { sources: ['github.issue.watch'] } }), event, {
        schemaVersion: 1,
        eventId: event.eventId,
        outcome: 'ignore',
        confidence: 1,
        rationale: 'irrelevant',
        evidenceRefs: [],
      }),
    ).toThrow('EVENT_POLICY_NOT_MATCHED');
  });
});
