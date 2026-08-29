import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { peekExecutionSession } from '../execution/session-store';
import { readJsonFile } from '../../shared/json-files';
import { readOrImportControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';
import { getWorkContract } from './work-contract-store';
import { isTerminalWorkContractStatus, type ControllerSession, type ControllerSessionStore, type ControllerType } from './types';

export interface ControllerSessionStoreOptions { controllerHome: string; repoId: string; now?: () => string; }

export interface ControllerSessionClaimInput {
  workId: string;
  controllerId: string;
  controllerType: ControllerType;
  sessionId: string;
  principalId?: string;
  controllerInstanceId?: string;
  /** Optional compare-and-swap fence supplied by a recovering caller. */
  expectedClaimGeneration?: number;
  leaseMs?: number;
}

function path(options: ControllerSessionStoreOptions): string {
  return join(repositoryControllerRoot(options.controllerHome, options.repoId), 'controller-sessions.json');
}

function now(options: ControllerSessionStoreOptions): string { return options.now?.() ?? new Date().toISOString(); }

function read(options: ControllerSessionStoreOptions): ControllerSessionStore {
  const legacyPath = path(options);
  return readOrImportControlPlaneRecord<ControllerSessionStore>(options.controllerHome, {
    namespace: 'controller_session_claim_store',
    scope: options.repoId,
    key: 'index',
    schemaVersion: 1,
    readLegacy: () => readJsonFile<ControllerSessionStore>(legacyPath, { schemaVersion: 1, updatedAt: now(options), sessions: [] }),
  })?.value ?? { schemaVersion: 1, updatedAt: now(options), sessions: [] };
}

function write(options: ControllerSessionStoreOptions, store: ControllerSessionStore): void {
  writeControlPlaneRecord(options.controllerHome, {
    namespace: 'controller_session_claim_store',
    scope: options.repoId,
    key: 'index',
    schemaVersion: 1,
    value: store,
    action: 'controller_session_claim_write',
  });
}

const DEFAULT_CONTROLLER_RECOVERY_GRACE_MS = 5 * 60_000;
const MAX_CONTROLLER_RECOVERY_GRACE_MS = 60 * 60_000;
const DEFAULT_CONTROLLER_LEASE_MS = 60 * 60_000;
const MAX_CONTROLLER_LEASE_MS = 60 * 60_000;

function activeSession(store: ControllerSessionStore, workId: string): ControllerSession | undefined {
  const at = Date.now();
  return store.sessions.find((session) => session.workId === workId && Date.parse(session.leaseExpiresAt) > at);
}

export function controllerSessionBlocksRecovery(
  options: ControllerSessionStoreOptions,
  workId: string,
  input: { nowMs?: number; graceMs?: number } = {},
): boolean {
  const owner = activeSession(read(options), workId);
  if (!owner) return false;
  const execution = peekExecutionSession(options.controllerHome, owner.sessionId);
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = Math.max(60_000, Math.min(input.graceMs ?? DEFAULT_CONTROLLER_RECOVERY_GRACE_MS, MAX_CONTROLLER_RECOVERY_GRACE_MS));
  if (execution?.invalidatedAt) {
    const invalidatedAtMs = Date.parse(execution.invalidatedAt);
    if (!Number.isFinite(invalidatedAtMs)) return true;
    return nowMs - invalidatedAtMs < graceMs;
  }
  if (execution?.activeWorkId && execution.activeWorkId !== workId) return false;
  const activityMs = [execution?.lastValidatedAt, execution?.updatedAt, owner.claimedAt]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(activityMs)) return false;
  return nowMs - activityMs < graceMs;
}

function assertIdentity(input: ControllerSessionClaimInput): void {
  if (!input.workId.trim() || !input.controllerId.trim() || !input.sessionId.trim()) {
    throw new Error('CONTROLLER_SESSION_IDENTITY_REQUIRED');
  }
}

function assertWorkClaimable(options: ControllerSessionStoreOptions, workId: string): void {
  const work = getWorkContract({ controllerHome: options.controllerHome, repoId: options.repoId }, workId);
  if (work && isTerminalWorkContractStatus(work.status)) {
    throw new Error(`WORK_CONTROLLER_CLAIM_TERMINAL: ${work.workId}:${work.status}`);
  }
}

function claimedSession(
  options: ControllerSessionStoreOptions,
  input: ControllerSessionClaimInput,
  claimedAt: string,
  previous?: ControllerSession,
): ControllerSession {
  const leaseExpiresAt = new Date(
    Date.parse(claimedAt) + Math.max(1_000, Math.min(input.leaseMs ?? DEFAULT_CONTROLLER_LEASE_MS, MAX_CONTROLLER_LEASE_MS)),
  ).toISOString();
  const previousPrincipal = previous?.principalId?.trim() || previous?.controllerId;
  const inputPrincipal = input.principalId?.trim() || input.controllerId;
  const sameOwner = previous?.controllerId === input.controllerId
    && previousPrincipal === inputPrincipal
    && (previous.controllerInstanceId ?? '') === (input.controllerInstanceId?.trim() ?? '');
  const claimGeneration = sameOwner
    ? Math.max(1, previous?.claimGeneration ?? 1)
    : Math.max(0, previous?.claimGeneration ?? 0) + 1;
  return {
    schemaVersion: 1,
    workId: input.workId,
    controllerId: input.controllerId,
    controllerType: input.controllerType,
    sessionId: input.sessionId,
    ...(input.principalId?.trim() ? { principalId: input.principalId.trim() } : {}),
    ...(input.controllerInstanceId?.trim() ? { controllerInstanceId: input.controllerInstanceId.trim() } : {}),
    claimGeneration,
    claimedAt,
    leaseExpiresAt,
  };
}

function assertExpectedGeneration(input: ControllerSessionClaimInput, current: ControllerSession | undefined): void {
  if (input.expectedClaimGeneration === undefined) return;
  const actual = current?.claimGeneration ?? 0;
  if (actual !== input.expectedClaimGeneration) {
    throw new Error(`WORK_CLAIM_GENERATION_MISMATCH: ${input.workId} expected=${input.expectedClaimGeneration} actual=${actual}`);
  }
}

function persistClaim(
  options: ControllerSessionStoreOptions,
  store: ControllerSessionStore,
  input: ControllerSessionClaimInput,
  previous?: ControllerSession,
): ControllerSession {
  const claimedAt = now(options);
  const session = claimedSession(options, input, claimedAt, previous);
  const sessions = [
    ...store.sessions.filter((entry) => entry.workId !== input.workId && Date.parse(entry.leaseExpiresAt) > Date.now()),
    session,
  ];
  write(options, { schemaVersion: 1, updatedAt: claimedAt, sessions });
  return session;
}

export function getControllerSession(options: ControllerSessionStoreOptions, workId: string): ControllerSession | undefined {
  return activeSession(read(options), workId);
}

export function listControllerSessions(options: ControllerSessionStoreOptions): ControllerSession[] {
  const at = Date.now();
  return read(options).sessions.filter((session) => Date.parse(session.leaseExpiresAt) > at);
}

export interface ControllerOwnershipAuthority {
  controllerId: string;
  controllerType: ControllerType;
  principalId: string;
  controllerInstanceId: string;
  claimGeneration: number;
}

export type ControllerTerminalizationAuthority = ControllerOwnershipAuthority;

export function controllerSessionPrincipalId(
  owner: Pick<ControllerSession, 'principalId' | 'controllerId'>,
): string {
  return owner.principalId?.trim() || owner.controllerId;
}

export function requireControllerOwnershipAuthority(
  owner: ControllerSession,
  workId: string = owner.workId,
): ControllerOwnershipAuthority {
  const principalId = controllerSessionPrincipalId(owner);
  const controllerInstanceId = owner.controllerInstanceId?.trim() || '';
  if (!controllerInstanceId) throw new Error(`WORK_CONTROLLER_INSTANCE_MISMATCH: ${workId}`);
  if (typeof owner.claimGeneration !== 'number' || owner.claimGeneration < 1) {
    throw new Error(`WORK_CONTROLLER_CLAIM_GENERATION_REQUIRED: ${workId}`);
  }
  return {
    controllerId: owner.controllerId,
    controllerType: owner.controllerType,
    principalId,
    controllerInstanceId,
    claimGeneration: owner.claimGeneration,
  };
}

export function assertControllerOwnershipAuthority(
  owner: ControllerSession,
  expected: {
    workId?: string;
    controllerId: string;
    principalId: string;
    controllerInstanceId?: string;
    controllerType?: ControllerType;
  },
): ControllerOwnershipAuthority {
  const workId = expected.workId ?? owner.workId;
  const authority = requireControllerOwnershipAuthority(owner, workId);
  if (authority.controllerId !== expected.controllerId.trim()) {
    throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${workId} is owned by ${owner.controllerId}`);
  }
  if (expected.controllerType && authority.controllerType !== expected.controllerType) {
    throw new Error(`WORK_CONTROLLER_TYPE_MISMATCH: ${workId} is owned by ${owner.controllerType}`);
  }
  if (authority.principalId !== expected.principalId.trim()) {
    throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${workId}`);
  }
  if (expected.controllerInstanceId !== undefined
    && authority.controllerInstanceId !== expected.controllerInstanceId.trim()) {
    throw new Error(`WORK_CONTROLLER_INSTANCE_MISMATCH: ${workId}`);
  }
  return authority;
}

export type ControllerTerminalizationFenceReason =
  | 'active_controller_claim'
  | 'stale_controller_authority'
  | 'controller_claim_missing';

export type ControllerTerminalizationFenceResult<T> =
  | { allowed: true; value: T; owner?: ControllerSession }
  | { allowed: false; reason: ControllerTerminalizationFenceReason; owner?: ControllerSession };

export function controllerTerminalizationAuthorityFromSession(
  owner: ControllerSession,
): ControllerTerminalizationAuthority | undefined {
  try {
    return requireControllerOwnershipAuthority(owner);
  } catch {
    return undefined;
  }
}

function controllerTerminalizationAuthorityMatches(
  owner: ControllerSession,
  authority: ControllerTerminalizationAuthority,
): boolean {
  const ownerPrincipal = controllerSessionPrincipalId(owner);
  const ownerInstanceId = owner.controllerInstanceId?.trim() || '';
  return owner.controllerId === authority.controllerId
    && owner.controllerType === authority.controllerType
    && ownerPrincipal === authority.principalId.trim()
    && ownerInstanceId === authority.controllerInstanceId.trim()
    && owner.claimGeneration === authority.claimGeneration;
}

/**
 * Serialize control-path Work terminalization against the same canonical
 * ControllerSession task lock used by claim/resume/release. This is a fence,
 * not a second lifecycle authority: WorkContract remains the terminal state
 * authority and ControllerSession remains the ownership authority.
 *
 * A caller without Controller authority may terminalize only while the Work is
 * unclaimed. A caller that observed a live owner must present that exact durable
 * owner epoch. Transport session ids are intentionally not compared because MCP
 * transports may rotate without moving Work ownership; controller instance plus
 * claim generation fence stale controller epochs while preserving that rotation.
 */
export function withControllerSessionTerminalizationFence<T>(
  options: ControllerSessionStoreOptions,
  input: {
    workId: string;
    actor: string;
    authority?: ControllerTerminalizationAuthority;
  },
  operation: () => T,
): ControllerTerminalizationFenceResult<T> {
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-session-${input.workId}` },
    input.actor,
    () => {
      const owner = activeSession(read(options), input.workId);
      if (!owner) {
        if (input.authority) return { allowed: false, reason: 'controller_claim_missing' };
        return { allowed: true, value: operation() };
      }
      if (!input.authority) return { allowed: false, reason: 'active_controller_claim', owner };

      if (!controllerTerminalizationAuthorityMatches(owner, input.authority)) {
        return { allowed: false, reason: 'stale_controller_authority', owner };
      }
      return { allowed: true, value: operation(), owner };
    },
  );
}

/**
 * Release a live ControllerSession only when the caller still owns the exact
 * durable controller epoch it observed. This closes the release-then-terminalize
 * race without changing WorkContract lifecycle authority.
 */
export function releaseControllerSessionWithAuthority(
  options: ControllerSessionStoreOptions,
  input: {
    workId: string;
    actor: string;
    authority: ControllerTerminalizationAuthority;
  },
): ControllerTerminalizationFenceResult<void> {
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-session-${input.workId}` },
    input.actor,
    () => {
      const store = read(options);
      const owner = activeSession(store, input.workId);
      if (!owner) return { allowed: false, reason: 'controller_claim_missing' };
      if (!controllerTerminalizationAuthorityMatches(owner, input.authority)) {
        return { allowed: false, reason: 'stale_controller_authority', owner };
      }
      const sessions = store.sessions.filter((entry) => entry.workId !== input.workId);
      write(options, { schemaVersion: 1, updatedAt: now(options), sessions });
      return { allowed: true, value: undefined, owner };
    },
  );
}

export function releaseObservedControllerSession(
  options: ControllerSessionStoreOptions,
  input: { workId: string; actor: string; owner: ControllerSession },
): ControllerTerminalizationFenceResult<void> {
  const authority = controllerTerminalizationAuthorityFromSession(input.owner);
  if (!authority) return { allowed: false, reason: 'stale_controller_authority', owner: input.owner };
  return releaseControllerSessionWithAuthority(options, {
    workId: input.workId,
    actor: input.actor,
    authority,
  });
}

/**
 * Strict claim used for first ownership acquisition and explicit release/reclaim flows.
 * A live claim with any different controller or transport session remains fenced.
 */
export function claimControllerSession(
  options: ControllerSessionStoreOptions,
  input: ControllerSessionClaimInput,
): ControllerSession {
  assertIdentity(input);
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-session-${input.workId}` },
    `controller-claim:${input.controllerId}:${input.sessionId}`,
    () => {
      assertWorkClaimable(options, input.workId);
      const store = read(options);
      const current = activeSession(store, input.workId);
      assertExpectedGeneration(input, current);
      if (current && (current.controllerId !== input.controllerId || current.sessionId !== input.sessionId)) {
        throw new Error(`WORK_ALREADY_CLAIMED: ${input.workId} is owned by ${current.controllerId}`);
      }
      return persistClaim(options, store, input, current);
    },
  );
}

/**
 * Resume a claim after transport replacement. Durable Work ownership belongs to
 * the authenticated principal/controller epoch, not to one MCP transport session.
 * A same-principal session rotation therefore preserves ownership generation;
 * a controller-epoch change is recovery and advances the generation fence.
 */
export function resumeControllerSession(
  options: ControllerSessionStoreOptions,
  input: ControllerSessionClaimInput & { principalId: string; controllerInstanceId: string },
): ControllerSession {
  assertIdentity(input);
  if (!input.principalId.trim() || !input.controllerInstanceId.trim()) {
    throw new Error('CONTROLLER_RESUME_AUTHORITY_REQUIRED');
  }
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-session-${input.workId}` },
    `controller-resume:${input.controllerId}:${input.sessionId}`,
    () => {
      assertWorkClaimable(options, input.workId);
      const store = read(options);
      const current = activeSession(store, input.workId);
      assertExpectedGeneration(input, current);
      if (!current) return persistClaim(options, store, input);
      const priorExecution = peekExecutionSession(options.controllerHome, current.sessionId);
      const currentPrincipal = current.principalId?.trim() || priorExecution?.principalId?.trim() || current.controllerId;
      if (currentPrincipal !== input.principalId.trim()) {
        throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${input.workId} is owned by another authenticated principal`);
      }
      if (current.controllerId !== input.controllerId) {
        throw new Error(`WORK_ALREADY_CLAIMED: ${input.workId} is owned by ${current.controllerId}`);
      }
      return persistClaim(options, store, input, current);
    },
  );
}

/**
 * Rebind one active Work to the authenticated Controller transport/Runtime that
 * is serving the current request. Same-instance transport rollover needs only
 * principal/controller proof. A Runtime-instance change additionally requires
 * positive proof that the requested instance is the live canonical Runtime;
 * this prevents a stale old Runtime request from migrating ownership backwards.
 * The observed claim generation is always supplied as a CAS fence.
 */
export function bindControllerSessionToCurrentRuntime(
  options: ControllerSessionStoreOptions,
  input: ControllerSessionClaimInput & {
    principalId: string;
    controllerInstanceId: string;
    currentRuntimeInstanceId?: string;
    allowClaimIfMissing?: boolean;
  },
): ControllerSession {
  assertIdentity(input);
  const current = getControllerSession(options, input.workId);
  if (!current) {
    if (input.allowClaimIfMissing !== true) throw new Error(`WORK_CONTROLLER_OWNER_REQUIRED: ${input.workId}`);
    return claimControllerSession(options, { ...input, expectedClaimGeneration: 0 });
  }
  const currentPrincipal = controllerSessionPrincipalId(current);
  if (current.controllerId !== input.controllerId) {
    throw new Error(`WORK_CONTROLLER_OWNER_MISMATCH: ${input.workId} is owned by ${current.controllerId}`);
  }
  if (current.controllerType !== input.controllerType) {
    throw new Error(`WORK_CONTROLLER_TYPE_MISMATCH: ${input.workId} is owned by ${current.controllerType}`);
  }
  if (currentPrincipal !== input.principalId.trim()) {
    throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${input.workId}`);
  }
  const ownerInstanceId = current.controllerInstanceId?.trim() || '';
  const requestedInstanceId = input.controllerInstanceId.trim();
  if (ownerInstanceId !== requestedInstanceId) {
    const currentRuntimeInstanceId = input.currentRuntimeInstanceId?.trim() || '';
    if (!currentRuntimeInstanceId || currentRuntimeInstanceId !== requestedInstanceId) {
      throw new Error(`WORK_CONTROLLER_INSTANCE_MISMATCH: ${input.workId}`);
    }
  }
  if (ownerInstanceId === requestedInstanceId && current.sessionId === input.sessionId) return current;
  return resumeControllerSession(options, {
    ...input,
    expectedClaimGeneration: current.claimGeneration,
  });
}

export function releaseControllerSession(options: ControllerSessionStoreOptions, workId: string, controllerId: string): void {
  withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-session-${workId}` },
    `controller-release:${controllerId}`,
    () => {
      const store = read(options);
      const sessions = store.sessions.filter((entry) => entry.workId !== workId || entry.controllerId !== controllerId);
      write(options, { schemaVersion: 1, updatedAt: now(options), sessions });
    },
  );
}
