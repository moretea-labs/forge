import { afterEach, describe, expect, test } from 'bun:test';
import { seedHistoricalWorkHandle } from '../helpers/historical-work-handle';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS } from '../../src/cli/controller/runtime-config';
import {
  getLocalBridgeJob,
  reconcileLocalBridgeJobs,
} from '../../src/cli/local-bridge/job-store';
import {
  executeRepositoryCommand,
  executeRepositoryCommandAsync,
  executeRepositoryReadOnlyCommandDirect,
  previewRepositoryCommandExecution,
  REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS,
  REPOSITORY_COMMAND_MAX_TIMEOUT_MS,
  REPOSITORY_COMMAND_MIN_TIMEOUT_MS} from '../../src/cli/repositories/command-executor';
import { addRepositoryCheckout, getRepository, registerRepository } from '../../src/cli/repositories/registry';
import { repositoryGitRemoveWorktree } from '../../src/cli/repositories/structured-worktree-cleanup';
import { recordOwnedResource } from '../../packages/kernel/identity/api/index';
import { commitSelectedPaths } from '../../src/cli/repositories/selected-path-actions';
import { acquireControllerLock, releaseControllerLock } from '../../src/cli/repositories/locks';
import { persistControllerAccessMode } from '../../adapters/mcp/access-mode';
import { executionIdentityForRepository } from '../../src/runtime/control-plane/execution/execution-identity';
import { readWorkHandle, WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { classifyRepositoryCommandRoute, executeRepositoryCommandViaProcessRuntime, waitRepositoryCommandProcess } from '../../src/runtime/execution/process-runtime/command-facade';
import { listProcessRecords } from '../../src/runtime/execution/process-runtime/store';
import { getExecutionJob, updateExecutionJob } from '../../src/runtime/execution/jobs/store';
import { waitForExecutionJob } from '../../src/runtime/execution/jobs/wait';
import { executeExecutionJob } from '../../src/runtime/execution/workers/executor';
import { acquireExecutionLeases, listActiveLeases, releaseExecutionLeases, renewExecutionLeases } from '../../src/runtime/resources/leases/store';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { terminateProcessTree } from '../../src/runtime/shared/process-tree';
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from './process-hygiene';
import { trustedEngineeringEvidence } from '../helpers/engineering-evidence';
import { seedHistoricalWorkContract } from '../helpers/historical-work-contract';

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
    stdio: ['ignore', 'pipe', 'pipe']});
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

function gitOutput(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout ?? '').trim();
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
    const cleanup = (input: { expectedHead?: string; expectedIdentity?: string; previewToken?: string; confirmCleanup?: boolean } = {}) =>
      repositoryGitRemoveWorktree(controllerHome, current(), { checkoutId: target.checkoutId, ...input });
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
    expect(() => fx.cleanup({
      confirmCleanup: true,
      expectedHead: preview.expectedHead,
      expectedIdentity: preview.physicalIdentity,
      previewToken: 'deliberately-wrong-preview-token',
    })).toThrow('GIT_WORKTREE_APPROVAL_TOKEN_STALE');
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
    expect(() => repositoryGitRemoveWorktree(fx.controllerHome, fx.current(), {
      checkoutId: fx.repository.activeCheckoutId,
    })).toThrow('GIT_WORKTREE_PRIMARY_OR_ACTIVE_PROTECTED');
    const preview = fx.cleanup();
    expect(() => fx.cleanup({
      expectedHead: '0'.repeat(40),
      expectedIdentity: preview.physicalIdentity,
      previewToken: preview.execution?.approvalToken,
      confirmCleanup: true,
    })).toThrow('GIT_WORKTREE_STALE_HEAD');
    expect(() => fx.cleanup({
      expectedHead: preview.expectedHead,
      expectedIdentity: 'reused:inode',
      previewToken: preview.execution?.approvalToken,
      confirmCleanup: true,
    })).toThrow('GIT_WORKTREE_PHYSICAL_IDENTITY_CHANGED');
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
      const attempted = spawnSync('git', ['-C', fx.linked, 'commit', '--allow-empty', '-m', 'concurrent git head writer'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(attempted.status).not.toBe(0);
      expect(String(attempted.stderr)).toContain('HEAD.lock');
      expect(() => fx.cleanup({
        confirmCleanup: true,
        expectedHead: preview.expectedHead,
        expectedIdentity: preview.physicalIdentity,
        previewToken: preview.execution?.approvalToken,
      })).toThrow('GIT_WORKTREE_HEAD_LOCK_HELD');
      expect(existsSync(fx.linked)).toBe(true);
      expect(gitOutput(fx.linked, ['rev-parse', 'HEAD'])).toBe(preview.expectedHead);
    } finally {
      closeSync(fd);
      unlinkSync(headLock);
    }
    expect(fx.cleanup({
      confirmCleanup: true,
      expectedHead: preview.expectedHead,
      expectedIdentity: preview.physicalIdentity,
      previewToken: preview.execution?.approvalToken,
    }).status).toBe('removed');
    expect(existsSync(fx.linked)).toBe(false);
  });

  test('retains historical WorkHandle checkout identity even when no OwnedResource metadata exists', () => {
    const fx = fixture();
    const previous = seedWorkHandle(fx.controllerHome, fx.repository, 'work-old-checkout-identity');
    seedHistoricalWorkHandle(fx.controllerHome, {
      ...previous,
      checkoutId: fx.target.checkoutId,
      worktreePath: fx.linked,
      managedWorktree: true,
      branch: 'legacy-work-source',
    });
    expect(() => fx.cleanup()).toThrow('GIT_WORKTREE_LEGACY_WORK_HANDLE_PROTECTED');
    expect(existsSync(fx.linked)).toBe(true);
    expect(fx.current().checkouts.find((item) => item.checkoutId === fx.target.checkoutId)?.lifecycle).toBe('active');
  });

  test('does not delete an explicitly Forge-owned linked worktree, even if its HEAD is merged and tree is clean', () => {
    const fx = fixture();
    recordOwnedResource(fx.controllerHome, {
      resourceId: 'worktree-owned-by-other-task',
      kind: 'worktree',
      targetRef: fx.linked,
      creator: 'forge:managed-workspace',
      repoId: fx.repository.repoId,
      associatedWorkId: 'existing-other-work',
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

function seedWorkHandle(controllerHome: string, repository: ReturnType<typeof seedRepo>, workId: string): WorkHandleState {
  const now = new Date().toISOString();
  const head = gitOutput(repository.canonicalRoot, ['rev-parse', 'HEAD']);
  seedHistoricalWorkContract({ controllerHome, repoId: repository.repoId }, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    workKind: 'repository_change',
    objective: `Execute repository command lifecycle fixture for ${workId}.`,
    acceptanceCriteria: [],
    allowedPaths: ['**'],
    forbiddenPaths: [],
    checks: [],
    constraints: { workspaceMode: 'current' },
    requestedBy: 'chatgpt',
    dispatchState: 'running',
  });
  return seedHistoricalWorkHandle(controllerHome, {
    schemaVersion: 1,
    workId,
    sessionId: `session-${workId}`,
    principalId: 'principal-test',
    repositoryId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    worktreePath: repository.canonicalRoot,
    branch: 'main',
    managedWorktree: false,
    baseCommit: head,
    deliveryBaseCommit: head,
    expectedHead: head,
    permissionSnapshotVersion: 1,
    state: 'editing',
    createdAt: now,
    updatedAt: now,
    finalization: {
      validation: 'pending',
      commit: 'pending',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    },
  });
}

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
      timeoutMs: MAX_AGENT_TIMEOUT_MS});
    expect(longOk.execution.status).toBe('preview');

    const minOk = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MIN_AGENT_TIMEOUT_MS});
    expect(minOk.execution.status).toBe('preview');

    expect(() => previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MAX_AGENT_TIMEOUT_MS + 1})).toThrow(/COMMAND_OPTION_INVALID/);

    expect(() => previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MIN_AGENT_TIMEOUT_MS - 1})).toThrow(/COMMAND_OPTION_INVALID/);

    expect(() => previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: 13 * 60 * 60 * 1000})).toThrow(String(MAX_AGENT_TIMEOUT_MS));

    const withDefault = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true});
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
      expect(shellForm.executionMetrics).toMatchObject({ lane: 'ephemeral_direct', durableWrites: 0, leaseOperations: 0 });
      expect(shellForm.stderr).not.toContain('runtime-authority@runtime-fence');
      expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    } finally {
      owner.release();
    }
  });

  test('raw git commits derive staged-index scope while widening forms stay blocked and selected-path commits isolate unrelated staged work', async () => {
    const route = (command: string[] | string) => classifyRepositoryCommandRoute(command);
    expect(route(['git', 'commit', '-m', 'staged index'])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route("git commit -m 'staged index shell'")).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route(['bash', '-lc', "git commit -m 'wrapped staged index'"])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route("git add . && git commit -m 'compound unsafe'")).toEqual({ route: 'reject', reason: 'git_commit_requires_explicit_path_scope' });
    expect(route(['git', 'commit', '--only', '-m', 'safe', '--', 'README.md'])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route(['git', 'commit', '-m', 'safe argv pathspec', '--', 'README.md', 'docs/forge-plugin-management.md'])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route("git commit -m 'safe shell pathspec' -- README.md docs/forge-plugin-management.md")).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route(['bash', '-lc', "git commit -m 'safe wrapped pathspec' -- README.md"])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route(['bash', '-lc', "rg -n 'git commit' src tests"])).toEqual({ route: 'process_direct', reason: 'readonly_fast_path' });
    expect(route(['git', 'commit', '-a', '-m', 'scope widening', '--', 'README.md'])).toEqual({ route: 'reject', reason: 'git_commit_requires_explicit_path_scope' });
    expect(route("git commit --include -m 'scope widening' -- README.md")).toEqual({ route: 'reject', reason: 'git_commit_requires_explicit_path_scope' });

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
        ? await waitRepositoryCommandProcess(controllerHome, repository.repoId, stagedCommit.process.processId, { timeoutMs: 10_000 })
        : undefined;
    expect(stagedCommitTerminal?.ok ?? stagedCommit.ok).toBe(true);
    expect(gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean)).toEqual(['staged-only.txt']);
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
      expect(() => commitSelectedPaths(controllerHome, repository, { paths: ['README.md'], message: 'selected only' })).toThrow(/LOCK_HELD/);
    } finally {
      releaseControllerLock(controllerHome, { scope: 'worktree', repoId: repository.repoId, worktreeId: repository.activeCheckoutId }, held.lockId);
    }

    const headBeforeReviewGuard = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    expect(() => commitSelectedPaths(controllerHome, repository, {
      paths: ['README.md'],
      message: 'review gate must stop this commit',
      beforeCommitGuard: ({ requestedPaths, stagedPaths, currentHead }) => {
        expect(requestedPaths).toEqual(['README.md']);
        expect(stagedPaths).toEqual(['README.md']);
        expect(currentHead).toBe(headBeforeReviewGuard);
        throw new Error('TEST_IMPLEMENTATION_REVIEW_BLOCKED');
      },
    })).toThrow('TEST_IMPLEMENTATION_REVIEW_BLOCKED');
    expect(gitOutput(repoRoot, ['rev-parse', 'HEAD'])).toBe(headBeforeReviewGuard);
    expect(gitOutput(repoRoot, ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean).sort()).toEqual(['README.md', 'other.txt']);

    const committed = commitSelectedPaths(controllerHome, repository, { paths: ['README.md'], message: 'selected only' });
    expect(committed.error).toBeUndefined();
    expect(committed.commit?.ok).toBe(true);
    expect(gitOutput(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean)).toEqual(['README.md']);
    expect(gitOutput(repoRoot, ['diff', '--cached', '--name-only'])).toBe('other.txt');
  });

  test('routes fixed shell diagnostics and ordinary local scripts without weakening external boundaries', () => {
    const route = (command: string[]) => classifyRepositoryCommandRoute(command);
    expect(route(['bash', '-lc', 'curl -fsS http://127.0.0.1:8765/ready'])).toEqual({ route: 'process_direct', reason: 'readonly_fast_path' });
    expect(route(['bash', '-lc', 'curl -fsS http://127.0.0.1:8765/ready >/dev/null'])).toEqual({ route: 'process_direct', reason: 'readonly_fast_path' });
    // Existing baseline had an obsolete reason assertion: these shell commands
    // are managed through the stronger ProcessLease path, not an unleased wrapper.
    for (const payload of ['curl -fsS http://127.0.0.1:8765/ready > marker.txt', 'curl -fsS -X POST http://127.0.0.1:8765/ready', 'curl -fsS -d payload http://127.0.0.1:8765/ready', 'curl -fsS https://example.com/']) expect(route(['bash', '-lc', payload])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    for (const payload of ['printf local > marker.txt', 'bun -e "console.log(1)"']) expect(route(['bash', '-lc', payload])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route(['bun', '-e', 'await fetch("http://127.0.0.1:8765/ready")'])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
    expect(route(['touch', 'marker.txt'])).toEqual({ route: 'process_managed', reason: 'workspace_write_requires_process_lease' });
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
    for (const name of ['target.txt', 'unrelated-a.txt', 'unrelated-b.txt']) writeFileSync(join(repoRoot, name), 'base\n');
    git(repoRoot, ['add', 'target.txt', 'unrelated-a.txt', 'unrelated-b.txt']);
    git(repoRoot, ['commit', '-m', 'add bounded snapshot fixture']);
    for (const name of ['target.txt', 'unrelated-a.txt', 'unrelated-b.txt']) writeFileSync(join(repoRoot, name), `changed:${name}\n`);

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
    expect(gitOutput(repoRoot, ['diff', '--name-only']).split(/\r?\n/).filter(Boolean).sort()).toEqual(['unrelated-a.txt', 'unrelated-b.txt']);
  });

  test('post-execution fingerprint timeout preserves child success while marking repository evidence unknown', async () => {
    const controllerHome = tempRoot('forge-cmd-post-evidence-home-');
    const repoRoot = tempRoot('forge-cmd-post-evidence-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    writeFileSync(join(repoRoot, 'write-three.mjs'), [
      "await Bun.write('evidence-a.txt', 'a\\n');",
      "await Bun.write('evidence-b.txt', 'b\\n');",
      "await Bun.write('evidence-c.txt', 'c\\n');",
    ].join('\n'));
    git(repoRoot, ['add', 'write-three.mjs']);
    git(repoRoot, ['commit', '-m', 'add evidence timeout fixture']);

    const result = await executeRepositoryCommandAsync(controllerHome, repository, {
      command: [process.execPath, 'write-three.mjs'],
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
    expect(result.after).toBeUndefined();
    expect(readFileSync(join(repoRoot, 'evidence-a.txt'), 'utf-8')).toBe('a\n');
  });

  test('write-capable command execution still reports repository changes', () => {
    const controllerHome = tempRoot('forge-cmd-write-snapshot-home-');
    const repoRoot = tempRoot('forge-cmd-write-snapshot-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    const result = executeRepositoryCommand(controllerHome, repository, {
      command: ['touch', 'marker.txt'],
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
      command: ['git', 'status', '--short'],
      timeoutMs: 10_000,
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
  });

  test('local shell and inline workspace writes use Process leases rather than unclaimed lightweight subprocesses', async () => {
    const controllerHome = tempRoot('forge-cmd-opaque-home-'); const repoRoot = tempRoot('forge-cmd-opaque-repo-'); const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access'); const processCount = listProcessRecords(controllerHome, repository.repoId).length;
    for (const [command, marker, expected] of [
      [['bash', '-lc', "printf 'shell-lightweight\\n' > shell-marker.txt"], 'shell-marker.txt', 'shell-lightweight\n'],
      [['bun', '-e', "await Bun.write('inline-marker.txt', 'inline-lightweight\\n')"], 'inline-marker.txt', 'inline-lightweight\n'],
    ] as const) {
      const result = await executeRepositoryCommandViaProcessRuntime({ controllerHome, repository, command, timeoutMs: 10_000, executionIdentity: executionIdentityForRepository(repository) });
      expect(result.process?.processId).not.toStartWith('lightweight:');
      expect(result.executionMetrics).toMatchObject({ lane: 'durable_process' });
      const terminal = result.process!.completed
        ? result.process!
        : await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, { timeoutMs: 10_000 });
      expect(terminal).toMatchObject({ completed: true, ok: true });
      expect(readFileSync(join(repoRoot, marker), 'utf-8')).toBe(expected);
    }
    expect(listProcessRecords(controllerHome, repository.repoId).length).toBeGreaterThan(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('long ordinary local workspace mutation holds a Process resource lease', async () => {
    const controllerHome = tempRoot('forge-cmd-light-home-');
    const repoRoot = tempRoot('forge-cmd-light-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access');
    writeFileSync(join(repoRoot, 'slow-command.mjs'), 'setTimeout(() => { console.log("lightweight-ok"); process.exit(0); }, 300);\n');
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
    expect(result.process?.processId).not.toStartWith('lightweight:');
    expect(result.executionMetrics).toMatchObject({ lane: 'durable_process' });
    expect(listProcessRecords(controllerHome, repository.repoId).length).toBeGreaterThan(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId).length).toBeGreaterThan(0);
    const terminal = await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, { timeoutMs: 10_000 });
    expect(terminal).toMatchObject({ completed: true, ok: true });
    expect(terminal.stdout).toContain('lightweight-ok');
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
    expect(classifyRepositoryCommandRoute(command)).toEqual({ route: 'process_managed', reason: 'effectful_command_managed' });
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
      : await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, { timeoutMs: 10_000 });
    expect(terminal).toMatchObject({ completed: true, ok: true });
    expect(gitOutput(remoteRoot, ['rev-parse', 'refs/heads/cloud-test'])).toBe(gitOutput(repoRoot, ['rev-parse', 'HEAD']));
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
    const held = acquireExecutionLeases(controllerHome, repository.repoId, blocker, [
      { resourceKey: 'workspace:' + repository.activeCheckoutId, mode: 'write' },
    ], { visibility: 'ephemeral' });
    expect(held.acquired).toBe(true);
    try {
      // An exact lease that does not match the remote head must never delete it.
      const stale = await executeRepositoryCommandViaProcessRuntime({
        controllerHome, repository,
        command: ['git', 'push', '--porcelain',
          '--force-with-lease=refs/heads/' + branch + ':' + 'b'.repeat(40),
          'origin', ':refs/heads/' + branch],
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      const staleTerminal = stale.process!.completed ? stale.process!
        : await waitRepositoryCommandProcess(controllerHome, repository.repoId, stale.process!.processId, { timeoutMs: 10_000 });
      expect(staleTerminal).toMatchObject({ completed: true, ok: false });
      expect(gitOutput(remoteRoot, ['rev-parse', 'refs/heads/' + branch])).toBe(exactHead);

      const result = await executeRepositoryCommandViaProcessRuntime({
        controllerHome,
        repository,
        command: ['git', 'push', '--porcelain',
          '--force-with-lease=refs/heads/' + branch + ':' + exactHead,
          'origin', ':refs/heads/' + branch],
        timeoutMs: 10_000,
        executionIdentity: executionIdentityForRepository(repository),
      });
      expect(result.process?.processId).toBeTruthy();
      const terminal = result.process!.completed ? result.process!
        : await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, { timeoutMs: 10_000 });
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
