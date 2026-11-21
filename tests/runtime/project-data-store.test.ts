import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { portableProjectSourceFingerprint, stablePortableProjectId } from '../../src/core/repository/identity';
import type { PlanContract } from '../../src/runtime/control-plane/facade/types';
import type { Requirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  buildProjectDataSnapshot,
  materializeProjectDataToRepository,
  projectDataPlanDefinition,
  projectDataRequirementDefinition,
  readProjectDataSnapshot,
  resolveProjectDataHeadSha,
  writeProjectDataSnapshot,
} from '../../src/runtime/control-plane/workspace/project-data-store';
import {
  writeProjectIdentity,
  writeProjectPlacement,
  writeWorkspaceIdentity,
} from '../../src/runtime/control-plane/workspace/workspace-store';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    schemaVersion: 1,
    requirementId: 'REQ-DATA-1',
    legacyAliases: [],
    title: 'Portable requirement',
    outcomeStatement: 'Definition syncs through project Git.',
    acceptanceCriteria: ['Mac and WSL read the same definition.'],
    requiredDeliveryReferences: [],
    state: 'active',
    needsAttention: false,
    revision: 1,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:01:00.000Z',
    auditRefs: [],
    ...overrides,
  };
}

function plan(): PlanContract {
  return {
    schemaVersion: 1,
    planId: 'PLAN-DATA-1',
    repoId: 'repo_mac_local',
    requirementId: 'REQ-DATA-1',
    scopeKey: 'project-data-sync',
    sourceRevision: 'abc123',
    goal: 'Persist definitions in project Git.',
    nonGoals: ['Do not sync runtime authority.'],
    assumptions: [],
    resolvedDecisions: ['Stage-1 omits progress fields.'],
    stopConditions: [],
    replanConditions: [],
    integrationStrategy: 'Git project-data only.',
    status: 'executing',
    steps: [
      {
        id: 'step-1',
        objective: 'Write definition files.',
        dependencies: [],
        authoritativeFiles: ['local-only.ts'],
        allowedPaths: ['src/**'],
        forbiddenPaths: [],
        checks: ['local-check'],
        acceptanceCriteria: ['Digest stable.'],
        status: 'executing',
        evidenceRefs: [{ title: 'LOCAL-EVIDENCE' }],
      },
    ],
    evidenceRefs: [{ title: 'LOCAL-PLAN-EVIDENCE' }],
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:02:00.000Z',
  };
}

function seedController(home: string, projectId: string, sourceFingerprint: string): void {
  ensureForgeInstanceIdentity({
    controllerHome: home,
    preferredInstanceId: 'mac-forge',
    now: () => '2026-09-03T00:00:00.000Z',
  });
  writeWorkspaceIdentity({
    controllerHome: home,
    value: { workspaceId: 'workspace-personal', title: 'Personal workspace' },
    expectedRevision: null,
  });
  writeProjectIdentity({
    controllerHome: home,
    value: { projectId, workspaceId: 'workspace-personal', displayName: 'Forge', sourceFingerprint },
    expectedRevision: null,
  });
  writeProjectPlacement({
    controllerHome: home,
    value: { projectId, forgeInstanceId: 'mac-forge', repositoryId: 'repo_mac_local' },
    expectedRevision: null,
  });
}

describe('Git project-data store (refs #712)', () => {
  test('definition projections omit progress and execution fields', () => {
    const definition = projectDataRequirementDefinition(
      requirement({
        projectId: 'project-x',
        priority: 'p0' as never,
        assignee: 'someone' as never,
      }),
    );
    expect(definition).toMatchObject({
      requirementId: 'REQ-DATA-1',
      title: 'Portable requirement',
    });
    expect(definition).not.toHaveProperty('state');
    expect(definition).not.toHaveProperty('priority');
    expect(definition).not.toHaveProperty('assignee');
    expect(definition).not.toHaveProperty('needsAttention');

    const planDefinition = projectDataPlanDefinition(plan());
    expect(planDefinition).not.toHaveProperty('status');
    expect(planDefinition.steps[0]).not.toHaveProperty('status');
    expect(JSON.stringify(planDefinition)).not.toContain('LOCAL-EVIDENCE');
  });

  test('materializes all project Requirements including Plan-less ones with base SHA CAS', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-project-data-'));
    try {
      const controllerHome = join(root, 'controller');
      const repositoryRoot = join(root, 'repo');
      const remote = 'https://github.com/moretea-labs/forge.git';
      const projectId = stablePortableProjectId(remote);
      const sourceFingerprint = portableProjectSourceFingerprint(remote);
      seedController(controllerHome, projectId, sourceFingerprint);

      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-DATA-1',
        schemaVersion: 1,
        value: requirement({ requirementId: 'REQ-DATA-1', projectId, state: 'active' }),
        expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-ORPHAN',
        schemaVersion: 1,
        value: requirement({
          requirementId: 'REQ-ORPHAN',
          title: 'No Plan',
          projectId,
          state: 'waiting_for_user',
        }),
        expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-OTHER',
        schemaVersion: 1,
        value: requirement({
          requirementId: 'REQ-OTHER',
          title: 'Other project',
          projectId: 'project-other',
        }),
        expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'plan_contract',
        scope: 'repo_mac_local',
        key: 'PLAN-DATA-1',
        schemaVersion: 1,
        value: plan(),
        expectedRevision: null,
      });

      const snapshot = buildProjectDataSnapshot({
        controllerHome,
        workspaceId: 'workspace-personal',
        projectId,
        baseGitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        now: () => '2026-09-03T00:10:00.000Z',
      });
      expect(snapshot.requirements.map((entry) => entry.id).sort()).toEqual(['REQ-DATA-1', 'REQ-ORPHAN']);
      expect(snapshot.plans.map((entry) => entry.id)).toEqual(['PLAN-DATA-1']);
      expect(JSON.stringify(snapshot)).not.toContain('"state"');
      expect(JSON.stringify(snapshot)).not.toContain('"status"');
      expect(JSON.stringify(snapshot)).not.toContain('repo_mac_local');
      expect(JSON.stringify(snapshot)).not.toContain(controllerHome);

      expect(() =>
        writeProjectDataSnapshot({
          repositoryRoot,
          snapshot,
          expectedBaseGitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          resolveHeadSha: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ).toThrow('PROJECT_DATA_BASE_GIT_SHA_MISMATCH');

      const written = writeProjectDataSnapshot({
        repositoryRoot,
        snapshot,
        expectedBaseGitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        resolveHeadSha: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      expect(written.writtenPaths).toEqual(
        expect.arrayContaining([
          '.forge/project-data/manifest.json',
          '.forge/project-data/requirements/REQ-ORPHAN.json',
          '.forge/project-data/plans/PLAN-DATA-1.json',
        ]),
      );

      const roundTrip = readProjectDataSnapshot(repositoryRoot);
      expect(roundTrip.manifest.contentDigest).toBe(snapshot.manifest.contentDigest);
      expect(roundTrip.requirements.map((entry) => entry.id).sort()).toEqual(['REQ-DATA-1', 'REQ-ORPHAN']);
      expect(roundTrip.requirements.find((entry) => entry.id === 'REQ-ORPHAN')?.value.title).toBe('No Plan');
      expect(
        readFileSync(join(repositoryRoot, '.forge/project-data/requirements/REQ-ORPHAN.json'), 'utf8'),
      ).not.toContain('"state"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('materializeProjectDataToRepository binds manifest baseSha to real Git HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-project-data-git-'));
    try {
      const controllerHome = join(root, 'controller');
      const repositoryRoot = join(root, 'repo');
      const remote = 'https://github.com/moretea-labs/forge.git';
      const projectId = stablePortableProjectId(remote);
      const sourceFingerprint = portableProjectSourceFingerprint(remote);
      seedController(controllerHome, projectId, sourceFingerprint);
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-DATA-1',
        schemaVersion: 1,
        value: requirement({ requirementId: 'REQ-DATA-1', projectId }),
        expectedRevision: null,
      });

      mkdirSync(repositoryRoot, { recursive: true });
      git(repositoryRoot, ['init']);
      git(repositoryRoot, ['config', 'user.email', 'forge@example.com']);
      git(repositoryRoot, ['config', 'user.name', 'Forge Test']);
      writeFileSync(join(repositoryRoot, 'README.md'), 'project-data\n');
      git(repositoryRoot, ['add', 'README.md']);
      git(repositoryRoot, ['commit', '-m', 'init']);
      const head = resolveProjectDataHeadSha(repositoryRoot);
      expect(head).toMatch(/^[a-f0-9]{40}$/);

      const materialized = materializeProjectDataToRepository({
        controllerHome,
        workspaceId: 'workspace-personal',
        projectId,
        repositoryRoot,
        now: () => '2026-09-03T00:20:00.000Z',
      });
      expect(materialized.headSha).toBe(head);
      expect(materialized.snapshot.manifest.baseGitSha).toBe(head);
      expect(readProjectDataSnapshot(repositoryRoot).manifest.baseGitSha).toBe(head);

      writeFileSync(join(repositoryRoot, 'README.md'), 'project-data changed\n');
      git(repositoryRoot, ['add', 'README.md']);
      git(repositoryRoot, ['commit', '-m', 'advance']);
      expect(() =>
        materializeProjectDataToRepository({
          controllerHome,
          workspaceId: 'workspace-personal',
          projectId,
          repositoryRoot,
          expectedBaseGitSha: head,
        }),
      ).toThrow('PROJECT_DATA_BASE_GIT_SHA_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
