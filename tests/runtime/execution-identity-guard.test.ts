import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { createMcpToolContext } from '../../adapters/mcp/multi-repository';
import { callRepositoryTool } from '../../src/runtime/control-plane/facade/repository-tool-dispatch';
import {
  addRepositoryCheckout,
  loadRepositoryRegistry,
  registerRepository,
  RepositoryCheckoutSelectionError,
  resolveRepositorySelection,
  saveRepositoryRegistry,
  selectRepositoryCheckout,
  setRepositoryCheckoutLifecycle,
} from '../../src/runtime/repositories/registry';
import {
  assertExecutionIdentity,
  classifyGitCommonDirectoryDrift,
  executionIdentityForRepository,
  ExecutionIdentityError,
  type ResolvedExecutionIdentity,
} from '../../src/runtime/control-plane/execution/execution-identity';
import { resolveWorkDeliveryTargetBranch } from '../../src/runtime/control-plane/execution/work-handle-store';
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

function identityFromCoordinates(
  input: Omit<ResolvedExecutionIdentity, 'schemaVersion'>,
): ResolvedExecutionIdentity {
  return Object.freeze({ schemaVersion: 1 as const, ...input });
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
    const identity = identityFromCoordinates({
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
    const identity = identityFromCoordinates({
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
    const identity = identityFromCoordinates({
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
    const identity = identityFromCoordinates({
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
    const linkedWorktree = join(fx.root, 'repo-a-archived-worktree');
    const worktreeResult = spawnSync('git', ['-C', fx.repoARoot, 'worktree', 'add', '-b', 'archived-checkout', linkedWorktree], { encoding: 'utf8' });
    expect(worktreeResult.status).toBe(0);
    const withCheckout = addRepositoryCheckout({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      path: linkedWorktree,
      activate: false,
    });
    const addedCheckout = withCheckout.checkouts.find((checkout) => checkout.canonicalRoot === realpathSync(linkedWorktree));
    expect(addedCheckout).toBeTruthy();
    setRepositoryCheckoutLifecycle({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      checkoutId: addedCheckout!.checkoutId,
      lifecycle: 'archived',
      reason: 'test fixture',
    });
    const refreshed = loadRepositoryRegistry(fx.controllerHome).repositories.find((record) => record.repoId === fx.repoA.repoId)!;
    let selectionError: unknown;
    try {
      selectRepositoryCheckout(refreshed, addedCheckout!.checkoutId);
    } catch (error) {
      selectionError = error;
    }
    expect(selectionError).toBeInstanceOf(RepositoryCheckoutSelectionError);
    expect((selectionError as RepositoryCheckoutSelectionError).code).toBe('CHECKOUT_NOT_ACTIVE');
    expect((selectionError as RepositoryCheckoutSelectionError).lifecycle).toBe('archived');

    const selected = selectRepositoryCheckout(refreshed, addedCheckout!.checkoutId, { allowArchived: true });
    const identity = executionIdentityForRepository(selected);
    expect(() => assertExecutionIdentity({
      controllerHome: fx.controllerHome,
      identity,
      cwd: linkedWorktree,
    })).toThrow(/CHECKOUT_NOT_ACTIVE/);
  });

  test('explicit checkout identity wins over server default path without mutating registry focus', async () => {
    const fx = dualRepoFixture();
    const staleRegistry = loadRepositoryRegistry(fx.controllerHome);
    const worktree = join(fx.root, 'repo-a-worktree');
    const worktreeResult = spawnSync('git', ['-C', fx.repoARoot, 'worktree', 'add', '-b', 'explicit-checkout', worktree], { encoding: 'utf8' });
    expect(worktreeResult.status).toBe(0);
    const withCheckout = addRepositoryCheckout({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      path: worktree,
      activate: false,
    });
    // Simulate the production interleaving from #196: another Runtime/Gateway
    // loaded the Registry before this checkout was added, then tries to persist
    // that stale snapshot afterwards. The stale writer must fail closed instead
    // of erasing a checkout that other MCP surfaces already accepted.
    expect(() => saveRepositoryRegistry(staleRegistry, fx.controllerHome)).toThrow(/REPOSITORY_REGISTRY_STALE/);
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

    const patch = await callRepositoryTool(fx.controllerHome, 'repository_safe_patch_apply', {
      repo_id: fx.repoA.repoId,
      checkout_id: checkout!.checkoutId,
      purpose: 'cross-surface checkout identity regression',
      allowed_paths: ['checkout-only.txt'],
      operations: [{
        type: 'replace',
        path: 'checkout-only.txt',
        expected_sha256: createHash('sha256').update('from explicit worktree\n').digest('hex'),
        old_text: 'from explicit worktree',
        new_text: 'from safe patch',
      }],
    }, ctx);
    expect(patch).toBeTruthy();
    expect(patch?.isError).not.toBe(true);
    expect(patch?.structuredContent).toEqual(expect.objectContaining({
      repoId: fx.repoA.repoId,
      checkoutId: checkout!.checkoutId,
      status: 'applied',
    }));

    const command = await callRepositoryTool(fx.controllerHome, 'execute_command', {
      repo_id: fx.repoA.repoId,
      checkout_id: checkout!.checkoutId,
      command: ['git', 'status', '--short'],
    }, ctx);
    expect(command).toBeTruthy();
    expect(command?.isError).not.toBe(true);
    expect(command?.structuredContent).toEqual(expect.objectContaining({
      repoId: fx.repoA.repoId,
      checkoutId: checkout!.checkoutId,
    }));
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

  test('rejects an independently rooted repository before it can become a checkout identity', () => {
    const fx = dualRepoFixture();
    expect(() => addRepositoryCheckout({
      controllerHome: fx.controllerHome,
      repoId: fx.repoA.repoId,
      path: fx.repoB.canonicalRoot,
      activate: false,
    })).toThrow(/CHECKOUT_REPOSITORY_MISMATCH/);
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
    const identity = identityFromCoordinates({
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

  test('structured errors expose safe expected/actual fields', () => {
    const fx = dualRepoFixture();
    const identity = identityFromCoordinates({
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

describe('repository Work delivery target authority', () => {

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
