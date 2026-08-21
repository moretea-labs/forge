import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  admitPlanContract,
  approvePlanContract,
  claimPlanStepForWork,
  acceptPlanStepEvidence,
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

interface ChildResult {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
}

async function runPlanStoreChildren(input: {
  controllerHome: string;
  repoId: string;
  operation: 'admit' | 'approve';
  planIds: [string, string];
  scopeKey: string;
  requirementId?: string;
}): Promise<ChildResult[]> {
  const startFile = join(input.controllerHome, `start-${input.operation}`);
  const moduleUrl = new URL('../../src/runtime/control-plane/facade/plan-contract-store.ts', import.meta.url).href;
  const script = `
    import { existsSync } from 'fs';
    while (!existsSync(process.env.START_FILE)) await Bun.sleep(1);
    const store = await import(process.env.PLAN_STORE_MODULE);
    try {
      const options = { controllerHome: process.env.CONTROLLER_HOME, repoId: process.env.REPO_ID };
      const value = process.env.OPERATION === 'admit'
        ? await store.admitPlanContractAsync(options, {
            planId: process.env.PLAN_ID,
            repoId: process.env.REPO_ID,
            requirementId: process.env.REQUIREMENT_ID || undefined,
            scopeKey: process.env.SCOPE_KEY,
            sourceRevision: 'revision-race',
            goal: 'Race one semantic Plan authority',
            steps: [{ id: 'step-a', objective: 'race', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['one authority'] }],
          })
        : await store.approvePlanContractAsync(options, process.env.PLAN_ID);
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  `;
  const children = input.planIds.map((planId) => spawn(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      START_FILE: startFile,
      PLAN_STORE_MODULE: moduleUrl,
      CONTROLLER_HOME: input.controllerHome,
      REPO_ID: input.repoId,
      OPERATION: input.operation,
      PLAN_ID: planId,
      SCOPE_KEY: input.scopeKey,
      REQUIREMENT_ID: input.requirementId ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  writeFileSync(startFile, 'go\n');
  return await Promise.all(children.map((child) => new Promise<ChildResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Plan-store child exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      if (!line) {
        reject(new Error(`Plan-store child produced no result: ${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as ChildResult);
    });
  })));
}

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

test('atomically admits one canonical Plan for concurrent same-scope callers', async () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-admission-race-'));
  homes.push(home);
  const results = await runPlanStoreChildren({
    controllerHome: home,
    repoId: 'repo-race',
    operation: 'admit',
    planIds: ['plan-race-a', 'plan-race-b'],
    scopeKey: 'shared-scope',
    requirementId: 'REQ-race',
  });
  expect(results.every((entry) => entry.ok)).toBe(true);
  expect(results.map((entry) => (entry.value as { admissionDecision?: string })?.admissionDecision).sort()).toEqual(['create_new', 'reuse_existing']);
  const persisted = listPlanContracts({ controllerHome: home, repoId: 'repo-race', status: 'all' });
  expect(persisted).toHaveLength(1);
  expect(persisted[0]?.scopeKey).toBe('shared-scope');
});

test('requires explicit Requirement relation and permits only distinct-scope parallel Plan slices', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-relation-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-relation' };
  const base = {
    repoId: 'repo-relation',
    requirementId: 'REQ-relation',
    sourceRevision: 'revision-a',
    goal: 'Deliver a Requirement slice',
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
  };
  expect(admitPlanContract(options, { ...base, planId: 'plan-primary', scopeKey: 'primary-scope' }).admissionDecision).toBe('create_new');
  const unresolved = admitPlanContract(options, { ...base, planId: 'plan-second', scopeKey: 'second-scope' });
  expect(unresolved).toMatchObject({ admissionDecision: 'resolution_required', reason: 'requirement_relation_required' });
  const extended = admitPlanContract(options, { ...base, planId: 'plan-extended', scopeKey: 'extended-scope', planRelation: 'extend', relatedPlanId: 'plan-primary' });
  expect(extended).toMatchObject({ admissionDecision: 'extend_existing', plan: { planId: 'plan-primary' } });
  const parallel = admitPlanContract(options, { ...base, planId: 'plan-parallel', scopeKey: 'parallel-scope', planRelation: 'parallel' });
  expect(parallel).toMatchObject({ admissionDecision: 'create_new', plan: { planId: 'plan-parallel' } });
  const duplicateParallel = admitPlanContract(options, { ...base, planId: 'plan-parallel-duplicate', scopeKey: 'parallel-scope', planRelation: 'parallel' });
  expect(duplicateParallel).toMatchObject({ admissionDecision: 'reuse_existing', plan: { planId: 'plan-parallel' } });
});

test('serializes concurrent approval so only one same-scope draft becomes committed', async () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-approval-race-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-approval-race' };
  const create = (planId: string, scopeKey: string) => createPlanContract(options, {
    planId,
    repoId: options.repoId,
    scopeKey,
    sourceRevision: 'revision-approval',
    goal: 'Approve one authority',
    steps: [{ id: 'step-a', objective: 'approve', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['one approval'] }],
  });
  create('plan-approve-a', 'shared-approval-scope');
  const second = create('plan-approve-b', 'temporary-second-scope');
  const secondRecord = readControlPlaneRecord<typeof second>(home, 'plan_contract', options.repoId, second.planId);
  expect(secondRecord).toBeTruthy();
  writeControlPlaneRecord(home, {
    namespace: 'plan_contract',
    scope: options.repoId,
    key: second.planId,
    schemaVersion: 1,
    value: { ...second, scopeKey: 'shared-approval-scope' },
    expectedRevision: secondRecord!.revision,
    action: 'test_same_scope_draft_seed',
  });

  const results = await runPlanStoreChildren({
    controllerHome: home,
    repoId: options.repoId,
    operation: 'approve',
    planIds: ['plan-approve-a', 'plan-approve-b'],
    scopeKey: 'shared-approval-scope',
  });
  expect(results.filter((entry) => entry.ok)).toHaveLength(1);
  const rejected = results.find((entry) => !entry.ok);
  expect(rejected?.error).toContain('active plan already owns scope_key shared-approval-scope');
  const sameScope = listPlanContracts({ ...options, status: 'all' }).filter((plan) => plan.scopeKey === 'shared-approval-scope');
  expect(sameScope.filter((plan) => plan.status === 'approved')).toHaveLength(1);
  expect(sameScope.filter((plan) => plan.status === 'draft')).toHaveLength(1);
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
  expect(failed).toMatchObject({ status: 'replanning', steps: [{ workId: 'work-terminal', status: 'ready' }] });
});

test('projects terminal Work evidence to validating and requires explicit semantic acceptance to complete the PlanStep', () => {
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
  const verifying = completePlanStepForWork(options, {
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
  expect(verifying).toMatchObject({ status: 'verifying', steps: [{ workId: 'work-receipt', status: 'validating' }] });
  expect(() => acceptPlanStepEvidence(options, { planId: 'plan-work-receipt', stepId: 'step-1', reviewer: '', rationale: 'looks good' })).toThrow(/PLAN_STEP_SEMANTIC_ACCEPTANCE_METADATA_REQUIRED/);
  const accepted = acceptPlanStepEvidence(options, { planId: 'plan-work-receipt', stepId: 'step-1', reviewer: 'chatgpt', rationale: 'Acceptance criteria reviewed against Work evidence.' });
  expect(accepted).toMatchObject({ status: 'finalized', steps: [{ workId: 'work-receipt', status: 'completed' }] });
  expect(accepted.steps[0]?.evidenceRefs[0]?.title).toBe('semantic acceptance');
});
