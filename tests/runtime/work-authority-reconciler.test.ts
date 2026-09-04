import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { approvePlanContract, createPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { createWorkContract, getWorkContract, listWorkContracts } from '../../packages/kernel/work/api/index';
import { reconcileOwnerlessWorkAuthorities } from '../../src/runtime/control-plane/execution/work-authority-reconciler';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-ownerless-work-'));
  roots.push(value);
  return value;
}

function work(controllerHome: string, workId: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return createWorkContract({ controllerHome, repoId: 'repo-a' }, {
    workId,
    repoId: 'repo-a',
    mode: 'goal_workloop',
    objective: `Execute ${workId}`,
    acceptanceCriteria: ['Only live authority remains current.'],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  } as Parameters<typeof createWorkContract>[1]);
}

function planInput(planId: string) {
  return {
    planId,
    repoId: 'repo-a',
    requirementId: 'REQ-A',
    scopeKey: 'scope-a',
    sourceRevision: 'abc123',
    goal: 'Keep one current execution authority.',
    nonGoals: [], assumptions: [], resolvedDecisions: [], stopConditions: [], replanConditions: [],
    steps: [{ id: 'stage-a', objective: 'Execute one stage.', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['package:check:type'], acceptanceCriteria: ['Current Plan protects its Work.'] }],
  };
}

describe('exact Work authority reconciliation', () => {
  test('retires stale ownerless non-Plan Work while preserving its history row', () => {
    const controllerHome = home();
    work(controllerHome, 'WORK-OLD', '2026-09-04T00:00:00.000Z');
    const result = reconcileOwnerlessWorkAuthorities({ controllerHome, repoId: 'repo-a', nowMs: Date.parse('2026-09-04T04:00:00.000Z'), graceMs: 60 * 60_000 });
    expect(result.workIds).toEqual(['WORK-OLD']);
    expect(getWorkContract({ controllerHome, repoId: 'repo-a' }, 'WORK-OLD')).toMatchObject({ status: 'cancelled', dispatchState: 'terminal', phase: 'cleanup' });
    expect(listWorkContracts({ controllerHome, repoId: 'repo-a', status: 'active', limit: 20 }).map((entry) => entry.workId)).not.toContain('WORK-OLD');
    expect(listWorkContracts({ controllerHome, repoId: 'repo-a', status: 'all', limit: 20 }).map((entry) => entry.workId)).toContain('WORK-OLD');
  });

  test('does not retire a fresh ownerless Work inside the grace period', () => {
    const controllerHome = home();
    work(controllerHome, 'WORK-FRESH', '2026-09-04T03:30:00.000Z');
    const result = reconcileOwnerlessWorkAuthorities({ controllerHome, repoId: 'repo-a', nowMs: Date.parse('2026-09-04T04:00:00.000Z'), graceMs: 60 * 60_000 });
    expect(result.workIds).toEqual([]);
    expect(result.skippedByReason.grace_period).toBe(1);
    expect(getWorkContract({ controllerHome, repoId: 'repo-a' }, 'WORK-FRESH')?.status).toBe('running');
  });

  test('current Plan authority protects stale Work from ownerless retirement', () => {
    const controllerHome = home();
    createRequirement({ controllerHome }, { requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Deliver the current Plan.' });
    createPlanContract({ controllerHome, repoId: 'repo-a' }, planInput('PLAN-A'));
    approvePlanContract({ controllerHome, repoId: 'repo-a' }, 'PLAN-A');
    work(controllerHome, 'WORK-PLAN', '2026-09-04T00:00:00.000Z', { requirementId: 'REQ-A', planId: 'PLAN-A', planStepId: 'stage-a' });
    const result = reconcileOwnerlessWorkAuthorities({ controllerHome, repoId: 'repo-a', nowMs: Date.parse('2026-09-04T04:00:00.000Z'), graceMs: 60 * 60_000 });
    expect(result.workIds).toEqual([]);
    expect(result.skippedByReason.current_plan).toBe(1);
    expect(getWorkContract({ controllerHome, repoId: 'repo-a' }, 'WORK-PLAN')?.status).toBe('running');
  });
});
