import { describe, expect, test } from 'bun:test';
import type { RepositorySchedule, ScheduleOccurrence } from '../../packages/kernel/scheduler/api/index';
import {
  buildScheduledWorkflowInvocation,
  isWorkflowSchedule,
  WORKFLOW_SCHEDULE_OPERATION,
} from '../../src/runtime/workflows/schedule-invocation';

function schedule(arguments_: Record<string, unknown>): Pick<RepositorySchedule, 'scheduleId' | 'repoId' | 'action'> {
  return {
    scheduleId: 'SCH-1',
    repoId: 'repo-1',
    action: { operation: WORKFLOW_SCHEDULE_OPERATION, target: 'controller', arguments: arguments_ },
  };
}
const occurrence: Pick<ScheduleOccurrence, 'occurrenceId' | 'scheduleId' | 'repoId'> = {
  occurrenceId: 'OCC-1',
  scheduleId: 'SCH-1',
  repoId: 'repo-1',
};

describe('Scheduled Workflow invocation bridge', () => {
  test('builds a first-class schedule-origin Workflow intent without knowing engine type', () => {
    const invocation = buildScheduledWorkflowInvocation(
      schedule({ workflow_id: 'daily.report', inputs: { period: 'daily', notify: true } }),
      occurrence,
    );
    expect(invocation).toMatchObject({
      schemaVersion: 1,
      workflowId: 'daily.report',
      registryScope: { kind: 'controller' },
      origin: { kind: 'schedule', id: 'SCH-1:OCC-1' },
      inputs: { period: 'daily', notify: true },
      binding: { scopeId: 'repository:repo-1:workflow:daily.report' },
    });
    expect(invocation.binding.runId).toMatch(/^schedule:[a-f0-9]{64}$/);
  });

  test('produces stable run identity for retries of the same occurrence', () => {
    const first = buildScheduledWorkflowInvocation(schedule({ workflow_id: 'daily.report' }), occurrence);
    const second = buildScheduledWorkflowInvocation(schedule({ workflow_id: 'daily.report' }), occurrence);
    expect(first.binding.runId).toBe(second.binding.runId);
  });

  test('supports explicit project-scoped Workflow lookup without giving Scheduler lifecycle authority', () => {
    const invocation = buildScheduledWorkflowInvocation(
      schedule({ workflow_id: 'project.audit', project_id: 'project-1', inputs: {} }),
      occurrence,
    );
    expect(invocation.registryScope).toEqual({ kind: 'project', projectId: 'project-1' });
    expect(JSON.stringify(invocation)).not.toContain('active');
    expect(JSON.stringify(invocation)).not.toContain('authorization');
  });

  test('rejects mismatched occurrence provenance and malformed arguments', () => {
    expect(() =>
      buildScheduledWorkflowInvocation(schedule({ workflow_id: 'x' }), { ...occurrence, scheduleId: 'SCH-2' }),
    ).toThrow('WORKFLOW_SCHEDULE_OCCURRENCE_SCHEDULE_MISMATCH');
    expect(() =>
      buildScheduledWorkflowInvocation(schedule({ workflow_id: 'x' }), { ...occurrence, repoId: 'repo-2' }),
    ).toThrow('WORKFLOW_SCHEDULE_OCCURRENCE_REPOSITORY_MISMATCH');
    expect(() => buildScheduledWorkflowInvocation(schedule({ workflow_id: '' }), occurrence)).toThrow(
      'WORKFLOW_SCHEDULE_WORKFLOW_ID_REQUIRED',
    );
  });

  test('distinguishes workflow.invoke from legacy Scheduler operations', () => {
    expect(isWorkflowSchedule(schedule({ workflow_id: 'x' }))).toBe(true);
    expect(isWorkflowSchedule({ action: { operation: 'browser_probe' } })).toBe(false);
  });
});
