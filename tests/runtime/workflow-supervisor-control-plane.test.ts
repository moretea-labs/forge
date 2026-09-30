import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome, SEMANTIC_SCOPE_KEY } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { acknowledgeControllerRoundClaim, beginInitialControllerRoundDispatch, claimStalledControllerRoundRelays, controllerRoundProviderEffectId, finishControllerRoundRelayDispatch, getRequirementControllerRoundRelay, recoverControllerRoundRelayAuthority, submitControllerRoundDisposition } from '../../packages/kernel/controller/api/index';
import { createWorkContract, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { createRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { forgeWorkflowSupervisorLifecycleHooks, inheritWorkflowSupervisorConversationBinding, workflowSupervisorBoundaryForWork, workflowSupervisorLowerLayerReadyForWork } from '../../src/runtime/root/workflow-supervisor-composition';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { WorkflowSupervisorNativeBrowserAdapter, type WorkflowSupervisorNativePage } from '../../supervisor/native-browser-adapter';
import { LEGACY_SUPERVISOR_BLOCK_END, LEGACY_SUPERVISOR_BLOCK_START, parseSupervisorCompletion, renderSupervisorPrompt, renderSupervisorReceipt, supervisorReceiptChallenge, SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START } from '../../supervisor/protocol';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { reconcileWorkflowSupervisorSocket, WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { claimControllerSession, getControllerSession, releaseControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { bindChatgptWorkConversation, getChatgptWorkConversationBinding, rebindChatgptWorkConversation } from '../../adapters/chatgpt/work-conversation-binding-store';
import { CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE, chatgptProviderPageFailure, classifyChatgptProviderFailure } from '../../adapters/chatgpt/provider-delivery';
import { parseChatgptConversationIdentity } from '../../supervisor/chatgpt-conversation';

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
  test('rejects ChatGPT local temporary conversation ids as non-canonical bootstrap identity', () => {
    expect(() => parseChatgptConversationIdentity(
      'https://chatgpt.com/g/g-p-6a922010db348191a84d1a5306c083e8-forge/c/local-chatgpt%3A401bd127-b347-47d1-bc9c-895b5741ec7b',
    )).toThrow('WORKFLOW_SUPERVISOR_CHATGPT_CONVERSATION_ID_INVALID');
    expect(parseChatgptConversationIdentity(
      'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    )).toEqual({
      conversationId: '11111111-2222-3333-4444-555555555555',
      canonicalUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    });
  });

  test('keeps one durable conversation across ChatGPT Project route changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-route-identity-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store, {
      completionContract: async () => ({ valid: true, reason: 'ok' }),
      userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }),
    });
    const conversationId = '11111111-2222-3333-4444-555555555555';
    control.registerTask({
      taskId: 'route-identity',
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Keep the same durable ChatGPT conversation.',
      completionContract: {},
      continuationPolicy: {},
      userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment('route-identity');

    expect(control.browserPoll({
      conversationId,
      conversationUrl: `https://chatgpt.com/g/g-p-abc123-forge/c/${conversationId}`,
    }).command).toMatchObject({ effectId: effect.effectId, conversationId });
    store.close();
  });

  test('derives standalone project scope from Supervisor-owned Controller Home', () => {
    const fx = fixture();
    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'standalone-project-scope'));
    const hooks = forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome);
    const standalone = supervisorStore.registerTask({
      taskId: 'supervisor:standalone-project-scope',
      conversationId: 'bootstrap:supervisor:standalone-project-scope',
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Standalone bootstrap.',
      completionContract: { repo_id: fx.repository.repoId },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
      userBlockerPolicy: {},
    });
    expect(hooks.projectScopeForTask?.(standalone)).toEqual({
      title: 'supervisor-terminal-reconcile',
      repoId: fx.repository.repoId,
      controllerHome: fx.controllerHome,
    });

    const mismatched = supervisorStore.registerTask({
      taskId: 'supervisor:standalone-project-scope-mismatch',
      conversationId: 'bootstrap:supervisor:standalone-project-scope-mismatch',
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Reject cross-home bootstrap.',
      completionContract: { repo_id: fx.repository.repoId, controller_home: join(fx.root, 'other-controller') },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
      userBlockerPolicy: {},
    });
    expect(hooks.projectScopeForTask?.(mismatched)).toBeUndefined();
    supervisorStore.close();
  });

  test('matches a Requirement-derived compact product alias to the ChatGPT Project identity', () => {
    const fx = fixture();
    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'requirement-project-alias'));
    const hooks = forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome);
    const task = supervisorStore.registerTask({
      taskId: 'forge:repo:requirement-project-alias',
      conversationId: 'bootstrap:requirement-project-alias',
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Bootstrap inside the product Project.',
      completionContract: {
        repo_id: fx.repository.repoId,
        controller_home: fx.controllerHome,
        requirement_id: 'REQ-shenbaobao-product-architecture-v2-20260905',
      },
      continuationPolicy: { kind: 'forge_goal_outer_turn', bootstrap: true },
      userBlockerPolicy: {},
    });
    expect(hooks.projectScopeForTask?.(task)).toEqual({
      title: 'supervisor-terminal-reconcile',
      aliases: ['shenbaobao'],
      repoId: fx.repository.repoId,
      controllerHome: fx.controllerHome,
    });

    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, hooks);
    control.recordBrowserDiscovery('test', [{
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      canonicalUrl: 'https://chatgpt.com/g/g-p-abc123-shen-bao-bao/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      projectTitle: 'Shen Bao Bao',
      projectUrl: 'https://chatgpt.com/g/g-p-abc123-shen-bao-bao/project',
    }]);
    expect(control.bootstrapProjectUrl(task.taskId)).toBe('https://chatgpt.com/g/g-p-abc123/project');
    supervisorStore.close();
  });

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
    expect(continuation).toContain('automation_type: "autonomous_continuation"');
    expect(continuation).toContain('automation_status');
    expect(continuation).not.toContain('CONTINUE => "C ');
    expect(continuation).not.toContain('DONE => "D ');
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

    expect(prompt).toContain('"continue", "done", or "needs_user"');
    expect(prompt).toContain('Use "continue" for all non-terminal autonomous work');
    expect(prompt).not.toContain(renderSupervisorReceipt(task, effectId, 'CONTINUE'));
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

  test('keeps one Supervisor enrollment effect when the lower ControllerRound rotates across Work carriers', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-enrollment-carrier-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    try {
      const control = new WorkflowSupervisorControlPlane(store);
      const task = control.registerTask({
        taskId: 'task-enrollment-carrier',
        conversationId: 'abababab-1111-2222-3333-444444444444',
        conversationUrl: 'https://chatgpt.com/c/abababab-1111-2222-3333-444444444444',
        objective: 'Preserve outer-turn authority while the lower Work carrier changes.',
        completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
      });
      const first = control.reserveEnrollment(task.taskId, 'fx_11111111111111111111111111111111');
      const migrated = control.reserveEnrollment(task.taskId, 'fx_22222222222222222222222222222222');
      expect(migrated.effectId).toBe(first.effectId);
      expect(migrated.effectId).toBe('fx_11111111111111111111111111111111');
    } finally {
      store.close();
    }
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
    expect(continuation).toContain('automation_type: "autonomous_continuation"');
    expect(continuation).not.toContain(renderSupervisorReceipt(task, 'fx_continue_1234', 'CONTINUE'));
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
    const successorBoundary = workflowSupervisorBoundaryForWork(fx.store, successorWorkId);
    expect(successorBoundary).toMatchObject({
      status: 'outer_turn',
      requirementId,
      conversationId: 'exact-conversation-lineage',
    });
    expect(successorBoundary).not.toHaveProperty('taskId');
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

  test('derives unattended continuation proof only for one exact release across a Runtime reconnect', () => {
    const fx = fixture();
    const store = new WorkflowSupervisorStore(join(fx.root, 'continuation-proof-supervisor'));
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'forge:repo-proof:conversation:proof-conversation';
    const conversationId = 'proof-conversation';
    control.registerTask({
      taskId,
      conversationId,
      conversationUrl: 'https://chatgpt.com/c/proof-conversation',
      objective: 'Prove unattended continuation.',
      completionContract: { kind: 'forge_work_done', repo_id: 'repo-proof', work_id: 'work-proof' },
      continuationPolicy: { kind: 'forge_goal_outer_turn', repo_id: 'repo-proof' },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', repo_id: 'repo-proof', work_id: 'work-proof' },
    });
    const notBefore = new Date(Date.now() - 1_000).toISOString();
    const releaseId = 'release-proof';
    const first = control.reserveEnrollment(taskId, 'fx_11111111111111111111111111111111');
    expect(store.recordEffectDispatchStarted(first.effectId, 1, 'dispatch-1', { active_release_id: releaseId, runtime_instance_id: 'runtime-a' })).toBe(true);
    store.recordEffectObservation(first.effectId, 'applied-1', 'applied');
    const firstCompletion = {
      completionFingerprint: 'completion-proof-1', taskId, sourceEffectId: first.effectId, action: 'CONTINUE' as const,
      responseSha256: 'response-1', controlBlockSha256: 'control-1',
      proposal: { action: 'CONTINUE' as const, sourceEffectId: first.effectId, checkpoint: 'round-1', reason: 'continue', evidence: [], conversationId, taskId, supervisorState: 'running' as const },
      committedAt: new Date().toISOString(),
    };
    const second = store.commitCompletion(firstCompletion, { effectId: 'fx_22222222222222222222222222222222', kind: 'continuation', prompt: 'round two' }).successorEffect!;
    expect(store.recordEffectDispatchStarted(second.effectId, 1, 'dispatch-2', { active_release_id: releaseId, runtime_instance_id: 'runtime-b' })).toBe(true);
    store.recordEffectObservation(second.effectId, 'applied-2', 'applied');
    const secondCompletion = {
      completionFingerprint: 'completion-proof-2', taskId, sourceEffectId: second.effectId, action: 'CONTINUE' as const,
      responseSha256: 'response-2', controlBlockSha256: 'control-2',
      proposal: { action: 'CONTINUE' as const, sourceEffectId: second.effectId, checkpoint: 'round-2', reason: 'continue', evidence: [], conversationId, taskId, supervisorState: 'running' as const },
      committedAt: new Date().toISOString(),
    };
    const third = store.commitCompletion(secondCompletion, { effectId: 'fx_33333333333333333333333333333333', kind: 'continuation', prompt: 'round three' }).successorEffect!;
    expect(store.recordEffectDispatchStarted(third.effectId, 1, 'dispatch-3', { active_release_id: releaseId, runtime_instance_id: 'runtime-b' })).toBe(true);
    store.recordEffectObservation(third.effectId, 'applied-3', 'applied');
    const thirdCompletion = {
      completionFingerprint: 'completion-proof-3', taskId, sourceEffectId: third.effectId, action: 'DONE' as const,
      responseSha256: 'response-3', controlBlockSha256: 'control-3',
      proposal: { action: 'DONE' as const, sourceEffectId: third.effectId, checkpoint: 'round-3', reason: 'done', evidence: [], conversationId, taskId, supervisorState: 'done' as const },
      committedAt: new Date().toISOString(),
    };
    store.commitCompletion(thirdCompletion);
    store.resolveTerminal({ completionFingerprint: thirdCompletion.completionFingerprint, taskId, action: 'DONE', accepted: true, reason: 'accepted' });

    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: 'other-release', notBefore })).toBeUndefined();
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore })).toMatchObject({
      taskId, conversationId, activeReleaseId: releaseId,
      actions: ['CONTINUE', 'CONTINUE', 'DONE'],
      runtimeInstanceIds: ['runtime-a', 'runtime-b'],
    });
    store.close();
  });

  test('requires a prepared lower ControllerRound before treating an outer turn as runnable', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-lower-layer-readiness';
    const workId = 'work-supervisor-lower-layer-readiness';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor lower-layer readiness', outcomeStatement: 'Do not submit an outer turn without a lower ControllerRound authority.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Require a prepared ControllerRound before Supervisor enrollment.',
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
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, objective: 'Exercise bounded repeated-state authority recovery.', acceptanceCriteria: ['recovery preserves lineage budgets'],
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

  test('reconciles a committed enrolled CONTINUE across a repeated-state block without user recovery', async () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-enrolled-repeat-reconcile';
    const workId = 'work-supervisor-enrolled-repeat-reconcile';
    const conversationId = '56565656-7878-9090-abab-cdcdcdcdcdcd';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    createRequirement({ controllerHome: fx.controllerHome }, {
      requirementId,
      title: 'Enrolled repeat reconcile',
      outcomeStatement: 'A durable Supervisor CONTINUE must mechanically resume unattended execution.',
    });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId,
      objective: 'Prove repeated-state recovery is scoped to exact enrolled unattended continuation.',
      acceptanceCriteria: ['committed CONTINUE reserves successor without another user message'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running',
    });
    const identity = {
      controllerId: 'supervisor-enrolled-repeat-controller', controllerType: 'chatgpt' as const,
      principalId: 'supervisor-enrolled-repeat-principal', controllerInstanceId: 'runtime-supervisor-enrolled-repeat',
    };
    const first = beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { ...identity, sessionId: 'supervisor-enrolled-repeat-1' }, maxRepeatedState: 2,
    });
    finishControllerRoundRelayDispatch(fx.store, { workId, ok: true });
    const firstSession = claimControllerSession(fx.store, { workId, ...identity, sessionId: 'supervisor-enrolled-repeat-1', leaseMs: 60_000 });
    acknowledgeControllerRoundClaim(fx.store, { workId, session: firstSession });
    submitControllerRoundDisposition(fx.store, {
      workId, relayScopeId: first.relayScopeId, identity: { ...identity, sessionId: firstSession.sessionId }, disposition: 'continue_immediately',
    });
    releaseControllerSession(fx.store, workId, identity.controllerId);
    claimStalledControllerRoundRelays(fx.store, { nowMs: Date.now() + 120_000, graceMs: 60_000 });
    finishControllerRoundRelayDispatch(fx.store, { workId, ok: true });
    const secondSession = claimControllerSession(fx.store, { workId, ...identity, sessionId: 'supervisor-enrolled-repeat-2', leaseMs: 60_000 });
    acknowledgeControllerRoundClaim(fx.store, { workId, session: secondSession });
    const blocked = submitControllerRoundDisposition(fx.store, {
      workId, relayScopeId: first.relayScopeId, identity: { ...identity, sessionId: secondSession.sessionId }, disposition: 'continue_immediately',
    });
    expect(blocked).toMatchObject({ status: 'blocked', repeatedStateCount: 2, blockedReason: 'repeated_state:2>=2' });
    releaseControllerSession(fx.store, workId, identity.controllerId);
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl });

    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'enrolled-repeat-reconcile-supervisor'));
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const taskId = `forge:${fx.repository.repoId}:work:${workId}`;
    const task = control.registerTask({
      taskId, conversationId, conversationUrl,
      objective: 'Resume the exact enrolled Work without another user message.',
      completionContract: { kind: 'forge_requirement_done', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId, exact_conversation_id: conversationId, exact_conversation_url: conversationUrl },
      userBlockerPolicy: { kind: 'forge_requirement_waiting_for_user', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
    });
    const enrollment = control.reserveEnrollment(taskId, controllerRoundProviderEffectId(blocked));
    supervisorStore.recordEffectObservation(enrollment.effectId, 'obs-enrolled-repeat-applied', 'applied');
    const completion = {
      completionFingerprint: 'completion-enrolled-repeat-reconcile', taskId, sourceEffectId: enrollment.effectId, action: 'CONTINUE' as const,
      responseSha256: 'response-enrolled-repeat-reconcile', controlBlockSha256: 'control-enrolled-repeat-reconcile',
      proposal: {
        action: 'CONTINUE' as const, sourceEffectId: enrollment.effectId, checkpoint: 'repeat-blocked', reason: 'continue', evidence: [],
        conversationId, taskId, supervisorState: 'running' as const, activeScope: `requirement:${requirementId}`,
      },
      committedAt: new Date().toISOString(),
    };
    supervisorStore.commitCompletion(completion);
    expect(supervisorStore.getEffectByOriginKey(`completion:${completion.completionFingerprint}`)).toBeUndefined();

    const reconciled = await control.reconcileCommittedContinuations();
    expect(reconciled).toEqual({ scanned: 1, reconciled: 1 });
    const successor = supervisorStore.getEffectByOriginKey(`completion:${completion.completionFingerprint}`);
    expect(successor).toBeDefined();
    const relay = getRequirementControllerRoundRelay(fx.store, requirementId);
    expect(relay).toMatchObject({
      status: 'dispatching', repeatedStateCount: blocked.repeatedStateCount, roundCount: blocked.roundCount,
      reason: `continuation_evidence:${completion.completionFingerprint}`,
    });
    expect(successor?.effectId).toMatch(/^fx_/);
    expect(successor?.effectId).not.toBe(enrollment.effectId);
    expect(successor?.effectId).not.toBe(controllerRoundProviderEffectId(relay!));
    expect((await control.reconcileCommittedContinuations())).toEqual({ scanned: 0, reconciled: 0 });
    supervisorStore.close();
  });

  test('reconciles a committed enrolled CONTINUE across lower round-budget exhaustion without resetting lineage', async () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-round-budget-reconcile';
    const workId = 'work-supervisor-round-budget-reconcile';
    const conversationId = '57575757-7979-9191-abab-dededededede';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    createRequirement({ controllerHome: fx.controllerHome }, {
      requirementId,
      title: 'Enrolled round budget reconcile',
      outcomeStatement: 'A durable Supervisor CONTINUE may mechanically resume after lower semantic round budget exhaustion.',
    });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId,
      objective: 'Prove lower ControllerRound budget cannot terminate an exact enrolled outer Supervisor continuation.',
      acceptanceCriteria: ['committed CONTINUE reserves successor without resetting lower lineage history'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running',
    });
    const identity = {
      controllerId: 'supervisor-round-budget-controller', controllerType: 'chatgpt' as const,
      principalId: 'supervisor-round-budget-principal', controllerInstanceId: 'runtime-supervisor-round-budget',
    };
    const first = beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { ...identity, sessionId: 'supervisor-round-budget-1' }, maxRounds: 1, maxRepeatedState: 8,
    });
    finishControllerRoundRelayDispatch(fx.store, { workId, ok: true });
    const session = claimControllerSession(fx.store, { workId, ...identity, sessionId: 'supervisor-round-budget-1', leaseMs: 60_000 });
    acknowledgeControllerRoundClaim(fx.store, { workId, session });
    const blocked = submitControllerRoundDisposition(fx.store, {
      workId, relayScopeId: first.relayScopeId, identity: { ...identity, sessionId: session.sessionId }, disposition: 'continue_immediately',
    });
    expect(blocked).toMatchObject({ status: 'blocked', roundCount: 2, maxRounds: 1, blockedReason: 'round_budget_exhausted:2>1' });
    releaseControllerSession(fx.store, workId, identity.controllerId);
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl });

    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'round-budget-reconcile-supervisor'));
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const taskId = `forge:${fx.repository.repoId}:work:${workId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl,
      objective: 'Resume the exact enrolled Work after lower round budget exhaustion.',
      completionContract: { kind: 'forge_requirement_done', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId, exact_conversation_id: conversationId, exact_conversation_url: conversationUrl },
      userBlockerPolicy: { kind: 'forge_requirement_waiting_for_user', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
    });
    const enrollment = control.reserveEnrollment(taskId, controllerRoundProviderEffectId(blocked));
    supervisorStore.recordEffectObservation(enrollment.effectId, 'obs-round-budget-applied', 'applied');
    const completion = {
      completionFingerprint: 'completion-round-budget-reconcile', taskId, sourceEffectId: enrollment.effectId, action: 'CONTINUE' as const,
      responseSha256: 'response-round-budget-reconcile', controlBlockSha256: 'control-round-budget-reconcile',
      proposal: {
        action: 'CONTINUE' as const, sourceEffectId: enrollment.effectId, checkpoint: 'round-budget-blocked', reason: 'continue', evidence: [],
        conversationId, taskId, supervisorState: 'running' as const, activeScope: `requirement:${requirementId}`,
      },
      committedAt: new Date().toISOString(),
    };
    supervisorStore.commitCompletion(completion);

    // A crash can occur after lower-layer settlement, before the successor is
    // committed. Reconciliation must not reuse the already-applied source id.
    await control.hooks.assistantTurnCommitted?.(control.getTask(taskId)!, completion);
    expect(await control.reconcileCommittedContinuations()).toEqual({ scanned: 1, reconciled: 1 });
    const successor = supervisorStore.getEffectByOriginKey(`completion:${completion.completionFingerprint}`);
    expect(successor).toBeDefined();
    const relay = getRequirementControllerRoundRelay(fx.store, requirementId);
    expect(relay).toMatchObject({
      status: 'dispatching', roundCount: blocked.roundCount, maxRounds: blocked.maxRounds,
      reason: `continuation_evidence:${completion.completionFingerprint}`,
    });
    expect(successor?.effectId).not.toBe(enrollment.effectId);
    expect((await control.reconcileCommittedContinuations())).toEqual({ scanned: 0, reconciled: 0 });
    supervisorStore.close();
  });

  test('reclaims a dispatch-confirmed Supervisor relay before settling a committed CONTINUE', async () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-dispatched-completion-reclaim';
    const workId = 'work-supervisor-dispatched-completion-reclaim';
    const conversationId = '67676767-8989-1010-abab-efefefefefef';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    createRequirement({ controllerHome: fx.controllerHome }, {
      requirementId,
      title: 'Dispatched completion reclaim',
      outcomeStatement: 'A provider-confirmed Supervisor turn must settle without requiring another user claim.',
    });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId,
      objective: 'Settle one dispatch-confirmed Supervisor turn through retained controller identity.',
      acceptanceCriteria: ['committed CONTINUE reserves exactly one successor'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt', status: 'running',
    });
    const identity = {
      controllerId: 'chatgpt-workflow-supervisor', controllerType: 'chatgpt' as const,
      principalId: 'chatgpt-workflow-supervisor', controllerInstanceId: 'runtime-dispatched-completion-reclaim',
      sessionId: 'thin:work-supervisor-dispatched-completion-reclaim',
    };
    const initial = beginInitialControllerRoundDispatch(fx.store, { workId, requirementId, identity });
    finishControllerRoundRelayDispatch(fx.store, { workId, ok: true });
    const retained = claimControllerSession(fx.store, { workId, ...identity, leaseMs: 60_000 });
    releaseControllerSession(fx.store, workId, identity.controllerId);
    expect(retained.claimGeneration).toBeGreaterThan(0);
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.status).toBe('dispatched');
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl });

    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'dispatched-completion-reclaim-supervisor'));
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const taskId = `forge:${fx.repository.repoId}:conversation:${conversationId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl,
      objective: 'Continue after the exact dispatch-confirmed provider turn.',
      completionContract: { kind: 'forge_requirement_done', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId, exact_conversation_id: conversationId, exact_conversation_url: conversationUrl },
      userBlockerPolicy: { kind: 'forge_requirement_waiting_for_user', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
    });
    const enrollment = control.reserveEnrollment(taskId, controllerRoundProviderEffectId(initial));
    supervisorStore.recordEffectObservation(enrollment.effectId, 'obs-dispatched-completion-applied', 'applied');
    const completion = {
      completionFingerprint: 'completion-dispatched-reclaim', taskId, sourceEffectId: enrollment.effectId, action: 'CONTINUE' as const,
      responseSha256: 'response-dispatched-reclaim', controlBlockSha256: 'control-dispatched-reclaim',
      proposal: {
        action: 'CONTINUE' as const, sourceEffectId: enrollment.effectId, checkpoint: 'dispatch-confirmed', reason: 'continue', evidence: [],
        conversationId, taskId, supervisorState: 'running' as const, activeScope: `requirement:${requirementId}`,
      },
      committedAt: new Date().toISOString(),
    };
    supervisorStore.commitCompletion(completion);
    expect(getControllerSession(fx.store, workId)).toBeUndefined();

    const reconciled = await control.reconcileCommittedContinuations();
    expect(reconciled).toEqual({ scanned: 1, reconciled: 1 });
    expect(supervisorStore.getEffectByOriginKey(`completion:${completion.completionFingerprint}`)).toBeDefined();
    expect(getControllerSession(fx.store, workId)).toBeUndefined();
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.status).toBe('dispatching');
    supervisorStore.close();
  });

  test('retires a predecessor browser task after the Work CAS-rebinds to a fresh conversation', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-conversation-rebind';
    const workId = 'work-supervisor-conversation-rebind';
    const oldConversationId = '11111111-aaaa-bbbb-cccc-222222222222';
    const newConversationId = '33333333-dddd-eeee-ffff-444444444444';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor rebind', outcomeStatement: 'Only the current exact Work conversation owns browser delivery.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Move autonomous execution onto a fresh conversation without retaining the predecessor writer.',
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
      status: 'outer_turn',
      workId,
      requirementId,
      conversationId: newConversationId,
      conversationUrl: `https://chatgpt.com/c/${newConversationId}`,
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
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Prove canonical terminal Work authority retires the stale Supervisor relay.',
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
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Prove completed Work is not projected as active Supervisor work.',
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
  expect(control.browserTasks()).toEqual([{
    taskId,
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
  }]);
});

test('browserTasks isolates a stale legacy task from an independent bootstrap task', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-browser-task-isolation-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store, {}, {
    browserTaskActive: (task) => {
      if (task.taskId === 'legacy-stale-task') throw new Error('STALE_LEGACY_WORK');
      return true;
    },
  });
  const legacyConversationId = '56565656-1111-2222-3333-343434343434';
  control.registerTask({
    taskId: 'legacy-stale-task',
    conversationId: legacyConversationId,
    conversationUrl: `https://chatgpt.com/c/${legacyConversationId}`,
    objective: 'Legacy task must fail closed locally.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  control.reserveEnrollment('legacy-stale-task');
  control.registerTask({
    taskId: 'standalone-bootstrap-task',
    conversationId: 'bootstrap:standalone-bootstrap-task',
    conversationUrl: 'https://chatgpt.com/',
    objective: 'Independent bootstrap must remain dispatchable.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true }, userBlockerPolicy: {},
  });
  control.reserveEnrollment('standalone-bootstrap-task');

  expect(control.browserTasks()).toEqual([
    expect.objectContaining({ taskId: 'standalone-bootstrap-task', conversationId: 'bootstrap:standalone-bootstrap-task' }),
  ]);
});

test('browserTasks prioritizes fresh sends ahead of older reconciliation work', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-browser-task-priority-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store);

  control.registerTask({
    taskId: 'older-reconcile-task',
    conversationId: 'bootstrap:older-reconcile-task',
    conversationUrl: 'https://chatgpt.com/',
    objective: 'Older outcome-unknown bootstrap.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true }, userBlockerPolicy: {},
  });
  const older = control.reserveEnrollment('older-reconcile-task');
  expect(control.bootstrapBeginEffect({
    taskId: 'older-reconcile-task', effectId: older.effectId,
    dispatchId: 'dispatch-older-reconcile', dispatchGeneration: 1,
  })).toBe(true);
  control.bootstrapObserveEffect({
    taskId: 'older-reconcile-task', effectId: older.effectId,
    observationId: 'older-outcome-unknown', outcome: 'unknown',
  });

  control.registerTask({
    taskId: 'fresh-send-task',
    conversationId: 'bootstrap:fresh-send-task',
    conversationUrl: 'https://chatgpt.com/',
    objective: 'Fresh bootstrap must not be starved by reconciliation backlog.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true }, userBlockerPolicy: {},
  });
  control.reserveEnrollment('fresh-send-task');

  // The older unknown is temporarily suppressed; once its bounded observation
  // backoff expires, the fresh send still sorts ahead of reconciliation.
  clock.nowMs += 10_000;
  expect(control.browserTasks().map((task) => task.taskId)).toEqual([
    'fresh-send-task',
    'older-reconcile-task',
  ]);
});

test('enrolled conversations never create a browser tab for send or reconciliation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-reconcile-no-create-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'reconcile-no-create-task';
  const conversationId = '45454545-6767-8989-1010-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Reconcile without manufacturing browser resources.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  expect(control.browserPoll({ conversationId, conversationUrl }).command?.mode).toBe('send');

  let createCalls = 0;
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    platform: 'darwin',
    listTabs: async () => ({ entries: [], unavailableProducts: [] }),
    reattach: async () => { throw new Error('unexpected reattach'); },
    create: async () => { createCalls += 1; throw new Error('unexpected create'); },
    close: async () => undefined,
    readOwner: async () => '',
    writeOwner: async () => undefined,
    snapshot: async () => { throw new Error('unexpected snapshot'); },
    clearComposer: async () => false,
    dispatchPrompt: async () => { throw new Error('unexpected dispatch'); },
    nowMs: () => clock.nowMs,
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onError: (error) => { throw error; },
  });

  await adapter.runOnce();
  expect(createCalls).toBe(0);
  expect(store.nextBrowserEffect(taskId)).toEqual(expect.objectContaining({ mode: 'send', generation: 1 }));

  expect(control.browserBeginEffect({
    conversationId, conversationUrl, effectId: effect.effectId,
    dispatchId: 'reconcile-no-create-dispatch', dispatchGeneration: 1,
    evidence: { surface: 'test', latest_user_text: '', latest_assistant_response: '' },
  })).toEqual(expect.objectContaining({ started: true }));
  control.browserObserveEffect({
    conversationId, conversationUrl, effectId: effect.effectId,
    observationId: 'reconcile-no-create-unknown', outcome: 'unknown',
    evidence: { surface: 'test' },
  });
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toBeUndefined();

  clock.nowMs += 10_000;
  expect(control.browserPoll({ conversationId, conversationUrl }).command?.mode).toBe('reconcile');
  await adapter.runOnce();

  expect(createCalls).toBe(0);
  expect(store.nextBrowserEffect(taskId)).toEqual(expect.objectContaining({ mode: 'reconcile', generation: 1 }));
});

test('retries a bootstrap effect after a proven pre-send failure instead of reconciling it forever', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-negative-proof-'));
  roots.push(root);
  const dispatchedAt = 1_700_000_000_000;
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => dispatchedAt });
  const control = new WorkflowSupervisorControlPlane(store);
  control.registerTask({
    taskId: 'bootstrap-negative-proof-task',
    conversationId: 'bootstrap:bootstrap-negative-proof-task',
    conversationUrl: 'https://chatgpt.com/',
    objective: 'Retry only after a mechanically proven pre-send failure.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true }, userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment('bootstrap-negative-proof-task');
  expect(control.bootstrapBeginEffect({
    taskId: 'bootstrap-negative-proof-task', effectId: effect.effectId,
    dispatchId: 'dispatch-pre-send-failure', dispatchGeneration: 1,
  })).toBe(true);
  control.bootstrapObserveEffect({
    taskId: 'bootstrap-negative-proof-task', effectId: effect.effectId,
    observationId: 'proven-no-send', outcome: 'not_applied',
  });

  expect(store.nextBrowserEffect('bootstrap-negative-proof-task', { nowMs: dispatchedAt + 30_000 }))
    .toEqual(expect.objectContaining({ effect: expect.objectContaining({ effectId: effect.effectId }), mode: 'send', generation: 2 }));
});

test('bootstrap does not require window.name and reconciles the exact effect marker after navigation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-causal-marker-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store, {}, {
    projectScopeForTask: () => ({ title: 'forge' }),
  });
  const projectUrl = 'https://chatgpt.com/g/g-p-forge/project';
  const conversationId = 'abababab-cdcd-efef-1212-343434343434';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.recordBrowserDiscovery('test', [{
    conversationId: '11111111-2222-3333-4444-555555555555',
    canonicalUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    title: 'Forge project seed', projectTitle: 'forge', projectUrl,
  }]);
  const taskId = 'bootstrap-causal-marker-task';
  control.registerTask({
    taskId, conversationId: `bootstrap:${taskId}`, conversationUrl: 'https://chatgpt.com/',
    objective: 'Bind from causal effect evidence even when navigation clears window.name.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true }, userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  const page: WorkflowSupervisorNativePage = {
    evaluate: async <T>() => false as T,
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'window-bootstrap', tabId: 'tab-bootstrap' }),
  };
  let canonical = false;
  let sentPrompt = '';
  let dispatchCount = 0;
  let closeCount = 0;
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    platform: 'darwin',
    listTabs: async () => ({ entries: [{
      windowId: 'window-bootstrap', tabId: 'tab-bootstrap', active: false,
      url: canonical ? conversationUrl : projectUrl, title: 'Forge bootstrap', browserProduct: 'chrome',
    }], unavailableProducts: [] }),
    reattach: async () => page,
    create: async () => page,
    close: async () => { closeCount += 1; },
    readOwner: async () => '',
    writeOwner: async () => undefined,
    snapshot: async () => ({
      url: canonical ? conversationUrl : projectUrl,
      title: 'Forge bootstrap', latestUserText: sentPrompt,
      userMessages: sentPrompt ? [sentPrompt] : [],
      latestAssistantResponse: '', providerActivityText: '', providerFailureText: '',
      latestTurnRole: sentPrompt ? 'user' : undefined, isGenerating: false,
    }),
    clearComposer: async () => true,
    dispatchPrompt: async (_page, prompt) => { sentPrompt = prompt; dispatchCount += 1; return { dispatched: true, confirmed: true }; },
    nowMs: () => clock.nowMs,
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onError: (error) => { throw error; },
  });

  await adapter.runOnce();
  // The send outcome is still unknown until the canonical conversation route
  // and exact effect marker become observable. Do not re-poll on the next tick.
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(dispatchCount).toBe(1);

  canonical = true;
  clock.nowMs += 10_000;
  await adapter.runOnce();

  expect(control.getTask(taskId)).toEqual(expect.objectContaining({ conversationId, conversationUrl }));
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(store.latestEffectDispatch(effect.effectId)?.generation).toBe(1);
  expect(dispatchCount).toBe(1);
  expect(closeCount).toBe(0);
});

test('reconciles a late applied Supervisor effect into the same outcome-unknown ControllerRound without replay', () => {
  const fx = fixture();
  const requirementId = 'REQ-supervisor-late-provider-confirmation';
  const workId = 'work-supervisor-late-provider-confirmation';
  const conversationId = '45454545-6767-8989-0101-232323232323';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  createRequirement({ controllerHome: fx.controllerHome }, {
    requirementId,
    title: 'Late provider confirmation',
    outcomeStatement: 'Reconcile exact applied provider evidence into the original ControllerRound.',
  });
  createWorkContract({ controllerHome: fx.controllerHome, scopeKey: SEMANTIC_SCOPE_KEY }, {
    workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Prove an outcome-unknown provider dispatch converges when the same external effect is later observed applied.',
    acceptanceCriteria: ['same effect and authority become dispatched without replay'], allowedPaths: [], forbiddenPaths: [], checks: [],
    constraints: { workspaceMode: 'current', requireWorktree: false, requireHandoffOnAmbiguity: true }, requestedBy: 'chatgpt', status: 'running',
  });
  const initial = beginInitialControllerRoundDispatch(fx.store, {
    workId, requirementId,
    identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
  });
  const providerDispatchEffectId = controllerRoundProviderEffectId(initial);
  bindChatgptWorkConversation(fx.store, { workId, conversationUrl });

  const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'late-provider-confirmation-supervisor'));
  const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
  const taskId = `forge:${fx.repository.repoId}:work:${workId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl, objective: 'Reconcile the exact already-applied provider effect.',
    completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
    continuationPolicy: { kind: 'forge_goal_outer_turn' },
    userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
  });
  const effect = control.reserveEnrollment(taskId, providerDispatchEffectId);
  expect(effect.effectId).toBe(providerDispatchEffectId);
  expect(supervisorStore.latestEffectDispatch(providerDispatchEffectId)).toBeUndefined();

  const blocked = finishControllerRoundRelayDispatch(fx.store, {
    workId, ok: false, outcomeUnknown: true, providerDispatchEffectId,
    error: 'CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE',
  });
  expect(blocked).toMatchObject({
    status: 'blocked',
    blockedReason: 'provider_dispatch_outcome_unknown',
    providerDispatchEffectId,
    authorityId: initial.authorityId,
  });
  expect(workflowSupervisorLowerLayerReadyForWork(fx.store, workId)).toEqual({
    ready: true,
    workId,
    providerEffectId: providerDispatchEffectId,
  });
  const reenrolled = control.reserveEnrollment(taskId, providerDispatchEffectId);
  expect(reenrolled.effectId).toBe(providerDispatchEffectId);
  expect(control.browserTasks()).toHaveLength(1);
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toMatchObject({
    mode: 'reconcile',
    effectId: providerDispatchEffectId,
    dispatchGeneration: 1,
  });
  expect(supervisorStore.latestEffectDispatch(providerDispatchEffectId)).toMatchObject({
    generation: 1,
    evidence: {
      inherited_provider_dispatch: true,
      surface: 'controller_round_reconciliation',
    },
  });

  control.browserObserveEffect({
    conversationId, conversationUrl, effectId: providerDispatchEffectId,
    observationId: 'late-provider-applied',
    outcome: 'applied',
    evidence: { surface: 'test', exact_user_message: true, reconciliation: true },
  });

  const reconciled = getRequirementControllerRoundRelay(fx.store, requirementId)!;
  expect(reconciled).toMatchObject({
    status: 'dispatched',
    lifecycleStage: 'dispatch_confirmed',
    providerDispatchEffectId,
    authorityId: initial.authorityId,
    providerDispatchAttempt: blocked?.providerDispatchAttempt,
  });
  expect(reconciled.blockedReason).toBeUndefined();
  expect(reconciled.lastError).toBeUndefined();
  expect(reconciled.providerDispatchReceiptId).toContain(`workflow-supervisor:${providerDispatchEffectId}:late-provider-applied`);

  control.browserObserveEffect({
    conversationId, conversationUrl, effectId: providerDispatchEffectId,
    observationId: 'late-provider-applied-duplicate',
    outcome: 'applied',
    evidence: { surface: 'test', exact_user_message: true, reconciliation: true },
  });
  expect(getRequirementControllerRoundRelay(fx.store, requirementId)).toMatchObject({
    status: 'dispatched',
    providerDispatchEffectId,
    authorityId: initial.authorityId,
    providerDispatchAttempt: reconciled.providerDispatchAttempt,
  });
});

test('provider recovery is a single exactly-once resume and does not recurse through Scheduler policy', async () => {
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
  // Exhaustion bounds recovery recursion; it does not abandon an already-applied
  // provider turn whose assistant receipt may still arrive late.
  expect(control.browserTasks()).toEqual([]);

  const lateReceipt = renderSupervisorReceipt(control.getTask(taskId)!, resume.effectId, 'CONTINUE');
  const late = await control.observeAssistantTurn({ taskId, conversationId, responseText: lateReceipt });
  expect(late.action).toBe('CONTINUE');
  expect(late.terminal).toBe(false);
  expect(late.successorEffect).toBeDefined();
  expect(store.getCompletionByResponseSha256(taskId, createHash('sha256').update(lateReceipt).digest('hex'))?.sourceEffectId).toBe(resume.effectId);
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
  expect(chatgptProviderPageFailure('ChatGPT stream recovery polling timed out')).toBe(CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE);
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

test('stream recovery stays on the attached exact tab and never creates a replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-stream-recovery-tab-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const conversationId = '23232323-2323-2323-2323-232323232323';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId: 'stream-recovery-tab', conversationId, conversationUrl,
    objective: 'Recover a failed stream without replaying its source effect.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const enrollment = control.reserveEnrollment('stream-recovery-tab');
  expect(store.recordEffectDispatchStarted(enrollment.effectId, 1, 'enrollment-dispatch', { surface: 'test' })).toBe(true);
  control.observeEffect({ effectId: enrollment.effectId, observationId: 'enrollment-applied', outcome: 'applied' });

  const page = (tabId: string): WorkflowSupervisorNativePage => ({
    evaluate: async <T>() => false as T,
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'window-1', tabId }),
  });
  const stalePage = page('tab-1');
  const owners = new Map<unknown, string>([[stalePage, `forge-workflow-supervisor:created:${conversationId}`]]);
  const createdUrls: string[] = [];
  const closed: unknown[] = [];
  const dispatchedPages: unknown[] = [];
  let nowMs = 0;
  const snapshot = (page: unknown) => ({
    url: conversationUrl,
    title: 'Forge recovery test',
    latestUserText: '', latestAssistantResponse: '', providerActivityText: '',
    providerFailureText: page === stalePage ? 'ChatGPT stream recovery polling timed out' : '',
    latestTurnRole: 'assistant' as const, isGenerating: false,
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    platform: 'darwin',
    listTabs: async () => ({ entries: [{ windowId: 'window-1', tabId: 'tab-1', url: conversationUrl, title: 'Forge recovery test', active: false, browserProduct: 'chrome' }], unavailableProducts: [] }),
    reattach: async () => stalePage,
    create: async (url) => { createdUrls.push(url); throw new Error('unexpected create'); },
    close: async (ref) => { closed.push(ref); },
    readOwner: async (page) => owners.get(page) ?? '',
    writeOwner: async (page, owner) => { owners.set(page, owner); },
    snapshot: async (page) => snapshot(page),
    dispatchPrompt: async (page) => { dispatchedPages.push(page); return { dispatched: true, confirmed: true }; },
    nowMs: () => nowMs,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    onError: (error) => { throw error; },
  });

  await adapter.runOnce();

  // The stream error applies provider backpressure before the recovery attempt.
  // On the next eligible tick the same reserved recovery effect stays on the
  // already-attached exact tab instead of manufacturing another resource.
  nowMs += 30_000;
  await adapter.runOnce();

  expect(createdUrls).toEqual([]);
  expect(dispatchedPages).toEqual([stalePage]);
  expect(closed).toContainEqual(expect.objectContaining({ windowId: 'window-1', tabId: 'tab-1' }));
  expect(store.latestEffectDispatch(enrollment.effectId)?.generation).toBe(1);
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

  expect(control.browserTasks()).toEqual([]);
});

test('refuses a not-applied proof observed on an unrendered conversation page', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-not-applied-surface-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-not-applied-surface';
  const conversationId = '57575757-6868-7979-8080-919191919191';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId,
    conversationId,
    conversationUrl,
    objective: 'Only a rendered conversation surface may prove non-application.',
    completionContract: {},
    continuationPolicy: {},
    userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  const latestUserText = 'baseline user turn';
  const latestAssistantResponse = 'baseline assistant turn';
  const began = control.browserBeginEffect({
    conversationId,
    conversationUrl,
    effectId: effect.effectId,
    dispatchId: 'dispatch-surface-1',
    dispatchGeneration: 1,
    evidence: { surface: 'test', latest_user_text: latestUserText, latest_assistant_response: latestAssistantResponse },
  });
  expect(began.started).toBe(true);

  // An empty/loading page with no readable composer cannot distinguish "the send
  // never applied" from "nothing rendered yet", so it is not negative proof.
  control.browserObserveEffect({
    conversationId,
    conversationUrl,
    effectId: effect.effectId,
    observationId: 'unrendered-page',
    outcome: 'not_applied',
    evidence: {
      surface: 'test',
      reconciliation: true,
      reason: 'composer_state_unavailable',
      latest_user_text: latestUserText,
      latest_assistant_response: latestAssistantResponse,
    },
  });
  // Unproven negative evidence must never mint a new provider generation. The
  // Browser lane may stay quiet under observation backoff; a later external
  // rendered-surface observation is still accepted independently of polling.
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 3_600_000 }))
    .toMatchObject({ mode: 'reconcile', generation: 1 });

  // The same observation from a rendered conversation surface whose composer is
  // provably empty is real negative proof and does authorise the spaced retry.
  control.browserObserveEffect({
    conversationId,
    conversationUrl,
    effectId: effect.effectId,
    observationId: 'rendered-empty-composer',
    outcome: 'not_applied',
    evidence: {
      surface: 'test',
      reconciliation: true,
      reason: 'composer_proven_empty',
      provider_surface_rendered: true,
      latest_user_text: latestUserText,
      latest_assistant_response: latestAssistantResponse,
    },
  });
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 31_000 }))
    .toMatchObject({ mode: 'send', generation: 2 });
});

test('bounds and spaces provider re-dispatch of one un-applied effect, then releases browser attention', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-dispatch-budget-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-dispatch-budget';
  const conversationId = '58585858-6969-7070-8181-929292929292';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId,
    conversationId,
    conversationUrl,
    objective: 'One un-applied effect may not mint unlimited provider submissions.',
    completionContract: {},
    continuationPolicy: {},
    userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  const latestUserText = 'baseline user turn';
  const latestAssistantResponse = 'baseline assistant turn';
  const snapshotEvidence = { latest_user_text: latestUserText, latest_assistant_response: latestAssistantResponse };
  const dispatch = (generation: number): void => {
    expect(control.browserBeginEffect({
      conversationId,
      conversationUrl,
      effectId: effect.effectId,
      dispatchId: `dispatch-budget-${generation}`,
      dispatchGeneration: generation,
      evidence: { surface: 'test', ...snapshotEvidence },
    })).toMatchObject({ started: true, mode: 'send', generation });
  };
  const proveNotApplied = (observationId: string): void => {
    control.browserObserveEffect({
      conversationId,
      conversationUrl,
      effectId: effect.effectId,
      observationId,
      outcome: 'not_applied',
      evidence: {
        surface: 'test',
        reconciliation: true,
        reason: 'composer_proven_empty',
        provider_surface_rendered: true,
        ...snapshotEvidence,
      },
    });
  };

  dispatch(1);
  proveNotApplied('budget-proof-1');
  // Inside the retry window the provider and Browser lane are both left alone;
  // the proof only permits a later generation, it does not replay or re-observe immediately.
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();

  clock.nowMs += 30_000;
  dispatch(2);
  proveNotApplied('budget-proof-2');
  clock.nowMs += 60_000;
  dispatch(3);
  proveNotApplied('budget-proof-3');

  expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 3, maxGenerations: 3, exhausted: true });
  // Exhaustion stops demanding the conversation tab, so the adapter no longer
  // re-opens and re-observes a provider effect it can never deliver.
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(control.browserTasks()).toEqual([]);
  // The ceiling also holds for a caller that names a generation past the budget.
  expect(store.recordEffectDispatchStarted(effect.effectId, 4, 'dispatch-budget-4')).toBe(false);
  expect(store.latestEffectDispatch(effect.effectId)?.generation).toBe(3);
});
