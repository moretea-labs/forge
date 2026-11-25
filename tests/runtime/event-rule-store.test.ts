import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventEnvelope, type EventRuleV1 } from '../../packages/kernel/events';
import {
  createEventRule,
  evaluatePersistedEventRules,
  listEventRules,
  readEventRule,
  updateEventRule,
} from '../../src/runtime/events/event-rule-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-event-rule-store-'));
  roots.push(value);
  return value;
}
function rule(ruleId: string, overrides: Partial<EventRuleV1> = {}): EventRuleV1 {
  return {
    schemaVersion: 1,
    ruleId,
    revision: 1,
    enabled: true,
    trigger: { sources: ['agentmail.watch'], providers: ['agentmail'] },
    condition: { kind: 'fact', key: 'mail.sender_domain', operator: 'equals', value: 'apple.com' },
    routing: 'all_matching',
    routes: [
      {
        routeId: 'notify',
        action: { actionRef: 'notification.owner', inputs: { message: { kind: 'fact', key: 'mail.subject' } } },
      },
    ],
    failure: { onConditionError: 'hold', onRouteError: 'quarantine' },
    ...overrides,
  };
}
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

describe('Event Rule persistence', () => {
  test('creates, reads and lists rule configuration without source-code changes', () => {
    const h = home();
    createEventRule(h, rule('asc-mail'));
    expect(readEventRule(h, 'asc-mail')?.value).toEqual(rule('asc-mail'));
    expect(listEventRules(h).map((x) => x.value.ruleId)).toEqual(['asc-mail']);
  });
  test('updates rules with optimistic record revision and monotonic logical revision', () => {
    const h = home();
    createEventRule(h, rule('asc-mail'));
    const updated = updateEventRule(h, 'asc-mail', 1, (current) => ({
      ...current,
      revision: 2,
      condition: { kind: 'fact', key: 'mail.sender_domain', operator: 'in', value: ['apple.com', 'itunes.com'] },
    }));
    expect(updated.revision).toBe(2);
    expect(updated.value.revision).toBe(2);
    expect(() => updateEventRule(h, 'asc-mail', 1, (current) => current)).toThrow('EVENT_RULE_REVISION_CONFLICT');
  });
  test('keeps rule identity immutable', () => {
    const h = home();
    createEventRule(h, rule('asc-mail'));
    expect(() =>
      updateEventRule(h, 'asc-mail', 1, (current) => ({ ...current, revision: 2, ruleId: 'renamed' })),
    ).toThrow('EVENT_RULE_ID_IMMUTABLE');
  });
  test('evaluates persisted configuration and returns resolved actions without dispatch', () => {
    const h = home();
    createEventRule(h, rule('asc-mail'));
    createEventRule(
      h,
      rule('other', {
        condition: { kind: 'fact', key: 'mail.sender_domain', operator: 'equals', value: 'example.com' },
      }),
    );
    const matches = evaluatePersistedEventRules(h, event, {
      facts: { 'mail.sender_domain': 'apple.com', 'mail.subject': 'App Review approved' },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.evaluation.actions).toEqual([
      { routeId: 'notify', actionRef: 'notification.owner', inputs: { message: 'App Review approved' } },
    ]);
  });
});
