/**
 * execute_command → three explicit execution lanes.
 *
 * - Ephemeral Direct: bounded ordinary reads and commands that finish inside
 *   the interactive budget.
 * - Lightweight Managed: the same local command remains alive in memory and
 *   returns a bounded handle, without SQLite, Lease, or recovery membership.
 * - Durable: explicit Work/external/release boundaries only.
 */

import {
  commandExecutionScopeKey,
  type RepositoryCommandScopeTarget,
} from '../../../cli/repositories/command-scope';
import { classifyRepositoryCommand, fixedShellWrapperCommand } from '../../../cli/repositories/command-classifier';
import {
  executeRepositoryCommandAsync,
  executeRepositoryReadOnlyCommandDirect,
  REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS,
  type RepositoryCommandExecution,
} from '../../../cli/repositories/command-executor';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import {
  assertRepositoryCommandNoPluginExecutionBypass,
  assertRepositoryCommandStableHostIdentity,
} from '../../../cli/repositories/command-scope';
import { claimsForRepositoryCommand, claimsRequireLiveDeviceAdmission, LIVE_DEVICE_ADMISSION_WAIT_MS, looksLikeBuildOrTest, scopeResourceClaims, toProcessClaims } from './resource-claims';
import {
  spawnWithQueuedAdmission,
  getProcessHandle,
  waitForProcess,
  cancelProcess,
  readProcessLogs,
} from './runtime';
import type { ProcessHandle, ProcessCommandSpec } from './types';
import { DEFAULT_INTERACTIVE_WAIT_MS } from './types';
import { durationAwareInteractiveWaitMs } from './interactive-admission';
import { assertExecutionIdentity, type ResolvedExecutionIdentity } from '../../control-plane/execution/execution-identity';
import {
  cancelLightweightProcess,
  getLightweightProcessHandle,
  getLightweightProcessHandleByCommandId,
  isLightweightProcessId,
  lightweightProcessScopeKey,
  readLightweightProcessLogs,
  startLightweightRepositoryCommand,
  waitForLightweightProcess,
} from './lightweight-managed';
import { isForgeInstanceProcessScopeKey, processScopeKeyForHandle } from './process-scope';
import { getProcessRequestBinding } from './store';

export type RepositoryCommandRoute =
  | 'process_direct'
  | 'process_managed'
  | 'durable'
  | 'reject';

export interface RepositoryCommandProcessInput {
  controllerHome: string;
  /** Repository identity is optional: an arbitrary workspace target carries a workspace scope key. */
  repository: RepositoryCommandScopeTarget;
  command: string | readonly string[];
  /** Model-declared repository-relative paths/directories this command may mutate. */
  mutationPaths?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  maxOutputBytes?: number;
  /** Force an explicit external/durable workflow boundary. */
  forceDurable?: boolean;
  /** Return a Process handle immediately without changing execution architecture. */
  returnHandleImmediately?: boolean;
  requestId?: string;
  commandId?: string;
  /** Authenticated principal recorded with the process handle for principal-bound attachment. */
  principalId?: string;
  signal?: AbortSignal;
  /** Explicit unregistered local workspace authority; never inferred from cwd. */
  allowNonGitWorkspace?: boolean;
  /** Immutable resolved identity — required; never inferred from main/active/cwd. */
  executionIdentity: ResolvedExecutionIdentity;
}

export interface RepositoryCommandProcessResult {
  route: RepositoryCommandRoute;
  reason?: string;
  process?: ProcessHandle;
  /** Present for completed direct/managed handles. */
  ok?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  executionStatus?: RepositoryCommandExecution['status'];
  policyDecision?: RepositoryCommandExecution['policyDecision'];
  authorizationDecision?: RepositoryCommandExecution['authorizationDecision'];
  approvalRequestId?: string;
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
  suggestedOperation?: string;
  externalEffect?: {
    outcome: 'not_started' | 'outcome_unknown';
    replayPolicy: 'never_auto_retry';
    reconciliation: string;
  };
  executionMetrics?: {
    lane: 'ephemeral_direct' | 'lightweight_managed' | 'durable_process' | 'durable_external';
    preSpawnHarnessMs?: number;
    childDurationMs?: number;
    interactiveReturnMs?: number;
    durableWrites: number;
    leaseOperations: number;
  };
}

const emptyEffects = {
  executionJobCount: 0,
  localJobCount: 0,
  workerSpawnCount: 0,
  projectionUpdateCount: 0,
};

const STANDALONE_RECOVERY_LIFECYCLE_COMMANDS = new Set([
  'restart-runtime',
  'restart-connector',
  'prepare-runtime-release-session',
  'recover',
  'rollback',
  'restart',
  'activate-runtime',
  'install',
]);

function commandBasename(value: string): string {
  return value.split(/[\\/]/).pop()?.toLowerCase() ?? '';
}

function recoveryLifecycleFromArgv(executable: string, args: readonly string[]): string | undefined {
  const executableName = commandBasename(executable);
  let recoveryArgs: readonly string[];
  if (executableName === 'forge' || executableName === 'forge.mjs') {
    recoveryArgs = args;
  } else if (['bun', 'node', 'nodejs'].includes(executableName)) {
    const scriptIndex = args.findIndex((arg) => {
      const name = commandBasename(arg);
      return name === 'forge' || name === 'forge.mjs';
    });
    if (scriptIndex < 0) return undefined;
    recoveryArgs = args.slice(scriptIndex + 1);
  } else {
    return undefined;
  }
  if (recoveryArgs[0] !== 'recovery') return undefined;
  const subcommand = recoveryArgs[1]?.toLowerCase();
  return subcommand && STANDALONE_RECOVERY_LIFECYCLE_COMMANDS.has(subcommand) ? subcommand : undefined;
}

function recoveryLifecycleFromShell(shellCommand: string): string | undefined {
  const match = /^\s*(?:exec\s+)?(?:(?:\S*[\\/])?(?:bun|node|nodejs)\s+)?(?:\S*[\\/])?forge(?:\.mjs)?\s+recovery\s+([a-z-]+)\b/i.exec(shellCommand);
  const subcommand = match?.[1]?.toLowerCase();
  return subcommand && STANDALONE_RECOVERY_LIFECYCLE_COMMANDS.has(subcommand) ? subcommand : undefined;
}

function repositoryCommandRecoveryLifecycle(command: string | readonly string[]): string | undefined {
  const normalized = normalizeRepositoryCommand(command);
  if (normalized.kind === 'shell') return recoveryLifecycleFromShell(normalized.shellCommand ?? '');
  const direct = recoveryLifecycleFromArgv(normalized.executable ?? '', normalized.args ?? []);
  if (direct) return direct;
  const argv = normalized.value as string[];
  const wrapped = fixedShellWrapperCommand(argv);
  return wrapped ? recoveryLifecycleFromShell(wrapped) : undefined;
}

function toProcessCommand(command: string | readonly string[], cwd: string): ProcessCommandSpec {
  const normalized = normalizeRepositoryCommand(command);
  if (normalized.kind === 'argv') {
    return {
      kind: 'argv',
      executable: normalized.executable,
      args: [...(normalized.args ?? [])],
      cwd,
    };
  }
  return {
    kind: 'shell',
    shellCommand: normalized.shellCommand ?? String(command),
    cwd,
  };
}

/**
 * Decide Direct / Managed / Durable without spawning.
 */
export function classifyRepositoryCommandRoute(
  command: string | readonly string[],
  options: {
    forceDurable?: boolean;
    defaultBranch?: string;
    timeoutMs?: number;
    mutationPaths?: readonly string[];
  } = {},
): { route: RepositoryCommandRoute; reason: string } {
  if (repositoryCommandRecoveryLifecycle(command)) {
    return { route: 'reject', reason: 'standalone_recovery_lifecycle_required' };
  }
  if (options.forceDurable) {
    return { route: 'durable', reason: 'force_durable_or_async' };
  }
  const classification = classifyRepositoryCommand(command, options.defaultBranch);
  const hasDeclaredMutationScope = Boolean(options.mutationPaths?.length);
  // Read-only observations remain lease-free unless the model explicitly says
  // the command mutates source. The declaration affects placement/claims only;
  // it never grants command authorization.
  if (classification.risk === 'readonly' && !hasDeclaredMutationScope) {
    return { route: 'process_direct', reason: 'readonly_fast_path' };
  }
  if (classification.risk === 'readonly' && hasDeclaredMutationScope) {
    return { route: 'process_managed', reason: 'model_declared_mutation_scope' };
  }
  if (classification.risk === 'remote_write' || classification.risk === 'destructive') {
    return { route: 'process_managed', reason: 'effectful_command_managed' };
  }
  return { route: 'process_managed', reason: 'workspace_write_requires_process_lease' };
}

/**
 * Execute via Unified Process Runtime when route is process_*.
 * Does not create ExecutionJob / LocalJob / Worker.
 */
export async function executeRepositoryCommandViaProcessRuntime(
  input: RepositoryCommandProcessInput,
): Promise<RepositoryCommandProcessResult> {
  // Process Runtime intentionally supports some command forms that the legacy
  // repository executor rejects (for example bounded typed eval). Keep that
  // surface, but fail closed before routing any macOS TCC-sensitive host tool:
  // a release-specific forge-runtime executable must never own those grants.
  assertRepositoryCommandStableHostIdentity(input.command);
  assertRepositoryCommandNoPluginExecutionBypass(input.command);
  const decision = classifyRepositoryCommandRoute(input.command, {
    forceDurable: input.forceDurable,
    defaultBranch: input.repository.defaultBranch,
    timeoutMs: input.timeoutMs,
    mutationPaths: input.mutationPaths,
  });
  // Only explicit lifecycle/delivery rejection or a caller-requested durable
  // mode stops here. Ordinary command effects, including remote writes, execute
  // through Process Runtime; classification does not become an authorization gate.
  if (decision.route === 'reject' || decision.route === 'durable') {
    return {
      route: decision.route,
      reason: decision.reason,
      durableSideEffects: emptyEffects,
      suggestedOperation: decision.reason === 'standalone_recovery_lifecycle_required'
        ? 'Use the standalone Forge Recovery connector for canonical Runtime/connector lifecycle operations.'
        : 'execute_command via the explicit durable/release workflow',
      externalEffect: decision.route === 'durable'
        ? {
            outcome: 'not_started',
            replayPolicy: 'never_auto_retry',
            reconciliation: 'If a separate external controller later loses the result after dispatch, report outcome_unknown and inspect remote state before any retry.',
          }
        : undefined,
      executionMetrics: { lane: 'durable_external', durableWrites: 0, leaseOperations: 0 },
    };
  }

  if (!input.executionIdentity) {
    throw new Error('EXECUTION_IDENTITY_REQUIRED: repository command process path requires an immutable executionIdentity');
  }
  const executionIdentity = input.executionIdentity;
  if (executionIdentity.repositoryId !== commandExecutionScopeKey(input.repository)) {
    throw new Error(
      `EXECUTION_IDENTITY_MISMATCH: repository ${commandExecutionScopeKey(input.repository)} differs from identity ${executionIdentity.repositoryId}`,
    );
  }
  if (executionIdentity.checkoutId !== input.repository.activeCheckoutId) {
    throw new Error(
      `CHECKOUT_ROUTE_MISMATCH: repository checkout ${input.repository.activeCheckoutId} differs from identity ${executionIdentity.checkoutId}`,
    );
  }
  const cwd = input.cwd?.trim() || executionIdentity.canonicalRoot;
  if (!cwd) {
    return {
      route: 'reject',
      reason: 'missing_repository_cwd',
      durableSideEffects: emptyEffects,
    };
  }

  const claims = scopeResourceClaims(
    claimsForRepositoryCommand(
      input.command,
      executionIdentity.repositoryId,
      executionIdentity.checkoutId,
      input.repository.defaultBranch,
      input.repository.canonicalRoot,
      cwd,
      input.mutationPaths,
    ),
    executionIdentity.repositoryId,
    executionIdentity.checkoutId,
  );
  const usesLiveDevice = claimsRequireLiveDeviceAdmission(claims);

  // Ordinary local commands own no durable Process/Lease state. Validate the
  // immutable repository identity first, then execute through the authorized
  // non-persistent repository executor. Runtime/release durability is not a
  // command-execution tax.
  if (decision.route === 'process_direct' && !usesLiveDevice) {
    assertExecutionIdentity({
      controllerHome: input.controllerHome,
      identity: executionIdentity,
      cwd,
      requestedRepoId: commandExecutionScopeKey(input.repository),
      requestedCheckoutId: input.repository.activeCheckoutId,
    });
    const directInput = {
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal,
      allowNonGitWorkspace: executionIdentity.authority === 'ephemeral_workspace',
      allowOpaqueLocalScript: decision.reason === 'lightweight_local_shell_wrapper'
        || decision.reason === 'lightweight_local_inline_interpreter',
    };
    const readonly = classifyRepositoryCommand(input.command, input.repository.defaultBranch).risk === 'readonly';
    if (readonly) {
      const interactiveWaitMs = durationAwareInteractiveWaitMs(
        input.command,
        input.returnHandleImmediately ? 0 : input.interactiveWaitMs,
        Math.min(DEFAULT_INTERACTIVE_WAIT_MS, 250),
      );
      const timeoutMs = Math.max(
        interactiveWaitMs + 1,
        Math.min(input.timeoutMs ?? REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS, 24 * 60 * 60_000),
      );
      const lightweight = await startLightweightRepositoryCommand({
        controllerHome: input.controllerHome,
        repository: input.repository,
        execution: directInput,
        readonlyDirect: true,
        interactiveWaitMs,
        timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        commandId: input.commandId ?? input.requestId,
        ...(input.principalId ? { principalId: input.principalId } : {}),
      });
      const handle = lightweight.handle;
      if (!handle.completed) {
        return {
          route: 'process_managed',
          reason: 'interactive_budget_exceeded_lightweight_handle',
          process: handle,
          durableSideEffects: emptyEffects,
          executionMetrics: lightweight.metrics,
        };
      }
      const completed = lightweight.execution;
      return {
        route: 'process_direct',
        reason: decision.reason,
        ...(completed ? {
          ok: completed.ok,
          exitCode: completed.exitCode,
          stdout: completed.stdout,
          stderr: completed.stderr,
          executionStatus: completed.status,
          policyDecision: completed.policyDecision,
          authorizationDecision: completed.authorizationDecision,
          approvalRequestId: completed.approvalRequestId,
        } : {
          ok: handle.ok,
          exitCode: handle.exitCode,
          stdout: handle.stdout,
          stderr: handle.stderr,
        }),
        durableSideEffects: emptyEffects,
        executionMetrics: { ...lightweight.metrics, lane: 'ephemeral_direct' },
      };
    }
    if (!readonly) {
      const deferLongPreparation = decision.reason === 'ephemeral_local_build_or_test';
      const interactiveWaitMs = deferLongPreparation
        ? 0
        : durationAwareInteractiveWaitMs(
            input.command,
            input.returnHandleImmediately ? 0 : input.interactiveWaitMs,
            Math.min(DEFAULT_INTERACTIVE_WAIT_MS, 250),
          );
      const timeoutMs = Math.max(
        interactiveWaitMs + 1,
        Math.min(input.timeoutMs ?? 15 * 60_000, 24 * 60 * 60_000),
      );
      const lightweight = await startLightweightRepositoryCommand({
        controllerHome: input.controllerHome,
        repository: input.repository,
        execution: directInput,
        interactiveWaitMs,
        timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        commandId: input.commandId ?? input.requestId,
        ...(input.principalId ? { principalId: input.principalId } : {}),
        deferStart: deferLongPreparation,
        reuseActiveEquivalent: deferLongPreparation,
      });
      const handle = lightweight.handle;
      return {
        route: handle.completed ? 'process_direct' : 'process_managed',
        reason: handle.completed ? decision.reason : 'interactive_budget_exceeded_lightweight_handle',
        process: handle,
        ok: handle.ok,
        exitCode: handle.exitCode,
        stdout: handle.stdout,
        stderr: handle.stderr,
        durableSideEffects: emptyEffects,
        executionMetrics: lightweight.metrics,
      };
    }
    const direct = await executeRepositoryReadOnlyCommandDirect(input.repository, directInput);
    return {
      route: 'process_direct',
      reason: decision.reason,
      ok: direct.ok,
      exitCode: direct.exitCode,
      stdout: direct.stdout,
      stderr: direct.stderr,
      executionStatus: direct.status,
      policyDecision: direct.policyDecision,
      authorizationDecision: direct.authorizationDecision,
      approvalRequestId: direct.approvalRequestId,
      durableSideEffects: emptyEffects,
      executionMetrics: { lane: 'ephemeral_direct', durableWrites: 0, leaseOperations: 0 },
    };
  }

  // An explicitly resolved ephemeral workspace has no canonical Runtime-owned
  // Process storage. Keep its bounded local source edits on the same direct
  // executor used for bounded reads instead of manufacturing a Process lease
  // that a separate Runtime authority can fence. Unknown commands remain
  // conservatively classified/authorized by the command executor; durable,
  // remote, and destructive routes never reach this branch.
  if (executionIdentity.authority === 'ephemeral_workspace' && input.allowNonGitWorkspace === true) {
    const direct = await executeRepositoryCommandAsync(input.controllerHome, input.repository, {
      command: input.command,
      cwd: input.cwd,
      timeoutMs: Math.min(input.timeoutMs ?? 30_000, 30_000),
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal,
      allowNonGitWorkspace: true,
    });
    return {
      route: 'process_direct',
      reason: 'ephemeral_workspace_bounded_direct',
      ok: direct.ok,
      exitCode: direct.exitCode,
      stdout: direct.stdout,
      stderr: direct.stderr,
      executionStatus: direct.status,
      policyDecision: direct.policyDecision,
      authorizationDecision: direct.authorizationDecision,
      approvalRequestId: direct.approvalRequestId,
      durableSideEffects: emptyEffects,
    };
  }

  const interactiveWaitMs = durationAwareInteractiveWaitMs(
    input.command,
    input.interactiveWaitMs,
    Math.min(DEFAULT_INTERACTIVE_WAIT_MS, 250),
  );
  const timeoutMs = Math.max(
    interactiveWaitMs + 1,
    Math.min(input.timeoutMs ?? 15 * 60_000, 24 * 60 * 60_000),
  );

  const handle = await spawnWithQueuedAdmission({
    controllerHome: input.controllerHome,
    repoId: executionIdentity.repositoryId,
    checkoutId: executionIdentity.checkoutId,
    executionIdentity,
    ...(input.principalId ? { principalId: input.principalId } : {}),
    commandId: input.commandId,
    command: toProcessCommand(input.command, cwd),
    // Short commands complete inside this budget; longer ones return a running handle.
    interactiveWaitMs,
    leaseWaitMs: usesLiveDevice ? LIVE_DEVICE_ADMISSION_WAIT_MS : undefined,
    timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    resourceClaims: toProcessClaims(claims),
    origin: {
      surface: 'command',
      toolName: 'execute_command',
      requestId: input.requestId,
    },
    signal: input.signal,
    reuseActiveEquivalent: looksLikeBuildOrTest(input.command),
    returnHandleImmediately: input.returnHandleImmediately === true,
  }, usesLiveDevice);

  const route: RepositoryCommandRoute = handle.completed ? 'process_direct' : 'process_managed';
  return {
    route,
    reason: decision.reason,
    process: handle,
    ok: handle.ok,
    exitCode: handle.exitCode,
    stdout: handle.stdout,
    stderr: handle.stderr,
    durableSideEffects: handle.durableSideEffects,
    executionMetrics: {
      lane: 'durable_process',
      interactiveReturnMs: interactiveWaitMs,
      durableWrites: 1,
      leaseOperations: claims.length,
    },
  };
}

/**
 * Resolve the canonical Process scope of one process handle.
 *
 * Explicit placement stays authoritative and is validated by the lane itself.
 * When the caller omits it, this Runtime's own lightweight memory or the
 * instance-level handle index supplies the recorded scope, so attachment never
 * requires replaying the original placement inputs or scanning repositories.
 */
function resolveCommandProcessScopeKey(
  controllerHome: string,
  repoId: string | undefined,
  processId: string,
): string | undefined {
  const explicit = repoId?.trim();
  if (explicit) return explicit;
  if (isLightweightProcessId(processId)) {
    const inMemory = lightweightProcessScopeKey(processId);
    if (inMemory) return inMemory;
  }
  return processScopeKeyForHandle(controllerHome, processId);
}

export function getRepositoryCommandProcess(
  controllerHome: string,
  repoId: string | undefined,
  processId: string,
): ProcessHandle | undefined {
  const scopeKey = resolveCommandProcessScopeKey(controllerHome, repoId, processId);
  if (!scopeKey) return undefined;
  if (!isLightweightProcessId(processId)) {
    return getProcessHandle(controllerHome, scopeKey, processId);
  }
  return getLightweightProcessHandle(controllerHome, scopeKey, processId);
}

/** Resolve a previously accepted execute_command by its original request ID.
 * Durable Process bindings are checkout-scoped; lightweight receipts are scoped
 * to the repository and command ID. Missing evidence never causes a replay.
 */
export function resolveRepositoryCommandProcessIdByRequestId(
  controllerHome: string,
  repoId: string,
  checkoutId: string,
  requestId: string,
): string | undefined {
  const normalizedRepoId = repoId.trim();
  const normalizedCheckoutId = checkoutId.trim();
  const normalizedRequestId = requestId.trim();
  if (!normalizedRepoId || !normalizedCheckoutId || !normalizedRequestId) return undefined;
  const binding = getProcessRequestBinding(controllerHome, normalizedRepoId, normalizedCheckoutId, normalizedRequestId);
  if (binding) {
    if (binding.repoId !== normalizedRepoId
        || binding.checkoutId?.trim() !== normalizedCheckoutId
        || binding.requestId !== normalizedRequestId
        || typeof binding.processId !== 'string' || !binding.processId.trim()) {
      throw new Error(`PROCESS_REQUEST_BINDING_SCOPE_MISMATCH: ${normalizedRequestId}`);
    }
    return binding.processId.trim();
  }
  return getLightweightProcessHandleByCommandId(controllerHome, normalizedRepoId, normalizedRequestId)?.processId;
}

export async function waitRepositoryCommandProcess(
  controllerHome: string,
  repoId: string | undefined,
  processId: string,
  options?: Parameters<typeof waitForProcess>[3],
): Promise<ProcessHandle> {
  const scopeKey = resolveCommandProcessScopeKey(controllerHome, repoId, processId);
  if (!scopeKey) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
  if (!isLightweightProcessId(processId)) {
    return waitForProcess(controllerHome, scopeKey, processId, options);
  }
  return waitForLightweightProcess(controllerHome, scopeKey, processId, options);
}

export async function cancelRepositoryCommandProcess(
  controllerHome: string,
  repoId: string | undefined,
  processId: string,
): Promise<ProcessHandle> {
  const scopeKey = resolveCommandProcessScopeKey(controllerHome, repoId, processId);
  if (!scopeKey) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
  if (!isLightweightProcessId(processId)) {
    return cancelProcess(controllerHome, scopeKey, processId);
  }
  return cancelLightweightProcess(controllerHome, scopeKey, processId);
}

export function readRepositoryCommandProcessLogs(
  controllerHome: string,
  repoId: string | undefined,
  processId: string,
  maxBytes?: number,
) {
  const scopeKey = resolveCommandProcessScopeKey(controllerHome, repoId, processId);
  if (!scopeKey) return undefined;
  if (!isLightweightProcessId(processId)) {
    return readProcessLogs(controllerHome, scopeKey, processId, maxBytes);
  }
  return readLightweightProcessLogs(controllerHome, scopeKey, processId, maxBytes);
}
