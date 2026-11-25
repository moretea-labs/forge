import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventEnvelope } from '../../packages/kernel/events';
import type { EventPolicyV1 } from '../../packages/kernel/events';
import {
  createEventPolicy,
  findMatchingEventPolicies,
  listEventPolicies,
  readEventPolicy,
  updateEventPolicy,
} from '../../src/runtime/events/event-policy-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-event-policy-store-'));
  roots.push(value);
  return value;
}
function policy(policyId: string, overrides: Partial<EventPolicyV1> = {}): EventPolicyV1 {
  return {
    schemaVersion: 1,
    policyId,
    revision: 1,
    enabled: true,
    match: { sources: ['agentmail.watch'], providers: ['agentmail'], eventTypes: ['mail.watch.matched'] },
    decision: { mode: 'deterministic' },
    allowedActions: [{ actionId: 'mail.label', permission: 'workspace_write', requiresApproval: false }],
    budget: { timeoutMs: 5000, maxInputBytes: 32000, maxOutputTokens: 256 },
    failure: { onTimeout: 'hold', onInvalidDecision: 'quarantine' },
    ...overrides,
  };
}
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

describe('Event Policy persistence', () => {
  test('creates, reads and lists policies from the shared Control Plane store', () => {
    const controllerHome = home();
    const created = createEventPolicy(controllerHome, policy('mail-triage'));
    expect(created.revision).toBe(1);
    expect(readEventPolicy(controllerHome, 'mail-triage')?.value).toEqual(policy('mail-triage'));
    expect(listEventPolicies(controllerHome).map((record) => record.value.policyId)).toEqual(['mail-triage']);
  });
  test('uses optimistic revisions and immutable policy IDs for updates', () => {
    const controllerHome = home();
    createEventPolicy(controllerHome, policy('mail-triage'));
    const updated = updateEventPolicy(controllerHome, 'mail-triage', 1, (current) => ({
      ...current,
      revision: 2,
      enabled: false,
    }));
    expect(updated.revision).toBe(2);
    expect(updated.value.enabled).toBe(false);
    expect(() => updateEventPolicy(controllerHome, 'mail-triage', 1, (current) => current)).toThrow(
      'EVENT_POLICY_REVISION_CONFLICT',
    );
    expect(() =>
      updateEventPolicy(controllerHome, 'mail-triage', 2, (current) => ({
        ...current,
        revision: 3,
        policyId: 'renamed',
      })),
    ).toThrow('EVENT_POLICY_ID_IMMUTABLE');
  });
  test('selects only enabled policies whose complete selectors match', () => {
    const controllerHome = home();
    createEventPolicy(controllerHome, policy('mail-match'));
    createEventPolicy(controllerHome, policy('mail-disabled', { enabled: false }));
    createEventPolicy(
      controllerHome,
      policy('github-only', { match: { sources: ['github.issue.watch'], providers: ['github'] } }),
    );
    expect(findMatchingEventPolicies(controllerHome, event).map((record) => record.value.policyId)).toEqual([
      'mail-match',
    ]);
  });
  test('fails closed on malformed, missing and revision-invalid policy writes', () => {
    const controllerHome = home();
    expect(() => createEventPolicy(controllerHome, { ...policy('bad'), revision: 2 })).toThrow(
      'EVENT_POLICY_CREATE_REVISION_INVALID',
    );
    expect(() => updateEventPolicy(controllerHome, 'missing', 1, (current) => current)).toThrow(
      'EVENT_POLICY_NOT_FOUND',
    );
    expect(() =>
      createEventPolicy(controllerHome, {
        ...policy('bad'),
        allowedActions: [{ actionId: 'shell.exec', permission: 'admin', requiresApproval: false }],
      }),
    ).toThrow('EVENT_POLICY_PERMISSION_INVALID');
  });
});
