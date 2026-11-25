import { describe, expect, test } from 'bun:test';
import {
  createEventEnvelope,
  eventEnvelopeDeduplicationKey,
  validateEventEnvelopeV1,
} from '../../packages/kernel/events';

const validInput = {
  eventId: 'mail:account-1:message-42:rule-7',
  source: 'agentmail.watch',
  provider: 'agentmail',
  eventType: 'mail.watch.matched',
  occurredAt: '2026-11-25T10:00:00.000Z',
  receivedAt: '2026-11-25T10:00:03.000Z',
  scope: { kind: 'account' as const, id: 'account-1', tenantId: 'workspace-1' },
  subject: { kind: 'mail.message', id: 'message-42' },
  correlationId: 'workflow-correlation-1',
  causationId: 'watch-observation-1',
  idempotencyKey: 'agentmail:account-1:message-42:rule-7',
  payloadRef: {
    store: 'provider' as const,
    key: 'agentmail://account-1/messages/message-42/metadata',
    mediaType: 'application/json',
    schemaVersion: 1,
    digest: {
      algorithm: 'sha256' as const,
      value: 'a'.repeat(64),
      bytes: 384,
    },
  },
};

describe('Event Envelope v1', () => {
  test('creates a versioned transport-neutral envelope with an opaque payload reference', () => {
    const envelope = createEventEnvelope(validInput);

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.source).toBe('agentmail.watch');
    expect(envelope.payloadRef.key).toBe(validInput.payloadRef.key);
    expect(envelope).not.toHaveProperty('payload');
  });

  test('validates existing envelopes without changing their identity', () => {
    const envelope = createEventEnvelope(validInput);
    expect(validateEventEnvelopeV1(envelope)).toEqual(envelope);
  });

  test('rejects unsupported envelope versions and unknown top-level payload fields', () => {
    const envelope = createEventEnvelope(validInput);
    expect(() => validateEventEnvelopeV1({ ...envelope, schemaVersion: 2 })).toThrow(
      'EVENT_ENVELOPE_SCHEMA_VERSION_UNSUPPORTED',
    );
    expect(() => validateEventEnvelopeV1({ ...envelope, body: 'private message body' })).toThrow(
      'EVENT_ENVELOPE_FIELD_UNSUPPORTED',
    );
  });

  test('rejects invalid source names, timestamps, and missing idempotency keys', () => {
    expect(() => createEventEnvelope({ ...validInput, source: 'Agent Mail' })).toThrow('EVENT_ENVELOPE_SOURCE_INVALID');
    expect(() => createEventEnvelope({ ...validInput, receivedAt: 'yesterday' })).toThrow(
      'EVENT_ENVELOPE_RECEIVED_AT_INVALID',
    );
    expect(() => createEventEnvelope({ ...validInput, idempotencyKey: '' })).toThrow(
      'EVENT_ENVELOPE_IDEMPOTENCY_KEY_INVALID',
    );
  });

  test('rejects unknown scope and subject fields instead of widening the envelope silently', () => {
    expect(() =>
      validateEventEnvelopeV1({
        schemaVersion: 1,
        ...validInput,
        scope: { ...validInput.scope, localPath: '/tmp/forge' },
      }),
    ).toThrow('EVENT_ENVELOPE_SCOPE_FIELD_UNSUPPORTED');
    expect(() =>
      validateEventEnvelopeV1({
        schemaVersion: 1,
        ...validInput,
        subject: { ...validInput.subject, arbitraryTarget: 'all' },
      }),
    ).toThrow('EVENT_ENVELOPE_SUBJECT_FIELD_UNSUPPORTED');
  });

  test('rejects malformed payload references and digests', () => {
    expect(() =>
      createEventEnvelope({
        ...validInput,
        payloadRef: { ...validInput.payloadRef, schemaVersion: 0 },
      }),
    ).toThrow('EVENT_ENVELOPE_PAYLOAD_SCHEMA_VERSION_INVALID');
    expect(() =>
      createEventEnvelope({
        ...validInput,
        payloadRef: {
          ...validInput.payloadRef,
          digest: { ...validInput.payloadRef.digest, value: 'not-a-sha256-digest' },
        },
      }),
    ).toThrow('EVENT_ENVELOPE_PAYLOAD_DIGEST_INVALID');
  });

  test('deduplicates within the exact source/provider/scope, not across accounts', () => {
    const envelope = createEventEnvelope(validInput);
    const sameDelivery = createEventEnvelope({
      ...validInput,
      receivedAt: '2026-11-25T10:00:05.000Z',
    });
    const otherAccount = createEventEnvelope({
      ...validInput,
      scope: { kind: 'account', id: 'account-2', tenantId: 'workspace-1' },
    });
    const otherTenant = createEventEnvelope({
      ...validInput,
      scope: { kind: 'account', id: 'account-1', tenantId: 'workspace-2' },
    });

    expect(eventEnvelopeDeduplicationKey(envelope)).toBe(eventEnvelopeDeduplicationKey(sameDelivery));
    expect(eventEnvelopeDeduplicationKey(envelope)).not.toBe(eventEnvelopeDeduplicationKey(otherAccount));
    expect(eventEnvelopeDeduplicationKey(envelope)).not.toBe(eventEnvelopeDeduplicationKey(otherTenant));
  });
});
