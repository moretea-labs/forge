import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { backupControlPlaneDatabase, restoreControlPlaneDatabase, withControlPlaneTransaction, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { createRequirement, listRequirements, normalizeLegacyRequirementAcceptance, readRequirement, reviseRequirementSemantic, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { listWorkContracts } from '../../src/runtime/control-plane/facade/work-contract-store';
import { implementationReviewChangedPathDigest } from '../../packages/kernel/work/api/index';
import { executionPlacement, scopeRef, semanticRecordMetadata } from '../../packages/kernel/identity/api/index';
import { createPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { buildRequirementBoard } from '../../src/runtime/control-plane/facade/requirement-board';
import { seedHistoricalWorkContract } from '../helpers/historical-work-contract';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createCancelledWork(
  options: Parameters<typeof seedHistoricalWorkContract>[0],
  input: Parameters<typeof seedHistoricalWorkContract>[1],
) {
  return seedHistoricalWorkContract(options, { ...input, semanticState: 'cancelled' });
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

test('derives multiple active Plan slices from Plan.requirementId without a mutable Requirement pointer', () => { const home = mkdtempSync(join('/tmp', 'forge-requirement-')); homes.push(home); const requirementOptions = { controllerHome: home }; createRequirement(requirementOptions, { requirementId: 'req-derived-plans', title: 'Derived plan slices', outcomeStatement: 'Plan relationships are queried from Plan.requirementId.' }); createRequirement(requirementOptions, { requirementId: 'req-unrelated', repoId:'repo-other', title: 'Other repository', outcomeStatement: 'Must not leak into this repository board.' }); const planOptions = { controllerHome: home, repoId: 'repo-derived-plans' }; for (const [planId, scopeKey] of [['plan-a', 'slice-a'], ['plan-b', 'slice-b']] as const) createPlanContract(planOptions, { planId, repoId: 'repo-derived-plans', requirementId: 'req-derived-plans', scopeKey, sourceRevision: 'revision-a', goal: `Deliver ${scopeKey}`, steps: [{ id: 'step-1', objective: 'Implement slice', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: [], acceptanceCriteria: [] }] }); expect(readRequirement(requirementOptions, 'req-derived-plans')?.value.activePlanId).toBeUndefined(); const board = buildRequirementBoard({ controllerHome: home, repoId: 'repo-derived-plans' }) as { requirements: Array<{ requirementId: string; activePlanId?: string; activePlanIds: string[] }> }; const item = board.requirements.find((entry) => entry.requirementId === 'req-derived-plans'); expect(item?.activePlanIds).toEqual(['plan-b', 'plan-a']); expect(item?.activePlanId).toBe('plan-b'); expect(board.requirements.some((entry) => entry.requirementId === 'req-unrelated')).toBe(false); });

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


test('two independent sessions share one Requirement and reconcile CAS conflicts without silent overwrite', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  // Two independent session contexts over the same canonical store home: no
  // per-session registration lock exists, only the store's expected-revision CAS.
  const sessionA = { controllerHome: home };
  const sessionB = { controllerHome: home };

  createRequirement(sessionA, { requirementId: 'req-shared', title: 'Shared outcome', outcomeStatement: 'Two sessions attach evidence to one Requirement.' });
  const located = readRequirement(sessionB, 'req-shared');
  expect(located?.value.state).toBe('planned');

  // Both sessions observe semantic revision 1; session A commits first.
  const baseRevision = located!.value.semanticRevision ?? 1;
  reviseRequirementSemantic(sessionA, 'req-shared', { expectedRevision: baseRevision, progressSummary: 'Session A attached evidence.' });

  // Session B's stale write is rejected with the actual current revision, and
  // nothing is silently overwritten.
  expect(() => reviseRequirementSemantic(sessionB, 'req-shared', { expectedRevision: baseRevision, progressSummary: 'Session B stale write.' }))
    .toThrow(/REQUIREMENT_REVISION_CONFLICT:req-shared:expected=1:actual=2/);
  expect(readRequirement(sessionB, 'req-shared')!.value.progressSummary).toBe('Session A attached evidence.');

  // Session B reconciles from the current revision and appends its own evidence.
  const current = readRequirement(sessionB, 'req-shared')!.value;
  const reconciled = reviseRequirementSemantic(sessionB, 'req-shared', {
    expectedRevision: current.semanticRevision ?? 2,
    progressSummary: `${current.progressSummary} Session B reconciled and attached evidence.`,
  });
  expect(reconciled.semanticRevision).toBe(3);
  const merged = readRequirement(sessionA, 'req-shared')!.value;
  expect(merged.progressSummary).toContain('Session A attached evidence.');
  expect(merged.progressSummary).toContain('Session B reconciled and attached evidence.');
});

test('independent sessions register distinct active Requirements without a global mutex', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const sessionA = { controllerHome: home };
  const sessionB = { controllerHome: home };

  const a = createRequirement(sessionA, { requirementId: 'req-issue-a', title: 'Issue A', outcomeStatement: 'Deliver A.' });
  const b = createRequirement(sessionB, { requirementId: 'req-issue-b', title: 'Issue B', outcomeStatement: 'Deliver B.' });
  expect(a.state).toBe('planned');
  expect(b.state).toBe('planned');

  // Both active Requirements are independently visible to either session.
  const seenByA = listRequirements(sessionA).map((record) => record.value.requirementId);
  expect(seenByA).toContain('req-issue-a');
  expect(seenByA).toContain('req-issue-b');

  // Activating one does not block or mutate the other.
  updateRequirement(sessionB, { requirementId: 'req-issue-b', action: 'activate', mutate: (current) => ({ ...current, state: 'active' }) });
  expect(readRequirement(sessionA, 'req-issue-a')!.value.state).toBe('planned');
  expect(readRequirement(sessionA, 'req-issue-b')!.value.state).toBe('active');
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
