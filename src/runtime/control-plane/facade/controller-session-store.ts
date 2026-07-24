import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import type { ControllerSession, ControllerSessionStore, ControllerType } from './types';

export interface ControllerSessionStoreOptions { controllerHome: string; repoId: string; now?: () => string; }

function path(options: ControllerSessionStoreOptions): string {
  return join(repositoryControllerRoot(options.controllerHome, options.repoId), 'controller-sessions.json');
}

function now(options: ControllerSessionStoreOptions): string { return options.now?.() ?? new Date().toISOString(); }

function read(options: ControllerSessionStoreOptions): ControllerSessionStore {
  return readJsonFile(path(options), { schemaVersion: 1, updatedAt: now(options), sessions: [] });
}

export function getControllerSession(options: ControllerSessionStoreOptions, workId: string): ControllerSession | undefined {
  const at = Date.now();
  return read(options).sessions.find((session) => session.workId === workId && Date.parse(session.leaseExpiresAt) > at);
}

export function claimControllerSession(options: ControllerSessionStoreOptions, input: {
  workId: string; controllerId: string; controllerType: ControllerType; sessionId: string; leaseMs?: number;
}): ControllerSession {
  if (!input.workId.trim() || !input.controllerId.trim() || !input.sessionId.trim()) {
    throw new Error('CONTROLLER_SESSION_IDENTITY_REQUIRED');
  }
  return withControllerLock(
    options.controllerHome,
    { scope: 'task', repoId: options.repoId, taskId: `controller-session-${input.workId}` },
    `controller-claim:${input.controllerId}:${input.sessionId}`,
    () => {
      const store = read(options);
      const current = store.sessions.find((entry) => entry.workId === input.workId && Date.parse(entry.leaseExpiresAt) > Date.now());
      if (current && (current.controllerId !== input.controllerId || current.sessionId !== input.sessionId)) {
        throw new Error(`WORK_ALREADY_CLAIMED: ${input.workId} is owned by ${current.controllerId}`);
      }
      const claimedAt = now(options);
      const leaseExpiresAt = new Date(Date.parse(claimedAt) + Math.max(1_000, Math.min(input.leaseMs ?? 300_000, 3_600_000))).toISOString();
      const session: ControllerSession = { schemaVersion: 1, workId: input.workId, controllerId: input.controllerId, controllerType: input.controllerType, sessionId: input.sessionId, claimedAt, leaseExpiresAt };
      const sessions = [...store.sessions.filter((entry) => entry.workId !== input.workId && Date.parse(entry.leaseExpiresAt) > Date.now()), session];
      writeJsonAtomic(path(options), { schemaVersion: 1, updatedAt: claimedAt, sessions });
      return session;
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
