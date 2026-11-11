/**
 * Repository-scoped Lightweight/Durable Process lifecycle MCP tools.
 *
 * process_get / process_wait / process_logs / process_cancel
 *
 * Schema definitions and the host-command surface only: the attachment/
 * lifecycle dispatch is the protocol-neutral tool-dispatch module shared with
 * the desktop native Agent local harness.
 */
import type { McpToolDefinition, CallToolResult } from '../../../packages/protocols/mcp/tool-contract';
import type { MultiRepositoryMcpToolContext } from '../multi-repository';
import { executeHostCommand } from '../../../src/runtime/execution/process-runtime';
import { resolveControllerAccessState } from '../access-mode';
import { stringList } from './shared-adapter';
import { result, failure, handleToPayload } from '../../../src/runtime/execution/process-runtime/tool-dispatch';

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
