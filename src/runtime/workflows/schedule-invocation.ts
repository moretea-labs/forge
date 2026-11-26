import { createHash } from 'crypto';
import type { RepositorySchedule, ScheduleOccurrence } from '../../../packages/kernel/scheduler/api/index';
import type { WorkflowJsonValue } from '../../../packages/workflow-runtime/domain/workflow-asset';
import {
  validateWorkflowInvocationIntent,
  type WorkflowInvocationIntentV1,
} from '../../../packages/workflow-runtime/domain/workflow-invocation';

export const WORKFLOW_SCHEDULE_OPERATION = 'workflow.invoke' as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, code: string, max = 191): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(code);
  return value;
}

function scheduledRunId(scheduleId: string, occurrenceId: string, workflowId: string): string {
  const digest = createHash('sha256').update([scheduleId, occurrenceId, workflowId].join('\n'), 'utf8').digest('hex');
  return `schedule:${digest}`;
}

export function isWorkflowSchedule(schedule: Pick<RepositorySchedule, 'action'>): boolean {
  return schedule.action.operation === WORKFLOW_SCHEDULE_OPERATION;
}

/**
 * Pure bridge from Scheduler occurrence to Workflow invocation. It performs no
 * Workflow lookup, lifecycle mutation, authorization, or execution.
 */
export function buildScheduledWorkflowInvocation(
  schedule: Pick<RepositorySchedule, 'scheduleId' | 'repoId' | 'action'>,
  occurrence: Pick<ScheduleOccurrence, 'occurrenceId' | 'scheduleId' | 'repoId'>,
): WorkflowInvocationIntentV1 {
  if (!isWorkflowSchedule(schedule)) throw new Error('WORKFLOW_SCHEDULE_OPERATION_REQUIRED');
  if (occurrence.scheduleId !== schedule.scheduleId) throw new Error('WORKFLOW_SCHEDULE_OCCURRENCE_SCHEDULE_MISMATCH');
  if (occurrence.repoId !== schedule.repoId) throw new Error('WORKFLOW_SCHEDULE_OCCURRENCE_REPOSITORY_MISMATCH');
  const args = schedule.action.arguments;
  if (!record(args)) throw new Error('WORKFLOW_SCHEDULE_ARGUMENTS_REQUIRED');
  const workflowId = bounded(args.workflow_id, 'WORKFLOW_SCHEDULE_WORKFLOW_ID_REQUIRED', 128);
  let registryScope: WorkflowInvocationIntentV1['registryScope'] = { kind: 'controller' };
  if (args.project_id !== undefined) {
    registryScope = {
      kind: 'project',
      projectId: bounded(args.project_id, 'WORKFLOW_SCHEDULE_PROJECT_ID_INVALID', 128),
    };
  }
  const inputs = args.inputs === undefined ? {} : args.inputs;
  if (!record(inputs)) throw new Error('WORKFLOW_SCHEDULE_INPUTS_INVALID');
  const runId = scheduledRunId(schedule.scheduleId, occurrence.occurrenceId, workflowId);
  return validateWorkflowInvocationIntent({
    schemaVersion: 1,
    workflowId,
    registryScope,
    origin: { kind: 'schedule', id: `${schedule.scheduleId}:${occurrence.occurrenceId}` },
    inputs: structuredClone(inputs) as Record<string, WorkflowJsonValue>,
    binding: {
      scopeId: `repository:${schedule.repoId}:workflow:${workflowId}`,
      runId,
    },
  });
}
