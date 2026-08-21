import {
  TERMINAL_JOB_STATUSES,
  type ExecutionJob,
  type ExecutionWorkerLifecycle,
} from '../../execution/jobs/types';

export type SchedulerWorkerExitDecision =
  | { kind: 'ignore'; reason: 'attempt_mismatch' | 'pid_mismatch' }
  | { kind: 'terminal'; job: ExecutionJob; lifecycle: ExecutionWorkerLifecycle }
  | { kind: 'active'; job: ExecutionJob; lifecycle: ExecutionWorkerLifecycle };

export function evaluateSchedulerWorkerExitCandidate(input: {
  job: ExecutionJob;
  attempt: number;
  childPid?: number;
  lifecycle: ExecutionWorkerLifecycle;
  diagnosticLifecycle: ExecutionWorkerLifecycle;
}): SchedulerWorkerExitDecision {
  if (input.job.attempt !== input.attempt) {
    return { kind: 'ignore', reason: 'attempt_mismatch' };
  }
  if (
    input.childPid !== undefined
    && input.job.workerPid !== undefined
    && input.job.workerPid !== input.childPid
  ) {
    return { kind: 'ignore', reason: 'pid_mismatch' };
  }

  const lifecycle = {
    ...(input.job.workerLifecycle ?? input.lifecycle),
    ...input.diagnosticLifecycle,
  };
  if (TERMINAL_JOB_STATUSES.has(input.job.status)) {
    return { kind: 'terminal', job: input.job, lifecycle };
  }
  return { kind: 'active', job: input.job, lifecycle };
}
