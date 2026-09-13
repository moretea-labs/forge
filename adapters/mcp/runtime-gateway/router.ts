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
import type { ExecutionTimeoutPolicy } from '../../../src/runtime/execution/jobs/types';
import { classifyRepositoryCommand } from '../../../src/cli/repositories/command-classifier';
import {
  isFastEligibleTool,
  routeExecution,
  type ExecutionDecision,
} from '../../../src/runtime/execution/thin-harness';
import { classifyRepositoryCommandRoute } from '../../../src/runtime/execution/process-runtime';
import { executeGatewayRoutedOperation } from './gateway-execution-adapter';
import { isProcessIsolatedReadDiagnostic } from '../../../src/runtime/diagnostics/process-facade';

const DIRECT_REPOSITORY_TOOLS = new Set(['repository_list', 'repository_get', 'repository_workbench', 'repository_command_preview']);
export const RETIRED_AGENT_OPERATIONS = new Set([
  'dispatch_task',
  'launch_issue',
  'dispatch_ready_tasks',
  'retry_task_run',
  'quick_agent_session',
  'submit_local_job',
]);

// Explicitly authorized bounded control-plane writes whose handlers already own
// their mutation boundary. These must not be promoted to retired ExecutionJobs.
const DIRECT_CONTROL_WRITE_TOOLS = new Set([
  'runtime_maintenance_apply',
  // Protected credential preparation and physical input own their authorization boundary.
  // Neither may be promoted into Process/ExecutionJob persistence or replay.
  'computer_console_unlock_prepare',
  'computer_console_unlock',
]);

// Historical ExecutionJobs remain readable migration evidence only.
function executionJobCreationRetired(): boolean {
  return true;
}

/**
 * Tools whose Fast/Durable boundary is owned by Thin Harness classification.
 * Gateway must classify BEFORE creating an ExecutionJob so short readonly
 * repository commands do not pay queue/worker overhead.
 */
const THIN_ROUTED_TOOLS = new Set([
  'repository_command_execute',
  'repository_safe_patch_apply',
  'repository_safe_patch_plan',
  'repository_git_status',
  'repository_git_diff',
  'repository_git_commit',
  'git_stage_paths',
  'git_commit_paths',
  'git_diff_paths',
  'apply_patch',
  'apply_edit_operations',
  'search_repository',
  'read_file_range',
  'read_repository_file',
  // Checks and edit verification use Process Runtime unless multi-phase/release requires Durable.
  'run_check',
  'verify_edit_session',
]);

/** Blocking native host tools must never execute on the public MCP event loop. */
const GATEWAY_ISOLATED_TOOLS = new Set([
  // Native Apple tooling uses synchronous xcodebuild/simctl subprocesses.
  'ios_review_packet', 'ios_xcode_status', 'ios_simulators_list', 'ios_project_discover',
  'ios_schemes_list', 'ios_simulator_boot', 'ios_app_build', 'ios_app_install',
  'ios_app_launch', 'ios_simulator_screenshot', 'ios_simulator_log_tail', 'ios_ui_smoke_test',
  // Diagnostics and maintenance perform process-table and recursive filesystem scans.
  'workflow_watchdog_report', 'runtime_cleanup_preview', 'runtime_cleanup_apply',
  'runtime_maintenance_status', 'runtime_maintenance_apply',
  // Release and recovery operations may spawn Git/process checks or restart managed children.
  'release_gate', 'runtime_recovery', 'capability_recovery',
]);

export function isGatewayIsolatedTool(name: string): boolean {
  return GATEWAY_ISOLATED_TOOLS.has(name);
}

/**
 * Tools that own their execution boundary and must never fall through to
 * retired generic ExecutionJob creation. Legacy iOS atomics are compatibility
 * adapters over the typed iOS plugin authority.
 */
const SELF_MANAGED_DURABLE_TOOLS = new Set([
  'plugin_action_execute',
  'ios_xcode_status', 'ios_simulators_list', 'ios_project_discover', 'ios_schemes_list',
  'ios_simulator_boot', 'ios_app_build', 'ios_app_install', 'ios_app_launch',
  'ios_simulator_screenshot', 'ios_simulator_log_tail', 'ios_ui_smoke_test',
]);

export function isSelfManagedDurableTool(name: string): boolean {
  return SELF_MANAGED_DURABLE_TOOLS.has(name);
}
/** High-frequency bounded reads execute in the current MCP request. */
const DIRECT_HOT_READ_TOOLS = new Set([
  'get_task_run', 'get_task_run_events', 'get_task_run_log',
  'get_job', 'list_jobs',
  'work_get', 'work_list', 'work_status_digest', 'work_result_summary',
  'controller_ready', 'repository_runtime_snapshot',
  'rh_status', 'rh_context', 'rh_inbox',
  'repository_git_status', 'repository_git_diff', 'git_diff_paths',
]);

export function isDirectHotReadTool(name: string): boolean {
  return DIRECT_HOT_READ_TOOLS.has(name);
}
/** Small interactive development writes: run synchronously by default so ChatGPT/GUI get immediate results. */
const INTERACTIVE_SYNC_WRITE_TOOLS = new Set([
  'repository_safe_patch_apply',
  'repository_git_create_branch',
  'repository_git_switch_branch',
  'repository_git_merge_branch',
  'repository_git_delete_branch',
  'repository_git_commit',
  'repository_git_finish_workflow',
  'begin_edit_session',
  'apply_patch',
  'apply_edit_operations',
  'create_edit_savepoint',
  'git_stage_paths',
  'git_commit_paths',
  // Recovery writes against an existing Run must remain available while legacy
  // Runs are the very thing preventing runtime-storage relocation. These tools
  // do not create new execution ownership or dispatch new work.
  'finish_task_run',
  'cancel_task_run',
]);
const AGENT_DELEGATION_TOOLS = new Set([
  'dispatch_task',
  'launch_issue',
  'dispatch_ready_tasks',
  'retry_task_run',
  'quick_agent_session',
]);
const EXPLICIT_EXTERNAL_CONTROLLER_TOOLS = new Set([
  'publish_issue_to_github',
  'close_github_issue',
  'request_release_gate',
]);

const GATEWAY_ROUTE_BEHAVIOR_PROBES: ReadonlyArray<{
  id: string;
  operation: string;
  args: Record<string, unknown>;
}> = [
  { id: 'hot-read', operation: 'controller_ready', args: {} },
  { id: 'isolated-read-diagnostic', operation: 'workflow_watchdog_report', args: {} },
  { id: 'readonly-command', operation: 'repository_command_execute', args: { command: ['git', 'status', '--short'] } },
  { id: 'managed-local-command', operation: 'repository_command_execute', args: { command: ['bun', 'run', 'check:type'], timeout_ms: 120_000 } },
  { id: 'focused-check', operation: 'run_check', args: { check_id: 'package:check:type' } },
  { id: 'release-check', operation: 'run_check', args: { check_id: 'package:check:release' } },
  { id: 'interactive-write', operation: 'repository_safe_patch_apply', args: { operations: [] } },
  { id: 'external-controller', operation: 'request_release_gate', args: {} },
  { id: 'unknown-tool', operation: '__route_behavior_probe_unknown__', args: {} },
];

export interface GatewayRouteBehaviorSnapshot {
  schemaVersion: 1;
  fingerprint: string;
  probeCount: number;
  probes: Array<{
    id: string;
    operation: string;
    path: 'direct' | 'fast' | 'durable' | 'reject';
    reasons: string[];
    decision?: {
      mode: string;
      risk: string;
      estimatedClass: string;
      requiresIsolation: boolean;
      requiresRecovery: boolean;
      effects: Record<string, boolean>;
    };
  }>;
}

/**
 * Fingerprint the real Gateway classifier over a fixed, bounded behavior matrix.
 * This is deliberately distinct from the MCP schema/tool-surface fingerprint.
 */
export function gatewayRouteBehaviorSnapshot(): GatewayRouteBehaviorSnapshot {
  const probes = GATEWAY_ROUTE_BEHAVIOR_PROBES.map((probe) => {
    const classification = classifyGatewayExecutionPath(probe.operation, probe.args);
    return {
      id: probe.id,
      operation: probe.operation,
      path: classification.path,
      reasons: [...classification.reasons],
      ...(classification.decision ? {
        decision: {
          mode: classification.decision.mode,
          risk: classification.decision.risk,
          estimatedClass: classification.decision.estimatedClass,
          requiresIsolation: classification.decision.requiresIsolation,
          requiresRecovery: classification.decision.requiresRecovery,
          effects: { ...classification.decision.effects },
        },
      } : {}),
    };
  });
  return {
    schemaVersion: 1,
    fingerprint: createHash('sha256').update(JSON.stringify(probes)).digest('hex'),
    probeCount: probes.length,
    probes,
  };
}
const MAX_DURABLE_TIMEOUT_MS = 24 * 60 * 60_000;

function durableTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1_000, Math.min(Math.trunc(value), MAX_DURABLE_TIMEOUT_MS));
}

function wantsAsyncExecution(args: Record<string, unknown>): boolean {
  return args.apply_mode === 'async'
    || args.mode === 'async'
    || args.mode === 'durable'
    || args.async === true
    || args.background === true;
}

/** Release checks cross the external Controller boundary when explicitly
 * requested asynchronously; ordinary checks remain Process-Runtime local. */
function isReleaseCheckId(value: unknown): boolean {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return id === 'check:release' || id === 'package:check:release';
}

export function runsAsInteractiveSyncWrite(
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  return INTERACTIVE_SYNC_WRITE_TOOLS.has(name) && !wantsAsyncExecution(args);
}

export function wantsWaitForResult(args: Record<string, unknown>): boolean {
  return args.wait === true
    || args.await_result === true
    || args.wait_for_result === true;
}

export function waitTimeoutMs(args: Record<string, unknown>): number {
  const explicitInteractiveWait = args.interactive_wait_ms ?? args.wait_ms;
  if (typeof explicitInteractiveWait === 'number' && Number.isFinite(explicitInteractiveWait)) {
    return Math.max(200, Math.min(Math.trunc(explicitInteractiveWait), 120_000));
  }
  if (typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) && wantsWaitForResult(args)) {
    return Math.max(200, Math.min(Math.trunc(args.timeout_ms), 120_000));
  }
  return 15_000;
}

export function operationExecutionTimeoutMsForMcpCall(
  name: string,
  args: Record<string, unknown>,
): number {
  const requested = args.execution_timeout_ms ?? args.timeout_ms;
  return durableTimeoutMs(requested, AGENT_DELEGATION_TOOLS.has(name) ? 60 * 60_000 : 15 * 60_000);
}

/**
 * Build independent budgets for the durable Parent Job. Agent delegation keeps
 * the caller's operation execution budget on the Child Run; the Parent only
 * receives enough execution time to create and durably associate that child.
 */
export function executionTimeoutPolicyForMcpCall(
  name: string,
  args: Record<string, unknown>,
): ExecutionTimeoutPolicy {
  const operationExecutionMs = operationExecutionTimeoutMsForMcpCall(name, args);
  const agentDelegation = AGENT_DELEGATION_TOOLS.has(name);
  return {
    admissionTimeoutMs: durableTimeoutMs(
      args.admission_timeout_ms,
      agentDelegation ? 5 * 60_000 : operationExecutionMs,
    ),
    queueTimeoutMs: durableTimeoutMs(
      args.queue_timeout_ms,
      agentDelegation ? MAX_DURABLE_TIMEOUT_MS : operationExecutionMs,
    ),
    executionTimeoutMs: agentDelegation ? 120_000 : operationExecutionMs,
    interactiveWaitMs: waitTimeoutMs(args),
  };
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
export function classifyGatewayExecutionPath(
  name: string,
  args: Record<string, unknown> = {},
  opts: { allowReadOnly?: boolean; forceDurable?: boolean; definition?: McpToolDefinition } = {},
): {
  path: 'direct' | 'fast' | 'durable' | 'reject';
  reasons: string[];
  decision?: ExecutionDecision;
} {
  // Heavy read-only diagnostics must leave the Gateway event loop before the
  // generic read-only shortcut. Process Runtime preserves the same request and
  // returns either the completed JSON or a queryable process handle.
  if (isProcessIsolatedReadDiagnostic(name)) {
    return { path: 'fast', reasons: ['isolated_read_diagnostic_process'] };
  }
  // Registered bounded reads execute through their real handler.
  if (opts.definition?.annotations?.readOnlyHint === true) {
    return { path: 'direct', reasons: ['registered_readonly_tool'] };
  }
  if (name.startsWith('repository_') && DIRECT_REPOSITORY_TOOLS.has(name)) {
    return { path: 'direct', reasons: ['direct_repository_tool'] };
  }
  if (isDirectHotReadTool(name)) {
    return { path: 'direct', reasons: ['direct_hot_read'] };
  }
  if (runsAsInteractiveSyncWrite(name, args)) {
    return { path: 'direct', reasons: ['interactive_sync_write'] };
  }
  if (isSelfManagedDurableTool(name)) {
    return { path: 'direct', reasons: ['self_managed_durable_boundary'] };
  }
  if (DIRECT_CONTROL_WRITE_TOOLS.has(name) && !wantsAsyncExecution(args)) {
    return { path: 'direct', reasons: ['bounded_direct_control_write'] };
  }
  if (EXPLICIT_EXTERNAL_CONTROLLER_TOOLS.has(name)) {
    return { path: 'durable', reasons: ['explicit_external_controller_boundary'] };
  }
  if (opts.forceDurable === true || isGatewayIsolatedTool(name)) {
    return {
      path: 'durable',
      reasons: opts.forceDurable ? ['force_durable'] : ['gateway_isolated_tool'],
    };
  }
  const selfManagedProcessAsync = (
    name === 'repository_command_execute'
    || name === 'run_check'
    || name === 'verify_edit_session'
  ) && (
    args.apply_mode === 'async'
    || args.mode === 'async'
    || args.async === true
    || args.background === true
  ) && !(name === 'run_check' && isReleaseCheckId(args.check_id ?? args.checkId));
  // Async on Process-Runtime-owned tools means return the managed Process
  // handle immediately. It must not promote local work into the retired
  // ExecutionJob path. Explicit durable mode still crosses the external
  // Controller boundary.
  if (wantsAsyncExecution(args) && !selfManagedProcessAsync) {
    return {
      path: 'durable',
      reasons: ['caller_requested_async_or_durable'],
    };
  }
  // run_check: Process Runtime for ordinary checks; Durable only for release/multi-phase.
  if (name === 'run_check') {
    const checkId = String(args.check_id ?? args.checkId ?? '').trim();
    const batchCheckIds = Array.isArray(args.check_ids)
      ? args.check_ids.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (args.mode === 'durable' || args.force_durable === true) {
      return { path: 'durable', reasons: ['caller_requested_durable_check'] };
    }
    if (isReleaseCheckId(checkId) && batchCheckIds.length === 0) {
      return { path: 'durable', reasons: ['release_check_requires_durable_boundary'] };
    }
    // Gateway owns transport placement, not Check lifecycle semantics. Until
    // the registered ControllerCheck is resolved by the Check owner below,
    // never infer Durable handling from a caller-provided id string.
    // Route as "fast" so shouldCreateDurableJob returns false; actual execution
    // uses Process Runtime (direct or managed handle) in routeDurableMcpCall / legacy handler.
    return {
      path: 'fast',
      reasons: ['run_check_process_runtime'],
      decision: {
        mode: 'fast',
        reasons: ['run_check_process_runtime'],
        risk: 'workspace_write',
        estimatedClass: 'short',
        requiresIsolation: false,
        requiresRecovery: false,
        effects: {
          readsWorkspace: true,
          mutatesWorkspace: true,
          mutatesGitRefs: false,
          remoteWrite: false,
        },
      },
    };
  }

  // verify_edit_session is a Process Runtime orchestration surface. It may
  // return a managed handle, but it must never be promoted to a retired
  // ExecutionJob/LocalJob merely because the edit session has checks.
  if (name === 'verify_edit_session') {
    if (args.mode === 'durable' || args.force_durable === true) {
      return { path: 'durable', reasons: ['caller_requested_durable_edit_verification'] };
    }
    return {
      path: 'fast',
      reasons: ['verify_edit_session_process_runtime'],
      decision: {
        mode: 'fast',
        reasons: ['verify_edit_session_process_runtime'],
        risk: 'workspace_write',
        estimatedClass: 'short',
        requiresIsolation: false,
        requiresRecovery: false,
        effects: {
          readsWorkspace: true,
          mutatesWorkspace: true,
          mutatesGitRefs: false,
          remoteWrite: false,
        },
      },
    };
  }

  // repository_command_execute has one authoritative classifier. Process Runtime
  // owns every local single-process command regardless of timeout. Async requests
  // stay here and return a handle; explicit durable mode remains an external-
  // Controller boundary.
  if (name === 'repository_command_execute') {
    const command = args.command;
    if (!(typeof command === 'string' || Array.isArray(command))) {
      return { path: 'reject', reasons: ['repository_command_missing'] };
    }
    const route = classifyRepositoryCommandRoute(command as string | string[], {
      defaultBranch: typeof args.default_branch === 'string' ? args.default_branch : undefined,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    });
    if (route.route === 'process_direct' || route.route === 'process_managed') {
      const commandClassification = classifyRepositoryCommand(
        command as string | string[],
        typeof args.default_branch === 'string' ? args.default_branch : undefined,
      );
      const risk = commandClassification.risk === 'readonly'
        ? 'readonly'
        : commandClassification.risk === 'remote_write'
          ? 'remote_write'
          : commandClassification.risk === 'destructive'
            ? 'destructive'
            : 'workspace_write';
      const reasons = ['repository_command_process_runtime', route.reason];
      return {
        path: 'fast',
        reasons,
        decision: {
          mode: 'fast',
          reasons,
          risk,
          estimatedClass: route.route === 'process_direct' ? 'short' : 'long',
          requiresIsolation: false,
          requiresRecovery: false,
          effects: {
            readsWorkspace: true,
            mutatesWorkspace: risk !== 'readonly',
            mutatesGitRefs: risk !== 'readonly' && /(?:^|\s)git\s+(?:commit|merge|branch|switch|checkout|reset|rebase|tag)\b/i.test(
              Array.isArray(command) ? command.join(' ') : command,
            ),
            remoteWrite: risk === 'remote_write',
          },
        },
      };
    }
    if (route.route === 'reject') return { path: 'reject', reasons: [route.reason] };
    return { path: 'durable', reasons: [route.reason] };
  }

  if (THIN_ROUTED_TOOLS.has(name)) {
    const decision = routeExecution({
      operation: name,
      mode: args.mode === 'fast' ? 'fast' : 'auto',
      background: args.background === true || args.apply_mode === 'async' || args.async === true,
      requiresRecovery: args.requires_recovery === true,
      requiresIsolation: args.isolation === 'new_worktree' || args.requires_isolation === true,
      requiresWorktree: args.isolation === 'new_worktree',
      agentRun: name === 'quick_agent_session' || name === 'dispatch_task',
      remoteWrite: name.includes('push') || name === 'publish_issue_to_github',
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      command: args.command as string | string[] | undefined,
      paths: Array.isArray(args.paths) ? args.paths.map(String) : undefined,
      allowedPaths: Array.isArray(args.allowed_paths) ? args.allowed_paths.map(String) : undefined,
      patchOperationCount: Array.isArray(args.operations) ? args.operations.length : undefined,
      patchPaths: Array.isArray(args.operations)
        ? args.operations
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .map((entry) => String(entry.path ?? '').trim())
          .filter(Boolean)
        : undefined,
    });
    if (decision.mode === 'fast') {
      return {
        path: 'fast',
        reasons: decision.reasons,
        decision,
      };
    }
    if (decision.mode === 'reject') {
      return { path: 'reject', reasons: decision.reasons, decision };
    }
    // Keep isFastEligibleTool as a secondary guard for tools whose operation
    // name maps to a Fast allowlist entry but routeExecution used a durable alias.
    if (isFastEligibleTool(name, args)) {
      return {
        path: 'fast',
        reasons: ['thin_router_fast_eligible'],
      };
    }
    return {
      path: 'durable',
      reasons: decision.reasons.length > 0 ? decision.reasons : ['thin_router_requires_durable'],
      decision,
    };
  }
  if (opts.definition) {
    return { path: 'direct', reasons: ['registered_tool_direct_handler'] };
  }
  return { path: 'reject', reasons: ['tool_not_found'] };
}

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
