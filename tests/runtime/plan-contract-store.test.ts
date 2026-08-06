import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import {
  approvePlanContract,
  claimPlanStepForWork,
  completePlanStepForWork,
  createPlanContract,
  getPlanContract,
  listPlanContracts,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  ControlPlaneConflictError,
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('persists facade Plan contracts as independently revisioned SQLite records', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-store-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-1', now: () => '2026-08-02T00:00:00.000Z' };
  const plan = createPlanContract(options, {
    planId: 'plan-1',
    repoId: 'repo-1',
    scopeKey: 'runtime',
    sourceRevision: 'abc123',
    goal: 'freeze authority',
    steps: [{ id: 'step-1', objective: 'define schema', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['schema is explicit'] }],
  });

  expect(getPlanContract(options, 'plan-1')).toEqual(plan);
  expect(listPlanContracts({ ...options, status: 'all' })).toHaveLength(1);
  expect(listControlPlaneRecords(options.controllerHome, { namespace: 'plan_contract', scope: 'repo-1' })).toHaveLength(1);

  const approved = approvePlanContract(options, 'plan-1');
  expect(approved.status).toBe('approved');
  expect(readControlPlaneRecord(options.controllerHome, 'plan_contract', 'repo-1', 'plan-1')?.revision).toBe(2);
});

test('rejects a second create and stale writer without changing the authoritative row', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-store-'));
  homes.push(home);
  const options = { controllerHome: home };
  const value = { planId: 'plan-1', repoId: 'repo-1', scopeKey: 'runtime', sourceRevision: 'abc', goal: 'goal', nonGoals: [], assumptions: [], resolvedDecisions: [], stopConditions: [], replanConditions: [], status: 'draft' as const, steps: [], evidenceRefs: [], createdAt: 'now', updatedAt: 'now', schemaVersion: 1 as const };
  writeControlPlaneRecord(home, { namespace: 'plan_contract', scope: 'repo-1', key: 'plan-1', schemaVersion: 1, value, expectedRevision: null, action: 'seed' });

  expect(() => writeControlPlaneRecord(home, { namespace: 'plan_contract', scope: 'repo-1', key: 'plan-1', schemaVersion: 1, value, expectedRevision: null, action: 'duplicate' })).toThrow(ControlPlaneConflictError);
  expect(() => writeControlPlaneRecord(home, { namespace: 'plan_contract', scope: 'repo-1', key: 'plan-1', schemaVersion: 1, value, expectedRevision: 99, action: 'stale' })).toThrow(ControlPlaneConflictError);
  expect(readControlPlaneRecord(home, 'plan_contract', 'repo-1', 'plan-1')?.revision).toBe(1);
});

test('keeps PlanStep materialization as a Work reference', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-store-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-1' };
  const plan = createPlanContract(options, {
    planId: 'plan-work-link',
    repoId: 'repo-1',
    scopeKey: 'runtime',
    sourceRevision: 'abc123',
    goal: 'materialize one Work',
    steps: [{ id: 'step-1', objective: 'execute bounded work', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['Work is bound'], workId: 'work-existing' }],
  });
  expect(plan.steps[0]?.workId).toBe('work-existing');
  expect(getPlanContract(options, plan.planId)?.steps[0]?.workId).toBe('work-existing');
});

function claimedPlan(options: { controllerHome: string; repoId: string; now: () => string }, planId: string, workId: string): void {
  createPlanContract(options, {
    planId,
    repoId: options.repoId,
    scopeKey: planId,
    sourceRevision: 'abc123',
    goal: 'complete only from Work authority',
    steps: [{ id: 'step-1', objective: 'execute bounded work', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['Work receipt is exact'] }],
  });
  approvePlanContract(options, planId);
  claimPlanStepForWork(options, { planId, stepId: 'step-1', workId, sourceRevision: 'abc123' });
}

test('rejects nonterminal Work and replans from failed Work', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-store-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-1', now: () => '2026-08-03T00:00:00.000Z' };
  claimedPlan(options, 'plan-work-terminal', 'work-terminal');
  expect(() => completePlanStepForWork(options, {
    planId: 'plan-work-terminal',
    stepId: 'step-1',
    work: { workId: 'work-terminal', status: 'running', phase: 'verification', evidenceState: 'partial', completionOutcome: undefined, completionReceipt: undefined, evidenceRefs: [] },
  })).toThrow(/PLAN_STEP_WORK_NOT_TERMINAL/);
  const failed = completePlanStepForWork(options, {
    planId: 'plan-work-terminal',
    stepId: 'step-1',
    work: { workId: 'work-terminal', status: 'failed', phase: 'cleanup', evidenceState: 'failed', completionOutcome: undefined, completionReceipt: undefined, evidenceRefs: [] },
  });
  expect(failed).toMatchObject({ status: 'replanning', steps: [{ workId: 'work-terminal', status: 'validating' }] });
});

test('completes a PlanStep only from the exact terminal Work receipt', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-store-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-1', now: () => '2026-08-03T00:00:00.000Z' };
  claimedPlan(options, 'plan-work-receipt', 'work-receipt');
  const receipt = {
    schemaVersion: 1 as const,
    receiptId: 'receipt-plan-work',
    source: 'controller_work' as const,
    issueId: 'ISS-plan-work-receipt',
    taskId: 'T1',
    workId: 'work-receipt',
    targetBranch: 'main',
    targetRevision: 'abc123',
    changedPaths: [],
    delivery: { kind: 'no_change' as const, status: 'integrated' as const, strategy: 'no_change' as const, reachable: true, recordedAt: '2026-08-03T00:00:00.000Z' },
    cleanup: { status: 'complete' as const, warnings: [], blockers: [], recordedAt: '2026-08-03T00:00:00.000Z' },
    verifiedAt: '2026-08-03T00:00:00.000Z',
    recordedAt: '2026-08-03T00:00:00.000Z',
  };
  const completed = completePlanStepForWork(options, {
    planId: 'plan-work-receipt',
    stepId: 'step-1',
    work: {
      workId: 'work-receipt',
      status: 'completed',
      phase: 'cleanup',
      evidenceState: 'valid',
      completionOutcome: 'completed_no_change',
      completionReceipt: receipt,
      evidenceRefs: [{ evidenceId: receipt.receiptId, title: 'Exact Work completion receipt.', summary: 'PlanStep completion is derived from the Work-owned receipt.' }],
    },
  });
  expect(completed).toMatchObject({ status: 'ready_to_finalize', steps: [{ workId: 'work-receipt', status: 'completed' }] });
});
