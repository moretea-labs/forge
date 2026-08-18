import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
import { branchRef, branchSlugSegment, validateBranchName } from '../../src/cli/repositories/branch-name-policy';
import {
  ensureManagedWorkspace,
  managedWorkspaceDependencyBootstrap,
} from '../../src/runtime/execution/managed-workspace';

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


  test('uses one BranchNamePolicy for generated managed-work branches and refs', () => {
    const branch = `work/${branchSlugSegment('Comprehensively audit model property test fault!!')}-6b3219db2a69`;
    expect(branch).toBe('work/comprehensively-audit-model-property-test-fault-6b3219db2a69');
    expect(validateBranchName(branch, { purpose: 'MANAGED_WORKSPACE_BRANCH' })).toBe(branch);
    expect(branchRef(branch, { purpose: 'MANAGED_WORKSPACE_BRANCH' })).toBe(`refs/heads/${branch}`);
  });

  test('rejects invalid managed-work branch metadata before cleanup-style ref construction', () => {
    expect(() => validateBranchName('work/bad branch', { purpose: 'MANAGED_WORKSPACE_BRANCH' })).toThrow(/MANAGED_WORKSPACE_BRANCH_INVALID/);
    expect(() => branchRef('refs/heads/work/full-ref', { purpose: 'MANAGED_WORKSPACE_BRANCH' })).toThrow(/MANAGED_WORKSPACE_BRANCH_INVALID/);
  });
  test('resolves an absolute Git executable without depending solely on service PATH', () => {
    const git = resolveGitExecutable();
    expect(isAbsolute(git)).toBe(true);
    expect(resolveGitExecutable({
      PATH: '',
      FORGE_GIT_EXECUTABLE: git,
    })).toBe(git);
    if (process.platform !== 'win32') {
      expect(isAbsolute(resolveGitExecutable({ PATH: '' }))).toBe(true);
    }
  });

  test('materializes requested Node dependencies only inside the managed worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-git-runtime-deps-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    ensureControllerHome(controllerHome);
    const repositoryRoot = join(root, 'repository');
    initGitRepo(repositoryRoot);
    writeFileSync(join(repositoryRoot, 'package.json'), '{"name":"fixture","private":true}\n');
    writeFileSync(join(repositoryRoot, 'bun.lock'), '# fixture lock\n');
    const git = resolveGitExecutable();
    expect(spawnSync(git, ['-C', repositoryRoot, 'add', 'package.json', 'bun.lock']).status).toBe(0);
    expect(spawnSync(git, ['-C', repositoryRoot, 'commit', '-m', 'add node fixture']).status).toBe(0);
    const repository = registerRepository({ path: repositoryRoot, controllerHome, displayName: 'git-runtime-deps-fixture' });

    expect(managedWorkspaceDependencyBootstrap(repositoryRoot)).toEqual({
      packageManager: 'bun',
      lockfile: 'bun.lock',
      command: ['bun', 'install', '--frozen-lockfile'],
    });
    expect(existsSync(join(repositoryRoot, 'node_modules'))).toBe(false);

    let materializedRoot = '';
    const prepared = ensureManagedWorkspace(controllerHome, repository, {
      requestId: 'git-runtime-deps-workspace',
      title: 'Git Runtime Dependency Workspace',
      branchName: 'work/git-runtime-deps-workspace',
      prepareDependencies: true,
    }, {
      materializeDependencies: (workspaceRoot) => {
        materializedRoot = workspaceRoot;
        expect(workspaceRoot).not.toBe(repositoryRoot);
        expect(existsSync(join(repositoryRoot, 'node_modules'))).toBe(false);
        mkdirSync(join(workspaceRoot, 'node_modules'), { recursive: true });
      },
    });
    expect(prepared.root).toBeTruthy();
    expect(materializedRoot).toBe(prepared.root!);
    expect(existsSync(join(prepared.root!, 'node_modules'))).toBe(true);
    expect(existsSync(join(repositoryRoot, 'node_modules'))).toBe(false);

    let unexpectedInstall = false;
    ensureManagedWorkspace(controllerHome, repository, {
      requestId: 'git-runtime-no-deps-workspace',
      title: 'Git Runtime No Dependency Workspace',
      branchName: 'work/git-runtime-no-deps-workspace',
      prepareDependencies: false,
    }, {
      materializeDependencies: () => { unexpectedInstall = true; },
    });
    expect(unexpectedInstall).toBe(false);
  });

  test('creates and validates a same-repository managed worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-git-runtime-'));
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
      branchName: 'work/git-runtime-workspace',
    });
    expect(workspace.root).toBeTruthy();
    expect(workspace.checkoutId).toBeTruthy();
    const workspaceRoot = workspace.root!;
    const workspaceCheckoutId = workspace.checkoutId!;
    const refreshed = getRepository(repository.repoId, controllerHome);
    const selected = selectRepositoryCheckout(refreshed, workspaceCheckoutId);
    const guarded = assertExecutionIdentity({
      controllerHome,
      identity: executionIdentityForRepository(selected),
      cwd: workspaceRoot,
      requestedRepoId: repository.repoId,
      requestedCheckoutId: workspaceCheckoutId,
    });

    expect(guarded.gitTopLevel).toBe(workspaceRoot);
    expect(guarded.gitCommonDirectory).toBeTruthy();
    expect(guarded.currentBranch).toBe('work/git-runtime-workspace');
  });
});
