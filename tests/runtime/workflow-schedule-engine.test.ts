import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSchedule, getSchedule, getScheduleDecision } from '../../packages/kernel/scheduler/api/index';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { WORKFLOW_SCHEDULE_OPERATION } from '../../src/runtime/workflows/schedule-invocation';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function fixture() {
  const repoRoot = temp('forge-workflow-schedule-repo-');
  const controllerHome = temp('forge-workflow-schedule-home-');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Forge Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'workflow schedule fixture' });
  const schedule = createSchedule(controllerHome, {
    requestId: 'workflow-schedule-request',
    repoId: repository.repoId,
    name: 'Daily report',
    enabled: true,
    trigger: { type: 'manual' },
    policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 60, shadowMode: false },
    action: {
      operation: WORKFLOW_SCHEDULE_OPERATION,
      target: 'controller',
      arguments: { workflow_id: 'daily.report', inputs: { day: 'today' } },
    },
    stopConditions: [],
  });
  return { controllerHome, repository, schedule };
}

describe('Scheduler → first-class Workflow dispatch', () => {
  test('records dispatched when Workflow accepts a durable waiting run', async () => {
    const { controllerHome, schedule } = fixture();
    const occurrence = await evaluateSchedule(
      controllerHome,
      schedule,
      true,
      { source: 'manual' },
      {
        executeScheduledWorkflow: async () => ({
          schemaVersion: 1,
          workflowId: 'daily.report',
          runId: 'schedule:run-1',
          scopeId: 'repository:repo:checkout:co:workflow:daily.report',
          status: 'waiting',
          workflowResult: { status: 'waiting' } as never,
        }),
      },
    );
    expect(occurrence).toMatchObject({ status: 'dispatched', decision: 'execute' });
    expect(occurrence?.decisionId).toBeDefined();
    const decision = getScheduleDecision(controllerHome, schedule.repoId, occurrence!.decisionId!);
    expect(decision?.evidence).toMatchObject({
      workflowId: 'daily.report',
      workflowRunId: 'schedule:run-1',
      workflowStatus: 'waiting',
    });
    const stored = getSchedule(controllerHome, schedule.repoId, schedule.scheduleId);
    expect(stored.lastOccurrenceId).toBe(occurrence?.occurrenceId);
    expect(stored.consecutiveFailures).toBe(0);
  });

  test('does not convert Workflow reconciliation ownership into a Schedule failure', async () => {
    const { controllerHome, schedule } = fixture();
    const occurrence = await evaluateSchedule(
      controllerHome,
      schedule,
      true,
      { source: 'manual' },
      {
        executeScheduledWorkflow: async () => ({
          schemaVersion: 1,
          workflowId: 'daily.report',
          runId: 'schedule:run-2',
          scopeId: 'scope-2',
          status: 'reconcile_required',
          workflowResult: { status: 'reconcile_required' } as never,
        }),
      },
    );
    expect(occurrence?.status).toBe('dispatched');
    const decision = getScheduleDecision(controllerHome, schedule.repoId, occurrence!.decisionId!);
    expect(decision?.evidence?.workflowStatus).toBe('reconcile_required');
    expect(getSchedule(controllerHome, schedule.repoId, schedule.scheduleId).consecutiveFailures).toBe(0);
  });

  test('counts failure only when Workflow dispatch itself fails before ownership transfers', async () => {
    const { controllerHome, schedule } = fixture();
    const occurrence = await evaluateSchedule(
      controllerHome,
      schedule,
      true,
      { source: 'manual' },
      {
        executeScheduledWorkflow: async () => {
          throw new Error('WORKFLOW_INVOCATION_BLOCKED:WORKFLOW_NOT_ACTIVE');
        },
      },
    );
    expect(occurrence).toMatchObject({ status: 'failed', decision: 'execute' });
    expect(occurrence?.reason).toContain('WORKFLOW_INVOCATION_BLOCKED');
    expect(getSchedule(controllerHome, schedule.repoId, schedule.scheduleId).consecutiveFailures).toBe(1);
  });
});
