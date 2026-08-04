import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import {
  getRepository,
  registerRepository,
  selectRepositoryCheckout,
} from '../../src/cli/repositories/registry';
import { resolveGitExecutable } from '../../src/effects/git-executable';
import {
  assertExecutionIdentity,
  executionIdentityForRepository,
} from '../../src/runtime/control-plane/execution/execution-identity';
import { ensureManagedWorkspace } from '../../src/runtime/workflow/campaigns/workspace';

const roots: string[] = [];

function initGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  const git = resolveGitExecutable();
  expect(spawnSync(git, ['-C', root, 'init', '-b', 'main']).status).toBe(0);
  expect(spawnSync(git, ['-C', root, 'config', 'user.name', 'Test']).status).toBe(0);
  expect(spawnSync(git, ['-C', root, 'config', 'user.email', 'test@example.com']).status).toBe(0);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  expect(spawnSync(git, ['-C', root, 'add', '.']).status).toBe(0);
  expect(spawnSync(git, ['-C', root, 'commit', '-m', 'init']).status).toBe(0);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Git executable and managed workspace guards', () => {
  test('resolves an absolute Git executable without depending solely on service PATH', () => {
    const git = resolveGitExecutable();
    expect(isAbsolute(git)).toBe(true);
    expect(resolveGitExecutable({
      PATH: '',
      REPO_HARNESS_GIT_EXECUTABLE: git,
    })).toBe(git);
    if (process.platform !== 'win32') {
      expect(isAbsolute(resolveGitExecutable({ PATH: '' }))).toBe(true);
    }
  });

  test('creates and validates a same-repository managed worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-git-runtime-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repositoryRoot = join(root, 'repository');
    initGitRepo(repositoryRoot);
    const repository = registerRepository({
      path: repositoryRoot,
      controllerHome,
      displayName: 'git-runtime-fixture',
    });

    const workspace = ensureManagedWorkspace(controllerHome, repository, {
      requestId: 'git-runtime-workspace',
      title: 'Git Runtime Workspace',
      branchName: 'campaign/git-runtime-workspace',
    });
    const refreshed = getRepository(repository.repoId, controllerHome);
    const selected = selectRepositoryCheckout(refreshed, workspace.checkoutId);
    const guarded = assertExecutionIdentity({
      controllerHome,
      identity: executionIdentityForRepository(selected),
      cwd: workspace.root,
      requestedRepoId: repository.repoId,
      requestedCheckoutId: workspace.checkoutId,
    });

    expect(guarded.gitTopLevel).toBe(workspace.root);
    expect(guarded.gitCommonDirectory).toBeTruthy();
    expect(guarded.currentBranch).toBe('campaign/git-runtime-workspace');
  });
});
