import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import {
  admitPlanContract,
  approvePlanContract,
  createPlanContract,
  getPlanContract,
  listUnresolvedPlanObligations,
  type CreatePlanContractInput,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import { createWorkContract, getWorkContract } from '../../packages/kernel/work/api/index';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), 'forge-plan-thin-authority-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  return { controllerHome, repoId: 'repo-a' };
}

function input(planId: string, overrides: Partial<CreatePlanContractInput> = {}): CreatePlanContractInput {
  return {
    planId,
    repoId: 'repo-a',
    scopeKey: 'kernel-v2',
    sourceRevision: 'revision-a',
    goal: `${planId} keeps Plan content descriptive.`,
    nonGoals: [],
    assumptions: [],
    resolvedDecisions: [],
    stopConditions: [],
    replanConditions: [],
    steps: [{
      id: 'stage-a',
      objective: 'Converge one bounded architecture slice.',
      dependencies: [],
      authoritativeFiles: ['src/runtime/example.ts'],
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: ['package:check:type'],
      acceptanceCriteria: ['The architecture slice keeps one writer.'],
    }],
    ...overrides,
  };
}

describe('thin Plan authority', () => {
  test('keeps predecessor obligations readable without making them an admission or revision gate', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-R1'));
    approvePlanContract(options, predecessor.planId);
    expect(listUnresolvedPlanObligations(predecessor).length).toBeGreaterThan(0);

    // No obligation disposition is supplied: continuity must not decide admission.
    const admitted = admitPlanContract(options, {
      ...input('PLAN-R2', { sourceRevision: 'revision-b' }),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
    });
    expect(admitted).toMatchObject({ admissionDecision: 'reuse_existing' });
    const staged = getPlanContract(options, predecessor.planId)!;
    expect(staged.status).toBe('replanning');
    expect(staged.pendingRevision?.revision).toBe(2);
    expect(staged.pendingRevision?.obligationDispositions ?? []).toHaveLength(0);

    const approved = approvePlanContract(options, predecessor.planId);
    expect(approved).toMatchObject({ planId: predecessor.planId, revision: 2, status: 'approved' });
    // Authored Plan item progress is untouched by admission, revision or approval.
    expect(approved.steps[0]).toMatchObject({ id: 'stage-a', status: 'pending' });
    expect(approved.steps[0]?.workId).toBeUndefined();
  });

  test('never lets Plan approval, revision or supersession rewrite a bound Work', () => {
    const options = store();
    const predecessor = createPlanContract(options, input('PLAN-WORK-R1'));
    approvePlanContract(options, predecessor.planId);
    createWorkContract(options, {
      workId: 'work-plan-bound',
      repoId: options.repoId,
      planId: predecessor.planId,
      planStepId: 'stage-a',
      planSourceRevision: predecessor.sourceRevision,
      baseRevision: predecessor.sourceRevision,
      mode: 'goal_workloop',
      workKind: 'repository_change',
      objective: predecessor.steps[0]!.objective,
      acceptanceCriteria: predecessor.steps[0]!.acceptanceCriteria,
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      checks: ['package:check:type'],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      status: 'running',
    });
    const before = getWorkContract(options, 'work-plan-bound')!;

    // A revision that changes the authored paths and acceptance criteria must not
    // refresh, retire or re-scope the Work that records this Plan as provenance.
    admitPlanContract(options, {
      ...input('PLAN-WORK-R2', {
        sourceRevision: 'revision-b',
        steps: [{
          id: 'stage-a',
          objective: 'Converge one bounded architecture slice.',
          dependencies: [],
          authoritativeFiles: ['src/runtime/example.ts'],
          allowedPaths: ['src/other/**'],
          forbiddenPaths: [],
          checks: ['package:check:type'],
          acceptanceCriteria: ['A different authored criterion.'],
        }],
      }),
      planRelation: 'extend',
      relatedPlanId: predecessor.planId,
    });
    approvePlanContract(options, predecessor.planId);

    expect(getWorkContract(options, 'work-plan-bound')).toEqual(before);
    const plan = getPlanContract(options, predecessor.planId)!;
    expect(plan.revision).toBe(2);
    expect(plan.steps[0]).toMatchObject({ allowedPaths: ['src/other/**'], status: 'pending' });
    expect(plan.steps[0]?.workId).toBeUndefined();
  });
});
