import type { WorkflowJsonValue } from '../domain/workflow-asset';
import type { WorkflowGraphAssetDefinition, WorkflowGraphBinding, WorkflowGraphNode } from '../domain/workflow-graph';
import type { WorkflowGraphCheckpoint } from '../domain/workflow-graph-checkpoint';
import { validateWorkflowFeatureInputs } from '../domain/workflow-feature';
import { resolveWorkflowGraphBinding, stabilizeWorkflowGraphCheckpoint } from './graph-reducer';

interface WorkflowGraphDispatchBase {
  nodeId: string;
  nextAttempt: number;
  timeoutMs?: number;
  authorization: 'not_authorized';
  execution: 'not_executed';
}

export type WorkflowGraphDispatchPlan =
  | (WorkflowGraphDispatchBase & {
      kind: 'capability';
      capabilityId: string;
      input: Record<string, WorkflowJsonValue>;
      idempotency: 'idempotent' | 'non_idempotent';
      reconcileWithCapabilityId?: string;
    })
  | (WorkflowGraphDispatchBase & {
      kind: 'script';
      scriptRef: string;
      input: Record<string, WorkflowJsonValue>;
    })
  | (WorkflowGraphDispatchBase & {
      kind: 'workflow';
      workflowId: string;
      input: Record<string, WorkflowJsonValue>;
    })
  | (WorkflowGraphDispatchBase & {
      kind: 'wait_event';
      sources: string[];
      eventTypes?: string[];
      correlationKey: string;
    })
  | (WorkflowGraphDispatchBase & {
      kind: 'approval';
      approvalKey: string;
      prompt: string;
    });

export interface WorkflowGraphDispatchBatch {
  checkpoint: WorkflowGraphCheckpoint;
  plans: WorkflowGraphDispatchPlan[];
}

function resolveRequiredBinding(
  binding: WorkflowGraphBinding,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: WorkflowGraphCheckpoint,
  code: string,
): WorkflowJsonValue {
  const value = resolveWorkflowGraphBinding(binding, inputs, checkpoint);
  if (value === undefined) throw new Error(code);
  return structuredClone(value);
}

function resolveNodeInput(
  node: WorkflowGraphNode,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: WorkflowGraphCheckpoint,
): Record<string, WorkflowJsonValue> {
  return Object.fromEntries(
    Object.entries(node.input ?? {}).map(([name, binding]) => [
      name,
      resolveRequiredBinding(
        binding,
        inputs,
        checkpoint,
        `WORKFLOW_GRAPH_NODE_INPUT_UNRESOLVED:${node.nodeId}:${name}`,
      ),
    ]),
  );
}

function base(node: WorkflowGraphNode, checkpoint: WorkflowGraphCheckpoint): WorkflowGraphDispatchBase {
  const state = checkpoint.nodes.find((entry) => entry.nodeId === node.nodeId);
  if (!state || state.status !== 'ready') throw new Error('WORKFLOW_GRAPH_DISPATCH_NODE_NOT_READY:' + node.nodeId);
  return {
    nodeId: node.nodeId,
    nextAttempt: state.attempts + 1,
    ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
    authorization: 'not_authorized',
    execution: 'not_executed',
  };
}

function planReadyNode(
  node: WorkflowGraphNode,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: WorkflowGraphCheckpoint,
): WorkflowGraphDispatchPlan | undefined {
  if (node.kind === 'branch' || node.kind === 'join') return undefined;
  const common = base(node, checkpoint);
  if (node.kind === 'capability') {
    return {
      ...common,
      kind: 'capability',
      capabilityId: node.capabilityId,
      input: resolveNodeInput(node, inputs, checkpoint),
      idempotency: node.idempotency ?? 'idempotent',
      ...(node.reconcileWithCapabilityId ? { reconcileWithCapabilityId: node.reconcileWithCapabilityId } : {}),
    };
  }
  if (node.kind === 'script') {
    return { ...common, kind: 'script', scriptRef: node.scriptRef, input: resolveNodeInput(node, inputs, checkpoint) };
  }
  if (node.kind === 'workflow') {
    return {
      ...common,
      kind: 'workflow',
      workflowId: node.workflowId,
      input: resolveNodeInput(node, inputs, checkpoint),
    };
  }
  if (node.kind === 'wait_event') {
    const correlation = resolveRequiredBinding(
      node.correlation,
      inputs,
      checkpoint,
      `WORKFLOW_GRAPH_WAIT_CORRELATION_UNRESOLVED:${node.nodeId}`,
    );
    if (typeof correlation !== 'string' || !correlation.trim())
      throw new Error('WORKFLOW_GRAPH_WAIT_CORRELATION_STRING_REQUIRED:' + node.nodeId);
    return {
      ...common,
      kind: 'wait_event',
      sources: [...node.sources],
      ...(node.eventTypes ? { eventTypes: [...node.eventTypes] } : {}),
      correlationKey: correlation,
    };
  }
  return { ...common, kind: 'approval', approvalKey: node.approvalKey, prompt: node.prompt };
}

/** Pure planning boundary: no capability, process, event subscription, approval, or child Workflow is executed here. */
export function planWorkflowGraphDispatch(
  asset: WorkflowGraphAssetDefinition,
  checkpointInput: WorkflowGraphCheckpoint,
  providedInputs: Record<string, WorkflowJsonValue> = {},
): WorkflowGraphDispatchBatch {
  const inputs = validateWorkflowFeatureInputs(asset, providedInputs);
  const checkpoint = stabilizeWorkflowGraphCheckpoint(asset, checkpointInput, inputs);
  const plans = asset.nodes
    .filter((node) => checkpoint.nodes.find((entry) => entry.nodeId === node.nodeId)?.status === 'ready')
    .map((node) => planReadyNode(node, inputs, checkpoint))
    .filter((plan): plan is WorkflowGraphDispatchPlan => plan !== undefined)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return { checkpoint, plans };
}
