import { describe, expect, test } from 'bun:test';
import {
  completeWorkflowGraphNodeFailure,
  completeWorkflowGraphNodeSuccess,
  expireWorkflowGraphWait,
  createInitialWorkflowGraphCheckpoint,
  materializeWorkflowGraphAsset,
  registerWorkflowGraphWait,
  resolveWorkflowGraphWait,
  stabilizeWorkflowGraphCheckpoint,
  startWorkflowGraphNode,
  wakeWorkflowGraphRetry,
  type WorkflowGraphAssetDraft,
} from '../../packages/workflow-runtime/api/index';

function fanoutGraph() {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'graph.fanout',
    version: '1',
    entryNodeId: 'start',
    nodes: [
      { kind: 'capability', nodeId: 'start', capabilityId: 'start', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'left', capabilityId: 'left', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'right', capabilityId: 'right', idempotency: 'idempotent' },
      { kind: 'join', nodeId: 'join', policy: 'all' },
      { kind: 'capability', nodeId: 'finish', capabilityId: 'finish', idempotency: 'idempotent' },
    ],
    edges: [
      { edgeId: 's-l', from: 'start', to: 'left', on: 'success' },
      { edgeId: 's-r', from: 'start', to: 'right', on: 'success' },
      { edgeId: 'l-j', from: 'left', to: 'join', on: 'success' },
      { edgeId: 'r-j', from: 'right', to: 'join', on: 'success' },
      { edgeId: 'j-f', from: 'join', to: 'finish', on: 'success' },
    ],
  };
  return materializeWorkflowGraphAsset(draft);
}

function branchGraph() {
  const draft: WorkflowGraphAssetDraft = {
    schemaVersion: 2,
    workflowId: 'graph.branch',
    version: '1',
    inputContract: { route: { type: 'string', required: true } },
    entryNodeId: 'branch',
    nodes: [
      { kind: 'branch', nodeId: 'branch' },
      { kind: 'capability', nodeId: 'apple', capabilityId: 'apple', idempotency: 'idempotent' },
      { kind: 'capability', nodeId: 'other', capabilityId: 'other', idempotency: 'idempotent' },
      { kind: 'join', nodeId: 'join', policy: 'all' },
      { kind: 'capability', nodeId: 'finish', capabilityId: 'finish', idempotency: 'idempotent' },
    ],
    edges: [
      {
        edgeId: 'apple-route',
        from: 'branch',
        to: 'apple',
        on: 'condition',
        condition: {
          kind: 'compare',
          operator: 'equals',
          left: { kind: 'input', name: 'route' },
          right: { kind: 'literal', value: 'apple' },
        },
      },
      { edgeId: 'other-route', from: 'branch', to: 'other', on: 'default' },
      { edgeId: 'apple-join', from: 'apple', to: 'join', on: 'success' },
      { edgeId: 'other-join', from: 'other', to: 'join', on: 'success' },
      { edgeId: 'join-finish', from: 'join', to: 'finish', on: 'success' },
    ],
  };
  return materializeWorkflowGraphAsset(draft);
}

function status(checkpoint: ReturnType<typeof createInitialWorkflowGraphCheckpoint>, nodeId: string) {
  return checkpoint.nodes.find((node) => node.nodeId === nodeId)?.status;
}

describe('Workflow Graph reducer', () => {
  test('fans out after one completed node and joins only after all active parallel branches succeed', () => {
    const asset = fanoutGraph();
    let checkpoint = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:fanout', runId: 'run-1' });
    checkpoint = startWorkflowGraphNode(asset, checkpoint, 'start');
    checkpoint = completeWorkflowGraphNodeSuccess(asset, checkpoint, 'start', {
      recordedAt: '2026-11-26T00:00:00.000Z',
    });
    expect([status(checkpoint, 'left'), status(checkpoint, 'right')]).toEqual(['ready', 'ready']);
    checkpoint = startWorkflowGraphNode(asset, checkpoint, 'left');
    checkpoint = completeWorkflowGraphNodeSuccess(asset, checkpoint, 'left', {
      recordedAt: '2026-11-26T00:00:01.000Z',
    });
    expect(status(checkpoint, 'join')).toBe('pending');
    checkpoint = startWorkflowGraphNode(asset, checkpoint, 'right');
    checkpoint = completeWorkflowGraphNodeSuccess(asset, checkpoint, 'right', {
      recordedAt: '2026-11-26T00:00:02.000Z',
    });
    expect(status(checkpoint, 'join')).toBe('succeeded');
    expect(status(checkpoint, 'finish')).toBe('ready');
  });

  test('resolves branch conditions deterministically, skips the inactive path and joins the active path', () => {
    const asset = branchGraph();
    let checkpoint = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:branch', runId: 'run-1' });
    checkpoint = stabilizeWorkflowGraphCheckpoint(asset, checkpoint, { route: 'apple' });
    expect(checkpoint.nodes.find((node) => node.nodeId === 'branch')?.output).toEqual({
      selectedEdgeId: 'apple-route',
    });
    expect(status(checkpoint, 'apple')).toBe('ready');
    expect(status(checkpoint, 'other')).toBe('skipped');
    checkpoint = startWorkflowGraphNode(asset, checkpoint, 'apple');
    checkpoint = completeWorkflowGraphNodeSuccess(
      asset,
      checkpoint,
      'apple',
      { recordedAt: '2026-11-26T00:00:00.000Z' },
      { route: 'apple' },
    );
    expect(status(checkpoint, 'other')).toBe('skipped');
    expect(status(checkpoint, 'join')).toBe('succeeded');
    expect(status(checkpoint, 'finish')).toBe('ready');
  });

  test('is restart-stable because control state is derived only from persisted node states and inputs', () => {
    const asset = branchGraph();
    const initial = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:branch', runId: 'run-1' });
    const once = stabilizeWorkflowGraphCheckpoint(asset, initial, { route: 'other' });
    const afterRestart = stabilizeWorkflowGraphCheckpoint(asset, JSON.parse(JSON.stringify(once)), { route: 'other' });
    expect(afterRestart).toEqual(once);
  });

  test('rejects ordinary convergence without an explicit join node', () => {
    const draft: WorkflowGraphAssetDraft = {
      schemaVersion: 2,
      workflowId: 'graph.invalid-convergence',
      version: '1',
      entryNodeId: 'start',
      nodes: [
        { kind: 'capability', nodeId: 'start', capabilityId: 'start' },
        { kind: 'capability', nodeId: 'left', capabilityId: 'left' },
        { kind: 'capability', nodeId: 'right', capabilityId: 'right' },
        { kind: 'capability', nodeId: 'finish', capabilityId: 'finish' },
      ],
      edges: [
        { edgeId: 's-l', from: 'start', to: 'left', on: 'success' },
        { edgeId: 's-r', from: 'start', to: 'right', on: 'success' },
        { edgeId: 'l-f', from: 'left', to: 'finish', on: 'success' },
        { edgeId: 'r-f', from: 'right', to: 'finish', on: 'success' },
      ],
    };
    expect(() => materializeWorkflowGraphAsset(draft)).toThrow('WORKFLOW_GRAPH_NON_JOIN_INCOMING_INVALID:finish');
  });

  test('persists bounded retry backoff and never retries outcome_unknown', () => {
    const asset = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'graph.retry',
      version: '1',
      entryNodeId: 'work',
      nodes: [
        {
          kind: 'capability',
          nodeId: 'work',
          capabilityId: 'remote.read',
          idempotency: 'idempotent',
          retry: {
            maxAttempts: 2,
            strategy: 'fixed',
            initialDelayMs: 1000,
            maxDelayMs: 1000,
            retryOn: ['unavailable'],
          },
        },
      ],
      edges: [],
    });
    let checkpoint = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:retry', runId: 'run-1' });
    checkpoint = startWorkflowGraphNode(asset, checkpoint, 'work');
    checkpoint = completeWorkflowGraphNodeFailure(
      asset,
      checkpoint,
      'work',
      { class: 'unavailable', code: 'DOWN', message: 'down', recordedAt: '2026-11-26T00:00:00.000Z' },
      new Date('2026-11-26T00:00:00.000Z'),
    );
    expect(checkpoint.nodes[0]).toMatchObject({
      status: 'waiting',
      attempts: 1,
      wait: { kind: 'retry_backoff', wakeAt: '2026-11-26T00:00:01.000Z' },
    });
    expect(() => wakeWorkflowGraphRetry(asset, checkpoint, 'work', new Date('2026-11-26T00:00:00.500Z'))).toThrow(
      'WORKFLOW_GRAPH_RETRY_NOT_DUE:work',
    );
    checkpoint = wakeWorkflowGraphRetry(asset, checkpoint, 'work', new Date('2026-11-26T00:00:01.000Z'));
    checkpoint = startWorkflowGraphNode(asset, checkpoint, 'work');
    const unknown = completeWorkflowGraphNodeFailure(
      asset,
      checkpoint,
      'work',
      {
        class: 'outcome_unknown',
        code: 'UNKNOWN',
        message: 'unknown',
        recordedAt: '2026-11-26T00:00:02.000Z',
        receiptRef: 'effect-1',
      },
      new Date('2026-11-26T00:00:02.000Z'),
    );
    expect(unknown).toMatchObject({
      status: 'reconcile_required',
      nodes: [{ status: 'reconcile_required', attempts: 2 }],
    });
  });

  test('supports durable event wait wake and timeout routing without polling', () => {
    const asset = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'graph.wait',
      version: '1',
      entryNodeId: 'wait',
      nodes: [
        {
          kind: 'wait_event',
          nodeId: 'wait',
          sources: ['agentmail.watch'],
          correlation: { kind: 'literal', value: 'case-1' },
          timeoutMs: 60000,
        },
        { kind: 'capability', nodeId: 'success', capabilityId: 'case.success', idempotency: 'idempotent' },
        { kind: 'capability', nodeId: 'timeout', capabilityId: 'case.timeout', idempotency: 'idempotent' },
      ],
      edges: [
        { edgeId: 'ok', from: 'wait', to: 'success', on: 'success' },
        { edgeId: 'expired', from: 'wait', to: 'timeout', on: 'timeout' },
      ],
    });
    let waiting = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:wait', runId: 'run-1' });
    waiting = registerWorkflowGraphWait(asset, waiting, 'wait', {
      correlationKey: 'case-1',
      registeredAt: '2026-11-26T00:00:00.000Z',
      expiresAt: '2026-11-26T00:01:00.000Z',
    });
    expect(waiting.status).toBe('waiting');
    expect(waiting.nodes.find((node) => node.nodeId === 'wait')).toMatchObject({
      status: 'waiting',
      wait: { kind: 'event', correlationKey: 'case-1' },
    });
    const resolved = resolveWorkflowGraphWait(asset, waiting, 'wait', {
      recordedAt: '2026-11-26T00:00:10.000Z',
      receiptRef: 'event-1',
    });
    expect(status(resolved, 'success')).toBe('ready');
    expect(status(resolved, 'timeout')).toBe('skipped');

    let timed = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:wait', runId: 'run-2' });
    timed = registerWorkflowGraphWait(asset, timed, 'wait', {
      correlationKey: 'case-2',
      registeredAt: '2026-11-26T00:00:00.000Z',
      expiresAt: '2026-11-26T00:01:00.000Z',
    });
    timed = expireWorkflowGraphWait(asset, timed, 'wait', new Date('2026-11-26T00:01:00.000Z'));
    expect(status(timed, 'success')).toBe('skipped');
    expect(status(timed, 'timeout')).toBe('ready');
  });

  test('approval wait is explicit and rejection follows failure routing', () => {
    const asset = materializeWorkflowGraphAsset({
      schemaVersion: 2,
      workflowId: 'graph.approval',
      version: '1',
      entryNodeId: 'approve',
      nodes: [
        { kind: 'approval', nodeId: 'approve', approvalKey: 'send-mail', prompt: 'Send?', timeoutMs: 60000 },
        { kind: 'capability', nodeId: 'sent', capabilityId: 'mail.send', idempotency: 'idempotent' },
        { kind: 'capability', nodeId: 'declined', capabilityId: 'mail.declined', idempotency: 'idempotent' },
      ],
      edges: [
        { edgeId: 'yes', from: 'approve', to: 'sent', on: 'success' },
        { edgeId: 'no', from: 'approve', to: 'declined', on: 'failure' },
      ],
    });
    let checkpoint = createInitialWorkflowGraphCheckpoint(asset, { scopeId: 'workflow:approval', runId: 'run-1' });
    checkpoint = registerWorkflowGraphWait(asset, checkpoint, 'approve', {
      requestRef: 'approval-1',
      registeredAt: '2026-11-26T00:00:00.000Z',
      expiresAt: '2026-11-26T00:01:00.000Z',
    });
    checkpoint = resolveWorkflowGraphWait(asset, checkpoint, 'approve', {
      approved: false,
      recordedAt: '2026-11-26T00:00:05.000Z',
      receiptRef: 'approval-1',
    });
    expect(status(checkpoint, 'sent')).toBe('skipped');
    expect(status(checkpoint, 'declined')).toBe('ready');
  });
});
