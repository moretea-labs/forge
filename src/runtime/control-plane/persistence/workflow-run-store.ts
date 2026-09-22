import { createHash } from 'crypto';
import type { WorkflowCheckpoint, WorkflowJsonValue, WorkflowStepReceipt, WorkflowPublicationReceipt } from '../../../../packages/workflow-runtime/api/index';
import { readControlPlaneRecord, writeControlPlaneRecord, type ControlPlaneRecord } from './sqlite-store';
import { assertControlPlaneMetadataPayload } from './metadata-payload-policy';

export const WORKFLOW_RUN_NAMESPACE = 'workflow_run';
const SCHEMA_VERSION = 1 as const;
const MAX_RECEIPTS = 128;

export interface WorkflowRunRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  workId: string;
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

export function workflowInputDigest(inputs: Record<string, WorkflowJsonValue> = {}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(inputs))).digest('hex')}`;
}

function evidenceContent(value: Omit<WorkflowRunRecord, 'evidenceRef'>): string {
  return JSON.stringify(canonical(value));
}

export function workflowRunEvidenceRef(value: Omit<WorkflowRunRecord, 'evidenceRef'> | WorkflowRunRecord): string {
  const { evidenceRef: _ignored, ...content } = value as WorkflowRunRecord;
  return `workflow-run-${createHash('sha256').update(evidenceContent(content)).digest('hex')}`;
}

function validRecord(value: WorkflowRunRecord): WorkflowRunRecord {
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('WORKFLOW_RUN_SCHEMA_VERSION_UNSUPPORTED');
  bounded(value.workId, 'WORKFLOW_RUN_WORK_ID_INVALID');
  bounded(value.runId, 'WORKFLOW_RUN_ID_INVALID');
  bounded(value.workflowId, 'WORKFLOW_RUN_WORKFLOW_ID_INVALID');
  bounded(value.version, 'WORKFLOW_RUN_VERSION_INVALID');
  bounded(value.contentDigest, 'WORKFLOW_RUN_CONTENT_DIGEST_INVALID');
  bounded(value.inputDigest, 'WORKFLOW_RUN_INPUT_DIGEST_INVALID');
  bounded(value.evidenceRef, 'WORKFLOW_RUN_EVIDENCE_REF_INVALID');
  if (workflowRunEvidenceRef(value) !== value.evidenceRef) throw new Error('WORKFLOW_RUN_EVIDENCE_REF_MISMATCH');
  if (!['running', 'reconcile_required', 'failed', 'succeeded'].includes(value.status)) throw new Error('WORKFLOW_RUN_STATUS_INVALID');
  if (!Number.isInteger(value.nextStepIndex) || value.nextStepIndex < 0) throw new Error('WORKFLOW_RUN_NEXT_STEP_INVALID');
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) throw new Error('WORKFLOW_RUN_RECEIPTS_INVALID');
  if (!Number.isFinite(Date.parse(value.updatedAt))) throw new Error('WORKFLOW_RUN_UPDATED_AT_INVALID');
  assertControlPlaneMetadataPayload(value, 'workflow_run', 256 * 1024);
  return value;
}

export function readWorkflowRun(
  controllerHome: string,
  workId: string,
  runId: string,
): ControlPlaneRecord<WorkflowRunRecord> | undefined {
  const record = readControlPlaneRecord<WorkflowRunRecord>(controllerHome, WORKFLOW_RUN_NAMESPACE, bounded(workId, 'WORKFLOW_RUN_WORK_ID_INVALID'), bounded(runId, 'WORKFLOW_RUN_ID_INVALID'));
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
    workId: input.checkpoint.binding.workId,
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
    scope: value.workId,
    key: value.runId,
    schemaVersion: SCHEMA_VERSION,
    value,
    action: `workflow_run_${value.status}`,
    expectedRevision: input.expectedRevision,
  });
}
