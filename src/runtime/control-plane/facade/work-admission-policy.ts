import {
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../persistence/sqlite-store';

export interface WorkAdmissionPolicy {
  schemaVersion: 1;
  mode: 'normal' | 'exclusive_work';
  allowedWorkId?: string;
  allowReadOnlyDiagnostics: true;
  reason?: string;
  activatedAt?: string;
  updatedAt: string;
}

const NAMESPACE = 'runtime_policy';
const SCOPE = 'global';
const KEY = 'work_admission';

function normalPolicy(now = new Date().toISOString()): WorkAdmissionPolicy {
  return {
    schemaVersion: 1,
    mode: 'normal',
    allowReadOnlyDiagnostics: true,
    updatedAt: now,
  };
}

export function readWorkAdmissionPolicy(controllerHome: string): WorkAdmissionPolicy {
  return readControlPlaneRecord<WorkAdmissionPolicy>(controllerHome, NAMESPACE, SCOPE, KEY)?.value
    ?? normalPolicy();
}

export function activateExclusiveWorkAdmission(
  controllerHome: string,
  input: { allowedWorkId: string; reason: string; now?: string },
): WorkAdmissionPolicy {
  const allowedWorkId = input.allowedWorkId.trim();
  if (!allowedWorkId) throw new Error('WORK_ADMISSION_POLICY_INVALID: allowedWorkId is required');
  const at = input.now ?? new Date().toISOString();
  const current = readControlPlaneRecord<WorkAdmissionPolicy>(controllerHome, NAMESPACE, SCOPE, KEY);
  const value: WorkAdmissionPolicy = {
    schemaVersion: 1,
    mode: 'exclusive_work',
    allowedWorkId,
    allowReadOnlyDiagnostics: true,
    reason: input.reason.slice(0, 500),
    activatedAt: current?.value.mode === 'exclusive_work'
      && current.value.allowedWorkId === allowedWorkId
      ? current.value.activatedAt ?? at
      : at,
    updatedAt: at,
  };
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: KEY,
    schemaVersion: 1,
    value,
    action: 'work_admission_exclusive',
    expectedRevision: current?.revision ?? null,
  }).value;
}

export function restoreNormalWorkAdmission(controllerHome: string, now = new Date().toISOString()): WorkAdmissionPolicy {
  const current = readControlPlaneRecord<WorkAdmissionPolicy>(controllerHome, NAMESPACE, SCOPE, KEY);
  const value = normalPolicy(now);
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: KEY,
    schemaVersion: 1,
    value,
    action: 'work_admission_normal',
    expectedRevision: current?.revision ?? null,
  }).value;
}

export function assertWorkAdmissionAllowed(
  controllerHome: string,
  input: { operation: 'create' | 'continue' | 'maintenance'; workId?: string },
): WorkAdmissionPolicy {
  const policy = readWorkAdmissionPolicy(controllerHome);
  if (policy.mode === 'normal' || input.operation === 'maintenance') return policy;
  if (input.workId?.trim() === policy.allowedWorkId) return policy;
  throw new Error(
    `WORK_ADMISSION_BLOCKED:P0_EXCLUSIVE_WORK:operation=${input.operation}:allowed=${policy.allowedWorkId ?? 'none'}`,
  );
}

export function schedulerDispatchAllowed(controllerHome: string): boolean {
  return readWorkAdmissionPolicy(controllerHome).mode === 'normal';
}
