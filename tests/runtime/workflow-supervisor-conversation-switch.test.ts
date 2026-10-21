import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { getCoreCapabilityExecutionSchema } from '../../src/runtime/control-plane/facade/capability-registry';
import { forgeWorkflowSupervisorLifecycleHooks } from '../../src/runtime/root/workflow-supervisor-composition';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
} from '../../adapters/chatgpt/work-conversation-binding-store';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { renderSupervisorReceipt, SUPERVISOR_TURN_BLOCK_START, SUPERVISOR_TURN_BLOCK_END } from '../../supervisor/protocol';
import { WorkflowSupervisorStore } from '../../supervisor/store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-conversation-switch-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const repoId = 'repo_conversation_switch_test';
  const workId = 'work-conversation-switch-test';
  return { root, controllerHome, repoId, workId, store: { controllerHome, repoId } };
}

describe('Workflow Supervisor fresh conversation switch', () => {
  test('exposes one canonical fresh-conversation action through the workflow supervisor capability', () => {
    const schema = getCoreCapabilityExecutionSchema('controller.workflow_supervisor') as {
      actions: Record<string, { argumentsSchema?: { required?: string[] } }>;
    };
    expect(schema.actions.switch_to_fresh_conversation).toBeDefined();
    expect(schema.actions.switch_to_fresh_conversation.argumentsSchema?.required).toEqual([
      'task_id', 'expected_conversation_id', 'reason',
    ]);
  });

  test('rebinds a Work only after an explicit fresh migration is observed as a canonical conversation', () => {
    const fx = fixture();
    const oldConversationId = '11111111-aaaa-bbbb-cccc-222222222222';
    const newConversationId = '33333333-dddd-eeee-ffff-444444444444';
    const taskId = 'forge:repo_conversation_switch_test:work:work-conversation-switch-test';
    const oldUrl = `https://chatgpt.com/c/${oldConversationId}`;
    const newUrl = `https://chatgpt.com/c/${newConversationId}`;

    bindChatgptWorkConversation(fx.store, {
      workId: fx.workId,
      conversationUrl: oldUrl,
      localAlias: 'Conversation switch test',
    });

    const supervisorStore = new WorkflowSupervisorStore(fx.controllerHome);
    const control = new WorkflowSupervisorControlPlane(
      supervisorStore,
      {},
      forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome),
    );
    control.registerTask({
      taskId,
      conversationId: oldConversationId,
      conversationUrl: oldUrl,
      objective: 'Continue the same Work in a fresh exact conversation.',
      completionContract: {
        controller_home: fx.controllerHome,
        repo_id: fx.repoId,
        work_id: fx.workId,
      },
      continuationPolicy: { kind: 'forge_goal_outer_turn', repo_id: fx.repoId },
      userBlockerPolicy: {
        controller_home: fx.controllerHome,
        repo_id: fx.repoId,
        work_id: fx.workId,
      },
    });

    expect(control.migrateConversation({
      taskId,
      expectedConversationId: oldConversationId,
      fresh: true,
      requestId: 'switch-to-fresh-1',
      reason: 'User explicitly selected Use new conversation.',
      authorizedBy: 'desktop-client',
    })).toMatchObject({
      migrated: true,
      freshConversation: true,
      conversationId: `bootstrap:${taskId}`,
    });

    expect(getChatgptWorkConversationBinding(fx.store, fx.workId)?.conversationId).toBe(oldConversationId);
    // The provider Project root can resolve back to its old chat. It must not
    // consume a fresh-migration enrollment or change the bound Work identity.
    expect(() => control.bindBootstrapConversation({
      taskId, conversationId: oldConversationId, conversationUrl: oldUrl,
    })).toThrow('WORKFLOW_SUPERVISOR_FRESH_CONVERSATION_REBOUND_SOURCE');
    expect(control.getTask(taskId)?.conversationId).toBe('bootstrap:' + taskId);
    control.bindBootstrapConversation({ taskId, conversationId: newConversationId, conversationUrl: newUrl });
    expect(getChatgptWorkConversationBinding(fx.store, fx.workId)).toMatchObject({
      workId: fx.workId,
      conversationId: newConversationId,
      conversationUrl: newUrl,
      localAlias: 'Conversation switch test',
    });
    // Browser observation can replay after either store commits. The durable migration event
    // remains the authorization evidence, so convergence is idempotent without extra state.
    expect(control.bindBootstrapConversation({ taskId, conversationId: newConversationId, conversationUrl: newUrl })).toMatchObject({
      taskId, conversationId: newConversationId, conversationUrl: newUrl,
    });
    expect(getChatgptWorkConversationBinding(fx.store, fx.workId)?.conversationId).toBe(newConversationId);
    supervisorStore.close();
  });

  test('rotates one standalone Supervisor atomically after 10 confirmed CONTINUE receipts', async () => {
    const fx = fixture();
    const oldConversationId = '12121212-aaaa-bbbb-cccc-343434343434';
    const taskId = 'supervisor:standalone-receipt-rotation';
    const store = new WorkflowSupervisorStore(fx.controllerHome);
    const control = new WorkflowSupervisorControlPlane(store);
    control.registerTask({
      taskId,
      conversationId: oldConversationId,
      conversationUrl: `https://chatgpt.com/c/${oldConversationId}`,
      objective: 'Deliver useful work across conversation boundaries.',
      completionContract: { repo_id: fx.repoId },
      continuationPolicy: { kind: 'standalone_supervisor' },
      userBlockerPolicy: {},
    });
    let effect = control.reserveEnrollment(taskId);
    for (let n = 1; n <= 10; n += 1) {
      expect(store.recordEffectDispatchStarted(effect.effectId, 1, `round-${n}`)).toBe(true);
      control.observeEffect({ effectId: effect.effectId, observationId: `applied-${n}`, outcome: 'applied' });
      const result = await control.observeAssistantTurn({ taskId, conversationId: oldConversationId,
        responseText: 'Delivered useful work.\n' + renderSupervisorReceipt(control.getTask(taskId)!, effect.effectId, 'CONTINUE'),
      });
      expect(result).toMatchObject({ action: 'CONTINUE', terminal: false });
      if (!('successorEffect' in result) || !result.successorEffect) throw new Error('MISSING_CONTINUATION_EFFECT');
      effect = result.successorEffect;
      if (n < 10) {
        expect(effect.kind).toBe('continuation');
        expect(store.getTask(taskId)?.conversationId).toBe(oldConversationId);
      }
    }
    expect(effect.kind).toBe('enrollment');
    expect(store.getTask(taskId)?.conversationId).toBe(`bootstrap:${taskId}`);
    expect(store.getTask(taskId)?.taskId).toBe(taskId);
    expect(store.currentUnappliedEffect(taskId)?.effectId).toBe(effect.effectId);
    // History from the old chat stays replayable but does not make a fresh chat established.
    expect(store.getLatestCompletion(taskId)).toBeDefined();
    expect(store.hasCompletionInCurrentConversation(taskId)).toBe(false);
    // The first reply echoes the challenge sent before binding the fresh URL.
    const sentChallenge = /^receipt:([0-9a-f]{7})$/m.exec(effect.prompt)?.[1];
    expect(sentChallenge).toBeDefined();
    const bootstrapReceipt = `C ${sentChallenge}`;
    const freshId = '56565656-dddd-eeee-ffff-787878787878';
    expect(() => control.bindBootstrapConversation({
      taskId, conversationId: oldConversationId,
      conversationUrl: `https://chatgpt.com/c/${oldConversationId}`,
    })).toThrow('WORKFLOW_SUPERVISOR_FRESH_CONVERSATION_REBOUND_SOURCE');
    control.bindBootstrapConversation({
      taskId, conversationId: freshId, conversationUrl: `https://chatgpt.com/c/${freshId}`,
    });
    expect(store.getTask(taskId)?.conversationId).toBe(freshId);
    expect(store.hasCompletionInCurrentConversation(taskId)).toBe(false);
    // A healthy second window must be eligible to rotate again. Migration
    // budgets limit *consecutive failed* moves, never lifetime conversations.
    for (let n = 11; n <= 20; n += 1) {
      expect(store.recordEffectDispatchStarted(effect.effectId, 1, `round-${n}`)).toBe(true);
      control.observeEffect({ effectId: effect.effectId, observationId: `applied-${n}`, outcome: 'applied' });
      const result = await control.observeAssistantTurn({ taskId, conversationId: freshId,
        responseText: 'Delivered useful work.\n' + (n === 11 ? bootstrapReceipt : renderSupervisorReceipt(control.getTask(taskId)!, effect.effectId, 'CONTINUE')),
      });
      if (!('successorEffect' in result) || !result.successorEffect) throw new Error('MISSING_SUCCESSOR_IN_SECOND_WINDOW');
      expect(store.hasCompletionInCurrentConversation(taskId)).toBe(true);
      effect = result.successorEffect;
      if (n < 20) {
        expect(effect.kind).toBe('continuation');
        expect(store.getTask(taskId)?.conversationId).toBe(freshId);
      }
    }
    expect(effect.kind).toBe('enrollment');
    expect(store.getTask(taskId)?.conversationId).toBe(`bootstrap:${taskId}`);
    expect(store.hasCompletionInCurrentConversation(taskId)).toBe(false);
    // A fresh logical chat cannot be a source retired two migrations ago.
    expect(() => control.bindBootstrapConversation({
      taskId, conversationId: oldConversationId,
      conversationUrl: `https://chatgpt.com/c/${oldConversationId}`,
    })).toThrow('WORKFLOW_SUPERVISOR_FRESH_CONVERSATION_REBOUND_SOURCE');
    const thirdId = '90909090-aaaa-bbbb-cccc-111111111111';
    control.bindBootstrapConversation({
      taskId, conversationId: thirdId, conversationUrl: `https://chatgpt.com/c/${thirdId}`,
    });
    expect(store.getTask(taskId)?.conversationId).toBe(thirdId);
    // One further operator-authorized move without another receipt is allowed,
    // but a third consecutive failed migration cannot churn conversations.
    expect(control.migrateConversation({
      taskId, expectedConversationId: thirdId, fresh: true,
      requestId: 'post-second-cycle-capacity', reason: 'Provider declared terminal capacity.',
      authorizedBy: 'test-operator',
    })).toMatchObject({ migrated: true, freshConversation: true });
    const fourthId = 'abababab-1212-3434-5656-cdcdcdcdcdcd';
    control.bindBootstrapConversation({
      taskId, conversationId: fourthId, conversationUrl: `https://chatgpt.com/c/${fourthId}`,
    });
    expect(() => control.migrateConversation({
      taskId, expectedConversationId: fourthId, fresh: true,
      requestId: 'third-failed-hop', reason: 'A third move without progress must stop.',
      authorizedBy: 'test-operator',
    })).toThrow('WORKFLOW_SUPERVISOR_MIGRATION_BUDGET_EXHAUSTED');
    store.close();
  });


  test('earlier confirmed receipt rotation derives from durable exact-target load failures', async () => {
    const fx = fixture();
    const conversationId = '75757575-aaaa-bbbb-cccc-878787878787';
    const taskId = 'supervisor:degraded-receipt-rotation';
    const store = new WorkflowSupervisorStore(fx.controllerHome);
    const control = new WorkflowSupervisorControlPlane(store);
    control.registerTask({
      taskId, conversationId, conversationUrl: `https://chatgpt.com/c/${conversationId}`,
      objective: 'Rotate a reliably degraded but still completing conversation.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    store.recordBrowserDeliveryAttemptFailure({ taskId, conversationId, code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', verifiedEmptyShell: true });
    store.recordBrowserDeliveryAttemptFailure({ taskId, conversationId, code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', verifiedEmptyShell: true });
    let effect = control.reserveEnrollment(taskId);
    for (let n = 1; n <= 6; n += 1) {
      expect(store.recordEffectDispatchStarted(effect.effectId, 1, `degraded-round-${n}`)).toBe(true);
      control.observeEffect({ effectId: effect.effectId, observationId: `degraded-applied-${n}`, outcome: 'applied' });
      const result = await control.observeAssistantTurn({
        taskId, conversationId,
        responseText: 'Useful progress.\n' + renderSupervisorReceipt(control.getTask(taskId)!, effect.effectId, 'CONTINUE'),
      });
      if (!('successorEffect' in result) || !result.successorEffect) throw new Error('DEGRADED_SUCCESSOR_MISSING');
      effect = result.successorEffect;
      expect(effect.kind).toBe(n === 6 ? 'enrollment' : 'continuation');
    }
    expect(store.getTask(taskId)?.conversationId).toBe(`bootstrap:${taskId}`);
    expect(store.latestEffectDispatch(effect.effectId)?.generation ?? 0).toBe(0);
    // Unverified typed failures alone do not lower the cadence to six receipts.
    const unverifiedTaskId = 'supervisor:unverified-degraded-receipt-rotation';
    const unverifiedConversationId = '85858585-bbbb-cccc-dddd-989898989898';
    const unverifiedUrl = 'https://chatgpt.com/c/' + unverifiedConversationId;
    control.registerTask({
      taskId: unverifiedTaskId, conversationId: unverifiedConversationId, conversationUrl: unverifiedUrl,
      objective: 'Do not rotate early on unverified typed failures.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    store.recordBrowserDeliveryAttemptFailure({ taskId: unverifiedTaskId, conversationId: unverifiedConversationId, code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE' });
    store.recordBrowserDeliveryAttemptFailure({ taskId: unverifiedTaskId, conversationId: unverifiedConversationId, code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE' });
    let unverifiedEffect = control.reserveEnrollment(unverifiedTaskId);
    for (let n = 1; n <= 10; n += 1) {
      expect(store.recordEffectDispatchStarted(unverifiedEffect.effectId, 1, 'unverified-round-' + n)).toBe(true);
      control.observeEffect({ effectId: unverifiedEffect.effectId, observationId: 'unverified-applied-' + n, outcome: 'applied' });
      const result = await control.observeAssistantTurn({
        taskId: unverifiedTaskId, conversationId: unverifiedConversationId,
        responseText: 'Useful progress.\n' + renderSupervisorReceipt(control.getTask(unverifiedTaskId)!, unverifiedEffect.effectId, 'CONTINUE'),
      });
      if (!('successorEffect' in result) || !result.successorEffect) throw new Error('UNVERIFIED_SUCCESSOR_MISSING');
      unverifiedEffect = result.successorEffect;
      expect(unverifiedEffect.kind).toBe(n === 10 ? 'enrollment' : 'continuation');
    }
    expect(store.getTask(unverifiedTaskId)?.conversationId).toBe('bootstrap:' + unverifiedTaskId);

    // The sixth receipt cannot retire an unrelated applied, unanswered turn.
    const siblingTaskId = 'supervisor:receipt-cadence-unanswered-sibling';
    const siblingConversation = 'abababab-aaaa-bbbb-cccc-cdcdcdcdcdcd';
    control.registerTask({
      taskId: siblingTaskId, conversationId: siblingConversation,
      conversationUrl: 'https://chatgpt.com/c/' + siblingConversation,
      objective: 'Keep the unanswered sibling on its original conversation.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    for (let n = 0; n < 2; n += 1) store.recordBrowserDeliveryAttemptFailure({
      taskId: siblingTaskId, conversationId: siblingConversation,
      code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', verifiedEmptyShell: true,
    });
    let siblingSource = control.reserveEnrollment(siblingTaskId);
    for (let n = 1; n <= 6; n += 1) {
      // Preserve the real source as the latest applied turn for causal receipt
      // matching; the extra applied sibling still remains unanswered.
      if (n === 6) {
        const outstanding = store.reserveEffect({
          taskId: siblingTaskId, effectId: 'fx_applied_unanswered_sibling_source',
          kind: 'continuation', originKey: 'test:unanswered-sibling-source',
          prompt: 'Separate applied source awaits its own reply.',
        });
        store.recordEffectDispatchStarted(outstanding.effectId, 1, 'sibling-outstanding-dispatch');
        store.recordEffectObservation(outstanding.effectId, 'sibling-outstanding-applied', 'applied');
      }
      expect(store.recordEffectDispatchStarted(siblingSource.effectId, 1, 'sibling-source-' + n)).toBe(true);
      control.observeEffect({ effectId: siblingSource.effectId, observationId: 'sibling-source-applied-' + n, outcome: 'applied' });
      const observed = await control.observeAssistantTurn({
        taskId: siblingTaskId, conversationId: siblingConversation,
        responseText: 'Useful progress.\n' + renderSupervisorReceipt(control.getTask(siblingTaskId)!, siblingSource.effectId, 'CONTINUE'),
      });
      if (!('successorEffect' in observed) || !observed.successorEffect) throw new Error('SIBLING_SUCCESSOR_MISSING');
      siblingSource = observed.successorEffect;
      expect(siblingSource.kind).toBe('continuation');
      expect(store.getTask(siblingTaskId)?.conversationId).toBe(siblingConversation);
    }
    expect(store.hasAppliedEffectAwaitingCompletion(siblingTaskId)).toBe(true);

    // The same auto-rotation path must not abandon an unresolved send.
    // Unlike an applied sibling, this one has a dispatched generation with
    // an unknown outcome. A later source reply does not resolve that send.
    const unknownTaskId = 'supervisor:receipt-cadence-unknown-send';
    const unknownConversation = 'cdcdcdcd-aaaa-bbbb-cccc-efefefefefef';
    control.registerTask({
      taskId: unknownTaskId, conversationId: unknownConversation,
      conversationUrl: 'https://chatgpt.com/c/' + unknownConversation,
      objective: 'Do not rotate away from an outcome-unknown sibling send.',
      completionContract: {}, continuationPolicy: { kind: 'standalone_supervisor' }, userBlockerPolicy: {},
    });
    for (let n = 0; n < 2; n += 1) store.recordBrowserDeliveryAttemptFailure({
      taskId: unknownTaskId, conversationId: unknownConversation,
      code: 'COMPUTER_CHATGPT_CONVERSATION_CONTENT_UNAVAILABLE', verifiedEmptyShell: true,
    });
    let current = control.reserveEnrollment(unknownTaskId);
    for (let n = 1; n <= 6; n += 1) {
      if (n === 6) {
        const unknown = store.reserveEffect({
          taskId: unknownTaskId, effectId: 'fx_undetermined_sibling_send',
          kind: 'continuation', originKey: 'test:undetermined-sibling-send',
          prompt: 'Separate send with unverified delivery.',
        });
        expect(store.recordEffectDispatchStarted(unknown.effectId, 1, 'unknown-sibling-send')).toBe(true);
        store.recordEffectObservation(unknown.effectId, 'unknown-sibling-observation', 'unknown', {
          surface: 'macos-native', reason: 'outbound_not_confirmed',
        });
      }
      expect(store.recordEffectDispatchStarted(current.effectId, 1, 'unknown-guard-source-' + n)).toBe(true);
      control.observeEffect({ effectId: current.effectId, observationId: 'unknown-guard-applied-' + n, outcome: 'applied' });
      const observed = await control.observeAssistantTurn({
        taskId: unknownTaskId, conversationId: unknownConversation,
        responseText: 'Useful progress.\n' + renderSupervisorReceipt(control.getTask(unknownTaskId)!, current.effectId, 'CONTINUE'),
      });
      if (!('successorEffect' in observed) || !observed.successorEffect) throw new Error('UNKNOWN_GUARD_SUCCESSOR_MISSING');
      current = observed.successorEffect;
      expect(current.kind).toBe('continuation');
      expect(store.getTask(unknownTaskId)?.conversationId).toBe(unknownConversation);
    }
    expect(store.currentUnappliedEffect(unknownTaskId)?.effectId).toBe('fx_undetermined_sibling_send');
    store.close();
  });

  test('does not allow an unrelated bootstrap bind to replace the canonical Work conversation', () => {
    const fx = fixture();
    const oldConversationId = '55555555-aaaa-bbbb-cccc-666666666666';
    const newConversationId = '77777777-dddd-eeee-ffff-888888888888';
    const taskId = 'forge:repo_conversation_switch_test:work:unapproved-rebind';
    const oldUrl = `https://chatgpt.com/c/${oldConversationId}`;

    bindChatgptWorkConversation(fx.store, { workId: fx.workId, conversationUrl: oldUrl });
    const supervisorStore = new WorkflowSupervisorStore(fx.controllerHome);
    const control = new WorkflowSupervisorControlPlane(supervisorStore, {}, forgeWorkflowSupervisorLifecycleHooks(fx.controllerHome));
    control.registerTask({
      taskId,
      conversationId: `bootstrap:${taskId}`,
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Bootstrap without an explicit migration event.',
      completionContract: { controller_home: fx.controllerHome, repo_id: fx.repoId, work_id: fx.workId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', repo_id: fx.repoId, bootstrap: true },
      userBlockerPolicy: { controller_home: fx.controllerHome, repo_id: fx.repoId, work_id: fx.workId },
    });

    expect(() => control.bindBootstrapConversation({
      taskId,
      conversationId: newConversationId,
      conversationUrl: `https://chatgpt.com/c/${newConversationId}`,
    })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_WORK_CONVERSATION_CONFLICT');
    expect(getChatgptWorkConversationBinding(fx.store, fx.workId)?.conversationId).toBe(oldConversationId);
    supervisorStore.close();
  });
});
