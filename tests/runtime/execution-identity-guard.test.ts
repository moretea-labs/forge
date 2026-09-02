import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { createMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { callRepositoryTool } from '../../src/cli/mcp/repository-tools';
import {
  addRepositoryCheckout,
  registerRepository,
  resolveRepositorySelection,
  selectRepositoryCheckout,
  setRepositoryCheckoutLifecycle,
} from '../../src/cli/repositories/registry';
import {
  assertExecutionIdentity,
  classifyGitCommonDirectoryDrift,
  executionIdentityForRepository,
  executionIdentityForWork,
  executionIdentityFromCoordinates,
  resolveLegacyWorkContractIdentity,
  ExecutionIdentityError,
} from '../../src/runtime/control-plane/execution/execution-identity';
import { adoptWorkHandleSuccessorCandidate, resolveWorkDeliveryTargetBranch, writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { inspectManagedWorkSuccessorAdoption } from '../../src/runtime/control-plane/execution/work-finalization-service';
import { repositoryGitStatus } from '../../src/cli/repositories/structured-git';
import { ensureRepositoryWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-authority';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
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

  test('explicit checkout identity wins over server default path without mutating registry focus', async () => {
    const fx = dualRepoFixture();
    const worktree = join(fx.root, 'repo-a-worktree');
    const worktreeResult = spawnSync('git', ['-C', fx.repoARoot, 'worktree', 'add', '-b', 'explicit-checkout', worktree], { encoding: 'utf8' });
    expect(worktreeResult.status).toBe(0);
    const withCheckout = addRepositoryCheckout({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      path: worktree,
      activate: false,
    });
    const checkout = withCheckout.checkouts.find((candidate) => candidate.canonicalRoot !== fx.repoA.canonicalRoot);
    expect(checkout).toBeTruthy();
    writeFileSync(join(worktree, 'checkout-only.txt'), 'from explicit worktree\n');
    const selected = resolveRepositorySelection({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      // Reproduce the real MCP shape: the server starts on main while this
      // invocation explicitly names another registered checkout.
      explicitPath: fx.repoA.canonicalRoot,
      checkoutId: checkout!.checkoutId,
    });
    expect(selected.activeCheckoutId).toBe(checkout!.checkoutId);
    expect(realpathSync(selected.canonicalRoot)).toBe(realpathSync(worktree));
    expect(withCheckout.activeCheckoutId).toBe(fx.repoA.activeCheckoutId);

    const ctx = createMcpToolContext({
      controllerHome: fx.controllerHome,
      profile: 'controller',
      repo: fx.repoA.canonicalRoot,
      sessionId: 'session-explicit-checkout',
      principalId: 'principal-explicit-checkout',
    });
    const read = await callRepositoryTool(fx.controllerHome, 'read_repository_file', {
      repo_id: fx.repoA.repoId,
      checkout_id: checkout!.checkoutId,
      path: 'checkout-only.txt',
    }, ctx);
    expect(read).toBeTruthy();
    expect(read?.isError).not.toBe(true);
    expect(JSON.stringify(read?.structuredContent)).toContain('from explicit worktree');
  });



  test('classifies Git common-directory drift before failing closed', () => {
    const fx = dualRepoFixture();
    const drift = classifyGitCommonDirectoryDrift({
      repoId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      actualCommonDirectory: join(fx.root, 'actual.git'),
      registeredCheckoutCommonDirectory: join(fx.root, 'actual.git'),
      repositoryCommonDirectory: join(fx.root, 'registry.git'),
      registeredRoot: fx.repoARoot,
      identityRoot: fx.repoARoot,
      resolvedCwd: fx.repoARoot,
    });
    expect(drift?.kind).toBe('repository_common_dir_drift');
    expect(drift?.safeAutomaticRepair).toBe(false);
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
    try {
      assertExecutionIdentity({
        controllerHome: fx.controllerHome,
        identity,
        cwd: fx.repoBRoot,
      });
      throw new Error('expected GIT_COMMON_DIR_MISMATCH');
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionIdentityError);
      expect((error as ExecutionIdentityError).code).toBe('GIT_COMMON_DIR_MISMATCH');
      expect((error as ExecutionIdentityError).details.driftKind).toBe('repository_common_dir_drift');
      expect((error as ExecutionIdentityError).details.safeAutomaticRepair).toBe('false');
    }
  });

  test('WorkHandle identity ignores mutable repository checkout projection', () => {
    const fx = dualRepoFixture();
    const handle = sampleHandle({
      workId: 'work_projection',
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      worktreePath: fx.repoA.canonicalRoot,
      branch: 'main',
      expectedHead: fx.headA,
    });
    const staleProjection = {
      ...fx.repoA,
      activeCheckoutId: fx.repoB.activeCheckoutId,
      canonicalRoot: fx.repoB.canonicalRoot,
      localRoot: fx.repoB.localRoot,
    };
    const identity = executionIdentityForWork(staleProjection, handle);
    expect(identity.repositoryId).toBe(fx.repoA.repoId);
    expect(identity.checkoutId).toBe(fx.repoA.activeCheckoutId);
    expect(identity.canonicalRoot).toBe(fx.repoA.canonicalRoot);
    expect(identity.worktreePath).toBe(fx.repoA.canonicalRoot);
  });

  test('WorkHandle still rejects a repository identity mismatch', () => {
    const fx = dualRepoFixture();
    const handle = sampleHandle({
      workId: 'work_wrong_repo',
      repositoryId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      worktreePath: fx.repoA.canonicalRoot,
      branch: 'main',
      expectedHead: fx.headA,
    });
    expect(() => executionIdentityForWork(fx.repoB, handle)).toThrow(/EXECUTION_IDENTITY_MISMATCH/);
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

  test('ephemeral workspace identity validates a non-Git root without Repository Registry ownership and rejects cwd escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-ephemeral-identity-'));
    roots.push(root);
    const controllerHome = join(root, 'controller-home');
    const workspaceRoot = join(root, 'plain-workspace');
    const child = join(workspaceRoot, 'child');
    const outside = join(root, 'outside');
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(child, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const canonicalRoot = realpathSync(workspaceRoot);
    const identity = executionIdentityFromCoordinates({
      authority: 'ephemeral_workspace',
      repositoryId: 'workspace_test_identity',
      checkoutId: 'workspace_checkout_test_identity',
      canonicalRoot,
    });

    const guarded = assertExecutionIdentity({
      controllerHome,
      identity,
      cwd: child,
      requestedRepoId: identity.repositoryId,
      requestedCheckoutId: identity.checkoutId,
    });
    expect(guarded.canonicalRoot).toBe(canonicalRoot);
    expect(guarded.resolvedCwd).toBe(realpathSync(child));
    expect(guarded.gitTopLevel).toBeUndefined();
    expect(guarded.gitCommonDirectory).toBeUndefined();

    expect(() => assertExecutionIdentity({
      controllerHome,
      identity,
      cwd: outside,
    })).toThrow(/WORKSPACE_SCOPE_MISMATCH/);
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


describe('managed Work successor authority', () => {
  test('adopts a clean target-reconciled rewritten candidate and re-arms validation', () => {
    const fx = dualRepoFixture();
    const base = fx.headA;
    spawnSync('git', ['-C', fx.repoARoot, 'checkout', '-b', 'work/successor'], { encoding: 'utf8' });
    writeFileSync(join(fx.repoARoot, 'work.txt'), 'work change\n');
    spawnSync('git', ['-C', fx.repoARoot, 'add', 'work.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', fx.repoARoot, 'commit', '-m', 'work candidate'], { encoding: 'utf8' });
    const oldCandidate = spawnSync('git', ['-C', fx.repoARoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['-C', fx.repoARoot, 'checkout', 'main'], { encoding: 'utf8' });
    writeFileSync(join(fx.repoARoot, 'target.txt'), 'target advance\n');
    spawnSync('git', ['-C', fx.repoARoot, 'add', 'target.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', fx.repoARoot, 'commit', '-m', 'target advance'], { encoding: 'utf8' });
    const targetHead = spawnSync('git', ['-C', fx.repoARoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['-C', fx.repoARoot, 'checkout', 'work/successor'], { encoding: 'utf8' });
    expect(spawnSync('git', ['-C', fx.repoARoot, 'rebase', 'main'], { encoding: 'utf8' }).status).toBe(0);
    const successorHead = spawnSync('git', ['-C', fx.repoARoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    expect(successorHead).not.toBe(oldCandidate);

    const inspection = inspectManagedWorkSuccessorAdoption({
      root: fx.repoARoot,
      worktreePath: fx.repoARoot,
      managedWorktree: true,
      workBranch: 'work/successor',
      targetBranch: 'main',
      expectedRevision: oldCandidate,
      deliveryBaseRevision: base,
      status: repositoryGitStatus(fx.repoA),
      scope: { allowedPaths: ['work.txt'], forbiddenPaths: [] },
    });
    expect(inspection).toMatchObject({
      adoptable: true,
      reason: 'adoptable',
      previousHead: oldCandidate,
      candidateHead: successorHead,
      targetHead,
      candidateChangedPaths: ['work.txt'],
    });

    const handle = writeWorkHandle(fx.controllerHome, {
      ...sampleHandle({
        workId: 'work-successor-adoption',
        repositoryId: fx.repoA.repoId,
        checkoutId: fx.repoA.activeCheckoutId,
        worktreePath: fx.repoARoot,
        branch: 'work/successor',
        expectedHead: oldCandidate,
      }),
      managedWorktree: true,
      deliveryBaseCommit: base,
      state: 'failed',
      failureReason: 'WORK_HANDLE_HEAD_CHANGED',
      validatedInputFingerprint: 'stale-validation',
      validationRun: {
        fingerprint: 'stale-validation',
        head: oldCandidate,
        workspaceFingerprint: 'stale-workspace',
        requestedChecks: ['package:check:type'],
        resumeState: 'committed',
        processes: {},
      },
      finalization: {
        validation: 'failed',
        commit: 'done',
        merge: 'failed',
        branchCleanup: 'failed',
        worktreeCleanup: 'failed',
        lastError: 'WORK_HANDLE_HEAD_CHANGED',
      },
    });
    const adopted = adoptWorkHandleSuccessorCandidate(fx.controllerHome, handle, { candidateHead: successorHead, targetHead });
    expect(adopted.state).toBe('validating');
    expect(adopted.expectedHead).toBe(successorHead);
    expect(adopted.deliveryBaseCommit).toBe(targetHead);
    expect(adopted.failureReason).toBeUndefined();
    expect(adopted.validationRun).toBeUndefined();
    expect(adopted.validatedInputFingerprint).toBeUndefined();
    expect(adopted.finalization).toMatchObject({
      validation: 'pending', commit: 'done', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending',
    });
  });

  test('leaves ordinary descendant progress on the existing path and rejects an out-of-scope rewritten successor', () => {
    const fx = dualRepoFixture();
    const base = fx.headA;
    spawnSync('git', ['-C', fx.repoARoot, 'checkout', '-b', 'work/invalid-successor'], { encoding: 'utf8' });
    writeFileSync(join(fx.repoARoot, 'work.txt'), 'work change\n');
    spawnSync('git', ['-C', fx.repoARoot, 'add', 'work.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', fx.repoARoot, 'commit', '-m', 'old work candidate'], { encoding: 'utf8' });
    const oldCandidate = spawnSync('git', ['-C', fx.repoARoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['-C', fx.repoARoot, 'checkout', 'main'], { encoding: 'utf8' });
    writeFileSync(join(fx.repoARoot, 'target.txt'), 'target advance\n');
    spawnSync('git', ['-C', fx.repoARoot, 'add', 'target.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', fx.repoARoot, 'commit', '-m', 'target advance'], { encoding: 'utf8' });
    spawnSync('git', ['-C', fx.repoARoot, 'checkout', 'work/invalid-successor'], { encoding: 'utf8' });
    writeFileSync(join(fx.repoARoot, 'outside.txt'), 'out of scope\n');
    spawnSync('git', ['-C', fx.repoARoot, 'add', 'outside.txt'], { encoding: 'utf8' });
    spawnSync('git', ['-C', fx.repoARoot, 'commit', '-m', 'unreconciled rewrite'], { encoding: 'utf8' });

    const notReconciled = inspectManagedWorkSuccessorAdoption({
      root: fx.repoARoot,
      worktreePath: fx.repoARoot,
      managedWorktree: true,
      workBranch: 'work/invalid-successor',
      targetBranch: 'main',
      expectedRevision: oldCandidate,
      deliveryBaseRevision: base,
      status: repositoryGitStatus(fx.repoA),
      scope: { allowedPaths: ['work.txt'], forbiddenPaths: [] },
    });
    expect(notReconciled).toMatchObject({ adoptable: false, reason: 'descendant_progress' });

    expect(spawnSync('git', ['-C', fx.repoARoot, 'rebase', 'main'], { encoding: 'utf8' }).status).toBe(0);
    const outOfScope = inspectManagedWorkSuccessorAdoption({
      root: fx.repoARoot,
      worktreePath: fx.repoARoot,
      managedWorktree: true,
      workBranch: 'work/invalid-successor',
      targetBranch: 'main',
      expectedRevision: oldCandidate,
      deliveryBaseRevision: base,
      status: repositoryGitStatus(fx.repoA),
      scope: { allowedPaths: ['work.txt'], forbiddenPaths: [] },
    });
    expect(outOfScope).toMatchObject({ adoptable: false, reason: 'scope_violation' });
    expect(outOfScope.detail).toContain('outside.txt');
  });
});


describe('repository Work delivery target authority', () => {
  test('materializes the exact non-default source branch as the durable delivery target', () => {
    const fx = dualRepoFixture();
    const branch = 'kernel-v2/architecture';
    const checkout = spawnSync('git', ['-C', fx.repoARoot, 'checkout', '-b', branch], { encoding: 'utf8' });
    expect(checkout.status).toBe(0);
    const workId = 'work-non-default-delivery-target';
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repoA.repoId }, {
      workId,
      repoId: fx.repoA.repoId,
      checkoutId: fx.repoA.activeCheckoutId,
      baseRevision: fx.headA,
      mode: 'goal_workloop',
      objective: 'Preserve non-default source delivery branch.',
      acceptanceCriteria: ['Delivery target remains exact.'],
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      constraints: { requireHandoffOnAmbiguity: true },
      requestedBy: 'chatgpt',
      workKind: 'repository_change',
      status: 'running',
      phase: 'implementation',
    });
    const handle = ensureRepositoryWorkHandle({
      controllerHome: fx.controllerHome,
      repository: fx.repoA,
      workId,
      identity: { sessionId: 'session-target-binding', principalId: 'principal-target-binding' },
    });
    expect(handle?.deliveryTargetBranch).toBe(branch);
  });

  test('uses the bound target, accepts an explicit match, rejects explicit rebinding, and preserves legacy fallback', () => {
    const repository = { defaultBranch: 'main' };
    const bound = { workId: 'work-bound-target', deliveryTargetBranch: 'kernel-v2/architecture' };
    expect(resolveWorkDeliveryTargetBranch(bound, repository.defaultBranch)).toBe('kernel-v2/architecture');
    expect(resolveWorkDeliveryTargetBranch(bound, repository.defaultBranch, 'kernel-v2/architecture')).toBe('kernel-v2/architecture');
    expect(() => resolveWorkDeliveryTargetBranch(bound, repository.defaultBranch, 'main')).toThrow(
      /WORK_DELIVERY_TARGET_BRANCH_MISMATCH.*kernel-v2\/architecture.*main/,
    );
    expect(resolveWorkDeliveryTargetBranch({ workId: 'legacy-work' }, repository.defaultBranch)).toBe('main');
    expect(resolveWorkDeliveryTargetBranch({ workId: 'legacy-work' }, repository.defaultBranch, 'release/legacy')).toBe('release/legacy');
  });
});
