import { executionIdentityForRepository } from '../control-plane/execution/execution-identity';
import type { RepositoryRecord } from '../../core/repository/types';
import { getRepository } from '../repositories/registry';
import {
  executeRegisteredWorkflowFeature,
  type ExecuteWorkflowFeatureInput,
  type WorkflowFeatureRunResult,
  type WorkflowFeatureRuntimeDependencies,
} from './feature-runtime';
import { buildScheduledWorkflowInvocation } from './schedule-invocation';
import type { RepositorySchedule, ScheduleOccurrence } from '../../../packages/kernel/scheduler/api/index';

export type ScheduledWorkflowExecutionStatus = 'succeeded' | 'waiting' | 'reconcile_required' | 'failed' | 'cancelled';

export interface ScheduledWorkflowExecutionResultV1 {
  schemaVersion: 1;
  workflowId: string;
  runId: string;
  scopeId: string;
  status: ScheduledWorkflowExecutionStatus;
  workflowResult: WorkflowFeatureRunResult;
}

export interface ScheduledWorkflowRuntimeDependencies {
  getRepository?: typeof getRepository;
  executeWorkflow?: (
    input: ExecuteWorkflowFeatureInput,
    dependencies?: WorkflowFeatureRuntimeDependencies,
  ) => Promise<WorkflowFeatureRunResult>;
  workflowDependencies?: WorkflowFeatureRuntimeDependencies;
}

function runtimeScopeId(repository: RepositoryRecord, workflowId: string): string {
  return `repository:${repository.repoId}:checkout:${repository.activeCheckoutId}:workflow:${workflowId}`;
}

function normalizeStatus(result: WorkflowFeatureRunResult): ScheduledWorkflowExecutionStatus {
  if (result.status === 'succeeded') return 'succeeded';
  if (result.status === 'reconcile_required') return 'reconcile_required';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'failed') return 'failed';
  if (result.status === 'waiting' || result.status === 'running') return 'waiting';
  throw new Error('WORKFLOW_SCHEDULE_RESULT_STATUS_UNSUPPORTED:' + String(result.status));
}

/**
 * Thin Scheduler→Workflow adapter. Scheduler owns trigger/admission; Workflow owns
 * catalog, lifecycle, engine routing, effects and recovery.
 */
export async function executeScheduledWorkflowOccurrence(input: {
  controllerHome: string;
  schedule: Pick<RepositorySchedule, 'scheduleId' | 'repoId' | 'action'>;
  occurrence: Pick<ScheduleOccurrence, 'occurrenceId' | 'scheduleId' | 'repoId'>;
  timeoutMs?: number;
  dependencies?: ScheduledWorkflowRuntimeDependencies;
}): Promise<ScheduledWorkflowExecutionResultV1> {
  const invocation = buildScheduledWorkflowInvocation(input.schedule, input.occurrence);
  const repository = (input.dependencies?.getRepository ?? getRepository)(input.schedule.repoId, input.controllerHome, {
    includeRemoved: true,
  });
  if (!repository.enabled || repository.removedAt) throw new Error('WORKFLOW_SCHEDULE_REPOSITORY_UNAVAILABLE');
  const scopeId = runtimeScopeId(repository, invocation.workflowId);
  const execute = input.dependencies?.executeWorkflow ?? executeRegisteredWorkflowFeature;
  const workflowResult = await execute(
    {
      controllerHome: input.controllerHome,
      repository,
      executionIdentity: executionIdentityForRepository(repository),
      scopeId,
      runId: invocation.binding.runId,
      registryScope: invocation.registryScope,
      workflowId: invocation.workflowId,
      inputs: invocation.inputs,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      origin: invocation.origin,
    },
    input.dependencies?.workflowDependencies,
  );
  return {
    schemaVersion: 1,
    workflowId: invocation.workflowId,
    runId: invocation.binding.runId,
    scopeId,
    status: normalizeStatus(workflowResult),
    workflowResult,
  };
}
