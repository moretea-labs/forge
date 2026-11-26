import {
  validateWorkflowAsset,
  workflowCapabilityDependencies,
  type WorkflowAssetDefinition,
  type WorkflowContentIdentity,
  type WorkflowInputContract,
  type WorkflowJsonValue,
} from './workflow-asset';
import { validateWorkflowGraphAsset, type WorkflowGraphAssetDefinition } from './workflow-graph';

export type WorkflowFeatureEngine = 'sequence_v1' | 'graph_v2';
export type WorkflowExecutableAssetDefinition = WorkflowAssetDefinition | WorkflowGraphAssetDefinition;

export interface WorkflowFeatureDescriptorV1 extends WorkflowContentIdentity {
  schemaVersion: 1;
  engine: WorkflowFeatureEngine;
  title?: string;
  description?: string;
  inputContract: Record<string, WorkflowInputContract>;
  capabilityDependencies: string[];
  childWorkflowDependencies: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateWorkflowExecutableAsset(value: unknown): WorkflowExecutableAssetDefinition {
  if (!record(value)) throw new Error('WORKFLOW_FEATURE_ASSET_INVALID');
  if (value.schemaVersion === 1) return validateWorkflowAsset(value as unknown as WorkflowAssetDefinition);
  if (value.schemaVersion === 2) return validateWorkflowGraphAsset(value as unknown as WorkflowGraphAssetDefinition);
  throw new Error('WORKFLOW_FEATURE_SCHEMA_VERSION_UNSUPPORTED');
}

export function workflowFeatureEngine(asset: WorkflowExecutableAssetDefinition): WorkflowFeatureEngine {
  return asset.schemaVersion === 1 ? 'sequence_v1' : 'graph_v2';
}

export function workflowFeatureContentIdentity(asset: WorkflowExecutableAssetDefinition): WorkflowContentIdentity {
  const valid = validateWorkflowExecutableAsset(asset);
  return { workflowId: valid.workflowId, version: valid.version, contentDigest: valid.contentDigest };
}

export function workflowFeatureCapabilityDependencies(asset: WorkflowExecutableAssetDefinition): string[] {
  const valid = validateWorkflowExecutableAsset(asset);
  if (valid.schemaVersion === 1) return workflowCapabilityDependencies(valid);
  const dependencies = new Set<string>();
  for (const node of valid.nodes) {
    if (node.kind === 'capability') {
      dependencies.add(node.capabilityId);
      if (node.reconcileWithCapabilityId) dependencies.add(node.reconcileWithCapabilityId);
    }
    if (node.kind !== 'capability' && node.kind !== 'script' && node.kind !== 'workflow') continue;
    const compensation = node.compensation;
    if (compensation?.kind === 'capability') {
      dependencies.add(compensation.capabilityId);
      if (compensation.reconcileWithCapabilityId) dependencies.add(compensation.reconcileWithCapabilityId);
    }
  }
  return [...dependencies].sort();
}

export function workflowFeatureChildWorkflowDependencies(asset: WorkflowExecutableAssetDefinition): string[] {
  const valid = validateWorkflowExecutableAsset(asset);
  if (valid.schemaVersion === 1) return [];
  return [...new Set(valid.nodes.filter((node) => node.kind === 'workflow').map((node) => node.workflowId))].sort();
}

export function workflowFeatureDescriptor(asset: WorkflowExecutableAssetDefinition): WorkflowFeatureDescriptorV1 {
  const valid = validateWorkflowExecutableAsset(asset);
  return {
    schemaVersion: 1,
    ...workflowFeatureContentIdentity(valid),
    engine: workflowFeatureEngine(valid),
    ...(valid.title ? { title: valid.title } : {}),
    ...(valid.description ? { description: valid.description } : {}),
    inputContract: structuredClone(valid.inputContract ?? {}),
    capabilityDependencies: workflowFeatureCapabilityDependencies(valid),
    childWorkflowDependencies: workflowFeatureChildWorkflowDependencies(valid),
  };
}

function assertJsonValue(value: unknown, depth = 0): asserts value is WorkflowJsonValue {
  if (depth > 32) throw new Error('WORKFLOW_INPUT_JSON_DEPTH_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (!record(value)) throw new Error('WORKFLOW_INPUT_JSON_INVALID');
  for (const entry of Object.values(value)) assertJsonValue(entry, depth + 1);
}

export function validateWorkflowFeatureInputs(
  asset: WorkflowExecutableAssetDefinition,
  provided: Record<string, WorkflowJsonValue> = {},
): Record<string, WorkflowJsonValue> {
  const valid = validateWorkflowExecutableAsset(asset);
  assertJsonValue(provided);
  const contract = valid.inputContract ?? {};
  const unknown = Object.keys(provided).filter((key) => !Object.hasOwn(contract, key));
  if (unknown.length > 0) throw new Error(`WORKFLOW_INPUT_UNKNOWN: ${unknown.sort().join(',')}`);
  const resolved: Record<string, WorkflowJsonValue> = {};
  for (const [name, definition] of Object.entries(contract)) {
    const value = Object.hasOwn(provided, name) ? provided[name] : definition.default;
    if (value === undefined) {
      if (definition.required) throw new Error(`WORKFLOW_INPUT_REQUIRED: ${name}`);
      continue;
    }
    const validType =
      definition.type === 'json' ||
      (definition.type === 'string' && typeof value === 'string') ||
      (definition.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (definition.type === 'boolean' && typeof value === 'boolean');
    if (!validType) throw new Error(`WORKFLOW_INPUT_TYPE_MISMATCH: ${name}:${definition.type}`);
    assertJsonValue(value);
    resolved[name] = structuredClone(value);
  }
  return resolved;
}
