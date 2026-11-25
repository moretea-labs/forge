import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import {
  matchEventPolicy,
  validateEventPolicyV1,
  type EventEnvelopeV1,
  type EventPolicyV1,
} from '../../../packages/kernel/events';

const NAMESPACE = 'event_policy';
const SCOPE = 'global';

export function createEventPolicy(controllerHome: string, input: unknown): ControlPlaneRecord<EventPolicyV1> {
  const policy = validateEventPolicyV1(input);
  if (policy.revision !== 1) throw new Error('EVENT_POLICY_CREATE_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: policy.policyId,
    schemaVersion: 1,
    value: policy,
    action: 'event_policy_created',
    expectedRevision: null,
  });
}

export function readEventPolicy(
  controllerHome: string,
  policyId: string,
): ControlPlaneRecord<EventPolicyV1> | undefined {
  const record = readControlPlaneRecord<unknown>(controllerHome, NAMESPACE, SCOPE, policyId);
  if (!record) return undefined;
  const value = validateEventPolicyV1(record.value);
  if (value.policyId !== record.key || value.policyId !== policyId) throw new Error('EVENT_POLICY_KEY_MISMATCH');
  return { ...record, value };
}

export function listEventPolicies(controllerHome: string, limit = 256): ControlPlaneRecord<EventPolicyV1>[] {
  return listControlPlaneRecords<unknown>(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    limit: Math.max(1, Math.min(Math.trunc(limit), 1_000)),
  }).map((record) => {
    const value = validateEventPolicyV1(record.value);
    if (value.policyId !== record.key) throw new Error('EVENT_POLICY_KEY_MISMATCH');
    return { ...record, value };
  });
}

export function updateEventPolicy(
  controllerHome: string,
  policyId: string,
  expectedRecordRevision: number,
  mutate: (current: EventPolicyV1) => EventPolicyV1,
): ControlPlaneRecord<EventPolicyV1> {
  const current = readEventPolicy(controllerHome, policyId);
  if (!current) throw new Error('EVENT_POLICY_NOT_FOUND: ' + policyId);
  if (current.revision !== expectedRecordRevision) throw new Error('EVENT_POLICY_REVISION_CONFLICT');
  const next = validateEventPolicyV1(mutate(structuredClone(current.value)));
  if (next.policyId !== policyId) throw new Error('EVENT_POLICY_ID_IMMUTABLE');
  if (next.revision !== current.value.revision + 1) throw new Error('EVENT_POLICY_LOGICAL_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: policyId,
    schemaVersion: 1,
    value: next,
    action: 'event_policy_updated',
    expectedRevision: current.revision,
  });
}

/** Deterministic policy selection only; model calls and action execution stay outside this store. */
export function findMatchingEventPolicies(
  controllerHome: string,
  envelope: EventEnvelopeV1,
): Array<ControlPlaneRecord<EventPolicyV1>> {
  return listEventPolicies(controllerHome)
    .filter((record) => matchEventPolicy(record.value, envelope).matched)
    .sort((left, right) => left.value.policyId.localeCompare(right.value.policyId));
}
