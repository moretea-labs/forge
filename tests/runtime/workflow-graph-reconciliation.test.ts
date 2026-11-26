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
  executeRegisteredWorkflowGraph,
  observeAndReconcileRegisteredWorkflowGraph,
} from '../../src/runtime/workflows/graph-runtime';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const v = mkdtempSync(join(tmpdir(), 'forge-graph-reconcile-'));
  roots.push(v);
  return v;
}
const repository = { repoId: 'repo-1', activeCheckoutId: 'checkout-1' } as never;
const executionIdentity = { repositoryId: 'repo-1', checkoutId: 'checkout-1' } as never;
function runtimeInput(h: string, workflowId: string) {
  return {
    controllerHome: h,
    repository,
    executionIdentity,
    scopeId: `repository:repo-1:checkout:checkout-1:workflow:${workflowId}`,
    runId: 'run-1',
    registryScope: { kind: 'controller' as const },
    workflowId,
    inputs: { resource_id: 'r1' },
  };
}
function install(
  h: string,
  draft: WorkflowGraphAssetDraft,
  bindings: { capabilityId: string; pluginId: string; actionId: string }[],
) {
  const written = writeWorkflowGraphAssetContent({ kind: 'controller', controllerHome: h }, draft);
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
    bindings,
  });
}
function pluginReceipt(request: any, actionId: string, result: any, effectOutcome?: 'outcome_unknown') {
  return {
    receipt: {
      receiptId: `${actionId}-receipt`,
      requestId: request.requestId,
      pluginId: 'svc',
      actionId,
      status: 'succeeded',
      createdAt: '2026-11-26T00:00:00.000Z',
      ...(effectOutcome ? { effectOutcome } : {}),
    } as never,
    result: {
      schemaVersion: 1,
      plugin: { pluginId: 'svc' },
      action: { actionId, requestId: request.requestId },
      result,
    },
  } as never;
}

describe('Workflow Graph reconciliation', () => {
  test('reconciles a forward unknown effect as applied and reaches succeeded without replay', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'reconcile.forward',
      version: '1',
      inputContract: { resource_id: { type: 'string', required: true } },
      entryNodeId: 'write',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'write',
          capabilityId: 'write',
          idempotency: 'non_idempotent',
          reconcileWithCapabilityId: 'observe',
          reconciliationInput: {
            effect_id: { kind: 'effect_request_id' },
            resource_id: { kind: 'input', name: 'resource_id' },
          },
        },
      ],
      edges: [],
    };
    install(h, draft, [
      { capabilityId: 'write', pluginId: 'svc', actionId: 'write' },
      { capabilityId: 'observe', pluginId: 'svc', actionId: 'observe' },
    ]);
    let writes = 0;
    const input = runtimeInput(h, 'reconcile.forward');
    const unknown = await executeRegisteredWorkflowGraph(input, {
      submitPluginAction: async (_home, _repo, request) => {
        if (request.actionId === 'write') {
          writes++;
          return pluginReceipt(request, 'write', { status: 'outcome_unknown' }, 'outcome_unknown');
        }
        throw new Error('unexpected observe');
      },
      now: () => new Date('2026-11-26T00:00:00.000Z'),
    });
    expect(unknown.status).toBe('reconcile_required');
    const result = await observeAndReconcileRegisteredWorkflowGraph(input, {
      submitPluginAction: async (_home, _repo, request) => {
        expect(request.actionId).toBe('observe');
        expect(request.args).toEqual({
          effect_id: `workflow-graph:${input.scopeId}:run-1:write:1:effect`,
          resource_id: 'r1',
        });
        return pluginReceipt(request, 'observe', {
          effectRequestId: `workflow-graph:${input.scopeId}:run-1:write:1:effect`,
          outcome: 'applied',
          output: { confirmed: true },
        });
      },
      now: () => new Date('2026-11-26T00:00:10.000Z'),
    });
    expect(writes).toBe(1);
    expect(result.status).toBe('succeeded');
    expect(result.nodes[0]).toMatchObject({ status: 'succeeded', output: { confirmed: true } });
  });

  test('confirmed not_applied clears uncertainty but never retries the forward effect automatically', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'reconcile.not-applied',
      version: '1',
      inputContract: { resource_id: { type: 'string', required: true } },
      entryNodeId: 'write',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'write',
          capabilityId: 'write',
          idempotency: 'non_idempotent',
          reconcileWithCapabilityId: 'observe',
        },
      ],
      edges: [],
    };
    install(h, draft, [
      { capabilityId: 'write', pluginId: 'svc', actionId: 'write' },
      { capabilityId: 'observe', pluginId: 'svc', actionId: 'observe' },
    ]);
    let writes = 0;
    const input = runtimeInput(h, 'reconcile.not-applied');
    await executeRegisteredWorkflowGraph(input, {
      submitPluginAction: async (_h, _r, request) => {
        writes++;
        return pluginReceipt(request, 'write', { status: 'outcome_unknown' }, 'outcome_unknown');
      },
    });
    const result = await observeAndReconcileRegisteredWorkflowGraph(input, {
      submitPluginAction: async (_h, _r, request) =>
        pluginReceipt(request, 'observe', {
          effectRequestId: `workflow-graph:${input.scopeId}:run-1:write:1:effect`,
          outcome: 'not_applied',
        }),
    });
    expect(writes).toBe(1);
    expect(result.status).toBe('failed');
  });

  test('reconciles unknown compensation separately and finishes compensated when applied', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'reconcile.comp',
      version: '1',
      inputContract: { resource_id: { type: 'string', required: true } },
      failurePolicy: { mode: 'compensate' },
      entryNodeId: 'create',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'create',
          capabilityId: 'create',
          idempotency: 'idempotent',
          compensation: {
            kind: 'capability',
            capabilityId: 'undo',
            idempotency: 'non_idempotent',
            reconcileWithCapabilityId: 'observe_undo',
          },
        },
        { kind: 'capability', nodeId: 'fail', capabilityId: 'fail', idempotency: 'idempotent' },
      ],
      edges: [{ edgeId: 'e', from: 'create', to: 'fail', on: 'success' }],
    };
    install(h, draft, [
      { capabilityId: 'create', pluginId: 'svc', actionId: 'create' },
      { capabilityId: 'fail', pluginId: 'svc', actionId: 'fail' },
      { capabilityId: 'undo', pluginId: 'svc', actionId: 'undo' },
      { capabilityId: 'observe_undo', pluginId: 'svc', actionId: 'observe_undo' },
    ]);
    const input = runtimeInput(h, 'reconcile.comp');
    const unknown = await executeRegisteredWorkflowGraph(input, {
      submitPluginAction: async (_h, _r, request) => {
        if (request.actionId === 'create') return pluginReceipt(request, 'create', { ok: true });
        if (request.actionId === 'fail')
          return {
            receipt: {
              receiptId: 'fail-r',
              requestId: request.requestId,
              pluginId: 'svc',
              actionId: 'fail',
              status: 'failed',
              createdAt: '2026-11-26T00:00:01.000Z',
              error: { code: 'FAIL', message: 'fail' },
            } as never,
            result: {
              schemaVersion: 1,
              plugin: { pluginId: 'svc' },
              action: { actionId: 'fail', requestId: request.requestId },
              result: { status: 'failed' },
            },
          } as never;
        if (request.actionId === 'undo')
          return pluginReceipt(request, 'undo', { status: 'outcome_unknown' }, 'outcome_unknown');
        throw new Error('unexpected');
      },
      now: () => new Date('2026-11-26T00:00:02.000Z'),
    });
    expect(unknown.status).toBe('reconcile_required');
    const result = await observeAndReconcileRegisteredWorkflowGraph(input, {
      submitPluginAction: async (_h, _r, request) => {
        expect(request.actionId).toBe('observe_undo');
        return pluginReceipt(request, 'observe_undo', {
          effectRequestId: `workflow-graph:${input.scopeId}:run-1:create:1:compensation`,
          outcome: 'applied',
        });
      },
      now: () => new Date('2026-11-26T00:00:03.000Z'),
    });
    expect(result.status).toBe('compensated');
    expect(readWorkflowGraphRun(h, input.scopeId, 'run-1')?.value.status).toBe('compensated');
  });

  test('fails closed when reconciliation provider reports a different effect identity', async () => {
    const h = home();
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'reconcile.mismatch',
      version: '1',
      inputContract: { resource_id: { type: 'string', required: true } },
      entryNodeId: 'write',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'write',
          capabilityId: 'write',
          idempotency: 'non_idempotent',
          reconcileWithCapabilityId: 'observe',
        },
      ],
      edges: [],
    };
    install(h, draft, [
      { capabilityId: 'write', pluginId: 'svc', actionId: 'write' },
      { capabilityId: 'observe', pluginId: 'svc', actionId: 'observe' },
    ]);
    const input = runtimeInput(h, 'reconcile.mismatch');
    await executeRegisteredWorkflowGraph(input, {
      submitPluginAction: async (_h, _r, request) =>
        pluginReceipt(request, 'write', { status: 'outcome_unknown' }, 'outcome_unknown'),
    });
    await expect(
      observeAndReconcileRegisteredWorkflowGraph(input, {
        submitPluginAction: async (_h, _r, request) =>
          pluginReceipt(request, 'observe', { effectRequestId: 'wrong', outcome: 'applied' }),
      }),
    ).rejects.toThrow('WORKFLOW_GRAPH_RECONCILIATION_EFFECT_ID_MISMATCH');
  });
});
