import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import {
  addRepositoryCheckout,
  registerRepository,
  selectRepositoryCheckout,
  setRepositoryCheckoutLifecycle,
} from '../../src/cli/repositories/registry';
import {
  assertExecutionIdentity,
  executionIdentityForRepository,
  executionIdentityForWork,
  executionIdentityFromCoordinates,
  resolveLegacyWorkContractIdentity,
  ExecutionIdentityError,
} from '../../src/runtime/control-plane/execution/execution-identity';
import type { WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { spawnManagedProcess } from '../../src/runtime/execution/process-runtime';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function initGitRepo(repoRoot: string, branch = 'main'): string {
  mkdirSync(repoRoot, { recursive: true });
  spawnSync('git', ['-C', repoRoot, 'init', '-b', branch], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' });
  writeFileSync(join(repoRoot, 'README.md'), `fixture ${repoRoot}\n`);
  spawnSync('git', ['-C', repoRoot, 'add', '.'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoRoot, 'commit', '-m', 'init'], { encoding: 'utf8' });
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  return head;
}

function dualRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'execution-identity-'));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  ensureControllerHome(controllerHome);
  const repoARoot = join(root, 'repo-a');
  const repoBRoot = join(root, 'repo-b');
  const headA = initGitRepo(repoARoot);
  const headB = initGitRepo(repoBRoot);
  const repoA = registerRepository({ path: repoARoot, controllerHome, displayName: 'repo-a' });
  const repoB = registerRepository({ path: repoBRoot, controllerHome, displayName: 'repo-b' });
  return { root, controllerHome, repoA, repoB, headA, headB, repoARoot, repoBRoot };
}

function sampleHandle(input: {
  workId: string;
  repositoryId: string;
  checkoutId: string;
  worktreePath: string;
  branch: string;
  expectedHead?: string;
}): WorkHandleState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    workId: input.workId,
    sessionId: 'sess-test',
    principalId: 'principal-test',
    repositoryId: input.repositoryId,
    checkoutId: input.checkoutId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    managedWorktree: false,
    expectedHead: input.expectedHead,
    permissionSnapshotVersion: 1,
    state: 'prepared',
    createdAt: now,
    updatedAt: now,
    finalization: {
      validation: 'pending',
      commit: 'pending',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    },
  };
}

describe('execution identity pre-spawn guard', () => {
  test('rejects explicit checkout A when cwd routes into repo B', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityForRepository(fx.repoA);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoBRoot,
      requestedRepoId: fx.repoA.repoId,
      requestedCheckoutId: fx.repoA.activeCheckoutId,
    })).toThrow(/CHECKOUT_ROUTE_MISMATCH|GIT_TOPLEVEL_MISMATCH/);
  });

  test('rejects checkoutId mismatch against immutable identity', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityForRepository(fx.repoA);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoARoot,
      requestedRepoId: fx.repoA.repoId,
      requestedCheckoutId: fx.repoB.activeCheckoutId,
    })).toThrow(/CHECKOUT_ROUTE_MISMATCH/);
  });

  test('rejects repoId mismatch against immutable identity', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityForRepository(fx.repoA);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoARoot,
      requestedRepoId: fx.repoB.repoId,
      requestedCheckoutId: fx.repoA.activeCheckoutId,
    })).toThrow(/EXECUTION_IDENTITY_MISMATCH/);
  });

  test('rejects an execution identity for an unregistered checkout', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityFromCoordinates({
      repositoryId: fx.repoA.repoId,
      checkoutId: 'checkout_missing',
      canonicalRoot: fx.repoARoot,
    });
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoARoot,
    })).toThrow(/CHECKOUT_NOT_REGISTERED/);
  });

  test('rejects WorkHandle worktree path drift', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityForRepository(fx.repoA, {
      workId: 'work_wrong_path',
      worktreePath: fx.repoBRoot,
    });
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoARoot,
    })).toThrow(/WORKTREE_PATH_MISMATCH/);
  });

  test('rejects Git top-level mismatch when cwd is outside registered checkout', () => {
    const fx = dualRepoFixture();
    const outsider = join(fx.root, 'outsider');
    initGitRepo(outsider);
    const identity = executionIdentityForRepository(fx.repoA);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: outsider,
      requestedRepoId: fx.repoA.repoId,
      requestedCheckoutId: fx.repoA.activeCheckoutId,
    })).toThrow(/CHECKOUT_ROUTE_MISMATCH|GIT_TOPLEVEL_MISMATCH/);
  });

  test('rejects a nested independent repository instead of inferring parent ownership', () => {
    const fx = dualRepoFixture();
    const nested = join(fx.repoARoot, 'nested-repository');
    initGitRepo(nested);
    const identity = executionIdentityForRepository(fx.repoA);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: nested,
    })).toThrow(/GIT_TOPLEVEL_MISMATCH/);
  });

  test('rejects branch drift', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityFromCoordinates({
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      canonicalRoot: fx.repoA.canonicalRoot,
      branch: 'expected-feature',
      expectedHead: fx.headA,
    });
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoARoot,
    })).toThrow(/WORK_HANDLE_BRANCH_CHANGED/);
  });

  test('rejects HEAD drift', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityFromCoordinates({
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      canonicalRoot: fx.repoA.canonicalRoot,
      branch: 'main',
      expectedHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoARoot,
    })).toThrow(/WORK_HANDLE_HEAD_CHANGED/);
  });

  test('symlink path alias still validates through realpath', () => {
    const fx = dualRepoFixture();
    const alias = join(fx.root, 'alias-a');
    symlinkSync(fx.repoARoot, alias);
    const identity = executionIdentityFromCoordinates({
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      canonicalRoot: alias,
      branch: 'main',
      expectedHead: fx.headA,
    });
    const guarded = assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: alias,
      requestedRepoId: fx.repoA.repoId,
      requestedCheckoutId: fx.repoA.activeCheckoutId,
    });
    expect(guarded.resolvedCwd).toBeTruthy();
    expect(guarded.gitTopLevel).toBeTruthy();
  });

  test('rejects archived checkout lifecycle unless explicitly allowed', () => {
    const fx = dualRepoFixture();
    const withCheckout = addRepositoryCheckout({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      path: fx.repoB.canonicalRoot,
      activate: false,
    });
    const addedCheckout = withCheckout.checkouts.find((checkout) => checkout.canonicalRoot === fx.repoB.canonicalRoot);
    expect(addedCheckout).toBeTruthy();
    setRepositoryCheckoutLifecycle({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      checkoutId: addedCheckout!.checkoutId,
      lifecycle: 'archived',
      reason: 'test fixture',
    });
    const selected = selectRepositoryCheckout(withCheckout, addedCheckout!.checkoutId, { allowArchived: true });
    const identity = executionIdentityForRepository(selected);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoBRoot,
    })).toThrow(/CHECKOUT_NOT_ACTIVE/);
  });

  test('rejects an independently rooted checkout with exact Git common-directory evidence', () => {
    const fx = dualRepoFixture();
    const withCheckout = addRepositoryCheckout({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      path: fx.repoB.canonicalRoot,
      activate: false,
    });
    const addedCheckout = withCheckout.checkouts.find((checkout) => checkout.canonicalRoot === fx.repoB.canonicalRoot);
    expect(addedCheckout).toBeTruthy();
    const selected = selectRepositoryCheckout(withCheckout, addedCheckout!.checkoutId);
    const identity = executionIdentityForRepository(selected);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoBRoot,
    })).toThrow(/GIT_COMMON_DIR_MISMATCH/);
  });

  test('legacy ambiguous WorkContract identity is rejected', () => {
    const fx = dualRepoFixture();
    const handleA = sampleHandle({
      workId: 'work_shared',
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      worktreePath: fx.repoA.canonicalRoot,
      branch: 'main',
      expectedHead: fx.headA,
    });
    const handleB = sampleHandle({
      workId: 'work_shared',
      repositoryId: fx.repoB.repoId,
      checkoutId: fx.repoB.activeCheckoutId,
      worktreePath: fx.repoB.canonicalRoot,
      branch: 'main',
      expectedHead: fx.headB,
    });
    expect(() => resolveLegacyWorkContractIdentity({
      workId: 'work_shared',
      candidates: [handleA, handleB],
    })).toThrow(/LEGACY_WORK_IDENTITY_AMBIGUOUS|LEGACY_WORK_IDENTITY_REJECTED/);
  });

  test('legacy unique exact WorkHandle match succeeds', () => {
    const fx = dualRepoFixture();
    const handle = sampleHandle({
      workId: 'work_unique',
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      worktreePath: fx.repoA.canonicalRoot,
      branch: 'main',
      expectedHead: fx.headA,
    });
    const resolved = resolveLegacyWorkContractIdentity({
      workId: 'work_unique',
      repoId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      canonicalRoot: fx.repoA.canonicalRoot,
      branch: 'main',
      head: fx.headA,
      candidates: [handle],
    });
    expect(resolved.workId).toBe('work_unique');
    expect(resolved.checkoutId).toBe(fx.repoA.activeCheckoutId);
  });

  test('happy path identity matches and spawn uses guarded cwd', async () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityForRepository(fx.repoA, {
      branch: 'main',
      expectedHead: fx.headA,
    });
    const guarded = assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: fx.repoARoot,
      requestedRepoId: fx.repoA.repoId,
      requestedCheckoutId: fx.repoA.activeCheckoutId,
    });
    expect(guarded.currentBranch).toBe('main');
    expect(guarded.currentHead).toBe(fx.headA);

    const handle = await spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      executionIdentity: identity,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'process.stdout.write("ok"); process.exit(0)'],
        cwd: fx.repoARoot,
      },
      interactiveWaitMs: 5_000,
      timeoutMs: 15_000,
    });
    expect(handle.completed).toBe(true);
    expect(handle.ok).toBe(true);
    expect(handle.stdout).toContain('ok');
  });

  test('spawn refuses wrong-repo identity without launching the command', async () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityForRepository(fx.repoA);
    await expect(spawnManagedProcess({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      executionIdentity: identity,
      command: {
        kind: 'argv',
        executable: 'node',
        args: ['-e', 'process.stdout.write("should-not-run"); process.exit(0)'],
        cwd: fx.repoBRoot,
      },
      interactiveWaitMs: 1_000,
      timeoutMs: 5_000,
    })).rejects.toThrow(/CHECKOUT_ROUTE_MISMATCH|GIT_TOPLEVEL_MISMATCH|GIT_COMMON_DIR_MISMATCH/);
  });

  test('WorkHandle checkout drift fails closed', () => {
    const fx = dualRepoFixture();
    const handle = sampleHandle({
      workId: 'work_drift',
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      worktreePath: fx.repoA.canonicalRoot,
      branch: 'main',
      expectedHead: fx.headA,
    });
    const wrongRepoView = selectRepositoryCheckout(fx.repoB, fx.repoB.activeCheckoutId);
    expect(() => executionIdentityForWork(wrongRepoView, handle)).toThrow(/EXECUTION_IDENTITY_MISMATCH|WORK_HANDLE_CHECKOUT_DRIFT/);
  });

  test('structured errors expose safe expected/actual fields', () => {
    const fx = dualRepoFixture();
    const identity = executionIdentityFromCoordinates({
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      canonicalRoot: fx.repoA.canonicalRoot,
      branch: 'main',
      expectedHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    try {
      assertExecutionIdentity({
        controllerHome: fx.controllerHome,
        identity,
        cwd: fx.repoARoot,
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionIdentityError);
      const typed = error as ExecutionIdentityError;
      expect(typed.code).toBe('WORK_HANDLE_HEAD_CHANGED');
      expect(typed.details.expected).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      expect(typed.details.actual).toBe(fx.headA);
      expect(typed.details.repoId).toBe(fx.repoA.repoId);
      expect(typed.details.checkoutId).toBe(fx.repoA.activeCheckoutId);
    }
  });
  test('missing executionIdentity fails closed before spawn', async () => {
    const fx = dualRepoFixture();
    const input = {
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      command: {
        kind: 'argv' as const,
        executable: 'node',
        args: ['-e', 'process.stdout.write("no"); process.exit(0)'],
        cwd: fx.repoARoot,
      },
      interactiveWaitMs: 1_000,
      timeoutMs: 5_000,
    };
    // Runtime fail-closed path for incomplete identity (bypass TypeScript required field).
    await expect(spawnManagedProcess(input as any)).rejects.toThrow(/EXECUTION_IDENTITY_REQUIRED/);
  });

});
