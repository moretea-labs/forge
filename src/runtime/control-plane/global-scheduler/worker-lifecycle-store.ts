import { rebuildRepositoryProjection } from '../../projections/materialized-view';
import { updateExecutionJob } from '../../execution/jobs/store';
import {
  TERMINAL_JOB_STATUSES,
  type ExecutionJob,
  type ExecutionJobStatus,
  type ExecutionWorkerLifecycle,
} from '../../execution/jobs/types';

export interface SchedulerWorkerLifecycleStoreDependencies {
  updateJob(
    controllerHome: string,
    repoId: string,
    jobId: string,
    updater: (current: ExecutionJob) => ExecutionJob,
  ): ExecutionJob;
  rebuildProjection(controllerHome: string, repoId: string): unknown;
}

const DEFAULT_DEPENDENCIES: SchedulerWorkerLifecycleStoreDependencies = {
  updateJob: (controllerHome, repoId, jobId, updater) => updateExecutionJob(
    controllerHome,
    repoId,
    jobId,
    updater,
  ),
  rebuildProjection: rebuildRepositoryProjection,
};

export function persistSchedulerSpawnedWorkerLifecycle(input: {
  controllerHome: string;
  repoId: string;
  jobId: string;
  lifecycle: ExecutionWorkerLifecycle;
}, dependencies: SchedulerWorkerLifecycleStoreDependencies = DEFAULT_DEPENDENCIES): void {
  try {
    dependencies.updateJob(input.controllerHome, input.repoId, input.jobId, (current) => {
      if (!['dispatched', 'running'].includes(current.status) || current.workerPid !== undefined) return current;
      return { ...current, workerLifecycle: input.lifecycle };
    });
  } catch {
    // The Job may have been superseded or made terminal.
  }
}

export function persistSchedulerTerminalWorkerLifecycle(input: {
  controllerHome: string;
  repoId: string;
  jobId: string;
  status: ExecutionJobStatus;
  lifecycle: ExecutionWorkerLifecycle;
}, dependencies: SchedulerWorkerLifecycleStoreDependencies = DEFAULT_DEPENDENCIES): boolean {
  if (!TERMINAL_JOB_STATUSES.has(input.status)) return false;
  dependencies.updateJob(input.controllerHome, input.repoId, input.jobId, (latest) => ({
    ...latest,
    workerLifecycle: input.lifecycle,
  }));
  try {
    dependencies.rebuildProjection(input.controllerHome, input.repoId);
  } catch {
    // The next scheduler/status read can retry projection materialization.
  }
  return true;
}
