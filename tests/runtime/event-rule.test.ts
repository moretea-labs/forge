import { describe, expect, test } from 'bun:test';
import {
  createEventEnvelope,
  evaluateEventRule,
  validateEventRuleV1,
  type EventRuleV1,
} from '../../packages/kernel/events';

const event = createEventEnvelope({
  eventId: 'mail:1',
  source: 'agentmail.watch',
  provider: 'agentmail',
  eventType: 'mail.watch.matched',
  occurredAt: '2026-11-25T10:00:00.000Z',
  receivedAt: '2026-11-25T10:00:01.000Z',
  scope: { kind: 'account', id: 'a1' },
  subject: { kind: 'mail.message', id: 'm1' },
  idempotencyKey: 'mail-1',
  payloadRef: {
    store: 'provider',
    key: 'agentmail://watch-events/1',
    mediaType: 'application/json',
    schemaVersion: 1,
    digest: { algorithm: 'sha256', value: 'a'.repeat(64), bytes: 10 },
  },
});
const rule: EventRuleV1 = {
  schemaVersion: 1,
  ruleId: 'asc-mail',
  revision: 1,
  enabled: true,
  trigger: { sources: ['agentmail.watch'], providers: ['agentmail'], eventTypes: ['mail.watch.matched'] },
  condition: {
    kind: 'all',
    conditions: [
      { kind: 'fact', key: 'mail.sender_domain', operator: 'equals', value: 'apple.com' },
      { kind: 'fact', key: 'mail.subject', operator: 'contains', value: 'App Review' },
    ],
  },
  routing: 'all_matching',
  routes: [
    {
      routeId: 'notify',
      action: { actionRef: 'notification.owner', inputs: { message: { kind: 'fact', key: 'mail.subject' } } },
    },
    {
      routeId: 'workflow',
      when: { kind: 'fact', key: 'mail.requires_followup', operator: 'equals', value: true },
      action: {
        actionRef: 'workflow.asc-followup',
        inputs: { message_id: { kind: 'event', path: 'subject.id' }, sender: { kind: 'fact', key: 'mail.sender' } },
      },
    },
  ],
  failure: { onConditionError: 'hold', onRouteError: 'quarantine' },
};

describe('Event Rule v1', () => {
  test('represents email trigger, deterministic conditions and arbitrary registered actions as configuration', () => {
    expect(validateEventRuleV1(rule)).toEqual(rule);
  });
  test('evaluates facts and resolves event/fact bindings without model dependency', () => {
    const result = evaluateEventRule(rule, event, {
      facts: {
        'mail.sender_domain': 'apple.com',
        'mail.subject': 'App Review update',
        'mail.requires_followup': true,
        'mail.sender': 'appreview@apple.com',
      },
    });
    expect(result).toEqual({
      matched: true,
      ruleId: 'asc-mail',
      revision: 1,
      actions: [
        { routeId: 'notify', actionRef: 'notification.owner', inputs: { message: 'App Review update' } },
        {
          routeId: 'workflow',
          actionRef: 'workflow.asc-followup',
          inputs: { message_id: 'm1', sender: 'appreview@apple.com' },
        },
      ],
    });
  });
  test('supports first matching routing for simple branching', () => {
    const first = { ...rule, routing: 'first_matching' as const };
    const result = evaluateEventRule(first, event, {
      facts: {
        'mail.sender_domain': 'apple.com',
        'mail.subject': 'App Review update',
        'mail.requires_followup': true,
        'mail.sender': 'x',
      },
    });
    expect(result.matched && result.actions.map((a) => a.routeId)).toEqual(['notify']);
  });
  test('returns condition mismatch without producing actions', () => {
    expect(
      evaluateEventRule(rule, event, {
        facts: { 'mail.sender_domain': 'example.com', 'mail.subject': 'App Review update' },
      }),
    ).toEqual({ matched: false, reason: 'condition' });
  });
  test('rejects unknown operators, arbitrary event paths and duplicate routes', () => {
    expect(() =>
      validateEventRuleV1({
        ...rule,
        condition: { kind: 'fact', key: 'mail.sender', operator: 'regex' as never, value: 'x' },
      }),
    ).toThrow('EVENT_RULE_OPERATOR_INVALID');
    expect(() =>
      validateEventRuleV1({
        ...rule,
        routes: [
          {
            routeId: 'bad',
            action: { actionRef: 'x', inputs: { x: { kind: 'event', path: 'payload.secret' as never } } },
          },
        ],
      }),
    ).toThrow('EVENT_RULE_EVENT_PATH_INVALID');
    expect(() => validateEventRuleV1({ ...rule, routes: [rule.routes[0]!, rule.routes[0]!] })).toThrow(
      'EVENT_RULE_ROUTE_ID_INVALID',
    );
  });
});
