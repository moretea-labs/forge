import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { getRepository, registerRepository } from '../../src/cli/repositories/registry';
import type { CompletionReceipt } from '../../src/cli/controller/types';
import { createWorkContract, recordWorkCompletionReceipt } from '../../src/runtime/control-plane/facade/work-contract-store';
import type { WorkContract } from '../../src/runtime/control-plane/facade/types';
import {
  readWorkHandle,
  writeWorkHandle,
  type WorkHandleState,
} from '../../src/runtime/control-plane/execution/work-handle-store';
import { cleanupTerminalWork } from '../../src/runtime/control-plane/execution/work-terminal-cleanup';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';
import { selectDefaultWorkValidationChecks } from '../../src/runtime/gateway/mcp/execution-tools';
import { ensureManagedWorkspace } from '../../src/runtime/workflow/campaigns/workspace';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(String(result.stderr || `git ${args.join(' ')} failed`));
  return String(result.stdout ?? '').trim();
}

function branchExists(root: string, branch: string): boolean {
  return spawnSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

function worktreeCount(root: string): number {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;
}

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `repo-harness-terminal-cleanup-${label}-`));
  roots.push(root);
  const controllerHome = join(root, 'controller');
  const repositoryRoot = join(root, 'repository');
  ensureControllerHome(controllerHome);
  mkdirSync(repositoryRoot, { recursive: true });
  git(repositoryRoot, ['init', '-b', 'main']);
  git(repositoryRoot, ['config', 'user.name', 'Cleanup Test']);
  git(repositoryRoot, ['config', 'user.email', 'cleanup@example.test']);
  writeFileSync(join(repositoryRoot, 'README.md'), 'fixture\n');
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'fixture']);
  const repository = registerRepository({ path: repositoryRoot, controllerHome, displayName: `cleanup-${label}` });
  const branch = `campaign/terminal-cleanup-${label}`;
  const workspace = ensureManagedWorkspace(controllerHome, repository, {
    requestId: `terminal-cleanup-${label}`,
    title: `Terminal Cleanup ${label}`,
    branchName: branch,
  });
  const now = new Date().toISOString();
  const workId = `work-terminal-cleanup-${label}`;
  const handle = writeWorkHandle(controllerHome, {
    schemaVersion: 1,
    workId,
    sessionId: `session-${label}`,
    principalId: `principal-${label}`,
    repositoryId: repository.repoId,
    checkoutId: workspace.checkoutId!,
    sourceCheckoutId: repository.activeCheckoutId,
    worktreePath: workspace.root!,
    branch,
    managedWorktree: true,
    baseCommit: workspace.baseRevision ?? undefined,
    expectedHead: workspace.baseRevision ?? undefined,
    permissionSnapshotVersion: 1,
    state: 'failed',
    failureReason: 'validation failed',
    createdAt: now,
    updatedAt: now,
    cleanupResponsibility: { owner: 'work_finalizer', registeredAt: now },
    finalization: {
      validation: 'failed',
      commit: 'pending',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
      lastError: 'validation failed',
    },
  });
  return { root, controllerHome, repositoryRoot, repository, workspace, branch, handle };
}

async function cleanup(fx: ReturnType<typeof fixture>, handle: WorkHandleState = fx.handle) {
  return cleanupTerminalWork({
    controllerHome: fx.controllerHome,
    handle,
    targetBranch: 'main',
    deleteBranch: true,
    terminalOutcome: 'validation_failed',
  });
}

describe('terminal Work cleanup', () => {
  test('removes a clean failed worktree, preserves failure, and is idempotent', async () => {
    const fx = fixture('clean');
    const first = await cleanup(fx);
    expect(first.handle).toMatchObject({ state: 'cleaned', failureReason: 'validation failed' });
    expect(first.receipt).toMatchObject({
      complete: true,
      partial: false,
      verification: { mode: 'cleanup_only', checksRun: [] },
      worktree: { status: 'removed' },
      branchCleanup: { status: 'deleted', uniqueCommits: 0 },
      checkoutRegistry: { status: 'removed' },
      prune: { status: 'done' },
    });
    expect(existsSync(fx.workspace.root!)).toBe(false);
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(false);
    expect(worktreeCount(fx.repositoryRoot)).toBe(1);

    const repeated = await cleanup(fx, first.handle);
    expect(repeated.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(repeated.receipt.complete).toBe(true);
    expect(worktreeCount(fx.repositoryRoot)).toBe(1);
  });

  test('cancelled cleanup preserves pending validation instead of fabricating failure', async () => {
    const fx = fixture('cancelled');
    const cancelled = writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      state: 'editing',
      failureReason: undefined,
      finalization: {
        ...fx.handle.finalization,
        validation: 'pending',
        lastError: undefined,
      },
    });
    const result = await cleanupTerminalWork({
      controllerHome: fx.controllerHome,
      handle: cancelled,
      targetBranch: 'main',
      deleteBranch: true,
      terminalOutcome: 'cancelled',
    });
    expect(result.handle.state).toBe('cleaned');
    expect(result.handle.finalization.validation).toBe('pending');
    expect(result.receipt).toMatchObject({ terminalOutcome: 'cancelled', complete: true });
  });

  test('fails closed when the registered path belongs to a different Git common directory', async () => {
    const fx = fixture('common-dir-mismatch');
    git(fx.repositoryRoot, ['worktree', 'remove', '--force', fx.workspace.root!]);
    mkdirSync(fx.workspace.root!, { recursive: true });
    git(fx.workspace.root!, ['init', '-b', fx.branch]);
    git(fx.workspace.root!, ['config', 'user.name', 'Mismatched Repository']);
    git(fx.workspace.root!, ['config', 'user.email', 'mismatch@example.test']);
    writeFileSync(join(fx.workspace.root!, 'README.md'), 'different repository\n');
    git(fx.workspace.root!, ['add', '.']);
    git(fx.workspace.root!, ['commit', '-m', 'different repository']);

    const result = await cleanup(fx);
    expect(result.handle.state).toBe('failed_terminal_cleanup');
    expect(result.receipt.complete).toBe(false);
    expect(result.receipt.blockers.join('\n')).toContain('GIT_COMMON_DIR_MISMATCH');
    expect(existsSync(fx.workspace.root!)).toBe(true);
  });

  test('checkpoints dirty work, bundles unique commits, then removes worktree and branch', async () => {
    const fx = fixture('dirty');
    writeFileSync(join(fx.workspace.root!, 'dirty.txt'), 'preserve me\n');
    const result = await cleanup(fx);
    expect(result.receipt.complete).toBe(true);
    expect(result.receipt.preservation.status).toBe('checkpointed');
    expect(result.receipt.preservation.checkpointCommit).toBeTruthy();
    expect(result.receipt.preservation.bundlePath).toBeTruthy();
    expect(existsSync(result.receipt.preservation.bundlePath!)).toBe(true);
    expect(git(fx.repositoryRoot, ['show', '-s', '--format=%s', result.receipt.preservation.checkpointCommit!]))
      .toBe('chore(checkpoint): preserve terminal work before cleanup');
    expect(git(fx.repositoryRoot, ['bundle', 'verify', result.receipt.preservation.bundlePath!]))
      .toContain(`refs/heads/${fx.branch}`);
    expect(result.receipt.branchCleanup.status).toBe('archived');
    expect(existsSync(fx.workspace.root!)).toBe(false);
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(false);
  });

  test('archives an unmerged committed branch before deleting it', async () => {
    const fx = fixture('unique');
    writeFileSync(join(fx.workspace.root!, 'change.txt'), 'unique commit\n');
    git(fx.workspace.root!, ['add', '.']);
    git(fx.workspace.root!, ['commit', '-m', 'feat: unique terminal work']);
    const head = git(fx.workspace.root!, ['rev-parse', 'HEAD']);
    const current = writeWorkHandle(fx.controllerHome, { ...fx.handle, expectedHead: head });
    const result = await cleanup(fx, current);
    expect(result.receipt.preservation.bundlePath).toBeTruthy();
    expect(result.receipt.preservation.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.branchCleanup).toMatchObject({ status: 'archived', uniqueCommits: 1 });
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(false);
  });

  test('fails closed while another Work Process owns the checkout', async () => {
    const fx = fixture('process-owner');
    const now = new Date().toISOString();
    createProcessRecord({
      schemaVersion: 1,
      processId: 'proc-other-live-work',
      repoId: fx.repository.repoId,
      checkoutId: fx.workspace.checkoutId,
      workId: undefined,
      controllerHome: fx.controllerHome,
      status: 'running',
      route: 'managed',
      commandId: 'other-live-command',
      command: { kind: 'argv', executable: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], cwd: fx.workspace.root! },
      resourceClaims: [],
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      startedAt: now,
      updatedAt: now,
      terminalFenceToken: 1,
    } satisfies ManagedProcessRecord);
    const result = await cleanup(fx);
    expect(result.handle.state).toBe('failed_terminal_cleanup');
    expect(result.receipt.complete).toBe(false);
    expect(result.receipt.blockers.join('\n')).toContain('ACTIVE_PROCESS_OTHER_WORK');
    expect(result.receipt.blockers.join('\n')).toContain('unbound process');
    expect(existsSync(fx.workspace.root!)).toBe(true);
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(true);
  });

  test('continues partial cleanup from the durable receipt after owner removal', async () => {
    const fx = fixture('restart');
    const now = new Date().toISOString();
    const other = writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      recordRevision: undefined,
      workId: 'work-other-restart-owner',
      sessionId: 'session-other-restart-owner',
      state: 'editing',
      createdAt: now,
      updatedAt: now,
      cleanupReceipt: undefined,
    });
    const partial = await cleanup(fx);
    expect(partial.handle.state).toBe('failed_terminal_cleanup');
    expect(partial.receipt.blockers.join('\n')).toContain('LIVE_WORK_OWNS_CHECKOUT');
    writeWorkHandle(fx.controllerHome, { ...other, state: 'cleaned' });

    const recoveredHandle = readWorkHandle(fx.controllerHome, fx.repository.repoId, fx.handle.workId)!;
    const recovered = await cleanup(fx, recoveredHandle);
    expect(recovered.handle.state).toBe('cleaned');
    expect(recovered.receipt.complete).toBe(true);
    expect(recovered.receipt.blockers).toEqual([]);
    expect(existsSync(fx.workspace.root!)).toBe(false);
  });

  test('does not treat a completed WorkContract with a stale prepared handle as a live checkout owner', async () => {
    const fx = fixture('completed-owner');
    const now = new Date().toISOString();
    const otherWorkId = 'work-completed-stale-owner';
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: otherWorkId,
      repoId: fx.repository.repoId,
      mode: 'direct_control',
      objective: 'Retain the already integrated checkout without further mutation.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'cleanup',
    });
    const revision = fx.workspace.baseRevision!;
    const receipt: CompletionReceipt = {
      schemaVersion: 1,
      receiptId: 'receipt-completed-stale-owner',
      source: 'controller_work',
      issueId: 'work',
      taskId: otherWorkId,
      workId: otherWorkId,
      targetBranch: 'main',
      targetRevision: revision,
      sourceRevision: revision,
      baseRevision: revision,
      changedPaths: [],
      delivery: {
        kind: 'commit',
        status: 'integrated',
        strategy: 'already_integrated',
        reachable: true,
        recordedAt: now,
      },
      cleanup: {
        status: 'maintenance_warning',
        warnings: [{
          code: 'cleanup_retained_by_request',
          message: 'Checkout retained by request.',
          resourceKind: 'worktree',
          resourceId: fx.workspace.root!,
          recordedAt: now,
        }],
        blockers: [],
        recordedAt: now,
      },
      verifiedAt: now,
      recordedAt: now,
    };
    recordWorkCompletionReceipt(
      { controllerHome: fx.controllerHome, repoId: fx.repository.repoId },
      otherWorkId,
      receipt,
      'completed_changed',
      'repository_change',
    );
    writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      recordRevision: undefined,
      workId: otherWorkId,
      workContractId: otherWorkId,
      sessionId: 'session-completed-stale-owner',
      state: 'prepared',
      failureReason: undefined,
      cleanupReceipt: undefined,
      finalization: {
        validation: 'done',
        commit: 'skipped',
        merge: 'skipped',
        branchCleanup: 'skipped',
        worktreeCleanup: 'skipped',
      },
      createdAt: now,
      updatedAt: now,
    });

    const result = await cleanup(fx);
    expect(result.receipt.complete).toBe(true);
    expect(result.receipt.blockers).toEqual([]);
    expect(result.handle.state).toBe('cleaned');
  });

  test('cleanup-only and low-risk selection never defaults to package-wide checks', () => {
    const low = {
      risk: 'low',
      checks: ['package:test', 'package:check:type', 'check:runtime-architecture', 'focused:changed-files'],
    } as unknown as WorkContract;
    expect(selectDefaultWorkValidationChecks(low, [])).toEqual([]);
    expect(selectDefaultWorkValidationChecks(low, ['README.md'])).toEqual(['focused:changed-files']);
    expect(selectDefaultWorkValidationChecks(low, ['src/changed.ts'])).toEqual([
      'package:check:type',
      'focused:changed-files',
    ]);

    const medium = { ...low, risk: 'medium' } as WorkContract;
    expect(selectDefaultWorkValidationChecks(medium, ['src/changed.ts'])).toEqual(low.checks);
  });

  test('repeated terminal work does not grow worktree or branch counts', async () => {
    const fx = fixture('count-0');
    await cleanup(fx);
    for (const label of ['count-1', 'count-2']) {
      const workspace = ensureManagedWorkspace(fx.controllerHome, getRepository(fx.repository.repoId, fx.controllerHome), {
        requestId: `terminal-cleanup-${label}`,
        title: `Terminal Cleanup ${label}`,
        branchName: `campaign/terminal-cleanup-${label}`,
      });
      const now = new Date().toISOString();
      const handle = writeWorkHandle(fx.controllerHome, {
        ...fx.handle,
        recordRevision: undefined,
        workId: `work-terminal-cleanup-${label}`,
        sessionId: `session-${label}`,
        checkoutId: workspace.checkoutId!,
        worktreePath: workspace.root!,
        branch: workspace.branch!,
        baseCommit: workspace.baseRevision ?? undefined,
        expectedHead: workspace.baseRevision ?? undefined,
        createdAt: now,
        updatedAt: now,
        cleanupReceipt: undefined,
      });
      await cleanupTerminalWork({
        controllerHome: fx.controllerHome,
        handle,
        targetBranch: 'main',
        deleteBranch: true,
        terminalOutcome: 'failed',
      });
      expect(worktreeCount(fx.repositoryRoot)).toBe(1);
    }
    expect(git(fx.repositoryRoot, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean)).toEqual(['main']);
  });
});
