import type { ExecutionJob, ExecutionJobStatus } from './types';

export function deadlineAfter(startedAt: string, timeoutMs: number): string {
  return new Date(Date.parse(startedAt) + timeoutMs).toISOString();
}

export type ExecutionTimeoutPhase = 'admission' | 'queue' | 'execution' | 'legacy';

export interface ExecutionTimeoutDecision {
  phase: ExecutionTimeoutPhase;
  deadlineAt: string;
  code: 'ADMISSION_TIMEOUT' | 'QUEUE_TIMEOUT' | 'EXECUTION_TIMEOUT' | 'DEADLINE_EXCEEDED';
  message: string;
}

const WAITING_STATUSES = new Set<ExecutionJobStatus>([
  'queued',
  'waiting_for_dependency',
  'waiting_for_workspace',
  'waiting_for_heavy_check',
  'waiting_for_integration',
  'waiting_for_release_barrier',
  'waiting_for_approval',
  'dispatched',
]);

function expired(deadlineAt: string | undefined, nowMs: number): deadlineAt is string {
  if (!deadlineAt) return false;
  const parsed = Date.parse(deadlineAt);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

export function executionTimeoutDecision(
  job: ExecutionJob,
  nowMs = Date.now(),
): ExecutionTimeoutDecision | undefined {
  if (!job.timeoutPolicy) {
    if (!expired(job.deadlineAt, nowMs)) return undefined;
    return {
      phase: 'legacy',
      deadlineAt: job.deadlineAt,
      code: 'DEADLINE_EXCEEDED',
      message: job.status === 'running'
        ? 'Execution deadline elapsed while the Worker was running.'
        : 'Execution deadline elapsed before dispatch.',
    };
  }

  if (job.status === 'running') {
    const deadlineAt = job.executionDeadlineAt ?? job.deadlineAt;
    if (!expired(deadlineAt, nowMs)) return undefined;
    return {
      phase: 'execution',
      deadlineAt,
      code: 'EXECUTION_TIMEOUT',
      message: 'Execution timeout elapsed after the Worker started.',
    };
  }

  if (!WAITING_STATUSES.has(job.status)) return undefined;
  if (!job.timings?.schedulerObservedAt) {
    const deadlineAt = job.admissionDeadlineAt ?? job.deadlineAt;
    if (!expired(deadlineAt, nowMs)) return undefined;
    return {
      phase: 'admission',
      deadlineAt,
      code: 'ADMISSION_TIMEOUT',
      message: 'Admission timeout elapsed before the Scheduler observed the Job.',
    };
  }

  const deadlineAt = job.queueDeadlineAt ?? job.deadlineAt;
  if (!expired(deadlineAt, nowMs)) return undefined;
  return {
    phase: 'queue',
    deadlineAt,
    code: 'QUEUE_TIMEOUT',
    message: 'Queue timeout elapsed after Scheduler admission and before Worker start.',
  };
}
