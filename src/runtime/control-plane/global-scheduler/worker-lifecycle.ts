import type { ExecutionWorkerLifecycle } from '../../execution/jobs/types';

export interface SchedulerWorkerExitFailure {
  retryable: boolean;
  error: {
    code: 'WORKER_START_FAILED' | 'WORKER_EXITED';
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export function buildSchedulerWorkerExitFailure(input: {
  lifecycle: ExecutionWorkerLifecycle;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stderrTruncated: boolean;
  startupError?: string;
}): SchedulerWorkerExitFailure {
  const retryable = input.attempt < input.maxAttempts;
  const details: Record<string, unknown> = {
    workerLostReason: input.startupError ? 'spawn_failed' : 'process_exit',
    executable: input.lifecycle.executable,
    cwd: input.lifecycle.cwd,
    exitCode: input.exitCode,
    signal: input.signal,
    stderr: input.stderr,
    stderrTruncated: input.stderrTruncated,
    stderrPath: input.lifecycle.stderrPath,
    processGroupId: input.lifecycle.processGroupId,
    ownerPid: input.lifecycle.ownerPid,
    runtimeInstanceId: input.lifecycle.runtimeInstanceId,
    releaseAuthorityRevision: input.lifecycle.releaseAuthorityRevision,
    releaseId: input.lifecycle.releaseId,
    artifactIdentity: input.lifecycle.artifactIdentity,
    workerProtocolVersion: input.lifecycle.workerProtocolVersion,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    ...(input.startupError ? { startupError: input.startupError } : {}),
  };
  const stderrSummary = input.stderr.trim() ? ` Worker stderr: ${input.stderr.trim()}` : '';
  const startupSummary = input.startupError ? ` Startup error: ${input.startupError}.` : '';
  const message = `Execution Worker ${input.lifecycle.executable} exited before completion (cwd ${input.lifecycle.cwd}, exit code ${input.exitCode ?? 'unknown'}${input.signal ? `, signal ${input.signal}` : ''}).${startupSummary}${stderrSummary}`;
  return {
    retryable,
    error: {
      code: input.startupError ? 'WORKER_START_FAILED' : 'WORKER_EXITED',
      message,
      retryable,
      details,
    },
  };
}
