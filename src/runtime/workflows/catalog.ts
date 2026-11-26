import {
  validateWorkflowFeatureInputs,
  workflowFeatureContentIdentity,
  workflowFeatureDescriptor,
  workflowFeatureEngine,
  type WorkflowFeatureDescriptorV1,
  type WorkflowJsonValue,
} from '../../../packages/workflow-runtime/api/index';
import {
  validateWorkflowInvocationIntent,
  type WorkflowInvocationIntentV1,
  type WorkflowInvocationOriginKind,
} from '../../../packages/workflow-runtime/domain/workflow-invocation';
import type {
  WorkflowGraphCompensationDefinition,
  WorkflowGraphNode,
} from '../../../packages/workflow-runtime/domain/workflow-graph';
import { readWorkflowExecutableContentFile } from '../control-plane/persistence/workflow-content-store';
import {
  listWorkflowRegistryEntries,
  readWorkflowRegistryEntry,
  workflowRegistryEngine,
  type WorkflowCapabilityBinding,
  type WorkflowRegistryEntry,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';

export type { WorkflowInvocationOriginKind } from '../../../packages/workflow-runtime/domain/workflow-invocation';

export interface WorkflowCatalogEntryV1 {
  schemaVersion: 1;
  descriptor: WorkflowFeatureDescriptorV1;
  scope: WorkflowRegistryScope;
  status: WorkflowRegistryEntry['status'];
  missingCapabilityBindings: string[];
  missingChildWorkflows: string[];
  contentLocation: WorkflowRegistryEntry['contentLocation'];
}

function loadCatalogEntry(
  controllerHome: string,
  registry: ReturnType<typeof readWorkflowRegistryEntry> extends infer T ? Exclude<T, undefined> : never,
): WorkflowCatalogEntryV1 {
  const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
  const identity = workflowFeatureContentIdentity(asset);
  if (
    identity.workflowId !== registry.value.workflowId ||
    identity.version !== registry.value.version ||
    identity.contentDigest !== registry.value.contentDigest
  ) {
    throw new Error('WORKFLOW_CATALOG_CONTENT_IDENTITY_MISMATCH');
  }
  if (workflowRegistryEngine(registry.value) !== workflowFeatureEngine(asset)) {
    throw new Error('WORKFLOW_CATALOG_ENGINE_MISMATCH');
  }
  const descriptor = workflowFeatureDescriptor(asset);
  const boundCapabilities = new Set(registry.value.bindings.map((binding) => binding.capabilityId));
  const missingCapabilityBindings = descriptor.capabilityDependencies.filter(
    (capability) => !boundCapabilities.has(capability),
  );
  const missingChildWorkflows = descriptor.childWorkflowDependencies.filter((workflowId) => {
    const child = readWorkflowRegistryEntry(controllerHome, registry.value.scope, workflowId);
    return child?.value.status !== 'active';
  });
  return {
    schemaVersion: 1,
    descriptor,
    scope: registry.value.scope,
    status: registry.value.status,
    missingCapabilityBindings,
    missingChildWorkflows,
    contentLocation: structuredClone(registry.value.contentLocation),
  };
}

export function getWorkflowCatalogEntry(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  workflowId: string,
): WorkflowCatalogEntryV1 | undefined {
  const registry = readWorkflowRegistryEntry(controllerHome, scope, workflowId);
  return registry ? loadCatalogEntry(controllerHome, registry) : undefined;
}

export function listWorkflowCatalog(controllerHome: string, scope: WorkflowRegistryScope): WorkflowCatalogEntryV1[] {
  return listWorkflowRegistryEntries(controllerHome, scope)
    .map((registry) => loadCatalogEntry(controllerHome, registry))
    .sort((left, right) => left.descriptor.workflowId.localeCompare(right.descriptor.workflowId));
}

export interface PrepareWorkflowInvocationInput {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  origin: { kind: WorkflowInvocationOriginKind; id?: string };
  inputs?: Record<string, WorkflowJsonValue>;
}

export interface WorkflowInvocationPlanV1 {
  schemaVersion: 1;
  origin: PrepareWorkflowInvocationInput['origin'];
  workflow: WorkflowFeatureDescriptorV1;
  scope: WorkflowRegistryScope;
  inputs: Record<string, WorkflowJsonValue>;
  readiness: 'ready' | 'blocked';
  blockers: string[];
  authorization: 'not_authorized';
  execution: 'not_executed';
}

/** Public workflow preflight. It discovers and validates a Workflow but never authorizes or executes it. */
export function prepareWorkflowInvocation(input: PrepareWorkflowInvocationInput): WorkflowInvocationPlanV1 {
  const entry = getWorkflowCatalogEntry(input.controllerHome, input.scope, input.workflowId);
  if (!entry) throw new Error('WORKFLOW_CATALOG_ENTRY_NOT_FOUND:' + input.workflowId);
  const asset = readWorkflowExecutableContentFile(entry.contentLocation.path);
  const inputs = validateWorkflowFeatureInputs(asset, input.inputs ?? {});
  const blockers: string[] = [];
  if (entry.status !== 'active') blockers.push('WORKFLOW_NOT_ACTIVE');
  blockers.push(
    ...entry.missingCapabilityBindings.map((capability) => 'WORKFLOW_CAPABILITY_BINDING_MISSING:' + capability),
  );
  blockers.push(...entry.missingChildWorkflows.map((workflowId) => 'WORKFLOW_CHILD_NOT_ACTIVE:' + workflowId));
  return {
    schemaVersion: 1,
    origin: structuredClone(input.origin),
    workflow: entry.descriptor,
    scope: structuredClone(entry.scope),
    inputs,
    readiness: blockers.length === 0 ? 'ready' : 'blocked',
    blockers,
    authorization: 'not_authorized',
    execution: 'not_executed',
  };
}

export interface WorkflowInvocationIntentPlanV1 extends WorkflowInvocationPlanV1 {
  binding: WorkflowInvocationIntentV1['binding'];
}

export interface WorkflowGraphPreviewEffectV1 {
  nodeId: string;
  phase: 'forward' | 'compensation';
  kind: 'capability' | 'workflow';
  capabilityId?: string;
  workflowId?: string;
  idempotency?: 'idempotent' | 'non_idempotent';
  reconcileWithCapabilityId?: string;
  binding?: WorkflowCapabilityBinding;
}

export interface WorkflowGraphPreviewV1 {
  schemaVersion: 1;
  workflow: WorkflowFeatureDescriptorV1;
  scope: WorkflowRegistryScope;
  status: WorkflowRegistryEntry['status'];
  readiness: WorkflowInvocationPlanV1['readiness'];
  blockers: string[];
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  branches: Array<{
    nodeId: string;
    routes: Array<Record<string, unknown>>;
  }>;
  waits: Array<{
    nodeId: string;
    sources: string[];
    eventTypes?: string[];
    correlation: unknown;
    timeoutMs?: number;
  }>;
  approvals: Array<{
    nodeId: string;
    approvalKey: string;
    prompt: string;
    timeoutMs?: number;
  }>;
  potentialExternalEffects: WorkflowGraphPreviewEffectV1[];
  permissions: {
    capabilityDependencies: string[];
    bindings: WorkflowCapabilityBinding[];
    authorization: 'not_authorized';
  };
  execution: 'not_executed';
}

function graphPreviewBinding(
  bindings: WorkflowCapabilityBinding[],
  capabilityId: string,
): WorkflowCapabilityBinding | undefined {
  const binding = bindings.find((candidate) => candidate.capabilityId === capabilityId);
  return binding ? structuredClone(binding) : undefined;
}

function compensationPreviewEffect(
  nodeId: string,
  compensation: WorkflowGraphCompensationDefinition | undefined,
  bindings: WorkflowCapabilityBinding[],
): WorkflowGraphPreviewEffectV1 | undefined {
  if (!compensation || compensation.kind === 'script') return undefined;
  if (compensation.kind === 'workflow') {
    return { nodeId, phase: 'compensation', kind: 'workflow', workflowId: compensation.workflowId };
  }
  return {
    nodeId,
    phase: 'compensation',
    kind: 'capability',
    capabilityId: compensation.capabilityId,
    idempotency: compensation.idempotency ?? 'idempotent',
    ...(compensation.reconcileWithCapabilityId
      ? { reconcileWithCapabilityId: compensation.reconcileWithCapabilityId }
      : {}),
    ...(graphPreviewBinding(bindings, compensation.capabilityId)
      ? { binding: graphPreviewBinding(bindings, compensation.capabilityId) }
      : {}),
  };
}

function graphPreviewEffects(
  node: WorkflowGraphNode,
  bindings: WorkflowCapabilityBinding[],
): WorkflowGraphPreviewEffectV1[] {
  const effects: WorkflowGraphPreviewEffectV1[] = [];
  if (node.kind === 'capability') {
    const binding = graphPreviewBinding(bindings, node.capabilityId);
    effects.push({
      nodeId: node.nodeId,
      phase: 'forward',
      kind: 'capability',
      capabilityId: node.capabilityId,
      idempotency: node.idempotency ?? 'idempotent',
      ...(node.reconcileWithCapabilityId ? { reconcileWithCapabilityId: node.reconcileWithCapabilityId } : {}),
      ...(binding ? { binding } : {}),
    });
  } else if (node.kind === 'workflow') {
    effects.push({ nodeId: node.nodeId, phase: 'forward', kind: 'workflow', workflowId: node.workflowId });
  }
  if (node.kind === 'capability' || node.kind === 'script' || node.kind === 'workflow') {
    const compensation = compensationPreviewEffect(node.nodeId, node.compensation, bindings);
    if (compensation) effects.push(compensation);
  }
  return effects;
}

/**
 * Deterministic Graph v2 preview. It exposes structure/readiness and local
 * binding metadata only; it never authorizes, dispatches, or resolves waits.
 */
export function previewWorkflowGraph(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  inputs?: Record<string, WorkflowJsonValue>;
}): WorkflowGraphPreviewV1 {
  const plan = prepareWorkflowInvocation({
    controllerHome: input.controllerHome,
    scope: input.scope,
    workflowId: input.workflowId,
    origin: { kind: 'system', id: 'workflow-preview' },
    inputs: input.inputs,
  });
  if (plan.workflow.engine !== 'graph_v2') throw new Error('WORKFLOW_GRAPH_PREVIEW_GRAPH_REQUIRED');
  const registry = readWorkflowRegistryEntry(input.controllerHome, input.scope, input.workflowId);
  if (!registry) throw new Error('WORKFLOW_CATALOG_ENTRY_NOT_FOUND:' + input.workflowId);
  const asset = readWorkflowExecutableContentFile(registry.value.contentLocation.path);
  if (asset.schemaVersion !== 2) throw new Error('WORKFLOW_GRAPH_PREVIEW_GRAPH_REQUIRED');
  const bindings = registry.value.bindings.map((binding) => structuredClone(binding));
  return {
    schemaVersion: 1,
    workflow: structuredClone(plan.workflow),
    scope: structuredClone(plan.scope),
    status: registry.value.status,
    readiness: plan.readiness,
    blockers: [...plan.blockers],
    nodes: asset.nodes.map((node) => structuredClone(node) as unknown as Record<string, unknown>),
    edges: asset.edges.map((edge) => structuredClone(edge) as unknown as Record<string, unknown>),
    branches: asset.nodes
      .filter((node) => node.kind === 'branch')
      .map((node) => ({
        nodeId: node.nodeId,
        routes: asset.edges
          .filter((edge) => edge.from === node.nodeId)
          .map((edge) => structuredClone(edge) as unknown as Record<string, unknown>),
      })),
    waits: asset.nodes
      .filter((node) => node.kind === 'wait_event')
      .map((node) => ({
        nodeId: node.nodeId,
        sources: [...node.sources],
        ...(node.eventTypes ? { eventTypes: [...node.eventTypes] } : {}),
        correlation: structuredClone(node.correlation),
        ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
      })),
    approvals: asset.nodes
      .filter((node) => node.kind === 'approval')
      .map((node) => ({
        nodeId: node.nodeId,
        approvalKey: node.approvalKey,
        prompt: node.prompt,
        ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
      })),
    potentialExternalEffects: asset.nodes.flatMap((node) => graphPreviewEffects(node, bindings)),
    permissions: {
      capabilityDependencies: [...plan.workflow.capabilityDependencies],
      bindings,
      authorization: 'not_authorized',
    },
    execution: 'not_executed',
  };
}

/** Canonical Intent preflight shared by direct, Event, Schedule, Skill, Plugin, Model and child Workflow callers. */
export function prepareWorkflowInvocationIntent(
  controllerHome: string,
  value: unknown,
): WorkflowInvocationIntentPlanV1 {
  const intent = validateWorkflowInvocationIntent(value);
  const plan = prepareWorkflowInvocation({
    controllerHome,
    scope: intent.registryScope,
    workflowId: intent.workflowId,
    origin: intent.origin,
    inputs: intent.inputs,
  });
  return { ...plan, binding: structuredClone(intent.binding) };
}
