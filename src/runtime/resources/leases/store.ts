import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { ControllerLockContentionError, withControllerLock } from '../../../cli/repositories/locks';
import type { ResourceClaimSpec } from '../../execution/jobs/types';
import { readJsonFile, removeFile, writeJsonAtomic } from '../../shared/json-files';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { touchSchedulerWakeSignal } from '../../control-plane/global-scheduler/wake-signal';
import { claimsConflict } from '../claims/conflicts';
import { appendRuntimeEvent } from '../../evidence/event-ledger';
import { assertRuntimeMayWrite, assertRuntimeMayWriteOrThrow } from '../../root/write-fence';
import type {
  ExecutionLease,
  LeaseAcquisitionOptions,
  LeaseAcquisitionResult,
  LeaseVisibility,
  ExecutionLeaseOwnerIdentity,
} from './types';

function leaseRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'leases');
}
function activeRoot(controllerHome: string, repoId: string): string { return join(leaseRoot(controllerHome, repoId), 'active'); }
function leasePath(controllerHome: string, repoId: string, leaseId: string): string { return join(activeRoot(controllerHome, repoId), `${leaseId}.json`); }
function counterPath(controllerHome: string, repoId: string, resourceKey: string): string {
  const hash = createHash('sha256').update(resourceKey).digest('hex');
  return join(leaseRoot(controllerHome, repoId), 'counters', `${hash}.json`);
}
function expired(lease: ExecutionLease): boolean { return Date.parse(lease.expiresAt) <= Date.now(); }

function validateClaimScopes(repoId: string, claims: ResourceClaimSpec[]): void {
  const checkoutIds = new Set<string>();
  const workIds = new Set<string>();
  for (const claim of claims) {
    const claimRepoId = claim.repoId?.trim();
    const checkoutId = claim.checkoutId?.trim();
    const workId = claim.workId?.trim();
    if (claimRepoId && claimRepoId !== repoId) {
      throw new Error(`LEASE_REPOSITORY_SCOPE_MISMATCH: expected ${repoId}, received ${claimRepoId}`);
    }
    if (checkoutId) checkoutIds.add(checkoutId);
    if (workId) workIds.add(workId);
    if (workId && (!claimRepoId || !checkoutId)) {
      throw new Error(`LEASE_WORK_SCOPE_INCOMPLETE: ${workId}`);
    }
  }
  if (checkoutIds.size > 1) throw new Error('LEASE_CHECKOUT_SCOPE_AMBIGUOUS');
  if (workIds.size > 1) throw new Error('LEASE_WORK_SCOPE_AMBIGUOUS');
}

function ownerIdentityDigest(identity: ExecutionLeaseOwnerIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    identity.repositoryId,
    identity.checkoutId,
    identity.worktreeId,
    identity.branch,
    identity.principalId,
    identity.controllerInstanceId,
    identity.controllerGeneration,
  ])).digest('hex');
}

function normalizedOwnerIdentity(
  repoId: string,
  ownerJobId: string,
  claims: ResourceClaimSpec[],
  provided?: ExecutionLeaseOwnerIdentity,
): ExecutionLeaseOwnerIdentity {
  const claimCheckout = claims.find((claim) => claim.checkoutId?.trim())?.checkoutId?.trim();
  if (provided?.repositoryId !== undefined && provided.repositoryId !== repoId) {
    throw new Error(`LEASE_OWNER_REPOSITORY_MISMATCH: expected ${repoId}, received ${provided.repositoryId}`);
  }
  if (provided?.checkoutId && claimCheckout && provided.checkoutId !== claimCheckout) {
    throw new Error(`LEASE_OWNER_CHECKOUT_MISMATCH: claim ${claimCheckout}, owner ${provided.checkoutId}`);
  }
  const checkoutId = provided?.checkoutId?.trim() || claimCheckout || 'unscoped';
  return {
    repositoryId: repoId,
    checkoutId,
    worktreeId: provided?.worktreeId?.trim() || checkoutId,
    branch: provided?.branch?.trim() || 'unknown',
    principalId: provided?.principalId?.trim() || `owner:${ownerJobId}`,
    controllerInstanceId: provided?.controllerInstanceId?.trim()
      || process.env.FORGE_WRITER_INSTANCE_ID?.trim()
      || process.env.FORGE_DAEMON_INSTANCE_ID?.trim()
      || `process:${process.pid}`,
    controllerGeneration: provided?.controllerGeneration?.trim()
      || process.env.FORGE_WRITER_GENERATION?.trim()
      || process.env.FORGE_ACTIVE_RUNTIME_REVISION?.trim()
      || 'unbound',
  };
}

function nextFencingToken(controllerHome: string, repoId: string, resourceKey: string): number {
  const path = counterPath(controllerHome, repoId, resourceKey);
  const current = readJsonFile<{ value: number }>(path, { value: 0 });
  const value = Math.max(0, current.value) + 1;
  writeJsonAtomic(path, { value, resourceKey, updatedAt: new Date().toISOString() });
  return value;
}

function resolveSideEffects(options?: LeaseAcquisitionOptions, visibility?: LeaseVisibility): {
  visibility: LeaseVisibility;
  notifyScheduler: boolean;
  invalidateProjection: boolean;
  emitRuntimeEvent: boolean;
} {
  const vis = options?.visibility ?? visibility ?? 'durable';
  const ephemeral = vis === 'ephemeral';
  return {
    visibility: vis,
    notifyScheduler: options?.notifyScheduler ?? !ephemeral,
    invalidateProjection: options?.invalidateProjection ?? !ephemeral,
    emitRuntimeEvent: options?.emitRuntimeEvent ?? !ephemeral,
  };
}

/** Instrumentation counters for Thin Harness metrics (process-local). */
const leaseSideEffectMetrics = {
  durableAcquireEvents: 0,
  durableReleaseEvents: 0,
  projectionDirtyMarks: 0,
  schedulerWakes: 0,
  ephemeralAcquires: 0,
  ephemeralReleases: 0,
};

export function getLeaseSideEffectMetrics() {
  return { ...leaseSideEffectMetrics };
}

export function resetLeaseSideEffectMetrics(): void {
  leaseSideEffectMetrics.durableAcquireEvents = 0;
  leaseSideEffectMetrics.durableReleaseEvents = 0;
  leaseSideEffectMetrics.projectionDirtyMarks = 0;
  leaseSideEffectMetrics.schedulerWakes = 0;
  leaseSideEffectMetrics.ephemeralAcquires = 0;
  leaseSideEffectMetrics.ephemeralReleases = 0;
}

export function listActiveLeases(controllerHome: string, repoId: string): ExecutionLease[] {
  try {
    const leases: ExecutionLease[] = [];
    for (const name of readdirSync(activeRoot(controllerHome, repoId)).filter((entry) => entry.endsWith('.json')).slice(0, 5000)) {
      const path = join(activeRoot(controllerHome, repoId), name);
      try {
        const lease = readJsonFile<ExecutionLease>(path);
        if (expired(lease)) removeFile(path);
        else leases.push(lease);
      } catch { removeFile(path); }
    }
    return leases;
  } catch { return []; }
}

export function acquireExecutionLeases(
  controllerHome: string,
  repoId: string,
  ownerJobId: string,
  claims: ResourceClaimSpec[],
  ttlMsOrOptions: number | LeaseAcquisitionOptions = 30_000,
): LeaseAcquisitionResult {
  // Canonical Runtime fencing: passive or stale runtimes must not acquire leases.
  const fence = assertRuntimeMayWrite('renew_lease', controllerHome);
  if (!fence.allowed) {
    return {
      acquired: false,
      leases: [],
      blockers: [{
        resourceKey: 'runtime-authority',
        ownerJobId: 'runtime-fence',
        leaseId: fence.reason ?? 'runtime_fenced',
        mode: 'exclusive',
      }],
    };
  }

  validateClaimScopes(repoId, claims);
  const options: LeaseAcquisitionOptions = typeof ttlMsOrOptions === 'number'
    ? { ttlMs: ttlMsOrOptions }
    : ttlMsOrOptions;
  const ttlMs = options.ttlMs ?? 30_000;
  const effects = resolveSideEffects(options);
  const ownerIdentity = normalizedOwnerIdentity(repoId, ownerJobId, claims, options.ownerIdentity);
  const identityDigest = ownerIdentityDigest(ownerIdentity);

  try {
    return withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-acquire:${ownerJobId}`, () => {
    const active = listActiveLeases(controllerHome, repoId).filter((lease) => lease.ownerJobId !== ownerJobId);
    const blockers = claims.flatMap((claim) => active
      .filter((lease) => claimsConflict(claim, lease))
      .map((lease) => ({ resourceKey: lease.resourceKey, ownerJobId: lease.ownerJobId, leaseId: lease.leaseId, mode: lease.mode, ownerIdentityDigest: lease.ownerIdentityDigest })));
    if (blockers.length > 0) return { acquired: false, leases: [], blockers };
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max(5_000, ttlMs)).toISOString();
    const leases = claims.map((claim): ExecutionLease => ({
      schemaVersion: 1,
      leaseId: `LEASE-${Date.now()}-${randomUUID().slice(0, 8)}`,
      repoId,
      ...(claim.checkoutId?.trim() ? { checkoutId: claim.checkoutId.trim() } : {}),
      ...(claim.workId?.trim() ? { workId: claim.workId.trim() } : {}),
      resourceKey: claim.resourceKey,
      mode: claim.mode,
      ownerJobId,
      ownerIdentity,
      ownerIdentityDigest: identityDigest,
      fencingToken: nextFencingToken(controllerHome, repoId, claim.resourceKey),
      acquiredAt: timestamp,
      expiresAt,
      heartbeatAt: timestamp,
      visibility: effects.visibility,
    }));
    for (const lease of leases) {
      writeJsonAtomic(leasePath(controllerHome, repoId, lease.leaseId), lease);
      if (effects.emitRuntimeEvent) {
        appendRuntimeEvent(controllerHome, {
          repoId,
          entityType: 'lease',
          entityId: lease.leaseId,
          eventType: 'lease_acquired',
          requestId: ownerJobId,
          correlationId: ownerJobId,
          revision: lease.fencingToken,
          data: {
            resourceKey: lease.resourceKey,
            mode: lease.mode,
            expiresAt: lease.expiresAt,
            visibility: lease.visibility,
          },
        });
        leaseSideEffectMetrics.durableAcquireEvents += 1;
      } else {
        leaseSideEffectMetrics.ephemeralAcquires += 1;
      }
    }
    if (leases.length > 0) {
      if (effects.invalidateProjection) {
        markRepositoryProjectionDirty(controllerHome, repoId, `leases-acquired:${ownerJobId}`);
        leaseSideEffectMetrics.projectionDirtyMarks += 1;
      }
      if (effects.notifyScheduler) {
        touchSchedulerWakeSignal(controllerHome, `leases-acquired:${ownerJobId}`);
        leaseSideEffectMetrics.schedulerWakes += 1;
      }
    }
    return { acquired: true, leases, blockers: [] };
    }, 10_000);
  } catch (error) {
    if (error instanceof ControllerLockContentionError) {
      return {
        acquired: false,
        leases: [],
        blockers: [{
          resourceKey: 'controller-lock',
          ownerJobId: error.contention.existing?.owner ?? 'controller-lock',
          leaseId: error.contention.existing?.lockId ?? 'controller-lock-contention',
          mode: 'exclusive',
        }],
      };
    }
    throw error;
  }
}

export interface ExpectedLeaseRef {
  leaseId: string;
  fencingToken: number;
  repoId?: string;
  checkoutId?: string;
  workId?: string;
  resourceKey?: string;
  ownerIdentityDigest?: string;
}

function expectedLeaseMap(expected?: ExpectedLeaseRef[]): Map<string, ExpectedLeaseRef> | undefined {
  return expected ? new Map(expected.map((ref) => [ref.leaseId, ref])) : undefined;
}

function leaseMatchesExpected(lease: ExecutionLease, expected: ExpectedLeaseRef | undefined): boolean {
  if (!expected || expected.fencingToken !== lease.fencingToken) return false;
  if (expected.repoId && expected.repoId !== lease.repoId) return false;
  if (expected.checkoutId && expected.checkoutId !== lease.checkoutId) return false;
  if (expected.workId && expected.workId !== lease.workId) return false;
  if (expected.resourceKey && expected.resourceKey !== lease.resourceKey) return false;
  if (expected.ownerIdentityDigest && expected.ownerIdentityDigest !== lease.ownerIdentityDigest) return false;
  return true;
}

export function renewExecutionLeases(
  controllerHome: string,
  repoId: string,
  ownerJobId: string,
  ttlMs = 30_000,
  expected?: ExpectedLeaseRef[],
): ExecutionLease[] {
  try {
    assertRuntimeMayWriteOrThrow('renew_lease', controllerHome);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('WRITER_FENCED:')) throw error;
    /* unbound legacy */
  }
  return withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-renew:${ownerJobId}`, () => {
    const expectedRefs = expectedLeaseMap(expected);
    const timestamp = new Date().toISOString();
    const owned = listActiveLeases(controllerHome, repoId)
      .filter((lease) => lease.ownerJobId === ownerJobId)
      .filter((lease) => !expectedRefs || leaseMatchesExpected(lease, expectedRefs.get(lease.leaseId)));
    if (expectedRefs && owned.length !== expectedRefs.size) {
      throw new Error(`FENCING_TOKEN_STALE: ${ownerJobId} no longer owns the expected scoped lease set`);
    }
    return owned.map((lease) => {
      const next = { ...lease, heartbeatAt: timestamp, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
      writeJsonAtomic(leasePath(controllerHome, repoId, lease.leaseId), next);
      return next;
    });
  }, 10_000);
}

export function releaseExecutionLeases(
  controllerHome: string,
  repoId: string,
  ownerJobId: string,
  expected?: ExpectedLeaseRef[],
  options?: Pick<LeaseAcquisitionOptions, 'visibility' | 'notifyScheduler' | 'invalidateProjection' | 'emitRuntimeEvent'>,
): number {
  // Writer fencing: passive / fenced runtimes must not release leases belonging
  // to (or managed by) the active runtime, even if they still hold matching lease tokens.
  try {
    assertThisRuntimeMayWriteOrThrow('release_lease', controllerHome);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('WRITER_FENCED:')) throw error;
    /* unbound legacy */
  }
  return withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-release:${ownerJobId}`, () => {
    const expectedRefs = expectedLeaseMap(expected);
    let releasedCount = 0;
    let visibility: LeaseVisibility = options?.visibility ?? 'durable';
    for (const lease of listActiveLeases(controllerHome, repoId)) {
      if (lease.ownerJobId !== ownerJobId) continue;
      if (expectedRefs && !leaseMatchesExpected(lease, expectedRefs.get(lease.leaseId))) continue;
      visibility = lease.visibility ?? visibility;
      removeFile(leasePath(controllerHome, repoId, lease.leaseId));
      const effects = resolveSideEffects(options, lease.visibility);
      if (effects.emitRuntimeEvent) {
        appendRuntimeEvent(controllerHome, {
          repoId,
          entityType: 'lease',
          entityId: lease.leaseId,
          eventType: 'lease_released',
          requestId: ownerJobId,
          correlationId: ownerJobId,
          revision: lease.fencingToken,
          data: { resourceKey: lease.resourceKey, mode: lease.mode, visibility: lease.visibility },
        });
        leaseSideEffectMetrics.durableReleaseEvents += 1;
      } else {
        leaseSideEffectMetrics.ephemeralReleases += 1;
      }
      releasedCount += 1;
    }
    if (releasedCount > 0) {
      const effects = resolveSideEffects(options, visibility);
      if (effects.invalidateProjection) {
        markRepositoryProjectionDirty(controllerHome, repoId, `leases-released:${ownerJobId}`);
        leaseSideEffectMetrics.projectionDirtyMarks += 1;
      }
      if (effects.notifyScheduler) {
        touchSchedulerWakeSignal(controllerHome, `leases-released:${ownerJobId}`);
        leaseSideEffectMetrics.schedulerWakes += 1;
      }
    }
    return releasedCount;
  }, 10_000);
}

export function releaseExactExecutionLeases(
  controllerHome: string,
  repoId: string,
  ownerJobId: string,
  expected: ExpectedLeaseRef[],
  options?: Pick<LeaseAcquisitionOptions, 'visibility' | 'notifyScheduler' | 'invalidateProjection' | 'emitRuntimeEvent'>,
): number {
  try {
    assertThisRuntimeMayWriteOrThrow('release_lease', controllerHome);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('WRITER_FENCED:')) throw error;
    /* unbound legacy */
  }
  return withControllerLock(controllerHome, { scope: 'repository', repoId }, `lease-release-exact:${ownerJobId}`, () => {
    const expectedRefs = expectedLeaseMap(expected) ?? new Map<string, ExpectedLeaseRef>();
    if (expectedRefs.size !== expected.length) {
      throw new Error(`LEASE_SET_INVALID: ${ownerJobId} contains duplicate lease ids`);
    }
    const owned = listActiveLeases(controllerHome, repoId)
      .filter((lease) => lease.ownerJobId === ownerJobId);
    if (owned.length !== expectedRefs.size) {
      throw new Error(`LEASE_SET_MISMATCH: ${ownerJobId} owns ${owned.length} active leases, expected ${expectedRefs.size}`);
    }
    for (const lease of owned) {
      if (!leaseMatchesExpected(lease, expectedRefs.get(lease.leaseId))) {
        throw new Error(`LEASE_SET_FENCE_MISMATCH: ${ownerJobId} no longer owns ${lease.leaseId}`);
      }
    }

    let releasedCount = 0;
    let visibility: LeaseVisibility = options?.visibility ?? 'durable';
    for (const lease of owned) {
      visibility = lease.visibility ?? visibility;
      removeFile(leasePath(controllerHome, repoId, lease.leaseId));
      const effects = resolveSideEffects(options, lease.visibility);
      if (effects.emitRuntimeEvent) {
        appendRuntimeEvent(controllerHome, {
          repoId,
          entityType: 'lease',
          entityId: lease.leaseId,
          eventType: 'lease_released',
          requestId: ownerJobId,
          correlationId: ownerJobId,
          revision: lease.fencingToken,
          data: { resourceKey: lease.resourceKey, mode: lease.mode, visibility: lease.visibility, exactSet: true },
        });
        leaseSideEffectMetrics.durableReleaseEvents += 1;
      } else {
        leaseSideEffectMetrics.ephemeralReleases += 1;
      }
      releasedCount += 1;
    }
    if (releasedCount > 0) {
      const effects = resolveSideEffects(options, visibility);
      if (effects.invalidateProjection) {
        markRepositoryProjectionDirty(controllerHome, repoId, `leases-released-exact:${ownerJobId}`);
        leaseSideEffectMetrics.projectionDirtyMarks += 1;
      }
      if (effects.notifyScheduler) {
        touchSchedulerWakeSignal(controllerHome, `leases-released-exact:${ownerJobId}`);
        leaseSideEffectMetrics.schedulerWakes += 1;
      }
    }
    return releasedCount;
  }, 10_000);
}

/**
 * Release only the exact active lease set owned by one terminal Process.
 *
 * Writer generation is deliberately not part of this authorization: a
 * controller restart changes that generation, while the terminal Process id
 * and durable lease fencing tokens remain stable. The caller must first prove
 * terminal Process state; this function proves exact owner/scope/token identity
 * atomically under the repository lock. Extra or changed leases fail closed.
 */
export function releaseTerminalProcessLeases(
  controllerHome: string,
  repoId: string,
  processId: string,
  expected: ExpectedLeaseRef[],
  options?: Pick<LeaseAcquisitionOptions, 'visibility' | 'notifyScheduler' | 'invalidateProjection' | 'emitRuntimeEvent'>,
): number {
  const normalizedProcessId = processId.trim();
  if (!normalizedProcessId) throw new Error('TERMINAL_PROCESS_ID_REQUIRED');
  const ownerJobId = `process:${normalizedProcessId}`;
  return withControllerLock(controllerHome, { scope: 'repository', repoId }, `terminal-lease-release:${ownerJobId}`, () => {
    const expectedRefs = expectedLeaseMap(expected) ?? new Map<string, ExpectedLeaseRef>();
    if (expectedRefs.size !== expected.length) {
      throw new Error(`TERMINAL_PROCESS_LEASE_SET_INVALID: ${normalizedProcessId} contains duplicate lease ids`);
    }
    for (const ref of expected) {
      if (ref.repoId && ref.repoId !== repoId) {
        throw new Error(`TERMINAL_PROCESS_LEASE_SCOPE_MISMATCH: ${normalizedProcessId} references another repository`);
      }
    }

    const owned = listActiveLeases(controllerHome, repoId)
      .filter((lease) => lease.ownerJobId === ownerJobId);
    for (const lease of owned) {
      const ref = expectedRefs.get(lease.leaseId);
      if (!ref) {
        throw new Error(`TERMINAL_PROCESS_LEASE_SET_MISMATCH: ${normalizedProcessId} owns an unrecorded lease ${lease.leaseId}`);
      }
      if (!leaseMatchesExpected(lease, ref)) {
        throw new Error(`TERMINAL_PROCESS_LEASE_FENCE_MISMATCH: ${normalizedProcessId} no longer owns the recorded lease ${lease.leaseId}`);
      }
    }

    let releasedCount = 0;
    let visibility: LeaseVisibility = options?.visibility ?? 'durable';
    for (const lease of owned) {
      visibility = lease.visibility ?? visibility;
      removeFile(leasePath(controllerHome, repoId, lease.leaseId));
      const effects = resolveSideEffects(options, lease.visibility);
      if (effects.emitRuntimeEvent) {
        appendRuntimeEvent(controllerHome, {
          repoId,
          entityType: 'lease',
          entityId: lease.leaseId,
          eventType: 'lease_released',
          requestId: ownerJobId,
          correlationId: ownerJobId,
          revision: lease.fencingToken,
          data: { resourceKey: lease.resourceKey, mode: lease.mode, visibility: lease.visibility, terminalProcessId: normalizedProcessId },
        });
        leaseSideEffectMetrics.durableReleaseEvents += 1;
      } else {
        leaseSideEffectMetrics.ephemeralReleases += 1;
      }
      releasedCount += 1;
    }
    if (releasedCount > 0) {
      const effects = resolveSideEffects(options, visibility);
      if (effects.invalidateProjection) {
        markRepositoryProjectionDirty(controllerHome, repoId, `terminal-leases-released:${ownerJobId}`);
        leaseSideEffectMetrics.projectionDirtyMarks += 1;
      }
      if (effects.notifyScheduler) {
        touchSchedulerWakeSignal(controllerHome, `terminal-leases-released:${ownerJobId}`);
        leaseSideEffectMetrics.schedulerWakes += 1;
      }
    }
    return releasedCount;
  }, 10_000);
}

export function assertFencingToken(
  controllerHome: string,
  repoId: string,
  leaseId: string,
  fencingToken: number,
): ExecutionLease {
  const path = leasePath(controllerHome, repoId, leaseId);
  if (!existsSync(path)) throw new Error(`LEASE_EXPIRED: ${leaseId}`);
  const lease = readJsonFile<ExecutionLease>(path);
  if (expired(lease)) {
    removeFile(path);
    throw new Error(`LEASE_EXPIRED: ${leaseId}`);
  }
  if (lease.fencingToken !== fencingToken) throw new Error(`FENCING_TOKEN_STALE: ${leaseId}`);
  return lease;
}
