import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { listControllerChecks, snapshotControllerCheck } from '../../../cli/controller/check-runner';
import {
  checkRequiresDurableWorkflow,
  claimsForCheck,
  spawnManagedProcess,
  toProcessClaims,
  type CheckExecutionMode,
  type RunCheckFacadeInput,
  type RunCheckFacadeResult,
} from '../../execution/process-runtime';
const INTERNAL_CHECK_SUBCOMMAND = ['controller', 'run-check-process'] as const;

export function resolvePersistedCheckCliInvocation(
  cliEntry: string,
  args: string[],
  options: { runtimeExecutable?: string; env?: NodeJS.ProcessEnv } = {},
): { executable: string; args: string[] } {
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath;
  const env = options.env ?? process.env;
  const standalone = env.REPO_HARNESS_RUNTIME_EXECUTION === 'standalone-binary'
    || cliEntry.includes('$bunfs');
  return standalone
    ? { executable: runtimeExecutable, args }
    : { executable: runtimeExecutable, args: [cliEntry, ...args] };
}

export function resolveRuntimeCliEntry(): string {
  const configured = process.env.REPO_HARNESS_RUNTIME_CLI_ENTRY?.trim();
  if (configured && existsSync(configured)) return resolve(configured);

  const argvEntry = process.argv[1]?.trim();
  if (argvEntry && /^repo-harness\.(?:js|mjs)$/.test(basename(argvEntry)) && existsSync(argvEntry)) {
    return resolve(argvEntry);
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const installed = join(here, 'repo-harness.js');
    if (existsSync(installed)) return installed;
  } catch {
    // Continue to the source checkout fallback used by local development/tests.
  }

  const sourceRoot = process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT?.trim() || process.cwd();
  const sourceEntry = join(resolve(sourceRoot), 'bin', 'repo-harness.mjs');
  if (existsSync(sourceEntry)) return sourceEntry;
  throw new Error('CHECK_PROCESS_CLI_ENTRY_NOT_FOUND: immutable runtime CLI entry is unavailable');
}

/**
 * Run a registered check through Process Runtime while keeping check-runner
 * evidence authoritative. The managed OS process invokes the same immutable
 * repo-harness CLI bundle with a hidden internal subcommand; that subcommand
 * executes runControllerCheck, writes the Artifact atomically, mirrors bounded
 * stdout/stderr, and exits with the exact check status.
 */
export async function runPersistedCheckViaProcessRuntime(
  input: RunCheckFacadeInput,
): Promise<RunCheckFacadeResult> {
  const emptyEffects = {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };
  const check = listControllerChecks(input.repoRoot).find((entry) => entry.id === input.checkId);
  if (!check) {
    return {
      mode: 'durable',
      checkId: input.checkId,
      durable: {
        reason: 'check_not_found_or_requires_registry_lookup',
        suggestedOperation: 'list_checks then run_check with a known check_id',
      },
      durableSideEffects: emptyEffects,
    };
  }
  if (input.forceDurable || checkRequiresDurableWorkflow(input.checkId, check)) {
    return {
      mode: 'durable',
      checkId: input.checkId,
      check,
      durable: {
        reason: 'multi_phase_or_release_check_requires_durable_workflow',
        suggestedOperation: 'Claim the related WorkContract and run this check through an external Controller.',
      },
      durableSideEffects: emptyEffects,
    };
  }

  const interactiveWaitMs = input.interactiveWaitMs ?? 800;
  const timeoutMs = Math.min(
    check.timeoutMs,
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(1_000, Math.trunc(input.timeoutMs))
      : check.timeoutMs,
  );
  if (!input.executionIdentity) {
    throw new Error('EXECUTION_IDENTITY_REQUIRED: persisted run_check requires an immutable executionIdentity');
  }
  const executionIdentity = input.executionIdentity;
  if (executionIdentity.repositoryId !== input.repoId) {
    throw new Error(
      `EXECUTION_IDENTITY_MISMATCH: check repo ${input.repoId} differs from identity ${executionIdentity.repositoryId}`,
    );
  }
  if (input.checkoutId?.trim() && executionIdentity.checkoutId !== input.checkoutId.trim()) {
    throw new Error(
      `CHECKOUT_ROUTE_MISMATCH: check checkout ${input.checkoutId} differs from identity ${executionIdentity.checkoutId}`,
    );
  }
  const claims = claimsForCheck(
    input.checkId,
    check.command,
    executionIdentity.repositoryId,
    executionIdentity.checkoutId,
    check.effects,
  );
  const checkSnapshot = snapshotControllerCheck(input.repoRoot, input.checkId);
  const checkFingerprint = createHash('sha256')
    .update(JSON.stringify(checkSnapshot))
    .digest('hex');
  const cliEntry = resolveRuntimeCliEntry();
  const checkArgs = [
    ...INTERNAL_CHECK_SUBCOMMAND,
    '--repo',
    executionIdentity.canonicalRoot,
    '--check-id',
    input.checkId,
    '--timeout-ms',
    String(timeoutMs),
    '--expected-check-fingerprint',
    checkFingerprint,
  ];
  const invocation = resolvePersistedCheckCliInvocation(cliEntry, checkArgs);
  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: executionIdentity.repositoryId,
    checkoutId: executionIdentity.checkoutId,
    executionIdentity,
    workId: input.workId,
    commandId: input.commandId,
    command: {
      kind: 'argv',
      executable: invocation.executable,
      args: invocation.args,
      cwd: executionIdentity.canonicalRoot,
    },
    interactiveWaitMs,
    timeoutMs: timeoutMs + 5_000,
    resourceClaims: toProcessClaims(claims),
    origin: {
      surface: 'check',
      toolName: 'run_check',
      checkId: input.checkId,
      requestId: input.requestId,
      correlationId: input.workId,
      executionSessionId: input.verificationBinding?.executionSessionId,
      editSessionId: input.verificationBinding?.editSessionId,
      editRevision: input.verificationBinding?.editRevision,
      issueId: input.verificationBinding?.issueId,
      taskId: input.verificationBinding?.taskId,
    },
    signal: input.signal,
  });

  const mode: CheckExecutionMode = handle.completed ? 'direct' : 'managed';
  return {
    mode,
    checkId: input.checkId,
    check,
    process: handle,
    ok: handle.completed ? handle.ok : undefined,
    durableSideEffects: handle.durableSideEffects,
  };
}
