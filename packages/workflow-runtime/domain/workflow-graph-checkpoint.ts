import type { WorkflowGraphAssetDefinition } from './workflow-graph';

export type WorkflowGraphRunStatus =
  | 'running'
  | 'waiting'
  | 'reconcile_required'
  | 'failed'
  | 'compensating'
  | 'compensated'
  | 'succeeded'
  | 'cancelled';
export type WorkflowGraphNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'reconcile_required'
  | 'skipped'
  | 'cancelled';

export interface WorkflowGraphNodeReceipt {
  attempt: number;
  outcome: 'succeeded' | 'failed' | 'outcome_unknown';
  receiptRef?: string;
  recordedAt: string;
}

export type WorkflowGraphCompensationStatus =
  | 'not_required'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'reconcile_required';

export interface WorkflowGraphCompensationCheckpoint {
  status: WorkflowGraphCompensationStatus;
  attempts: number;
  receipts: WorkflowGraphNodeReceipt[];
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export type WorkflowGraphWaitState =
  | { kind: 'event'; correlationKey: string; registeredAt: string; expiresAt: string }
  | { kind: 'approval'; approvalKey: string; requestRef?: string; registeredAt: string; expiresAt: string }
  | { kind: 'retry_backoff'; wakeAt: string };

export interface WorkflowGraphNodeCheckpoint {
  nodeId: string;
  status: WorkflowGraphNodeStatus;
  attempts: number;
  receipts: WorkflowGraphNodeReceipt[];
  completion?: 'success' | 'failure' | 'timeout';
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  wait?: WorkflowGraphWaitState;
  compensation?: WorkflowGraphCompensationCheckpoint;
}

export type WorkflowGraphEdgeStatus = 'dormant' | 'active' | 'consumed' | 'skipped';

export interface WorkflowGraphEdgeCheckpoint {
  edgeId: string;
  status: WorkflowGraphEdgeStatus;
}

export interface WorkflowGraphCheckpoint {
  schemaVersion: 2;
  binding: { scopeId: string; runId: string };
  workflowId: string;
  version: string;
  contentDigest: string;
  status: WorkflowGraphRunStatus;
  nodes: WorkflowGraphNodeCheckpoint[];
  edges: WorkflowGraphEdgeCheckpoint[];
}

const TERMINAL_NODE = new Set<WorkflowGraphNodeStatus>(['succeeded', 'failed', 'skipped', 'cancelled']);
const NODE_STATUS = new Set<WorkflowGraphNodeStatus>([
  'pending',
  'ready',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'reconcile_required',
  'skipped',
  'cancelled',
]);

function terminalFailureHandled(asset: WorkflowGraphAssetDefinition, node: WorkflowGraphNodeCheckpoint): boolean {
  if (node.status !== 'failed') return false;
  return asset.edges.some(
    (edge) =>
      edge.from === node.nodeId &&
      ((edge.on === 'timeout' && node.completion === 'timeout') ||
        (edge.on === 'failure' && (node.completion ?? 'failure') === 'failure')),
  );
}

function boundedText(value: unknown, code: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(code);
  return value;
}
function iso(value: unknown, code: string): string {
  const text = boundedText(value, code, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(code);
  return text;
}
function validateReceipt(value: WorkflowGraphNodeReceipt, attempts: number): WorkflowGraphNodeReceipt {
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > attempts)
    throw new Error('WORKFLOW_GRAPH_RECEIPT_ATTEMPT_INVALID');
  if (!['succeeded', 'failed', 'outcome_unknown'].includes(value.outcome))
    throw new Error('WORKFLOW_GRAPH_RECEIPT_OUTCOME_INVALID');
  const recordedAt = iso(value.recordedAt, 'WORKFLOW_GRAPH_RECEIPT_TIME_INVALID');
  const receiptRef =
    value.receiptRef === undefined ? undefined : boundedText(value.receiptRef, 'WORKFLOW_GRAPH_RECEIPT_REF_INVALID');
  return { attempt: value.attempt, outcome: value.outcome, ...(receiptRef ? { receiptRef } : {}), recordedAt };
}
function validateWait(value: WorkflowGraphWaitState | undefined): WorkflowGraphWaitState | undefined {
  if (!value) return undefined;
  if (value.kind === 'event') {
    const registeredAt = iso(value.registeredAt, 'WORKFLOW_GRAPH_WAIT_REGISTERED_AT_INVALID');
    const expiresAt = iso(value.expiresAt, 'WORKFLOW_GRAPH_WAIT_EXPIRES_AT_INVALID');
    if (Date.parse(expiresAt) <= Date.parse(registeredAt)) throw new Error('WORKFLOW_GRAPH_WAIT_WINDOW_INVALID');
    return {
      kind: 'event',
      correlationKey: boundedText(value.correlationKey, 'WORKFLOW_GRAPH_WAIT_CORRELATION_INVALID'),
      registeredAt,
      expiresAt,
    };
  }
  if (value.kind === 'approval') {
    const registeredAt = iso(value.registeredAt, 'WORKFLOW_GRAPH_WAIT_REGISTERED_AT_INVALID');
    const expiresAt = iso(value.expiresAt, 'WORKFLOW_GRAPH_WAIT_EXPIRES_AT_INVALID');
    if (Date.parse(expiresAt) <= Date.parse(registeredAt)) throw new Error('WORKFLOW_GRAPH_WAIT_WINDOW_INVALID');
    return {
      kind: 'approval',
      approvalKey: boundedText(value.approvalKey, 'WORKFLOW_GRAPH_APPROVAL_KEY_INVALID'),
      ...(value.requestRef
        ? { requestRef: boundedText(value.requestRef, 'WORKFLOW_GRAPH_APPROVAL_REQUEST_REF_INVALID') }
        : {}),
      registeredAt,
      expiresAt,
    };
  }
  if (value.kind === 'retry_backoff')
    return { kind: 'retry_backoff', wakeAt: iso(value.wakeAt, 'WORKFLOW_GRAPH_RETRY_WAKE_AT_INVALID') };
  throw new Error('WORKFLOW_GRAPH_WAIT_KIND_INVALID');
}

function validateCompensationCheckpoint(
  value: WorkflowGraphCompensationCheckpoint | undefined,
): WorkflowGraphCompensationCheckpoint | undefined {
  if (!value) return undefined;
  if (!['not_required', 'pending', 'running', 'succeeded', 'failed', 'reconcile_required'].includes(value.status))
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_STATUS_INVALID');
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 10)
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_ATTEMPTS_INVALID');
  if (!Array.isArray(value.receipts) || value.receipts.length > 32)
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_RECEIPTS_INVALID');
  const receipts = value.receipts.map((receipt) => validateReceipt(receipt, value.attempts));
  if (value.status === 'reconcile_required' && !receipts.some((receipt) => receipt.outcome === 'outcome_unknown'))
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_RECONCILIATION_RECEIPT_REQUIRED');
  return {
    status: value.status,
    attempts: value.attempts,
    receipts,
    ...(value.output === undefined ? {} : { output: structuredClone(value.output) }),
    ...(value.error === undefined
      ? {}
      : {
          error: {
            code: boundedText(value.error.code, 'WORKFLOW_GRAPH_COMPENSATION_ERROR_CODE_INVALID', 128),
            message: boundedText(value.error.message, 'WORKFLOW_GRAPH_COMPENSATION_ERROR_MESSAGE_INVALID', 2000),
          },
        }),
  };
}

function validateNodeCheckpoint(value: WorkflowGraphNodeCheckpoint): WorkflowGraphNodeCheckpoint {
  const nodeId = boundedText(value.nodeId, 'WORKFLOW_GRAPH_CHECKPOINT_NODE_ID_INVALID', 128);
  if (!NODE_STATUS.has(value.status)) throw new Error('WORKFLOW_GRAPH_CHECKPOINT_NODE_STATUS_INVALID');
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 10)
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_ATTEMPTS_INVALID');
  if (!Array.isArray(value.receipts) || value.receipts.length > 32)
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_RECEIPTS_INVALID');
  const receipts = value.receipts.map((receipt) => validateReceipt(receipt, value.attempts));
  if (value.completion !== undefined && !['success', 'failure', 'timeout'].includes(value.completion))
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_COMPLETION_INVALID');
  if (value.status === 'succeeded' && value.completion !== undefined && value.completion !== 'success')
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_COMPLETION_STATUS_MISMATCH');
  if (value.status === 'failed' && value.completion === 'success')
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_COMPLETION_STATUS_MISMATCH');
  const wait = validateWait(value.wait);
  const compensation = validateCompensationCheckpoint(value.compensation);
  if (value.status === 'waiting' && !wait) throw new Error('WORKFLOW_GRAPH_CHECKPOINT_WAIT_STATE_REQUIRED');
  if (value.status !== 'waiting' && wait) throw new Error('WORKFLOW_GRAPH_CHECKPOINT_WAIT_STATE_UNEXPECTED');
  if (value.status === 'reconcile_required' && !receipts.some((receipt) => receipt.outcome === 'outcome_unknown'))
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_RECONCILIATION_RECEIPT_REQUIRED');
  return {
    nodeId,
    status: value.status,
    attempts: value.attempts,
    receipts,
    ...(value.completion === undefined ? {} : { completion: value.completion }),
    ...(value.output === undefined ? {} : { output: structuredClone(value.output) }),
    ...(value.error === undefined
      ? {}
      : {
          error: {
            code: boundedText(value.error.code, 'WORKFLOW_GRAPH_CHECKPOINT_ERROR_CODE_INVALID', 128),
            message: boundedText(value.error.message, 'WORKFLOW_GRAPH_CHECKPOINT_ERROR_MESSAGE_INVALID', 2000),
          },
        }),
    ...(wait ? { wait } : {}),
    ...(compensation ? { compensation } : {}),
  };
}

function validateEdgeCheckpoint(value: WorkflowGraphEdgeCheckpoint): WorkflowGraphEdgeCheckpoint {
  const edgeId = boundedText(value.edgeId, 'WORKFLOW_GRAPH_CHECKPOINT_EDGE_ID_INVALID', 128);
  if (!['dormant', 'active', 'consumed', 'skipped'].includes(value.status))
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_EDGE_STATUS_INVALID');
  return { edgeId, status: value.status };
}

export function validateWorkflowGraphCheckpoint(
  asset: WorkflowGraphAssetDefinition,
  input: WorkflowGraphCheckpoint,
): WorkflowGraphCheckpoint {
  if (input.schemaVersion !== 2) throw new Error('WORKFLOW_GRAPH_CHECKPOINT_SCHEMA_VERSION_UNSUPPORTED');
  const scopeId = boundedText(input.binding.scopeId, 'WORKFLOW_GRAPH_CHECKPOINT_SCOPE_ID_INVALID');
  const runId = boundedText(input.binding.runId, 'WORKFLOW_GRAPH_CHECKPOINT_RUN_ID_INVALID');
  if (
    input.workflowId !== asset.workflowId ||
    input.version !== asset.version ||
    input.contentDigest !== asset.contentDigest
  )
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_ASSET_IDENTITY_MISMATCH');
  if (
    ![
      'running',
      'waiting',
      'reconcile_required',
      'failed',
      'compensating',
      'compensated',
      'succeeded',
      'cancelled',
    ].includes(input.status)
  )
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_STATUS_INVALID');
  if (!Array.isArray(input.nodes) || input.nodes.length !== asset.nodes.length)
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_NODE_SET_INVALID');
  const expected = new Set(asset.nodes.map((node) => node.nodeId));
  const seen = new Set<string>();
  const nodes = input.nodes.map((node) => {
    const checked = validateNodeCheckpoint(node);
    if (!expected.has(checked.nodeId) || seen.has(checked.nodeId))
      throw new Error('WORKFLOW_GRAPH_CHECKPOINT_NODE_SET_INVALID');
    seen.add(checked.nodeId);
    return checked;
  });
  if (seen.size !== expected.size) throw new Error('WORKFLOW_GRAPH_CHECKPOINT_NODE_SET_INVALID');
  for (const node of nodes) {
    const definition = asset.nodes.find((entry) => entry.nodeId === node.nodeId)!;
    const compensable =
      (definition.kind === 'capability' || definition.kind === 'script' || definition.kind === 'workflow') &&
      definition.compensation !== undefined;
    if (compensable !== (node.compensation !== undefined))
      throw new Error('WORKFLOW_GRAPH_COMPENSATION_CHECKPOINT_MISMATCH:' + node.nodeId);
  }
  if (!Array.isArray(input.edges) || input.edges.length !== asset.edges.length)
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_EDGE_SET_INVALID');
  const expectedEdges = new Set(asset.edges.map((edge) => edge.edgeId));
  const seenEdges = new Set<string>();
  const edges = input.edges.map((edge) => {
    const checked = validateEdgeCheckpoint(edge);
    if (!expectedEdges.has(checked.edgeId) || seenEdges.has(checked.edgeId))
      throw new Error('WORKFLOW_GRAPH_CHECKPOINT_EDGE_SET_INVALID');
    seenEdges.add(checked.edgeId);
    return checked;
  });
  if (seenEdges.size !== expectedEdges.size) throw new Error('WORKFLOW_GRAPH_CHECKPOINT_EDGE_SET_INVALID');
  if (input.status === 'waiting' && !nodes.some((node) => node.status === 'waiting'))
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_WAITING_NODE_REQUIRED');
  if (
    input.status === 'reconcile_required' &&
    !nodes.some((node) => node.status === 'reconcile_required' || node.compensation?.status === 'reconcile_required')
  )
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_RECONCILIATION_NODE_REQUIRED');
  if (
    input.status === 'succeeded' &&
    nodes.some(
      (node) =>
        !TERMINAL_NODE.has(node.status) ||
        node.status === 'cancelled' ||
        (node.status === 'failed' && !terminalFailureHandled(asset, node)),
    )
  )
    throw new Error('WORKFLOW_GRAPH_CHECKPOINT_SUCCESS_STATE_INVALID');
  return {
    schemaVersion: 2,
    binding: { scopeId, runId },
    workflowId: asset.workflowId,
    version: asset.version,
    contentDigest: asset.contentDigest,
    status: input.status,
    nodes,
    edges,
  };
}

export function createInitialWorkflowGraphCheckpoint(
  asset: WorkflowGraphAssetDefinition,
  binding: WorkflowGraphCheckpoint['binding'],
): WorkflowGraphCheckpoint {
  return validateWorkflowGraphCheckpoint(asset, {
    schemaVersion: 2,
    binding,
    workflowId: asset.workflowId,
    version: asset.version,
    contentDigest: asset.contentDigest,
    status: 'running',
    nodes: asset.nodes.map((node) => ({
      nodeId: node.nodeId,
      status: node.nodeId === asset.entryNodeId ? 'ready' : 'pending',
      attempts: 0,
      receipts: [],
      ...((node.kind === 'capability' || node.kind === 'script' || node.kind === 'workflow') && node.compensation
        ? { compensation: { status: 'not_required' as const, attempts: 0, receipts: [] } }
        : {}),
    })),
    edges: asset.edges.map((edge) => ({ edgeId: edge.edgeId, status: 'dormant' })),
  });
}
