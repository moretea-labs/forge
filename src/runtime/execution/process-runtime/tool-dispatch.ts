/**
 * Protocol-neutral Process attachment tool dispatch.
 *
 * One dispatcher below every transport: the MCP runtime gateway and the
 * desktop native Agent local harness both call this module, so Process
 * attachment, cancellation and receipt semantics cannot fork between
 * surfaces. Attachment never re-executes the original command; the Process
 * Runtime handle remains the sole execution authority.
 */
import type { CallToolResult } from '../../../../packages/protocols/mcp/tool-contract';
import {
  cancelRepositoryCommandProcess,
  getRepositoryCommandProcess,
  readRepositoryCommandProcessLogs,
  waitRepositoryCommandProcess,
} from './command-facade';
import { redactSensitiveText, redactSensitiveValue } from '../../evidence/sensitive-output';
import { leadingErrorCode } from '../../shared/response-budget';
import { forgeInstanceIdFor, readProcessHandleIndexEntry } from './handle-index';
import { isForgeInstanceProcessScopeKey, isRepositoryProcessScopeKey, processScopeKeyForHandle } from './process-scope';

/**
 * Narrow transport-agnostic caller context. The MCP gateway context
 * structurally satisfies this interface; the desktop local harness passes
 * its controller-home-scoped caller identity directly.
 */
export interface ProcessToolCallContext {
  controllerHome: string;
  principalId?: string;
  signal?: AbortSignal;
  processWaitAttachBudgetMs?: unknown;
}

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

export function result(value: Record<string, unknown>, isError = false): CallToolResult {
  const safe = redactSensitiveValue(value).value;
  return {
    content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
    structuredContent: safe,
    ...(isError ? { isError: true } : {}),
  };
}

export function failure(error: unknown): CallToolResult {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
  const code = leadingErrorCode(message, 'PROCESS_TOOL_FAILED');
  return result({ error: { code, message } }, true);
}

function requireRepoAndProcess(
  ctx: ProcessToolCallContext,
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
function assertProcessHandleAccess(ctx: ProcessToolCallContext, processId: string): void {
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

export function handleToPayload(handle: NonNullable<ReturnType<typeof getRepositoryCommandProcess>>): Record<string, unknown> {
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
  ctx: ProcessToolCallContext,
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
        const testBudget = ctx.processWaitAttachBudgetMs;
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
