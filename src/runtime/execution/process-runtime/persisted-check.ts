import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  controllerCheckExecutionIdentity,
  listControllerChecks,
  snapshotControllerCheck,
} from '../../../cli/controller/check-runner';
import {
  currentCliRuntimeTarget,
  resolveCliChildInvocation,
  type CliChildInvocation,
  type CliChildInvocationOptions,
  type CliRuntimeTarget,
} from '../../../cli/runtime-invocation';
import { readRuntimeGeneration, resolveControllerRuntimeSourceRoot } from '../../control-plane/runtime-generation';
import { cleanupWorkVerificationSnapshot, materializeWorkVerificationSnapshot } from '../../control-plane/execution/work-verification-snapshot';
import {
  checkRequiresDurableWorkflow,
  processCheckSemanticScopeKey,
  type CheckExecutionMode,
  type RunCheckFacadeInput,
  type RunCheckFacadeResult,
} from './check-facade';
import { claimsForCheck, toProcessClaims } from './resource-claims';
import { spawnManagedProcess } from './runtime';
import { allocatePersistedCheckResultReceiptPath } from './check-result';
import { durationAwareInteractiveWaitMs } from './interactive-admission';
const PERSISTED_CHECK_SOURCE_ENTRY = 'src/runtime/execution/process-runtime/check-runner-sidecar.ts';

export function resolvePersistedCheckCliInvocation(
  cliEntry: string,
  args: string[],
  options: CliChildInvocationOptions = {},
): CliChildInvocation {
  return resolveCliChildInvocation(cliEntry, args, options);
}

export function resolveRuntimeCliTarget(controllerHome?: string): CliRuntimeTarget {
  const moduleSourceRoot = resolve(import.meta.dir, '..', '..', '..', '..');
  const sourceEntry = resolve(moduleSourceRoot, 'src', 'cli', 'index.ts');
  const source = resolveControllerRuntimeSourceRoot({
    explicitRoot: existsSync(sourceEntry) ? moduleSourceRoot : undefined,
  });
  const sourceMode = Boolean(source.root && existsSync(resolve(source.root, 'src', 'cli', 'index.ts')));
  const runtimeEnv = { ...process.env };
  if (sourceMode) {
    delete runtimeEnv.FORGE_RUNTIME_EXECUTION;
    delete runtimeEnv.FORGE_RUNTIME_CLI_ENTRY;
  }
  const generation = controllerHome ? readRuntimeGeneration(controllerHome) : undefined;
  return currentCliRuntimeTarget({
    env: runtimeEnv,
    argv: sourceMode ? [] : process.argv,
    moduleUrl: sourceMode ? undefined : import.meta.url,
    sourceRoot: source.root,
    cwd: source.root ?? moduleSourceRoot,
    sourceRevision: generation?.source.releaseRevision
      ?? generation?.source.commit
      ?? process.env.FORGE_ACTIVE_RUNTIME_REVISION,
  });
}

export function resolveRuntimeCliEntry(controllerHome?: string): string {
  return resolveRuntimeCliTarget(controllerHome).entry;
}

export function persistedCheckSemanticScopeKey(
  input: Pick<RunCheckFacadeInput, 'workId' | 'verificationBinding' | 'checkoutId'>,
  reuseScope: 'repository' | 'checkout',
): string {
  return processCheckSemanticScopeKey(input, reuseScope);
}

export function resolvePersistedCheckRuntimeExecutable(
  cliTarget: CliRuntimeTarget,
  runtimeExecutable = process.execPath,
  entryExists: (path: string) => boolean = existsSync,
): string {
  if (cliTarget.runtimeKind !== 'compiled_bun_release') return runtimeExecutable;
  const checkRunner = resolve(dirname(runtimeExecutable), 'forge-check-runner');
  if (!entryExists(checkRunner)) {
    throw new Error(`PERSISTED_CHECK_RUNNER_MISSING: ${checkRunner}`);
  }
  return checkRunner;
}

export function resolvePersistedCheckProcessInvocation(
  cliTarget: CliRuntimeTarget,
  args: string[],
  options: { runtimeExecutable?: string; entryExists?: (path: string) => boolean } = {},
): CliChildInvocation {
  const runtimeExecutable = options.runtimeExecutable ?? process.execPath;
  const executable = resolvePersistedCheckRuntimeExecutable(cliTarget, runtimeExecutable, options.entryExists ?? existsSync);
  if (cliTarget.runtimeKind === 'compiled_bun_release') {
    return { executable, args };
  }
  const sourceEntry = resolve(cliTarget.cwd, PERSISTED_CHECK_SOURCE_ENTRY);
  if (!(options.entryExists ?? existsSync)(sourceEntry)) {
    throw new Error(`PERSISTED_CHECK_SOURCE_RUNNER_MISSING: ${sourceEntry}`);
  }
  return resolvePersistedCheckCliInvocation(sourceEntry, args, {
    runtimeExecutable: executable,
    runtimeKind: cliTarget.runtimeKind,
    sourceRevision: cliTarget.sourceRevision,
    immutable: false,
    ...(cliTarget.runtimeKind === 'package_launcher' ? { launcherEntry: cliTarget.entry } : {}),
  });
}

/**
 * Run a registered check through Process Runtime while keeping check-runner
 * evidence authoritative. The managed OS process invokes the same immutable
 * forge CLI bundle with a hidden internal subcommand; that subcommand
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
  const verificationSnapshot = input.verificationSnapshot
    ? materializeWorkVerificationSnapshot({
        controllerHome: input.controllerHome,
        repoId: input.repoId,
        sourceRoot: input.repoRoot,
        scope: input.verificationSnapshot,
      })
    : undefined;
  const executionRoot = verificationSnapshot?.root ?? input.repoRoot;
  const cleanupVerificationSnapshot = () => {
    if (verificationSnapshot) cleanupWorkVerificationSnapshot(verificationSnapshot.root);
  };
  const check = listControllerChecks(executionRoot).find((entry) => entry.id === input.checkId);
  if (!check) {
    cleanupVerificationSnapshot();
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
    cleanupVerificationSnapshot();
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

  const interactiveWaitMs = durationAwareInteractiveWaitMs(check.command, input.interactiveWaitMs);
  const leaseWaitMs = input.leaseWaitMs;
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
  const checkSnapshot = snapshotControllerCheck(executionRoot, input.checkId);
  const checkFingerprint = createHash('sha256')
    .update(JSON.stringify(checkSnapshot))
    .digest('hex');
  const semanticCheck = controllerCheckExecutionIdentity(
    executionRoot,
    input.checkId,
    timeoutMs,
    checkSnapshot,
  );
  const processCheckExecution = {
    schemaVersion: 1 as const,
    checkId: semanticCheck.checkId,
    cacheKey: semanticCheck.cacheKey,
    revision: semanticCheck.revision,
    definitionDigest: semanticCheck.definitionDigest,
    environmentFingerprint: semanticCheck.environmentFingerprint,
    timeoutMs: semanticCheck.timeoutMs,
    reuseScope: semanticCheck.reuseScope,
    scopeKey: persistedCheckSemanticScopeKey(input, semanticCheck.reuseScope),
  };
  const cliTarget = resolveRuntimeCliTarget(input.controllerHome);
  const checkResultReceiptPath = allocatePersistedCheckResultReceiptPath(input.controllerHome, input.repoId);
  const checkArgs = [
    '--repo',
    executionRoot,
    '--check-id',
    input.checkId,
    '--timeout-ms',
    String(timeoutMs),
    '--expected-check-fingerprint',
    checkFingerprint,
    '--result-receipt',
    checkResultReceiptPath,
    ...(verificationSnapshot ? ['--cleanup-root', verificationSnapshot.root] : []),
  ];
  const invocation = resolvePersistedCheckProcessInvocation(cliTarget, checkArgs);
  let handle;
  try {
    handle = await spawnManagedProcess({
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
    leaseWaitMs,
    timeoutMs: timeoutMs + 5_000,
    resourceClaims: toProcessClaims(claims),
    checkExecution: processCheckExecution,
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
      checkResultReceiptPath,
      workVerificationSnapshot: Boolean(verificationSnapshot),
    },
    signal: input.signal,
  });
  } catch (error) {
    cleanupVerificationSnapshot();
    throw error;
  }
  if (verificationSnapshot && (handle.deduplicated === true || handle.semanticDeduplicated === true)) {
    cleanupVerificationSnapshot();
  }

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
