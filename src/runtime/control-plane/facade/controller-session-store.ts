import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { peekExecutionSession } from '../execution/session-store';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import type { ControllerSession, ControllerSessionStore, ControllerType } from './types';

export interface ControllerSessionStoreOptions { controllerHome: string; repoId: string; now?: () => string; }

export interface ControllerSessionClaimInput {
  workId: string;
  controllerId: string;
  controllerType: ControllerType;
  sessionId: string;
  principalId?: string;
  controllerInstanceId?: string;
  leaseMs?: number;
}

function path(options: ControllerSessionStoreOptions): string {
  return join(repositoryControllerRoot(options.controllerHome, options.repoId), 'controller-sessions.json');
}

function now(options: ControllerSessionStoreOptions): string { return options.now?.() ?? new Date().toISOString(); }

function read(options: ControllerSessionStoreOptions): ControllerSessionStore {
  return readJsonFile(path(options), { schemaVersion: 1, updatedAt: now(options), sessions: [] });
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

function claimedSession(options: ControllerSessionStoreOptions, input: ControllerSessionClaimInput, claimedAt: string): ControllerSession {
  const leaseExpiresAt = new Date(
    Date.parse(claimedAt) + Math.max(1_000, Math.min(input.leaseMs ?? 300_000, 3_600_000)),
  ).toISOString();
  return {
    schemaVersion: 1,
    workId: input.workId,
    controllerId: input.controllerId,
    controllerType: input.controllerType,
    sessionId: input.sessionId,
    ...(input.principalId?.trim() ? { principalId: input.principalId.trim() } : {}),
    ...(input.controllerInstanceId?.trim() ? { controllerInstanceId: input.controllerInstanceId.trim() } : {}),
    claimedAt,
    leaseExpiresAt,
  };
}

function persistClaim(
  options: ControllerSessionStoreOptions,
  store: ControllerSessionStore,
  input: ControllerSessionClaimInput,
): ControllerSession {
  const claimedAt = now(options);
  const session = claimedSession(options, input, claimedAt);
  const sessions = [
    ...store.sessions.filter((entry) => entry.workId !== input.workId && Date.parse(entry.leaseExpiresAt) > Date.now()),
    session,
  ];
  writeJsonAtomic(path(options), { schemaVersion: 1, updatedAt: claimedAt, sessions });
  return session;
}

export function getControllerSession(options: ControllerSessionStoreOptions, workId: string): ControllerSession | undefined {
  return activeSession(read(options), workId);
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
      if (current && (current.controllerId !== input.controllerId || current.sessionId !== input.sessionId)) {
        throw new Error(`WORK_ALREADY_CLAIMED: ${input.workId} is owned by ${current.controllerId}`);
      }
      return persistClaim(options, store, input);
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
      if (!current) return persistClaim(options, store, input);
      if (current.controllerId !== input.controllerId) {
        throw new Error(`WORK_ALREADY_CLAIMED: ${input.workId} is owned by ${current.controllerId}`);
      }
      if (current.sessionId !== input.sessionId) {
        const priorExecution = peekExecutionSession(options.controllerHome, current.sessionId);
        const currentPrincipal = current.principalId?.trim() || priorExecution?.principalId?.trim() || current.controllerId;
        if (currentPrincipal !== input.principalId.trim()) {
          throw new Error(`WORK_CONTROLLER_PRINCIPAL_MISMATCH: ${input.workId} is owned by another authenticated principal`);
        }
        const priorInstance = current.controllerInstanceId?.trim() || priorExecution?.controllerInstanceId?.trim();
        const priorSessionUnavailable = !priorExecution || Boolean(priorExecution.invalidatedAt);
        const crossedControllerEpoch = Boolean(priorInstance && priorInstance !== input.controllerInstanceId.trim());
        if (!priorSessionUnavailable && !crossedControllerEpoch) {
          throw new Error(`WORK_ALREADY_CLAIMED: ${input.workId} has an active session ${current.sessionId}`);
        }
      }
      return persistClaim(options, store, input);
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
      writeJsonAtomic(path(options), { schemaVersion: 1, updatedAt: now(options), sessions });
    },
  );
}
