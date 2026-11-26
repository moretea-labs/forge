import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInitialWorkflowGraphCheckpoint,
  materializeWorkflowGraphAsset,
  validateWorkflowGraphCheckpoint,
  type WorkflowGraphAssetDraft,
} from '../../packages/workflow-runtime/api/index';
import {
  readWorkflowGraphRun,
  writeWorkflowGraphRunCheckpoint,
  WORKFLOW_RUN_NAMESPACE,
} from '../../src/runtime/control-plane/persistence/workflow-run-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function home() {
  const value = mkdtempSync(join(tmpdir(), 'forge-graph-checkpoint-'));
  roots.push(value);
  return value;
}
const graphExecution = {
  repositoryId: 'repo-1',
  checkoutId: 'checkout-1',
  registryScope: { kind: 'controller' as const },
};

function asset() {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'mail.graph',
    version: '1',
    entryNodeId: 'start',
    nodes: [
      { kind: 'capability', nodeId: 'start', capabilityId: 'mail.inspect', idempotency: 'idempotent' },
      {
        kind: 'wait_event',
        nodeId: 'wait',
        sources: ['agentmail.watch'],
        correlation: { kind: 'input', name: 'message_id' },
        timeoutMs: 60000,
      },
      { kind: 'approval', nodeId: 'approve', approvalKey: 'send-reply', prompt: 'Approve?', timeoutMs: 60000 },
    ],
    edges: [
      { edgeId: 'e1', from: 'start', to: 'wait', on: 'success' },
      { edgeId: 'e2', from: 'wait', to: 'approve', on: 'success' },
    ],
  };
  return materializeWorkflowGraphAsset(draft);
}

describe('Workflow Graph v2 checkpoints', () => {
  test('initializes one durable state per graph node with only the entry ready', () => {
    const graph = asset();
    const checkpoint = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:mail.graph', runId: 'run-1' });
    expect(checkpoint.status).toBe('running');
    expect(checkpoint.nodes).toEqual([
      { nodeId: 'start', status: 'ready', attempts: 0, receipts: [] },
      { nodeId: 'wait', status: 'pending', attempts: 0, receipts: [] },
      { nodeId: 'approve', status: 'pending', attempts: 0, receipts: [] },
    ]);
  });
  test('persists graph v2 checkpoints in the existing workflow_run namespace', () => {
    const h = home();
    const graph = asset();
    const checkpoint = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:mail.graph', runId: 'run-1' });
    const stored = writeWorkflowGraphRunCheckpoint({
      controllerHome: h,
      checkpoint,
      inputs: { message_id: 'm1' },
      execution: graphExecution,
      now: new Date('2026-11-25T10:00:00.000Z'),
    });
    expect(stored.namespace).toBe(WORKFLOW_RUN_NAMESPACE);
    expect(stored.value.schemaVersion).toBe(2);
    expect(readWorkflowGraphRun(h, 'workflow:mail.graph', 'run-1')?.value).toEqual(stored.value);
  });
  test('uses optimistic revisions in the same workflow_run ledger', () => {
    const h = home();
    const graph = asset();
    const checkpoint = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:mail.graph', runId: 'run-1' });
    const first = writeWorkflowGraphRunCheckpoint({
      controllerHome: h,
      checkpoint,
      execution: graphExecution,
      expectedRevision: null,
    });
    const second = {
      ...checkpoint,
      nodes: checkpoint.nodes.map((node) =>
        node.nodeId === 'start' ? { ...node, status: 'running' as const, attempts: 1 } : node,
      ),
    };
    const updated = writeWorkflowGraphRunCheckpoint({
      controllerHome: h,
      checkpoint: second,
      execution: graphExecution,
      expectedRevision: first.revision,
    });
    expect(updated.revision).toBe(first.revision + 1);
    expect(() =>
      writeWorkflowGraphRunCheckpoint({
        controllerHome: h,
        checkpoint: second,
        execution: graphExecution,
        expectedRevision: first.revision,
      }),
    ).toThrow();
  });
  test('requires explicit wait state and reconciliation evidence', () => {
    const graph = asset();
    const base = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:mail.graph', runId: 'run-1' });
    const badWait = {
      ...base,
      status: 'waiting' as const,
      nodes: base.nodes.map((node) => (node.nodeId === 'wait' ? { ...node, status: 'waiting' as const } : node)),
    };
    expect(() => validateWorkflowGraphCheckpoint(graph, badWait)).toThrow(
      'WORKFLOW_GRAPH_CHECKPOINT_WAIT_STATE_REQUIRED',
    );
    const badReconcile = {
      ...base,
      status: 'reconcile_required' as const,
      nodes: base.nodes.map((node) =>
        node.nodeId === 'start' ? { ...node, status: 'reconcile_required' as const, attempts: 1, receipts: [] } : node,
      ),
    };
    expect(() => validateWorkflowGraphCheckpoint(graph, badReconcile)).toThrow(
      'WORKFLOW_GRAPH_CHECKPOINT_RECONCILIATION_RECEIPT_REQUIRED',
    );
  });
  test('accepts durable wait and outcome-unknown reconciliation states', () => {
    const graph = asset();
    const base = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:mail.graph', runId: 'run-1' });
    const waiting = {
      ...base,
      status: 'waiting' as const,
      nodes: base.nodes.map((node) =>
        node.nodeId === 'wait'
          ? {
              ...node,
              status: 'waiting' as const,
              wait: {
                kind: 'event' as const,
                correlationKey: 'message:m1',
                registeredAt: '2026-11-25T10:00:00.000Z',
                expiresAt: '2026-11-25T10:01:00.000Z',
              },
            }
          : node,
      ),
    };
    expect(validateWorkflowGraphCheckpoint(graph, waiting).status).toBe('waiting');
    const reconcile = {
      ...base,
      status: 'reconcile_required' as const,
      nodes: base.nodes.map((node) =>
        node.nodeId === 'start'
          ? {
              ...node,
              status: 'reconcile_required' as const,
              attempts: 1,
              receipts: [
                {
                  attempt: 1,
                  outcome: 'outcome_unknown' as const,
                  receiptRef: 'receipt-1',
                  recordedAt: '2026-11-25T10:00:00.000Z',
                },
              ],
            }
          : node,
      ),
    };
    expect(validateWorkflowGraphCheckpoint(graph, reconcile).status).toBe('reconcile_required');
  });
});
