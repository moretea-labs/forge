import { afterEach, describe, expect, test } from 'bun:test';
import { forgeWorkflowSupervisorValidators } from '../../supervisor/forge-validators';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerHome, SEMANTIC_SCOPE_KEY } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { acknowledgeControllerRoundClaim, beginInitialControllerRoundDispatch, claimStalledControllerRoundRelays, controllerRoundProviderEffectId, finishControllerRoundRelayDispatch, getControllerRoundRelay, getRequirementControllerRoundRelay, recoverControllerRoundRelayAuthority, submitControllerRoundDisposition } from '../../packages/kernel/controller/api/index';
import { createWorkContract, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { createRequirement, reviseRequirementSemantic, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { bindCurrentWorkflowSupervisorConversationForWork, ensureWorkflowSupervisorEnrollmentForWork, forgeWorkflowSupervisorLifecycleHooks, inheritWorkflowSupervisorConversationBinding, workflowSupervisorBoundaryForWork, workflowSupervisorLowerLayerReadyForWork } from '../../src/runtime/root/workflow-supervisor-composition';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { WorkflowSupervisorNativeBrowserAdapter } from '../../supervisor/native-browser-adapter';
import { hasCommittedSupervisorEnvelope, LEGACY_SUPERVISOR_BLOCK_END, LEGACY_SUPERVISOR_BLOCK_START, parseSupervisorCompletion, renderSupervisorPrompt, renderSupervisorReceipt, supervisorReceiptChallenge, SUPERVISOR_BLOCK_END, SUPERVISOR_BLOCK_START, SUPERVISOR_TURN_BLOCK_END, SUPERVISOR_TURN_BLOCK_START } from '../../supervisor/protocol';
import { WorkflowSupervisorStore, workflowSupervisorCompletionContractSha256, WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS } from '../../supervisor/store';
import { createWorkflowSupervisorServer, reconcileWorkflowSupervisorSocket, WorkflowSupervisorEphemeralDiscovery } from '../../supervisor/server';
import { claimControllerSession, getControllerSession, releaseControllerSession } from '../../packages/kernel/controller/api/index';
import { bindChatgptWorkConversation, getChatgptWorkConversationBinding, rebindChatgptWorkConversation } from '../../adapters/chatgpt/work-conversation-binding-store';
import { CHATGPT_AUTOMATION_RATE_LIMITED, CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE, chatgptProviderBackpressureRemainingMs, chatgptProviderPageFailure, classifyChatgptProviderFailure, noteChatgptProviderBackpressure } from '../../adapters/chatgpt/provider-delivery';
import { chatgptBrowserObservationMatchesTarget, chatgptComposerRetainsPrompt, chatgptFailedRequestIsCausalRateLimit, chatgptForgePluginMentionBound, chatgptForgePluginPickerIndex, chatgptOutboundMessageMatchesPrompt, chatgptSupervisorPromptBody } from '../../adapters/chatgpt/browser-delivery-runtime';
import { parseChatgptConversationIdentity } from '../../supervisor/chatgpt-conversation';
import { setMacOsBrowserRuntimeHooksForTest, resetMacOsBrowserRuntimeHooksForTest } from '../../src/runtime/plugins/browser-macos-bridge';
import { createTestChatgptTargetPort, type TestBrowserPage } from './helpers/computer-chatgpt-target-harness';
import { callWorkflowSupervisorAdapter } from '../../adapters/mcp/runtime-gateway/workflow-supervisor-adapter';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';

const roots: string[] = [];
afterEach(() => { resetMacOsBrowserRuntimeHooksForTest(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });


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

describe('ChatGPT Supervisor structured plugin mention', () => {
  const payload = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_example01>>>\nFORGE_WORKFLOW_TURN_V2_BEGIN';
  const legacyDeveloperChip = '<span app-mention-name="forge-current-1-8-1" app-mention-display-name="Forge Current 1.8.1" contenteditable="false">Forge Current 1.8.1</span>';
  const unboundForgeChip = '<span plugin-mention-name="dev-6ac09022b26081918f20ff868c773824" contenteditable="false">forge</span>';
  const mainChip = '<span app-mention-name="forge" app-mention-path="app://asdk_app_6ac09022b26081918f20ff868c773824" contenteditable="false">forge</span>';
  const recoveryChip = '<span app-mention-name="forge-recovery" app-mention-display-name="Forge Recovery" contenteditable="false">Forge Recovery</span>';
  test('removes only the legacy leading @forge text trigger and preserves the effect payload', () => {
    expect(chatgptSupervisorPromptBody(`@forge\n${payload}`)).toBe(payload);
    expect(chatgptSupervisorPromptBody(`@forge ${payload}`)).toBe(payload);
    expect(chatgptSupervisorPromptBody(payload)).toBe(payload);
    expect(chatgptSupervisorPromptBody(`Keep @forge in the explanation. ${payload}`)).toBe(`Keep @forge in the explanation. ${payload}`);
    expect(() => chatgptSupervisorPromptBody('@forge')).toThrow('CHATGPT_AUTOMATION_PROMPT_REQUIRED');
  });
  test('normalizes live suggestion line breaks and refuses lookalikes or ambiguity', () => {
    expect(chatgptForgePluginPickerIndex(['Forge Recovery\nRecovery', 'forge\nCurrent Forge 1.8.1 controller runtime', 'forge-cloud'])).toBe(1);
    expect(chatgptForgePluginPickerIndex(['Forge Recovery', 'forge-cloud'])).toBeUndefined();
    expect(chatgptForgePluginPickerIndex(['forge\nCurrent Forge 1.8.1', 'forge\nAnother connected app'])).toBeUndefined();
  });
  test('accepts only the exact installed main Forge app chip with the full payload', () => {
    expect(chatgptForgePluginMentionBound(`<p>${payload}</p><p>${mainChip}</p>`, `${payload} forge`, payload)).toBe(true);
    expect(chatgptForgePluginMentionBound(`<p>${payload}</p><p>${mainChip}</p>`, `${payload.slice(1)} forge`, payload)).toBe(false);
    expect(chatgptForgePluginMentionBound(`<p>${payload}</p><p>${mainChip}${mainChip}</p>`, `${payload} forge forge`, payload)).toBe(false);
    // A forged name in one node and the valid app path in a separate node
    // must not pass the same-chip authorization proof.
    expect(chatgptForgePluginMentionBound(`<p>${payload}</p><span app-mention-name="forge">forge</span><span app-mention-path="app://asdk_app_6ac09022b26081918f20ff868c773824"></span>`, `${payload} forge`, payload)).toBe(false);
  });
  test('rejects the legacy developer package, unbound chip, literal text, and Recovery app', () => {
    expect(chatgptForgePluginMentionBound(`<p>${legacyDeveloperChip} ${payload}</p>`, `Forge Current 1.8.1 ${payload}`, payload)).toBe(false);
    expect(chatgptForgePluginMentionBound(`<p>${unboundForgeChip} ${payload}</p>`, `${payload} forge`, payload)).toBe(false);
    expect(chatgptForgePluginMentionBound(`<p>@forge ${payload}</p>`, `@forge ${payload}`, payload)).toBe(false);
    expect(chatgptForgePluginMentionBound(`<p>${recoveryChip} ${payload}</p>`, `Forge Recovery ${payload}`, payload)).toBe(false);
    expect(chatgptForgePluginMentionBound(`<p>${legacyDeveloperChip}${recoveryChip} ${payload}</p>`, `Forge Current 1.8.1 Forge Recovery ${payload}`, payload)).toBe(false);
  });
  test('accepts the installed plugin suffix only after a verified selection', () => {
    expect(chatgptOutboundMessageMatchesPrompt(`${payload} forge`, payload, { boundForgePlugin: true })).toBe(true);
    expect(chatgptOutboundMessageMatchesPrompt(`${payload} forge`, payload)).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt(`Forge Current 1.8.1 ${payload}`, payload, { boundForgePlugin: true })).toBe(false);
    expect(chatgptOutboundMessageMatchesPrompt(`Forge Recovery ${payload}`, payload, { boundForgePlugin: true })).toBe(false);
  });
});

describe('ChatGPT native tab identity pre-send fence', () => {
  const target = 'https://chatgpt.com/g/g-p-forge/c/11111111-2222-3333-4444-555555555555';
  test('accepts only the exact conversation and exact Browser session', () => {
    const observation = { sessionId: 'browser_exact', url: target,
      browserConnection: { tab: { url: target } } };
    expect(chatgptBrowserObservationMatchesTarget(observation, 'browser_exact', target)).toBe(true);
    expect(chatgptBrowserObservationMatchesTarget({ ...observation, sessionId: 'browser_other' }, 'browser_exact', target)).toBe(false);
    expect(chatgptBrowserObservationMatchesTarget({ ...observation,
      browserConnection: { tab: { url: 'https://chatgpt.com/g/g-p-avela/c/99999999-2222-3333-4444-555555555555' } } }, 'browser_exact', target)).toBe(false);
    expect(chatgptBrowserObservationMatchesTarget({ sessionId: 'browser_exact' }, 'browser_exact', target)).toBe(false);
  });
});

describe('Standalone Supervisor explicit bootstrap Project binding', () => {
  test('binds one observed Project without inventing a Work or replaying an effect', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-project-binding-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'supervisor:standalone-revenue';
    const projectId = 'g-p-6a922010db348191a84d1a5306c083e8';
    const projectUrl = `https://chatgpt.com/g/${projectId}/project`;
    const conversationId = '11111111-2222-3333-4444-555555555555';
    control.registerTask({
      taskId, conversationId: `bootstrap:${taskId}`, conversationUrl: 'https://chatgpt.com/',
      objective: 'Continue the original standalone revenue experiment.',
      completionContract: { kind: 'model_semantic_completion' },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
      userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(taskId);
    expect(() => control.bootstrapProjectUrl(taskId)).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_SCOPE_REQUIRED');
    expect(() => control.bindBootstrapProject({
      taskId, projectUrl, requestId: 'bind-before-discovery', authorizedBy: 'user',
    })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_NOT_DISCOVERED');
    control.recordBrowserDiscovery('chrome', [{
      conversationId, canonicalUrl: `https://chatgpt.com/g/${projectId}-forge/c/${conversationId}`,
      projectTitle: 'forge', projectUrl,
    }]);
    expect(() => control.bindBootstrapProject({
      taskId, projectUrl: 'https://evil.example/g/' + projectId + '/project', requestId: 'evil', authorizedBy: 'user',
    })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_URL_INVALID');
    const bind = { taskId, projectUrl: `https://chatgpt.com/g/${projectId}-forge/project`, requestId: 'bind-once', authorizedBy: 'user' };
    expect(control.bindBootstrapProject(bind)).toEqual({ projectUrl, deduplicated: false });
    expect(control.bindBootstrapProject(bind)).toEqual({ projectUrl, deduplicated: true });
    expect(control.bootstrapProjectUrl(taskId)).toBe(projectUrl);
    expect(control.bootstrapPoll(taskId).command?.effectId).toBe(effect.effectId);
    expect(control.getTask(taskId)?.completionContract).toEqual({ kind: 'model_semantic_completion' });
    expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
    store.close();
  });

  test('refuses changing the target after any provider dispatch and forbids conflicting rebinding', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-project-fence-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const projectId = 'g-p-6a922010db348191a84d1a5306c083e8';
    const projectUrl = `https://chatgpt.com/g/${projectId}/project`;
    const otherProject = 'https://chatgpt.com/g/g-p-fedcba9876543210/project';
    const discovered = [projectUrl, otherProject].map((url, i) => ({
      conversationId: i === 0 ? '11111111-2222-3333-4444-555555555555' : '22222222-3333-4444-5555-666666666666',
      canonicalUrl: i === 0 ? 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555' : 'https://chatgpt.com/c/22222222-3333-4444-5555-666666666666',
      projectTitle: i === 0 ? 'forge' : 'another', projectUrl: url,
    }));
    control.recordBrowserDiscovery('chrome', discovered);
    for (const suffix of ['bound', 'dispatched']) {
      const taskId = `supervisor:project-${suffix}`;
      control.registerTask({
        taskId, conversationId: `bootstrap:${taskId}`, conversationUrl: 'https://chatgpt.com/',
        objective: 'Preserve exact Supervisor enrollment.',
        completionContract: { kind: 'model_semantic_completion' },
        continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true }, userBlockerPolicy: {},
      });
      const effect = control.reserveEnrollment(taskId);
      if (suffix === 'dispatched') {
        expect(store.recordEffectDispatchStarted(effect.effectId, 1, 'send-started')).toBe(true);
        expect(() => control.bindBootstrapProject({ taskId, projectUrl, requestId: 'late', authorizedBy: 'user' }))
          .toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_OUTCOME_UNRESOLVED');
      } else {
        control.bindBootstrapProject({ taskId, projectUrl, requestId: 'first', authorizedBy: 'user' });
        expect(() => control.bindBootstrapProject({ taskId, projectUrl: otherProject, requestId: 'change', authorizedBy: 'user' }))
          .toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_CONFLICT');
      }
    }
    store.close();
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
    expect(recovery.prompt).toContain('supervisor_task get');
    expect(Array.from(recovery.prompt).length).toBeLessThanOrEqual(4_000);
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
    expect(revised.refreshedEffect!.prompt).toContain('task_id:' + JSON.stringify(task.taskId));
    expect(revised.refreshedEffect!.prompt).toContain('Deliver the current product outcome until complete or genuinely blocked.');
    expect(Array.from(revised.refreshedEffect!.prompt).length).toBeLessThanOrEqual(500);
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

  test('revises an unbound active Supervisor task with one CAS Work binding without changing its in-flight effect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-semantic-binding-'));
    roots.push(root);
    const repoId = 'repo-semantic-binding';
    const workId = 'work-semantic-binding-target';
    const otherWorkId = 'work-semantic-binding-other';
    for (const targetId of [workId, otherWorkId]) {
      createWorkContract({ controllerHome: root, scopeKey: repoId }, {
        workId: targetId, repoId, checkoutId: 'fixture', objective: 'Complete the semantic target before DONE.',
        acceptanceCriteria: ['Canonical semantic target completes'], allowedPaths: [], forbiddenPaths: [],
        checks: [], constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
      });
    }
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store, forgeWorkflowSupervisorValidators());
    const task = control.registerTask({
      taskId: 'supervisor:semantic-binding-revision',
      conversationId: '19191919-2828-3737-4646-555555555555',
      conversationUrl: 'https://chatgpt.com/c/19191919-2828-3737-4646-555555555555',
      objective: 'Continue the canonical Work until its semantic outcome is complete.',
      completionContract: { kind: 'model_semantic_completion', controller_home: root, repo_id: repoId },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, repo_id: repoId },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    const effect = control.reserveEnrollment(task.taskId, 'fx_semantic_binding_1234567890');
    store.recordEffectDispatchStarted(effect.effectId, 1, 'semantic-binding-dispatch');
    const objectiveSha = createHash('sha256').update(task.objective).digest('hex');
    const contractSha = workflowSupervisorCompletionContractSha256(task.completionContract);
    const revised = control.reviseTaskObjective({
      taskId: task.taskId, objective: task.objective, expectedObjectiveSha256: objectiveSha,
      expectedCompletionContractSha256: contractSha, workId, requestId: 'bind-work-1', authorizedBy: 'user',
    });
    expect(revised).toMatchObject({
      changed: false, deduplicated: false, semanticBindingChanged: true,
      task: { taskId: task.taskId, conversationId: task.conversationId, completionContract: { work_id: workId } },
    });
    expect(revised.refreshedEffect).toBeUndefined();
    expect(store.getEffect(effect.effectId)?.prompt).toBe(effect.prompt);
    const validate = forgeWorkflowSupervisorValidators().completionContract!;
    expect(await validate(revised.task, { action: 'DONE' } as any)).toMatchObject({ valid: false, reason: 'work_not_completed' });

    const duplicate = control.reviseTaskObjective({
      taskId: task.taskId, objective: task.objective, expectedObjectiveSha256: objectiveSha,
      expectedCompletionContractSha256: contractSha, workId, requestId: 'bind-work-1', authorizedBy: 'user',
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.completionContractSha256).toBe(workflowSupervisorCompletionContractSha256(revised.task.completionContract));
    expect(() => control.reviseTaskObjective({
      taskId: task.taskId, objective: task.objective, expectedObjectiveSha256: objectiveSha,
      expectedCompletionContractSha256: contractSha, workId, requestId: 'bind-stale-contract', authorizedBy: 'user',
    })).toThrow('WORKFLOW_SUPERVISOR_COMPLETION_CONTRACT_REVISION_CONFLICT');
    expect(() => control.reviseTaskObjective({
      taskId: task.taskId, objective: task.objective, expectedObjectiveSha256: objectiveSha,
      expectedCompletionContractSha256: revised.completionContractSha256, workId: otherWorkId,
      requestId: 'bind-conflicting-target', authorizedBy: 'user',
    })).toThrow('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_CONFLICT');

    expect(() => control.registerTask({
      taskId: task.taskId, conversationId: task.conversationId, conversationUrl: task.conversationUrl,
      objective: task.objective, completionContract: { kind: 'forge_work_done', controller_home: root, repo_id: repoId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', bootstrap: false, repo_id: repoId },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', controller_home: root, repo_id: repoId },
    })).toThrow('WORKFLOW_SUPERVISOR_SEMANTIC_BINDING_CONFLICT');
    const upgraded = control.registerTask({
      taskId: task.taskId, conversationId: task.conversationId, conversationUrl: task.conversationUrl,
      objective: task.objective, completionContract: { kind: 'forge_work_done', controller_home: root, repo_id: repoId, work_id: workId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', bootstrap: false, repo_id: repoId },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', controller_home: root, repo_id: repoId, work_id: workId },
    });
    expect(upgraded.completionContract.work_id).toBe(workId);
    control.stopTask(task.taskId, 'Finish the binding regression fixture.');
    expect(() => control.reviseTaskObjective({
      taskId: task.taskId, objective: task.objective, expectedObjectiveSha256: objectiveSha,
      expectedCompletionContractSha256: workflowSupervisorCompletionContractSha256(upgraded.completionContract),
      workId, requestId: 'bind-after-terminal', authorizedBy: 'user',
    })).toThrow('WORKFLOW_SUPERVISOR_TASK_TERMINAL');
    store.close();
  });

  test('standalone Supervisor uses only a uniquely bound canonical conversation to resume its Work', () => {
    const fx = fixture();
    const conversationId = 'b2222222-3333-4444-5555-666666666666';
    const workId = 'work-standalone-resume-concrete';
    const objective = 'Run the pending exact-target regression before continuing delivery.';
    createWorkContract(fx.store, {
      workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId,
      objective, acceptanceCriteria: ['Regression passes'],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
    });
    const task = {
      taskId: 'supervisor:standalone-resume-concrete',
      conversationId,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Unfinished autonomous Forge delivery',
      completionContract: { repo_id: fx.repository.repoId, controller_home: fx.controllerHome },
      continuationPolicy: { kind: 'standalone_supervisor' },
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const hooks = forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome);
    expect(hooks.canonicalObjectiveForTask?.(task)).toBeUndefined();
    bindChatgptWorkConversation(fx.store, { workId, conversationUrl: task.conversationUrl });
    expect(hooks.canonicalObjectiveForTask?.(task)).toBeUndefined();
    expect(hooks.advisoryCognitionForTask?.(task)).toContain(objective);
    expect(hooks.workProgressFingerprint?.(task)).toMatch(/^[0-9a-f]{64}$/);
    const siblingId = 'work-standalone-resume-ambiguous';
    createWorkContract(fx.store, {
      workId: siblingId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId,
      objective: 'Unrelated sibling', acceptanceCriteria: [],
      allowedPaths: [], forbiddenPaths: [], checks: [],
      constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
    });
    bindChatgptWorkConversation(fx.store, { workId: siblingId, conversationUrl: task.conversationUrl });
    expect(hooks.canonicalObjectiveForTask?.(task)).toBeUndefined();
    expect(hooks.workProgressFingerprint?.(task)).toBeUndefined();
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

  test('keeps complete 8k durable goals independent from compact outbound prompts', () => {
    const base = {
      taskId: 'task-exact-objective-bound',
      conversationId: 'ababcdcd-abcd-abcd-abcd-abcdefabcdef',
      conversationUrl: 'https://chatgpt.com/c/ababcdcd-abcd-abcd-abcd-abcdefabcdef',
      objective: 'A'.repeat(7_950),
      completionContract: {},
      continuationPolicy: {},
      userBlockerPolicy: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(base.objective.length).toBeLessThanOrEqual(8_000);
    const prompt = renderSupervisorPrompt(base, 'fx_12345678', 'enrollment');
    expect(Array.from(prompt).length).toBeLessThanOrEqual(500);
    expect(prompt).toContain('\nreceipt:' + supervisorReceiptChallenge(base, 'fx_12345678'));
    expect(prompt).toContain('目标摘录：');
    expect(prompt).toContain('supervisor_task get');
    const legacyPrompt = renderSupervisorPrompt({ ...base, objective: 'L'.repeat(7_950) }, 'fx_12345678', 'continuation');
    expect(Array.from(legacyPrompt).length).toBeLessThanOrEqual(4_000);
    expect(legacyPrompt).toContain('task_id:' + JSON.stringify(base.taskId));

    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-objective-bound-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor'));
    expect(() => store.registerTask({ ...base, objective: 'x'.repeat(8_001) }))
      .toThrow('WORKFLOW_SUPERVISOR_OBJECTIVE_TOO_LARGE');
    expect(store.getTask(base.taskId)).toBeUndefined();
    expect(store.registerTask(base).objective).toBe(base.objective);
    store.close();
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

    expect(prompt).toContain('\nreceipt:' + supervisorReceiptChallenge(task, effectId));
    expect(Array.from(prompt).length).toBeLessThanOrEqual(4_000);
    expect(prompt).not.toContain('automation.receipt:');
    expect(prompt).not.toContain('最后一次 Forge 调用');
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

    // The installed old extension collapsed newlines in an already-finished
    // assistant reply. Retain one causal parser rather than rebind providers.
    const completedReply = `本轮完成了实际检查。\n\nC ${supervisorReceiptChallenge(task, effectId)}`;
    const flattened = completedReply.replace(/\s+/g, ' ').trim();
    expect(hasCommittedSupervisorEnvelope(flattened)).toBe(true);
    expect(parseSupervisorCompletion(flattened, { task, effectId, prompt }).proposal)
      .toMatchObject({ action: 'CONTINUE', sourceEffectId: effectId, checkpoint: '本轮完成了实际检查。' });
    expect(() => parseSupervisorCompletion('本轮完成。 C 0000000', { task, effectId, prompt }))
      .toThrow('WORKFLOW_SUPERVISOR_COMPACT_RECEIPT_CHALLENGE_MISMATCH');
    const inlineWithNewlines = `本轮完成了实际检查。\n仍在叙述 C ${supervisorReceiptChallenge(task, effectId)}`;
    expect(hasCommittedSupervisorEnvelope(inlineWithNewlines)).toBe(false);
    expect(() => parseSupervisorCompletion(inlineWithNewlines, { task, effectId, prompt }))
      .toThrow('WORKFLOW_SUPERVISOR_END_MARKER_REQUIRED');

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

  test('Review REVISE joins the original standalone CONTINUE without second effect or stale-head approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-review-original-writer-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const task = control.registerTask({
      taskId: 'task-review-original-writer',
      conversationId: '90909090-1111-2222-3333-444444444444',
      conversationUrl: 'https://chatgpt.com/c/90909090-1111-2222-3333-444444444444',
      objective: 'Deliver and review the original PR without a replacement writer.',
      completionContract: { repo_id: 'repo-original' },
      continuationPolicy: { kind: 'standalone_supervisor' },
      userBlockerPolicy: {},
    });
    const notice = {
      taskId: task.taskId, repoId: 'repo-original', prNumber: 446,
      reviewedHeadSha: 'a'.repeat(40), currentHeadSha: 'a'.repeat(40),
      reviewId: 'review-42', source: 'independent_reviewer' as const, outcome: 'REVISE' as const,
    };
    const source = control.reserveEnrollment(task.taskId);
    control.observeEffect({ effectId: source.effectId, observationId: 'review-source-applied', outcome: 'applied' });
    expect(control.observeReviewNotice(notice)).toMatchObject({ deduplicated: false, deferred: true });
    expect(control.observeReviewNotice(notice)).toMatchObject({ deduplicated: true, deferred: true });
    // Stale findings remain useful for REVISE, but never authorize the new HEAD.
    expect(control.observeReviewNotice({ ...notice, currentHeadSha: 'b'.repeat(40) }))
      .toMatchObject({ deduplicated: true, deferred: true });
    expect(control.observeReviewNotice({ ...notice, reviewId: 'review-stale', currentHeadSha: 'b'.repeat(40) }))
      .toMatchObject({ deduplicated: false, deferred: true });
    expect(() => control.observeReviewNotice({ ...notice, repoId: 'repo-foreign' })).toThrow('WORKFLOW_SUPERVISOR_REVIEW_REPOSITORY_MISMATCH');
    expect(control.taskStall(task.taskId).state).not.toBe('deliverable');
    const completion = await control.observeAssistantTurn({
      taskId: task.taskId, conversationId: task.conversationId,
      responseText: renderSupervisorReceipt(task, source.effectId, 'CONTINUE'),
    });
    expect(completion.action).toBe('CONTINUE');
    expect(completion.successorEffect?.prompt).toContain('receipt review-42');
    expect(completion.successorEffect?.prompt).toContain('[UNVERIFIED STALE_HEAD]');
    expect(completion.successorEffect?.prompt).toContain('NOT ACCEPTANCE');
    expect(completion.successorEffect?.prompt).toContain('REVISE');
    expect(completion.successorEffect?.prompt).toContain('SAME PR/branch');
    expect(store.listPendingReviewNotices()).toHaveLength(0);
    const after = await control.observeAssistantTurn({
      taskId: task.taskId, conversationId: task.conversationId,
      responseText: renderSupervisorReceipt(task, source.effectId, 'CONTINUE'),
    });
    expect(after.successorEffect?.effectId).toBe(completion.successorEffect?.effectId);
    expect(after.deduplicated).toBe(true);
    expect(control.taskStall(task.taskId)).toMatchObject({ state: 'deliverable', effectId: completion.successorEffect?.effectId });
    store.close();
  });

  test('WAIT is durable and only the exact bound Scheduler occurrence can wake the same task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-scheduled-wake-'));
    roots.push(root);
    let nowMs = Date.now();
    const store = new WorkflowSupervisorStore(root, { now: () => nowMs });
    const control = new WorkflowSupervisorControlPlane(store, {
      completionContract: async () => ({ valid: true, reason: 'completion accepted' }),
      userBlockerPolicy: async () => ({ valid: true, reason: 'exact user blocker accepted' }),
    });
    const task = control.registerTask({
      taskId: 'task-scheduled-wake',
      conversationId: 'abababab-1111-2222-3333-444444444444',
      conversationUrl: 'https://chatgpt.com/c/abababab-1111-2222-3333-444444444444',
      objective: 'Run the same Gmail routine once per scheduled occurrence.',
      completionContract: { repo_id: 'repo-scheduled-wake', work_id: 'work-scheduled-wake' },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: {},
    });
    const unscheduledEffectId = 'fx_12345678';
    expect(() => parseSupervisorCompletion(renderSupervisorReceipt(task, unscheduledEffectId, 'WAIT'), {
      task, effectId: unscheduledEffectId,
    })).toThrow('WORKFLOW_SUPERVISOR_WAIT_NOT_SCHEDULED');

    const pendingBeforeBinding = control.reserveEnrollment(task.taskId);
    expect(pendingBeforeBinding.prompt).not.toContain('当日完 W');
    const bound = control.bindScheduledWake({
      taskId: task.taskId, repoId: 'repo-scheduled-wake', workId: 'work-scheduled-wake', scheduleId: 'SCH-daily-gmail',
    });
    expect(bound.task.continuationPolicy.scheduled_wake_schedule_id).toBe('SCH-daily-gmail');
    expect(bound.changed).toBe(true);
    expect(control.getEffect(pendingBeforeBinding.effectId)?.prompt).toContain('当日完 W');
    expect(control.bindScheduledWake({
      taskId: task.taskId, repoId: 'repo-scheduled-wake', workId: 'work-scheduled-wake', scheduleId: 'SCH-daily-gmail',
    }).deduplicated).toBe(true);
    expect(() => control.bindScheduledWake({
      taskId: task.taskId, repoId: 'repo-scheduled-wake', workId: 'work-scheduled-wake', scheduleId: 'SCH-other',
    })).toThrow('WORKFLOW_SUPERVISOR_SCHEDULE_BINDING_CONFLICT');

    const refreshed = control.getTask(task.taskId)!;
    const enrollment = control.reserveEnrollment(task.taskId);
    expect(enrollment.prompt).toContain('当日完 W');
    control.observeEffect({ effectId: enrollment.effectId, observationId: 'scheduled-wake-applied', outcome: 'applied' });
    const receipt = renderSupervisorReceipt(refreshed, enrollment.effectId, 'WAIT');
    const completion = await control.observeAssistantTurn({
      taskId: task.taskId, conversationId: task.conversationId, responseText: receipt,
    });
    expect(completion).toMatchObject({ action: 'WAIT', terminal: false });
    expect(completion.successorEffect).toBeUndefined();
    const duplicateWait = await control.observeAssistantTurn({
      taskId: task.taskId, conversationId: task.conversationId, responseText: receipt,
    });
    expect(duplicateWait).toMatchObject({ action: 'WAIT', terminal: false, deduplicated: true });
    nowMs += 4 * 60_000;
    expect(control.taskStall(task.taskId)).toMatchObject({
      state: 'waiting', scheduleId: 'SCH-daily-gmail', completionFingerprint: completion.completionFingerprint,
    });

    const wakeInput = { taskId: task.taskId, scheduleId: 'SCH-daily-gmail', occurrenceId: 'occurrence-2026-10-17T08:00+08:00' };
    const wake = control.wakeScheduledTask(wakeInput);
    expect(wake.deduplicated).toBe(false);
    expect(wake.effect).toMatchObject({ kind: 'continuation', sourceCompletionFingerprint: completion.completionFingerprint });
    const duplicate = control.wakeScheduledTask(wakeInput);
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.effect.effectId).toBe(wake.effect.effectId);
    expect(control.taskStall(task.taskId)).toMatchObject({ state: 'deliverable', effectId: wake.effect.effectId, mode: 'send' });
    expect(() => control.wakeScheduledTask({
      ...wakeInput, occurrenceId: 'occurrence-2026-10-18T08:00+08:00',
    })).toThrow('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_CAUSAL_OBLIGATION_PENDING');

    control.observeEffect({ effectId: wake.effect.effectId, observationId: 'scheduled-wake-second-turn-applied', outcome: 'applied' });
    const staleDone = await control.observeAssistantTurn({
      taskId: task.taskId,
      conversationId: task.conversationId,
      responseText: renderSupervisorReceipt(control.getTask(task.taskId)!, wake.effect.effectId, 'DONE'),
    });
    expect(staleDone).toMatchObject({ action: 'DONE', terminal: false });
    expect(staleDone.successorEffect?.kind).toBe('correction');
    const correction = staleDone.successorEffect!;
    control.observeEffect({ effectId: correction.effectId, observationId: 'scheduled-wake-correction-applied', outcome: 'applied' });
    const nextWait = await control.observeAssistantTurn({
      taskId: task.taskId,
      conversationId: task.conversationId,
      responseText: renderSupervisorReceipt(control.getTask(task.taskId)!, correction.effectId, 'WAIT'),
    });
    expect(nextWait).toMatchObject({ action: 'WAIT', terminal: false });
    const nextWake = control.wakeScheduledTask({
      taskId: task.taskId,
      scheduleId: 'SCH-daily-gmail',
      occurrenceId: 'occurrence-2026-10-18T08:00+08:00',
    });
    expect(nextWake.deduplicated).toBe(false);
    expect(nextWake.effect.effectId).not.toBe(wake.effect.effectId);
    expect(control.wakeScheduledTask({
      taskId: task.taskId,
      scheduleId: 'SCH-daily-gmail',
      occurrenceId: 'occurrence-2026-10-18T08:00+08:00',
    })).toMatchObject({ deduplicated: true, effect: { effectId: nextWake.effect.effectId } });
    control.observeEffect({ effectId: nextWake.effect.effectId, observationId: 'scheduled-wake-user-blocker-applied', outcome: 'applied' });
    const userBlocker = await control.observeAssistantTurn({
      taskId: task.taskId,
      conversationId: task.conversationId,
      responseText: renderSupervisorReceipt(control.getTask(task.taskId)!, nextWake.effect.effectId, 'NEEDS_USER'),
    });
    expect(userBlocker).toMatchObject({ action: 'NEEDS_USER', terminal: false });
    expect(userBlocker.successorEffect?.kind).toBe('correction');
    expect(control.taskStall(task.taskId)).toMatchObject({
      state: 'deliverable', effectId: userBlocker.successorEffect?.effectId, mode: 'send',
    });
    store.close();
  });

  test('a completed provider recovery settles the failed applied parent and permits the next scheduled wake', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-recovery-wait-settlement-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'task-gmail-recovered-wait';
    const conversationId = 'abababab-2222-3333-4444-555555555555';
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Resume the same daily Gmail task from the durable WAIT receipt.',
      completionContract: { repo_id: 'repo-gmail', work_id: 'work-gmail' },
      continuationPolicy: { kind: 'forge_goal_outer_turn' },
      userBlockerPolicy: {},
    });
    control.bindScheduledWake({ taskId, repoId: 'repo-gmail', workId: 'work-gmail', scheduleId: 'SCH-gmail' });
    const source = control.reserveEnrollment(taskId);
    control.observeEffect({ effectId: source.effectId, observationId: 'source-applied', outcome: 'applied' });
    const recovery = store.reserveEffect({
      taskId, effectId: 'fx_12345678123456781234567812345678', kind: 'recovery',
      originKey: `provider-recovery:${source.effectId}`,
      prompt: 'Resume the applied Gmail turn after an observed stream failure.',
    });
    expect(store.recordEffectDispatchStarted(recovery.effectId, 1, 'recovery-dispatch')).toBe(true);
    control.observeEffect({ effectId: recovery.effectId, observationId: 'recovery-applied', outcome: 'applied' });
    expect(store.hasAppliedEffectAwaitingCompletion(taskId)).toBe(true);
    expect(control.taskStall(taskId).state).toBe('spaced');
    const blockedWake = { taskId, scheduleId: 'SCH-gmail', occurrenceId: '2026-10-22' };
    expect(() => control.wakeScheduledTask(blockedWake))
      .toThrow('WORKFLOW_SUPERVISOR_SCHEDULED_WAKE_CAUSAL_OBLIGATION_PENDING');

    const receipt = await control.observeAssistantTurn({
      taskId, conversationId,
      responseText: renderSupervisorReceipt(control.getTask(taskId)!, recovery.effectId, 'WAIT'),
    });
    expect(receipt).toMatchObject({ action: 'WAIT', terminal: false });
    // Parent was genuinely applied, never directly completed, and never
    // replayed. The completed child is the exact subsequent causal authority.
    expect(store.getEffect(source.effectId)).toBeDefined();
    expect(store.hasAppliedEffectAwaitingCompletion(taskId)).toBe(false);
    expect(control.taskStall(taskId)).toMatchObject({
      state: 'waiting', scheduleId: 'SCH-gmail', completionFingerprint: receipt.completionFingerprint,
    });
    const wake = control.wakeScheduledTask(blockedWake);
    expect(wake).toMatchObject({ deduplicated: false, effect: { kind: 'continuation' } });
    expect(control.wakeScheduledTask(blockedWake)).toMatchObject({
      deduplicated: true, effect: { effectId: wake.effect.effectId },
    });
    store.close();
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

    reviseWorkSemanticContext(fx.store, predecessorWorkId, { expectedRevision: 1, state: 'completed' });
    expect(forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome).browserTaskActive?.(task)).toBe(true);
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


  test('does not resurrect a stopped Work bootstrap task or re-register a live one after Work wording changes', async () => {
    const fx = fixture();
    const stoppedWorkId = 'work-stopped-bootstrap-after-replacement';
    const liveWorkId = 'work-existing-bootstrap-after-work-update';
    for (const workId of [stoppedWorkId, liveWorkId]) {
      createWorkContract(fx.store, {
        workId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId,
        objective: 'Updated Work wording must not become an implicit Supervisor task revision.',
        acceptanceCriteria: ['Existing Supervisor Task/effect remains the only outer-turn authority'],
        allowedPaths: [], forbiddenPaths: [], checks: [],
        constraints: { workspaceMode: 'current' },
        requestedBy: 'chatgpt', dispatchState: 'running',
      });
    }
    const supervisorRoot = join(fx.controllerHome, 'supervisor');
    mkdirSync(supervisorRoot, { recursive: true });
    const supervisorStore = new WorkflowSupervisorStore(supervisorRoot);
    const control = new WorkflowSupervisorControlPlane(supervisorStore);
    const register = (workId: string) => control.registerTask({
      taskId: `forge:${fx.repository.repoId}:work:${workId}`,
      conversationId: `bootstrap:${workId}`,
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Original Supervisor goal must remain immutable without explicit CAS revision.',
      completionContract: { kind: 'forge_work_done', controller_home: fx.controllerHome,
        repo_id: fx.repository.repoId, work_id: workId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', bootstrap: true,
        outer_turn_owner: 'workflow_supervisor' },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user',
        controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: workId },
    });
    const stopped = register(stoppedWorkId);
    const stoppedEffect = control.reserveEnrollment(stopped.taskId);
    expect(control.stopTask(stopped.taskId, 'Historical task explicitly replaced.').terminal).toBe('STOPPED');
    const live = register(liveWorkId);
    const liveEffect = control.reserveEnrollment(live.taskId);
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
      expect(workflowSupervisorBoundaryForWork(fx.store, stoppedWorkId).status).toBe('conversation_pending');
      expect(workflowSupervisorBoundaryForWork(fx.store, liveWorkId).status).toBe('conversation_pending');
      expect(await ensureWorkflowSupervisorEnrollmentForWork(fx.store, stoppedWorkId)).toEqual({
        status: 'lower_layer_not_ready', reason: 'WORKFLOW_SUPERVISOR_TASK_TERMINAL',
      });
      expect(await ensureWorkflowSupervisorEnrollmentForWork(fx.store, liveWorkId)).toEqual({
        status: 'enrolled', taskId: live.taskId, effectId: liveEffect.effectId,
      });
      expect(control.taskStall(stopped.taskId)).toMatchObject({ state: 'terminal' });
      expect(supervisorStore.getEffectByOriginKey(`enrollment:${stopped.taskId}`)?.effectId)
        .toBe(stoppedEffect.effectId);
      expect(supervisorStore.getEffectByOriginKey(`enrollment:${live.taskId}`)?.effectId)
        .toBe(liveEffect.effectId);
      expect(supervisorStore.listTasks()).toHaveLength(2);
      expect(control.getTask(stopped.taskId)?.objective).toBe(stopped.objective);
      expect(control.getTask(live.taskId)?.objective).toBe(live.objective);
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

  test('derives unattended release proof only for causal CONTINUE -> CONTINUE -> DONE across a Runtime reconnect', async () => {
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
    const boundaryAfterFirstSend = new Date(Date.now() + 20).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const firstCompletion = {
      completionFingerprint: 'completion-proof-1', taskId, sourceEffectId: first.effectId, action: 'CONTINUE' as const,
      responseSha256: 'response-1', controlBlockSha256: 'control-1',
      proposal: { action: 'CONTINUE' as const, sourceEffectId: first.effectId, checkpoint: 'round-1', reason: 'continue', evidence: [], conversationId, taskId, supervisorState: 'running' as const },
      committedAt: new Date().toISOString(),
    };
    const second = store.commitCompletion(firstCompletion, { effectId: 'fx_22222222222222222222222222222222', kind: 'continuation', prompt: 'round two' }).successorEffect!;
    expect(store.recordEffectDispatchStarted(second.effectId, 1, 'dispatch-2', { active_release_id: releaseId, runtime_instance_id: 'runtime-a' })).toBe(true);
    store.recordEffectObservation(second.effectId, 'applied-2', 'applied');
    const secondCompletion = {
      completionFingerprint: 'completion-proof-2', taskId, sourceEffectId: second.effectId, action: 'CONTINUE' as const,
      responseSha256: 'response-2', controlBlockSha256: 'control-2',
      proposal: { action: 'CONTINUE' as const, sourceEffectId: second.effectId, checkpoint: 'round-2', reason: 'continue', evidence: [], conversationId, taskId, supervisorState: 'running' as const },
      committedAt: new Date().toISOString(),
    };
    const secondResult = store.commitCompletion(secondCompletion, { effectId: 'fx_33333333333333333333333333333333', kind: 'continuation', prompt: 'round three' });
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore })).toBeUndefined();
    const third = secondResult.successorEffect!;
    expect(store.recordEffectDispatchStarted(third.effectId, 1, 'dispatch-3', { active_release_id: releaseId, runtime_instance_id: 'runtime-b' })).toBe(true);
    store.recordEffectObservation(third.effectId, 'unknown-3', 'unknown');
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore })).toBeUndefined();
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
      completionFingerprints: ['completion-proof-1', 'completion-proof-2', 'completion-proof-3'],
      sourceEffectIds: [first.effectId, second.effectId, third.effectId],
      runtimeInstanceIds: ['runtime-a', 'runtime-b'],
    });
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore: boundaryAfterFirstSend })).toBeUndefined();
    store.close();
  });

  test('rejects release proof when DONE is not the causal successor of the second CONTINUE', () => {
    const fx = fixture();
    const store = new WorkflowSupervisorStore(join(fx.root, 'noncausal-continuation-proof-supervisor'));
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'forge:repo-proof:noncausal-conversation';
    const conversationId = 'noncausal-conversation';
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Reject a terminal completion sourced from an unrelated applied effect.',
      completionContract: { kind: 'forge_work_done', repo_id: 'repo-proof', work_id: 'work-proof' },
      continuationPolicy: { kind: 'forge_goal_outer_turn', repo_id: 'repo-proof' },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', repo_id: 'repo-proof', work_id: 'work-proof' },
    });
    const notBefore = new Date(Date.now() - 1_000).toISOString();
    const releaseId = 'release-proof';
    const dispatchApplied = (effectId: string, index: number, runtimeInstanceId: string) => {
      expect(store.recordEffectDispatchStarted(effectId, 1, `noncausal-dispatch-${index}`, {
        active_release_id: releaseId, runtime_instance_id: runtimeInstanceId,
      })).toBe(true);
      store.recordEffectObservation(effectId, `noncausal-applied-${index}`, 'applied');
    };
    const completion = (fingerprint: string, sourceEffectId: string, action: 'CONTINUE' | 'DONE', checkpoint: string) => ({
      completionFingerprint: fingerprint, taskId, sourceEffectId, action,
      responseSha256: `response-${checkpoint}`, controlBlockSha256: `control-${checkpoint}`,
      proposal: {
        action, sourceEffectId, checkpoint, reason: checkpoint, evidence: [], conversationId, taskId,
        supervisorState: (action === 'DONE' ? 'done' : 'running') as 'done' | 'running',
      },
      committedAt: new Date().toISOString(),
    });
    const first = control.reserveEnrollment(taskId, 'fx_77777777777777777777777777777777');
    dispatchApplied(first.effectId, 1, 'runtime-a');
    const firstResult = store.commitCompletion(completion('noncausal-c1', first.effectId, 'CONTINUE', 'round-1'), {
      effectId: 'fx_88888888888888888888888888888888', kind: 'continuation', prompt: 'round two',
    });
    const second = firstResult.successorEffect!;
    dispatchApplied(second.effectId, 2, 'runtime-a');
    const secondResult = store.commitCompletion(completion('noncausal-c2', second.effectId, 'CONTINUE', 'round-2'), {
      effectId: 'fx_99999999999999999999999999999999', kind: 'continuation', prompt: 'round three',
    });
    const unrelatedDoneEffect = store.reserveEffect({
      taskId, effectId: 'fx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'continuation',
      originKey: 'release-proof-unrelated-done', sourceCompletionFingerprint: 'not-the-second-completion',
      prompt: 'unrelated terminal source',
    });
    expect(secondResult.successorEffect).toBeDefined();
    dispatchApplied(unrelatedDoneEffect.effectId, 3, 'runtime-b');
    const finalCompletion = completion('noncausal-done', unrelatedDoneEffect.effectId, 'DONE', 'round-3');
    store.commitCompletion(finalCompletion);
    store.resolveTerminal({
      completionFingerprint: finalCompletion.completionFingerprint, taskId, action: 'DONE', accepted: true, reason: 'accepted',
    });
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore })).toBeUndefined();
    store.close();
  });

  test('rejects a terminal receipt that predates its DONE assistant completion', () => {
    const fx = fixture();
    const store = new WorkflowSupervisorStore(join(fx.root, 'stale-terminal-proof-supervisor'));
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'forge:repo-proof:stale-terminal-conversation';
    const conversationId = 'stale-terminal-conversation';
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Reject a terminal receipt that was recorded before the terminal assistant completion.',
      completionContract: { kind: 'forge_work_done', repo_id: 'repo-proof', work_id: 'work-proof' },
      continuationPolicy: { kind: 'forge_goal_outer_turn', repo_id: 'repo-proof' },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', repo_id: 'repo-proof', work_id: 'work-proof' },
    });
    const notBefore = new Date(Date.now() - 1_000).toISOString();
    const releaseId = 'release-proof';
    const dispatchApplied = (effectId: string, index: number, runtimeInstanceId: string) => {
      expect(store.recordEffectDispatchStarted(effectId, 1, `stale-terminal-dispatch-${index}`, {
        active_release_id: releaseId, runtime_instance_id: runtimeInstanceId,
      })).toBe(true);
      store.recordEffectObservation(effectId, `stale-terminal-applied-${index}`, 'applied');
    };
    const completion = (fingerprint: string, sourceEffectId: string, action: 'CONTINUE' | 'DONE', checkpoint: string) => ({
      completionFingerprint: fingerprint, taskId, sourceEffectId, action,
      responseSha256: `response-${checkpoint}`, controlBlockSha256: `control-${checkpoint}`,
      proposal: {
        action, sourceEffectId, checkpoint, reason: checkpoint, evidence: [], conversationId, taskId,
        supervisorState: (action === 'DONE' ? 'done' : 'running') as 'done' | 'running',
      },
      committedAt: new Date().toISOString(),
    });
    const first = control.reserveEnrollment(taskId, 'fx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    dispatchApplied(first.effectId, 1, 'runtime-a');
    const firstResult = store.commitCompletion(completion('stale-terminal-c1', first.effectId, 'CONTINUE', 'round-1'), {
      effectId: 'fx_cccccccccccccccccccccccccccccccc', kind: 'continuation', prompt: 'round two',
    });
    const second = firstResult.successorEffect!;
    dispatchApplied(second.effectId, 2, 'runtime-a');
    const secondResult = store.commitCompletion(completion('stale-terminal-c2', second.effectId, 'CONTINUE', 'round-2'), {
      effectId: 'fx_dddddddddddddddddddddddddddddddd', kind: 'continuation', prompt: 'round three',
    });
    const third = secondResult.successorEffect!;
    dispatchApplied(third.effectId, 3, 'runtime-b');
    const finalCompletion = completion('stale-terminal-done', third.effectId, 'DONE', 'round-3');
    store.resolveTerminal({
      completionFingerprint: finalCompletion.completionFingerprint, taskId, action: 'DONE', accepted: true, reason: 'accepted',
    });
    store.commitCompletion(finalCompletion);
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore })).toBeUndefined();
    store.close();
  });

  test('rejects out-of-order CONTINUE -> DONE -> CONTINUE release history', () => {
    const fx = fixture();
    const store = new WorkflowSupervisorStore(join(fx.root, 'out-of-order-continuation-proof-supervisor'));
    const control = new WorkflowSupervisorControlPlane(store);
    const taskId = 'forge:repo-proof:out-of-order-conversation';
    const conversationId = 'out-of-order-conversation';
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Reject release proof when the final three actions are not C -> C -> D.',
      completionContract: { kind: 'forge_work_done', repo_id: 'repo-proof', work_id: 'work-proof' },
      continuationPolicy: { kind: 'forge_goal_outer_turn', repo_id: 'repo-proof' },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', repo_id: 'repo-proof', work_id: 'work-proof' },
    });
    const notBefore = new Date(Date.now() - 1_000).toISOString();
    const releaseId = 'release-proof';
    const dispatchApplied = (effectId: string, index: number, runtimeInstanceId: string) => {
      expect(store.recordEffectDispatchStarted(effectId, 1, `out-of-order-dispatch-${index}`, {
        active_release_id: releaseId, runtime_instance_id: runtimeInstanceId,
      })).toBe(true);
      store.recordEffectObservation(effectId, `out-of-order-applied-${index}`, 'applied');
    };
    const completion = (fingerprint: string, sourceEffectId: string, action: 'CONTINUE' | 'DONE', checkpoint: string) => ({
      completionFingerprint: fingerprint, taskId, sourceEffectId, action,
      responseSha256: `response-${checkpoint}`, controlBlockSha256: `control-${checkpoint}`,
      proposal: {
        action, sourceEffectId, checkpoint, reason: checkpoint, evidence: [], conversationId, taskId,
        supervisorState: (action === 'DONE' ? 'done' : 'running') as 'done' | 'running',
      },
      committedAt: new Date().toISOString(),
    });
    const first = control.reserveEnrollment(taskId, 'fx_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    dispatchApplied(first.effectId, 1, 'runtime-a');
    const firstResult = store.commitCompletion(completion('out-of-order-c1', first.effectId, 'CONTINUE', 'round-1'), {
      effectId: 'fx_ffffffffffffffffffffffffffffffff', kind: 'continuation', prompt: 'round two',
    });
    const second = firstResult.successorEffect!;
    dispatchApplied(second.effectId, 2, 'runtime-a');
    const secondResult = store.commitCompletion(completion('out-of-order-done', second.effectId, 'DONE', 'round-2'), {
      effectId: 'fx_00000000000000000000000000000001', kind: 'continuation', prompt: 'invalid post-DONE turn',
    });
    store.resolveTerminal({
      completionFingerprint: 'out-of-order-done', taskId, action: 'DONE', accepted: true, reason: 'accepted',
    });
    const third = secondResult.successorEffect!;
    dispatchApplied(third.effectId, 3, 'runtime-b');
    store.commitCompletion(completion('out-of-order-c3', third.effectId, 'CONTINUE', 'round-3'));
    expect(control.continuationProof({ repoId: 'repo-proof', activeReleaseId: releaseId, notBefore })).toBeUndefined();
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
      const responseText = 'Meaningful progress.\n' + renderSupervisorReceipt(control.getTask(taskId)!, currentEffect.effectId, 'CONTINUE');
      const continued = await control.observeAssistantTurn({ taskId, conversationId, responseText });
      const replayed = await control.observeAssistantTurn({ taskId, conversationId, responseText });
      expect('successorEffect' in continued ? continued.successorEffect : undefined).toBeDefined();
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
    const ownedWorkId = `${workId}-owned`;
    const ownedConversationId = 'abababab-7878-efef-3434-343434343434';
    createWorkContract(fx.store, {
      workId: ownedWorkId, repoId: fx.repository.repoId, checkoutId: fx.repository.activeCheckoutId,
      objective: 'Exact Work-owned automation stops when this Work closes.', acceptanceCriteria: [],
      allowedPaths: [], forbiddenPaths: [], checks: [], constraints: { workspaceMode: 'current' },
      requestedBy: 'chatgpt', dispatchState: 'running',
    });
    bindChatgptWorkConversation(fx.store, { workId: ownedWorkId, conversationUrl: `https://chatgpt.com/c/${ownedConversationId}` });
    const ownedTaskId = `forge:${fx.repository.repoId}:work:${ownedWorkId}`;
    control.registerTask({
      taskId: ownedTaskId, conversationId: ownedConversationId, conversationUrl: `https://chatgpt.com/c/${ownedConversationId}`,
      objective: 'Work-owned continuation.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repository.repoId, work_id: ownedWorkId, kind: 'forge_work_done' },
      continuationPolicy: { kind: 'forge_goal_outer_turn' }, userBlockerPolicy: {},
    });
    control.reserveEnrollment(ownedTaskId);
    expect(control.browserTasks()).toHaveLength(2);

    reviseWorkSemanticContext(fx.store, workId, { expectedRevision: 1, state: 'completed' });
    reviseWorkSemanticContext(fx.store, ownedWorkId, { expectedRevision: 1, state: 'completed' });
    expect(control.browserTasks()).toHaveLength(1);
    expect(control.reconcileTerminalWorkBoundTasks()).toEqual([ownedTaskId]);
    expect(control.store.terminalAction(ownedTaskId)).toBe('STOPPED');
    expect(control.reconcileTerminalWorkBoundTasks()).toEqual([]);
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

test('bootstrap reconciles an applied leaf before dispatching its unstarted recovery child', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-recovery-order-'));
  roots.push(root);
  let nowMs = Date.now();
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => nowMs });
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'bootstrap-applied-before-recovery';
  control.registerTask({
    taskId,
    conversationId: `bootstrap:${taskId}`,
    conversationUrl: 'https://chatgpt.com/',
    objective: 'Reconcile an applied bootstrap effect before dispatching its recovery child.',
    completionContract: {},
    continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
    userBlockerPolicy: {},
  });
  const source = control.reserveEnrollment(taskId);
  expect(control.bootstrapBeginEffect({
    taskId, effectId: source.effectId, dispatchId: 'bootstrap-source-dispatch', dispatchGeneration: 1,
  })).toBe(true);
  control.bootstrapObserveEffect({
    taskId, effectId: source.effectId, observationId: 'bootstrap-source-applied', outcome: 'applied',
    reconciled: true,
  });
  const recovery = store.reserveEffect({
    taskId,
    effectId: 'fx_99999999999999999999999999999999',
    kind: 'recovery',
    originKey: `provider-recovery:${source.effectId}`,
    prompt: 'Resume the already-applied source effect without replaying it.',
  });

  expect(control.bootstrapPoll(taskId).command).toMatchObject({
    mode: 'reconcile', effectId: source.effectId, kind: 'enrollment',
  });
  control.bootstrapObserveEffect({
    taskId, effectId: source.effectId, observationId: 'bootstrap-source-still-unbound', outcome: 'unknown',
    evidence: { reconciliation: true, reason: 'bootstrap_target_not_observed' },
  });
  expect(control.bootstrapPoll(taskId).command).toBeUndefined();
  nowMs += 10_000;
  expect(control.bootstrapPoll(taskId).command).toMatchObject({
    mode: 'reconcile', effectId: source.effectId, kind: 'enrollment',
  });
  expect(store.effectDispatchBudget(recovery.effectId).generations).toBe(0);
});

test('unbound bootstrap applied observation is rejected before any ledger write', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-applied-prevalidation-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'bootstrap-unbound-applied';
  control.registerTask({
    taskId,
    conversationId: `bootstrap:${taskId}`,
    conversationUrl: 'https://chatgpt.com/',
    objective: 'Reject an alternate unbound applied writer.',
    completionContract: {},
    continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
    userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  expect(control.bootstrapBeginEffect({
    taskId, effectId: effect.effectId, dispatchId: 'bootstrap-unbound-dispatch', dispatchGeneration: 1,
  })).toBe(true);
  expect(() => control.bootstrapObserveEffect({
    taskId, effectId: effect.effectId, observationId: 'unbound-applied', outcome: 'applied',
  })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_APPLIED_REQUIRES_BOUND_CONVERSATION');
  expect(store.effectApplied(effect.effectId)).toBe(false);
  expect(store.nextBrowserEffect(taskId)).toMatchObject({ mode: 'reconcile', effect: { effectId: effect.effectId } });

  control.bindBootstrapConversation({
    taskId,
    conversationId: '6ad5b608-91dc-83ea-b059-c2427cb85db4',
    conversationUrl: 'https://chatgpt.com/c/6ad5b608-91dc-83ea-b059-c2427cb85db4',
  });
  control.bootstrapObserveEffect({
    taskId, effectId: effect.effectId, observationId: 'bound-applied', outcome: 'applied',
  });
  expect(store.effectApplied(effect.effectId)).toBe(true);
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

test('explicit browser repairs re-arm the same proven pre-send effect without changing release or minting generations', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-operator-preflight-repair-'));
  roots.push(root);
  const release = { id: 'browser-release-one' };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), {
    activeReleaseId: () => release.id,
  });
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'operator-repaired-browser-task';
  const conversationId = '28282828-3939-4848-9494-575757575757';
  control.registerTask({ taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    objective: 'Resume the same exact enrollment after fixing browser extension.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const effect = control.reserveEnrollment(taskId);
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_CHATGPT_EXTENSION_COMMAND_UNKNOWN');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  const input = { taskId, sourceEffectId: effect.effectId,
    requestId: 'operator-repaired-browser-extension-20261009',
    reason: 'Extension service worker reloaded and new provider is verified.',
    authorizedBy: 'user',
  };
  const repaired = control.recoverTask(input);
  expect(repaired.action).toBe('retry_authorized');
  expect(repaired.recoveryEffect.effectId).toBe(effect.effectId);
  expect(control.recoverTask(input).recoveryEffect.effectId).toBe(effect.effectId);
  expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(effect.effectId);
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  // This second local failure is a NEW durable failed preparation. The rearm
  // does not turn INSERT OR IGNORE into an unlimited retry loophole.
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_CHATGPT_FORGE_CHIP_NOT_BOUND');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(control.recoverTask({ ...input, requestId: 'operator-attempt-two',
    reason: 'Verified composer cleared after preserving the exact draft',
  }).recoveryEffect.effectId).toBe(effect.effectId);
  expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(effect.effectId);
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_REPAIR_NOT_SUFFICIENT');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  release.id = 'browser-release-two';
  // Explicit repairs never reset the existing automatic preparation ceiling.
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_PREPARE_FAILED');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  const secondReleaseRepair = control.recoverTask({ ...input, requestId: 'operator-repaired-browser-release-two' });
  expect(secondReleaseRepair.action).toBe('retry_authorized');
  expect(secondReleaseRepair.recoveryEffect.effectId).toBe(effect.effectId);
  expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(effect.effectId);
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_PREPARE_FAILED_AFTER_RELEASE_TWO_REARM');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(control.recoverTask({ ...input, requestId: 'operator-attempt-two-release-two',
    reason: 'Verified exact provider target repaired',
  }).recoveryEffect.effectId).toBe(effect.effectId);
  expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(effect.effectId);
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_REPAIR_NOT_SUFFICIENT');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  release.id = 'browser-release-three';
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  const thirdReleaseRepair = control.recoverTask({ ...input, requestId: 'operator-repaired-browser-release-three' });
  expect(thirdReleaseRepair.action).toBe('retry_authorized');
  expect(thirdReleaseRepair.recoveryEffect.effectId).toBe(effect.effectId);
  expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(effect.effectId);
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_PREPARE_FAILED_AFTER_RELEASE_THREE_REARM');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(control.recoverTask({ ...input, requestId: 'operator-attempt-two-release-three',
    reason: 'Verified refreshed extension provider',
  }).recoveryEffect.effectId).toBe(effect.effectId);
  expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(effect.effectId);
  store.recordEffectPreparationFailure(effect.effectId, 'COMPUTER_REPAIR_NOT_SUFFICIENT');
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  store.close();
});

test('F01 Supervisor never dispatches when Prepare callback times out after draft write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-f01-prepare-timeout-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'f01-prepare-timeout-task';
  const conversationId = '43434343-5656-7878-9090-151515151515';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId, conversationId, conversationUrl,
    objective: 'Never send after a lost Prepare acknowledgment.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const effect = control.reserveEnrollment(taskId);
  let draftWrites = 0;
  let sends = 0;
  const page: TestBrowserPage = {
    evaluate: async () => undefined as never,
    tabRef: () => ({ windowId: 'f01-window', tabId: 'f01-tab' }),
  };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [{ windowId: 'f01-window', tabId: 'f01-tab',
      active: true, url: conversationUrl, title: 'F01 timeout', browserProduct: 'chrome' }] }),
    reattach: async () => page,
    create: async () => { throw new Error('Must not replace the pinned conversation'); },
    close: async () => undefined,
    snapshot: async () => ({ url: conversationUrl, title: 'F01 timeout', latestUserText: '',
      latestAssistantResponse: '', composerText: '', isGenerating: false,
      providerActivityText: '', providerFailureText: '' }),
    preparePrompt: async () => {
      draftWrites++;
      return { ready: false as const, reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TAB_MESSAGE_TIMEOUT' };
    },
    dispatchPrompt: async () => { sends++; return { dispatched: true, confirmed: true }; },
  });
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort, nowMs: () => Date.now(), providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'), sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined, onError: () => undefined,
  });
  await adapter.runOnce();
  expect(draftWrites).toBe(1);
  expect(sends).toBe(0);
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  expect(store.latestEffectDispatch(effect.effectId)).toBeUndefined();
  await adapter.close();
  store.close();
});

test('Supervisor preparation rejection is durably release-fenced and never spends a provider generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-pre-send-boundary-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const release = { id: 'release-one' };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs, activeReleaseId: () => release.id });
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'pre-send-boundary-task';
  const conversationId = '43434343-5656-7878-9090-131313131313';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId, conversationId, conversationUrl,
    objective: 'Do not charge failed local preparation to a provider send.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const effect = control.reserveEnrollment(taskId);
  let preparationReady = false;
  let providerBusy = true;
  let preparations = 0;
  let sends = 0;
  const page: TestBrowserPage = {
    evaluate: async () => undefined as never,
    tabRef: () => ({ windowId: 'pre-send-window', tabId: 'pre-send-tab' }),
  };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [{ windowId: 'pre-send-window', tabId: 'pre-send-tab',
      active: true, url: conversationUrl, title: 'Pre-send boundary', browserProduct: 'chrome' }] }),
    reattach: async () => page,
    create: async () => { throw new Error('Never create a replacement conversation'); },
    close: async () => undefined,
    snapshot: async () => ({ url: conversationUrl, title: 'Pre-send boundary', latestUserText: '',
      latestAssistantResponse: '', composerText: '', isGenerating: false,
      providerActivityText: '', providerFailureText: '' }),
    preparePrompt: async () => { preparations++; return providerBusy
      ? { ready: false as const, reasonCode: 'provider_busy' }
      : preparationReady ? { ready: true as const } : { ready: false as const, reasonCode: 'FORGE_PLUGIN_NOT_BOUND' }; },
    dispatchPrompt: async () => { sends++; return { dispatched: true, confirmed: true }; },
  });
  const deps = { targetPort, nowMs: () => clock.nowMs, providerIdleGraceMs: 60_000,
    providerScopeKey: join(root, 'provider-scope'), sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>, clearInterval: () => undefined,
    onError: () => undefined };
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), deps);
  // Repeated provider activity, even across releases, must only defer locally:
  // no Send, no durable failed preflight, and no exhausted operator repair.
  for (const busyRelease of ['busy-release-one', 'busy-release-two', 'busy-release-three']) {
    release.id = busyRelease;
    await adapter.runOnce();
    clock.nowMs += 30 * 60_000;
  }
  expect(preparations).toBe(3);
  expect(store.nextBrowserEffect(taskId)).toMatchObject({ mode: 'send', effect: { effectId: effect.effectId } });
  expect(control.taskStall(taskId)).toMatchObject({ state: 'deliverable', effectId: effect.effectId });
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  providerBusy = false;
  release.id = 'release-one';
  for (let n = 0; n < 6; n++) { await adapter.runOnce(); clock.nowMs += 30 * 60_000; }
  expect(preparations).toBe(4);
  expect(sends).toBe(0);
  expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
  expect(control.taskStall(taskId)).toMatchObject({ state: 'spaced', reason: 'pre_send_infrastructure_blocked' });
  // Runtime restart must not reset the failed-preparation evidence.
  const reopened = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs, activeReleaseId: () => release.id });
  expect(reopened.nextBrowserEffect(taskId)).toBeUndefined();
  reopened.close();
  await adapter.close();
  release.id = 'release-two';
  // A repaired, independently booted Runtime is a new Computer observation
  // opportunity, not a refunded provider mutation or replacement effect.
  preparationReady = true;
  const repaired = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), deps);
  await repaired.runOnce();
  expect(preparations).toBe(5); // three transient deferrals + blocked preparation + recovered preparation
  expect(sends).toBe(1);
  expect(store.latestEffectDispatch(effect.effectId)?.generation).toBe(1);
  expect(store.latestEffectDispatch(effect.effectId)?.evidence).toMatchObject({ surface: 'computer-chatgpt-target' });
  await repaired.close();
  // Across unrelated deployments this effect remains capped at three distinct
  // failing preparations, including after restarts; none spends provider budget.
  const task2 = 'pre-send-bounded-task';
  control.registerTask({ taskId: task2, conversationId: '43434343-5656-7878-9090-141414141414',
    conversationUrl: 'https://chatgpt.com/c/43434343-5656-7878-9090-141414141414',
    objective: 'Never permit infinite failed preparation', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const effect2 = control.reserveEnrollment(task2);
  for (const id of ['release-three', 'release-four', 'release-five']) {
    release.id = id;
    control.recordProviderPreparationFailure({ taskId: task2, effectId: effect2.effectId, reasonCode: 'FORGE_PLUGIN_NOT_BOUND' });
  }
  release.id = 'release-six';
  expect(store.nextBrowserEffect(task2)).toBeUndefined();
  expect(store.effectDispatchBudget(effect2.effectId).generations).toBe(0);
  // A verified replacement Runtime does not reset the three automatic
  // preparations. One explicitly authorized, source-preserving preflight may
  // proceed; a further failure re-blocks without spending a Send generation.
  expect(store.authorizeOperatorPreflightRetry({ effectId: effect2.effectId,
    requestId: 'verified-source-repair-on-release-six', authorizedBy: 'operator',
    reason: 'Verified Computer preflight fix and original effect has zero Send generations',
  })).toEqual({ deduplicated: false });
  expect(store.nextBrowserEffect(task2)).toMatchObject({ mode: 'send', generation: 1 });
  control.recordProviderPreparationFailure({ taskId: task2, effectId: effect2.effectId,
    reasonCode: 'COMPUTER_STILL_NOT_READY', composerObservation: { chars: 37,
      fingerprint: 'd47b8b0f40a7de521c8391bb', classification: 'unattributed', selectorVersion: 'visible-single-v2' } });
  expect(control.taskStall(task2)).toMatchObject({ state: 'spaced', preflightReasonCode: 'COMPUTER_STILL_NOT_READY',
    preflightComposerObservation: { chars: 37, classification: 'unattributed', selectorVersion: 'visible-single-v2' } });
  expect(store.nextBrowserEffect(task2)).toBeUndefined();
  expect(store.effectDispatchBudget(effect2.effectId).generations).toBe(0);
  expect(store.authorizeOperatorPreflightRetry({ effectId: effect2.effectId,
    requestId: 'attempt-second-explicit-rearm', authorizedBy: 'operator',
    reason: 'Verified exact backed-up draft was cleared after the first repair failed',
  })).toEqual({ deduplicated: false });
  expect(store.nextBrowserEffect(task2)).toMatchObject({ mode: 'send', generation: 1 });
  control.recordProviderPreparationFailure({ taskId: task2, effectId: effect2.effectId, reasonCode: 'COMPUTER_REPAIR_NOT_SUFFICIENT' });
  expect(store.nextBrowserEffect(task2)).toBeUndefined();
  expect(store.effectDispatchBudget(effect2.effectId).generations).toBe(0);
  store.close();
});

test('recovery stop-pending is a live-turn observation, not a failed preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-recovery-stop-pending-'));
  roots.push(root);
  const clock = { nowMs: Date.now() };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clock.nowMs });
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'recovery-stop-pending-task';
  const conversationId = '45454545-6767-8989-1010-121212121212';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Do not classify a still-generating exact recovery target as failed infrastructure.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const source = control.reserveEnrollment(taskId);
  store.recordEffectDispatchStarted(source.effectId, 1, 'source-dispatch', { surface: 'test' });
  store.recordEffectObservation(source.effectId, 'source-applied', 'applied', { surface: 'test' });
  const observe = (providerFailureCode?: string) => control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: true,
    latestAssistantResponse: 'stable assistant output',
    providerActivityText: 'stable provider activity',
    ...(providerFailureCode ? { providerFailureCode } : {}),
    observedAtMs: clock.nowMs, graceMs: 1_000,
  });
  expect(observe().state).toBe('generating');
  clock.nowMs += 2_000;
  // An actual provider failure, not text silence, authorizes the one recovery.
  const reserved = observe('CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE');
  expect(reserved.state).toBe('recovery_reserved');
  const recovery = reserved.recoveryEffect;
  if (!recovery) throw new Error('TEST_RECOVERY_EFFECT_NOT_RESERVED');

  let preparationReady = false;
  let providerGenerating = true;
  let preparations = 0;
  let sends = 0;
  const errors: unknown[] = [];
  let latestUserText = source.prompt;
  const page = {
    evaluate: async () => undefined as never,
    tabRef: () => ({ windowId: 'recovery-window', tabId: 'recovery-tab' }),
  };
  const targetPort = createTestChatgptTargetPort({
    listTabs: async () => ({ entries: [{ windowId: 'recovery-window', tabId: 'recovery-tab',
      active: true, url: conversationUrl, title: 'Recovery still generating', browserProduct: 'chrome' }] }),
    reattach: async () => page,
    create: async () => { throw new Error('Never create a replacement conversation'); },
    close: async () => undefined,
    snapshot: async () => ({
      url: conversationUrl, title: 'Recovery still generating', latestUserText,
      latestAssistantResponse: providerGenerating ? 'stable assistant output' : '', composerText: '',
      isGenerating: providerGenerating, latestTurnRole: 'user',
      providerActivityText: 'stable provider activity', providerFailureText: '',
    }),
    preparePrompt: async () => {
      preparations++;
      return preparationReady
        ? { ready: true as const }
        : { ready: false as const, reasonCode: 'provider_recovery_stop_pending' };
    },
    dispatchPrompt: async (_page, prompt) => {
      sends++;
      latestUserText = prompt;
      return { dispatched: true, confirmed: true };
    },
  });
  const deps = {
    targetPort, nowMs: () => clock.nowMs, providerIdleGraceMs: 1_000,
    providerScopeKey: join(root, 'provider-scope'), sleep: async () => undefined,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined, onError: (error: unknown) => errors.push(error),
  };
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), deps);
  await adapter.runOnce();

  expect(preparations).toBe(1);
  expect(sends).toBe(0);
  expect(errors).toEqual([]);
  expect(store.latestEffectDispatch(recovery.effectId)).toBeUndefined();
  expect(store.effectDispatchBudget(recovery.effectId).generations).toBe(0);
  expect(store.nextBrowserEffect(taskId)).toMatchObject({
    effect: { effectId: recovery.effectId, kind: 'recovery' }, mode: 'send', generation: 1,
  });
  expect(control.taskStall(taskId)?.state).not.toBe('spaced');

  preparationReady = true;
  providerGenerating = false;
  clock.nowMs += 2_000;
  await adapter.runOnce();
  expect(preparations).toBe(2);
  expect(sends).toBe(1);
  expect(errors).toEqual([]);
  expect(store.latestEffectDispatch(recovery.effectId)?.generation).toBe(1);
  expect(store.effectDispatchBudget(recovery.effectId).generations).toBe(1);
  await adapter.close();
  store.close();
});

test('only a fresh typed Chrome no-stop proof refunds one generation; proofless failures remain unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-typed-refund-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'typed-refund-proof';
  const conversationId = 'abababab-1111-2222-3333-444444444444';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({ taskId, conversationId, conversationUrl, objective: 'Refund only a fresh exact-target no-mutation receipt.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {} });
  const effect = control.reserveEnrollment(taskId);
  const receipt = (reason: string) => ({
    kind: 'prewrite_no_mutation_proof' as const, phase: 'prewrite_or_preclick' as const, reason,
    issued_at_ms: Date.now(), editor_touched: false as const, stop_clicked: false as const, send_clicked: false as const,
    loaded_capability: 'recover-no-stop-prewrite-v1' as const, provider_id: 'browser.chrome-extension' as const,
    provider_instance_id: 'profile-instance', provider_session_id: 'profile-instance', profile_id: 'profile-instance',
    command_id: 'claimed-command-1', window_id: '7', tab_id: '9', owner_token: 'exact-owner-token',
  });
  expect(store.recordEffectDispatchStarted(effect.effectId, 1, 'owner-1', { surface: 'computer-chatgpt-target', target_id: 'exact-target' })).toBe(true);
  expect(store.recordEffectNotAppliedProof(effect.effectId, 'typed-no-stop-proof-1', {
    ...receipt('provider_recovery_turn_unknown'), effect_id: effect.effectId, dispatch_generation: 1,
    dispatch_id: 'owner-1', surface: 'computer-chatgpt-target', target_id: 'exact-target',
  })).toBe(true);
  expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 1, maxGenerations: 3, exhausted: false });
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toMatchObject({ mode: 'send', generation: 2 });

  expect(store.recordEffectDispatchStarted(effect.effectId, 2, 'owner-2', { surface: 'computer-chatgpt-target', target_id: 'exact-target' })).toBe(true);
  control.browserObserveDispatchFailure({ conversationId, conversationUrl, effectId: effect.effectId, observationId: 'proofless-no-click-2',
    dispatchGeneration: 2, dispatchId: 'owner-2', targetId: 'exact-target', surface: 'computer-chatgpt-target', reason: 'composer_missing' });
  expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 2, maxGenerations: 3, exhausted: false });
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toMatchObject({ mode: 'reconcile', generation: 2 });
  store.close();
});

test('proofless bootstrap not-applied evidence stays unknown and cannot refund or authorize a retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-no-click-proof-'));
  roots.push(root);
  const release = { id: 'release-1' };
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { activeReleaseId: () => release.id });
  const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
  const taskId = 'bootstrap-no-click-proof';
  control.registerTask({ taskId, conversationId: `bootstrap:${taskId}`, conversationUrl: 'https://chatgpt.com/',
    objective: 'Proofless legacy bootstrap evidence cannot authorize a new Send.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true }, userBlockerPolicy: {} });
  const effect = control.reserveEnrollment(taskId);
  expect(control.bootstrapBeginEffect({ taskId, effectId: effect.effectId, dispatchId: 'bootstrap-no-click-dispatch-1', dispatchGeneration: 1 })).toBe(true);
  for (const evidence of [{}, { dispatch_mutation: 'attempted', send_clicked: false }, { dispatch_mutation: 'not_attempted', send_clicked: true }]) {
    expect(() => control.bootstrapObserveEffect({ taskId, effectId: effect.effectId, observationId: `untrusted-${JSON.stringify(evidence)}`,
      outcome: 'not_applied', evidence })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_NOT_APPLIED_PROOF_INVALID');
  }
  expect(store.recordEffectDispatchStarted(effect.effectId, 2, 'unproven-bootstrap-retry')).toBe(false);
  control.bootstrapObserveEffect({ taskId, effectId: effect.effectId, observationId: 'bootstrap-no-click-proof-1', outcome: 'not_applied',
    evidence: { dispatch_mutation: 'not_attempted', send_clicked: false } });
  expect(() => control.recordProviderPreparationFailure({ taskId, effectId: effect.effectId, reasonCode: 'composer_missing' }))
    .toThrow('WORKFLOW_SUPERVISOR_PRE_SEND_FAILURE_OUTCOME_NOT_PROVEN');
  expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 1, maxGenerations: 3, exhausted: false });
  expect(store.nextBrowserEffect(taskId)).toBeUndefined();
  release.id = 'release-2';
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toMatchObject({ mode: 'reconcile', generation: 1 });
  store.close();
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
  let otherProviderReady = false;
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
    targetPort: { ...targetPort, inventory: async () => ({ ...await targetPort.inventory(), providerInventoryReady: otherProviderReady }) },
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

  // An available extension must not erase native inventory loss, nor cause
  // exponential transport backoff for already usable exact-target delivery.
  otherProviderReady = true;
  clock.nowMs += 1_000;
  await adapter.runOnce();
  expect(adapter.status().transportFailureStreak).toBe(0);
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

  expect(adapter.status().lastFailure?.code).toBe('WORKFLOW_SUPERVISOR_EMPTY_SHELL_EVIDENCE_UNVERIFIED');
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

test('bootstrap legacy no-click boolean cannot authorize another dispatch after send intent', () => {
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
  expect(control.bootstrapObserveEffect({
    taskId: 'bootstrap-negative-proof-task', effectId: effect.effectId,
    observationId: 'legacy-no-click', outcome: 'not_applied',
    evidence: { dispatch_mutation: 'not_attempted', send_clicked: false },
  })).toBe(false);
  expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 1, exhausted: false });
  expect(store.nextBrowserEffect('bootstrap-negative-proof-task', { nowMs: dispatchedAt + 30_000 })).toBeUndefined();
  expect(store.recordEffectDispatchStarted(effect.effectId, 2, 'unproven-second-send')).toBe(false);
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
  let redundantPromotions = 0;
  const promote = targetPort.promoteBootstrap.bind(targetPort);
  targetPort.promoteBootstrap = async (...args) => { redundantPromotions += 1; return await promote(...args); };
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
  expect(redundantPromotions).toBe(0);
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
  const settled = await control.observeAssistantTurn({ taskId, conversationId,
    responseText: 'Work recorded.\n' + renderSupervisorReceipt(control.getTask(taskId)!, applied.effectId, 'CONTINUE') });
  expect(settled).toMatchObject({ action: 'CONTINUE', terminal: false });
  expect(store.getLatestCompletion(taskId)?.sourceEffectId).toBe(applied.effectId);
  store.close();
});

test('stable text-only assistant reply permits one bounded recovery without replaying source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-missing-receipt-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'task-text-only-receipt';
  const conversationId = '78787878-5656-3434-1212-909090909091';
  control.registerTask({ taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`, objective: 'Settle an exact receipt.', completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const applied = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: applied.effectId, observationId: 'text-only-applied', outcome: 'applied' });
  const recoveryEffectId = 'fx_90909090909090909090909090909998';
  const sample = { taskId, effectId: applied.effectId, generating: false, receiptMissing: true, assistantDigest: 'rendered-text-only-response', graceMs: WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS,
    recovery: { effectId: recoveryEffectId, prompt: 'settle missing typed receipt without replaying source' } };
  expect(store.observeProviderTurn({ ...sample, observedAtMs: 1_000 }).state).toBe('idle_pending');
  expect(store.observeProviderTurn({ ...sample, observedAtMs: WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS + 999 }).state).toBe('idle_pending');
  expect(store.observeProviderTurn({ ...sample, observedAtMs: WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS + 1_000 }).state).toBe('recovery_reserved');
  expect(store.observeProviderTurn({ ...sample, observedAtMs: WORKFLOW_SUPERVISOR_PROVIDER_IDLE_GRACE_MS + 2_000 }).recoveryEffect?.effectId).toBe(recoveryEffectId);
  expect(store.getLatestCompletion(taskId)).toBeUndefined();
  expect(store.nextBrowserEffect(taskId)?.effect.effectId).toBe(recoveryEffectId);
  // The recovery has never sent: a local draft blocks its preflight. A late
  // completed reply from the already-applied source must supersede that
  // unnecessary recovery, without clearing the draft or dispatching anything.
  store.recordEffectPreparationFailure(recoveryEffectId, 'composer_not_empty');
  expect(control.taskStall(taskId)).toMatchObject({ state: 'spaced', reason: 'pre_send_infrastructure_blocked' });
  const late = await control.observeAssistantTurn({ taskId, conversationId,
    responseText: 'Provider finished.\n' + renderSupervisorReceipt(control.getTask(taskId)!, applied.effectId, 'CONTINUE') });
  expect(late).toMatchObject({ action: 'CONTINUE', terminal: false });
  expect(store.getLatestCompletion(taskId)?.sourceEffectId).toBe(applied.effectId);
  expect(store.currentUnappliedEffect(taskId)?.kind).toBe('continuation');
  expect(store.currentUnappliedEffect(taskId)?.effectId).toBe(late.successorEffect?.effectId);
  expect(store.effectApplied(recoveryEffectId)).toBe(false);
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
  // A silent but actively generating model has not failed: no recovery Send.
  expect(store.observeProviderTurn({ ...live, assistantDigest: 'waiting-tool-progress', observedAtMs: 2_501 }).state).toBe('generating');
  expect(store.getEffect(live.recovery.effectId)).toBeUndefined();
  const firstRecovery = store.observeProviderTurn({ ...live, assistantDigest: 'waiting-tool-progress', providerFailureCode: 'CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE', observedAtMs: 2_600 }).recoveryEffect!;
  expect(firstRecovery.kind).toBe('recovery');
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toMatchObject({ kind: 'recovery', effectId: firstRecovery.effectId });
  expect(store.providerResumeExhausted(effect.effectId)).toBe(false);

  control.observeEffect({ effectId: firstRecovery.effectId, observationId: 'provider-resume-1-applied', outcome: 'applied' });
  expect(store.observeProviderTurn({
    taskId, effectId: firstRecovery.effectId, generating: true, assistantDigest: 'resume-1-digest', observedAtMs: 3_000, graceMs: 1_000,
    recovery: { effectId: 'fx_78787878787878787878787878787878', prompt: 'recovery-2' },
  }).state).toBe('generating');
  const secondReserved = store.observeProviderTurn({
    taskId, effectId: firstRecovery.effectId, generating: true, assistantDigest: 'resume-1-digest', providerFailureCode: 'CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE', observedAtMs: 4_001, graceMs: 1_000,
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
    taskId, effectId: secondRecovery.effectId, generating: true, assistantDigest: 'resume-2-digest', providerFailureCode: 'CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE', observedAtMs: 6_001, graceMs: 1_000,
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

test('native adapter does not interrupt active model reasoning for unchanged output', async () => {
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
  expect(dispatchModes).toEqual([]);
  expect(store.getEffectByOriginKey(`provider-recovery:${source.effectId}`)).toBeUndefined();
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

test('active provider reasoning never reserves an unsent recovery merely because output is unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-provider-activity-digest-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'provider-activity-digest-task';
  const conversationId = 'abababab-1212-3434-5656-787878787878';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Live provider progress must reset the idle digest before a final assistant response commits.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const source = control.reserveEnrollment(taskId);
  expect(store.recordEffectDispatchStarted(source.effectId, 1, 'applied-source-generation', { surface: 'test' })).toBe(true);
  control.observeEffect({ effectId: source.effectId, observationId: 'source-applied', outcome: 'applied' });

  const observe = (providerActivityText: string, observedAtMs: number) => control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: true,
    latestAssistantResponse: 'Previously committed assistant answer',
    providerActivityText, observedAtMs, graceMs: 1_000,
  });

  expect(observe('Reasoning: inspect the repository', 1_000).state).toBe('generating');
  // The committed assistant answer is unchanged, but new tool/progress text
  // must change the canonical digest and restart the grace window.
  expect(observe('Reasoning: inspect the repository. Tool output: 4 files found.', 5_000).state).toBe('generating');
  expect(observe('Reasoning: inspect the repository. Tool output: 4 files found.', 5_999).state).toBe('generating');
  const stale = observe('Reasoning: inspect the repository. Tool output: 4 files found.', 6_000);
  expect(stale.state).toBe('generating');
  expect(stale.recoveryEffect).toBeUndefined();
  expect(store.latestEffectDispatch(source.effectId)).toMatchObject({ generation: 1 });
  expect(store.providerResumeExhausted(source.effectId)).toBe(false);
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 60_000 })).toBeUndefined();
  store.close();
});

test('provider recovery exhaustion stops new mutations but keeps observing late activity and receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-late-provider-observation-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'late-provider-observation-after-exhaustion';
  const conversationId = '23232323-4545-6767-8989-010101010101';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Keep observing an exhausted applied leaf without reserving more automatic recoveries.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
  });
  const source = control.reserveEnrollment(taskId);
  expect(store.recordEffectDispatchStarted(source.effectId, 1, 'source-dispatch', { surface: 'test' })).toBe(true);
  control.observeEffect({ effectId: source.effectId, observationId: 'source-applied', outcome: 'applied' });

  const observeFailure = (observedAtMs: number) => control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: false, latestAssistantResponse: '',
    providerFailureCode: 'CHATGPT_AUTOMATION_RESPONSE_STREAM_UNAVAILABLE',
    observedAtMs, graceMs: 1_000,
  });
  const first = observeFailure(1_000);
  expect(first.state).toBe('recovery_reserved');
  const firstRecovery = first.recoveryEffect!;
  expect(store.recordEffectDispatchStarted(firstRecovery.effectId, 1, 'recovery-one-dispatch', { surface: 'test' })).toBe(true);
  store.recordEffectObservation(firstRecovery.effectId, 'recovery-one-applied', 'applied');

  const second = observeFailure(2_000);
  expect(second.state).toBe('recovery_reserved');
  const secondRecovery = second.recoveryEffect!;
  expect(store.recordEffectDispatchStarted(secondRecovery.effectId, 1, 'recovery-two-dispatch', { surface: 'test' })).toBe(true);
  store.recordEffectObservation(secondRecovery.effectId, 'recovery-two-applied', 'applied');
  expect(observeFailure(3_000).state).toBe('exhausted');
  expect(store.providerResumeExhausted(secondRecovery.effectId)).toBe(true);

  // Exhaustion disables another automatic recovery, not the read-only observer.
  const lateActivity = control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: true, latestAssistantResponse: '',
    providerActivityText: 'Late tool output: three files analyzed',
    observedAtMs: 4_000, graceMs: 1_000,
  });
  expect(lateActivity.state).toBe('generating');
  expect(lateActivity.recoveryEffect).toBeUndefined();
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toBeUndefined();

  const stableAfterLateActivity = control.browserObserveProviderTurn({
    conversationId, conversationUrl, generating: true, latestAssistantResponse: '',
    providerActivityText: 'Late tool output: three files analyzed',
    observedAtMs: 5_000, graceMs: 1_000,
  });
  expect(stableAfterLateActivity.state).toBe('generating');
  expect(stableAfterLateActivity.recoveryEffect).toBeUndefined();
  expect(control.browserPoll({ conversationId, conversationUrl }).command).toBeUndefined();

  const responseText = `Late final result.\n${renderSupervisorReceipt(control.getTask(taskId)!, secondRecovery.effectId, 'CONTINUE')}`;
  const completion = await control.browserObserveAssistant({ conversationId, conversationUrl, responseText });
  if (completion.action !== 'CONTINUE' || !completion.successorEffect) throw new Error('LATE_RECEIPT_NOT_ACCEPTED');
  expect(completion.successorEffect.kind).toBe('continuation');
  expect(store.providerResumeExhausted(secondRecovery.effectId)).toBe(true);
  expect(store.latestEffectDispatch(source.effectId)).toMatchObject({ generation: 1 });
  expect(store.latestEffectDispatch(firstRecovery.effectId)).toMatchObject({ generation: 1 });
  expect(store.latestEffectDispatch(secondRecovery.effectId)).toMatchObject({ generation: 1 });
  expect(store.latestAppliedLeafEffectWithoutCompletion(taskId)).toBeUndefined();
  store.close();
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
  // A persisted legacy reason is not an exact provider no-click receipt.
  expect(() => control.recoverTask({ ...operatorRequest, sourceEffectId: operatorRecovery.effectId }))
    .toThrow('WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN');
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 60_000 })).toMatchObject({
    mode: 'reconcile', generation: 1, effect: { effectId: operatorRecovery.effectId },
  });
  control.browserObserveDispatchFailure({ conversationId, conversationUrl, effectId: operatorRecovery.effectId, observationId: 'owner-no-click',
    dispatchGeneration: 1, dispatchId: 'operator-recovery-send', targetId: 'test-target', surface: 'macos-native', reason: 'composer_missing' });
  expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 60_000 })).toMatchObject({ mode: 'reconcile', generation: 1 });
  expect(control.taskStall(taskId)).toMatchObject({ state: 'spaced', effectId: operatorRecovery.effectId, reason: 'unknown_observation_spacing' });
  expect(store.effectDispatchBudget(operatorRecovery.effectId)).toMatchObject({ generations: 1, exhausted: false });
});

test('public supervisor_task revise binds the existing task through canonical RPC with completion-contract CAS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-public-semantic-binding-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const supervisorRoot = join(controllerHome, 'supervisor');
  mkdirSync(supervisorRoot, { recursive: true });
  const repoId = 'repo-public-semantic-binding';
  const workId = 'work-public-semantic-binding';
  createWorkContract({ controllerHome, scopeKey: repoId }, {
    workId, repoId, checkoutId: 'fixture', objective: 'Complete the public API semantic target.',
    acceptanceCriteria: ['Canonical semantic target completes'], allowedPaths: [], forbiddenPaths: [],
    checks: [], constraints: { workspaceMode: 'current' }, requestedBy: 'chatgpt', dispatchState: 'running',
  });
  const store = new WorkflowSupervisorStore(controllerHome);
  const control = new WorkflowSupervisorControlPlane(store, forgeWorkflowSupervisorValidators());
  const taskId = 'supervisor:public-semantic-binding';
  const conversationId = '45454545-2323-6767-8989-101010101010';
  const conversationUrl = 'https://chatgpt.com/c/' + conversationId;
  const task = control.registerTask({
    taskId, conversationId, conversationUrl,
    objective: 'Keep this existing task open until the bound Work is complete.',
    completionContract: { kind: 'model_semantic_completion', controller_home: controllerHome, repo_id: repoId },
    continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, repo_id: repoId },
    userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
  });
  const effect = control.reserveEnrollment(taskId, 'fx_public_semantic_binding_1234');
  store.recordEffectDispatchStarted(effect.effectId, 1, 'public-semantic-binding-dispatch');
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
    const definition = runtimeToolDefinitions.find((entry) => entry.name === 'supervisor_task');
    expect(JSON.stringify(definition?.inputSchema)).toContain('expected_completion_contract_sha256');
    const getResult = await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', { operation: 'get', task_id: taskId });
    const getPayload = getResult?.structuredContent as Record<string, any>;
    expect(getPayload.completionContractSha256).toBe(workflowSupervisorCompletionContractSha256(task.completionContract));
    const revised = await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', {
      operation: 'revise', task_id: taskId, objective: task.objective,
      expected_objective_sha256: createHash('sha256').update(task.objective).digest('hex'),
      expected_completion_contract_sha256: getPayload.completionContractSha256,
      work_id: workId, repo_id: repoId, request_id: 'public-bind-work-1', authorized_by: 'user',
    });
    const revisedPayload = revised?.structuredContent as Record<string, any>;
    expect(revisedPayload).toMatchObject({
      semanticBindingChanged: true,
      task: { taskId, conversationId, conversationUrl, completionContract: { work_id: workId } },
    });
    expect(revisedPayload.summary).toContain('semantic completion binding revised');
    expect(store.getEffect(effect.effectId)?.prompt).toBe(effect.prompt);
    expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 1 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('public supervisor_task review_notice persists through the real local RPC and only the original CONTINUE sends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-review-rpc-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const supervisorHome = join(controllerHome, 'supervisor');
  mkdirSync(supervisorHome, { recursive: true });
  const store = new WorkflowSupervisorStore(supervisorHome);
  const control = new WorkflowSupervisorControlPlane(store);
  const task = control.registerTask({
    taskId: 'supervisor:review-rpc-original',
    conversationId: '88888888-7777-6666-5555-444444444444',
    conversationUrl: 'https://chatgpt.com/c/88888888-7777-6666-5555-444444444444',
    objective: 'Apply a review on the original Work and PR.',
    completionContract: { kind: 'model_semantic_completion', controller_home: controllerHome, repo_id: 'repo-review-rpc' },
    continuationPolicy: { kind: 'standalone_supervisor', repo_id: 'repo-review-rpc' },
    userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
  });
  const enrollment = control.reserveEnrollment(task.taskId);
  const server = createWorkflowSupervisorServer({
    controlPlane: control, socketPath: join(supervisorHome, 'supervisor.sock'),
    discovery: new WorkflowSupervisorEphemeralDiscovery(), browserAdapterEnabled: true,
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) { resolve(); return; }
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const ctx = { controllerHome, repoId: 'repo-review-rpc' } as unknown as Parameters<typeof callWorkflowSupervisorAdapter>[0];
    const watch = { operation: 'review_watch_bind', task_id: task.taskId, repo_id: 'repo-review-rpc',
      github_repository: 'moretea-labs/forge', pr_number: 447 };
    expect((await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', watch))?.structuredContent)
      .toMatchObject({ deduplicated: false, status: 'original_task_watch_bound' });
    expect((await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', watch))?.structuredContent)
      .toMatchObject({ deduplicated: true });
    expect(store.listReviewWatches()).toMatchObject([{ taskId: task.taskId, prNumber: 447 }]);
    await expect(callWorkflowSupervisorAdapter(ctx, 'supervisor_task', { ...watch, repo_id: 'repo-foreign' }))
      .rejects.toThrow('WORKFLOW_SUPERVISOR_REVIEW_REPOSITORY_MISMATCH');
    const args = {
      operation: 'review_notice', task_id: task.taskId, repo_id: 'repo-review-rpc', pr_number: 447,
      reviewed_head_sha: 'a'.repeat(40), current_head_sha: 'b'.repeat(40),
      review_id: 'review-rpc-1', review_source: 'independent_reviewer', review_outcome: 'REVISE',
    };
    const definition = runtimeToolDefinitions.find((entry) => entry.name === 'supervisor_task');
    expect(JSON.stringify(definition?.inputSchema)).toContain('review_notice');
    expect((await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', args))?.structuredContent)
      .toMatchObject({ deferred: true, deduplicated: false, taskId: task.taskId });
    expect((await callWorkflowSupervisorAdapter(ctx, 'supervisor_task', args))?.structuredContent)
      .toMatchObject({ deferred: true, deduplicated: true, taskId: task.taskId });
    expect(store.listPendingReviewNotices()).toHaveLength(1);
    control.observeEffect({ effectId: enrollment.effectId, observationId: 'review-rpc-applied', outcome: 'applied' });
    const committed = await control.observeAssistantTurn({
      taskId: task.taskId, conversationId: task.conversationId,
      responseText: renderSupervisorReceipt(task, enrollment.effectId, 'CONTINUE'),
    });
    expect(committed.successorEffect?.prompt).toContain('[UNVERIFIED STALE_HEAD]');
    expect(store.listPendingReviewNotices()).toHaveLength(0);
    expect(control.taskStall(task.taskId)).toMatchObject({
      state: 'deliverable', effectId: committed.successorEffect?.effectId,
    });
    store.retireReviewWatch(task.taskId, 447);
    expect(store.listReviewWatches()).toHaveLength(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
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


test('verified repeated exact-conversation empty shells migrate only a never-sent standalone effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-empty-shell-rotation-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store, {}, {
    browserTaskActive: () => true, projectScopeForTask: () => ({ title: 'Forge' }),
  });
  const taskId = 'supervisor:verified-empty-shell';
  const conversationId = '91919191-aaaa-bbbb-cccc-929292929292';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  control.registerTask({
    taskId, conversationId, conversationUrl, objective: 'Resume without the old unusable conversation.',
    completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
  });
  control.recordBrowserDiscovery('empty-shell-test', [{
    conversationId, canonicalUrl: conversationUrl, title: 'Forge',
    projectTitle: 'Forge', projectUrl: 'https://chatgpt.com/g/g-p-123456789abcdef0/project',
  }]);
  const pending = control.reserveEnrollment(taskId);
  // A durable no-send preparation blocker must not disable exact-target
  // observation or the existing safe empty-shell migration.
  store.recordEffectPreparationFailure(pending.effectId, 'composer_not_empty');
  let nowMs = 1_000_000;
  let observationMode: 'missing' | 'wrong' | 'failure-text' | 'exact' = 'missing';
  let inventoryHealthy = true;
  const providerScopeKey = join(root, 'provider-scope');
  const emptyShellObservation = {
    url: conversationUrl, title: 'Forge', latestUserText: '', latestAssistantResponse: '',
    providerActivityText: '', providerFailureText: '', composerText: undefined, isGenerating: false,
  };
  const targetPort = {
    inventory: async () => ({
      conversations: [{ conversationId, canonicalUrl: conversationUrl, title: 'Forge' }],
      complete: inventoryHealthy, providerInventoryReady: inventoryHealthy,
      unavailableProviders: inventoryHealthy ? [] : ['browser.chrome-extension'],
    }),
    cleanup: async () => undefined,
    // The typed error is insufficient: only a read-only observation whose URL
    // and empty content the Supervisor independently verifies may count.
    ensureExact: async () => ({
      state: 'unavailable', failure: { code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE' },
      ...(observationMode === 'missing' ? {} : { observation: {
        ...emptyShellObservation,
        url: observationMode === 'wrong' ? 'https://chatgpt.com/g/g-test/project/p-test/c/' + conversationId : conversationUrl,
        providerFailureText: observationMode === 'failure-text' || observationMode === 'wrong' ? 'too many requests' : '',
      } }),
    }),
    // The test asserts migration reservation, not a new provider submission.
    openBootstrap: async () => ({ state: 'unavailable', failure: { code: 'TEST_BOOTSTRAP_NOT_STARTED' } }),
    close: async () => undefined,
  } as any;
  const adapter = new WorkflowSupervisorNativeBrowserAdapter(control, new WorkflowSupervisorEphemeralDiscovery(), {
    targetPort, nowMs: () => nowMs, providerIdleGraceMs: 60_000, providerScopeKey,
    sleep: async () => undefined, setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined, onError: (error) => { throw error; },
  });
  for (const mode of ['missing', 'wrong', 'failure-text'] as const) {
    observationMode = mode;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      nowMs += 15 * 60_000;
      await adapter.runOnce();
      expect(store.getTask(taskId)?.conversationId).toBe(conversationId);
    }
    if (mode === 'wrong') expect(chatgptProviderBackpressureRemainingMs(providerScopeKey, nowMs)).toBe(0);
  }
  observationMode = 'exact';
  inventoryHealthy = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    nowMs += 15 * 60_000;
    await adapter.runOnce();
    expect(store.getTask(taskId)?.conversationId).toBe(conversationId);
  }
  inventoryHealthy = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    nowMs += 15 * 60_000;
    noteChatgptProviderBackpressure(providerScopeKey, CHATGPT_AUTOMATION_RATE_LIMITED, nowMs);
    await adapter.runOnce();
    expect(store.getTask(taskId)?.conversationId).toBe(conversationId);
  }
  // Expire the account-wide cooldown before collecting three fresh verified
  // observations against the healthy inventory.
  nowMs += 60 * 60_000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    nowMs += 15 * 60_000;
    await adapter.runOnce();
    expect(store.getTask(taskId)?.conversationId).toBe(attempt === 2 ? 'bootstrap:' + taskId : conversationId);
  }
  expect(store.latestEffectDispatch(pending.effectId)?.generation ?? 0).toBe(0);
  await adapter.close();
  store.close();
});

test('a terminal conversation capacity banner migrates the same Supervisor but quoted activity text cannot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-capacity-migration-'));
  roots.push(root);
  let clockMs = Date.now();
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'), { now: () => clockMs });
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
      // The live capacity banner can outlive hydration of the old transcript.
      // A quoted activity line without a live failure remains insufficient.
      latestUserText: observedPage === page && !activeStatus ? 'Original durable effect already submitted.' : '',
      latestAssistantResponse: '', providerActivityText: observedPage === page && !activeStatus ? warning : '',
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
    nowMs: () => clockMs,
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
  // Even an explicit provider capacity banner cannot abandon an applied turn
  // until its durable causal completion is recorded.
  expect(store.getTask(taskId)?.conversationId).toBe(conversationId);
  expect(store.getEffectByOriginKey(`fresh-conversation:${taskId}:capacity:${conversationId}`)).toBeUndefined();
  expect(() => control.migrateConversation({ taskId, expectedConversationId: conversationId,
    fresh: true, requestId: 'capacity-unresolved-direct', reason: 'Terminal capacity', authorizedBy: 'test',
  })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_APPLIED_TURN_UNRESOLVED');
  expect(() => control.migrateConversation({ taskId, expectedConversationId: conversationId,
    conversationId: '99999999-8888-7777-6666-555555555555',
    conversationUrl: 'https://chatgpt.com/c/99999999-8888-7777-6666-555555555555',
    requestId: 'capacity-unresolved-explicit', reason: 'Move conversation', authorizedBy: 'test',
  })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_APPLIED_TURN_UNRESOLVED');
  const completed = await control.observeAssistantTurn({ taskId, conversationId,
    responseText: 'Existing turn completed.\n' + renderSupervisorReceipt(control.getTask(taskId)!, effect.effectId, 'CONTINUE'),
  });
  expect(completed.action).toBe('CONTINUE');
  // The old transcript is now empty while the exact provider failure banner
  // remains visible. The CAS can migrate only after that applied receipt.
  // The previous capacity observation set task-local backoff. A completed
  // source receipt restores eligibility, but it must respect that spacing.
  clockMs += 5 * 60_000;
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

test('final assistant receipt successor waits for observed provider idle before delivery', async () => {
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
    objective: 'Continue only after an observable final reply completes.',
    completionContract: {},
    continuationPolicy: {},
    userBlockerPolicy: {},
  });

  const sourceEffect = control.reserveEnrollment(taskId);
  control.observeEffect({ effectId: sourceEffect.effectId, observationId: 'automation-source-applied', outcome: 'applied' });
  let visibleAssistant = 'Completed useful step.\n' + renderSupervisorReceipt(control.getTask(taskId)!, sourceEffect.effectId, 'CONTINUE');
  const continued = await control.observeAssistantTurn({ taskId, conversationId, responseText: visibleAssistant });
  expect('successorEffect' in continued ? continued.successorEffect : undefined).toBeDefined();
  const successor = 'successorEffect' in continued ? continued.successorEffect! : undefined;
  expect(successor).toBeDefined();

  // The completed causal receipt is only authoritative at provider idle.
  // In-flight generation must never trigger a successor send, even if a
  // compatible prior receipt appears in the visible response.
  let submittedText = '继续。';
  let blankTimeline = false;
  let dehydrateOnPrepare = false;
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
        url: conversationUrl, title: 'Tool-only completed turn', latestUserText: blankTimeline ? '' : submittedText,
        latestAssistantResponse: '', composerText: '', latestTurnRole: 'user' as const,
        isGenerating: generating, providerActivityText: '', providerFailureText: '',
      };
    },
    preparePrompt: async () => {
      if (dehydrateOnPrepare) { blankTimeline = true; dehydrateOnPrepare = false; }
      return { ready: true };
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
  nowMs += 1_500;
  storeClockMs += 4 * 60_000;
  blankTimeline = true;
  await adapter.runOnce();
  expect(dispatched).toEqual([]);
  expect(store.latestEffectDispatch(successor!.effectId)).toBeUndefined();
  blankTimeline = false;
  dehydrateOnPrepare = true;
  nowMs += 15 * 60_000;
  await adapter.runOnce();
  expect(dispatched).toEqual([]);
  expect(store.latestEffectDispatch(successor!.effectId)).toBeUndefined();
  // Recover the very same prepared effect; no new Send identity or generation.
  blankTimeline = false;
  nowMs += 15 * 60_000;
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
    visibleAssistant = 'Follow-up verified.\n' + renderSupervisorReceipt(control.getTask(taskId)!, store.latestAppliedEffectWithoutCompletion(taskId)!.effectId, 'CONTINUE');
    await control.observeAssistantTurn({ taskId, conversationId, responseText: visibleAssistant });
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
      evidence: { surface: 'test', target_id: 'exact-target', ...snapshotEvidence },
    })).toMatchObject({ started: true, mode: 'send', generation });
  };
  const proveNotApplied = (observationId: string): void => {
    // A positive provider non-application receipt permits bounded resend but
    // cannot refund a dispatch; old generic no-click strings cannot do either.
    expect(store.recordEffectNotAppliedProof(effect.effectId, observationId, {
      effect_id: effect.effectId,
      dispatch_id: `dispatch-budget-${store.latestEffectDispatch(effect.effectId)!.generation}`,
      dispatch_generation: store.latestEffectDispatch(effect.effectId)!.generation,
      surface: 'test', target_id: 'exact-target', reason: 'provider_confirmed_not_applied', send_clicked: true,
      provider_receipt: 'confirmed_not_applied_after_dispatch',
    })).toBe(false);
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

test('delayed negative proof from an older dispatch cannot authorize an unknown newer generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-stale-proof-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
  const control = new WorkflowSupervisorControlPlane(store);
  const taskId = 'stale-negative-proof-task';
  const conversationId = 'f0f0f0f0-1111-2222-3333-444444444444';
  control.registerTask({ taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    objective: 'Do not replay an unknown generation after an earlier proof arrives late.',
    completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {} });
  const effect = control.reserveEnrollment(taskId);
  expect(store.recordEffectDispatchStarted(effect.effectId, 1, 'generation-one', { surface: 'computer-chatgpt-target', target_id: 'test-target' })).toBe(true);
  const makeProof = (generation: number, dispatchId: string) => ({
    effect_id: effect.effectId, dispatch_generation: generation, dispatch_id: dispatchId,
    surface: 'computer-chatgpt-target', target_id: 'test-target',
    kind: 'prewrite_no_mutation_proof', phase: 'prewrite_or_preclick', reason: 'provider_recovery_turn_unknown',
    issued_at_ms: Date.now(), editor_touched: false, stop_clicked: false, send_clicked: false,
    loaded_capability: 'recover-no-stop-prewrite-v1', provider_id: 'browser.chrome-extension',
    provider_instance_id: 'profile-instance', provider_session_id: 'profile-instance', profile_id: 'profile-instance',
    command_id: `claimed-command-${generation}`, window_id: '7', tab_id: '9', owner_token: 'exact-owner-token',
  });
  const firstProof = makeProof(1, 'generation-one');
  expect(store.recordEffectNotAppliedProof(effect.effectId, 'first-proof', firstProof)).toBe(true);
  expect(store.recordEffectDispatchStarted(effect.effectId, 2, 'generation-two', { surface: 'computer-chatgpt-target', target_id: 'test-target' })).toBe(true);
  // Identical receipt replay is idempotent even after the next generation starts.
  expect(store.recordEffectNotAppliedProof(effect.effectId, 'first-proof', firstProof)).toBe(true);
  expect(() => store.recordEffectNotAppliedProof(effect.effectId, 'late-first-proof', makeProof(1, 'generation-one')))
    .toThrow('WORKFLOW_SUPERVISOR_NOT_APPLIED_PROOF_GENERATION_STALE');
  expect(() => store.recordEffectNotAppliedProof(effect.effectId, 'unattributed-proof', { send_clicked: false }))
    .toThrow('WORKFLOW_SUPERVISOR_NOT_APPLIED_PROOF_GENERATION_STALE');
  expect(store.recordEffectDispatchStarted(effect.effectId, 3, 'premature-third')).toBe(false);
  expect(store.recordEffectNotAppliedProof(effect.effectId, 'second-proof', makeProof(2, 'generation-two'))).toBe(true);
  expect(store.recordEffectDispatchStarted(effect.effectId, 3, 'authorized-third', { surface: 'computer-chatgpt-target', target_id: 'test-target' })).toBe(true);
  store.close();
});

describe('Workflow Supervisor operator recovery and conversation replacement', () => {
  test('confirmed post-dispatch non-application exhausts send budget and needs one bounded operator grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-operator-retry-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(join(root, 'supervisor-home'));
    const control = new WorkflowSupervisorControlPlane(store, {}, { browserTaskActive: () => true });
    const conversationId = 'aaaaaaa1-1111-2222-3333-444444444444';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    const taskId = 'operator-retry-exhaustion';
    control.registerTask({
      taskId, conversationId, conversationUrl, objective: 'Operator retry after confirmed provider non-application.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(taskId);
    const ownerReturn = (generation: number, reason: string): void => {
      store.recordEffectDispatchStarted(effect.effectId, generation, `owner-${generation}`, { surface: 'macos-native', target_id: 'native-bound-target' });
      store.recordEffectNotAppliedProof(effect.effectId, `provider-confirmed-not-applied-${generation}`, {
        effect_id: effect.effectId, dispatch_id: `owner-${generation}`, target_id: 'native-bound-target',
        surface: 'macos-native', dispatch_generation: generation, send_clicked: true,
        provider_receipt: 'confirmed_not_applied_after_dispatch', reason,
      });
    };
    ownerReturn(1, 'provider_receipt_not_applied');
    ownerReturn(2, 'provider_receipt_not_applied');
    ownerReturn(3, 'provider_receipt_not_applied');
    // Confirmed post-dispatch non-application is not a pre-send rejection and
    // therefore consumes the bounded generation budget.
    expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 3, maxGenerations: 3, exhausted: true });
    expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toBeUndefined();
    // Exhaustion is visible as a derived projection instead of an empty queue.
    expect(control.taskStall(taskId)).toMatchObject({ state: 'retryable', effectId: effect.effectId, generations: 3, maxGenerations: 3 });
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
      taskId, effectId: effect.effectId, state: 'exhausted', stallKind: 'retryable', generations: 3, maxGenerations: 3,
    }));
    expect(() => control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: '', reason: 'missing request id' }))
      .toThrow('WORKFLOW_SUPERVISOR_RECOVERY_REASON_REQUIRED');
    // A positive post-dispatch provider receipt allows bounded resend without a refund,
    // but cannot be upgraded into operator refund authority.
    expect(() => control.recoverTask({ taskId, sourceEffectId: effect.effectId, requestId: 'op-retry-1', reason: 'The local composer obstacle was fixed.' }))
      .toThrow('WORKFLOW_SUPERVISOR_RECOVERY_OUTCOME_UNKNOWN');
    expect(store.effectDispatchBudget(effect.effectId)).toMatchObject({ generations: 3, maxGenerations: 3, exhausted: true });
    expect(store.nextBrowserEffect(taskId, { nowMs: Date.now() + 600_000 })).toBeUndefined();
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
    store.recordEffectDispatchStarted(unknownEffect.effectId, 1, 'uncertain-send', { surface: 'macos-native', target_id: 'native-bound-target' });
    store.recordEffectObservation(unknownEffect.effectId, 'unknown-after-send', 'unknown', { surface: 'macos-native', reconciliation: true, reason: 'outbound_not_confirmed' });
    expect(() => control.migrateConversation({
      taskId: 'migration-unknown', expectedConversationId: conversationF, conversationId: conversationE, conversationUrl: url(conversationE),
      requestId: 'migrate-unknown', reason: 'cannot abandon an unresolved submission',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_OUTCOME_UNKNOWN');
    // A mechanically proven un-applied effect is safe to carry to the replacement.
    store.recordEffectNotAppliedProof(unknownEffect.effectId, 'owner-confirmed-not-applied', {
      effect_id: unknownEffect.effectId, dispatch_id: 'uncertain-send', target_id: 'native-bound-target',
      surface: 'macos-native', reason: 'provider_receipt_not_applied', send_clicked: true,
      provider_receipt: 'confirmed_not_applied_after_dispatch', dispatch_generation: 1,
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
