import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseTestGovernanceArgs } from '../../scripts/test-governance';
import {
  collectChangedPaths,
  loadTestManifest,
  selectTests,
  testContentDigest,
  trackedTreeDigest,
  validateTestManifest,
} from '../../src/testing/test-governance';

const ROOT = join(import.meta.dir, '../..');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('test governance', () => {
  test('declares every test exactly once with a v1 module and resource', () => {
    const manifest = loadTestManifest(ROOT);
    expect(validateTestManifest(ROOT, manifest)).toEqual([]);
    expect(Object.keys(manifest.tests).length).toBeGreaterThan(50);
    expect(Object.keys(manifest.tests).length).toBeLessThanOrEqual(manifest.policy.maxTestFiles);
  });

  test('keeps no-change affected selection on smoke tests', () => {
    const manifest = loadTestManifest(ROOT);
    const selection = selectTests(manifest, 'affected', []);
    expect(selection.reason).toContain('core smoke');
    expect(selection.files.length).toBeLessThan(20);
    expect(selection.files.every((file) => manifest.tests[file]?.smoke)).toBe(true);
  });

  test('maps unknown paths conservatively without selecting full', () => {
    const manifest = loadTestManifest(ROOT);
    const selection = selectTests(manifest, 'affected', ['unknown/new-surface.ts']);
    expect(selection.modules).toEqual(['core', 'workflow']);
    expect(selection.files.length).toBeLessThan(Object.keys(manifest.tests).length / 2);
  });

  test('parses explicit files without mistaking option values for focus', () => {
    expect(parseTestGovernanceArgs(['affected', '--base', 'origin/main', 'tests/access-policy.test.ts'])).toMatchObject({
      gate: 'affected',
      baseRef: 'origin/main',
      explicitTests: ['tests/access-policy.test.ts'],
    });
  });

  test('collects staged, unstaged, untracked, and merge-base changes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-harness-selector-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'tests@example.com');
      git(repo, 'config', 'user.name', 'Tests');
      writeFileSync(join(repo, 'base.ts'), 'base\n');
      git(repo, 'add', 'base.ts');
      git(repo, 'commit', '-qm', 'base');
      const base = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'committed.ts'), 'commit\n');
      git(repo, 'add', 'committed.ts');
      git(repo, 'commit', '-qm', 'branch');
      writeFileSync(join(repo, 'base.ts'), 'unstaged\n');
      writeFileSync(join(repo, 'staged.ts'), 'staged\n');
      git(repo, 'add', 'staged.ts');
      writeFileSync(join(repo, 'untracked.ts'), 'untracked\n');
      expect(collectChangedPaths(repo, { baseRef: base })).toEqual([
        'base.ts', 'committed.ts', 'staged.ts', 'untracked.ts',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('content evidence ignores commit identity while tracked-tree evidence sees mutations', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-harness-content-digest-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'tests@example.com');
      git(repo, 'config', 'user.name', 'Tests');
      writeFileSync(join(repo, 'source.ts'), 'same tree\n');
      git(repo, 'add', 'source.ts');
      git(repo, 'commit', '-qm', 'first identity');
      const content = testContentDigest(repo);
      git(repo, 'commit', '--allow-empty', '-qm', 'merge-like identity only');
      expect(testContentDigest(repo)).toBe(content);
      const tracked = trackedTreeDigest(repo);
      writeFileSync(join(repo, 'source.ts'), 'mutated\n');
      expect(trackedTreeDigest(repo)).not.toBe(tracked);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
