import { createHash } from 'crypto';

export const WORKFLOW_ASSET_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_CONTENT_DIGEST_PREFIX = 'sha256:' as const;

export type WorkflowJsonValue = null | boolean | number | string | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };

export interface WorkflowCredentialReference {
  /** Existing credential authority reference. Never inline a secret value here. */
  credentialRef: string;
}

export interface WorkflowDeterministicScript {
  runtime: 'shell' | 'node' | 'python';
  body: string;
  deterministic: true;
  /** Declares how Process stdout is decoded. It is not replay or side-effect authority. */
  outputFormat?: 'text' | 'json';
}

export interface WorkflowInputContract {
  type: 'string' | 'number' | 'boolean' | 'json';
  required?: boolean;
  default?: WorkflowJsonValue;
}

interface WorkflowStepBase {
  stepId: string;
  input?: Record<string, WorkflowJsonValue>;
  idempotency?: 'idempotent' | 'non_idempotent';
  reconcileWithCapabilityId?: string;
  /** Optional read/observation arguments for the declared reconciliation capability. */
  reconciliationInput?: Record<string, WorkflowJsonValue>;
  /** Declared fields are the only outputs retained or available to later steps. */
  outputContract?: Record<string, WorkflowInputContract>;
}

export interface WorkflowCapabilityStepDefinition extends WorkflowStepBase {
  kind?: 'capability';
  capabilityId: string;
}

export interface WorkflowScriptStepDefinition extends WorkflowStepBase {
  kind: 'script';
  scriptRef: string;
}

export type WorkflowStepDefinition = WorkflowCapabilityStepDefinition | WorkflowScriptStepDefinition;

export interface WorkflowPublicationContract {
  channel: string;
  accountInput: string;
  effectStepId: string;
  contentDigestOutput: { stepId: string; field: string };
  postIdOutput: { stepId: string; field: string };
  postUrlOutput: { stepId: string; field: string };
  verificationStepIds: string[];
}

export interface WorkflowPublicationReceipt {
  schemaVersion: 1;
  receiptId: string;
  workflowId: string;
  channel: string;
  account: string;
  postId: string;
  postUrl: string;
  contentDigest: string;
  publishedAt: string;
  timeSource: 'effect_receipt_recorded_at';
  effectReceiptRef: string;
  verificationEvidenceRefs: string[];
}

export interface WorkflowAssetDefinition {
  schemaVersion: typeof WORKFLOW_ASSET_SCHEMA_VERSION;
  workflowId: string;
  version: string;
  title?: string;
  description?: string;
  inputs?: Record<string, WorkflowJsonValue>;
  inputContract?: Record<string, WorkflowInputContract>;
  credentialRefs?: Record<string, WorkflowCredentialReference>;
  requiredCapabilities?: string[];
  steps: WorkflowStepDefinition[];
  prompts?: Record<string, string>;
  scripts?: Record<string, WorkflowDeterministicScript>;
  templates?: Record<string, string>;
  selectors?: Record<string, string>;
  resources?: Record<string, string>;
  publication?: WorkflowPublicationContract;
  contentDigest: string;
}

export type WorkflowAssetDraft = Omit<WorkflowAssetDefinition, 'contentDigest'>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function requireBoundedId(value: string, label: string, pattern = ID_PATTERN): void {
  if (!pattern.test(value)) throw new Error(`WORKFLOW_ASSET_${label.toUpperCase()}_INVALID: ${value}`);
}

function requireRecordStrings(value: Record<string, string> | undefined, label: string): void {
  if (!value) return;
  for (const [key, entry] of Object.entries(value)) {
    requireBoundedId(key, `${label}_key`);
    if (typeof entry !== 'string') throw new Error(`WORKFLOW_ASSET_${label.toUpperCase()}_VALUE_INVALID: ${key}`);
  }
}

export function workflowAssetContentDigest(asset: WorkflowAssetDraft | WorkflowAssetDefinition): string {
  const { contentDigest: _ignored, ...content } = asset as WorkflowAssetDefinition;
  const json = JSON.stringify(canonical(content));
  return `${WORKFLOW_CONTENT_DIGEST_PREFIX}${createHash('sha256').update(json).digest('hex')}`;
}

export function validateWorkflowAsset(asset: WorkflowAssetDefinition): WorkflowAssetDefinition {
  if (asset.schemaVersion !== WORKFLOW_ASSET_SCHEMA_VERSION) throw new Error('WORKFLOW_ASSET_SCHEMA_VERSION_UNSUPPORTED');
  requireBoundedId(asset.workflowId, 'workflow_id');
  requireBoundedId(asset.version, 'version', VERSION_PATTERN);
  if (!DIGEST_PATTERN.test(asset.contentDigest)) throw new Error('WORKFLOW_ASSET_CONTENT_DIGEST_INVALID');
  if (workflowAssetContentDigest(asset) !== asset.contentDigest) throw new Error('WORKFLOW_ASSET_CONTENT_DIGEST_MISMATCH');
  if (!Array.isArray(asset.steps) || asset.steps.length === 0) throw new Error('WORKFLOW_ASSET_STEPS_REQUIRED');
  if (asset.steps.length > 128) throw new Error('WORKFLOW_ASSET_STEP_LIMIT');

  const stepIds = new Set<string>();
  for (const step of asset.steps) {
    requireBoundedId(step.stepId, 'step_id');
    if (stepIds.has(step.stepId)) throw new Error(`WORKFLOW_ASSET_STEP_DUPLICATE: ${step.stepId}`);
    stepIds.add(step.stepId);
    if (step.kind === 'script') {
      requireBoundedId(step.scriptRef, 'script_ref');
      if (!asset.scripts?.[step.scriptRef]) throw new Error(`WORKFLOW_ASSET_SCRIPT_REFERENCE_MISSING: ${step.scriptRef}`);
      if (step.idempotency === 'non_idempotent') throw new Error(`WORKFLOW_ASSET_SCRIPT_NON_IDEMPOTENT_FORBIDDEN: ${step.stepId}`);
    } else {
      requireBoundedId(step.capabilityId, 'capability_id');
      if (step.idempotency === 'non_idempotent' && !step.reconcileWithCapabilityId) {
        throw new Error(`WORKFLOW_ASSET_NON_IDEMPOTENT_RECONCILIATION_REQUIRED: ${step.stepId}`);
      }
    }
    if (step.reconcileWithCapabilityId) requireBoundedId(step.reconcileWithCapabilityId, 'reconcile_capability_id');
    if (step.reconciliationInput && !step.reconcileWithCapabilityId) throw new Error(`WORKFLOW_ASSET_RECONCILIATION_INPUT_WITHOUT_CAPABILITY: ${step.stepId}`);
    for (const [name, contract] of Object.entries(step.outputContract ?? {})) {
      requireBoundedId(name, 'output_contract_key');
      if (!contract || !['string', 'number', 'boolean', 'json'].includes(contract.type)) throw new Error('WORKFLOW_OUTPUT_CONTRACT_INVALID');
    }
  }

  for (const [name, contract] of Object.entries(asset.inputContract ?? {})) {
    requireBoundedId(name, 'input_contract_key');
    if (!contract || !['string', 'number', 'boolean', 'json'].includes(contract.type)) throw new Error(`WORKFLOW_ASSET_INPUT_CONTRACT_INVALID: ${name}`);
  }
  for (const capabilityId of asset.requiredCapabilities ?? []) requireBoundedId(capabilityId, 'required_capability_id');
  for (const [name, ref] of Object.entries(asset.credentialRefs ?? {})) {
    requireBoundedId(name, 'credential_ref_key');
    if (!ref || typeof ref.credentialRef !== 'string' || !ref.credentialRef.trim() || ref.credentialRef.length > 512) {
      throw new Error(`WORKFLOW_ASSET_CREDENTIAL_REFERENCE_INVALID: ${name}`);
    }
  }
  for (const [name, script] of Object.entries(asset.scripts ?? {})) {
    requireBoundedId(name, 'script_key');
    if (!script || script.deterministic !== true || !['shell', 'node', 'python'].includes(script.runtime) || typeof script.body !== 'string'
      || (script.outputFormat !== undefined && !['text', 'json'].includes(script.outputFormat))) {
      throw new Error(`WORKFLOW_ASSET_SCRIPT_INVALID: ${name}`);
    }
  }
  requireRecordStrings(asset.prompts, 'prompt');
  requireRecordStrings(asset.templates, 'template');
  requireRecordStrings(asset.selectors, 'selector');
  requireRecordStrings(asset.resources, 'resource');
  if (asset.publication) {
    const publication = asset.publication;
    requireBoundedId(publication.channel, 'publication_channel');
    requireBoundedId(publication.accountInput, 'publication_account_input');
    if (!asset.inputContract?.[publication.accountInput]) throw new Error('WORKFLOW_ASSET_PUBLICATION_ACCOUNT_INPUT_MISSING');
    const byId = new Map(asset.steps.map((step, index) => [step.stepId, { step, index }] as const));
    const effect = byId.get(publication.effectStepId);
    if (!effect || effect.step.kind === 'script' || effect.step.idempotency !== 'non_idempotent') throw new Error('WORKFLOW_ASSET_PUBLICATION_EFFECT_STEP_INVALID');
    const refs = [publication.contentDigestOutput, publication.postIdOutput, publication.postUrlOutput];
    for (const ref of refs) {
      const source = byId.get(ref.stepId);
      if (!source || !source.step.outputContract?.[ref.field]) throw new Error('WORKFLOW_ASSET_PUBLICATION_OUTPUT_REF_INVALID');
      if (source.index <= effect.index) throw new Error('WORKFLOW_ASSET_PUBLICATION_OUTPUT_BEFORE_EFFECT');
    }
    if (!Array.isArray(publication.verificationStepIds) || publication.verificationStepIds.length < 1 || publication.verificationStepIds.length > 16) throw new Error('WORKFLOW_ASSET_PUBLICATION_VERIFICATION_INVALID');
    for (const stepId of publication.verificationStepIds) {
      const verification = byId.get(stepId);
      if (!verification || verification.index <= effect.index) throw new Error('WORKFLOW_ASSET_PUBLICATION_VERIFICATION_INVALID');
    }
  }
  return asset;
}

export function materializeWorkflowAsset(draft: WorkflowAssetDraft): WorkflowAssetDefinition {
  const asset: WorkflowAssetDefinition = { ...draft, contentDigest: workflowAssetContentDigest(draft) };
  return validateWorkflowAsset(asset);
}

export interface WorkflowContentIdentity {
  workflowId: string;
  version: string;
  contentDigest: string;
}

export function workflowContentIdentity(asset: WorkflowAssetDefinition): WorkflowContentIdentity {
  validateWorkflowAsset(asset);
  return { workflowId: asset.workflowId, version: asset.version, contentDigest: asset.contentDigest };
}

export function sameWorkflowContentIdentity(left: WorkflowContentIdentity, right: WorkflowContentIdentity): boolean {
  return left.workflowId === right.workflowId && left.version === right.version && left.contentDigest === right.contentDigest;
}
