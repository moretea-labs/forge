import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { selectCrossProjectRequirementCandidates } from '../../src/runtime/control-plane/facade/cross-project-requirement-dispatch';
import type { Requirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  writeProjectIdentity,
  writeWorkspaceIdentity,
} from '../../src/runtime/control-plane/workspace/workspace-store';

function requirement(overrides: Partial<Requirement>): Requirement {
  return {
    schemaVersion: 1,
    requirementId: 'REQ-1',
    legacyAliases: [],
    title: 'Task',
    outcomeStatement: 'Outcome',
    acceptanceCriteria: ['Done'],
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

describe('cross-project Requirement dispatch selection (refs #707)', () => {
  test('inherits Project default priority and classifies dependency blockers', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-cross-project-dispatch-'));
    const controllerHome = join(root, 'controller');
    try {
      ensureForgeInstanceIdentity({
        controllerHome,
        preferredInstanceId: 'dispatch-forge',
        now: () => '2026-09-03T00:00:00.000Z',
      });
      writeWorkspaceIdentity({
        controllerHome,
        value: { workspaceId: 'workspace-personal', title: 'Personal' },
        expectedRevision: null,
      });
      writeProjectIdentity({
        controllerHome,
        value: {
          projectId: 'project-a',
          workspaceId: 'workspace-personal',
          displayName: 'Project A',
          defaultRequirementPriority: 'high',
        },
        expectedRevision: null,
      });
      writeProjectIdentity({
        controllerHome,
        value: {
          projectId: 'project-b',
          workspaceId: 'workspace-personal',
          displayName: 'Project B',
        },
        expectedRevision: null,
      });

      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-DEP',
        schemaVersion: 1,
        value: requirement({
          requirementId: 'REQ-DEP',
          projectId: 'project-a',
          title: 'Dependency',
          state: 'active',
          updatedAt: '2026-09-03T00:01:00.000Z',
        }),
        expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-BLOCKED',
        schemaVersion: 1,
        value: requirement({
          requirementId: 'REQ-BLOCKED',
          projectId: 'project-a',
          title: 'Blocked child',
          state: 'active',
          dependsOnRequirementIds: ['REQ-DEP'],
          updatedAt: '2026-09-03T00:02:00.000Z',
        }),
        expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-URGENT',
        schemaVersion: 1,
        value: requirement({
          requirementId: 'REQ-URGENT',
          projectId: 'project-b',
          title: 'Explicit urgent',
          state: 'planned',
          priority: 'urgent',
          updatedAt: '2026-09-03T00:03:00.000Z',
        }),
        expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement',
        scope: 'controller',
        key: 'REQ-WAIT',
        schemaVersion: 1,
        value: requirement({
          requirementId: 'REQ-WAIT',
          projectId: 'project-b',
          title: 'Needs user',
          state: 'waiting_for_user',
          updatedAt: '2026-09-03T00:04:00.000Z',
        }),
        expectedRevision: null,
      });

      const selection = selectCrossProjectRequirementCandidates({
        controllerHome,
        now: () => '2026-09-03T00:10:00.000Z',
      });
      expect(selection.ready.map((entry) => entry.requirementId)).toEqual(['REQ-URGENT', 'REQ-DEP']);
      expect(selection.ready[0]).toMatchObject({
        requirementId: 'REQ-URGENT',
        effectivePriority: 'urgent',
        prioritySource: 'requirement',
      });
      expect(selection.ready[1]).toMatchObject({
        requirementId: 'REQ-DEP',
        effectivePriority: 'high',
        prioritySource: 'project_default',
      });
      const blocked = selection.candidates.find((entry) => entry.requirementId === 'REQ-BLOCKED');
      expect(blocked).toMatchObject({
        readiness: 'blocked',
        blockingRequirementIds: ['REQ-DEP'],
        effectivePriority: 'high',
        prioritySource: 'project_default',
      });
      const waiting = selection.candidates.find((entry) => entry.requirementId === 'REQ-WAIT');
      expect(waiting?.readiness).toBe('waiting_for_user');
      expect(selection.counts.ready).toBe(2);
      expect(selection.counts.blocked).toBe(1);
      expect(selection.counts.waiting_for_user).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
