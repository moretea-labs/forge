import { createHash } from 'crypto';
import {
  validateWorkflowAsset,
  type WorkflowAssetDefinition,
  type WorkflowDeterministicScript,
  type WorkflowJsonValue,
  type WorkflowStepDefinition,
  type WorkflowPublicationReceipt,
} from '../domain/workflow-asset';

export interface WorkflowRunBinding {
  workId: string;
  runId: string;
}

export interface WorkflowStepExecutionResult {
  outcome: 'succeeded' | 'failed' | 'outcome_unknown';
  receiptRef?: string;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface WorkflowStepReceipt {
  stepId: string;
  outcome: WorkflowStepExecutionResult['outcome'];
  receiptRef?: string;
  recordedAt: string;
}

export interface WorkflowCheckpoint {
  schemaVersion: 1;
  binding: WorkflowRunBinding;
  workflowId: string;
  version: string;
  contentDigest: string;
  status: 'running' | 'reconcile_required' | 'failed' | 'succeeded';
  nextStepIndex: number;
  receipts: WorkflowStepReceipt[];
  reconcileStepId?: string;
  reconcileWithCapabilityId?: string;
  outputs: Record<string, Record<string, unknown>>;
  publicationReceipt?: WorkflowPublicationReceipt;
  /** Written before dispatch; restart must consult the effect owner before replay. */
  inFlightStepId?: string;
}

export interface WorkflowRuntimePorts {
  executeCapability(input: {
    binding: WorkflowRunBinding;
    asset: WorkflowAssetDefinition;
    step: Extract<WorkflowStepDefinition, { kind?: 'capability' }>;
    arguments: Record<string, WorkflowJsonValue>;
  }): Promise<WorkflowStepExecutionResult>;
  executeScript(input: {
    binding: WorkflowRunBinding;
    asset: WorkflowAssetDefinition;
    step: Extract<WorkflowStepDefinition, { kind: 'script' }>;
    script: WorkflowDeterministicScript;
    arguments: Record<string, WorkflowJsonValue>;
  }): Promise<WorkflowStepExecutionResult>;
  /** Revalidate retained success against the canonical effect/process authority. Checkpoints never self-authenticate. */
  validateRetainedStep?(input: {
    binding: WorkflowRunBinding;
    asset: WorkflowAssetDefinition;
    step: WorkflowStepDefinition;
    receipt: WorkflowStepReceipt;
    output: Record<string, unknown>;
  }): Promise<void> | void;
  checkpoint?(checkpoint: WorkflowCheckpoint): Promise<void> | void;
  now?: () => Date;
}

export interface ExecuteWorkflowInput {
  asset: WorkflowAssetDefinition;
  binding: WorkflowRunBinding;
  inputs?: Record<string, WorkflowJsonValue>;
  startStepIndex?: number;
  retainedReceipts?: WorkflowStepReceipt[];
  retainedOutputs?: Record<string, Record<string, unknown>>;
}

export type WorkflowRunResult = WorkflowCheckpoint & { outputs: Record<string, Record<string, unknown>> };

function requiredText(value: string, code: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) throw new Error(code);
  return trimmed;
}

/** Reject lossy JSON coercions (NaN, getters, Date, undefined, cycles) before checkpointing. */
function assertJsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 32) throw new Error('WORKFLOW_JSON_DEPTH_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('WORKFLOW_JSON_VALUE_INVALID');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('WORKFLOW_JSON_VALUE_INVALID');
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) throw new Error('WORKFLOW_JSON_VALUE_INVALID');
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('WORKFLOW_JSON_VALUE_INVALID');
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('WORKFLOW_JSON_VALUE_INVALID');
    assertJsonValue(descriptor.value, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

export function validateWorkflowRunInputs(
  asset: WorkflowAssetDefinition,
  provided: Record<string, WorkflowJsonValue> = {},
): Record<string, WorkflowJsonValue> {
  assertJsonValue(provided);
  const contract = asset.inputContract ?? {};
  const unknown = Object.keys(provided).filter((key) => !Object.prototype.hasOwnProperty.call(contract, key));
  if (unknown.length > 0) throw new Error(`WORKFLOW_INPUT_UNKNOWN: ${unknown.sort().join(',')}`);
  const resolved: Record<string, WorkflowJsonValue> = {};
  for (const [name, definition] of Object.entries(contract)) {
    const value = Object.hasOwn(provided, name) ? provided[name] : definition.default;
    if (value === undefined) {
      if (definition.required) throw new Error(`WORKFLOW_INPUT_REQUIRED: ${name}`);
      continue;
    }
    const valid = definition.type === 'json'
      || (definition.type === 'string' && typeof value === 'string')
      || (definition.type === 'number' && typeof value === 'number' && Number.isFinite(value))
      || (definition.type === 'boolean' && typeof value === 'boolean');
    if (!valid) throw new Error(`WORKFLOW_INPUT_TYPE_MISMATCH: ${name}:${definition.type}`);
    assertJsonValue(value);
    resolved[name] = value;
  }
  return resolved;
}

function refValue(asset: WorkflowAssetDefinition, inputs: Record<string, WorkflowJsonValue>, namespace: string, key: string): WorkflowJsonValue | undefined {
  if (namespace === 'input') return inputs[key];
  if (namespace === 'prompt') return asset.prompts?.[key];
  if (namespace === 'template') return asset.templates?.[key];
  if (namespace === 'selector') return asset.selectors?.[key];
  if (namespace === 'resource') return asset.resources?.[key];
  return undefined;
}

function resolveString(asset: WorkflowAssetDefinition, inputs: Record<string, WorkflowJsonValue>, source: string): WorkflowJsonValue {
  const exact = source.match(/^\{\{(input|prompt|template|selector|resource)\.([A-Za-z0-9._-]+)\}\}$/);
  if (exact) {
    const value = refValue(asset, inputs, exact[1]!, exact[2]!);
    if (value === undefined) throw new Error(`WORKFLOW_REFERENCE_MISSING: ${exact[1]}.${exact[2]}`);
    return value;
  }
  return source.replace(/\{\{(input|prompt|template|selector|resource)\.([A-Za-z0-9._-]+)\}\}/g, (_match, namespace, key) => {
    const value = refValue(asset, inputs, namespace, key);
    if (value === undefined) throw new Error(`WORKFLOW_REFERENCE_MISSING: ${namespace}.${key}`);
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export function resolveWorkflowValue(
  asset: WorkflowAssetDefinition,
  inputs: Record<string, WorkflowJsonValue>,
  value: WorkflowJsonValue,
  outputs: Record<string, Record<string, unknown>> = {},
): WorkflowJsonValue {
  if (typeof value === 'string') {
    const reference = value.match(/^\{\{output\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}\}$/);
    if (reference) {
      const output = outputs[reference[1]!];
      if (!output || !Object.hasOwn(output, reference[2]!)) throw new Error(`WORKFLOW_OUTPUT_REFERENCE_MISSING: ${reference[1]}.${reference[2]}`);
      return output[reference[2]!] as WorkflowJsonValue;
    }
    if (value.includes('{{output.')) throw new Error('WORKFLOW_OUTPUT_REFERENCE_MUST_BE_EXACT');
    return resolveString(asset, inputs, value);
  }
  if (Array.isArray(value)) return value.map((entry) => resolveWorkflowValue(asset, inputs, entry, outputs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveWorkflowValue(asset, inputs, entry, outputs)]));
  }
  return value;
}

function resolvedArguments(
  asset: WorkflowAssetDefinition,
  inputs: Record<string, WorkflowJsonValue>,
  step: WorkflowStepDefinition,
  outputs: Record<string, Record<string, unknown>>,
): Record<string, WorkflowJsonValue> {
  return Object.fromEntries(Object.entries(step.input ?? {}).map(([key, value]) => [key, resolveWorkflowValue(asset, inputs, value, outputs)]));
}

export function retainWorkflowOutput(step: WorkflowStepDefinition, output: Record<string, unknown> = {}): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const [key, contract] of Object.entries(step.outputContract ?? {})) {
    const value = Object.hasOwn(output, key) ? output[key] : undefined;
    if (value === undefined && !contract.required) continue;
    if (value === undefined || contract.type !== 'json' && (typeof value !== contract.type || contract.type === 'number' && !Number.isFinite(value))) throw new Error(`WORKFLOW_OUTPUT_TYPE_MISMATCH: ${step.stepId}.${key}`);
    assertJsonValue(value);
    selected[key] = value;
  }
  const encoded = JSON.stringify(selected);
  if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024) throw new Error('WORKFLOW_OUTPUT_BYTE_LIMIT');
  return JSON.parse(encoded) as Record<string, unknown>;
}


function publicationOutput(outputs: Record<string, Record<string, unknown>>, ref: { stepId: string; field: string }, label: string): string {
  const value = outputs[ref.stepId]?.[ref.field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`WORKFLOW_PUBLICATION_${label}_MISSING`);
  return value.trim();
}

export function buildWorkflowPublicationReceipt(
  asset: WorkflowAssetDefinition,
  inputs: Record<string, WorkflowJsonValue>,
  checkpoint: Pick<WorkflowCheckpoint, 'status' | 'receipts' | 'outputs'>,
): WorkflowPublicationReceipt | undefined {
  const contract = asset.publication;
  if (!contract) return undefined;
  if (checkpoint.status !== 'succeeded') throw new Error('WORKFLOW_PUBLICATION_WORKFLOW_NOT_SUCCEEDED');
  const account = inputs[contract.accountInput];
  if (typeof account !== 'string' || !account.trim()) throw new Error('WORKFLOW_PUBLICATION_ACCOUNT_MISSING');
  const effect = checkpoint.receipts.find(receipt => receipt.stepId === contract.effectStepId && receipt.outcome === 'succeeded');
  if (!effect?.receiptRef) throw new Error('WORKFLOW_PUBLICATION_EFFECT_RECEIPT_MISSING');
  const verificationEvidenceRefs = contract.verificationStepIds.map((stepId) => {
    const receipt = checkpoint.receipts.find(candidate => candidate.stepId === stepId && candidate.outcome === 'succeeded');
    if (!receipt?.receiptRef) throw new Error(`WORKFLOW_PUBLICATION_VERIFICATION_RECEIPT_MISSING: ${stepId}`);
    return receipt.receiptRef;
  });
  const postUrl = publicationOutput(checkpoint.outputs, contract.postUrlOutput, 'POST_URL');
  const parsed = new URL(postUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('WORKFLOW_PUBLICATION_POST_URL_INVALID');
  const postId = publicationOutput(checkpoint.outputs, contract.postIdOutput, 'POST_ID');
  const contentDigest = publicationOutput(checkpoint.outputs, contract.contentDigestOutput, 'CONTENT_DIGEST');
  if (!/^sha256:[a-f0-9]{64}$/.test(contentDigest)) throw new Error('WORKFLOW_PUBLICATION_CONTENT_DIGEST_INVALID');
  const identity = {
    workflowId: asset.workflowId,
    channel: contract.channel,
    account: account.trim(),
    postId,
    postUrl: parsed.toString(),
    contentDigest,
    publishedAt: effect.recordedAt,
    effectReceiptRef: effect.receiptRef,
    verificationEvidenceRefs,
  };
  return {
    schemaVersion: 1,
    receiptId: `workflow-publication-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    ...identity,
    timeSource: 'effect_receipt_recorded_at',
  };
}

async function persist(ports: WorkflowRuntimePorts, checkpoint: WorkflowCheckpoint): Promise<void> {
  await ports.checkpoint?.(checkpoint);
}

export async function executeWorkflow(
  input: ExecuteWorkflowInput,
  ports: WorkflowRuntimePorts,
): Promise<WorkflowRunResult> {
  const asset = validateWorkflowAsset(input.asset);
  const binding = {
    workId: requiredText(input.binding.workId, 'WORKFLOW_RUN_WORK_ID_REQUIRED'),
    runId: requiredText(input.binding.runId, 'WORKFLOW_RUN_ID_REQUIRED'),
  };
  const inputs = validateWorkflowRunInputs(asset, input.inputs);
  const receipts = [...(input.retainedReceipts ?? [])];
  const outputs: Record<string, Record<string, unknown>> = structuredClone(input.retainedOutputs ?? {});
  const startStepIndex = input.startStepIndex ?? 0;
  if (!Number.isInteger(startStepIndex) || startStepIndex < 0 || startStepIndex > asset.steps.length) throw new Error('WORKFLOW_RUN_START_STEP_INVALID');
  const retainedStepIds = new Set(asset.steps.slice(0, startStepIndex).map(step => step.stepId));
  for (const receipt of receipts) if (!retainedStepIds.has(receipt.stepId)) throw new Error('WORKFLOW_FUTURE_RECEIPT_REFUSED');
  for (let index = 0; index < startStepIndex; index++) {
    const step = asset.steps[index]!;
    const succeeded = receipts.filter(receipt => receipt.stepId === step.stepId && receipt.outcome === 'succeeded');
    if (succeeded.length !== 1 || !succeeded[0]!.receiptRef?.trim()) throw new Error('WORKFLOW_RETAINED_RECEIPT_REQUIRED');
    outputs[step.stepId] = retainWorkflowOutput(step, outputs[step.stepId]);
    await ports.validateRetainedStep?.({ binding, asset, step, receipt: succeeded[0]!, output: outputs[step.stepId]! });
  }
  for (const stepId of Object.keys(outputs)) if (!retainedStepIds.has(stepId)) throw new Error('WORKFLOW_FUTURE_OUTPUT_REFUSED');

  let checkpoint: WorkflowCheckpoint = {
    schemaVersion: 1,
    binding,
    workflowId: asset.workflowId,
    version: asset.version,
    contentDigest: asset.contentDigest,
    status: 'running',
    nextStepIndex: startStepIndex,
    receipts,
    outputs,
  };
  await persist(ports, checkpoint);

  for (let index = startStepIndex; index < asset.steps.length; index += 1) {
    const step = asset.steps[index]!;
    const args = resolvedArguments(asset, inputs, step, outputs);
    checkpoint = { ...checkpoint, inFlightStepId: step.stepId };
    await persist(ports, checkpoint);
    let execution: WorkflowStepExecutionResult;
    try {
      execution = step.kind === 'script'
        ? await ports.executeScript({ binding, asset, step, script: asset.scripts![step.scriptRef]!, arguments: args })
        : await ports.executeCapability({ binding, asset, step, arguments: args });
      if (execution.outcome === 'succeeded') outputs[step.stepId] = retainWorkflowOutput(step, execution.output);
    } catch (error) {
      execution = { outcome: step.idempotency === 'non_idempotent' ? 'outcome_unknown' : 'failed', error: { code: 'WORKFLOW_STEP_INTERRUPTED', message: error instanceof Error ? error.message : String(error) } };
    }
    const receipt: WorkflowStepReceipt = {
      stepId: step.stepId,
      outcome: execution.outcome,
      receiptRef: execution.receiptRef,
      recordedAt: (ports.now?.() ?? new Date()).toISOString(),
    };
    receipts.push(receipt);

    if (execution.outcome === 'outcome_unknown') {
      checkpoint = {
        ...checkpoint,
        status: 'reconcile_required',
        nextStepIndex: index,
        receipts: [...receipts],
        reconcileStepId: step.stepId,
        reconcileWithCapabilityId: step.reconcileWithCapabilityId,
        outputs: structuredClone(outputs),
      };
      await persist(ports, checkpoint);
      return { ...checkpoint, outputs };
    }
    if (execution.outcome === 'failed') {
      checkpoint = { ...checkpoint, status: 'failed', nextStepIndex: index, receipts: [...receipts], inFlightStepId: undefined, outputs: structuredClone(outputs) };
      await persist(ports, checkpoint);
      return { ...checkpoint, outputs };
    }
    checkpoint = { ...checkpoint, status: 'running', nextStepIndex: index + 1, receipts: [...receipts], inFlightStepId: undefined, outputs: structuredClone(outputs) };
    await persist(ports, checkpoint);
  }
  checkpoint = { ...checkpoint, status: 'succeeded', nextStepIndex: asset.steps.length, receipts: [...receipts], outputs: structuredClone(outputs) };
  checkpoint = { ...checkpoint, publicationReceipt: buildWorkflowPublicationReceipt(asset, inputs, checkpoint) };
  await persist(ports, checkpoint);
  return { ...checkpoint, outputs };
}
