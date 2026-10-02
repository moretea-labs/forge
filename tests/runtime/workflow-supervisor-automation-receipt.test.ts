import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { forgeWorkflowSupervisorValidators } from '../../supervisor/forge-validators';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { renderSupervisorPrompt } from '../../supervisor/protocol';
import { automationMetadata, automationReceiptControllerTypeAllowed } from '../../adapters/mcp/runtime-gateway/automation-receipt-adapter';
import { normalizeRhWorkInputWireMigration } from '../../adapters/mcp/runtime-gateway/work-input-wire-migration';
import { callWorkAdapter } from '../../adapters/mcp/runtime-gateway/work-adapter';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';
import { callCoreCapabilityAdapter } from '../../adapters/mcp/runtime-gateway/core-capability-adapter';
import { createWorkflowSupervisorServer } from '../../supervisor/server';
import { workflowSupervisorSocketPath } from '../../supervisor/paths';

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
    expect(automationMetadata({ capability_id: 'automation.receipt:continue:forge:repo:test-work' })).toEqual({
      status: 'continue', taskId: 'forge:repo:test-work',
    });
    expect(automationMetadata({ capability_id: 'automation.receipt:done:forge:repo:test-work' })).toEqual({
      status: 'done', taskId: 'forge:repo:test-work',
    });
    expect(automationReceiptControllerTypeAllowed(undefined)).toBe(true);
    expect(automationReceiptControllerTypeAllowed('chatgpt')).toBe(true);
    expect(automationReceiptControllerTypeAllowed('codex')).toBe(false);
    expect(automationReceiptControllerTypeAllowed('human')).toBe(false);
  });

  test('accepts the frozen-schema automation receipt carrier without repository admission', async () => {
    const input = { operation: 'repair', capability_id: 'automation.receipt:continue:forge:repo:test-work' };
    expect(normalizeRhWorkInputWireMigration(input)).toMatchObject({ ok: true, operation: 'repair' });
    const annotated = { ...input, repo_id: 'transport-context-only', checkout_id: 'transport-checkout-only', reason: 'work checkpoint' };
    expect(normalizeRhWorkInputWireMigration(annotated)).toEqual({ ok: true, operation: 'repair', args: input });
    expect(normalizeRhWorkInputWireMigration({ ...input, source_effect_id: 'fx_untrusted' })).toMatchObject({ ok: false });
    expect(normalizeRhWorkInputWireMigration({ ...input, reason: {} })).toMatchObject({ ok: false });
    const response = await callWorkAdapter({ controllerHome: '/tmp/unused-for-automation-receipt' } as any, annotated);
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      status: 'ok',
      data: { automationReceiptCompatibility: true },
    });
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
    control.recordBrowserDiscovery('chrome-extension', [
      {
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        canonicalUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        projectTitle: 'forge',
        projectUrl: 'https://chatgpt.com/g/g-p-abc123/project',
      },
      {
        conversationId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        canonicalUrl: 'https://chatgpt.com/g/g-p-abc123-forge/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        projectTitle: 'forge',
        projectUrl: 'https://chatgpt.com/g/g-p-abc123-forge/project',
      },
      {
        conversationId: 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa',
        canonicalUrl: 'https://chatgpt.com/c/cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa',
        projectTitle: 'forge',
        projectUrl: 'https://chatgpt.com/plugins/plugin_asdk_app_example',
      },
    ]);
    expect(control.bootstrapProjectUrl(task.taskId)).toBe('https://chatgpt.com/g/g-p-abc123/project');
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
    expect(renderSupervisorPrompt(task, effect.effectId, 'enrollment')).toContain(`automation.receipt:continue:${task.taskId}`);
    expect(renderSupervisorPrompt(task, effect.effectId, 'enrollment')).toStartWith('@forge\n');
    expect(renderSupervisorPrompt(task, effect.effectId, 'enrollment')).not.toContain('CONTINUE => "C ');
    store.close();
  });

  test('routes standalone Supervisor start/list through capability_execute without a second handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-capability-'));
    roots.push(root);
    const supervisorRoot = join(root, 'supervisor');
    mkdirSync(supervisorRoot, { recursive: true });
    const store = new WorkflowSupervisorStore(supervisorRoot);
    const control = new WorkflowSupervisorControlPlane(store, forgeWorkflowSupervisorValidators());
    const socketPath = workflowSupervisorSocketPath(root);
    const server = createWorkflowSupervisorServer({ controlPlane: control, socketPath });
    await new Promise<void>((resolve, reject) => {
      if (server.listening) { resolve(); return; }
      server.once('error', reject);
      server.once('listening', () => resolve());
    });
    try {
      const ctx = { controllerHome: root, repoId: 'repo-forge' } as any;
      const started = await callCoreCapabilityAdapter(ctx, 'capability_execute', {
        capability_id: 'controller.workflow_supervisor', action: 'start', request_id: 'standalone-proof-capability-test', repo_id: 'repo-forge',
        arguments: { objective: 'Prove the existing Supervisor authority is reachable through capability_execute.' },
      });
      expect(started?.isError).not.toBe(true);
      expect(started?.structuredContent).toMatchObject({
        task: { conversationId: expect.stringContaining('bootstrap:supervisor:'), continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, repo_id: 'repo-forge' } },
        effect: { kind: 'enrollment' },
      });
      const listed = await callCoreCapabilityAdapter(ctx, 'capability_execute', {
        capability_id: 'controller.workflow_supervisor', action: 'list', request_id: 'standalone-proof-capability-list-test', repo_id: 'repo-forge', arguments: {},
      });
      expect(listed?.structuredContent).toMatchObject({ count: 1, activeOnly: true });
      expect(store.listTasks()).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
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
