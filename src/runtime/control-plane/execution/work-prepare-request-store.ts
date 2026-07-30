import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';

export interface WorkPrepareRequestRecord {
  schemaVersion: 1;
  repoId: string;
  sessionId: string;
  principalId: string;
  requestId: string;
  fingerprint: string;
  workId: string;
  status: 'claimed' | 'prepared';
  createdAt: string;
  updatedAt: string;
}

export interface WorkPrepareRequestInput {
  controllerHome: string;
  repoId: string;
  sessionId: string;
  principalId: string;
  requestId: string;
  fingerprint: string;
  proposedWorkId: string;
}

const WORK_PREPARE_LOCK_WAIT_MS = 180_000;

function normalized(value: string, code: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${code}: value must not be empty`);
  return result;
}

function requestScope(input: Pick<WorkPrepareRequestInput, 'repoId' | 'sessionId' | 'principalId' | 'requestId'>): string {
  return JSON.stringify([input.repoId, input.sessionId, input.principalId, input.requestId]);
}

function requestIdentity(input: Pick<WorkPrepareRequestInput, 'repoId' | 'sessionId' | 'principalId' | 'requestId'>): string {
  return createHash('sha256').update(requestScope(input)).digest('hex');
}

function requestRecordPath(controllerHome: string, repoId: string, identity: string): string {
  const root = join(repositoryControllerRoot(ensureControllerHome(controllerHome), repoId), 'work-prepare', 'requests');
  const path = join(root, `${identity}.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function validateExistingRecord(record: WorkPrepareRequestRecord, input: WorkPrepareRequestInput): void {
  if (
    record.schemaVersion !== 1
    || !record.workId
    || !record.fingerprint
    || (record.status !== 'claimed' && record.status !== 'prepared')
    || record.repoId !== input.repoId
    || record.sessionId !== input.sessionId
    || record.principalId !== input.principalId
    || record.requestId !== input.requestId
  ) {
    throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${input.requestId}`);
  }
  if (record.fingerprint !== input.fingerprint) {
    throw new Error(`WORK_PREPARE_REQUEST_CONFLICT: ${input.requestId} was already used with different work parameters`);
  }
}

/**
 * Persist and serialize one work_prepare request before any WorkContract or
 * worktree side effect. Matching retries reuse the original Work id; changed
 * parameters fail closed. The record survives process restarts so a retry can
 * resume a partially completed preparation with the same deterministic owner.
 */
export function withWorkPrepareRequest<T>(
  rawInput: WorkPrepareRequestInput,
  operation: (record: WorkPrepareRequestRecord, reused: boolean) => T,
): T {
  const input: WorkPrepareRequestInput = {
    controllerHome: rawInput.controllerHome,
    repoId: normalized(rawInput.repoId, 'WORK_PREPARE_REPOSITORY_REQUIRED'),
    sessionId: normalized(rawInput.sessionId, 'WORK_PREPARE_SESSION_REQUIRED'),
    principalId: normalized(rawInput.principalId, 'WORK_PREPARE_PRINCIPAL_REQUIRED'),
    requestId: normalized(rawInput.requestId, 'WORK_PREPARE_REQUEST_ID_REQUIRED'),
    fingerprint: normalized(rawInput.fingerprint, 'WORK_PREPARE_FINGERPRINT_REQUIRED'),
    proposedWorkId: normalized(rawInput.proposedWorkId, 'WORK_PREPARE_WORK_ID_REQUIRED'),
  };
  const identity = requestIdentity(input);
  return withControllerLock(
    input.controllerHome,
    { scope: 'global', resource: `work-prepare-${identity.slice(0, 24)}` },
    `work-prepare:${input.repoId}:${input.requestId}`,
    () => {
      const path = requestRecordPath(input.controllerHome, input.repoId, identity);
      if (existsSync(path)) {
        let existing: WorkPrepareRequestRecord;
        try {
          existing = readJsonFile<WorkPrepareRequestRecord>(path);
        } catch {
          throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${input.requestId}`);
        }
        validateExistingRecord(existing, input);
        const result = operation(existing, true);
        if (existing.status !== 'prepared') {
          writeJsonAtomic(path, { ...existing, status: 'prepared', updatedAt: new Date().toISOString() });
        }
        return result;
      }
      const record: WorkPrepareRequestRecord = {
        schemaVersion: 1,
        repoId: input.repoId,
        sessionId: input.sessionId,
        principalId: input.principalId,
        requestId: input.requestId,
        fingerprint: input.fingerprint,
        workId: input.proposedWorkId,
        status: 'claimed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(path, record);
      const result = operation(record, false);
      writeJsonAtomic(path, { ...record, status: 'prepared', updatedAt: new Date().toISOString() });
      return result;
    },
    undefined,
    WORK_PREPARE_LOCK_WAIT_MS,
  );
}
