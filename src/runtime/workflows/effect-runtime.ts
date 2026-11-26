import type { RepositoryRecord } from '../../core/repository/types';
import type { ResolvedExecutionIdentity } from '../control-plane/execution/execution-identity';
import type { WorkflowJsonValue } from '../../../packages/workflow-runtime/api/index';
import type {
  WorkflowCapabilityBinding,
  WorkflowRegistryEntry,
} from '../control-plane/persistence/workflow-registry-store';
import { submitAssistantPluginAction, type PluginActionReceipt } from '../plugins/store';
import { isAssistantPluginError } from '../plugins/errors';
import {
  executeRepositoryCommandViaProcessRuntime,
  waitRepositoryCommandProcess,
  type RepositoryCommandProcessResult,
} from '../execution/process-runtime/command-facade';

export interface WorkflowEffectRuntimeContext {
  controllerHome: string;
  repository: RepositoryRecord;
  executionIdentity: ResolvedExecutionIdentity;
  runId: string;
  timeoutMs?: number;
  registry: Pick<WorkflowRegistryEntry, 'bindings' | 'capabilityGrantRefs'>;
}

export interface WorkflowEffectRuntimeDependencies {
  submitPluginAction?: typeof submitAssistantPluginAction;
  executeCommand?: typeof executeRepositoryCommandViaProcessRuntime;
  waitCommand?: typeof waitRepositoryCommandProcess;
}

export interface WorkflowEffectResult {
  outcome: 'succeeded' | 'failed' | 'outcome_unknown';
  receiptRef?: string;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export function workflowCapabilityBinding(
  bindings: WorkflowCapabilityBinding[],
  capabilityId: string,
): WorkflowCapabilityBinding {
  const matches = bindings.filter((binding) => binding.capabilityId === capabilityId);
  if (matches.length === 0) throw new Error(`WORKFLOW_CAPABILITY_BINDING_REQUIRED: ${capabilityId}`);
  if (matches.length > 1) throw new Error(`WORKFLOW_CAPABILITY_BINDING_AMBIGUOUS: ${capabilityId}`);
  const binding = matches[0]!;
  if (!binding.pluginId || !binding.actionId)
    throw new Error(`WORKFLOW_CAPABILITY_BINDING_EXECUTION_TARGET_REQUIRED: ${capabilityId}`);
  return binding;
}

export function workflowPluginActionOutput(
  result: Record<string, unknown> | undefined,
  binding: WorkflowCapabilityBinding,
  expectedRequestId: string,
): Record<string, unknown> {
  const plugin = result?.plugin;
  const action = result?.action;
  const output = result?.result;
  if (
    result?.schemaVersion !== 1 ||
    !plugin ||
    typeof plugin !== 'object' ||
    Array.isArray(plugin) ||
    (plugin as Record<string, unknown>).pluginId !== binding.pluginId ||
    !action ||
    typeof action !== 'object' ||
    Array.isArray(action) ||
    (action as Record<string, unknown>).actionId !== binding.actionId ||
    (action as Record<string, unknown>).requestId !== expectedRequestId ||
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output)
  ) {
    throw new Error('WORKFLOW_PLUGIN_RESULT_ENVELOPE_MISMATCH');
  }
  return output as Record<string, unknown>;
}

export function workflowPluginOutcome(
  receipt: PluginActionReceipt,
  result?: Record<string, unknown>,
): WorkflowEffectResult {
  const outcome = result?.outcome ?? result?.status;
  if (receipt.effectOutcome === 'outcome_unknown' || outcome === 'outcome_unknown') {
    return { outcome: 'outcome_unknown', receiptRef: receipt.receiptId, output: result };
  }
  if (
    receipt.status === 'failed' ||
    result?.matched === false ||
    result?.verified === false ||
    [
      'failed',
      'login_required',
      'authentication_required',
      'page_changed',
      'not_verified',
      'generation_required',
      'auth_required',
      'page_schema_changed',
      'publish_unverified',
      'verification_pending',
      'incompatible',
    ].includes(String(outcome))
  ) {
    return { outcome: 'failed', receiptRef: receipt.receiptId, error: receipt.error };
  }
  return { outcome: 'succeeded', receiptRef: receipt.receiptId, output: result };
}

export async function executeWorkflowCapabilityEffect(input: {
  context: WorkflowEffectRuntimeContext;
  capabilityId: string;
  arguments: Record<string, WorkflowJsonValue>;
  requestId: string;
  idempotency: 'idempotent' | 'non_idempotent';
  dependencies?: WorkflowEffectRuntimeDependencies;
}): Promise<WorkflowEffectResult> {
  const submit = input.dependencies?.submitPluginAction ?? submitAssistantPluginAction;
  const binding = workflowCapabilityBinding(input.context.registry.bindings, input.capabilityId);
  try {
    const submitted = await submit(input.context.controllerHome, input.context.repository, {
      pluginId: binding.pluginId!,
      actionId: binding.actionId!,
      requestId: input.requestId,
      args: input.arguments,
      timeoutMs: input.context.timeoutMs,
      authorizationGrantRefs: input.context.registry.capabilityGrantRefs,
      origin: { surface: 'system', actor: 'workflow-runtime', correlationId: input.context.runId },
    });
    const output =
      submitted.receipt.status === 'succeeded'
        ? workflowPluginActionOutput(submitted.result, binding, input.requestId)
        : undefined;
    return workflowPluginOutcome(submitted.receipt, output);
  } catch (error) {
    const effectOutcome = isAssistantPluginError(error) ? error.effectOutcome : undefined;
    return {
      outcome: input.idempotency === 'non_idempotent' && effectOutcome !== 'failed' ? 'outcome_unknown' : 'failed',
      error: {
        code: isAssistantPluginError(error) ? error.code : 'WORKFLOW_CAPABILITY_EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function workflowScriptOutput(
  script: { outputFormat?: 'text' | 'json' },
  stdout: string,
): Record<string, unknown> {
  if (script.outputFormat !== 'json') return { stdout };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('WORKFLOW_SCRIPT_JSON_OUTPUT_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('WORKFLOW_SCRIPT_JSON_OUTPUT_INVALID');
  return parsed as Record<string, unknown>;
}

function workflowScriptCommand(
  runtime: 'shell' | 'node' | 'python',
  body: string,
  args: Record<string, WorkflowJsonValue>,
): string[] {
  const serialized = JSON.stringify(args);
  if (runtime === 'node') return ['node', '-e', body, serialized];
  if (runtime === 'python') return ['python3', '-c', body, serialized];
  return ['bash', '-lc', body, '--', serialized];
}

async function completedCommandResult(
  context: WorkflowEffectRuntimeContext,
  result: RepositoryCommandProcessResult,
  waitCommand: typeof waitRepositoryCommandProcess,
): Promise<{
  ok?: boolean;
  processId?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}> {
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
  const terminal = await waitCommand(context.controllerHome, context.repository.repoId, result.process.processId, {
    timeoutMs: context.timeoutMs ?? 30_000,
  });
  return {
    ok: terminal.ok,
    processId: terminal.processId,
    stdout: terminal.stdout,
    stderr: terminal.stderr,
    timedOut: terminal.timedOut,
    cancelled: terminal.cancelled,
  };
}

export async function executeWorkflowScriptEffect(input: {
  context: WorkflowEffectRuntimeContext;
  script: {
    runtime: 'shell' | 'node' | 'python';
    body: string;
    outputFormat?: 'text' | 'json';
  };
  arguments: Record<string, WorkflowJsonValue>;
  requestId: string;
  dependencies?: WorkflowEffectRuntimeDependencies;
}): Promise<WorkflowEffectResult> {
  const execute = input.dependencies?.executeCommand ?? executeRepositoryCommandViaProcessRuntime;
  const wait = input.dependencies?.waitCommand ?? waitRepositoryCommandProcess;
  try {
    const process = await execute({
      controllerHome: input.context.controllerHome,
      repository: input.context.repository,
      executionIdentity: input.context.executionIdentity,
      requestId: input.requestId,
      persistReceipt: true,
      command: workflowScriptCommand(input.script.runtime, input.script.body, input.arguments),
      timeoutMs: input.context.timeoutMs,
    });
    if (process.externalEffect?.outcome === 'not_started') {
      return {
        outcome: 'failed',
        error: {
          code: 'WORKFLOW_SCRIPT_DURABLE_CONTROLLER_REQUIRED',
          message: process.externalEffect.reconciliation,
        },
      };
    }
    if (process.externalEffect?.outcome === 'outcome_unknown') {
      return { outcome: 'outcome_unknown', receiptRef: process.process?.processId };
    }
    const terminal = await completedCommandResult(input.context, process, wait);
    if (terminal.timedOut || terminal.cancelled) {
      return {
        outcome: 'outcome_unknown',
        receiptRef: terminal.processId,
        error: {
          code: 'WORKFLOW_SCRIPT_PROCESS_INCOMPLETE',
          message: terminal.stderr ?? 'Script Process did not complete safely.',
        },
      };
    }
    return terminal.ok
      ? {
          outcome: 'succeeded',
          receiptRef: terminal.processId,
          output: workflowScriptOutput(input.script, terminal.stdout ?? ''),
        }
      : {
          outcome: 'failed',
          receiptRef: terminal.processId,
          error: {
            code: 'WORKFLOW_SCRIPT_FAILED',
            message: terminal.stderr ?? 'Script Process failed.',
          },
        };
  } catch (error) {
    return {
      outcome: 'outcome_unknown',
      error: {
        code: 'WORKFLOW_SCRIPT_EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
