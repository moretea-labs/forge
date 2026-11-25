import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { normalizeAgentMailWatchEvent } from '../../src/runtime/events/adapters/agentmail-watch';

const event = {
  source: 'mail.watch.matched' as const,
  event_id: 'rule-1:account-1:message-1',
  observed_at: '2026-11-25T10:00:00.000Z',
  ref: {
    provider: 'agentmail' as const,
    account_id: '22222222-2222-4222-8222-222222222222',
    provider_message_id: 'provider-message-1',
  },
  summary: {
    rule_id: '11111111-1111-4111-8111-111111111111',
    sender_email: 'sender@example.com',
  },
};

describe('AgentMail Watch Event Source Adapter', () => {
  test('normalizes a durable Watch observation into a stable, scoped Event Envelope', () => {
    const envelope = normalizeAgentMailWatchEvent(event, { receivedAt: event.observed_at });
    const eventKey = createHash('sha256').update(event.event_id).digest('hex');
    const eventReference = Buffer.from(event.event_id, 'utf8').toString('base64url');
    const payload = JSON.stringify(event);

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      eventId: event.event_id,
      source: 'agentmail.watch',
      provider: 'agentmail',
      eventType: 'mail.watch.matched',
      occurredAt: event.observed_at,
      receivedAt: event.observed_at,
      scope: { kind: 'account', id: event.ref.account_id },
      subject: { kind: 'mail.message', id: event.ref.provider_message_id },
      idempotencyKey: eventKey,
      payloadRef: {
        store: 'provider',
        key: `agentmail://watch-events/${eventReference}`,
        mediaType: 'application/json',
        schemaVersion: 1,
        digest: {
          algorithm: 'sha256',
          value: createHash('sha256').update(payload).digest('hex'),
          bytes: Buffer.byteLength(payload, 'utf8'),
        },
      },
    });
    expect(envelope).not.toHaveProperty('payload');
    expect(envelope).not.toHaveProperty('body');
  });

  test('produces the same identity and payload reference for a replay of the same source observation', () => {
    const first = normalizeAgentMailWatchEvent(event, { receivedAt: event.observed_at });
    const replay = normalizeAgentMailWatchEvent(event, { receivedAt: event.observed_at });
    expect(replay).toEqual(first);
  });

  test('rejects unsupported source fields and identity mismatches instead of silently widening metadata', () => {
    expect(() =>
      normalizeAgentMailWatchEvent(
        {
          ...event,
          body: 'private email body',
        } as typeof event,
        { receivedAt: event.observed_at },
      ),
    ).toThrow('AGENTMAIL_WATCH_EVENT_FIELD_UNSUPPORTED');
    expect(() =>
      normalizeAgentMailWatchEvent(
        {
          ...event,
          ref: { ...event.ref, provider: 'other' as 'agentmail' },
        },
        { receivedAt: event.observed_at },
      ),
    ).toThrow('AGENTMAIL_WATCH_EVENT_IDENTITY_INVALID');
  });
});
