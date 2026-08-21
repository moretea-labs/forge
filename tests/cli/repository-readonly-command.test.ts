import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeRepositoryReadOnlyCommandDirect } from '../../src/cli/repositories/command-executor';
import type { RepositoryRecord } from '../../src/cli/repositories/types';

describe('repository readonly command fast path', () => {
  test('remains available when the worktree exceeds the write-path dirty fingerprint cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-readonly-command-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'readonly@example.test'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Readonly Test'], { cwd: root });
      writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      for (let index = 0; index < 205; index += 1) writeFileSync(join(root, `dirty-${index}.txt`), `${index}\n`);

      const now = new Date().toISOString();
      const repository: RepositoryRecord = {
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

      const result = await executeRepositoryReadOnlyCommandDirect(repository, {
        command: ['git', 'status', '--short'],
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      expect(result.classification.risk).toBe('readonly');
      expect(result.before.paths.length).toBe(205);
      expect(Object.keys(result.before.pathFingerprints)).toHaveLength(0);
      expect(result.repositoryChanged).toBe(false);
      expect(result.changedPaths).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
