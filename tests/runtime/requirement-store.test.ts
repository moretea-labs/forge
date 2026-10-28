import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { backupControlPlaneDatabase, restoreControlPlaneDatabase, withControlPlaneTransaction, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { createRequirement, normalizeLegacyRequirementAcceptance, readRequirement, reviseRequirementSemantic, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { cancelWorkContract, createWorkContract, listWorkContracts, recordWorkCompletionReceipt, recordWorkEvidenceState, recordWorkImplementationReview, supersedeWorkContract, transitionWorkContractPhase, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../packages/kernel/work/api/index';
import { executionPlacement, scopeRef, semanticRecordMetadata } from '../../packages/kernel/identity/api/index';
import { createPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { buildRequirementBoard } from '../../src/runtime/control-plane/facade/requirement-board';
import { forgeWorkflowSupervisorValidators } from '../../supervisor/forge-validators';
import type { WorkflowSupervisorTask, WorkflowSupervisorProposal } from '../../supervisor/types';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createCancelledWork(
  options: Parameters<typeof createWorkContract>[0],
  input: Parameters<typeof createWorkContract>[1],
) {
  const created = createWorkContract(options, input);
  return cancelWorkContract(options, created.workId, { summary: 'test fixture semantic cancellation' });
}

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
    objective: `Deliver ${workId}`,
    acceptanceCriteria: [],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: {},
    requestedBy: 'chatgpt',
    dispatchState: 'running',
  });
  make('work-lineage-old');
  make('work-lineage-new');

  const linked = supersedeWorkContract(options, {
    workId: 'work-lineage-old',
    supersededBy: 'work-lineage-new',
    reason: 'same-root successor verified',
  });
  expect(linked.predecessor).toMatchObject({
    semanticState: 'open',
    dispatchState: 'running',
    supersededBy: 'work-lineage-new',
    supersessionReason: 'same-root successor verified',
  });
  expect(linked.successor.supersedes).toEqual(['work-lineage-old']);
  expect(listWorkContracts({ ...options, state: 'active' }).map((work) => work.workId)).toEqual(['work-lineage-new']);
  expect(listWorkContracts({ ...options, state: 'all' }).map((work) => work.workId).sort()).toEqual(['work-lineage-new', 'work-lineage-old']);
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

test('rejects reopening a completed Requirement without an explicit replacement state', async () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-2', title: 'Outcome', outcomeStatement: 'Outcome statement' });
  updateRequirement(options, { requirementId: 'req-2', action: 'activate', mutate: (current) => ({ ...current, state: 'active' }) });
  expect(() => updateRequirement(options, { requirementId: 'req-2', action: 'complete', mutate: (current) => ({ ...current, state: 'done' }) }))
    .toThrow(/REQUIREMENT_STATE_TRANSITION_INVALID/);
  reviseRequirementSemantic(options, 'req-2', { expectedRevision: 1, state: 'completed', remainingWork: [], acceptedEvidenceRefs: ['review:accepted'] });
  expect(() => updateRequirement(options, { requirementId: 'req-2', action: 'cancel_completed', mutate: (current) => ({ ...current, state: 'cancelled' }) }))
    .toThrow(/REQUIREMENT_TERMINAL_IMMUTABLE/);
  const completed = readRequirement(options, 'req-2')!.value;
  expect(() => reviseRequirementSemantic(options, 'req-2', {
    expectedRevision: completed.semanticRevision ?? 2,
    state: 'cancelled',
  })).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_TRANSITION_FORBIDDEN/);
  expect(() => reviseRequirementSemantic(options, 'req-2', {
    expectedRevision: completed.semanticRevision ?? 2,
    outcomeStatement: 'A completed Requirement cannot be rewritten.',
  })).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_IMMUTABLE/);
  expect(() => updateRequirement(options, {
    requirementId: 'req-2', action: 'rewrite_completed',
    mutate: (current) => ({ ...current, outcomeStatement: 'Legacy writer cannot rewrite terminal facts.' }),
  })).toThrow(/REQUIREMENT_TERMINAL_IMMUTABLE/);
  expect(() => updateRequirement(options, { requirementId: 'req-2', action: 'reopen', mutate: (current) => ({ ...current, state: 'active' }) })).toThrow(/REQUIREMENT_TERMINAL_IMMUTABLE/);

  // Persist actual legacy row shapes, then exercise the startup conversion and
  // the same terminal writer guards. No fixture-only acceptance writer survives.
  const acceptance = { reviewer: 'mcp-bearer-client', rationale: 'Fixed candidate independently accepted', planIds: [], acceptedAt: '2026-09-22T06:17:53.399Z' };
  for (const suffix of ['a', 'b', 'unproven']) {
    const legacy = { ...completed, requirementId: `legacy-${suffix}`, acceptedEvidenceRefs: [], semanticAcceptance: suffix === 'unproven' ? { ...acceptance, reviewer: '' } : acceptance };
    writeControlPlaneRecord(home, { namespace: 'requirement', scope: 'controller', key: legacy.requirementId, schemaVersion: 1, value: legacy });
  }
  const before = readRequirement(options, 'legacy-a')!;
  const backup = join(home, 'before-normalization.sqlite');
  backupControlPlaneDatabase(home, backup);
  withControlPlaneTransaction(home, (database) => database.exec("CREATE TRIGGER fail_normalization BEFORE INSERT ON control_plane_audit WHEN NEW.action='requirement_legacy_acceptance_normalized_v1' AND NEW.record_key='legacy-b' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END"));
  expect(() => normalizeLegacyRequirementAcceptance(options)).toThrow('injected migration failure');
  expect(readRequirement(options, 'legacy-a')).toEqual(before);
  withControlPlaneTransaction(home, (database) => database.exec('DROP TRIGGER fail_normalization'));
  expect(normalizeLegacyRequirementAcceptance(options)).toBe(2);
  const migrated = readRequirement(options, 'legacy-a')!;
  expect(migrated.revision).toBe(before.revision);
  expect(migrated.updatedAt).toBe(before.updatedAt);
  expect(migrated.value).toMatchObject({ state: 'done', revision: completed.revision, semanticRevision: completed.semanticRevision, semanticAcceptance: acceptance });
  expect(migrated.value.acceptedEvidenceRefs?.[0]).toMatch(/^requirement:legacy-a:legacy-acceptance:sha256:[a-f0-9]{64}$/);
  expect(readRequirement(options, 'legacy-unproven')?.value.acceptedEvidenceRefs).toEqual([]);
  expect(normalizeLegacyRequirementAcceptance(options)).toBe(0);
  expect(readRequirement(options, 'legacy-a')).toEqual(migrated);
  const task: WorkflowSupervisorTask = { taskId: 'legacy-validation', conversationId: 'legacy-conversation', conversationUrl: 'https://chatgpt.com/c/legacy-conversation', objective: 'Validate migrated completion', createdAt: acceptance.acceptedAt, continuationPolicy: {}, completionContract: { kind: 'model_semantic_completion', controller_home: home, requirement_id: 'legacy-a' }, userBlockerPolicy: {} };
  const proposal: WorkflowSupervisorProposal = { action: 'DONE', sourceEffectId: 'legacy-effect', checkpoint: 'migration verified', reason: 'accepted evidence preserved', evidence: [] };
  expect(await forgeWorkflowSupervisorValidators().completionContract(task, proposal)).toMatchObject({ valid: true, evidence: migrated.value.acceptedEvidenceRefs });
  expect(await forgeWorkflowSupervisorValidators().completionContract({ ...task, completionContract: { ...task.completionContract, requirement_id: 'legacy-unproven' } }, proposal)).toMatchObject({ valid: false, reason: 'requirement_acceptance_evidence_missing' });
  expect(() => reviseRequirementSemantic(options, 'legacy-a', { expectedRevision: completed.semanticRevision!, progressSummary: 'rewrite' })).toThrow(/TERMINAL_IMMUTABLE/);
  expect(() => updateRequirement(options, { requirementId: 'legacy-a', action: 'rewrite', mutate: (value) => ({ ...value, acceptedEvidenceRefs: ['forged'] }) })).toThrow(/TERMINAL_IMMUTABLE/);
  restoreControlPlaneDatabase(home, backup);
  expect(readRequirement(options, 'legacy-a')).toEqual(before);
});

test('semantic Requirement CAS forbids cancelled-to-done terminal rewrite', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-cancelled-terminal', title: 'Outcome', outcomeStatement: 'Outcome statement' });
  reviseRequirementSemantic(options, 'req-cancelled-terminal', { expectedRevision: 1, state: 'cancelled' });
  const cancelled = readRequirement(options, 'req-cancelled-terminal')!.value;
  expect(() => reviseRequirementSemantic(options, 'req-cancelled-terminal', {
    expectedRevision: cancelled.semanticRevision ?? 2,
    state: 'completed',
    remainingWork: [],
    acceptedEvidenceRefs: ['review:accepted'],
  })).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_TRANSITION_FORBIDDEN/);
  expect(() => reviseRequirementSemantic(options, 'req-cancelled-terminal', {
    expectedRevision: cancelled.semanticRevision ?? 2,
    acceptanceCriteria: ['A cancelled Requirement cannot be rewritten.'],
  })).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_IMMUTABLE/);
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
  reviseRequirementSemantic(options, 'req-reviewed', {
    expectedRevision: 1, state: 'completed', remainingWork: [], acceptedEvidenceRefs: ['review:accepted'],
  });

  const work = createCancelledWork({ controllerHome: home, repoId: 'repo-reviewed' }, {
    workId: 'work-historical-cancelled',
    repoId: 'repo-reviewed',
    requirementId: 'req-reviewed',
    objective: 'Historical attempt retained for evidence.',
    acceptanceCriteria: [],
    allowedPaths: [],
    forbiddenPaths: [],
    checks: [],
    constraints: {},
    requestedBy: 'chatgpt',
  });
  expect(work.semanticState).toBe('cancelled');
  expect(work.completionReceipt).toBeUndefined();
  expect(readRequirement(options, 'req-reviewed')?.value.state).toBe('done');
  expect(() => updateRequirement(options, {
    requirementId: 'req-reviewed',
    action: 'stale_run_reopen',
    mutate: (current) => ({ ...current, state: 'active' }),
  })).toThrow(/REQUIREMENT_TERMINAL_IMMUTABLE/);

  const retained = recordWorkEvidenceState({ controllerHome: home, repoId: 'repo-reviewed' }, work.workId, 'failed');
  expect(retained.semanticState).toBe('cancelled');
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
