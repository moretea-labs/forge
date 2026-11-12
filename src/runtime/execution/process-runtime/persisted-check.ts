import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  controllerCheckExecutionIdentity,
  controllerCheckLiveExecutionStateFingerprint,
  listControllerChecks,
  snapshotControllerCheck,
} from './check-runner';
import {
  currentCliRuntimeTarget,
  resolveCliChildInvocation,
  type CliChildInvocation,
  type CliChildInvocationOptions,
  type CliRuntimeTarget,
} from '../../../cli/runtime-invocation';
import { readRuntimeGeneration, resolveControllerRuntimeSourceRoot } from '../../control-plane/runtime-generation';
import { resolveBunExecutable } from '../../shared/process-environment';
import {
  checkRequiresDurableWorkflow,
  processCheckSemanticScopeKey,
  type CheckExecutionMode,
  type RunCheckFacadeInput,
  type RunCheckFacadeResult,
} from './check-facade';
import { claimsForCheck, claimsRequireLiveDeviceAdmission, LIVE_DEVICE_ADMISSION_WAIT_MS, toProcessClaims } from './resource-claims';
import { getProcessHandle, spawnWithQueuedAdmission } from './runtime';
import { getProcessRecord, getProcessRequestBinding } from './store';
import { allocatePersistedCheckResultReceiptPath } from './check-result';
import { durationAwareInteractiveWaitMs } from './interactive-admission';

const PERSISTED_CHECK_SOURCE_ENTRY = 'src/runtime/execution/process-runtime/check-runner-sidecar.ts';
const PERSISTED_CHECK_NODE_LOADER = 'src/runtime/shared/node-ts-loader.mjs';

export function resolvePersistedCheckCliInvocation(
  cliEntry: string,
  args: string[],
  options: CliChildInvocationOptions = {},
): CliChildInvocation {
  return resolveCliChildInvocation(cliEntry, args, options);
}

export function resolveRuntimeCliTarget(controllerHome?: string): CliRuntimeTarget {
  const moduleDir = typeof import.meta.dir === 'string' && import.meta.dir
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));
  const moduleSourceRoot = resolve(moduleDir, '..', '..', '..', '..');
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
  input: Pick<RunCheckFacadeInput, 'verificationBinding' | 'checkoutId' | 'requestSemanticFingerprint'>,
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
  const checkRunner = resolve(cliTarget.cwd, 'forge-check-runner');
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
  const entryExists = options.entryExists ?? existsSync;
  const sourceEntry = resolve(cliTarget.cwd, PERSISTED_CHECK_SOURCE_ENTRY);
  if (!entryExists(sourceEntry)) {
    throw new Error(`PERSISTED_CHECK_SOURCE_RUNNER_MISSING: ${sourceEntry}`);
  }
  let nodeSourceLoaderEntry: string | undefined;
  if (cliTarget.runtimeKind === 'node_source') {
    nodeSourceLoaderEntry = resolve(cliTarget.cwd, PERSISTED_CHECK_NODE_LOADER);
    if (!entryExists(nodeSourceLoaderEntry)) {
      throw new Error(`PERSISTED_CHECK_NODE_LOADER_MISSING: ${nodeSourceLoaderEntry}`);
    }
  }
  return resolvePersistedCheckCliInvocation(sourceEntry, args, {
    runtimeExecutable: executable,
    runtimeKind: cliTarget.runtimeKind,
    sourceRevision: cliTarget.sourceRevision,
    immutable: false,
    ...(nodeSourceLoaderEntry ? { nodeSourceLoaderEntry } : {}),
    ...(cliTarget.runtimeKind === 'package_launcher' ? { launcherEntry: cliTarget.entry } : {}),
  });
}

/**
 * Run a registered check through Process Runtime while keeping check-runner
 * evidence authoritative. Repository source under test is the explicitly
 * selected checkout; Process/lease/receipt authority remains in the active Runtime.
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
  const requestId = input.requestId?.trim();
  const requestSemanticFingerprint = input.requestSemanticFingerprint?.trim();
  if (requestId && requestSemanticFingerprint) {
    const binding = getProcessRequestBinding(input.controllerHome, input.repoId, input.checkoutId, requestId);
    if (binding) {
      const record = getProcessRecord(input.controllerHome, input.repoId, binding.processId);
      const exactIdentity = Boolean(
        record
        && record.repoId === input.repoId
        && (record.checkoutId?.trim() || undefined) === (input.checkoutId?.trim() || undefined)
        && record.origin?.surface === 'check'
        && record.origin.requestId === requestId
        && record.origin.checkId === input.checkId
        && record.origin.requestSemanticFingerprint === requestSemanticFingerprint,
      );
      if (!exactIdentity) throw new Error(`PROCESS_REQUEST_ID_CONFLICT: ${requestId}`);
      const existing = getProcessHandle(input.controllerHome, input.repoId, binding.processId);
      if (!existing) {
        throw new Error(`PROCESS_REQUEST_INCOMPLETE: request ${requestId} is bound to missing process ${binding.processId}; refusing re-execution`);
      }
      const check = listControllerChecks(input.repoRoot).find((entry) => entry.id === input.checkId);
      return {
        mode: existing.completed ? 'direct' : 'managed',
        checkId: input.checkId,
        check,
        process: { ...existing, deduplicated: true, requestId },
        ok: existing.completed ? existing.ok : undefined,
        durableSideEffects: emptyEffects,
      };
    }
  }
  // Freeze the exact registered check definition before execution. Source-under-test
  // identity comes from the explicitly selected repository/checkout, not Work.
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
  const checkSnapshot = snapshotControllerCheck(input.repoRoot, input.checkId);
  const executionRoot = input.repoRoot;
  if (check.id !== checkSnapshot.id) {
    throw new Error(`CHECK_DEFINITION_AUTHORITY_MISMATCH: ${input.checkId}`);
  }
  if (input.forceDurable || (checkRequiresDurableWorkflow(input.checkId, check) && input.allowDurableCheckExecution !== true)) {
    return {
      mode: 'durable',
      checkId: input.checkId,
      check,
      durable: {
        reason: 'multi_phase_or_release_check_requires_durable_workflow',
        suggestedOperation: 'Run this check through the explicit release/durable verification workflow.',
      },
      durableSideEffects: emptyEffects,
    };
  }

  const interactiveWaitMs = durationAwareInteractiveWaitMs(check.command, input.interactiveWaitMs);
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
    check.executionAuthority,
  );
  const usesLiveDevice = claimsRequireLiveDeviceAdmission(claims);
  const leaseWaitMs = input.leaseWaitMs
    ?? (usesLiveDevice ? LIVE_DEVICE_ADMISSION_WAIT_MS : undefined);
  const checkFingerprint = createHash('sha256')
    .update(JSON.stringify(checkSnapshot))
    .digest('hex');
  const liveCertification = check.executionAuthority === 'live_controller_home';
  if (liveCertification && input.allowDurableCheckExecution !== true) {
    throw new Error('LIVE_CHECK_DURABLE_AUTHORITY_REQUIRED');
  }
  const liveExecutionStateFingerprint = liveCertification
    ? controllerCheckLiveExecutionStateFingerprint(input.controllerHome)
    : undefined;
  const preliminarySemanticCheck = controllerCheckExecutionIdentity(
    executionRoot,
    input.checkId,
    timeoutMs,
    checkSnapshot,
    liveExecutionStateFingerprint,
  );
  // Freeze the same exact EditSession input for both Process reuse and the
  // Check Runner's own success cache; a fresh Process alone is insufficient.
  const editInputFingerprint = input.verificationBinding?.editSessionId
    ? input.requestSemanticFingerprint?.trim() : undefined;
  const executionStateFingerprint = editInputFingerprint
    ? createHash('sha256').update(JSON.stringify({ liveExecutionStateFingerprint: liveExecutionStateFingerprint ?? '', editInputFingerprint })).digest('hex').slice(0, 24)
    : liveExecutionStateFingerprint;
  const semanticCheck = editInputFingerprint
    ? controllerCheckExecutionIdentity(
        executionRoot,
        input.checkId,
        timeoutMs,
        checkSnapshot,
        executionStateFingerprint,
      )
    : preliminarySemanticCheck;
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
  const checkResultReceiptPath = allocatePersistedCheckResultReceiptPath(
    input.controllerHome,
    input.repoId,
    input.requestId,
  );
  const checkArgs = [
    '--repo',
    executionRoot,
    '--controller-home',
    input.controllerHome,
    '--repo-id',
    input.repoId,
    '--check-id',
    input.checkId,
    '--timeout-ms',
    String(timeoutMs),
    '--expected-check-fingerprint',
    checkFingerprint,
    '--check-snapshot',
    Buffer.from(JSON.stringify(checkSnapshot)).toString('base64url'),
    '--result-receipt',
    checkResultReceiptPath,
    ...(executionStateFingerprint ? ['--execution-state-fingerprint', executionStateFingerprint] : [])
  ];
  const invocation = resolvePersistedCheckProcessInvocation(cliTarget, checkArgs);
  let handle;
  try {
    handle = await spawnWithQueuedAdmission({
    controllerHome: input.controllerHome,
    repoId: executionIdentity.repositoryId,
    checkoutId: executionIdentity.checkoutId,
    executionIdentity,
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
      requestSemanticFingerprint: input.requestSemanticFingerprint,
      executionSessionId: input.verificationBinding?.executionSessionId,
      editSessionId: input.verificationBinding?.editSessionId,
      editRevision: input.verificationBinding?.editRevision,
      issueId: input.verificationBinding?.issueId,
      taskId: input.verificationBinding?.taskId,
      checkResultReceiptPath,
    },
    signal: input.signal,
  }, usesLiveDevice);
  } catch (error) {
    throw error;
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
