import {
  sameWorkflowContentIdentity,
  workflowFeatureContentIdentity,
  workflowFeatureEngine,
  type WorkflowAssetDefinition,
  type WorkflowContentIdentity,
  type WorkflowExecutableAssetDefinition,
  type WorkflowFeatureEngine,
} from '../../../../packages/workflow-runtime/api/index';
import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from './sqlite-store';

export const WORKFLOW_REGISTRY_NAMESPACE = 'workflow_registry';
const SCHEMA_VERSION = 1 as const;

export type WorkflowRegistryScope = { kind: 'controller' } | { kind: 'project'; projectId: string };

export interface WorkflowCapabilityBinding {
  capabilityId: string;
  providerId?: string;
  integrationId?: string;
  /** Concrete existing typed action target. Workflow Runtime does not own plugin authorization. */
  pluginId?: string;
  actionId?: string;
}

export interface WorkflowRegistryEntry extends WorkflowContentIdentity {
  schemaVersion: typeof SCHEMA_VERSION;
  scope: WorkflowRegistryScope;
  status: 'installed' | 'active' | 'inactive';
  contentLocation: { kind: 'controller' | 'project'; path: string; projectId?: string };
  capabilityGrantRefs: string[];
  bindings: WorkflowCapabilityBinding[];
  executionReceiptReuseRefs: string[];
  /** Missing on historical v1 entries; treat absence as sequence_v1. */
  engine?: WorkflowFeatureEngine;
  updatedAt: string;
}

function registryScopeKey(scope: WorkflowRegistryScope): string {
  if (scope.kind === 'controller') return '__controller__';
  if (!scope.projectId.trim() || scope.projectId.length > 128) throw new Error('WORKFLOW_REGISTRY_PROJECT_ID_INVALID');
  return `project:${scope.projectId}`;
}

function boundedRef(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) throw new Error(`WORKFLOW_REGISTRY_${label}_INVALID`);
  return trimmed;
}

function validateBinding(binding: WorkflowCapabilityBinding): WorkflowCapabilityBinding {
  const capabilityId = boundedRef(binding.capabilityId, 'CAPABILITY_ID');
  const providerId = binding.providerId === undefined ? undefined : boundedRef(binding.providerId, 'PROVIDER_ID');
  const integrationId =
    binding.integrationId === undefined ? undefined : boundedRef(binding.integrationId, 'INTEGRATION_ID');
  const pluginId = binding.pluginId === undefined ? undefined : boundedRef(binding.pluginId, 'PLUGIN_ID');
  const actionId = binding.actionId === undefined ? undefined : boundedRef(binding.actionId, 'ACTION_ID');
  if (providerId && integrationId) throw new Error('WORKFLOW_REGISTRY_BINDING_PROVIDER_INTEGRATION_CONFLICT');
  if (Boolean(pluginId) !== Boolean(actionId)) throw new Error('WORKFLOW_REGISTRY_BINDING_PLUGIN_ACTION_PAIR_REQUIRED');
  return { capabilityId, providerId, integrationId, pluginId, actionId };
}

function validateBindings(bindings: WorkflowCapabilityBinding[]): WorkflowCapabilityBinding[] {
  const seenCapabilities = new Set<string>();
  return bindings.map((binding) => {
    const validated = validateBinding(binding);
    if (seenCapabilities.has(validated.capabilityId)) {
      throw new Error(`WORKFLOW_REGISTRY_BINDING_CAPABILITY_DUPLICATE: ${validated.capabilityId}`);
    }
    seenCapabilities.add(validated.capabilityId);
    return validated;
  });
}

function validateEntry(value: WorkflowRegistryEntry): WorkflowRegistryEntry {
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('WORKFLOW_REGISTRY_SCHEMA_VERSION_UNSUPPORTED');
  boundedRef(value.workflowId, 'WORKFLOW_ID');
  boundedRef(value.version, 'VERSION');
  boundedRef(value.contentDigest, 'CONTENT_DIGEST');
  boundedRef(value.contentLocation.path, 'CONTENT_LOCATION');
  if (!['installed', 'active', 'inactive'].includes(value.status)) throw new Error('WORKFLOW_REGISTRY_STATUS_INVALID');
  if (value.engine !== undefined && value.engine !== 'sequence_v1' && value.engine !== 'graph_v2')
    throw new Error('WORKFLOW_REGISTRY_ENGINE_INVALID');
  if (
    !Array.isArray(value.capabilityGrantRefs) ||
    !Array.isArray(value.bindings) ||
    !Array.isArray(value.executionReceiptReuseRefs)
  ) {
    throw new Error('WORKFLOW_REGISTRY_MACHINE_STATE_INVALID');
  }
  for (const ref of value.capabilityGrantRefs) boundedRef(ref, 'GRANT_REF');
  for (const ref of value.executionReceiptReuseRefs) boundedRef(ref, 'RECEIPT_REF');
  validateBindings(value.bindings);
  if (!Number.isFinite(Date.parse(value.updatedAt))) throw new Error('WORKFLOW_REGISTRY_UPDATED_AT_INVALID');
  return value;
}

export function readWorkflowRegistryEntry(
  controllerHome: string,
  scope: WorkflowRegistryScope,
  workflowId: string,
): ControlPlaneRecord<WorkflowRegistryEntry> | undefined {
  const record = readControlPlaneRecord<WorkflowRegistryEntry>(
    controllerHome,
    WORKFLOW_REGISTRY_NAMESPACE,
    registryScopeKey(scope),
    workflowId,
  );
  if (!record) return undefined;
  validateEntry(record.value);
  return record;
}

export function listWorkflowRegistryEntries(
  controllerHome: string,
  scope: WorkflowRegistryScope,
): ControlPlaneRecord<WorkflowRegistryEntry>[] {
  const records = listControlPlaneRecords<WorkflowRegistryEntry>(controllerHome, {
    namespace: WORKFLOW_REGISTRY_NAMESPACE,
    scope: registryScopeKey(scope),
  });
  for (const record of records) validateEntry(record.value);
  return records;
}

export function registerWorkflowFeatureAsset(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  asset: WorkflowExecutableAssetDefinition;
  contentLocation: WorkflowRegistryEntry['contentLocation'];
  status?: WorkflowRegistryEntry['status'];
  expectedRevision?: number | null;
  now?: Date;
}): ControlPlaneRecord<WorkflowRegistryEntry> {
  const identity = workflowFeatureContentIdentity(input.asset);
  const existing = readWorkflowRegistryEntry(input.controllerHome, input.scope, identity.workflowId);
  const sameIdentity = existing ? sameWorkflowContentIdentity(existing.value, identity) : false;
  const entry: WorkflowRegistryEntry = {
    schemaVersion: SCHEMA_VERSION,
    scope: input.scope,
    ...identity,
    status: input.status ?? existing?.value.status ?? 'installed',
    contentLocation: input.contentLocation,
    capabilityGrantRefs: sameIdentity ? [...existing!.value.capabilityGrantRefs] : [],
    bindings: sameIdentity ? validateBindings(existing!.value.bindings).map((binding) => ({ ...binding })) : [],
    executionReceiptReuseRefs: sameIdentity ? [...existing!.value.executionReceiptReuseRefs] : [],
    engine: workflowFeatureEngine(input.asset),
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: WORKFLOW_REGISTRY_NAMESPACE,
    scope: registryScopeKey(input.scope),
    key: identity.workflowId,
    schemaVersion: SCHEMA_VERSION,
    value: entry,
    action: sameIdentity
      ? 'workflow_registry_refresh'
      : existing
        ? 'workflow_registry_content_identity_changed'
        : 'workflow_registry_install',
    expectedRevision: input.expectedRevision,
  });
}

export function registerWorkflowAsset(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  asset: WorkflowAssetDefinition;
  contentLocation: WorkflowRegistryEntry['contentLocation'];
  status?: WorkflowRegistryEntry['status'];
  expectedRevision?: number | null;
  now?: Date;
}): ControlPlaneRecord<WorkflowRegistryEntry> {
  return registerWorkflowFeatureAsset(input);
}

export function workflowRegistryEngine(entry: WorkflowRegistryEntry): WorkflowFeatureEngine {
  return entry.engine ?? 'sequence_v1';
}

export function setWorkflowRegistryStatus(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  workflowId: string;
  status: WorkflowRegistryEntry['status'];
  expectedRevision?: number;
  now?: Date;
}): ControlPlaneRecord<WorkflowRegistryEntry> {
  const existing = readWorkflowRegistryEntry(input.controllerHome, input.scope, input.workflowId);
  if (!existing) throw new Error('WORKFLOW_REGISTRY_ENTRY_REQUIRED');
  if (!['installed', 'active', 'inactive'].includes(input.status)) throw new Error('WORKFLOW_REGISTRY_STATUS_INVALID');
  const entry: WorkflowRegistryEntry = {
    ...existing.value,
    status: input.status,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: WORKFLOW_REGISTRY_NAMESPACE,
    scope: registryScopeKey(input.scope),
    key: input.workflowId,
    schemaVersion: SCHEMA_VERSION,
    value: entry,
    action: `workflow_registry_${input.status}`,
    expectedRevision: input.expectedRevision ?? existing.revision,
  });
}

export function recordWorkflowBindings(input: {
  controllerHome: string;
  scope: WorkflowRegistryScope;
  expectedIdentity: WorkflowContentIdentity;
  capabilityGrantRefs?: string[];
  bindings?: WorkflowCapabilityBinding[];
  executionReceiptReuseRefs?: string[];
  expectedRevision?: number;
  now?: Date;
}): ControlPlaneRecord<WorkflowRegistryEntry> {
  const existing = readWorkflowRegistryEntry(input.controllerHome, input.scope, input.expectedIdentity.workflowId);
  if (!existing) throw new Error('WORKFLOW_REGISTRY_ENTRY_REQUIRED');
  if (!sameWorkflowContentIdentity(existing.value, input.expectedIdentity)) {
    throw new Error('WORKFLOW_REGISTRY_CONTENT_IDENTITY_CHANGED');
  }
  const entry: WorkflowRegistryEntry = {
    ...existing.value,
    capabilityGrantRefs: (input.capabilityGrantRefs ?? existing.value.capabilityGrantRefs).map((ref) =>
      boundedRef(ref, 'GRANT_REF'),
    ),
    bindings: validateBindings(input.bindings ?? existing.value.bindings),
    executionReceiptReuseRefs: (input.executionReceiptReuseRefs ?? existing.value.executionReceiptReuseRefs).map(
      (ref) => boundedRef(ref, 'RECEIPT_REF'),
    ),
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: WORKFLOW_REGISTRY_NAMESPACE,
    scope: registryScopeKey(input.scope),
    key: input.expectedIdentity.workflowId,
    schemaVersion: SCHEMA_VERSION,
    value: entry,
    action: 'workflow_registry_bindings_update',
    expectedRevision: input.expectedRevision ?? existing.revision,
  });
}
