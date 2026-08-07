import type { ControllerTask, TaskStatus } from '../../../cli/controller/types';
import { isRepositoryCompletionReceipt, type WorkContract, type WorkRisk } from './types';

/**
 * Legacy Task statuses are a read-model vocabulary. They are intentionally
 * derived from Work and never fed back into Work or Requirement state.
 */
export function taskStatusFromWork(work: Pick<WorkContract, 'status' | 'phase'>): TaskStatus {
  if (work.status === 'completed') return 'done';
  if (work.status === 'cancelled') return 'cancelled';
  if (work.status === 'failed') return 'changes_requested';
  if (work.status === 'blocked') return 'blocked';
  if (work.status === 'running') {
    return work.phase === 'verification' ? 'verifying' : work.phase === 'delivery' ? 'integrating' : work.phase === 'cleanup' ? 'cleanup_pending' : 'running';
  }
  if (work.status === 'ready') return 'ready_to_integrate';
  return 'planned';
}

function workRiskToTaskRisk(risk: WorkRisk): ControllerTask['risk'] {
  return risk;
}

/**
 * Project one Work into the old ControllerTask shape for compatibility UIs and
 * readers. The source Task object is not mutated and its duplicated contract
 * fields are never consulted by this projection.
 */
export function projectControllerTaskFromWork(
  task: ControllerTask,
  work: WorkContract,
): ControllerTask {
  const projected: ControllerTask = {
    ...task,
    workId: work.workId,
    objective: work.objective,
    allowedPaths: [...work.allowedPaths],
    forbiddenPaths: [...work.forbiddenPaths],
    checks: [...work.checks],
    acceptanceCriteria: [...work.acceptanceCriteria],
    risk: workRiskToTaskRisk(work.risk),
    // A reviewed legacy outcome is user-facing evidence. Historical failed or
    // cancelled execution facts cannot move it backwards.
    status: task.status === 'done' && work.status !== 'completed' ? 'done' : taskStatusFromWork(work),
  };
  if (work.completionReceipt && projected.verification && isRepositoryCompletionReceipt(work.completionReceipt)) {
    projected.verification = {
      ...projected.verification,
      completionReceipt: work.completionReceipt,
    };
  }
  return projected;
}

export function taskExecutionContractFromWork(work: WorkContract): Pick<ControllerTask, 'workId' | 'objective' | 'allowedPaths' | 'forbiddenPaths' | 'checks' | 'acceptanceCriteria' | 'risk' | 'status'> {
  return {
    workId: work.workId,
    objective: work.objective,
    allowedPaths: [...work.allowedPaths],
    forbiddenPaths: [...work.forbiddenPaths],
    checks: [...work.checks],
    acceptanceCriteria: [...work.acceptanceCriteria],
    risk: workRiskToTaskRisk(work.risk),
    status: taskStatusFromWork(work),
  };
}
