import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { acknowledgeControllerRoundClaim, beginInitialControllerRoundDispatch, claimStalledControllerRoundRelays, controllerRoundProviderEffectId, finishControllerRoundRelayDispatch, getRequirementControllerRoundRelay, recoverControllerRoundRelayAuthority, submitControllerRoundDisposition } from '../../packages/kernel/controller/api/index';
import { createWorkContract, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { forgeWorkflowSupervisorLifecycleHooks, inheritWorkflowSupervisorConversationBinding, workflowSupervisorBoundaryForWork, workflowSupervisorLowerLayerReadyForWork } from '../../src/runtime/root/workflow-supervisor-composition';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { LEGACY_SUPERVISOR_BLOCK_END, LEGACY_SUPERVISOR_BLOCK_START, parseSupervisorCompletion, renderSupervisorPrompt, renderSupervisorReceipt, supervisorReceiptChallenge, SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../../supervisor/protocol';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { reconcileWorkflowSupervisorSocket, WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { claimControllerSession, releaseControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { bindChatgptWorkConversation, getChatgptWorkConversationBinding, rebindChatgptWorkConversation } from '../../adapters/chatgpt/work-conversation-binding-store';
import { CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE, chatgptProviderPageFailure, classifyChatgptProviderFailure } from '../../adapters/chatgpt/provider-delivery';

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
  test('keeps normal same-conversation continuation minimal while recovery retains bounded restore context', () => {
    const task = {
      taskId: 'task-minimal-continuation',
      conversationId: '11111111-2222-3333-4444-555555555555',
      conversationUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
      objective: 'A deliberately distinctive original objective that must not be repeated during normal continuation.',
      completionContract: { requirement_id: 'REQ-minimal-continuation' },
      continuationPolicy: {},
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const lowerLayerContext = 'controller_authority_id=opaque-previous-turn-token';
    const continuation = renderSupervisorPrompt(task, 'fx_minimal01', 'continuation', 'large checkpoint payload', undefined, lowerLayerContext);
    expect(continuation).toContain('Continue using the context already present in this same conversation.');
    expect(continuation).toContain('Complete one coherent safe work wave');
    const challenge = supervisorReceiptChallenge(task, 'fx_minimal01');
    expect(continuation).toContain(`CONTINUE => "C ${challenge}"`);
    expect(continuation).toContain(`DONE => "D ${challenge}"`);
    expect(continuation).toContain('do not echo it in the receipt');
    expect(continuation).not.toContain('source_effect_id=');
    expect(continuation).not.toContain('conversation_id=');
    expect(continuation).not.toContain('task_id=');
    expect(continuation).not.toContain('active_scope=');
    expect(continuation).not.toContain('Original objective:');
    expect(continuation).not.toContain(task.objective);
    expect(continuation).not.toContain('large checkpoint payload');
    expect(continuation).not.toContain('Forge lower-layer continuation contract');
    expect(continuation).not.toContain(lowerLayerContext);
    expect(continuation).not.toContain('Preserve the original Requirement, Plan');

    const recovery = renderSupervisorPrompt(task, 'fx_recover01', 'recovery', 'restore checkpoint', 'recover durable state', lowerLayerContext);
    expect(recovery).toContain(`Original objective: ${JSON.stringify(task.objective)}`);
    expect(recovery).toContain('restore checkpoint');
    expect(recovery).toContain('recover durable state');
    expect(recovery).toContain(lowerLayerContext);
  });

  test('pins the exact assistant action enum and validates compact causal receipts while retaining legacy reads', () => {
    const task = {
      taskId: 'task-supervisor-action-contract',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      conversationUrl: 'https://chatgpt.com/c/abababab-cdcd-efef-1212-343434343434',
      objective: 'Keep the outer Supervisor protocol exact.',
      completionContract: {},
      continuationPolicy: {},
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const effectId = 'fx_12345678';
    const prompt = renderSupervisorPrompt(task, effectId, 'recovery');

    expect(prompt).toContain('"CONTINUE", "DONE", or "NEEDS_USER"');
    expect(prompt).toContain('"WAIT", "RETRY", and every other value are invalid');
    expect(prompt).toContain('Use CONTINUE for any non-terminal state');
    expect(prompt).toContain(renderSupervisorReceipt(task, effectId, 'CONTINUE'));
    expect(prompt).toContain(renderSupervisorReceipt(task, effectId, 'DONE'));
    expect(prompt).toContain(renderSupervisorReceipt(task, effectId, 'NEEDS_USER'));
    expect(prompt).not.toContain(SUPERVISOR_BLOCK_START);
    expect(prompt).not.toContain(LEGACY_SUPERVISOR_BLOCK_START);
    expect(prompt).not.toContain('conversation_id=');
    expect(prompt).not.toContain('task_id=');
    expect(prompt).not.toContain('supervisor_state=');

    const compact = parseSupervisorCompletion(renderSupervisorReceipt(task, effectId, 'CONTINUE'), { task, effectId });
    expect(compact.proposal).toMatchObject({
      action: 'CONTINUE', sourceEffectId: effectId, conversationId: task.conversationId,
      taskId: task.taskId, supervisorState: 'running', reason: 'compact_receipt',
    });
    expect(() => parseSupervisorCompletion('C 0000000', { task, effectId })).toThrow('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH');

    const legacy = parseSupervisorCompletion(`${LEGACY_SUPERVISOR_BLOCK_START}\n${JSON.stringify({
      action: 'CONTINUE', conversation_id: task.conversationId, task_id: task.taskId,
      supervisor_state: 'running', active_scope: 'requirement:REQ-protocol', source_effect_id: effectId,
      checkpoint: 'legacy-readable', reason: 'compatibility', evidence: ['legacy-wire'],
    })}\n${LEGACY_SUPERVISOR_BLOCK_END}`);
    expect(legacy.proposal.checkpoint).toBe('legacy-readable');
    expect(legacy.proposal.activeScope).toBe('requirement:REQ-protocol');
  });

  test('deduplicates an exact compact receipt after its source effect is already completed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-compact-dedupe-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const task = control.registerTask({
      taskId: 'task-compact-dedupe',
      conversationId: 'cdcdcdcd-1111-2222-3333-444444444444',
      conversationUrl: 'https://chatgpt.com/c/cdcdcdcd-1111-2222-3333-444444444444',
      objective: 'Prove duplicate compact receipt observation is idempotent.',
      completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
    });
    const enrollment = control.reserveEnrollment(task.taskId);
    control.observeEffect({ effectId: enrollment.effectId, observationId: 'obs-compact-dedupe', outcome: 'applied' });
    const receipt = renderSupervisorReceipt(task, enrollment.effectId, 'CONTINUE');

    const first = await control.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId, responseText: receipt });
    const duplicate = await control.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId, responseText: receipt });

    expect(first.successorEffect).toBeDefined();
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.successorEffect?.effectId).toBe(first.successorEffect?.effectId);
  });

  test('keeps normal continuation minimal while recovery retains bounded restoration context', () => {
    const task = {
      taskId: 'task-minimal-continuation',
      conversationId: '12121212-3434-5656-7878-909090909090',
      conversationUrl: 'https://chatgpt.com/c/12121212-3434-5656-7878-909090909090',
      objective: 'OBJECTIVE_SENTINEL that must not repeat on normal continuation.',
      completionContract: { requirement_id: 'REQ-minimal-prompt' },
      continuationPolicy: {},
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const continuation = renderSupervisorPrompt(task, 'fx_continue_1234', 'continuation', 'checkpoint-sentinel', undefined, 'LOWER_LAYER_SENTINEL');
    expect(continuation).toContain('Complete one coherent safe work wave');
    expect(continuation).not.toContain('checkpoint-sentinel');
    expect(continuation).toContain(renderSupervisorReceipt(task, 'fx_continue_1234', 'CONTINUE'));
    expect(continuation).not.toContain('source_effect_id=');
    expect(continuation).not.toContain('active_scope=');
    expect(continuation).not.toContain('Original objective:');
    expect(continuation).not.toContain('OBJECTIVE_SENTINEL');
    expect(continuation).not.toContain('LOWER_LAYER_SENTINEL');
    expect(continuation).not.toContain('Preserve the original Requirement');

    const recovery = renderSupervisorPrompt(task, 'fx_recovery_1234', 'recovery', 'checkpoint-sentinel', 'recover causally', 'LOWER_LAYER_SENTINEL');
    expect(recovery).toContain('Original objective:');
    expect(recovery).toContain('OBJECTIVE_SENTINEL');
    expect(recovery).toContain('checkpoint-sentinel');
    expect(recovery).toContain('LOWER_LAYER_SENTINEL');
    expect(recovery).toContain('Preserve the original Requirement');
  });

  test('inherits a Supervisor conversation only across explicit predecessor lineage, never across Requirement siblings', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-exact-conversation-lineage';
    const predecessorWorkId = 'work-supervisor-conversation-predecessor';
    const siblingWorkId = 'work-supervisor-conversation-sibling';
    const successorWorkId = 'work-supervisor-conversation-successor';
    createRequirement({ controllerHome: fx.controllerHome }, {
      requirementId,
      title: 'Exact current conversation lineage',
      outcomeStatement: 'Never substitute an historical sibling conversation for the current controller conversation.',
    });
    const create = (workId: string, predecessorWorkIdValue?: string) => createWorkContract(fx.store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      requirementId,
      ...(predecessorWorkIdValue ? { predecessorWorkId: predecessorWorkIdValue } : {}),
      mode: 'goal_workloop',
      objective: `Exercise exact conversation lineage for ${workId}.`,
      acceptanceCriteria: ['only explicit predecessor lineage may inherit a conversation'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running',
    });
    create(predecessorWorkId);
    create(siblingWorkId);
    create(successorWorkId, predecessorWorkId);
    bindChatgptWorkConversation(fx.store, {
      workId: predecessorWorkId,
      conversationUrl: 'https://chatgpt.com/c/exact-conversation-lineage',
      latestBrowserSessionId: 'forge-chatgpt-work-exact-lineage',
    });

    expect(inheritWorkflowSupervisorConversationBinding(fx.store, predecessorWorkId, siblingWorkId)).toBeUndefined();
    expect(getChatgptWorkConversationBinding(fx.store, siblingWorkId)).toBeUndefined();
    expect(workflowSupervisorBoundaryForWork(fx.store, siblingWorkId)).toEqual({
      status: 'conversation_pending',
      reason: 'EXACT_WORK_CONVERSATION_BINDING_REQUIRED',
    });

    const inherited = inheritWorkflowSupervisorConversationBinding(fx.store, predecessorWorkId, successorWorkId);
    expect(inherited?.conversationId).toBe('exact-conversation-lineage');
    expect(workflowSupervisorBoundaryForWork(fx.store, successorWorkId)).toMatchObject({
      status: 'outer_turn',
      requirementId,
      conversationId: 'exact-conversation-lineage',
    });
  });

  test('keeps the browser-observed current conversation ephemeral, exact, and unambiguous', () => {
    const discovery = new WorkflowSupervisorEphemeralDiscovery();
    const currentId = '22222222-3333-4444-5555-666666666666';
    const otherId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    discovery.update([
      {
        conversation_id: currentId,
        canonical_url: `https://chatgpt.com/c/${currentId}`,
        title: 'Current Forge conversation',
        is_current: true,
      },
      {
        conversation_id: otherId,
        canonical_url: `https://chatgpt.com/c/${otherId}`,
        title: 'Other conversation',
      },
    ], 'chrome-extension');

    expect(discovery.currentConversation('chrome-extension')).toEqual({
      conversationId: currentId,
      canonicalUrl: `https://chatgpt.com/c/${currentId}`,
      title: 'Current Forge conversation',
    });

    expect(() => discovery.update([
      { conversation_id: currentId, canonical_url: `https://chatgpt.com/c/${currentId}`, is_current: true },
      { conversation_id: otherId, canonical_url: `https://chatgpt.com/c/${otherId}`, is_current: true },
    ], 'chrome-extension')).toThrow('WORKFLOW_SUPERVISOR_DISCOVERY_CURRENT_AMBIGUOUS');

    discovery.update([
      { conversation_id: currentId, canonical_url: `https://chatgpt.com/c/${currentId}` },
    ], 'chrome-extension');
    expect(discovery.currentConversation('chrome-extension')).toBeUndefined();
  });

  test('refuses to reserve enrollment for a terminal Supervisor task instead of reporting delivery that cannot happen', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-terminal-task-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor'));
    try {
      const control = new WorkflowSupervisorControlPlane(store);
      const conversationId = '99999999-2222-3333-4444-555555555555';
      const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
      const task = control.registerTask({
        taskId: 'forge:repo:conversation:terminal-task',
        conversationId,
        conversationUrl,
        objective: 'Terminal Supervisor task',
        completionContract: { kind: 'forge_work_done', repo_id: 'repo_terminal', work_id: 'work-terminal' },
        continuationPolicy: { kind: 'forge_goal_outer_turn', exact_conversation_id: conversationId, exact_conversation_url: conversationUrl },
        userBlockerPolicy: { kind: 'forge_work_waiting_for_user', repo_id: 'repo_terminal', work_id: 'work-terminal' },
      });
      expect(control.reserveEnrollment(task.taskId).kind).toBe('enrollment');
      store.resolveTerminal({
        completionFingerprint: 'terminal-fingerprint-1',
        taskId: task.taskId,
        action: 'NEEDS_USER',
        accepted: true,
        reason: 'operator cancelled this conversation',
      });
      expect(() => control.reserveEnrollment(task.taskId)).toThrow('WORKFLOW_SUPERVISOR_TASK_TERMINAL:NEEDS_USER');
      expect(() => control.reserveSchedulerRecovery(task.taskId, 'scheduler-recovery-key')).toThrow('WORKFLOW_SUPERVISOR_TASK_TERMINAL:NEEDS_USER');
    } finally {
      store.close();
    }
  });

  test('persists project conversation discovery across Supervisor store reopen without turning discovery into lifecycle authority', () => {
    const fx = fixture();
    const supervisorHome = join(fx.root, 'durable-supervisor-discovery');
    const firstStore = new WorkflowSupervisorStore(supervisorHome);
    const firstControl = new WorkflowSupervisorControlPlane(firstStore);
    const firstDiscovery = new WorkflowSupervisorEphemeralDiscovery();
    firstDiscovery.update([{
      conversation_id: '11111111-2222-3333-4444-555555555555',
      canonical_url: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
      title: 'Forge durable discovery',
      project_title: 'forge',
      project_url: 'https://chatgpt.com/g/g-p-forge/project',
    }], 'chrome-extension');
    firstControl.recordBrowserDiscovery('chrome-extension', firstDiscovery.sourceConversations('chrome-extension'));
    firstStore.close();

    const reopened = new WorkflowSupervisorStore(supervisorHome);
    const reopenedControl = new WorkflowSupervisorControlPlane(reopened);
    const snapshot = reopenedControl.browserDiscoverySnapshot();
    expect(snapshot.conversations).toEqual([{
      conversationId: '11111111-2222-3333-4444-555555555555',
      canonicalUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
      title: 'Forge durable discovery',
      projectTitle: 'forge',
      projectUrl: 'https://chatgpt.com/g/g-p-forge/project',
    }]);
    expect(reopened.listTasks()).toEqual([]);
    reopened.close();
  });

  test('keeps matching project discovery observation-only and never auto-enrolls historical conversations', () => {
    const fx = fixture();
    const store = new WorkflowSupervisorStore(join(fx.root, 'project-discovery-supervisor'));
    const seedConversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const seedTaskId = 'forge:seed';
    const control = new WorkflowSupervisorControlPlane(store, {}, {
      projectScopeForTask: () => ({ title: 'forge', repoId: fx.repository.repoId, controllerHome: fx.controllerHome }),
    });
    control.registerTask({
      taskId: seedTaskId, conversationId: seedConversationId, conversationUrl: `https://chatgpt.com/c/${seedConversationId}`,
      objective: 'Seed project scope.', completionContract: { repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
      continuationPolicy: {}, userBlockerPolicy: {},
    });
    const discovered = {
      conversationId: '12121212-3434-5656-7878-909090909090',
      canonicalUrl: 'https://chatgpt.com/c/12121212-3434-5656-7878-909090909090',
      projectTitle: 'Forge', projectUrl: 'https://chatgpt.com/g/g-p-forge/project', title: 'Existing Forge work',
    };
    control.recordBrowserDiscovery('chrome-extension', [discovered]);
    expect(control.browserDiscoverySnapshot().conversations).toContainEqual(discovered);
    expect(store.getTaskByConversationId(discovered.conversationId)).toBeUndefined();
    expect(store.listTasks().map((task) => task.taskId)).toEqual([seedTaskId]);
    store.close();
  });

  test('treats legacy discovery-bootstrap tasks without Requirement authority as browser-inactive', () => {
    const fx = fixture();
    const store = new WorkflowSupervisorStore(join(fx.root, 'legacy-discovery-supervisor'));
    const control = new WorkflowSupervisorControlPlane(store, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const conversationId = '23232323-4545-6767-8989-010101010101';
    const taskId = `forge:${fx.repository.repoId}:conversation:${conversationId}`;
    control.registerTask({
      taskId,
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Legacy discovery bootstrap.',
      completionContract: { kind: 'forge_dynamic_requirement_done', repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
      continuationPolicy: { kind: 'forge_project_conversation_outer_turn', repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
      userBlockerPolicy: { kind: 'forge_dynamic_requirement_waiting_for_user', repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
    });
    control.reserveEnrollment(taskId);
    expect(control.browserTasks()).toEqual([]);
    store.close();
  });

  test('upgrades one matching legacy project-bootstrap task through explicit Requirement enrollment without duplicating its effect', () => {
    const fx = fixture();
    const store = new WorkflowSupervisorStore(join(fx.root, 'legacy-explicit-enrollment-supervisor'));
    const control = new WorkflowSupervisorControlPlane(store);
    const conversationId = '24242424-4646-6868-9090-020202020202';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const taskId = `forge:${fx.repository.repoId}:conversation:${conversationId}`;
    const requirementId = 'REQ-explicit-current-conversation-upgrade';
    const legacy = control.registerTask({
      taskId,
      conversationId,
      conversationUrl,
      objective: 'Legacy discovery bootstrap.',
      completionContract: { kind: 'forge_dynamic_requirement_done', repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
      continuationPolicy: { kind: 'forge_project_conversation_outer_turn', repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
      userBlockerPolicy: { kind: 'forge_dynamic_requirement_waiting_for_user', repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
    });
    const originalEffect = control.reserveEnrollment(taskId);

    const upgraded = control.registerTask({
      taskId,
      conversationId,
      conversationUrl,
      objective: 'Complete the exact Requirement through this conversation.',
      completionContract: { kind: 'forge_requirement_done', repo_id: fx.repository.repoId, controller_home: fx.controllerHome, requirement_id: requirementId },
      continuationPolicy: {
        kind: 'forge_goal_outer_turn',
        exact_conversation_id: conversationId,
        exact_conversation_url: conversationUrl,
        lower_layer_continuation_owner: 'controller_round',
        outer_turn_owner: 'workflow_supervisor',
      },
      userBlockerPolicy: { kind: 'forge_requirement_waiting_for_user', repo_id: fx.repository.repoId, controller_home: fx.controllerHome, requirement_id: requirementId },
    });
    const repeatedEffect = control.reserveEnrollment(taskId);

    expect(upgraded.createdAt).toBe(legacy.createdAt);
    expect(upgraded.objective).toBe('Complete the exact Requirement through this conversation.');
    expect(upgraded.completionContract).toMatchObject({ kind: 'forge_requirement_done', repo_id: fx.repository.repoId, requirement_id: requirementId });
    expect(upgraded.continuationPolicy).toMatchObject({ kind: 'forge_goal_outer_turn', exact_conversation_id: conversationId, exact_conversation_url: conversationUrl });
    expect(upgraded.userBlockerPolicy).toMatchObject({ kind: 'forge_requirement_waiting_for_user', requirement_id: requirementId });
    expect(repeatedEffect.effectId).toBe(originalEffect.effectId);
    expect(store.listTasks()).toHaveLength(1);
    expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(originalEffect.effectId);

    expect(() => control.registerTask({
      taskId,
      conversationId,
      conversationUrl,
      objective: 'Malformed explicit enrollment must fail closed.',
      completionContract: { kind: 'forge_requirement_done', repo_id: fx.repository.repoId, controller_home: fx.controllerHome, requirement_id: 'REQ-other' },
      continuationPolicy: { kind: 'forge_goal_outer_turn', exact_conversation_id: conversationId, exact_conversation_url: conversationUrl },
      userBlockerPolicy: { kind: 'forge_requirement_waiting_for_user', repo_id: fx.repository.repoId, controller_home: fx.controllerHome, requirement_id: 'REQ-mismatch' },
    })).toThrow('WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT');
    store.close();
  });

  test('requires a prepared lower ControllerRound before treating an outer turn as runnable', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-lower-layer-readiness';
    const workId = 'work-supervisor-lower-layer-readiness';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor lower-layer readiness', outcomeStatement: 'Do not submit an outer turn without a lower ControllerRound authority.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, mode: 'goal_workloop',
      objective: 'Require a prepared ControllerRound before Supervisor enrollment.',
      acceptanceCriteria: ['missing lower-layer authority is not runnable'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });

    expect(workflowSupervisorLowerLayerReadyForWork(fx.store, workId)).toEqual({ ready: false, reason: 'CONTROLLER_ROUND_NOT_PREPARED' });
    const relay = beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId,
      identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
    });
    expect(workflowSupervisorLowerLayerReadyForWork(fx.store, workId)).toEqual({
      ready: true,
      workId,
      providerEffectId: controllerRoundProviderEffectId(relay),
    });
  });

  test('reopens a repeated-state relay only through a reasoned user recovery without resetting its budget', () => {
    const fx = fixture();
    const workId = 'work-supervisor-repeated-state-recovery';
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, mode: 'goal_workloop',
      objective: 'Exercise bounded repeated-state authority recovery.', acceptanceCriteria: ['recovery preserves lineage budgets'],
      allowedPaths: [], forbiddenPaths: [], checks: [], constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    const identity = { controllerId: 'supervisor-recovery-controller', controllerType: 'chatgpt' as const, principalId: 'supervisor-recovery-principal', controllerInstanceId: 'runtime-supervisor-recovery' };
    const store = fx.store;
    const first = beginInitialControllerRoundDispatch(store, { workId, identity: { ...identity, sessionId: 'supervisor-recovery-1' }, maxRepeatedState: 2 });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const firstSession = claimControllerSession(store, { workId, ...identity, sessionId: 'supervisor-recovery-1', leaseMs: 60_000 });
    acknowledgeControllerRoundClaim(store, { workId, session: firstSession });
    submitControllerRoundDisposition(store, { workId, relayScopeId: first.relayScopeId, identity: { ...identity, sessionId: firstSession.sessionId }, disposition: 'continue_immediately' });
    releaseControllerSession(store, workId, identity.controllerId);
    claimStalledControllerRoundRelays(store, { nowMs: Date.now() + 120_000, graceMs: 60_000 });
    finishControllerRoundRelayDispatch(store, { workId, ok: true });
    const secondSession = claimControllerSession(store, { workId, ...identity, sessionId: 'supervisor-recovery-2', leaseMs: 60_000 });
    acknowledgeControllerRoundClaim(store, { workId, session: secondSession });
    const blocked = submitControllerRoundDisposition(store, { workId, relayScopeId: first.relayScopeId, identity: { ...identity, sessionId: secondSession.sessionId }, disposition: 'continue_immediately' });
    expect(blocked).toMatchObject({ status: 'blocked', repeatedStateCount: 2, blockedReason: 'repeated_state:2>=2' });
    releaseControllerSession(store, workId, identity.controllerId);
    expect(() => recoverControllerRoundRelayAuthority(store, { workId, requestedBy: 'system', identity: { ...identity, sessionId: 'supervisor-recovery-3' } })).toThrow('WORK_CONTROLLER_AUTHORITY_RECOVERY_USER_REQUIRED');
    expect(() => recoverControllerRoundRelayAuthority(store, { workId, requestedBy: 'user', identity: { ...identity, sessionId: 'supervisor-recovery-3' } })).toThrow('WORK_CONTROLLER_AUTHORITY_RECOVERY_REASON_REQUIRED');
    const recovered = recoverControllerRoundRelayAuthority(store, { workId, requestedBy: 'user', recoveryReason: 'Explicitly reopen the active Work for automatic verification acceptance.', identity: { ...identity, sessionId: 'supervisor-recovery-3' } });
    expect(recovered).toMatchObject({ status: 'dispatching', roundCount: blocked.roundCount, repeatedStateCount: blocked.repeatedStateCount, maxRepeatedState: blocked.maxRepeatedState });
  });

  test('retires a predecessor browser task after the Work CAS-rebinds to a fresh conversation', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-conversation-rebind';
    const workId = 'work-supervisor-conversation-rebind';
    const oldConversationId = '11111111-aaaa-bbbb-cccc-222222222222';
    const newConversationId = '33333333-dddd-eeee-ffff-444444444444';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor rebind', outcomeStatement: 'Only the current exact Work conversation owns browser delivery.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, mode: 'goal_workloop',
      objective: 'Move autonomous execution onto a fresh conversation without retaining the predecessor writer.',
      acceptanceCriteria: ['old conversation becomes browser-inactive after rebind'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
    });
    beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
    });
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl: `https://chatgpt.com/c/${oldConversationId}` });
    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'supervisor-home'));
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const oldTaskId = `forge:${fx.repository.repoId}:conversation:${oldConversationId}`;
    control.registerTask({
      taskId: oldTaskId, conversationId: oldConversationId, conversationUrl: `https://chatgpt.com/c/${oldConversationId}`, objective: 'Old execution conversation.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
    });
    control.reserveEnrollment(oldTaskId);
    expect(control.browserTasks()).toHaveLength(1);

    rebindChatgptWorkConversation(fx.store, {
      workId, previousConversationId: oldConversationId, conversationUrl: `https://chatgpt.com/c/${newConversationId}`,
    });
    expect(workflowSupervisorBoundaryForWork(fx.store, workId)).toMatchObject({
      status: 'outer_turn', conversationId: newConversationId,
      taskId: `forge:${fx.repository.repoId}:conversation:${newConversationId}`,
    });
    expect(control.browserTasks()).toEqual([]);
    expect(() => control.browserPoll({ conversationId: oldConversationId, conversationUrl: `https://chatgpt.com/c/${oldConversationId}` }))
      .toThrow('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
  });

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
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl: `https://chatgpt.com/c/${conversationId}` });
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

    reviseWorkSemanticContext(fx.store, workId, { expectedRevision: 1, state: 'cancelled' });
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
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl: `https://chatgpt.com/c/${conversationId}` });
    const taskId = `forge:${fx.repository.repoId}:requirement:${requirementId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`, objective: 'Retire completed Work projection.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
    });
    control.reserveEnrollment(taskId);
    expect(control.browserTasks()).toHaveLength(1);

    reviseWorkSemanticContext(fx.store, workId, { expectedRevision: 1, state: 'completed' });
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

test('provider recovery is a single exactly-once resume and does not recurse through Scheduler policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-browser-exhausted-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-browser-exhausted';
  const conversationId = '34343434-5656-7878-9090-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId, conversationId, conversationUrl, objective: 'Stop after bounded provider recovery.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const effect = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: effect.effectId, observationId: 'browser-exhausted-applied', outcome: 'applied' });

  const first = store.observeProviderTurn({
    taskId, effectId: effect.effectId, generating: false, assistantDigest: 'digest', observedAtMs: 1_000, graceMs: 1_000,
    recovery: { effectId: 'fx_34343434343434343434343434343434', prompt: 'recovery' },
  });
  expect(first.state).toBe('idle_pending');
  const resumed = store.observeProviderTurn({
    taskId, effectId: effect.effectId, generating: false, assistantDigest: 'digest', observedAtMs: 2_001, graceMs: 1_000,
    recovery: { effectId: 'fx_56565656565656565656565656565656', prompt: 'recovery' },
  });
  expect(resumed.state).toBe('recovery_reserved');
  expect(resumed.recoveryEffect?.kind).toBe('recovery');
  expect(control.browserTasks()).toHaveLength(1);

  const resume = resumed.recoveryEffect!;
  control.observeEffect({ effectId: resume.effectId, observationId: 'provider-resume-applied', outcome: 'applied' });
  const resumePending = store.observeProviderTurn({
    taskId, effectId: resume.effectId, generating: false, assistantDigest: 'resume-digest', observedAtMs: 3_000, graceMs: 1_000,
    recovery: { effectId: 'fx_78787878787878787878787878787878', prompt: 'must-not-send' },
  });
  expect(resumePending.state).toBe('idle_pending');
  const exhausted = store.observeProviderTurn({
    taskId, effectId: resume.effectId, generating: false, assistantDigest: 'resume-digest', observedAtMs: 4_001, graceMs: 1_000,
    recovery: { effectId: 'fx_90909090909090909090909090909090', prompt: 'must-not-send' },
  });
  expect(exhausted.state).toBe('exhausted');
  expect(store.providerResumeExhausted(resume.effectId)).toBe(true);
  expect(control.reserveSchedulerRecovery(taskId, 'legacy-retry')).toBeUndefined();
});

test('Resume stream unavailable reserves exactly one same-conversation recovery effect and never replays the applied effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-stream-unavailable-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-stream-unavailable';
  const conversationId = '12121212-1212-1212-1212-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Resume after a provider stream loss.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });

  // A real dispatch of the enrollment effect so "never replay" is observable.
  const effect = control.reserveEnrollment(taskId);
  const began = control.browserBeginEffect({
    conversationId, conversationUrl, effectId: effect.effectId, dispatchId: 'dispatch-enrollment-1', dispatchGeneration: 1,
    evidence: { surface: 'test', latest_user_text: '@forge enrollment', latest_assistant_response: '' },
  });
  expect(began.started).toBe(true);
  control.observeEffect({ effectId: effect.effectId, observationId: 'stream-applied', outcome: 'applied' });
  expect(store.latestEffectDispatch(effect.effectId)?.generation).toBe(1);

  // Direct delivery and durable Supervisor observation share one detector, and a
  // stream loss is always outcome-unknown rather than a retryable failure.
  const failureCode = chatgptProviderPageFailure('Resume stream unavailable');
  expect(failureCode).toBe(CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE);
  expect(classifyChatgptProviderFailure(failureCode!)).toBe('outcome_unknown');

  const observed = control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: false, latestAssistantResponse: '',
    providerFailureCode: failureCode!, observedAtMs: 1_000, graceMs: 1_000,
  });
  expect(observed.state).toBe('recovery_reserved');
  const recovery = observed.recoveryEffect!;
  expect(recovery.kind).toBe('recovery');
  expect(recovery.effectId).not.toBe(effect.effectId);

  // Durable authority deduplicates: a second reservation attempt with a different
  // candidate id returns the same single recovery effect.
  const repeated = store.observeProviderTurn({
    taskId, effectId: effect.effectId, generating: false, assistantDigest: 'stream-digest',
    providerFailureCode: failureCode!, observedAtMs: 2_000, graceMs: 1_000,
    recovery: { effectId: 'fx_10101010101010101010101010101010', prompt: 'must-not-send' },
  });
  expect(repeated.state).toBe('recovery_reserved');
  expect(repeated.recoveryEffect?.effectId).toBe(recovery.effectId);

  // A repeated control-plane observation must not manufacture a further effect.
  const reobserved = control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: false, latestAssistantResponse: '',
    providerFailureCode: failureCode!, observedAtMs: 2_500, graceMs: 1_000,
  });
  expect(reobserved.state).toBe('none');

  // The single recovery effect resumes on the exact same conversation.
  const poll = control.browserPoll({ conversationId, conversationUrl });
  expect(poll.command).toMatchObject({ mode: 'send', kind: 'recovery', effectId: recovery.effectId, conversationId });

  // The applied source effect is never re-dispatched: its generation is unchanged
  // and only canonical not-applied proof could ever advance it.
  expect(store.latestEffectDispatch(effect.effectId)?.generation).toBe(1);
  expect(() => store.recordEffectDispatchStarted(effect.effectId, 2, 'dispatch-enrollment-2'))
    .toThrow('WORKFLOW_SUPERVISOR_EFFECT_ALREADY_APPLIED');

  // A provider failure on the recovery resume itself terminates the chain instead
  // of recursively producing unlimited recovery effects.
  control.observeEffect({ effectId: recovery.effectId, observationId: 'recovery-applied', outcome: 'applied' });
  const exhausted = control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: false, latestAssistantResponse: '',
    providerFailureCode: failureCode!, observedAtMs: 3_000, graceMs: 1_000,
  });
  expect(exhausted.state).toBe('exhausted');
  expect(exhausted.recoveryEffect).toBeUndefined();
  expect(store.providerResumeExhausted(recovery.effectId)).toBe(true);
});

test('browserTasks keeps an applied external effect observable while lower ControllerRound waits', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-browser-applied-waiting-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => false });
  const taskId = 'task-browser-applied-waiting';
  const conversationId = '56565656-7878-9090-1212-343434343434';
  control.registerTask({
    taskId,
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    objective: 'Keep observing an already applied effect while the lower round waits.',
    completionContract: {},
    continuationPolicy: {},
    userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: effect.effectId, observationId: 'applied-while-waiting', outcome: 'applied' });
  const recovery = store.reserveEffect({
    taskId,
    effectId: 'fx_78787878787878787878787878787878',
    kind: 'recovery',
    originKey: `provider-recovery:${effect.effectId}`,
    prompt: 'recovery',
  });

  expect(control.browserTasks()).toHaveLength(1);
  expect(control.browserPoll({ conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}` }).command?.effectId).toBe(recovery.effectId);
});
