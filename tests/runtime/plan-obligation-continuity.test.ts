import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  admitPlanContract,
  createPlanContract,
  getPlanContract,
  listUnresolvedPlanObligations,
  retireTerminalPlanBoundWorkAuthorities,
  type CreatePlanContractInput,
  type PlanContractStoreOptions,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import type { PlanObligationDisposition } from '../../src/runtime/control-plane/facade/types';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { createWorkContract, getWorkContract, listWorkContracts } from '../../packages/kernel/work/api/index';

const roots: string[] = [];
function store(): PlanContractStoreOptions {
  const root = mkdtempSync(join(tmpdir(), 'forge-plan-obligation-'));
  roots.push(root);
  return { root };
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function input(planId: string): CreatePlanContractInput {
  return {
    planId,
    repoId: 'repo-a',
    requirementId: 'REQ-A',
    scopeKey: 'kernel-v2',
    sourceRevision: 'revision-a',
    goal: `${planId} preserves the intended V2 outcome.`,
    nonGoals: ['Do not create a second semantic authority.'],
    assumptions: ['The predecessor source identity is still valid.'],
    resolvedDecisions: ['Runtime mutable state belongs to Controller Home.'],
    stopConditions: ['Stop if a second writer appears.'],
    replanConditions: ['Replan when authority assumptions materially change.'],
    integrationStrategy: 'Preserve authority while replacing the plan contract.',
    steps: [{
      id: 'stage-a',
      objective: 'Converge one bounded architecture slice.',
      dependencies: [],
      authoritativeFiles: ['src/runtime/example.ts'],
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: ['package:check:type'],
      acceptanceCriteria: ['The architecture slice keeps one writer.', 'Lifecycle cleanup remains explicit.'],
    }],
  };
}

function successorDispositions(predecessor: ReturnType<typeof createPlanContract>): PlanObligationDisposition[] {
  return listUnresolvedPlanObligations(predecessor).map((obligation) => ({
    predecessorPlanId: predecessor.planId,
    obligationId: obligation.obligationId,
    disposition: 'keep' as const,
    successorRefs: ['goal'],
  }));
}

describe('Plan obligation continuity', () => {
  test('serial successor creation fails before predecessor supersession when obligations are uncovered', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    expect(listUnresolvedPlanObligations(predecessor).length).toBeGreaterThan(0);

    expect(() => admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
    })).toThrow('PLAN_OBLIGATION_CONTINUITY_REQUIRED');

    expect(getPlanContract(options, predecessor.planId)?.status).toBe('draft');
    expect(getPlanContract(options, 'PLAN-R2')).toBeUndefined();
  });

  test('explicit coverage allows serial replanning and preserves the supersession edge', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    const admitted = admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: successorDispositions(predecessor),
    });

    expect(admitted.plan?.planId).toBe('PLAN-R2');
    expect(admitted.plan?.supersedes).toEqual(['PLAN-R1']);
    expect(getPlanContract(options, 'PLAN-R1')).toMatchObject({ status: 'superseded', supersededBy: 'PLAN-R2' });
    expect(admitted.plan?.obligationDispositions?.length).toBe(listUnresolvedPlanObligations(predecessor).length);
  });

  test('coverage cannot point at invented successor locations', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    const dispositions = successorDispositions(predecessor);
    dispositions[0] = { ...dispositions[0]!, successorRefs: ['step:not-real'] };

    expect(() => admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    })).toThrow('references unknown successor_ref');
  });

  test('semantic changes, deferrals, and drops require Controller rationale', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    const dispositions = successorDispositions(predecessor);
    dispositions[0] = {
      ...dispositions[0]!,
      disposition: 'change' as const,
      successorRefs: ['goal'],
    };

    expect(() => admitPlanContract(options, {
      ...input('PLAN-R2'),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
      obligationDispositions: dispositions,
    })).toThrow('change requires rationale');
  });

  test('serial Plan replacement immediately retires predecessor-bound Work authority but keeps history', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-work-retirement-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Deliver the requirement through current Plan authority.',
    });
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    createWorkContract(options, {
      workId: 'WORK-R1', repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: 'stage-a',
      mode: 'goal_workloop', objective: 'Execute predecessor Plan stage.', acceptanceCriteria: ['Only current Plan Work remains active.'],
      allowedPaths: ['src/**'], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });

    const admitted = admitPlanContract(options, {
      ...input('PLAN-R2'), planRelation: 'extend', relatedPlanId: predecessor.planId,
      obligationDispositions: successorDispositions(predecessor),
    });
    expect(admitted.plan?.planId).toBe('PLAN-R2');
    expect(getWorkContract(options, 'WORK-R1')).toMatchObject({ status: 'cancelled', phase: 'cleanup', dispatchState: 'terminal' });
    expect(listWorkContracts({ ...options, status: 'active', limit: 20 }).map((work) => work.workId)).not.toContain('WORK-R1');
    expect(listWorkContracts({ ...options, status: 'all', limit: 20 }).map((work) => work.workId)).toContain('WORK-R1');
  });

  test('maintenance retires legacy active Work whose Plan was already terminal', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-plan-work-maintenance-'));
    roots.push(controllerHome);
    const options = { controllerHome, repoId: 'repo-a' };
    createRequirement({ controllerHome }, {
      requirementId: 'REQ-A', title: 'Requirement A', outcomeStatement: 'Keep only current Plan authority executable.',
    });
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    createWorkContract(options, {
      workId: 'WORK-LEGACY', repoId: 'repo-a', requirementId: 'REQ-A', planId: predecessor.planId, planStepId: 'stage-a',
      mode: 'goal_workloop', objective: 'Legacy Work left running by an older Runtime.', acceptanceCriteria: ['Maintenance retires stale authority.'],
      allowedPaths: ['src/**'], forbiddenPaths: [], checks: [], constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const stored = readControlPlaneRecord<typeof predecessor>(controllerHome, 'plan_contract', 'repo-a', predecessor.planId)!;
    writeControlPlaneRecord(controllerHome, {
      namespace: 'plan_contract', scope: 'repo-a', key: predecessor.planId, schemaVersion: 1,
      value: { ...stored.value, status: 'cancelled' as const, updatedAt: '2026-09-04T00:00:00.000Z' },
      action: 'test_legacy_terminal_plan', expectedRevision: stored.revision,
    });

    expect(retireTerminalPlanBoundWorkAuthorities(options)).toEqual(['WORK-LEGACY']);
    expect(getWorkContract(options, 'WORK-LEGACY')).toMatchObject({ status: 'cancelled', dispatchState: 'terminal', phase: 'cleanup' });
    expect(retireTerminalPlanBoundWorkAuthorities(options)).toEqual([]);
  });
});
