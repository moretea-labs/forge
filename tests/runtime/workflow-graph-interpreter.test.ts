import { describe, expect, test } from 'bun:test';
import {
  createInitialWorkflowGraphCheckpoint,
  executeWorkflowGraph,
  materializeWorkflowGraphAsset,
  startWorkflowGraphNode,
  type WorkflowGraphAssetDraft,
  type WorkflowGraphCheckpoint,
} from '../../packages/workflow-runtime/api/index';

function parallelAsset() {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'graph.runtime.parallel',
    version: '1',
    entryNodeId: 'start',
    nodes: [
      { kind: 'capability', nodeId: 'start', capabilityId: 'start', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'left', capabilityId: 'left', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'right', capabilityId: 'right', idempotency: 'idempotent' },
      { kind: 'join', nodeId: 'join', policy: 'all' },
    ],
    edges: [
      { edgeId: 's-l', from: 'start', to: 'left', on: 'success' },
      { edgeId: 's-r', from: 'start', to: 'right', on: 'success' },
      { edgeId: 'l-j', from: 'left', to: 'join', on: 'success' },
      { edgeId: 'r-j', from: 'right', to: 'join', on: 'success' },
    ],
  };
  return materializeWorkflowGraphAsset(draft);
}

function waitAsset() {
  return materializeWorkflowGraphAsset({
    schemaVersion: 2,
    workflowId: 'graph.runtime.wait',
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
  });
}

describe('Workflow Graph interpreter protocol', () => {
  test('checkpoints all parallel effects as running before dispatch and executes them concurrently', async () => {
    const asset = parallelAsset();
    const checkpoints: WorkflowGraphCheckpoint[] = [];
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await executeWorkflowGraph(
      { asset, binding: { scopeId: 'workflow:parallel', runId: 'run-1' } },
      {
        checkpoint: (checkpoint) => {
          checkpoints.push(checkpoint);
        },
        executeEffect: async ({ plan }) => {
          started.push(plan.nodeId);
          if (plan.nodeId === 'start')
            return { outcome: 'succeeded', receiptRef: 'start-r', recordedAt: '2026-11-26T00:00:00.000Z' };
          if (started.includes('left') && started.includes('right')) release();
          await gate;
          return { outcome: 'succeeded', receiptRef: `${plan.nodeId}-r`, recordedAt: '2026-11-26T00:00:01.000Z' };
        },
        registerWait: async () => {
          throw new Error('unexpected wait');
        },
        now: () => new Date('2026-11-26T00:00:01.000Z'),
      },
    );
    expect(result.status).toBe('succeeded');
    expect(started).toEqual(['start', 'left', 'right']);
    expect(
      checkpoints.some(
        (checkpoint) =>
          checkpoint.nodes.find((node) => node.nodeId === 'left')?.status === 'running' &&
          checkpoint.nodes.find((node) => node.nodeId === 'right')?.status === 'running',
      ),
    ).toBe(true);
  });

  test('registers durable waits with a stable request identity and returns waiting without polling', async () => {
    const asset = waitAsset();
    const requests: string[] = [];
    const result = await executeWorkflowGraph(
      { asset, binding: { scopeId: 'workflow:wait', runId: 'run-1' }, inputs: { case_id: 'case-1' } },
      {
        executeEffect: async () => {
          throw new Error('unexpected effect');
        },
        registerWait: async ({ plan, requestId }) => {
          requests.push(requestId);
          return {
            registeredAt: '2026-11-26T00:00:00.000Z',
            expiresAt: '2026-11-26T00:01:00.000Z',
            correlationKey: plan.kind === 'wait_event' ? plan.correlationKey : undefined,
            requestRef: 'wait-owner-1',
          };
        },
      },
    );
    expect(result.status).toBe('waiting');
    expect(requests).toEqual(['workflow-graph:workflow:wait:run-1:wait:1:wait']);
    expect(result.nodes[0]).toMatchObject({ status: 'waiting', wait: { kind: 'event', correlationKey: 'case-1' } });
  });

  test('converts thrown effect dispatch into reconciliation instead of blind retry', async () => {
    const asset = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'graph.runtime.unknown',
      version: '1',
      entryNodeId: 'effect',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'effect',
          capabilityId: 'mail.send',
          idempotency: 'non_idempotent',
          reconcileWithCapabilityId: 'mail.lookup',
        },
      ],
      edges: [],
    });
    const result = await executeWorkflowGraph(
      { asset, binding: { scopeId: 'workflow:unknown', runId: 'run-1' } },
      {
        executeEffect: async () => {
          throw new Error('connection lost after dispatch');
        },
        registerWait: async () => {
          throw new Error('unexpected wait');
        },
        now: () => new Date('2026-11-26T00:00:00.000Z'),
      },
    );
    expect(result).toMatchObject({
      status: 'reconcile_required',
      nodes: [{ status: 'reconcile_required', receipts: [{ outcome: 'outcome_unknown' }] }],
    });
  });

  test('a resumed checkpoint with running effects is fenced for reconciliation and never replayed', async () => {
    const asset = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'graph.runtime.resume',
      version: '1',
      entryNodeId: 'effect',
      nodes: [{ kind: 'capability', nodeId: 'effect', capabilityId: 'effect', idempotency: 'idempotent' }],
      edges: [],
    });
    let checkpoint = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:resume', runId: 'run-1' });
    checkpoint = startWorkflowGraphNode(asset, checkpoint, 'effect');
    let calls = 0;
    const result = await executeWorkflowGraph(
      { asset, binding: checkpoint.binding, checkpoint },
      {
        executeEffect: async () => {
          calls += 1;
          return { outcome: 'succeeded' };
        },
        registerWait: async () => {
          throw new Error('unexpected wait');
        },
        now: () => new Date('2026-11-26T00:00:05.000Z'),
      },
    );
    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: 'reconcile_required', nodes: [{ status: 'reconcile_required' }] });
  });

  test('runs compensations sequentially in reverse completion order with independent request identities', async () => {
    const asset = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'graph.runtime.saga',
      version: '1',
      failurePolicy: { mode: 'compensate' },
      entryNodeId: 'first',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'first',
          capabilityId: 'first',
          compensation: { kind: 'capability', capabilityId: 'undo-first' },
        },
        {
          kind: 'capability',
          nodeId: 'second',
          capabilityId: 'second',
          compensation: { kind: 'capability', capabilityId: 'undo-second' },
        },
        { kind: 'capability', nodeId: 'fail', capabilityId: 'fail' },
      ],
      edges: [
        { edgeId: 'a', from: 'first', to: 'second', on: 'success' },
        { edgeId: 'b', from: 'second', to: 'fail', on: 'success' },
      ],
    });
    const compensationRequests: string[] = [];
    const result = await executeWorkflowGraph(
      { asset, binding: { scopeId: 'workflow:saga', runId: 'run-1' } },
      {
        executeEffect: async ({ plan }) =>
          plan.nodeId === 'fail'
            ? { outcome: 'failed', error: { code: 'FAIL', message: 'fail' }, recordedAt: '2026-11-26T00:00:03.000Z' }
            : {
                outcome: 'succeeded',
                receiptRef: plan.nodeId + '-r',
                recordedAt: plan.nodeId === 'first' ? '2026-11-26T00:00:01.000Z' : '2026-11-26T00:00:02.000Z',
              },
        executeCompensation: async ({ plan, requestId }) => {
          compensationRequests.push(`${plan.nodeId}:${requestId}`);
          return { outcome: 'succeeded', receiptRef: `undo-${plan.nodeId}-r`, recordedAt: '2026-11-26T00:00:04.000Z' };
        },
        registerWait: async () => {
          throw new Error('unexpected wait');
        },
      },
    );
    expect(result.status).toBe('compensated');
    expect(compensationRequests).toEqual([
      'second:workflow-graph:workflow:saga:run-1:second:1:compensation',
      'first:workflow-graph:workflow:saga:run-1:first:1:compensation',
    ]);
  });

  test('stops Saga compensation on unknown compensation effect', async () => {
    const asset = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'graph.runtime.saga-unknown',
      version: '1',
      failurePolicy: { mode: 'compensate' },
      entryNodeId: 'effect',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'effect',
          capabilityId: 'effect',
          compensation: {
            kind: 'capability',
            capabilityId: 'undo',
            idempotency: 'non_idempotent',
            reconcileWithCapabilityId: 'undo.lookup',
          },
        },
        { kind: 'capability', nodeId: 'fail', capabilityId: 'fail' },
      ],
      edges: [{ edgeId: 'e', from: 'effect', to: 'fail', on: 'success' }],
    });
    const result = await executeWorkflowGraph(
      { asset, binding: { scopeId: 'workflow:saga-unknown', runId: 'run-1' } },
      {
        executeEffect: async ({ plan }) =>
          plan.nodeId === 'fail'
            ? { outcome: 'failed', error: { code: 'FAIL', message: 'fail' } }
            : { outcome: 'succeeded', receiptRef: 'effect-r' },
        executeCompensation: async () => ({ outcome: 'outcome_unknown', receiptRef: 'undo-unknown' }),
        registerWait: async () => {
          throw new Error('unexpected wait');
        },
        now: () => new Date('2026-11-26T00:00:05.000Z'),
      },
    );
    expect(result.status).toBe('reconcile_required');
    expect(result.nodes[0]?.compensation).toMatchObject({
      status: 'reconcile_required',
      receipts: [{ outcome: 'outcome_unknown' }],
    });
  });
});
