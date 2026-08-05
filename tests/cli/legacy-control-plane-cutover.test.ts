import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { getIssueReadView, createIssue, updateTask } from '../../src/cli/controller/issue-store';
import { buildControllerTaskLedgerProjection, writeControllerTaskLedgerArtifacts } from '../../src/cli/controller/task-ledger';
import { getProjectProgress } from '../../src/cli/controller/progress';
import { inspectProjectGovernance, reconcileProjectGovernance } from '../../src/cli/controller/governance';
import { clearCurrentIssue, loadControllerProjectState, saveControllerProjectState } from '../../src/cli/controller/project-state';
import { finishEditSession, finishTaskRun } from '../../src/cli/controller/completion-orchestrator';
import { applyCompletionDecision, finishCompletionBacklog, inspectCompletionBacklog } from '../../src/cli/controller/completion-backlog';
import { continueTaskAfterSuccessfulRun } from '../../src/cli/controller/execution-completion';
import { applyStuckStateMigration, inspectStuckControllerStates } from '../../src/cli/controller/stuck-state-migration';

const REPO_ID = 'repo_cutover_cli';
const ISSUE_ID = 'ISS-20260802-7E1D69';
const PLAN_ID = 'PLAN-20260802-7E1D69';
const REQUIREMENT_ID = 'REQ-CONTROL-PLANE';
const NOW = '2026-08-05T00:00:00.000Z';

function withRepo(run: (repoRoot: string, controllerHome: string, issuePath: string) => void): void {
  const repoRoot = mkdtempSync(join(tmpdir(), 'legacy-cutover-cli-'));
  const controllerHome = join(repoRoot, '_ops', 'controller-home');
  const issueDir = join(repoRoot, 'tasks', 'issues');
  const issuePath = join(issueDir, `${ISSUE_ID}-legacy.issue.json`);
  try {
    mkdirSync(join(repoRoot, '.ai', 'harness'), { recursive: true });
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(repoRoot, '.ai', 'harness', 'repository.json'), `${JSON.stringify({ schemaVersion: 1, repoId: REPO_ID }, null, 2)}\n`);
    writeFileSync(join(repoRoot, '.ai', 'harness', 'project-state.json'), `${JSON.stringify({ schemaVersion: 1, currentIssueId: ISSUE_ID, issueCreationMode: 'open', updatedAt: NOW }, null, 2)}\n`);
    writeFileSync(issuePath, `${JSON.stringify({
      schemaVersion: 5,
      id: ISSUE_ID,
      title: 'Untrusted legacy title',
      status: 'in_progress',
      tasks: [{ id: 'T6', title: 'Untrusted task', status: 'running' }],
      createdAt: NOW,
      updatedAt: NOW,
    }, null, 2)}\n`);

    writeControlPlaneRecord(controllerHome, {
      namespace: 'requirement', scope: 'controller', key: REQUIREMENT_ID, schemaVersion: 1,
      value: {
        requirementId: REQUIREMENT_ID,
        title: 'SQLite authoritative control plane',
        outcomeStatement: 'Only SQLite may mutate control-plane lifecycle state.',
        state: 'done',
        needsAttention: false,
        legacyAliases: [ISSUE_ID],
        createdAt: NOW,
        updatedAt: NOW,
      }, expectedRevision: null,
    });
    writeControlPlaneRecord(controllerHome, {
      namespace: 'plan_contract', scope: REPO_ID, key: PLAN_ID, schemaVersion: 1,
      value: {
        schemaVersion: 1,
        planId: PLAN_ID,
        requirementId: REQUIREMENT_ID,
        repoId: REPO_ID,
        goal: 'Final SQLite cutover',
        status: 'completed',
        steps: [
          { id: 'T6', objective: 'Remove legacy writers', status: 'completed', checks: ['package:check:type'], acceptanceCriteria: ['No dual writer'], evidenceRefs: [] },
          { id: 'T7', objective: 'Verify recovery', status: 'completed', checks: ['package:test'], acceptanceCriteria: ['Restore verified'], evidenceRefs: [] },
        ],
        evidenceRefs: [],
        createdAt: NOW,
        updatedAt: NOW,
      }, expectedRevision: null,
    });
    writeControlPlaneRecord(controllerHome, {
      namespace: 'requirement_portfolio_migration', scope: REPO_ID, key: 'requirement-portfolio-20260802-v1', schemaVersion: 1,
      value: {
        schemaVersion: 1,
        migrationId: 'requirement-portfolio-20260802-v1',
        repoId: REPO_ID,
        sourceRevision: 'a'.repeat(40),
        sourceFingerprint: 'source',
        mappingFingerprint: 'mapping',
        sourceIssueIds: [ISSUE_ID],
        frozenIssueIds: [ISSUE_ID],
        postSnapshotIssueIds: [],
        requirementIds: [REQUIREMENT_ID],
        planIds: [PLAN_ID],
        requirementStateCounts: { planned: 0, active: 0, waiting_for_user: 0, done: 1, cancelled: 0 },
        appliedAt: NOW,
      }, expectedRevision: null,
    });
    run(repoRoot, controllerHome, issuePath);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe('legacy control-plane cutover', () => {
  test('late Issue/Task and project-state writes cannot change the SQLite-derived compatibility projection', () => {
    withRepo((repoRoot, _controllerHome, issuePath) => {
      const before = getIssueReadView(repoRoot, ISSUE_ID, 'full');
      expect(before).toMatchObject({
        projection: 'deprecated_frozen_legacy_issue',
        authority: 'controller-home-sqlite',
        title: 'SQLite authoritative control plane',
        status: 'done',
      });
      expect(before.tasks.find((task) => ('taskId' in task ? task.taskId : task.id) === 'T6')).toMatchObject({
        status: 'done', planStepStatus: 'completed', deprecated: true, frozen: true, readOnly: true,
      });

      writeFileSync(issuePath, `${JSON.stringify({ id: ISSUE_ID, title: 'Late overwrite', status: 'cancelled', tasks: [{ id: 'T6', status: 'cancelled' }] }, null, 2)}\n`);
      writeFileSync(join(repoRoot, '.ai', 'harness', 'project-state.json'), `${JSON.stringify({ schemaVersion: 1, currentIssueId: 'ISS-LATE', issueCreationMode: 'open', updatedAt: '2099-01-01T00:00:00.000Z' })}\n`);

      expect(getIssueReadView(repoRoot, ISSUE_ID, 'full')).toEqual(before);
      const frozenState = loadControllerProjectState(repoRoot);
      expect(frozenState).toMatchObject({
        issueCreationMode: 'paused',
        deprecated: true,
        frozen: true,
        authority: 'controller-home-sqlite',
      });
      expect(frozenState.currentIssueId).toBeUndefined();
      const clearedState = clearCurrentIssue(repoRoot);
      expect(clearedState).toMatchObject({ frozen: true, authority: 'controller-home-sqlite' });
      expect(clearedState.currentIssueId).toBeUndefined();
      expect(readFileSync(issuePath, 'utf8')).toContain('Late overwrite');
    });
  });

  test('default progress, governance and task ledger expose Requirement authority only', () => {
    withRepo((repoRoot) => {
      const progress = getProjectProgress(repoRoot);
      expect(progress).toMatchObject({
        view: 'requirement_progress',
        authority: 'controller-home-sqlite',
        issues: [],
        taskCount: 0,
      });
      expect(JSON.stringify(progress.requirementBoard)).toContain(REQUIREMENT_ID);

      const governance = inspectProjectGovernance(repoRoot);
      expect(governance).toMatchObject({
        view: 'requirement_governance',
        authority: 'controller-home-sqlite',
        activeIssueCount: 0,
        executionQueue: [],
      });
      expect(JSON.stringify(governance.requirements)).toContain(REQUIREMENT_ID);

      const ledger = buildControllerTaskLedgerProjection(repoRoot);
      expect(ledger).toMatchObject({
        deprecated: true,
        frozen: true,
        readOnly: true,
        authority: 'controller-home-sqlite',
        issues: [],
        readyTasks: [],
      });
    });
  });

  test('all exposed legacy mutations fail before reading or writing frozen files', () => {
    withRepo((repoRoot, _controllerHome, issuePath) => {
      const before = readFileSync(issuePath, 'utf8');
      expect(() => createIssue(repoRoot, { title: 'Refused durable Issue' })).toThrow('LEGACY_ISSUE_WRITES_RETIRED');
      expect(() => updateTask(repoRoot, ISSUE_ID, 'T6', { status: 'cancelled' })).toThrow('LEGACY_ISSUE_WRITES_RETIRED');
      expect(() => saveControllerProjectState(repoRoot, { currentIssueId: ISSUE_ID })).toThrow('LEGACY_CURRENT_ISSUE_RETIRED');
      expect(() => saveControllerProjectState(repoRoot, { issueCreationMode: 'open' })).toThrow('LEGACY_PROJECT_STATE_WRITES_RETIRED');
      expect(() => writeControllerTaskLedgerArtifacts(repoRoot)).toThrow('LEGACY_TASK_LEDGER_WRITES_RETIRED');
      expect(() => reconcileProjectGovernance(repoRoot)).toThrow('LEGACY_GOVERNANCE_RECONCILIATION_RETIRED');
      expect(() => finishTaskRun(repoRoot, { runId: 'RUN-MISSING' })).toThrow('LEGACY_TASK_RUN_COMPLETION_RETIRED');
      expect(() => finishEditSession(repoRoot, { sessionId: 'EDIT-MISSING' })).toThrow('LEGACY_EDIT_SESSION_COMPLETION_RETIRED');
      expect(() => finishCompletionBacklog(repoRoot, { dryRun: false })).toThrow('LEGACY_COMPLETION_BACKLOG_RETIRED');
      expect(() => applyCompletionDecision(repoRoot, { action: 'finish', runId: 'RUN-MISSING' })).toThrow('LEGACY_COMPLETION_DECISION_RETIRED');
      expect(() => applyStuckStateMigration(repoRoot, { dryRun: false })).toThrow('LEGACY_STUCK_STATE_MIGRATION_RETIRED');
      expect(inspectCompletionBacklog(repoRoot)).toMatchObject({ items: [], finishableRunIds: [], needsHumanReviewRunIds: [] });
      expect(inspectStuckControllerStates(repoRoot)).toMatchObject({ findings: [] });
      expect(continueTaskAfterSuccessfulRun(repoRoot, { status: 'succeeded' } as never)).toMatchObject({
        continued: false,
        reason: expect.stringContaining('retired after SQLite cutover'),
      });
      expect(readFileSync(issuePath, 'utf8')).toBe(before);
    });
  });

  test('Local Bridge marks old mutation routes as retired and its snapshot is Requirement-centered', () => {
    const source = readFileSync(join(process.cwd(), 'src/cli/local-bridge/server.ts'), 'utf8');
    expect(source).toContain('LEGACY_CONTROL_PLANE_MUTATION_RETIRED');
    expect(source).toContain('buildRequirementBoard');
    expect(source).toContain('buildExecutionDiagnostics');
    expect(source).toContain('issueToolsAvailable: !retiredLegacyControlPlane');
    for (const route of [
      '/api/project-state', '/api/issues/:issueId/focus', '/api/issues/:issueId/archive', '/api/issues/:issueId/restore',
      '/api/issues/:issueId/tasks/:taskId/verify', '/api/issues/:issueId/tasks/:taskId/accept',
      '/api/issues/:issueId/tasks/:taskId/request-changes', '/api/issues/:issueId/tasks/:taskId/cancel',
      '/api/issues/:issueId/tasks/:taskId/dependencies',
    ]) expect(source).toContain(route);
    expect((source.match(/legacyControlPlaneMutationRetiredPayload\(\)/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
});
