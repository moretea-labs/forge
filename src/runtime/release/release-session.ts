import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { assertStorageHeadroom } from '../shared/storage-capacity';
import type { CandidateExecutionLane, StableExecutionLane } from '../root/runtime-lane';
import type { RuntimePublishedRelease, RuntimeReleaseAuthority } from '../root/release-store';

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

/**
 * Durable semantic rollback authority for one ReleaseSession after physical
 * cutover has published Candidate B. RuntimeReleaseAuthority stores only
 * physical active/previous release identity and backing artifacts; rollback
 * eligibility and transaction semantics live only in this ReleaseSession.
 */
export interface ReleaseSessionTransaction {
  schemaVersion: 1;
  operationId: string;
  candidateReleaseId: string;
  cutoverAuthorityRevision: number;
  rollbackRelease: RuntimePublishedRelease;
  startedAt: string;
}

export interface ReleaseSession {
  /** Wire/storage schema remains readable by the previous Recovery release. */
  schemaVersion: 1;
  /** Current semantic model. Legacy records omit this field (or carry epoch 1). */
  semanticEpoch: 2;
  sessionId: string;
  stable: StableExecutionLane;
  stableRelease: ReleaseSessionStableRelease;
  candidate: CandidateExecutionLane;
  candidateRelease?: ReleaseSessionCandidateRelease;
  transaction?: ReleaseSessionTransaction;
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

function sameStableRelease(session: Pick<ReleaseSession, 'stableRelease'>, release: RuntimePublishedRelease): boolean {
  return release.releaseId === session.stableRelease.releaseId
    && release.artifactIdentity === session.stableRelease.artifactIdentity
    && release.manifestSha256 === session.stableRelease.manifestSha256
    && release.workerProtocolVersion === session.stableRelease.workerProtocolVersion;
}

function validTransaction(session: ReleaseSession): boolean {
  const transaction = session.transaction;
  if (!transaction) return !['cutover_committed', 'soaking'].includes(session.phase);
  const rollback = transaction.rollbackRelease;
  return transaction.schemaVersion === 1
    && Boolean(transaction.operationId?.trim())
    && Boolean(session.candidateRelease)
    && transaction.candidateReleaseId === session.candidateRelease!.releaseId
    && Number.isInteger(transaction.cutoverAuthorityRevision)
    && transaction.cutoverAuthorityRevision > session.stableRelease.authorityRevision
    && Number.isFinite(Date.parse(transaction.startedAt))
    && sameStableRelease(session, rollback)
    && Boolean(rollback.manifestPath?.trim())
    && Number.isFinite(Date.parse(rollback.publishedAt))
    && Boolean(rollback.databaseBackup)
    && resolve(rollback.databaseBackup!.path) === rollback.databaseBackup!.path
    && Number.isInteger(rollback.databaseBackup!.schemaVersion)
    && rollback.databaseBackup!.schemaVersion > 0
    && Number.isFinite(Date.parse(rollback.databaseBackup!.createdAt));
}

function assertCurrentSession(value: ReleaseSession, sessionId: string): ReleaseSession {
  if (
    value.schemaVersion !== 1
    || value.semanticEpoch !== 2
    || value.sessionId !== sessionId
    || !RELEASE_SESSION_PHASES.includes(value.phase)
    || !Number.isInteger(value.revision)
    || value.revision < 1
    || !validTransaction(value)
  ) throw new Error('RELEASE_SESSION_INVALID');
  return value;
}

export interface ReleaseSessionStateMigration {
  migratedSessionIds: string[];
  currentSessionIds: string[];
  inspected: number;
}

type LegacyReleaseSessionV1 = Omit<ReleaseSession, 'semanticEpoch' | 'transaction'> & {
  schemaVersion: 1;
  semanticEpoch?: 1;
};

type TransitionalReleaseSessionV2 = Omit<ReleaseSession, 'schemaVersion' | 'semanticEpoch'> & {
  schemaVersion: 2;
  semanticEpoch?: never;
};

type MigratableReleaseSession = ReleaseSession | LegacyReleaseSessionV1 | TransitionalReleaseSessionV2;

function releaseIdentityKey(release: {
  releaseId?: string;
  artifactIdentity?: string;
  manifestSha256?: string;
} | undefined): string | undefined {
  const releaseId = release?.releaseId?.trim() || '';
  const artifactIdentity = release?.artifactIdentity?.trim() || '';
  const manifestSha256 = release?.manifestSha256?.trim() || '';
  if (!releaseId || !artifactIdentity || !manifestSha256) return undefined;
  return `${releaseId}\u0000${artifactIdentity}\u0000${manifestSha256}`;
}

function basicMigratableSessionShape(raw: MigratableReleaseSession, id: string): boolean {
  const schemaSupported = (raw.schemaVersion === 1 && (raw.semanticEpoch === undefined || raw.semanticEpoch === 1 || raw.semanticEpoch === 2))
    || (raw.schemaVersion === 2 && raw.semanticEpoch === undefined);
  return schemaSupported
    && raw.sessionId === id
    && RELEASE_SESSION_PHASES.includes(raw.phase)
    && Number.isFinite(Date.parse(raw.createdAt))
    && Number.isFinite(Date.parse(raw.updatedAt));
}

function historicalAcceptanceReceipt(
  sessionId: string,
  recordedAt: string,
  proof: string,
): ReleaseSessionReceipt {
  return {
    id: `migration:historical-known-good:${sessionId}`,
    kind: 'known_good',
    recordedAt,
    summary: `Legacy soaking state reconciled as known-good from exact durable release lineage: ${proof}.`,
  };
}

export function migrateReleaseSessionState(
  controllerHome: string,
  dependencies: { readAuthority?: () => RuntimeReleaseAuthority | undefined } = {},
): ReleaseSessionStateMigration {
  const root = dirname(sessionPath(controllerHome, 'release-session-migration'));
  if (!existsSync(root)) return { migratedSessionIds: [], currentSessionIds: [], inspected: 0 };
  const authority = dependencies.readAuthority?.();
  const migratedSessionIds: string[] = [];
  const currentSessionIds: string[] = [];
  const names = readdirSync(root).filter((name) => name.endsWith('.json')).sort();
  const parsed = names.map((name) => {
    const id = name.slice(0, -'.json'.length);
    const path = sessionPath(controllerHome, validSessionId(id));
    try {
      return { id, path, raw: JSON.parse(readFileSync(path, 'utf8')) as MigratableReleaseSession };
    } catch {
      throw new Error(`RELEASE_SESSION_MIGRATION_INVALID_JSON: ${id}`);
    }
  });
  const stableSuccessors = new Map<string, Array<{ sessionId: string; createdAt: string }>>();
  for (const entry of parsed) {
    if (!basicMigratableSessionShape(entry.raw, entry.id)) continue;
    const stableKey = releaseIdentityKey(entry.raw.stableRelease);
    if (!stableKey) continue;
    const existing = stableSuccessors.get(stableKey) ?? [];
    existing.push({ sessionId: entry.id, createdAt: entry.raw.createdAt });
    stableSuccessors.set(stableKey, existing);
  }
  const activeKey = releaseIdentityKey(authority?.active);
  const previousKey = releaseIdentityKey(authority?.previous);

  for (const { id, path, raw } of parsed) {
    if (raw.schemaVersion === 1 && raw.semanticEpoch === 2) {
      let current = raw as ReleaseSession;
      if (
        !current.transaction
        && current.phase === 'cutover_attempting'
        && current.candidateRelease
        && authority?.active.releaseId === current.candidateRelease.releaseId
        && authority.active.artifactIdentity === current.candidateRelease.artifactIdentity
        && authority.previous?.databaseBackup
        && authority.previous.releaseId === current.stableRelease.releaseId
        && authority.previous.artifactIdentity === current.stableRelease.artifactIdentity
        && authority.previous.manifestSha256 === current.stableRelease.manifestSha256
      ) {
        current = {
          ...current,
          transaction: {
            schemaVersion: 1,
            operationId: `reconcile:${id}:${authority.revision}`,
            candidateReleaseId: current.candidateRelease.releaseId,
            cutoverAuthorityRevision: authority.revision,
            rollbackRelease: authority.previous,
            startedAt: authority.committedAt,
          },
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        assertCurrentSession(current, id);
        writeSession(path, current);
        migratedSessionIds.push(id);
      } else {
        assertCurrentSession(current, id);
        currentSessionIds.push(id);
      }
      continue;
    }
    const legacyV1 = raw.schemaVersion === 1
      && (raw.semanticEpoch === undefined || raw.semanticEpoch === 1);
    const transitionalV2 = raw.schemaVersion === 2
      && raw.semanticEpoch === undefined;
    if ((!legacyV1 && !transitionalV2) || !basicMigratableSessionShape(raw, id)) {
      throw new Error(`RELEASE_SESSION_MIGRATION_UNSUPPORTED_SCHEMA: ${id}`);
    }

    let transaction: ReleaseSessionTransaction | undefined = 'transaction' in raw
      ? raw.transaction
      : undefined;
    let migratedPhase = raw.phase;
    let migratedReceipts = raw.receipts;
    const candidateKey = releaseIdentityKey(raw.candidateRelease);
    const candidateIsActive = Boolean(candidateKey && activeKey && candidateKey === activeKey);
    if (!transaction && ['cutover_attempting', 'cutover_committed', 'soaking', 'known_good'].includes(raw.phase)) {
      const candidate = raw.candidateRelease;
      const previous = authority?.previous;
      if (
        candidateIsActive
        && candidate
        && authority
        && previous?.databaseBackup
        && previous.releaseId === raw.stableRelease.releaseId
        && previous.artifactIdentity === raw.stableRelease.artifactIdentity
        && previous.manifestSha256 === raw.stableRelease.manifestSha256
      ) {
        transaction = {
          schemaVersion: 1,
          operationId: `migration:${id}:${authority.revision}`,
          candidateReleaseId: candidate.releaseId,
          cutoverAuthorityRevision: authority.revision,
          rollbackRelease: previous,
          startedAt: raw.updatedAt,
        };
      } else if (raw.phase === 'known_good') {
        // Historical terminal acceptance needs no live rollback authority. Keep
        // exact transaction evidence when it is reconstructable above, but do
        // not invent obsolete rollback state for already-terminal sessions.
      } else if (raw.phase === 'soaking' && candidateKey && !candidateIsActive) {
        const updatedAtMs = Date.parse(raw.updatedAt);
        const successors = (stableSuccessors.get(candidateKey) ?? [])
          .filter((entry) => entry.sessionId !== id && Date.parse(entry.createdAt) >= updatedAtMs);
        if (successors.length > 1) {
          throw new Error(`RELEASE_SESSION_MIGRATION_HISTORICAL_ACCEPTANCE_AMBIGUOUS: ${id}`);
        }
        const previousAuthorityProof = Boolean(previousKey && candidateKey === previousKey);
        if (successors.length === 0 && !previousAuthorityProof) {
          throw new Error(`RELEASE_SESSION_MIGRATION_HISTORICAL_ACCEPTANCE_UNPROVEN: ${id}`);
        }
        migratedPhase = 'known_good';
        const proof = successors.length === 1
          ? `successor ReleaseSession ${successors[0]!.sessionId} uses Candidate B as Stable A`
          : 'current RuntimeReleaseAuthority.previous references Candidate B';
        const receiptId = `migration:historical-known-good:${id}`;
        migratedReceipts = raw.receipts.some((receipt) => receipt.id === receiptId)
          ? raw.receipts
          : [...raw.receipts, historicalAcceptanceReceipt(id, raw.updatedAt, proof)];
      } else {
        throw new Error(`RELEASE_SESSION_MIGRATION_AUTHORITY_MISMATCH: ${id}`);
      }
    }
    const migrated = assertCurrentSession({
      ...raw,
      schemaVersion: 1,
      semanticEpoch: 2,
      phase: migratedPhase,
      receipts: migratedReceipts,
      ...(transaction ? { transaction } : {}),
    } as ReleaseSession, id);
    writeSession(path, migrated);
    migratedSessionIds.push(id);
  }
  return { migratedSessionIds, currentSessionIds, inspected: names.length };
}

export function readReleaseSession(controllerHome: string, sessionId: string): ReleaseSession | undefined {
  const path = sessionPath(controllerHome, validSessionId(sessionId));
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ReleaseSession;
    return assertCurrentSession(value, sessionId);
  } catch (error) {
    if (error instanceof Error && error.message === 'RELEASE_SESSION_INVALID') throw error;
    throw new Error('RELEASE_SESSION_INVALID');
  }
}

export interface ReleaseSessionInventory {
  sessions: ReleaseSession[];
  invalidSessionFiles: string[];
  inspected: number;
  truncated: boolean;
}

/**
 * Bounded read-only inventory for ReleaseSession authority.
 * The release domain owns phase progression. Recovery may execute fenced
 * Runtime mutations, but it is not the semantic owner of normal release intent.
 */
export function listReleaseSessions(
  controllerHome: string,
  options: { maxEntries?: number } = {},
): ReleaseSessionInventory {
  const root = dirname(sessionPath(controllerHome, 'release-session-inventory'));
  if (!existsSync(root)) return { sessions: [], invalidSessionFiles: [], inspected: 0, truncated: false };
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 512));
  const names = readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const selected = names.slice(0, maxEntries);
  const sessions: ReleaseSession[] = [];
  const invalidSessionFiles: string[] = [];
  for (const name of selected) {
    const sessionId = name.slice(0, -'.json'.length);
    try {
      const session = readReleaseSession(controllerHome, sessionId);
      if (session) sessions.push(session);
      else invalidSessionFiles.push(name);
    } catch {
      invalidSessionFiles.push(name);
    }
  }
  return {
    sessions,
    invalidSessionFiles,
    inspected: selected.length,
    truncated: names.length > selected.length,
  };
}

const RELEASE_SESSION_TERMINAL_PHASES = new Set<ReleaseSessionPhase>([
  'known_good',
  'rolled_back',
  'failed',
]);

const RELEASE_SESSION_CANDIDATE_RETIRED_PHASES = new Set<ReleaseSessionPhase>([
  'soaking',
  ...RELEASE_SESSION_TERMINAL_PHASES,
]);

export function releaseSessionIsTerminal(session: ReleaseSession): boolean {
  return RELEASE_SESSION_TERMINAL_PHASES.has(session.phase);
}

/**
 * Durable semantic proof that Candidate B is no longer required as a mutable
 * Controller Home. This does not itself authorize deletion: cleanup must still
 * prove the exact fenced path and absence of a live Runtime owner.
 */
export function releaseSessionCandidateIsRetired(session: ReleaseSession): boolean {
  return RELEASE_SESSION_CANDIDATE_RETIRED_PHASES.has(session.phase);
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
  const inventory = listReleaseSessions(input.controllerHome, { maxEntries: 512 });
  if (inventory.truncated || inventory.invalidSessionFiles.length > 0) {
    throw new Error(`RELEASE_SESSION_INVENTORY_INCOMPLETE: truncated=${inventory.truncated}; invalid=${inventory.invalidSessionFiles.join(',') || 'none'}`);
  }
  const active = inventory.sessions.filter((session) => !releaseSessionIsTerminal(session));
  if (active.length > 0) {
    throw new Error(`RELEASE_SESSION_ACTIVE_EXISTS: ${active.map((session) => `${session.sessionId}:${session.phase}`).join(',')}`);
  }
  if (resolve(input.stable.controllerHome) === resolve(input.candidate.controllerHome)) throw new Error('RELEASE_SESSION_LANE_COLLISION');
  const timestamp = new Date().toISOString();
  const session: ReleaseSession = {
    schemaVersion: 1,
    semanticEpoch: 2,
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
 * The release coordinator calls this while the executing provider holds the
 * appropriate mutation lock. expectedRevision is a CAS fence, so a stale
 * observer cannot advance a newer session.
 */
export function recordReleaseSessionTransaction(input: {
  controllerHome: string;
  sessionId: string;
  expectedRevision: number;
  transaction: ReleaseSessionTransaction;
}): ReleaseSession {
  const current = readReleaseSession(input.controllerHome, input.sessionId);
  if (!current) throw new Error('RELEASE_SESSION_MISSING');
  if (current.revision !== input.expectedRevision) throw new Error('RELEASE_SESSION_REVISION_FENCED');
  if (current.phase !== 'cutover_attempting') throw new Error(`RELEASE_SESSION_TRANSACTION_REQUIRES_CUTOVER_ATTEMPTING: ${current.phase}`);
  const next = {
    ...current,
    transaction: input.transaction,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  } satisfies ReleaseSession;
  if (!validTransaction(next)) throw new Error('RELEASE_SESSION_TRANSACTION_INVALID');
  writeSession(sessionPath(input.controllerHome, current.sessionId), next);
  return next;
}

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
