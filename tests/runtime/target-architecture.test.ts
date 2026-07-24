import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertAutomatedOperationAllowed } from '../../src/runtime/control-plane/governance/external-effects';
import { touchSchedulerWakeSignal, waitForSchedulerWakeSignal } from '../../src/runtime/control-plane/global-scheduler/wake-signal';
import { createExecutionJob } from '../../src/runtime/execution/jobs/store';
import {
  acquireExecutionLeases,
  listActiveLeases,
} from '../../src/runtime/resources/leases/store';
import { recordCandidateFinding } from '../../src/runtime/workflow/findings/store';
import { createPortfolioWorkflow } from '../../src/runtime/workflow/portfolio/store';
import { evaluateSchedule } from '../../src/runtime/workflow/schedules/engine';
import { createSchedule, listActiveOccurrences, listOccurrences } from '../../src/runtime/workflow/schedules/store';

const homes: string[] = [];
function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'repo-harness-runtime-test-'));
  homes.push(value);
  return value;
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('target architecture runtime', () => {
  test('refuses new ExecutionJob creation at the Kernel write boundary', () => {
    const controllerHome = home();
    expect(() => createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'mcp-tool',
      requestId: 'retired-job',
      semanticKey: 'retired-job',
      origin: { surface: 'mcp' },
      payload: { operation: 'controller_context', target: 'mcp-tool' },
      resourceClaims: [],
    })).toThrow(/EXECUTION_JOB_RETIRED/);
  });

  test('records idempotent external-controller handoffs for non-deterministic schedules', async () => {
    const controllerHome = home();
    const schedule = createSchedule(controllerHome, {
      requestId: 'schedule-request-1',
      repoId: 'repo-a',
      name: 'Read-only triage',
      enabled: true,
      trigger: { type: 'manual' },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 10, shadowMode: true },
      action: { operation: 'controller_context', resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }] },
      stopConditions: [],
    });
    const first = await evaluateSchedule(controllerHome, schedule, true);
    const second = await evaluateSchedule(controllerHome, schedule, true);
    expect(first?.status).toBe('skipped');
    expect(first?.decision).toBe('operation_blocked');
    expect(first?.handoffId).toBeTruthy();
    expect(first?.jobId).toBeUndefined();
    expect(second?.occurrenceId).toBe(first?.occurrenceId);
    expect(listOccurrences(controllerHome, 'repo-a')).toHaveLength(1);
    expect(listActiveOccurrences(controllerHome, 'repo-a')).toHaveLength(0);
  });

  test('prevents automated external side effects and requirement inflation', () => {
    expect(() => assertAutomatedOperationAllowed('publish_issue_to_github')).toThrow('EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
    expect(() => assertAutomatedOperationAllowed('repository_command_execute', { command: 'git push origin main' })).toThrow('EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
    expect(() => assertAutomatedOperationAllowed('create_issue', {})).toThrow('AUTOMATED_REQUIREMENT_REQUIRES_CANDIDATE');
    expect(() => assertAutomatedOperationAllowed('run_check', {})).not.toThrow();
  });

  test('deduplicates candidate findings and rejects cyclic Portfolio DAGs', () => {
    const controllerHome = home();
    const first = recordCandidateFinding(controllerHome, {
      repoId: 'repo-a', requestId: 'finding-1', semanticKey: 'same-defect', title: 'Same defect',
      evidence: { source: 'schedule', reference: 'OCC-1' },
    });
    const second = recordCandidateFinding(controllerHome, {
      repoId: 'repo-a', requestId: 'finding-2', semanticKey: 'same-defect', title: 'Same defect',
      evidence: { source: 'schedule', reference: 'OCC-2' },
    });
    expect(second.findingId).toBe(first.findingId);
    expect(second.observationCount).toBe(2);
    expect(() => createPortfolioWorkflow(controllerHome, {
      name: 'cycle', requestId: 'cycle', failurePolicy: 'stop',
      steps: [
        { stepId: 'a', repoId: 'repo-a', operation: 'controller_context', dependsOn: ['b'], priority: 'P2', resourceClaims: [], status: 'pending' },
        { stepId: 'b', repoId: 'repo-b', operation: 'controller_context', dependsOn: ['a'], priority: 'P2', resourceClaims: [], status: 'pending' },
      ],
    })).toThrow('PORTFOLIO_DEPENDENCY_CYCLE');
  });

  test('release freeze blocks writers while preserving read-only observation', () => {
    const controllerHome = home();
    const freeze = acquireExecutionLeases(controllerHome, 'repo-a', 'release-job', [{ resourceKey: 'release:repo-a', mode: 'exclusive' }], 30_000);
    expect(freeze.acquired).toBe(true);
    const reader = acquireExecutionLeases(controllerHome, 'repo-a', 'reader-job', [{ resourceKey: 'repo-state', mode: 'read' }], 30_000);
    expect(reader.acquired).toBe(true);
    const writer = acquireExecutionLeases(controllerHome, 'repo-a', 'writer-job', [{ resourceKey: 'repo-state', mode: 'write' }], 30_000);
    expect(writer.acquired).toBe(false);
  });

  test('competing writers cannot both hold the same repository write lease', () => {
    const controllerHome = home();
    const writer = acquireExecutionLeases(
      controllerHome,
      'repo-a',
      'writer-job',
      [{ resourceKey: 'repo-state', mode: 'write' }],
      30_000,
    );
    expect(writer.acquired).toBe(true);
    const competing = acquireExecutionLeases(
      controllerHome,
      'repo-a',
      'writer-job-2',
      [{ resourceKey: 'repo-state', mode: 'write' }],
      30_000,
    );
    expect(competing.acquired).toBe(false);
    expect(listActiveLeases(controllerHome, 'repo-a').length).toBeGreaterThanOrEqual(1);
  });

  test('scheduler wake signals interrupt idle backoff waits', async () => {
    const controllerHome = home();
    const before = 0;
    const waiter = waitForSchedulerWakeSignal(controllerHome, before, 5_000);
    touchSchedulerWakeSignal(controllerHome, 'test-wakeup');
    await expect(waiter).resolves.toBe('wakeup');
  });
});
