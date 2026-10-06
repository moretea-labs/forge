import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { getCoreCapabilityExecutionSchema } from '../../src/runtime/control-plane/facade/capability-registry';
import { forgeWorkflowSupervisorLifecycleHooks } from '../../src/runtime/root/workflow-supervisor-composition';
import {
  bindChatgptWorkConversation,
  getChatgptWorkConversationBinding,
} from '../../adapters/chatgpt/work-conversation-binding-store';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
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
