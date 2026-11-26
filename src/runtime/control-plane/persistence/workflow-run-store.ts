import { createHash } from 'crypto';
import type {
  WorkflowCheckpoint,
  WorkflowJsonValue,
  WorkflowStepReceipt,
  WorkflowPublicationReceipt,
  WorkflowGraphCheckpoint,
  WorkflowGraphRunStatus,
} from '../../../../packages/workflow-runtime/api/index';
import {
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
  type ControlPlaneRecord,
} from './sqlite-store';
import { assertControlPlaneMetadataPayload } from './metadata-payload-policy';
import type {
  WorkflowCapabilityBinding,
  WorkflowRegistryEntry,
  WorkflowRegistryScope,
} from './workflow-registry-store';

export const WORKFLOW_RUN_NAMESPACE = 'workflow_run';
const SCHEMA_VERSION = 1 as const;
const MAX_RECEIPTS = 128;

export interface WorkflowRunRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  scopeId: string;
  runId: string;
  workflowId: string;
  version: string;
  contentDigest: string;
  inputDigest: string;
  evidenceRef: string;
  status: WorkflowCheckpoint['status'];
  nextStepIndex: number;
  receipts: WorkflowStepReceipt[];
  reconcileStepId?: string;
  reconcileWithCapabilityId?: string;
  updatedAt: string;
  outputs: Record<string, Record<string, unknown>>;
  inFlightStepId?: string;
  publicationReceipt?: WorkflowPublicationReceipt;
}

function bounded(value: string, code: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) throw new Error(code);
  return trimmed;
}

function workflowRunScopeId(value: Pick<WorkflowRunRecord, 'scopeId'>): string {
  return bounded(value.scopeId, 'WORKFLOW_RUN_SCOPE_ID_INVALID');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function workflowInputDigest(inputs: Record<string, WorkflowJsonValue> = {}): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(inputs)))
    .digest('hex')}`;
}

function evidenceContent(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function workflowRunEvidenceRef(value: Omit<WorkflowRunRecord, 'evidenceRef'> | WorkflowRunRecord): string {
  const { evidenceRef: _ignored, ...content } = value as WorkflowRunRecord;
  return `workflow-run-${createHash('sha256').update(evidenceContent(content)).digest('hex')}`;
}

function validRecord(value: WorkflowRunRecord): WorkflowRunRecord {
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('WORKFLOW_RUN_SCHEMA_VERSION_UNSUPPORTED');
  workflowRunScopeId(value);
  bounded(value.runId, 'WORKFLOW_RUN_ID_INVALID');
  bounded(value.workflowId, 'WORKFLOW_RUN_WORKFLOW_ID_INVALID');
  bounded(value.version, 'WORKFLOW_RUN_VERSION_INVALID');
  bounded(value.contentDigest, 'WORKFLOW_RUN_CONTENT_DIGEST_INVALID');
  bounded(value.inputDigest, 'WORKFLOW_RUN_INPUT_DIGEST_INVALID');
  bounded(value.evidenceRef, 'WORKFLOW_RUN_EVIDENCE_REF_INVALID');
  if (workflowRunEvidenceRef(value) !== value.evidenceRef) throw new Error('WORKFLOW_RUN_EVIDENCE_REF_MISMATCH');
  if (!['running', 'reconcile_required', 'failed', 'succeeded'].includes(value.status))
    throw new Error('WORKFLOW_RUN_STATUS_INVALID');
  if (!Number.isInteger(value.nextStepIndex) || value.nextStepIndex < 0)
    throw new Error('WORKFLOW_RUN_NEXT_STEP_INVALID');
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS)
    throw new Error('WORKFLOW_RUN_RECEIPTS_INVALID');
  if (!Number.isFinite(Date.parse(value.updatedAt))) throw new Error('WORKFLOW_RUN_UPDATED_AT_INVALID');
  assertControlPlaneMetadataPayload(value, 'workflow_run', 256 * 1024);
  return value;
}

export function readWorkflowRun(
  controllerHome: string,
  scopeId: string,
  runId: string,
): ControlPlaneRecord<WorkflowRunRecord> | undefined {
  const record = readControlPlaneRecord<WorkflowRunRecord>(
    controllerHome,
    WORKFLOW_RUN_NAMESPACE,
    bounded(scopeId, 'WORKFLOW_RUN_SCOPE_ID_INVALID'),
    bounded(runId, 'WORKFLOW_RUN_ID_INVALID'),
  );
  if (!record) return undefined;
  validRecord(record.value);
  return record;
}

export function writeWorkflowRunCheckpoint(input: {
  controllerHome: string;
  checkpoint: WorkflowCheckpoint;
  inputs?: Record<string, WorkflowJsonValue>;
  expectedRevision?: number | null;
  now?: Date;
}): ControlPlaneRecord<WorkflowRunRecord> {
  if (input.checkpoint.receipts.length > MAX_RECEIPTS) throw new Error('WORKFLOW_RUN_RECEIPT_BUDGET_EXCEEDED');
  const content: Omit<WorkflowRunRecord, 'evidenceRef'> = {
    schemaVersion: SCHEMA_VERSION,
    scopeId: input.checkpoint.binding.scopeId,
    runId: input.checkpoint.binding.runId,
    workflowId: input.checkpoint.workflowId,
    version: input.checkpoint.version,
    contentDigest: input.checkpoint.contentDigest,
    inputDigest: workflowInputDigest(input.inputs),
    status: input.checkpoint.status,
    nextStepIndex: input.checkpoint.nextStepIndex,
    receipts: input.checkpoint.receipts.map((receipt) => ({ ...receipt })),
    reconcileStepId: input.checkpoint.reconcileStepId,
    reconcileWithCapabilityId: input.checkpoint.reconcileWithCapabilityId,
    updatedAt: (input.now ?? new Date()).toISOString(),
    outputs: input.checkpoint.outputs,
    inFlightStepId: input.checkpoint.inFlightStepId,
    publicationReceipt: input.checkpoint.publicationReceipt,
  };
  const value: WorkflowRunRecord = { ...content, evidenceRef: workflowRunEvidenceRef(content) };
  validRecord(value);
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: WORKFLOW_RUN_NAMESPACE,
    scope: workflowRunScopeId(value),
    key: value.runId,
    schemaVersion: SCHEMA_VERSION,
    value,
    action: `workflow_run_${value.status}`,
    expectedRevision: input.expectedRevision,
  });
}

export interface WorkflowRunExecutionSnapshot {
  repositoryId: string;
  checkoutId: string;
  registryScope: WorkflowRegistryScope;
  contentLocation: WorkflowRegistryEntry['contentLocation'];
  bindings: WorkflowCapabilityBinding[];
  capabilityGrantRefs: string[];
  approvalContext?: {
    sessionId: string;
    principalId: string;
    permissionSnapshotVersion: number;
  };
}

function validWorkflowRunExecutionSnapshot(value: WorkflowRunExecutionSnapshot): WorkflowRunExecutionSnapshot {
  bounded(value.repositoryId, 'WORKFLOW_RUN_REPOSITORY_ID_INVALID');
  bounded(value.checkoutId, 'WORKFLOW_RUN_CHECKOUT_ID_INVALID');
  if (value.registryScope.kind === 'project') bounded(value.registryScope.projectId, 'WORKFLOW_RUN_PROJECT_ID_INVALID');
  else if (value.registryScope.kind !== 'controller') throw new Error('WORKFLOW_RUN_REGISTRY_SCOPE_INVALID');
  if (value.contentLocation.kind !== 'controller' && value.contentLocation.kind !== 'project')
    throw new Error('WORKFLOW_RUN_CONTENT_LOCATION_KIND_INVALID');
  bounded(value.contentLocation.path, 'WORKFLOW_RUN_CONTENT_LOCATION_INVALID');
  if (value.contentLocation.kind === 'project')
    bounded(value.contentLocation.projectId ?? '', 'WORKFLOW_RUN_CONTENT_LOCATION_PROJECT_ID_INVALID');
  if (!Array.isArray(value.bindings) || value.bindings.length > 256) throw new Error('WORKFLOW_RUN_BINDINGS_INVALID');
  const seenCapabilities = new Set<string>();
  for (const binding of value.bindings) {
    const capabilityId = bounded(binding.capabilityId, 'WORKFLOW_RUN_BINDING_CAPABILITY_ID_INVALID');
    if (seenCapabilities.has(capabilityId)) throw new Error('WORKFLOW_RUN_BINDING_CAPABILITY_DUPLICATE');
    seenCapabilities.add(capabilityId);
    if (binding.providerId !== undefined) bounded(binding.providerId, 'WORKFLOW_RUN_BINDING_PROVIDER_ID_INVALID');
    if (binding.integrationId !== undefined)
      bounded(binding.integrationId, 'WORKFLOW_RUN_BINDING_INTEGRATION_ID_INVALID');
    if (binding.pluginId !== undefined) bounded(binding.pluginId, 'WORKFLOW_RUN_BINDING_PLUGIN_ID_INVALID');
    if (binding.actionId !== undefined) bounded(binding.actionId, 'WORKFLOW_RUN_BINDING_ACTION_ID_INVALID');
    if (binding.providerId && binding.integrationId)
      throw new Error('WORKFLOW_RUN_BINDING_PROVIDER_INTEGRATION_CONFLICT');
    if (Boolean(binding.pluginId) !== Boolean(binding.actionId))
      throw new Error('WORKFLOW_RUN_BINDING_PLUGIN_ACTION_PAIR_REQUIRED');
  }
  if (!Array.isArray(value.capabilityGrantRefs) || value.capabilityGrantRefs.length > 256)
    throw new Error('WORKFLOW_RUN_GRANT_REFS_INVALID');
  for (const ref of value.capabilityGrantRefs) bounded(ref, 'WORKFLOW_RUN_GRANT_REF_INVALID');
  if (value.approvalContext) {
    bounded(value.approvalContext.sessionId, 'WORKFLOW_RUN_APPROVAL_SESSION_INVALID');
    bounded(value.approvalContext.principalId, 'WORKFLOW_RUN_APPROVAL_PRINCIPAL_INVALID');
    if (
      !Number.isSafeInteger(value.approvalContext.permissionSnapshotVersion) ||
      value.approvalContext.permissionSnapshotVersion < 0
    )
      throw new Error('WORKFLOW_RUN_APPROVAL_PERMISSION_SNAPSHOT_INVALID');
  }
  return value;
}

export interface WorkflowGraphRunRecord {
  schemaVersion: 2;
  scopeId: string;
  runId: string;
  workflowId: string;
  version: string;
  contentDigest: string;
  inputDigest: string;
  inputs: Record<string, WorkflowJsonValue>;
  execution: WorkflowRunExecutionSnapshot;
  evidenceRef: string;
  status: WorkflowGraphRunStatus;
  nodes: WorkflowGraphCheckpoint['nodes'];
  edges: WorkflowGraphCheckpoint['edges'];
  updatedAt: string;
}

function workflowGraphRunEvidenceRef(
  value: Omit<WorkflowGraphRunRecord, 'evidenceRef'> | WorkflowGraphRunRecord,
): string {
  const content = { ...value } as Record<string, unknown>;
  delete content.evidenceRef;
  return `workflow-run-${createHash('sha256').update(evidenceContent(content)).digest('hex')}`;
}

function validGraphRecord(value: WorkflowGraphRunRecord): WorkflowGraphRunRecord {
  if (value.schemaVersion !== 2) throw new Error('WORKFLOW_GRAPH_RUN_SCHEMA_VERSION_UNSUPPORTED');
  workflowRunScopeId(value);
  bounded(value.runId, 'WORKFLOW_RUN_ID_INVALID');
  bounded(value.workflowId, 'WORKFLOW_RUN_WORKFLOW_ID_INVALID');
  bounded(value.version, 'WORKFLOW_RUN_VERSION_INVALID');
  bounded(value.contentDigest, 'WORKFLOW_RUN_CONTENT_DIGEST_INVALID');
  bounded(value.inputDigest, 'WORKFLOW_RUN_INPUT_DIGEST_INVALID');
  if (!value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs))
    throw new Error('WORKFLOW_GRAPH_RUN_INPUTS_INVALID');
  validWorkflowRunExecutionSnapshot(value.execution);
  bounded(value.evidenceRef, 'WORKFLOW_RUN_EVIDENCE_REF_INVALID');
  if (workflowGraphRunEvidenceRef(value) !== value.evidenceRef) throw new Error('WORKFLOW_RUN_EVIDENCE_REF_MISMATCH');
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
    ].includes(value.status)
  )
    throw new Error('WORKFLOW_GRAPH_RUN_STATUS_INVALID');
  if (!Array.isArray(value.nodes) || value.nodes.length > 256) throw new Error('WORKFLOW_GRAPH_RUN_NODES_INVALID');
  if (!Array.isArray(value.edges) || value.edges.length > 1024) throw new Error('WORKFLOW_GRAPH_RUN_EDGES_INVALID');
  if (!Number.isFinite(Date.parse(value.updatedAt))) throw new Error('WORKFLOW_RUN_UPDATED_AT_INVALID');
  assertControlPlaneMetadataPayload(value, 'workflow_run', 256 * 1024);
  return value;
}

/** Graph v2 shares the canonical workflow_run namespace; it is not a second workflow ledger. */
export function readWorkflowGraphRun(
  controllerHome: string,
  scopeId: string,
  runId: string,
): ControlPlaneRecord<WorkflowGraphRunRecord> | undefined {
  const record = readControlPlaneRecord<WorkflowGraphRunRecord>(
    controllerHome,
    WORKFLOW_RUN_NAMESPACE,
    bounded(scopeId, 'WORKFLOW_RUN_SCOPE_ID_INVALID'),
    bounded(runId, 'WORKFLOW_RUN_ID_INVALID'),
  );
  if (!record) return undefined;
  validGraphRecord(record.value);
  return record;
}

export function writeWorkflowGraphRunCheckpoint(input: {
  controllerHome: string;
  checkpoint: WorkflowGraphCheckpoint;
  inputs?: Record<string, WorkflowJsonValue>;
  execution: WorkflowGraphRunRecord['execution'];
  expectedRevision?: number | null;
  now?: Date;
}): ControlPlaneRecord<WorkflowGraphRunRecord> {
  const content: Omit<WorkflowGraphRunRecord, 'evidenceRef'> = {
    schemaVersion: 2,
    scopeId: input.checkpoint.binding.scopeId,
    runId: input.checkpoint.binding.runId,
    workflowId: input.checkpoint.workflowId,
    version: input.checkpoint.version,
    contentDigest: input.checkpoint.contentDigest,
    inputDigest: workflowInputDigest(input.inputs),
    inputs: structuredClone(input.inputs ?? {}),
    execution: structuredClone(input.execution),
    status: input.checkpoint.status,
    nodes: structuredClone(input.checkpoint.nodes),
    edges: structuredClone(input.checkpoint.edges),
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  const value: WorkflowGraphRunRecord = { ...content, evidenceRef: workflowGraphRunEvidenceRef(content) };
  validGraphRecord(value);
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: WORKFLOW_RUN_NAMESPACE,
    scope: workflowRunScopeId(value),
    key: value.runId,
    schemaVersion: 2,
    value,
    action: `workflow_graph_run_${value.status}`,
    expectedRevision: input.expectedRevision,
  });
}

export function listWorkflowGraphRuns(
  controllerHome: string,
  input: { status?: WorkflowGraphRunStatus; limit?: number } = {},
): ControlPlaneRecord<WorkflowGraphRunRecord>[] {
  const records = listControlPlaneRecords<WorkflowGraphRunRecord>(controllerHome, {
    namespace: WORKFLOW_RUN_NAMESPACE,
    limit: Math.max(1, Math.min(Math.trunc(input.limit ?? 1000), 5000)),
  });
  const graphRuns: ControlPlaneRecord<WorkflowGraphRunRecord>[] = [];
  for (const record of records) {
    if (record.schemaVersion !== 2 || record.value?.schemaVersion !== 2) continue;
    validGraphRecord(record.value);
    if (input.status && record.value.status !== input.status) continue;
    graphRuns.push(record);
  }
  return graphRuns;
}
