import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { peekExecutionSession } from '../execution/session-store';
import { readJsonFile } from '../../shared/json-files';
import { readOrImportControlPlaneRecord, writeControlPlaneRecord } from '../persistence/sqlite-store';
import type { ControllerSession, ControllerSessionStore, ControllerType } from './types';

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

function activeSession(store: ControllerSessionStore, workId: string): ControllerSession | undefined {
  const at = Date.now();
  return store.sessions.find((session) => session.workId === workId && Date.parse(session.leaseExpiresAt) > at);
}

function assertIdentity(input: ControllerSessionClaimInput): void {
  if (!input.workId.trim() || !input.controllerId.trim() || !input.sessionId.trim()) {
    throw new Error('CONTROLLER_SESSION_IDENTITY_REQUIRED');
  }
}

function claimedSession(
  options: ControllerSessionStoreOptions,
  input: ControllerSessionClaimInput,
  claimedAt: string,
  previous?: ControllerSession,
): ControllerSession {
  const leaseExpiresAt = new Date(
    Date.parse(claimedAt) + Math.max(1_000, Math.min(input.leaseMs ?? 300_000, 3_600_000)),
  ).toISOString();
  const sameOwner = previous?.controllerId === input.controllerId
    && previous.sessionId === input.sessionId
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
 * Resume a claim after transport replacement without allowing same-epoch stealing.
 * The authenticated principal must remain identical, and a different session id
 * is accepted only when the previous execution session is gone/invalidated or
 * belongs to a different Controller instance (the normal rollout boundary).
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
      if (current.sessionId !== input.sessionId) {
        const priorInstance = current.controllerInstanceId?.trim() || priorExecution?.controllerInstanceId?.trim();
        const priorSessionUnavailable = !priorExecution || Boolean(priorExecution.invalidatedAt);
        const crossedControllerEpoch = Boolean(priorInstance && priorInstance !== input.controllerInstanceId.trim());
        if (!priorSessionUnavailable && !crossedControllerEpoch) {
          throw new Error(`WORK_ALREADY_CLAIMED: ${input.workId} has an active session ${current.sessionId}`);
        }
      }
      return persistClaim(options, store, input, current);
    },
  );
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
