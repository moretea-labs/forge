import { settleScheduledExecution } from '../../workflow/schedules/settlement';
import {
  buildDelegatedExecutionResult,
  childReferenceFromJob,
  childReferenceFromReceipt,
  hasDurableChildReference,
  isAgentDelegationOperation,
  mergeChildReferences,
} from './child-reference';
import { operationReceiptMatchesJobOwnership, readOperationReceipt } from './receipt-store';
import { getExecutionJob, transitionExecutionJob } from './store';
import type { ExecutionJob } from './types';
import { releaseExecutionLeases } from '../../resources/leases/store';

export type RecoveredReceiptOutcome = {
  job: ExecutionJob;
  recoveredAs: 'completed' | 'delegated';
  outcome: 'succeeded' | 'failed' | 'delegated';
};

function isAgentDelegationJob(job: ExecutionJob): boolean {
  return isAgentDelegationOperation(job.payload.operation)
    || job.type === 'agent-run'
    || job.type === 'dispatch-task'
    || job.payload.arguments?.agentDelegation === true
    || (job.payload.operation === 'legacy-local-job'
      && typeof job.payload.arguments?.localAction === 'string'
      && ['launch-task', 'quick-agent-session'].includes(String(job.payload.arguments.localAction)));
}

/**
 * Recover a running Job from a matching completed/delegated Worker receipt.
 *
 * Ownership must match attempt, worker PID, ownerEpoch, and lease fencing so a
 * stale receipt from a previous attempt cannot finalize the current owner.
 * Callers must not release leases, requeue, or emit WORKER_EXITED when this
 * returns a recovered Job.
 */
export function recoverCompletedReceipt(
  controllerHome: string,
  job: ExecutionJob,
): RecoveredReceiptOutcome | undefined {
  if (!['running', 'dispatched'].includes(job.status)) return undefined;
  const receipt = readOperationReceipt(controllerHome, job.repoId, job.jobId);
  if (!receipt || !operationReceiptMatchesJobOwnership(receipt, job)) return undefined;

  const childReference = mergeChildReferences(
    childReferenceFromReceipt(receipt),
    childReferenceFromJob(job),
  );
  if (
    (receipt.state === 'delegated' || hasDurableChildReference(childReference))
    && isAgentDelegationJob(job)
  ) {
    if (!hasDurableChildReference(childReference) || !childReference) return undefined;
    releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
    const result = receipt.result ?? buildDelegatedExecutionResult({ childReference });
    const recovered = transitionExecutionJob(controllerHome, job.repoId, job.jobId, 'succeeded', {
      result,
      error: undefined,
      evidenceIds: receipt.evidenceIds ?? job.evidenceIds,
      workerPid: undefined,
      leaseRefs: [],
    }, { recoveredFromReceipt: true, receiptAttempt: receipt.attempt, recoveredAs: 'delegated' });
    settleScheduledExecution(
      controllerHome,
      recovered,
      'succeeded',
      'Scheduled agent-delegation operation recovered from a durable child reference.',
    );
    return { job: recovered, recoveredAs: 'delegated', outcome: 'delegated' };
  }

  if (receipt.state !== 'completed' || !receipt.outcome || receipt.outcome === 'delegated') {
    return undefined;
  }
  releaseExecutionLeases(controllerHome, job.repoId, job.jobId, job.leaseRefs);
  const recovered = transitionExecutionJob(controllerHome, job.repoId, job.jobId, receipt.outcome, {
    result: receipt.result,
    error: receipt.error,
    evidenceIds: receipt.evidenceIds ?? job.evidenceIds,
    workerPid: undefined,
    leaseRefs: [],
  }, { recoveredFromReceipt: true, receiptAttempt: receipt.attempt });
  settleScheduledExecution(
    controllerHome,
    recovered,
    receipt.outcome,
    receipt.outcome === 'succeeded'
      ? 'Scheduled operation recovered from a completed Worker receipt.'
      : 'Scheduled operation failed before Job terminal state was persisted.',
  );
  return { job: recovered, recoveredAs: 'completed', outcome: receipt.outcome };
}

/**
 * Best-effort recovery used on Worker process exit. Returns the terminal Job
 * when a matching receipt was applied; otherwise undefined so the caller can
 * keep the original abnormal-exit retry path.
 */
export function tryRecoverJobFromWorkerReceipt(
  controllerHome: string,
  job: ExecutionJob,
): ExecutionJob | undefined {
  try {
    return recoverCompletedReceipt(controllerHome, job)?.job;
  } catch {
    // JOB_ALREADY_TERMINAL or concurrent finalization — re-read below.
    try {
      const current = getExecutionJob(controllerHome, job.repoId, job.jobId);
      if (['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(current.status)) {
        return current;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }
}
