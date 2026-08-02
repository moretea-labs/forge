import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  controllerContextProjectionKey,
  controllerContextProjectionNeedsRefresh,
  queueControllerContextProjectionRefresh,
  readControllerContextProjection,
  writeControllerContextProjection,
  type ControllerContextProjectionSourceIdentity,
} from '../../src/runtime/projections/controller-context';

function source(overrides: Partial<ControllerContextProjectionSourceIdentity> = {}): ControllerContextProjectionSourceIdentity {
  return {
    repoId: 'repo-round2',
    checkoutId: 'checkout-main',
    head: 'abc123456789',
    workingTreeFingerprint: 'tree-a',
    runtimeGeneration: 'runtime-a',
    sourceRevision: '7',
    variant: 'summary',
    toolset: 'advanced',
    profile: 'controller',
    ...overrides,
  };
}

async function withHome(fn: (controllerHome: string) => Promise<void>): Promise<void> {
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-context-round2-'));
  try {
    await fn(controllerHome);
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
}

describe('controller context projection round two', () => {
  test('isolates summary/detail and repository/checkout keys', async () => {
    await withHome(async (controllerHome) => {
      const summary = source();
      const detail = source({ variant: 'detail' });
      const otherCheckout = source({ checkoutId: 'checkout-feature' });
      const otherRepo = source({ repoId: 'repo-other' });

      writeControllerContextProjection(controllerHome, summary.repoId, { kind: 'summary' }, {
        sourceIdentity: summary,
        variant: 'summary',
      });

      expect(readControllerContextProjection(controllerHome, summary.repoId, { sourceIdentity: summary })?.payload.kind).toBe('summary');
      expect(readControllerContextProjection(controllerHome, summary.repoId, { sourceIdentity: detail })).toBeUndefined();
      expect(readControllerContextProjection(controllerHome, summary.repoId, { sourceIdentity: otherCheckout })).toBeUndefined();
      expect(readControllerContextProjection(controllerHome, otherRepo.repoId, { sourceIdentity: otherRepo })).toBeUndefined();
      expect(controllerContextProjectionKey(summary)).not.toBe(controllerContextProjectionKey(detail));
      expect(controllerContextProjectionKey(summary)).not.toBe(controllerContextProjectionKey(otherCheckout));
    });
  });

  test('uses one single-flight refresh and exposes failure backoff', async () => {
    await withHome(async (controllerHome) => {
      const identity = source({ head: 'cold-head' });
      let builds = 0;
      const request = {
        variant: 'summary' as const,
        sourceIdentity: identity,
        build: async () => {
          builds += 1;
          await Bun.sleep(5);
          return { builds };
        },
      };

      const first = queueControllerContextProjectionRefresh(controllerHome, identity.repoId, request);
      const second = queueControllerContextProjectionRefresh(controllerHome, identity.repoId, request);
      expect(first.queued).toBe(true);
      expect(second.queued).toBe(false);
      expect(second.skippedReason).toBe('single_flight');
      await Bun.sleep(30);
      expect(builds).toBe(1);
      expect(readControllerContextProjection(controllerHome, identity.repoId, { sourceIdentity: identity })?.payload.builds).toBe(1);

      const failedIdentity = source({ head: 'failed-head' });
      queueControllerContextProjectionRefresh(controllerHome, failedIdentity.repoId, {
        variant: 'summary',
        sourceIdentity: failedIdentity,
        build: () => { throw new Error('fixture refresh failed'); },
      });
      await Bun.sleep(20);
      const failed = readControllerContextProjection(controllerHome, failedIdentity.repoId, { sourceIdentity: failedIdentity });
      expect(failed?.refreshState).toBe('failed');
      expect(failed?.lastRefreshError?.message).toBe('fixture refresh failed');
      expect(failed?.nextAttemptAt).toBeTruthy();
      const deferred = queueControllerContextProjectionRefresh(controllerHome, failedIdentity.repoId, {
        variant: 'summary',
        sourceIdentity: failedIdentity,
        build: () => ({ recovered: true }),
      });
      expect(deferred.queued).toBe(false);
      expect(deferred.skippedReason).toBe('retry_deferred');
    });
  });

  test('drops superseded generations and recovers stale owners after restart', async () => {
    await withHome(async (controllerHome) => {
      const oldIdentity = source({ head: 'old-head' });
      const newIdentity = source({ head: 'new-head', sourceRevision: '8' });
      let releaseOld!: () => void;
      const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
      queueControllerContextProjectionRefresh(controllerHome, oldIdentity.repoId, {
        variant: 'summary',
        sourceIdentity: oldIdentity,
        build: async () => {
          await oldGate;
          return { generation: 'old' };
        },
      });
      queueControllerContextProjectionRefresh(controllerHome, newIdentity.repoId, {
        variant: 'summary',
        sourceIdentity: newIdentity,
        build: () => ({ generation: 'new' }),
      });
      releaseOld();
      await Bun.sleep(30);
      expect(readControllerContextProjection(controllerHome, newIdentity.repoId, { sourceIdentity: newIdentity })?.payload.generation).toBe('new');
      expect(readControllerContextProjection(controllerHome, oldIdentity.repoId, { sourceIdentity: oldIdentity })?.payload.generation).toBeUndefined();

      const staleIdentity = source({ head: 'stale-head' });
      writeControllerContextProjection(controllerHome, staleIdentity.repoId, { retained: true }, {
        sourceIdentity: staleIdentity,
        variant: 'summary',
        refreshState: 'refreshing',
        refreshOwner: { pid: 999_999, acquiredAt: new Date().toISOString() },
      });
      const recovered = readControllerContextProjection(controllerHome, staleIdentity.repoId, { sourceIdentity: staleIdentity });
      expect(recovered?.payload.retained).toBe(true);
      expect(recovered?.refreshState).toBe('pending');
      expect(recovered?.refreshOwner).toBeUndefined();
      expect(controllerContextProjectionNeedsRefresh(recovered, staleIdentity.sourceRevision, staleIdentity)).toBe(true);
    });
  });
});
