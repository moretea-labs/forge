import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowGraphAssetDraft } from '../../packages/workflow-runtime/api/index';
import { writeWorkflowGraphAssetContent } from '../../src/runtime/control-plane/persistence/workflow-content-store';
import {
  recordWorkflowBindings,
  registerWorkflowFeatureAsset,
} from '../../src/runtime/control-plane/persistence/workflow-registry-store';
import { readWorkflowGraphRun } from '../../src/runtime/control-plane/persistence/workflow-run-store';
import {
  readAuthorizationRequest,
  resolveAuthorizationRequest,
} from '../../src/runtime/control-plane/governance/authorization';
import { executeRegisteredWorkflowGraph } from '../../src/runtime/workflows/graph-runtime';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-graph-runtime-'));
  roots.push(v);
  return v;
}
const repository = { repoId: 'repo-1', activeCheckoutId: 'checkout-1' } as never;
const executionIdentity = { repositoryId: 'repo-1', checkoutId: 'checkout-1' } as never;
function install(
  h: string,
  draft: WorkflowGraphAssetDraft,
  bindings: { capabilityId: string; pluginId: string; actionId: string }[] = [],
) {
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, draft);
  const registered = registerWorkflowFeatureAsset({
    controllerHome: h,
    scope: { kind: 'controller' },
    asset: written.asset,
    contentLocation: { kind: 'controller', path: written.path },
    status: 'active',
  });
  return bindings.length
    ? recordWorkflowBindings({
        controllerHome: h,
        scope: { kind: 'controller' },
        expectedIdentity: registered.value,
        bindings,
      })
    : registered;
}
function input(h: string, workflowId: string, inputs: Record<string, never | boolean | string | number | object> = {}) {
  return {
    controllerHome: h,
    repository,
    executionIdentity,
    scopeId: `repository:repo-1:checkout:checkout-1:workflow:${workflowId}`,
    runId: 'run-1',
    registryScope: { kind: 'controller' as const },
    workflowId,
    inputs: inputs as never,
  };
}

describe('registered Workflow Graph runtime', () => {
  test('executes capability through existing Plugin Action owner and persists graph run in workflow_run', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.capability',
      version: '1',
      entryNodeId: 'call',
      nodes: [{ kind: 'capability', nodeId: 'call', capabilityId: 'mail.read', idempotency: 'idempotent' }],
      edges: [],
    };
    install(h, draft, [{ capabilityId: 'mail.read', pluginId: 'mail', actionId: 'read' }]);
    const result = await executeRegisteredWorkflowGraph(input(h, 'graph.capability'), {
      submitPluginAction: async (_home, _repo, request) =>
        ({
          receipt: {
            receiptId: 'receipt-1',
            requestId: request.requestId,
            pluginId: 'mail',
            actionId: 'read',
            status: 'succeeded',
            createdAt: '2026-11-26T00:00:00.000Z',
          } as never,
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'mail' },
            action: { actionId: 'read', requestId: request.requestId },
            result: { message: 'ok' },
          },
        }) as never,
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    });
    expect(result.status).toBe('succeeded');
    expect(readWorkflowGraphRun(h, input(h, 'graph.capability').scopeId, 'run-1')?.value.status).toBe('succeeded');
  });
  test('executes deterministic script through Process Runtime owner', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.script',
      version: '1',
      entryNodeId: 'run',
      nodes: [{ kind: 'script', nodeId: 'run', scriptRef: 'echo' }],
      edges: [],
      scripts: { echo: { runtime: 'node', deterministic: true, body: '', outputFormat: 'json' } },
    };
    install(h, draft);
    let command: string[] | undefined;
    const result = await executeRegisteredWorkflowGraph(input(h, 'graph.script'), {
      executeCommand: async (request) => {
        command = request.command as string[];
        return {
          ok: true,
          process: { processId: 'p1', status: 'succeeded', completed: true, ok: true, stdout: '{"ok":true}' },
        } as never;
      },
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    });
    expect(result.status).toBe('succeeded');
    expect(command?.[0]).toBe('node');
    expect(result.nodes[0]?.output).toEqual({ ok: true });
  });
  test('uses parent workflow_run itself as durable event-wait registration', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.wait',
      version: '1',
      inputContract: { case_id: { type: 'string', required: true } },
      entryNodeId: 'wait',
      nodes: [
        {
          kind: 'wait_event',
          nodeId: 'wait',
          sources: ['agentmail.watch'],
          correlation: { kind: 'input', name: 'case_id' },
          timeoutMs: 60000,
        },
      ],
      edges: [],
    };
    install(h, draft);
    const result = await executeRegisteredWorkflowGraph(input(h, 'graph.wait', { case_id: 'case-1' }), {
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    });
    expect(result).toMatchObject({
      status: 'waiting',
      nodes: [
        { status: 'waiting', wait: { kind: 'event', correlationKey: 'case-1', expiresAt: '2026-11-26T00:01:00.000Z' } },
      ],
    });
    expect(readWorkflowGraphRun(h, input(h, 'graph.wait').scopeId, 'run-1')?.value.status).toBe('waiting');
  });
  test('approval uses the existing Authorization owner and resumes only after exact resolution', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.approval',
      version: '1',
      entryNodeId: 'approve',
      nodes: [
        { kind: 'approval', nodeId: 'approve', approvalKey: 'send', prompt: 'Send?', timeoutMs: 60000 },
        { kind: 'capability', nodeId: 'send', capabilityId: 'mail.send', idempotency: 'idempotent' },
      ],
      edges: [{ edgeId: 'approved', from: 'approve', to: 'send', on: 'success' }],
    };
    install(h, draft, [{ capabilityId: 'mail.send', pluginId: 'mail', actionId: 'send' }]);
    const base = {
      ...input(h, 'graph.approval'),
      approvalContext: { sessionId: 'session-1', principalId: 'principal-1', permissionSnapshotVersion: 1 },
    };
    const waiting = await executeRegisteredWorkflowGraph(base, {
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    });
    expect(waiting.status).toBe('waiting');
    const requestRef = waiting.nodes[0]?.wait?.kind === 'approval' ? waiting.nodes[0].wait.requestRef : undefined;
    expect(requestRef).toBeDefined();
    expect(readAuthorizationRequest(h, 'repo-1', requestRef!)).toMatchObject({
      status: 'pending',
      sessionId: 'session-1',
      principalId: 'principal-1',
      humanSummary: 'Send?',
    });
    resolveAuthorizationRequest({
      controllerHome: h,
      repositoryId: 'repo-1',
      approvalRequestId: requestRef!,
      sessionId: 'session-1',
      principalId: 'principal-1',
      permissionSnapshotVersion: 1,
      confirm: true,
    });
    let calls = 0;
    const result = await executeRegisteredWorkflowGraph(base, {
      submitPluginAction: async (_home, _repo, request) => {
        calls += 1;
        return {
          receipt: {
            receiptId: 'sent-1',
            requestId: request.requestId,
            pluginId: 'mail',
            actionId: 'send',
            status: 'succeeded',
            createdAt: '2026-11-26T00:00:10.000Z',
          } as never,
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'mail' },
            action: { actionId: 'send', requestId: request.requestId },
            result: { sent: true },
          },
        } as never;
      },
      now: () => new Date('2026-11-26T00:00:10.000Z'),
    });
    expect(calls).toBe(1);
    expect(result.status).toBe('succeeded');
  });

  test('approval fails closed without authenticated approval context', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.approval-context',
      version: '1',
      entryNodeId: 'approve',
      nodes: [{ kind: 'approval', nodeId: 'approve', approvalKey: 'send', prompt: 'Send?', timeoutMs: 60000 }],
      edges: [],
    };
    install(h, draft);
    await expect(
      executeRegisteredWorkflowGraph(input(h, 'graph.approval-context'), {
        now: () => new Date('2026-11-26T00:00:00.000Z'),
      }),
    ).rejects.toThrow('WORKFLOW_GRAPH_APPROVAL_CONTEXT_REQUIRED');
  });
  test('production Graph Runtime routes compensation through the existing Plugin owner with a distinct request identity', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.saga-runtime',
      version: '1',
      failurePolicy: { mode: 'compensate' },
      entryNodeId: 'create',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'create',
          capabilityId: 'create',
          idempotency: 'idempotent',
          compensation: { kind: 'capability', capabilityId: 'delete', idempotency: 'idempotent' },
        },
        { kind: 'capability', nodeId: 'fail', capabilityId: 'fail', idempotency: 'idempotent' },
      ],
      edges: [{ edgeId: 'e', from: 'create', to: 'fail', on: 'success' }],
    };
    install(h, draft, [
      { capabilityId: 'create', pluginId: 'svc', actionId: 'create' },
      { capabilityId: 'delete', pluginId: 'svc', actionId: 'delete' },
      { capabilityId: 'fail', pluginId: 'svc', actionId: 'fail' },
    ]);
    const requests: string[] = [];
    const result = await executeRegisteredWorkflowGraph(input(h, 'graph.saga-runtime'), {
      submitPluginAction: async (_home, _repo, request) => {
        requests.push(request.requestId);
        if (request.actionId === 'fail')
          return {
            receipt: {
              receiptId: 'fail-r',
              requestId: request.requestId,
              pluginId: 'svc',
              actionId: 'fail',
              status: 'failed',
              createdAt: '2026-11-26T00:00:02.000Z',
              error: { code: 'FAIL', message: 'fail' },
            } as never,
            result: {
              schemaVersion: 1,
              plugin: { pluginId: 'svc' },
              action: { actionId: 'fail', requestId: request.requestId },
              result: { status: 'failed' },
            },
          } as never;
        return {
          receipt: {
            receiptId: request.actionId + '-r',
            requestId: request.requestId,
            pluginId: 'svc',
            actionId: request.actionId,
            status: 'succeeded',
            createdAt: '2026-11-26T00:00:01.000Z',
          } as never,
          result: {
            schemaVersion: 1,
            plugin: { pluginId: 'svc' },
            action: { actionId: request.actionId, requestId: request.requestId },
            result: { ok: true },
          },
        } as never;
      },
      now: () => new Date('2026-11-26T00:00:03.000Z'),
    });
    expect(result.status).toBe('compensated');
    expect(requests.some((id) => id.endsWith(':create:1:compensation'))).toBe(true);
  });
});
