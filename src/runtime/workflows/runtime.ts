import { withControllerLock, withControllerLockAsync } from '../../cli/repositories/locks';
import { getWorkContract, isTerminalWorkContractStatus } from '../../../packages/kernel/work/api/index';
import { getControllerSession, getControllerRoundRelay, controllerSessionAuthorityMatches } from '../../../packages/kernel/controller/api/index';
import { readRequirement } from '../control-plane/persistence/requirement-store';
import { createHash } from 'crypto';
import type { RepositoryRecord } from '../../cli/repositories/types';
import type { ResolvedExecutionIdentity } from '../control-plane/execution/execution-identity';
import {
  executeWorkflow,
  workflowContentIdentity,
  type WorkflowJsonValue,
  type WorkflowRuntimePorts,
  type WorkflowRunResult,
  retainWorkflowOutput,
  validateWorkflowRunInputs,
  resolveWorkflowValue,
} from '../../../packages/workflow-runtime/api/index';
import { readWorkflowAssetContentFile } from '../control-plane/persistence/workflow-content-store';
import {
  readWorkflowRegistryEntry,
  type WorkflowCapabilityBinding,
  type WorkflowRegistryScope,
} from '../control-plane/persistence/workflow-registry-store';
import {
  readWorkflowRun,
  workflowInputDigest,
  writeWorkflowRunCheckpoint,
} from '../control-plane/persistence/workflow-run-store';
import {
  submitAssistantPluginAction,
  type PluginActionReceipt,
  readPluginActionReceiptForRequest,
  findPluginActionReceipt,
} from '../plugins/store';
import { isAssistantPluginError } from '../plugins/errors';
import { listControlPlaneRecords } from '../control-plane/persistence/sqlite-store';
import type { WorkflowRunRecord } from '../control-plane/persistence/workflow-run-store';
import {
  executeRepositoryCommandViaProcessRuntime,
  waitRepositoryCommandProcess,
  getRepositoryCommandProcess,
  type RepositoryCommandProcessResult,
} from '../execution/process-runtime/command-facade';
import { getLightweightProcessHandle } from '../execution/process-runtime/lightweight-managed';
import { getProcessRecord, getProcessRequestBinding } from '../execution/process-runtime/store';
import { releaseExecutionLeases } from '../resources/leases/store';

export interface WorkflowRuntimeExecutionDependencies {
  submitPluginAction?: typeof submitAssistantPluginAction;
  executeCommand?: typeof executeRepositoryCommandViaProcessRuntime;
  waitCommand?: typeof waitRepositoryCommandProcess;
}

export interface ExecuteRegisteredWorkflowInput {
  controllerHome: string;
  repository: RepositoryRecord;
  executionIdentity: ResolvedExecutionIdentity;
  workId: string;
  controller: { controllerId: string; authorityId: string };
  runId: string;
  registryScope: WorkflowRegistryScope;
  workflowId: string;
  inputs?: Record<string, WorkflowJsonValue>;
  timeoutMs?: number;
}

function assertWorkflowController(input: ExecuteRegisteredWorkflowInput, reconciliation = false): void {
  const store = { controllerHome: input.controllerHome, repoId: input.repository.repoId };
  const work = getWorkContract(store, input.workId);
  if (!work || isTerminalWorkContractStatus(work.status) || work.supersededBy
    || (!reconciliation && !['open', 'running'].includes(work.status))) throw new Error('WORKFLOW_WORK_NOT_EXECUTABLE');
  if (work.repoId !== input.executionIdentity.repositoryId || work.checkoutId !== input.executionIdentity.checkoutId
    || input.executionIdentity.workId !== work.workId) throw new Error('WORKFLOW_EXECUTION_IDENTITY_MISMATCH');
  if (input.registryScope.kind === 'project' && (work.scopeRef?.kind !== 'project' || work.scopeRef.id !== input.registryScope.projectId)
    && work.engineeringContext?.projectContractReceipt?.projectId !== input.registryScope.projectId) throw new Error('WORKFLOW_PROJECT_MISMATCH');
  const owner = getControllerSession(store, input.workId);
  if (!input.controller || !owner || owner.controllerId !== input.controller.controllerId) throw new Error('WORKFLOW_CONTROLLER_NOT_OWNER');
  const relay = getControllerRoundRelay(store, input.workId);
  if (relay ? relay.status !== 'claimed' || relay.authorityId !== input.controller.authorityId || relay.claimGeneration !== owner.claimGeneration
    : !controllerSessionAuthorityMatches(owner, input.controller.authorityId)) throw new Error('WORKFLOW_CONTROLLER_AUTHORITY_STALE');
  if (!reconciliation && work.requirementId) {
    const requirement = readRequirement({ controllerHome: input.controllerHome }, work.requirementId)?.value;
    if (!requirement || !['planned', 'active'].includes(requirement.state)) throw new Error('WORKFLOW_REQUIREMENT_NOT_ACTIVE');
  }
}

function requestId(input: ExecuteRegisteredWorkflowInput, stepId: string, digest: string): string {
  return `workflow-${createHash('sha256').update(`${input.workId}\0${input.runId}\0${stepId}\0${digest}`).digest('hex').slice(0, 32)}`;
}

function capabilityBinding(bindings: WorkflowCapabilityBinding[], capabilityId: string): WorkflowCapabilityBinding {
  const matches = bindings.filter((binding) => binding.capabilityId === capabilityId);
  if (matches.length === 0) throw new Error(`WORKFLOW_CAPABILITY_BINDING_REQUIRED: ${capabilityId}`);
  if (matches.length > 1) throw new Error(`WORKFLOW_CAPABILITY_BINDING_AMBIGUOUS: ${capabilityId}`);
  const binding = matches[0]!;
  if (!binding.pluginId || !binding.actionId) throw new Error(`WORKFLOW_CAPABILITY_BINDING_EXECUTION_TARGET_REQUIRED: ${capabilityId}`);
  return binding;
}

function pluginOutcome(receipt: PluginActionReceipt, result?: Record<string, unknown>) {
  const outcome = result?.outcome ?? result?.status;
  if (receipt.effectOutcome === 'outcome_unknown' || outcome === 'outcome_unknown') {
    return { outcome: 'outcome_unknown' as const, receiptRef: receipt.receiptId, output: result };
  }
  if (receipt.status === 'failed' || result?.matched === false || result?.verified === false
    || ['failed', 'login_required', 'authentication_required', 'page_changed', 'not_verified', 'generation_required', 'auth_required', 'page_schema_changed', 'publish_unverified', 'verification_pending', 'incompatible'].includes(String(outcome))) {
    return { outcome: 'failed' as const, receiptRef: receipt.receiptId, error: receipt.error };
  }
  return { outcome: 'succeeded' as const, receiptRef: receipt.receiptId, output: result };
}

function scriptOutput(script: { outputFormat?: 'text' | 'json' }, stdout: string): Record<string, unknown> {
  if (script.outputFormat !== 'json') return { stdout };
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('WORKFLOW_SCRIPT_JSON_OUTPUT_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('WORKFLOW_SCRIPT_JSON_OUTPUT_INVALID');
  return parsed as Record<string, unknown>;
}

function scriptCommand(runtime: 'shell' | 'node' | 'python', body: string, args: Record<string, WorkflowJsonValue>): string[] {
  const serialized = JSON.stringify(args);
  if (runtime === 'node') return ['node', '-e', body, serialized];
  if (runtime === 'python') return ['python3', '-c', body, serialized];
  return ['bash', '-lc', body, '--', serialized];
}

async function completedCommandResult(
  input: ExecuteRegisteredWorkflowInput,
  result: RepositoryCommandProcessResult,
  waitCommand: typeof waitRepositoryCommandProcess,
): Promise<{ ok?: boolean; processId?: string; stdout?: string; stderr?: string; timedOut?: boolean; cancelled?: boolean }> {
  if (!result.process || result.process.completed) {
    return {
      ok: result.process?.ok ?? result.ok,
      processId: result.process?.processId,
      stdout: result.process?.stdout ?? result.stdout,
      stderr: result.process?.stderr ?? result.stderr,
      timedOut: result.process?.timedOut,
      cancelled: result.process?.cancelled,
    };
  }
  const terminal = await waitCommand(input.controllerHome, input.repository.repoId, result.process.processId, { timeoutMs: input.timeoutMs ?? 30_000 });
  return {
    ok: terminal.ok,
    processId: terminal.processId,
    stdout: terminal.stdout,
    stderr: terminal.stderr,
    timedOut: terminal.timedOut,
    cancelled: terminal.cancelled,
  };
}

/** Hold the existing Work resource lock across read, dispatch and checkpoint, including distinct run IDs. */
export async function executeRegisteredWorkflow(input: ExecuteRegisteredWorkflowInput, dependencies: WorkflowRuntimeExecutionDependencies = {}): Promise<WorkflowRunResult> {
  assertWorkflowController(input);
  return withControllerLockAsync(input.controllerHome, { scope: 'task', repoId: input.repository.repoId, taskId: `workflow:${input.workId}` },
    `workflow:${input.runId}`, () => executeRegisteredWorkflowLocked(input, dependencies), undefined, 0);
}

async function executeRegisteredWorkflowLocked(
  input: ExecuteRegisteredWorkflowInput,
  dependencies: WorkflowRuntimeExecutionDependencies = {},
): Promise<WorkflowRunResult> {
  if (!input.workId.trim()) throw new Error('WORKFLOW_RUNTIME_WORK_ID_REQUIRED');
  if (!input.runId.trim()) throw new Error('WORKFLOW_RUNTIME_RUN_ID_REQUIRED');
  assertWorkflowController(input);
  const registry = readWorkflowRegistryEntry(input.controllerHome, input.registryScope, input.workflowId);
  if (!registry) throw new Error(`WORKFLOW_REGISTRY_ENTRY_REQUIRED: ${input.workflowId}`);
  if (registry.value.status !== 'active') throw new Error(`WORKFLOW_REGISTRY_ENTRY_NOT_ACTIVE: ${input.workflowId}`);
  const asset = readWorkflowAssetContentFile(registry.value.contentLocation.path);
  const identity = workflowContentIdentity(asset);
  if (identity.workflowId !== registry.value.workflowId
    || identity.version !== registry.value.version
    || identity.contentDigest !== registry.value.contentDigest) {
    throw new Error(`WORKFLOW_REGISTRY_CONTENT_IDENTITY_MISMATCH: ${input.workflowId}`);
  }

  const existing = readWorkflowRun(input.controllerHome, input.workId, input.runId);
  validateWorkflowRunInputs(asset, input.inputs);
  // Run ids are not a way to evade an unresolved effect in the same Work.
  const relatedRuns = listControlPlaneRecords<WorkflowRunRecord>(input.controllerHome, { namespace: 'workflow_run', scope: input.workId, limit: 1000 });
  if (relatedRuns.length >= 1000) throw new Error('WORKFLOW_RUN_HISTORY_LIMIT');
  if (relatedRuns.some(run => run.key !== input.runId && (run.value.status === 'reconcile_required' || run.value.inFlightStepId))) throw new Error('WORKFLOW_WORK_RECONCILIATION_REQUIRED');
  const inputDigest = workflowInputDigest(input.inputs);
  if (existing) {
    if (existing.value.workflowId !== identity.workflowId
      || existing.value.version !== identity.version
      || existing.value.contentDigest !== identity.contentDigest
      || existing.value.inputDigest !== inputDigest) {
      throw new Error('WORKFLOW_RUN_IDENTITY_CONFLICT');
    }
    if (existing.value.status === 'reconcile_required') throw new Error(`WORKFLOW_RUN_RECONCILIATION_REQUIRED: ${existing.value.reconcileStepId ?? 'unknown'}`);
    if (existing.value.inFlightStepId) throw new Error(`WORKFLOW_RUN_RECONCILIATION_REQUIRED: ${existing.value.inFlightStepId}`);
    if (existing.value.status === 'succeeded') throw new Error('WORKFLOW_RUN_ALREADY_SUCCEEDED');
    if (existing.value.status === 'failed') throw new Error('WORKFLOW_RUN_FAILED_RESTART_REQUIRES_NEW_RUN_ID');
  }

  const submitPluginAction = dependencies.submitPluginAction ?? submitAssistantPluginAction;
  const executeCommand = dependencies.executeCommand ?? executeRepositoryCommandViaProcessRuntime;
  const waitCommand = dependencies.waitCommand ?? waitRepositoryCommandProcess;
  let checkpointRevision = existing?.revision;

  const ports: WorkflowRuntimePorts = {
    validateRetainedStep: ({ step, receipt, output }) => {
      const receiptRef = receipt.receiptRef?.trim();
      if (!receiptRef) throw new Error(`WORKFLOW_RETAINED_RECEIPT_REQUIRED: ${step.stepId}`);
      const expectedRequestId = requestId(input, step.stepId, asset.contentDigest);
      if (step.kind === 'script') {
        const script = asset.scripts?.[step.scriptRef];
        if (!script) throw new Error(`WORKFLOW_RETAINED_SCRIPT_MISSING: ${step.stepId}`);
        const lightweight = getLightweightProcessHandle(input.controllerHome, input.repository.repoId, receiptRef);
        if (lightweight) {
          if (lightweight.processId !== receiptRef || lightweight.workId !== input.workId || lightweight.requestId !== expectedRequestId
            || lightweight.status !== 'succeeded' || lightweight.ok !== true || lightweight.timedOut || lightweight.cancelled) {
            throw new Error(`WORKFLOW_RETAINED_PROCESS_RECEIPT_MISMATCH: ${step.stepId}`);
          }
          const canonicalOutput = retainWorkflowOutput(step, scriptOutput(script, lightweight.stdout ?? ''));
          if (JSON.stringify(canonicalOutput) !== JSON.stringify(output)) throw new Error(`WORKFLOW_RETAINED_OUTPUT_MISMATCH: ${step.stepId}`);
          return;
        }
        const process = getProcessRecord(input.controllerHome, input.repository.repoId, receiptRef);
        if (!process || process.processId !== receiptRef || process.workId !== input.workId || process.checkoutId !== input.executionIdentity.checkoutId
          || process.origin?.requestId !== expectedRequestId || process.status !== 'succeeded' || process.exitCode !== 0 || process.timedOut || process.cancelled) {
          throw new Error(`WORKFLOW_RETAINED_PROCESS_RECEIPT_MISMATCH: ${step.stepId}`);
        }
        const handle = getRepositoryCommandProcess(input.controllerHome, input.repository.repoId, receiptRef);
        if (!handle || handle.processId !== receiptRef || handle.status !== 'succeeded' || handle.ok !== true || !handle.completed) throw new Error(`WORKFLOW_RETAINED_OUTPUT_UNPROVEN: ${step.stepId}`);
        const canonicalOutput = retainWorkflowOutput(step, scriptOutput(script, handle.stdout ?? ''));
        if (JSON.stringify(canonicalOutput) !== JSON.stringify(output)) throw new Error(`WORKFLOW_RETAINED_OUTPUT_MISMATCH: ${step.stepId}`);
        return;
      }
      const binding = capabilityBinding(registry.value.bindings, step.capabilityId);
      const canonical = findPluginActionReceipt(input.controllerHome, receiptRef);
      if (!canonical || canonical.receiptId !== receiptRef || canonical.requestId !== expectedRequestId
        || canonical.workId !== input.workId || (canonical.workRepoId ?? canonical.repoId) !== input.repository.repoId
        || canonical.pluginId !== binding.pluginId || canonical.actionId !== binding.actionId
        || canonical.status !== 'succeeded' || canonical.effectOutcome === 'outcome_unknown'
        || pluginOutcome(canonical, canonical.result).outcome !== 'succeeded') {
        throw new Error(`WORKFLOW_RETAINED_PLUGIN_RECEIPT_MISMATCH: ${step.stepId}`);
      }
      const canonicalOutput = retainWorkflowOutput(step, canonical.result ?? {});
      if (JSON.stringify(canonicalOutput) !== JSON.stringify(output)) throw new Error(`WORKFLOW_RETAINED_OUTPUT_MISMATCH: ${step.stepId}`);
    },
    executeCapability: async ({ step, arguments: args }) => {
      assertWorkflowController(input);
      const binding = capabilityBinding(registry.value.bindings, step.capabilityId);
      try {
        const submitted = await submitPluginAction(input.controllerHome, input.repository, {
          pluginId: binding.pluginId!,
          actionId: binding.actionId!,
          requestId: requestId(input, step.stepId, asset.contentDigest),
          workId: input.workId,
          workRepoId: input.repository.repoId,
          args,
          timeoutMs: input.timeoutMs,
          authorizationGrantRefs: registry.value.capabilityGrantRefs,
          origin: { surface: 'system', actor: 'workflow-runtime', correlationId: input.runId },
        });
        return pluginOutcome(submitted.receipt, submitted.result);
      } catch (error) {
        const effectOutcome = isAssistantPluginError(error) ? error.effectOutcome : undefined;
        return {
          outcome: step.idempotency === 'non_idempotent' && effectOutcome !== 'failed' ? 'outcome_unknown' : 'failed',
          error: { code: isAssistantPluginError(error) ? error.code : 'WORKFLOW_CAPABILITY_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
    executeScript: async ({ step, script, arguments: args }) => {
      assertWorkflowController(input);
      try {
        const process = await executeCommand({
          controllerHome: input.controllerHome,
          repository: input.repository,
          executionIdentity: input.executionIdentity,
          workId: input.workId,
          requestId: requestId(input, step.stepId, asset.contentDigest),
          command: scriptCommand(script.runtime, script.body, args),
          timeoutMs: input.timeoutMs,
        });
        if (process.externalEffect?.outcome === 'not_started') {
          return { outcome: 'failed', error: { code: 'WORKFLOW_SCRIPT_DURABLE_CONTROLLER_REQUIRED', message: process.externalEffect.reconciliation } };
        }
        if (process.externalEffect?.outcome === 'outcome_unknown') {
          return { outcome: 'outcome_unknown', receiptRef: process.process?.processId };
        }
        const terminal = await completedCommandResult(input, process, waitCommand);
        if (terminal.timedOut || terminal.cancelled) {
          return { outcome: 'outcome_unknown', receiptRef: terminal.processId, error: { code: 'WORKFLOW_SCRIPT_PROCESS_INCOMPLETE', message: terminal.stderr ?? 'Script Process did not complete safely.' } };
        }
        return terminal.ok
          ? { outcome: 'succeeded', receiptRef: terminal.processId, output: scriptOutput(script, terminal.stdout ?? '') }
          : { outcome: 'failed', receiptRef: terminal.processId, error: { code: 'WORKFLOW_SCRIPT_FAILED', message: terminal.stderr ?? 'Script Process failed.' } };
      } catch (error) {
        return { outcome: 'outcome_unknown', error: { code: 'WORKFLOW_SCRIPT_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) } };
      }
    },
    checkpoint: (checkpoint) => {
      const stored = writeWorkflowRunCheckpoint({
        controllerHome: input.controllerHome,
        checkpoint,
        inputs: input.inputs,
        expectedRevision: checkpointRevision ?? null,
      });
      checkpointRevision = stored.revision;
    },
  };

  return executeWorkflow({
    asset,
    binding: { workId: input.workId, runId: input.runId },
    inputs: input.inputs,
    startStepIndex: existing?.value.nextStepIndex,
    retainedReceipts: existing?.value.receipts,
    retainedOutputs: existing?.value.outputs,
  }, ports);
}

/** Reconcile from canonical provider/Process evidence. Observation never re-dispatches the uncertain effect. */
export async function reconcileRegisteredWorkflow(
  input: ExecuteRegisteredWorkflowInput & { reconciliationRequestId?: string },
  dependencies: WorkflowRuntimeExecutionDependencies = {},
): Promise<WorkflowRunRecord> {
  assertWorkflowController(input, true);
  return withControllerLockAsync(
    input.controllerHome,
    { scope: 'task', repoId: input.repository.repoId, taskId: `workflow:${input.workId}` },
    `workflow-reconcile:${input.runId}`,
    () => reconcileRegisteredWorkflowLocked(input, dependencies),
    undefined,
    0,
  );
}

async function reconcileRegisteredWorkflowLocked(
  input: ExecuteRegisteredWorkflowInput & { reconciliationRequestId?: string },
  dependencies: WorkflowRuntimeExecutionDependencies = {},
): Promise<WorkflowRunRecord> {
  assertWorkflowController(input, true);
  const stored = readWorkflowRun(input.controllerHome, input.workId, input.runId);
  if (!stored || !(stored.value.inFlightStepId || stored.value.status === 'reconcile_required')) throw new Error('WORKFLOW_RECONCILIATION_NOT_REQUIRED');
  const registry = readWorkflowRegistryEntry(input.controllerHome, input.registryScope, input.workflowId);
  if (!registry || registry.value.status !== 'active') throw new Error('WORKFLOW_REGISTRY_ENTRY_REQUIRED');
  const asset = readWorkflowAssetContentFile(registry.value.contentLocation.path);
  if (asset.workflowId !== stored.value.workflowId || asset.version !== stored.value.version || asset.contentDigest !== stored.value.contentDigest
    || workflowInputDigest(input.inputs) !== stored.value.inputDigest) throw new Error('WORKFLOW_RUN_IDENTITY_CONFLICT');
  const registeredIdentity = workflowContentIdentity(asset);
  if (registeredIdentity.contentDigest !== registry.value.contentDigest || registeredIdentity.version !== registry.value.version
    || registeredIdentity.workflowId !== registry.value.workflowId) throw new Error('WORKFLOW_REGISTRY_CONTENT_IDENTITY_MISMATCH');
  const step = asset.steps[stored.value.nextStepIndex];
  if (!step) throw new Error('WORKFLOW_RECONCILIATION_STEP_REQUIRED');
  const originalRequestId = requestId(input, step.stepId, asset.contentDigest);
  const recordedAt = new Date().toISOString();

  if (step.kind === 'script') {
    const binding = getProcessRequestBinding(input.controllerHome, input.repository.repoId, input.executionIdentity.checkoutId, originalRequestId);
    if (!binding || binding.requestId !== originalRequestId || binding.repoId !== input.repository.repoId
      || (binding.checkoutId?.trim() || undefined) !== (input.executionIdentity.checkoutId?.trim() || undefined)) {
      throw new Error('WORKFLOW_RECONCILIATION_EVIDENCE_REQUIRED');
    }
    const process = getProcessRecord(input.controllerHome, input.repository.repoId, binding.processId);
    if (!process || process.processId !== binding.processId || process.workId !== input.workId
      || process.checkoutId !== input.executionIdentity.checkoutId || process.origin?.requestId !== originalRequestId) {
      throw new Error('WORKFLOW_RECONCILIATION_PROCESS_IDENTITY_MISMATCH');
    }
    // Existing Process maintenance is the only authority allowed to prove that spawn never happened.
    if (process.status === 'failed' && process.error?.message.includes('PROCESS_PRESPAWN_ABANDONED:')) {
      return writeWorkflowRunCheckpoint({ controllerHome: input.controllerHome, inputs: input.inputs, expectedRevision: stored.revision,
        checkpoint: { schemaVersion: 1, binding: { workId: input.workId, runId: input.runId }, workflowId: asset.workflowId, version: asset.version, contentDigest: asset.contentDigest,
          status: 'failed', nextStepIndex: stored.value.nextStepIndex, outputs: stored.value.outputs,
          receipts: [...stored.value.receipts.filter(receipt => receipt.stepId !== step.stepId), { stepId: step.stepId, outcome: 'failed', receiptRef: process.processId, recordedAt }] } }).value;
    }
    if (process.status !== 'succeeded' || process.exitCode !== 0 || process.timedOut || process.cancelled) {
      // Failed/timeout/stale Process does not prove absence of side effects. Keep reconciliation pending.
      throw new Error('WORKFLOW_RECONCILIATION_EVIDENCE_REQUIRED');
    }
    const handle = getRepositoryCommandProcess(input.controllerHome, input.repository.repoId, process.processId);
    if (!handle || handle.processId !== process.processId || handle.status !== 'succeeded' || handle.ok !== true || !handle.completed) {
      throw new Error('WORKFLOW_RECONCILIATION_EVIDENCE_REQUIRED');
    }
    const outputs = { ...stored.value.outputs, [step.stepId]: retainWorkflowOutput(step, { stdout: handle.stdout ?? '' }) };
    return writeWorkflowRunCheckpoint({ controllerHome: input.controllerHome, inputs: input.inputs, expectedRevision: stored.revision,
      checkpoint: { schemaVersion: 1, binding: { workId: input.workId, runId: input.runId }, workflowId: asset.workflowId, version: asset.version, contentDigest: asset.contentDigest,
        status: 'running', nextStepIndex: stored.value.nextStepIndex + 1, outputs,
        receipts: [...stored.value.receipts.filter(receipt => receipt.stepId !== step.stepId), { stepId: step.stepId, outcome: 'succeeded', receiptRef: process.processId, recordedAt }] } }).value;
  }

  const requestedReceiptId = input.reconciliationRequestId ?? originalRequestId;
  const receipt = readPluginActionReceiptForRequest(input.controllerHome, requestedReceiptId);
  if (!receipt || receipt.requestId !== requestedReceiptId || receipt.workId !== input.workId
    || (receipt.workRepoId ?? receipt.repoId) !== input.repository.repoId || receipt.status !== 'succeeded' || receipt.effectOutcome === 'outcome_unknown') {
    throw new Error('WORKFLOW_RECONCILIATION_EVIDENCE_REQUIRED');
  }
  const binding = capabilityBinding(registry.value.bindings, input.reconciliationRequestId ? step.reconcileWithCapabilityId ?? '' : step.capabilityId);
  if (receipt.pluginId !== binding.pluginId || receipt.actionId !== binding.actionId) throw new Error('WORKFLOW_RECONCILIATION_TARGET_MISMATCH');
  if (pluginOutcome(receipt, receipt.result).outcome !== 'succeeded') throw new Error('WORKFLOW_RECONCILIATION_BUSINESS_VERIFICATION_REQUIRED');
  let output = receipt.result ?? {};
  if (input.reconciliationRequestId) {
    if (output.effectRequestId !== originalRequestId) throw new Error('WORKFLOW_RECONCILIATION_NOT_PROVEN');
    if (output.outcome === 'not_applied') {
      // Exact negative observation clears the unresolved effect but never retries it. Controller chooses whether a new run is justified.
      releaseExecutionLeases(input.controllerHome, input.repository.repoId, `plugin:${originalRequestId}`);
      return writeWorkflowRunCheckpoint({ controllerHome: input.controllerHome, inputs: input.inputs, expectedRevision: stored.revision,
        checkpoint: { schemaVersion: 1, binding: { workId: input.workId, runId: input.runId }, workflowId: asset.workflowId, version: asset.version, contentDigest: asset.contentDigest,
          status: 'failed', nextStepIndex: stored.value.nextStepIndex, outputs: stored.value.outputs,
          receipts: [...stored.value.receipts.filter(candidate => candidate.stepId !== step.stepId), { stepId: step.stepId, outcome: 'failed', receiptRef: receipt.receiptId, recordedAt }] } }).value;
    }
    if (output.outcome !== 'applied' || !output.output || typeof output.output !== 'object' || Array.isArray(output.output)) throw new Error('WORKFLOW_RECONCILIATION_NOT_PROVEN');
    output = output.output as Record<string, unknown>;
  }
  releaseExecutionLeases(input.controllerHome, input.repository.repoId, `plugin:${originalRequestId}`);
  const outputs = { ...stored.value.outputs, [step.stepId]: retainWorkflowOutput(step, output) };
  return writeWorkflowRunCheckpoint({ controllerHome: input.controllerHome, inputs: input.inputs, expectedRevision: stored.revision,
    checkpoint: { schemaVersion: 1, binding: { workId: input.workId, runId: input.runId }, workflowId: asset.workflowId, version: asset.version, contentDigest: asset.contentDigest,
      status: 'running', nextStepIndex: stored.value.nextStepIndex + 1, outputs,
      receipts: [...stored.value.receipts.filter(candidate => candidate.stepId !== step.stepId), { stepId: step.stepId, outcome: 'succeeded', receiptRef: receipt.receiptId, recordedAt }] } }).value;
}


function reconciliationArguments(
  asset: ReturnType<typeof readWorkflowAssetContentFile>,
  inputs: Record<string, WorkflowJsonValue> | undefined,
  step: NonNullable<ReturnType<typeof readWorkflowAssetContentFile>['steps'][number]>,
  outputs: Record<string, Record<string, unknown>>,
  effectRequestId: string,
): Record<string, WorkflowJsonValue> {
  const resolvedInputs = validateWorkflowRunInputs(asset, inputs);
  const injectRuntime = (value: WorkflowJsonValue): WorkflowJsonValue => {
    if (value === '{{runtime.effect_request_id}}') return effectRequestId;
    if (Array.isArray(value)) return value.map(injectRuntime);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, injectRuntime(entry)]));
    return value;
  };
  return Object.fromEntries(Object.entries(step.reconciliationInput ?? {}).map(([key, value]) => [
    key,
    resolveWorkflowValue(asset, resolvedInputs, injectRuntime(value), outputs),
  ]));
}

/**
 * Produce one exact read-only reconciliation observation through the capability
 * declared by the asset, then consume that durable receipt under the same Work
 * lock. A retry with the same reconciliationRequestId reuses the same receipt;
 * a later observation needs a new caller-issued id.
 */
export async function observeAndReconcileRegisteredWorkflow(
  input: ExecuteRegisteredWorkflowInput & { reconciliationRequestId: string },
  dependencies: WorkflowRuntimeExecutionDependencies = {},
): Promise<WorkflowRunRecord> {
  if (!input.reconciliationRequestId.trim()) throw new Error('WORKFLOW_RECONCILIATION_REQUEST_ID_REQUIRED');
  assertWorkflowController(input, true);
  return withControllerLockAsync(
    input.controllerHome,
    { scope: 'task', repoId: input.repository.repoId, taskId: `workflow:${input.workId}` },
    `workflow-reconcile-observe:${input.runId}`,
    async () => {
      assertWorkflowController(input, true);
      const stored = readWorkflowRun(input.controllerHome, input.workId, input.runId);
      if (!stored || !(stored.value.inFlightStepId || stored.value.status === 'reconcile_required')) throw new Error('WORKFLOW_RECONCILIATION_NOT_REQUIRED');
      const registry = readWorkflowRegistryEntry(input.controllerHome, input.registryScope, input.workflowId);
      if (!registry || registry.value.status !== 'active') throw new Error('WORKFLOW_REGISTRY_ENTRY_REQUIRED');
      const asset = readWorkflowAssetContentFile(registry.value.contentLocation.path);
      if (asset.workflowId !== stored.value.workflowId || asset.version !== stored.value.version || asset.contentDigest !== stored.value.contentDigest
        || workflowInputDigest(input.inputs) !== stored.value.inputDigest) throw new Error('WORKFLOW_RUN_IDENTITY_CONFLICT');
      const step = asset.steps[stored.value.nextStepIndex];
      if (!step || step.kind === 'script' || !step.reconcileWithCapabilityId) throw new Error('WORKFLOW_RECONCILIATION_CAPABILITY_REQUIRED');
      const originalRequestId = requestId(input, step.stepId, asset.contentDigest);
      const binding = capabilityBinding(registry.value.bindings, step.reconcileWithCapabilityId);
      const submitPluginAction = dependencies.submitPluginAction ?? submitAssistantPluginAction;
      const observed = await submitPluginAction(input.controllerHome, input.repository, {
        pluginId: binding.pluginId!,
        actionId: binding.actionId!,
        requestId: input.reconciliationRequestId,
        workId: input.workId,
        workRepoId: input.repository.repoId,
        args: reconciliationArguments(asset, input.inputs, step, stored.value.outputs, originalRequestId),
        timeoutMs: input.timeoutMs,
        authorizationGrantRefs: registry.value.capabilityGrantRefs,
        origin: { surface: 'system', actor: 'workflow-runtime-reconciliation', correlationId: input.runId },
      });
      if (observed.receipt.status !== 'succeeded') throw new Error('WORKFLOW_RECONCILIATION_OBSERVATION_FAILED');
      return reconcileRegisteredWorkflowLocked(input, dependencies);
    },
    undefined,
    0,
  );
}
