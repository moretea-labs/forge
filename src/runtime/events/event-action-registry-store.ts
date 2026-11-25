import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from '../control-plane/persistence/sqlite-store';
import { validateEventActionDefinitionV1, type EventActionDefinitionV1 } from '../../../packages/kernel/events';

const NAMESPACE = 'event_action_definition';
const SCOPE = 'global';

export function createEventActionDefinition(
  controllerHome: string,
  input: unknown,
): ControlPlaneRecord<EventActionDefinitionV1> {
  const value = validateEventActionDefinitionV1(input);
  if (value.revision !== 1) throw new Error('EVENT_ACTION_CREATE_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: value.actionRef,
    schemaVersion: 1,
    value,
    action: 'event_action_created',
    expectedRevision: null,
  });
}
export function readEventActionDefinition(
  controllerHome: string,
  actionRef: string,
): ControlPlaneRecord<EventActionDefinitionV1> | undefined {
  const record = readControlPlaneRecord<unknown>(controllerHome, NAMESPACE, SCOPE, actionRef);
  if (!record) return undefined;
  const value = validateEventActionDefinitionV1(record.value);
  if (value.actionRef !== record.key || value.actionRef !== actionRef) throw new Error('EVENT_ACTION_KEY_MISMATCH');
  return { ...record, value };
}
export function listEventActionDefinitions(
  controllerHome: string,
  limit = 256,
): ControlPlaneRecord<EventActionDefinitionV1>[] {
  return listControlPlaneRecords<unknown>(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    limit: Math.max(1, Math.min(Math.trunc(limit), 1000)),
  }).map((record) => {
    const value = validateEventActionDefinitionV1(record.value);
    if (value.actionRef !== record.key) throw new Error('EVENT_ACTION_KEY_MISMATCH');
    return { ...record, value };
  });
}
export function updateEventActionDefinition(
  controllerHome: string,
  actionRef: string,
  expectedRecordRevision: number,
  mutate: (current: EventActionDefinitionV1) => EventActionDefinitionV1,
): ControlPlaneRecord<EventActionDefinitionV1> {
  const current = readEventActionDefinition(controllerHome, actionRef);
  if (!current) throw new Error('EVENT_ACTION_NOT_FOUND:' + actionRef);
  if (current.revision !== expectedRecordRevision) throw new Error('EVENT_ACTION_REVISION_CONFLICT');
  const next = validateEventActionDefinitionV1(mutate(structuredClone(current.value)));
  if (next.actionRef !== actionRef) throw new Error('EVENT_ACTION_REF_IMMUTABLE');
  if (next.revision !== current.value.revision + 1) throw new Error('EVENT_ACTION_LOGICAL_REVISION_INVALID');
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: actionRef,
    schemaVersion: 1,
    value: next,
    action: 'event_action_updated',
    expectedRevision: current.revision,
  });
}
