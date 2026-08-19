/**
 * Lightweight run_check facade.
 *
 * Ordinary checks execute through an in-memory lightweight handle and return
 * within the interactive budget without creating Process/Lease state. Checks
 * with real Work/Edit/verification consumers keep persisted Process receipts.
 * Multi-phase and release checks require explicit external Controller handling.
 */

import {
  controllerCheckExecutionIdentity,
  listControllerChecks,
  snapshotControllerCheck,
  type ControllerCheck,
  type ControllerCheckSnapshot,
} from '../../../cli/controller/check-runner';
import { claimsForCheck, scopeResourceClaims, toProcessClaims } from './resource-claims';
import { spawnManagedProcess, waitForProcess, getProcessHandle } from './runtime';
import {
  getLightweightProcessHandle,
  isLightweightProcessId,
  startLightweightControllerCheck,
  waitForLightweightProcess,
} from './lightweight-managed';
import type { ProcessHandle } from './types';
import { DEFAULT_INTERACTIVE_WAIT_MS } from './types';
import { durationAwareInteractiveWaitMs } from './interactive-admission';
import type { ResolvedExecutionIdentity } from '../../control-plane/execution/execution-identity';

export type CheckExecutionMode = 'direct' | 'managed' | 'durable';

export interface RunCheckFacadeInput {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  repoRoot: string;
  checkId: string;
  timeoutMs?: number;
  interactiveWaitMs?: number;
  /**
   * Bounded wait budget for lease conflicts (ms). 0 keeps the historical
   * fail-fast PROCESS_LEASE_CONFLICT behavior; >0 lets Process Runtime wait
   * for conflicting claims to release before acquiring and executing.
   */
  leaseWaitMs?: number;
  requestId?: string;
  /** Stable caller-owned semantic identity for safely reattaching the same request before rebuilding ephemeral execution inputs. */
  requestSemanticFingerprint?: string;
  workId?: string;
  commandId?: string;
  /** Force durable workflow (release / multi-phase). */
  forceDurable?: boolean;
  signal?: AbortSignal;
  /** Immutable resolved identity — required; never inferred from main/active/cwd. */
  executionIdentity: ResolvedExecutionIdentity;
  /** Exact consumers of the resulting persisted Process check receipt. */
  verificationBinding?: {
    executionSessionId?: string;
    editSessionId?: string;
    editRevision?: number;
    issueId?: string;
    taskId?: string;
  };
  /** Work-scoped verification runs against HEAD plus only scope-owned dirty paths. */
  verificationSnapshot?: {
    workId: string;
    allowedPaths: readonly string[];
    forbiddenPaths: readonly string[];
  };
}

export function processCheckSemanticScopeKey(
  input: Pick<RunCheckFacadeInput, 'workId' | 'verificationBinding' | 'checkoutId'>,
  reuseScope: 'repository' | 'checkout',
): string {
  return reuseScope === 'repository' ? 'repository' : `checkout:${input.checkoutId ?? 'unknown'}`;
}

export interface RunCheckFacadeResult {
  mode: CheckExecutionMode;
  checkId: string;
  check?: ControllerCheck;
  /** Present when mode is direct or managed. */
  process?: ProcessHandle;
  /** Present when mode is durable — Kernel must not create a compatibility Job. */
  durable?: {
    reason: string;
    suggestedOperation: string;
  };
  ok?: boolean;
  /** Zero job side effects for process path. */
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
}

const DURABLE_CHECK_ID = /(?:^|:)(?:release|migration|integrate|public-export|deploy)(?:$|:)/i;
/**
 * True when a check requires external Controller handling (multi-phase / release).
 * Ordinary typecheck / lint / package test / focused validation stay on Process Runtime.
 */
export function checkRequiresDurableWorkflow(checkId: string, check?: ControllerCheck): boolean {
  if (DURABLE_CHECK_ID.test(checkId)) return true;
  if (check && /release|rollback|blue.?green|migrate/i.test(check.description)) return true;
  return false;
}

function resolveCheck(repoRoot: string, checkId: string): ControllerCheck | undefined {
  return listControllerChecks(repoRoot).find((entry) => entry.id === checkId);
}

/**
 * Run a configured check through Unified Process Runtime when eligible.
 * Does not create ExecutionJob / LocalBridgeJob / Worker.
 */
export async function runCheckViaProcessRuntime(
  input: RunCheckFacadeInput,
): Promise<RunCheckFacadeResult> {
  const emptyEffects = {
    executionJobCount: 0,
    localJobCount: 0,
    workerSpawnCount: 0,
    projectionUpdateCount: 0,
  };

  const check = resolveCheck(input.repoRoot, input.checkId);
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

  // The wait budget is an interaction preference, not a persistence reason.
  // Ordinary checks stay in memory; only a real durable evidence consumer may
  // allocate Process/Lease state.
  const interactiveWaitMs = durationAwareInteractiveWaitMs(
    check.command,
    input.interactiveWaitMs,
    Math.min(250, DEFAULT_INTERACTIVE_WAIT_MS),
  );
  const timeoutMs = Math.min(
    check.timeoutMs,
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(1_000, Math.trunc(input.timeoutMs))
      : check.timeoutMs,
  );
  const durableVerificationBinding = Boolean(
    input.workId
    || input.verificationSnapshot
    || input.verificationBinding?.executionSessionId
    || input.verificationBinding?.editSessionId
    || input.verificationBinding?.issueId
    || input.verificationBinding?.taskId,
  );
  if (!input.executionIdentity) {
    throw new Error('EXECUTION_IDENTITY_REQUIRED: run_check requires an immutable executionIdentity');
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
  if (!durableVerificationBinding) {
    const lightweight = await startLightweightControllerCheck({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      repoRoot: input.repoRoot,
      checkId: input.checkId,
      interactiveWaitMs,
      timeoutMs,
      workId: input.workId,
      commandId: input.commandId ?? input.requestId,
    });
    const handle = lightweight.handle;
    return {
      mode: handle.completed ? 'direct' : 'managed',
      checkId: input.checkId,
      check,
      process: handle,
      ok: handle.completed ? handle.ok : undefined,
      durableSideEffects: emptyEffects,
    };
  }
  const claims = scopeResourceClaims(
    claimsForCheck(
      input.checkId,
      check.command,
      executionIdentity.repositoryId,
      executionIdentity.checkoutId,
      check.effects,
    ),
    executionIdentity.repositoryId,
    executionIdentity.checkoutId,
    input.workId,
  );
  const cwd = check.cwd === '.'
    ? executionIdentity.canonicalRoot
    : `${executionIdentity.canonicalRoot}/${check.cwd}`.replace(/\/+/g, '/');
  const semanticCheck = controllerCheckExecutionIdentity(input.repoRoot, input.checkId, timeoutMs);
  const processCheckExecution = {
    schemaVersion: 1 as const,
    checkId: semanticCheck.checkId,
    cacheKey: semanticCheck.cacheKey,
    revision: semanticCheck.revision,
    definitionDigest: semanticCheck.definitionDigest,
    environmentFingerprint: semanticCheck.environmentFingerprint,
    timeoutMs: semanticCheck.timeoutMs,
    reuseScope: semanticCheck.reuseScope,
    scopeKey: processCheckSemanticScopeKey({
      checkoutId: executionIdentity.checkoutId,
      workId: input.workId,
      verificationBinding: input.verificationBinding,
    }, semanticCheck.reuseScope),
  };

  const handle = await spawnManagedProcess({
    controllerHome: input.controllerHome,
    repoId: executionIdentity.repositoryId,
    checkoutId: executionIdentity.checkoutId,
    executionIdentity,
    workId: input.workId,
    commandId: input.commandId,
    command: {
      kind: 'argv',
      executable: check.command[0],
      args: check.command.slice(1),
      cwd,
    },
    interactiveWaitMs,
    leaseWaitMs: input.leaseWaitMs,
    timeoutMs,
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

export async function waitForCheckProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
  timeoutMs?: number,
): Promise<ProcessHandle> {
  if (isLightweightProcessId(processId)) {
    return waitForLightweightProcess(controllerHome, repoId, processId, { timeoutMs });
  }
  return waitForProcess(controllerHome, repoId, processId, { timeoutMs });
}

export function getCheckProcessHandle(
  controllerHome: string,
  repoId: string,
  processId: string,
): ProcessHandle | undefined {
  if (isLightweightProcessId(processId)) {
    return getLightweightProcessHandle(controllerHome, repoId, processId);
  }
  return getProcessHandle(controllerHome, repoId, processId);
}

/** Snapshot helper re-export for durable fallback path compatibility. */
export function snapshotCheck(repoRoot: string, checkId: string): ControllerCheckSnapshot {
  return snapshotControllerCheck(repoRoot, checkId);
}
