import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
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
import { createIssue, projectBoard, updateIssue } from '../../src/cli/controller/issue-store';
import { clearCurrentIssue, saveControllerProjectState } from '../../src/cli/controller/project-state';
import { migratedTaskCompletionState, recordMigratedTaskCompletion } from '../../src/cli/controller/legacy-issue-cutover';
import { exportRequirementPortfolio } from '../../src/cli/controller/requirement-portfolio-export';
import { applyMigratedIssueDecision } from '../../src/cli/controller/migrated-issue-decision';
import { listControlPlaneRecords } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { getPlanContract, listPlanContracts } from '../../src/runtime/control-plane/facade/plan-contract-store';
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
    const tasks = entry.issueId === 'ISS-20260802-7E1D69'
      ? [
          task(entry.issueId, 'T1', 'done'),
          task(entry.issueId, 'T5', 'ready'),
          task(entry.issueId, 'T6', 'ready'),
          task(entry.issueId, 'T7', 'ready'),
        ]
      : [task(entry.issueId, 'T1', taskStatus)];
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

  test('applies explicit legacy Issue close and block decisions to Requirement/Plan authority without rewriting frozen files', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'requirement-decision-repo-'));
    const controllerHome = join(repoRoot, '_ops', 'controller-home');
    try {
      mkdirSync(join(repoRoot, '.ai', 'harness'), { recursive: true });
      writeFileSync(join(repoRoot, '.ai', 'harness', 'repository.json'), `${JSON.stringify({ schemaVersion: 1, repoId: REPO_ID }, null, 2)}\n`, 'utf8');
      const legacyIssue = createIssue(repoRoot, {
        title: 'Frozen legacy issue',
        kind: 'bug',
        summary: 'Frozen after migration.',
        tasks: [{ title: 'Legacy task', objective: 'Historical only.' }],
      });
      const issueDir = join(repoRoot, 'tasks', 'issues');
      const beforeFiles = readdirSync(issueDir).sort();
      const beforeContents = Object.fromEntries(beforeFiles.map((name) => [name, readFileSync(join(issueDir, name), 'utf8')]));
      applyRequirementPortfolioMigration(input(controllerHome));

      const closed = applyMigratedIssueDecision(repoRoot, {
        issueId: 'ISS-20260731-B66A97',
        status: 'done',
        summary: 'User accepted the delivered route-integrity outcome; remaining old fault-matrix steps move to current architecture work.',
      });
      expect(closed).toMatchObject({ migrated: true, legacyIssueFrozen: true, legacyIssueId: 'ISS-20260731-B66A97' });
      expect(closed).toMatchObject({ legacyPlanClosed: true, requirementClosed: false });
      expect(closed?.requirement).toMatchObject({ requirementId: 'REQ-ROUTE-INTEGRITY', state: 'active', needsAttention: true });
      expect(closed?.plan.status).toBe('superseded');
      expect(closed?.plan.steps.some((step) => step.status !== 'completed')).toBe(true);
      const repeated = applyMigratedIssueDecision(repoRoot, {
        issueId: 'ISS-20260731-B66A97',
        status: 'done',
        summary: 'User accepted the delivered route-integrity outcome; remaining old fault-matrix steps move to current architecture work.',
      });
      expect(repeated?.decisionId).toBe(closed?.decisionId);
      expect(repeated?.requirement.revision).toBe(closed?.requirement.revision);
      const resumedSibling = applyMigratedIssueDecision(repoRoot, {
        issueId: 'ISS-20260803-90E84B',
        status: 'in_progress',
      });
      expect(resumedSibling?.requirement.state).toBe('active');

      const remoteRecovery = applyMigratedIssueDecision(repoRoot, {
        issueId: 'ISS-20260802-27931A',
        status: 'done',
        summary: 'The standalone remote Recovery outcome is delivered; remaining fault drills are owned by runtime availability work.',
      });
      expect(remoteRecovery).toMatchObject({ legacyPlanClosed: true, requirementClosed: true });
      expect(remoteRecovery?.requirement).toMatchObject({ requirementId: 'REQ-REMOTE-RECOVERY', state: 'done' });
      expect(() => applyMigratedIssueDecision(repoRoot, {
        issueId: 'ISS-20260802-27931A',
        status: 'in_progress',
      })).toThrow('MIGRATED_REQUIREMENT_STATE_TRANSITION_INVALID');

      const blocked = applyMigratedIssueDecision(repoRoot, {
        issueId: 'ISS-20260730-CCF211',
        status: 'launch_blocked',
        summary: 'Retain the investigation, but redesign the experiment and plan against the current Requirement/Work architecture.',
      });
      expect(blocked?.requirement).toMatchObject({
        requirementId: 'REQ-DEFECT-REVIEW',
        state: 'planned',
        needsAttention: true,
        attentionSummary: 'Retain the investigation, but redesign the experiment and plan against the current Requirement/Work architecture.',
      });
      expect(blocked?.plan.status).toBe('replanning');
      expect(() => applyMigratedIssueDecision(repoRoot, {
        issueId: 'ISS-20260730-CCF211',
        goals: ['Unsupported compatibility mutation'],
      })).toThrow('MIGRATED_ISSUE_FIELD_RETIRED');

      expect(readdirSync(issueDir).sort()).toEqual(beforeFiles);
      expect(Object.fromEntries(beforeFiles.map((name) => [name, readFileSync(join(issueDir, name), 'utf8')]))).toEqual(beforeContents);
      expect(() => updateIssue(repoRoot, legacyIssue.id, { summary: 'Still frozen.' })).toThrow('LEGACY_ISSUE_WRITES_RETIRED');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
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

  test('retires legacy writes, records migrated completion, and exports deterministic offline snapshots', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'requirement-cutover-repo-'));
    const controllerHome = join(repoRoot, '_ops', 'controller-home');
    try {
      mkdirSync(join(repoRoot, '.ai', 'harness'), { recursive: true });
      writeFileSync(join(repoRoot, '.ai', 'harness', 'repository.json'), `${JSON.stringify({ schemaVersion: 1, repoId: REPO_ID }, null, 2)}\n`, 'utf8');
      const legacyIssue = createIssue(repoRoot, {
        title: 'Legacy writable fixture',
        kind: 'feature',
        summary: 'This file becomes frozen history after cutover.',
        tasks: [{ title: 'Legacy task', objective: 'Do not mutate after migration.' }],
      });
      const issueDir = join(repoRoot, 'tasks', 'issues');
      const beforeFiles = readdirSync(issueDir).sort();
      const beforeContents = Object.fromEntries(beforeFiles.map((name) => [name, readFileSync(join(issueDir, name), 'utf8')]));

      applyRequirementPortfolioMigration(input(controllerHome));
      expect(() => updateIssue(repoRoot, legacyIssue.id, { summary: 'Refused mutation.' })).toThrow('LEGACY_ISSUE_WRITES_RETIRED');
      expect(() => createIssue(repoRoot, { title: 'Refused new durable Issue', kind: 'bug' })).toThrow('LEGACY_ISSUE_WRITES_RETIRED');
      expect(() => projectBoard(repoRoot)).toThrow('LEGACY_PROJECT_BOARD_RETIRED');
      expect(() => saveControllerProjectState(repoRoot, { currentIssueId: legacyIssue.id })).toThrow('LEGACY_CURRENT_ISSUE_RETIRED');
      expect(clearCurrentIssue(repoRoot).currentIssueId).toBeUndefined();
      expect(readdirSync(issueDir).sort()).toEqual(beforeFiles);
      expect(Object.fromEntries(beforeFiles.map((name) => [name, readFileSync(join(issueDir, name), 'utf8')]))).toEqual(beforeContents);

      const t6Receipt = completionReceipt('ISS-20260802-7E1D69', 'T6');
      const first = recordMigratedTaskCompletion(repoRoot, {
        issueId: 'ISS-20260802-7E1D69',
        taskId: 'T6',
        receipt: t6Receipt,
        reviewer: 'test',
        checks: [{ checkId: 'package:check:type', ok: true, summary: 'passed' }],
      });
      expect(first).toMatchObject({ migrated: true, completed: true, planId: 'PLAN-20260802-7E1D69', receiptId: t6Receipt.receiptId });
      expect(migratedTaskCompletionState(repoRoot, 'ISS-20260802-7E1D69', 'T6')).toMatchObject({ completed: true, receiptId: t6Receipt.receiptId });
      expect(recordMigratedTaskCompletion(repoRoot, {
        issueId: 'ISS-20260802-7E1D69', taskId: 'T6', receipt: t6Receipt, reviewer: 'test',
      }).receiptId).toBe(t6Receipt.receiptId);
      expect(getPlanContract({ controllerHome, repoId: REPO_ID }, 'PLAN-20260802-7E1D69')?.steps.find((step) => step.id === 'T6')).toMatchObject({ status: 'completed' });
      expect(listRequirements({ controllerHome }, 100).find((record) => record.value.requirementId === 'REQ-CONTROL-PLANE')?.value.state).toBe('active');

      const t7Receipt = completionReceipt('ISS-20260802-7E1D69', 'T7');
      recordMigratedTaskCompletion(repoRoot, { issueId: 'ISS-20260802-7E1D69', taskId: 'T7', receipt: t7Receipt, reviewer: 'test' });
      expect(listRequirements({ controllerHome }, 100).find((record) => record.value.requirementId === 'REQ-CONTROL-PLANE')?.value.state).toBe('done');

      const outputDir = join(repoRoot, 'offline-requirement-export');
      const exported = exportRequirementPortfolio({ controllerHome, repoId: REPO_ID, repoRoot, outputDir });
      const firstManifest = readFileSync(join(outputDir, 'manifest.json'), 'utf8');
      const repeated = exportRequirementPortfolio({ controllerHome, repoId: REPO_ID, repoRoot, outputDir });
      expect(repeated).toEqual(exported);
      expect(readFileSync(join(outputDir, 'manifest.json'), 'utf8')).toBe(firstManifest);
      expect(readdirSync(join(outputDir, 'requirements')).some((name) => name === 'REQ-CONTROL-PLANE.json')).toBe(true);
      expect(exported).toMatchObject({ requirementCount: 10, planCount: 36 });
      expect(() => exportRequirementPortfolio({ controllerHome, repoId: REPO_ID, repoRoot, outputDir: issueDir })).toThrow('REQUIREMENT_EXPORT_LEGACY_AUTHORITY_PATH_REFUSED');
      expect(readdirSync(issueDir).sort()).toEqual(beforeFiles);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
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
