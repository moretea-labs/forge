import type { ExecutionWorkerLifecycle } from '../../execution/jobs/types';
import type { SchedulerWorkerLaunchDescriptor } from './worker-launch';

export type SchedulerWorkerReleaseIdentity = Pick<
  ExecutionWorkerLifecycle,
  'runtimeInstanceId' | 'releaseAuthorityRevision' | 'releaseId' | 'artifactIdentity' | 'workerProtocolVersion'
>;

export function buildSchedulerWorkerSpawnFailureLifecycle(input: {
  executable: string;
  cwd: string;
  environment: Record<string, string | undefined>;
  ownerPid: number;
  attempt: number;
  maxAttempts: number;
  spawnedAt?: string;
}): ExecutionWorkerLifecycle {
  return {
    executable: input.executable,
    args: [],
    cwd: input.cwd,
    environment: input.environment,
    ownerPid: input.ownerPid,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    spawnedAt: input.spawnedAt ?? new Date().toISOString(),
    startupState: 'spawn_failed',
  };
}

export function buildSchedulerWorkerSpawnedLifecycle(input: {
  launch: SchedulerWorkerLaunchDescriptor;
  ownerPid: number;
  releaseIdentity?: SchedulerWorkerReleaseIdentity;
  attempt: number;
  maxAttempts: number;
  stderrPath: string;
  spawnedAt?: string;
}): ExecutionWorkerLifecycle {
  return {
    executable: input.launch.executable,
    args: input.launch.args,
    cwd: input.launch.cwd,
    environment: input.launch.lifecycleEnvironment,
    ownerPid: input.ownerPid,
    ...(input.releaseIdentity ?? {}),
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    spawnedAt: input.spawnedAt ?? new Date().toISOString(),
    stderrPath: input.stderrPath,
    startupState: 'spawned',
  };
}

export function buildSchedulerWorkerExitedLifecycle(input: {
  lifecycle: ExecutionWorkerLifecycle;
  childPid?: number;
  platform?: NodeJS.Platform;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stderrTruncated: boolean;
  startupError?: string;
  exitedAt?: string;
}): ExecutionWorkerLifecycle {
  const platform = input.platform ?? process.platform;
  return {
    ...input.lifecycle,
    exitedAt: input.exitedAt ?? new Date().toISOString(),
    exitCode: input.exitCode,
    signal: input.signal,
    workerPid: input.childPid ?? input.lifecycle.workerPid,
    processGroupId: input.lifecycle.processGroupId ?? (platform !== 'win32' ? input.childPid : undefined),
    stderr: input.stderr,
    stderrTruncated: input.stderrTruncated,
    startupState: input.startupError ? 'spawn_failed' : 'exited',
  };
}

export function buildSchedulerWorkerRegisteredLifecycle(input: {
  lifecycle: ExecutionWorkerLifecycle;
  currentLifecycle?: ExecutionWorkerLifecycle;
  workerPid: number;
  platform?: NodeJS.Platform;
  attachedAt?: string;
}): ExecutionWorkerLifecycle {
  const platform = input.platform ?? process.platform;
  return {
    ...(input.currentLifecycle ?? input.lifecycle),
    attachedAt: input.attachedAt ?? new Date().toISOString(),
    processGroupId: platform !== 'win32' ? input.workerPid : undefined,
    workerPid: input.workerPid,
    startupState: 'registered',
  };
}

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
