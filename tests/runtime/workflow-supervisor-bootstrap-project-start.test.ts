import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callWorkflowSupervisorAdapter } from '../../adapters/mcp/runtime-gateway/workflow-supervisor-adapter';
import { callCoreCapabilityAdapter } from '../../adapters/mcp/runtime-gateway/core-capability-adapter';
import { runtimeToolDefinitions } from '../../adapters/mcp/runtime-gateway/runtime-tool-definitions';
import { WorkflowSupervisorControlPlane } from '../../supervisor/control-plane';
import { workflowSupervisorSocketPath } from '../../supervisor/paths';
import { createWorkflowSupervisorServer } from '../../supervisor/server';
import { WorkflowSupervisorStore } from '../../supervisor/store';

const roots: string[] = [];
const stores: WorkflowSupervisorStore[] = [];
const servers: Server[] = [];
const projectId = 'g-p-6a922010db348191a84d1a5306c083e8';
const projectUrl = `https://chatgpt.com/g/${projectId}/project`;
const repoId = 'repo-bootstrap-project-test';

async function fixture(discoverProject: boolean, scopeForTask = false, discoveredProjectId = projectId) {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-project-start-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(root);
  stores.push(store);
  const control = new WorkflowSupervisorControlPlane(store, {}, scopeForTask
    ? { projectScopeForTask: () => ({ title: 'Forge', repoId }) }
    : {});
  if (discoverProject) control.recordBrowserDiscovery('chrome', [{
    conversationId: '11111111-2222-3333-4444-555555555555',
    canonicalUrl: `https://chatgpt.com/g/${discoveredProjectId}-forge/c/11111111-2222-3333-4444-555555555555`,
    projectTitle: 'Forge', projectUrl: `https://chatgpt.com/g/${discoveredProjectId}-forge/project`,
  }]);
  const server = createWorkflowSupervisorServer({ controlPlane: control, socketPath: workflowSupervisorSocketPath(root) });
  servers.push(server);
  if (!server.listening) await once(server, 'listening');
  return { root, store, control };
}

const context = (controllerHome: string) => ({ controllerHome, repoId }) as never;
const startArgs = (requestId: string, project_url?: string) => ({
  operation: 'start', repo_id: repoId, request_id: requestId,
  objective: 'Run a fixed-HEAD independent #483 review in the existing Forge Project.',
  ...(project_url ? { project_url } : {}), authorized_by: 'user-authorized #483 Project binding',
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Supervisor bootstrap Project binding before enrollment', () => {
  test('exposes project_url and binds the exact observed Project before reserving the first effect', async () => {
    const definition = runtimeToolDefinitions.find((tool) => tool.name === 'supervisor_task');
    const schema = definition?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties?.project_url).toMatchObject({ type: 'string', maxLength: 2048 });

    const { root, store, control } = await fixture(true);
    const result = await callWorkflowSupervisorAdapter(context(root), 'supervisor_task', startArgs('start-bound-project', projectUrl));
    expect(result).toBeDefined();
    if (!result) throw new Error('SUPERVISOR_TASK_START_RESULT_MISSING');
    expect(result.isError).not.toBe(true);
    const payload = result.structuredContent as { task: { taskId: string }; effect: { effectId: string } };
    expect(control.bootstrapProjectUrl(payload.task.taskId)).toBe(projectUrl);
    expect(control.bootstrapPoll(payload.task.taskId).command?.effectId).toBe(payload.effect.effectId);
    expect(store.effectDispatchBudget(payload.effect.effectId).generations).toBe(0);
    const conversationId = '33333333-4444-5555-6666-777777777777';
    store.bindBootstrapConversation(payload.task.taskId, conversationId, `https://chatgpt.com/c/${conversationId}`);
    const retry = await callWorkflowSupervisorAdapter(context(root), 'supervisor_task', startArgs('start-bound-project', projectUrl));
    expect(retry?.structuredContent).toMatchObject({
      task: { taskId: payload.task.taskId, conversationId }, effect: { effectId: payload.effect.effectId },
    });
    expect(control.listTasks(false)).toHaveLength(1);
    expect(store.effectDispatchBudget(payload.effect.effectId).generations).toBe(0);
  });

  test('an existing bootstrap can be bound through the public operation without replaying its effect', async () => {
    const competingProjectId = 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { root, store, control } = await fixture(true, true, competingProjectId);
    const task = control.registerTask({
      taskId: 'supervisor:legacy-project-bind', conversationId: 'bootstrap:supervisor:legacy-project-bind',
      conversationUrl: 'https://chatgpt.com/', objective: 'Bind an existing independent Reviewer without creating another task.',
      completionContract: { kind: 'model_semantic_completion', controller_home: root, repo_id: repoId },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, repo_id: repoId },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    const effect = control.reserveEnrollment(task.taskId);
    expect(control.bootstrapPoll(task.taskId).command?.effectId).toBe(effect.effectId);
    expect(JSON.stringify(runtimeToolDefinitions.find((tool) => tool.name === 'supervisor_task')?.inputSchema))
      .toContain('bootstrap_project_bind');

    const bindArgs = {
      operation: 'bootstrap_project_bind', repo_id: repoId, task_id: task.taskId,
      project_url: projectUrl, request_id: 'bind-existing-reviewer',
      authorized_by: 'user-authorized #483 Project binding',
    };
    await expect(callWorkflowSupervisorAdapter(context(root), 'supervisor_task', bindArgs))
      .rejects.toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_NOT_DISCOVERED');
    expect(control.getTask(task.taskId)?.continuationPolicy.project_binding_required).toBe(true);
    expect(() => control.registerTask({
      taskId: task.taskId, conversationId: task.conversationId, conversationUrl: task.conversationUrl,
      objective: task.objective, completionContract: task.completionContract,
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, repo_id: repoId },
      userBlockerPolicy: task.userBlockerPolicy,
    })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_REQUIRED');
    expect(control.bootstrapPoll(task.taskId).command).toBeFalsy();
    expect(() => store.recordEffectDispatchStarted(effect.effectId, 1, 'stale-poll-after-failed-bind'))
      .toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_REQUIRED');
    expect(store.getEffectByOriginKey(`enrollment:${task.taskId}`)?.effectId).toBe(effect.effectId);

    control.recordBrowserDiscovery('chrome', [{
      conversationId: '22222222-3333-4444-5555-666666666666',
      canonicalUrl: `https://chatgpt.com/g/${projectId}-forge/c/22222222-3333-4444-5555-666666666666`,
      projectTitle: 'Forge', projectUrl,
    }]);
    const bound = await callWorkflowSupervisorAdapter(context(root), 'supervisor_task', bindArgs);
    expect(bound?.isError).not.toBe(true);
    expect(bound?.structuredContent).toMatchObject({ taskId: task.taskId, projectUrl, deduplicated: false, status: 'project_bound' });
    expect(control.bootstrapProjectUrl(task.taskId)).toBe(projectUrl);
    expect(control.bootstrapPoll(task.taskId).command?.effectId).toBe(effect.effectId);
    expect(store.getEffectByOriginKey(`enrollment:${task.taskId}`)?.effectId).toBe(effect.effectId);
    const conversationId = '33333333-4444-5555-6666-777777777777';
    store.bindBootstrapConversation(task.taskId, conversationId, `https://chatgpt.com/c/${conversationId}`);
    const retry = await callWorkflowSupervisorAdapter(context(root), 'supervisor_task', bindArgs);
    expect(retry?.structuredContent).toMatchObject({ taskId: task.taskId, projectUrl, deduplicated: true });
    await expect(callWorkflowSupervisorAdapter(context(root), 'supervisor_task', {
      ...bindArgs, project_url: `https://chatgpt.com/g/${competingProjectId}/project`,
    })).rejects.toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_CONFLICT');
    expect(store.getTask(task.taskId)?.conversationId).toBe(conversationId);
    expect(store.getEffectByOriginKey(`enrollment:${task.taskId}`)?.effectId).toBe(effect.effectId);
  });

  test('binds an existing Work-owned Reviewer after ambiguous pre-send discovery without replacing its effect', async () => {
    const competingProjectId = 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { root, store, control } = await fixture(true, true, competingProjectId);
    const workId = 'work-review-once';
    const taskId = `forge:${repoId}:work:${workId}`;
    const registration = {
      taskId, conversationId: `bootstrap:${workId}`, conversationUrl: 'https://chatgpt.com/',
      objective: 'One-shot exact SHA independent reviewer',
      completionContract: { kind: 'forge_work_done', controller_home: root, repo_id: repoId, work_id: workId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', bootstrap: true, outer_turn_owner: 'workflow_supervisor' },
      userBlockerPolicy: { kind: 'forge_work_waiting_for_user', controller_home: root, repo_id: repoId, work_id: workId },
    };
    const task = control.registerTask(registration);
    const effect = control.reserveEnrollment(task.taskId);
    control.recordBrowserDiscovery('chrome', [{
      conversationId: '22222222-3333-4444-5555-666666666666',
      canonicalUrl: `https://chatgpt.com/g/${projectId}/c/22222222-3333-4444-5555-666666666666`,
      projectTitle: 'Forge', projectUrl,
    }]);
    expect(() => control.bootstrapProjectUrl(task.taskId)).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_AMBIGUOUS');
    store.recordBrowserDeliveryAttemptFailure({
      taskId: task.taskId, conversationId: task.conversationId, effectId: effect.effectId,
      code: 'WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_AMBIGUOUS',
    });
    expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
    const args = {
      operation: 'bootstrap_project_bind', repo_id: repoId, task_id: task.taskId,
      project_url: projectUrl, request_id: 'bind-existing-work-reviewer',
      authorized_by: 'explicit operator verified Project',
    };
    const receipt = await callCoreCapabilityAdapter(context(root), 'capability_execute', {
      capability_id: 'controller.workflow_supervisor', action: 'bootstrap_project_bind',
      repo_id: repoId, request_id: args.request_id,
      arguments: { task_id: args.task_id, project_url: args.project_url, authorized_by: args.authorized_by },
    });
    expect(receipt?.structuredContent).toMatchObject({ taskId: task.taskId, projectUrl, status: 'project_bound' });
    expect(control.bootstrapProjectUrl(task.taskId)).toBe(projectUrl);
    expect(control.bootstrapPoll(task.taskId).command?.effectId).toBe(effect.effectId);
    expect(control.registerTask(registration)).toMatchObject({ taskId, conversationId: task.conversationId });
    expect(store.getEffectByOriginKey(`enrollment:${task.taskId}`)?.effectId).toBe(effect.effectId);
    expect(() => control.registerTask({ ...registration, objective: 'Conflicting identity' }))
      .toThrow('WORKFLOW_SUPERVISOR_TASK_ID_CONFLICT');
    expect(store.effectDispatchBudget(effect.effectId).generations).toBe(0);
    expect((await callWorkflowSupervisorAdapter(context(root), 'supervisor_task', args))?.structuredContent)
      .toMatchObject({ deduplicated: true });
    await expect(callWorkflowSupervisorAdapter(context(root), 'supervisor_task', {
      ...args, project_url: `https://chatgpt.com/g/${competingProjectId}/project`,
    })).rejects.toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_CONFLICT');
  });

  test('cannot bind a Work-owned bootstrap after any provider dispatch has started', async () => {
    const { root, store, control } = await fixture(true);
    const workId = 'work-review-already-dispatched';
    const task = control.registerTask({
      taskId: `forge:${repoId}:work:${workId}`,
      conversationId: `bootstrap:${workId}`, conversationUrl: 'https://chatgpt.com/',
      objective: 'Unsafe late Project change must be blocked',
      completionContract: { kind: 'forge_work_done', repo_id: repoId, work_id: workId },
      continuationPolicy: { kind: 'forge_goal_outer_turn', bootstrap: true },
      userBlockerPolicy: {},
    });
    const effect = control.reserveEnrollment(task.taskId);
    store.recordEffectDispatchStarted(effect.effectId, 1, 'real-send-already-started');
    expect(() => control.bindBootstrapProject({
      taskId: task.taskId, projectUrl, requestId: 'late-work-binding', authorizedBy: 'operator',
    })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_OUTCOME_UNRESOLVED');
    expect(store.boundBootstrapProjectUrl(task.taskId)).toBeUndefined();
  });

  test('first Project binding is rejected after any provider dispatch has begun', async () => {
    const { root, store, control } = await fixture(true);
    const task = control.registerTask({
      taskId: 'supervisor:late-project-bind', conversationId: 'bootstrap:supervisor:late-project-bind',
      conversationUrl: 'https://chatgpt.com/', objective: 'Legacy unbound bootstrap before first project binding.',
      completionContract: { kind: 'model_semantic_completion', controller_home: root, repo_id: repoId },
      continuationPolicy: { kind: 'standalone_supervisor', repo_id: repoId },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });
    const effect = control.reserveEnrollment(task.taskId);
    store.recordEffectDispatchStarted(effect.effectId, 1, 'send-before-project-bind');

    expect(() => control.bindBootstrapProject({
      taskId: task.taskId, projectUrl, requestId: 'late-bind-after-dispatch', authorizedBy: 'user-authorized #483 Project binding',
    })).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_BINDING_OUTCOME_UNRESOLVED');
  });

  test('start without project_url is rejected before task/effect creation, even without repository provenance', async () => {
    const { root, control } = await fixture(true);
    await expect(callWorkflowSupervisorAdapter(context(root), 'supervisor_task', startArgs('missing-project-url')))
      .rejects.toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_REQUIRED');
    await expect(callWorkflowSupervisorAdapter({ controllerHome: root } as never, 'supervisor_task', {
      operation: 'start', request_id: 'unbound-missing-project-url', objective: 'Unbound standalone task must still have an exact Project.',
    })).rejects.toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_REQUIRED');
    expect(control.listTasks(false)).toHaveLength(0);
  });

  test('an undiscovered explicit Project cannot be replaced by a scope-matching Project during recovery', async () => {
    const competingProjectId = 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { root, store, control } = await fixture(true, true, competingProjectId);
    await expect(callWorkflowSupervisorAdapter(context(root), 'supervisor_task', startArgs('undiscovered-project', projectUrl)))
      .rejects.toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_NOT_DISCOVERED');
    const task = control.listTasks(false).find((candidate) => candidate.objective.includes('fixed-HEAD independent #483 review'));
    expect(task).toBeDefined();
    expect(task!.continuationPolicy.project_binding_required).toBe(true);

    // The start failure leaves a task record, but it must not create an effect
    // later when the actual Runtime recovery scanner reconciles inert tasks.
    expect(store.listTasksWithoutCausalObligation()).toEqual([]);
    await control.reconcileCommittedContinuations();
    expect(store.getEffectByOriginKey(`enrollment:${task!.taskId}`)).toBeUndefined();
    expect(control.bootstrapPoll(task!.taskId).command).toBeFalsy();
    expect(() => control.bootstrapProjectUrl(task!.taskId)).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_REQUIRED');
  });

  test('a crash between task registration and Project binding stays inert and recovers after exact binding', async () => {
    const { root, store, control } = await fixture(true, true);
    const task = control.registerTask({
      taskId: 'supervisor:crash-before-project-bind', conversationId: 'bootstrap:supervisor:crash-before-project-bind',
      conversationUrl: 'https://chatgpt.com/', objective: 'Crash between registration and explicit Project binding.',
      completionContract: { kind: 'model_semantic_completion', controller_home: root, repo_id: repoId },
      continuationPolicy: { kind: 'standalone_supervisor', bootstrap: true, project_binding_required: true, repo_id: repoId },
      userBlockerPolicy: { kind: 'model_semantic_user_blocker' },
    });

    expect(() => control.reserveEnrollment(task.taskId)).toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_REQUIRED');
    expect(store.listTasksWithoutCausalObligation()).toEqual([]);
    await control.reconcileCommittedContinuations();
    expect(store.getEffectByOriginKey(`enrollment:${task.taskId}`)).toBeUndefined();
    expect(control.bootstrapPoll(task.taskId).command).toBeFalsy();

    control.bindBootstrapProject({ taskId: task.taskId, projectUrl, requestId: 'bind-after-recovery', authorizedBy: 'user-authorized #483 Project binding' });
    expect(store.listTasksWithoutCausalObligation().map((candidate) => candidate.taskId)).toContain(task.taskId);
    await control.reconcileCommittedContinuations();
    const effect = store.getEffectByOriginKey(`enrollment:${task.taskId}`);
    expect(effect).toBeDefined();
    expect(control.bootstrapProjectUrl(task.taskId)).toBe(projectUrl);
    expect(control.bootstrapPoll(task.taskId).command?.effectId).toBe(effect!.effectId);
  });
});
