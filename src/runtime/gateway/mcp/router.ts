import { createHash } from 'crypto';
import type { CallToolResult, McpToolDefinition } from '../../../cli/mcp/tools';
import {
  buildMultiRepositoryToolDefinitions,
  type MultiRepositoryMcpToolContext,
} from '../../../cli/mcp/multi-repository';
import { callRepositoryTool, repositoryToolDefinitions } from '../../../cli/mcp/repository-tools';
import { runtimeToolDefinitions } from './runtime-tools';
import { executionToolDefinitions } from './execution-tools';
import { processToolDefinitions } from './process-tools';
import { resolveRepositorySelection } from '../../../cli/repositories/registry';
import { executionIdentityForRepository } from '../../control-plane/execution/execution-identity';
import { startOrJoinEditValidation } from '../../control-plane/execution/edit-validation-coordinator';
import type {
  ExecutionOperationMetadata,
  ExecutionTimeoutPolicy,
} from '../../execution/jobs/types';
import { claimsForMcpOperation } from './resource-policy';
import { classifyRepositoryCommand, classifyRepositoryCommandReplay } from '../../../cli/repositories/command-classifier';
import {
  isFastEligibleTool,
  routeExecution,
  type ExecutionDecision,
} from '../../execution/thin-harness';
import {
  checkRequiresDurableWorkflow,
  classifyRepositoryCommandRoute,
} from '../../execution/process-runtime';
import { runPersistedCheckViaProcessRuntime } from './persisted-check-process';
import {
  isProcessIsolatedReadDiagnostic,
  runReadOnlyDiagnosticViaProcessRuntime,
} from '../../diagnostics/process-facade';

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
const DIRECT_CONTROL_WRITE_TOOLS = new Set(['runtime_maintenance_apply']);

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

/** Tools that already own their direct-read versus durable-write boundary. */
const SELF_MANAGED_DURABLE_TOOLS = new Set(['plugin_action_execute']);

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
  'controller_context_pack',
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
  'promote_candidate_finding',
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
  return [...runtimeToolDefinitions, ...executionToolDefinitions, ...processToolDefinitions, ...repositoryToolDefinitions, ...buildMultiRepositoryToolDefinitions(ctx)]
    .find((tool) => tool.name === name);
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
  if (wantsAsyncExecution(args)) {
    return {
      path: 'durable',
      reasons: ['caller_requested_async_or_durable'],
    };
  }
  // run_check: Process Runtime for ordinary checks; Durable only for release/multi-phase.
  if (name === 'run_check') {
    const checkId = String(args.check_id ?? args.checkId ?? '').trim();
    if (args.apply_mode === 'async' || args.mode === 'durable' || args.force_durable === true) {
      return { path: 'durable', reasons: ['caller_requested_durable_check'] };
    }
    if (checkId && checkRequiresDurableWorkflow(checkId)) {
      return { path: 'durable', reasons: ['multi_phase_or_release_check'] };
    }
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
    if (args.apply_mode === 'async' || args.mode === 'durable' || args.force_durable === true) {
      return { path: 'durable', reasons: ['caller_requested_durable_edit_verification'] };
    }
    const checkIds = Array.isArray(args.check_ids)
      ? args.check_ids.map(String).map((entry) => entry.trim()).filter(Boolean)
      : [];
    if (checkIds.some((checkId) => checkRequiresDurableWorkflow(checkId))) {
      return { path: 'durable', reasons: ['multi_phase_or_release_edit_check'] };
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
  // owns every local single-process command regardless of timeout; explicit
  // async/durable requests were handled above and remain external-controller work.
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

export function operationMetadataForTool(
  name: string,
  definition: McpToolDefinition,
  claims: ReturnType<typeof claimsForMcpOperation>,
  timeoutMs: number,
  args: Record<string, unknown> = {},
  defaultBranch?: string,
  timeoutPolicy?: ExecutionTimeoutPolicy,
): ExecutionOperationMetadata {
  if (name === 'repository_command_execute' && args.command !== undefined) {
    const classification = classifyRepositoryCommand(args.command as string | string[], defaultBranch);
    const replay = classifyRepositoryCommandReplay(args.command as string | string[], defaultBranch);
    const mode = classification.risk === 'readonly'
      ? 'readonly'
      : classification.risk === 'remote_write'
        ? 'remote_write'
        : classification.risk === 'destructive'
          ? 'destructive'
          : 'mutating';
    return {
      mode,
      idempotent: replay.idempotent,
      replayable: replay.replayable,
      timeoutMs,
      admissionTimeoutMs: timeoutPolicy?.admissionTimeoutMs,
      queueTimeoutMs: timeoutPolicy?.queueTimeoutMs,
      executionTimeoutMs: timeoutPolicy?.executionTimeoutMs,
      interactiveWaitMs: timeoutPolicy?.interactiveWaitMs,
      retryPolicy: replay.retryPolicy,
      approvalPolicy: classification.risk === 'readonly'
        ? 'none'
        : classification.risk === 'destructive' ? 'required' : 'request',
      lockScope: claims.map((claim) => claim.resourceKey),
      resourceClaims: claims,
    };
  }
  const destructive = definition.annotations?.destructiveHint === true;
  const remoteWrite = claims.some((claim) => claim.resourceKey.startsWith('remote:'));
  const readOnly = definition.annotations?.readOnlyHint === true || claims.length === 0;
  const mode = destructive
    ? 'destructive'
    : remoteWrite
      ? 'remote_write'
      : readOnly
        ? 'readonly'
        : 'mutating';
  return {
    mode,
    idempotent: readOnly,
    replayable: readOnly,
    timeoutMs,
    admissionTimeoutMs: timeoutPolicy?.admissionTimeoutMs,
    queueTimeoutMs: timeoutPolicy?.queueTimeoutMs,
    executionTimeoutMs: timeoutPolicy?.executionTimeoutMs,
    interactiveWaitMs: timeoutPolicy?.interactiveWaitMs,
    retryPolicy: readOnly ? 'safe_retry' : 'idempotent_request',
    approvalPolicy: destructive ? 'required' : remoteWrite || !readOnly ? 'request' : 'none',
    lockScope: claims.map((claim) => claim.resourceKey),
    resourceClaims: claims,
  };
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

async function runEditSessionValidationViaProcessRuntime(
  ctx: MultiRepositoryMcpToolContext,
  repository: NonNullable<ReturnType<typeof resolveRepositorySelection>>,
  editSessionId: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const validation = await startOrJoinEditValidation(ctx.controllerHome, repository, {
    editSessionId,
    checkIds: Array.isArray(args.check_ids) ? args.check_ids.map(String) : undefined,
    requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
    validationRequestId: typeof args.validation_request_id === 'string' ? args.validation_request_id : undefined,
    reviewer: typeof args.reviewer === 'string' ? args.reviewer : undefined,
    note: typeof args.note === 'string' ? args.note : undefined,
    timeoutMs: typeof args.check_timeout_ms === 'number'
      ? args.check_timeout_ms
      : typeof args.timeout_ms === 'number'
        ? args.timeout_ms
        : undefined,
    leaseWaitMs: typeof args.lease_wait_ms === 'number' ? args.lease_wait_ms : undefined,
  });
  return result(validation as unknown as Record<string, unknown>, validation.accepted === false);
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

  if (classification.path === 'durable' && executionJobCreationRetired()) {
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

  if (isProcessIsolatedReadDiagnostic(name) && classification.path === 'fast') {
    const repository = resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
    });
    if (!repository) {
      return result({
        accepted: false,
        mode: 'reject',
        path: 'reject',
        message: `${name} requires a resolvable repository`,
      }, true);
    }
    try {
      const payload = await runReadOnlyDiagnosticViaProcessRuntime({
        controllerHome: ctx.controllerHome,
        repository,
        tool: name,
        args: {
          ...args,
          __diagnostic_toolset: ctx.toolset,
          __diagnostic_profile: ctx.policy.profile,
        },
      });
      return result(payload, payload.accepted === false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'DIAGNOSTIC_PROCESS_FAILED';
      return result({
        accepted: false,
        mode: 'process_direct',
        path: 'process_direct',
        error: { code, message },
        durableSideEffects: {
          executionJobCount: 0,
          localJobCount: 0,
          workerSpawnCount: 0,
          projectionUpdateCount: 0,
        },
      }, true);
    }
  }

  // Edit-session verification uses the same resource-aware Process Runtime
  // coordinator as the stable Direct Edit composite below.
  if (name === 'verify_edit_session' && classification.path === 'fast') {
    const repository = resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
    });
    if (!repository) {
      return result({ accepted: false, mode: 'reject', path: 'reject', message: 'verify_edit_session requires a resolvable repository' });
    }
    const editSessionId = String(args.session_id ?? '').trim();
    if (!editSessionId) {
      return result({ accepted: false, mode: 'reject', path: 'reject', message: 'verify_edit_session requires session_id' });
    }
    return runEditSessionValidationViaProcessRuntime(ctx, repository, editSessionId, args);
  }

  // Stable Direct Edit composite: checks are opt-in. Without check_ids this
  // tool remains the ordinary synchronous patch path. With check_ids, the same
  // call applies one coherent edit batch, returns its review evidence, and
  // starts revision-bound validation without waiting on long checks.
  if (name === 'repository_safe_patch_apply' && classification.path === 'direct'
    && (args.validation_only === true || (Array.isArray(args.check_ids) && args.check_ids.length > 0))) {
    const repository = resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
    });
    if (!repository) {
      return result({ accepted: false, mode: 'reject', path: 'reject', message: 'repository_safe_patch_apply requires a resolvable repository' }, true);
    }

    if (args.validation_only === true) {
      const editSessionId = String(args.session_id ?? '').trim();
      if (!editSessionId) {
        return result({ accepted: false, mode: 'reject', path: 'reject', message: 'validation_only requires session_id' }, true);
      }
      const validation = await runEditSessionValidationViaProcessRuntime(ctx, repository, editSessionId, args);
      const validationPayload = (validation.structuredContent ?? {}) as Record<string, unknown>;
      return result({
        operation: 'repository_safe_patch_apply',
        validationOnly: true,
        sessionId: editSessionId,
        validation: validationPayload,
        validationRequestId: validationPayload.validationRequestId,
        completed: validationPayload.completed === true,
        ok: validationPayload.ok,
        acceptanceReady: validationPayload.completed === true && validationPayload.ok === true,
        next: validationPayload.completed === true
          ? validationPayload.ok === true
            ? 'Validation passed for the exact edit revision; delivery may proceed if policy and semantic review are satisfied.'
            : 'Validation completed with failures; return the failure evidence to ChatGPT for repair reasoning.'
          : validationPayload.next,
      }, validation.isError === true);
    }

    const applied = await callRepositoryTool(ctx.controllerHome, name, args);
    if (!applied || applied.isError === true) return applied;
    const patchPayload = (applied.structuredContent ?? {}) as Record<string, unknown>;
    if (patchPayload.status !== 'applied') return applied;
    const session = patchPayload.session && typeof patchPayload.session === 'object'
      ? patchPayload.session as Record<string, unknown>
      : undefined;
    const editSessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
    if (!editSessionId) return applied;
    const validation = await runEditSessionValidationViaProcessRuntime(ctx, repository, editSessionId, args);
    const validationPayload = (validation.structuredContent ?? {}) as Record<string, unknown>;
    const validationCompleted = validationPayload.completed === true;
    const validationPassed = validationCompleted && validationPayload.ok === true;
    return result({
      ...patchPayload,
      validation: validationPayload,
      validationStarted: true,
      validationCompleted,
      validationPassed,
      acceptanceReady: validationPassed,
      validationRequestId: validationPayload.validationRequestId,
      next: validationCompleted
        ? validationPassed
          ? 'Patch review evidence and requested validation are complete; proceed to delivery only after ChatGPT semantic review is satisfied.'
          : 'Patch applied but validation failed; return the failure evidence to ChatGPT before any delivery.'
        : validationPayload.next,
    }, validation.isError === true);
  }

  // run_check Process Runtime facade — execute here so legacy LocalBridgeJob path is skipped.
  if (name === 'run_check' && classification.path === 'fast') {
    const restoringDisabledRepository = false;
    void restoringDisabledRepository;
    const repository = resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
    });
    if (!repository) {
      return result({
        accepted: false,
        mode: 'reject',
        path: 'reject',
        message: 'run_check requires a resolvable repository',
      });
    }
    const checkId = String(args.check_id ?? '').trim();
    if (!checkId) {
      return result({
        accepted: false,
        mode: 'reject',
        path: 'reject',
        message: 'run_check requires check_id',
      });
    }
    const facade = await runPersistedCheckViaProcessRuntime({
      controllerHome: ctx.controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot: repository.canonicalRoot,
      executionIdentity: executionIdentityForRepository(repository),
      checkId,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      interactiveWaitMs: typeof args.interactive_wait_ms === 'number' ? args.interactive_wait_ms : undefined,
      requestId: typeof args.request_id === 'string' ? args.request_id : undefined,
      forceDurable: args.force_durable === true,
    });
    if (facade.mode === 'durable') {
      // Multi-phase/release should already be classified durable. Remaining durable
      // reasons (missing check, explicit force) must not silently create empty jobs
      // without a clear signal — return structured escalation instead of LocalBridge.
      return result({
        accepted: false,
        mode: 'durable',
        path: 'durable',
        routing: {
          path: 'durable',
          reasons: [facade.durable?.reason ?? 'check_requires_durable'],
        },
        checkId: facade.checkId,
        message: facade.durable?.reason ?? 'check requires durable workflow',
        suggestedOperation: facade.durable?.suggestedOperation,
        durableSideEffects: facade.durableSideEffects,
      });
    }
    const handle = facade.process;
    return result({
      accepted: true,
      mode: facade.mode,
      path: facade.mode === 'direct' ? 'process_direct' : 'process_managed',
      routing: {
        path: facade.mode,
        reasons: classification.reasons,
      },
      checkId: facade.checkId,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      processId: handle?.processId,
      status: handle?.status,
      completed: handle?.completed === true,
      deduplicated: handle?.deduplicated === true,
      semanticDeduplicated: handle?.semanticDeduplicated === true,
      ok: handle?.ok,
      exitCode: handle?.exitCode,
      timedOut: handle?.timedOut,
      stdout: handle?.stdout,
      stderr: handle?.stderr,
      durableSideEffects: facade.durableSideEffects,
      next: handle?.completed
        ? 'Check finished on Process Runtime without ExecutionJob / LocalBridgeJob / Worker.'
        : `Check still running as managed process ${handle?.processId}. Continue independent work; use process_wait once when this result becomes a real dependency. Do not re-run or repeatedly poll the same check.`,
    });
  }

  // Durable classifications have already returned the explicit external-controller
  // handoff above. All remaining tools are direct, fast, or self-managed and must
  // not retain a dormant ExecutionJob creation branch.
  return undefined;
}
