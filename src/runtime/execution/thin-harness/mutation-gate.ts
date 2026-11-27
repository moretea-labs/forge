/**
 * Checkout Mutation Ownership backed by the shared Execution Lease arbiter.
 *
 * Fast Path uses visibility=ephemeral (active set + fencing only; no projection
 * dirty / scheduler wake / runtime events). Durable workers use default durable
 * leases. Both contend on the same claim set with expanded path/git-ref overlap.
 *
 * Ownership lifecycle is covered by the mutation lease alone — do NOT hold the
 * repository controller lock for the duration of the write (renew needs that lock).
 *
 * Claims cover exact paths when known; unknown effects receive only an
 * owner-scoped fencing lease. Git index and repository refs are claimed only
 * when the operation actually mutates those resources.
 */
import { createHash } from 'crypto';
import {
  acquireExecutionLeases,
  assertFencingToken,
  releaseExactExecutionLeases,
  renewExecutionLeases,
} from '../../resources/leases/store';
import type { ExecutionLease, ExecutionLeaseOwnerIdentity } from '../../resources/leases/types';
import { recordGatewayLatency } from '../../../core/observability/gateway-contention-metrics';
import type { ResourceClaimSpec } from '../../execution/jobs/types';
import { normalizeClaims } from '../../resources/claims/conflicts';
import { claimGitIndex, claimGitRefs, claimRequiredPathWrites } from '../process-runtime/resource-claims';
import { runBoundedGit } from './async-process';
import { terminateProcessTree } from '../../shared/process-tree';

export interface CheckoutMutationGate {
  gateId: string;
  owner: string;
  ownerJobId: string;
  repoId: string;
  checkoutId: string;
  resourceKey: string;
  resourceKeys: string[];
  leaseIds: string[];
  primaryLeaseId: string;
  leaseId: string;
  fencingToken: number;
  fencingTokens: Record<string, number>;
  baseHead: string | null;
  baseStatusHash: string | null;
  acquiredAt: string;
  expiresAt: string;
  ttlMs: number;
  renewCount: number;
  claims: ResourceClaimSpec[];
  ownerIdentity: ExecutionLeaseOwnerIdentity;
  ownerIdentityDigest: string;
}

export interface MutationGateBusy {
  busy: true;
  reason: string;
  blockers: Array<{ kind: 'fast_gate' | 'durable_lease'; owner: string; resourceKey?: string; leaseId?: string }>;
}

export type MutationGateAcquireResult = { acquired: true; gate: CheckoutMutationGate } | MutationGateBusy;

export interface MutationGateHelpers {
  renew: () => CheckoutMutationGate;
  assert: () => void;
  /** Aborts when ownership is lost or renew fails. Combine with caller signal. */
  signal: AbortSignal;
  getGate: () => CheckoutMutationGate;
  /** Register a child pid for ownership-loss process-tree kill. */
  trackChildPid: (pid: number) => void;
  /** True when ownership abort fired. */
  ownershipLost: () => boolean;
}

export interface MutationOwnershipOptions {
  /** Paths that will be written (path:<checkout>:<rel> claims). */
  writePaths?: string[];
  /** When true, also claim git-ref (commit / branch mutation). */
  mutatesGitRefs?: boolean;
  /** When true, claim the checkout's Git index. */
  mutatesGitIndex?: boolean;
}

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 3_000;
const MAX_TTL_MS = 120_000;

const EPHEMERAL_OPTS = {
  visibility: 'ephemeral' as const,
  notifyScheduler: false,
  invalidateProjection: false,
  emitRuntimeEvent: false,
};

export function normalizeMutationOwnerIdentity(input: {
  repoId: string;
  checkoutId: string;
  owner: string;
  ownerIdentity?: Partial<ExecutionLeaseOwnerIdentity>;
}): ExecutionLeaseOwnerIdentity {
  const supplied = input.ownerIdentity;
  if (supplied?.repositoryId && supplied.repositoryId !== input.repoId) {
    throw new Error(`MUTATION_OWNER_REPOSITORY_MISMATCH: expected ${input.repoId}, received ${supplied.repositoryId}`);
  }
  if (supplied?.checkoutId && supplied.checkoutId !== input.checkoutId) {
    throw new Error(`MUTATION_OWNER_CHECKOUT_MISMATCH: expected ${input.checkoutId}, received ${supplied.checkoutId}`);
  }
  return {
    repositoryId: input.repoId,
    checkoutId: input.checkoutId,
    worktreeId: supplied?.worktreeId?.trim() || input.checkoutId,
    branch: supplied?.branch?.trim() || 'unknown',
    principalId: supplied?.principalId?.trim() || `owner:${input.owner}`,
    controllerInstanceId:
      supplied?.controllerInstanceId?.trim() ||
      process.env.FORGE_RUNTIME_INSTANCE_ID?.trim() ||
      process.env.FORGE_WRITER_INSTANCE_ID?.trim() ||
      process.env.FORGE_DAEMON_INSTANCE_ID?.trim() ||
      `process:${process.pid}`,
    controllerGeneration:
      supplied?.controllerGeneration?.trim() ||
      process.env.FORGE_RUNTIME_INCARNATION_GENERATION?.trim() ||
      process.env.FORGE_WRITER_GENERATION?.trim() ||
      process.env.FORGE_ACTIVE_RUNTIME_REVISION?.trim() ||
      'unbound',
  };
}

export function buildMutationClaims(
  repoId: string,
  checkoutId: string,
  options: MutationOwnershipOptions = {},
): ResourceClaimSpec[] {
  // Use the same constructors and conflict keys as Process Runtime. This keeps
  // Fast and managed writes on one resource vocabulary and scopes Git refs to
  // their owning repository rather than a process-global wildcard.
  return normalizeClaims([
    ...claimRequiredPathWrites(options.writePaths ?? [], checkoutId, repoId),
    ...(options.mutatesGitIndex === true ? [claimGitIndex(checkoutId, repoId)] : []),
    ...(options.mutatesGitRefs ? [claimGitRefs(repoId)] : []),
  ]);
}

async function snapshotHead(repoRoot: string): Promise<string | null> {
  const result = await runBoundedGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  if (result.cancelled) throw new Error('CANCELLED: Git HEAD snapshot aborted');
  return result.ok ? result.stdout.trim() || null : null;
}

function gateFromLeases(
  ownerJobId: string,
  repoId: string,
  checkoutId: string,
  claims: ResourceClaimSpec[],
  leases: ExecutionLease[],
  snap: { head: string | null; statusHash: string | null },
  ttlMs: number,
  ownerIdentity: ExecutionLeaseOwnerIdentity,
): CheckoutMutationGate {
  const primary = leases[0]!;
  const fencingTokens: Record<string, number> = {};
  for (const lease of leases) {
    fencingTokens[lease.leaseId] = lease.fencingToken;
  }
  return {
    gateId: ownerJobId,
    owner: ownerJobId,
    ownerJobId,
    repoId,
    checkoutId,
    resourceKey: primary.resourceKey,
    resourceKeys: leases.map((lease) => lease.resourceKey),
    leaseIds: leases.map((lease) => lease.leaseId),
    primaryLeaseId: primary.leaseId,
    leaseId: primary.leaseId,
    fencingToken: primary.fencingToken,
    fencingTokens,
    baseHead: snap.head,
    baseStatusHash: snap.statusHash,
    acquiredAt: primary.acquiredAt,
    expiresAt: primary.expiresAt,
    ttlMs,
    renewCount: 0,
    claims,
    ownerIdentity,
    ownerIdentityDigest:
      primary.ownerIdentityDigest ?? createHash('sha256').update(JSON.stringify(ownerIdentity)).digest('hex'),
  };
}

/**
 * Acquire exact resource claims via ephemeral Execution Lease(s).
 * Only Git-ref mutations capture a HEAD baseline after lease acquisition;
 * source-only writes never hash checkout-wide status or unrelated dirty files.
 */
export async function acquireCheckoutMutationGate(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  owner: string;
  ttlMs?: number;
  ownership?: MutationOwnershipOptions;
  ownerIdentity?: Partial<ExecutionLeaseOwnerIdentity>;
}): Promise<MutationGateAcquireResult> {
  const ttlMs = Math.max(MIN_TTL_MS, Math.min(input.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS));
  const startedAt = performance.now();
  const ownerIdentity = normalizeMutationOwnerIdentity(input);
  const ownerJobId =
    input.owner.startsWith('fast:') || input.owner.startsWith('JOB-') ? input.owner : `fast:${input.owner}`;
  const exactClaims = buildMutationClaims(input.repoId, input.checkoutId, input.ownership);
  // Writer identity is attribution, not a monopoly: an edit without exact
  // claims holds only its own owner-scoped lease for fencing/renewal (#713).
  const claims = (
    exactClaims.length > 0
      ? exactClaims
      : [{ resourceKey: `writer:${input.checkoutId}:${ownerJobId}`, mode: 'write' as const }]
  ).map((claim) => ({
    ...claim,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
  }));

  const result = acquireExecutionLeases(input.controllerHome, input.repoId, ownerJobId, claims, {
    ...EPHEMERAL_OPTS,
    ttlMs,
    ownerIdentity,
  });

  if (!result.acquired || result.leases.length === 0) {
    recordGatewayLatency({
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      operationClass: 'mutation',
      phase: 'lock_wait',
      durationMs: performance.now() - startedAt,
      outcome: 'contention',
    });
    return {
      busy: true,
      reason: 'mutation_ownership_busy',
      blockers: result.blockers.map((blocker) => ({
        kind: blocker.ownerJobId.startsWith('fast:') ? ('fast_gate' as const) : ('durable_lease' as const),
        owner: blocker.ownerJobId,
        resourceKey: blocker.resourceKey,
        leaseId: blocker.leaseId,
      })),
    };
  }

  let snap: { head: string | null; statusHash: string | null };
  try {
    snap = input.ownership?.mutatesGitRefs
      ? { head: await snapshotHead(input.repoRoot), statusHash: null }
      : { head: null, statusHash: null };
  } catch (error) {
    releaseExactExecutionLeases(
      input.controllerHome,
      input.repoId,
      ownerJobId,
      result.leases.map((lease) => ({
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        repoId: input.repoId,
        checkoutId: input.checkoutId,
        ownerIdentityDigest: lease.ownerIdentityDigest,
      })),
      EPHEMERAL_OPTS,
    );
    return {
      busy: true,
      reason: 'snapshot_failed',
      blockers: [
        {
          kind: 'fast_gate',
          owner: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  recordGatewayLatency({
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    operationClass: 'mutation',
    phase: 'lock_wait',
    durationMs: performance.now() - startedAt,
    outcome: 'success',
  });
  return {
    acquired: true,
    gate: gateFromLeases(ownerJobId, input.repoId, input.checkoutId, claims, result.leases, snap, ttlMs, ownerIdentity),
  };
}

export function renewCheckoutMutationGate(
  controllerHome: string,
  gate: CheckoutMutationGate,
  ttlMs?: number,
): CheckoutMutationGate {
  const nextTtl = Math.max(MIN_TTL_MS, Math.min(ttlMs ?? gate.ttlMs, MAX_TTL_MS));
  const expected = gate.leaseIds.map((leaseId) => ({
    leaseId,
    fencingToken: gate.fencingTokens[leaseId] ?? gate.fencingToken,
    ownerIdentityDigest: gate.ownerIdentityDigest,
  }));
  const renewed = renewExecutionLeases(controllerHome, gate.repoId, gate.ownerJobId, nextTtl, expected);
  if (renewed.length === 0) {
    throw new Error(`MUTATION_RENEW_FAILED: no leases renewed for ${gate.ownerJobId}`);
  }
  const fencingTokens: Record<string, number> = { ...gate.fencingTokens };
  let expiresAt = gate.expiresAt;
  let fencingToken = gate.fencingToken;
  for (const lease of renewed) {
    fencingTokens[lease.leaseId] = lease.fencingToken;
    expiresAt = lease.expiresAt;
    if (lease.leaseId === gate.primaryLeaseId || lease.resourceKey === gate.resourceKey) {
      fencingToken = lease.fencingToken;
    }
  }
  return {
    ...gate,
    expiresAt,
    fencingToken,
    fencingTokens,
    ttlMs: nextTtl,
    renewCount: gate.renewCount + 1,
  };
}

export function assertCheckoutMutationGate(controllerHome: string, gate: CheckoutMutationGate): ExecutionLease {
  let primary: ExecutionLease | undefined;
  for (const leaseId of gate.leaseIds) {
    const token = gate.fencingTokens[leaseId] ?? gate.fencingToken;
    const lease = assertFencingToken(controllerHome, gate.repoId, leaseId, token);
    if (lease.ownerIdentityDigest !== gate.ownerIdentityDigest) {
      throw new Error(`MUTATION_OWNER_IDENTITY_STALE: ${leaseId}`);
    }
    if (leaseId === gate.primaryLeaseId) primary = lease;
  }
  if (!primary) {
    primary = assertFencingToken(controllerHome, gate.repoId, gate.leaseId, gate.fencingToken);
    if (primary.ownerIdentityDigest !== gate.ownerIdentityDigest) {
      throw new Error(`MUTATION_OWNER_IDENTITY_STALE: ${gate.leaseId}`);
    }
  }
  return primary;
}

export function releaseCheckoutMutationGate(
  controllerHome: string,
  repoId: string,
  checkoutId: string,
  gateIdOrOwner?: string,
  fencing?: { leaseId: string; fencingToken: number } | Array<{ leaseId: string; fencingToken: number }>,
): void {
  if (!gateIdOrOwner) return;
  if (!fencing) throw new Error('MUTATION_RELEASE_FENCING_REQUIRED');
  const expected = (Array.isArray(fencing) ? fencing : [fencing]).map((entry) => ({
    ...entry,
    repoId,
    checkoutId,
  }));
  releaseExactExecutionLeases(controllerHome, repoId, gateIdOrOwner, expected, EPHEMERAL_OPTS);
}

export function releaseCheckoutMutationGateOwned(controllerHome: string, gate: CheckoutMutationGate): void {
  releaseExactExecutionLeases(
    controllerHome,
    gate.repoId,
    gate.ownerJobId,
    gate.leaseIds.map((leaseId) => ({
      leaseId,
      fencingToken: gate.fencingTokens[leaseId] ?? gate.fencingToken,
      repoId: gate.repoId,
      checkoutId: gate.checkoutId,
      ownerIdentityDigest: gate.ownerIdentityDigest,
    })),
    EPHEMERAL_OPTS,
  );
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export interface WithMutationGateResult<T> {
  ok: true;
  value: T;
  gate: CheckoutMutationGate;
  /** When kill of tracked children could not be confirmed. */
  processStopUnconfirmed?: boolean;
}

/**
 * Hold mutation ownership for the duration of operation with automatic heartbeat renew.
 * Renew interval = ttl/3. Renew failure aborts ownershipSignal (not only flags).
 * Does NOT hold repository controller lock during operation.
 */
export async function withCheckoutMutationGate<T>(
  input: {
    controllerHome: string;
    repoId: string;
    checkoutId: string;
    repoRoot: string;
    owner: string;
    ttlMs?: number;
    signal?: AbortSignal;
    ownership?: MutationOwnershipOptions;
    ownerIdentity?: Partial<ExecutionLeaseOwnerIdentity>;
  },
  operation: (gate: CheckoutMutationGate, helpers: MutationGateHelpers) => Promise<T>,
): Promise<WithMutationGateResult<T> | { ok: false; busy: MutationGateBusy }> {
  const acquired = await acquireCheckoutMutationGate(input);
  if (!('acquired' in acquired) || !acquired.acquired) {
    return { ok: false, busy: acquired as MutationGateBusy };
  }

  let gate = acquired.gate;
  const ownershipAbort = new AbortController();
  const combined = combineAbortSignals([input.signal, ownershipAbort.signal]);
  let renewFailed: Error | undefined;
  const trackedPids = new Set<number>();
  let processStopUnconfirmed = false;
  const renewIntervalMs = Math.max(500, Math.floor(gate.ttlMs / 3));

  const killTracked = async () => {
    for (const pid of trackedPids) {
      try {
        const result = await terminateProcessTree(pid, {
          gracePeriodMs: 200,
          killAfterMs: 1_500,
          pollIntervalMs: 50,
        });
        if (!result.exited || result.remainingPids.length > 0) {
          processStopUnconfirmed = true;
        }
      } catch {
        processStopUnconfirmed = true;
      }
    }
  };

  const failOwnership = (error: unknown) => {
    if (renewFailed) return;
    renewFailed = error instanceof Error ? error : new Error(String(error));
    try {
      ownershipAbort.abort(renewFailed);
    } catch {
      /* already aborted */
    }
    void killTracked();
  };

  const timer = setInterval(() => {
    try {
      gate = renewCheckoutMutationGate(input.controllerHome, gate);
    } catch (error) {
      failOwnership(error);
    }
  }, renewIntervalMs);
  timer.unref?.();

  const helpers: MutationGateHelpers = {
    renew: () => {
      if (renewFailed) throw renewFailed;
      gate = renewCheckoutMutationGate(input.controllerHome, gate);
      return gate;
    },
    assert: () => {
      if (renewFailed) throw renewFailed;
      if (combined.aborted) throw new Error('MUTATION_OWNERSHIP_LOST: ownership signal aborted');
      assertCheckoutMutationGate(input.controllerHome, gate);
    },
    signal: combined,
    getGate: () => gate,
    trackChildPid: (pid: number) => {
      if (pid > 0) trackedPids.add(pid);
    },
    ownershipLost: () => Boolean(renewFailed) || ownershipAbort.signal.aborted,
  };

  try {
    const value = await operation(gate, helpers);
    if (renewFailed) throw renewFailed;
    assertCheckoutMutationGate(input.controllerHome, gate);
    return { ok: true, value, gate, processStopUnconfirmed: processStopUnconfirmed || undefined };
  } catch (error) {
    if (ownershipAbort.signal.aborted) {
      await killTracked();
    }
    throw error;
  } finally {
    clearInterval(timer);
    try {
      releaseCheckoutMutationGateOwned(input.controllerHome, gate);
    } catch {
      /* best-effort release */
    }
  }
}

export function mutationGateBusyMessage(busy: MutationGateBusy): string {
  const owners = busy.blockers.map((entry) => entry.owner).join(', ');
  return `${busy.reason}: active writers=[${owners}]`;
}

/**
 * Build unknown-outcome payload when process stop cannot be confirmed after ownership loss.
 */
export function unknownOwnershipOutcome(input: { repositoryChanged?: boolean }): {
  outcome: 'unknown';
  repositoryChanged: true;
  reconciliationRequired: true;
} {
  return {
    outcome: 'unknown',
    repositoryChanged: true,
    reconciliationRequired: true,
    ...(input.repositoryChanged === false ? {} : {}),
  };
}
