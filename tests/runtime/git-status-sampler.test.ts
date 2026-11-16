import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RepositoryRecord } from '../../src/core/repository/types';
import { readRepositoryGitStatusSample, sampleRepositoryGitStatusForRepositories, writeRepositoryGitStatusSample } from '../../src/runtime/projections/git-status-sampler';
import { repositoryGitStatus } from '../../src/runtime/repositories/structured-git';

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
  test('samples only the active checkout with one scan and preserves live Git identity', async () => {
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

    const tracePath = join(controllerHome, 'git-trace.log');
    const previousTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = tracePath;
    try {
      expect(await sampleRepositoryGitStatusForRepositories(controllerHome, [repository])).toEqual({
        sampled: 1,
        failed: [],
      });
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = previousTrace;
    }
    const commands = readFileSync(tracePath, 'utf8').split('\n').filter((line) => line.includes('built-in: git '));
    expect(commands.filter((line) => line.includes('git status '))).toHaveLength(1);
    expect(commands).toHaveLength(2);
    const unborn = readRepositoryGitStatusSample(controllerHome, repository.repoId, repository.activeCheckoutId)!;
    expect(unborn.head).toBeNull();
    expect(unborn.branch).toBe(execFileSync('git', ['branch', '--show-current'], { cwd: activeRoot, encoding: 'utf8' }).trim());

    const git = (...args: string[]) => execFileSync('git', args, { cwd: activeRoot, encoding: 'utf8' }).trim();
    git('config', 'user.name', 'sampler-test');
    git('config', 'user.email', 'sampler@example.invalid');
    writeFileSync(join(activeRoot, 'tracked.txt'), 'initial\n');
    git('add', 'tracked.txt');
    git('commit', '-m', 'fixture');
    git('branch', '-M', 'main');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('config', 'remote.origin.url', activeRoot);
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    git('branch', '--set-upstream-to=origin/main');
    writeFileSync(join(activeRoot, 'tracked.txt'), 'changed\n');
    writeFileSync(join(activeRoot, 'untracked file.txt'), 'new\n');
    const compareLive = async () => {
      const live = repositoryGitStatus(repository);
      const sampled = await writeRepositoryGitStatusSample(controllerHome, repository);
      for (const key of ['branch', 'head', 'upstream', 'porcelain', 'shortStatus', 'staged', 'unstaged', 'untracked', 'clean'] as const) {
        expect(sampled[key]).toEqual(live[key]);
      }
      return sampled;
    };
    expect((await compareLive()).upstream).toBe('origin/main');
    git('mv', 'tracked.txt', 'renamed file.txt');
    await compareLive();
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect((await compareLive()).upstream).toBe('origin/main');
    git('checkout', '--detach');
    expect((await compareLive()).branch).toBeNull();
  });
});
