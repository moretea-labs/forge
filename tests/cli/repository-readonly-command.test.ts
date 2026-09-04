import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeRepositoryReadOnlyCommandDirect } from '../../src/cli/repositories/command-executor';
import type { RepositoryRecord } from '../../src/cli/repositories/types';

function repositoryRecord(root: string): RepositoryRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    repoId: 'repo-readonly-test',
    displayName: 'readonly-test',
    localRoot: root,
    canonicalRoot: root,
    activeCheckoutId: 'checkout-readonly-test',
    checkouts: [{
      checkoutId: 'checkout-readonly-test',
      localRoot: root,
      canonicalRoot: root,
      worktree: false,
      branch: 'main',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }],
    defaultBranch: 'main',
    repositoryType: 'git',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    configurationPath: join(root, '.forge', 'repository.json'),
    stateStorageStrategy: 'controller-home',
  };
}

function initializeRepository(root: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'readonly@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Readonly Test'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
}

describe('repository readonly command fast path', () => {
  test('remains available when the worktree exceeds the write-path dirty fingerprint cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-readonly-command-'));
    try {
      initializeRepository(root);
      for (let index = 0; index < 205; index += 1) writeFileSync(join(root, `dirty-${index}.txt`), `${index}\n`);

      const result = await executeRepositoryReadOnlyCommandDirect(repositoryRecord(root), {
        command: ['git', 'status', '--short'],
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      expect(result.classification.risk).toBe('readonly');
      expect(result.before.mutationEvidence).toBe('readonly_unobserved');
      expect(result.before.paths).toEqual([]);
      expect(result.repositoryChanged).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not require Git mutation observation before a proven-readonly command', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'forge-readonly-no-snapshot-'));
    const emptyPath = join(root, 'empty-path');
    const originalPath = process.env.PATH;
    try {
      initializeRepository(root);
      mkdirSync(emptyPath);
      const pwdExecutable = execFileSync('which', ['pwd'], { encoding: 'utf8' }).trim();
      process.env.PATH = emptyPath;

      const result = await executeRepositoryReadOnlyCommandDirect(repositoryRecord(root), {
        command: [pwdExecutable],
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      expect(result.stdout?.trim()).toBe(root);
      expect(result.classification.risk).toBe('readonly');
      expect(result.before.mutationEvidence).toBe('readonly_unobserved');
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
