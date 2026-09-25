import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  admitPlanContract,
  approvePlanContract,
  createPlanContract,
  getPlanContract,
  listPlanContracts,
  listUnresolvedPlanObligations,
  repairDraftPlanContract,
  listPlanRevisionRecords,
  supersedePlanContract,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  ControlPlaneConflictError,
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { createWorkContract, getWorkContract, updateWorkContract } from '../../packages/kernel/work/api/index';

const homes: string[] = [];

function keepAllPlanObligations(plan: Parameters<typeof listUnresolvedPlanObligations>[0]) {
  return listUnresolvedPlanObligations(plan).map((obligation) => ({
    predecessorPlanId: plan.planId,
    obligationId: obligation.obligationId,
    disposition: 'keep' as const,
    successorRefs: [obligation.sourceRef],
  }));
}

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
  createPlanContract(options, {
    planId: 'plan-2',
    repoId: 'repo-1',
    scopeKey: 'runtime-sibling',
    sourceRevision: 'abc123',
    goal: 'preserve sibling authority',
    steps: [{ id: 'step-2', objective: 'remain unchanged', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['revision remains stable'] }],
  });

  expect(getPlanContract(options, 'plan-1')).toEqual(plan);
  expect(listPlanContracts({ ...options, status: 'all' })).toHaveLength(2);
  expect(listControlPlaneRecords(options.controllerHome, { namespace: 'plan_contract', scope: 'repo-1' })).toHaveLength(2);

  const approved = approvePlanContract(options, 'plan-1');
  expect(approved.status).toBe('approved');
  // Approval is Plan identity bookkeeping; authored Plan item progress is never
  // promoted by Forge.
  expect(approved.steps[0]?.status).toBe('pending');
  expect(readControlPlaneRecord(options.controllerHome, 'plan_contract', 'repo-1', 'plan-1')?.revision).toBe(2);
  expect(readControlPlaneRecord(options.controllerHome, 'plan_contract', 'repo-1', 'plan-2')?.revision).toBe(1);
});

test('persists Work contracts as independent SQLite rows without sibling revision fan-out', () => {
  const home = mkdtempSync(join('/tmp', 'forge-work-store-row-delta-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-work-row-delta', now: () => '2026-09-11T00:00:00.000Z' };
  for (const workId of ['work-1', 'work-2']) {
    createWorkContract(options, {
      workId, repoId: options.repoId, mode: 'goal_workloop', objective: `deliver ${workId}`,
      acceptanceCriteria: ['deliver independently'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
  }

  expect(readControlPlaneRecord(home, 'work_contract', options.repoId, 'work-1')?.revision).toBe(1);
  expect(readControlPlaneRecord(home, 'work_contract', options.repoId, 'work-2')?.revision).toBe(1);
  updateWorkContract(options, 'work-1', { objective: 'deliver work-1 with updated metadata' });
  expect(readControlPlaneRecord(home, 'work_contract', options.repoId, 'work-1')?.revision).toBe(2);
  expect(readControlPlaneRecord(home, 'work_contract', options.repoId, 'work-2')?.revision).toBe(1);
});

test('repairs a legacy malformed draft in place without replacing Plan authority', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-draft-repair-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-draft-repair', now: () => '2026-08-28T00:00:00.000Z' };
  const legacy = {
    schemaVersion: 1 as const,
    planId: 'plan-legacy-malformed',
    repoId: options.repoId,
    scopeKey: 'legacy-scope',
    sourceRevision: '',
    goal: '',
    nonGoals: [], assumptions: [], resolvedDecisions: [], stopConditions: [], replanConditions: [],
    status: 'draft' as const,
    steps: [], evidenceRefs: [{ title: 'legacy evidence' }],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
  writeControlPlaneRecord(home, { namespace: 'plan_contract', scope: options.repoId, key: legacy.planId, schemaVersion: 1, value: legacy, expectedRevision: null, action: 'seed_legacy_malformed_draft' });

  const repaired = repairDraftPlanContract(options, legacy.planId, {
    scopeKey: 'legacy-scope',
    sourceRevision: '101a8920',
    goal: 'Repair the existing Plan authority rather than creating a second Plan.',
    steps: [{ id: 'repair', objective: 'restore a reviewable Plan draft', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['same Plan identity is approvable'] }],
  });

  expect(repaired).toMatchObject({
    planId: legacy.planId,
    repoId: options.repoId,
    scopeKey: 'legacy-scope',
    sourceRevision: '101a8920',
    status: 'draft',
    createdAt: legacy.createdAt,
    evidenceRefs: legacy.evidenceRefs,
  });
  expect(listPlanContracts({ ...options, status: 'all' })).toHaveLength(1);
  expect(() => repairDraftPlanContract(options, legacy.planId, {
    expectedSourceRevision: 'stale-source',
    scopeKey: legacy.scopeKey,
    sourceRevision: 'newer-source',
    goal: 'A stale controller must not overwrite the current draft.',
    steps: [{ id: 'repair', objective: 'reject stale writer', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['stale source is fenced'] }],
  })).toThrow(`PLAN_DRAFT_REPAIR_STALE_SOURCE: ${legacy.planId}:expected=stale-source:actual=101a8920`);
  expect(getPlanContract(options, legacy.planId)?.sourceRevision).toBe('101a8920');
  expect(approvePlanContract(options, legacy.planId).status).toBe('approved');
  expect(() => repairDraftPlanContract(options, legacy.planId, {
    scopeKey: 'legacy-scope', sourceRevision: 'later', goal: 'must not rewrite approved authority',
    steps: [{ id: 'repair', objective: 'invalid', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['never runs'] }],
  })).toThrow(`PLAN_DRAFT_REPAIR_STATUS_INVALID: ${legacy.planId}:approved`);
});

test('rejects an incomplete draft repair before mutating the existing Plan authority', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-draft-repair-invalid-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-draft-repair-invalid', now: () => '2026-08-28T00:00:00.000Z' };
  const plan = createPlanContract(options, {
    planId: 'plan-incomplete-repair', repoId: options.repoId, scopeKey: 'repair-scope', sourceRevision: '', goal: '', steps: [],
  });

  expect(() => repairDraftPlanContract(options, plan.planId, {
    scopeKey: plan.scopeKey, sourceRevision: '', goal: '', steps: [],
  })).toThrow('PLAN_DRAFT_REPAIR_INVALID: source_revision is required; goal is required; at least one plan step is required');
  expect(getPlanContract(options, plan.planId)).toMatchObject({
    planId: plan.planId,
    sourceRevision: '',
    goal: '',
    steps: [],
    status: 'draft',
  });
});

test('rejects a dangling Requirement reference before Plan persistence', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-requirement-integrity-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-requirement-integrity' };
  expect(() => createPlanContract(options, {
    planId: 'plan-missing-requirement',
    repoId: options.repoId,
    requirementId: 'REQ-missing',
    scopeKey: 'missing-requirement',
    sourceRevision: 'abc123',
    goal: 'Never persist dangling Requirement authority',
    steps: [{ id: 'step-a', objective: 'do not execute', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['Requirement exists'] }],
  })).toThrow(/PLAN_REQUIREMENT_NOT_FOUND: REQ-missing/);
  expect(listPlanContracts({ ...options, status: 'all' })).toHaveLength(0);
});

test('fails closed when a legacy Plan gains a dangling Requirement before approval', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-legacy-requirement-integrity-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-legacy-requirement-integrity' };
  const plan = createPlanContract(options, {
    planId: 'plan-legacy-requirement',
    repoId: options.repoId,
    scopeKey: 'legacy-requirement',
    sourceRevision: 'abc123',
    goal: 'Preserve a legacy Plan but never execute dangling Requirement authority',
    steps: [{ id: 'step-a', objective: 'do not execute', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['Requirement exists'] }],
  });
  const draftRecord = readControlPlaneRecord<typeof plan>(home, 'plan_contract', options.repoId, plan.planId)!;
  writeControlPlaneRecord(home, {
    namespace: 'plan_contract', scope: options.repoId, key: plan.planId, schemaVersion: 1,
    value: { ...plan, requirementId: 'REQ-legacy-missing' }, expectedRevision: draftRecord.revision, action: 'seed_legacy_dangling_requirement',
  });
  expect(() => approvePlanContract(options, plan.planId)).toThrow(/PLAN_REQUIREMENT_NOT_FOUND: REQ-legacy-missing/);
  // Plan state is not consulted by Work execution, so a dangling legacy
  // Requirement reference cannot become an execution gate either.
  expect(getPlanContract(options, plan.planId)?.status).toBe('draft');
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
  createRequirement({ controllerHome: home }, { requirementId: 'REQ-race', title: 'Race authority', outcomeStatement: 'Exactly one Plan owns the shared requirement scope.' });
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

test('same-Requirement distinct scopes coexist while exact scope remains single-owner', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-relation-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-relation' };
  createRequirement({ controllerHome: home }, { requirementId: 'REQ-relation', title: 'Relation authority', outcomeStatement: 'Requirement is portfolio ownership while Plan scope is semantic authority.' });
  const base = {
    repoId: 'repo-relation', requirementId: 'REQ-relation', sourceRevision: 'revision-a', goal: 'Deliver a Requirement slice',
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
  };
  const primaryAdmission = admitPlanContract(options, { ...base, planId: 'plan-primary', scopeKey: 'primary-scope' });
  expect(primaryAdmission).toMatchObject({ admissionDecision: 'create_new', plan: { planId: 'plan-primary' } });
  const second = admitPlanContract(options, { ...base, planId: 'plan-second', scopeKey: 'second-scope' });
  expect(second).toMatchObject({ admissionDecision: 'create_new', plan: { planId: 'plan-second' } });
  const duplicate = admitPlanContract(options, { ...base, planId: 'plan-primary-duplicate', scopeKey: 'primary-scope' });
  expect(duplicate).toMatchObject({ admissionDecision: 'reuse_existing', reason: 'exact_scope_authority', plan: { planId: 'plan-primary' } });

  const primary = getPlanContract(options, 'plan-primary')!;
  const extended = admitPlanContract(options, {
    ...base,
    planId: 'plan-extended',
    scopeKey: 'extended-scope',
    planRelation: 'extend',
    relatedPlanId: 'plan-primary',
    obligationDispositions: keepAllPlanObligations(primary),
  });
  expect(extended).toMatchObject({ admissionDecision: 'reuse_existing', reason: 'extend_existing', plan: { planId: 'plan-primary', revision: 1, status: 'draft', scopeKey: 'extended-scope' } });
  expect(getPlanContract(options, 'plan-extended')).toBeUndefined();

  const parallel = admitPlanContract(options, { ...base, planId: 'plan-parallel', scopeKey: 'parallel-scope', planRelation: 'parallel' });
  expect(parallel).toMatchObject({ admissionDecision: 'create_new', plan: { planId: 'plan-parallel' } });
  const duplicateParallel = admitPlanContract(options, { ...base, planId: 'plan-parallel-duplicate', scopeKey: 'parallel-scope', planRelation: 'parallel' });
  expect(duplicateParallel).toMatchObject({ admissionDecision: 'reuse_existing', plan: { planId: 'plan-parallel' } });
  expect(listPlanContracts({ ...options, status: 'active' }).map((plan) => plan.planId).sort()).toEqual(['plan-parallel', 'plan-primary', 'plan-second']);
});

test('stages and approves a committed Plan revision without creating a successor Plan entity', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-atomic-replan-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-atomic-replan' };
  const base = {
    repoId: options.repoId,
    scopeKey: 'release-scope',
    sourceRevision: 'revision-a',
    goal: 'Release safely',
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
  };
  const created = admitPlanContract(options, { ...base, planId: 'plan-r1' }).plan!;
  const committed = approvePlanContract(options, created.planId);
  expect(committed).toMatchObject({ planId: 'plan-r1', revision: 1, status: 'approved' });
  const staged = admitPlanContract(options, {
    ...base,
    planId: 'plan-r2',
    sourceRevision: 'revision-b',
    planRelation: 'extend',
    relatedPlanId: committed.planId,
    obligationDispositions: keepAllPlanObligations(committed),
  });
  expect(staged).toMatchObject({
    admissionDecision: 'reuse_existing',
    reason: 'extend_existing',
    plan: { planId: 'plan-r1', revision: 1, status: 'replanning', pendingRevision: { revision: 2, requestedRevisionLabel: 'plan-r2', sourceRevision: 'revision-b' } },
  });
  expect(getPlanContract(options, 'plan-r2')).toBeUndefined();
  expect(listPlanContracts({ ...options, status: 'active' }).map((plan) => plan.planId)).toEqual(['plan-r1']);

  const revised = approvePlanContract(options, committed.planId);
  expect(revised).toMatchObject({ planId: 'plan-r1', revision: 2, sourceRevision: 'revision-b', status: 'approved' });
  expect(revised.pendingRevision).toBeUndefined();
  expect(listPlanRevisionRecords(options, committed.planId)).toEqual([expect.objectContaining({ planId: 'plan-r1', revision: 1, sourceRevision: 'revision-a', requestedRevisionLabel: 'plan-r2' })]);
});


test('repeated committed replans advance one stable Plan while revision history grows only as audit', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-revision-cardinality-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-revision-cardinality' };
  const base = {
    repoId: options.repoId,
    scopeKey: 'one-semantic-scope',
    sourceRevision: 'revision-1',
    goal: 'Keep one durable Plan authority through repeated replanning.',
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
  };
  let current = approvePlanContract(options, admitPlanContract(options, { ...base, planId: 'plan-stable' }).plan!.planId);
  expect(current).toMatchObject({ planId: 'plan-stable', revision: 1, status: 'approved' });

  for (let revision = 2; revision <= 4; revision += 1) {
    const requestedLabel = `plan-legacy-r${revision}`;
    const staged = admitPlanContract(options, {
      ...base,
      planId: requestedLabel,
      sourceRevision: `revision-${revision}`,
      planRelation: 'extend',
      relatedPlanId: current.planId,
      obligationDispositions: keepAllPlanObligations(current),
    });
    expect(staged).toMatchObject({
      admissionDecision: 'reuse_existing',
      reason: 'extend_existing',
      plan: { planId: 'plan-stable', status: 'replanning', pendingRevision: { revision, requestedRevisionLabel: requestedLabel } },
    });
    expect(getPlanContract(options, requestedLabel)).toBeUndefined();
    expect(listPlanContracts({ ...options, status: 'active' }).map((plan) => plan.planId)).toEqual(['plan-stable']);
    current = approvePlanContract(options, 'plan-stable');
    expect(current).toMatchObject({ planId: 'plan-stable', revision, sourceRevision: `revision-${revision}` });
  }

  expect(listPlanContracts({ ...options, status: 'active' })).toHaveLength(1);
  expect(listPlanContracts({ ...options, status: 'all' })).toHaveLength(1);
  expect(listPlanRevisionRecords(options, 'plan-stable').map((record) => record.revision)).toEqual([3, 2, 1]);
  expect(listPlanRevisionRecords(options, 'plan-stable').map((record) => record.requestedRevisionLabel)).toEqual([
    'plan-legacy-r4',
    'plan-legacy-r3',
    'plan-legacy-r2',
  ]);
});



test('does not allow cancelled Plans to become extension predecessors', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-cancelled-predecessor-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-cancelled-predecessor' };
  const base = {
    repoId: options.repoId,
    scopeKey: 'release-scope',
    sourceRevision: 'revision-a',
    goal: 'Remain terminal after cancellation',
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
  };
  createPlanContract(options, { ...base, planId: 'plan-cancelled' });
  const record = readControlPlaneRecord<any>(home, 'plan_contract', options.repoId, 'plan-cancelled')!;
  writeControlPlaneRecord(home, {
    namespace: 'plan_contract', scope: options.repoId, key: 'plan-cancelled', schemaVersion: 1,
    value: { ...record.value, status: 'cancelled' }, expectedRevision: record.revision, action: 'seed_cancelled_plan',
  });
  const blocked = admitPlanContract(options, {
    ...base,
    planId: 'plan-illegal-successor',
    sourceRevision: 'revision-b',
    planRelation: 'extend',
    relatedPlanId: 'plan-cancelled',
    obligationDispositions: keepAllPlanObligations(getPlanContract(options, 'plan-cancelled')!),
  });
  expect(blocked).toMatchObject({ admissionDecision: 'resolution_required', reason: 'extension_target_required' });
  expect(getPlanContract(options, 'plan-illegal-successor')).toBeUndefined();
  expect(getPlanContract(options, 'plan-cancelled')?.status).toBe('cancelled');
  expect(getPlanContract(options, 'plan-cancelled')?.supersededBy).toBeUndefined();
});



test('direct supersession records bidirectional Plan lineage and removes the predecessor from current Plans', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-direct-supersession-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-direct-supersession' };
  const create = (planId: string, scopeKey: string) => createPlanContract(options, {
    planId, repoId: options.repoId, scopeKey, sourceRevision: 'revision-a', goal: `Deliver ${planId}`,
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
  });
  const predecessor = create('plan-direct-old', 'scope-old');
  createPlanContract(options, {
    planId: 'plan-direct-new', repoId: options.repoId, scopeKey: 'scope-new', sourceRevision: 'revision-a', goal: 'Deliver plan-direct-new',
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
    obligationDispositions: keepAllPlanObligations(predecessor),
  });
  supersedePlanContract(options, 'plan-direct-old', 'plan-direct-new', 'replanned_after_drift');
  expect(getPlanContract(options, 'plan-direct-old')).toMatchObject({
    status: 'superseded', supersededBy: 'plan-direct-new', supersessionReason: 'replanned_after_drift',
  });
  expect(getPlanContract(options, 'plan-direct-new')).toMatchObject({ supersedes: ['plan-direct-old'] });
  expect(listPlanContracts({ ...options, status: 'active' }).map((plan) => plan.planId)).toEqual(['plan-direct-new']);
});

test('direct supersession rejects a missing successor without mutating the predecessor', () => {
  const home = mkdtempSync(join('/tmp', 'forge-plan-missing-successor-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-missing-successor' };
  createPlanContract(options, {
    planId: 'plan-current', repoId: options.repoId, scopeKey: 'scope-a', sourceRevision: 'revision-a', goal: 'Stay authoritative',
    steps: [{ id: 'step-a', objective: 'deliver', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['done'] }],
  });
  expect(() => supersedePlanContract(options, 'plan-current', 'plan-does-not-exist')).toThrow('PLAN_SUCCESSOR_NOT_FOUND: plan-does-not-exist');
  expect(getPlanContract(options, 'plan-current')?.status).toBe('draft');
  expect(getPlanContract(options, 'plan-current')?.supersededBy).toBeUndefined();
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



