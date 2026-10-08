import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome, SEMANTIC_SCOPE_KEY } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { acknowledgeControllerRoundClaim, beginInitialControllerRoundDispatch, claimStalledControllerRoundRelays, controllerRoundProviderEffectId, finishControllerRoundRelayDispatch, getControllerRoundRelay, getRequirementControllerRoundRelay, recoverControllerRoundRelayAuthority, submitControllerRoundDisposition } from '../../packages/kernel/controller/api/index';
import { createWorkContract, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { createRequirement, reviseRequirementSemantic, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { bindCurrentWorkflowSupervisorConversationForWork, ensureWorkflowSupervisorEnrollmentForWork, forgeWorkflowSupervisorLifecycleHooks, inheritWorkflowSupervisorConversationBinding, workflowSupervisorBoundaryForWork, workflowSupervisorLowerLayerReadyForWork } from '../../src/runtime/root/workflow-supervisor-composition';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { TASK_TARGET_SPACED_FAILURE_CODES, WorkflowSupervisorNativeBrowserAdapter } from '../../supervisor/native-browser-adapter';
import { LEGACY_SUPERVISOR_BLOCK_END, LEGACY_SUPERVISOR_BLOCK_START, parseSupervisorCompletion, renderSupervisorPrompt, renderSupervisorReceipt, supervisorReceiptChallenge, SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START, SUPERVISOR_TURN_BLOCK_END, SUPERVISOR_TURN_BLOCK_START } from '../../supervisor/protocol';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { createWorkflowSupervisorServer, reconcileWorkflowSupervisorSocket, WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { claimControllerSession, getControllerSession, releaseControllerSession } from '../../src/runtime/control-plane/facade/controller-session-store';
import { bindChatgptWorkConversation, getChatgptWorkConversationBinding, rebindChatgptWorkConversation } from '../../adapters/chatgpt/work-conversation-binding-store';
import { CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE, chatgptProviderPageFailure, classifyChatgptProviderFailure } from '../../adapters/chatgpt/provider-delivery';
import { chatgptComposerRetainsPrompt, chatgptFailedRequestIsCausalRateLimit } from '../../adapters/chatgpt/browser-delivery-runtime';
import { parseChatgptConversationIdentity } from '../../supervisor/chatgpt-conversation';
import { setMacOsBrowserRuntimeHooksForTest, resetMacOsBrowserRuntimeHooksForTest } from '../../src/runtime/plugins/browser-macos-bridge';
import { createTestChatgptTargetPort, type TestBrowserPage } from './helpers/computer-chatgpt-target-harness';
import { callWorkflowSupervisorAdapter } from '../../adapters/mcp/runtime-gateway/workflow-supervisor-adapter';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';

const roots: string[] = [];
afterEach(() => { resetMacOsBrowserRuntimeHooksForTest(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function parseSupervisorTurn(prompt: string): Record<string, any> {
  const lines = prompt.split('\n');
  const start = lines.indexOf(SUPERVISOR_TURN_BLOCK_START);
  const end = lines.indexOf(SUPERVISOR_TURN_BLOCK_END);
  if (start < 0 || end !== start + 2) throw new Error('SUPERVISOR_TURN_ENVELOPE_MISSING');
  return JSON.parse(lines[start + 1]!);
}

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

describe('ChatGPT Supervisor composer pre-send verification', () => {
  const payload = '@forge\n<<<FORGE_WORKFLOW_EFFECT_V1:fx_example01>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  test('requires an exact observed composer payload before send', () => {
    expect(chatgptComposerRetainsPrompt(payload, payload)).toBe(true);
    expect(chatgptComposerRetainsPrompt(undefined, payload)).toBe(false);
    expect(chatgptComposerRetainsPrompt('@forge', payload)).toBe(false);
    expect(chatgptComposerRetainsPrompt(payload.slice(1), payload)).toBe(false);
  });
});

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
      completionContract: { repo_id: 'repo-route-identity' },
      continuationPolicy: {},
      userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment('route-identity');
    const original = store.getTask('route-identity')!;
    const enriched = control.registerTask({ ...original, completionContract: { ...original.completionContract, checkout_id: 'checkout_ios_candidate' } });
    expect(enriched.conversationId).toBe(original.conversationId);
    expect(control.registerTask(enriched)).toEqual(enriched);
    expect(control.registerTask(original)).toEqual(enriched);
    expect(store.getEffect(effect.effectId)).toEqual(effect);
    expect(() => control.registerTask({ ...enriched, completionContract: { ...enriched.completionContract, checkout_id: 'checkout_other_candidate' } })).toThrow('WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT');
    expect(() => control.registerTask({ ...enriched, objective: 'Replace the original objective.' })).toThrow('WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT');

    expect(control.browserPoll({
      conversationId,
      conversationUrl: `https://chatgpt.com/g/g-p-abc123-forge/c/${conversationId}`,
    }).command).toMatchObject({ effectId: effect.effectId, conversationId });
    store.close();
  });

  test('refreshes the canonical objective for enrollment and continuation prompts', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-canonical-objective-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    let canonicalObjective = 'Current canonical objective v1.';
    const control = new WorkflowSupervisorControlPlane(store, {
      completionContract: async () => ({ valid: true, reason: 'ok' }),
      userBlockerPolicy: async () => ({ valid: true, reason: 'ok' }),
    }, {
      canonicalObjectiveForTask: () => canonicalObjective,
    });
    const conversationId = '33333333-4444-5555-6666-777777777777';
    control.registerTask({
      taskId: 'canonical-objective-refresh',
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Stale registration objective.',
      completionContract: {},
      continuationPolicy: {},
      userBlockerPolicy: {},
    });

    const enrollment = control.reserveEnrollment('canonical-objective-refresh');
    expect(control.getTask('canonical-objective-refresh')?.objective).toBe('Stale registration objective.');
    expect(enrollment.prompt).toContain('Current canonical objective v1.');
    expect(enrollment.prompt).not.toContain('Stale registration objective.');
    control.observeEffect({ effectId: enrollment.effectId, observationId: 'canonical-objective-applied', outcome: 'applied' });

    canonicalObjective = 'Current canonical objective v2.';
    const recovery = control.recoverTask({
      taskId: 'canonical-objective-refresh',
      sourceEffectId: enrollment.effectId,
      requestId: 'canonical-objective-recovery',
      reason: 'Verify prompt refresh after the canonical Work objective changes.',
    }).recoveryEffect;
    expect(parseSupervisorTurn(recovery.prompt).goal).toEqual({ role: 'outcome', objective: 'Current canonical objective v2.' });
    expect(recovery.prompt).not.toContain('Current canonical objective v1.');
    expect(recovery.prompt).not.toContain('Stale registration objective.');
    store.close();
  });

  test('uses the Requirement outcome as canonical Supervisor goal instead of the Work execution objective', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-outcome-authority';
    const workId = 'work-supervisor-outcome-authority';
    createRequirement({ controllerHome: fx.controllerHome }, {
      requirementId,
      title: 'Supervisor outcome authority',
      outcomeStatement: 'Deliver the durable requirement outcome v1.',
    });
    createWorkContract(fx.store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      requirementId,
      objective: 'Inspect only file A and stop after one check.',
      acceptanceCriteria: ['Requirement outcome remains the outer-turn goal'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
    });
    const hooks = forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome);
    const task = {
      taskId: 'task-supervisor-outcome-authority',
      conversationId: '44444444-5555-6666-7777-888888888888',
      conversationUrl: 'https://chatgpt.com/c/44444444-5555-6666-7777-888888888888',
      objective: 'Historical task registration objective.',
      completionContract: {
        controller_home: fx.controllerHome,
        repo_id: fx.repository.repoId,
        requirement_id: requirementId,
        work_id: workId,
      },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    expect(hooks.canonicalObjectiveForTask?.(task)).toBe('Deliver the durable requirement outcome v1.');
    expect(hooks.canonicalObjectiveForTask?.(task)).not.toBe('Inspect only file A and stop after one check.');

    reviseRequirementSemantic({ controllerHome: fx.controllerHome }, requirementId, {
      expectedRevision: 1,
      outcomeStatement: 'Deliver the durable requirement outcome v2.',
    });
    expect(hooks.canonicalObjectiveForTask?.(task)).toBe('Deliver the durable requirement outcome v2.');
  });

  test('revises an active task outcome in place and refreshes only an undispatched effect prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-objective-revise-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const originalObjective = 'Legacy objective with execution-detail baggage.';
    const task = control.registerTask({
      taskId: 'task-objective-revise',
      conversationId: '19191919-2828-3737-4646-555555555555',
      conversationUrl: 'https://chatgpt.com/c/19191919-2828-3737-4646-555555555555',
      objective: originalObjective,
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(task.taskId, 'fx_objective_revise_1234');
    const originalSha = createHash('sha256').update(originalObjective).digest('hex');
    const revised = control.reviseTaskObjective({
      taskId: task.taskId,
      objective: 'Deliver the current product outcome until complete or genuinely blocked.',
      expectedObjectiveSha256: originalSha,
      requestId: 'objective-revise-1',
      authorizedBy: 'user',
    });
    expect(revised).toMatchObject({ changed: true, deduplicated: false, task: { taskId: task.taskId, conversationId: task.conversationId } });
    expect(revised.refreshedEffect?.effectId).toBe(effect.effectId);
    expect(parseSupervisorTurn(revised.refreshedEffect!.prompt)).toMatchObject({
      schema_version: 2,
      identity: { task_id: task.taskId, effect_id: effect.effectId, kind: 'enrollment' },
      goal: { role: 'outcome', objective: 'Deliver the current product outcome until complete or genuinely blocked.' },
    });
    expect(revised.refreshedEffect!.prompt).not.toContain(originalObjective);

    const duplicate = control.reviseTaskObjective({
      taskId: task.taskId,
      objective: revised.task.objective,
      expectedObjectiveSha256: originalSha,
      requestId: 'objective-revise-1',
      authorizedBy: 'user',
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.refreshedEffect?.effectId).toBe(effect.effectId);

    store.recordEffectDispatchStarted(effect.effectId, 1, 'dispatch-after-revise');
    const promptAfterDispatch = store.getEffect(effect.effectId)!.prompt;
    const second = control.reviseTaskObjective({
      taskId: task.taskId,
      objective: 'Deliver the refined outcome without encoding an execution plan.',
      expectedObjectiveSha256: revised.objectiveSha256,
      requestId: 'objective-revise-2',
      authorizedBy: 'user',
    });
    expect(second.changed).toBe(true);
    expect(second.refreshedEffect).toBeUndefined();
    expect(store.getEffect(effect.effectId)!.prompt).toBe(promptAfterDispatch);
    expect(() => control.reviseTaskObjective({
      taskId: task.taskId,
      objective: 'Conflicting writer outcome.',
      expectedObjectiveSha256: originalSha,
      requestId: 'objective-revise-conflict',
    })).toThrow('WORKFLOW_SUPERVISOR_OBJECTIVE_REVISION_CONFLICT');
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
    const chinese = new WorkflowSupervisorControlPlane(supervisorStore, {}, {
      ...hooks, projectScopeForTask: () => ({ title: '肾宝保' }),
    });
    chinese.recordBrowserDiscovery('test', [{
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      canonicalUrl: 'https://chatgpt.com/g/g-p-abc123/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      projectTitle: '肾宝保', projectUrl: 'https://chatgpt.com/g/g-p-abc123/project',
    }, {
      conversationId: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb',
      canonicalUrl: 'https://chatgpt.com/g/g-p-near456/c/ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb',
      projectTitle: '肾宝保2', projectUrl: 'https://chatgpt.com/g/g-p-near456/project',
    }]);
    expect(chinese.bootstrapProjectUrl(task.taskId)).toBe('https://chatgpt.com/g/g-p-abc123/project');
    // A different project's sidebar observation cannot relabel this route,
    // even when the Chinese project has no slug in its canonical URL.
    chinese.recordBrowserDiscovery('stale-extension', [{
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      canonicalUrl: 'https://chatgpt.com/g/g-p-abc123/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      projectTitle: 'forge', projectUrl: 'https://chatgpt.com/g/g-p-other123/project',
    }]);
    expect(chinese.bootstrapProjectUrl(task.taskId)).toBe('https://chatgpt.com/g/g-p-abc123/project');
    expect(chinese.browserDiscoverySnapshot().conversations.find(entry => entry.conversationId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')?.projectTitle).toBe('肾宝保');
    chinese.recordBrowserDiscovery('stale-extension', [{
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      canonicalUrl: 'https://chatgpt.com/g/g-p-abc123/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }]);
    expect(chinese.bootstrapProjectUrl(task.taskId)).toBe('https://chatgpt.com/g/g-p-abc123/project');
    chinese.recordBrowserDiscovery('test', [{
      conversationId: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb',
      canonicalUrl: 'https://chatgpt.com/g/g-p-near456/c/ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb',
      projectTitle: '肾宝保', projectUrl: 'https://chatgpt.com/g/g-p-near456/project',
    }]);
    expect(() => chinese.bootstrapProjectUrl(task.taskId)).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_AMBIGUOUS');
    supervisorStore.close();
  });

  test('matches a leading product token to a longer Project identity and fails closed on ambiguity', () => {
    const fx = fixture();
    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'bounded-project-product-token'));
    const task = supervisorStore.registerTask({
      taskId: 'forge:repo:bounded-project-product-token',
      conversationId: 'bootstrap:bounded-project-product-token',
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Bootstrap inside Avela.',
      completionContract: {},
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
      userBlockerPolicy: {},
    });
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, {
      projectScopeForTask: () => ({ title: 'Avela' }),
    });
    control.recordBrowserDiscovery('test', [{
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      canonicalUrl: 'https://chatgpt.com/g/g-p-avela123-avela-yi-fu-yao/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      projectTitle: 'Avela Yi Fu Yao',
      projectUrl: 'https://chatgpt.com/g/g-p-avela123-avela-yi-fu-yao/project',
    }]);
    expect(control.bootstrapProjectUrl(task.taskId)).toBe('https://chatgpt.com/g/g-p-avela123/project');

    control.recordBrowserDiscovery('test', [{
      conversationId: 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb',
      canonicalUrl: 'https://chatgpt.com/g/g-p-sandbox456-avela-sandbox/c/ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb',
      projectTitle: 'Avela Sandbox',
      projectUrl: 'https://chatgpt.com/g/g-p-sandbox456-avela-sandbox/project',
    }]);
    expect(() => control.bootstrapProjectUrl(task.taskId)).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_AMBIGUOUS');
    supervisorStore.close();
  });

  test('carries only typed autonomous turn context without constraining execution scope', () => {
    const task = {
      taskId: 'task-minimal-continuation',
      conversationId: '11111111-2222-3333-4444-555555555555',
      conversationUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
      objective: 'A deliberately distinctive durable objective.',
      completionContract: { requirement_id: 'REQ-minimal-continuation', repo_id: 'repo-minimal-continuation', checkout_id: 'checkout_ios_candidate' },
      continuationPolicy: {},
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const lowerLayerContext = 'controller_authority_id=opaque-previous-turn-token';
    const continuation = renderSupervisorPrompt(task, 'fx_minimal01', 'continuation', 'large checkpoint payload', undefined, lowerLayerContext, 'Relevant prior cognition.');
    expect(continuation).toStartWith('@forge\n<<<FORGE_WORKFLOW_EFFECT_V1:fx_minimal01>>>\n');
    expect(parseSupervisorTurn(continuation)).toEqual({
      schema_version: 2,
      identity: {
        task_id: task.taskId,
        effect_id: 'fx_minimal01',
        kind: 'continuation',
      },
      goal: {
        role: 'outcome',
        objective: task.objective,
      },
      continuity: {
        role: 'advisory',
        summary: 'large checkpoint payload',
      },
      repository: { repo_id: 'repo-minimal-continuation', checkout_id: 'checkout_ios_candidate' },
      cognition: { role: 'advisory', projection: 'Relevant prior cognition.' },
      automation: {
        automation_task_id: task.taskId,
        automation_type: 'autonomous_continuation',
        intermediate_status: 'working',
        final_statuses: ['continue', 'done', 'needs_user'],
      },
    });
    expect(continuation).not.toContain('继续当前 Supervisor 任务。');
    expect(continuation).not.toContain('目标：');
    expect(continuation).not.toContain('模型自行判断');
    expect(continuation).not.toContain('本提示不新增');
    expect(continuation).not.toContain('REQ-minimal-continuation');
    expect(continuation).not.toContain(lowerLayerContext);
    expect(continuation).not.toContain('"steps"');
    expect(continuation).not.toContain('"scope"');
    expect(continuation).not.toContain('"allowed_paths"');
    expect(continuation).not.toContain('"next_action"');

    const recovery = renderSupervisorPrompt(task, 'fx_recover01', 'recovery', 'restore checkpoint', 'recover durable state', lowerLayerContext);
    expect(parseSupervisorTurn(recovery)).toMatchObject({
      identity: { kind: 'recovery' },
      goal: { role: 'outcome', objective: task.objective },
      continuity: { role: 'advisory', summary: 'restore checkpoint\nrecover durable state' },
    });
    expect(recovery).toContain('FORGE_AUTONOMOUS_RECEIPT_V1');
    expect(recovery).toContain('automation_status=working');
    expect(recovery).toContain('automation_status=continue');
    expect(recovery).toContain('Do not report continue for a status-only or empty round.');
    expect(recovery).not.toContain(lowerLayerContext);

    const correction = renderSupervisorPrompt(task, 'fx_correct01', 'correction', 'ignored checkpoint', 'ignored correction', lowerLayerContext);
    expect(parseSupervisorTurn(correction)).toMatchObject({
      identity: { kind: 'correction' },
      goal: { role: 'outcome', objective: task.objective },
      continuity: { role: 'advisory', summary: 'ignored checkpoint\nignored correction' },
    });

    const enrollment = renderSupervisorPrompt(task, 'fx_1234567890abcdef', 'enrollment');
    expect(parseSupervisorTurn(enrollment)).toMatchObject({
      identity: { kind: 'enrollment' },
      goal: { role: 'outcome', objective: task.objective },
    });
    expect(parseSupervisorTurn(enrollment).continuity).toBeUndefined();
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

    expect(parseSupervisorTurn(prompt).automation).toEqual({
      automation_task_id: task.taskId,
      automation_type: 'autonomous_continuation',
      intermediate_status: 'working',
      final_statuses: ['continue', 'done', 'needs_user'],
    });
    expect(prompt).toContain('FORGE_AUTONOMOUS_RECEIPT_V1');
    expect(prompt).not.toContain('automation.receipt:');
    expect(prompt).not.toContain('最后一次 Forge 调用');
    expect(prompt).not.toContain(renderSupervisorReceipt(task, effectId, 'CONTINUE'));
    expect(prompt).not.toContain(SUPERVISOR_BLOCK_START);
    expect(prompt).not.toContain(LEGACY_SUPERVISOR_BLOCK_START);
    expect(prompt).not.toContain('conversation_id=');
    expect(prompt).not.toContain('\ntask_id=');
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

  test('keeps every Supervisor prompt on the reusable start or continuation template', () => {
    const task = {
      taskId: 'task-minimal-continuation',
      conversationId: '12121212-3434-5656-7878-909090909090',
      conversationUrl: 'https://chatgpt.com/c/12121212-3434-5656-7878-909090909090',
      objective: 'OBJECTIVE_SENTINEL durable goal.',
      completionContract: { requirement_id: 'REQ-minimal-prompt' },
      continuationPolicy: {},
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const continuation = renderSupervisorPrompt(task, 'fx_continue_1234', 'continuation', 'checkpoint-sentinel', undefined, 'LOWER_LAYER_SENTINEL');
    expect(parseSupervisorTurn(continuation)).toMatchObject({
      schema_version: 2,
      identity: { task_id: task.taskId, effect_id: 'fx_continue_1234', kind: 'continuation' },
      goal: { role: 'outcome', objective: task.objective },
      continuity: { role: 'advisory', summary: 'checkpoint-sentinel' },
      automation: { automation_type: 'autonomous_continuation' },
    });
    expect(continuation).not.toContain('automation.receipt:');
    expect(continuation).not.toContain(renderSupervisorReceipt(task, 'fx_continue_1234', 'CONTINUE'));
    expect(continuation).not.toContain('LOWER_LAYER_SENTINEL');
    expect(continuation).not.toContain('REQ-minimal-prompt');

    const recovery = renderSupervisorPrompt(task, 'fx_recovery_1234', 'recovery', 'checkpoint-sentinel', 'recover causally', 'LOWER_LAYER_SENTINEL');
    expect(parseSupervisorTurn(recovery)).toMatchObject({
      identity: { kind: 'recovery' },
      goal: { role: 'outcome', objective: task.objective },
      continuity: { role: 'advisory', summary: 'checkpoint-sentinel\nrecover causally' },
    });
    expect(recovery).toContain('recover causally');
    expect(recovery).not.toContain('LOWER_LAYER_SENTINEL');
    const longRecovery = renderSupervisorPrompt(task, 'fx_recovery_long', 'recovery', 'checkpoint.'.repeat(250), 'preserve non-replay cause', 'LOWER_LAYER_SENTINEL');
    const bounded = parseSupervisorTurn(longRecovery).continuity?.summary;
    expect(bounded?.length).toBeLessThanOrEqual(2_000);
    expect(bounded).toContain('preserve non-replay cause');
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
      constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
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

    const identity = {
      controllerId: 'lineage-controller', controllerType: 'chatgpt' as const,
      principalId: 'lineage-principal', controllerInstanceId: 'lineage-runtime',
    };
    const predecessorRelay = beginInitialControllerRoundDispatch(fx.store, {
      workId: predecessorWorkId, requirementId, identity: { ...identity, sessionId: 'lineage-predecessor' },
    });
    const successorRelay = beginInitialControllerRoundDispatch({ ...fx.store, now: () => new Date(Date.now() + 1_000).toISOString() }, {
      workId: successorWorkId, requirementId, identity: { ...identity, sessionId: 'lineage-successor' },
    });
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.originWorkId).toBe(successorWorkId);
    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'lineage-supervisor'));
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const task = control.registerTask({
      taskId: `forge:${fx.repository.repoId}:work:${predecessorWorkId}`,
      conversationId: inherited!.conversationId, conversationUrl: inherited!.conversationUrl,
      objective: 'Keep exact effect provenance across a successor carrier.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: predecessorWorkId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' }, userBlockerPolicy: {},
    });
    const enrollment = control.reserveEnrollment(task.taskId, controllerRoundProviderEffectId(predecessorRelay));
    control.browserObserveEffect({
      conversationId: task.conversationId, conversationUrl: task.conversationUrl,
      effectId: enrollment.effectId, observationId: 'lineage-predecessor-applied', outcome: 'applied',
    });
    expect(getControllerRoundRelay(fx.store, predecessorWorkId)?.status).toBe('dispatched');
    expect(getControllerRoundRelay(fx.store, successorWorkId)).toEqual(successorRelay);
    supervisorStore.close();
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

  test('prefers the fresh ChatGPT extension current observation over a conflicting native foreground observation', () => {
    const discovery = new WorkflowSupervisorEphemeralDiscovery();
    const extensionId = '11111111-2222-4333-8444-555555555555';
    const nativeId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    discovery.update([
      { conversation_id: extensionId, canonical_url: `https://chatgpt.com/c/${extensionId}`, title: 'ChatGPT turn', is_current: true },
    ], 'chrome-extension');
    discovery.update([
      { conversation_id: nativeId, canonical_url: `https://chatgpt.com/c/${nativeId}`, title: 'System foreground', is_current: true },
    ], 'native-browser');

    expect(discovery.currentConversation()).toEqual({
      conversationId: extensionId,
      canonicalUrl: `https://chatgpt.com/c/${extensionId}`,
      title: 'ChatGPT turn',
    });

    discovery.update([
      { conversation_id: extensionId, canonical_url: `https://chatgpt.com/c/${extensionId}`, title: 'ChatGPT turn' },
    ], 'chrome-extension');
    expect(discovery.currentConversation()).toEqual({
      conversationId: nativeId,
      canonicalUrl: `https://chatgpt.com/c/${nativeId}`,
      title: 'System foreground',
    });
  });

  test('reuses an exact durable Work conversation when no foreground browser current is observable', async () => {
    const fx = fixture();
    const boundWorkId = 'work-supervisor-existing-exact-binding';
    const unboundWorkId = 'work-supervisor-first-binding-still-requires-current';
    const create = (workId: string) => createWorkContract(fx.store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      objective: `Exercise current-conversation binding for ${workId}.`,
      acceptanceCriteria: ['durable exact binding survives missing foreground observation'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
    });
    create(boundWorkId);
    create(unboundWorkId);
    const conversationId = '34343434-5656-7878-9090-121212121212';
    const existing = bindChatgptWorkConversation(fx.store, {
      workId: boundWorkId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    });

    const supervisorRoot = join(fx.controllerHome, 'supervisor');
    mkdirSync(supervisorRoot, { recursive: true });
    const supervisorStore = new WorkflowSupervisorStore(supervisorRoot);
    const control = new WorkflowSupervisorControlPlane(supervisorStore);
    const server = createWorkflowSupervisorServer({
      controlPlane: control,
      socketPath: join(supervisorRoot, 'supervisor.sock'),
      discovery: new WorkflowSupervisorEphemeralDiscovery(),
      browserAdapterEnabled: true,
    });
    await new Promise<void>((resolve, reject) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    try {
      expect(await bindCurrentWorkflowSupervisorConversationForWork(fx.store, boundWorkId)).toEqual({
        status: 'bound',
        binding: existing,
      });
      expect(await bindCurrentWorkflowSupervisorConversationForWork(fx.store, unboundWorkId)).toEqual({
        status: 'current_conversation_unbound',
        reason: 'WORKFLOW_SUPERVISOR_CURRENT_CONVERSATION_UNBOUND',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      supervisorStore.close();
    }
  });

  test('reuses enrolled exact Supervisor authority without requiring another ControllerRound', async () => {
    const fx = fixture();
    const workId = 'work-supervisor-existing-authority-no-round';
    const conversationId = '45454545-6767-8989-1010-232323232323';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    createWorkContract(fx.store, {
      workId,
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      objective: 'Continue an already-enrolled exact conversation after lower ControllerRound state is gone.',
      acceptanceCriteria: ['Supervisor remains the outer-turn authority after enrollment'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
    });
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl });
    expect(workflowSupervisorLowerLayerReadyForWork(fx.store, workId)).toEqual({
      ready: false,
      reason: 'CONTROLLER_ROUND_NOT_PREPARED',
    });

    const supervisorRoot = join(fx.controllerHome, 'supervisor');
    mkdirSync(supervisorRoot, { recursive: true });
    const supervisorStore = new WorkflowSupervisorStore(supervisorRoot);
    const control = new WorkflowSupervisorControlPlane(supervisorStore);
    const taskId = `forge:${fx.repository.repoId}:conversation:${conversationId}`;
    control.registerTask({
      taskId,
      conversationId,
      conversationUrl,
      objective: 'Continue the exact enrolled conversation.',
      completionContract: { kind: 'forge_work_done', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', exact_conversation_id: conversationId, exact_conversation_url: conversationUrl, outer_turn_owner: 'workflow_supervisor' },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId },
    });
    const enrollment = control.reserveEnrollment(taskId);
    const server = createWorkflowSupervisorServer({
      controlPlane: control,
      socketPath: join(supervisorRoot, 'supervisor.sock'),
      discovery: new WorkflowSupervisorEphemeralDiscovery(),
      browserAdapterEnabled: true,
    });
    await new Promise<void>((resolve, reject) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    try {
      expect(await ensureWorkflowSupervisorEnrollmentForWork(fx.store, workId)).toEqual({
        status: 'enrolled',
        taskId,
        effectId: enrollment.effectId,
      });
      expect(workflowSupervisorLowerLayerReadyForWork(fx.store, workId)).toEqual({
        ready: false,
        reason: 'CONTROLLER_ROUND_NOT_PREPARED',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      supervisorStore.close();
    }
  });

  test('reconciles a registered non-terminal task that crashed before enrollment reservation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-missing-enrollment-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor'));
    try {
      const control = new WorkflowSupervisorControlPlane(store);
      const conversationId = '56565656-7878-9090-1212-343434343434';
      const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
      const task = control.registerTask({
        taskId: 'supervisor:missing-enrollment',
        conversationId,
        conversationUrl,
        objective: 'Recover the registration-to-enrollment crash boundary.',
        completionContract: {},
        continuationPolicy: { kind: 'standalone_supervisor' },
        userBlockerPolicy: {},
      });
      expect(store.currentUnappliedEffect(task.taskId)).toBeUndefined();
      expect(control.browserTasks()).toEqual([]);

      expect(await control.reconcileCommittedContinuations()).toEqual({ scanned: 1, reconciled: 1 });
      const enrollment = store.getEffectByOriginKey(`enrollment:${task.taskId}`);
      expect(enrollment).toMatchObject({ taskId: task.taskId, kind: 'enrollment' });
      expect(control.browserTasks()).toEqual([{ taskId: task.taskId, conversationId, conversationUrl }]);
      expect(await control.reconcileCommittedContinuations()).toEqual({ scanned: 0, reconciled: 0 });
    } finally {
      store.close();
    }
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
    const secondResult = store.commitCompletion(secondCompletion, { effectId: 'fx_33333333333333333333333333333333', kind: 'continuation', prompt: 'round three' });
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore })).toMatchObject({
      taskId, conversationId, activeReleaseId: releaseId,
      actions: ['CONTINUE', 'CONTINUE'],
      runtimeInstanceIds: ['runtime-a', 'runtime-b'],
    });
    const third = secondResult.successorEffect!;
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
      actions: ['CONTINUE', 'CONTINUE'],
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
      constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
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
      allowedPaths: [], forbiddenPaths: [], checks: [], constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
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
      constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
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
      status: 'blocked', repeatedStateCount: blocked.repeatedStateCount, roundCount: blocked.roundCount,
      authorityId: blocked.authorityId,
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
      constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
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

    // Successive outer turns of one task are spaced, so this test advances the
    // store clock past the minimum interval instead of asserting instant
    // deliverability of a just-authorized continuation.
    let storeClockMs = Date.now() + 10 * 60_000;
    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'round-budget-reconcile-supervisor'), { now: () => storeClockMs });
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

    // Recover a completion persisted by a previous Runtime without a successor.
    // Reconciliation must not reuse the already-applied source id.
    expect(await control.reconcileCommittedContinuations()).toEqual({ scanned: 1, reconciled: 1 });
    const successor = supervisorStore.getEffectByOriginKey(`completion:${completion.completionFingerprint}`);
    expect(successor).toBeDefined();
    const relay = getRequirementControllerRoundRelay(fx.store, requirementId);
    expect(relay).toMatchObject({
      status: 'blocked', roundCount: blocked.roundCount, maxRounds: blocked.maxRounds,
      authorityId: blocked.authorityId,
    });
    expect(successor?.effectId).not.toBe(enrollment.effectId);
    expect((await control.reconcileCommittedContinuations())).toEqual({ scanned: 0, reconciled: 0 });
    // Repeated real tool receipts must keep advancing past the lower budget.
    // Every completion owns one successor; lower authority/history stay fixed.
    let currentEffect = successor!;
    for (let turn = 0; turn < 12; turn += 1) {
      storeClockMs += 4 * 60_000;
      expect(control.browserPoll({ conversationId, conversationUrl }).command?.effectId).toBe(currentEffect.effectId);
      control.browserObserveEffect({
        conversationId, conversationUrl, effectId: currentEffect.effectId,
        observationId: `budget-turn-${turn}`, outcome: 'applied',
      });
      const continued = await control.observeAutomationReceipt({
        taskId, conversationId, status: 'continue', receiptId: `rh_work:continue:${taskId}`,
      });
      expect('successorEffect' in continued ? continued.successorEffect : undefined).toBeDefined();
      const replayed = await control.observeAutomationReceipt({
        taskId, conversationId, status: 'continue', receiptId: `rh_work:continue:${taskId}`,
      });
      expect('successorEffect' in replayed ? replayed.successorEffect?.effectId : undefined)
        .toBe('successorEffect' in continued ? continued.successorEffect?.effectId : undefined);
      currentEffect = 'successorEffect' in continued ? continued.successorEffect! : currentEffect;
      expect(getRequirementControllerRoundRelay(fx.store, requirementId)).toEqual(relay);
      expect(getControllerSession(fx.store, workId)).toBeUndefined();
    }
    supervisorStore.close();
  });

  test('reserves a committed CONTINUE without manufacturing a lower Controller claim or round', async () => {
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
      constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
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
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.status).toBe('dispatched');
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.authorityId).toBe(initial.authorityId);
    expect(await control.reconcileCommittedContinuations()).toEqual({ scanned: 0, reconciled: 0 });
    supervisorStore.close();
  });

  test('retires a predecessor browser task after the Work CAS-rebinds to a fresh conversation', async () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-conversation-rebind';
    const workId = 'work-supervisor-conversation-rebind';
    const oldConversationId = '11111111-aaaa-bbbb-cccc-222222222222';
    const newConversationId = '33333333-dddd-eeee-ffff-444444444444';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor rebind', outcomeStatement: 'Only the current exact Work conversation owns browser delivery.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Move autonomous execution onto a fresh conversation without retaining the predecessor writer.',
      acceptanceCriteria: ['old conversation becomes browser-inactive after rebind'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
    });
    beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
    });
    const supervisorStore = new WorkflowSupervisorStore(join(fx.root, 'supervisor-home'));
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const oldTaskId = `forge:${fx.repository.repoId}:conversation:${oldConversationId}`;
    control.registerTask({
      taskId: oldTaskId, conversationId: oldConversationId, conversationUrl: `https://chatgpt.com/c/${oldConversationId}`, objective: 'Old execution conversation.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId, requirement_id: requirementId },
    });
    const oldEnrollment = control.reserveEnrollment(oldTaskId);
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl: `https://chatgpt.com/c/${oldConversationId}` });
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
    // A command selected before the rebind cannot start after it.
    expect(() => control.browserBeginEffect({
      conversationId: oldConversationId, conversationUrl: `https://chatgpt.com/c/${oldConversationId}`,
      effectId: oldEnrollment.effectId, dispatchId: 'stale-rebound-send', dispatchGeneration: 1,
      evidence: { latest_user_text: '', latest_assistant_response: '' },
    })).toThrow('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
    expect(supervisorStore.latestEffectDispatch(oldEnrollment.effectId)).toBeUndefined();
    // A send committed before the rebind still has a reconciliation obligation.
    supervisorStore.recordEffectDispatchStarted(oldEnrollment.effectId, 1, 'pre-rebind-send');
    expect(control.browserTasks()).toHaveLength(1);
    expect(control.browserPoll({ conversationId: oldConversationId, conversationUrl: `https://chatgpt.com/c/${oldConversationId}` }).command?.mode).toBe('reconcile');
    supervisorStore.close();
  });

  test('keeps the enrolled Goal alive across Work cancellation without pretending the relay completed', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-terminal-reconcile';
    const workId = 'work-supervisor-terminal-reconcile';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor cancellation boundary', outcomeStatement: 'Keep the original Goal independent from a cancelled Work carrier.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Work cancellation is not Goal cancellation or provider completion.',
      acceptanceCriteria: ['only Goal cancellation revokes the original prompt chain'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
    });
    beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
    });
    const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(join(fx.root, 'supervisor-home')), {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl: `https://chatgpt.com/c/${conversationId}` });
    const taskId = `forge:${fx.repository.repoId}:requirement:${requirementId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`, objective: 'Continue the original Goal across Work turnover.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
    });
    control.reserveEnrollment(taskId);
    expect(control.browserTasks()).toHaveLength(1);
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.status).toBe('dispatching');

    reviseWorkSemanticContext(fx.store, workId, { expectedRevision: 1, state: 'cancelled' });
    expect(control.browserTasks()).toHaveLength(1);
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)).toMatchObject({ status: 'dispatching', originWorkId: workId });
    expect(control.browserPoll({ conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}` }).command?.mode).toBe('send');
    updateRequirement({ controllerHome: fx.controllerHome }, {
      requirementId, action: 'explicit_goal_cancellation', mutate: current => ({ ...current, state: 'cancelled' }),
    });
    expect(control.browserTasks()).toEqual([]);
    expect(() => control.browserPoll({ conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}` }))
      .toThrow('WORKFLOW_SUPERVISOR_BROWSER_TASK_INACTIVE');
    expect(getRequirementControllerRoundRelay(fx.store, requirementId)?.status).toBe('dispatching');
    control.store.close();
  });

  test('Work completion does not terminalize an enrolled original Goal', () => {
    const fx = fixture();
    const requirementId = 'REQ-supervisor-completed-reconcile';
    const workId = 'work-supervisor-completed-reconcile';
    createRequirement({ controllerHome: fx.controllerHome }, { requirementId, title: 'Supervisor completed Work boundary', outcomeStatement: 'Original Goal may outlive a completed Work carrier.' });
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId, requirementId, objective: 'Complete the original Goal independently from this Work carrier.',
      acceptanceCriteria: ['Work completion never fabricates Supervisor terminality'], allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', workKind: 'completed_no_change', dispatchState: 'running',
    });
    beginInitialControllerRoundDispatch(fx.store, {
      workId, requirementId, identity: { controllerId: 'chatgpt-supervisor-test', controllerType: 'chatgpt', principalId: 'chatgpt-supervisor-test', controllerInstanceId: 'runtime-supervisor-test', sessionId: 'session-supervisor-test' },
    });
    const control = new WorkflowSupervisorControlPlane(new WorkflowSupervisorStore(join(fx.root, 'supervisor-home')), {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    const conversationId = 'cdcdcdcd-abab-efef-3434-121212121212';
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl: `https://chatgpt.com/c/${conversationId}` });
    const taskId = `forge:${fx.repository.repoId}:requirement:${requirementId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`, objective: 'Preserve original Goal ownership.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, requirement_id: requirementId },
    });
    control.reserveEnrollment(taskId);
    expect(control.browserTasks()).toHaveLength(1);

    reviseWorkSemanticContext(fx.store, workId, { expectedRevision: 1, state: 'completed' });
    expect(control.browserTasks()).toHaveLength(1);
    expect(control.browserPoll({ conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}` }).command?.mode).toBe('send');
    control.stopTask(taskId);
    expect(control.browserTasks()).toEqual([]);
    control.store.close();
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

test('native consumer status exposes and clears a pre-dispatch due-effect transport blocker without changing effect authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-consumer-status-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'consumer-status-task';
  const conversationId = '43434343-5656-7878-9090-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Expose native consumer liveness without becoming effect authority.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);

  let inventoryUnavailable = true;
  let owner = '';
  let createCalls = 0;
  const page: TestBrowserPage = {
    evaluate: async () => undefined as never,
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'consumer-window', tabId: 'consumer-tab' }),
  };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [], unavailableProducts: inventoryUnavailable ? ['chrome'] : [] }),
    reattach: async () => page,
    create: async (url) => { expect(url).toBe(conversationUrl); createCalls += 1; return page; },
    close: async () => undefined,
    readOwner: async () => owner,
    writeOwner: async (_page, marker) => { owner = marker; },
    snapshot: async () => ({
      url: conversationUrl, title: 'Consumer status', latestUserText: '', latestAssistantResponse: '',
      composerText: '', isGenerating: false, providerActivityText: '', providerFailureText: '',
    }),
    dispatchPrompt: async () => ({ dispatched: false, reason: 'test_pre_send_rejection' }),
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort,
    nowMs: () => clock.nowMs,
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onError: () => undefined,
  });

  await adapter.runOnce();
  expect(adapter.status()).toMatchObject({
    enabled: true,
    running: false,
    transportFailureStreak: 1,
    stalled: false,
    dueCommand: {
      taskId,
      conversationId,
      effectId: effect.effectId,
      mode: 'send',
      kind: 'enrollment',
    },
    lastFailure: {
      code: 'WORKFLOW_SUPERVISOR_NATIVE_INVENTORY_INCOMPLETE',
      taskId,
      effectId: effect.effectId,
    },
  });
  expect(adapter.status().lastTickStartedAt).toBeDefined();
  expect(adapter.status().lastTickCompletedAt).toBeDefined();
  expect(store.nextBrowserEffect(taskId)).toEqual(expect.objectContaining({ mode: 'send', generation: 1 }));

  inventoryUnavailable = false;
  clock.nowMs += 1_000;
  await adapter.runOnce();
  const recovered = adapter.status();
  expect(createCalls).toBe(1);
  expect(recovered.transportFailureStreak).toBe(0);
  expect(recovered.lastFailure).toBeUndefined();
  expect(recovered.lastCommandAttemptAt).toBeDefined();
  // Provider dispatch rejection remains owned by the existing durable effect ledger;
  // the consumer projection neither replays nor marks the effect applied itself.
  expect(store.nextBrowserEffect(taskId)?.mode).not.toBe('reconcile');
});

test('native Apple Events timeout and lock contention use existing task-local spacing', () => {
  expect(TASK_TARGET_SPACED_FAILURE_CODES.has('BROWSER_AUTOMATION_TIMEOUT')).toBe(true);
  expect(TASK_TARGET_SPACED_FAILURE_CODES.has('BROWSER_AUTOMATION_SERIALIZATION_BUSY')).toBe(true);
  expect(TASK_TARGET_SPACED_FAILURE_CODES.has('PLUGIN_BROWSER_NATIVE_OPERATION_FAILED')).toBe(false);
});

test('task-local exact-target failure does not back off or starve an independent Supervisor task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-task-transport-isolation-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const badConversationId = '11111111-aaaa-2222-bbbb-333333333333';
  const goodConversationId = '44444444-cccc-5555-dddd-666666666666';
  const badConversationUrl = `https://chatgpt.com/c/${badConversationId}`;
  const goodConversationUrl = `https://chatgpt.com/c/${goodConversationId}`;
  control.registerTask({
    taskId: 'a-bad-target-task', conversationId: badConversationId, conversationUrl: badConversationUrl,
    objective: 'Remain isolated when exact target proof is ambiguous.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const badEffect = control.reserveEnrollment('a-bad-target-task');
  control.registerTask({
    taskId: 'b-good-target-task', conversationId: goodConversationId, conversationUrl: goodConversationUrl,
    objective: 'Continue even while a sibling exact target is unavailable.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  control.reserveEnrollment('b-good-target-task');

  const page = (windowId: string, tabId: string): TestBrowserPage => ({
    evaluate: async () => undefined as never,
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId, tabId }),
  });
  const badPage1 = page('bad-window-1', 'bad-tab-1');
  const badPage2 = page('bad-window-2', 'bad-tab-2');
  const goodPage = page('good-window', 'good-tab');
  const pages = new Map([
    ['bad-tab-1', badPage1], ['bad-tab-2', badPage2], ['good-tab', goodPage],
  ]);
  let goodDispatchCalls = 0;
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [
      { windowId: 'bad-window-1', tabId: 'bad-tab-1', active: false, url: badConversationUrl, title: 'bad duplicate 1' },
      { windowId: 'bad-window-2', tabId: 'bad-tab-2', active: false, url: badConversationUrl, title: 'bad duplicate 2' },
      { windowId: 'good-window', tabId: 'good-tab', active: false, url: goodConversationUrl, title: 'good exact target' },
    ] }),
    reattach: async (ref) => pages.get(ref.tabId)!,
    create: async () => { throw new Error('no new tab should be created'); },
    close: async () => undefined,
    snapshot: async (current) => ({
      url: current === goodPage ? goodConversationUrl : badConversationUrl,
      title: current === goodPage ? 'good exact target' : 'bad duplicate',
      latestUserText: '', latestAssistantResponse: '', composerText: '', isGenerating: false,
      providerActivityText: '', providerFailureText: '',
    }),
    dispatchPrompt: async (current) => {
      if (current === goodPage) goodDispatchCalls += 1;
      return { dispatched: false, reason: 'test_pre_send_rejection' };
    },
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort,
    nowMs: () => clock.nowMs,
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onError: () => undefined,
  });

  await adapter.runOnce();
  expect(goodDispatchCalls).toBe(1);
  expect(adapter.status()).toMatchObject({
    transportFailureStreak: 0,
    lastFailure: {
      code: 'COMPUTER_CHATGPT_EXACT_TARGET_UNPROVEN',
      taskId: 'a-bad-target-task',
      effectId: badEffect.effectId,
    },
  });
  expect(store.nextBrowserEffect('a-bad-target-task')).toEqual(expect.objectContaining({ mode: 'send', generation: 1 }));
});

test('enrolled reconciliation reopens only its exact conversation and never repeats an ambiguous submission', async () => {
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
    objective: 'Reconcile the same durable conversation with disposable browser resources.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  expect(control.browserPoll({ conversationId, conversationUrl }).command?.mode).toBe('send');

  let createCalls = 0;
  let closeCalls = 0;
  let inventoryUnavailable = true;
  let tabPresent = false;
  let owner = '';
  let composerText = '';
  let submittedText = '';
  let snapshotCalls = 0;
  let conversationLoaded = false;
  setMacOsBrowserRuntimeHooksForTest({
    platform: 'darwin', appExists: () => true,
    processRunning: async () => {
      if (inventoryUnavailable) throw new Error('process inventory unavailable');
      return false;
    },
  });
  const page: TestBrowserPage = {
    evaluate: async () => { throw new Error('reconciliation must not click provider controls'); },
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'reconcile-window', tabId: 'reconcile-tab' }),
  };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({
      entries: tabPresent ? [{ windowId: 'reconcile-window', tabId: 'reconcile-tab', active: false, url: conversationUrl, title: 'Existing conversation', browserProduct: 'chrome' }] : [],
      unavailableProducts: inventoryUnavailable ? ['chrome'] : [],
    }),
    reattach: async () => page,
    create: async (url) => { expect(url).toBe(conversationUrl); createCalls += 1; tabPresent = true; return page; },
    close: async () => { closeCalls += 1; tabPresent = false; },
    readOwner: async () => owner,
    writeOwner: async (_page, marker) => { owner = marker; },
    snapshot: async () => {
      snapshotCalls += 1;
      return {
        url: conversationUrl, title: 'Existing conversation',
        latestUserText: submittedText, latestAssistantResponse: '',
        ...(conversationLoaded ? { composerText } : {}), isGenerating: false, providerActivityText: '', providerFailureText: '',
      };
    },
    dispatchPrompt: async () => { throw new Error('unexpected dispatch'); },
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort,
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
  inventoryUnavailable = false;
  expect(control.browserPoll({ conversationId, conversationUrl }).command?.mode).toBe('reconcile');
  await adapter.runOnce();

  expect(adapter.status().lastFailure?.code).toBe('COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE');
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(1);
  expect(store.effectApplied(effect.effectId)).toBe(false);
  conversationLoaded = true;
  clock.nowMs += 30_000;
  await adapter.runOnce();
  // Event timestamps use wall time; align the injected eligibility clock with
  // the just-recorded observation before exercising its cooldown.
  clock.nowMs = Date.now();

  expect(createCalls).toBe(1);
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  // Computer keeps the semantic target and provider binding stable while the
  // task is still active. Reconciliation re-observes the same target instead
  // of closing and manufacturing replacement tabs.
  expect(closeCalls).toBe(0);
  expect(tabPresent).toBe(true);
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  // A second bounded reconciliation observation enters the existing unknown
  // backoff; the Computer target stays attached instead of being retired.
  await adapter.runOnce();
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();

  // An empty composer or retained draft never authorizes another click in this
  // generation or a new generation.
  // A tick during observation spacing must also keep the exact attachment:
  // closing it here reloads provider history on every subsequent observation.
  await adapter.runOnce();
  expect(closeCalls).toBe(0);
  expect(createCalls).toBe(1);
  expect(tabPresent).toBe(true);
  for (const draft of ['', effect.prompt]) {
    composerText = draft;
    clock.nowMs += 60_000;
    await adapter.runOnce();
    expect(store.effectDispatchBudget(effect.effectId).generations).toBe(1);
    expect(store.effectApplied(effect.effectId)).toBe(false);
  }
  expect(snapshotCalls).toBeGreaterThan(0);
  submittedText = effect.prompt;
  clock.nowMs += 60_000;
  await adapter.runOnce();
  expect(store.effectApplied(effect.effectId)).toBe(true);
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(1);
  expect(createCalls).toBe(1);
  expect(closeCalls).toBe(0);
  expect(tabPresent).toBe(true);
  await adapter.close();
  store.close();
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
  const page: TestBrowserPage = {
    evaluate: async <T>() => false as T,
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'window-bootstrap', tabId: 'tab-bootstrap' }),
  };
  let canonical = false;
  let sentPrompt = '';
  let dispatchCount = 0;
  let closeCount = 0;
  const targetPort = createTestChatgptTargetPort({
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
    dispatchPrompt: async (_page, prompt) => { sentPrompt = prompt; dispatchCount += 1; return { dispatched: true, confirmed: true }; },
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort,
    nowMs: () => clock.nowMs,
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onError: (error) => { throw error; },
  });

  // A reused Project bootstrap tab that already shows a /c/<id> is NOT a
  // fresh conversation. Reject before external mutation and preserve effect 1.
  canonical = true;
  await adapter.runOnce();
  expect(dispatchCount).toBe(0);
  expect(store.latestEffectDispatch(effect.effectId)).toBeUndefined();
  expect(control.getTask(taskId)?.conversationId).toBe(`bootstrap:${taskId}`);
  expect(closeCount).toBe(1);

  canonical = false;
  clock.nowMs += 30_000;
  await adapter.runOnce();
  // After send, preserve the exact source effect in reconciliation mode.
  // No additional message may be dispatched while its outcome is unknown.
  expect(store.nextBrowserEffect(taskId)).toMatchObject({ mode: 'reconcile' });
  expect(dispatchCount).toBe(1);

  canonical = true;
  clock.nowMs += 10_000;
  await adapter.runOnce();

  expect(control.getTask(taskId)).toEqual(expect.objectContaining({ conversationId, conversationUrl }));
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(store.latestEffectDispatch(effect.effectId)?.generation).toBe(1);
  expect(dispatchCount).toBe(1);
  expect(closeCount).toBe(1);
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
    constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
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

test('completed idle provider turn remains a receipt obligation, not a reason to inject another prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-idle-receipt-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-idle-awaiting-receipt';
  const conversationId = '78787878-5656-3434-1212-909090909090';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId, conversationId, conversationUrl, objective: 'Do real work and settle exactly one receipt.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const applied = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: applied.effectId, observationId: 'idle-receipt-applied', outcome: 'applied' });
  const recoveryEffectId = 'fx_90909090909090909090909090909999';
  const sample = {
    taskId, effectId: applied.effectId, generating: false,
    assistantDigest: 'finished-response-without-receipt', graceMs: 1_000,
    recovery: { effectId: recoveryEffectId, prompt: 'must-not-replay-idle' },
  };
  expect(store.observeProviderTurn({ ...sample, observedAtMs: 1_000 }).state).toBe('idle_pending');
  expect(store.observeProviderTurn({ ...sample, observedAtMs: 30_000 }).state).toBe('idle_pending');
  expect(control.taskStall(taskId)).toMatchObject({
    state: 'spaced', effectId: applied.effectId, reason: 'awaiting_completion_receipt',
  });
  expect(store.getEffect(recoveryEffectId)).toBeUndefined();
  const settled = await control.observeAutomationReceipt({
    taskId, conversationId, status: 'continue', receiptId: 'idle-receipt-final-call',
  });
  expect(settled).toMatchObject({ action: 'CONTINUE', terminal: false });
  expect(store.getLatestCompletion(taskId)?.sourceEffectId).toBe(applied.effectId);
  store.close();
});

test('provider recovery uses the full bounded two-resume budget without replaying the applied source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-browser-exhausted-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-browser-exhausted';
  const conversationId = '34343434-5656-7878-9090-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId, conversationId, conversationUrl, objective: 'Stop only after the bounded provider recovery budget.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const effect = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: effect.effectId, observationId: 'browser-exhausted-applied', outcome: 'applied' });

  const live = { taskId, effectId: effect.effectId, generating: true, assistantDigest: 'waiting-tool', graceMs: 1_000,
    recovery: { effectId: 'fx_34343434343434343434343434343434', prompt: 'recovery-1' } };
  expect(store.observeProviderTurn({ ...live, observedAtMs: 1_000 }).state).toBe('generating');
  expect(store.observeProviderTurn({ ...live, assistantDigest: 'waiting-tool-progress', observedAtMs: 1_500 }).state).toBe('generating');
  expect(store.observeProviderTurn({ ...live, assistantDigest: 'waiting-tool-progress', observedAtMs: 2_501 }).state).toBe('recovery_reserved');
  const firstRecovery = store.observeProviderTurn({ ...live, assistantDigest: 'waiting-tool-progress', observedAtMs: 2_600 }).recoveryEffect!;
  expect(firstRecovery.kind).toBe('recovery');
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toMatchObject({ kind: 'recovery', effectId: firstRecovery.effectId });
  expect(store.providerResumeExhausted(effect.effectId)).toBe(false);

  control.observeEffect({ effectId: firstRecovery.effectId, observationId: 'provider-resume-1-applied', outcome: 'applied' });
  expect(store.observeProviderTurn({
    taskId, effectId: firstRecovery.effectId, generating: true, assistantDigest: 'resume-1-digest', observedAtMs: 3_000, graceMs: 1_000,
    recovery: { effectId: 'fx_78787878787878787878787878787878', prompt: 'recovery-2' },
  }).state).toBe('generating');
  const secondReserved = store.observeProviderTurn({
    taskId, effectId: firstRecovery.effectId, generating: true, assistantDigest: 'resume-1-digest', observedAtMs: 4_001, graceMs: 1_000,
    recovery: { effectId: 'fx_90909090909090909090909090909090', prompt: 'recovery-2' },
  });
  expect(secondReserved.state).toBe('recovery_reserved');
  const secondRecovery = secondReserved.recoveryEffect!;
  expect(secondRecovery.effectId).not.toBe(firstRecovery.effectId);
  expect(store.providerResumeExhausted(firstRecovery.effectId)).toBe(false);
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toMatchObject({ kind: 'recovery', effectId: secondRecovery.effectId });

  control.observeEffect({ effectId: secondRecovery.effectId, observationId: 'provider-resume-2-applied', outcome: 'applied' });
  expect(store.observeProviderTurn({
    taskId, effectId: secondRecovery.effectId, generating: true, assistantDigest: 'resume-2-digest', observedAtMs: 5_000, graceMs: 1_000,
    recovery: { effectId: 'fx_12121212121212121212121212121212', prompt: 'must-not-send' },
  }).state).toBe('generating');
  const exhausted = store.observeProviderTurn({
    taskId, effectId: secondRecovery.effectId, generating: true, assistantDigest: 'resume-2-digest', observedAtMs: 6_001, graceMs: 1_000,
    recovery: { effectId: 'fx_56565656565656565656565656565656', prompt: 'must-not-send' },
  });
  expect(exhausted.state).toBe('exhausted');
  expect(store.providerResumeExhausted(secondRecovery.effectId)).toBe(true);
  expect(control.browserTasks()).toHaveLength(1);
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toBeUndefined();
  expect(control.taskStall(taskId)).toMatchObject({ state: 'provider_resume_exhausted', effectId: secondRecovery.effectId });

  const lateReceipt = renderSupervisorReceipt(control.getTask(taskId)!, secondRecovery.effectId, 'CONTINUE');
  const late = await control.observeAssistantTurn({ taskId, conversationId, responseText: lateReceipt });
  expect(late.action).toBe('CONTINUE');
  expect(late.terminal).toBe(false);
  expect(late.successorEffect).toBeDefined();
  expect(store.getCompletionByResponseSha256(taskId, createHash('sha256').update(lateReceipt).digest('hex'))?.sourceEffectId).toBe(secondRecovery.effectId);
});

test('native adapter interrupts a digest-stalled generating turn only for the exactly-once recovery effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-stalled-generating-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const conversationId = '45454545-5656-7878-9090-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId: 'stalled-generating', conversationId, conversationUrl, objective: 'Resume a stalled provider turn.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const source = control.reserveEnrollment('stalled-generating');
  control.observeEffect({ effectId: source.effectId, observationId: 'stalled-generating-applied', outcome: 'applied' });
  let nowMs = 0;
  const dispatchModes: Array<string | undefined> = [];
  const page: TestBrowserPage = { evaluate: async <T>() => false as T, tabRef: () => ({ windowId: 'window-1', tabId: 'tab-1' }) };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [{ windowId: 'window-1', tabId: 'tab-1', url: conversationUrl, title: 'stalled', active: true }], unavailableProducts: [] }),
    reattach: async () => page, create: async () => page, close: async () => undefined,
    snapshot: async () => ({ url: conversationUrl, title: 'stalled', latestUserText: '', latestAssistantResponse: '', providerActivityText: '', providerFailureText: '', latestTurnRole: 'assistant', isGenerating: true }),
    dispatchPrompt: async (_page, _prompt, options) => { dispatchModes.push(options?.mode); return { dispatched: true, confirmed: true }; },
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort, nowMs: () => nowMs, providerIdleGraceMs: 1_000, providerScopeKey: join(root, 'provider-scope'), sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval: () => undefined, onError: (error) => { throw error; },
  });
  await adapter.runOnce();
  expect(dispatchModes).toEqual([]);
  nowMs = 1_001;
  await adapter.runOnce();
  expect(dispatchModes).toEqual(['recover']);
  expect(store.latestEffectDispatch(source.effectId)?.generation).toBeUndefined();
});

test('429 network evidence is rate-limit authority only when it belongs to the current conversation submit pipeline', () => {
  expect(chatgptFailedRequestIsCausalRateLimit({ method: 'GET', status: 429, url: 'https://chatgpt.com/backend-api/conversations?conversation_origin=tpp' })).toBe(false);
  expect(chatgptFailedRequestIsCausalRateLimit({ method: 'POST', status: 429, url: 'https://chatgpt.com/backend-api/conversation' })).toBe(true);
  expect(chatgptFailedRequestIsCausalRateLimit({ method: 'POST', status: 429, url: 'https://chatgpt.com/backend-api/f/conversation' })).toBe(true);
  expect(chatgptFailedRequestIsCausalRateLimit({ method: 'POST', status: 429, url: 'https://chatgpt.com/backend-api/sentinel/chat-requirements' })).toBe(true);
  expect(chatgptFailedRequestIsCausalRateLimit({ method: 'POST', status: 429, url: 'https://example.com/backend-api/conversation' })).toBe(false);
  expect(chatgptFailedRequestIsCausalRateLimit({ status: 429, url: 'https://chatgpt.com/backend-api/conversation' })).toBe(false);
});

test('Resume stream unavailable uses a bounded same-conversation recovery chain and never replays the applied effect', () => {
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
  expect(chatgptProviderPageFailure('连接已中断，正在等待完整答复')).toBe(CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE);
  expect(chatgptProviderPageFailure('分析已暂停')).toBe(CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE);
  expect(chatgptProviderPageFailure('Analysis paused')).toBe(CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE);
  expect(chatgptProviderPageFailure('已分析\n分析已暂停\n分析已暂停')).toBe(CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE);
  expect(chatgptProviderPageFailure('出了点问题。请重试')).toBe(CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE);
  expect(chatgptProviderPageFailure('你已达到此对话的长度上限，你可以开始新聊天以继续对话。'))
    .toBe('CHATGPT_AUTOMATION_CONVERSATION_LIMIT_REACHED');
  expect(chatgptProviderPageFailure("You've reached the maximum length for this conversation."))
    .toBe('CHATGPT_AUTOMATION_CONVERSATION_LIMIT_REACHED');
  expect(chatgptProviderPageFailure('Earlier the analysis paused; now the model is working.')).toBeUndefined();
  expect(chatgptProviderPageFailure('消息传输超时。请重试。')).toBe('CHATGPT_AUTOMATION_MESSAGE_DELIVERY_TIMED_OUT');
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

  // A provider failure on the first recovery uses the second and final automatic
  // recovery turn. Only a failure on that second recovery exhausts the chain.
  control.observeEffect({ effectId: recovery.effectId, observationId: 'recovery-1-applied', outcome: 'applied' });
  const secondReserved = control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: false, latestAssistantResponse: '',
    providerFailureCode: failureCode!, observedAtMs: 3_000, graceMs: 1_000,
  });
  expect(secondReserved.state).toBe('recovery_reserved');
  const secondRecovery = secondReserved.recoveryEffect!;
  expect(secondRecovery.effectId).not.toBe(recovery.effectId);
  expect(store.providerResumeExhausted(recovery.effectId)).toBe(false);
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toMatchObject({ kind: 'recovery', mode: 'send', effectId: secondRecovery.effectId });
  control.observeEffect({ effectId: secondRecovery.effectId, observationId: 'recovery-2-applied', outcome: 'applied' });
  const exhausted = control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: false, latestAssistantResponse: '',
    providerFailureCode: failureCode!, observedAtMs: 4_000, graceMs: 1_000,
  });
  expect(exhausted.state).toBe('exhausted');
  expect(exhausted.recoveryEffect).toBeUndefined();
  expect(store.providerResumeExhausted(secondRecovery.effectId)).toBe(true);
  const operatorRequest = { taskId, sourceEffectId: secondRecovery.effectId, requestId: 'user-recover-stream', reason: 'User requested recovery after observation repair.' };
  expect(() => control.recoverTask({ ...operatorRequest, reason: '' })).toThrow('WORKFLOW_SUPERVISOR_RECOVERY_REASON_REQUIRED');
  const operatorRecovery = control.recoverTask(operatorRequest).recoveryEffect;
  expect(operatorRecovery.taskId).toBe(taskId);
  expect(operatorRecovery.effectId).not.toBe(recovery.effectId);
  expect(control.recoverTask(operatorRequest).recoveryEffect.effectId).toBe(operatorRecovery.effectId);
  expect(store.providerResumeExhausted(secondRecovery.effectId)).toBe(true);
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toMatchObject({ kind: 'recovery', mode: 'send', effectId: operatorRecovery.effectId });
  store.recordEffectDispatchStarted(operatorRecovery.effectId, 1, 'operator-recovery-send', { surface: 'macos-native' });
  store.recordEffectObservation(operatorRecovery.effectId, 'extension-transport-unknown', 'unknown', { reason: 'The message port closed before a response was received.' });
  expect(() => control.recoverTask({ ...operatorRequest, sourceEffectId: operatorRecovery.effectId })).toThrow('WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN');
  store.recordEffectObservation(operatorRecovery.effectId, 'legacy-owner-no-click', 'unknown', { surface: 'macos-native', reason: 'composer_missing' });
  expect(control.recoverTask({ ...operatorRequest, sourceEffectId: operatorRecovery.effectId }).recoveryEffect.effectId).toBe(operatorRecovery.effectId);
  control.browserObserveDispatchFailure({ conversationId, conversationUrl, effectId: operatorRecovery.effectId, observationId: 'owner-no-click', dispatchGeneration: 1, reason: 'composer_missing' });
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 60_000 })).toMatchObject({ mode: 'send', generation: 2, effect: { effectId: operatorRecovery.effectId } });
  expect(store.effectDispatchBudget(operatorRecovery.effectId).generations).toBe(1);
});

test('public supervisor_task recover routes exhausted provider resume through the canonical single writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-public-recover-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const supervisorRoot = join(controllerHome, 'supervisor');
  mkdirSync(supervisorRoot, { recursive: true });
  const store = new WorkflowSupervisorStore(supervisorRoot);
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-public-provider-recover';
  const conversationId = '34343434-1212-5656-7878-909090909090';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Recover an exhausted provider resume through the public Supervisor facade.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const source = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: source.effectId, observationId: 'public-recover-source-applied', outcome: 'applied' });
  const automatic = store.observeProviderTurn({
    taskId, effectId: source.effectId, generating: false, assistantDigest: '',
    providerFailureCode: CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE,
    observedAtMs: 1_000, graceMs: 1_000,
    recovery: { effectId: 'fx_34343434343434343434343434343434', prompt: 'automatic resume 1' },
  }).recoveryEffect!;
  control.observeEffect({ effectId: automatic.effectId, observationId: 'public-recover-automatic-1-applied', outcome: 'applied' });
  const automaticSecond = store.observeProviderTurn({
    taskId, effectId: automatic.effectId, generating: false, assistantDigest: '',
    providerFailureCode: CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE,
    observedAtMs: 2_000, graceMs: 1_000,
    recovery: { effectId: 'fx_56565656565656565656565656565656', prompt: 'automatic resume 2' },
  }).recoveryEffect!;
  control.observeEffect({ effectId: automaticSecond.effectId, observationId: 'public-recover-automatic-2-applied', outcome: 'applied' });
  expect(store.observeProviderTurn({
    taskId, effectId: automaticSecond.effectId, generating: false, assistantDigest: '',
    providerFailureCode: CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE,
    observedAtMs: 3_000, graceMs: 1_000,
    recovery: { effectId: 'fx_78787878787878787878787878787878', prompt: 'must not recurse' },
  }).state).toBe('exhausted');
  expect(store.providerResumeExhausted(automaticSecond.effectId)).toBe(true);

  const definition = runtimeToolDefinitions.find((entry) => entry.name === 'supervisor_task');
  expect(JSON.stringify(definition?.inputSchema)).toContain('"recover"');

  const server = createWorkflowSupervisorServer({
    controlPlane: control,
    socketPath: join(supervisorRoot, 'supervisor.sock'),
    discovery: new WorkflowSupervisorEphemeralDiscovery(),
    browserAdapterEnabled: true,
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) { resolve(); return; }
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  try {
    const ctx = { controllerHome } as unknown as Parameters<typeof callWorkflowSupervisorAdapter>[0];
    await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', {
      operation: 'recover',
      task_id: taskId,
      source_effect_id: automaticSecond.effectId,
      request_id: 'public-provider-recover-request',
      reason: 'Operator explicitly requested continuation after bounded provider resume exhaustion.',
      authorized_by: 'test-operator',
    });
    const recovered = store.getEffectByOriginKey(`provider-recovery:${automaticSecond.effectId}`);
    expect(recovered).toMatchObject({ taskId, kind: 'recovery' });
    expect(recovered?.effectId).not.toBe(automaticSecond.effectId);
    expect(store.providerResumeExhausted(automaticSecond.effectId)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('a terminal conversation capacity banner migrates the same Supervisor but quoted activity text cannot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-capacity-migration-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store, {}, {
    browserTaskActive: () => true,
    projectScopeForTask: () => ({ title: 'Avela' }),
  });
  const taskId = 'supervisor:capacity-test';
  const conversationId = 'abcabcab-1234-5678-90ab-cdefabcdefab';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Continue one durable task even after terminal provider capacity.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
  });
  control.recordBrowserDiscovery('capacity-test', [{
    conversationId, canonicalUrl: conversationUrl, title: 'Avela',
    projectTitle: 'Avela', projectUrl: 'https://chatgpt.com/g/g-p-123456789abcdef0/project',
  }]);
  const effect = control.reserveEnrollment(taskId);
  expect(store.recordEffectDispatchStarted(effect.effectId, 1, 'capacity-original-send')).toBe(true);
  control.observeEffect({ effectId: effect.effectId, observationId: 'capacity-applied', outcome: 'applied' });

  const warning = '你已达到此对话的长度上限，你可以开始新聊天以继续对话。';
  let activeStatus = '';
  const page: TestBrowserPage = {
    evaluate: async <T>() => false as T,
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'window-capacity', tabId: 'tab-capacity' }),
  };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [{
      windowId: 'window-capacity', tabId: 'tab-capacity',
      url: conversationUrl, title: 'Avela', active: true, browserProduct: 'chrome',
    }], unavailableProducts: [] }),
    reattach: async () => page,
    create: async () => ({
      evaluate: async <T>() => false as T,
      waitForSelector: async () => undefined,
      tabRef: () => ({ windowId: 'window-fresh', tabId: 'tab-fresh' }),
    }),
    close: async () => undefined,
    readOwner: async () => '',
    writeOwner: async () => undefined,
    snapshot: async (observedPage) => ({
      url: observedPage === page ? conversationUrl : 'https://chatgpt.com/g/g-p-123456789abcdef0/project',
      title: 'Avela',
      latestUserText: observedPage === page ? 'Original durable effect already submitted.' : '',
      latestAssistantResponse: '', providerActivityText: observedPage === page ? warning : '',
      providerFailureText: observedPage === page ? activeStatus : '',
      latestTurnRole: 'user' as const,
      isGenerating: false,
    }),
    // A separate NEW enrollment may be attempted; the old applied source
    // must never be dispatched again and its generation remains exactly one.
    dispatchPrompt: async (targetPage) => {
      if (targetPage === page) throw new Error('CAPACITY_MUST_NOT_REPLAY_APPLIED_EFFECT');
      return { dispatched: false, confirmed: false };
    },
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort,
    nowMs: () => Date.now(),
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onError: (error) => { throw error; },
  });
  await adapter.runOnce();
  expect(store.getTask(taskId)?.conversationId).toBe(conversationId);
  activeStatus = warning;
  await adapter.runOnce();
  expect(store.getTask(taskId)?.conversationId).toBe(`bootstrap:${taskId}`);
  expect(store.latestEffectDispatch(effect.effectId)?.generation).toBe(1);
  expect(store.getEffectByOriginKey(`fresh-conversation:${taskId}:capacity:${conversationId}`)?.kind).toBe('enrollment');
  store.close();
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

  const page = (tabId: string): TestBrowserPage => ({
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
    latestUserText: '', latestAssistantResponse: '', composerText: '', providerActivityText: '',
    providerFailureText: page === stalePage ? 'ChatGPT stream recovery polling timed out' : '',
    latestTurnRole: 'assistant' as const, isGenerating: false,
  });
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [{ windowId: 'window-1', tabId: 'tab-1', url: conversationUrl, title: 'Forge recovery test', active: false, browserProduct: 'chrome' }], unavailableProducts: [] }),
    reattach: async () => stalePage,
    create: async (url) => { createdUrls.push(url); throw new Error('unexpected create'); },
    close: async (ref) => { closed.push(ref); },
    readOwner: async (page) => owners.get(page) ?? '',
    writeOwner: async (page, owner) => { owners.set(page, owner); },
    snapshot: async (page) => snapshot(page),
    dispatchPrompt: async (page) => { dispatchedPages.push(page); return { dispatched: true, confirmed: true }; },
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort,
    nowMs: () => nowMs,
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
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
  // Provider cooldown never retires an active semantic target. The recovery
  // submits once on the same exact conversation without manufacturing another tab.
  expect(closed).toEqual([]);
  expect(store.latestEffectDispatch(enrollment.effectId)?.generation).toBe(1);
  control.stopTask('stream-recovery-tab');
  await adapter.runOnce();
  expect(closed).toContainEqual(expect.objectContaining({ windowId: 'window-1', tabId: 'tab-1' }));
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

test('automation tool receipt successor begins from the real assistant page baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-automation-successor-baseline-'));
  roots.push(root);
  // The successor of a completion becomes deliverable only after the spacing
  // interval, so this test advances the store clock instead of requiring an
  // immediate send after the authorizing completion.
  let storeClockMs = Date.now();
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => storeClockMs });
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-automation-successor-baseline';
  const conversationId = '67676767-7878-8989-9090-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId,
    conversationId,
    conversationUrl,
    objective: 'Continue through a canonical automation tool receipt.',
    completionContract: {},
    continuationPolicy: {},
    userBlockerPolicy: {},
  });

  const sourceEffect = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: sourceEffect.effectId, observationId: 'automation-source-applied', outcome: 'applied' });
  const continued = await control.observeAutomationReceipt({
    taskId,
    conversationId,
    status: 'continue',
    receiptId: `rh_work:continue:${taskId}`,
  });
  expect('successorEffect' in continued ? continued.successorEffect : undefined).toBeDefined();
  const successor = 'successorEffect' in continued ? continued.successorEffect! : undefined;
  expect(successor).toBeDefined();

  // A tool-only completed turn can leave the last rendered role as user.
  // Exercise the actual consumer, including its exact owned resource lifetime.
  // ChatGPT can compact an automated prompt to ordinary visible prose after
  // recording its local tool receipt. The successor must still begin because
  // the durable automation receipt is the causal anchor, not a retained DOM
  // marker for the prior prompt.
  let submittedText = '继续。';
  let owner = `forge-workflow-supervisor:created:${conversationId}`;
  let generating = true;
  let closeCount = 0;
  let tabPresent = true;
  const dispatched: string[] = [];
  let nowMs = Date.now();
  let receiptDuringScan: (() => Promise<void>) | undefined;
  const scanEvents: string[] = [];
  const backlogPages = ['unknown-tab-1', 'unknown-tab-2'].map((tabId): TestBrowserPage => ({
    evaluate: async () => { throw new Error('unknown reconciliation must never mutate'); },
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'receipt-window', tabId }),
  }));
  const page: TestBrowserPage = {
    evaluate: async () => { throw new Error('unexpected provider control'); },
    waitForSelector: async () => undefined,
    tabRef: () => ({ windowId: 'receipt-window', tabId: 'receipt-tab' }),
  };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [...(tabPresent ? [{
      windowId: 'receipt-window', tabId: 'receipt-tab', active: false,
      url: conversationUrl, title: 'Tool-only completed turn', browserProduct: 'chrome' as const,
    }] : []), ...backlogPages.map((entry) => ({
      windowId: 'receipt-window', tabId: entry.tabRef()!.tabId, active: false,
      url: 'https://chatgpt.com/', title: 'Unrelated unknown bootstrap', browserProduct: 'chrome' as const,
    }))], unavailableProducts: [] }),
    reattach: async (ref: { tabId: string }) => backlogPages.find((entry) => entry.tabRef()!.tabId === ref.tabId) ?? page,
    create: async () => { throw new Error('must retain the same conversation tab'); },
    close: async () => { closeCount += 1; tabPresent = false; },
    readOwner: async (entry: TestBrowserPage) => {
      if (entry.tabRef()!.tabId === 'unknown-tab-2') {
        generating = false;
        nowMs += 1_500;
        scanEvents.push('provider-idle');
      }
      return entry === page ? owner : '';
    },
    writeOwner: async (_page: TestBrowserPage, marker: string) => { owner = marker; },
    snapshot: async (entry: TestBrowserPage) => {
      if (entry !== page) {
        scanEvents.push(entry.tabRef()!.tabId);
        const receipt = receiptDuringScan;
        receiptDuringScan = undefined;
        await receipt?.();
        return {
          url: 'https://chatgpt.com/', title: 'Unrelated unknown bootstrap', latestUserText: '',
          latestAssistantResponse: '', latestTurnRole: 'user' as const,
          isGenerating: false, providerActivityText: '', providerFailureText: '',
        };
      }
      return {
        url: conversationUrl, title: 'Tool-only completed turn', latestUserText: submittedText,
        latestAssistantResponse: '', latestTurnRole: 'user' as const,
        isGenerating: generating, providerActivityText: '', providerFailureText: '',
      };
    },
    dispatchPrompt: async (_page: TestBrowserPage, prompt: string) => {
      dispatched.push(prompt); submittedText = prompt; scanEvents.push('successor-send');
      return { dispatched: true, confirmed: true };
    },
  });
  const dependencies = {
    targetPort,
    nowMs: () => nowMs,
    providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'),
    sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
    onError: (error: unknown) => { throw error; },
  };
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), dependencies);
  await adapter.runOnce();
  expect(dispatched).toEqual([]);
  generating = false;
  storeClockMs += 4 * 60_000;
  await adapter.runOnce();
  expect(dispatched).toEqual([successor!.prompt]);
  expect(store.latestEffectDispatch(successor!.effectId)?.generation).toBe(1);
  expect(closeCount).toBe(0);
  await adapter.close();
  // After restart, commit CONTINUE in the middle of a historical bootstrap
  // inventory scan. It must dispatch before that scan reads the next tab.
  const backlogTaskId = 'old-outcome-unknown-bootstrap';
  control.registerTask({
    taskId: backlogTaskId, conversationId: `bootstrap:${backlogTaskId}`, conversationUrl: 'https://chatgpt.com/',
    objective: 'Observe an already-started provider effect without resending.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const backlogEffect = control.reserveEnrollment(backlogTaskId);
  expect(control.bootstrapBeginEffect({
    taskId: backlogTaskId, effectId: backlogEffect.effectId,
    dispatchId: 'old-bootstrap-dispatch', dispatchGeneration: 1,
  })).toBe(true);
  receiptDuringScan = async () => {
    await control.observeAutomationReceipt({ taskId, conversationId, status: 'continue', receiptId: 'second-native-continue' });
    generating = true;
    scanEvents.push('continue-committed');
  };
  scanEvents.length = 0;
  const restarted = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), dependencies);
  await restarted.runOnce();
  expect(dispatched).toHaveLength(2);
  expect(scanEvents).toEqual(['unknown-tab-1', 'continue-committed', 'provider-idle', 'successor-send', 'unknown-tab-2']);
  expect(store.effectDispatchBudget(backlogEffect.effectId).generations).toBe(1);
  expect(store.effectApplied(backlogEffect.effectId)).toBe(false);
  expect(control.bootstrapPoll(backlogTaskId).command?.mode).not.toBe('send');
  await restarted.runOnce();
  expect(dispatched).toHaveLength(2);
  expect(store.effectDispatchBudget(backlogEffect.effectId).generations).toBe(1);
  expect(closeCount).toBe(0);
  control.stopTask(taskId);
  await restarted.runOnce();
  expect(closeCount).toBe(1);
  const last = store.latestAppliedEffectWithoutCompletion(taskId)!;
  expect(() => control.browserBeginEffect({
    conversationId, conversationUrl, effectId: last.effectId,
    dispatchId: 'stale-after-stop', dispatchGeneration: 1,
  })).toThrow('WORKFLOW_SUPERVISOR_TASK_TERMINAL:STOPPED');
  control.stopTask(backlogTaskId);
  expect(() => control.bootstrapBeginEffect({
    taskId: backlogTaskId, effectId: backlogEffect.effectId,
    dispatchId: 'stale-bootstrap-after-stop', dispatchGeneration: 1,
  })).toThrow('WORKFLOW_SUPERVISOR_TASK_TERMINAL:STOPPED');
  await restarted.close();
  // Runtime restart drops only in-memory attachment state. A terminal task has
  // no Supervisor effect authority; cleanup of any leaked provider-owned tab is
  // a Computer target-authority concern and is covered in Computer tests.
  tabPresent = true;
  const cleanup = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), dependencies);
  await cleanup.runOnce();
  expect(closeCount).toBe(1);
  expect(tabPresent).toBe(true);
  owner = '';
  await cleanup.runOnce();
  expect(closeCount).toBe(1);
  expect(tabPresent).toBe(true);
  await cleanup.close();
  store.close();
});

test('refuses post-send negative proofs from both loading and rendered stale conversation pages', () => {
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
    objective: 'A browser snapshot cannot prove a provider submission never applied.',
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

  // A rendered, empty composer with the exact old baseline can also be stale.
  // It must not authorize another send after an ambiguous transport outcome.
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
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 3_600_000 }))
    .toMatchObject({ mode: 'reconcile', generation: 1 });
  control.browserObserveEffect({
    conversationId, conversationUrl, effectId: effect.effectId,
    observationId: 'delayed-provider-acceptance', outcome: 'applied',
    evidence: { target_marker_present: true },
  });
  expect(store.effectApplied(effect.effectId)).toBe(true);
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(1);
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
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
    // Exercise bounded retry with trusted dispatch-owner evidence, never with
    // a post-send DOM observation claiming provider rejection.
    store.recordEffectNotAppliedProof(effect.effectId, observationId, {
      dispatch_generation: store.latestEffectDispatch(effect.effectId)!.generation,
      reason: 'provider_rejected_before_submission',
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

describe('Workflow Supervisor operator recovery and conversation replacement', () => {
  test('a mechanically exhausted un-applied effect never becomes silently inert and needs one bounded operator grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-operator-retry-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
    const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
    const conversationId = 'aaaaaaa1-1111-2222-3333-444444444444';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const taskId = 'operator-retry-exhaustion';
    control.registerTask({
      taskId, conversationId, conversationUrl, objective: 'Operator retry after a purely local obstacle.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(taskId);
    const ownerReturn = (generation: number, reason: string): void => {
      store.recordEffectDispatchStarted(effect.effectId, generation, `owner-${generation}`, { surface: 'macos-native' });
      control.browserObserveDispatchFailure({
        conversationId, conversationUrl, effectId: effect.effectId,
        observationId: `owner-no-click-${generation}`, dispatchGeneration: generation, reason,
      });
    };
    ownerReturn(1, 'composer_missing');
    ownerReturn(2, 'send_button_missing');
    ownerReturn(3, 'composer_missing');
    // Every failure above is the dispatch owner's own pre-send return, so the
    // one bounded automatic refund must apply instead of exhausting the effect.
    expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 3, exhausted: false });
    expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toMatchObject({ mode: 'send', generation: 4 });
    ownerReturn(4, 'composer_missing');
    expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toBeUndefined();
    // Exhaustion is visible as a derived projection instead of an empty queue.
    expect(control.taskStall(taskId)).toMatchObject({ state: 'retryable', effectId: effect.effectId, generations: 4, maxGenerations: 4 });
    const stallProjections: Array<Record<string, unknown>> = [];
    const page: TestBrowserPage = {
      evaluate: async () => undefined as never,
      tabRef: () => ({ windowId: 'stall-window', tabId: 'stall-tab' }),
    };
    const targetPort = createTestChatgptTargetPort({
      listTabs: async () => ({ entries: [{ windowId: 'stall-window', tabId: 'stall-tab', active: true, frontmost: true, url: conversationUrl, title: 'stall' }] }),
      reattach: async () => page,
      create: async () => page,
      close: async () => undefined,
      snapshot: async () => ({
        url: conversationUrl, title: 'stall', latestUserText: 'prior user', latestAssistantResponse: '',
        composerText: '', isGenerating: true, providerActivityText: 'working', providerFailureText: '',
      }),
      dispatchPrompt: async () => { throw new Error('stall projection test must not dispatch'); },
    });
    const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
      targetPort,
      nowMs: () => Date.now(),
      providerIdleGraceMs: 60_000,
      providerScopeKey: join(root, 'provider-scope'),
      sleep: async () => undefined,
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      onError: () => undefined,
      reportTaskStall: (projection) => { stallProjections.push(projection as unknown as Record<string, unknown>); },
    });
    await adapter.runOnce();
    expect(stallProjections).toContainEqual(expect.objectContaining({
      taskId, effectId: effect.effectId, state: 'exhausted', stallKind: 'retryable', generations: 4, maxGenerations: 4,
    }));
    expect(() => control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: '', reason: 'missing request id' }))
      .toThrow('WORKFLOW_SUPERVISOR_RECOVERY_REASON_REQUIRED');
    const recovered = control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: 'op-retry-1', reason: 'The local composer obstacle was fixed.' });
    expect(recovered.action).toBe('retry_authorized');
    expect(recovered.recoveryEffect.effectId).toBe(effect.effectId);
    expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toMatchObject({ mode: 'send', generation: 5 });
    await adapter.runOnce();
    expect(stallProjections).toContainEqual(expect.objectContaining({
      taskId, effectId: effect.effectId, state: 'recovered', stallKind: 'retryable',
    }));
    // Idempotent per request id, and the explicit budget stays bounded.
    expect(control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: 'op-retry-1', reason: 'repeat' }).recoveryEffect.effectId).toBe(effect.effectId);
    control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: 'op-retry-2', reason: 'Second explicit grant.' });
    expect(() => control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: 'op-retry-3', reason: 'Third explicit grant.' }))
      .toThrow('WORKFLOW_SUPERVISOR_RECOVERY_REFUND_BUDGET_EXHAUSTED');
    await adapter.close();
    store.close();
  });

  test('an outcome-unknown submission is retired only by an explicit operator decision and is never resent', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-unknown-supersede-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
    const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
    const conversationId = 'aaaaaaa2-1111-2222-3333-444444444444';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const taskId = 'unknown-supersede-task';
    control.registerTask({
      taskId, conversationId, conversationUrl, objective: 'Retire an unknown submission explicitly.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(taskId);
    store.recordEffectDispatchStarted(effect.effectId, 1, 'uncertain-send', { surface: 'macos-native' });
    store.recordEffectObservation(effect.effectId, 'unknown-after-send', 'unknown', {
      surface: 'macos-native', reconciliation: true, reason: 'outbound_not_confirmed',
    });
    // Observation alone never authorizes a re-send.
    expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 60_000 })).toMatchObject({ mode: 'reconcile', effect: { effectId: effect.effectId } });
    expect(() => control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: 'unknown-1', reason: 'Observation-only request.' }))
      .toThrow('WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN');
    expect(store.effectApplied(effect.effectId)).toBe(false);
    const superseded = control.recoverTask({
      taskId, sourceEffectId: effect.effectId, requestId: 'unknown-1',
      reason: 'Operator decided to stop waiting on the unknown submission.', supersedeUnknown: true, authorizedBy: 'greyson',
    });
    expect(superseded.action).toBe('unknown_superseded');
    expect(superseded.recoveryEffect.effectId).not.toBe(effect.effectId);
    // The successor is the only live obligation; the retired effect keeps its
    // single dispatch generation and is never replayed.
    expect(store.nextBrowserEffect(taskId)).toMatchObject({ mode: 'send', effect: { effectId: superseded.recoveryEffect.effectId } });
    expect(store.effectDispatchBudget(effect.effectId).generations).toBe(1);
    expect(store.effectApplied(effect.effectId)).toBe(false);
    expect(control.taskStall(taskId)).toMatchObject({ state: 'deliverable', effectId: superseded.recoveryEffect.effectId, mode: 'send' });
    expect(control.recoverTask({
      taskId, sourceEffectId: effect.effectId, requestId: 'unknown-1',
      reason: 'repeat of the same explicit decision', supersedeUnknown: true,
    }).recoveryEffect.effectId).toBe(superseded.recoveryEffect.effectId);
    store.close();
  });

  test('conversation replacement is explicit, CAS-fenced, bounded, and refuses an unresolved submission', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-conversation-migration-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
    const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
    const conversationA = 'bbbbbbb1-1111-2222-3333-444444444444';
    const conversationB = 'bbbbbbb2-1111-2222-3333-444444444444';
    const conversationC = 'bbbbbbb3-1111-2222-3333-444444444444';
    const conversationD = 'bbbbbbb4-1111-2222-3333-444444444444';
    const conversationE = 'bbbbbbb5-1111-2222-3333-444444444444';
    const conversationF = 'bbbbbbb6-1111-2222-3333-444444444444';
    const url = (id: string): string => `https://chatgpt.com/c/${id}`;
    control.registerTask({
      taskId: 'migration-a', conversationId: conversationA, conversationUrl: url(conversationA), objective: 'Move a task whose conversation is unusable.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    expect(control.migrateConversation({
      taskId: 'migration-a', expectedConversationId: conversationA, conversationId: conversationB, conversationUrl: url(conversationB),
      requestId: 'migrate-1', reason: 'The exact conversation is durably unreadable.',
    })).toMatchObject({ migrated: true, conversationId: conversationB });
    // A stale expectation cannot move a task that already advanced.
    expect(() => control.migrateConversation({
      taskId: 'migration-a', expectedConversationId: conversationA, conversationId: conversationC, conversationUrl: url(conversationC),
      requestId: 'migrate-stale', reason: 'stale decision',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_STALE');
    control.registerTask({
      taskId: 'migration-owner', conversationId: conversationC, conversationUrl: url(conversationC), objective: 'Owns its own conversation.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    expect(() => control.migrateConversation({
      taskId: 'migration-a', expectedConversationId: conversationB, conversationId: conversationC, conversationUrl: url(conversationC),
      requestId: 'migrate-conflict', reason: 'another task already owns it',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_CONVERSATION_CONFLICT');
    control.migrateConversation({
      taskId: 'migration-a', expectedConversationId: conversationB, conversationId: conversationD, conversationUrl: url(conversationD),
      requestId: 'migrate-2', reason: 'Second explicit replacement.',
    });
    expect(() => control.migrateConversation({
      taskId: 'migration-a', expectedConversationId: conversationD, conversationId: conversationE, conversationUrl: url(conversationE),
      requestId: 'migrate-3', reason: 'Third replacement must be refused.',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_BUDGET_EXHAUSTED');

    control.registerTask({
      taskId: 'migration-unknown', conversationId: conversationF, conversationUrl: url(conversationF), objective: 'A submitted mutation stays in place.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    const unknownEffect = control.reserveEnrollment('migration-unknown');
    store.recordEffectDispatchStarted(unknownEffect.effectId, 1, 'uncertain-send', { surface: 'macos-native' });
    store.recordEffectObservation(unknownEffect.effectId, 'unknown-after-send', 'unknown', { surface: 'macos-native', reconciliation: true, reason: 'outbound_not_confirmed' });
    expect(() => control.migrateConversation({
      taskId: 'migration-unknown', expectedConversationId: conversationF, conversationId: conversationE, conversationUrl: url(conversationE),
      requestId: 'migrate-unknown', reason: 'cannot abandon an unresolved submission',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_OUTCOME_UNKNOWN');
    // A mechanically proven un-applied effect is safe to carry to the replacement.
    store.recordEffectNotAppliedProof(unknownEffect.effectId, 'owner-no-click', {
      surface: 'macos-native', reason: 'composer_missing', send_clicked: false, dispatch_generation: 1, pre_send_rejection: true,
    });
    expect(control.migrateConversation({
      taskId: 'migration-unknown', expectedConversationId: conversationF, conversationId: conversationE, conversationUrl: url(conversationE),
      requestId: 'migrate-proven', reason: 'The submission never left the composer.',
    })).toMatchObject({ migrated: true, conversationId: conversationE, conversationUrl: url(conversationE) });
    store.close();
  });

  test('a durably unusable conversation is replaced by a fresh one only through an explicit operator move', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-fresh-conversation-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
    const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
    const conversationA = 'ddddddd1-1111-2222-3333-444444444444';
    const conversationB = 'ddddddd2-1111-2222-3333-444444444444';
    const url = (id: string): string => `https://chatgpt.com/c/${id}`;
    const taskId = 'fresh-conversation-task';
    control.registerTask({
      taskId, conversationId: conversationA, conversationUrl: url(conversationA),
      objective: 'Fresh conversation objective.', completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    const pending = control.reserveEnrollment(taskId);
    expect(control.migrateConversation({
      taskId, expectedConversationId: conversationA, fresh: true, requestId: 'fresh-1',
      reason: 'The exact conversation no longer renders any content for the provider.', authorizedBy: 'greyson',
    })).toMatchObject({ migrated: true, conversationId: `bootstrap:${taskId}`, freshConversation: true });
    expect(control.getTask(taskId)?.conversationUrl).toBe('https://chatgpt.com/');
    // The replacement turn carries the objective again: a fresh conversation has
    // no prior turns for a bare continuation to rely on.
    const next = store.nextBrowserEffect(taskId);
    expect(next).toMatchObject({ mode: 'send', generation: 1, effect: { kind: 'enrollment' } });
    expect(next!.effect.effectId).not.toBe(pending.effectId);
    expect(next!.effect.prompt).toContain('Fresh conversation objective.');
    expect(store.currentUnappliedEffect(taskId)?.effectId).toBe(next!.effect.effectId);
    expect(() => control.migrateConversation({
      taskId, expectedConversationId: conversationA, fresh: true, requestId: 'fresh-stale', reason: 'stale decision',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_STALE');
    // An unresolved submitted mutation is never abandoned by moving the task.
    const blockedTaskId = 'fresh-conversation-blocked';
    control.registerTask({
      taskId: blockedTaskId, conversationId: conversationB, conversationUrl: url(conversationB),
      objective: 'Blocked fresh conversation.', completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    const blockedEffect = control.reserveEnrollment(blockedTaskId);
    store.recordEffectDispatchStarted(blockedEffect.effectId, 1, 'uncertain-send', { surface: 'macos-native' });
    store.recordEffectObservation(blockedEffect.effectId, 'unknown-after-send', 'unknown', { surface: 'macos-native', reconciliation: true, reason: 'outbound_not_confirmed' });
    expect(() => control.migrateConversation({
      taskId: blockedTaskId, expectedConversationId: conversationB, fresh: true, requestId: 'fresh-blocked',
      reason: 'cannot abandon an unresolved submission',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_OUTCOME_UNKNOWN');
    store.close();
  });

  test('native broker timeout and busy failures back off the affected send across ticks', async () => {
    for (const code of ['BROWSER_AUTOMATION_TIMEOUT', 'BROWSER_AUTOMATION_SERIALIZATION_BUSY']) {
      const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-native-broker-spacing-'));
      roots.push(root);
      const clock = { nowMs: Date.now() };
      const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
      const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
      const taskId = 'native-broker-failure';
      const conversationId = 'ccccccc2-1111-2222-3333-444444444444';
      const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
      control.registerTask({
        taskId, conversationId, conversationUrl, objective: 'Do not hot-loop one unavailable native tab.',
        completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
      });
      control.reserveEnrollment(taskId);
      let attempts = 0;
      const targetPort = {
        inventory: async () => ({ conversations: [], complete: true, unavailableProviders: [] }),
        cleanup: async () => undefined,
        ensureExact: async () => { attempts += 1; throw new Error(`${code}: native broker still unavailable`); },
        close: async () => undefined,
      } as any;
      const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
        targetPort, nowMs: () => clock.nowMs, providerIdleGraceMs: 60_000, providerScopeKey: join(root, 'provider-scope'),
        sleep: async () => undefined, setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => undefined, onError: () => undefined,
      });
      await adapter.runOnce();
      expect(attempts).toBe(1);
      expect(adapter.status().lastFailure?.code).toBe(code);
      clock.nowMs += 10_000;
      await adapter.runOnce();
      expect(attempts).toBe(1);
      clock.nowMs += 20_000;
      await adapter.runOnce();
      expect(attempts).toBe(2);
      store.close();
    }
  });

  test('a task-local exact-conversation failure spaces its own retries instead of reopening the surface every tick', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-target-spacing-'));
    roots.push(root);
    const clock = { nowMs: Date.now() };
    const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
    const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
    const taskId = 'target-spacing-task';
    const conversationId = 'ccccccc1-1111-2222-3333-444444444444';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    control.registerTask({
      taskId, conversationId, conversationUrl, objective: 'Space exact-conversation retries.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    control.reserveEnrollment(taskId);
    let snapshotCalls = 0;
    const page: TestBrowserPage = { evaluate: async () => undefined as never, tabRef: () => ({ windowId: 'spacing-window', tabId: 'spacing-tab' }) };
    const targetPort = createTestChatgptTargetPort({
      listTabs: async () => ({ entries: [{ windowId: 'spacing-window', tabId: 'spacing-tab', active: true, frontmost: true, url: conversationUrl, title: 'spacing' }] }),
      reattach: async () => page,
      create: async () => { throw new Error('a spaced task must not manufacture a replacement tab'); },
      close: async () => undefined,
      // The exact URL is present but the provider has not rendered the
      // conversation yet: transport evidence, never send evidence.
      snapshot: async () => {
        snapshotCalls += 1;
        return { url: conversationUrl, title: 'spacing', latestUserText: '', latestAssistantResponse: '', isGenerating: false, providerActivityText: '', providerFailureText: '' };
      },
      dispatchPrompt: async () => { throw new Error('unexpected dispatch'); },
    });
    const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
      targetPort, nowMs: () => clock.nowMs, providerIdleGraceMs: 60_000, providerScopeKey: join(root, 'provider-scope'),
      sleep: async () => undefined, setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval: () => undefined, onError: () => undefined,
    });
    await adapter.runOnce();
    expect(snapshotCalls).toBe(1);
    expect(adapter.status().lastFailure?.code).toBe('COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE');
    // Inside the spacing window the retained surface is not touched at all.
    clock.nowMs += 10_000;
    await adapter.runOnce();
    expect(snapshotCalls).toBe(1);
    // After the base interval exactly one more bounded observation happens.
    clock.nowMs += 20_000;
    await adapter.runOnce();
    expect(snapshotCalls).toBe(2);
    // The second identical failure grows the spacing: 30s is no longer enough.
    clock.nowMs += 30_000;
    await adapter.runOnce();
    expect(snapshotCalls).toBe(2);
    clock.nowMs += 30_000;
    await adapter.runOnce();
    expect(snapshotCalls).toBe(3);
    store.close();
  });
});
