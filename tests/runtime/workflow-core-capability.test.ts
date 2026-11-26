import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowAssetDraft, WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import {
  getCoreCapabilityExecutionSchema,
  listCapabilityDescriptors,
} from '../../src/runtime/control-plane/facade/capability-registry';
import {
  writeWorkflowAssetContent,
  writeWorkflowGraphAssetContent,
} from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  recordWorkflowBindings,
  registerWorkflowFeatureAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { callCoreCapabilityAdapter } from '../../adapters/mcp/runtime-gateway/core-capability-adapter';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-workflow-capability-'));
  roots.push(value);
  return value;
}
const draft: WorkflowAssetDraft = {
  schemaVersion: 1,
  workflowId: 'cap.demo',
  version: '1',
  inputContract: { message: { type: 'string', required: true } },
  steps: [{ stepId: 'notify', capabilityId: 'notify', input: { message: '{{input.message}}' } }],
};
function ctx(controllerHome: string) {
  return {
    controllerHome,
    sessionId: 'test',
    principalId: 'test',
    controllerInstanceId: 'test',
    repositories: [],
  } as never;
}
function install(h: string) {
  const written = writeWorkflowAssetContent({ kind: 'controller', controllerHome: h }, draft);
  const registered = registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'installed',
  });
  return recordWorkflowBindings({
    controllerHome: h,
    scope: { kind: 'controller' },
    expectedIdentity: registered.value,
    bindings: [{ capabilityId: 'notify', pluginId: 'test', actionId: 'send' }],
  });
}
function installGraph(h: string) {
  const graph: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'graph.preview',
    version: '1',
    inputContract: { route: { type: 'string', required: true } },
    entryNodeId: 'route',
    nodes: [
      { kind: 'branch', nodeId: 'route' },
      { kind: 'approval', nodeId: 'approve', approvalKey: 'send', prompt: 'Send notification?', timeoutMs: 60000 },
      { kind: 'capability', nodeId: 'notify', capabilityId: 'notify', idempotency: 'idempotent' },
      {
        kind: 'wait_event',
        nodeId: 'wait',
        sources: ['agentmail.watch'],
        eventTypes: ['mail.reply'],
        correlation: { kind: 'input', name: 'route' },
        timeoutMs: 120000,
      },
      { kind: 'workflow', nodeId: 'child', workflowId: 'child.followup' },
    ],
    edges: [
      {
        edgeId: 'approval-route',
        from: 'route',
        to: 'approve',
        on: 'condition',
        condition: {
          kind: 'compare',
          operator: 'equals',
          left: { kind: 'input', name: 'route' },
          right: { kind: 'literal', value: 'approve' },
        },
      },
      { edgeId: 'wait-route', from: 'route', to: 'wait', on: 'default' },
      { edgeId: 'approved', from: 'approve', to: 'notify', on: 'success' },
      { edgeId: 'waited', from: 'wait', to: 'child', on: 'success' },
    ],
  };
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, graph);
  const registered = registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
  return recordWorkflowBindings({
    controllerHome: h,
    scope: { kind: 'controller' },
    expectedIdentity: registered.value,
    bindings: [{ capabilityId: 'notify', pluginId: 'test', actionId: 'send' }],
    expectedRevision: registered.revision,
  });
}

function content(result: Awaited<ReturnType<typeof callCoreCapabilityAdapter>>) {
  const item = result?.content?.[0];
  if (item?.type !== 'text') throw new Error('WORKFLOW_CORE_CAPABILITY_TEXT_RESULT_REQUIRED');
  return JSON.parse(item.text);
}

describe('workflow.control core capability', () => {
  test('is discoverable as an independent workflow domain/group through capability_execute', () => {
    const descriptor = listCapabilityDescriptors().find((item) => item.capabilityId === 'workflow.control');
    expect(descriptor).toMatchObject({ domain: 'workflow', group: 'workflow', exposedVia: 'capability_execute' });
    expect(getCoreCapabilityExecutionSchema('workflow.control')).toMatchObject({
      executeWith: 'capability_execute',
      actions: {
        list: { readOnly: true },
        get: { readOnly: true },
        prepare: { readOnly: true },
        preview: { readOnly: true },
        authoring_preflight: { readOnly: true },
        install: { readOnly: false },
        execute: { readOnly: false },
        activate: { readOnly: false },
        deactivate: { readOnly: false },
      },
    });
  });
  test('lists and inspects installed workflows without project/event coupling', async () => {
    const h = home();
    install(h);
    const listed = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'list',
        request_id: 'r1',
        arguments: {},
      }),
    );
    expect(listed.workflows).toHaveLength(1);
    expect(listed.workflows[0].descriptor.workflowId).toBe('cap.demo');
    const got = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'get',
        request_id: 'r2',
        arguments: { workflow_id: 'cap.demo' },
      }),
    );
    expect(got.workflow.descriptor.engine).toBe('sequence_v1');
  });
  test('previews Graph v2 structure, branches, approvals, waits and external effects without execution', async () => {
    const h = home();
    installGraph(h);
    const value = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'preview',
        request_id: 'preview-1',
        arguments: { workflow_id: 'graph.preview', inputs: { route: 'approve' } },
      }),
    );
    expect(value.preview).toMatchObject({
      workflow: { workflowId: 'graph.preview', version: '1', engine: 'graph_v2' },
      status: 'active',
      readiness: 'blocked',
      execution: 'not_executed',
      permissions: {
        authorization: 'not_authorized',
        bindings: [{ capabilityId: 'notify', pluginId: 'test', actionId: 'send' }],
      },
      branches: [{ nodeId: 'route' }],
      waits: [{ nodeId: 'wait', sources: ['agentmail.watch'], eventTypes: ['mail.reply'], timeoutMs: 120000 }],
      approvals: [{ nodeId: 'approve', approvalKey: 'send', prompt: 'Send notification?', timeoutMs: 60000 }],
    });
    expect(value.preview.blockers).toContain('WORKFLOW_CHILD_NOT_ACTIVE:child.followup');
    expect(value.preview.branches[0].routes).toHaveLength(2);
    expect(value.preview.potentialExternalEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'notify',
          phase: 'forward',
          kind: 'capability',
          capabilityId: 'notify',
          binding: { capabilityId: 'notify', pluginId: 'test', actionId: 'send' },
        }),
        expect.objectContaining({
          nodeId: 'child',
          phase: 'forward',
          kind: 'workflow',
          workflowId: 'child.followup',
        }),
      ]),
    );
    expect(JSON.stringify(value.preview)).not.toContain('process.stdout');
  });

  test('prepare validates inputs but never authorizes or executes', async () => {
    const h = home();
    install(h);
    const prepared = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'prepare',
        request_id: 'r3',
        arguments: {
          workflow_id: 'cap.demo',
          origin_kind: 'model',
          origin_id: 'model-1',
          inputs: { message: 'hello' },
        },
      }),
    );
    expect(prepared.plan).toMatchObject({
      readiness: 'blocked',
      blockers: ['WORKFLOW_NOT_ACTIVE'],
      authorization: 'not_authorized',
      execution: 'not_executed',
      origin: { kind: 'model' },
    });
  });
  test('activation is an explicit workflow lifecycle operation and makes prepare ready', async () => {
    const h = home();
    const installed = install(h);
    const activated = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'activate',
        request_id: 'r4',
        arguments: { workflow_id: 'cap.demo', expected_revision: installed.revision },
      }),
    );
    expect(activated.workflow.value.status).toBe('active');
    const prepared = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'prepare',
        request_id: 'r5',
        arguments: { workflow_id: 'cap.demo', origin_kind: 'user', inputs: { message: 'hello' } },
      }),
    );
    expect(prepared.plan).toMatchObject({
      readiness: 'ready',
      authorization: 'not_authorized',
      execution: 'not_executed',
    });
    const deactivated = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'deactivate',
        request_id: 'r6',
        arguments: { workflow_id: 'cap.demo' },
      }),
    );
    expect(deactivated.workflow.value.status).toBe('inactive');
  });
  test('model-authored Workflow can be preflighted and installed but not implicitly activated', async () => {
    const h = home();
    const proposal = {
      schemaVersion: 1,
      proposalId: 'model-proposal',
      author: { kind: 'model', id: 'model-1' },
      scope: { kind: 'controller' },
      operation: { kind: 'create' },
      draft: {
        schemaVersion: 1,
        workflowId: 'model.workflow',
        version: '1',
        inputContract: { message: { type: 'string', required: true } },
        steps: [{ stepId: 'run', kind: 'script', scriptRef: 'echo', input: { message: '{{input.message}}' } }],
        scripts: {
          echo: { runtime: 'node', deterministic: true, body: 'process.stdout.write(process.argv[1]||"")' },
        },
      },
    };
    const checked = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'authoring_preflight',
        request_id: 'r7',
        arguments: { proposal },
      }),
    );
    expect(checked.preflight).toMatchObject({
      valid: true,
      author: { kind: 'model' },
      descriptor: { workflowId: 'model.workflow', engine: 'sequence_v1' },
    });
    const installed = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'install',
        request_id: 'r8',
        arguments: { proposal },
      }),
    );
    expect(installed.workflow.value).toMatchObject({
      workflowId: 'model.workflow',
      status: 'installed',
      engine: 'sequence_v1',
    });
    const prepared = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'prepare',
        request_id: 'r9',
        arguments: { workflow_id: 'model.workflow', origin_kind: 'model', inputs: { message: 'hello' } },
      }),
    );
    expect(prepared.plan).toMatchObject({
      readiness: 'blocked',
      blockers: ['WORKFLOW_NOT_ACTIVE'],
      execution: 'not_executed',
    });
  });

  test('project-scope install fails closed until Project Authority owns a Workflow content contract', async () => {
    const h = home();
    const proposal = {
      schemaVersion: 1,
      proposalId: 'project-proposal',
      author: { kind: 'model', id: 'model-1' },
      scope: { kind: 'project', projectId: 'project-1' },
      operation: { kind: 'create' },
      draft: {
        schemaVersion: 1,
        workflowId: 'project.workflow',
        version: '1',
        steps: [{ stepId: 'run', kind: 'script', scriptRef: 'echo' }],
        scripts: { echo: { runtime: 'node', deterministic: true, body: 'process.stdout.write("ok")' } },
      },
    };
    const output = content(
      await callCoreCapabilityAdapter(ctx(h), 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'install',
        request_id: 'r10',
        arguments: { proposal },
      }),
    );
    expect(JSON.stringify(output)).toContain('WORKFLOW_CAPABILITY_PROJECT_INSTALL_REQUIRES_PROJECT_CONTENT_AUTHORITY');
  });
  test('execute is a first-class Workflow capability and fails before engine dispatch when inactive', async () => {
    const h = home();
    install(h);
    const repository = { repoId: 'repo-1', activeCheckoutId: 'checkout-1' };
    const runtimeCtx = {
      controllerHome: h,
      sessionId: 'test',
      principalId: 'test',
      controllerInstanceId: 'test',
      repositories: [],
      repositoryAccess: {
        resolve: () => repository,
        list: () => [repository],
      },
    } as never;
    const output = content(
      await callCoreCapabilityAdapter(runtimeCtx, 'capability_execute', {
        capability_id: 'workflow.control',
        action: 'execute',
        request_id: 'r11',
        repo_id: 'repo-1',
        checkout_id: 'checkout-1',
        arguments: {
          workflow_id: 'cap.demo',
          run_id: 'run-1',
          origin_kind: 'model',
          inputs: { message: 'hello' },
        },
      }),
    );
    expect(JSON.stringify(output)).toContain('WORKFLOW_INVOCATION_BLOCKED:WORKFLOW_NOT_ACTIVE');
  });
});
