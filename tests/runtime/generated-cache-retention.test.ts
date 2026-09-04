import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupGeneratedRepositoryCaches } from '../../src/runtime/control-plane/generated-cache-retention';

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-generated-cache-retention-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  return root;
}

function age(path: string): void {
  const old = new Date('2026-08-24T00:00:00.000Z');
  utimesSync(path, old, old);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('generated repository cache retention', () => {
  test('removes stale caches and browser artifacts only from Forge-owned namespaces while preserving recent and tracked content', () => {
    const root = repository();
    const stale = join(root, '.repo-harness', 'old-run', 'DerivedData');
    const active = join(root, '.ai', 'harness', 'deriveddata-active');
    const tracked = join(root, '.forge', 'ios', 'DerivedData', 'tracked-build');
    const staleUpload = join(root, '.forge', 'browser', 'uploads', 'stale.zip');
    const staleScreenshot = join(root, '.forge', 'browser', 'screenshots', 'stale.png');
    const recentScreenshot = join(root, '.forge', 'browser', 'screenshots', 'recent.png');
    const trackedScreenshot = join(root, '.forge', 'browser', 'screenshots', 'tracked.png');
    const resultBundle = join(root, '.repo-harness', 'old-run', 'result.xcresult');
    mkdirSync(stale, { recursive: true });
    mkdirSync(active, { recursive: true });
    mkdirSync(tracked, { recursive: true });
    mkdirSync(resultBundle, { recursive: true });
    writeFileSync(join(stale, 'cache.bin'), 'cache');
    writeFileSync(join(active, 'cache.bin'), 'cache');
    writeFileSync(join(tracked, 'keep.txt'), 'tracked');
    writeFileSync(join(resultBundle, 'Info.plist'), 'evidence');
    mkdirSync(join(root, '.forge', 'browser', 'uploads'), { recursive: true });
    mkdirSync(join(root, '.forge', 'browser', 'screenshots'), { recursive: true });
    writeFileSync(staleUpload, 'upload');
    writeFileSync(staleScreenshot, 'screenshot');
    writeFileSync(recentScreenshot, 'recent screenshot');
    writeFileSync(trackedScreenshot, 'tracked screenshot');
    execFileSync('git', ['-C', root, 'add', '.forge/ios/DerivedData/tracked-build/keep.txt']);
    execFileSync('git', ['-C', root, 'add', '.forge/browser/screenshots/tracked.png']);
    age(stale);
    age(active);
    age(tracked);
    age(staleUpload);
    age(staleScreenshot);
    age(trackedScreenshot);

    const report = cleanupGeneratedRepositoryCaches(root, {
      nowMs: Date.parse('2026-08-25T12:00:00.000Z'),
      graceMs: 60_000,
      processCommands: [`xcodebuild -derivedDataPath ${active}`],
      maxRemovals: 10,
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(staleUpload)).toBe(false);
    expect(existsSync(staleScreenshot)).toBe(false);
    expect(existsSync(recentScreenshot)).toBe(true);
    expect(existsSync(trackedScreenshot)).toBe(true);
    expect(existsSync(resultBundle)).toBe(true);
    expect(report.removedPaths).toContain('.repo-harness/old-run/DerivedData');
    expect(report.removedPaths).toContain('.forge/browser/uploads/stale.zip');
    expect(report.removedPaths).toContain('.forge/browser/screenshots/stale.png');
    expect(report.skippedByReason.active_process ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.skippedByReason.tracked_content ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('scans bounded browser artifact roots before high-cardinality cache trees', () => {
    const root = repository();
    const upload = join(root, '.forge', 'browser', 'uploads', 'stale.zip');
    mkdirSync(join(root, '.forge', 'browser', 'uploads'), { recursive: true });
    writeFileSync(upload, 'upload');
    age(upload);
    mkdirSync(join(root, '.repo-harness', 'many', 'DerivedData'), { recursive: true });

    const report = cleanupGeneratedRepositoryCaches(root, {
      nowMs: Date.parse('2026-08-25T12:00:00.000Z'),
      graceMs: 60_000,
      maxEntries: 1,
      maxRemovals: 1,
    });

    expect(existsSync(upload)).toBe(false);
    expect(report.removedPaths).toEqual(['.forge/browser/uploads/stale.zip']);
    expect(report.budgetExhausted).toBe(true);
  });
});
