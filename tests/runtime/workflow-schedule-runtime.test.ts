import { describe, expect, test } from 'bun:test';
import type { RepositorySchedule, ScheduleOccurrence } from '../../packages/kernel/scheduler/api/index';
import type { RepositoryRecord } from '../../src/core/repository/types';
import type {
  ExecuteWorkflowFeatureInput,
  WorkflowFeatureRunResult,
} from '../../src/runtime/workflows/feature-runtime';
import { executeScheduledWorkflowOccurrence } from '../../src/runtime/workflows/schedule-runtime';
import { WORKFLOW_SCHEDULE_OPERATION } from '../../src/runtime/workflows/schedule-invocation';

const schedule: Pick<RepositorySchedule, 'scheduleId' | 'repoId' | 'action'> = {
  scheduleId: 'SCH-1',
  repoId: 'repo-1',
  action: {
    operation: WORKFLOW_SCHEDULE_OPERATION,
    arguments: { workflow_id: 'daily.report', inputs: { day: 'today' } },
  },
};
const occurrence: Pick<ScheduleOccurrence, 'occurrenceId' | 'scheduleId' | 'repoId'> = {
  occurrenceId: 'OCC-1',
  scheduleId: 'SCH-1',
  repoId: 'repo-1',
};
const repository = {
  repoId: 'repo-1',
  activeCheckoutId: 'checkout-7',
  canonicalRoot: '/repo',
  enabled: true,
} as unknown as RepositoryRecord;
function result(
  status: 'succeeded' | 'waiting' | 'reconcile_required' | 'failed' | 'cancelled' | 'running',
): WorkflowFeatureRunResult {
  return { status } as WorkflowFeatureRunResult;
}

describe('Scheduled Workflow runtime adapter', () => {
  test('resolves local checkout at execution time and routes through first-class Workflow Feature', async () => {
    let seen: unknown;
    const executed = await executeScheduledWorkflowOccurrence({
      controllerHome: '/controller',
      schedule,
      occurrence,
      dependencies: {
        getRepository: (() => repository) as never,
        executeWorkflow: async (input) => {
          seen = input;
          return result('succeeded');
        },
      },
    });
    expect(seen).toMatchObject({
      workflowId: 'daily.report',
      scopeId: 'repository:repo-1:checkout:checkout-7:workflow:daily.report',
      origin: { kind: 'schedule', id: 'SCH-1:OCC-1' },
      inputs: { day: 'today' },
      repository: { repoId: 'repo-1', activeCheckoutId: 'checkout-7' },
      executionIdentity: { repositoryId: 'repo-1', checkoutId: 'checkout-7' },
    });
    expect(executed).toMatchObject({
      workflowId: 'daily.report',
      status: 'succeeded',
      scopeId: 'repository:repo-1:checkout:checkout-7:workflow:daily.report',
    });
  });

  test('reuses the stable occurrence-derived run id across runtime retries', async () => {
    const ids: string[] = [];
    const dependencies = {
      getRepository: (() => repository) as never,
      executeWorkflow: async (input: ExecuteWorkflowFeatureInput) => {
        ids.push(input.runId);
        return result('succeeded');
      },
    };
    await executeScheduledWorkflowOccurrence({ controllerHome: '/controller', schedule, occurrence, dependencies });
    await executeScheduledWorkflowOccurrence({ controllerHome: '/controller', schedule, occurrence, dependencies });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  test('surfaces durable Workflow waiting/reconciliation instead of pretending schedule success', async () => {
    for (const [workflowStatus, expected] of [
      ['waiting', 'waiting'],
      ['running', 'waiting'],
      ['reconcile_required', 'reconcile_required'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
    ] as const) {
      const executed = await executeScheduledWorkflowOccurrence({
        controllerHome: '/controller',
        schedule,
        occurrence,
        dependencies: {
          getRepository: (() => repository) as never,
          executeWorkflow: async () => result(workflowStatus),
        },
      });
      expect(executed.status).toBe(expected);
    }
  });

  test('fails before Workflow execution when repository placement is removed/disabled', async () => {
    let called = false;
    await expect(
      executeScheduledWorkflowOccurrence({
        controllerHome: '/controller',
        schedule,
        occurrence,
        dependencies: {
          getRepository: (() => ({ ...repository, enabled: false })) as never,
          executeWorkflow: async () => {
            called = true;
            return result('succeeded');
          },
        },
      }),
    ).rejects.toThrow('WORKFLOW_SCHEDULE_REPOSITORY_UNAVAILABLE');
    expect(called).toBe(false);
  });
});
