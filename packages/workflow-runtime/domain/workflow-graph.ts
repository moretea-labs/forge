import { createHash } from 'crypto';
import type { WorkflowDeterministicScript, WorkflowInputContract, WorkflowJsonValue } from './workflow-asset';

export const WORKFLOW_GRAPH_SCHEMA_VERSION = 2 as const;
export const WORKFLOW_GRAPH_DIGEST_PREFIX = 'sha256:' as const;

export type WorkflowGraphBinding =
  | { kind: 'literal'; value: WorkflowJsonValue }
  | { kind: 'input'; name: string }
  | { kind: 'output'; nodeId: string; field: string };

export type WorkflowGraphReconciliationBinding = WorkflowGraphBinding | { kind: 'effect_request_id' };

export type WorkflowGraphCondition =
  | {
      kind: 'compare';
      operator: 'equals' | 'not_equals' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';
      left: WorkflowGraphBinding;
      right?: WorkflowGraphBinding;
    }
  | { kind: 'all' | 'any'; conditions: WorkflowGraphCondition[] }
  | { kind: 'not'; condition: WorkflowGraphCondition };

export interface WorkflowGraphRetryPolicy {
  maxAttempts: number;
  strategy: 'fixed' | 'exponential';
  initialDelayMs: number;
  maxDelayMs: number;
  retryOn: Array<'failed' | 'timeout' | 'rate_limited' | 'unavailable'>;
}

export type WorkflowGraphCompensationDefinition =
  | {
      kind: 'capability';
      capabilityId: string;
      input?: Record<string, WorkflowGraphBinding>;
      idempotency?: 'idempotent' | 'non_idempotent';
      reconcileWithCapabilityId?: string;
      reconciliationInput?: Record<string, WorkflowGraphReconciliationBinding>;
    }
  | { kind: 'script'; scriptRef: string; input?: Record<string, WorkflowGraphBinding> }
  | { kind: 'workflow'; workflowId: string; input?: Record<string, WorkflowGraphBinding> };

interface WorkflowGraphNodeBase {
  nodeId: string;
  input?: Record<string, WorkflowGraphBinding>;
  timeoutMs?: number;
  retry?: WorkflowGraphRetryPolicy;
}

export interface WorkflowGraphCapabilityNode extends WorkflowGraphNodeBase {
  kind: 'capability';
  capabilityId: string;
  idempotency?: 'idempotent' | 'non_idempotent';
  reconcileWithCapabilityId?: string;
  reconciliationInput?: Record<string, WorkflowGraphReconciliationBinding>;
  compensation?: WorkflowGraphCompensationDefinition;
}
export interface WorkflowGraphScriptNode extends WorkflowGraphNodeBase {
  kind: 'script';
  scriptRef: string;
  compensation?: WorkflowGraphCompensationDefinition;
}
export interface WorkflowGraphChildWorkflowNode extends WorkflowGraphNodeBase {
  kind: 'workflow';
  workflowId: string;
  compensation?: WorkflowGraphCompensationDefinition;
}
export interface WorkflowGraphBranchNode extends WorkflowGraphNodeBase {
  kind: 'branch';
}
export interface WorkflowGraphJoinNode extends WorkflowGraphNodeBase {
  kind: 'join';
  policy: 'all' | 'any' | 'quorum';
  quorum?: number;
}
export interface WorkflowGraphWaitEventNode extends WorkflowGraphNodeBase {
  kind: 'wait_event';
  sources: string[];
  eventTypes?: string[];
  correlation: WorkflowGraphBinding;
}
export interface WorkflowGraphApprovalNode extends WorkflowGraphNodeBase {
  kind: 'approval';
  approvalKey: string;
  prompt: string;
}

export type WorkflowGraphNode =
  | WorkflowGraphCapabilityNode
  | WorkflowGraphScriptNode
  | WorkflowGraphChildWorkflowNode
  | WorkflowGraphBranchNode
  | WorkflowGraphJoinNode
  | WorkflowGraphWaitEventNode
  | WorkflowGraphApprovalNode;

export interface WorkflowGraphEdge {
  edgeId: string;
  from: string;
  to: string;
  on: 'success' | 'failure' | 'timeout' | 'condition' | 'default';
  condition?: WorkflowGraphCondition;
}

export interface WorkflowGraphAssetDefinition {
  schemaVersion: typeof WORKFLOW_GRAPH_SCHEMA_VERSION;
  workflowId: string;
  version: string;
  title?: string;
  description?: string;
  inputContract?: Record<string, WorkflowInputContract>;
  entryNodeId: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  scripts?: Record<string, WorkflowDeterministicScript>;
  failurePolicy?: { mode: 'fail' | 'compensate' };
  contentDigest: string;
}

export type WorkflowGraphAssetDraft = Omit<WorkflowGraphAssetDefinition, 'contentDigest'>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireId(value: unknown, code: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(code);
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}
function assertJson(value: unknown, depth = 0): asserts value is WorkflowJsonValue {
  if (depth > 24) throw new Error('WORKFLOW_GRAPH_JSON_DEPTH_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (!record(value)) throw new Error('WORKFLOW_GRAPH_JSON_INVALID');
  for (const entry of Object.values(value)) assertJson(entry, depth + 1);
}

function validateBinding(value: unknown): WorkflowGraphBinding {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('WORKFLOW_GRAPH_BINDING_INVALID');
  if (value.kind === 'literal') {
    assertJson(value.value);
    return { kind: 'literal', value: structuredClone(value.value) };
  }
  if (value.kind === 'input')
    return { kind: 'input', name: requireId(value.name, 'WORKFLOW_GRAPH_INPUT_BINDING_INVALID') };
  if (value.kind === 'output') {
    return {
      kind: 'output',
      nodeId: requireId(value.nodeId, 'WORKFLOW_GRAPH_OUTPUT_NODE_INVALID'),
      field: requireId(value.field, 'WORKFLOW_GRAPH_OUTPUT_FIELD_INVALID'),
    };
  }
  throw new Error('WORKFLOW_GRAPH_BINDING_KIND_INVALID');
}

function validateReconciliationBinding(value: unknown): WorkflowGraphReconciliationBinding {
  if (record(value) && value.kind === 'effect_request_id') {
    if (Object.keys(value).some((key) => key !== 'kind'))
      throw new Error('WORKFLOW_GRAPH_RECONCILIATION_BINDING_FIELD_UNSUPPORTED');
    return { kind: 'effect_request_id' };
  }
  return validateBinding(value);
}

function validateReconciliationInput(value: unknown): Record<string, WorkflowGraphReconciliationBinding> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length > 64) throw new Error('WORKFLOW_GRAPH_RECONCILIATION_INPUT_INVALID');
  return Object.fromEntries(
    Object.entries(value).map(([key, binding]) => [
      requireId(key, 'WORKFLOW_GRAPH_RECONCILIATION_INPUT_KEY_INVALID'),
      validateReconciliationBinding(binding),
    ]),
  );
}

function validateCondition(value: unknown, depth = 0): WorkflowGraphCondition {
  if (depth > 12 || !record(value) || typeof value.kind !== 'string')
    throw new Error('WORKFLOW_GRAPH_CONDITION_INVALID');
  if (value.kind === 'all' || value.kind === 'any') {
    if (!Array.isArray(value.conditions) || value.conditions.length < 1 || value.conditions.length > 32)
      throw new Error('WORKFLOW_GRAPH_CONDITION_GROUP_INVALID');
    return { kind: value.kind, conditions: value.conditions.map((item) => validateCondition(item, depth + 1)) };
  }
  if (value.kind === 'not') return { kind: 'not', condition: validateCondition(value.condition, depth + 1) };
  if (value.kind !== 'compare') throw new Error('WORKFLOW_GRAPH_CONDITION_KIND_INVALID');
  const operator = String(value.operator);
  if (!['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'].includes(operator))
    throw new Error('WORKFLOW_GRAPH_CONDITION_OPERATOR_INVALID');
  const left = validateBinding(value.left);
  if (operator === 'exists') {
    if (value.right !== undefined) throw new Error('WORKFLOW_GRAPH_EXISTS_RIGHT_UNSUPPORTED');
    return { kind: 'compare', operator: 'exists', left };
  }
  if (value.right === undefined) throw new Error('WORKFLOW_GRAPH_CONDITION_RIGHT_REQUIRED');
  return {
    kind: 'compare',
    operator: operator as Extract<WorkflowGraphCondition, { kind: 'compare' }>['operator'],
    left,
    right: validateBinding(value.right),
  };
}

function validateRetry(value: unknown): WorkflowGraphRetryPolicy | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('WORKFLOW_GRAPH_RETRY_INVALID');
  const maxAttempts = Number(value.maxAttempts);
  const initialDelayMs = Number(value.initialDelayMs);
  const maxDelayMs = Number(value.maxDelayMs);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
    throw new Error('WORKFLOW_GRAPH_RETRY_ATTEMPTS_INVALID');
  if (value.strategy !== 'fixed' && value.strategy !== 'exponential')
    throw new Error('WORKFLOW_GRAPH_RETRY_STRATEGY_INVALID');
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 3_600_000)
    throw new Error('WORKFLOW_GRAPH_RETRY_DELAY_INVALID');
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs || maxDelayMs > 86_400_000)
    throw new Error('WORKFLOW_GRAPH_RETRY_MAX_DELAY_INVALID');
  if (!Array.isArray(value.retryOn) || value.retryOn.length < 1 || value.retryOn.length > 4)
    throw new Error('WORKFLOW_GRAPH_RETRY_CLASSES_INVALID');
  const allowed = new Set(['failed', 'timeout', 'rate_limited', 'unavailable']);
  if (
    value.retryOn.some((entry) => typeof entry !== 'string' || !allowed.has(entry)) ||
    new Set(value.retryOn).size !== value.retryOn.length
  )
    throw new Error('WORKFLOW_GRAPH_RETRY_CLASSES_INVALID');
  return {
    maxAttempts,
    strategy: value.strategy,
    initialDelayMs,
    maxDelayMs,
    retryOn: [...value.retryOn] as WorkflowGraphRetryPolicy['retryOn'],
  };
}

function validateBindingMap(value: unknown, code: string): Record<string, WorkflowGraphBinding> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length > 64) throw new Error(code);
  return Object.fromEntries(
    Object.entries(value).map(([key, binding]) => [
      requireId(key, 'WORKFLOW_GRAPH_COMPENSATION_INPUT_KEY_INVALID'),
      validateBinding(binding),
    ]),
  );
}

function validateCompensation(
  value: unknown,
  asset: WorkflowGraphAssetDefinition,
): WorkflowGraphCompensationDefinition | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || typeof value.kind !== 'string') throw new Error('WORKFLOW_GRAPH_COMPENSATION_INVALID');
  const input = validateBindingMap(value.input, 'WORKFLOW_GRAPH_COMPENSATION_INPUT_INVALID');
  if (value.kind === 'capability') {
    const capabilityId = requireId(value.capabilityId, 'WORKFLOW_GRAPH_COMPENSATION_CAPABILITY_ID_INVALID');
    const idempotency = value.idempotency === undefined ? undefined : value.idempotency;
    if (idempotency !== undefined && idempotency !== 'idempotent' && idempotency !== 'non_idempotent')
      throw new Error('WORKFLOW_GRAPH_COMPENSATION_IDEMPOTENCY_INVALID');
    const reconcileWithCapabilityId =
      value.reconcileWithCapabilityId === undefined
        ? undefined
        : requireId(value.reconcileWithCapabilityId, 'WORKFLOW_GRAPH_COMPENSATION_RECONCILE_INVALID');
    if (idempotency === 'non_idempotent' && !reconcileWithCapabilityId)
      throw new Error('WORKFLOW_GRAPH_COMPENSATION_RECONCILIATION_REQUIRED');
    const reconciliationInput = validateReconciliationInput(value.reconciliationInput);
    if (reconciliationInput && !reconcileWithCapabilityId)
      throw new Error('WORKFLOW_GRAPH_COMPENSATION_RECONCILIATION_INPUT_REQUIRES_CAPABILITY');
    return {
      kind: 'capability',
      capabilityId,
      ...(input ? { input } : {}),
      ...(idempotency ? { idempotency } : {}),
      ...(reconcileWithCapabilityId ? { reconcileWithCapabilityId } : {}),
      ...(reconciliationInput ? { reconciliationInput } : {}),
    };
  }
  if (value.kind === 'script') {
    const scriptRef = requireId(value.scriptRef, 'WORKFLOW_GRAPH_COMPENSATION_SCRIPT_REF_INVALID');
    if (!asset.scripts?.[scriptRef]) throw new Error('WORKFLOW_GRAPH_COMPENSATION_SCRIPT_REF_MISSING:' + scriptRef);
    return { kind: 'script', scriptRef, ...(input ? { input } : {}) };
  }
  if (value.kind === 'workflow') {
    const workflowId = requireId(value.workflowId, 'WORKFLOW_GRAPH_COMPENSATION_WORKFLOW_ID_INVALID');
    if (workflowId === asset.workflowId) throw new Error('WORKFLOW_GRAPH_COMPENSATION_SELF_WORKFLOW_FORBIDDEN');
    return { kind: 'workflow', workflowId, ...(input ? { input } : {}) };
  }
  throw new Error('WORKFLOW_GRAPH_COMPENSATION_KIND_INVALID');
}

function validateBase(
  value: Record<string, unknown>,
): Pick<WorkflowGraphNodeBase, 'nodeId' | 'input' | 'timeoutMs' | 'retry'> {
  const nodeId = requireId(value.nodeId, 'WORKFLOW_GRAPH_NODE_ID_INVALID');
  let input: Record<string, WorkflowGraphBinding> | undefined;
  if (value.input !== undefined) {
    if (!record(value.input) || Object.keys(value.input).length > 64)
      throw new Error('WORKFLOW_GRAPH_NODE_INPUT_INVALID');
    input = Object.fromEntries(
      Object.entries(value.input).map(([key, binding]) => [
        requireId(key, 'WORKFLOW_GRAPH_NODE_INPUT_KEY_INVALID'),
        validateBinding(binding),
      ]),
    );
  }
  let timeoutMs: number | undefined;
  if (value.timeoutMs !== undefined) {
    timeoutMs = Number(value.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 7 * 24 * 60 * 60 * 1000)
      throw new Error('WORKFLOW_GRAPH_NODE_TIMEOUT_INVALID');
  }
  const retry = validateRetry(value.retry);
  return {
    nodeId,
    ...(input ? { input } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(retry ? { retry } : {}),
  };
}

function validateNode(value: unknown, asset: WorkflowGraphAssetDefinition): WorkflowGraphNode {
  if (!record(value) || typeof value.kind !== 'string') throw new Error('WORKFLOW_GRAPH_NODE_INVALID');
  const base = validateBase(value);
  if (value.kind === 'capability') {
    const capabilityId = requireId(value.capabilityId, 'WORKFLOW_GRAPH_CAPABILITY_ID_INVALID');
    const idempotency = value.idempotency === undefined ? undefined : value.idempotency;
    if (idempotency !== undefined && idempotency !== 'idempotent' && idempotency !== 'non_idempotent')
      throw new Error('WORKFLOW_GRAPH_IDEMPOTENCY_INVALID');
    const reconcileWithCapabilityId =
      value.reconcileWithCapabilityId === undefined
        ? undefined
        : requireId(value.reconcileWithCapabilityId, 'WORKFLOW_GRAPH_RECONCILE_CAPABILITY_INVALID');
    if (idempotency === 'non_idempotent' && !reconcileWithCapabilityId)
      throw new Error('WORKFLOW_GRAPH_NON_IDEMPOTENT_RECONCILIATION_REQUIRED');
    const reconciliationInput = validateReconciliationInput(value.reconciliationInput);
    if (reconciliationInput && !reconcileWithCapabilityId)
      throw new Error('WORKFLOW_GRAPH_RECONCILIATION_INPUT_REQUIRES_CAPABILITY');
    const compensation = validateCompensation(value.compensation, asset);
    return {
      ...base,
      kind: 'capability',
      capabilityId,
      ...(idempotency ? { idempotency } : {}),
      ...(reconcileWithCapabilityId ? { reconcileWithCapabilityId } : {}),
      ...(reconciliationInput ? { reconciliationInput } : {}),
      ...(compensation ? { compensation } : {}),
    };
  }
  if (value.kind === 'script') {
    if (base.retry && base.retry.maxAttempts > 1) throw new Error('WORKFLOW_GRAPH_SCRIPT_RETRY_UNSUPPORTED');
    const scriptRef = requireId(value.scriptRef, 'WORKFLOW_GRAPH_SCRIPT_REF_INVALID');
    if (!asset.scripts?.[scriptRef]) throw new Error('WORKFLOW_GRAPH_SCRIPT_REF_MISSING:' + scriptRef);
    const compensation = validateCompensation(value.compensation, asset);
    return { ...base, kind: 'script', scriptRef, ...(compensation ? { compensation } : {}) };
  }
  if (value.kind === 'workflow') {
    const workflowId = requireId(value.workflowId, 'WORKFLOW_GRAPH_CHILD_WORKFLOW_ID_INVALID');
    if (workflowId === asset.workflowId) throw new Error('WORKFLOW_GRAPH_SELF_CHILD_FORBIDDEN');
    const compensation = validateCompensation(value.compensation, asset);
    return { ...base, kind: 'workflow', workflowId, ...(compensation ? { compensation } : {}) };
  }
  if (value.kind === 'branch') {
    if (base.retry) throw new Error('WORKFLOW_GRAPH_CONTROL_RETRY_UNSUPPORTED');
    return { ...base, kind: 'branch' };
  }
  if (value.kind === 'join') {
    if (base.retry) throw new Error('WORKFLOW_GRAPH_CONTROL_RETRY_UNSUPPORTED');
    if (value.policy !== 'all' && value.policy !== 'any' && value.policy !== 'quorum')
      throw new Error('WORKFLOW_GRAPH_JOIN_POLICY_INVALID');
    const quorum = value.quorum === undefined ? undefined : Number(value.quorum);
    if (value.policy === 'quorum' && (!Number.isSafeInteger(quorum) || quorum! < 1))
      throw new Error('WORKFLOW_GRAPH_JOIN_QUORUM_INVALID');
    if (value.policy !== 'quorum' && quorum !== undefined) throw new Error('WORKFLOW_GRAPH_JOIN_QUORUM_UNEXPECTED');
    return { ...base, kind: 'join', policy: value.policy, ...(quorum === undefined ? {} : { quorum }) };
  }
  if (value.kind === 'wait_event') {
    if (base.retry) throw new Error('WORKFLOW_GRAPH_CONTROL_RETRY_UNSUPPORTED');
    if (
      !Array.isArray(value.sources) ||
      value.sources.length < 1 ||
      value.sources.some((entry) => typeof entry !== 'string' || !ID.test(entry))
    )
      throw new Error('WORKFLOW_GRAPH_WAIT_SOURCES_INVALID');
    const eventTypes = value.eventTypes === undefined ? undefined : value.eventTypes;
    if (
      eventTypes !== undefined &&
      (!Array.isArray(eventTypes) ||
        eventTypes.length < 1 ||
        eventTypes.some((entry) => typeof entry !== 'string' || !ID.test(entry)))
    )
      throw new Error('WORKFLOW_GRAPH_WAIT_EVENT_TYPES_INVALID');
    if (base.timeoutMs === undefined) throw new Error('WORKFLOW_GRAPH_WAIT_TIMEOUT_REQUIRED');
    return {
      ...base,
      kind: 'wait_event',
      sources: [...value.sources] as string[],
      ...(eventTypes ? { eventTypes: [...eventTypes] as string[] } : {}),
      correlation: validateBinding(value.correlation),
    };
  }
  if (value.kind === 'approval') {
    if (base.retry) throw new Error('WORKFLOW_GRAPH_CONTROL_RETRY_UNSUPPORTED');
    const approvalKey = requireId(value.approvalKey, 'WORKFLOW_GRAPH_APPROVAL_KEY_INVALID');
    if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 2000)
      throw new Error('WORKFLOW_GRAPH_APPROVAL_PROMPT_INVALID');
    if (base.timeoutMs === undefined) throw new Error('WORKFLOW_GRAPH_APPROVAL_TIMEOUT_REQUIRED');
    return { ...base, kind: 'approval', approvalKey, prompt: value.prompt };
  }
  throw new Error('WORKFLOW_GRAPH_NODE_KIND_INVALID');
}

function validateEdge(value: unknown): WorkflowGraphEdge {
  if (!record(value)) throw new Error('WORKFLOW_GRAPH_EDGE_INVALID');
  const edgeId = requireId(value.edgeId, 'WORKFLOW_GRAPH_EDGE_ID_INVALID');
  const from = requireId(value.from, 'WORKFLOW_GRAPH_EDGE_FROM_INVALID');
  const to = requireId(value.to, 'WORKFLOW_GRAPH_EDGE_TO_INVALID');
  if (!['success', 'failure', 'timeout', 'condition', 'default'].includes(String(value.on)))
    throw new Error('WORKFLOW_GRAPH_EDGE_OUTCOME_INVALID');
  if (value.on === 'condition') {
    if (value.condition === undefined) throw new Error('WORKFLOW_GRAPH_EDGE_CONDITION_REQUIRED');
    return { edgeId, from, to, on: 'condition', condition: validateCondition(value.condition) };
  }
  if (value.condition !== undefined) throw new Error('WORKFLOW_GRAPH_EDGE_CONDITION_UNEXPECTED');
  return { edgeId, from, to, on: value.on as Exclude<WorkflowGraphEdge['on'], 'condition'> };
}

function validateTopology(asset: WorkflowGraphAssetDefinition): void {
  const byId = new Map(asset.nodes.map((node) => [node.nodeId, node] as const));
  if (!byId.has(asset.entryNodeId)) throw new Error('WORKFLOW_GRAPH_ENTRY_NODE_MISSING');
  const edgeIds = new Set<string>();
  const outgoing = new Map<string, WorkflowGraphEdge[]>();
  const incoming = new Map<string, WorkflowGraphEdge[]>();
  for (const edge of asset.edges) {
    if (edgeIds.has(edge.edgeId)) throw new Error('WORKFLOW_GRAPH_EDGE_DUPLICATE:' + edge.edgeId);
    edgeIds.add(edge.edgeId);
    if (!byId.has(edge.from) || !byId.has(edge.to)) throw new Error('WORKFLOW_GRAPH_EDGE_DANGLING:' + edge.edgeId);
    if (edge.from === edge.to) throw new Error('WORKFLOW_GRAPH_SELF_EDGE_FORBIDDEN:' + edge.edgeId);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }
  for (const node of asset.nodes) {
    const outs = outgoing.get(node.nodeId) ?? [];
    const ins = incoming.get(node.nodeId) ?? [];
    if (node.nodeId === asset.entryNodeId && ins.length > 0) throw new Error('WORKFLOW_GRAPH_ENTRY_INCOMING_FORBIDDEN');
    if (node.nodeId !== asset.entryNodeId && node.kind !== 'join' && ins.length !== 1)
      throw new Error('WORKFLOW_GRAPH_NON_JOIN_INCOMING_INVALID:' + node.nodeId);
    if (node.kind === 'branch') {
      if (
        outs.length < 2 ||
        outs.filter((edge) => edge.on === 'default').length !== 1 ||
        outs.some((edge) => edge.on !== 'condition' && edge.on !== 'default')
      )
        throw new Error('WORKFLOW_GRAPH_BRANCH_EDGES_INVALID:' + node.nodeId);
    } else if (outs.some((edge) => edge.on === 'condition' || edge.on === 'default')) {
      throw new Error('WORKFLOW_GRAPH_CONDITION_EDGE_FROM_NON_BRANCH:' + node.nodeId);
    }
    if (node.kind === 'join') {
      if (ins.length < 2) throw new Error('WORKFLOW_GRAPH_JOIN_INPUTS_INSUFFICIENT:' + node.nodeId);
      if (node.policy === 'quorum' && node.quorum! > ins.length)
        throw new Error('WORKFLOW_GRAPH_JOIN_QUORUM_EXCEEDS_INPUTS:' + node.nodeId);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (nodeId: string): void => {
    if (visiting.has(nodeId)) throw new Error('WORKFLOW_GRAPH_CYCLE_FORBIDDEN:' + nodeId);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) walk(edge.to);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  walk(asset.entryNodeId);
  const unreachable = asset.nodes.map((node) => node.nodeId).filter((nodeId) => !visited.has(nodeId));
  if (unreachable.length > 0) throw new Error('WORKFLOW_GRAPH_NODE_UNREACHABLE:' + unreachable.sort().join(','));
}

export function workflowGraphContentDigest(asset: WorkflowGraphAssetDraft | WorkflowGraphAssetDefinition): string {
  const { contentDigest: _ignored, ...content } = asset as WorkflowGraphAssetDefinition;
  return `${WORKFLOW_GRAPH_DIGEST_PREFIX}${createHash('sha256')
    .update(JSON.stringify(canonical(content)))
    .digest('hex')}`;
}

export function validateWorkflowGraphAsset(asset: WorkflowGraphAssetDefinition): WorkflowGraphAssetDefinition {
  if (asset.schemaVersion !== WORKFLOW_GRAPH_SCHEMA_VERSION)
    throw new Error('WORKFLOW_GRAPH_SCHEMA_VERSION_UNSUPPORTED');
  requireId(asset.workflowId, 'WORKFLOW_GRAPH_WORKFLOW_ID_INVALID');
  requireId(asset.version, 'WORKFLOW_GRAPH_VERSION_INVALID', VERSION);
  requireId(asset.entryNodeId, 'WORKFLOW_GRAPH_ENTRY_NODE_INVALID');
  if (!DIGEST.test(asset.contentDigest) || workflowGraphContentDigest(asset) !== asset.contentDigest)
    throw new Error('WORKFLOW_GRAPH_CONTENT_DIGEST_INVALID');
  if (!Array.isArray(asset.nodes) || asset.nodes.length < 1 || asset.nodes.length > 256)
    throw new Error('WORKFLOW_GRAPH_NODES_INVALID');
  if (!Array.isArray(asset.edges) || asset.edges.length > 1024) throw new Error('WORKFLOW_GRAPH_EDGES_INVALID');
  if (
    asset.failurePolicy !== undefined &&
    asset.failurePolicy.mode !== 'fail' &&
    asset.failurePolicy.mode !== 'compensate'
  )
    throw new Error('WORKFLOW_GRAPH_FAILURE_POLICY_INVALID');
  const nodeIds = new Set<string>();
  asset.nodes = asset.nodes.map((node) => {
    const validated = validateNode(node, asset);
    if (nodeIds.has(validated.nodeId)) throw new Error('WORKFLOW_GRAPH_NODE_DUPLICATE:' + validated.nodeId);
    nodeIds.add(validated.nodeId);
    return validated;
  });
  asset.edges = asset.edges.map(validateEdge);
  for (const [name, contract] of Object.entries(asset.inputContract ?? {})) {
    requireId(name, 'WORKFLOW_GRAPH_INPUT_CONTRACT_KEY_INVALID');
    if (!contract || !['string', 'number', 'boolean', 'json'].includes(contract.type))
      throw new Error('WORKFLOW_GRAPH_INPUT_CONTRACT_INVALID:' + name);
  }
  for (const [name, script] of Object.entries(asset.scripts ?? {})) {
    requireId(name, 'WORKFLOW_GRAPH_SCRIPT_KEY_INVALID');
    if (
      !script ||
      script.deterministic !== true ||
      !['shell', 'node', 'python'].includes(script.runtime) ||
      typeof script.body !== 'string'
    )
      throw new Error('WORKFLOW_GRAPH_SCRIPT_INVALID:' + name);
  }
  validateTopology(asset);
  return asset;
}

export function materializeWorkflowGraphAsset(draft: WorkflowGraphAssetDraft): WorkflowGraphAssetDefinition {
  const asset = {
    ...structuredClone(draft),
    contentDigest: workflowGraphContentDigest(draft),
  } as WorkflowGraphAssetDefinition;
  return validateWorkflowGraphAsset(asset);
}
