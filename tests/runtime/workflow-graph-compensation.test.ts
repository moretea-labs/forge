import { describe, expect, test } from 'bun:test';
import {
  beginWorkflowGraphCompensation,
  completeWorkflowGraphCompensation,
  completeWorkflowGraphNodeFailure,
  completeWorkflowGraphNodeSuccess,
  createInitialWorkflowGraphCheckpoint,
  materializeWorkflowGraphAsset,
  planWorkflowGraphCompensation,
  startWorkflowGraphCompensation,
  startWorkflowGraphNode,
  type WorkflowGraphAssetDraft,
} from '../../packages/workflow-runtime/api/index';

function asset() {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'saga.demo',
    version: '1',
    failurePolicy: { mode: 'compensate' },
    entryNodeId: 'create',
    nodes: [
      {
        kind: 'capability',
        nodeId: 'create',
        capabilityId: 'resource.create',
        idempotency: 'idempotent',
        compensation: {
          kind: 'capability',
          capabilityId: 'resource.delete',
          idempotency: 'non_idempotent',
          reconcileWithCapabilityId: 'resource.lookup_deleted',
          input: { resource_id: { kind: 'output', nodeId: 'create', field: 'resource_id' } },
        },
      },
      {
        kind: 'capability',
        nodeId: 'publish',
        capabilityId: 'resource.publish',
        idempotency: 'idempotent',
        compensation: {
          kind: 'capability',
          capabilityId: 'resource.unpublish',
          input: { resource_id: { kind: 'output', nodeId: 'create', field: 'resource_id' } },
        },
      },
      { kind: 'capability', nodeId: 'fail', capabilityId: 'remote.fail', idempotency: 'idempotent' },
    ],
    edges: [
      { edgeId: 'c-p', from: 'create', to: 'publish', on: 'success' },
      { edgeId: 'p-f', from: 'publish', to: 'fail', on: 'success' },
    ],
  };
  return materializeWorkflowGraphAsset(draft);
}

function failedRun() {
  const graph = asset();
  let checkpoint = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:saga.demo', runId: 'run-1' });
  checkpoint = startWorkflowGraphNode(graph, checkpoint, 'create');
  checkpoint = completeWorkflowGraphNodeSuccess(graph, checkpoint, 'create', {
    output: { resource_id: 'r1' },
    receiptRef: 'create-r',
    recordedAt: '2026-11-26T00:00:01.000Z',
  });
  checkpoint = startWorkflowGraphNode(graph, checkpoint, 'publish');
  checkpoint = completeWorkflowGraphNodeSuccess(graph, checkpoint, 'publish', {
    receiptRef: 'publish-r',
    recordedAt: '2026-11-26T00:00:02.000Z',
  });
  checkpoint = startWorkflowGraphNode(graph, checkpoint, 'fail');
  checkpoint = completeWorkflowGraphNodeFailure(
    graph,
    checkpoint,
    'fail',
    { class: 'failed', code: 'REMOTE_FAILED', message: 'failed', recordedAt: '2026-11-26T00:00:03.000Z' },
    new Date('2026-11-26T00:00:03.000Z'),
  );
  return { graph, checkpoint };
}

describe('Workflow Graph compensation / Saga', () => {
  test('only confirmed successful forward effects become compensable', () => {
    const { graph, checkpoint } = failedRun();
    const compensating = beginWorkflowGraphCompensation(graph, checkpoint);
    expect(compensating.status).toBe('compensating');
    expect(compensating.nodes.map((node) => [node.nodeId, node.compensation?.status])).toEqual([
      ['create', 'pending'],
      ['publish', 'pending'],
      ['fail', undefined],
    ]);
  });

  test('plans compensation one-at-a-time in reverse confirmed completion order', () => {
    const { graph, checkpoint } = failedRun();
    const compensating = beginWorkflowGraphCompensation(graph, checkpoint);
    const first = planWorkflowGraphCompensation(graph, compensating);
    expect(first).toMatchObject({
      phase: 'compensation',
      nodeId: 'publish',
      kind: 'capability',
      capabilityId: 'resource.unpublish',
      input: { resource_id: 'r1' },
      authorization: 'not_authorized',
      execution: 'not_executed',
    });
  });

  test('records independent compensation receipts and ends as compensated', () => {
    const { graph, checkpoint } = failedRun();
    let current = beginWorkflowGraphCompensation(graph, checkpoint);
    current = startWorkflowGraphCompensation(graph, current, 'publish');
    current = completeWorkflowGraphCompensation(graph, current, 'publish', {
      outcome: 'succeeded',
      receiptRef: 'unpublish-r',
      recordedAt: '2026-11-26T00:00:04.000Z',
    });
    expect(current.status).toBe('compensating');
    expect(planWorkflowGraphCompensation(graph, current)?.nodeId).toBe('create');
    current = startWorkflowGraphCompensation(graph, current, 'create');
    current = completeWorkflowGraphCompensation(graph, current, 'create', {
      outcome: 'succeeded',
      receiptRef: 'delete-r',
      recordedAt: '2026-11-26T00:00:05.000Z',
    });
    expect(current.status).toBe('compensated');
    expect(current.nodes.find((node) => node.nodeId === 'create')?.compensation?.receipts).toEqual([
      { attempt: 1, outcome: 'succeeded', receiptRef: 'delete-r', recordedAt: '2026-11-26T00:00:05.000Z' },
    ]);
  });

  test('compensation outcome_unknown fences the Saga for reconciliation', () => {
    const { graph, checkpoint } = failedRun();
    let current = beginWorkflowGraphCompensation(graph, checkpoint);
    current = startWorkflowGraphCompensation(graph, current, 'publish');
    current = completeWorkflowGraphCompensation(graph, current, 'publish', {
      outcome: 'outcome_unknown',
      receiptRef: 'unknown-r',
      recordedAt: '2026-11-26T00:00:04.000Z',
    });
    expect(current.status).toBe('reconcile_required');
    expect(current.nodes.find((node) => node.nodeId === 'publish')?.compensation).toMatchObject({
      status: 'reconcile_required',
      receipts: [{ outcome: 'outcome_unknown', receiptRef: 'unknown-r' }],
    });
  });

  test('non-idempotent compensation requires an explicit reconciliation capability', () => {
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'saga.invalid',
      version: '1',
      failurePolicy: { mode: 'compensate' },
      entryNodeId: 'effect',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'effect',
          capabilityId: 'create',
          compensation: { kind: 'capability', capabilityId: 'delete', idempotency: 'non_idempotent' },
        },
      ],
      edges: [],
    };
    expect(() => materializeWorkflowGraphAsset(draft)).toThrow('WORKFLOW_GRAPH_COMPENSATION_RECONCILIATION_REQUIRED');
  });
});
