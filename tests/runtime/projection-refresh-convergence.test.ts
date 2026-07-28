import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { GlobalScheduler } from '../../src/runtime/control-plane/global-scheduler/scheduler';
import { evaluateRuntimeHealth } from '../../src/runtime/health';
import {
  projectionObservation,
  readRepositoryProjectionSnapshot,
  rebuildRepositoryProjection,
  refreshRepositoryProjectionForRepository,
} from '../../src/runtime/projections/materialized-view';
import {
  clearRepositoryProjectionDirty,
  gitRevisionsEquivalent,
  markRepositoryProjectionDirty,
  persistRepositoryProjectionDirty,
  readRepositoryProjectionDirty,
  repositoryProjectionDirtyPath,
} from '../../src/runtime/projections/invalidation';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function initRepo(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), 'projection fixture\n');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Repo Harness Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
}

function commitFile(root: string, path: string, content: string, message: string): string {
  writeFileSync(join(root, path), content);
  git(root, ['add', path]);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function fixture() {
  const root = temp('repo-harness-projection-refresh-repo-');
  const controllerHome = temp('repo-harness-projection-refresh-home-');
  initRepo(root);
  const repository = registerRepository({ path: root, controllerHome, displayName: 'projection-refresh' });
  return { root, controllerHome, repository };
}

function projectionHealth(snapshot: ReturnType<typeof readRepositoryProjectionSnapshot>) {
  return evaluateRuntimeHealth({
    daemon: { status: 'ready', heartbeatAgeMs: 100 },
    scheduler: { status: 'ready', heartbeatAgeMs: 100 },
    workers: {
      queueDepth: snapshot.projection.queueDepth,
      runningWorkers: snapshot.projection.runningWorkers,
      activeLeases: snapshot.projection.activeLeases,
      activeAttentionCount: snapshot.projection.currentAttention.length,
    },
    projection: projectionObservation(snapshot),
    localBridge: {
      enabled: false,
      requiredForReadiness: false,
      mode: 'disabled',
      endpointReachable: true,
      expectedSurface: true,
    },
    runtimeStorage: { readable: true, ready: true },
  });
}

describe('projection refresh convergence', () => {
  test('dirty source revision refreshes with an empty queue, clears dirty, and returns readiness to ready', async () => {
    const fx = fixture();
    const initial = rebuildRepositoryProjection(fx.controllerHome, fx.repository.repoId);
    const initialHead = git(fx.root, ['rev-parse', 'HEAD']);
    expect(gitRevisionsEquivalent(initial.metadata?.generatedFromRevision, initialHead)).toBe(true);

    const nextHead = commitFile(fx.root, 'src/index.ts', 'export const value = 2;\n', 'change source');
    const scheduler = new GlobalScheduler(fx.controllerHome, {
      pollIntervalMs: 50,
      idleBackoffMaxMs: 250,
    });
    const ticked = await scheduler.tick();

    expect(ticked.activeJobs).toBe(0);
    expect(readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId)).toBeUndefined();
    const snapshot = readRepositoryProjectionSnapshot(fx.controllerHome, fx.repository.repoId);
    expect(snapshot.stale).toBe(false);
    expect(gitRevisionsEquivalent(snapshot.projection.metadata?.generatedFromRevision, nextHead)).toBe(true);
    const health = projectionHealth(snapshot);
    expect(health.ready).toBe(true);
    expect(health.activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_REFRESH_MISSED');
  });

  test('failure evidence persists, retry succeeds, and terminal success does not report a missed refresh', () => {
    const fx = fixture();
    const sourceRevision = git(fx.root, ['rev-parse', 'HEAD']);
    markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'test-failure', { sourceRevision });
    const projectionPath = join(repositoryControllerRoot(fx.controllerHome, fx.repository.repoId), 'projections', 'runtime.json');
    rmSync(projectionPath, { force: true });
    mkdirSync(projectionPath, { recursive: true });

    expect(() => refreshRepositoryProjectionForRepository(fx.controllerHome, fx.repository, {
      sourceRevision,
      reason: 'test-failure',
    })).toThrow();

    const failed = readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId);
    expect(failed?.refreshStatus).toBe('failed');
    expect(failed?.lastFailure?.message).toBeTruthy();
    expect(failed?.nextAttemptAt).toBeTruthy();

    rmSync(projectionPath, { recursive: true, force: true });
    const retried = refreshRepositoryProjectionForRepository(fx.controllerHome, fx.repository, {
      sourceRevision,
      reason: 'test-retry',
      force: true,
    });

    expect(retried.refreshed).toBe(true);
    expect(readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId)).toBeUndefined();
    const snapshot = readRepositoryProjectionSnapshot(fx.controllerHome, fx.repository.repoId);
    expect(projectionObservation(snapshot).lastBuildError).toBeUndefined();
    expect(projectionHealth(snapshot).activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_REFRESH_MISSED');
  });

  test('newer revision wins, stale owner recovers, concurrent requests coalesce, and short SHA compares equal', () => {
    const fx = fixture();
    const head = git(fx.root, ['rev-parse', 'HEAD']);
    const shortHead = git(fx.root, ['rev-parse', '--short=12', 'HEAD']);
    const first = markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'same-source', { sourceRevision: shortHead });
    const second = markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'same-source', { sourceRevision: head });
    expect(second?.nonce).toBe(first?.nonce);
    expect(gitRevisionsEquivalent(second?.sourceRevision, head)).toBe(true);

    const snapshot = readRepositoryProjectionSnapshot(fx.controllerHome, fx.repository.repoId);
    expect(snapshot.sourceRevisionChanged).toBe(true);
    const refreshed = refreshRepositoryProjectionForRepository(fx.controllerHome, fx.repository, {
      sourceRevision: shortHead,
      reason: 'short-sha',
      force: true,
    });
    expect(refreshed.refreshed).toBe(true);
    expect(gitRevisionsEquivalent(refreshed.projection?.metadata?.generatedFromRevision, head)).toBe(true);

    const equivalentDirty = markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'same-generated-source', { sourceRevision: shortHead });
    const equivalentSnapshot = readRepositoryProjectionSnapshot(fx.controllerHome, fx.repository.repoId);
    const equivalentObservation = projectionObservation(equivalentSnapshot);
    expect(equivalentSnapshot.sourceRevisionChanged).toBe(false);
    expect(equivalentObservation.refreshPending).toBe(false);
    expect(projectionHealth(equivalentSnapshot).activeBlockers.map((item) => item.code)).not.toContain('PROJECTION_REFRESH_MISSED');
    clearRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, equivalentDirty, head);

    const oldHead = head;
    const newHead = commitFile(fx.root, 'src/index.ts', 'export const value = 3;\n', 'newer revision');
    const oldMarker = markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'old-revision', { sourceRevision: oldHead })!;
    const newMarker = markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'new-revision', { sourceRevision: newHead })!;
    expect(newMarker.nonce).not.toBe(oldMarker.nonce);
    clearRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, oldMarker, oldHead);
    expect(readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId)?.nonce).toBe(newMarker.nonce);

    const oldRunningAt = new Date(Date.now() - 120_000).toISOString();
    persistRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, {
      ...newMarker,
      refreshStatus: 'running',
      refreshAttempt: 1,
      runningStartedAt: oldRunningAt,
      refreshUpdatedAt: oldRunningAt,
      refreshOwner: {
        pid: 999_999,
        acquiredAt: oldRunningAt,
        ownerEpoch: 'old-rollout',
      },
    });
    const recovered = refreshRepositoryProjectionForRepository(fx.controllerHome, fx.repository, {
      sourceRevision: newHead,
      reason: 'stale-owner-retry',
      owner: { ownerEpoch: 'new-rollout' },
    });
    expect(recovered.refreshed).toBe(true);
    expect(readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId)).toBeUndefined();
    expect(gitRevisionsEquivalent(recovered.projection?.metadata?.generatedFromRevision, newHead)).toBe(true);

    const concurrent = [
      markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'concurrent', { sourceRevision: newHead }),
      markRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId, 'concurrent', { sourceRevision: git(fx.root, ['rev-parse', '--short=10', 'HEAD']) }),
    ];
    expect(concurrent[0]?.nonce).toBe(concurrent[1]?.nonce);
  });

  test('legacy dirty markers remain readable refresh requests', () => {
    const fx = fixture();
    writeJsonAtomic(repositoryProjectionDirtyPath(fx.controllerHome, fx.repository.repoId), {
      schemaVersion: 1,
      repoId: fx.repository.repoId,
      reason: 'legacy-marker',
      markedAt: new Date().toISOString(),
      nonce: 'legacy-nonce',
    });

    const marker = readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId);
    expect(marker?.refreshStatus).toBe('pending');
    expect(marker?.nonce).toBe('legacy-nonce');
    const refreshed = refreshRepositoryProjectionForRepository(fx.controllerHome, fx.repository, {
      reason: 'legacy-refresh',
      force: true,
    });
    expect(refreshed.refreshed).toBe(true);
    expect(readRepositoryProjectionDirty(fx.controllerHome, fx.repository.repoId)).toBeUndefined();
  });
});
