import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, test } from 'bun:test';
import { registerRepository } from '../../src/cli/repositories/registry';
import { repositoryControllerRoot } from '../../src/cli/repositories/controller-home';
import {
  managedPathInside,
  managedWorktreePath,
  managedWorktreeStorageRoot,
} from '../../src/cli/repositories/worktree-storage';
import { ensureManagedWorkspace } from '../../src/runtime/workflow/campaigns/workspace';
import type { RepositoryRecord } from '../../src/cli/repositories/types';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function record(root: string): RepositoryRecord {
  return {
    repoId: 'repo-test',
    localRoot: root,
    canonicalRoot: root,
    activeCheckoutId: 'checkout-main',
    checkouts: [{ checkoutId: 'checkout-main', localRoot: root, canonicalRoot: root, lifecycle: 'active' }],
  } as RepositoryRecord;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

describe('external managed worktree storage', () => {
  test('falls back outside a repo-local Controller Home', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'managed-worktree-root-'));
    roots.push(fixture);
    const source = join(fixture, 'source');
    const controllerHome = join(source, '_ops', 'controller-home');
    const external = join(fixture, 'external');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(external, { recursive: true });
    const repository = record(source);

    const path = managedWorktreePath(controllerHome, repository.repoId, 'campaign-one', [repository], {
      REPO_HARNESS_WORKTREE_HOME: external,
    });
    expect(managedPathInside(source, path)).toBe(false);
    expect(managedPathInside(external, path)).toBe(true);
  });

  test('uses the Controller Home when it is already disjoint', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'managed-worktree-controller-'));
    roots.push(fixture);
    const source = join(fixture, 'source');
    const controllerHome = join(fixture, 'controller-home');
    mkdirSync(source, { recursive: true });
    mkdirSync(controllerHome, { recursive: true });
    const storage = managedWorktreeStorageRoot(controllerHome, [record(source)], {});
    expect(managedPathInside(controllerHome, storage)).toBe(true);
    expect(managedPathInside(source, storage)).toBe(false);
  });

  test('fails closed when an explicit worktree home overlaps a registered checkout', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'managed-worktree-overlap-'));
    roots.push(fixture);
    const source = join(fixture, 'source');
    mkdirSync(source, { recursive: true });
    expect(() => managedWorktreeStorageRoot(join(fixture, 'controller'), [record(source)], {
      REPO_HARNESS_WORKTREE_HOME: join(source, 'managed'),
    })).toThrow(/MANAGED_WORKTREE_HOME_OVERLAPS_REPOSITORY/);
  });

  test('rejects a legacy manifest path owned by another Git repository', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'managed-worktree-foreign-'));
    roots.push(fixture);
    const source = join(fixture, 'source');
    const foreign = join(fixture, 'foreign');
    const controllerHome = join(source, '_ops', 'controller-home');
    for (const root of [source, foreign]) {
      mkdirSync(root, { recursive: true });
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
      writeFileSync(join(root, 'README.md'), `${root}\n`);
      git(root, 'add', 'README.md');
      git(root, 'commit', '-qm', 'base');
    }
    const repository = registerRepository({ path: source, controllerHome });
    const requestId = 'foreign-request';
    const identity = createHash('sha256').update(`${repository.repoId}:${requestId}`).digest('hex').slice(0, 12);
    const branch = `campaign/foreign-${identity}`;
    git(foreign, 'checkout', '-qb', branch);
    const stateRoot = join(repositoryControllerRoot(controllerHome, repository.repoId), 'campaigns', 'workspaces');
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, `${identity}.json`), `${JSON.stringify({
      schemaVersion: 1,
      repoId: repository.repoId,
      requestId,
      branch,
      path: foreign,
      baseRevision: git(source, 'rev-parse', 'HEAD'),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);

    expect(() => ensureManagedWorkspace(controllerHome, repository, {
      requestId,
      title: 'foreign',
      branchName: branch,
    })).toThrow(/CAMPAIGN_WORKSPACE_REPOSITORY_MISMATCH/);
  });

  test('reuses an exact legacy nested manifest without moving the worktree', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'managed-worktree-legacy-'));
    roots.push(fixture);
    const source = join(fixture, 'source');
    const controllerHome = join(source, '_ops', 'controller-home');
    mkdirSync(source, { recursive: true });
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    writeFileSync(join(source, 'README.md'), 'base\n');
    git(source, 'add', 'README.md');
    git(source, 'commit', '-qm', 'base');
    const repository = registerRepository({ path: source, controllerHome });
    const requestId = 'legacy-request';
    const identity = createHash('sha256').update(`${repository.repoId}:${requestId}`).digest('hex').slice(0, 12);
    const branch = `campaign/legacy-${identity}`;
    const legacyPath = join(source, '.ai', 'harness', 'worktrees', `campaign-${identity}`);
    mkdirSync(join(source, '.ai', 'harness', 'worktrees'), { recursive: true });
    git(source, 'worktree', 'add', '-q', '-b', branch, legacyPath, 'HEAD');
    const statePath = join(repositoryControllerRoot(controllerHome, repository.repoId), 'campaigns', 'workspaces', `${identity}.json`);
    mkdirSync(join(repositoryControllerRoot(controllerHome, repository.repoId), 'campaigns', 'workspaces'), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 1,
      repoId: repository.repoId,
      requestId,
      branch,
      path: legacyPath,
      baseRevision: git(source, 'rev-parse', 'HEAD'),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const workspace = ensureManagedWorkspace(controllerHome, repository, {
      requestId,
      title: 'legacy',
      branchName: branch,
    });
    expect(workspace.root).toBe(realpathSync(legacyPath));
    expect(workspace.managed).toBe(true);
  });
});
