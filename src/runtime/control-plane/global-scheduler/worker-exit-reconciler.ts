import {
  getExecutionJob,
  transitionExecutionJob,
  updateExecutionJob,
} from '../../execution/jobs/store';
import { tryRecoverJobFromWorkerReceipt } from '../../execution/jobs/receipt-recovery';
import { releaseExecutionLeases } from '../../resources/leases/store';
import { rebuildRepositoryProjection } from '../../projections/materialized-view';
import type {
  ExecutionJob,
  ExecutionJobStatus,
  ExecutionWorkerLifecycle,
} from '../../execution/jobs/types';
import { evaluateSchedulerWorkerExitCandidate } from './worker-exit-decision';
import { buildSchedulerWorkerExitFailure } from './worker-lifecycle';
import { persistSchedulerTerminalWorkerLifecycle } from './worker-lifecycle-store';

export interface SchedulerWorkerExitReconcilerDependencies {
  getJob(controllerHome: string, repoId: string, jobId: string): ExecutionJob;
  recoverReceipt(controllerHome: string, job: ExecutionJob): ExecutionJob | undefined;
  persistTerminalLifecycle(input: {
    controllerHome: string;
    repoId: string;
    jobId: string;
    status: ExecutionJobStatus;
    lifecycle: ExecutionWorkerLifecycle;
  }): boolean;
  updateJob(
    controllerHome: string,
    repoId: string,
    jobId: string,
    updater: (current: ExecutionJob) => ExecutionJob,
  ): ExecutionJob;
  releaseLeases(
    controllerHome: string,
    repoId: string,
    jobId: string,
    leaseRefs: ExecutionJob['leaseRefs'],
  ): unknown;
  transitionJob(
    controllerHome: string,
    repoId: string,
    jobId: string,
    status: ExecutionJobStatus,
    patch: Partial<ExecutionJob>,
  ): ExecutionJob;
  rebuildProjection(controllerHome: string, repoId: string): unknown;
}

const DEFAULT_DEPENDENCIES: SchedulerWorkerExitReconcilerDependencies = {
  getJob: getExecutionJob,
  recoverReceipt: tryRecoverJobFromWorkerReceipt,
  persistTerminalLifecycle: persistSchedulerTerminalWorkerLifecycle,
  updateJob: (controllerHome, repoId, jobId, updater) => updateExecutionJob(
    controllerHome,
    repoId,
    jobId,
    updater,
  ),
  releaseLeases: releaseExecutionLeases,
  transitionJob: (controllerHome, repoId, jobId, status, patch) => transitionExecutionJob(
    controllerHome,
    repoId,
    jobId,
    status,
    patch,
  ),
  rebuildProjection: rebuildRepositoryProjection,
};

export function reconcileSchedulerWorkerExit(input: {
  controllerHome: string;
  repoId: string;
  jobId: string;
  attempt: number;
  childPid?: number;
  lifecycle: ExecutionWorkerLifecycle;
  diagnosticLifecycle: ExecutionWorkerLifecycle;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stderrTruncated: boolean;
  startupError?: string;
}, dependencies: SchedulerWorkerExitReconcilerDependencies = DEFAULT_DEPENDENCIES): void {
  try {
    const current = evaluateSchedulerWorkerExitCandidate({
      job: dependencies.getJob(input.controllerHome, input.repoId, input.jobId),
      attempt: input.attempt,
      childPid: input.childPid,
      lifecycle: input.lifecycle,
      diagnosticLifecycle: input.diagnosticLifecycle,
    });
    if (current.kind === 'ignore') return;
    if (current.kind === 'terminal') {
      dependencies.persistTerminalLifecycle({
        controllerHome: input.controllerHome,
        repoId: input.repoId,
        jobId: input.jobId,
        status: current.job.status,
        lifecycle: current.lifecycle,
      });
      return;
    }

    const recovered = dependencies.recoverReceipt(input.controllerHome, current.job);
    if (recovered) {
      dependencies.updateJob(input.controllerHome, input.repoId, input.jobId, (latest) => ({
        ...latest,
        workerLifecycle: current.lifecycle,
      }));
      try {
        dependencies.rebuildProjection(input.controllerHome, input.repoId);
      } catch {
        // The next scheduler/status read can retry projection materialization.
      }
      return;
    }

    const rechecked = evaluateSchedulerWorkerExitCandidate({
      job: dependencies.getJob(input.controllerHome, input.repoId, input.jobId),
      attempt: input.attempt,
      childPid: input.childPid,
      lifecycle: input.lifecycle,
      diagnosticLifecycle: input.diagnosticLifecycle,
    });
    if (rechecked.kind === 'ignore') return;
    if (rechecked.kind === 'terminal') {
      dependencies.persistTerminalLifecycle({
        controllerHome: input.controllerHome,
        repoId: input.repoId,
        jobId: input.jobId,
        status: rechecked.job.status,
        lifecycle: rechecked.lifecycle,
      });
      return;
    }

    const failure = buildSchedulerWorkerExitFailure({
      lifecycle: rechecked.lifecycle,
      attempt: rechecked.job.attempt,
      maxAttempts: rechecked.job.maxAttempts,
      exitCode: input.exitCode,
      signal: input.signal,
      stderr: input.stderr,
      stderrTruncated: input.stderrTruncated,
      startupError: input.startupError,
    });
    dependencies.releaseLeases(
      input.controllerHome,
      input.repoId,
      input.jobId,
      rechecked.job.leaseRefs,
    );
    dependencies.transitionJob(
      input.controllerHome,
      input.repoId,
      input.jobId,
      failure.retryable ? 'queued' : 'failed',
      {
        workerPid: undefined,
        heartbeatAt: undefined,
        leaseRefs: [],
        workerLifecycle: rechecked.lifecycle,
        error: failure.error,
      },
    );
    try {
      dependencies.rebuildProjection(input.controllerHome, input.repoId);
    } catch {
      // The next scheduler/status read can retry projection materialization.
    }
  } catch {
    // The Job may have been finalized by the Worker or reconciliation.
  }
}
