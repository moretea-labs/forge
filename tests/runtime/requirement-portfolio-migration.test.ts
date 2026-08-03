import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ControllerIssue, ControllerTask, IssueStatus, TaskStatus } from '../../src/cli/controller/types';
import {
  CANONICAL_REQUIREMENTS,
  PORTFOLIO_ISSUE_MAPPINGS,
  applyRequirementPortfolioMigration,
  prepareRequirementPortfolioMigration,
} from '../../src/cli/controller/requirement-portfolio-migration';
import { createRequirement, listRequirements } from '../../src/runtime/control-plane/persistence/requirement-store';
import { listControlPlaneRecords } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { listPlanContracts } from '../../src/runtime/control-plane/facade/plan-contract-store';
import { buildExecutionDiagnostics } from '../../src/runtime/control-plane/facade/requirement-board';

const REPO_ID = 'repo_portfolio_test';
const SOURCE_REVISION = 'a'.repeat(40);
const NOW = '2026-08-03T12:00:00.000Z';

function completionReceipt(issueId: string, taskId: string) {
  return {
    schemaVersion: 1 as const,
    receiptId: `REC-${issueId}-${taskId}`,
    source: 'direct_edit' as const,
    issueId,
    taskId,
    targetBranch: 'main',
    targetRevision: `rev-${issueId}`,
    changedPaths: [`src/${issueId}.ts`],
    delivery: { kind: 'commit' as const, status: 'integrated' as const, strategy: 'already_integrated' as const, reachable: true, recordedAt: NOW },
    cleanup: { status: 'complete' as const, warnings: [], blockers: [], recordedAt: NOW },
    verifiedAt: NOW,
    recordedAt: NOW,
  };
}

function task(issueId: string, taskId: string, status: TaskStatus): ControllerTask {
  const terminal = ['done', 'cancelled', 'superseded'].includes(status);
  return {
    repoId: REPO_ID,
    id: taskId,
    title: `Task ${taskId} for ${issueId}`,
    objective: `Preserve the exact legacy objective for ${issueId}/${taskId}.`,
    status,
    dependsOn: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: ['_ops/**'],
    checks: ['package:check:type'],
    acceptanceCriteria: ['Evidence remains queryable.'],
    risk: 'medium',
    notes: terminal ? [`Historical terminal note for ${issueId}/${taskId}.`] : [],
    runIds: terminal ? [`RUN-${issueId}-${taskId}`] : [],
    verification: status === 'done' ? {
      repoId: REPO_ID,
      integratedRevision: `rev-${issueId}`,
      checkResults: [{ checkId: 'package:check:type', ok: true }],
      acceptanceResults: [{ criterion: 'Evidence remains queryable.', ok: true }],
      reviewer: 'test',
      verifiedAt: NOW,
      completionReceipt: completionReceipt(issueId, taskId),
    } : undefined,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixtureStatus(issueId: string, disposition: string, requirementId: string): IssueStatus {
  const definition = CANONICAL_REQUIREMENTS.find((candidate) => candidate.requirementId === requirementId)!;
  if (disposition === 'superseded') return 'cancelled';
  if (disposition === 'historical' || definition.state === 'done') return 'done';
  if (issueId === 'ISS-20260802-7E1D69') return 'in_progress';
  if (issueId === 'ISS-20260731-6A7BB5' || issueId === 'ISS-20260731-B66A97') return 'review';
  if (definition.needsAttention) return 'launch_blocked';
  return 'planned';
}

function fixtures(): ControllerIssue[] {
  return PORTFOLIO_ISSUE_MAPPINGS.map((entry) => {
    const status = fixtureStatus(entry.issueId, entry.disposition, entry.requirementId);
    const taskStatus: TaskStatus = status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'ready';
    const tasks = [task(entry.issueId, 'T1', taskStatus)];
    if (entry.issueId === 'ISS-20260802-7E1D69') tasks.push(task(entry.issueId, 'T5', 'ready'));
    return {
      schemaVersion: 5,
      repoId: entry.issueId === 'ISS-20260726-69DA83' ? 'repo_legacy_registration' : REPO_ID,
      id: entry.issueId,
      title: `Legacy ${entry.issueId}`,
      slug: entry.issueId.toLowerCase(),
      kind: 'governance',
      status,
      summary: `Legacy summary for ${entry.issueId}.`,
      goals: [`Goal for ${entry.issueId}.`],
      nonGoals: ['Do not create a duplicate Requirement.'],
      acceptanceCriteria: [`Acceptance for ${entry.issueId}.`],
      relatedArtifacts: [`artifact-${entry.issueId}`],
      tasks,
      createdAt: NOW,
      updatedAt: NOW,
    } satisfies ControllerIssue;
  });
}

function withHome(run: (controllerHome: string) => void): void {
  const controllerHome = mkdtempSync(join(tmpdir(), 'requirement-portfolio-'));
  try {
    run(controllerHome);
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
}

function input(controllerHome: string, issues = fixtures()) {
  return { controllerHome, repoId: REPO_ID, sourceRevision: SOURCE_REVISION, issues, now: () => NOW };
}

describe('Requirement portfolio migration', () => {
  test('atomically imports 36 Issues into 10 Requirements and owned Plans, then deduplicates', () => {
    withHome((controllerHome) => {
      const prepared = prepareRequirementPortfolioMigration(input(controllerHome));
      expect(prepared.requirements).toHaveLength(10);
      expect(prepared.plans).toHaveLength(36);
      expect(new Set(prepared.plans.map((plan) => plan.requirementId)).size).toBe(10);
      expect(prepared.migrationRecord.requirementStateCounts).toEqual({ planned: 3, active: 5, waiting_for_user: 0, done: 2, cancelled: 0 });

      const first = applyRequirementPortfolioMigration(input(controllerHome));
      expect(first).toMatchObject({ status: 'applied', sourceIssueCount: 36, frozenIssueCount: 33, postSnapshotIssueCount: 3, requirementCount: 10, planCount: 36 });
      const requirements = listRequirements({ controllerHome }, 100).map((record) => record.value);
      expect(requirements).toHaveLength(10);
      expect(requirements.find((requirement) => requirement.requirementId === 'REQ-TRUSTED-EXECUTION')?.state).toBe('done');
      expect(requirements.find((requirement) => requirement.requirementId === 'REQ-ROUTE-INTEGRITY')?.legacyAliases).toEqual(expect.arrayContaining([
        'ISS-20260731-B66A97',
        'ISS-20260803-02317D',
        'ISS-20260803-90E84B',
      ]));

      const plans = listPlanContracts({ controllerHome, repoId: REPO_ID, status: 'all', limit: 100 });
      expect(plans).toHaveLength(36);
      expect(plans.every((plan) => Boolean(plan.requirementId) && plan.repoId === REPO_ID)).toBe(true);
      expect(plans.find((plan) => plan.planId === 'PLAN-20260726-69DA83')?.evidenceRefs[0]?.summary).toContain('repo_legacy_registration');
      const controlPlan = plans.find((plan) => plan.planId === 'PLAN-20260802-7E1D69')!;
      expect(controlPlan.requirementId).toBe('REQ-CONTROL-PLANE');
      expect(controlPlan.steps.find((step) => step.id === 'T5')).toMatchObject({ status: 'completed' });
      expect(controlPlan.steps.find((step) => step.id === 'T5')?.evidenceRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ evidenceId: 'requirement-portfolio-20260802-v1' }),
      ]));

      const diagnostics = buildExecutionDiagnostics({ controllerHome, repoId: REPO_ID, detailLevel: 'detail', requirementId: 'REQ-ROUTE-INTEGRITY' });
      expect(diagnostics.planCount).toBeGreaterThanOrEqual(3);
      expect((diagnostics.plans as Array<Record<string, unknown>>).every((plan) => plan.requirementId === 'REQ-ROUTE-INTEGRITY')).toBe(true);
      expect(JSON.stringify(diagnostics)).toContain('Legacy Issue ISS-20260731-B66A97');

      const revisionsBefore = listControlPlaneRecords(controllerHome, { namespace: 'requirement', scope: 'controller', limit: 100 }).map((record) => record.revision);
      const second = applyRequirementPortfolioMigration(input(controllerHome));
      expect(second.status).toBe('deduplicated');
      expect(listControlPlaneRecords(controllerHome, { namespace: 'requirement', scope: 'controller', limit: 100 }).map((record) => record.revision)).toEqual(revisionsBefore);
    });
  });

  test('fails closed before writing when the source set is missing or unknown', () => {
    withHome((controllerHome) => {
      const missing = fixtures().slice(1);
      expect(() => applyRequirementPortfolioMigration(input(controllerHome, missing))).toThrow('REQUIREMENT_PORTFOLIO_SOURCE_SET_MISMATCH');
      expect(listRequirements({ controllerHome }, 100)).toEqual([]);

      const unknown = fixtures();
      unknown.push({ ...unknown[0], id: 'ISS-UNKNOWN', title: 'Unknown source' });
      expect(() => applyRequirementPortfolioMigration(input(controllerHome, unknown))).toThrow('REQUIREMENT_PORTFOLIO_SOURCE_SET_MISMATCH');
      expect(listRequirements({ controllerHome }, 100)).toEqual([]);
    });
  });

  test('rejects partial authority and rejects a changed source after migration', () => {
    withHome((controllerHome) => {
      createRequirement({ controllerHome, now: () => NOW }, {
        requirementId: 'REQ-CONTROL-PLANE',
        title: 'Conflicting partial record',
        outcomeStatement: 'Do not overwrite this partial authority.',
      });
      expect(() => applyRequirementPortfolioMigration(input(controllerHome))).toThrow('REQUIREMENT_PORTFOLIO_PARTIAL_AUTHORITY');
      expect(listRequirements({ controllerHome }, 100)).toHaveLength(1);
    });

    withHome((controllerHome) => {
      applyRequirementPortfolioMigration(input(controllerHome));
      const changed = fixtures();
      changed[0] = { ...changed[0], title: 'Drifted source title' };
      expect(() => applyRequirementPortfolioMigration(input(controllerHome, changed))).toThrow('REQUIREMENT_PORTFOLIO_ALREADY_MIGRATED_DIFFERENT_SOURCE');
      expect(listRequirements({ controllerHome }, 100)).toHaveLength(10);
    });
  });
});
