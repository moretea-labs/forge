import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { advanceReleaseSession, createReleaseSession, readReleaseSession, type ReleaseSessionCandidateRelease, type ReleaseSessionStableRelease } from '../../src/runtime/standalone-recovery/release-session';
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

  test('fences stale observers and never lets them advance the current session', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-release-session-'));
    roots.push(home);
    const { stable, stableRelease, candidate, candidateRelease } = lanes(home);
    const session = createReleaseSession({ controllerHome: home, sessionId: candidate.sessionId, stable, stableRelease, candidate, sourceRevision: 'abc123' });
    advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'built', candidateRelease });
    expect(() => advanceReleaseSession({ controllerHome: home, sessionId: session.sessionId, expectedRevision: session.revision, phase: 'failed' })).toThrow('RELEASE_SESSION_REVISION_FENCED');
  });
});
