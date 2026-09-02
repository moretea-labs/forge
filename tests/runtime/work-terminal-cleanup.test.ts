import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import { cleanupTerminalWork, reconcileTerminalWorkCleanups } from '../../src/runtime/control-plane/execution/work-terminal-cleanup';
import { processLogDir } from '../../src/runtime/execution/process-runtime';
import { createProcessRecord } from '../../src/runtime/execution/process-runtime/store';
import type { ManagedProcessRecord } from '../../src/runtime/execution/process-runtime/types';
import { resetFinalizationStagesForRequest, selectDefaultWorkValidationChecks } from '../../src/runtime/gateway/mcp/execution-tools';
import { ensureManagedWorkspace } from '../../src/runtime/execution/managed-workspace';
import { cleanupControllerRuntimeState } from '../../src/runtime/control-plane/runtime-cleanup';

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
  const root = mkdtempSync(join(tmpdir(), `forge-terminal-cleanup-${label}-`));
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
  const branch = `work/terminal-cleanup-${label}`;
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

  test('runtime architecture gate tracks the canonical finalization reset helper', () => {
    const gate = readFileSync(join(import.meta.dir, '../../scripts/check-runtime-architecture.mjs'), 'utf8');
    expect(gate).toContain("requireText('adapters/mcp/runtime-gateway/execution-tools.ts', 'resetFinalizationStagesForRequest');");
    expect(gate).not.toContain("requireText('src/runtime/gateway/mcp/execution-tools.ts', 'resetFailedFinalizationStages');");
  });

  test('late cleanup re-arms only retained managed cleanup stages', () => {
    const retained = {
      validation: 'done',
      commit: 'done',
      merge: 'done',
      branchCleanup: 'skipped',
      worktreeCleanup: 'skipped',
    } as const;
    expect(resetFinalizationStagesForRequest(
      retained,
      { commit: true, merge: true, cleanup: true },
      { managedWorktree: true, deleteBranchRequested: true, retainedByRequest: true },
    )).toEqual({
      validation: 'done',
      commit: 'done',
      merge: 'done',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    });

    expect(resetFinalizationStagesForRequest(
      retained,
      { commit: true, merge: true, cleanup: true },
      { managedWorktree: true, deleteBranchRequested: false, retainedByRequest: true },
    )).toEqual({ ...retained, worktreeCleanup: 'pending' });

    expect(resetFinalizationStagesForRequest(
      retained,
      { commit: true, merge: true, cleanup: true },
      { managedWorktree: false, deleteBranchRequested: true, retainedByRequest: true },
    )).toEqual(retained);

    expect(resetFinalizationStagesForRequest(
      retained,
      { commit: true, merge: true, cleanup: true },
      { managedWorktree: true, deleteBranchRequested: true, retainedByRequest: false },
    )).toEqual(retained);

    expect(resetFinalizationStagesForRequest(
      { ...retained, branchCleanup: 'pending', worktreeCleanup: 'failed', lastError: 'managed worktree is dirty; cleanup preserved it' },
      { commit: true, merge: true, cleanup: true },
      { managedWorktree: true, deleteBranchRequested: true, retainedByRequest: false, workspaceDirty: true },
    )).toEqual({
      validation: 'done',
      commit: 'pending',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    });
  });
  test('periodic reconciler never reclaims a cancelled Work explicitly retained by terminal resource disposition', async () => {
    const fx = fixture('retained-cancelled');
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: fx.handle.workId,
      repoId: fx.repository.repoId,
      mode: 'direct_control',
      objective: 'Explicitly retained cancelled Work must not be reclaimed by periodic cleanup.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'cancelled',
      phase: 'cleanup',
    });
    const retained = writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      terminalResourceDisposition: {
        mode: 'retained_by_request',
        retainWorktree: true,
        retainBranch: true,
        recordedAt: new Date(Date.now() - 120_000).toISOString(),
      },
      finalization: {
        validation: 'done',
        commit: 'skipped',
        merge: 'skipped',
        branchCleanup: 'skipped',
        worktreeCleanup: 'skipped',
      },
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    expect(existsSync(retained.worktreePath)).toBe(true);

    const report = await reconcileTerminalWorkCleanups(fx.controllerHome, {
      nowMs: Date.now(),
      minAgeMs: 60_000,
      maxWork: 20,
    });
    expect(report.skippedRetained).toContain(retained.workId);
    expect(report.cleaned).not.toContain(retained.workId);
    expect(report.attempted).toBe(0);
    expect(existsSync(retained.worktreePath)).toBe(true);
    expect(readWorkHandle(fx.controllerHome, fx.repository.repoId, retained.workId)?.terminalResourceDisposition?.mode).toBe('retained_by_request');
  });

  test('periodic reconciler closes a stale cancelled managed Work without a caller cleanup request', async () => {
    const fx = fixture('periodic-cancelled');
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: fx.handle.workId,
      repoId: fx.repository.repoId,
      mode: 'direct_control',
      objective: 'Cancelled Work should close its managed Git resources.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'cancelled',
      phase: 'cleanup',
    });

    const report = await reconcileTerminalWorkCleanups(fx.controllerHome, { minAgeMs: 0, maxWork: 5 });
    expect(report.cleaned).toContain(fx.handle.workId);
    expect(report.errors).toEqual([]);
    expect(existsSync(fx.workspace.root!)).toBe(false);
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(false);
    expect(readWorkHandle(fx.controllerHome, fx.repository.repoId, fx.handle.workId)?.state).toBe('cleaned');
  });

  test('periodic reconciler reconstructs missing physical ownership from a completed WorkContract', async () => {
    const fx = fixture('missing-handle-contract');
    const workId = 'work-terminal-cleanup-missing-handle-contract-only';
    const branch = 'work/terminal-cleanup-missing-handle-contract-only';
    const workspace = ensureManagedWorkspace(fx.controllerHome, getRepository(fx.repository.repoId, fx.controllerHome), {
      requestId: 'terminal-cleanup-missing-handle-contract-only',
      title: 'Terminal Cleanup Missing Handle Contract Only',
      branchName: branch,
    });
    const revision = workspace.baseRevision!;
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId,
      repoId: fx.repository.repoId,
      mode: 'goal_workloop',
      objective: 'Completed WorkContract must remain sufficient physical cleanup authority when its WorkHandle is missing.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'delivery',
      checkoutId: workspace.checkoutId,
      worktreeRef: workspace.root,
      baseRevision: revision,
    });
    const now = new Date().toISOString();
    recordWorkCompletionReceipt(
      { controllerHome: fx.controllerHome, repoId: fx.repository.repoId },
      workId,
      {
        schemaVersion: 1,
        receiptId: 'receipt-missing-handle-contract-only',
        source: 'controller_work',
        issueId: 'work',
        taskId: workId,
        workId,
        targetBranch: 'main',
        targetRevision: revision,
        sourceRevision: revision,
        baseRevision: revision,
        changedPaths: [],
        delivery: { kind: 'commit', status: 'integrated', strategy: 'already_integrated', reachable: true, recordedAt: now },
        cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt: now },
        verifiedAt: now,
        recordedAt: now,
      },
      'completed_changed',
      'repository_change',
    );
    expect(readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)).toBeUndefined();
    expect(existsSync(workspace.root!)).toBe(true);

    const report = await reconcileTerminalWorkCleanups(fx.controllerHome, { minAgeMs: 0, maxWork: 10 });
    expect(report.cleaned).toContain(workId);
    expect(report.errors).toEqual([]);
    expect(existsSync(workspace.root!)).toBe(false);
    expect(branchExists(fx.repositoryRoot, branch)).toBe(false);
    expect(readWorkHandle(fx.controllerHome, fx.repository.repoId, workId)?.state).toBe('cleaned');
  });

  test('periodic reconciler repairs only clean zero-unique-commit legacy branch drift before cleanup', async () => {
    const fx = fixture('periodic-branch-drift');
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: fx.handle.workId,
      repoId: fx.repository.repoId,
      mode: 'direct_control',
      objective: 'Legacy branch identity drift should be reconciled only when cleanup is provably lossless.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'cancelled',
      phase: 'cleanup',
    });
    const actualBranch = 'cleanup/periodic-branch-drift';
    git(fx.workspace.root!, ['branch', '-m', actualBranch]);

    const report = await reconcileTerminalWorkCleanups(fx.controllerHome, { minAgeMs: 0, maxWork: 5 });
    expect(report.branchReconciled).toContainEqual({ workId: fx.handle.workId, from: fx.branch, to: actualBranch });
    expect(report.cleaned).toContain(fx.handle.workId);
    expect(existsSync(fx.workspace.root!)).toBe(false);
    expect(branchExists(fx.repositoryRoot, actualBranch)).toBe(false);
  });

  test('periodic reconciler leaves non-terminal Work untouched', async () => {
    const fx = fixture('periodic-active');
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: fx.handle.workId,
      repoId: fx.repository.repoId,
      mode: 'direct_control',
      objective: 'Active Work remains owned.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'running',
      phase: 'implementation',
    });

    const report = await reconcileTerminalWorkCleanups(fx.controllerHome, { minAgeMs: 0, maxWork: 5 });
    expect(report.skippedNonTerminal).toContain(fx.handle.workId);
    expect(existsSync(fx.workspace.root!)).toBe(true);
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(true);
  });

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

  test('cleans a migrated managed worktree whose checkout metadata was not transferred', async () => {
    const fx = fixture('migrated-unregistered');
    const registryPath = join(fx.controllerHome, 'repositories.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { repositories: Array<{ repoId: string; checkouts: Array<{ checkoutId: string }> }> };
    const record = registry.repositories.find((candidate) => candidate.repoId === fx.repository.repoId)!;
    record.checkouts = record.checkouts.filter((checkout) => checkout.checkoutId !== fx.workspace.checkoutId);
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const result = await cleanup(fx);
    expect(result.handle.state).toBe('cleaned');
    expect(result.receipt).toMatchObject({ complete: true, worktree: { status: 'removed' }, checkoutRegistry: { status: 'already_removed' } });
    expect(result.receipt.checkoutRegistry.reason).toContain('Controller Home migration');
    expect(existsSync(fx.workspace.root!)).toBe(false);
  });

  test('deletes a branch proven contained in targetBranch even when the cleanup checkout HEAD is stale', async () => {
    const fx = fixture('stale-current-head');
    writeFileSync(join(fx.workspace.root!, 'delivered.txt'), 'delivered\n');
    git(fx.workspace.root!, ['add', 'delivered.txt']);
    git(fx.workspace.root!, ['commit', '-m', 'deliver feature']);
    const featureHead = git(fx.workspace.root!, ['rev-parse', 'HEAD']);
    git(fx.repositoryRoot, ['merge', '--ff-only', fx.branch]);
    expect(git(fx.repositoryRoot, ['rev-parse', 'main'])).toBe(featureHead);
    git(fx.repositoryRoot, ['branch', 'stale-cleanup-head', fx.handle.baseCommit!]);
    git(fx.repositoryRoot, ['checkout', 'stale-cleanup-head']);

    const handle = writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      expectedHead: featureHead,
    });
    const result = await cleanup(fx, handle);
    expect(result.receipt).toMatchObject({
      complete: true,
      branchCleanup: { status: 'deleted', uniqueCommits: 0 },
      worktree: { status: 'removed' },
    });
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(false);
    expect(git(fx.repositoryRoot, ['branch', '--show-current'])).toBe('stale-cleanup-head');
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


  test('does not create a bundle for ancestry-only unique commits with no source delta', async () => {
    const fx = fixture('empty-unique');
    git(fx.workspace.root!, ['commit', '--allow-empty', '-m', 'chore: ancestry-only marker']);
    const head = git(fx.workspace.root!, ['rev-parse', 'HEAD']);
    const current = writeWorkHandle(fx.controllerHome, { ...fx.handle, expectedHead: head });

    const result = await cleanup(fx, current);

    expect(result.receipt.complete).toBe(true);
    expect(result.receipt.branchCleanup).toMatchObject({ status: 'deleted', uniqueCommits: 1 });
    expect(result.receipt.preservation.bundlePath).toBeUndefined();
    expect(result.receipt.preservation.bundleRetirement).toMatchObject({
      status: 'not_needed',
      reason: 'no_source_delta',
      protectedRevision: head,
      comparedPaths: [],
    });
    expect(existsSync(fx.workspace.root!)).toBe(false);
    expect(branchExists(fx.repositoryRoot, fx.branch)).toBe(false);
  });

  test('periodic cleanup retires a terminal bundle only after local and origin target content contain the protected delta', async () => {
    const fx = fixture('retire-contained-bundle');
    writeFileSync(join(fx.workspace.root!, 'contained.txt'), 'delivered content\n');
    git(fx.workspace.root!, ['add', 'contained.txt']);
    git(fx.workspace.root!, ['commit', '-m', 'feat: preserved then delivered']);
    const head = git(fx.workspace.root!, ['rev-parse', 'HEAD']);
    const current = writeWorkHandle(fx.controllerHome, { ...fx.handle, expectedHead: head });
    const cleaned = await cleanup(fx, current);
    const bundlePath = cleaned.receipt.preservation.bundlePath!;
    expect(existsSync(bundlePath)).toBe(true);

    git(fx.repositoryRoot, ['cherry-pick', head]);
    const delivered = git(fx.repositoryRoot, ['rev-parse', 'HEAD']);
    git(fx.repositoryRoot, ['update-ref', 'refs/remotes/origin/main', delivered]);

    const report = cleanupControllerRuntimeState(fx.controllerHome, {
      cleanupArtifactRetentionGraceMs: 0,
      maxEntries: 1_000,
      maxRemovals: 50,
    });

    expect(existsSync(bundlePath)).toBe(false);
    expect(report.removedCleanupArtifactPaths.some((path) => path.endsWith(`${fx.handle.workId}/branch.bundle`))).toBe(true);
    const after = readWorkHandle(fx.controllerHome, fx.repository.repoId, fx.handle.workId)!;
    expect(after.cleanupReceipt?.preservation.bundlePath).toBeUndefined();
    expect(after.cleanupReceipt?.preservation.bundleRetirement).toMatchObject({
      status: 'removed',
      reason: 'target_and_remote_content_contained',
      protectedRevision: head,
      targetRevision: delivered,
      remoteRevision: delivered,
      comparedPaths: ['contained.txt'],
    });
  });

  test('periodic cleanup preserves a bundle when remote target containment is not proven', async () => {
    const fx = fixture('retain-without-remote-proof');
    writeFileSync(join(fx.workspace.root!, 'local-only.txt'), 'local delivery only\n');
    git(fx.workspace.root!, ['add', 'local-only.txt']);
    git(fx.workspace.root!, ['commit', '-m', 'feat: local only delivery']);
    const head = git(fx.workspace.root!, ['rev-parse', 'HEAD']);
    const current = writeWorkHandle(fx.controllerHome, { ...fx.handle, expectedHead: head });
    const cleaned = await cleanup(fx, current);
    const bundlePath = cleaned.receipt.preservation.bundlePath!;
    git(fx.repositoryRoot, ['cherry-pick', head]);

    const report = cleanupControllerRuntimeState(fx.controllerHome, {
      cleanupArtifactRetentionGraceMs: 0,
      maxEntries: 1_000,
      maxRemovals: 50,
    });

    expect(existsSync(bundlePath)).toBe(true);
    expect(report.removedCleanupArtifactPaths).not.toContain(bundlePath);
    expect(report.cycle.skippedByReason.cleanup_artifact_containment_remote_revision_unavailable).toBeGreaterThan(0);
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

  test('preserves merged delivery state when cleanup is blocked by another live process', async () => {
    const fx = fixture('merged-process-owner');
    const now = new Date().toISOString();
    const merged = writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      state: 'merged',
      finalization: {
        ...fx.handle.finalization,
        validation: 'done',
        commit: 'done',
        merge: 'done',
      },
    });
    createProcessRecord({
      schemaVersion: 1,
      processId: 'proc-other-live-after-merge',
      repoId: fx.repository.repoId,
      checkoutId: fx.workspace.checkoutId,
      workId: undefined,
      controllerHome: fx.controllerHome,
      status: 'running',
      route: 'managed',
      commandId: 'other-live-after-merge',
      command: { kind: 'argv', executable: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], cwd: fx.workspace.root! },
      resourceClaims: [],
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      startedAt: now,
      updatedAt: now,
      terminalFenceToken: 1
    } satisfies ManagedProcessRecord);

    const result = await cleanup(fx, merged);
    expect(result.handle.state).toBe('merged');
    expect(result.handle.failureReason).toBeUndefined();
    expect(result.handle.finalization.merge).toBe('done');
    expect(result.receipt.complete).toBe(false);
    expect(result.receipt.blockers.join('\n')).toContain('ACTIVE_PROCESS_OTHER_WORK');
  });

  test('reconciles a stale process proven abandoned before OS spawn', async () => {
    const fx = fixture('stale-pre-spawn-process');
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const processId = 'proc-stale-pre-spawn-cleanup';
    createProcessRecord({
      schemaVersion: 1,
      processId,
      repoId: fx.repository.repoId,
      checkoutId: fx.workspace.checkoutId,
      workId: undefined,
      controllerHome: fx.controllerHome,
      status: 'starting',
      route: 'direct',
      commandId: 'stale-pre-spawn-command',
      command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: fx.workspace.root! },
      resourceClaims: [{ resourceKey: `workspace:${fx.workspace.checkoutId}`, mode: 'read' }],
      interactiveWaitMs: 800,
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      startedAt: stale,
      updatedAt: stale,
      terminalFenceToken: 5,
      exitReceiptPath: join(processLogDir(fx.controllerHome, fx.repository.repoId), `${processId}.exit.json`),
      commandDescriptorPath: join(processLogDir(fx.controllerHome, fx.repository.repoId), `${processId}.command.json`),
    } satisfies ManagedProcessRecord);

    const result = await cleanup(fx);
    expect(result.receipt.complete).toBe(true);
    expect(result.receipt.processes.blocking).toEqual([]);
    expect(result.receipt.blockers).toEqual([]);
    expect(result.handle.state).toBe('cleaned');
  });

  test('reconciles a receipt-backed terminal process before checkout blocker classification', async () => {
    const fx = fixture('receipt-backed-process');
    const now = new Date().toISOString();
    const processId = 'proc-receipt-backed-terminal';
    const exitReceiptPath = join(processLogDir(fx.controllerHome, fx.repository.repoId), `${processId}.exit.json`);
    createProcessRecord({
      schemaVersion: 1,
      processId,
      repoId: fx.repository.repoId,
      checkoutId: fx.workspace.checkoutId,
      controllerHome: fx.controllerHome,
      status: 'starting',
      route: 'managed',
      commandId: 'receipt-backed-command',
      command: { kind: 'argv', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: fx.workspace.root! },
      resourceClaims: [],
      interactiveWaitMs: 0,
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      startedAt: now,
      updatedAt: now,
      terminalFenceToken: 9,
      exitReceiptPath,
    } satisfies ManagedProcessRecord);
    writeFileSync(exitReceiptPath, `${JSON.stringify({
      schemaVersion: 1,
      processId,
      exitCode: 0,
      finishedAt: now,
      commandExecutedOnce: true,
    })}\n`);

    const result = await cleanup(fx);
    expect(result.receipt.complete).toBe(true);
    expect(result.receipt.processes.blocking).toEqual([]);
    expect(result.receipt.blockers).toEqual([]);
    expect(result.handle.state).toBe('cleaned');
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

  test('does not treat a cancelled WorkContract with a stale prepared handle as a live checkout owner', async () => {
    const fx = fixture('cancelled-owner');
    const now = new Date().toISOString();
    const otherWorkId = 'work-cancelled-stale-owner';
    createWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, {
      workId: otherWorkId,
      repoId: fx.repository.repoId,
      mode: 'direct_control',
      objective: 'Cancelled auxiliary cleanup ownership must not retain the checkout.',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'cancelled',
      phase: 'cleanup',
    });
    writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      recordRevision: undefined,
      workId: otherWorkId,
      workContractId: otherWorkId,
      sessionId: 'session-cancelled-stale-owner',
      state: 'prepared',
      failureReason: undefined,
      cleanupReceipt: undefined,
      createdAt: now,
      updatedAt: now,
    });

    const result = await cleanup(fx);
    expect(result.receipt.complete).toBe(true);
    expect(result.receipt.blockers).toEqual([]);
    expect(result.handle.state).toBe('cleaned');
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
        branchName: `work/terminal-cleanup-${label}`,
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

  test('terminal cleanup honors durable non-default delivery target and rejects explicit rebinding', async () => {
    const fx = fixture('bound-delivery-target');
    git(fx.repositoryRoot, ['branch', 'kernel-v2/architecture']);
    const bound = writeWorkHandle(fx.controllerHome, {
      ...fx.handle,
      deliveryTargetBranch: 'kernel-v2/architecture',
    });
    await expect(cleanupTerminalWork({
      controllerHome: fx.controllerHome,
      handle: bound,
      targetBranch: 'main',
      deleteBranch: true,
      terminalOutcome: 'failed',
    })).rejects.toThrow(/WORK_DELIVERY_TARGET_BRANCH_MISMATCH.*kernel-v2\/architecture.*main/);

    const cleaned = await cleanupTerminalWork({
      controllerHome: fx.controllerHome,
      handle: bound,
      deleteBranch: true,
      terminalOutcome: 'failed',
    });
    expect(cleaned.receipt.targetBranch).toBe('kernel-v2/architecture');
  });

});
