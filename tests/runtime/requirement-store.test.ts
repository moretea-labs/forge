import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  backupControlPlaneDatabase,
  restoreControlPlaneDatabase,
  withControlPlaneTransaction,
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  createRequirement,
  listRequirementRevisionRecords,
  listRequirements,
  normalizeLegacyRequirementAcceptance,
  readRequirement,
  requirementSemanticView,
  reviseRequirementSemantic,
  updateRequirement,
} from '../../src/runtime/control-plane/persistence/requirement-store';
import { executionPlacement, scopeRef, semanticRecordMetadata } from '../../packages/kernel/identity/api/index';
import { createPlanContract } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { buildRequirementBoard } from '../../src/runtime/control-plane/facade/requirement-board';
import {
  createProjectIdentity,
  readProjectIdentity,
  writeProjectIdentity,
  writeProjectPlacement,
} from '../../src/runtime/control-plane/workspace/workspace-store';

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

test('derives multiple active Plan slices from Plan.requirementId without a mutable Requirement pointer', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const requirementOptions = { controllerHome: home };
  createRequirement(requirementOptions, {
    requirementId: 'req-derived-plans',
    title: 'Derived plan slices',
    outcomeStatement: 'Plan relationships are queried from Plan.requirementId.',
  });
  createRequirement(requirementOptions, {
    requirementId: 'req-unrelated',
    repoId: 'repo-other',
    title: 'Other repository',
    outcomeStatement: 'Must not leak into this repository board.',
  });
  const planOptions = { controllerHome: home, repoId: 'repo-derived-plans' };
  for (const [planId, scopeKey] of [
    ['plan-a', 'slice-a'],
    ['plan-b', 'slice-b'],
  ] as const)
    createPlanContract(planOptions, {
      planId,
      repoId: 'repo-derived-plans',
      requirementId: 'req-derived-plans',
      scopeKey,
      sourceRevision: 'revision-a',
      goal: `Deliver ${scopeKey}`,
      steps: [
        {
          id: 'step-1',
          objective: 'Implement slice',
          dependencies: [],
          authoritativeFiles: [],
          allowedPaths: [],
          forbiddenPaths: [],
          checks: [],
          acceptanceCriteria: [],
        },
      ],
    });
  expect(readRequirement(requirementOptions, 'req-derived-plans')?.value.activePlanId).toBeUndefined();
  const board = buildRequirementBoard({ controllerHome: home, repoId: 'repo-derived-plans' }) as {
    requirements: Array<{ requirementId: string; activePlanId?: string; activePlanIds: string[] }>;
  };
  const item = board.requirements.find((entry) => entry.requirementId === 'req-derived-plans');
  expect(item?.activePlanIds).toEqual(['plan-b', 'plan-a']);
  expect(item?.activePlanId).toBe('plan-b');
  expect(board.requirements.some((entry) => entry.requirementId === 'req-unrelated')).toBe(false);
});

test('rejects reopening a completed Requirement without an explicit replacement state', async () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-2', title: 'Outcome', outcomeStatement: 'Outcome statement' });
  updateRequirement(options, {
    requirementId: 'req-2',
    action: 'activate',
    mutate: (current) => ({ ...current, state: 'active' }),
  });
  expect(() =>
    updateRequirement(options, {
      requirementId: 'req-2',
      action: 'complete',
      mutate: (current) => ({ ...current, state: 'done' }),
    }),
  ).toThrow(/REQUIREMENT_STATE_TRANSITION_INVALID/);
  reviseRequirementSemantic(options, 'req-2', {
    expectedRevision: 1,
    state: 'completed',
    remainingWork: [],
    acceptedEvidenceRefs: ['review:accepted'],
  });
  expect(() =>
    updateRequirement(options, {
      requirementId: 'req-2',
      action: 'cancel_completed',
      mutate: (current) => ({ ...current, state: 'cancelled' }),
    }),
  ).toThrow(/REQUIREMENT_TERMINAL_IMMUTABLE/);
  const completed = readRequirement(options, 'req-2')!.value;
  expect(() =>
    reviseRequirementSemantic(options, 'req-2', {
      expectedRevision: completed.semanticRevision ?? 2,
      state: 'cancelled',
    }),
  ).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_TRANSITION_FORBIDDEN/);
  expect(() =>
    reviseRequirementSemantic(options, 'req-2', {
      expectedRevision: completed.semanticRevision ?? 2,
      outcomeStatement: 'A completed Requirement cannot be rewritten.',
    }),
  ).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_IMMUTABLE/);
  expect(() =>
    updateRequirement(options, {
      requirementId: 'req-2',
      action: 'rewrite_completed',
      mutate: (current) => ({ ...current, outcomeStatement: 'Legacy writer cannot rewrite terminal facts.' }),
    }),
  ).toThrow(/REQUIREMENT_TERMINAL_IMMUTABLE/);
  expect(() =>
    updateRequirement(options, {
      requirementId: 'req-2',
      action: 'reopen',
      mutate: (current) => ({ ...current, state: 'active' }),
    }),
  ).toThrow(/REQUIREMENT_TERMINAL_IMMUTABLE/);

  // Persist actual legacy row shapes, then exercise the startup conversion and
  // the same terminal writer guards. No fixture-only acceptance writer survives.
  const acceptance = {
    reviewer: 'mcp-bearer-client',
    rationale: 'Fixed candidate independently accepted',
    planIds: [],
    acceptedAt: '2026-09-22T06:17:53.399Z',
  };
  for (const suffix of ['a', 'b', 'unproven']) {
    const legacy = {
      ...completed,
      requirementId: `legacy-${suffix}`,
      acceptedEvidenceRefs: [],
      semanticAcceptance: suffix === 'unproven' ? { ...acceptance, reviewer: '' } : acceptance,
    };
    writeControlPlaneRecord(home, {
      namespace: 'requirement',
      scope: 'controller',
      key: legacy.requirementId,
      schemaVersion: 1,
      value: legacy,
    });
  }
  const before = readRequirement(options, 'legacy-a')!;
  const backup = join(home, 'before-normalization.sqlite');
  backupControlPlaneDatabase(home, backup);
  withControlPlaneTransaction(home, (database) =>
    database.exec(
      "CREATE TRIGGER fail_normalization BEFORE INSERT ON control_plane_audit WHEN NEW.action='requirement_legacy_acceptance_normalized_v1' AND NEW.record_key='legacy-b' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END",
    ),
  );
  expect(() => normalizeLegacyRequirementAcceptance(options)).toThrow('injected migration failure');
  expect(readRequirement(options, 'legacy-a')).toEqual(before);
  withControlPlaneTransaction(home, (database) => database.exec('DROP TRIGGER fail_normalization'));
  expect(normalizeLegacyRequirementAcceptance(options)).toBe(2);
  const migrated = readRequirement(options, 'legacy-a')!;
  expect(migrated.revision).toBe(before.revision);
  expect(migrated.updatedAt).toBe(before.updatedAt);
  expect(migrated.value).toMatchObject({
    state: 'done',
    revision: completed.revision,
    semanticRevision: completed.semanticRevision,
    semanticAcceptance: acceptance,
  });
  expect(migrated.value.acceptedEvidenceRefs?.[0]).toMatch(
    /^requirement:legacy-a:legacy-acceptance:sha256:[a-f0-9]{64}$/,
  );
  expect(readRequirement(options, 'legacy-unproven')?.value.acceptedEvidenceRefs).toEqual([]);
  expect(normalizeLegacyRequirementAcceptance(options)).toBe(0);
  expect(readRequirement(options, 'legacy-a')).toEqual(migrated);
  expect(() =>
    reviseRequirementSemantic(options, 'legacy-a', {
      expectedRevision: completed.semanticRevision!,
      progressSummary: 'rewrite',
    }),
  ).toThrow(/TERMINAL_IMMUTABLE/);
  expect(() =>
    updateRequirement(options, {
      requirementId: 'legacy-a',
      action: 'rewrite',
      mutate: (value) => ({ ...value, acceptedEvidenceRefs: ['forged'] }),
    }),
  ).toThrow(/TERMINAL_IMMUTABLE/);
  restoreControlPlaneDatabase(home, backup);
  expect(readRequirement(options, 'legacy-a')).toEqual(before);
});

test('semantic Requirement CAS forbids cancelled-to-done terminal rewrite', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const options = { controllerHome: home };
  createRequirement(options, {
    requirementId: 'req-cancelled-terminal',
    title: 'Outcome',
    outcomeStatement: 'Outcome statement',
  });
  reviseRequirementSemantic(options, 'req-cancelled-terminal', { expectedRevision: 1, state: 'cancelled' });
  const cancelled = readRequirement(options, 'req-cancelled-terminal')!.value;
  expect(() =>
    reviseRequirementSemantic(options, 'req-cancelled-terminal', {
      expectedRevision: cancelled.semanticRevision ?? 2,
      state: 'completed',
      remainingWork: [],
      acceptedEvidenceRefs: ['review:accepted'],
    }),
  ).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_TRANSITION_FORBIDDEN/);
  expect(() =>
    reviseRequirementSemantic(options, 'req-cancelled-terminal', {
      expectedRevision: cancelled.semanticRevision ?? 2,
      acceptanceCriteria: ['A cancelled Requirement cannot be rewritten.'],
    }),
  ).toThrow(/REQUIREMENT_SEMANTIC_TERMINAL_IMMUTABLE/);
});

test('restores a verified SQLite backup without losing Requirement authority', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-'));
  homes.push(home);
  const backup = join(home, 'backup.sqlite');
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-backup', title: 'Backup', outcomeStatement: 'Restore this state' });
  backupControlPlaneDatabase(home, backup);
  updateRequirement(options, {
    requirementId: 'req-backup',
    action: 'activate',
    mutate: (current) => ({ ...current, state: 'active' }),
  });
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

  createRequirement(sessionA, {
    requirementId: 'req-shared',
    title: 'Shared outcome',
    outcomeStatement: 'Two sessions attach evidence to one Requirement.',
  });
  const located = readRequirement(sessionB, 'req-shared');
  expect(located?.value.state).toBe('planned');

  // Both sessions observe semantic revision 1; session A commits first.
  const baseRevision = located!.value.semanticRevision ?? 1;
  reviseRequirementSemantic(sessionA, 'req-shared', {
    expectedRevision: baseRevision,
    progressSummary: 'Session A attached evidence.',
  });

  // Session B's stale write is rejected with the actual current revision, and
  // nothing is silently overwritten.
  expect(() =>
    reviseRequirementSemantic(sessionB, 'req-shared', {
      expectedRevision: baseRevision,
      progressSummary: 'Session B stale write.',
    }),
  ).toThrow(/REQUIREMENT_REVISION_CONFLICT:req-shared:expected=1:actual=2/);
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

  const a = createRequirement(sessionA, {
    requirementId: 'req-issue-a',
    title: 'Issue A',
    outcomeStatement: 'Deliver A.',
  });
  const b = createRequirement(sessionB, {
    requirementId: 'req-issue-b',
    title: 'Issue B',
    outcomeStatement: 'Deliver B.',
  });
  expect(a.state).toBe('planned');
  expect(b.state).toBe('planned');

  // Both active Requirements are independently visible to either session.
  const seenByA = listRequirements(sessionA).map((record) => record.value.requirementId);
  expect(seenByA).toContain('req-issue-a');
  expect(seenByA).toContain('req-issue-b');

  // Activating one does not block or mutate the other.
  updateRequirement(sessionB, {
    requirementId: 'req-issue-b',
    action: 'activate',
    mutate: (current) => ({ ...current, state: 'active' }),
  });
  expect(readRequirement(sessionA, 'req-issue-a')!.value.state).toBe('planned');
  expect(readRequirement(sessionA, 'req-issue-b')!.value.state).toBe('active');
});

test('keeps portable semantic scope separate from local execution placement', () => {
  const scope = scopeRef('requirement', 'REQ-portable');
  const placement = executionPlacement({
    forgeInstanceId: 'forge-mac',
    repositoryId: 'repo-local',
    checkoutId: 'checkout-local',
  });
  const metadata = semanticRecordMetadata({
    scope,
    revision: 7,
    updatedAt: '2026-09-02T00:00:00.000Z',
    origin: 'local',
    forgeInstanceId: 'forge-mac',
    sourceRevision: 'abc123',
  });
  expect(scope).toEqual({ schemaVersion: 1, kind: 'requirement', id: 'REQ-portable' });
  expect(placement).toEqual({
    schemaVersion: 1,
    forgeInstanceId: 'forge-mac',
    repositoryId: 'repo-local',
    checkoutId: 'checkout-local',
  });
  expect(metadata.scope).toEqual(scope);
  expect(metadata.revision).toBe(7);
  expect(() => semanticRecordMetadata({ ...metadata, revision: -1 })).toThrow(/SEMANTIC_RECORD_REVISION_INVALID/);
});

test('task detail reads its latest revisions even when other Requirements own the first history rows', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-history-'));
  homes.push(home);
  const options = { controllerHome: home, now: () => '2026-11-16T00:00:00.000Z' };
  for (let index = 0; index < 25; index++) {
    const requirementId = `req-a-noise-${String(index).padStart(2, '0')}`;
    createRequirement(options, {
      requirementId,
      title: 'Unrelated task',
      outcomeStatement: 'Unrelated work',
    });
    reviseRequirementSemantic(options, requirementId, {
      expectedRevision: 1,
      progressSummary: 'Unrelated task was edited.',
    });
  }
  createRequirement(options, {
    requirementId: 'req-z-history',
    title: 'Original user task',
    outcomeStatement: 'Keep its full recent history.',
  });
  reviseRequirementSemantic(options, 'req-z-history', {
    expectedRevision: 1,
    title: 'First task edit',
  });
  reviseRequirementSemantic(options, 'req-z-history', {
    expectedRevision: 2,
    title: 'Second task edit',
  });
  expect(listRequirementRevisionRecords(options, 'req-z-history', 2)).toMatchObject([
    { requirementId: 'req-z-history', revision: 2, title: 'First task edit' },
    { requirementId: 'req-z-history', revision: 1, title: 'Original user task' },
  ]);
  expect(readControlPlaneRecord(home, 'requirement_revision', 'controller', 'req-z-history:r1')).toBeUndefined();
  expect(readControlPlaneRecord(home, 'requirement_revision', 'controller', 'req-z-history:r2')).toBeUndefined();
  const change = readControlPlaneRecord<Record<string, unknown>>(
    home,
    'requirement_change',
    'controller',
    'req-z-history:r2',
  )?.value;
  expect(change).toMatchObject({ revision: 2, nextRevision: 3 });
  expect(JSON.stringify(change).length).toBeLessThan(
    JSON.stringify(listRequirementRevisionRecords(options, 'req-z-history', 1)[0]).length,
  );
});

test('Project root Requirement uniqueness and parent hierarchy are atomic and separate from dependencies', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-hierarchy-'));
  homes.push(home);
  const options = { controllerHome: home, now: () => '2026-11-20T00:00:00.000Z' };
  createProjectIdentity({
    controllerHome: home,
    value: { projectId: 'project-hierarchy', workspaceId: 'workspace-personal', displayName: 'Hierarchy' },
  });
  createProjectIdentity({
    controllerHome: home,
    value: { projectId: 'project-hierarchy-other', workspaceId: 'workspace-personal', displayName: 'Other hierarchy' },
  });
  writeProjectPlacement({
    controllerHome: home,
    value: { projectId: 'project-hierarchy', forgeInstanceId: 'forge-hierarchy', repositoryId: 'repo-hierarchy' },
  });

  const root = createRequirement(options, {
    requirementId: 'REQ-HIERARCHY-ROOT',
    projectId: 'project-hierarchy',
    isProjectRoot: true,
    title: 'Project root',
    outcomeStatement: 'Deliver the complete project outcome.',
  });
  expect(root.rootRequirementId).toBe(root.requirementId);
  expect(readProjectIdentity(home, 'workspace-personal', 'project-hierarchy')?.value.rootRequirementId).toBe(
    root.requirementId,
  );
  expect(() =>
    writeProjectIdentity({
      controllerHome: home,
      expectedRevision: 2,
      value: {
        projectId: 'project-hierarchy',
        workspaceId: 'workspace-personal',
        displayName: 'Hierarchy',
        rootRequirementId: 'REQ-HIERARCHY-OTHER',
      },
    }),
  ).toThrow('PROJECT_ROOT_REQUIREMENT_BINDING_REQUIRES_REQUIREMENT_TRANSACTION');

  const child = createRequirement(options, {
    requirementId: 'REQ-HIERARCHY-CHILD',
    repoId: 'repo-hierarchy',
    parentRequirementId: root.requirementId,
    dependsOnRequirementIds: [root.requirementId],
    title: 'Repository child',
    outcomeStatement: 'Deliver one repository slice.',
  });
  expect(requirementSemanticView(child)).toMatchObject({
    parentRequirementId: root.requirementId,
    rootRequirementId: root.requirementId,
    dependsOnRequirementIds: [root.requirementId],
  });

  const legacy = createRequirement(options, {
    requirementId: 'REQ-HIERARCHY-LEGACY',
    projectId: 'project-hierarchy',
    title: 'Existing task',
    outcomeStatement: 'Attach an existing task under the canonical root.',
  });
  const attached = reviseRequirementSemantic(options, legacy.requirementId, {
    expectedRevision: 1,
    parentRequirementId: root.requirementId,
  });
  expect(requirementSemanticView(attached)).toMatchObject({
    revision: 2,
    parentRequirementId: root.requirementId,
    rootRequirementId: root.requirementId,
  });
  expect(listRequirementRevisionRecords(options, legacy.requirementId, 2)[0]).toMatchObject({
    revision: 1,
    title: 'Existing task',
  });
  expect(listRequirementRevisionRecords(options, legacy.requirementId, 2)[0]?.parentRequirementId).toBeUndefined();
  expect(() =>
    reviseRequirementSemantic(options, legacy.requirementId, {
      expectedRevision: 2,
      parentRequirementId: 'REQ-OTHER-PARENT',
    }),
  ).toThrow('REQUIREMENT_PARENT_IMMUTABLE:REQ-HIERARCHY-LEGACY');

  expect(() =>
    createRequirement(options, {
      requirementId: 'REQ-HIERARCHY-SECOND-ROOT',
      projectId: 'project-hierarchy',
      isProjectRoot: true,
      title: 'Second root',
      outcomeStatement: 'A second root must be rejected.',
    }),
  ).toThrow(/PROJECT_ROOT_REQUIREMENT_ALREADY_BOUND:project-hierarchy:REQ-HIERARCHY-ROOT/);
  expect(readRequirement(options, 'REQ-HIERARCHY-SECOND-ROOT')).toBeUndefined();

  const foreignRoot = createRequirement(options, {
    requirementId: 'REQ-HIERARCHY-FOREIGN-ROOT',
    projectId: 'project-hierarchy-other',
    isProjectRoot: true,
    title: 'Foreign root',
    outcomeStatement: 'Belongs to another Project.',
  });
  expect(() =>
    createRequirement(options, {
      requirementId: 'REQ-HIERARCHY-CROSS-PROJECT',
      repoId: 'repo-hierarchy',
      parentRequirementId: foreignRoot.requirementId,
      title: 'Cross-project child',
      outcomeStatement: 'Must not cross Project roots.',
    }),
  ).toThrow(/REQUIREMENT_HIERARCHY_PROJECT_MISMATCH/);
});

test('attaches historical terminal tasks without changing lifecycle, evidence or dependencies', () => {
  const home = mkdtempSync(join('/tmp', 'forge-terminal-hierarchy-'));
  homes.push(home);
  const options = { controllerHome: home };
  const projectId = 'project-terminal-migration';
  createProjectIdentity({
    controllerHome: home,
    value: { projectId, workspaceId: 'workspace-personal', displayName: 'Migration' },
  });
  const root = createRequirement(options, {
    requirementId: 'REQ-MIGRATION-ROOT',
    projectId,
    isProjectRoot: true,
    title: 'Root',
    outcomeStatement: 'Project outcome',
  });
  const task = createRequirement(options, {
    requirementId: 'REQ-MIGRATION-DONE',
    projectId,
    title: 'Historical delivery',
    outcomeStatement: 'Delivered result',
    priority: 'high',
    assignee: 'owner',
    dependsOnRequirementIds: [root.requirementId],
    legacyAliases: ['github:example/repo#42'],
  });
  const done = reviseRequirementSemantic(options, task.requirementId, {
    expectedRevision: 1,
    state: 'completed',
    acceptedEvidenceRefs: ['receipt:accepted'],
  });
  const cancelledTask = createRequirement(options, {
    requirementId: 'REQ-MIGRATION-CANCELLED',
    projectId,
    title: 'Cancelled delivery',
    outcomeStatement: 'Cancelled result',
  });
  const cancelled = reviseRequirementSemantic(options, cancelledTask.requirementId, {
    expectedRevision: 1,
    state: 'cancelled',
  });
  for (const before of [done, cancelled]) {
    expect(() =>
      reviseRequirementSemantic(options, before.requirementId, {
        expectedRevision: 1,
        parentRequirementId: root.requirementId,
      }),
    ).toThrow('REQUIREMENT_REVISION_CONFLICT');
    expect(() =>
      reviseRequirementSemantic(options, before.requirementId, {
        expectedRevision: 2,
        parentRequirementId: root.requirementId,
        title: 'Rewrite',
      }),
    ).toThrow('REQUIREMENT_SEMANTIC_TERMINAL_IMMUTABLE');
    expect(readRequirement(options, before.requirementId)?.value).toEqual(before);
    const attached = reviseRequirementSemantic(options, before.requirementId, {
      expectedRevision: 2,
      parentRequirementId: root.requirementId,
    });
    const {
      parentRequirementId,
      rootRequirementId,
      revision,
      semanticRevision,
      updatedAt,
      semanticUpdatedAt,
      ...facts
    } = attached;
    const {
      revision: oldRevision,
      semanticRevision: oldSemanticRevision,
      updatedAt: oldUpdatedAt,
      semanticUpdatedAt: oldSemanticUpdatedAt,
      ...oldFacts
    } = before;
    expect(facts).toEqual(oldFacts);
    expect(parentRequirementId).toBe(root.requirementId);
    expect(rootRequirementId).toBe(root.requirementId);
    expect(revision).toBe(oldRevision + 1);
    expect(semanticRevision).toBe(3);
    expect(
      listRequirementRevisionRecords(options, before.requirementId, 10).find((row) => row.revision === 2),
    ).toMatchObject({ status: before.state, title: before.title, acceptedEvidenceRefs: before.acceptedEvidenceRefs });
    expect(
      reviseRequirementSemantic(options, before.requirementId, {
        expectedRevision: 3,
        parentRequirementId: root.requirementId,
      }),
    ).toEqual(attached);
    expect(() =>
      reviseRequirementSemantic(options, before.requirementId, {
        expectedRevision: 3,
        isProjectRoot: true,
      }),
    ).toThrow('REQUIREMENT_HIERARCHY_ROOT_IMMUTABLE');
  }
  expect(listRequirements(options)).toHaveLength(3);
});

test('competing independent processes can bind exactly one canonical Project root', async () => {
  const home = mkdtempSync(join('/tmp', 'forge-project-root-race-'));
  homes.push(home);
  const options = { controllerHome: home };
  const projectId = 'project-root-race';
  createProjectIdentity({
    controllerHome: home,
    value: { projectId, workspaceId: 'workspace-personal', displayName: 'Root race' },
  });
  const go = join(home, 'go');
  const workerSource = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createRequirement } from './src/runtime/control-plane/persistence/requirement-store';
    const [home, projectId, requirementId, ready, go] = process.argv.slice(1);
    writeFileSync(ready, 'ready');
    const deadline = Date.now() + 5000;
    while (!existsSync(go)) {
      if (Date.now() > deadline) throw new Error('ROOT_RACE_START_TIMEOUT');
      await Bun.sleep(2);
    }
    try {
      const requirement = createRequirement({ controllerHome: home }, {
        requirementId, projectId, isProjectRoot: true,
        title: requirementId, outcomeStatement: 'Exactly one root must win.',
      });
      console.log(JSON.stringify({ status: 'created', requirementId: requirement.requirementId }));
    } catch (error) {
      console.log(JSON.stringify({ status: 'rejected', message: String(error) }));
    }
  `;
  const ids = ['REQ-RACE-A', 'REQ-RACE-B'];
  const ready = ids.map((id) => join(home, id + '.ready'));
  const workers = ids.map((id, index) =>
    Bun.spawn([process.execPath, '-e', workerSource, home, projectId, id, ready[index]!, go], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  try {
    const deadline = Date.now() + 5_000;
    while (!ready.every(existsSync)) {
      if (Date.now() > deadline) throw new Error('ROOT_RACE_READY_TIMEOUT');
      await Bun.sleep(5);
    }
    writeFileSync(go, 'go');
    const results = await Promise.all(
      workers.map(async (worker) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(`Root race worker exited ${exitCode}: ${stderr}`);
        return JSON.parse(stdout) as { status: string; requirementId?: string; message?: string };
      }),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'created')!.requirementId!;
    expect(results.find((result) => result.status === 'rejected')?.message).toContain(
      `PROJECT_ROOT_REQUIREMENT_ALREADY_BOUND:${projectId}:${winner}`,
    );
    expect(readProjectIdentity(home, 'workspace-personal', projectId)).toMatchObject({
      revision: 2,
      value: { rootRequirementId: winner },
    });
    expect(listRequirements(options).map((record) => record.value.requirementId)).toEqual([winner]);
    expect(readRequirement(options, winner)?.value.rootRequirementId).toBe(winner);
    expect(readRequirement(options, ids.find((id) => id !== winner)!)).toBeUndefined();
  } finally {
    for (const worker of workers) if (worker.exitCode === null) worker.kill();
    await Promise.all(workers.map((worker) => worker.exited));
  }
}, 15_000);

test('Requirement task priority, assignee and status share one revisioned authority and board projection', () => {
  const home = mkdtempSync(join('/tmp', 'forge-requirement-task-'));
  homes.push(home);
  const options = { controllerHome: home, now: () => '2026-11-15T00:00:00.000Z' };
  const created = createRequirement(options, {
    requirementId: 'req-task-metadata',
    title: 'Ship task metadata',
    outcomeStatement: 'A project task can be assigned, prioritized and moved through its real lifecycle.',
    status: 'active',
    priority: 'high',
    assignee: 'greyson',
  });
  expect(requirementSemanticView(created)).toMatchObject({
    revision: 1,
    state: 'open',
    status: 'active',
    priority: 'high',
    assignee: 'greyson',
  });

  const active = reviseRequirementSemantic(options, created.requirementId, {
    expectedRevision: 1,
    status: 'active',
    priority: 'urgent',
    assignee: 'agent:codex',
  });
  expect(requirementSemanticView(active)).toMatchObject({
    revision: 2,
    state: 'open',
    status: 'active',
    priority: 'urgent',
    assignee: 'agent:codex',
  });
  expect(listRequirementRevisionRecords(options, created.requirementId, 10)).toMatchObject([
    { revision: 1, status: 'active', priority: 'high', assignee: 'greyson' },
  ]);

  const board = buildRequirementBoard({ controllerHome: home }) as { requirements: Array<Record<string, unknown>> };
  expect(board.requirements[0]).toMatchObject({
    requirementId: created.requirementId,
    state: 'active',
    priority: 'urgent',
    assignee: 'agent:codex',
  });
  expect(() =>
    reviseRequirementSemantic(options, created.requirementId, {
      expectedRevision: 2,
      status: 'planned',
    }),
  ).toThrow('REQUIREMENT_STATE_TRANSITION_INVALID');

  const done = reviseRequirementSemantic(options, created.requirementId, {
    expectedRevision: 2,
    status: 'done',
    remainingWork: [],
    acceptedEvidenceRefs: ['test:task-accepted'],
  });
  expect(requirementSemanticView(done)).toMatchObject({ revision: 3, state: 'completed', status: 'done' });
  expect(() =>
    reviseRequirementSemantic(options, created.requirementId, {
      expectedRevision: 3,
      status: 'active',
    }),
  ).toThrow('REQUIREMENT_STATUS_TERMINAL_TRANSITION_FORBIDDEN');
  expect(() =>
    createRequirement(options, {
      requirementId: 'req-invalid-priority',
      title: 'Invalid priority',
      outcomeStatement: 'Reject unknown priority.',
      priority: 'critical' as never,
    }),
  ).toThrow('REQUIREMENT_PRIORITY_INVALID');
  expect(() =>
    createRequirement(options, {
      requirementId: 'req-invalid-initial-status',
      title: 'Invalid initial status',
      outcomeStatement: 'Terminal tasks are not created directly.',
      status: 'done',
    }),
  ).toThrow('REQUIREMENT_CREATE_TERMINAL_STATUS_FORBIDDEN');
});

test('Requirement board and diagnostics preserve Plan-derived repository placement', async () => {
  const { buildExecutionDiagnostics } = await import('../../src/runtime/control-plane/facade/requirement-board');
  const home = mkdtempSync(join('/tmp', 'forge-requirement-board-'));
  homes.push(home);
  createRequirement(
    { controllerHome: home },
    {
      requirementId: 'req-plan-placement',
      title: 'Portable Requirement',
      outcomeStatement: 'Show a Requirement linked to a local Plan.',
    },
  );
  createRequirement(
    { controllerHome: home },
    {
      requirementId: 'req-other-placement',
      repoId: 'repo-other',
      title: 'Other Requirement',
      outcomeStatement: 'Must remain scoped.',
    },
  );
  createPlanContract(
    { controllerHome: home, repoId: 'repo-board' },
    {
      planId: 'plan-placement',
      repoId: 'repo-board',
      requirementId: 'req-plan-placement',
      scopeKey: 'board-slice',
      sourceRevision: 'base',
      goal: 'Deliver the linked requirement',
      steps: [
        {
          id: 'step-1',
          objective: 'Deliver',
          dependencies: [],
          authoritativeFiles: [],
          allowedPaths: [],
          forbiddenPaths: [],
          checks: [],
          acceptanceCriteria: [],
        },
      ],
    },
  );
  const board = buildRequirementBoard({ controllerHome: home, repoId: 'repo-board' }) as {
    requirements: Array<{ requirementId: string; activePlanIds: string[] }>;
  };
  expect(board.requirements.map((item) => item.requirementId)).toEqual(['req-plan-placement']);
  expect(board.requirements[0]?.activePlanIds).toEqual(['plan-placement']);
  expect(board).not.toHaveProperty('historicalWorkProjection');

  const diagnostics = buildExecutionDiagnostics({
    controllerHome: home,
    repoId: 'repo-board',
    detailLevel: 'detail',
    requirementId: 'req-plan-placement',
  }) as {
    requirements: Array<{ requirementId: string; activePlanIds: string[] }>;
    plans: Array<{ planId: string }>;
  };
  expect(diagnostics.requirements[0]?.activePlanIds).toEqual(['plan-placement']);
  expect(diagnostics.plans.map((plan) => plan.planId)).toEqual(['plan-placement']);
  expect(diagnostics).not.toHaveProperty('historicalWorkProjection');
});
