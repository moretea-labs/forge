import { createHash } from 'crypto';
import { createEventEnvelope, type EventSourceAdapter, type EventEnvelopeV1 } from '../../../../packages/kernel/events';

export interface AgentMailWatchEventObservation {
  source: 'mail.watch.matched';
  event_id: string;
  observed_at: string;
  ref: {
    provider: 'agentmail';
    account_id: string;
    provider_message_id: string;
  };
  summary: {
    rule_id: string;
    sender_email: string;
  };
}

const descriptor = Object.freeze({
  source: 'agentmail.watch',
  provider: 'agentmail',
  eventTypes: Object.freeze(['mail.watch.matched']),
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: object, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(code);
}

function canonicalPayload(observation: AgentMailWatchEventObservation): string {
  return JSON.stringify({
    source: observation.source,
    event_id: observation.event_id,
    observed_at: observation.observed_at,
    ref: {
      provider: observation.ref.provider,
      account_id: observation.ref.account_id,
      provider_message_id: observation.ref.provider_message_id,
    },
    summary: {
      rule_id: observation.summary.rule_id,
      sender_email: observation.summary.sender_email,
    },
  });
}

export const agentMailWatchEventAdapter: EventSourceAdapter<AgentMailWatchEventObservation> = {
  descriptor,
  normalize(observation, context): readonly EventEnvelopeV1[] {
    if (!isRecord(observation)) throw new Error('AGENTMAIL_WATCH_EVENT_INVALID');
    exactKeys(
      observation,
      ['source', 'event_id', 'observed_at', 'ref', 'summary'],
      'AGENTMAIL_WATCH_EVENT_FIELD_UNSUPPORTED',
    );
    if (observation.source !== 'mail.watch.matched') throw new Error('AGENTMAIL_WATCH_EVENT_SOURCE_INVALID');
    if (!isRecord(observation.ref)) throw new Error('AGENTMAIL_WATCH_EVENT_REF_INVALID');
    exactKeys(
      observation.ref,
      ['provider', 'account_id', 'provider_message_id'],
      'AGENTMAIL_WATCH_EVENT_REF_FIELD_UNSUPPORTED',
    );
    if (!isRecord(observation.summary)) throw new Error('AGENTMAIL_WATCH_EVENT_SUMMARY_INVALID');
    exactKeys(observation.summary, ['rule_id', 'sender_email'], 'AGENTMAIL_WATCH_EVENT_SUMMARY_FIELD_UNSUPPORTED');

    const event = observation as unknown as AgentMailWatchEventObservation;
    if (event.ref.provider !== 'agentmail' || !uuid.test(event.ref.account_id) || !uuid.test(event.summary.rule_id)) {
      throw new Error('AGENTMAIL_WATCH_EVENT_IDENTITY_INVALID');
    }
    if (typeof event.ref.provider_message_id !== 'string' || event.ref.provider_message_id.length === 0) {
      throw new Error('AGENTMAIL_WATCH_EVENT_MESSAGE_INVALID');
    }
    if (typeof event.summary.sender_email !== 'string' || event.summary.sender_email.length > 320) {
      throw new Error('AGENTMAIL_WATCH_EVENT_SENDER_INVALID');
    }

    const payload = canonicalPayload(event);
    const eventKey = createHash('sha256').update(event.event_id).digest('hex');
    const eventReference = Buffer.from(event.event_id, 'utf8').toString('base64url');
    const payloadDigest = createHash('sha256').update(payload).digest('hex');

    return [
      createEventEnvelope({
        eventId: event.event_id,
        source: descriptor.source,
        provider: descriptor.provider,
        eventType: event.source,
        occurredAt: event.observed_at,
        receivedAt: context.receivedAt,
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
            value: payloadDigest,
            bytes: Buffer.byteLength(payload, 'utf8'),
          },
        },
      }),
    ];
  },
};

export function normalizeAgentMailWatchEvent(
  observation: AgentMailWatchEventObservation,
  context: { readonly receivedAt: string },
): EventEnvelopeV1 {
  const envelopes = agentMailWatchEventAdapter.normalize(observation, context);
  if (envelopes.length !== 1) throw new Error('AGENTMAIL_WATCH_EVENT_ENVELOPE_COUNT_INVALID');
  return envelopes[0]!;
}
