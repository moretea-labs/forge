import { attachExecutionWorker, updateExecutionJob } from '../../execution/jobs/store';
import type { ExecutionJob, ExecutionWorkerLifecycle } from '../../execution/jobs/types';
import { buildSchedulerWorkerRegisteredLifecycle } from './worker-lifecycle';

export interface SchedulerWorkerAttachmentDependencies {
  attachWorker(
    controllerHome: string,
    repoId: string,
    jobId: string,
    workerPid: number,
  ): ExecutionJob | undefined;
  updateJob(
    controllerHome: string,
    repoId: string,
    jobId: string,
    updater: (current: ExecutionJob) => ExecutionJob,
  ): ExecutionJob;
}

const DEFAULT_DEPENDENCIES: SchedulerWorkerAttachmentDependencies = {
  attachWorker: attachExecutionWorker,
  updateJob: (controllerHome, repoId, jobId, updater) => updateExecutionJob(
    controllerHome,
    repoId,
    jobId,
    updater,
  ),
};

export function persistSchedulerWorkerAttachment(input: {
  controllerHome: string;
  repoId: string;
  jobId: string;
  workerPid: number;
  lifecycle: ExecutionWorkerLifecycle;
}, dependencies: SchedulerWorkerAttachmentDependencies = DEFAULT_DEPENDENCIES): boolean {
  const attached = dependencies.attachWorker(
    input.controllerHome,
    input.repoId,
    input.jobId,
    input.workerPid,
  );
  if (!attached) return false;
  try {
    dependencies.updateJob(input.controllerHome, input.repoId, input.jobId, (latest) => ({
      ...latest,
      workerLifecycle: buildSchedulerWorkerRegisteredLifecycle({
        lifecycle: input.lifecycle,
        currentLifecycle: latest.workerLifecycle,
        workerPid: input.workerPid,
      }),
    }));
  } catch {
    // close/reconciliation may have finalized the Job after attachment.
  }
  return true;
}
