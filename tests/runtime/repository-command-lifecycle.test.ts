import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS } from '../../src/runtime/shared/runtime-config';
import { getLocalBridgeJob, reconcileLocalBridgeJobs } from '../../src/cli/local-bridge/job-store';
import {
  executeRepositoryCommand,
  executeRepositoryCommandAsync,
  executeRepositoryReadOnlyCommandDirect,
  previewRepositoryCommandExecution,
  REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS,
  REPOSITORY_COMMAND_MAX_TIMEOUT_MS,
  REPOSITORY_COMMAND_MIN_TIMEOUT_MS,
} from '../../src/runtime/repositories/command-executor';
import { addRepositoryCheckout, getRepository, registerRepository } from '../../src/runtime/repositories/registry';
import { repositoryGitRemoveWorktree } from '../../src/runtime/repositories/structured-worktree-cleanup';
import { recordOwnedResource } from '../../packages/kernel/identity/api/index';
import {
  commitSelectedPatch,
  commitSelectedPaths,
  restoreSelectedPaths,
  selectedPathDiff,
} from '../../src/runtime/repositories/selected-path-actions';
import { acquireControllerLock, releaseControllerLock } from '../../src/effects/controller-locks';
import { persistControllerAccessMode } from '../../adapters/mcp/access-mode';
import { classifyRepositoryCommand } from '../../src/cli/repositories/command-classifier';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import {
  classifyRepositoryCommandRoute,
  executeRepositoryCommandViaProcessRuntime,
  waitRepositoryCommandProcess,
} from '../../src/runtime/execution/process-runtime/command-facade';
import { listProcessRecords } from '../../src/runtime/execution/process-runtime/store';
import { processScopeRoot } from '../../src/runtime/execution/process-runtime/process-scope';
import { getExecutionJob, updateExecutionJob } from '../../src/runtime/execution/jobs/store';
import { waitForExecutionJob } from '../../src/runtime/execution/jobs/wait';
import { executeExecutionJob } from '../../src/runtime/execution/workers/executor';
import {
  acquireExecutionLeases,
  withRepositoryMutationExclusionAsync,
  listActiveLeases,
  releaseExecutionLeases,
  renewExecutionLeases,
} from '../../src/runtime/resources/leases/store';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { terminateProcessTree } from '../../src/runtime/shared/process-tree';
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from './process-hygiene';

const roots: string[] = [];
const tracked: ChildProcess[] = [];

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

function gitOutput(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout ?? '').trim();
}

function gitRawOutput(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout ?? '');
}

function seedRepo(controllerHome: string, repoRoot: string) {
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Forge Test']);
  git(repoRoot, ['config', 'user.email', 'forge-test@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'hello\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
  return registerRepository({ path: repoRoot, controllerHome });
}

describe('structured registered worktree cleanup (#41)', () => {
  function fixture() {
    const root = tempRoot('forge-worktree-cleanup-');
    const controllerHome = join(root, 'controller');
    const repoRoot = join(root, 'repo');
    const repository = seedRepo(controllerHome, repoRoot);
    const linked = join(root, 'linked');
    git(repoRoot, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const registered = addRepositoryCheckout({ repoId: repository.repoId, path: linked, controllerHome });
    const target = registered.checkouts.find((item) => item.localRoot === realpathSync(linked));
    if (!target) throw new Error('checkout registration missing');
    const current = () => getRepository(repository.repoId, controllerHome)!;
    const cleanup = (
      input: { expectedHead?: string; expectedIdentity?: string; previewToken?: string; confirmCleanup?: boolean } = {},
    ) => repositoryGitRemoveWorktree(controllerHome, current(), { checkoutId: target.checkoutId, ...input });
    return { root, controllerHome, repoRoot, linked, repository, target, current, cleanup };
  }

  test('previews exact clean detached checkout then removes with matching Git/physical witnesses and Registry receipt', () => {
    const fx = fixture();
    const before = fx.current();
    const preview = fx.cleanup();
    expect(preview.status).toBe('preview');
    expect(preview.execution?.approvalToken).toBeTruthy();
    expect(existsSync(fx.linked)).toBe(true);
    expect(() => fx.cleanup({ confirmCleanup: true })).toThrow('GIT_WORKTREE_PREVIEW_PROOF_REQUIRED');
    expect(() =>
      fx.cleanup({
        confirmCleanup: true,
        expectedHead: preview.expectedHead,
        expectedIdentity: preview.physicalIdentity,
        previewToken: 'deliberately-wrong-preview-token',
      }),
    ).toThrow('GIT_WORKTREE_APPROVAL_TOKEN_STALE');
    expect(existsSync(fx.linked)).toBe(true);
    const result = fx.cleanup({
      expectedHead: preview.expectedHead,
      expectedIdentity: preview.physicalIdentity,
      previewToken: preview.execution?.approvalToken,
      confirmCleanup: true,
    });
    expect(result.status).toBe('removed');
    expect(existsSync(fx.linked)).toBe(false);
    expect(gitOutput(fx.repoRoot, ['worktree', 'list', '--porcelain'])).not.toContain(fx.linked);
    const after = fx.current();
    expect(after.canonicalRoot).toBe(before.canonicalRoot);
    expect(after.displayName).toBe(before.displayName);
    expect(after.activeCheckoutId).toBe(before.activeCheckoutId);
    expect(after.checkouts.find((item) => item.checkoutId === fx.target.checkoutId)?.lifecycle).toBe('removed');
    expect(fx.cleanup().status).toBe('already_removed');
  });

  test('fails closed for active/primary target, stale proofs, dirty content, and nonmerged detached commits', () => {
    const fx = fixture();
    expect(() =>
      repositoryGitRemoveWorktree(fx.controllerHome, fx.current(), {
        checkoutId: fx.repository.activeCheckoutId,
      }),
    ).toThrow('GIT_WORKTREE_PRIMARY_OR_ACTIVE_PROTECTED');
    const preview = fx.cleanup();
    expect(() =>
      fx.cleanup({
        expectedHead: '0'.repeat(40),
        expectedIdentity: preview.physicalIdentity,
        previewToken: preview.execution?.approvalToken,
        confirmCleanup: true,
      }),
    ).toThrow('GIT_WORKTREE_STALE_HEAD');
    expect(() =>
      fx.cleanup({
        expectedHead: preview.expectedHead,
        expectedIdentity: 'reused:inode',
        previewToken: preview.execution?.approvalToken,
        confirmCleanup: true,
      }),
    ).toThrow('GIT_WORKTREE_PHYSICAL_IDENTITY_CHANGED');
    writeFileSync(join(fx.linked, 'untracked.txt'), 'preserve');
    expect(() => fx.cleanup()).toThrow('GIT_WORKTREE_DIRTY_PROTECTED');
    expect(existsSync(join(fx.linked, 'untracked.txt'))).toBe(true);
    rmSync(join(fx.linked, 'untracked.txt'));
    writeFileSync(join(fx.linked, 'unique.txt'), 'unique');
    git(fx.linked, ['add', 'unique.txt']);
    git(fx.linked, ['commit', '-m', 'detached unique evidence']);
    expect(() => fx.cleanup()).toThrow('GIT_WORKTREE_UNMERGED_HEAD_PROTECTED');
    expect(existsSync(fx.linked)).toBe(true);
  });

  test('rejects an in-flight external Git HEAD writer without deleting its checkout', () => {
    const fx = fixture();
    const preview = fx.cleanup();
    const adminRoot = gitOutput(fx.linked, ['rev-parse', '--absolute-git-dir']);
    const headLock = join(adminRoot, 'HEAD.lock');
    const fd = openSync(headLock, 'wx', 0o600);
    try {
      const attempted = spawnSync(
        'git',
        ['-C', fx.linked, 'commit', '--allow-empty', '-m', 'concurrent git head writer'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(attempted.status).not.toBe(0);
      expect(String(attempted.stderr)).toContain('HEAD.lock');
      expect(() =>
        fx.cleanup({
          confirmCleanup: true,
          expectedHead: preview.expectedHead,
          expectedIdentity: preview.physicalIdentity,
          previewToken: preview.execution?.approvalToken,
        }),
      ).toThrow('GIT_WORKTREE_HEAD_LOCK_HELD');
      expect(existsSync(fx.linked)).toBe(true);
      expect(gitOutput(fx.linked, ['rev-parse', 'HEAD'])).toBe(preview.expectedHead);
    } finally {
      closeSync(fd);
      unlinkSync(headLock);
    }
    expect(
      fx.cleanup({
        confirmCleanup: true,
        expectedHead: preview.expectedHead,
        expectedIdentity: preview.physicalIdentity,
        previewToken: preview.execution?.approvalToken,
      }).status,
    ).toBe('removed');
    expect(existsSync(fx.linked)).toBe(false);
  });

  test('reconciles a registered checkout already removed from Git even when another owned worktree exists', () => {
    const fx = fixture();
    const unrelatedOwned = join(fx.root, 'unrelated-owned-worktree');
    mkdirSync(unrelatedOwned, { recursive: true });
    recordOwnedResource(fx.controllerHome, {
      resourceId: 'unrelated-owned-worktree',
      kind: 'worktree',
      targetRef: unrelatedOwned,
      creator: 'forge:managed-workspace',
      repoId: fx.repository.repoId,
    });

    git(fx.repoRoot, ['worktree', 'remove', fx.linked]);
    expect(existsSync(fx.linked)).toBe(false);
    expect(gitOutput(fx.repoRoot, ['worktree', 'list', '--porcelain'])).not.toContain(fx.linked);

    const result = fx.cleanup();
    expect(result.status).toBe('already_removed');
    expect(fx.current().checkouts.find((item) => item.checkoutId === fx.target.checkoutId)?.lifecycle).toBe('removed');
  });

  test('does not delete an explicitly Forge-owned linked worktree, even if its HEAD is merged and tree is clean', () => {
    const fx = fixture();
    recordOwnedResource(fx.controllerHome, {
      resourceId: 'worktree-owned-by-other-task',
      kind: 'worktree',
      targetRef: fx.linked,
      creator: 'forge:managed-workspace',
      repoId: fx.repository.repoId,
    });
    expect(() => fx.cleanup()).toThrow('GIT_WORKTREE_OWNED_RESOURCE_PROTECTED');
    expect(existsSync(fx.linked)).toBe(true);
    expect(fx.current().checkouts.find((item) => item.checkoutId === fx.target.checkoutId)?.lifecycle).toBe('active');
  });
});

test('macOS temporary repository and Controller Home aliases are accepted consistently', () => {
  if (process.platform !== 'darwin') return;
  const root = tempRoot('forge-macos-temp-alias-');
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  const registered = seedRepo(controllerHome, repoRoot);
  expect(registered.canonicalRoot).toBe(realpathSync(repoRoot));
});

function listLocalJobIds(repoRoot: string): string[] {
  const jobsDir = join(repoRoot, '.ai/harness/local-jobs');
  if (!existsSync(jobsDir)) return [];
  return readdirSync(jobsDir).filter((name) => name.startsWith('JOB-'));
}

afterEach(async () => {
  for (const child of tracked.splice(0)) {
    if (child.pid) await terminateProcessTree(child.pid, { gracePeriodMs: 50, killAfterMs: 300, pollIntervalMs: 25 });
  }
  await terminateProcessesByCommand(roots);
  await waitForNoProcessesByCommand(roots);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('repository command execution lifecycle', () => {
  test('accepts explicit long timeouts up to the shared agent maximum and rejects above it', () => {
    const controllerHome = tempRoot('forge-cmd-timeout-home-');
    const repoRoot = tempRoot('forge-cmd-timeout-repo-');
    const repository = seedRepo(controllerHome, repoRoot);

    expect(REPOSITORY_COMMAND_MAX_TIMEOUT_MS).toBe(MAX_AGENT_TIMEOUT_MS);
    expect(REPOSITORY_COMMAND_MIN_TIMEOUT_MS).toBe(MIN_AGENT_TIMEOUT_MS);
    expect(REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS).toBe(120_000);

    const longOk = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MAX_AGENT_TIMEOUT_MS,
    });
    expect(longOk.execution.status).toBe('preview');

    const minOk = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MIN_AGENT_TIMEOUT_MS,
    });
    expect(minOk.execution.status).toBe('preview');

    expect(() =>
      previewRepositoryCommandExecution(repository, {
        command: "printf 'ready\\n'",
        dryRun: true,
        timeoutMs: MAX_AGENT_TIMEOUT_MS + 1,
      }),
    ).toThrow(/COMMAND_OPTION_INVALID/);

    expect(() =>
      previewRepositoryCommandExecution(repository, {
        command: "printf 'ready\\n'",
        dryRun: true,
        timeoutMs: MIN_AGENT_TIMEOUT_MS - 1,
      }),
    ).toThrow(/COMMAND_OPTION_INVALID/);

    expect(() =>
      previewRepositoryCommandExecution(repository, {
        command: "printf 'ready\\n'",
        dryRun: true,
        timeoutMs: 13 * 60 * 60 * 1000,
      }),
    ).toThrow(String(MAX_AGENT_TIMEOUT_MS));

    const withDefault = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
    });
    expect(withDefault.execution.status).toBe('preview');
  });

  test('short readonly command executes without Process or Lease writer authority', async () => {
    const controllerHome = tempRoot('forge-cmd-read-home-');
    const repoRoot = tempRoot('forge-cmd-read-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const owner = acquireRuntimeOwnership(controllerHome, 'other-runtime-owner');
    try {
      const execution = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command: ['git', 'status', '--short'],
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      expect(execution.route).toBe('process_direct');
      expect(execution.ok).toBe(true);
      expect(execution.process).toBeUndefined();
      expect(execution.stderr).not.toContain('runtime-authority@runtime-fence');
      expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);

      const shellForm = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command: 'git status --short',
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      expect(shellForm.route).toBe('process_direct');
      expect(shellForm.reason).toBe('readonly_fast_path');
      expect(shellForm.ok).toBe(true);
      expect(shellForm.process).toBeUndefined();
      expect(shellForm.executionMetrics).toMatchObject({
        lane: 'ephemeral_direct',
        durableWrites: 0,
        leaseOperations: 0,
      });
      expect(shellForm.stderr).not.toContain('runtime-authority@runtime-fence');
      expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    } finally {
      owner.release();
    }
  });

  test('raw git commits allow native scope while selected-path commits isolate unrelated staged work', async () => {
    const route = (command: string[] | string) => classifyRepositoryCommandRoute(command);
    expect(route(['git', 'commit', '-m', 'staged index'])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route("git commit -m 'staged index shell'")).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route(['bash', '-lc', "git commit -m 'wrapped staged index'"])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route("git add . && git commit -m 'compound native'")).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route(['git', 'commit', '--only', '-m', 'safe', '--', 'README.md'])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(
      route(['git', 'commit', '-m', 'safe argv pathspec', '--', 'README.md', 'docs/forge-plugin-management.md']),
    ).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route("git commit -m 'safe shell pathspec' -- README.md docs/forge-plugin-management.md")).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route(['bash', '-lc', "git commit -m 'safe wrapped pathspec' -- README.md"])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route(['bash', '-lc', "rg -n 'git commit' src tests"])).toEqual({
      route: 'process_direct',
      reason: 'readonly_fast_path',
    });
    expect(route(['git', 'commit', '-a', '-m', 'tracked files', '--', 'README.md'])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route("git commit --include -m 'native scope' -- README.md")).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route(['git', 'commit', '--amend', '--no-edit'])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route(['git', 'commit', '--patch'])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(classifyRepositoryCommand(['git', 'reset', '--hard'], 'main')).toMatchObject({
      risk: 'destructive',
      confirmation: 'strong_confirmation',
    });
    expect(classifyRepositoryCommand(['git', 'push', '--force', 'origin', 'HEAD'], 'main')).toMatchObject({
      risk: 'destructive',
      confirmation: 'strong_confirmation',
    });

    const controllerHome = tempRoot('forge-selected-commit-home-');
    const repoRoot = tempRoot('forge-selected-commit-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');

    writeFileSync(join(repoRoot, 'staged-only.txt'), 'staged\n');
    writeFileSync(join(repoRoot, 'unstaged-only.txt'), 'unstaged\n');
    git(repoRoot, ['add', 'staged-only.txt']);
    const stagedCommit = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['git', 'commit', '-m', 'commit staged index only'],
      timeoutMs: 10_000,
      executionIdentity: executionIdentityForRepository(repository),
    });
    const stagedCommitTerminal = stagedCommit.process?.completed
      ? stagedCommit.process
      : stagedCommit.process
        ? await waitRepositoryCommandProcess(controllerHome, repository.repoId, stagedCommit.process.processId, {
            timeoutMs: 10_000,
          })
        : undefined;
    expect(stagedCommitTerminal?.ok ?? stagedCommit.ok).toBe(true);
    expect(
      gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean),
    ).toEqual(['staged-only.txt']);
    expect(gitOutput(repoRoot, ['status', '--short'])).toContain('?? unstaged-only.txt');

    writeFileSync(join(repoRoot, 'README.md'), 'selected change\n');
    writeFileSync(join(repoRoot, 'other.txt'), 'other staged change\n');
    git(repoRoot, ['add', 'other.txt']);

    const held = acquireControllerLock(
      controllerHome,
      { scope: 'worktree', repoId: repository.repoId, worktreeId: repository.activeCheckoutId },
      'concurrent-controller',
    );
    try {
      expect(() =>
        commitSelectedPaths(controllerHome, repository, { paths: ['README.md'], message: 'selected only' }),
      ).toThrow(/LOCK_HELD/);
    } finally {
      releaseControllerLock(
        controllerHome,
        { scope: 'worktree', repoId: repository.repoId, worktreeId: repository.activeCheckoutId },
        held.lockId,
      );
    }

    const headBeforeReviewGuard = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    expect(() =>
      commitSelectedPaths(controllerHome, repository, {
        paths: ['README.md'],
        message: 'review gate must stop this commit',
        beforeCommitGuard: ({ requestedPaths, stagedPaths, currentHead }) => {
          expect(requestedPaths).toEqual(['README.md']);
          expect(stagedPaths).toEqual(['README.md']);
          expect(currentHead).toBe(headBeforeReviewGuard);
          throw new Error('TEST_IMPLEMENTATION_REVIEW_BLOCKED');
        },
      }),
    ).toThrow('TEST_IMPLEMENTATION_REVIEW_BLOCKED');
    expect(gitOutput(repoRoot, ['rev-parse', 'HEAD'])).toBe(headBeforeReviewGuard);
    expect(gitOutput(repoRoot, ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean).sort()).toEqual([
      'README.md',
      'other.txt',
    ]);

    const committed = commitSelectedPaths(controllerHome, repository, {
      paths: ['README.md'],
      message: 'selected only',
    });
    expect(committed.error).toBeUndefined();
    expect(committed.commit?.ok).toBe(true);
    expect(
      gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean),
    ).toEqual(['README.md']);
    expect(gitOutput(repoRoot, ['diff', '--cached', '--name-only'])).toBe('other.txt');
  });

  test('two awaited path-scoped editors overlap without repository lock and preserve conflict fencing (#713)', async () => {
    const controllerHome = tempRoot('forge-713-async-writers-home-');
    const repoRoot = tempRoot('forge-713-async-writers-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const alpha = [{ resourceKey: `path:${repository.activeCheckoutId}:README.md`, mode: 'write' as const }];
    const beta = [{ resourceKey: `path:${repository.activeCheckoutId}:other.txt`, mode: 'write' as const }];
    let notifyStarted: (() => void) | undefined;
    let releaseAlpha: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const writerA = withRepositoryMutationExclusionAsync(
      controllerHome,
      repository.repoId,
      'async-alpha',
      async () => {
        notifyStarted?.();
        await hold;
        writeFileSync(join(repoRoot, 'README.md'), 'alpha wrote\n');
        return 'alpha';
      },
      undefined,
      alpha,
    );
    try {
      await started;
      const held = listActiveLeases(controllerHome, repository.repoId);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ checkoutId: repository.activeCheckoutId });
      const writerB = await withRepositoryMutationExclusionAsync(
        controllerHome,
        repository.repoId,
        'async-beta',
        async () => {
          writeFileSync(join(repoRoot, 'other.txt'), 'beta wrote\n');
          return 'beta';
        },
        undefined,
        beta,
      );
      expect(writerB).toBe('beta');
      expect(readFileSync(join(repoRoot, 'other.txt'), 'utf8')).toBe('beta wrote\n');
      await expect(
        withRepositoryMutationExclusionAsync(
          controllerHome,
          repository.repoId,
          'async-conflict',
          async () => 'unsafe',
          undefined,
          alpha,
        ),
      ).rejects.toThrow('REPOSITORY_PROCESS_LEASE_HELD');
      await expect(
        withRepositoryMutationExclusionAsync(controllerHome, repository.repoId, 'legacy-async', async () => 'unsafe'),
      ).rejects.toThrow('REPOSITORY_PROCESS_LEASE_HELD');
      await expect(
        withRepositoryMutationExclusionAsync(
          controllerHome,
          repository.repoId,
          'unscoped-async',
          async () => 'unsafe',
          undefined,
          [{ resourceKey: 'path:README.md', mode: 'write' }],
        ),
      ).rejects.toThrow('REPOSITORY_PROCESS_LEASE_HELD');
      expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(1);
    } finally {
      releaseAlpha?.();
      expect(await writerA).toBe('alpha');
    }
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('alpha wrote\n');
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    await expect(
      withRepositoryMutationExclusionAsync(
        controllerHome,
        repository.repoId,
        'async-throws',
        async () => {
          throw new Error('EXPECTED_ASYNC_WRITE_FAILURE');
        },
        undefined,
        beta,
      ),
    ).rejects.toThrow('EXPECTED_ASYNC_WRITE_FAILURE');
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('exact-path commit ignores unrelated Process source ownership but retains path/index fences (#713)', () => {
    const controllerHome = tempRoot('forge-713-selected-commit-home-');
    const repoRoot = tempRoot('forge-713-selected-commit-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const opts = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    const acquire = (owner: string, key: string) =>
      acquireExecutionLeases(controllerHome, repository.repoId, owner, [{ resourceKey: key, mode: 'write' }], opts);

    writeFileSync(join(repoRoot, 'README.md'), 'new reviewed content\n');
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'foreign untracked dirty\n');
    const unrelated = acquire('foreign-unrelated', `path:${repository.activeCheckoutId}:unrelated.txt`);
    expect(unrelated.acquired).toBe(true);
    try {
      const committed = commitSelectedPaths(controllerHome, repository, {
        paths: ['README.md'],
        message: 'only README',
      });
      expect(committed.error).toBeUndefined();
      expect(committed.commit?.ok).toBe(true);
      expect(gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD'])).toBe('README.md');
      expect(readFileSync(join(repoRoot, 'unrelated.txt'), 'utf8')).toBe('foreign untracked dirty\n');
      expect(
        listActiveLeases(controllerHome, repository.repoId).some((lease) => lease.ownerJobId === 'foreign-unrelated'),
      ).toBe(true);
    } finally {
      if (unrelated.acquired)
        releaseExecutionLeases(controllerHome, repository.repoId, 'foreign-unrelated', unrelated.leases, opts);
    }

    writeFileSync(join(repoRoot, 'README.md'), 'another reviewed change\n');
    for (const key of [
      `path:${repository.activeCheckoutId}:README.md`,
      `git-index:${repository.activeCheckoutId}`,
      `git-refs:${repository.repoId}`,
    ]) {
      const held = acquire('foreign-overlap', key);
      expect(held.acquired).toBe(true);
      try {
        expect(() =>
          commitSelectedPaths(controllerHome, repository, {
            paths: ['README.md'],
            message: 'must not race',
          }),
        ).toThrow('REPOSITORY_PROCESS_LEASE_HELD');
      } finally {
        if (held.acquired)
          releaseExecutionLeases(controllerHome, repository.repoId, 'foreign-overlap', held.leases, opts);
      }
    }
  });

  test('exact patch commit preserves foreign hunks in the same file and unrelated staged paths (#716)', () => {
    const controllerHome = tempRoot('forge-716-exact-patch-home-');
    const repoRoot = tempRoot('forge-716-exact-patch-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');

    const base = [
      'function alpha() {',
      "  return 'alpha-base';",
      '}',
      '',
      '// spacer 01',
      '// spacer 02',
      '// spacer 03',
      '// spacer 04',
      '// spacer 05',
      '// spacer 06',
      '// spacer 07',
      '// spacer 08',
      '',
      'function beta() {',
      "  return 'beta-base';",
      '}',
      '',
    ].join('\n');
    writeFileSync(join(repoRoot, 'README.md'), base);
    git(repoRoot, ['add', 'README.md']);
    git(repoRoot, ['commit', '-m', 'seed exact patch file']);

    const owned = base.replace("'alpha-base'", "'alpha-owned'");
    writeFileSync(join(repoRoot, 'README.md'), owned);
    const exactPatch = gitRawOutput(repoRoot, ['diff', '--binary', '--', 'README.md']);
    expect(exactPatch).toContain('alpha-owned');
    expect(exactPatch).not.toContain('beta-foreign');

    const combined = owned.replace("'beta-base'", "'beta-foreign'");
    writeFileSync(join(repoRoot, 'README.md'), combined);
    writeFileSync(join(repoRoot, 'other.txt'), 'foreign staged\n');
    git(repoRoot, ['add', 'other.txt']);

    const committed = commitSelectedPatch(controllerHome, repository, {
      paths: ['README.md'],
      patch: exactPatch,
      message: 'commit only alpha hunk',
    });
    expect(committed.error).toBeUndefined();
    expect(committed.attempts).toBe(1);
    expect(committed.patchPaths).toEqual(['README.md']);
    expect(gitRawOutput(repoRoot, ['show', 'HEAD:README.md'])).toContain("'alpha-owned'");
    expect(gitRawOutput(repoRoot, ['show', 'HEAD:README.md'])).toContain("'beta-base'");
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toContain("'beta-foreign'");

    const residual = gitRawOutput(repoRoot, ['diff', '--unified=0', '--', 'README.md']);
    expect(residual).toContain('beta-foreign');
    expect(residual).not.toContain('alpha-base');
    expect(gitOutput(repoRoot, ['diff', '--cached', '--name-only'])).toBe('other.txt');
    expect(gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD'])).toBe('README.md');
  });

  test('exact patch commit retries a concurrent ref advance without redoing source edits (#716)', () => {
    const controllerHome = tempRoot('forge-716-ref-cas-home-');
    const repoRoot = tempRoot('forge-716-ref-cas-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');

    writeFileSync(join(repoRoot, 'README.md'), 'race-base\n');
    git(repoRoot, ['add', 'README.md']);
    git(repoRoot, ['commit', '-m', 'seed ref race']);
    writeFileSync(join(repoRoot, 'README.md'), 'race-owned\n');
    const exactPatch = gitRawOutput(repoRoot, ['diff', '--binary', '--', 'README.md']);
    let advanced = false;

    const committed = commitSelectedPatch(controllerHome, repository, {
      paths: ['README.md'],
      patch: exactPatch,
      message: 'exact commit after ref race',
      beforeRefUpdateGuard: ({ attempt }) => {
        if (attempt !== 1 || advanced) return;
        advanced = true;
        git(repoRoot, ['commit', '--allow-empty', '-m', 'foreign ref advance']);
      },
    });

    expect(advanced).toBe(true);
    expect(committed.error).toBeUndefined();
    expect(committed.attempts).toBe(2);
    expect(gitOutput(repoRoot, ['log', '-2', '--pretty=%s']).split(/\r?\n/)).toEqual([
      'exact commit after ref race',
      'foreign ref advance',
    ]);
    expect(gitOutput(repoRoot, ['show', 'HEAD:README.md'])).toBe('race-owned');
    expect(gitOutput(repoRoot, ['status', '--short', '--', 'README.md'])).toBe('');
  });

  test('exact patch rejects out-of-scope files before ref mutation (#716)', () => {
    const controllerHome = tempRoot('forge-716-patch-scope-home-');
    const repoRoot = tempRoot('forge-716-patch-scope-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');

    writeFileSync(join(repoRoot, 'other.txt'), 'other-base\n');
    git(repoRoot, ['add', 'other.txt']);
    git(repoRoot, ['commit', '-m', 'seed scope files']);
    const beforeHead = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoRoot, 'README.md'), 'hello-owned\n');
    writeFileSync(join(repoRoot, 'other.txt'), 'other-owned\n');
    const patch = gitRawOutput(repoRoot, ['diff', '--binary', '--', 'README.md', 'other.txt']);

    expect(() =>
      commitSelectedPatch(controllerHome, repository, {
        paths: ['README.md'],
        patch,
        message: 'must not cross scope',
      }),
    ).toThrow('SELECTED_PATCH_SCOPE_DENIED');
    expect(gitOutput(repoRoot, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('hello-owned\n');
    expect(readFileSync(join(repoRoot, 'other.txt'), 'utf8')).toBe('other-owned\n');
  });

  test('exact patch localizes a changed target as a worktree conflict without ref mutation (#716)', () => {
    const controllerHome = tempRoot('forge-716-patch-conflict-home-');
    const repoRoot = tempRoot('forge-716-patch-conflict-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');

    const beforeHead = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoRoot, 'README.md'), 'owned-version\n');
    const patch = gitRawOutput(repoRoot, ['diff', '--binary', '--', 'README.md']);
    writeFileSync(join(repoRoot, 'README.md'), 'different-writer-version\n');

    expect(() =>
      commitSelectedPatch(controllerHome, repository, {
        paths: ['README.md'],
        patch,
        message: 'conflicting exact patch',
      }),
    ).toThrow('SELECTED_PATCH_WORKTREE_CHANGED');
    expect(gitOutput(repoRoot, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('different-writer-version\n');
  });

  test('reviewed selected-path restore shares checkout with unrelated Process but observes index/ref (#713)', () => {
    const controllerHome = tempRoot('forge-713-selected-restore-home-');
    const repoRoot = tempRoot('forge-713-selected-restore-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const opts = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    const acquire = (owner: string, key: string) =>
      acquireExecutionLeases(controllerHome, repository.repoId, owner, [{ resourceKey: key, mode: 'write' }], opts);
    const preview = () => selectedPathDiff(repository, { paths: ['README.md'], staged: false, maxBytes: 20_000 });
    const restore = (reviewed: ReturnType<typeof preview>) =>
      restoreSelectedPaths(controllerHome, repository, {
        paths: ['README.md'],
        expectedHead: reviewed.head,
        expectedBranch: reviewed.branch,
        expectedPatch: reviewed.diff,
        confirmAuthorization: true,
      });

    writeFileSync(join(repoRoot, 'README.md'), 'reviewed rollback\n');
    const reviewed = preview();
    const unrelated = acquire('foreign-restore-unrelated', `path:${repository.activeCheckoutId}:other.txt`);
    expect(unrelated.acquired).toBe(true);
    try {
      const result = restore(reviewed);
      expect(result.error).toBeUndefined();
      expect(result.execution?.ok).toBe(true);
      expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('hello\n');
    } finally {
      if (unrelated.acquired)
        releaseExecutionLeases(controllerHome, repository.repoId, 'foreign-restore-unrelated', unrelated.leases, opts);
    }

    writeFileSync(join(repoRoot, 'README.md'), 'must preserve until lease exits\n');
    const nextReview = preview();
    for (const key of [
      `path:${repository.activeCheckoutId}:README.md`,
      `git-index:${repository.activeCheckoutId}`,
      `git-refs:${repository.repoId}`,
    ]) {
      const held = acquire('foreign-restore-overlap', key);
      expect(held.acquired).toBe(true);
      try {
        expect(() => restore(nextReview)).toThrow('REPOSITORY_PROCESS_LEASE_HELD');
        expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('must preserve until lease exits\n');
      } finally {
        if (held.acquired)
          releaseExecutionLeases(controllerHome, repository.repoId, 'foreign-restore-overlap', held.leases, opts);
      }
    }
  });

  test('reviewed selected-path restore discards only exact tracked unstaged changes and rejects stale or staged scope', () => {
    const controllerHome = tempRoot('forge-selected-restore-home-');
    const repoRoot = tempRoot('forge-selected-restore-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');

    writeFileSync(join(repoRoot, 'README.md'), 'reviewed restore\n');
    const reviewed = selectedPathDiff(repository, { paths: ['README.md'], staged: false, maxBytes: 20_000 });
    expect(reviewed.diff).not.toBe('');
    const restored = restoreSelectedPaths(controllerHome, repository, {
      paths: ['README.md'],
      expectedHead: reviewed.head,
      expectedBranch: reviewed.branch,
      expectedPatch: reviewed.diff,
      confirmAuthorization: true,
    });
    expect(restored.error).toBeUndefined();
    expect(restored.execution?.ok).toBe(true);
    expect(gitOutput(repoRoot, ['diff', '--', 'README.md'])).toBe('');

    writeFileSync(join(repoRoot, 'README.md'), 'staged restore must fail\n');
    const stagedReview = selectedPathDiff(repository, { paths: ['README.md'], staged: false, maxBytes: 20_000 });
    git(repoRoot, ['add', 'README.md']);
    expect(() =>
      restoreSelectedPaths(controllerHome, repository, {
        paths: ['README.md'],
        expectedHead: stagedReview.head,
        expectedBranch: stagedReview.branch,
        expectedPatch: stagedReview.diff,
        confirmAuthorization: true,
      }),
    ).toThrow('SELECTED_PATH_RESTORE_STAGED_CHANGES');
    git(repoRoot, ['restore', '--staged', '--', 'README.md']);

    const stale = selectedPathDiff(repository, { paths: ['README.md'], staged: false, maxBytes: 20_000 });
    writeFileSync(join(repoRoot, 'README.md'), 'changed after review\n');
    expect(() =>
      restoreSelectedPaths(controllerHome, repository, {
        paths: ['README.md'],
        expectedHead: stale.head,
        expectedBranch: stale.branch,
        expectedPatch: stale.diff,
        confirmAuthorization: true,
      }),
    ).toThrow('SELECTED_PATH_RESTORE_PATCH_CHANGED');
  });

  test('work-free native git -a, chained add/commit and amend execute without taking unrelated untracked files', async () => {
    const controllerHome = tempRoot('forge-agent-git-home-');
    const repoRoot = tempRoot('forge-agent-git-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');

    const execute = async (command: string | string[]) => {
      const result = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command,
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      const terminal = result.process?.completed
        ? result.process
        : result.process
          ? await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process.processId, {
              timeoutMs: 10_000,
            })
          : undefined;
      expect(terminal?.ok ?? result.ok).toBe(true);
    };

    writeFileSync(join(repoRoot, 'README.md'), 'tracked edit\n');
    writeFileSync(join(repoRoot, 'untracked.txt'), 'preserve me\n');
    await execute(['git', 'commit', '-am', 'tracked edit']);
    expect(gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD'])).toBe('README.md');
    expect(gitOutput(repoRoot, ['status', '--short'])).toContain('?? untracked.txt');

    writeFileSync(join(repoRoot, 'new-file.txt'), 'explicitly selected\n');
    await execute("git add new-file.txt && git commit -m 'native chained commit'");
    expect(gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD'])).toBe('new-file.txt');
    expect(gitOutput(repoRoot, ['status', '--short'])).toContain('?? untracked.txt');

    const previousHead = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoRoot, 'new-file.txt'), 'amended\n');
    git(repoRoot, ['add', 'new-file.txt']);
    await execute(['git', 'commit', '--amend', '--no-edit']);
    expect(gitOutput(repoRoot, ['rev-parse', 'HEAD'])).not.toBe(previousHead);
    expect(gitOutput(repoRoot, ['status', '--short'])).toContain('?? untracked.txt');
  });

  test('routes fixed shell diagnostics and ordinary local scripts without weakening external boundaries', () => {
    const route = (command: string[]) => classifyRepositoryCommandRoute(command);
    expect(route(['bash', '-lc', 'curl -fsS http://127.0.0.1:8765/ready'])).toEqual({
      route: 'process_direct',
      reason: 'readonly_fast_path',
    });
    expect(route(['bash', '-lc', 'curl -fsS http://127.0.0.1:8765/ready >/dev/null'])).toEqual({
      route: 'process_direct',
      reason: 'readonly_fast_path',
    });
    for (const payload of [
      'curl -fsS http://127.0.0.1:8765/ready > marker.txt',
      'curl -fsS -X POST http://127.0.0.1:8765/ready',
      'curl -fsS -d payload http://127.0.0.1:8765/ready',
      'curl -fsS https://example.com/',
    ])
      expect(route(['bash', '-lc', payload])).toEqual({
        route: 'process_managed',
        reason: 'workspace_write_requires_process_lease',
      });
    for (const payload of ['printf local > marker.txt', 'bun -e "console.log(1)"'])
      expect(route(['bash', '-lc', payload])).toEqual({ route: 'process_direct', reason: 'local_workspace_direct' });
    expect(route(['bun', '-e', 'await fetch("http://127.0.0.1:8765/ready")'])).toEqual({
      route: 'process_managed',
      reason: 'workspace_write_requires_process_lease',
    });
    expect(route(['touch', 'marker.txt'])).toEqual({ route: 'process_direct', reason: 'local_workspace_direct' });
  });

  test('readonly direct execution exposes unobserved mutation evidence without taking before/after snapshots', async () => {
    const controllerHome = tempRoot('forge-cmd-read-snapshot-home-');
    const repoRoot = tempRoot('forge-cmd-read-snapshot-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const result = await executeRepositoryReadOnlyCommandDirect(repository, {
      command: ['git', 'status', '--short'],
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.before.mutationEvidence).toBe('readonly_unobserved');
    expect(result.after).toBe(result.before);
    expect(result.repositoryChanged).toBe(false);
    expect(result.changedPaths).toEqual([]);
  });

  test('path-bounded git add does not fingerprint unrelated dirty files before spawn', async () => {
    const controllerHome = tempRoot('forge-cmd-bounded-snapshot-home-');
    const repoRoot = tempRoot('forge-cmd-bounded-snapshot-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    for (const name of ['target.txt', 'unrelated-a.txt', 'unrelated-b.txt'])
      writeFileSync(join(repoRoot, name), 'base\n');
    git(repoRoot, ['add', 'target.txt', 'unrelated-a.txt', 'unrelated-b.txt']);
    git(repoRoot, ['commit', '-m', 'add bounded snapshot fixture']);
    for (const name of ['target.txt', 'unrelated-a.txt', 'unrelated-b.txt'])
      writeFileSync(join(repoRoot, name), `changed:${name}\n`);

    const result = await executeRepositoryCommandAsync(controllerHome, repository, {
      command: ['git', 'add', '--', 'target.txt'],
      timeoutMs: 10_000,
      snapshotFingerprintTimeoutMs: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceError).toBeUndefined();
    expect(result.repositoryChanged).toBe(true);
    expect(result.changedPaths).toEqual(['target.txt']);
    expect(gitOutput(repoRoot, ['diff', '--cached', '--name-only'])).toBe('target.txt');
    expect(gitOutput(repoRoot, ['diff', '--name-only']).split(/\r?\n/).filter(Boolean).sort()).toEqual([
      'unrelated-a.txt',
      'unrelated-b.txt',
    ]);
  });

  test('more than 200 unrelated dirty paths do not block a scoped command or widen its evidence', async () => {
    const controllerHome = tempRoot('forge-cmd-large-scoped-home-');
    const repoRoot = tempRoot('forge-cmd-large-scoped-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    writeFileSync(join(repoRoot, 'target.txt'), 'base\n');
    writeFileSync(join(repoRoot, 'write-target.mjs'), "await Bun.write('target.txt', 'after\\n');");
    git(repoRoot, ['add', 'target.txt', 'write-target.mjs']);
    git(repoRoot, ['commit', '-m', 'add scoped fingerprint fixture']);
    writeFileSync(join(repoRoot, 'target.txt'), 'before\n');
    for (let index = 0; index < 205; index += 1) {
      writeFileSync(join(repoRoot, 'unrelated-' + index + '.txt'), 'dirty\n');
    }

    const result = await executeRepositoryCommandAsync(controllerHome, repository, {
      command: [process.execPath, 'write-target.mjs'],
      mutationPaths: ['target.txt'],
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.before.paths.length).toBeGreaterThan(200);
    expect(Object.keys(result.before.pathFingerprints)).toEqual(['target.txt']);
    expect(Object.keys(result.after?.pathFingerprints ?? {})).toEqual(['target.txt']);
    expect(result.repositoryChanged).toBe(true);
    expect(result.changedPaths).toEqual(['target.txt']);
    expect(result.evidenceError).toBeUndefined();
    expect(readFileSync(join(repoRoot, 'target.txt'), 'utf-8')).toBe('after\n');
  });

  test('more than 200 dirty paths without a declared scope execute but report unknown mutation evidence', async () => {
    const controllerHome = tempRoot('forge-cmd-large-unscoped-home-');
    const repoRoot = tempRoot('forge-cmd-large-unscoped-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    for (let index = 0; index < 205; index += 1) {
      writeFileSync(join(repoRoot, 'unrelated-' + index + '.txt'), 'dirty\n');
    }

    const result = await executeRepositoryCommandAsync(controllerHome, repository, {
      command: ['touch', 'marker.txt'],
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.before.paths.length).toBeGreaterThan(200);
    expect(result.before.pathFingerprints).toEqual({});
    expect(result.after?.fingerprintScope).toBe('none');
    expect(result.evidenceError?.code).toBe('SNAPSHOT_SCOPE_UNDECLARED');
    expect(result.repositoryChanged).toBeUndefined();
    expect(result.changedPaths).toBeUndefined();
    expect(readFileSync(join(repoRoot, 'marker.txt'), 'utf-8')).toBe('');
  });

  test('post-execution fingerprint timeout preserves child success while marking repository evidence unknown', async () => {
    const controllerHome = tempRoot('forge-cmd-post-evidence-home-');
    const repoRoot = tempRoot('forge-cmd-post-evidence-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    writeFileSync(
      join(repoRoot, 'write-three.mjs'),
      [
        "await Bun.write('evidence-a.txt', 'a\\n');",
        "await Bun.write('evidence-b.txt', 'b\\n');",
        "await Bun.write('evidence-c.txt', 'c\\n');",
      ].join('\n'),
    );
    git(repoRoot, ['add', 'write-three.mjs']);
    git(repoRoot, ['commit', '-m', 'add evidence timeout fixture']);

    const result = await executeRepositoryCommandAsync(controllerHome, repository, {
      command: [process.execPath, 'write-three.mjs'],
      mutationPaths: ['evidence-a.txt', 'evidence-b.txt', 'evidence-c.txt'],
      timeoutMs: 10_000,
      snapshotFingerprintTimeoutMs: 1,
    });

    expect(result).toMatchObject({
      status: 'executed',
      ok: true,
      exitCode: 0,
      repositoryChanged: undefined,
      changedPaths: undefined,
      evidenceError: { code: 'SNAPSHOT_WORKER_TIMEOUT' },
    });
    expect(result.after).toBeDefined();
    expect(result.after?.pathFingerprintError?.code).toBe('SNAPSHOT_WORKER_TIMEOUT');
    expect(readFileSync(join(repoRoot, 'evidence-a.txt'), 'utf-8')).toBe('a\n');
  });

  test('write-capable command execution still reports repository changes', () => {
    const controllerHome = tempRoot('forge-cmd-write-snapshot-home-');
    const repoRoot = tempRoot('forge-cmd-write-snapshot-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const result = executeRepositoryCommand(controllerHome, repository, {
      command: ['touch', 'marker.txt'],
      mutationPaths: ['marker.txt'],
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.before.mutationEvidence).toBe('observed');
    expect(result.after?.mutationEvidence).toBe('observed');
    expect(result.repositoryChanged).toBe(true);
    expect(result.changedPaths).toContain('marker.txt');
  });

  test('ordinary readonly command stays on the direct path without semantic attribution', async () => {
    const controllerHome = tempRoot('forge-cmd-work-read-home-');
    const repoRoot = tempRoot('forge-cmd-work-read-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const processCount = listProcessRecords(controllerHome, repository.repoId).length;
    const result = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['pwd'],
      timeoutMs: 10_000,
      interactiveWaitMs: 1_000,
      executionIdentity: executionIdentityForRepository(repository),
    });
    expect(result).toMatchObject({
      route: 'process_direct',
      reason: 'readonly_fast_path',
      ok: true,
      executionMetrics: { lane: 'ephemeral_direct', durableWrites: 0, leaseOperations: 0 },
    });
    expect(result.process).toBeUndefined();
    expect(listProcessRecords(controllerHome, repository.repoId)).toHaveLength(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    const root = join(processScopeRoot(controllerHome, repository.repoId), 'process-runtime');
    expect(existsSync(join(root, 'lightweight-running'))).toBe(false);
    expect(existsSync(join(root, 'lightweight-terminal'))).toBe(false);
  });

  test('ordinary local write stays direct and does not take a checkout lease', async () => {
    const controllerHome = tempRoot('forge-cmd-local-write-home-');
    const repoRoot = tempRoot('forge-cmd-local-write-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const result = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['touch', 'marker.txt'],
      timeoutMs: 10_000,
      interactiveWaitMs: 1_000,
      executionIdentity: executionIdentityForRepository(repository),
    });
    expect(result).toMatchObject({
      route: 'process_direct',
      reason: 'local_workspace_direct',
      ok: true,
      executionMetrics: { durableWrites: 0, leaseOperations: 0 },
    });
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    expect(existsSync(join(repoRoot, 'marker.txt'))).toBe(true);
  });

  test('long readonly command returns a lightweight handle after the interactive budget and reuses it for the same request', async () => {
    if (process.platform === 'win32') return;
    const controllerHome = tempRoot('forge-cmd-readonly-long-home-');
    const repoRoot = tempRoot('forge-cmd-readonly-long-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const processCount = listProcessRecords(controllerHome, repository.repoId).length;
    const input = {
      controllerHome,
      repository,
      command: ['sleep', '0.5'],
      timeoutMs: 5_000,
      interactiveWaitMs: 25,
      requestId: 'long-readonly-command',
      executionIdentity: executionIdentityForRepository(repository),
    } as const;

    const result = await executeRepositoryCommandViaProcessRuntime(input);
    expect(result.route).toBe('process_managed');
    expect(result.reason).toBe('interactive_budget_exceeded_lightweight_handle');
    expect(result.process?.processId).toStartWith('lightweight:');
    expect(result.process?.completed).toBe(false);
    expect(result.executionMetrics).toMatchObject({
      lane: 'lightweight_managed',
      durableWrites: 0,
      leaseOperations: 0,
    });
    expect(listProcessRecords(controllerHome, repository.repoId)).toHaveLength(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);

    const replay = await executeRepositoryCommandViaProcessRuntime(input);
    expect(replay.process?.processId).toBe(result.process?.processId);
    const terminal = await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, {
      timeoutMs: 5_000,
    });
    expect(terminal).toMatchObject({ completed: true, ok: true });
    expect(listProcessRecords(controllerHome, repository.repoId)).toHaveLength(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('ordinary local shell and inline writes do not create durable checkout lease state (#713)', async () => {
    const controllerHome = tempRoot('forge-cmd-opaque-home-');
    const repoRoot = tempRoot('forge-cmd-opaque-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const processCount = listProcessRecords(controllerHome, repository.repoId).length;
    for (const [command, marker, expected] of [
      [['bash', '-lc', "printf 'shell-lightweight\\n' > shell-marker.txt"], 'shell-marker.txt', 'shell-lightweight\n'],
      [
        ['bun', '-e', "await Bun.write('inline-marker.txt', 'inline-lightweight\\n')"],
        'inline-marker.txt',
        'inline-lightweight\n',
      ],
    ] as const) {
      expect(classifyRepositoryCommandRoute(command).route).toBe('process_direct');
      const result = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command,
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      expect(result.process?.processId.startsWith('lightweight:') ?? true).toBe(true);
      expect(result.executionMetrics).toMatchObject({ durableWrites: 0, leaseOperations: 0 });
      const terminal = result.process
        ? result.process.completed
          ? result.process
          : await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process.processId, {
              timeoutMs: 10_000,
            })
        : result;
      expect(terminal).toMatchObject({ ok: true });
      expect(readFileSync(join(repoRoot, marker), 'utf-8')).toBe(expected);
    }
    expect(listProcessRecords(controllerHome, repository.repoId).length).toBe(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('long ordinary local command uses a lightweight handle without durable lease state (#713)', async () => {
    const controllerHome = tempRoot('forge-cmd-light-home-');
    const repoRoot = tempRoot('forge-cmd-light-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    writeFileSync(
      join(repoRoot, 'slow-command.mjs'),
      'setTimeout(() => { console.log("lightweight-ok"); process.exit(0); }, 300);\n',
    );
    const processCount = listProcessRecords(controllerHome, repository.repoId).length;
    const result = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: [process.execPath, 'slow-command.mjs'],
      timeoutMs: 10_000,
      returnHandleImmediately: true,
      requestId: 'lightweight-command',
      executionIdentity: executionIdentityForRepository(repository),
    });
    expect(result.route).toBe('process_managed');
    expect(result.process?.processId).toStartWith('lightweight:');
    expect(result.executionMetrics).toMatchObject({ durableWrites: 0, leaseOperations: 0 });
    expect(listProcessRecords(controllerHome, repository.repoId).length).toBe(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    const terminal = await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, {
      timeoutMs: 10_000,
    });
    expect(terminal).toMatchObject({ completed: true, ok: true });
    expect(terminal.stdout).toContain('lightweight-ok');
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('real Git fetch proceeds with an unrelated same-checkout source Writer (#713)', async () => {
    const controllerHome = tempRoot('forge-713-fetch-home-');
    const repoRoot = tempRoot('forge-713-fetch-repo-');
    const remoteRoot = tempRoot('forge-713-fetch-remote-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    git(remoteRoot, ['init', '--bare']);
    git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
    git(repoRoot, ['push', 'origin', 'HEAD:refs/heads/main']);
    const headBefore = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    const opts = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    const foreign = acquireExecutionLeases(
      controllerHome,
      repository.repoId,
      'foreign-source-writer',
      [{ resourceKey: `path:${repository.activeCheckoutId}:README.md`, mode: 'write' }],
      opts,
    );
    expect(foreign.acquired).toBe(true);
    try {
      const result = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command: ['git', 'fetch', 'origin'],
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      const terminal = result.process?.completed
        ? result.process
        : result.process
          ? await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process.processId, {
              timeoutMs: 10_000,
            })
          : undefined;
      expect(terminal?.ok ?? result.ok).toBe(true);
      expect(gitOutput(repoRoot, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('hello\n');
      expect(
        listActiveLeases(controllerHome, repository.repoId).some(
          (lease) => lease.ownerJobId === 'foreign-source-writer',
        ),
      ).toBe(true);
    } finally {
      if (foreign.acquired)
        releaseExecutionLeases(controllerHome, repository.repoId, 'foreign-source-writer', foreign.leases, opts);
    }
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('ordinary remote writes execute through managed Process Runtime without external-controller delegation', async () => {
    const controllerHome = tempRoot('forge-cmd-external-home-');
    const repoRoot = tempRoot('forge-cmd-external-repo-');
    const remoteRoot = tempRoot('forge-cmd-external-remote-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    git(remoteRoot, ['init', '--bare']);
    git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
    const command = ['git', 'push', 'origin', 'HEAD:refs/heads/cloud-test'];
    expect(classifyRepositoryCommandRoute(command)).toEqual({
      route: 'process_managed',
      reason: 'effectful_command_managed',
    });
    const result = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command,
      timeoutMs: 10_000,
      executionIdentity: executionIdentityForRepository(repository),
    });
    expect(result.process?.processId).toBeTruthy();
    expect(result.executionMetrics).toMatchObject({ lane: 'durable_process' });
    const terminal = result.process!.completed
      ? result.process!
      : await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, {
          timeoutMs: 10_000,
        });
    expect(terminal).toMatchObject({ completed: true, ok: true });
    expect(gitOutput(remoteRoot, ['rev-parse', 'refs/heads/cloud-test'])).toBe(
      gitOutput(repoRoot, ['rev-parse', 'HEAD']),
    );
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('exact remote branch CAS deletion succeeds despite unrelated checkout writer lease (#469)', async () => {
    const controllerHome = tempRoot('forge-469-remote-home-');
    const repoRoot = tempRoot('forge-469-remote-repo-');
    const remoteRoot = tempRoot('forge-469-remote-bare-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    git(remoteRoot, ['init', '--bare']);
    git(repoRoot, ['remote', 'add', 'origin', remoteRoot]);
    const branch = 'review/closed-pr-469';
    git(repoRoot, ['push', 'origin', 'HEAD:refs/heads/' + branch]);
    const exactHead = gitOutput(remoteRoot, ['rev-parse', 'refs/heads/' + branch]);
    const checkoutHead = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoRoot, 'unrelated-local-edit.txt'), 'preserve owner bytes\n');
    const blocker = 'unrelated-checkout-owner';
    const held = acquireExecutionLeases(
      controllerHome,
      repository.repoId,
      blocker,
      [{ resourceKey: 'workspace:' + repository.activeCheckoutId, mode: 'write' }],
      { visibility: 'ephemeral' },
    );
    expect(held.acquired).toBe(true);
    try {
      // An exact lease that does not match the remote head must never delete it.
      const stale = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command: [
          'git',
          'push',
          '--porcelain',
          '--force-with-lease=refs/heads/' + branch + ':' + 'b'.repeat(40),
          'origin',
          ':refs/heads/' + branch,
        ],
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      const staleTerminal = stale.process!.completed
        ? stale.process!
        : await waitRepositoryCommandProcess(controllerHome, repository.repoId, stale.process!.processId, {
            timeoutMs: 10_000,
          });
      expect(staleTerminal).toMatchObject({ completed: true, ok: false });
      expect(gitOutput(remoteRoot, ['rev-parse', 'refs/heads/' + branch])).toBe(exactHead);

      const result = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command: [
          'git',
          'push',
          '--porcelain',
          '--force-with-lease=refs/heads/' + branch + ':' + exactHead,
          'origin',
          ':refs/heads/' + branch,
        ],
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      expect(result.process?.processId).toBeTruthy();
      const terminal = result.process!.completed
        ? result.process!
        : await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, {
            timeoutMs: 10_000,
          });
      expect(terminal).toMatchObject({ completed: true, ok: true });
      const absent = spawnSync('git', ['ls-remote', remoteRoot, 'refs/heads/' + branch], { encoding: 'utf8' });
      expect(absent.status).toBe(0);
      expect(absent.stdout.trim()).toBe('');
      expect(gitOutput(repoRoot, ['rev-parse', 'HEAD'])).toBe(checkoutHead);
      expect(readFileSync(join(repoRoot, 'unrelated-local-edit.txt'), 'utf8')).toBe('preserve owner bytes\n');
      expect(listActiveLeases(controllerHome, repository.repoId).map((lease) => lease.ownerJobId)).toEqual([blocker]);
    } finally {
      releaseExecutionLeases(controllerHome, repository.repoId, blocker);
    }
  });
});

describe('scoped async lease heartbeat resilience (#713)', () => {
  test('retries a transient global lease-lock collision without poisoning a live path lease', async () => {
    const controllerHome = tempRoot('forge-713-heartbeat-contention-home-');
    const repoRoot = tempRoot('forge-713-heartbeat-contention-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const claims = [{ resourceKey: `path:${repository.activeCheckoutId}:README.md`, mode: 'write' as const }];
    const lockKey = { scope: 'global' as const, resource: 'execution-leases' };

    const result = await withRepositoryMutationExclusionAsync(
      controllerHome,
      repository.repoId,
      'async-heartbeat-transient-contention',
      async () => {
        // Hold the existing lease-store mutex across the first 5s heartbeat.
        // The renewal's single-try lock acquisition must fail transiently,
        // then succeed on the next heartbeat after this short critical section.
        const blocker = acquireControllerLock(controllerHome, lockKey, 'test-heartbeat-contention');
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 7_000));
        } finally {
          releaseControllerLock(controllerHome, lockKey, blocker.lockId);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        return 'completed-after-renewal';
      },
      15_000,
      claims,
    );

    expect(result).toBe('completed-after-renewal');
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  }, 20_000);
});
