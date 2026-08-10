/**
 * repository_command_execute → Unified Process Runtime.
 *
 * Short readonly / focused commands: Direct (wait briefly, return result).
 * Longer local build/test: Managed (same spawn, return handle).
 * release / remote / non-idempotent: Durable (caller keeps ExecutionJob path).
 */

import type { RepositoryRecord } from '../../../cli/repositories/types';
import { classifyRepositoryCommand } from '../../../cli/repositories/command-classifier';
import { executeRepositoryReadOnlyCommandDirect } from '../../../cli/repositories/command-executor';
import { normalizeRepositoryCommand } from '../../../cli/repositories/command-normalization';
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
import { isFocusedCheckCommand } from '../thin-harness/execution-router';
import { assertExecutionIdentity, type ResolvedExecutionIdentity } from '../../control-plane/execution/execution-identity';

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
  /** Force durable workflow (async apply, release, remote). */
  forceDurable?: boolean;
  requestId?: string;
  workId?: string;
  commandId?: string;
  signal?: AbortSignal;
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
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
  suggestedOperation?: string;
}

const emptyEffects = {
  executionJobCount: 0,
  localJobCount: 0,
  workerSpawnCount: 0,
  projectionUpdateCount: 0,
};

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
  if (options.forceDurable) {
    return { route: 'durable', reason: 'force_durable_or_async' };
  }
  const classification = classifyRepositoryCommand(command, options.defaultBranch);
  // ExecutionJobs are retired. Authorized local destructive/remote-risk commands
  // still execute through Process Runtime; SuperController owns retry/replay policy.
  if (classification.risk === 'remote_write' || classification.risk === 'destructive') {
    return {
      route: 'process_managed',
      reason: `risk_${classification.risk}_via_process_runtime`,
    };
  }
  // release / rollback style commands
  const text = Array.isArray(command) ? command.join(' ') : String(command);
  if (/\b(?:gh\s+release\s+(?:create|delete|edit|upload)|git\s+push|npm\s+publish)\b/i.test(text)) {
    return { route: 'durable', reason: 'release_or_remote_mutation' };
  }
  if (classification.risk === 'readonly') {
    // Short readonly → direct. Only an *explicit* long timeout upgrades to managed.
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 30_000) {
      return { route: 'process_managed', reason: 'readonly_long_timeout' };
    }
    return { route: 'process_direct', reason: 'readonly_fast_path' };
  }
  // workspace_write / build-test
  if (isFocusedCheckCommand(command) || /\b(?:test|typecheck|lint|build|check)\b/i.test(text)) {
    return { route: 'process_managed', reason: 'local_build_or_test' };
  }
  // Unknown mutating local command remains one local Managed Process. Timeout is
  // a process lifecycle budget and must never select a different architecture.
  return { route: 'process_managed', reason: 'local_workspace_mutation' };
}

/**
 * Execute via Unified Process Runtime when route is process_*.
 * Does not create ExecutionJob / LocalJob / Worker.
 */
export async function executeRepositoryCommandViaProcessRuntime(
  input: RepositoryCommandProcessInput,
): Promise<RepositoryCommandProcessResult> {
  const decision = classifyRepositoryCommandRoute(input.command, {
    forceDurable: input.forceDurable,
    defaultBranch: input.repository.defaultBranch,
    timeoutMs: input.timeoutMs,
  });

  if (decision.route === 'durable' || decision.route === 'reject') {
    return {
      route: decision.route,
      reason: decision.reason,
      durableSideEffects: emptyEffects,
      suggestedOperation: 'repository_command_execute via Durable Work / Local Job',
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

  // A short readonly command owns no durable Process/Lease state. Validate the
  // same immutable repository identity first, then execute with the bounded
  // non-persistent reader. This keeps reads available while a stale/passive
  // Runtime remains correctly fenced from Controller writes.
  const canonicalCommand = normalizeRepositoryCommand(input.command);
  if (decision.route === 'process_direct' && canonicalCommand.kind === 'argv') {
    assertExecutionIdentity({
      controllerHome: input.controllerHome,
      identity: executionIdentity,
      cwd,
      requestedRepoId: input.repository.repoId,
      requestedCheckoutId: input.repository.activeCheckoutId,
    });
    const direct = await executeRepositoryReadOnlyCommandDirect(input.repository, {
      command: input.command,
      cwd: input.cwd,
      timeoutMs: Math.min(input.timeoutMs ?? 30_000, 30_000),
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal,
      allowNonGitWorkspace: executionIdentity.authority === 'ephemeral_workspace',
    });
    return {
      route: 'process_direct',
      reason: decision.reason,
      ok: direct.ok,
      exitCode: direct.exitCode,
      stdout: direct.stdout,
      stderr: direct.stderr,
      durableSideEffects: emptyEffects,
    };
  }

  const interactiveWaitMs = decision.route === 'process_direct'
    ? (input.interactiveWaitMs ?? DEFAULT_INTERACTIVE_WAIT_MS)
    : (input.interactiveWaitMs ?? Math.min(DEFAULT_INTERACTIVE_WAIT_MS, 2_000));
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
    returnHandleImmediately: input.forceDurable === true,
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
  };
}

export {
  getProcessHandle as getRepositoryCommandProcess,
  waitForProcess as waitRepositoryCommandProcess,
  cancelProcess as cancelRepositoryCommandProcess,
  readProcessLogs as readRepositoryCommandProcessLogs,
};
