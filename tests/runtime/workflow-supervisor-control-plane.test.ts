import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { beginInitialControllerRoundDispatch, getRequirementControllerRoundRelay } from '../../packages/kernel/controller/api/index';
import { cancelWorkContract, createWorkContract, implementationReviewChangedPathDigest, recordWorkCompletionReceipt, recordWorkImplementationReview, requestWorkImplementationReview, transitionWorkContractPhase } from '../../packages/kernel/work/api/index';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { forgeWorkflowSupervisorLifecycleHooks } from '../../src/runtime/root/workflow-supervisor-composition';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { reconcileWorkflowSupervisorSocket } from '../../supervisor/server';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-terminal-reconcile-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  ensureControllerHome(controllerHome);
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'supervisor@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Supervisor Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), 'supervisor terminal reconciliation\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'supervisor-terminal-reconcile' });
  return { root, controllerHome, repoRoot, repository, store: { controllerHome, repoId: repository.repoId } };
}

describe('Workflow Supervisor canonical lifecycle projection', () => {
  test('retires a stale relay when its canonical origin Work is cancelled', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-terminal-reconcile';
    const workId = 'work-supervisor-terminal-reconcile';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor terminal reconciliation', outcomeStatement: 'Retire stale outer-turn authority after canonical Work cancellation.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, mode: 'goal_workloop',
      objective: 'Prove canonical terminal Work authority retires the stale Supervisor relay.',
      acceptanceCriteria: ['cancelled Work cannot remain an active outer-turn authority'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
    });
    const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(join(fx.root, 'supervisor-home')), {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const taskId = `forge:${fx.repository.repoId}:requirement:${requirementId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`, objective: 'Retire stale relay.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
    });
    control.reserveEnrollment(taskId);
    expect(control.browserTasks()).toHaveLength(1);
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.status).toBe('dispatching');

    cancelWorkContract(fx.store, workId, { summary: 'Canonical cancellation for Supervisor reconciliation.' });
    expect(control.browserTasks()).toEqual([]);
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)).toMatchObject({ status: 'failed', originWorkId: workId });
    expect(() => control.browserPoll({ conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}` })).toThrow('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
  });

  test('does not project a completed canonical Work as active outer-turn authority', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-completed-reconcile';
    const workId = 'work-supervisor-completed-reconcile';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor completed reconciliation', outcomeStatement: 'Completed Work is not an active outer-turn authority.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, mode: 'goal_workloop',
      objective: 'Prove completed Work is not projected as active Supervisor work.',
      acceptanceCriteria: ['completed Work cannot remain active outer-turn authority'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', workKind: 'completed_no_change', status: 'running',
    });
    beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
    });
    const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(join(fx.root, 'supervisor-home')), {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const conversationId = 'cdcdcdcd-abab-efef-3434-121212121212';
    const taskId = `forge:${fx.repository.repoId}:requirement:${requirementId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`, objective: 'Retire completed Work projection.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
    });
    control.reserveEnrollment(taskId);
    expect(control.browserTasks()).toHaveLength(1);

    const targetRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const recordedAt = '2026-09-19T00:00:00.000Z';
    transitionWorkContractPhase(fx.store, workId, {
      phase: 'verification', status: 'running', state: 'satisfied', summary: 'Canonical no-change Work verified for terminal projection coverage.',
    });
    requestWorkImplementationReview(fx.store, workId, 'Review canonical completed Work projection coverage.');
    recordWorkImplementationReview(fx.store, workId, {
      schemaVersion: 1, reviewId: 'REV-supervisor-completed-reconcile', workId, reviewerPrincipalId: 'test-reviewer',
      decision: 'approved', rationale: 'The no-change fixture is reviewed before canonical completion.', findings: [],
      sourceRevision: targetRevision, workspaceFingerprint: 'supervisor-completed-content',
      verificationWorkspaceFingerprint: 'supervisor-completed-verification', changedPaths: [],
      changedPathDigest: implementationReviewChangedPathDigest([]),
      acceptanceCriteriaSummary: 'completed Work cannot remain active outer-turn authority',
      verificationEvidence: [], architectureEvidence: [], recordedAt,
    });
    recordWorkCompletionReceipt(fx.store, workId, {
      schemaVersion: 1, receiptId: 'receipt-supervisor-completed-reconcile', source: 'controller_work',
      issueId: 'supervisor-completed-reconcile', taskId: workId, workId, targetBranch: 'main', targetRevision, changedPaths: [],
      delivery: { kind: 'no_change', status: 'integrated', strategy: 'no_change', reachable: true, recordedAt },
      cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt }, verifiedAt: recordedAt, recordedAt,
    }, 'completed_no_change', 'completed_no_change');
    expect(control.browserTasks()).toEqual([]);
    expect(() => control.browserPoll({ conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}` })).toThrow('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
  });

  test('never deletes a non-socket path during writer reconciliation', async () => {
    const fx = fixture();
    const socketPath = join(fx.root, 'workflow-supervisor.sock');
    writeFileSync(socketPath, 'not a socket');
    await expect(reconcileWorkflowSupervisorSocket({
      socketPath,
      incoming: { runtimeInstanceId: 'runtime-new', fencingGeneration: 2, pid: process.pid },
    })).rejects.toThrow('WORKFLOW_SUPERVISOR_SOCKET_PATH_OCCUPIED');
    expect(existsSync(socketPath)).toBe(true);
  });
});


test('browserTasks polls only tasks with pending browser work or an applied effect awaiting completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-browser-attention-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-browser-attention';
  const conversationId = '12121212-3434-5656-7878-909090909090';
  control.registerTask({
    taskId,
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    objective: 'Poll only while browser work is outstanding.',
    completionContract: {},
    continuationPolicy: {},
    userBlockerPolicy: {},
  });

  expect(control.browserTasks()).toEqual([]);

  const effect = control.reserveEnrollment(taskId);
  expect(control.browserTasks()).toHaveLength(1);

  control.observeEffect({
    effectId: effect.effectId,
    observationId: 'browser-attention-applied',
    outcome: 'applied',
    evidence: { surface: 'test' },
  });
  expect(control.browserTasks()).toHaveLength(1);
});
