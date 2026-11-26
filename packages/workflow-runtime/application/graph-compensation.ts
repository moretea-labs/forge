import type { WorkflowJsonValue } from '../domain/workflow-asset';
import type {
  WorkflowGraphAssetDefinition,
  WorkflowGraphCompensationDefinition,
  WorkflowGraphNode,
} from '../domain/workflow-graph';
import {
  validateWorkflowGraphCheckpoint,
  type WorkflowGraphCheckpoint,
  type WorkflowGraphNodeCheckpoint,
} from '../domain/workflow-graph-checkpoint';
import { resolveWorkflowGraphBinding } from './graph-reducer';

export type WorkflowGraphCompensationPlan =
  | {
      phase: 'compensation';
      nodeId: string;
      nextAttempt: number;
      kind: 'capability';
      capabilityId: string;
      input: Record<string, WorkflowJsonValue>;
      idempotency: 'idempotent' | 'non_idempotent';
      reconcileWithCapabilityId?: string;
      authorization: 'not_authorized';
      execution: 'not_executed';
    }
  | {
      phase: 'compensation';
      nodeId: string;
      nextAttempt: number;
      kind: 'script';
      scriptRef: string;
      input: Record<string, WorkflowJsonValue>;
      authorization: 'not_authorized';
      execution: 'not_executed';
    }
  | {
      phase: 'compensation';
      nodeId: string;
      nextAttempt: number;
      kind: 'workflow';
      workflowId: string;
      input: Record<string, WorkflowJsonValue>;
      authorization: 'not_authorized';
      execution: 'not_executed';
    };

function definitionFor(asset: WorkflowGraphAssetDefinition, nodeId: string): WorkflowGraphNode {
  const definition = asset.nodes.find((node) => node.nodeId === nodeId);
  if (!definition) throw new Error('WORKFLOW_GRAPH_COMPENSATION_NODE_NOT_FOUND:' + nodeId);
  return definition;
}

function compensationFor(definition: WorkflowGraphNode): WorkflowGraphCompensationDefinition | undefined {
  return definition.kind === 'capability' || definition.kind === 'script' || definition.kind === 'workflow'
    ? definition.compensation
    : undefined;
}

function lastSuccessTime(state: WorkflowGraphNodeCheckpoint): number {
  const successes = state.receipts.filter((receipt) => receipt.outcome === 'succeeded');
  if (successes.length === 0) return Number.NEGATIVE_INFINITY;
  return Math.max(...successes.map((receipt) => Date.parse(receipt.recordedAt)));
}

export function beginWorkflowGraphCompensation(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  if (asset.failurePolicy?.mode !== 'compensate') return checkpoint;
  if (checkpoint.status !== 'failed') throw new Error('WORKFLOW_GRAPH_COMPENSATION_FAILED_RUN_REQUIRED');
  let count = 0;
  for (const state of checkpoint.nodes) {
    const definition = definitionFor(asset, state.nodeId);
    if (state.status !== 'succeeded' || !compensationFor(definition) || !state.compensation) continue;
    if (!state.receipts.some((receipt) => receipt.outcome === 'succeeded')) continue;
    state.compensation.status = 'pending';
    count += 1;
  }
  if (count === 0) return checkpoint;
  checkpoint.status = 'compensating';
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

function resolveInput(
  compensation: WorkflowGraphCompensationDefinition,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: WorkflowGraphCheckpoint,
  nodeId: string,
): Record<string, WorkflowJsonValue> {
  return Object.fromEntries(
    Object.entries(compensation.input ?? {}).map(([key, binding]) => {
      const value = resolveWorkflowGraphBinding(binding, inputs, checkpoint);
      if (value === undefined) throw new Error(`WORKFLOW_GRAPH_COMPENSATION_INPUT_UNRESOLVED:${nodeId}:${key}`);
      return [key, structuredClone(value)];
    }),
  );
}

export function planWorkflowGraphCompensation(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  inputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphCompensationPlan | undefined {
  const checkpoint = validateWorkflowGraphCheckpoint(asset, checkpointInput);
  if (checkpoint.status !== 'compensating') return undefined;
  const state = checkpoint.nodes
    .filter((node) => node.compensation?.status === 'pending')
    .sort(
      (left, right) => lastSuccessTime(right) - lastSuccessTime(left) || left.nodeId.localeCompare(right.nodeId),
    )[0];
  if (!state) return undefined;
  const definition = definitionFor(asset, state.nodeId);
  const compensation = compensationFor(definition);
  if (!compensation || !state.compensation)
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_DEFINITION_MISSING:' + state.nodeId);
  const common = {
    phase: 'compensation' as const,
    nodeId: state.nodeId,
    nextAttempt: state.compensation.attempts + 1,
    input: resolveInput(compensation, inputs, checkpoint, state.nodeId),
    authorization: 'not_authorized' as const,
    execution: 'not_executed' as const,
  };
  if (compensation.kind === 'capability') {
    return {
      ...common,
      kind: 'capability',
      capabilityId: compensation.capabilityId,
      idempotency: compensation.idempotency ?? 'idempotent',
      ...(compensation.reconcileWithCapabilityId
        ? { reconcileWithCapabilityId: compensation.reconcileWithCapabilityId }
        : {}),
    };
  }
  if (compensation.kind === 'script') return { ...common, kind: 'script', scriptRef: compensation.scriptRef };
  return { ...common, kind: 'workflow', workflowId: compensation.workflowId };
}

export function startWorkflowGraphCompensation(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = checkpoint.nodes.find((node) => node.nodeId === nodeId);
  if (!state?.compensation || state.compensation.status !== 'pending')
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_NOT_PENDING:' + nodeId);
  state.compensation.status = 'running';
  state.compensation.attempts += 1;
  checkpoint.status = 'compensating';
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

export function completeWorkflowGraphCompensation(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  result: {
    outcome: 'succeeded' | 'failed' | 'outcome_unknown';
    receiptRef?: string;
    recordedAt: string;
    output?: Record<string, unknown>;
    error?: { code: string; message: string };
  },
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = checkpoint.nodes.find((node) => node.nodeId === nodeId);
  if (!state?.compensation || state.compensation.status !== 'running')
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_NOT_RUNNING:' + nodeId);
  state.compensation.receipts.push({
    attempt: state.compensation.attempts,
    outcome: result.outcome,
    ...(result.receiptRef ? { receiptRef: result.receiptRef } : {}),
    recordedAt: result.recordedAt,
  });
  if (result.output !== undefined) state.compensation.output = structuredClone(result.output);
  if (result.error !== undefined) state.compensation.error = structuredClone(result.error);
  if (result.outcome === 'outcome_unknown') {
    state.compensation.status = 'reconcile_required';
    checkpoint.status = 'reconcile_required';
    return validateWorkflowGraphCheckpoint(asset, checkpoint);
  }
  if (result.outcome === 'failed') {
    state.compensation.status = 'failed';
    checkpoint.status = 'failed';
    return validateWorkflowGraphCheckpoint(asset, checkpoint);
  }
  state.compensation.status = 'succeeded';
  const remaining = checkpoint.nodes.some(
    (node) => node.compensation?.status === 'pending' || node.compensation?.status === 'running',
  );
  checkpoint.status = remaining ? 'compensating' : 'compensated';
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}

export function reconcileWorkflowGraphCompensationEffect(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  nodeId: string,
  observation: {
    outcome: 'applied' | 'not_applied';
    receiptRef: string;
    recordedAt: string;
    output?: Record<string, unknown>;
  },
): WorkflowGraphCheckpoint {
  const checkpoint = structuredClone(validateWorkflowGraphCheckpoint(asset, checkpointInput));
  const state = checkpoint.nodes.find((node) => node.nodeId === nodeId);
  if (!state?.compensation || state.compensation.status !== 'reconcile_required')
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_RECONCILIATION_REQUIRED:' + nodeId);
  if (!state.compensation.receipts.some((receipt) => receipt.outcome === 'outcome_unknown'))
    throw new Error('WORKFLOW_GRAPH_COMPENSATION_UNKNOWN_RECEIPT_REQUIRED:' + nodeId);
  state.compensation.error = undefined;
  state.compensation.receipts.push({
    attempt: state.compensation.attempts,
    outcome: observation.outcome === 'applied' ? 'succeeded' : 'failed',
    receiptRef: observation.receiptRef,
    recordedAt: observation.recordedAt,
  });
  if (observation.output !== undefined) state.compensation.output = structuredClone(observation.output);
  if (observation.outcome === 'not_applied') {
    state.compensation.status = 'failed';
    state.compensation.error = {
      code: 'WORKFLOW_GRAPH_COMPENSATION_CONFIRMED_NOT_APPLIED',
      message: `Compensation for ${nodeId} was confirmed not applied.`,
    };
    checkpoint.status = 'failed';
    return validateWorkflowGraphCheckpoint(asset, checkpoint);
  }
  state.compensation.status = 'succeeded';
  const remaining = checkpoint.nodes.some(
    (node) => node.compensation?.status === 'pending' || node.compensation?.status === 'running',
  );
  checkpoint.status = remaining ? 'compensating' : 'compensated';
  return validateWorkflowGraphCheckpoint(asset, checkpoint);
}
