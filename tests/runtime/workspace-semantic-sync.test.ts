import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureForgeInstanceIdentity,
  MAX_SEMANTIC_SYNC_JOURNAL_ENTRIES,
} from '../../packages/kernel/identity/api/index';
import { portableProjectSourceFingerprint, stablePortableProjectId } from '../../src/core/repository/identity';
import type { PlanContract } from '../../src/runtime/control-plane/facade/types';
import type { Requirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import {
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  boundedSemanticSyncJournal,
  exportSemanticSyncBundle,
  importSemanticSyncBundle,
  listSemanticSyncReplicas,
  readSemanticSyncJournal,
  type SemanticSyncJournalEntry,
} from '../../src/runtime/control-plane/workspace/semantic-sync-service';
import {
  listProjectRevisionRecords,
  writeProjectIdentity,
  writeProjectPlacement,
  writeWorkspaceIdentity,
} from '../../src/runtime/control-plane/workspace/workspace-store';

function requirement(title = 'Shared requirement', revision = 1): Requirement {
  return {
    schemaVersion: 1,
    requirementId: 'REQ-SYNC-1',
    legacyAliases: [],
    title,
    outcomeStatement: 'The same semantic requirement is visible on both Forge instances.',
    acceptanceCriteria: ['Mac and WSL see the same semantic identity.'],
    requiredDeliveryReferences: [],
    state: 'active',
    needsAttention: false,
    revision,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: `2026-09-03T00:0${revision}:00.000Z`,
    auditRefs: [],
  };
}

function plan(): PlanContract {
  return {
    schemaVersion: 1,
    planId: 'PLAN-SYNC-1',
    repoId: 'repo_mac_local',
    requirementId: 'REQ-SYNC-1',
    scopeKey: 'shared-workspace-sync',
    sourceRevision: 'abc123',
    goal: 'Deliver portable semantics across nodes.',
    nonGoals: ['Do not sync runtime authority.'],
    assumptions: [],
    resolvedDecisions: ['Replicas are read-only semantic visibility.'],
    stopConditions: [],
    replanConditions: [],
    integrationStrategy: 'Sync semantics only.',
    status: 'executing',
    steps: [
      {
        id: 'step-1',
        objective: 'Sync semantic records.',
        dependencies: [],
        authoritativeFiles: ['local-only.ts'],
        allowedPaths: ['src/**'],
        forbiddenPaths: [],
        checks: ['local-check'],
        acceptanceCriteria: ['Replica visible.'],
        status: 'executing',
        evidenceRefs: [{ title: 'LOCAL-EVIDENCE-SHOULD-NOT-SYNC' }],
      },
    ],
    evidenceRefs: [{ title: 'LOCAL-PLAN-EVIDENCE-SHOULD-NOT-SYNC' }],
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:02:00.000Z',
  };
}

function seedNode(
  home: string,
  instanceId: string,
  repoId: string,
  projectId: string,
  sourceFingerprint: string,
): void {
  ensureForgeInstanceIdentity({
    controllerHome: home,
    preferredInstanceId: instanceId,
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
    value: { projectId, forgeInstanceId: instanceId, repositoryId: repoId },
    expectedRevision: null,
  });
}

describe('Kernel V2 Workspace semantic sync', () => {
  test('Project history shows the newest revisions after more than one page of edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-project-history-'));
    try {
      const home = join(root, 'controller');
      writeWorkspaceIdentity({
        controllerHome: home,
        value: { workspaceId: 'workspace-personal', title: 'Personal workspace' },
        expectedRevision: null,
      });
      const identity = {
        projectId: 'project-history',
        workspaceId: 'workspace-personal',
        displayName: 'Original project',
      };
      let current = writeProjectIdentity({ controllerHome: home, value: identity, expectedRevision: null });
      for (let revision = 2; revision <= 58; revision++) {
        current = writeProjectIdentity({
          controllerHome: home,
          value: { ...current.value, displayName: `Updated project ${revision}` },
          expectedRevision: current.revision,
        });
      }
      expect(current.revision).toBe(58);
      expect(listProjectRevisionRecords(home, 'project-history', current.revision, 5)).toMatchObject([
        { revision: 58, displayName: 'Updated project 58' },
        { revision: 57, displayName: 'Updated project 57' },
        { revision: 56, displayName: 'Updated project 56' },
        { revision: 55, displayName: 'Updated project 55' },
        { revision: 54, displayName: 'Updated project 54' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('resolves one portable Project identity across HTTPS and SSH repository registrations', () => {
    const https = 'https://github.com/moretea-labs/forge.git';
    const ssh = 'git@github.com:moretea-labs/forge.git';
    expect(stablePortableProjectId(https)).toBe(stablePortableProjectId(ssh));
    expect(portableProjectSourceFingerprint(https)).toBe(portableProjectSourceFingerprint(ssh));
  });

  test('syncs semantic visibility between independent Forge instances without importing execution authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-v2-semantic-sync-'));
    try {
      const macHome = join(root, 'mac-controller');
      const wslHome = join(root, 'wsl-controller');
      const remote = 'https://github.com/moretea-labs/forge.git';
      const projectId = stablePortableProjectId(remote);
      const sourceFingerprint = portableProjectSourceFingerprint(remote);
      seedNode(macHome, 'mac-forge', 'repo_mac_local', projectId, sourceFingerprint);
      seedNode(wslHome, 'wsl-forge', 'repo_wsl_local', projectId, sourceFingerprint);

      writeControlPlaneRecord(macHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-SYNC-1',
        schemaVersion: 1,
        value: requirement(),
        expectedRevision: null,
      });
      writeControlPlaneRecord(macHome, {
        namespace: 'plan_contract',
        scope: 'repo_mac_local',
        key: 'PLAN-SYNC-1',
        schemaVersion: 1,
        value: plan(),
        expectedRevision: null,
      });

      const firstBundle = exportSemanticSyncBundle({
        controllerHome: macHome,
        workspaceId: 'workspace-personal',
        projectId,
        now: () => '2026-09-03T00:05:00.000Z',
      });
      const serialized = JSON.stringify(firstBundle);
      expect(firstBundle.sourceForgeInstanceId).toBe('mac-forge');
      expect(firstBundle.records.map((entry) => entry.kind)).toEqual(['plan', 'project', 'requirement', 'workspace']);
      for (const forbidden of ['repo_mac_local', 'WORK-SYNC-1', 'LOCAL-WORK-EVIDENCE-SHOULD-NOT-SYNC']) {
        expect(serialized).not.toContain(forbidden);
      }

      const retiredWorkBundle = {
        ...firstBundle,
        records: [
          ...firstBundle.records,
          { ...firstBundle.records[0]!, kind: 'work' as (typeof firstBundle.records)[number]['kind'] },
        ],
      };
      expect(() =>
        importSemanticSyncBundle({
          controllerHome: wslHome,
          bundle: retiredWorkBundle,
        }),
      ).toThrow('SEMANTIC_SYNC_WORK_RETIRED');

      const firstReceipt = importSemanticSyncBundle({
        controllerHome: wslHome,
        bundle: firstBundle,
        now: () => '2026-09-03T00:06:00.000Z',
      });
      expect(firstReceipt.targetForgeInstanceId).toBe('wsl-forge');
      expect(firstReceipt.converged).toEqual(
        expect.arrayContaining([`workspace:workspace-personal`, `project:${projectId}`]),
      );
      expect(firstReceipt.applied).toEqual(expect.arrayContaining(['requirement:REQ-SYNC-1', 'plan:PLAN-SYNC-1']));
      expect(readControlPlaneRecord(wslHome, 'plan_contract', 'repo_wsl_local', 'PLAN-SYNC-1')).toBeUndefined();
      expect(readControlPlaneRecord(wslHome, 'requirement', 'controller', 'REQ-SYNC-1')).toBeUndefined();
      const replicas = listSemanticSyncReplicas({
        controllerHome: wslHome,
        workspaceId: 'workspace-personal',
        projectId,
      });
      expect(replicas.map((entry) => entry.key).sort()).toEqual(['plan:PLAN-SYNC-1', 'requirement:REQ-SYNC-1']);
      expect(JSON.stringify(replicas)).not.toContain('repo_mac_local');

      writeControlPlaneRecord(macHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-SYNC-1',
        schemaVersion: 1,
        value: requirement('Shared requirement v2', 2),
        expectedRevision: 1,
      });
      const secondBundle = exportSemanticSyncBundle({
        controllerHome: macHome,
        workspaceId: 'workspace-personal',
        projectId,
        targetReplicaRevisions: firstReceipt.replicaRevisions,
        now: () => '2026-09-03T00:07:00.000Z',
      });
      const secondReceipt = importSemanticSyncBundle({
        controllerHome: wslHome,
        bundle: secondBundle,
        now: () => '2026-09-03T00:08:00.000Z',
      });
      expect(secondReceipt.applied).toContain('requirement:REQ-SYNC-1');
      expect(secondReceipt.replicaRevisions['requirement:REQ-SYNC-1']).toBe(2);
      expect(secondReceipt.converged).toContain('plan:PLAN-SYNC-1');

      writeControlPlaneRecord(wslHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-SYNC-1',
        schemaVersion: 1,
        value: requirement('Independent WSL authority', 1),
        expectedRevision: null,
      });
      const thirdBundle = exportSemanticSyncBundle({
        controllerHome: macHome,
        workspaceId: 'workspace-personal',
        projectId,
        targetReplicaRevisions: secondReceipt.replicaRevisions,
        now: () => '2026-09-03T00:09:00.000Z',
      });
      expect(() =>
        importSemanticSyncBundle({
          controllerHome: wslHome,
          bundle: thirdBundle,
          now: () => '2026-09-03T00:10:00.000Z',
        }),
      ).toThrow('SEMANTIC_SYNC_LOCAL_AUTHORITY_CONFLICT: requirement:REQ-SYNC-1');
      expect(readControlPlaneRecord<Requirement>(wslHome, 'requirement', 'controller', 'REQ-SYNC-1')?.value.title).toBe(
        'Independent WSL authority',
      );
      expect(
        readControlPlaneRecord<any>(
          wslHome,
          'semantic_sync_replica',
          `workspace-personal:${projectId}`,
          'requirement:REQ-SYNC-1',
        )?.revision,
      ).toBe(2);
      expect(
        readSemanticSyncJournal({ controllerHome: wslHome, workspaceId: 'workspace-personal', projectId }),
      ).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exports Project-owned Requirements that are not linked by any Plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-v2-semantic-sync-orphan-req-'));
    try {
      const macHome = join(root, 'mac-controller');
      const wslHome = join(root, 'wsl-controller');
      const remote = 'https://github.com/moretea-labs/forge.git';
      const projectId = stablePortableProjectId(remote);
      const sourceFingerprint = portableProjectSourceFingerprint(remote);
      seedNode(macHome, 'mac-forge', 'repo_mac_local', projectId, sourceFingerprint);
      seedNode(wslHome, 'wsl-forge', 'repo_wsl_local', projectId, sourceFingerprint);

      const orphan: Requirement = {
        ...requirement('Project-owned without Plan'),
        requirementId: 'REQ-ORPHAN-1',
        projectId,
      };
      writeControlPlaneRecord(macHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-ORPHAN-1',
        schemaVersion: 1,
        value: orphan,
        expectedRevision: null,
      });
      writeControlPlaneRecord(macHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-OTHER-PROJECT',
        schemaVersion: 1,
        value: {
          ...requirement('Other project requirement'),
          requirementId: 'REQ-OTHER-PROJECT',
          projectId: 'project-other',
        },
        expectedRevision: null,
      });

      const bundle = exportSemanticSyncBundle({
        controllerHome: macHome,
        workspaceId: 'workspace-personal',
        projectId,
        now: () => '2026-09-03T00:12:00.000Z',
      });
      const requirementIds = bundle.records.filter((entry) => entry.kind === 'requirement').map((entry) => entry.id);
      expect(requirementIds).toEqual(['REQ-ORPHAN-1']);
      expect(bundle.records.some((entry) => entry.kind === 'plan')).toBe(false);

      const receipt = importSemanticSyncBundle({
        controllerHome: wslHome,
        bundle,
        now: () => '2026-09-03T00:13:00.000Z',
      });
      expect(receipt.applied).toContain('requirement:REQ-ORPHAN-1');
      expect(
        listSemanticSyncReplicas({ controllerHome: wslHome, workspaceId: 'workspace-personal', projectId }).map(
          (entry) => entry.key,
        ),
      ).toEqual(['requirement:REQ-ORPHAN-1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects cross-scope or forged-source bundles even when their content fingerprint is recomputed', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-v2-semantic-sync-identity-'));
    try {
      const macHome = join(root, 'mac-controller');
      const wslHome = join(root, 'wsl-controller');
      const remote = 'https://github.com/moretea-labs/forge.git';
      const projectId = stablePortableProjectId(remote);
      const sourceFingerprint = portableProjectSourceFingerprint(remote);
      seedNode(macHome, 'mac-forge', 'repo_mac_local', projectId, sourceFingerprint);
      seedNode(wslHome, 'wsl-forge', 'repo_wsl_local', projectId, sourceFingerprint);
      const original = exportSemanticSyncBundle({
        controllerHome: macHome,
        workspaceId: 'workspace-personal',
        projectId,
        now: () => '2026-09-03T00:11:00.000Z',
      });
      const forged = structuredClone(original);
      forged.workspaceId = 'workspace-other';
      const canonical = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                  .filter(([, entry]) => entry !== undefined)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, entry]) => [key, canonical(entry)]),
              )
            : value;
      const { contentFingerprint: _ignored, ...base } = forged;
      forged.contentFingerprint = createHash('sha256')
        .update(JSON.stringify(canonical(base)))
        .digest('hex');
      expect(() => importSemanticSyncBundle({ controllerHome: wslHome, bundle: forged })).toThrow(
        'SEMANTIC_SYNC_WORKSPACE_IDENTITY_MISMATCH',
      );

      const forgedSource = structuredClone(original);
      forgedSource.sourceForgeInstanceId = 'other-forge';
      const { contentFingerprint: _ignored2, ...base2 } = forgedSource;
      forgedSource.contentFingerprint = createHash('sha256')
        .update(JSON.stringify(canonical(base2)))
        .digest('hex');
      expect(() => importSemanticSyncBundle({ controllerHome: wslHome, bundle: forgedSource })).toThrow(
        'SEMANTIC_SYNC_RECORD_SOURCE_MISMATCH: project:',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bounds the sync journal deterministically', () => {
    const entries: SemanticSyncJournalEntry[] = Array.from(
      { length: MAX_SEMANTIC_SYNC_JOURNAL_ENTRIES + 50 },
      (_, index) => ({
        schemaVersion: 1,
        sourceForgeInstanceId: 'mac-forge',
        bundleFingerprint: String(index).padStart(64, '0').slice(-64),
        importedAt: `2026-09-03T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        appliedCount: 1,
        convergedCount: 0,
        sampledKeys: [`work:WORK-${index}`],
      }),
    );
    const bounded = boundedSemanticSyncJournal(entries);
    expect(bounded).toHaveLength(MAX_SEMANTIC_SYNC_JOURNAL_ENTRIES);
    expect(bounded[0]?.sampledKeys[0]).toBe('work:WORK-50');
    expect(bounded.at(-1)?.sampledKeys[0]).toBe(`work:WORK-${MAX_SEMANTIC_SYNC_JOURNAL_ENTRIES + 49}`);
  });
});
