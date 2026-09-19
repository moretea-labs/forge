import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { assertStorageHeadroom } from '../shared/storage-capacity';
import type { CandidateExecutionLane, StableExecutionLane } from '../root/runtime-lane';

export const RELEASE_SESSION_PHASES = [
  'source_frozen',
  'built',
  'static_verified',
  'candidate_booted',
  'candidate_verified',
  'cutover_eligible',
  'cutover_attempting',
  'cutover_committed',
  'soaking',
  'known_good',
  'rolled_back',
  'failed',
] as const;

export type ReleaseSessionPhase = (typeof RELEASE_SESSION_PHASES)[number];

export interface ReleaseSessionStableRelease {
  authorityRevision: number;
  releaseId: string;
  artifactIdentity: string;
  manifestSha256: string;
  workerProtocolVersion: number;
  releaseFencingTokenSha256: string;
}

export interface ReleaseSessionCandidateRelease {
  releaseId: string;
  manifestPath: string;
  artifactIdentity: string;
  manifestSha256: string;
  treeSha256: string;
  sourceCommit: string;
  sourceRepositoryId?: string;
}

export interface ReleaseSessionReceipt {
  id: string;
  kind: 'source' | 'build' | 'static_gate' | 'candidate_canary' | 'cutover' | 'soak' | 'known_good' | 'rollback';
  recordedAt: string;
  summary: string;
}

export interface ReleaseSession {
  schemaVersion: 1;
  sessionId: string;
  stable: StableExecutionLane;
  stableRelease: ReleaseSessionStableRelease;
  candidate: CandidateExecutionLane;
  candidateRelease?: ReleaseSessionCandidateRelease;
  sourceRevision: string;
  phase: ReleaseSessionPhase;
  revision: number;
  receipts: ReleaseSessionReceipt[];
  createdAt: string;
  updatedAt: string;
}

const REQUIRED_STATIC_GATES = new Set(['type', 'runtime_architecture', 'architecture_sync', 'bootstrap']);
const REQUIRED_CANDIDATE_CANARIES = new Set(['recovery', 'mcp', 'scheduler', 'supervisor', 'controller']);

function sessionPath(controllerHome: string, sessionId: string): string {
  return join(resolve(controllerHome), 'recovery', 'state', 'release-sessions', `${sessionId}.json`);
}

function validSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(sessionId)) throw new Error('RELEASE_SESSION_ID_INVALID');
  return sessionId;
}

function writeSession(path: string, session: ReleaseSession): void {
  const content = `${JSON.stringify(session, null, 2)}\n`;
  assertStorageHeadroom(path, { operation: 'release_session_write', requiredBytes: Buffer.byteLength(content), reserveBytes: 16 * 1024 * 1024 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export function readReleaseSession(controllerHome: string, sessionId: string): ReleaseSession | undefined {
  const path = sessionPath(controllerHome, validSessionId(sessionId));
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ReleaseSession;
    if (value.schemaVersion !== 1 || value.sessionId !== sessionId || !RELEASE_SESSION_PHASES.includes(value.phase) || !Number.isInteger(value.revision) || value.revision < 1) {
      throw new Error('RELEASE_SESSION_INVALID');
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'RELEASE_SESSION_INVALID') throw error;
    throw new Error('RELEASE_SESSION_INVALID');
  }
}

export function createReleaseSession(input: {
  controllerHome: string;
  sessionId: string;
  stable: StableExecutionLane;
  stableRelease: ReleaseSessionStableRelease;
  candidate: CandidateExecutionLane;
  sourceRevision: string;
}): ReleaseSession {
  const sessionId = validSessionId(input.sessionId);
  const path = sessionPath(input.controllerHome, sessionId);
  if (existsSync(path)) throw new Error('RELEASE_SESSION_ALREADY_EXISTS');
  if (resolve(input.stable.controllerHome) === resolve(input.candidate.controllerHome)) throw new Error('RELEASE_SESSION_LANE_COLLISION');
  const timestamp = new Date().toISOString();
  const session: ReleaseSession = {
    schemaVersion: 1,
    sessionId,
    stable: input.stable,
    stableRelease: input.stableRelease,
    candidate: input.candidate,
    sourceRevision: input.sourceRevision.trim(),
    phase: 'source_frozen',
    revision: 1,
    receipts: [{ id: `source:${sessionId}`, kind: 'source', recordedAt: timestamp, summary: `source frozen at ${input.sourceRevision.trim()}` }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!session.sourceRevision) throw new Error('RELEASE_SESSION_SOURCE_REVISION_REQUIRED');
  if (
    !Number.isInteger(session.stableRelease.authorityRevision)
    || session.stableRelease.authorityRevision < 1
    || !session.stableRelease.releaseId
    || !session.stableRelease.artifactIdentity
    || !session.stableRelease.manifestSha256
    || !Number.isInteger(session.stableRelease.workerProtocolVersion)
    || session.stableRelease.workerProtocolVersion < 1
    || !session.stableRelease.releaseFencingTokenSha256
  ) throw new Error('RELEASE_SESSION_STABLE_RELEASE_IDENTITY_INVALID');
  writeSession(path, session);
  return session;
}

function receiptIds(session: ReleaseSession, kind: ReleaseSessionReceipt['kind']): Set<string> {
  return new Set(session.receipts.filter((receipt) => receipt.kind === kind).map((receipt) => receipt.id));
}

function assertTransition(session: ReleaseSession, phase: ReleaseSessionPhase): void {
  const order: ReleaseSessionPhase[] = ['source_frozen', 'built', 'static_verified', 'candidate_booted', 'candidate_verified', 'cutover_eligible', 'cutover_attempting', 'cutover_committed', 'soaking', 'known_good'];
  if (session.phase === 'failed' || session.phase === 'rolled_back' || session.phase === 'known_good') {
    throw new Error('RELEASE_SESSION_TERMINAL');
  }
  if (phase === 'failed') return;
  if (phase === 'rolled_back') {
    if (order.indexOf(session.phase) < order.indexOf('cutover_attempting')) {
      throw new Error('RELEASE_SESSION_ROLLBACK_BEFORE_CUTOVER_ATTEMPT');
    }
    return;
  }
  if (order.indexOf(phase) !== order.indexOf(session.phase) + 1) throw new Error('RELEASE_SESSION_TRANSITION_INVALID');
  if ((phase === 'built' || phase === 'static_verified') && !session.candidateRelease) {
    throw new Error('RELEASE_SESSION_CANDIDATE_RELEASE_REQUIRED');
  }
  if (phase === 'static_verified' && [...REQUIRED_STATIC_GATES].some((id) => !receiptIds(session, 'static_gate').has(id))) {
    throw new Error('RELEASE_SESSION_STATIC_GATES_INCOMPLETE');
  }
  if (phase === 'candidate_verified' && [...REQUIRED_CANDIDATE_CANARIES].some((id) => !receiptIds(session, 'candidate_canary').has(id))) {
    throw new Error('RELEASE_SESSION_CANDIDATE_CANARIES_INCOMPLETE');
  }
  if (phase === 'cutover_eligible' && (session.stable.controllerHome === session.candidate.controllerHome || session.stable.port === session.candidate.port)) {
    throw new Error('RELEASE_SESSION_LANE_COLLISION');
  }
}

/**
 * Recovery calls this under its existing operation lock. expectedRevision is
 * a second CAS fence, so a stale observer cannot advance a newer session.
 */
export function advanceReleaseSession(input: {
  controllerHome: string;
  sessionId: string;
  expectedRevision: number;
  phase: ReleaseSessionPhase;
  candidateRelease?: ReleaseSessionCandidateRelease;
  receipts?: Array<Omit<ReleaseSessionReceipt, 'recordedAt'>>;
}): ReleaseSession {
  const current = readReleaseSession(input.controllerHome, input.sessionId);
  if (!current) throw new Error('RELEASE_SESSION_MISSING');
  if (current.revision !== input.expectedRevision) throw new Error('RELEASE_SESSION_REVISION_FENCED');
  const recordedAt = new Date().toISOString();
  const receipts = [...current.receipts, ...(input.receipts ?? []).map((receipt) => ({ ...receipt, recordedAt }))].slice(-64);
  const candidateRelease = input.candidateRelease ?? current.candidateRelease;
  if (candidateRelease && (
    !candidateRelease.releaseId
    || !candidateRelease.manifestPath
    || !candidateRelease.artifactIdentity
    || !candidateRelease.manifestSha256
    || !/^[a-f0-9]{64}$/i.test(candidateRelease.treeSha256)
    || candidateRelease.sourceCommit !== current.sourceRevision
  )) throw new Error('RELEASE_SESSION_CANDIDATE_RELEASE_IDENTITY_INVALID');
  const proposed: ReleaseSession = { ...current, ...(candidateRelease ? { candidateRelease } : {}), receipts };
  assertTransition(proposed, input.phase);
  const next: ReleaseSession = { ...proposed, phase: input.phase, revision: current.revision + 1, updatedAt: recordedAt };
  writeSession(sessionPath(input.controllerHome, current.sessionId), next);
  return next;
}
