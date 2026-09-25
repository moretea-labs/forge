import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { backupControlPlaneDatabase, restoreControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { createRequirement, readRequirement, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { createWorkContract, listWorkContracts, recordWorkCompletionReceipt, recordWorkEvidenceState, recordWorkImplementationReview, requestWorkImplementationReview, supersedeWorkContract, transitionWorkContractPhase, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../packages/kernel/work/api/index';
import { executionPlacement, scopeRef, semanticRecordMetadata } from '../../packages/kernel/identity/api/index';
import { createPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { buildRequirementBoard } from '../../src/runtime/control-plane/facade/requirement-board';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('keeps user Requirement lifecycle separate from its active technical plan', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const options = { controllerHome: home, now: () => '2026-08-02T00:00:00.000Z' };
  const requirement = createRequirement(options, {
    requirementId: 'req-1',
    title: 'Restore service safely',
    outcomeStatement: 'The service remains available after supervisor restart.',
    acceptanceCriteria: ['health endpoint is available'],
  });
  expect(requirement.state).toBe('planned');

  expect(requirement.activePlanId).toBeUndefined();

  const active = updateRequirement(options, {
    requirementId: 'req-1',
    action: 'requirement_activated',
    mutate: (current) => ({ ...current, state: 'active' }),
  });
  expect(active.state).toBe('active');
  expect(active.revision).toBe(2);
  expect(readRequirement(options, 'req-1')?.revision).toBe(2);
});

test('derives multiple active Plan slices from Plan.requirementId without a mutable Requirement pointer', () => { const home = mkdtempSync(join('/tmp', 'forge-requirement-')); homes.push(home); const requirementOptions = { controllerHome: home }; createRequirement(requirementOptions, { requirementId: 'req-derived-plans', title: 'Derived plan slices', outcomeStatement: 'Plan relationships are queried from Plan.requirementId.' }); const planOptions = { controllerHome: home, repoId: 'repo-derived-plans' }; for (const [planId, scopeKey] of [['plan-a', 'slice-a'], ['plan-b', 'slice-b']] as const) createPlanContract(planOptions, { planId, repoId: 'repo-derived-plans', requirementId: 'req-derived-plans', scopeKey, sourceRevision: 'revision-a', goal: `Deliver ${scopeKey}`, steps: [{ id: 'step-1', objective: 'Implement slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: [], acceptanceCriteria: [] }] }); expect(readRequirement(requirementOptions, 'req-derived-plans')?.value.activePlanId).toBeUndefined(); const board = buildRequirementBoard({ controllerHome: home, repoId: 'repo-derived-plans' }) as { requirements: Array<{ requirementId: string; activePlanId?: string; activePlanIds: string[] }> }; const item = board.requirements.find((entry) => entry.requirementId === 'req-derived-plans'); expect(item?.activePlanIds).toEqual(['plan-b', 'plan-a']); expect(item?.activePlanId).toBe('plan-b'); });

test('keeps superseded Work as durable history while removing it from the current active view', () => {
  const home = mkdtempSync(join('/tmp', 'forge-work-lineage-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-work-lineage' };
  const make = (workId: string) => createWorkContract(options, {
    workId,
    repoId: options.repoId,
    mode: 'goal_workloop',
    objective: `Deliver ${workId}`,
    acceptanceCriteria: [],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'running',
  });
  make('work-lineage-old');
  make('work-lineage-new');

  const linked = supersedeWorkContract(options, {
    workId: 'work-lineage-old',
    supersededBy: 'work-lineage-new',
    reason: 'same-root successor verified',
  });
  expect(linked.predecessor).toMatchObject({
    status: 'running',
    supersededBy: 'work-lineage-new',
    supersessionReason: 'same-root successor verified',
  });
  expect(linked.successor.supersedes).toEqual(['work-lineage-old']);
  expect(listWorkContracts({ ...options, status: 'active' }).map((work) => work.workId)).toEqual(['work-lineage-new']);
  expect(listWorkContracts({ ...options, status: 'all' }).map((work) => work.workId).sort()).toEqual(['work-lineage-new', 'work-lineage-old']);
  make('work-lineage-other');
  expect(() => supersedeWorkContract(options, {
    workId: 'work-lineage-old',
    supersededBy: 'work-lineage-other',
    reason: 'conflicting replacement',
  })).toThrow('WORK_SUPERSESSION_CONFLICT');
  supersedeWorkContract(options, {
    workId: 'work-lineage-new',
    supersededBy: 'work-lineage-other',
    reason: 'new successor verified',
  });
  expect(() => supersedeWorkContract(options, {
    workId: 'work-lineage-other',
    supersededBy: 'work-lineage-old',
    reason: 'must reject transitive cycle',
  })).toThrow('WORK_SUPERSESSION_CYCLE');
});

test('rejects reopening a completed Requirement without an explicit replacement state', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-2', title: 'Outcome', outcomeStatement: 'Outcome statement' });
  updateRequirement(options, { requirementId: 'req-2', action: 'activate', mutate: (current) => ({ ...current, state: 'active' }) });
  updateRequirement(options, { requirementId: 'req-2', action: 'complete', mutate: (current) => ({ ...current, state: 'done' }) });
  expect(() => updateRequirement(options, { requirementId: 'req-2', action: 'reopen', mutate: (current) => ({ ...current, state: 'active' }) })).toThrow(/REQUIREMENT_STATE_TRANSITION_INVALID/);
});

test('restores a verified SQLite backup without losing Requirement authority', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const backup = join(home, 'backup.sqlite');
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-backup', title: 'Backup', outcomeStatement: 'Restore this state' });
  backupControlPlaneDatabase(home, backup);
  updateRequirement(options, { requirementId: 'req-backup', action: 'activate', mutate: (current) => ({ ...current, state: 'active' }) });
  restoreControlPlaneDatabase(home, backup);
  expect(readRequirement(options, 'req-backup')?.value.state).toBe('planned');
});

test('historical cancelled Work evidence cannot reopen a reviewed Requirement outcome', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const options = { controllerHome: home, now: () => '2026-08-02T00:00:00.000Z' };
  createRequirement(options, { requirementId: 'req-reviewed', title: 'Reviewed outcome', outcomeStatement: 'The reviewed outcome remains done.' });
  updateRequirement(options, { requirementId: 'req-reviewed', action: 'activate', mutate: (current) => ({ ...current, state: 'active' }) });
  updateRequirement(options, { requirementId: 'req-reviewed', action: 'reviewed_done', mutate: (current) => ({ ...current, state: 'done' }) });

  const work = createWorkContract({ controllerHome: home, repoId: 'repo-reviewed' }, {
    workId: 'work-historical-cancelled',
    repoId: 'repo-reviewed',
    requirementId: 'req-reviewed',
    mode: 'goal_workloop',
    objective: 'Historical attempt retained for evidence.',
    acceptanceCriteria: [],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    status: 'cancelled',
  });
  expect(work.status).toBe('cancelled');
  expect(work.completionReceipt).toBeUndefined();
  expect(readRequirement(options, 'req-reviewed')?.value.state).toBe('done');
  expect(() => updateRequirement(options, {
    requirementId: 'req-reviewed',
    action: 'stale_run_reopen',
    mutate: (current) => ({ ...current, state: 'active' }),
  })).toThrow(/REQUIREMENT_STATE_TRANSITION_INVALID/);

  const retained = recordWorkEvidenceState({ controllerHome: home, repoId: 'repo-reviewed' }, work.workId, 'failed');
  expect(retained.status).toBe('cancelled');
  expect(readRequirement(options, 'req-reviewed')?.value.state).toBe('done');
});


test('keeps portable semantic scope separate from local execution placement', () => {
  const scope = scopeRef('requirement', 'REQ-portable');
  const placement = executionPlacement({ forgeInstanceId: 'forge-mac', repositoryId: 'repo-local', checkoutId: 'checkout-local' });
  const metadata = semanticRecordMetadata({
    scope,
    revision: 7,
    updatedAt: '2026-09-02T00:00:00.000Z',
    origin: 'local',
    forgeInstanceId: 'forge-mac',
    sourceRevision: 'abc123',
  });
  expect(scope).toEqual({ schemaVersion: 1, kind: 'requirement', id: 'REQ-portable' });
  expect(placement).toEqual({ schemaVersion: 1, forgeInstanceId: 'forge-mac', repositoryId: 'repo-local', checkoutId: 'checkout-local' });
  expect(metadata.scope).toEqual(scope);
  expect(metadata.revision).toBe(7);
  expect(() => semanticRecordMetadata({ ...metadata, revision: -1 })).toThrow(/SEMANTIC_RECORD_REVISION_INVALID/);
});
