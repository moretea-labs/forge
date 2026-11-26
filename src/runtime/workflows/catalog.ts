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
import { readWorkflowExecutableContentFile } from '../control-plane/persistence/workflow-content-store';
import {
  listWorkflowRegistryEntries,
  readWorkflowRegistryEntry,
  workflowRegistryEngine,
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
