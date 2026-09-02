import { withControllerLock } from '../../../../src/cli/repositories/locks';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../../../src/runtime/control-plane/persistence/sqlite-store';
import type { ControllerBinding } from '../domain/types';
import { getRetainedControllerSession, type ControllerSessionStoreOptions } from './controller-session-store';

const SESSION_NAMESPACE = 'controller_session_binding';
const WORK_NAMESPACE = 'controller_work_binding';

export interface ControllerSessionBindingRecord {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  sessionId: string;
  binding: ControllerBinding;
  boundAt: string;
  updatedAt: string;
}

/** Durable provider interaction target for a Work. latestSessionId is observation only. */
export interface ControllerWorkBindingRecord {
  schemaVersion: 1;
  repoId: string;
  workId: string;
  latestSessionId: string;
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
  const sessionKey = `${input.workId}:${input.sessionId}`;
  return withControllerLock(options.controllerHome, { scope: 'task', repoId: options.repoId, taskId: `controller-binding-${input.workId}` }, `controller-binding:${input.workId}`, () => {
    const currentSession = readControlPlaneRecord<ControllerSessionBindingRecord>(options.controllerHome, SESSION_NAMESPACE, options.repoId, sessionKey);
    const currentWork = readControlPlaneRecord<ControllerWorkBindingRecord>(options.controllerHome, WORK_NAMESPACE, options.repoId, input.workId);
    const at = options.now?.() ?? new Date().toISOString();
    const sessionValue: ControllerSessionBindingRecord = {
      schemaVersion: 1, repoId: options.repoId, workId: input.workId, sessionId: input.sessionId,
      binding: { ...input.binding }, boundAt: currentSession?.value.boundAt ?? at, updatedAt: at,
    };
    const workValue: ControllerWorkBindingRecord = {
      schemaVersion: 1, repoId: options.repoId, workId: input.workId, latestSessionId: input.sessionId,
      binding: { ...input.binding }, boundAt: currentWork?.value.boundAt ?? at, updatedAt: at,
    };
    writeControlPlaneRecord(options.controllerHome, {
      namespace: SESSION_NAMESPACE, scope: options.repoId, key: sessionKey, schemaVersion: 1, value: sessionValue,
      action: currentSession ? 'controller_session_binding_update' : 'controller_session_binding_create',
      expectedRevision: currentSession?.revision ?? null,
    });
    writeControlPlaneRecord(options.controllerHome, {
      namespace: WORK_NAMESPACE, scope: options.repoId, key: input.workId, schemaVersion: 1, value: workValue,
      action: currentWork ? 'controller_work_binding_update' : 'controller_work_binding_create',
      expectedRevision: currentWork?.revision ?? null,
    });
    return sessionValue;
  });
}

/** Legacy transport-scoped projection retained for migration/read compatibility. */
export function getControllerSessionBinding(
  options: ControllerSessionStoreOptions,
  workId: string,
  sessionId: string,
): ControllerSessionBindingRecord | undefined {
  return readControlPlaneRecord<ControllerSessionBindingRecord>(
    options.controllerHome, SESSION_NAMESPACE, options.repoId, `${workId}:${sessionId}`,
  )?.value;
}

/** Canonical Work-scoped provider interaction target. */
export function getControllerWorkBinding(
  options: ControllerSessionStoreOptions,
  workId: string,
): ControllerWorkBindingRecord | undefined {
  return readControlPlaneRecord<ControllerWorkBindingRecord>(
    options.controllerHome, WORK_NAMESPACE, options.repoId, workId,
  )?.value;
}
