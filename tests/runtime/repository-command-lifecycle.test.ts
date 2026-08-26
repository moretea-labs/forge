import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS } from '../../src/cli/controller/runtime-config';
import {
  executeLocalBridgeJob,
  getLocalBridgeJob,
  reconcileLocalBridgeJobs,
  submitLocalBridgeJob} from '../../src/cli/local-bridge/job-store';
import {
  executeRepositoryCommand,
  executeRepositoryReadOnlyCommandDirect,
  previewRepositoryCommandExecution,
  REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS,
  REPOSITORY_COMMAND_MAX_TIMEOUT_MS,
  REPOSITORY_COMMAND_MIN_TIMEOUT_MS} from '../../src/cli/repositories/command-executor';
import { registerRepository } from '../../src/cli/repositories/registry';
import { commitSelectedPaths } from '../../src/cli/repositories/selected-path-actions';
import { acquireControllerLock, releaseControllerLock } from '../../src/cli/repositories/locks';
import { persistControllerAccessMode } from '../../src/cli/mcp/access-mode';
import { executionIdentityForRepository, executionIdentityForWork } from '../../src/runtime/control-plane/execution/execution-identity';
import { readWorkHandle, writeWorkHandle, type WorkHandleState } from '../../src/runtime/control-plane/execution/work-handle-store';
import { classifyRepositoryCommandRoute, executeRepositoryCommandViaProcessRuntime, waitRepositoryCommandProcess } from '../../src/runtime/execution/process-runtime/command-facade';
import { listProcessRecords } from '../../src/runtime/execution/process-runtime/store';
import { getExecutionJob, updateExecutionJob } from '../../src/runtime/execution/jobs/store';
import { waitForExecutionJob } from '../../src/runtime/execution/jobs/wait';
import { executeExecutionJob } from '../../src/runtime/execution/workers/executor';
import { acquireExecutionLeases, listActiveLeases, releaseExecutionLeases, renewExecutionLeases } from '../../src/runtime/resources/leases/store';
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

function seedWorkHandle(controllerHome: string, repository: ReturnType<typeof seedRepo>, workId: string): WorkHandleState {
  const now = new Date().toISOString();
  const head = gitOutput(repository.canonicalRoot, ['rev-parse', 'HEAD']);
  return writeWorkHandle(controllerHome, {
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
      expect(shellForm.process).toBeDefined();
      expect(shellForm.process?.processId).toStartWith('lightweight:');
      expect(shellForm.executionMetrics).toMatchObject({ lane: 'lightweight_managed', durableWrites: 0, leaseOperations: 0 });
      const shellTerminal = shellForm.process!.completed
        ? shellForm.process!
        : await waitRepositoryCommandProcess(controllerHome, repository.repoId, shellForm.process!.processId, { timeoutMs: 10_000 });
      expect(shellTerminal).toMatchObject({ completed: true, ok: true });
      expect(shellTerminal.stderr).not.toContain('runtime-authority@runtime-fence');
      expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    } finally {
      owner.release();
    }
  });

  test('settles WorkHandle expectedHead after a successful Work-attributed git commit', async () => {
    const controllerHome = tempRoot('forge-cmd-work-head-home-');
    const repoRoot = tempRoot('forge-cmd-work-head-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const handle = seedWorkHandle(controllerHome, repository, 'work-head-sync');
    const previousHead = handle.expectedHead;
    writeFileSync(join(repoRoot, 'README.md'), 'changed by work\n');

    const execution = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['git', 'commit', '--only', '-m', 'work head sync', '--', 'README.md'],
      timeoutMs: 10_000,
      workId: handle.workId,
      executionIdentity: executionIdentityForWork(repository, handle),
    });
    const terminal = execution.process?.completed
      ? execution.process
      : execution.process
        ? await waitRepositoryCommandProcess(controllerHome, repository.repoId, execution.process.processId, { timeoutMs: 10_000 })
        : undefined;
    expect(terminal?.ok ?? execution.ok).toBe(true);
    const currentHead = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    expect(currentHead).not.toBe(previousHead);
    expect(readWorkHandle(controllerHome, repository.repoId, handle.workId)?.expectedHead).toBe(currentHead);
  });

  test('settles WorkHandle expectedHead when a lightweight managed commit completes after the caller returns', async () => {
    const controllerHome = tempRoot('forge-cmd-work-head-async-home-');
    const repoRoot = tempRoot('forge-cmd-work-head-async-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const handle = seedWorkHandle(controllerHome, repository, 'work-head-async');
    writeFileSync(join(repoRoot, 'README.md'), 'changed asynchronously\n');
    writeFileSync(join(repoRoot, 'commit-later.sh'), "#!/usr/bin/env bash\nsleep 0.15\ngit commit --only -m 'work head async' -- README.md\n");

    const execution = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['bash', 'commit-later.sh'],
      timeoutMs: 10_000,
      interactiveWaitMs: 0,
      returnHandleImmediately: true,
      workId: handle.workId,
      executionIdentity: executionIdentityForWork(repository, handle),
    });
    expect(execution.route).toBe('process_managed');
    expect(execution.process?.completed).toBe(false);
    const terminal = await waitRepositoryCommandProcess(controllerHome, repository.repoId, execution.process!.processId, { timeoutMs: 10_000 });
    expect(terminal).toMatchObject({ completed: true, ok: true });
    expect(readWorkHandle(controllerHome, repository.repoId, handle.workId)?.expectedHead).toBe(gitOutput(repoRoot, ['rev-parse', 'HEAD']));
  });

  test('does not settle WorkHandle expectedHead after a failed command or branch drift', async () => {
    const controllerHome = tempRoot('forge-cmd-work-head-fence-home-');
    const repoRoot = tempRoot('forge-cmd-work-head-fence-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const failed = seedWorkHandle(controllerHome, repository, 'work-head-failed');
    const failedHead = failed.expectedHead;
    writeFileSync(join(repoRoot, 'README.md'), 'commit then fail\n');
    writeFileSync(join(repoRoot, 'commit-then-fail.sh'), "#!/usr/bin/env bash\ngit commit --only -m 'commit then fail' -- README.md\nexit 1\n");

    const failedExecution = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['bash', 'commit-then-fail.sh'],
      timeoutMs: 10_000,
      workId: failed.workId,
      executionIdentity: executionIdentityForWork(repository, failed),
    });
    const failedTerminal = failedExecution.process?.completed
      ? failedExecution.process
      : failedExecution.process
        ? await waitRepositoryCommandProcess(controllerHome, repository.repoId, failedExecution.process.processId, { timeoutMs: 10_000 })
        : undefined;
    expect(failedTerminal?.ok ?? failedExecution.ok).toBe(false);
    expect(readWorkHandle(controllerHome, repository.repoId, failed.workId)?.expectedHead).toBe(failedHead);

    const newHead = gitOutput(repoRoot, ['rev-parse', 'HEAD']);
    const drift = writeWorkHandle(controllerHome, {
      ...readWorkHandle(controllerHome, repository.repoId, failed.workId)!,
      workId: 'work-head-branch-drift',
      sessionId: 'session-work-head-branch-drift',
      expectedHead: newHead,
      baseCommit: newHead,
      deliveryBaseCommit: newHead,
      recordRevision: undefined,
    });
    const driftExecution = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['git', 'switch', '-c', 'drift-branch'],
      timeoutMs: 10_000,
      workId: drift.workId,
      executionIdentity: executionIdentityForWork(repository, drift),
    });
    const driftTerminal = driftExecution.process?.completed
      ? driftExecution.process
      : driftExecution.process
        ? await waitRepositoryCommandProcess(controllerHome, repository.repoId, driftExecution.process.processId, { timeoutMs: 10_000 })
        : undefined;
    expect(driftTerminal?.ok ?? driftExecution.ok).toBe(true);
    expect(readWorkHandle(controllerHome, repository.repoId, drift.workId)?.expectedHead).toBe(newHead);
  });

  test('raw git commits require explicit path scope and selected-path commits keep unrelated staged work isolated', () => {
    const route = (command: string[] | string) => classifyRepositoryCommandRoute(command);
    expect(route(['git', 'commit', '-m', 'unsafe'])).toEqual({ route: 'reject', reason: 'git_commit_requires_explicit_path_scope' });
    expect(route('git commit -m unsafe')).toEqual({ route: 'reject', reason: 'git_commit_requires_explicit_path_scope' });
    expect(route(['git', 'commit', '--only', '-m', 'safe', '--', 'README.md'])).toEqual({ route: 'process_direct', reason: 'ephemeral_local_workspace_mutation' });

    const controllerHome = tempRoot('forge-selected-commit-home-');
    const repoRoot = tempRoot('forge-selected-commit-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access', repoRoot);
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
    for (const payload of ['curl -fsS http://127.0.0.1:8765/ready > marker.txt', 'curl -fsS -X POST http://127.0.0.1:8765/ready', 'curl -fsS -d payload http://127.0.0.1:8765/ready', 'curl -fsS https://example.com/']) expect(route(['bash', '-lc', payload])).toEqual({ route: 'process_managed', reason: 'shell_wrapper_requires_managed_boundary' });
    for (const payload of ['printf local > marker.txt', 'bun -e "console.log(1)"']) expect(route(['bash', '-lc', payload])).toEqual({ route: 'process_direct', reason: 'lightweight_local_shell_wrapper' });
    expect(route(['bun', '-e', 'await fetch("http://127.0.0.1:8765/ready")'])).toEqual({ route: 'process_direct', reason: 'lightweight_local_inline_interpreter' });
    expect(route(['touch', 'marker.txt'])).toEqual({ route: 'process_direct', reason: 'ephemeral_local_workspace_mutation' });
  });

  test('readonly direct execution reuses its pre-execution snapshot instead of taking a redundant post snapshot', async () => {
    const controllerHome = tempRoot('forge-cmd-read-snapshot-home-');
    const repoRoot = tempRoot('forge-cmd-read-snapshot-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const result = await executeRepositoryReadOnlyCommandDirect(repository, {
      command: ['git', 'status', '--short'],
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.after).toBe(result.before);
    expect(result.repositoryChanged).toBe(false);
    expect(result.changedPaths).toEqual([]);
  });

  test('write-capable command execution still reports repository changes', () => {
    const controllerHome = tempRoot('forge-cmd-write-snapshot-home-');
    const repoRoot = tempRoot('forge-cmd-write-snapshot-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access', repoRoot);
    const result = executeRepositoryCommand(controllerHome, repository, {
      command: ['touch', 'marker.txt'],
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.repositoryChanged).toBe(true);
    expect(result.changedPaths).toContain('marker.txt');
  });

  test('Work identity does not upgrade an ordinary readonly command into Process Runtime', async () => {
    const controllerHome = tempRoot('forge-cmd-work-read-home-');
    const repoRoot = tempRoot('forge-cmd-work-read-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access', repoRoot);
    const processCount = listProcessRecords(controllerHome, repository.repoId).length;
    const result = await executeRepositoryCommandViaProcessRuntime({
      controllerHome,
      repository,
      command: ['git', 'status', '--short'],
      timeoutMs: 10_000,
      workId: 'work-readonly-continuity',
      executionIdentity: executionIdentityForRepository(repository, { workId: 'work-readonly-continuity' }),
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

  test('local shell wrappers and inline interpreters stay lightweight without persistent Process or Lease state', async () => {
    const controllerHome = tempRoot('forge-cmd-opaque-home-'); const repoRoot = tempRoot('forge-cmd-opaque-repo-'); const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access', repoRoot); const processCount = listProcessRecords(controllerHome, repository.repoId).length;
    for (const [command, marker, expected] of [
      [['bash', '-lc', "printf 'shell-lightweight\\n' > shell-marker.txt"], 'shell-marker.txt', 'shell-lightweight\n'],
      [['bun', '-e', "await Bun.write('inline-marker.txt', 'inline-lightweight\\n')"], 'inline-marker.txt', 'inline-lightweight\n'],
    ] as const) {
      const result = await executeRepositoryCommandViaProcessRuntime({ controllerHome, repository, command, timeoutMs: 10_000, executionIdentity: executionIdentityForRepository(repository) });
      expect(result.process?.processId).toStartWith('lightweight:');
      expect(result.executionMetrics).toMatchObject({ lane: 'lightweight_managed', durableWrites: 0, leaseOperations: 0 });
      const terminal = result.process!.completed
        ? result.process!
        : await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, { timeoutMs: 10_000 });
      expect(terminal).toMatchObject({ completed: true, ok: true });
      expect(readFileSync(join(repoRoot, marker), 'utf-8')).toBe(expected);
    }
    expect(listProcessRecords(controllerHome, repository.repoId)).toHaveLength(processCount); expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
  });

  test('long ordinary local command upgrades only to an in-memory lightweight handle', async () => {
    const controllerHome = tempRoot('forge-cmd-light-home-');
    const repoRoot = tempRoot('forge-cmd-light-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access', repoRoot);
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
    expect(result.process?.processId).toStartWith('lightweight:');
    expect(result.executionMetrics).toMatchObject({ lane: 'lightweight_managed', durableWrites: 0, leaseOperations: 0 });
    expect(listProcessRecords(controllerHome, repository.repoId)).toHaveLength(processCount);
    expect(listActiveLeases(controllerHome, repository.repoId)).toHaveLength(0);
    const terminal = await waitRepositoryCommandProcess(controllerHome, repository.repoId, result.process!.processId, { timeoutMs: 10_000 });
    expect(terminal).toMatchObject({ completed: true, ok: true });
    expect(terminal.stdout).toContain('lightweight-ok');
  });

  test('ordinary remote writes execute through managed Process Runtime without external-controller delegation', async () => {
    const controllerHome = tempRoot('forge-cmd-external-home-');
    const repoRoot = tempRoot('forge-cmd-external-repo-');
    const remoteRoot = tempRoot('forge-cmd-external-remote-');
    const repository = seedRepo(controllerHome, repoRoot);
    persistControllerAccessMode(controllerHome, 'full_access', repoRoot);
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

});
