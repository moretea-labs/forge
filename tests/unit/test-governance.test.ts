import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseTestGovernanceArgs } from '../../scripts/test-governance';
import {
  collectChangedPaths,
  existingChangedFiles,
  loadTestManifest,
  selectTests,
  testContentDigest,
  trackedTreeDigest,
  validateTestManifest,
} from '../../scripts/testing/test-governance';

const ROOT = join(import.meta.dir, '../..');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('test governance', () => {
  test('declares every test exactly once with a v1 module and resource', () => {
    const manifest = loadTestManifest(ROOT);
    expect(validateTestManifest(ROOT, manifest)).toEqual([]);
    expect(Object.keys(manifest.tests).length).toBeGreaterThan(0);
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

  test('maps repository implementation paths to repository regressions', () => {
    const manifest = loadTestManifest(ROOT);
    const selection = selectTests(manifest, 'affected', ['src/runtime/repositories/repository-snapshot.ts']);
    expect(selection.modules).toEqual(['repository']);
    expect(selection.files).toContain('tests/cli/repository-command-scope.test.ts');
  });

  test('parses explicit files without mistaking option values for focus', () => {
    expect(parseTestGovernanceArgs(['affected', '--base', 'origin/main', 'tests/access-policy.test.ts'])).toMatchObject(
      {
        gate: 'affected',
        baseRef: 'origin/main',
        explicitTests: ['tests/access-policy.test.ts'],
      },
    );
    expect(parseTestGovernanceArgs(['full', '--no-cache'])).toMatchObject({ gate: 'full', useCache: false });
  });

  test('records auditable provenance for every reused test checkpoint', () => {
    const source = readFileSync(join(ROOT, 'scripts/testing/test-governance.ts'), 'utf8');
    expect(source).toContain('cacheProvenance');
    expect(source).toContain('checkpointKey: cachedCheckpoint.key');
    expect(source).toContain('completedAt: cachedCheckpoint.completedAt');
    expect(source).toContain('evidence=${checkpointRelativePath}');
  });

  test('collects staged, unstaged, untracked, and merge-base changes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-selector-'));
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
        'base.ts',
        'committed.ts',
        'staged.ts',
        'untracked.ts',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('uses all commits and fails closed for invalid or shallow Git baselines', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-multicommit-'));
    const shallow = mkdtempSync(join(tmpdir(), 'forge-shallow-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'tests@example.com');
      git(repo, 'config', 'user.name', 'Tests');
      writeFileSync(join(repo, 'initial.ts'), 'initial\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'initial');
      const base = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'first.ts'), 'first\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'first');
      writeFileSync(join(repo, 'second.ts'), 'second\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'second');
      expect(collectChangedPaths(repo, { baseRef: base })).toEqual(['first.ts', 'second.ts']);
      expect(collectChangedPaths(repo, { baseRef: '0'.repeat(40) })).toEqual(['first.ts', 'initial.ts', 'second.ts']);
      expect(() => collectChangedPaths(repo, { baseRef: 'does-not-exist' })).toThrow(
        /Cannot determine complete Git change baseline/,
      );
      git(shallow, 'clone', '--quiet', '--depth', '1', `file://${repo}`, '.');
      expect(() => collectChangedPaths(shallow, { baseRef: base })).toThrow(
        /Cannot determine complete Git change baseline/,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  test('keeps deleted and renamed-away paths for regressions but not formatter inputs', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-source-delete-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'tests@example.com');
      git(repo, 'config', 'user.name', 'Tests');
      for (const file of ['removed.ts', 'old.ts', 'restored.ts']) writeFileSync(join(repo, file), 'original\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'base');
      const base = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'rm', '-q', 'removed.ts');
      git(repo, 'mv', 'old.ts', 'new.ts');
      git(repo, 'rm', '-q', 'restored.ts');
      writeFileSync(join(repo, 'restored.ts'), 'recreated\n');
      const changed = collectChangedPaths(repo, { baseRef: base });
      expect(changed).toEqual(['new.ts', 'old.ts', 'removed.ts', 'restored.ts']);
      expect(existingChangedFiles(repo, changed)).toEqual(['new.ts', 'restored.ts']);
      expect(collectChangedPaths(repo, { baseRef: base })).toContain('removed.ts');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('content evidence ignores commit identity while tracked-tree evidence sees mutations', () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-content-digest-'));
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
