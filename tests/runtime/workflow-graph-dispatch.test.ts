import { describe, expect, test } from 'bun:test';
import {
  completeWorkflowGraphNodeSuccess,
  createInitialWorkflowGraphCheckpoint,
  materializeWorkflowGraphAsset,
  planWorkflowGraphDispatch,
  startWorkflowGraphNode,
  type WorkflowGraphAssetDraft,
} from '../../packages/workflow-runtime/api/index';

function asset() {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'dispatch.demo',
    version: '1',
    inputContract: { case_id: { type: 'string', required: true } },
    entryNodeId: 'inspect',
    nodes: [
      {
        kind: 'capability',
        nodeId: 'inspect',
        capabilityId: 'case.inspect',
        idempotency: 'idempotent',
        input: { case_id: { kind: 'input', name: 'case_id' } },
      },
      {
        kind: 'script',
        nodeId: 'script',
        scriptRef: 'normalize',
        input: { subject: { kind: 'output', nodeId: 'inspect', field: 'subject' } },
      },
      {
        kind: 'workflow',
        nodeId: 'child',
        workflowId: 'case.child',
        input: { case_id: { kind: 'input', name: 'case_id' } },
      },
      {
        kind: 'wait_event',
        nodeId: 'wait',
        sources: ['agentmail.watch'],
        eventTypes: ['mail.reply.received'],
        correlation: { kind: 'input', name: 'case_id' },
        timeoutMs: 60000,
      },
      {
        kind: 'approval',
        nodeId: 'approve',
        approvalKey: 'send-reply',
        prompt: 'Approve reply?',
        timeoutMs: 60000,
      },
      { kind: 'join', nodeId: 'join', policy: 'all' },
    ],
    edges: [
      { edgeId: 'i-s', from: 'inspect', to: 'script', on: 'success' },
      { edgeId: 'i-c', from: 'inspect', to: 'child', on: 'success' },
      { edgeId: 'i-w', from: 'inspect', to: 'wait', on: 'success' },
      { edgeId: 'i-a', from: 'inspect', to: 'approve', on: 'success' },
      { edgeId: 's-j', from: 'script', to: 'join', on: 'success' },
      { edgeId: 'c-j', from: 'child', to: 'join', on: 'success' },
      { edgeId: 'w-j', from: 'wait', to: 'join', on: 'success' },
      { edgeId: 'a-j', from: 'approve', to: 'join', on: 'success' },
    ],
    scripts: {
      normalize: {
        runtime: 'node',
        deterministic: true,
        outputFormat: 'json',
        body: 'process.stdout.write(process.argv[1]||"{}")',
      },
    },
  };
  return materializeWorkflowGraphAsset(draft);
}

describe('Workflow Graph dispatch planning', () => {
  test('plans a ready capability without authorizing or executing it', () => {
    const graph = asset();
    const checkpoint = createInitialWorkflowGraphCheckpoint(graph, {
      scopeId: 'workflow:dispatch.demo',
      runId: 'run-1',
    });
    const batch = planWorkflowGraphDispatch(graph, checkpoint, { case_id: 'case-1' });
    expect(batch.plans).toEqual([
      {
        nodeId: 'inspect',
        nextAttempt: 1,
        kind: 'capability',
        capabilityId: 'case.inspect',
        input: { case_id: 'case-1' },
        idempotency: 'idempotent',
        authorization: 'not_authorized',
        execution: 'not_executed',
      },
    ]);
  });

  test('fans out into independent script, child workflow, durable wait, and approval plans', () => {
    const graph = asset();
    let checkpoint = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:dispatch.demo', runId: 'run-1' });
    checkpoint = startWorkflowGraphNode(graph, checkpoint, 'inspect');
    checkpoint = completeWorkflowGraphNodeSuccess(
      graph,
      checkpoint,
      'inspect',
      { output: { subject: 'Review update' }, receiptRef: 'inspect-1', recordedAt: '2026-11-26T00:00:00.000Z' },
      { case_id: 'case-1' },
    );
    const batch = planWorkflowGraphDispatch(graph, checkpoint, { case_id: 'case-1' });
    expect(batch.plans.map((plan) => plan.kind)).toEqual(['approval', 'workflow', 'script', 'wait_event']);
    expect(batch.plans.find((plan) => plan.kind === 'script')).toMatchObject({
      nodeId: 'script',
      input: { subject: 'Review update' },
      authorization: 'not_authorized',
      execution: 'not_executed',
    });
    expect(batch.plans.find((plan) => plan.kind === 'workflow')).toMatchObject({
      nodeId: 'child',
      workflowId: 'case.child',
      input: { case_id: 'case-1' },
      authorization: 'not_authorized',
      execution: 'not_executed',
    });
    expect(batch.plans.find((plan) => plan.kind === 'wait_event')).toMatchObject({
      nodeId: 'wait',
      sources: ['agentmail.watch'],
      eventTypes: ['mail.reply.received'],
      correlationKey: 'case-1',
      timeoutMs: 60000,
    });
    expect(batch.plans.find((plan) => plan.kind === 'approval')).toMatchObject({
      nodeId: 'approve',
      approvalKey: 'send-reply',
      prompt: 'Approve reply?',
      timeoutMs: 60000,
    });
  });

  test('fails closed when a ready node input/output binding is unresolved', () => {
    const graph = asset();
    let checkpoint = createInitialWorkflowGraphCheckpoint(graph, { scopeId: 'workflow:dispatch.demo', runId: 'run-1' });
    checkpoint = startWorkflowGraphNode(graph, checkpoint, 'inspect');
    checkpoint = completeWorkflowGraphNodeSuccess(
      graph,
      checkpoint,
      'inspect',
      { output: {}, recordedAt: '2026-11-26T00:00:00.000Z' },
      { case_id: 'case-1' },
    );
    expect(() => planWorkflowGraphDispatch(graph, checkpoint, { case_id: 'case-1' })).toThrow(
      'WORKFLOW_GRAPH_NODE_INPUT_UNRESOLVED:script:subject',
    );
  });

  test('requires durable event correlation to resolve to a non-empty string', () => {
    const graph = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'dispatch.wait',
      version: '1',
      inputContract: { correlation: { type: 'json', required: true } },
      entryNodeId: 'wait',
      nodes: [
        {
          kind: 'wait_event',
          nodeId: 'wait',
          sources: ['event'],
          correlation: { kind: 'input', name: 'correlation' },
          timeoutMs: 1000,
        },
      ],
      edges: [],
    });
    const checkpoint = createInitialWorkflowGraphCheckpoint(graph, {
      scopeId: 'workflow:dispatch.wait',
      runId: 'run-1',
    });
    expect(() => planWorkflowGraphDispatch(graph, checkpoint, { correlation: { id: 'complex' } })).toThrow(
      'WORKFLOW_GRAPH_WAIT_CORRELATION_STRING_REQUIRED:wait',
    );
  });
});
