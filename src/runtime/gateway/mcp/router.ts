import { createHash } from 'crypto';
import type { CallToolResult, McpToolDefinition } from '../../../cli/mcp/tools';
import {
  buildMultiRepositoryToolDefinitions,
  type MultiRepositoryMcpToolContext,
} from '../../../cli/mcp/multi-repository';
import { repositoryToolDefinitions } from '../../../cli/mcp/repository-tools';
import { runtimeToolDefinitions } from './runtime-tools';
import { executionToolDefinitions } from './execution-tools';
import { processToolDefinitions } from './process-tools';
import { resolveRepositorySelection } from '../../../cli/repositories/registry';
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
  runCheckViaProcessRuntime,
} from '../../execution/process-runtime';

const DIRECT_REPOSITORY_TOOLS = new Set(['repository_list', 'repository_get', 'repository_workbench', 'repository_command_preview']);
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
  // run_check uses Process Runtime unless multi-phase/release requires Durable.
  'run_check',
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
  'repository_git_commit',
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

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
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
  opts: { allowReadOnly?: boolean; forceDurable?: boolean } = {},
): {
  path: 'direct' | 'fast' | 'durable' | 'reject';
  reasons: string[];
  decision?: ExecutionDecision;
} {
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

  if (THIN_ROUTED_TOOLS.has(name) || name === 'repository_command_execute') {
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
  return { path: 'durable', reasons: ['default_durable_for_mutating_or_unknown_tool'] };
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
  if (isSelfManagedDurableTool(name)) return false;
  if (opts.forceDurable === true || isGatewayIsolatedTool(name)) return true;
  if (name.startsWith('repository_') && DIRECT_REPOSITORY_TOOLS.has(name)) return false;
  if (definition.annotations?.readOnlyHint === true && opts.allowReadOnly !== true) return false;
  if (isDirectHotReadTool(name)) return false;
  // Interactive development path: sync by default unless caller opts into async queueing.
  if (runsAsInteractiveSyncWrite(name, args)) return false;
  // Thin Harness classification must happen before ExecutionJob creation.
  const classification = classifyGatewayExecutionPath(name, args, opts);
  if (classification.path === 'fast' || classification.path === 'direct' || classification.path === 'reject') {
    return false;
  }
  return true;
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
          description: 'Idempotency key. Retries with the same request_id return the original durable Job.',
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
  if (!definition) return undefined;

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
  const classification = classifyGatewayExecutionPath(name, args, opts);
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
    });
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
    const facade = await runCheckViaProcessRuntime({
      controllerHome: ctx.controllerHome,
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      repoRoot: repository.canonicalRoot,
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
      ok: handle?.ok,
      exitCode: handle?.exitCode,
      timedOut: handle?.timedOut,
      stdout: handle?.stdout,
      stderr: handle?.stderr,
      durableSideEffects: facade.durableSideEffects,
      next: handle?.completed
        ? 'Check finished on Process Runtime without ExecutionJob / LocalBridgeJob / Worker.'
        : `Check still running as managed process ${handle?.processId}. Poll work_status_digest with work_ref=${handle?.processId}; do not re-run the same check.`,
    });
  }

  // Durable classifications have already returned the explicit external-controller
  // handoff above. All remaining tools are direct, fast, or self-managed and must
  // not retain a dormant ExecutionJob creation branch.
  return undefined;
}
