import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { forgeWorkflowSupervisorValidators } from '../../supervisor/forge-validators';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { renderSupervisorPrompt } from '../../supervisor/protocol';
import { automationMetadata } from '../../adapters/mcp/runtime-gateway/automation-receipt-adapter';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Workflow Supervisor automation receipts', () => {
  test('exposes and validates the standalone autonomous tool-call envelope', () => {
    const schema = runtimeToolDefinitions.find((definition) => definition.name === 'rh_status')!.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties.automation_task_id).toBeDefined();
    expect(schema.properties.automation_type).toBeDefined();
    expect(schema.properties.automation_status).toBeDefined();
    expect(automationMetadata({
      automation_type: 'autonomous_continuation', automation_status: 'continue', automation_task_id: 'TASK-1',
    })).toEqual({ status: 'continue', taskId: 'TASK-1' });
    expect(() => automationMetadata({ automation_type: 'autonomous_continuation', automation_status: 'continue' })).toThrow('AUTOMATION_TASK_ID_REQUIRED');
  });

  test('resolves bootstrap inside the uniquely discovered repository ChatGPT Project', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-project-bootstrap-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store, {}, {
      projectScopeForTask: () => ({ title: 'forge', repoId: 'repo-forge', controllerHome: root }),
    });
    const task = control.registerTask({
      taskId: 'supervisor:project-bootstrap',
      conversationId: 'bootstrap:supervisor:project-bootstrap',
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Continue inside the Forge project.',
      completionContract: { repo_id: 'repo-forge', controller_home: root },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true },
      userBlockerPolicy: {},
    });
    control.recordBrowserDiscovery('chrome-extension', [{
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      canonicalUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      projectTitle: 'forge',
      projectUrl: 'https://chatgpt.com/g/g-p-forge/project',
    }]);
    expect(control.bootstrapProjectUrl(task.taskId)).toBe('https://chatgpt.com/g/g-p-forge/project');
    store.close();
  });

  test('turns one durable bootstrap reservation into exactly one canonical conversation', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const task = control.registerTask({
      taskId: 'forge:repo:bootstrap-work',
      conversationId: 'bootstrap:bootstrap-work',
      conversationUrl: 'https://chatgpt.com/',
      objective: 'Create one controlled conversation.',
      completionContract: {}, continuationPolicy: { bootstrap: true }, userBlockerPolicy: {},
    });
    control.reserveEnrollment(task.taskId);
    expect(control.browserTasks()).toEqual([expect.objectContaining({ taskId: task.taskId, conversationId: 'bootstrap:bootstrap-work' })]);
    const bound = control.bindBootstrapConversation({
      taskId: task.taskId,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      conversationUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(bound).toMatchObject({
      taskId: task.taskId,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(() => control.bindBootstrapConversation({
      taskId: task.taskId,
      conversationId: 'ffffffff-1111-2222-3333-444444444444',
      conversationUrl: 'https://chatgpt.com/c/ffffffff-1111-2222-3333-444444444444',
    })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_ALREADY_BOUND');
    store.close();
  });

  test('persists a final MCP continue receipt once and reserves one successor without page text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-automation-receipt-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store);
    const task = control.registerTask({
      taskId: 'forge:repo:test-work',
      conversationId: '11111111-2222-3333-4444-555555555555',
      conversationUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
      objective: 'Use Forge tool receipts.',
      completionContract: {}, continuationPolicy: {}, userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(task.taskId);
    control.observeEffect({ effectId: effect.effectId, observationId: 'submitted', outcome: 'applied' });

    expect(await control.observeAutomationReceipt({
      taskId: task.taskId, conversationId: task.conversationId, status: 'working', receiptId: 'working-1',
    })).toEqual({ recorded: true });
    const first = await control.observeAutomationReceipt({
      taskId: task.taskId, conversationId: task.conversationId, status: 'continue', receiptId: 'turn-1',
    });
    const replay = await control.observeAutomationReceipt({
      taskId: task.taskId, conversationId: task.conversationId, status: 'continue', receiptId: 'turn-1',
    });

    expect(first).toMatchObject({ action: 'CONTINUE', terminal: false });
    expect(replay).toMatchObject({ action: 'CONTINUE', terminal: false });
    expect(store.getEffectByOriginKey(`completion:${(first as { completionFingerprint: string }).completionFingerprint}`)).toBeDefined();
    expect(renderSupervisorPrompt(task, effect.effectId, 'enrollment')).toContain('automation_type: "autonomous_continuation"');
    expect(renderSupervisorPrompt(task, effect.effectId, 'enrollment')).not.toContain('CONTINUE => "C ');
    store.close();
  });

  test('advances a standalone Supervisor task CONTINUE -> CONTINUE -> DONE without Work or Plan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-standalone-'));
    roots.push(root);
    const store = new WorkflowSupervisorStore(root);
    const control = new WorkflowSupervisorControlPlane(store, forgeWorkflowSupervisorValidators());
    const task = control.registerTask({
      taskId: 'supervisor:standalone-proof',
      conversationId: '11111111-aaaa-bbbb-cccc-222222222222',
      conversationUrl: 'https://chatgpt.com/c/11111111-aaaa-bbbb-cccc-222222222222',
      objective: 'Prove three autonomous rounds.',
      completionContract: { kind: 'model_semantic_completion' },
      continuationPolicy: { kind: 'standalone_supervisor' },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    const firstEffect = control.reserveEnrollment(task.taskId);
    control.observeEffect({ effectId: firstEffect.effectId, observationId: 'applied-1', outcome: 'applied' });
    const first = await control.observeAutomationReceipt({
      taskId: task.taskId, conversationId: task.conversationId, status: 'continue', receiptId: 'round-1',
    });
    expect(first).toMatchObject({ action: 'CONTINUE', terminal: false });
    const secondEffect = (first as { successorEffect: { effectId: string } }).successorEffect;
    control.observeEffect({ effectId: secondEffect.effectId, observationId: 'applied-2', outcome: 'applied' });
    const second = await control.observeAutomationReceipt({
      taskId: task.taskId, conversationId: task.conversationId, status: 'continue', receiptId: 'round-2',
    });
    expect(second).toMatchObject({ action: 'CONTINUE', terminal: false });
    const thirdEffect = (second as { successorEffect: { effectId: string } }).successorEffect;
    control.observeEffect({ effectId: thirdEffect.effectId, observationId: 'applied-3', outcome: 'applied' });
    const third = await control.observeAutomationReceipt({
      taskId: task.taskId, conversationId: task.conversationId, status: 'done', receiptId: 'round-3',
    });
    expect(third).toMatchObject({
      action: 'DONE',
      terminal: true,
      validation: { valid: true, reason: 'model_semantic_completion' },
    });
    store.close();
  });
});
