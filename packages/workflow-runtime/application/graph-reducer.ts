import type { WorkflowJsonValue } from '../domain/workflow-asset';
import type {
  WorkflowGraphAssetDefinition,
  WorkflowGraphBinding,
  WorkflowGraphCondition,
  WorkflowGraphEdge,
  WorkflowGraphNode,
} from '../domain/workflow-graph';
import {
  validateWorkflowGraphCheckpoint,
  type WorkflowGraphCheckpoint,
  type WorkflowGraphNodeCheckpoint,
} from '../domain/workflow-graph-checkpoint';
import { validateWorkflowFeatureInputs } from '../domain/workflow-feature';

const TERMINAL = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);

function nodeState(checkpoint: WorkflowGraphCheckpoint, nodeId: string): WorkflowGraphNodeCheckpoint {
  const state = checkpoint.nodes.find((node) => node.nodeId === nodeId);
  if (!state) throw new Error('WORKFLOW_GRAPH_NODE_STATE_MISSING:' + nodeId);
  return state;
}

export function resolveWorkflowGraphBinding(
  binding: WorkflowGraphBinding,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: WorkflowGraphCheckpoint,
): WorkflowJsonValue | undefined {
  if (binding.kind === 'literal') return binding.value;
  if (binding.kind === 'input') return inputs[binding.name];
  const output = nodeState(checkpoint, binding.nodeId).output;
  return output?.[binding.field] as WorkflowJsonValue | undefined;
}

function compareValues(
  operator: Extract<WorkflowGraphCondition, { kind: 'compare' }>['operator'],
  left: unknown,
  right: unknown,
): boolean {
  if (operator === 'exists') return left !== undefined;
  if (operator === 'equals') return left === right;
  if (operator === 'not_equals') return left !== right;
  if (operator === 'contains') return typeof left === 'string' && typeof right === 'string' && left.includes(right);
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  if (operator === 'lte') return left <= right;
  return false;
}

export function evaluateWorkflowGraphCondition(
  condition: WorkflowGraphCondition,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: WorkflowGraphCheckpoint,
): boolean {
  if (condition.kind === 'all')
    return condition.conditions.every((entry) => evaluateWorkflowGraphCondition(entry, inputs, checkpoint));
  if (condition.kind === 'any')
    return condition.conditions.some((entry) => evaluateWorkflowGraphCondition(entry, inputs, checkpoint));
  if (condition.kind === 'not') return !evaluateWorkflowGraphCondition(condition.condition, inputs, checkpoint);
  const comparison = condition as Extract<WorkflowGraphCondition, { kind: 'compare' }>;
  return compareValues(
    comparison.operator,
    resolveWorkflowGraphBinding(comparison.left, inputs, checkpoint),
    comparison.right === undefined ? undefined : resolveWorkflowGraphBinding(comparison.right, inputs, checkpoint),
  );
}

function incoming(asset: WorkflowGraphAssetDefinition, nodeId: string): WorkflowGraphEdge[] {
  return asset.edges.filter((edge) => edge.to === nodeId);
}

function outgoing(asset: WorkflowGraphAssetDefinition, nodeId: string): WorkflowGraphEdge[] {
  return asset.edges.filter((edge) => edge.from === nodeId);
}

function branchSelectedEdge(source: WorkflowGraphNodeCheckpoint): string | undefined {
  const value = source.output?.selectedEdgeId;
  return typeof value === 'string' ? value : undefined;
}

function activeEdge(
  asset: WorkflowGraphAssetDefinition,
  edge: WorkflowGraphEdge,
  checkpoint: WorkflowGraphCheckpoint,
): boolean {
  const sourceDefinition = asset.nodes.find((node) => node.nodeId === edge.from);
  const source = nodeState(checkpoint, edge.from);
  if (sourceDefinition?.kind === 'branch')
    return source.status === 'succeeded' && branchSelectedEdge(source) === edge.edgeId;
  if (edge.on === 'success') return source.status === 'succeeded' && (source.completion ?? 'success') === 'success';
  if (edge.on === 'failure') return source.status === 'failed' && (source.completion ?? 'failure') === 'failure';
  if (edge.on === 'timeout') return source.status === 'failed' && source.completion === 'timeout';
  return false;
}

function allSourcesTerminal(edges: WorkflowGraphEdge[], checkpoint: WorkflowGraphCheckpoint): boolean {
  return edges.every((edge) => TERMINAL.has(nodeState(checkpoint, edge.from).status));
}

function joinSatisfied(
  node: Extract<WorkflowGraphNode, { kind: 'join' }>,
  edges: WorkflowGraphEdge[],
  asset: WorkflowGraphAssetDefinition,
  checkpoint: WorkflowGraphCheckpoint,
): boolean {
  const active = edges.filter((edge) => activeEdge(asset, edge, checkpoint)).length;
  if (node.policy === 'any') return active >= 1;
  if (node.policy === 'quorum') return active >= node.quorum!;
  return allSourcesTerminal(edges, checkpoint) && active >= 1;
}

function markPendingNode(
  asset: WorkflowGraphAssetDefinition,
  checkpoint: WorkflowGraphCheckpoint,
  definition: WorkflowGraphNode,
  state: WorkflowGraphNodeCheckpoint,
): boolean {
  if (state.status !== 'pending' || definition.nodeId === asset.entryNodeId) return false;
  const edges = incoming(asset, definition.nodeId);
  if (definition.kind === 'join') {
    if (joinSatisfied(definition, edges, asset, checkpoint)) {
      state.status = 'ready';
      return true;
    }
    if (allSourcesTerminal(edges, checkpoint)) {
      state.status = 'skipped';
      return true;
    }
    return false;
  }
  if (edges.some((edge) => activeEdge(asset, edge, checkpoint))) {
    state.status = 'ready';
    return true;
  }
  if (allSourcesTerminal(edges, checkpoint)) {
    state.status = 'skipped';
    return true;
  }
  return false;
}

function resolveBranch(
  asset: WorkflowGraphAssetDefinition,
  checkpoint: WorkflowGraphCheckpoint,
  inputs: Record<string, WorkflowJsonValue>,
  definition: WorkflowGraphNode,
  state: WorkflowGraphNodeCheckpoint,
): boolean {
  if (definition.kind !== 'branch' || state.status !== 'ready') return false;
  const edges = outgoing(asset, definition.nodeId);
  const selected =
    edges.find(
      (edge) => edge.on === 'condition' && evaluateWorkflowGraphCondition(edge.condition!, inputs, checkpoint),
    ) ?? edges.find((edge) => edge.on === 'default');
  if (!selected) throw new Error('WORKFLOW_GRAPH_BRANCH_NO_ROUTE:' + definition.nodeId);
  state.status = 'succeeded';
  state.completion = 'success';
  state.output = { selectedEdgeId: selected.edgeId };
  return true;
}

function resolveJoin(definition: WorkflowGraphNode, state: WorkflowGraphNodeCheckpoint): boolean {
  if (definition.kind !== 'join' || state.status !== 'ready') return false;
  state.status = 'succeeded';
  state.completion = 'success';
  return true;
}

function failureHandled(
  asset: WorkflowGraphAssetDefinition,
  checkpoint: WorkflowGraphCheckpoint,
  node: WorkflowGraphNodeCheckpoint,
): boolean {
  if (node.status !== 'failed') return false;
  return outgoing(asset, node.nodeId).some((edge) => activeEdge(asset, edge, checkpoint));
}

function deriveRunStatus(
  asset: WorkflowGraphAssetDefinition,
  checkpoint: WorkflowGraphCheckpoint,
): WorkflowGraphCheckpoint['status'] {
  if (checkpoint.nodes.some((node) => node.status === 'reconcile_required')) return 'reconcile_required';
  if (checkpoint.nodes.some((node) => node.status === 'failed' && !failureHandled(asset, checkpoint, node)))
    return 'failed';
  const allDone = checkpoint.nodes.every(
    (node) => node.status === 'succeeded' || node.status === 'skipped' || failureHandled(asset, checkpoint, node),
  );
  if (allDone) return 'succeeded';
  const hasActiveExecution = checkpoint.nodes.some((node) => node.status === 'ready' || node.status === 'running');
  if (hasActiveExecution) return 'running';
  if (checkpoint.nodes.some((node) => node.status === 'waiting')) return 'waiting';
  return 'running';
}

/** Deterministically advances control nodes only. It never executes capabilities/scripts/child workflows. */
export function stabilizeWorkflowGraphCheckpoint(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  providedInputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphCheckpoint {
  const inputs = validateWorkflowFeatureInputs(asset, providedInputs);
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of asset.nodes) {
      const state = nodeState(checkpoint, definition.nodeId);
      changed = markPendingNode(asset, checkpoint, definition, state) || changed;
      changed =
        resolveBranch(asset, checkpoint, inputs, definition as Extract<WorkflowGraphNode, { kind: 'branch' }>, state) ||
        changed;
      changed = resolveJoin(definition, state) || changed;
    }
  }
  checkpoint.status = deriveRunStatus(asset, checkpoint);
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

export function startWorkflowGraphNode(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const definition = asset.nodes.find((node) => node.nodeId === nodeId);
  if (
    !definition ||
    definition.kind === 'branch' ||
    definition.kind === 'join' ||
    definition.kind === 'wait_event' ||
    definition.kind === 'approval'
  )
    throw new Error('WORKFLOW_GRAPH_EXECUTABLE_NODE_REQUIRED:' + nodeId);
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'ready') throw new Error('WORKFLOW_GRAPH_NODE_NOT_READY:' + nodeId);
  state.status = 'running';
  state.attempts += 1;
  checkpoint.status = 'running';
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

export function completeWorkflowGraphNodeSuccess(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  result: { output?: Record<string, unknown>; receiptRef?: string; recordedAt: string },
  inputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'running') throw new Error('WORKFLOW_GRAPH_NODE_NOT_RUNNING:' + nodeId);
  state.status = 'succeeded';
  state.completion = 'success';
  if (result.output !== undefined) state.output = structuredClone(result.output);
  state.receipts.push({
    attempt: state.attempts,
    outcome: 'succeeded',
    ...(result.receiptRef ? { receiptRef: result.receiptRef } : {}),
    recordedAt: result.recordedAt,
  });
  return stabilizeWorkflowGraphCheckpoint(asset, checkpoint, inputs);
}

function retryDelayMs(node: WorkflowGraphNode, attempt: number): number | undefined {
  if (!node.retry || attempt >= node.retry.maxAttempts) return undefined;
  const multiplier = node.retry.strategy === 'exponential' ? 2 ** Math.max(0, attempt - 1) : 1;
  return Math.min(node.retry.maxDelayMs, node.retry.initialDelayMs * multiplier);
}

function addNodeReceipt(
  state: WorkflowGraphNodeCheckpoint,
  recordedAt: string,
  receiptRef: string | undefined,
  outcome: 'succeeded' | 'failed' | 'outcome_unknown',
): void {
  state.receipts.push({
    attempt: state.attempts,
    outcome,
    ...(receiptRef ? { receiptRef } : {}),
    recordedAt,
  });
}

export function completeWorkflowGraphNodeFailure(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  failure: {
    class: 'failed' | 'timeout' | 'rate_limited' | 'unavailable' | 'outcome_unknown';
    code: string;
    message: string;
    recordedAt: string;
    receiptRef?: string;
  },
  now: Date,
  inputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const definition = asset.nodes.find((node) => node.nodeId === nodeId);
  if (!definition) throw new Error('WORKFLOW_GRAPH_NODE_NOT_FOUND:' + nodeId);
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'running') throw new Error('WORKFLOW_GRAPH_NODE_NOT_RUNNING:' + nodeId);
  state.error = { code: failure.code, message: failure.message };
  if (failure.class === 'outcome_unknown') {
    addNodeReceipt(state, failure.recordedAt, failure.receiptRef, 'outcome_unknown');
    state.status = 'reconcile_required';
    checkpoint.status = 'reconcile_required';
    return validateWorkflowGraphCheckpoint(asset, checkpoint);
  }
  addNodeReceipt(state, failure.recordedAt, failure.receiptRef, 'failed');
  const retryable =
    definition.retry?.retryOn.includes(failure.class as 'failed' | 'timeout' | 'rate_limited' | 'unavailable') ?? false;
  const delay = retryable ? retryDelayMs(definition, state.attempts) : undefined;
  if (delay !== undefined) {
    state.status = 'waiting';
    state.wait = { kind: 'retry_backoff', wakeAt: new Date(now.getTime() + delay).toISOString() };
    state.completion = undefined;
    checkpoint.status = deriveRunStatus(asset, checkpoint);
    return validateWorkflowGraphCheckpoint(asset, checkpoint);
  }
  state.status = 'failed';
  state.completion = failure.class === 'timeout' ? 'timeout' : 'failure';
  state.wait = undefined;
  return stabilizeWorkflowGraphCheckpoint(asset, checkpoint, inputs);
}

export function wakeWorkflowGraphRetry(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  now: Date,
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'waiting' || state.wait?.kind !== 'retry_backoff')
    throw new Error('WORKFLOW_GRAPH_RETRY_WAIT_REQUIRED:' + nodeId);
  if (now.getTime() < Date.parse(state.wait.wakeAt)) throw new Error('WORKFLOW_GRAPH_RETRY_NOT_DUE:' + nodeId);
  state.status = 'ready';
  state.wait = undefined;
  checkpoint.status = deriveRunStatus(asset, checkpoint);
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

export function registerWorkflowGraphWait(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  wait: { correlationKey?: string; requestRef?: string; registeredAt: string; expiresAt: string },
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const definition = asset.nodes.find((node) => node.nodeId === nodeId);
  if (!definition || (definition.kind !== 'wait_event' && definition.kind !== 'approval'))
    throw new Error('WORKFLOW_GRAPH_WAIT_NODE_REQUIRED:' + nodeId);
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'ready') throw new Error('WORKFLOW_GRAPH_NODE_NOT_READY:' + nodeId);
  state.status = 'waiting';
  state.attempts += 1;
  state.wait =
    definition.kind === 'wait_event'
      ? {
          kind: 'event',
          correlationKey: wait.correlationKey ?? '',
          registeredAt: wait.registeredAt,
          expiresAt: wait.expiresAt,
        }
      : {
          kind: 'approval',
          approvalKey: definition.approvalKey,
          ...(wait.requestRef ? { requestRef: wait.requestRef } : {}),
          registeredAt: wait.registeredAt,
          expiresAt: wait.expiresAt,
        };
  checkpoint.status = deriveRunStatus(asset, checkpoint);
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

export function resolveWorkflowGraphWait(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  result: { approved?: boolean; output?: Record<string, unknown>; receiptRef?: string; recordedAt: string },
  inputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'waiting' || !state.wait || state.wait.kind === 'retry_backoff')
    throw new Error('WORKFLOW_GRAPH_DURABLE_WAIT_REQUIRED:' + nodeId);
  const rejected = state.wait.kind === 'approval' && result.approved === false;
  state.wait = undefined;
  state.status = rejected ? 'failed' : 'succeeded';
  state.completion = rejected ? 'failure' : 'success';
  if (result.output !== undefined) state.output = structuredClone(result.output);
  addNodeReceipt(state, result.recordedAt, result.receiptRef, rejected ? 'failed' : 'succeeded');
  checkpoint.status = deriveRunStatus(asset, checkpoint);
  return stabilizeWorkflowGraphCheckpoint(asset, checkpoint, inputs);
}

export function expireWorkflowGraphWait(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  now: Date,
  inputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'waiting' || !state.wait || state.wait.kind === 'retry_backoff')
    throw new Error('WORKFLOW_GRAPH_DURABLE_WAIT_REQUIRED:' + nodeId);
  if (now.getTime() < Date.parse(state.wait.expiresAt)) throw new Error('WORKFLOW_GRAPH_WAIT_NOT_EXPIRED:' + nodeId);
  state.wait = undefined;
  state.status = 'failed';
  state.completion = 'timeout';
  state.error = { code: 'WORKFLOW_GRAPH_WAIT_TIMEOUT', message: `Workflow node ${nodeId} timed out.` };
  addNodeReceipt(state, now.toISOString(), undefined, 'failed');
  checkpoint.status = deriveRunStatus(asset, checkpoint);
  return stabilizeWorkflowGraphCheckpoint(asset, checkpoint, inputs);
}

export function reconcileWorkflowGraphNodeEffect(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  observation: {
    outcome: 'applied' | 'not_applied';
    receiptRef: string;
    recordedAt: string;
    output?: Record<string, unknown>;
  },
  inputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = nodeState(checkpoint, nodeId);
  if (state.status !== 'reconcile_required') throw new Error('WORKFLOW_GRAPH_RECONCILIATION_NODE_REQUIRED:' + nodeId);
  if (!state.receipts.some((receipt) => receipt.outcome === 'outcome_unknown'))
    throw new Error('WORKFLOW_GRAPH_RECONCILIATION_UNKNOWN_RECEIPT_REQUIRED:' + nodeId);
  state.error = undefined;
  if (observation.outcome === 'applied') {
    state.status = 'succeeded';
    state.completion = 'success';
    if (observation.output !== undefined) state.output = structuredClone(observation.output);
    addNodeReceipt(state, observation.recordedAt, observation.receiptRef, 'succeeded');
  } else {
    state.status = 'failed';
    state.completion = 'failure';
    state.error = {
      code: 'WORKFLOW_GRAPH_EFFECT_CONFIRMED_NOT_APPLIED',
      message: `Workflow effect ${nodeId} was confirmed not applied.`,
    };
    addNodeReceipt(state, observation.recordedAt, observation.receiptRef, 'failed');
  }
  checkpoint.status = deriveRunStatus(asset, checkpoint);
  return stabilizeWorkflowGraphCheckpoint(asset, checkpoint, inputs);
}
