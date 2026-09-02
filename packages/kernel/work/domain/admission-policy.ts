export interface WorkAdmissionPolicy {
  schemaVersion: 1;
  mode: 'normal' | 'exclusive_work' | 'convergence';
  allowedWorkId?: string;
  allowReadOnlyDiagnostics: true;
  reason?: string;
  activatedAt?: string;
  updatedAt: string;
}

export const WORK_ADMISSION_POLICY_NAMESPACE = 'runtime_policy';
export const WORK_ADMISSION_POLICY_SCOPE = 'global';
export const WORK_ADMISSION_POLICY_KEY = 'work_admission';

export function normalWorkAdmissionPolicy(now = new Date().toISOString()): WorkAdmissionPolicy {
  return { schemaVersion: 1, mode: 'normal', allowReadOnlyDiagnostics: true, updatedAt: now };
}

export function assertWorkAdmissionPolicyAllows(
  policy: WorkAdmissionPolicy,
  input: { operation: 'create' | 'continue' | 'maintenance'; workId?: string },
): WorkAdmissionPolicy {
  if (policy.mode === 'normal' || input.operation === 'maintenance') return policy;
  if (policy.mode === 'convergence') {
    if (input.operation !== 'create') return policy;
    throw new Error('WORK_ADMISSION_BLOCKED:CONVERGENCE:operation=create');
  }
  if (input.workId?.trim() === policy.allowedWorkId) return policy;
  throw new Error(`WORK_ADMISSION_BLOCKED:P0_EXCLUSIVE_WORK:operation=${input.operation}:allowed=${policy.allowedWorkId ?? 'none'}`);
}

export function schedulerDispatchPolicyAllowed(policy: WorkAdmissionPolicy): boolean {
  return policy.mode !== 'exclusive_work';
}
