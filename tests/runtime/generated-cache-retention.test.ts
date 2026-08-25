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
  test('removes stale DerivedData only from Forge-owned namespaces while preserving evidence and tracked content', () => {
    const root = repository();
    const stale = join(root, '.repo-harness', 'old-run', 'DerivedData');
    const active = join(root, '.ai', 'harness', 'deriveddata-active');
    const tracked = join(root, '.forge', 'ios', 'DerivedData', 'tracked-build');
    const resultBundle = join(root, '.repo-harness', 'old-run', 'result.xcresult');
    mkdirSync(stale, { recursive: true });
    mkdirSync(active, { recursive: true });
    mkdirSync(tracked, { recursive: true });
    mkdirSync(resultBundle, { recursive: true });
    writeFileSync(join(stale, 'cache.bin'), 'cache');
    writeFileSync(join(active, 'cache.bin'), 'cache');
    writeFileSync(join(tracked, 'keep.txt'), 'tracked');
    writeFileSync(join(resultBundle, 'Info.plist'), 'evidence');
    execFileSync('git', ['-C', root, 'add', '.forge/ios/DerivedData/tracked-build/keep.txt']);
    age(stale);
    age(active);
    age(tracked);

    const report = cleanupGeneratedRepositoryCaches(root, {
      nowMs: Date.parse('2026-08-25T12:00:00.000Z'),
      graceMs: 60_000,
      processCommands: [`xcodebuild -derivedDataPath ${active}`],
      maxRemovals: 10,
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(resultBundle)).toBe(true);
    expect(report.removedPaths).toContain('.repo-harness/old-run/DerivedData');
    expect(report.skippedByReason.active_process).toBe(1);
    expect(report.skippedByReason.tracked_content).toBe(1);
  });
});
