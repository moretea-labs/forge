export const EVENT_ENVELOPE_SCHEMA_VERSION = 1 as const;

export type EventScopeKind = 'global' | 'tenant' | 'account' | 'workspace' | 'repository' | 'device' | 'provider';

export interface EventScopeRef {
  kind: EventScopeKind;
  id: string;
  tenantId?: string;
}

export interface EventSubjectRef {
  kind: string;
  id: string;
}

export interface EventPayloadRef {
  store: 'provider' | 'forge';
  key: string;
  mediaType: string;
  schemaVersion: number;
  digest: {
    algorithm: 'sha256';
    value: string;
    bytes: number;
  };
}

/**
 * Transport-neutral event metadata. The payload is always an opaque, scoped
 * reference; raw provider content must never be embedded in this envelope.
 */
export interface EventEnvelopeV1 {
  schemaVersion: typeof EVENT_ENVELOPE_SCHEMA_VERSION;
  eventId: string;
  source: string;
  provider: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  scope: EventScopeRef;
  subject: EventSubjectRef;
  correlationId?: string;
  causationId?: string;
  idempotencyKey: string;
  payloadRef: EventPayloadRef;
}

export type EventEnvelope = EventEnvelopeV1;
export type EventEnvelopeDraft = Omit<EventEnvelopeV1, 'schemaVersion'>;

const SCOPE_KINDS: readonly EventScopeKind[] = [
  'global',
  'tenant',
  'account',
  'workspace',
  'repository',
  'device',
  'provider',
];
const CANONICAL_NAME = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

type UnknownRecord = Record<string, unknown>;

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function requireText(value: unknown, code: string, maximum: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    fail(code);
  }
}

function requireName(value: unknown, code: string): asserts value is string {
  requireText(value, code, 128);
  if (!CANONICAL_NAME.test(value)) fail(code);
}

function requireTimestamp(value: unknown, code: string): asserts value is string {
  requireText(value, code, 64);
  if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) fail(code);
}

function requirePositiveInteger(value: unknown, code: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(code);
}

export function validateEventEnvelopeV1(value: unknown): EventEnvelopeV1 {
  if (!isRecord(value)) fail('EVENT_ENVELOPE_INVALID');
  exactKeys(
    value,
    [
      'schemaVersion',
      'eventId',
      'source',
      'provider',
      'eventType',
      'occurredAt',
      'receivedAt',
      'scope',
      'subject',
      'correlationId',
      'causationId',
      'idempotencyKey',
      'payloadRef',
    ],
    'EVENT_ENVELOPE_FIELD_UNSUPPORTED',
  );
  if (value.schemaVersion !== EVENT_ENVELOPE_SCHEMA_VERSION) fail('EVENT_ENVELOPE_SCHEMA_VERSION_UNSUPPORTED');

  requireText(value.eventId, 'EVENT_ENVELOPE_EVENT_ID_INVALID', 4096);
  requireName(value.source, 'EVENT_ENVELOPE_SOURCE_INVALID');
  requireName(value.provider, 'EVENT_ENVELOPE_PROVIDER_INVALID');
  requireName(value.eventType, 'EVENT_ENVELOPE_TYPE_INVALID');
  requireTimestamp(value.occurredAt, 'EVENT_ENVELOPE_OCCURRED_AT_INVALID');
  requireTimestamp(value.receivedAt, 'EVENT_ENVELOPE_RECEIVED_AT_INVALID');
  requireText(value.idempotencyKey, 'EVENT_ENVELOPE_IDEMPOTENCY_KEY_INVALID', 512);

  if (!isRecord(value.scope)) fail('EVENT_ENVELOPE_SCOPE_INVALID');
  exactKeys(value.scope, ['kind', 'id', 'tenantId'], 'EVENT_ENVELOPE_SCOPE_FIELD_UNSUPPORTED');
  if (!SCOPE_KINDS.includes(value.scope.kind as EventScopeKind)) fail('EVENT_ENVELOPE_SCOPE_KIND_INVALID');
  requireText(value.scope.id, 'EVENT_ENVELOPE_SCOPE_ID_INVALID', 512);
  if (value.scope.tenantId !== undefined) {
    requireText(value.scope.tenantId, 'EVENT_ENVELOPE_TENANT_ID_INVALID', 512);
  }

  if (!isRecord(value.subject)) fail('EVENT_ENVELOPE_SUBJECT_INVALID');
  exactKeys(value.subject, ['kind', 'id'], 'EVENT_ENVELOPE_SUBJECT_FIELD_UNSUPPORTED');
  requireName(value.subject.kind, 'EVENT_ENVELOPE_SUBJECT_KIND_INVALID');
  requireText(value.subject.id, 'EVENT_ENVELOPE_SUBJECT_ID_INVALID', 1024);

  if (value.correlationId !== undefined) {
    requireText(value.correlationId, 'EVENT_ENVELOPE_CORRELATION_ID_INVALID', 512);
  }
  if (value.causationId !== undefined) {
    requireText(value.causationId, 'EVENT_ENVELOPE_CAUSATION_ID_INVALID', 512);
  }

  if (!isRecord(value.payloadRef)) fail('EVENT_ENVELOPE_PAYLOAD_REF_INVALID');
  exactKeys(
    value.payloadRef,
    ['store', 'key', 'mediaType', 'schemaVersion', 'digest'],
    'EVENT_ENVELOPE_PAYLOAD_REF_FIELD_UNSUPPORTED',
  );
  if (value.payloadRef.store !== 'provider' && value.payloadRef.store !== 'forge') {
    fail('EVENT_ENVELOPE_PAYLOAD_STORE_INVALID');
  }
  requireText(value.payloadRef.key, 'EVENT_ENVELOPE_PAYLOAD_KEY_INVALID', 2048);
  requireText(value.payloadRef.mediaType, 'EVENT_ENVELOPE_PAYLOAD_MEDIA_TYPE_INVALID', 128);
  if (!value.payloadRef.mediaType.includes('/')) fail('EVENT_ENVELOPE_PAYLOAD_MEDIA_TYPE_INVALID');
  requirePositiveInteger(value.payloadRef.schemaVersion, 'EVENT_ENVELOPE_PAYLOAD_SCHEMA_VERSION_INVALID');

  if (!isRecord(value.payloadRef.digest)) fail('EVENT_ENVELOPE_PAYLOAD_DIGEST_INVALID');
  exactKeys(
    value.payloadRef.digest,
    ['algorithm', 'value', 'bytes'],
    'EVENT_ENVELOPE_PAYLOAD_DIGEST_FIELD_UNSUPPORTED',
  );
  if (value.payloadRef.digest.algorithm !== 'sha256') fail('EVENT_ENVELOPE_PAYLOAD_DIGEST_ALGORITHM_INVALID');
  requireText(value.payloadRef.digest.value, 'EVENT_ENVELOPE_PAYLOAD_DIGEST_INVALID', 64);
  if (!SHA256.test(value.payloadRef.digest.value)) fail('EVENT_ENVELOPE_PAYLOAD_DIGEST_INVALID');
  if (!Number.isSafeInteger(value.payloadRef.digest.bytes) || (value.payloadRef.digest.bytes as number) < 0) {
    fail('EVENT_ENVELOPE_PAYLOAD_BYTES_INVALID');
  }

  return value as unknown as EventEnvelopeV1;
}

export function createEventEnvelope(input: EventEnvelopeDraft): EventEnvelopeV1 {
  return validateEventEnvelopeV1({ schemaVersion: EVENT_ENVELOPE_SCHEMA_VERSION, ...input });
}

/**
 * Stable source- and scope-qualified key for delivery deduplication.
 * The source adapter must keep idempotencyKey stable across retries.
 */
export function eventEnvelopeDeduplicationKey(envelope: EventEnvelopeV1): string {
  const valid = validateEventEnvelopeV1(envelope);
  return JSON.stringify([
    valid.source,
    valid.provider,
    valid.scope.kind,
    valid.scope.id,
    valid.scope.tenantId ?? null,
    valid.idempotencyKey,
  ]);
}
