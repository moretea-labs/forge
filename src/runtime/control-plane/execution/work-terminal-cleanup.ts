import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import {
  getRepository,
  selectRepositoryCheckout,
  setRepositoryCheckoutLifecycle,
} from '../../../cli/repositories/registry';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { getWorkContract } from '../facade/work-contract-store';
import { isTerminalWorkContractStatus } from '../facade/types';
import {
  cancelProcess,
  getProcessHandle,
  isManagedProcessActive,
  isManagedProcessTerminal,
  reconcileAbandonedPreSpawnProcess,
  releaseProcessLeasesOnce,
} from '../../execution/process-runtime';
import { getProcessRecord, listProcessRecords } from '../../execution/process-runtime/store';
import {
  listWorkHandles,
  transitionWorkHandle,
  writeWorkHandle,
  type WorkCleanupReceipt,
  type WorkHandleState,
  type WorkTerminalOutcome,
} from './work-handle-store';

const CHECKPOINT_MESSAGE = 'chore(checkpoint): preserve terminal work before cleanup';

export interface TerminalWorkCleanupInput {
  controllerHome: string;
  handle: WorkHandleState;
  targetBranch?: string;
  deleteBranch?: boolean;
  terminalOutcome: WorkTerminalOutcome;
  failureReason?: string;
}

export interface TerminalWorkCleanupResult {
  handle: WorkHandleState;
  receipt: WorkCleanupReceipt;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashText(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(root: string, args: string[], timeout = 30_000): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

function deterministicReceiptId(handle: WorkHandleState): string {
  return `cleanup_${hashText(`${handle.repositoryId}\0${handle.checkoutId}\0${handle.workId}`).slice(0, 24)}`;
}

function artifactRoot(controllerHome: string, handle: WorkHandleState): string {
  const root = join(repositoryControllerRoot(controllerHome, handle.repositoryId), 'cleanup-artifacts', handle.workId);
  mkdirSync(root, { recursive: true });
  return root;
}

function newReceipt(handle: WorkHandleState, targetBranch: string, terminalOutcome: WorkTerminalOutcome): WorkCleanupReceipt {
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    receiptId: deterministicReceiptId(handle),
    repoId: handle.repositoryId,
    checkoutId: handle.checkoutId,
    workId: handle.workId,
    branch: handle.branch,
    targetBranch,
    terminalOutcome,
    startedAt: timestamp,
    updatedAt: timestamp,
    verification: { mode: 'cleanup_only', checksRun: [] },
    processes: { examined: [], terminated: [], blocking: [], allTerminal: false },
    ownership: { controllerLease: 'pending', processLeases: 'pending' },
    preservation: { status: 'not_needed' },
    worktree: { path: handle.worktreePath, status: 'pending' },
    branchCleanup: { branch: handle.branch, status: 'pending' },
    checkoutRegistry: { status: 'pending' },
    prune: { status: 'pending' },
    complete: false,
    partial: false,
    blockers: [],
  };
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function persist(
  controllerHome: string,
  handle: WorkHandleState,
  receipt: WorkCleanupReceipt,
): WorkHandleState {
  receipt.updatedAt = nowIso();
  return writeWorkHandle(controllerHome, { ...handle, cleanupReceipt: receipt });
}

function addBlocker(receipt: WorkCleanupReceipt, reason: string): void {
  receipt.blockers = appendUnique(receipt.blockers, reason.slice(0, 1_000));
  receipt.partial = true;
}

function branchExists(root: string, branch: string): boolean {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

function gitCommonDir(root: string): string | undefined {
  const result = git(root, ['rev-parse', '--git-common-dir']);
  return result.ok && result.stdout ? resolve(root, result.stdout) : undefined;
}

function branchUsedByAnotherWorktree(root: string, branch: string, currentPath: string): boolean {
  const listed = git(root, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return true;
  let path = '';
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && resolve(path) !== resolve(currentPath)) return true;
  }
  return false;
}

function copyUntrackedFiles(worktreePath: string, archiveRoot: string): Array<{ path: string; sha256: string }> {
  const listed = git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!listed.ok || !listed.stdout) return [];
  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const relativePath of listed.stdout.split('\0').filter(Boolean)) {
    const source = join(worktreePath, relativePath);
    const destination = join(archiveRoot, 'untracked', relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination)) {
      cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
    }
    if (existsSync(source)) {
      try {
        manifest.push({ path: relativePath, sha256: hashText(readFileSync(source)) });
      } catch {
        manifest.push({ path: relativePath, sha256: 'directory-or-unreadable' });
      }
    }
  }
  return manifest;
}

function createPatchArchive(controllerHome: string, handle: WorkHandleState): {
  path: string;
  sha256: string;
  recoveryInstructions: string;
} {
  const root = artifactRoot(controllerHome, handle);
  const path = join(root, 'worktree.patch.json');
  if (!existsSync(path)) {
    const unstaged = git(handle.worktreePath, ['diff', '--binary', 'HEAD']);
    const staged = git(handle.worktreePath, ['diff', '--binary', '--cached', 'HEAD']);
    const untracked = copyUntrackedFiles(handle.worktreePath, root);
    const archive = {
      schemaVersion: 1,
      repoId: handle.repositoryId,
      checkoutId: handle.checkoutId,
      workId: handle.workId,
      branch: handle.branch,
      baseCommit: handle.baseCommit,
      expectedHead: handle.expectedHead,
      createdAt: nowIso(),
      unstagedPatch: unstaged.stdout,
      stagedPatch: staged.stdout,
      untracked,
    };
    writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const sha256 = hashText(readFileSync(path));
  return {
    path,
    sha256,
    recoveryInstructions: `Apply tracked changes from ${path}; restore copied untracked files from ${join(root, 'untracked')}. Verify SHA-256 ${sha256}.`,
  };
}

function createVerifiedBundle(controllerHome: string, handle: WorkHandleState, targetRoot: string): {
  path: string;
  sha256: string;
} {
  const path = join(artifactRoot(controllerHome, handle), 'branch.bundle');
  if (!existsSync(path)) {
    const created = git(targetRoot, ['bundle', 'create', path, `refs/heads/${handle.branch}`], 60_000);
    if (!created.ok) throw new Error(created.stderr || 'git bundle create failed');
  }
  const verified = git(targetRoot, ['bundle', 'verify', path], 60_000);
  if (!verified.ok) throw new Error(verified.stderr || 'git bundle verify failed');
  return { path, sha256: hashText(readFileSync(path)) };
}

async function settleProcesses(input: TerminalWorkCleanupInput, receipt: WorkCleanupReceipt): Promise<void> {
  const observed = listProcessRecords(input.controllerHome, input.handle.repositoryId, 5_000)
    .filter((record) => record.checkoutId === input.handle.checkoutId);
  const records = observed.map((record) => {
    // Reconcile independent Runner receipts before classifying ownership. This
    // never re-executes a command and can only perform a monotonic,
    // fence-token-bound terminal transition.
    if (record.exitReceiptPath) {
      getProcessHandle(input.controllerHome, input.handle.repositoryId, record.processId);
    }
    let current = getProcessRecord(input.controllerHome, input.handle.repositoryId, record.processId) ?? record;
    if (isManagedProcessActive(current)) {
      current = reconcileAbandonedPreSpawnProcess(
        input.controllerHome,
        input.handle.repositoryId,
        record.processId,
      ) ?? current;
    }
    if (isManagedProcessTerminal(current)) {
      releaseProcessLeasesOnce(input.controllerHome, input.handle.repositoryId, current.processId);
      return getProcessRecord(input.controllerHome, input.handle.repositoryId, current.processId) ?? current;
    }
    return current;
  });
  const otherOwners = records.filter((record) =>
    isManagedProcessActive(record)
    && record.workId !== input.handle.workId);
  for (const record of otherOwners) {
    receipt.processes.blocking = appendUnique(receipt.processes.blocking, record.processId);
    addBlocker(receipt, `ACTIVE_PROCESS_OTHER_WORK: ${record.processId} belongs to ${record.workId ?? 'unbound process'}`);
  }
  if (otherOwners.length > 0) {
    receipt.processes.allTerminal = false;
    receipt.ownership.processLeases = 'partial';
    return;
  }

  const owned = records.filter((record) => record.workId === input.handle.workId);
  for (const record of owned) {
    receipt.processes.examined = appendUnique(receipt.processes.examined, record.processId);
    if (isManagedProcessActive(record)) {
      await cancelProcess(input.controllerHome, input.handle.repositoryId, record.processId);
      receipt.processes.terminated = appendUnique(receipt.processes.terminated, record.processId);
    }
    releaseProcessLeasesOnce(input.controllerHome, input.handle.repositoryId, record.processId);
    const settled = getProcessRecord(input.controllerHome, input.handle.repositoryId, record.processId);
    if (settled && isManagedProcessActive(settled)) {
      receipt.processes.blocking = appendUnique(receipt.processes.blocking, record.processId);
      addBlocker(receipt, `PROCESS_STILL_ACTIVE: ${record.processId}`);
    }
    if (settled && (settled.leaseRefs?.length ?? 0) > 0 && settled.leasesReleased !== true) {
      addBlocker(receipt, `PROCESS_LEASE_RELEASE_INCOMPLETE: ${record.processId}`);
    }
  }
  receipt.processes.allTerminal = receipt.processes.blocking.length === 0;
  receipt.ownership.processLeases = receipt.processes.allTerminal ? 'released' : 'partial';
}

function workHandleOwnsCheckout(controllerHome: string, handle: WorkHandleState): boolean {
  if (handle.state === 'cleaned') return false;
  const contract = getWorkContract(
    { controllerHome, repoId: handle.repositoryId },
    handle.workContractId ?? handle.workId,
  );
  // WorkContract completion is the authoritative ownership boundary. Older
  // runtimes could persist a completed contract while leaving the handle in a
  // non-terminal state; that historical handle must not remain a live owner.
  return contract === undefined || !isTerminalWorkContractStatus(contract.status);
}

function assertNoOtherLiveWork(input: TerminalWorkCleanupInput, receipt: WorkCleanupReceipt): void {
  const live = listWorkHandles(input.controllerHome, input.handle.repositoryId)
    .filter((handle) =>
      handle.workId !== input.handle.workId
      && handle.checkoutId === input.handle.checkoutId
      && resolve(handle.worktreePath) === resolve(input.handle.worktreePath)
      && workHandleOwnsCheckout(input.controllerHome, handle));
  for (const handle of live) addBlocker(receipt, `LIVE_WORK_OWNS_CHECKOUT: ${handle.workId} (${handle.state})`);
}

function preserveDirtyWorktree(
  input: TerminalWorkCleanupInput,
  receipt: WorkCleanupReceipt,
  current: WorkHandleState,
): WorkHandleState {
  const status = git(current.worktreePath, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) {
    receipt.preservation.status = 'failed';
    addBlocker(receipt, `GIT_STATUS_FAILED: ${status.stderr || 'unknown git status failure'}`);
    return persist(input.controllerHome, current, receipt);
  }
  if (!status.stdout) {
    receipt.preservation.status = receipt.preservation.checkpointCommit || receipt.preservation.patchArchivePath
      ? receipt.preservation.status
      : 'not_needed';
    return persist(input.controllerHome, current, receipt);
  }

  if (!receipt.preservation.checkpointCommit && !receipt.preservation.patchArchivePath) {
    const staged = git(current.worktreePath, ['add', '-A']);
    const committed = staged.ok
      ? git(current.worktreePath, [
          '-c', 'user.name=repo-harness',
          '-c', 'user.email=repo-harness@local.invalid',
          'commit', '-m', CHECKPOINT_MESSAGE,
        ], 60_000)
      : { ok: false, stdout: '', stderr: staged.stderr };
    if (committed.ok) {
      const head = git(current.worktreePath, ['rev-parse', 'HEAD']);
      if (!head.ok || !head.stdout) {
        receipt.preservation.status = 'failed';
        addBlocker(receipt, 'CHECKPOINT_HEAD_UNAVAILABLE');
      } else {
        receipt.preservation.status = 'checkpointed';
        receipt.preservation.checkpointCommit = head.stdout;
        current = writeWorkHandle(input.controllerHome, {
          ...current,
          expectedHead: head.stdout,
          cleanupReceipt: receipt,
        });
      }
    } else {
      try {
        const archive = createPatchArchive(input.controllerHome, current);
        receipt.preservation.status = 'patch_archived';
        receipt.preservation.patchArchivePath = archive.path;
        receipt.preservation.patchArchiveSha256 = archive.sha256;
        receipt.preservation.recoveryInstructions = archive.recoveryInstructions;
      } catch (error) {
        receipt.preservation.status = 'failed';
        addBlocker(receipt, `PRESERVATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (receipt.preservation.checkpointCommit && status.stdout) {
    try {
      const archive = createPatchArchive(input.controllerHome, current);
      receipt.preservation.status = 'patch_archived';
      receipt.preservation.patchArchivePath = archive.path;
      receipt.preservation.patchArchiveSha256 = archive.sha256;
      receipt.preservation.recoveryInstructions = archive.recoveryInstructions;
    } catch (error) {
      receipt.preservation.status = 'failed';
      addBlocker(receipt, `POST_CHECKPOINT_PRESERVATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return persist(input.controllerHome, current, receipt);
}

export async function cleanupTerminalWork(input: TerminalWorkCleanupInput): Promise<TerminalWorkCleanupResult> {
  const repository = getRepository(input.handle.repositoryId, input.controllerHome, { includeRemoved: true });
  const targetBranch = input.targetBranch?.trim() || repository.defaultBranch || 'main';
  const deleteBranch = input.deleteBranch !== false;
  let current = input.handle;
  const preservedFailure = (input.failureReason ?? current.failureReason ?? current.finalization.lastError ?? 'terminal work cleanup').slice(0, 1_000);
  const receipt = current.cleanupReceipt ?? newReceipt(current, targetBranch, input.terminalOutcome);

  if (
    receipt.repoId !== current.repositoryId
    || receipt.checkoutId !== current.checkoutId
    || receipt.workId !== current.workId
  ) throw new Error('WORK_CLEANUP_RECEIPT_IDENTITY_MISMATCH');

  if (current.state === 'cleaned' && receipt.complete) return { handle: current, receipt };

  // Retryable blockers are observations, not permanent vetoes. Recompute them
  // from durable Work/Process/Git state after a controller restart or retry.
  receipt.blockers = [];
  receipt.partial = false;
  receipt.processes.examined = [];
  receipt.processes.terminated = [];
  receipt.processes.blocking = [];
  receipt.processes.allTerminal = false;
  if (receipt.worktree.status === 'failed' || receipt.worktree.status === 'retained') receipt.worktree.status = 'pending';
  if (receipt.branchCleanup.status === 'failed' || receipt.branchCleanup.status === 'retained') receipt.branchCleanup.status = 'pending';
  if (receipt.checkoutRegistry.status === 'failed') receipt.checkoutRegistry.status = 'pending';
  if (receipt.prune.status === 'failed') receipt.prune.status = 'pending';
  if (!current.managedWorktree) {
    receipt.worktree.status = 'already_removed';
    receipt.worktree.reason = 'Work did not create a managed worktree.';
  }

  if (current.state !== 'failed_terminal_cleanup') {
    current = transitionWorkHandle(input.controllerHome, current, 'failed_terminal_cleanup', {
      failureReason: preservedFailure,
      cleanupReceipt: receipt,
      validationRun: undefined,
      finalization: {
        ...current.finalization,
        validation: input.terminalOutcome === 'validation_failed' || input.terminalOutcome === 'infrastructure_failed'
          ? 'failed'
          : current.finalization.validation,
        commit: current.finalization.commit === 'pending' ? 'skipped' : current.finalization.commit,
        merge: current.finalization.merge === 'pending' ? 'skipped' : current.finalization.merge,
        lastError: preservedFailure,
      },
    });
  } else {
    current = persist(input.controllerHome, current, receipt);
  }

  await settleProcesses(input, receipt);
  assertNoOtherLiveWork(input, receipt);
  current = persist(input.controllerHome, current, receipt);
  if (receipt.blockers.length > 0) return { handle: current, receipt };

  const target = selectRepositoryCheckout(repository, current.sourceCheckoutId ?? repository.activeCheckoutId, { allowArchived: true });
  let registeredPath: string | undefined;
  try {
    registeredPath = selectRepositoryCheckout(repository, current.checkoutId, { allowArchived: true }).canonicalRoot;
  } catch {
    registeredPath = undefined;
  }
  if (registeredPath && resolve(registeredPath) !== resolve(current.worktreePath)) {
    addBlocker(receipt, `WORKTREE_PATH_MISMATCH: registry=${registeredPath}; handle=${current.worktreePath}`);
    current = persist(input.controllerHome, current, receipt);
    return { handle: current, receipt };
  }
  if (!registeredPath && existsSync(current.worktreePath)) {
    addBlocker(receipt, 'CHECKOUT_NOT_CONTROLLER_REGISTERED');
    current = persist(input.controllerHome, current, receipt);
    return { handle: current, receipt };
  }

  if (existsSync(current.worktreePath)) {
    const root = git(current.worktreePath, ['rev-parse', '--show-toplevel']);
    const branch = git(current.worktreePath, ['branch', '--show-current']);
    const worktreeCommonDir = gitCommonDir(current.worktreePath);
    const targetCommonDir = gitCommonDir(target.canonicalRoot);
    if (!worktreeCommonDir || !targetCommonDir || worktreeCommonDir !== targetCommonDir) {
      addBlocker(receipt, `GIT_COMMON_DIR_MISMATCH: worktree=${worktreeCommonDir ?? 'unknown'}; target=${targetCommonDir ?? 'unknown'}`);
      current = persist(input.controllerHome, current, receipt);
      return { handle: current, receipt };
    }
    if (!root.ok || resolve(root.stdout) !== resolve(current.worktreePath) || !branch.ok || branch.stdout !== current.branch) {
      addBlocker(receipt, 'WORKTREE_IDENTITY_INVALID');
      current = persist(input.controllerHome, current, receipt);
      return { handle: current, receipt };
    }
    current = preserveDirtyWorktree(input, receipt, current);
    if (receipt.preservation.status === 'failed' || receipt.blockers.length > 0) {
      receipt.worktree.status = 'retained';
      receipt.worktree.reason = 'Preservation did not complete; destructive cleanup was blocked.';
      current = persist(input.controllerHome, current, receipt);
      return { handle: current, receipt };
    }
  } else {
    receipt.worktree.status = 'already_removed';
  }

  let uniqueCommits = 0;
  if (branchExists(target.canonicalRoot, current.branch)) {
    if (!branchExists(target.canonicalRoot, targetBranch)) {
      addBlocker(receipt, `TARGET_BRANCH_MISSING: ${targetBranch}`);
    } else {
      const unique = git(target.canonicalRoot, ['rev-list', '--count', `refs/heads/${targetBranch}..refs/heads/${current.branch}`]);
      if (!unique.ok || !/^\d+$/.test(unique.stdout)) addBlocker(receipt, `BRANCH_UNIQUENESS_UNKNOWN: ${unique.stderr || unique.stdout}`);
      else uniqueCommits = Number(unique.stdout);
    }
  }
  receipt.branchCleanup.uniqueCommits = uniqueCommits;

  if (uniqueCommits > 0 && !receipt.preservation.bundlePath) {
    try {
      const bundle = createVerifiedBundle(input.controllerHome, current, target.canonicalRoot);
      receipt.preservation.bundlePath = bundle.path;
      receipt.preservation.bundleSha256 = bundle.sha256;
      receipt.preservation.recoveryInstructions = [
        receipt.preservation.recoveryInstructions,
        `Recover branch commits with: git fetch ${bundle.path} refs/heads/${current.branch}:refs/heads/${current.branch}`,
      ].filter(Boolean).join(' ');
    } catch (error) {
      addBlocker(receipt, `BRANCH_BUNDLE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  current = persist(input.controllerHome, current, receipt);
  if (receipt.blockers.length > 0) {
    receipt.worktree.status = existsSync(current.worktreePath) ? 'retained' : receipt.worktree.status;
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Unique commits were not durably preserved.';
    current = persist(input.controllerHome, current, receipt);
    return { handle: current, receipt };
  }

  if (existsSync(current.worktreePath)) {
    const removed = git(target.canonicalRoot, ['worktree', 'remove', '--force', current.worktreePath], 60_000);
    if (!removed.ok && existsSync(current.worktreePath)) {
      receipt.worktree.status = 'failed';
      receipt.worktree.reason = removed.stderr || 'git worktree remove failed';
      addBlocker(receipt, `WORKTREE_REMOVE_FAILED: ${receipt.worktree.reason}`);
      current = persist(input.controllerHome, current, receipt);
      return { handle: current, receipt };
    }
    receipt.worktree.status = 'removed';
  } else if (receipt.worktree.status === 'pending') {
    receipt.worktree.status = 'already_removed';
  }

  try {
    setRepositoryCheckoutLifecycle({
      controllerHome: input.controllerHome,
      repoId: current.repositoryId,
      checkoutId: current.checkoutId,
      lifecycle: 'removed',
      reason: `Terminal Work ${current.workId} cleanup ${receipt.receiptId}.`,
    });
    receipt.checkoutRegistry.status = registeredPath ? 'removed' : 'already_removed';
    markRepositoryProjectionDirty(input.controllerHome, current.repositoryId, `cleanup:${current.workId}:terminal`);
  } catch (error) {
    if (!registeredPath) receipt.checkoutRegistry.status = 'already_removed';
    else {
      receipt.checkoutRegistry.status = 'failed';
      receipt.checkoutRegistry.reason = error instanceof Error ? error.message : String(error);
      addBlocker(receipt, `CHECKOUT_REGISTRY_REMOVE_FAILED: ${receipt.checkoutRegistry.reason}`);
    }
  }

  if (!deleteBranch) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Branch retention was explicitly requested.';
  } else if (!branchExists(target.canonicalRoot, current.branch)) {
    receipt.branchCleanup.status = 'already_deleted';
  } else if (current.branch === targetBranch) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Refusing to delete the target branch.';
    addBlocker(receipt, `BRANCH_IS_TARGET: ${targetBranch}`);
  } else if (branchUsedByAnotherWorktree(target.canonicalRoot, current.branch, current.worktreePath)) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Branch is checked out by another worktree.';
    addBlocker(receipt, `BRANCH_IN_USE: ${current.branch}`);
  } else if (uniqueCommits > 0 && !receipt.preservation.bundlePath) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Unique commits are not archived.';
    addBlocker(receipt, `BRANCH_UNPRESERVED: ${current.branch}`);
  } else {
    const deleted = git(target.canonicalRoot, ['branch', uniqueCommits > 0 ? '-D' : '-d', current.branch]);
    if (!deleted.ok && branchExists(target.canonicalRoot, current.branch)) {
      receipt.branchCleanup.status = 'failed';
      receipt.branchCleanup.reason = deleted.stderr || 'branch delete failed';
      addBlocker(receipt, `BRANCH_DELETE_FAILED: ${receipt.branchCleanup.reason}`);
    } else {
      receipt.branchCleanup.status = uniqueCommits > 0 ? 'archived' : 'deleted';
    }
  }

  const pruned = git(target.canonicalRoot, ['worktree', 'prune']);
  receipt.prune.status = pruned.ok ? 'done' : 'failed';
  if (!pruned.ok) {
    receipt.prune.reason = pruned.stderr || 'git worktree prune failed';
    addBlocker(receipt, `WORKTREE_PRUNE_FAILED: ${receipt.prune.reason}`);
  }

  receipt.complete = receipt.blockers.length === 0
    && ['removed', 'already_removed'].includes(receipt.worktree.status)
    && ['removed', 'already_removed'].includes(receipt.checkoutRegistry.status)
    && (deleteBranch
      ? ['deleted', 'already_deleted', 'archived'].includes(receipt.branchCleanup.status)
      : receipt.branchCleanup.status === 'retained');
  receipt.partial = !receipt.complete;
  if (receipt.complete) receipt.completedAt = receipt.completedAt ?? nowIso();

  const finalization = {
    ...current.finalization,
    commit: current.finalization.commit === 'pending' ? 'skipped' as const : current.finalization.commit,
    merge: current.finalization.merge === 'pending' ? 'skipped' as const : current.finalization.merge,
    branchCleanup: deleteBranch
      ? receipt.complete ? 'done' as const : 'failed' as const
      : 'skipped' as const,
    worktreeCleanup: ['removed', 'already_removed'].includes(receipt.worktree.status)
      ? 'done' as const
      : 'failed' as const,
    lastError: preservedFailure,
  };

  current = receipt.complete
    ? transitionWorkHandle(input.controllerHome, current, 'cleaned', {
        failureReason: preservedFailure,
        cleanupReceipt: receipt,
        finalization,
      })
    : writeWorkHandle(input.controllerHome, {
        ...current,
        state: 'failed_terminal_cleanup',
        failureReason: preservedFailure,
        cleanupReceipt: receipt,
        finalization,
      });
  return { handle: current, receipt };
}
