import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
import { sampleRepositoryGitStatusForRepositories } from '../../src/runtime/projections/git-status-sampler';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('git status sampler', () => {
  test('samples only the repository active checkout', () => {
    const controllerHome = tempRoot('forge-git-sampler-home-');
    const activeRoot = tempRoot('forge-git-sampler-active-');
    const staleRoot = join(tempRoot('forge-git-sampler-missing-'), 'removed-worktree');
    execFileSync('git', ['init', activeRoot], { stdio: 'ignore' });
    const now = new Date().toISOString();
    const repository: RepositoryRecord = {
      schemaVersion: 1,
      repoId: 'repo-sampler',
      displayName: 'sampler',
      localRoot: activeRoot,
      canonicalRoot: activeRoot,
      activeCheckoutId: 'checkout-active',
      checkouts: [
        {
          checkoutId: 'checkout-active',
          localRoot: activeRoot,
          canonicalRoot: activeRoot,
          worktree: false,
          branch: 'main',
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          lifecycle: 'active',
        },
        {
          checkoutId: 'checkout-stale',
          localRoot: staleRoot,
          canonicalRoot: staleRoot,
          worktree: true,
          branch: 'historical',
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          lifecycle: 'active',
        },
      ],
      repositoryType: 'local-git',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      configurationPath: join(activeRoot, '.ai/harness/config.yaml'),
      stateStorageStrategy: 'controller-home',
    };

    expect(sampleRepositoryGitStatusForRepositories(controllerHome, [repository])).toEqual({
      sampled: 1,
      failed: [],
    });
  });
});
