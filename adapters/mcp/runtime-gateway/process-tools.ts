/**
 * Repository-scoped Lightweight/Durable Process lifecycle MCP tools.
 *
 * process_get / process_wait / process_logs / process_cancel
 *
 * These tools attach to an existing in-memory lightweight or persisted durable
 * handle. They never re-execute the original command.
 */

import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import {
  cancelRepositoryCommandProcess,
  executeHostCommand,
  getRepositoryCommandProcess,
  readRepositoryCommandProcessLogs,
  waitRepositoryCommandProcess,
} from '../../../src/runtime/execution/process-runtime';
import { redactSensitiveText, redactSensitiveValue } from '../../../src/runtime/evidence/sensitive-output';
import { resolveControllerAccessState } from '../access-mode';
import { forgeInstanceIdFor, readProcessHandleIndexEntry } from '../../../src/runtime/execution/process-runtime/handle-index';
import { isForgeInstanceProcessScopeKey, isRepositoryProcessScopeKey, processScopeKeyForHandle } from '../../../src/runtime/execution/process-runtime/process-scope';
import { stringList } from './shared-adapter';

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  readOnlyHint = false,
  destructiveHint = false,
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: { readOnlyHint, openWorldHint: false, destructiveHint },
  };
}

const repoIdProp = {
  type: 'string',
  description: 'Optional repository or ephemeral workspace scope id returned by the originating command. When omitted, the process handle resolves its own recorded execution target.',
};
const processIdProp = {
  type: 'string',
  description: 'Process id returned by execute_command or run_check.',
};

export const processToolDefinitions: McpToolDefinition[] = [
  definition(
    'run_check',
    'Run one focused repository check, or launch one resource-compatible check wave, through Process Runtime. Use check_id for the existing single-check behavior or check_ids for a batch; do not send both. Batch mode validates the existing check-scheduling resource model and starts every check in one compatible wave concurrently without waiting for completion or creating a second scheduler. Cross-wave, invalid, release, and multi-phase batches fail closed. Long ordinary checks return managed handles; attach only at a real dependency boundary.',
    {
      repo_id: repoIdProp,
      checkout_id: { type: 'string' },
      check_id: { type: 'string', description: 'Single check id. Mutually exclusive with check_ids.' },
      check_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32, uniqueItems: true, description: 'Batch check ids. All requested checks must fit one resource-compatible execution wave; mutually exclusive with check_id.' },
      timeout_ms: { type: 'number' },
      request_id: { type: 'string' },
      issue_id: { type: 'string' },
      task_id: { type: 'string' },
      mode: { type: 'string', enum: ['direct', 'async', 'durable'] },
      apply_mode: { type: 'string', enum: ['sync', 'async'] },
      force_durable: { type: 'boolean' },
    },
    [],
    false,
  ),
  definition(
    'process_get',
    'Non-blocking observation of a lightweight or durable process; never re-executes. Use only when the observation can change the next decision. It is not a synchronization join.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
    },
    ['process_id'],
    true,
  ),
  definition(
    'process_wait',
    'Bounded dependency attachment for an existing lightweight or durable process, only when the next decision requires its result. Never use for periodic polling; a running result means continue independent work or report pending acceptance. Caller interruption only ends observation for a durable Process; use process_cancel for explicit termination. Attaching never re-executes the command.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
      timeout_ms: { type: 'number', description: 'Requested wait in milliseconds (default 15000); each attachment is capped at 5000ms and returns a running handle when not terminal.' },
    },
    ['process_id'],
    true,
  ),
  definition(
    'process_logs',
    'Read a bounded tail of lightweight or durable process stdout/stderr. Never loads unbounded logs. Readonly.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
      max_bytes: { type: 'number', description: 'Max tail bytes per stream (default 32KiB).' },
    },
    ['process_id'],
    true,
  ),
  definition(
    'process_cancel',
    'Cancel a lightweight or durable process through its owning runtime handle. Classified as workspace-write / process-control.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
    },
    ['process_id'],
    false,
    true,
  ),
];

const processToolNames = new Set(processToolDefinitions.map((tool) => tool.name));
const processAttachmentToolNames = new Set(['process_get', 'process_wait', 'process_logs', 'process_cancel']);

// A long-lived MCP wait can monopolize shared Runtime request/transport capacity
// even though the underlying Process wait is asynchronous. Keep public waits
// short and return a normal running snapshot; the Process continues unchanged
// and callers can attach again only when the result is a real dependency.
export const DEFAULT_PROCESS_WAIT_ATTACH_BUDGET_MS = 5_000;

/**
 * Stable controller-facing continuation semantics for a returned Process.
 * This is deliberately response-only: Process Runtime remains the sole owner
 * of execution and no polling scheduler or second state authority is created.
 */
export function managedProcessContinuation(handle: { completed?: boolean; observationInterrupted?: boolean }): Record<string, string> {
  if (handle.completed === true) {
    return {
      state: 'terminal',
      nextAction: 'consume_terminal_result',
      join: 'complete',
      reexecution: 'forbidden',
    };
  }
  if (handle.observationInterrupted === true) {
    return {
      state: 'observation_interrupted',
      nextAction: 'reconcile_same_process',
      join: 'required_at_dependency_boundary',
      observation: 'caller_signal_aborted; durable_process_continues',
      reexecution: 'forbidden',
    };
  }
  return {
    state: 'background',
    nextAction: 'continue_independent_work',
    join: 'required_at_dependency_boundary',
    observation: 'process_get_if_it_can_change_the_next_decision',
    repeatedWait: 'not_recommended',
    reexecution: 'forbidden',
  };
}

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  const safe = redactSensitiveValue(value).value;
  return {
    content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
    structuredContent: safe,
    ...(isError ? { isError: true } : {}),
  };
}

function failure(error: unknown): CallToolResult {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'PROCESS_TOOL_FAILED';
  return result({ error: { code, message } }, true);
}

function requireRepoAndProcess(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): { repoId?: string; processId: string; handle: NonNullable<ReturnType<typeof getRepositoryCommandProcess>> } {
  const repoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  const processId = typeof args.process_id === 'string' ? args.process_id.trim() : '';
  if (!processId) throw new Error('PROCESS_ID_REQUIRED: process_id is required for process tools');
  assertProcessHandleAccess(ctx, processId);

  // The Process handle is the scope authority. An explicit repo_id is validated
  // against the handle's recorded target; when it is omitted the handle index
  // resolves the target so attachment never needs placement replay. Ephemeral
  // workspace targets are intentionally not registered in Repository Registry,
  // so requiring a live repository record here would make their returned
  // managed handles impossible to resume.
  const recordedScopeKey = processScopeKeyForHandle(ctx.controllerHome, processId);
  // A ForgeInstance-scoped handle keeps its instance target even when a client
  // always sends repo_id; the index remains the target authority.
  const effectiveScopeKey = recordedScopeKey && isForgeInstanceProcessScopeKey(recordedScopeKey)
    ? recordedScopeKey
    : (repoId || recordedScopeKey);
  const handle = getRepositoryCommandProcess(ctx.controllerHome, effectiveScopeKey, processId);
  if (!handle) {
    throw new Error(repoId
      ? `PROCESS_NOT_FOUND: process ${processId} is not registered under repo ${repoId}`
      : `PROCESS_NOT_FOUND: ${processId}`);
  }
  const resolvedScopeKey = recordedScopeKey && isForgeInstanceProcessScopeKey(recordedScopeKey) ? recordedScopeKey : (repoId || recordedScopeKey);
  const resolvedRepoId = resolvedScopeKey && isRepositoryProcessScopeKey(resolvedScopeKey) ? resolvedScopeKey : undefined;
  return { repoId: resolvedRepoId || undefined, processId, handle };
}

/**
 * A process handle id locates a record; it never authorizes attachment by
 * itself. Instance-level handles are principal-bound and ForgeInstance-bound,
 * and a recorded repository principal is enforced when the caller presents one.
 */
function assertProcessHandleAccess(ctx: MultiRepositoryMcpToolContext, processId: string): void {
  const entry = readProcessHandleIndexEntry(ctx.controllerHome, processId);
  if (!entry) return;
  const caller = ctx.principalId?.trim();
  const recorded = entry.principalId?.trim();
  if (entry.target.scope === 'forge_instance') {
    const servingInstance = forgeInstanceIdFor(ctx.controllerHome);
    if (entry.target.forgeInstanceId && servingInstance && entry.target.forgeInstanceId !== servingInstance) {
      throw new Error(`PROCESS_HANDLE_INSTANCE_MISMATCH: process ${processId} belongs to ForgeInstance ${entry.target.forgeInstanceId}`);
    }
    if (!recorded) throw new Error(`PROCESS_HANDLE_PRINCIPAL_UNBOUND: process ${processId} has no recorded principal`);
    if (!caller) throw new Error(`PROCESS_HANDLE_PRINCIPAL_REQUIRED: process ${processId} requires an authenticated principal`);
    if (recorded !== caller) throw new Error(`PROCESS_HANDLE_PRINCIPAL_MISMATCH: process ${processId} is owned by another principal`);
    return;
  }
  if (recorded && caller && recorded !== caller) {
    throw new Error(`PROCESS_HANDLE_PRINCIPAL_MISMATCH: process ${processId} is owned by another principal`);
  }
}

function handleToPayload(handle: NonNullable<ReturnType<typeof getRepositoryCommandProcess>>): Record<string, unknown> {
  return {
    processId: handle.processId,
    commandId: handle.commandId,
    status: handle.status,
    contractStatus: handle.contractStatus,
    route: handle.route,
    pid: handle.pid,
    startedAt: handle.startedAt,
    interactiveWaitMs: handle.interactiveWaitMs,
    timeoutMs: handle.timeoutMs,
    completed: handle.completed === true,
    ...(handle.observationInterrupted === true ? { observationInterrupted: true } : {}),
    ok: handle.ok,
    exitCode: handle.exitCode,
    timedOut: handle.timedOut,
    cancelled: handle.cancelled,
    stdout: handle.stdout,
    stderr: handle.stderr,
    // Keep the bounded tail available after completion for callers that use it
    // as their compact log view. Lightweight terminal receipts bound this tail
    // separately, so retaining the established field does not restore the
    // previous full-output duplication in persisted state.
    stdoutTail: handle.stdoutTail,
    stderrTail: handle.stderrTail,
    continuation: managedProcessContinuation(handle),
    concurrencyWait: handle.concurrencyWait,
    durableSideEffects: handle.durableSideEffects,
  };
}

export async function callProcessTool(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | undefined> {
  // run_check shares this module's public schema, but its execution authority is
  // the Gateway check facade in router.ts. Only attachment/lifecycle operations
  // consume an existing process_id here.
  if (!processAttachmentToolNames.has(name)) return undefined;
  try {
    const { repoId, processId, handle: attachedHandle } = requireRepoAndProcess(ctx, args);
    const scopePayload = repoId ? { repoId } : {};
    switch (name) {
      case 'process_get': {
        return result({
          ...scopePayload,
          process: handleToPayload(attachedHandle),
        });
      }
      case 'process_wait': {
        const requestedWaitMs = typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
          ? Math.max(1, Math.trunc(args.timeout_ms))
          : 15_000;
        const testBudget = (ctx as MultiRepositoryMcpToolContext & { processWaitAttachBudgetMs?: unknown }).processWaitAttachBudgetMs;
        const attachBudgetMs = typeof testBudget === 'number' && Number.isFinite(testBudget)
          ? Math.max(1, Math.trunc(testBudget))
          : DEFAULT_PROCESS_WAIT_ATTACH_BUDGET_MS;
        const startedAt = Date.now();
        const handle = await waitRepositoryCommandProcess(ctx.controllerHome, repoId, processId, {
          timeoutMs: Math.min(requestedWaitMs, attachBudgetMs),
          signal: ctx.signal,
        });
        return result({
          ...scopePayload,
          process: handleToPayload(handle),
          synchronization: handle.completed === true ? 'terminal_result_available'
            : handle.observationInterrupted === true ? 'observation_interrupted' : 'continue_independent_work',
          waitedMs: Date.now() - startedAt,
          requestedWaitMs,
          attachBudgetMs,
          reExecuted: false,
        });
      }
      case 'process_logs': {
        const maxBytes = typeof args.max_bytes === 'number' && Number.isFinite(args.max_bytes)
          ? Math.max(256, Math.trunc(args.max_bytes))
          : 32 * 1024;
        const logs = readRepositoryCommandProcessLogs(ctx.controllerHome, repoId, processId, maxBytes);
        if (!logs) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
        return result({
          ...scopePayload,
          processId,
          stdout: logs.stdout,
          stderr: logs.stderr,
          stdoutBytes: logs.stdoutBytes,
          stderrBytes: logs.stderrBytes,
          truncated: logs.truncated,
          maxBytes,
        });
      }
      case 'process_cancel': {
        const handle = await cancelRepositoryCommandProcess(ctx.controllerHome, repoId, processId);
        return result({
          ...scopePayload,
          process: handleToPayload(handle),
          cancelled: handle.cancelled === true || handle.status === 'cancelled' || handle.status === 'completed_unknown',
        });
      }
      default:
        return undefined;
    }
  } catch (error) {
    return failure(error);
  }
}

/**
 * Host target of the single execute_command entry: canonical process:exec Grant.
 *
 * Repo-less by construction: the Forge instance is the target and `cwd` is an
 * execution argument. Authorization is one explicit canonical `process:exec`
 * Grant for this instance, enforced in the lane before any spawn.
 */
/**
 * The explicitly user-selected Full Access mode is the single Forge permission
 * authority for ordinary host commands. Legacy defaults are not opt-in proof.
 */
export function requireHostFullAccess(controllerHome: string, principalId: string | undefined): void {
  if (!principalId?.trim()) throw new Error('HOST_PROCESS_PRINCIPAL_REQUIRED: authenticated principal required');
  const state = resolveControllerAccessState({ controllerHome });
  if (state.source !== 'controller_home.access_mode' || state.effectiveAccessMode !== 'full_access') {
    throw new Error('HOST_FULL_ACCESS_REQUIRED: explicitly enable Full Access in existing Forge permission settings');
  }
}

export async function executeAuthorizedHostCommand(
  ctx: MultiRepositoryMcpToolContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    requireHostFullAccess(ctx.controllerHome, ctx.principalId);
    const command = stringList(args.command);
    const shellCommand = typeof args.shell_command === 'string' && args.shell_command.trim()
      ? args.shell_command
      : undefined;
    if (command.length > 0 && shellCommand) {
      throw new Error('HOST_COMMAND_AMBIGUOUS: provide exactly one of command or shell_command');
    }
    if (command.length === 0 && !shellCommand) {
      throw new Error('HOST_COMMAND_REQUIRED: provide command (argv) or shell_command');
    }
    const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
    if (typeof args.work_id === 'string' && args.work_id.trim()) {
      throw new Error(`WORK_PROCESS_ATTRIBUTION_RETIRED: ${args.work_id}`);
    }
    const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : '';
    const executed = await executeHostCommand({
      controllerHome: ctx.controllerHome,
      principalId: ctx.principalId ?? '',
      ...(command.length > 0 ? { command } : {}),
      ...(shellCommand ? { shellCommand } : {}),
      cwd,
      ...(typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {}),
      ...(typeof args.interactive_wait_ms === 'number' ? { interactiveWaitMs: args.interactive_wait_ms } : {}),
      ...(typeof args.max_output_bytes === 'number' ? { maxOutputBytes: args.max_output_bytes } : {}),
      ...(requestId ? { commandId: requestId } : {}),
    });
    return result({
      process: handleToPayload(executed.handle),
      target: {
        scope: 'forge_instance',
        forgeInstanceId: executed.target.forgeInstanceId,
        cwd: executed.target.cwd,
      },
      authorization: { source: 'host_ai_full_access', principalId: ctx.principalId },
      executionMetrics: executed.metrics,
    });
  } catch (error) {
    return failure(error);
  }
}

export function isProcessTool(name: string): boolean {
  return processToolNames.has(name);
}
