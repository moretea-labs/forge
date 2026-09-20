import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RELEASE_SESSION_PHASES, advanceReleaseSession, createReleaseSession, listReleaseSessions, migrateReleaseSessionState, readReleaseSession, releaseSessionCandidateIsRetired, type ReleaseSessionCandidateRelease, type ReleaseSessionStableRelease } from '../../src/runtime/release/release-session';
import type { RuntimeReleaseAuthority } from '../../src/runtime/root/release-store';
import { decideConfiguredRuntimeReleaseAction } from '../../src/runtime/release/release-coordinator';
import { cancelConfiguredRuntimeReleaseSession, createRecoveryConfig } from '../../src/runtime/standalone-recovery/core';
import type { CandidateExecutionLane, StableExecutionLane } from '../../src/runtime/root/runtime-lane';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function lanes(home: string): { stable: StableExecutionLane; stableRelease: ReleaseSessionStableRelease; candidate: CandidateExecutionLane; candidateRelease: ReleaseSessionCandidateRelease } {
  const stable: StableExecutionLane = { schemaVersion: 1, kind: 'stable', controllerHome: join(home, 'a'), serviceLabel: 'a', port: 8765, authTokenFile: join(home, 'a-token') };
  const stableRelease: ReleaseSessionStableRelease = { authorityRevision: 7, releaseId: 'stable-a', artifactIdentity: 'sha256:stable', manifestSha256: 'stable-manifest', workerProtocolVersion: 1, releaseFencingTokenSha256: 'stable-fence' };
  const candidate: CandidateExecutionLane = { schemaVersion: 1, kind: 'candidate', sessionId: 'release-session-12345678', controllerHome: join(home, 'b'), serviceLabel: 'b', port: 8766, authTokenFile: join(home, 'b-token'), databaseSnapshotPath: join(home, 'b', 'control-plane.sqlite'), sourceStableControllerHome: stable.controllerHome, createdAt: new Date().toISOString() };
  const candidateRelease: ReleaseSessionCandidateRelease = { releaseId: 'candidate-b', manifestPath: join(candidate.controllerHome, 'runtime', 'releases', 'candidate-b', 'manifest.json'), artifactIdentity: 'sha256:candidate', manifestSha256: 'candidate-manifest', treeSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sourceCommit: 'abc123', sourceRepositoryId: 'repo' };
  return { stable, stableRelease, candidate, candidateRelease };
}

describe('Recovery ReleaseSession', () => {
  test('requires all static and isolated-candidate evidence before cutover eligibility', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-'));
    roots.push(home);
    const { stable, stableRelease, candidate, candidateRelease } = lanes(home);
    let session = createReleaseSession({ controllerHome: home, sessionId: candidate.sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'built', candidateRelease, receipts: [{ id: 'build', kind: 'build', summary: 'built' }] });
    expect(() => advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'static_verified' })).toThrow('RELEASE_SESSION_STATIC_GATES_INCOMPLETE');
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'static_verified', receipts: ['type', 'runtime_architecture', 'architecture_sync', 'bootstrap'].map((id) => ({ id, kind: 'static_gate' as const, summary: id })) });
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'candidate_booted' });
    expect(() => advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'candidate_verified' })).toThrow('RELEASE_SESSION_CANDIDATE_CANARIES_INCOMPLETE');
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'candidate_verified', receipts: ['recovery', 'mcp', 'scheduler', 'supervisor', 'controller'].map((id) => ({ id, kind: 'candidate_canary' as const, summary: id })) });
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'cutover_eligible' });
    expect(readReleaseSession(home, session.sessionId)).toMatchObject({ phase: 'cutover_eligible', revision: session.revision });
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'cutover_attempting' });
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'rolled_back', receipts: [{ id: 'rollback', kind: 'rollback', summary: 'Stable A restored' }] });
    expect(readReleaseSession(home, session.sessionId)).toMatchObject({ phase: 'rolled_back', revision: session.revision });
  });

  test('lists durable sessions and exposes Candidate B retirement only from durable phase', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-inventory-'));
    roots.push(home);
    const { stable, stableRelease, candidate } = lanes(home);
    let session = createReleaseSession({ controllerHome: home, sessionId: candidate.sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });
    expect(listReleaseSessions(home)).toMatchObject({
      inspected: 1,
      truncated: false,
      invalidSessionFiles: [],
      sessions: [{ sessionId: candidate.sessionId, phase: 'source_frozen' }],
    });
    expect(releaseSessionCandidateIsRetired(session)).toBe(false);
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'failed' });
    expect(releaseSessionCandidateIsRetired(session)).toBe(true);
  });

  test('retires a superseded Candidate B before cutover without inventing another lifecycle state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-release-session-cancel-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const sessionId = 'release-session-cancel-1234';
    const candidateHome = join(root, 'candidate-runtime-lanes', sessionId);
    mkdirSync(candidateHome, { recursive: true });
    const stable: StableExecutionLane = {
      schemaVersion: 1,
      kind: 'stable',
      controllerHome,
      serviceLabel: 'stable',
      port: 8765,
      authTokenFile: join(controllerHome, 'runtime-token'),
    };
    const stableRelease: ReleaseSessionStableRelease = {
      authorityRevision: 7,
      releaseId: 'stable-a',
      artifactIdentity: 'sha256:stable',
      manifestSha256: 'stable-manifest',
      workerProtocolVersion: 1,
      releaseFencingTokenSha256: 'f'.repeat(64),
    };
    const candidate: CandidateExecutionLane = {
      schemaVersion: 1,
      kind: 'candidate',
      sessionId,
      controllerHome: candidateHome,
      serviceLabel: 'candidate',
      port: 8766,
      authTokenFile: join(candidateHome, 'runtime-token'),
      databaseSnapshotPath: join(candidateHome, 'control-plane.sqlite'),
      sourceStableControllerHome: controllerHome,
      createdAt: new Date().toISOString(),
    };
    const candidateRelease: ReleaseSessionCandidateRelease = {
      releaseId: 'candidate-b',
      manifestPath: join(candidateHome, 'runtime', 'releases', 'candidate-b', 'manifest.json'),
      artifactIdentity: 'sha256:candidate',
      manifestSha256: 'candidate-manifest',
      treeSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceCommit: 'abc123',
      sourceRepositoryId: 'repo',
    };
    let session = createReleaseSession({ controllerHome, sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });
    session = advanceReleaseSession({ controllerHome, sessionId, expectedRevision: session.revision, phase: 'built', candidateRelease });
    session = advanceReleaseSession({
      controllerHome,
      sessionId,
      expectedRevision: session.revision,
      phase: 'static_verified',
      receipts: ['type', 'runtime_architecture', 'architecture_sync', 'bootstrap'].map((id) => ({ id, kind: 'static_gate' as const, summary: id })),
    });

    const cancelled = await cancelConfiguredRuntimeReleaseSession(createRecoveryConfig(controllerHome), sessionId, 'test-cancel');
    expect(cancelled).toMatchObject({ ok: true, attempted: true, releaseSession: { phase: 'failed' } });
    expect(existsSync(candidateHome)).toBe(false);

    const again = await cancelConfiguredRuntimeReleaseSession(createRecoveryConfig(controllerHome), sessionId, 'test-cancel-again');
    expect(again).toMatchObject({ ok: true, attempted: false, noOp: true, releaseSession: { phase: 'failed' } });
  });

  test('cancels and removes a superseded pre-cutover Candidate B under Recovery authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-release-session-cancel-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const sessionId = 'release-session-cancel-1234';
    const candidateHome = join(root, 'candidate-runtime-lanes', sessionId);
    mkdirSync(candidateHome, { recursive: true });
    const stable: StableExecutionLane = {
      schemaVersion: 1,
      kind: 'stable',
      controllerHome,
      serviceLabel: 'stable',
      port: 8765,
      authTokenFile: join(controllerHome, 'mcp', 'runtime-token'),
    };
    const stableRelease: ReleaseSessionStableRelease = {
      authorityRevision: 7,
      releaseId: 'stable-a',
      artifactIdentity: 'sha256:stable',
      manifestSha256: 'stable-manifest',
      workerProtocolVersion: 1,
      releaseFencingTokenSha256: 'f'.repeat(64),
    };
    const candidate: CandidateExecutionLane = {
      schemaVersion: 1,
      kind: 'candidate',
      sessionId,
      controllerHome: candidateHome,
      serviceLabel: 'candidate',
      port: 8766,
      authTokenFile: join(candidateHome, 'mcp', 'runtime-token'),
      databaseSnapshotPath: join(candidateHome, 'control-plane.sqlite'),
      sourceStableControllerHome: controllerHome,
      createdAt: new Date().toISOString(),
    };
    createReleaseSession({ controllerHome, sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });

    const cancelled = await cancelConfiguredRuntimeReleaseSession(createRecoveryConfig(controllerHome), sessionId, 'test-cancel');
    expect(cancelled).toMatchObject({ ok: true, attempted: true, releaseSession: { phase: 'failed' } });
    expect(existsSync(candidateHome)).toBe(false);

    const again = await cancelConfiguredRuntimeReleaseSession(createRecoveryConfig(controllerHome), sessionId, 'test-cancel-again');
    expect(again).toMatchObject({ ok: true, attempted: false, noOp: true, releaseSession: { phase: 'failed' } });
  });

  test('enforces one active Runtime ReleaseSession per Forge instance', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-singleton-'));
    roots.push(home);
    const { stable, stableRelease, candidate } = lanes(home);
    let first = createReleaseSession({ controllerHome: home, sessionId: candidate.sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });
    const second: CandidateExecutionLane = {
      ...candidate,
      sessionId: 'release-session-87654321',
      controllerHome: join(home, 'candidate-2'),
      serviceLabel: 'candidate-2',
      port: 8767,
      databaseSnapshotPath: join(home, 'candidate-2', 'control-plane.sqlite'),
    };
    expect(() => createReleaseSession({ controllerHome: home, sessionId: second.sessionId, stable, stableRelease, candidate: second, sourceRevision: 'def456' }))
      .toThrow('RELEASE_SESSION_ACTIVE_EXISTS');
    first = advanceReleaseSession({ controllerHome: home, sessionId: first.sessionId, expectedRevision: first.revision, phase: 'failed' });
    expect(first.phase).toBe('failed');
    expect(() => createReleaseSession({ controllerHome: home, sessionId: second.sessionId, stable, stableRelease, candidate: second, sourceRevision: 'def456' }))
      .not.toThrow();
  });

  test('derives the next normal release action only from durable ReleaseSession phase', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-coordinator-'));
    roots.push(home);
    expect(decideConfiguredRuntimeReleaseAction(home)).toEqual({ action: 'prepare' });
    const { stable, stableRelease, candidate, candidateRelease } = lanes(home);
    let session = createReleaseSession({ controllerHome: home, sessionId: candidate.sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });
    expect(decideConfiguredRuntimeReleaseAction(home)).toMatchObject({ action: 'prepare', session: { sessionId: session.sessionId } });
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'built', candidateRelease });
    expect(decideConfiguredRuntimeReleaseAction(home)).toMatchObject({ action: 'verify_static', session: { revision: session.revision } });
    session = advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'static_verified', receipts: ['type', 'runtime_architecture', 'architecture_sync', 'bootstrap'].map((id) => ({ id, kind: 'static_gate' as const, summary: id })) });
    expect(decideConfiguredRuntimeReleaseAction(home)).toMatchObject({ action: 'verify_candidate' });
  });

  test('keeps Work completion and Watchdog outside normal release authority', () => {
    const root = join(import.meta.dir, '..', '..');
    const workFinalization = readFileSync(join(root, 'src/runtime/control-plane/execution/work-finalization-service.ts'), 'utf8');
    const workCompletion = readFileSync(join(root, 'src/runtime/control-plane/execution/work-completion-authority.ts'), 'utf8');
    const watchdog = readFileSync(join(root, 'src/runtime/watchdog/workflow-watchdog.ts'), 'utf8');
    expect(workFinalization).not.toContain('release-session');
    expect(workFinalization).not.toContain('standalone-recovery');
    expect(workCompletion).not.toContain('release-session');
    expect(workCompletion).not.toContain('standalone-recovery');
    expect(watchdog).not.toContain('release-session');
    expect(watchdog).not.toContain('release-coordinator');
    const coordinator = readFileSync(join(root, 'src/runtime/release/release-coordinator.ts'), 'utf8');
    expect(coordinator).not.toContain('standalone-recovery');
  });

  test('migrates one historical soaking session into the current rollback-authority model exactly once', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-migration-'));
    roots.push(home);
    const { stable, stableRelease, candidate, candidateRelease } = lanes(home);
    const sessionId = candidate.sessionId;
    const now = new Date().toISOString();
    const sessionDir = join(home, 'recovery', 'state', 'release-sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${sessionId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      stable,
      stableRelease,
      candidate,
      candidateRelease,
      sourceRevision: 'abc123',
      phase: 'soaking',
      revision: 9,
      receipts: [],
      createdAt: now,
      updatedAt: now,
    }, null, 2)}\n`);

    const backupPath = join(home, 'runtime', 'releases', 'backups', 'stable-a.sqlite');
    const authority: RuntimeReleaseAuthority = {
      schemaVersion: 2,
      status: 'committed',
      revision: 8,
      fencingToken: 'f'.repeat(64),
      active: {
        releaseId: candidateRelease.releaseId,
        artifactIdentity: candidateRelease.artifactIdentity,
        manifestPath: candidateRelease.manifestPath,
        manifestSha256: candidateRelease.manifestSha256,
        workerProtocolVersion: 1,
        publishedAt: now,
      },
      previous: {
        releaseId: stableRelease.releaseId,
        artifactIdentity: stableRelease.artifactIdentity,
        manifestPath: join(home, 'runtime', 'releases', 'stable-a', 'manifest.json'),
        manifestSha256: stableRelease.manifestSha256,
        workerProtocolVersion: stableRelease.workerProtocolVersion,
        publishedAt: now,
        databaseBackup: { path: backupPath, schemaVersion: 1, createdAt: now },
      },
      operationId: 'cutover-op',
      committedAt: now,
    };

    const first = migrateReleaseSessionState(home, { readAuthority: () => authority });
    expect(first).toMatchObject({ migratedSessionIds: [sessionId], currentSessionIds: [], inspected: 1 });
    expect(readReleaseSession(home, sessionId)).toMatchObject({
      schemaVersion: 1,
      semanticEpoch: 2,
      phase: 'soaking',
      revision: 9,
      transaction: {
        candidateReleaseId: candidateRelease.releaseId,
        cutoverAuthorityRevision: authority.revision,
        rollbackRelease: {
          releaseId: stableRelease.releaseId,
          databaseBackup: { path: backupPath },
        },
      },
    });

    const second = migrateReleaseSessionState(home, { readAuthority: () => authority });
    expect(second).toMatchObject({ migratedSessionIds: [], currentSessionIds: [sessionId], inspected: 1 });
  });

  test('migrates the observed transitional schema-2 failed session exactly once without changing durable state', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-schema2-migration-'));
    roots.push(home);
    const { stable, stableRelease, candidate } = lanes(home);
    const sessionId = candidate.sessionId;
    const root = join(home, 'recovery', 'state', 'release-sessions');
    mkdirSync(root, { recursive: true });
    const createdAt = '2026-09-18T13:15:53.309Z';
    const updatedAt = '2026-09-20T02:03:10.216Z';
    const receipts = [
      { id: `source:${sessionId}`, kind: 'source', recordedAt: createdAt, summary: 'source frozen at historical revision' },
      { id: 'candidate_cancelled', kind: 'candidate_canary', recordedAt: updatedAt, summary: 'Candidate B was retired before cutover' },
    ];
    writeFileSync(join(root, `${sessionId}.json`), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      stable,
      stableRelease,
      candidate,
      sourceRevision: '60dc9c2309b5e8001702f696ec1f3ed6d4b0f77e',
      phase: 'failed',
      revision: 2,
      receipts,
      createdAt,
      updatedAt,
    }, null, 2));

    const first = migrateReleaseSessionState(home);
    expect(first).toMatchObject({ migratedSessionIds: [sessionId], currentSessionIds: [], inspected: 1 });
    expect(readReleaseSession(home, sessionId)).toMatchObject({
      schemaVersion: 1,
      semanticEpoch: 2,
      sessionId,
      sourceRevision: '60dc9c2309b5e8001702f696ec1f3ed6d4b0f77e',
      phase: 'failed',
      revision: 2,
      receipts,
      createdAt,
      updatedAt,
    });
    expect(readReleaseSession(home, sessionId)?.transaction).toBeUndefined();

    const second = migrateReleaseSessionState(home);
    expect(second).toMatchObject({ migratedSessionIds: [], currentSessionIds: [sessionId], inspected: 1 });
  });

  test('preserves an existing transitional schema-2 rollback transaction during migration', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-schema2-transaction-migration-'));
    roots.push(home);
    const { stable, stableRelease, candidate, candidateRelease } = lanes(home);
    const sessionId = candidate.sessionId;
    const root = join(home, 'recovery', 'state', 'release-sessions');
    mkdirSync(root, { recursive: true });
    const updatedAt = '2026-09-20T00:00:00.000Z';
    const rollbackRelease = {
      releaseId: stableRelease.releaseId,
      artifactIdentity: stableRelease.artifactIdentity,
      manifestPath: join(home, 'runtime', 'releases', stableRelease.releaseId, 'manifest.json'),
      manifestSha256: stableRelease.manifestSha256,
      workerProtocolVersion: stableRelease.workerProtocolVersion,
      publishedAt: updatedAt,
      databaseBackup: {
        path: join(home, 'runtime', 'releases', 'backups', 'schema2-stable.sqlite'),
        schemaVersion: 1,
        createdAt: updatedAt,
      },
    };
    const transaction = {
      schemaVersion: 1,
      operationId: 'schema2-existing-cutover',
      candidateReleaseId: candidateRelease.releaseId,
      cutoverAuthorityRevision: stableRelease.authorityRevision + 7,
      rollbackRelease,
      startedAt: updatedAt,
    };
    writeFileSync(join(root, `${sessionId}.json`), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      stable,
      stableRelease,
      candidate,
      candidateRelease,
      transaction,
      sourceRevision: 'schema2-existing-transaction-revision',
      phase: 'soaking',
      revision: 11,
      receipts: [],
      createdAt: updatedAt,
      updatedAt,
    }, null, 2));

    const first = migrateReleaseSessionState(home);
    expect(first).toMatchObject({ migratedSessionIds: [sessionId], currentSessionIds: [], inspected: 1 });
    expect(readReleaseSession(home, sessionId)).toMatchObject({
      schemaVersion: 1,
      semanticEpoch: 2,
      phase: 'soaking',
      revision: 11,
      transaction,
    });
    const second = migrateReleaseSessionState(home);
    expect(second).toMatchObject({ migratedSessionIds: [], currentSessionIds: [sessionId], inspected: 1 });
  });

  test('migrates a historical known-good session with its exact rollback transaction evidence', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-known-good-migration-'));
    roots.push(home);
    const { stable, stableRelease, candidate, candidateRelease } = lanes(home);
    const sessionId = candidate.sessionId;
    const root = join(home, 'recovery', 'state', 'release-sessions');
    mkdirSync(root, { recursive: true });
    const updatedAt = '2026-09-20T00:00:00.000Z';
    writeFileSync(join(root, `${sessionId}.json`), JSON.stringify({
      schemaVersion: 1,
      sessionId,
      stable,
      stableRelease,
      candidate,
      candidateRelease,
      sourceRevision: 'abc123',
      phase: 'known_good',
      revision: 9,
      receipts: [],
      createdAt: updatedAt,
      updatedAt,
    }, null, 2));
    const rollbackRelease = {
      releaseId: stableRelease.releaseId,
      artifactIdentity: stableRelease.artifactIdentity,
      manifestPath: join(home, 'runtime', 'releases', stableRelease.releaseId, 'manifest.json'),
      manifestSha256: stableRelease.manifestSha256,
      workerProtocolVersion: stableRelease.workerProtocolVersion,
      publishedAt: updatedAt,
      databaseBackup: {
        path: join(home, 'runtime', 'releases', 'backups', 'stable.sqlite'),
        schemaVersion: 1,
        createdAt: updatedAt,
      },
    };
    const authority = {
      schemaVersion: 2 as const,
      status: 'committed' as const,
      revision: stableRelease.authorityRevision + 1,
      fencingToken: 'fence-known-good',
      active: {
        releaseId: candidateRelease.releaseId,
        artifactIdentity: candidateRelease.artifactIdentity,
        manifestPath: candidateRelease.manifestPath,
        manifestSha256: candidateRelease.manifestSha256,
        workerProtocolVersion: stableRelease.workerProtocolVersion,
        publishedAt: updatedAt,
      },
      previous: rollbackRelease,
      operationId: 'known-good-migration',
      committedAt: updatedAt,
    };

    migrateReleaseSessionState(home, { readAuthority: () => authority });

    expect(readReleaseSession(home, sessionId)).toMatchObject({
      semanticEpoch: 2,
      phase: 'known_good',
      transaction: {
        candidateReleaseId: candidateRelease.releaseId,
        rollbackRelease: { releaseId: stableRelease.releaseId },
      },
    });
  });

  test('keeps the current semantic model readable by the previous schema-1 Recovery wire reader', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-wire-compat-'));
    roots.push(home);
    const { stable, stableRelease, candidate } = lanes(home);
    const session = createReleaseSession({
      controllerHome: home,
      sessionId: candidate.sessionId,
      stable,
      stableRelease,
      candidate,
      sourceRevision: 'abc123',
    });
    const raw = JSON.parse(readFileSync(join(home, 'recovery', 'state', 'release-sessions', `${session.sessionId}.json`), 'utf8')) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect(raw.semanticEpoch).toBe(2);
    expect(raw.sessionId).toBe(session.sessionId);
    expect(RELEASE_SESSION_PHASES.includes(raw.phase as any)).toBe(true);
  });

  test('fences stale observers and never lets them advance the current session', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-'));
    roots.push(home);
    const { stable, stableRelease, candidate, candidateRelease } = lanes(home);
    const session = createReleaseSession({ controllerHome: home, sessionId: candidate.sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });
    advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'built', candidateRelease });
    expect(() => advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'failed' })).toThrow('RELEASE_SESSION_REVISION_FENCED');
  });
});
