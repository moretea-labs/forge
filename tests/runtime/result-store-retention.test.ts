import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cleanupControllerResultStore,
  readControllerResult,
  writeControllerResult,
} from '../../src/runtime/evidence/result-store';

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-result-retention-'));
  homes.push(value);
  return value;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe('controller result store retention', () => {
  test('reclaims expired result payload, record, and locator while retaining recent results', () => {
    const controllerHome = home();
    const old = writeControllerResult({
      controllerHome,
      repoId: 'repo-a',
      sessionId: 'session-a',
      principalId: 'principal-a',
      kind: 'inspection',
      value: { payload: 'old' },
    });
    const fresh = writeControllerResult({
      controllerHome,
      repoId: 'repo-a',
      sessionId: 'session-a',
      principalId: 'principal-a',
      kind: 'inspection',
      value: { payload: 'fresh' },
    });
    const root = join(controllerHome, 'system', 'outputs', 'results');
    const oldRecord = join(root, 'records', `${old.resultId}.json`);
    const oldData = join(root, 'data', `${old.resultId}.json`);
    const freshRecord = join(root, 'records', `${fresh.resultId}.json`);

    const base = Date.now();
    const first = cleanupControllerResultStore(controllerHome, {
      nowMs: base + 6 * 24 * 60 * 60_000,
      ttlMs: 7 * 24 * 60 * 60_000,
      maxRemovals: 10,
    });
    expect(first.removed).toBe(0);
    expect(existsSync(oldRecord)).toBe(true);

    const second = cleanupControllerResultStore(controllerHome, {
      nowMs: base + 8 * 24 * 60 * 60_000,
      ttlMs: 7 * 24 * 60 * 60_000,
      maxRemovals: 1,
    });
    expect(second.eligible).toBe(2);
    expect(second.removed).toBe(1);
    expect(second.budgetExhausted).toBe(true);
    expect(existsSync(oldRecord) || existsSync(freshRecord)).toBe(true);

    const removedId = second.removedResultIds[0]!;
    const kept = removedId === old.resultId ? fresh : old;
    const keptPayload = removedId === old.resultId ? 'fresh' : 'old';
    expect(existsSync(join(root, 'records', `${removedId}.json`))).toBe(false);
    expect(existsSync(join(root, 'data', `${removedId}.json`))).toBe(false);
    expect(() =>
      readControllerResult({
        controllerHome,
        resultRef: `result://${removedId}`,
        sessionId: 'session-a',
        principalId: 'principal-a',
      }),
    ).toThrow('RESULT_LOCATOR_NOT_FOUND');
    expect(
      readControllerResult({
        controllerHome,
        resultRef: kept.resultRef,
        sessionId: 'session-a',
        principalId: 'principal-a',
      }).items,
    ).toContain(keptPayload);
  });

  test('zero removal budget reports eligibility without deleting', () => {
    const controllerHome = home();
    const result = writeControllerResult({
      controllerHome,
      sessionId: 'session-b',
      principalId: 'principal-b',
      kind: 'generic',
      value: 'retain-me',
    });
    const report = cleanupControllerResultStore(controllerHome, {
      nowMs: Date.now() + 8 * 24 * 60 * 60_000,
      ttlMs: 7 * 24 * 60 * 60_000,
      maxRemovals: 0,
    });
    expect(report.eligible).toBe(1);
    expect(report.removed).toBe(0);
    expect(report.budgetExhausted).toBe(true);
    expect(existsSync(join(controllerHome, 'system', 'outputs', 'results', 'records', `${result.resultId}.json`))).toBe(
      true,
    );
  });
});
