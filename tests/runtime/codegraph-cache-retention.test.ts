import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { codegraphRepositoryCacheRoot, codegraphCacheRoot } from '../../src/runtime/context/codegraph-cache-boundary';
import { cleanupCodegraphCaches } from '../../src/runtime/control-plane/codegraph-cache-retention';

const roots: string[] = [];
function root(prefix: string): string { const value = mkdtempSync(join(tmpdir(), prefix)); roots.push(value); return value; }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function age(path: string, at = '2026-08-01T00:00:00.000Z'): void { const old = new Date(at); utimesSync(path, old, old); }

describe('CodeGraph cache retention', () => {
  test('protects only a live-locator cache and removes stale inactive rebuildable cache', () => {
    const home = root('forge-codegraph-retention-home-');
    const activeRepo = root('forge-codegraph-retention-active-');
    const retiredRepo = root('forge-codegraph-retention-retired-');
    const freshRepo = root('forge-codegraph-retention-fresh-');
    const active = codegraphRepositoryCacheRoot(home, activeRepo);
    const retired = codegraphRepositoryCacheRoot(home, retiredRepo);
    const fresh = codegraphRepositoryCacheRoot(home, freshRepo);
    for (const path of [active, retired, fresh]) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'index.bin'), 'cache'); }
    age(active); age(retired);

    const report = cleanupCodegraphCaches(home, {
      nowMs: Date.parse('2026-09-05T00:00:00.000Z'), retentionMs: 60_000,
      protectedRepositoryRoots: [activeRepo], maxEntries: 10, maxRemovals: 10,
    });

    expect(existsSync(active)).toBe(true);
    expect(existsSync(retired)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(report.protected).toBe(1);
    expect(report.skippedByReason.active_locator).toBe(1);
    expect(report.removedPaths).toHaveLength(1);
    expect(report.reclaimedBytes).toBeGreaterThan(0);
    expect(report.policyVersion).toBe('codegraph-cache-retention-v2');
  });

  test('evicts oldest inactive cache under total-byte pressure even inside age grace', () => {
    const home = root('forge-codegraph-retention-total-');
    const olderRepo = root('forge-codegraph-retention-older-');
    const newerRepo = root('forge-codegraph-retention-newer-');
    const older = codegraphRepositoryCacheRoot(home, olderRepo);
    const newer = codegraphRepositoryCacheRoot(home, newerRepo);
    for (const path of [older, newer]) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'index.bin'), '0123456789'); }
    age(older, '2026-09-04T00:00:00.000Z');
    age(newer, '2026-09-04T12:00:00.000Z');

    const report = cleanupCodegraphCaches(home, {
      nowMs: Date.parse('2026-09-05T00:00:00.000Z'), retentionMs: 7 * 24 * 60 * 60_000,
      maxTotalBytes: 15, maxRepositoryBytes: 100, maxEntries: 10, maxRemovals: 10,
    });

    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(report.removedPaths).toHaveLength(1);
    expect(report.observedBytes).toBeGreaterThan(15);
  });

  test('reports active over-capacity cache as a blocker instead of deleting it', () => {
    const home = root('forge-codegraph-retention-active-cap-');
    const activeRepo = root('forge-codegraph-retention-active-cap-repo-');
    const active = codegraphRepositoryCacheRoot(home, activeRepo);
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, 'index.bin'), '0123456789');

    const report = cleanupCodegraphCaches(home, {
      nowMs: Date.parse('2026-09-05T00:00:00.000Z'), maxRepositoryBytes: 1, maxTotalBytes: 1,
      protectedRepositoryRoots: [activeRepo], maxEntries: 10, maxRemovals: 10,
    });

    expect(existsSync(active)).toBe(true);
    expect(report.protectedOverCapacity).toBe(1);
    expect(report.skippedByReason.active_cache_over_capacity).toBe(1);
  });

  test('honors a zero shared removal budget without deleting an eligible cache', () => {
    const home = root('forge-codegraph-retention-zero-budget-');
    const repo = root('forge-codegraph-retention-zero-budget-repo-');
    const cache = codegraphRepositoryCacheRoot(home, repo);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'index.bin'), 'cache');
    age(cache);

    const report = cleanupCodegraphCaches(home, {
      nowMs: Date.parse('2026-09-05T00:00:00.000Z'), retentionMs: 60_000,
      maxEntries: 10, maxRemovals: 0,
    });

    expect(existsSync(cache)).toBe(true);
    expect(report.eligible).toBe(1);
    expect(report.attempted).toBe(0);
    expect(report.budgetExhausted).toBe(true);
    expect(report.skippedByReason.cleanup_budget_exhausted).toBe(1);
  });

  test('scans oldest entries first and fails closed for non-owned symlink entries', () => {
    const home = root('forge-codegraph-retention-budget-');
    const repoOld = root('forge-codegraph-retention-old-');
    const repoNew = root('forge-codegraph-retention-new-');
    const oldCache = codegraphRepositoryCacheRoot(home, repoOld);
    const newCache = codegraphRepositoryCacheRoot(home, repoNew);
    mkdirSync(oldCache, { recursive: true }); mkdirSync(newCache, { recursive: true });
    writeFileSync(join(oldCache, 'index.bin'), 'old'); writeFileSync(join(newCache, 'index.bin'), 'new');
    age(oldCache);
    const external = root('forge-codegraph-retention-external-');
    mkdirSync(codegraphCacheRoot(home), { recursive: true });
    symlinkSync(external, join(codegraphCacheRoot(home), 'aaaaaaaaaaaaaaaaaaaaaaaa'));

    const report = cleanupCodegraphCaches(home, {
      nowMs: Date.parse('2026-09-05T00:00:00.000Z'), retentionMs: 60_000,
      maxEntries: 1, maxRemovals: 1,
    });

    expect(existsSync(oldCache)).toBe(false);
    expect(existsSync(newCache)).toBe(true);
    expect(existsSync(external)).toBe(true);
    expect(report.truncated).toBe(true);
    expect(report.skippedByReason.ownership_unproven).toBe(1);
  });
});
