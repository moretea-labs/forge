import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupPersistedCheckResults } from '../../src/runtime/execution/process-runtime/check-result-retention';
import { allocatePersistedCheckResultReceiptPath, writePersistedCheckResultReceipt } from '../../src/runtime/execution/process-runtime/check-result';
import { writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';

const homes: string[] = [];
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
function home() { const value = mkdtempSync(join(tmpdir(), 'forge-check-result-retention-')); homes.push(value); return value; }
function receipt(controllerHome: string, repoId: string, id: string, cacheKey: string, executedAt: string) {
  const path = allocatePersistedCheckResultReceiptPath(controllerHome, repoId, id);
  writePersistedCheckResultReceipt(path, { checkId: id, cacheKey, ok: true, status: 0, timedOut: false, executedAt });
  return path;
}

describe('persisted Process check-result retention', () => {
  test('reclaims stale unreferenced sidecars while protecting active Work cache identity and fresh results', () => {
    const controllerHome = home();
    const repoId = 'repo-check-results';
    const old = '2026-01-01T00:00:00.000Z';
    const freshAt = '2026-09-05T00:59:30.000Z';
    const protectedPath = receipt(controllerHome, repoId, 'protected', 'cache-protected', old);
    const stalePath = receipt(controllerHome, repoId, 'stale', 'cache-stale', old);
    const freshPath = receipt(controllerHome, repoId, 'fresh', 'cache-fresh', freshAt);
    writeControlPlaneRecord(controllerHome, {
      namespace: 'work_contract', scope: repoId, key: 'WORK-ACTIVE', schemaVersion: 2,
      value: {
        workId: 'WORK-ACTIVE', repoId, status: 'running', checkRefs: [{ receipt: { checkCacheKey: 'cache-protected' } }],
      },
    });

    const report = cleanupPersistedCheckResults(controllerHome, repoId, {
      nowMs: Date.parse('2026-09-05T01:00:00.000Z'), ttlMs: 60_000, maxRetained: 100, maxRemovals: 10,
    });
    expect(report.removed).toBe(1);
    expect(report.attempted).toBe(1);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(protectedPath)).toBe(true);
    expect(existsSync(freshPath)).toBe(true);
  });

  test('bounds sidecar scanning and reports incomplete capacity observation', () => {
    const controllerHome = home();
    const repoId = 'repo-check-results-scan';
    for (let index = 0; index < 3; index += 1) receipt(controllerHome, repoId, `stale-${index}`, `cache-${index}`, '2026-01-01T00:00:00.000Z');
    const report = cleanupPersistedCheckResults(controllerHome, repoId, {
      nowMs: Date.parse('2026-09-05T01:00:00.000Z'), ttlMs: 60_000, maxRetained: 100, maxRemovals: 10, maxScan: 1,
    });
    expect(report.inspected).toBe(1);
    expect(report.scanTruncated).toBe(true);
    expect(report.removed).toBeLessThanOrEqual(1);
  });

  test('honors zero removal budget without deleting eligible evidence', () => {
    const controllerHome = home();
    const repoId = 'repo-check-results-zero';
    const stalePath = receipt(controllerHome, repoId, 'stale-zero', 'cache-stale-zero', '2026-01-01T00:00:00.000Z');
    const report = cleanupPersistedCheckResults(controllerHome, repoId, {
      nowMs: Date.parse('2026-09-05T01:00:00.000Z'), ttlMs: 60_000, maxRetained: 100, maxRemovals: 0,
    });
    expect(report.eligible).toBe(1);
    expect(report.attempted).toBe(0);
    expect(report.budgetExhausted).toBe(true);
    expect(existsSync(stalePath)).toBe(true);
  });
});
