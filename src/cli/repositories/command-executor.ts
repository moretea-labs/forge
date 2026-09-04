import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS } from '../controller/runtime-config';
import { repositoryControllerRoot } from './controller-home';
import {
  classifyRepositoryCommand,
  type RepositoryCommandAuthorization,
  type RepositoryCommandClassification,
} from './command-classifier';
import {
  assertCommandPathOperandsStayInRepository,
  assertRepositoryCommandInputAllowed,
  type RepositoryCommandExternalPathUsage,
  resolveRepositoryCommandCwd,
} from './command-scope';
import { commandValue, type CanonicalRepositoryCommand, type RepositoryCommandValue } from './command-normalization';
import { loadExternalFilesystemGrants } from '../../runtime/safe-tooling/external-filesystem';
import type { RepositoryRecord } from './types';
import { readRepositoryAccessPolicy } from '../../runtime/control-plane/governance/access-policy';
import { invalidateRepositoryReadCaches } from '../repository/inspector';
import { assertResolvedAuthorization, decideAuthorization, type AuthorizationDecision } from '../../runtime/control-plane/governance/authorization';
import { assertRuntimeMayWriteOrThrow } from '../../runtime/root/write-fence';
import { commandEnvironment, runCanonicalCommand, type RepositoryCommandAsyncHooks, type SpawnCommandResult } from './command-process';
import {
  changedSnapshotPaths,
  emptyWorkspaceSnapshot,
  readonlyUnobservedRepositorySnapshot,
  repositorySnapshot,
  repositorySnapshotAsync,
  snapshotChanged,
  type RepositoryCommandSnapshot,
} from './repository-snapshot';

export type { RepositoryCommandSnapshot } from './repository-snapshot';
export type { RepositoryCommandAsyncHooks, SpawnCommandResult } from './command-process';
// Compatibility exports for supported callers; implementations live in their
// responsibility-owned modules.
export { runCanonicalCommand } from './command-process';
export { repositorySnapshotAsync } from './repository-snapshot';

export { classifyRepositoryCommand } from './command-classifier';
export type {
  RepositoryCommandAuthorization,
  RepositoryCommandClassification,
  RepositoryCommandConfirmation,
  RepositoryCommandRisk,
} from './command-classifier';

export interface ExecuteRepositoryCommandInput {
  command: string | readonly string[];
  cwd?: string;
  authorization?: RepositoryCommandAuthorization;
  approvalToken?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  authorizationDecision?: AuthorizationDecision;
  approvalRequestId?: string;
  sessionId?: string;
  principalId?: string;
  workId?: string;
  /** When set, cancel spawn via process-tree kill. Async path only. */
  signal?: AbortSignal;
  /**
   * Reuse a precomputed snapshot (e.g. from preview) so Fast Path does not
   * re-run multiple sync/async git snapshots for the same command.
   */
  reuseSnapshot?: RepositoryCommandSnapshot;
  /** Internal: explicit ephemeral workspace authority may operate without a Git repository. */
  allowNonGitWorkspace?: boolean;
  /** Internal: command-facade already classified this as a bounded local script; retain policy/snapshot/audit without durable Process state. */
  allowOpaqueLocalScript?: boolean;
  /** Internal/test seam: bound dirty-path fingerprint enrichment independently from child execution lifetime. */
  snapshotFingerprintTimeoutMs?: number;
}


export interface RepositoryCommandExecution {
  status: 'preview' | 'approval_required' | 'executed';
  repoId: string;
  checkoutId: string;
  cwd: string;
  command: RepositoryCommandValue;
  classification: RepositoryCommandClassification;
  approvalToken: string;
  authorization?: RepositoryCommandAuthorization;
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  before: RepositoryCommandSnapshot;
  after?: RepositoryCommandSnapshot;
  repositoryChanged?: boolean;
  changedPaths?: string[];
  policyDecision?: 'allowed' | 'approval_required' | 'rejected';
  authorizationDecision?: AuthorizationDecision;
  approvalRequestId?: string;
  infrastructureError?: { code: string; message: string };
  /** Child execution completed, but post-execution repository evidence could not be proven. Mutation state is unknown until a later authoritative inspection. */
  evidenceError?: { code: string; message: string };
  externalPathUsages?: RepositoryCommandExternalPathUsage[];
}


export interface PreparedRepositoryCommandExecution {
  before: RepositoryCommandSnapshot;
  executable: boolean;
  execution: RepositoryCommandExecution;
}


/** Sensible interactive default for ordinary repository commands. */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Explicit repository-command timeouts share agent bounds so Local Job
 * deadline resolution and process kill agree (min 5s, max 12h, no silent clamp).
 */
const MIN_TIMEOUT_MS = MIN_AGENT_TIMEOUT_MS;
const MAX_TIMEOUT_MS = MAX_AGENT_TIMEOUT_MS;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const REPOSITORY_COMMAND_MIN_TIMEOUT_MS = MIN_TIMEOUT_MS;
export const REPOSITORY_COMMAND_MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('COMMAND_OPTION_INVALID: numeric command option must be finite');
  const normalized = Math.trunc(value);
  if (normalized < minimum || normalized > maximum) {
    throw new Error(`COMMAND_OPTION_INVALID: value must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function approvalToken(
  repository: RepositoryRecord,
  relativeCwd: string,
  command: RepositoryCommandValue,
  classification: RepositoryCommandClassification,
  snapshot: RepositoryCommandSnapshot,
  externalPathUsages: RepositoryCommandExternalPathUsage[],
): string {
  return createHash('sha256').update(JSON.stringify({
    version: 2,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    command,
    classification,
    snapshot,
    externalPathUsages,
  })).digest('hex');
}

function finalizePreparedExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome: string | undefined,
  root: string,
  cwd: string,
  relativeCwd: string,
  command: CanonicalRepositoryCommand,
  externalPathUsages: RepositoryCommandExternalPathUsage[],
  classification: RepositoryCommandClassification,
  before: RepositoryCommandSnapshot,
): {
  root: string;
  cwd: string;
  command: CanonicalRepositoryCommand;
  timeoutMs: number;
  maxOutputBytes: number;
  before: RepositoryCommandSnapshot;
  execution: RepositoryCommandExecution;
  executable: boolean;
  externalPathUsages: RepositoryCommandExternalPathUsage[];
} {
  const commandForPersistence = commandValue(command);
  const token = approvalToken(repository, relativeCwd, commandForPersistence, classification, before, externalPathUsages);
  const permission = controllerHome ? readRepositoryAccessPolicy(controllerHome, repository.repoId) : undefined;
  const isGit = command.kind === 'argv'
    ? command.executable?.split(/[\\/]/).at(-1)?.toLowerCase() === 'git'
    : /^\s*git\s+/i.test(command.shellCommand!);
  // Command classification is observability/replay metadata, not execution
  // authority. Raw repository commands follow the host AI permission model once
  // repository/cwd/external-path scope has been resolved. Typed catastrophic
  // Forge operations retain their own explicit confirmation contracts.
  const risk = isGit ? 'local_git' : 'local_command';
  const delegated = input.authorizationDecision ?? (controllerHome ? decideAuthorization({
    controllerHome,
    accessMode: permission?.mode ?? 'request',
    risk,
    repositoryId: repository.repoId,
    currentRepositoryId: repository.repoId,
    permissionSnapshotVersion: permission?.revision ?? 1,
    approvalToken: token,
    command: commandForPersistence,
    cwd: relativeCwd,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.principalId ? { principalId: input.principalId } : {}),
    ...(input.workId ? { workId: input.workId, boundWorkId: input.workId } : {}),
  }) : undefined);
  const resolved = controllerHome && input.approvalRequestId
    ? assertResolvedAuthorization({ controllerHome, repositoryId: repository.repoId, approvalRequestId: input.approvalRequestId, sessionId: input.sessionId, principalId: input.principalId, workId: input.workId, permissionSnapshotVersion: permission?.revision ?? 1, command: commandForPersistence })
    : undefined;
  const effectiveDecision: AuthorizationDecision | undefined = resolved
    ? { decision: 'allow', source: 'user_confirmation', reason: 'Resolved approval request matches the exact command and current permission snapshot.' }
    : delegated;
  const execution: RepositoryCommandExecution = {
    status: input.dryRun === true ? 'preview' : 'approval_required',
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    cwd: relativeCwd,
    command: commandForPersistence,
    classification,
    approvalToken: token,
    authorization: input.authorization,
    before,
    policyDecision: input.dryRun === true || !controllerHome || effectiveDecision?.decision === 'allow'
      ? 'allowed'
      : 'approval_required',
    ...(effectiveDecision ? { authorizationDecision: effectiveDecision } : {}),
    ...(effectiveDecision?.decision === 'user_confirmation_required' ? { approvalRequestId: effectiveDecision.approvalRequestId } : {}),
    externalPathUsages: externalPathUsages.length > 0 ? externalPathUsages : undefined,
  };
  const confirmed = input.authorization === 'confirmed_plan' && input.approvalToken === token;
  const delegatedAllowed = !controllerHome || effectiveDecision?.decision === 'allow';
  const executable = input.dryRun === true || confirmed || delegatedAllowed;
  execution.policyDecision = executable ? 'allowed' : 'approval_required';
  return {
    root,
    cwd,
    command,
    timeoutMs: boundedInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputBytes: boundedInteger(input.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES),
    before,
    execution,
    executable,
    externalPathUsages,
  };
}

function prepareRepositoryCommandExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
): {
  root: string;
  cwd: string;
  command: CanonicalRepositoryCommand;
  timeoutMs: number;
  maxOutputBytes: number;
  before: RepositoryCommandSnapshot;
  execution: RepositoryCommandExecution;
  executable: boolean;
  externalPathUsages: RepositoryCommandExternalPathUsage[];
} {
  const { root, cwd, relativeCwd } = resolveRepositoryCommandCwd(repository, input.cwd);
  const command = assertRepositoryCommandInputAllowed(input.command, {
    allowOpaqueLocalScript: input.allowOpaqueLocalScript,
  });
  const externalGrants = loadExternalFilesystemGrants(root).grants;
  const externalPathUsages = assertCommandPathOperandsStayInRepository(command, cwd, root, externalGrants);
  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  const before = input.reuseSnapshot ?? (input.allowNonGitWorkspace ? emptyWorkspaceSnapshot() : repositorySnapshot(root));
  return finalizePreparedExecution(
    repository,
    input,
    controllerHome,
    root,
    cwd,
    relativeCwd,
    command,
    externalPathUsages,
    classification,
    before,
  );
}

async function prepareRepositoryCommandExecutionAsync(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
  mode: 'standard' | 'readonly_direct' = 'standard',
): Promise<{
  root: string;
  cwd: string;
  command: CanonicalRepositoryCommand;
  timeoutMs: number;
  maxOutputBytes: number;
  before: RepositoryCommandSnapshot;
  execution: RepositoryCommandExecution;
  executable: boolean;
  externalPathUsages: RepositoryCommandExternalPathUsage[];
}> {
  const { root, cwd, relativeCwd } = resolveRepositoryCommandCwd(repository, input.cwd);
  const command = assertRepositoryCommandInputAllowed(input.command, {
    allowOpaqueLocalScript: input.allowOpaqueLocalScript,
  });
  const externalGrants = loadExternalFilesystemGrants(root).grants;
  const externalPathUsages = assertCommandPathOperandsStayInRepository(command, cwd, root, externalGrants);
  const classification = classifyRepositoryCommand(command, repository.defaultBranch);
  if (mode === 'readonly_direct' && classification.risk !== 'readonly') {
    throw new Error(`READONLY_DIRECT_ROUTE_REQUIRED: received ${classification.risk}`);
  }
  // The readonly-direct lane has already resolved repository identity, cwd/path
  // scope, command input and readonly classification. Mutation snapshots are not
  // authorization authority, so do not launch rev-parse/branch/status/show-ref
  // merely to prove that a command selected for this lane did not mutate state.
  // Write-capable lanes keep their complete observed snapshot semantics.
  const before = input.reuseSnapshot ?? (input.allowNonGitWorkspace
    ? emptyWorkspaceSnapshot()
    : mode === 'readonly_direct'
      ? readonlyUnobservedRepositorySnapshot()
      : await repositorySnapshotAsync(root, input.signal, {
          fingerprintTimeoutMs: input.snapshotFingerprintTimeoutMs,
        }));
  return finalizePreparedExecution(
    repository,
    input,
    controllerHome,
    root,
    cwd,
    relativeCwd,
    command,
    externalPathUsages,
    classification,
    before,
  );
}

export function previewRepositoryCommandExecution(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
): PreparedRepositoryCommandExecution {
  const prepared = prepareRepositoryCommandExecution(repository, input, controllerHome);
  return {
    before: prepared.before,
    executable: prepared.executable,
    execution: prepared.execution,
  };
}

/** Async preview — preferred on Fast Path to avoid blocking Gateway with sync git snapshots. */
export async function previewRepositoryCommandExecutionAsync(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  controllerHome?: string,
): Promise<PreparedRepositoryCommandExecution> {
  const prepared = await prepareRepositoryCommandExecutionAsync(repository, input, controllerHome);
  return {
    before: prepared.before,
    executable: prepared.executable,
    execution: prepared.execution,
  };
}

function auditCommand(
  controllerHome: string,
  repository: RepositoryRecord,
  execution: RepositoryCommandExecution,
): void {
  const path = join(repositoryControllerRoot(controllerHome, repository.repoId), 'audit', 'commands.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...execution,
    stdout: execution.stdout ? `[${Buffer.byteLength(execution.stdout, 'utf8')} bytes returned]` : undefined,
    stderr: execution.stderr ? `[${Buffer.byteLength(execution.stderr, 'utf8')} bytes returned]` : undefined,
  })}\n`, 'utf-8');
}

export function executeRepositoryCommand(
  controllerHome: string,
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
): RepositoryCommandExecution {
  const prepared = prepareRepositoryCommandExecution(repository, input, controllerHome);
  const { root, cwd, command, timeoutMs, maxOutputBytes, before, execution: base, executable, externalPathUsages } = prepared;

  if (input.dryRun === true) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  if (!executable) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  // Final effect executor fencing for remote / destructive writes.
  // Classifier alone is not sufficient — passive runtimes must not execute side effects.
  const risk = base.classification?.risk;
  if (risk === 'remote_write' || risk === 'destructive') {
    try {
      assertRuntimeMayWriteOrThrow('remote_side_effect', controllerHome);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('WRITER_FENCED:')) throw error;
      /* unbound legacy */
    }
  }
  const executableName = command.kind === 'argv'
    ? command.executable!
    : process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const commandArgs = command.kind === 'argv'
    ? [...(command.args ?? [])]
    : process.platform === 'win32' ? ['/d', '/s', '/c', command.shellCommand!] : ['-c', command.shellCommand!];
  const result = spawnSync(executableName, commandArgs, {
    cwd,
    env: commandEnvironment(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: Math.max(maxOutputBytes, 1024 * 1024),
  });
  const error = result.error instanceof Error ? result.error.message : '';
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const after = repositorySnapshot(root);
  const execution: RepositoryCommandExecution = {
    ...base,
    status: 'executed',
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? 1,
    timedOut,
    stdout: capProcessOutput(
      redactProcessOutput(typeof result.stdout === 'string' ? result.stdout : ''),
      maxOutputBytes,
    ),
    stderr: capProcessOutput(redactProcessOutput([
      typeof result.stderr === 'string' ? result.stderr : '',
      error,
    ].filter(Boolean).join('\n')), maxOutputBytes),
    after,
    repositoryChanged: snapshotChanged(before, after),
    changedPaths: changedSnapshotPaths(before, after),
    policyDecision: 'allowed',
    externalPathUsages: externalPathUsages.length > 0 ? externalPathUsages : undefined,
    infrastructureError: result.error ? {
      code: timedOut ? 'COMMAND_TIMED_OUT' : 'COMMAND_SPAWN_FAILED',
      message: error || `repository command failed with exit ${String(result.status ?? 1)}`,
    } : undefined,
  };
  if (execution.repositoryChanged) invalidateRepositoryReadCaches(root);
  auditCommand(controllerHome, repository, execution);
  return execution;
}

/**
 * Bounded readonly execution that deliberately owns no Controller mutation.
 *
 * This path exists for short repository reads that must remain available while
 * Runtime writer authority is fenced or rotating. It reuses the exact command
 * input/scope classifier, bounded async process runner, cancellation,
 * environment allowlist, output caps and redaction. It deliberately owns no
 * mutation snapshot or Controller write state, Process records, Leases, Jobs or receipts.
 */
export async function executeRepositoryReadOnlyCommandDirect(
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
): Promise<RepositoryCommandExecution> {
  const prepared = await prepareRepositoryCommandExecutionAsync(
    repository,
    { ...input, dryRun: false },
    undefined,
    'readonly_direct',
  );
  const { root, cwd, command, timeoutMs, maxOutputBytes, before, execution: base, externalPathUsages } = prepared;
  if (base.classification.risk !== 'readonly') {
    throw new Error(`READONLY_DIRECT_ROUTE_REQUIRED: received ${base.classification.risk}`);
  }
  if (!prepared.executable) {
    throw new Error('READONLY_DIRECT_ROUTE_REJECTED: readonly command was not executable after policy evaluation');
  }
  const signal = input.signal;
  if (signal?.aborted) {
    return {
      ...base,
      status: 'executed',
      ok: false,
      exitCode: 1,
      timedOut: false,
      cancelled: true,
      stdout: '',
      stderr: 'cancelled before spawn',
      after: before,
      repositoryChanged: false,
      changedPaths: [],
      policyDecision: 'allowed',
      infrastructureError: { code: 'COMMAND_CANCELLED', message: 'cancelled before spawn' },
    };
  }

  const result = await runCanonicalCommand(command, cwd, timeoutMs, maxOutputBytes, { signal });
  // This entry point is reachable only after the bounded classifier has proven
  // the command readonly. Mutation evidence is explicitly unobserved rather than
  // fabricated: no before/after Git snapshot is taken, while write-capable lanes
  // still take independent observed before/after snapshots.
  const after = before;
  return {
    ...base,
    status: 'executed',
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stdout: result.stdout,
    stderr: result.stderr,
    after,
    repositoryChanged: false,
    changedPaths: [],
    policyDecision: 'allowed',
    externalPathUsages: externalPathUsages.length > 0 ? externalPathUsages : undefined,
    infrastructureError: result.timedOut
      ? { code: 'COMMAND_TIMED_OUT', message: result.stderr || `repository command timed out after ${timeoutMs}ms` }
      : result.cancelled
        ? { code: 'COMMAND_CANCELLED', message: result.stderr || 'repository command cancelled' }
        : undefined,
  };
}

export async function executeRepositoryCommandAsync(
  controllerHome: string,
  repository: RepositoryRecord,
  input: ExecuteRepositoryCommandInput,
  hooks: RepositoryCommandAsyncHooks = {},
): Promise<RepositoryCommandExecution> {
  const signal = hooks.signal ?? input.signal;
  const prepared = await prepareRepositoryCommandExecutionAsync(
    repository,
    { ...input, signal },
    controllerHome,
  );
  const { root, cwd, command, timeoutMs, maxOutputBytes, before, execution: base, executable, externalPathUsages } = prepared;

  if (input.dryRun === true) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  if (!executable) {
    auditCommand(controllerHome, repository, base);
    return base;
  }

  const asyncRisk = base.classification?.risk;
  if (asyncRisk === 'remote_write' || asyncRisk === 'destructive') {
    assertRuntimeMayWriteOrThrow('remote_side_effect', controllerHome);
  }

  if (signal?.aborted) {
    const cancelled: RepositoryCommandExecution = {
      ...base,
      status: 'executed',
      ok: false,
      exitCode: 1,
      timedOut: false,
      cancelled: true,
      stdout: '',
      stderr: 'cancelled before spawn',
      after: before,
      repositoryChanged: false,
      changedPaths: [],
      policyDecision: 'allowed',
      infrastructureError: { code: 'COMMAND_CANCELLED', message: 'cancelled before spawn' },
    };
    auditCommand(controllerHome, repository, cancelled);
    return cancelled;
  }

  const result = await runCanonicalCommand(command, cwd, timeoutMs, maxOutputBytes, {
    ...hooks,
    signal,
  });
  let after: RepositoryCommandSnapshot | undefined = input.allowNonGitWorkspace ? before : undefined;
  let evidenceError: RepositoryCommandExecution['evidenceError'];
  if (!input.allowNonGitWorkspace) {
    try {
      after = await repositorySnapshotAsync(root, signal?.aborted ? undefined : signal, {
        fingerprintTimeoutMs: input.snapshotFingerprintTimeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'POST_EXECUTION_EVIDENCE_FAILED';
      evidenceError = { code, message };
    }
  }
  const execution: RepositoryCommandExecution = {
    ...base,
    status: 'executed',
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stdout: result.stdout,
    stderr: result.stderr,
    after,
    repositoryChanged: after ? snapshotChanged(before, after) : undefined,
    changedPaths: after ? changedSnapshotPaths(before, after) : undefined,
    evidenceError,
    policyDecision: 'allowed',
    externalPathUsages: externalPathUsages.length > 0 ? externalPathUsages : undefined,
    infrastructureError: result.timedOut
      ? {
        code: 'COMMAND_TIMED_OUT',
        message: result.stderr || `repository command timed out after ${timeoutMs}ms`,
      }
      : result.cancelled
        ? {
          code: 'COMMAND_CANCELLED',
          message: result.stderr || 'repository command cancelled',
        }
        : undefined,
  };
  // Unknown post-execution mutation evidence is conservatively cache-invalidating;
  // later reads must re-observe the repository rather than reuse a false unchanged state.
  if (execution.repositoryChanged === true || execution.evidenceError) invalidateRepositoryReadCaches(root);
  auditCommand(controllerHome, repository, execution);
  return execution;
}
