import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import type { ControllerBinding } from '../domain/types';
import { getRetainedControllerSession, type ControllerSessionStoreOptions } from './controller-session-store';

const NAMESPACE = 'controller_session_binding';

export interface ControllerSessionBindingRecord {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  sessionId: string;
  binding: ControllerBinding;
  boundAt: string;
  updatedAt: string;
}

export function bindControllerSessionBinding(
  options: ControllerSessionStoreOptions,
  input: { workId: string; sessionId: string; binding: ControllerBinding },
): ControllerSessionBindingRecord {
  const session = getRetainedControllerSession(options, input.workId);
  if (!session) throw new Error(`CONTROLLER_SESSION_NOT_RETAINED: ${input.workId}`);
  if (session.sessionId !== input.sessionId) throw new Error(`CONTROLLER_SESSION_BINDING_SESSION_MISMATCH: ${input.workId}`);
  if (session.controllerType !== input.binding.hostKind) throw new Error(`CONTROLLER_SESSION_BINDING_HOST_MISMATCH: ${input.workId}`);
  const key = `${input.workId}:${input.sessionId}`;
  return withControllerLock(options.controllerHome, { scope: 'task', repoId: options.repoId, taskId: `controller-binding-${input.workId}` }, `controller-binding:${key}`, () => {
    const current = readControlPlaneRecord<ControllerSessionBindingRecord>(options.controllerHome, NAMESPACE, options.repoId, key);
    const at = options.now?.() ?? new Date().toISOString();
    const value: ControllerSessionBindingRecord = {
      schemaVersion: 1,
      repoId: options.repoId,
      workId: input.workId,
      sessionId: input.sessionId,
      binding: { ...input.binding },
      boundAt: current?.value.boundAt ?? at,
      updatedAt: at,
    };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: NAMESPACE, scope: options.repoId, key, schemaVersion: 1, value,
      action: current ? 'controller_session_binding_update' : 'controller_session_binding_create',
      expectedRevision: current?.revision ?? null,
    });
    return value;
  });
}

export function getControllerSessionBinding(
  options: ControllerSessionStoreOptions,
  workId: string,
  sessionId: string,
): ControllerSessionBindingRecord | undefined {
  return readControlPlaneRecord<ControllerSessionBindingRecord>(
    options.controllerHome, NAMESPACE, options.repoId, `${workId}:${sessionId}`,
  )?.value;
}
