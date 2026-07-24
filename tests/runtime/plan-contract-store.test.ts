import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  approvePlanContract,
  createPlanContract,
  getPlanContract,
  listPlanContracts,
  supersedePlanContract,
} from '../../src/runtime/control-plane/facade/plan-contract-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-plan-contract-'));
  roots.push(root);
  return { root, now: () => '2026-07-24T00:00:00.000Z' };
}

function input(overrides: Partial<Parameters<typeof createPlanContract>[1]> = {}) {
  return {
    planId: 'plan-facade-routing',
    repoId: 'repo-test',
    scopeKey: 'src/runtime/gateway/mcp',
    sourceRevision: 'abc123',
    goal: 'Make complex work planning durable',
    stopConditions: ['Stop when scope expands outside the facade.'],
    replanConditions: ['Replan if the source revision changes.'],
    steps: [{
      id: 'inspect',
      objective: 'Inspect the existing facade.',
      dependencies: [],
      authoritativeFiles: ['src/runtime/gateway/mcp/runtime-tools.ts'],
      allowedPaths: ['src/runtime/'],
      forbiddenPaths: ['_ops/'],
      checks: ['package:check:type'],
      acceptanceCriteria: ['The plan is stored and can be approved.'],
    }],
    ...overrides,
  };
}

describe('PlanContract store', () => {
  test('requires a caller-provided plan id', () => {
    const options = store();
    expect(() => createPlanContract(options, input({ planId: '' }))).toThrow('plan_id is required');
  });

  test('approves a complete draft and preserves its frozen source revision', () => {
    const options = store();
    const draft = createPlanContract(options, input());
    const approved = approvePlanContract(options, draft.planId);

    expect(approved).toMatchObject({ status: 'approved', sourceRevision: 'abc123' });
    expect(getPlanContract(options, draft.planId)?.steps[0]).toMatchObject({ status: 'pending' });
  });

  test('rejects incomplete plans, duplicate steps, and invalid dependencies at approval', () => {
    const options = store();
    const incomplete = createPlanContract(options, input({
      planId: 'plan-incomplete',
      sourceRevision: '',
      steps: [
        { ...input().steps[0], id: 'duplicate', checks: [], acceptanceCriteria: [] },
        { ...input().steps[0], id: 'duplicate', dependencies: ['missing-step'] },
      ],
    }));

    expect(() => approvePlanContract(options, incomplete.planId)).toThrow(/source_revision.*duplicate.*missing-step/i);
  });

  test('prevents overlapping active scopes and allows a replacement after supersession', () => {
    const options = store();
    const first = createPlanContract(options, input());
    approvePlanContract(options, first.planId);
    const second = createPlanContract(options, input({ planId: 'plan-facade-routing-v2' }));

    expect(() => approvePlanContract(options, second.planId)).toThrow(/active plan already owns scope_key/i);
    supersedePlanContract(options, first.planId, second.planId);
    expect(approvePlanContract(options, second.planId).status).toBe('approved');
    expect(listPlanContracts({ ...options, status: 'active' }).map((plan) => plan.planId)).toEqual([second.planId]);
  });

  test('does not permit operations on terminal plans', () => {
    const options = store();
    const plan = createPlanContract(options, input());
    supersedePlanContract(options, plan.planId, 'replacement-plan');

    expect(() => approvePlanContract(options, plan.planId)).toThrow(/cannot be approved from superseded/i);
    expect(() => supersedePlanContract(options, plan.planId, 'another-plan')).toThrow(/is terminal/i);
  });
});
