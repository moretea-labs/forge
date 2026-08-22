/**
 * Repository-scoped Lightweight/Durable Process lifecycle MCP tools.
 *
 * process_get / process_wait / process_logs / process_cancel
 *
 * These tools attach to an existing in-memory lightweight or persisted durable
 * handle. They never re-execute the original command.
 */

import type { McpToolDefinition, CallToolResult } from '../../../cli/mcp/tools';
import type { MultiRepositoryMcpToolContext } from '../../../cli/mcp/multi-repository';
import {
  cancelRepositoryCommandProcess,
  getRepositoryCommandProcess,
  readRepositoryCommandProcessLogs,
  waitRepositoryCommandProcess,
} from '../../execution/process-runtime';
import { redactSensitiveText, redactSensitiveValue } from '../../evidence/sensitive-output';

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
  description: 'Repository or ephemeral workspace scope id returned by the originating command. Process must belong to this scope.',
};
const processIdProp = {
  type: 'string',
  description: 'Lightweight or durable process id returned by run_check / repository_command_execute.',
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
    ['repo_id', 'process_id'],
    true,
  ),
  definition(
    'process_wait',
    'Explicit dependency synchronization for one lightweight or durable process. Call only when the next decision or acceptance boundary is blocked on this exact result; do not use as periodic polling. Waits never re-execute the command.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
      timeout_ms: { type: 'number', description: 'Max wait milliseconds (default 15000).' },
    },
    ['repo_id', 'process_id'],
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
    ['repo_id', 'process_id'],
    true,
  ),
  definition(
    'process_cancel',
    'Cancel a lightweight or durable process through its owning runtime handle. Classified as workspace-write / process-control.',
    {
      repo_id: repoIdProp,
      process_id: processIdProp,
    },
    ['repo_id', 'process_id'],
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
export function managedProcessContinuation(handle: { completed?: boolean }): Record<string, string> {
  if (handle.completed === true) {
    return {
      state: 'terminal',
      nextAction: 'consume_terminal_result',
      join: 'complete',
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
): { repoId: string; processId: string } {
  const repoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  const processId = typeof args.process_id === 'string' ? args.process_id.trim() : '';
  if (!repoId) throw new Error('REPOSITORY_ID_REQUIRED: repo_id is required for process tools');
  if (!processId) throw new Error('PROCESS_ID_REQUIRED: process_id is required for process tools');

  // The Process handle is the scope authority. Ephemeral workspace targets are
  // intentionally not registered in Repository Registry, so requiring a live
  // repository record here would make their returned managed handles impossible
  // to resume. Exact repo/workspace scope + process id still fails closed.
  const handle = getRepositoryCommandProcess(ctx.controllerHome, repoId, processId);
  if (!handle) {
    throw new Error(`PROCESS_NOT_FOUND: process ${processId} is not registered under repo ${repoId}`);
  }
  return { repoId, processId };
}

function handleToPayload(handle: NonNullable<ReturnType<typeof getRepositoryCommandProcess>>): Record<string, unknown> {
  return {
    processId: handle.processId,
    workId: handle.workId,
    commandId: handle.commandId,
    status: handle.status,
    contractStatus: handle.contractStatus,
    route: handle.route,
    pid: handle.pid,
    startedAt: handle.startedAt,
    interactiveWaitMs: handle.interactiveWaitMs,
    timeoutMs: handle.timeoutMs,
    completed: handle.completed === true,
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
    const { repoId, processId } = requireRepoAndProcess(ctx, args);
    switch (name) {
      case 'process_get': {
        const handle = getRepositoryCommandProcess(ctx.controllerHome, repoId, processId);
        if (!handle) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
        return result({
          repoId,
          process: handleToPayload(handle),
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
        });
        return result({
          repoId,
          process: handleToPayload(handle),
          synchronization: handle.completed === true ? 'terminal_result_available' : 'continue_independent_work',
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
          repoId,
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
          repoId,
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

export function isProcessTool(name: string): boolean {
  return processToolNames.has(name);
}
