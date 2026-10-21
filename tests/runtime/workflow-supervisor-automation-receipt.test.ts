import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { forgeWorkflowSupervisorValidators } from '../../supervisor/forge-validators';
import { WorkflowSupervisorStore } from '../../supervisor/store';
import { parseSupervisorCompletion, renderSupervisorPrompt, renderSupervisorReceipt, supervisorReceiptChallenge, SUPERVISOR_TURN_BLOCK_END, SUPERVISOR_TURN_BLOCK_START } from '../../supervisor/protocol';
import { callCoreCapabilityAdapter } from '../../adapters/mcp/runtime-gateway/core-capability-adapter';
import { createWorkflowSupervisorServer } from '../../supervisor/server';
import { workflowSupervisorSocketPath } from '../../supervisor/paths';
import { createWorkSemanticContext, reviseWorkSemanticContext } from '../../packages/kernel/work/api/index';
import { createRequirement, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';
import { SEMANTIC_SCOPE_KEY } from '../../src/effects/controller-home';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Workflow Supervisor automation receipts', () => {
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

  test('accepts completed final assistant reply and deduplicates causal continuation', async () => {
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

    const responseText = 'Implemented and verified a change.\n' + renderSupervisorReceipt(task, effect.effectId, 'CONTINUE');
    const first = await control.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId, responseText });
    const replay = await control.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId, responseText });

    expect(first).toMatchObject({ action: 'CONTINUE', terminal: false });
    expect(replay).toMatchObject({ action: 'CONTINUE', terminal: false });
    expect(store.getEffectByOriginKey(`completion:${(first as { completionFingerprint: string }).completionFingerprint}`)).toBeDefined();
    const enrollmentPrompt = renderSupervisorPrompt(task, effect.effectId, 'enrollment');
    expect(enrollmentPrompt).toContain('\nreceipt:' + supervisorReceiptChallenge(task, effect.effectId));
    expect(enrollmentPrompt).not.toContain('automation.receipt:');
    expect(enrollmentPrompt).toStartWith('<<<FORGE_WORKFLOW_EFFECT_V1:');
    expect(enrollmentPrompt).toContain('目标摘录：');
    expect(enrollmentPrompt).toContain('supervisor_task get');
    expect(enrollmentPrompt).not.toContain('CONTINUE => "C ');
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
      const startedTask = (started?.structuredContent as any).task;
      const startedEffect = (started?.structuredContent as any).effect;
      const revised = await callCoreCapabilityAdapter(ctx, 'capability_execute', {
        capability_id: 'controller.workflow_supervisor', action: 'revise', request_id: 'standalone-proof-capability-revise-test', repo_id: 'repo-forge',
        arguments: {
          task_id: startedTask.taskId,
          objective: 'Deliver the standalone Supervisor outcome through the V2 goal envelope.',
          expected_objective_sha256: createHash('sha256').update(startedTask.objective).digest('hex'),
          authorized_by: 'user',
        },
      });
      expect(revised?.isError).not.toBe(true);
      expect(revised?.structuredContent).toMatchObject({
        changed: true,
        task: { taskId: startedTask.taskId, conversationId: startedTask.conversationId, objective: 'Deliver the standalone Supervisor outcome through the V2 goal envelope.' },
        refreshedEffect: { effectId: startedEffect.effectId },
      });
      expect((revised?.structuredContent as any).refreshedEffect.prompt).toContain('Deliver the standalone Supervisor outcome through the V2 goal envelope.');
      expect(store.listTasks()).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });

  test('advances a standalone Supervisor task CONTINUE -> CONTINUE -> DONE without Work or Plan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-standalone-'));
    roots.push(root);
    const validators = forgeWorkflowSupervisorValidators();
    const options = { controllerHome: root, repoId: 'repo-proof' };
    createRequirement({ controllerHome: root }, {
      requirementId: 'REQ-LINEAGE', title: 'Bound goal', outcomeStatement: 'Close the bound Work.',
    });
    updateRequirement({ controllerHome: root }, {
      requirementId: 'REQ-LINEAGE', action: 'fixture_activate',
      mutate: (current) => ({ ...current, state: 'active' }),
    });
    updateRequirement({ controllerHome: root }, {
      requirementId: 'REQ-LINEAGE', action: 'fixture_acceptance',
      mutate: (current) => ({ ...current, state: 'done', semanticAcceptance: {
        reviewer: 'test', rationale: 'goal accepted', planIds: [], acceptedAt: new Date().toISOString(),
      } }),
    });
    const parent = createWorkSemanticContext(options, {
      workId: 'lineage-parent', objective: 'Bound parent', requirementId: 'REQ-LINEAGE',
    });
    const child = createWorkSemanticContext(options, {
      workId: 'lineage-child', objective: 'Bound child', semanticParentWorkId: parent.workId,
    });
    reviseWorkSemanticContext(options, parent.workId, { expectedRevision: 1, state: 'completed' });
    const proposal = { action: 'DONE' as const, sourceEffectId: 'fx_fixture', checkpoint: 'done', reason: 'done', evidence: [] };
    const validationTask = {
      taskId: 'validator-fixture', conversationId: 'fixture', conversationUrl: 'https://chatgpt.com/c/fixture',
      objective: 'Validate bound lineage', createdAt: new Date().toISOString(),
      completionContract: { kind: 'forge_requirement_done', controller_home: root, repo_id: options.repoId, requirement_id: 'REQ-LINEAGE' },
      continuationPolicy: {}, userBlockerPolicy: {},
    };
    expect((await validators.completionContract!(validationTask, proposal)).valid).toBe(false);
    const workTask = { ...validationTask, completionContract: {
      kind: 'forge_work_done', controller_home: root, repo_id: options.repoId, work_id: parent.workId,
    } };
    expect((await validators.completionContract!(workTask, proposal)).valid).toBe(false);
    const modelBoundTask = { ...workTask, completionContract: { ...workTask.completionContract, kind: 'model_semantic_completion' } };
    expect((await validators.completionContract!(modelBoundTask, proposal)).valid).toBe(false);
    // A semantic CAS, rather than Process/commit/cleanup, settles the child.
    reviseWorkSemanticContext(options, child.workId, { expectedRevision: 1, state: 'completed' });
    expect((await validators.completionContract!(workTask, proposal)).valid).toBe(true);
    expect((await validators.completionContract!(validationTask, proposal)).valid).toBe(true);
    createWorkSemanticContext(options, { workId: 'unrelated-open', objective: 'Another goal stays open' });
    expect((await validators.completionContract!(workTask, proposal)).valid).toBe(true);
    expect((await validators.completionContract!(modelBoundTask, proposal)).valid).toBe(true);
    const portable = { controllerHome: root, scopeKey: SEMANTIC_SCOPE_KEY };
    createWorkSemanticContext(portable, { workId: parent.workId, objective: 'Canonical semantic parent', requirementId: 'REQ-LINEAGE' });
    // A terminal repository compatibility row cannot hide a current semantic obligation.
    expect((await validators.completionContract!(workTask, proposal)).valid).toBe(false);
    reviseWorkSemanticContext(portable, parent.workId, { expectedRevision: 1, state: 'completed' });
    expect((await validators.completionContract!(workTask, proposal)).valid).toBe(true);
    const dependency = createWorkSemanticContext(portable, { workId: 'portable-dependency', objective: 'Declared prerequisite' });
    createWorkSemanticContext(portable, {
      workId: 'portable-child', objective: 'Portable child', semanticParentWorkId: parent.workId,
      dependsOnWorkIds: [dependency.workId],
    });
    reviseWorkSemanticContext(portable, 'portable-child', { expectedRevision: 1, state: 'completed' });
    const portableRequirementTask = { ...validationTask, completionContract: {
      kind: 'forge_requirement_done', controller_home: root, requirement_id: 'REQ-LINEAGE',
    } };
    expect((await validators.completionContract!(portableRequirementTask, proposal)).valid).toBe(false);
    reviseWorkSemanticContext(portable, dependency.workId, { expectedRevision: 1, state: 'completed' });
    expect((await validators.completionContract!(portableRequirementTask, proposal)).valid).toBe(true);

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
    const noToolResponse = 'NO_TOOL_RECEIPT：本轮没有可调用的 Forge 工具。\n'
      + renderSupervisorReceipt(task, firstEffect.effectId, 'NEEDS_USER');
    const noToolProposal = parseSupervisorCompletion(noToolResponse, {
      task, effectId: firstEffect.effectId, prompt: firstEffect.prompt,
    }).proposal;
    expect(noToolProposal.evidence).toEqual(['NO_TOOL_RECEIPT']);
    expect((await forgeWorkflowSupervisorValidators().userBlockerPolicy(task, noToolProposal)))
      .toMatchObject({ valid: false, reason: 'tool_unavailable_not_user_blocker' });
    expect((await forgeWorkflowSupervisorValidators().userBlockerPolicy(task, { ...noToolProposal, evidence: [] })).valid)
      .toBe(true);
    control.observeEffect({ effectId: firstEffect.effectId, observationId: 'applied-1', outcome: 'applied' });
    const first = await control.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId,
      responseText: 'Useful work first.\n' + renderSupervisorReceipt(task, firstEffect.effectId, 'CONTINUE') });
    expect(first).toMatchObject({ action: 'CONTINUE', terminal: false });
    const secondEffect = (first as { successorEffect: { effectId: string } }).successorEffect;
    control.observeEffect({ effectId: secondEffect.effectId, observationId: 'applied-2', outcome: 'applied' });
    const second = await control.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId,
      responseText: 'More verified work.\n' + renderSupervisorReceipt(task, secondEffect.effectId, 'CONTINUE') });
    expect(second).toMatchObject({ action: 'CONTINUE', terminal: false });
    const thirdEffect = (second as { successorEffect: { effectId: string } }).successorEffect;
    control.observeEffect({ effectId: thirdEffect.effectId, observationId: 'applied-3', outcome: 'applied' });
    const third = await control.observeAssistantTurn({ taskId: task.taskId, conversationId: task.conversationId,
      responseText: 'Goal delivered.\n' + renderSupervisorReceipt(task, thirdEffect.effectId, 'DONE') });
    expect(third).toMatchObject({
      action: 'DONE',
      terminal: true,
      validation: { valid: true, reason: 'model_semantic_completion' },
    });
    store.close();
  });
});
