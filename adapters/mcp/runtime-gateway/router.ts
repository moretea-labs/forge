import { createHash } from 'crypto';
import type { CallToolResult, McpToolDefinition } from '../../../packages/protocols/mcp/tool-contract';
import {
  buildMultiRepositoryToolDefinitions,
  type MultiRepositoryMcpToolContext,
} from '../multi-repository';
import { repositoryToolDefinitions } from '../tool-mapping/repository-tools';
import { runtimeToolDefinitions } from './runtime-tool-definitions';
import { executionToolDefinitions } from './execution-tools';
import { processToolDefinitions } from './process-tools';
import { executeGatewayRoutedOperation } from './gateway-execution-adapter';
import { classifyGatewayExecutionPath } from './routing-policy';
export {
  classifyGatewayExecutionPath,
  executionTimeoutPolicyForMcpCall,
  gatewayRouteBehaviorSnapshot,
  isDirectHotReadTool,
  isGatewayIsolatedTool,
  isSelfManagedDurableTool,
  operationExecutionTimeoutMsForMcpCall,
  runsAsInteractiveSyncWrite,
  waitTimeoutMs,
  wantsWaitForResult,
} from './routing-policy';
export type { GatewayRouteBehaviorSnapshot } from './routing-policy';

export const RETIRED_AGENT_OPERATIONS = new Set([
  'dispatch_task',
  'launch_issue',
  'dispatch_ready_tasks',
  'retry_task_run',
  'quick_agent_session',
  'submit_local_job',
]);

// Historical ExecutionJobs remain readable migration evidence only.
function executionJobCreationRetired(): boolean {
  return true;
}

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function getMcpToolDefinition(ctx: MultiRepositoryMcpToolContext, name: string): McpToolDefinition | undefined {
  const currentDefinitions = [...runtimeToolDefinitions, ...executionToolDefinitions, ...processToolDefinitions, ...repositoryToolDefinitions];
  if (ctx.toolset !== 'full') return currentDefinitions.find((tool) => tool.name === name);
  return [...currentDefinitions, ...buildMultiRepositoryToolDefinitions(ctx)].find((tool) => tool.name === name);
}

/**
 * Classify Gateway execution path before any ExecutionJob is created.
 * Fast decisions short-circuit durable queueing so Thin Harness owns the request.
 */
export function shouldCreateDurableJob(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown> = {},
  opts: { allowReadOnly?: boolean; forceDurable?: boolean } = {},
): boolean {
  if (executionJobCreationRetired()) return false;
  const definition = getMcpToolDefinition(ctx, name);
  if (!definition) return false;
  // One authoritative decision: do not duplicate read/write/isolation policy here.
  return classifyGatewayExecutionPath(name, args, { ...opts, definition }).path === 'durable';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'request_id')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function hashMcpToolArguments(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex').slice(0, 20);
}

export function validateMcpToolArguments(name: string, definition: McpToolDefinition, args: Record<string, unknown>): void {
  const schema = definition.inputSchema as { required?: unknown; properties?: Record<string, unknown>; additionalProperties?: unknown };
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    throw new Error(`INVALID_ARGUMENT: ${name} is missing required argument(s): ${missing.join(', ')}`);
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new Error(`INVALID_ARGUMENT: ${name} received unsupported argument(s): ${unexpected.join(', ')}`);
    }
  }
}

export function injectDurableCommandFields(tool: McpToolDefinition): McpToolDefinition {
  const schema = tool.inputSchema as { type?: unknown; properties?: Record<string, unknown>; [key: string]: unknown };
  if (schema.type !== 'object') return tool;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        request_id: {
          type: 'string',
          description: 'Idempotency key. Process Runtime retries return the original Process; durable operations return the original Work or historical Job.',
        },
        apply_mode: {
          type: 'string',
          enum: ['sync', 'async'],
          description: 'Interactive development tools default to sync. Set async to queue a durable Job instead.',
        },
        wait: {
          type: 'boolean',
          description: 'When true for durable operations, wait up to wait_ms for a terminal result digest.',
        },
        wait_ms: {
          type: 'number',
          description: 'Max wait for terminal job result. Only used when wait=true; never enables waiting by itself. Default 15000, max 120000.',
        },
        admission_timeout_ms: {
          type: 'number',
          description: 'Durable admission budget before the Scheduler first observes the Job.',
        },
        queue_timeout_ms: {
          type: 'number',
          description: 'Durable queue budget after Scheduler admission and before Worker start.',
        },
        execution_timeout_ms: {
          type: 'number',
          description: 'Operation execution budget. For Agent delegation this is the Child Run budget and is never silently reduced by the Parent Job.',
        },
        interactive_wait_ms: {
          type: 'number',
          description: 'Caller-side wait budget only. It never cancels or shortens the durable operation.',
        },
      },
    },
  };
}

export async function routeDurableMcpCall(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
  opts: { allowReadOnly?: boolean; forceDurable?: boolean } = {},
): Promise<CallToolResult | undefined> {
  const definition = getMcpToolDefinition(ctx, name);
  if (!definition) {
    return result({
      accepted: false,
      mode: 'reject',
      path: 'reject',
      rejectCode: 'TOOL_NOT_FOUND',
      error: {
        code: 'TOOL_NOT_FOUND',
        message: `${name} is not registered by this forge build.`,
      },
    }, true);
  }

  if (RETIRED_AGENT_OPERATIONS.has(name)) {
    return result({
      accepted: false,
      mode: 'reject',
      path: 'reject',
      rejectCode: 'AGENT_RUN_DEPRECATED',
      message: 'Kernel-managed Agent Runs are retired. Create or resume a WorkContract, claim it, then start the external Controller through rh_work.launcher_start.',
      migration: ['rh_work.plan_create', 'rh_work.controller_claim', 'rh_work.launcher_start', 'rh_inbox.create'],
    });
  }

  // Classify BEFORE creating any ExecutionJob / LocalJob / Worker.
  const classification = classifyGatewayExecutionPath(name, args, { ...opts, definition });
  if (classification.path === 'reject' && classification.reasons.includes('tool_not_found')) {
    return result({
      accepted: false,
      mode: 'reject',
      path: 'reject',
      routing: {
        path: 'reject',
        reasons: classification.reasons,
      },
      rejectCode: 'TOOL_NOT_FOUND',
      error: {
        code: 'TOOL_NOT_FOUND',
        message: `${name} is not registered by this forge build.`,
      },
    }, true);
  }
  if (classification.path === 'reject' && classification.decision) {
    return result({
      accepted: false,
      mode: 'reject',
      path: 'reject',
      routing: {
        path: 'reject',
        reasons: classification.reasons,
        decision: classification.decision,
      },
      rejectCode: classification.decision.rejectCode,
      message: classification.reasons.join('; ') || 'operation rejected by Thin Harness routing',
      suggestedOperation: classification.decision.suggestedOperation,
    }, true);
  }

  // repository_command_execute has its own durable boundary: non-destructive
  // remote writes run through the durable Process Runtime, while destructive or
  // explicitly delegated commands are refused by the repository facade itself.
  // Do not intercept that tool with the retired ExecutionJob gate here.
  if (classification.path === 'durable' && executionJobCreationRetired() && name !== 'repository_command_execute') {
    return result({
      accepted: false,
      mode: 'external_controller_required',
      path: 'external_controller_required',
      routing: {
        path: 'external_controller_required',
        reasons: [...classification.reasons, 'execution_job_creation_retired'],
        ...(classification.decision ? { decision: classification.decision } : {}),
      },
      rejectCode: 'EXECUTION_JOB_RETIRED',
      message: 'This operation requires an explicitly claimed external Controller; the Kernel no longer creates ExecutionJobs.',
      suggestedOperation: 'Create or resume a WorkContract, claim it with controller_claim, then use Process Runtime commands or rh_work.launcher_start.',
    });
  }

  const execution = await executeGatewayRoutedOperation(ctx, name, args, classification);
  if (execution) return execution;

  // Durable classifications have already returned the explicit external-controller
  // handoff above. All remaining tools are direct, fast, or self-managed and must
  // not retain a dormant ExecutionJob creation branch.
  return undefined;
}
