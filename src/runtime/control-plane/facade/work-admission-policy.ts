import { readControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';
import {
  WORK_ADMISSION_POLICY_KEY as KEY,
  WORK_ADMISSION_POLICY_NAMESPACE as NAMESPACE,
  WORK_ADMISSION_POLICY_SCOPE as SCOPE,
  assertWorkAdmissionPolicyAllows,
  normalWorkAdmissionPolicy as normalPolicy,
  schedulerDispatchPolicyAllowed,
  type WorkAdmissionPolicy,
} from '../../../../packages/kernel/work/api/index';
export type { WorkAdmissionPolicy } from '../../../../packages/kernel/work/api/index';

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

export function activateConvergenceWorkAdmission(
  controllerHome: string,
  input: { reason: string; now?: string },
): WorkAdmissionPolicy {
  const at = input.now ?? new Date().toISOString();
  const current = readControlPlaneRecord<WorkAdmissionPolicy>(controllerHome, NAMESPACE, SCOPE, KEY);
  const value: WorkAdmissionPolicy = {
    schemaVersion: 1,
    mode: 'convergence',
    allowReadOnlyDiagnostics: true,
    reason: input.reason.slice(0, 500),
    activatedAt: current?.value.mode === 'convergence'
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
    action: 'work_admission_convergence',
    expectedRevision: current?.revision ?? null,
  }).value;
}

export function transitionConvergenceToExclusiveWorkAdmission(
  controllerHome: string,
  input: { allowedWorkId: string; reason: string; now?: string },
): WorkAdmissionPolicy {
  const allowedWorkId = input.allowedWorkId.trim();
  if (!allowedWorkId) throw new Error('WORK_ADMISSION_POLICY_INVALID: allowedWorkId is required');
  const current = readControlPlaneRecord<WorkAdmissionPolicy>(controllerHome, NAMESPACE, SCOPE, KEY);
  if (current?.value.mode === 'exclusive_work' && current.value.allowedWorkId === allowedWorkId) {
    return current.value;
  }
  if (current?.value.mode !== 'convergence') {
    throw new Error(`WORK_ADMISSION_TRANSITION_REQUIRES_CONVERGENCE:current=${current?.value.mode ?? 'normal'}`);
  }
  const at = input.now ?? new Date().toISOString();
  const value: WorkAdmissionPolicy = {
    schemaVersion: 1,
    mode: 'exclusive_work',
    allowedWorkId,
    allowReadOnlyDiagnostics: true,
    reason: input.reason.slice(0, 500),
    activatedAt: at,
    updatedAt: at,
  };
  return writeControlPlaneRecord(controllerHome, {
    namespace: NAMESPACE,
    scope: SCOPE,
    key: KEY,
    schemaVersion: 1,
    value,
    action: 'work_admission_convergence_to_exclusive',
    expectedRevision: current.revision,
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
  return assertWorkAdmissionPolicyAllows(readWorkAdmissionPolicy(controllerHome), input);
}

export function schedulerDispatchAllowed(controllerHome: string): boolean {
  return schedulerDispatchPolicyAllowed(readWorkAdmissionPolicy(controllerHome));
}
