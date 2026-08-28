/**
 * repository_command_execute → three explicit execution lanes.
 *
 * - Ephemeral Direct: bounded ordinary reads and commands that finish inside
 *   the interactive budget.
 * - Lightweight Managed: the same local command remains alive in memory and
 *   returns a bounded handle, without SQLite, Lease, or recovery membership.
 * - Durable: explicit Work/external/release boundaries only.
 */

import type { RepositoryRecord } from '../../../cli/repositories/types';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { classifyRepositoryCommand, fixedShellWrapperCommand, shellSegments, shellWordsPreservingQuotes } from '../../../cli/repositories/command-classifier';
import {
  executeRepositoryCommandAsync,
  executeRepositoryReadOnlyCommandDirect,
  type RepositoryCommandExecution,
} from '../../../cli/repositories/command-executor';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
import {
  assertRepositoryCommandNoPluginExecutionBypass,
  assertRepositoryCommandStableHostIdentity,
} from '../../../cli/repositories/command-scope';
import { claimsForRepositoryCommand, scopeResourceClaims, toProcessClaims } from './resource-claims';
import {
  spawnManagedProcess,
  getProcessHandle,
  waitForProcess,
  cancelProcess,
  readProcessLogs,
} from './runtime';
import type { ProcessHandle, ProcessCommandSpec } from './types';
import { DEFAULT_INTERACTIVE_WAIT_MS } from './types';
import { durationAwareInteractiveWaitMs } from './interactive-admission';
import { isFocusedCheckCommand } from '../thin-harness/execution-router';
import { assertExecutionIdentity, type ResolvedExecutionIdentity } from '../../control-plane/execution/execution-identity';
import { readWorkHandle, transitionWorkHandle } from '../../control-plane/execution/work-handle-store';
import {
  cancelLightweightProcess,
  getLightweightProcessHandle,
  isLightweightProcessId,
  readLightweightProcessLogs,
  startLightweightRepositoryCommand,
  waitForLightweightProcess,
} from './lightweight-managed';

export type RepositoryCommandRoute =
  | 'process_direct'
  | 'process_managed'
  | 'durable'
  | 'reject';

export interface RepositoryCommandProcessInput {
  controllerHome: string;
  repository: RepositoryRecord;
  command: string | readonly string[];
  cwd?: string;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  maxOutputBytes?: number;
  /** Force an explicit external/durable workflow boundary. */
  forceDurable?: boolean;
  /** Return a Process handle immediately without changing execution architecture. */
  returnHandleImmediately?: boolean;
  requestId?: string;
  workId?: string;
  commandId?: string;
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

export type WorkHeadSettlementReason =
  | 'settled'
  | 'no_work'
  | 'command_not_successful'
  | 'work_handle_missing'
  | 'identity_mismatch'
  | 'terminal_handle'
  | 'branch_changed'
  | 'head_unavailable'
  | 'head_unchanged'
  | 'concurrent_lifecycle_write';

export interface WorkHeadSettlementResult {
  settled: boolean;
  reason: WorkHeadSettlementReason;
  previousHead?: string;
  currentHead?: string;
}

/**
 * Settle the one legitimate post-command Work HEAD transition without weakening
 * the pre-command execution identity fence. The command has already been
 * admitted only if repo/checkout/branch/expectedHead matched the WorkHandle.
 * After success, adopt the exact current HEAD only while the same checkout and
 * branch still own the Work. CAS failure is a bounded no-op: finalization keeps
 * failing closed instead of accepting a concurrent lifecycle writer.
 */
export function settleWorkHandleExpectedHeadAfterRepositoryCommand(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  executionIdentity: ResolvedExecutionIdentity;
  workId?: string;
  ok?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
}): WorkHeadSettlementResult {
  const workId = input.workId?.trim();
  if (!workId) return { settled: false, reason: 'no_work' };
  if (input.ok !== true || input.cancelled === true || input.timedOut === true) {
    return { settled: false, reason: 'command_not_successful' };
  }
  const handle = readWorkHandle(input.controllerHome, input.repository.repoId, workId);
  if (!handle) return { settled: false, reason: 'work_handle_missing' };
  if (
    handle.repositoryId !== input.executionIdentity.repositoryId
    || handle.checkoutId !== input.executionIdentity.checkoutId
    || handle.workId !== input.executionIdentity.workId
  ) return { settled: false, reason: 'identity_mismatch' };
  if (handle.state === 'merged' || handle.state === 'cleaned' || handle.state === 'failed_terminal_cleanup') {
    return { settled: false, reason: 'terminal_handle' };
  }
  const status = repositoryGitStatus(input.repository);
  if (!status.branch || status.branch !== handle.branch) {
    return { settled: false, reason: 'branch_changed', previousHead: handle.expectedHead, currentHead: status.head ?? undefined };
  }
  const currentHead = status.head?.trim();
  if (!currentHead) return { settled: false, reason: 'head_unavailable', previousHead: handle.expectedHead };
  if (currentHead === handle.expectedHead) {
    return { settled: false, reason: 'head_unchanged', previousHead: handle.expectedHead, currentHead };
  }
  try {
    transitionWorkHandle(input.controllerHome, handle, handle.state, { expectedHead: currentHead });
    return { settled: true, reason: 'settled', previousHead: handle.expectedHead, currentHead };
  } catch (error) {
    if (error instanceof Error && error.message.includes('CONTROL_PLANE_REVISION_CONFLICT')) {
      return { settled: false, reason: 'concurrent_lifecycle_write', previousHead: handle.expectedHead, currentHead };
    }
    throw error;
  }
}

const STANDALONE_RECOVERY_LIFECYCLE_COMMANDS = new Set([
  'restart-runtime',
  'bootstrap-cutover',
  'restart-connector',
  'stage-and-activate-runtime',
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

function gitCommitWordsRequireExplicitPathScope(words: readonly string[]): boolean | undefined {
  const executable = commandBasename(words[0] ?? '');
  if (executable !== 'git') return undefined;
  const args = words.slice(1);
  let index = 0;
  while (index < args.length && args[index]?.startsWith('-')) {
    const option = args[index]!;
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(option)) index += 2;
    else if (['--git-dir=', '--work-tree=', '--namespace='].some((prefix) => option.startsWith(prefix))) index += 1;
    else index += 1;
  }
  if (args[index]?.toLowerCase() !== 'commit') return undefined;
  const commitArgs = args.slice(index + 1);
  const pathSeparator = commitArgs.indexOf('--');
  const paths = pathSeparator >= 0 ? commitArgs.slice(pathSeparator + 1).filter(Boolean) : [];
  const widensScope = commitArgs.some((arg) => ['-a', '--all', '-i', '--include', '--interactive', '-p', '--patch'].includes(arg));
  return paths.length === 0 || widensScope;
}

function rawGitCommitRequiresExplicitPathScope(command: string | readonly string[]): boolean {
  const normalized = normalizeRepositoryCommand(command);
  if (normalized.kind === 'argv') {
    const direct = gitCommitWordsRequireExplicitPathScope([
      normalized.executable ?? '',
      ...(normalized.args ?? []),
    ]);
    if (direct !== undefined) return direct;
    const wrapped = fixedShellWrapperCommand(normalized.value as string[]);
    if (!wrapped) return false;
    return shellSegments(wrapped)
      .some((segment) => gitCommitWordsRequireExplicitPathScope(shellWordsPreservingQuotes(segment)) === true);
  }
  return shellSegments(normalized.shellCommand ?? '')
    .some((segment) => gitCommitWordsRequireExplicitPathScope(shellWordsPreservingQuotes(segment)) === true);
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
  } = {},
): { route: RepositoryCommandRoute; reason: string } {
  if (repositoryCommandRecoveryLifecycle(command)) {
    return { route: 'reject', reason: 'standalone_recovery_lifecycle_required' };
  }
  if (rawGitCommitRequiresExplicitPathScope(command)) {
    return { route: 'reject', reason: 'git_commit_requires_explicit_path_scope' };
  }
  if (options.forceDurable) {
    return { route: 'durable', reason: 'force_durable_or_async' };
  }
  const classification = classifyRepositoryCommand(command, options.defaultBranch);
  const text = Array.isArray(command) ? command.join(' ') : String(command);
  // Classification chooses scheduling/receipt granularity only; it does not
  // decide whether a scoped repository command is allowed to run. Known remote
  // or broadly effectful commands use managed Process Runtime so existing
  // resource claims and receipts can serialize/reconcile them. Unknown commands
  // still execute instead of requiring a new allow rule.
  if (classification.risk === 'remote_write' || classification.risk === 'destructive') {
    return { route: 'process_managed', reason: 'effectful_command_managed' };
  }
  const argv = Array.isArray(command) ? command : [];
  const executable = argv[0]?.split(/[\\/]/).pop()?.toLowerCase();
  const shellWrapped = Boolean(executable
    && ['bash', 'sh', 'zsh', 'fish', 'dash', 'cmd', 'powershell', 'pwsh'].includes(executable)
    && argv.slice(1).some((arg) => ['-c', '-lc', '/c', '-Command'].includes(arg)));
  const wrappedShellCommand = shellWrapped ? fixedShellWrapperCommand(argv) : undefined;
  const wrapsInlineInterpreter = Boolean(wrappedShellCommand
    && /^\s*(?:exec\s+)?(?:node|nodejs|bun|deno|ruby|perl|python\d*)\b[^\n]*(?:\s-c\b|\s-e\b|\s--eval\b)/i.test(wrappedShellCommand));
  const wrapsObviousExternalIo = Boolean(wrappedShellCommand
    && /\b(?:curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat)\b|https?:\/\//i.test(wrappedShellCommand));
  if (shellWrapped && classification.risk !== 'readonly') {
    if (wrapsObviousExternalIo && !wrapsInlineInterpreter) {
      return { route: 'process_managed', reason: 'shell_wrapper_requires_managed_boundary' };
    }
    return { route: 'process_direct', reason: 'lightweight_local_shell_wrapper' };
  }
  if (executable && ['node', 'nodejs', 'bun', 'deno', 'ruby', 'perl', 'python', 'python3'].includes(executable)
    && argv.slice(1).some((arg) => ['-c', '-e', '--eval'].includes(arg))) {
    return { route: 'process_direct', reason: 'lightweight_local_inline_interpreter' };
  }
  if (classification.risk === 'readonly') {
    return { route: 'process_direct', reason: 'readonly_fast_path' };
  }
  // workspace_write / build-test
  if (isFocusedCheckCommand(command) || /\b(?:test|typecheck|lint|build|check)\b/i.test(text)) {
    return { route: 'process_direct', reason: 'ephemeral_local_build_or_test' };
  }
  return { route: 'process_direct', reason: 'ephemeral_local_workspace_mutation' };
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
    // Work identity is continuity/audit metadata only. It must not change the
    // execution lane of an otherwise ordinary local repository command.
    defaultBranch: input.repository.defaultBranch,
    timeoutMs: input.timeoutMs,
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
        : 'repository_command_execute via Durable Work / Local Job',
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
  if (executionIdentity.repositoryId !== input.repository.repoId) {
    throw new Error(
      `EXECUTION_IDENTITY_MISMATCH: repository ${input.repository.repoId} differs from identity ${executionIdentity.repositoryId}`,
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

  // Ordinary local commands own no durable Process/Lease state. Validate the
  // immutable repository identity first, then execute through the authorized
  // non-persistent repository executor. Runtime/release durability is not a
  // command-execution tax.
  const canonicalCommand = normalizeRepositoryCommand(input.command);
  if (decision.route === 'process_direct') {
    assertExecutionIdentity({
      controllerHome: input.controllerHome,
      identity: executionIdentity,
      cwd,
      requestedRepoId: input.repository.repoId,
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
    const readonly = canonicalCommand.kind === 'argv'
      && classifyRepositoryCommand(input.command, input.repository.defaultBranch).risk === 'readonly';
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
        workId: input.workId,
        commandId: input.commandId ?? input.requestId,
        deferStart: deferLongPreparation,
        reuseActiveEquivalent: deferLongPreparation,
        onCompleted: (result) => {
          // A terminal child exit is sufficient to close the Process, but not to
          // advance Work mutation authority when post-execution repository
          // evidence is unavailable. Finalization must keep failing closed until
          // a later authoritative repository inspection proves the new HEAD.
          if (result.evidenceError) return;
          settleWorkHandleExpectedHeadAfterRepositoryCommand({
            controllerHome: input.controllerHome,
            repository: input.repository,
            executionIdentity,
            workId: input.workId,
            ok: result.ok,
            cancelled: result.cancelled,
            timedOut: result.timedOut,
          });
        },
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

  const claims = scopeResourceClaims(
    claimsForRepositoryCommand(
      input.command,
      executionIdentity.repositoryId,
      executionIdentity.checkoutId,
      input.repository.defaultBranch,
      input.repository.canonicalRoot,
    ),
    executionIdentity.repositoryId,
    executionIdentity.checkoutId,
    input.workId,
  );

  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: executionIdentity.repositoryId,
    checkoutId: executionIdentity.checkoutId,
    executionIdentity,
    workId: input.workId,
    commandId: input.commandId,
    command: toProcessCommand(input.command, cwd),
    // Short commands complete inside this budget; longer ones return a running handle.
    interactiveWaitMs,
    timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    resourceClaims: toProcessClaims(claims),
    origin: {
      surface: 'command',
      toolName: 'repository_command_execute',
      requestId: input.requestId,
      correlationId: input.workId,
    },
    signal: input.signal,
    returnHandleImmediately: input.returnHandleImmediately === true,
  });

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

export function getRepositoryCommandProcess(controllerHome: string, repoId: string, processId: string): ProcessHandle | undefined {
  return isLightweightProcessId(processId)
    ? getLightweightProcessHandle(controllerHome, repoId, processId)
    : getProcessHandle(controllerHome, repoId, processId);
}

export function waitRepositoryCommandProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
  options?: Parameters<typeof waitForProcess>[3],
): Promise<ProcessHandle> {
  return isLightweightProcessId(processId)
    ? waitForLightweightProcess(controllerHome, repoId, processId, options)
    : waitForProcess(controllerHome, repoId, processId, options);
}

export function cancelRepositoryCommandProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
): Promise<ProcessHandle> {
  return isLightweightProcessId(processId)
    ? cancelLightweightProcess(controllerHome, repoId, processId)
    : cancelProcess(controllerHome, repoId, processId);
}

export function readRepositoryCommandProcessLogs(
  controllerHome: string,
  repoId: string,
  processId: string,
  maxBytes?: number,
) {
  return isLightweightProcessId(processId)
    ? readLightweightProcessLogs(controllerHome, repoId, processId, maxBytes)
    : readProcessLogs(controllerHome, repoId, processId, maxBytes);
}
