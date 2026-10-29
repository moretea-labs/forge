import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callWorkflowSupervisorAdapter } from '../../adapters/mcp/runtime-gateway/workflow-supervisor-adapter';
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

async function fixture(discoverProject: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'forge-supervisor-bootstrap-project-start-'));
  roots.push(root);
  const store = new WorkflowSupervisorStore(root);
  stores.push(store);
  const control = new WorkflowSupervisorControlPlane(store);
  if (discoverProject) control.recordBrowserDiscovery('chrome', [{
    conversationId: '11111111-2222-3333-4444-555555555555',
    canonicalUrl: `https://chatgpt.com/g/${projectId}-forge/c/11111111-2222-3333-4444-555555555555`,
    projectTitle: 'Forge', projectUrl,
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

  test('an undiscovered Project fails closed before enrollment effect reservation', async () => {
    const { root, control } = await fixture(false);
    await expect(callWorkflowSupervisorAdapter(context(root), 'supervisor_task', startArgs('undiscovered-project', projectUrl)))
      .rejects.toThrow('WORKFLOW_SUPERVISOR_BOOTSTRAP_PROJECT_NOT_DISCOVERED');
    const task = control.listTasks(false).find((candidate) => candidate.objective.includes('fixed-HEAD independent #483 review'));
    expect(task).toBeDefined();
    expect(control.bootstrapPoll(task!.taskId).command).toBeFalsy();
  });
});
