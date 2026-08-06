import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MANAGED_WORKTREE_HOME_ENV,
  managedWorktreeStorageRoot,
} from '../../src/cli/repositories/worktree-storage';
import type { RepositoryCheckout, RepositoryRecord } from '../../src/cli/repositories/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function checkout(
  checkoutId: string,
  root: string,
  worktree: boolean,
): RepositoryCheckout {
  return {
    checkoutId,
    localRoot: root,
    canonicalRoot: root,
    worktree,
    branch: worktree ? `work/${checkoutId}` : 'main',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    lastSeenAt: '2026-08-03T00:00:00.000Z',
    lifecycle: 'active',
  };
}

function repository(root: string, checkouts: RepositoryCheckout[]): RepositoryRecord {
  return {
    schemaVersion: 1,
    repoId: 'repo-test',
    displayName: 'test repository',
    localRoot: root,
    canonicalRoot: root,
    activeCheckoutId: checkouts[0]?.checkoutId ?? 'checkout-main',
    checkouts,
    defaultBranch: 'main',
    repositoryType: 'git',
    enabled: true,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    lastSeenAt: '2026-08-03T00:00:00.000Z',
    configurationPath: join(root, '.forge', 'config.json'),
    stateStorageStrategy: 'controller-home',
  };
}

function explicitEnv(base: string): NodeJS.ProcessEnv {
  return { [MANAGED_WORKTREE_HOME_ENV]: base };
}

describe('managed worktree storage ownership', () => {
  test('keeps the managed root usable after it contains an active worktree checkout', () => {
    const repositoryRoot = tempRoot('forge-source-');
    const controllerHome = tempRoot('forge-controller-');
    const storageBase = tempRoot('forge-worktrees-');
    const mainCheckout = checkout('checkout-main', repositoryRoot, false);
    const record = repository(repositoryRoot, [mainCheckout]);

    const firstRoot = managedWorktreeStorageRoot(
      controllerHome,
      [record],
      explicitEnv(storageBase),
    );
    const managedCheckoutRoot = join(firstRoot, record.repoId, 'work-existing');
    record.checkouts.push(checkout('checkout-managed', managedCheckoutRoot, true));

    expect(managedWorktreeStorageRoot(
      controllerHome,
      [record],
      explicitEnv(storageBase),
    )).toBe(firstRoot);
  });

  test('still rejects a non-worktree checkout inside the proposed managed root', () => {
    const repositoryRoot = tempRoot('forge-source-');
    const controllerHome = tempRoot('forge-controller-');
    const storageBase = tempRoot('forge-worktrees-');
    const mainCheckout = checkout('checkout-main', repositoryRoot, false);
    const record = repository(repositoryRoot, [mainCheckout]);

    const managedRoot = managedWorktreeStorageRoot(
      controllerHome,
      [record],
      explicitEnv(storageBase),
    );
    record.checkouts.push(checkout(
      'checkout-external-source',
      join(managedRoot, 'external-source'),
      false,
    ));

    expect(() => managedWorktreeStorageRoot(
      controllerHome,
      [record],
      explicitEnv(storageBase),
    )).toThrow('MANAGED_WORKTREE_HOME_OVERLAPS_REPOSITORY');
  });

  test('still rejects an independently registered repository beneath the proposed root', () => {
    const repositoryRoot = tempRoot('forge-source-');
    const controllerHome = tempRoot('forge-controller-');
    const storageBase = tempRoot('forge-worktrees-');
    const record = repository(repositoryRoot, [checkout('checkout-main', repositoryRoot, false)]);

    const managedRoot = managedWorktreeStorageRoot(
      controllerHome,
      [record],
      explicitEnv(storageBase),
    );
    const nestedRepositoryRoot = join(managedRoot, 'independent-repository');
    const nested = repository(
      nestedRepositoryRoot,
      [checkout('checkout-independent', nestedRepositoryRoot, false)],
    );
    nested.repoId = 'repo-independent';

    expect(() => managedWorktreeStorageRoot(
      controllerHome,
      [record, nested],
      explicitEnv(storageBase),
    )).toThrow('MANAGED_WORKTREE_HOME_OVERLAPS_REPOSITORY');
  });
});
