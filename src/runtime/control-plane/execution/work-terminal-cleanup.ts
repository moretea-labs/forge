import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { repoLocalNoIndexControllerHome, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import {
  getRepository,
  listRepositories,
  RepositoryCheckoutSelectionError,
  selectRepositoryCheckout,
  setRepositoryCheckoutLifecycle,
} from '../../../cli/repositories/registry';
import { managedPathInside, managedWorktreeStorageRoot } from '../../../cli/repositories/worktree-storage';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { listControlPlaneRecords } from '../persistence/sqlite-store';
import { getWorkContract, recordCancelledWorkCleanupCompleted } from '../../../../packages/kernel/work/api/index';
import { markOwnedResourceCleaned, markOwnedResourceRetained } from '../../../../packages/kernel/identity/api/index';
import { managedBranchOwnedResourceId, managedWorkspaceOwnedResourceId } from '../../execution/managed-workspace';
import {
  controllerTerminalizationAuthorityFromSession,
  getControllerSession,
  releaseControllerSessionWithAuthority,
  releaseObservedControllerSession,
  type ControllerTerminalizationAuthority,
} from '../../../../packages/kernel/controller/api/index';
import { isRepositoryCompletionReceipt, isTerminalWorkContractStatus, type WorkContract } from '../facade/types';
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
  readWorkHandle,
  resolveWorkDeliveryTargetBranch,
  transitionWorkHandle,
  writeWorkHandle,
  type WorkCleanupReceipt,
  type WorkHandleState,
  type WorkTerminalOutcome,
} from './work-handle-store';
import { proveWorkPreservationContained } from '../cleanup-artifact-retention';

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
    receipt.preservation.status = 'not_needed';
    return persist(input.controllerHome, current, receipt);
  }

  // Semantic Work terminal state is not authority to mutate, commit, archive,
  // or delete uncommitted workspace content. Dirty bytes stay exactly where the
  // model/user left them until an explicit delivery/discard action resolves them.
  receipt.preservation.status = 'not_needed';
  receipt.preservation.recoveryInstructions = `Dirty managed worktree retained in place at ${current.worktreePath}; commit, deliver, or explicitly discard the pending changes before cleanup.`;
  receipt.worktree.status = 'retained';
  receipt.worktree.reason = 'Dirty managed worktree retained; terminal semantic state does not authorize destructive cleanup.';
  receipt.branchCleanup.status = 'retained';
  receipt.branchCleanup.reason = 'Branch retained with dirty managed worktree.';
  addBlocker(receipt, 'DIRTY_WORKTREE_RETAINED');
  markOwnedResourceRetained(input.controllerHome, managedWorkspaceOwnedResourceId(current.repositoryId, current.checkoutId));
  markOwnedResourceRetained(input.controllerHome, managedBranchOwnedResourceId(current.repositoryId, current.checkoutId));
  return persist(input.controllerHome, current, receipt);
}

function selectTerminalCleanupTarget(repository: ReturnType<typeof getRepository>, handle: WorkHandleState): ReturnType<typeof getRepository> {
  const sourceCheckoutId = handle.sourceCheckoutId?.trim();
  if (sourceCheckoutId) {
    try {
      return selectRepositoryCheckout(repository, sourceCheckoutId, { allowArchived: true });
    } catch (error) {
      const unavailable = error instanceof RepositoryCheckoutSelectionError
        && (error.code === 'CHECKOUT_NOT_FOUND' || (error.code === 'CHECKOUT_NOT_ACTIVE' && error.lifecycle === 'removed'));
      if (!unavailable) throw error;
    }
  }
  // Terminal cleanup only performs repository-common Git administration after
  // proving Work ownership/branch containment. A removed legacy source checkout
  // must not strand those resources when another active checkout still owns the
  // same Repository record.
  return repository;
}

function isCurrentControllerManagedWorktree(
  controllerHome: string,
  worktreePath: string,
): boolean {
  try {
    const storageRoot = managedWorktreeStorageRoot(
      controllerHome,
      listRepositories(controllerHome, { includeRemoved: true }),
    );
    if (managedPathInside(storageRoot, worktreePath)) return true;
    // Older Controller releases used a namespaced sibling of controller/.
    // Accept only namespaces whose source Home appears in this target's
    // controlled migration receipt; then let the caller's Git common-dir,
    // branch, cleanliness, and preservation checks prove the exact Work before
    // any removal.
    const sourceHomes = new Set<string>([resolve(controllerHome)]);
    for (const record of listControlPlaneRecords<{ sourceHome?: unknown; status?: unknown }>(controllerHome, {
      namespace: 'controller_home_migration',
      limit: 1_000,
    })) {
      if (record.value.status !== 'applied' || typeof record.value.sourceHome !== 'string') continue;
      const sourceHome = resolve(record.value.sourceHome);
      sourceHomes.add(sourceHome);
      const physical = repoLocalNoIndexControllerHome(sourceHome);
      if (physical) sourceHomes.add(physical);
    }
    return [...sourceHomes].some((sourceHome) => {
      const namespace = createHash('sha256').update(sourceHome).digest('hex').slice(0, 16);
      const legacyRoot = join(dirname(resolve(controllerHome)), 'managed-worktrees', namespace);
      return managedPathInside(legacyRoot, worktreePath);
    });
  } catch {
    return false;
  }
}

export interface TerminalWorkCleanupReconcileOptions {
  nowMs?: number;
  minAgeMs?: number;
  maxWork?: number;
}

export interface TerminalWorkCleanupReconcileReport {
  scanned: number;
  eligible: number;
  attempted: number;
  cleaned: string[];
  blocked: Array<{ workId: string; reason: string }>;
  skippedRecent: string[];
  skippedRetained: string[];
  skippedNonTerminal: string[];
  branchReconciled: Array<{ workId: string; from: string; to: string }>;
  errors: Array<{ workId: string; error: string }>;
  truncated: boolean;
}

function terminalOutcomeForContract(contract: WorkContract): WorkTerminalOutcome {
  if (contract.status === 'cancelled') return 'cancelled';
  if (contract.status === 'completed') return 'completed_cleanup';
  return 'failed';
}

export function recoverTerminalWorkHandle(
  controllerHome: string,
  repositoryId: string,
  workId: string,
): WorkHandleState | undefined {
  const existing = readWorkHandle(controllerHome, repositoryId, workId);
  if (existing) return existing;
  const contract = getWorkContract({ controllerHome, repoId: repositoryId }, workId);
  if (!contract || !isTerminalWorkContractStatus(contract.status)) return undefined;
  const worktreePath = contract.worktreeRef?.trim();
  const checkoutId = contract.checkoutId?.trim();
  if (!worktreePath || !checkoutId || !existsSync(worktreePath)) return undefined;
  if (!isCurrentControllerManagedWorktree(controllerHome, worktreePath)) return undefined;

  const repository = getRepository(repositoryId, controllerHome, { includeRemoved: true });
  // Reconstruct physical cleanup authority from the recorded checkout entry itself.
  // selectRepositoryCheckout returns a RepositoryRecord view rooted at a checkout,
  // not the checkout entry (and terminal cleanup must also tolerate an already
  // archived/removed registry lifecycle while the physical worktree still exists).
  const checkout = repository.checkouts.find((candidate) => candidate.checkoutId === checkoutId);
  if (!checkout || checkout.worktree !== true || resolve(checkout.canonicalRoot) !== resolve(worktreePath)) return undefined;
  const branch = checkout.branch?.trim();
  if (!branch) return undefined;

  const head = git(worktreePath, ['rev-parse', 'HEAD']);
  if (!head.ok || !head.stdout) return undefined;
  const receiptTargetBranch = contract.completionReceipt && isRepositoryCompletionReceipt(contract.completionReceipt)
    ? contract.completionReceipt.targetBranch?.trim()
    : undefined;
  const targetBranch = receiptTargetBranch || repository.defaultBranch || 'main';
  const targetExists = branchExists(repository.canonicalRoot, targetBranch);
  const contained = targetExists
    ? git(repository.canonicalRoot, ['merge-base', '--is-ancestor', head.stdout, `refs/heads/${targetBranch}`]).ok
    : false;
  const delivered = contract.status === 'completed' && contained;
  const session = getControllerSession({ controllerHome, repoId: repositoryId }, workId);
  const recordedAt = nowIso();
  return writeWorkHandle(controllerHome, {
    schemaVersion: 1,
    workId,
    workContractId: workId,
    sessionId: session?.sessionId ?? `terminal-recovery:${workId}`,
    principalId: contract.principalId?.trim() || session?.principalId || 'terminal-recovery',
    repositoryId,
    checkoutId,
    sourceCheckoutId: repository.activeCheckoutId,
    ...(receiptTargetBranch ? { deliveryTargetBranch: receiptTargetBranch } : {}),
    worktreePath,
    branch,
    managedWorktree: true,
    baseCommit: contract.baseRevision,
    expectedHead: head.stdout,
    permissionSnapshotVersion: 1,
    state: delivered ? 'merged' : 'failed_terminal_cleanup',
    failureReason: delivered ? undefined : 'Recovered terminal Work ownership for cleanup; target-branch containment was not proven.',
    createdAt: contract.createdAt || recordedAt,
    updatedAt: recordedAt,
    cleanupResponsibility: { owner: 'work_finalizer', registeredAt: recordedAt },
    finalization: {
      validation: contract.status === 'failed' ? 'failed' : 'done',
      commit: 'skipped',
      merge: delivered ? 'done' : 'skipped',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
      ...(contract.status === 'failed' ? { lastError: 'Recovered failed terminal Work for cleanup.' } : {}),
    },
  });
}

function cleanupRetainedByRequest(contract: WorkContract, handle: WorkHandleState): boolean {
  // `skipped` in old WorkHandle finalization records was also used for legacy
  // no-op/error paths, so it is not sufficient proof of an explicit retention
  // request. New cancelled/terminal Work records persist an explicit physical
  // resource disposition on the WorkHandle. Completed Work keeps the existing
  // completion-receipt warning as the delivery authority.
  if (
    handle.terminalResourceDisposition?.mode === 'retained_by_request'
    && (handle.terminalResourceDisposition.retainWorktree === true
      || handle.terminalResourceDisposition.retainBranch === true)
  ) return true;
  const receipt = contract.completionReceipt;
  if (!receipt || !isRepositoryCompletionReceipt(receipt)) return false;
  return receipt.cleanup.warnings.some((warning) => warning.code === 'cleanup_retained_by_request');
}

function cleanedManagedBranchRetirementCandidate(
  repository: ReturnType<typeof getRepository>,
  contract: WorkContract,
  handle: WorkHandleState,
  targetBranch: string,
  deleteBranch: boolean,
): boolean {
  const receipt = handle.cleanupReceipt;
  if (
    handle.state !== 'cleaned'
    || !handle.managedWorktree
    || !deleteBranch
    || !receipt
    || receipt.targetBranch !== targetBranch
    || cleanupRetainedByRequest(contract, handle)
  ) return false;
  if (!['removed', 'already_removed'].includes(receipt.worktree.status)
    || !['removed', 'already_removed'].includes(receipt.checkoutRegistry.status)
    || receipt.prune.status !== 'done'
    || !['retained', 'failed', 'pending'].includes(receipt.branchCleanup.status)) return false;
  // A crash may occur after branch deletion but before the final cleanup receipt
  // is persisted. The unsettled branchCleanup status is sufficient residue to
  // re-enter cleanup; applyManagedBranchCleanup will converge an absent branch
  // to already_deleted without reopening semantic Work state.
  return handle.branch !== targetBranch;
}

function prepareManagedBranchPreservation(
  input: TerminalWorkCleanupInput,
  receipt: WorkCleanupReceipt,
  current: WorkHandleState,
  target: ReturnType<typeof getRepository>,
  targetBranch: string,
): { uniqueCommits: number; branchPreserved: boolean } {
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

  let branchPreserved = Boolean(
    receipt.preservation.bundleRetirement?.status === 'not_needed'
    || receipt.preservation.bundleRetirement?.status === 'removed',
  );
  if (receipt.preservation.bundlePath && !branchPreserved) {
    try {
      const bundle = createVerifiedBundle(input.controllerHome, current, target.canonicalRoot);
      if (receipt.preservation.bundleSha256 && receipt.preservation.bundleSha256 !== bundle.sha256) {
        throw new Error(`stored bundle digest ${receipt.preservation.bundleSha256} does not match ${bundle.sha256}`);
      }
      receipt.preservation.bundleSha256 = bundle.sha256;
      branchPreserved = true;
    } catch (error) {
      addBlocker(receipt, `BRANCH_BUNDLE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (uniqueCommits > 0 && !branchPreserved && receipt.blockers.length === 0) {
    const proof = proveWorkPreservationContained(target.canonicalRoot, { ...current, cleanupReceipt: receipt }, targetBranch);
    if (proof.contained) {
      receipt.preservation.bundleRetirement = {
        status: 'not_needed',
        reason: proof.reason === 'no_source_delta' ? 'no_source_delta' : 'target_and_remote_content_contained',
        protectedRevision: proof.protectedRevision!,
        targetRevision: proof.targetRevision,
        remoteRevision: proof.remoteRevision,
        comparedPaths: proof.comparedPaths,
        provedAt: nowIso(),
      };
      receipt.preservation.recoveryInstructions = `Branch bundle not created after ${proof.reason}; exact proof is stored in cleanupReceipt.preservation.bundleRetirement.`;
      branchPreserved = true;
    } else {
      try {
        const bundle = createVerifiedBundle(input.controllerHome, current, target.canonicalRoot);
        receipt.preservation.bundlePath = bundle.path;
        receipt.preservation.bundleSha256 = bundle.sha256;
        receipt.preservation.recoveryInstructions = [
          receipt.preservation.recoveryInstructions,
          `Recover branch commits with: git fetch ${bundle.path} refs/heads/${current.branch}:refs/heads/${current.branch}`,
        ].filter(Boolean).join(' ');
        branchPreserved = true;
      } catch (error) {
        addBlocker(receipt, `BRANCH_BUNDLE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { uniqueCommits, branchPreserved };
}

function applyManagedBranchCleanup(
  target: ReturnType<typeof getRepository>,
  current: WorkHandleState,
  targetBranch: string,
  deleteBranch: boolean,
  receipt: WorkCleanupReceipt,
  uniqueCommits: number,
  branchPreserved: boolean,
): void {
  if (!deleteBranch) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Branch retention was explicitly requested.';
  } else if (!branchExists(target.canonicalRoot, current.branch)) {
    receipt.branchCleanup.status = 'already_deleted';
    receipt.branchCleanup.reason = undefined;
  } else if (current.branch === targetBranch) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Refusing to delete the target branch.';
    addBlocker(receipt, `BRANCH_IS_TARGET: ${targetBranch}`);
  } else if (branchUsedByAnotherWorktree(target.canonicalRoot, current.branch, current.worktreePath)) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Branch is checked out by another worktree.';
    addBlocker(receipt, `BRANCH_IN_USE: ${current.branch}`);
  } else if (uniqueCommits > 0 && !branchPreserved) {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Unique commits are not archived.';
    addBlocker(receipt, `BRANCH_UNPRESERVED: ${current.branch}`);
  } else {
    // We already proved the exact branch relation against targetBranch above.
    // `git branch -d` instead consults the checkout's current HEAD, which may be
    // an older/stale source checkout and can falsely reject a branch that is
    // fully contained in the explicit target branch. After that target-branch
    // proof (or a verified archive for unique commits), delete the ref directly.
    const deleted = git(target.canonicalRoot, ['branch', '-D', current.branch]);
    if (!deleted.ok && branchExists(target.canonicalRoot, current.branch)) {
      receipt.branchCleanup.status = 'failed';
      receipt.branchCleanup.reason = deleted.stderr || 'branch delete failed';
      addBlocker(receipt, `BRANCH_DELETE_FAILED: ${receipt.branchCleanup.reason}`);
    } else {
      receipt.branchCleanup.status = uniqueCommits > 0 && receipt.preservation.bundlePath ? 'archived' : 'deleted';
      receipt.branchCleanup.reason = undefined;
    }
  }
}

function cleanupReceiptComplete(receipt: WorkCleanupReceipt, deleteBranch: boolean): boolean {
  return receipt.blockers.length === 0
    && ['removed', 'already_removed'].includes(receipt.worktree.status)
    && ['removed', 'already_removed'].includes(receipt.checkoutRegistry.status)
    && (deleteBranch
      ? ['deleted', 'already_deleted', 'archived'].includes(receipt.branchCleanup.status)
      : receipt.branchCleanup.status === 'retained');
}

function projectOwnedResourceCleanup(
  controllerHome: string,
  handle: WorkHandleState,
  receipt: WorkCleanupReceipt,
): void {
  const worktreeResourceId = managedWorkspaceOwnedResourceId(handle.repositoryId, handle.checkoutId);
  if (['removed', 'already_removed'].includes(receipt.worktree.status)) {
    markOwnedResourceCleaned(controllerHome, worktreeResourceId, 'forge:work-terminal-cleanup', receipt.receiptId);
  }

  const branchResourceId = managedBranchOwnedResourceId(handle.repositoryId, handle.checkoutId);
  if (['deleted', 'already_deleted', 'archived'].includes(receipt.branchCleanup.status)) {
    markOwnedResourceCleaned(controllerHome, branchResourceId, 'forge:work-terminal-cleanup', receipt.receiptId);
  } else if (receipt.branchCleanup.status === 'retained') {
    markOwnedResourceRetained(controllerHome, branchResourceId);
  }
}

function reconcileCleanedManagedBranchRetirement(
  input: TerminalWorkCleanupInput,
  repository: ReturnType<typeof getRepository>,
  targetBranch: string,
  deleteBranch: boolean,
  current: WorkHandleState,
  receipt: WorkCleanupReceipt,
): TerminalWorkCleanupResult | undefined {
  const workId = current.workContractId ?? current.workId;
  const contract = getWorkContract({ controllerHome: input.controllerHome, repoId: current.repositoryId }, workId);
  if (!contract || !isTerminalWorkContractStatus(contract.status)
    || !cleanedManagedBranchRetirementCandidate(repository, contract, current, targetBranch, deleteBranch)) return undefined;

  const target = selectTerminalCleanupTarget(repository, current);
  receipt.blockers = [];
  receipt.partial = false;
  receipt.complete = false;
  receipt.completedAt = undefined;
  receipt.branchCleanup.status = 'pending';
  receipt.branchCleanup.reason = undefined;

  const preservation = prepareManagedBranchPreservation(input, receipt, current, target, targetBranch);
  current = persist(input.controllerHome, current, receipt);
  if (receipt.blockers.length === 0) {
    applyManagedBranchCleanup(
      target,
      current,
      targetBranch,
      deleteBranch,
      receipt,
      preservation.uniqueCommits,
      preservation.branchPreserved,
    );
  } else if (receipt.branchCleanup.status === 'pending') {
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Branch retirement proof could not be re-established.';
  }

  const pruned = git(target.canonicalRoot, ['worktree', 'prune']);
  receipt.prune.status = pruned.ok ? 'done' : 'failed';
  if (!pruned.ok) {
    receipt.prune.reason = pruned.stderr || 'git worktree prune failed';
    addBlocker(receipt, `WORKTREE_PRUNE_FAILED: ${receipt.prune.reason}`);
  } else {
    receipt.prune.reason = undefined;
  }

  receipt.complete = cleanupReceiptComplete(receipt, deleteBranch);
  receipt.partial = !receipt.complete;
  if (receipt.complete) receipt.completedAt = nowIso();
  const finalization = {
    ...current.finalization,
    branchCleanup: receipt.complete ? 'done' as const : 'failed' as const,
    worktreeCleanup: 'done' as const,
  };
  current = writeWorkHandle(input.controllerHome, {
    ...current,
    state: 'cleaned',
    cleanupReceipt: receipt,
    finalization,
  });
  if (receipt.complete) {
    markRepositoryProjectionDirty(input.controllerHome, current.repositoryId, `cleanup:${current.workId}:terminal-branch-retirement`);
  }
  return { handle: current, receipt };
}

function reconcileLegacyTerminalBranchDrift(
  controllerHome: string,
  repository: ReturnType<typeof getRepository>,
  handle: WorkHandleState,
  targetBranch: string,
): { handle: WorkHandleState; reconciled?: { from: string; to: string }; blocker?: string } {
  if (!existsSync(handle.worktreePath)) return { handle };
  let registered;
  try {
    registered = selectRepositoryCheckout(repository, handle.checkoutId, { allowArchived: true });
  } catch (error) {
    return { handle, blocker: `BRANCH_DRIFT_CHECKOUT_UNKNOWN: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (resolve(registered.canonicalRoot) !== resolve(handle.worktreePath)) {
    return { handle, blocker: `BRANCH_DRIFT_PATH_MISMATCH: registry=${registered.canonicalRoot}; handle=${handle.worktreePath}` };
  }
  const actualBranch = git(handle.worktreePath, ['branch', '--show-current']);
  if (!actualBranch.ok || !actualBranch.stdout || actualBranch.stdout === handle.branch) return { handle };
  const status = git(handle.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok || status.stdout) {
    return { handle, blocker: `BRANCH_DRIFT_UNSAFE_DIRTY: expected=${handle.branch}; actual=${actualBranch.stdout || 'unknown'}` };
  }
  const target = selectTerminalCleanupTarget(repository, handle);
  const worktreeCommonDir = gitCommonDir(handle.worktreePath);
  const targetCommonDir = gitCommonDir(target.canonicalRoot);
  if (!worktreeCommonDir || !targetCommonDir || worktreeCommonDir !== targetCommonDir) {
    return { handle, blocker: `BRANCH_DRIFT_GIT_COMMON_DIR_MISMATCH: expected=${handle.branch}; actual=${actualBranch.stdout}` };
  }
  if (actualBranch.stdout === targetBranch) {
    return { handle, blocker: `BRANCH_DRIFT_IS_TARGET: ${targetBranch}` };
  }
  if (!branchExists(target.canonicalRoot, targetBranch)) {
    return { handle, blocker: `BRANCH_DRIFT_TARGET_MISSING: ${targetBranch}` };
  }
  const head = git(handle.worktreePath, ['rev-parse', 'HEAD']);
  if (!head.ok || !head.stdout) return { handle, blocker: 'BRANCH_DRIFT_HEAD_UNKNOWN' };
  const contained = git(target.canonicalRoot, ['merge-base', '--is-ancestor', head.stdout, `refs/heads/${targetBranch}`]);
  if (!contained.ok) {
    return { handle, blocker: `BRANCH_DRIFT_UNIQUE_COMMITS: expected=${handle.branch}; actual=${actualBranch.stdout}` };
  }
  if (branchUsedByAnotherWorktree(target.canonicalRoot, actualBranch.stdout, handle.worktreePath)) {
    return { handle, blocker: `BRANCH_DRIFT_IN_USE: ${actualBranch.stdout}` };
  }
  const updated = writeWorkHandle(controllerHome, { ...handle, branch: actualBranch.stdout });
  return { handle: updated, reconciled: { from: handle.branch, to: actualBranch.stdout } };
}

export async function cleanupTerminalWork(input: TerminalWorkCleanupInput): Promise<TerminalWorkCleanupResult> {
  const repository = getRepository(input.handle.repositoryId, input.controllerHome, { includeRemoved: true });
  const targetBranch = resolveWorkDeliveryTargetBranch(input.handle, repository.defaultBranch, input.targetBranch);
  const deleteBranch = input.deleteBranch !== false;
  let current = input.handle;
  const landed = current.state === 'merged' || current.finalization.merge === 'done';
  const preservedFailure = (input.failureReason ?? current.failureReason ?? current.finalization.lastError ?? 'terminal work cleanup').slice(0, 1_000);
  const receipt = current.cleanupReceipt ?? newReceipt(current, targetBranch, input.terminalOutcome);

  if (
    receipt.repoId !== current.repositoryId
    || receipt.checkoutId !== current.checkoutId
    || receipt.workId !== current.workId
  ) throw new Error('WORK_CLEANUP_RECEIPT_IDENTITY_MISMATCH');

  if (current.state === 'cleaned') {
    const branchRetirement = reconcileCleanedManagedBranchRetirement(
      input,
      repository,
      targetBranch,
      deleteBranch,
      current,
      receipt,
    );
    if (branchRetirement) return branchRetirement;
    if (!receipt.complete) {
      receipt.complete = true;
      receipt.partial = false;
      receipt.completedAt = receipt.completedAt ?? current.updatedAt ?? nowIso();
      receipt.blockers = [];
      receipt.processes.allTerminal = true;
      if (receipt.ownership.controllerLease === 'pending') receipt.ownership.controllerLease = 'already_released';
      if (receipt.ownership.processLeases === 'pending') receipt.ownership.processLeases = 'released';
      if (receipt.worktree.status === 'pending' || receipt.worktree.status === 'failed') {
        receipt.worktree.status = 'already_removed';
        receipt.worktree.reason = 'Reconciled from durable cleaned WorkHandle state.';
      }
      if (receipt.checkoutRegistry.status === 'pending' || receipt.checkoutRegistry.status === 'failed') {
        receipt.checkoutRegistry.status = 'already_removed';
        receipt.checkoutRegistry.reason = 'Reconciled from durable cleaned WorkHandle state.';
      }
      if (receipt.prune.status === 'pending' || receipt.prune.status === 'failed') {
        receipt.prune.status = 'done';
        receipt.prune.reason = 'Reconciled from durable cleaned WorkHandle state.';
      }
      if (receipt.branchCleanup.status === 'pending' || receipt.branchCleanup.status === 'failed') {
        receipt.branchCleanup.status = 'retained';
        receipt.branchCleanup.reason = 'Historical cleaned state does not prove branch deletion; branch is conservatively retained.';
      }
      current = writeWorkHandle(input.controllerHome, { ...current, cleanupReceipt: receipt });
    }
    return { handle: current, receipt };
  }

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

  const cleanupFinalization = {
    ...current.finalization,
    validation: input.terminalOutcome === 'validation_failed' || input.terminalOutcome === 'infrastructure_failed'
      ? 'failed' as const
      : current.finalization.validation,
    commit: current.finalization.commit === 'pending' ? 'skipped' as const : current.finalization.commit,
    merge: landed ? 'done' as const : current.finalization.merge === 'pending' ? 'skipped' as const : current.finalization.merge,
    lastError: preservedFailure,
  };
  if (landed) {
    // Cleanup is a follow-up transaction. Once the target branch contains the
    // result, a process/lease/worktree blocker must not downgrade delivery.
    current = writeWorkHandle(input.controllerHome, {
      ...current,
      state: 'merged',
      failureReason: undefined,
      cleanupReceipt: receipt,
      validationRun: undefined,
      finalization: cleanupFinalization,
    });
  } else if (current.state !== 'failed_terminal_cleanup') {
    current = transitionWorkHandle(input.controllerHome, current, 'failed_terminal_cleanup', {
      failureReason: preservedFailure,
      cleanupReceipt: receipt,
      validationRun: undefined,
      finalization: cleanupFinalization,
    });
  } else {
    current = persist(input.controllerHome, current, receipt);
  }

  await settleProcesses(input, receipt);
  // The selected/current repository checkout is shared infrastructure, not a
  // disposable Work-owned resource. Other live Works may legitimately share it;
  // only a managed Work checkout requires exclusive lifecycle ownership before
  // physical removal.
  if (current.managedWorktree) assertNoOtherLiveWork(input, receipt);
  current = persist(input.controllerHome, current, receipt);
  if (receipt.blockers.length > 0) return { handle: current, receipt };

  // A Work running in the selected/current checkout owns lifecycle and process
  // leases, but it does not own the checkout/branch as disposable resources.
  // Closing that Work therefore releases ownership without attempting git
  // worktree removal, branch deletion, checkout-registry removal, or prune.
  if (!current.managedWorktree) {
    receipt.worktree.status = 'already_removed';
    receipt.worktree.reason = 'Not applicable: Work did not create a managed worktree.';
    receipt.branchCleanup.status = 'retained';
    receipt.branchCleanup.reason = 'Current checkout branch is repository-owned, not Work-owned.';
    receipt.checkoutRegistry.status = 'already_removed';
    receipt.checkoutRegistry.reason = 'Not applicable: current checkout registration is retained.';
    receipt.prune.status = 'done';
    receipt.prune.reason = 'Not applicable: no managed worktree was removed.';
    receipt.complete = true;
    receipt.partial = false;
    receipt.completedAt = receipt.completedAt ?? nowIso();
    const finalization = {
      ...current.finalization,
      commit: current.finalization.commit === 'pending' ? 'skipped' as const : current.finalization.commit,
      merge: current.finalization.merge === 'pending' ? 'skipped' as const : current.finalization.merge,
      branchCleanup: 'skipped' as const,
      worktreeCleanup: 'skipped' as const,
      lastError: preservedFailure,
    };
    current = transitionWorkHandle(input.controllerHome, current, 'cleaned', {
      failureReason: landed ? undefined : preservedFailure,
      cleanupReceipt: receipt,
      finalization,
    });
    return { handle: current, receipt };
  }

  const target = selectTerminalCleanupTarget(repository, current);
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
  const migratedManagedWorktree = !registeredPath
    && existsSync(current.worktreePath)
    && isCurrentControllerManagedWorktree(input.controllerHome, current.worktreePath);
  if (!registeredPath && existsSync(current.worktreePath) && !migratedManagedWorktree) {
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
    const rootIdentityValid = root.ok && resolve(root.stdout) === resolve(current.worktreePath);
    const branchIdentityValid = branch.ok && branch.stdout === current.branch;
    let detachedContainedIdentity = false;
    if (rootIdentityValid && branch.ok && !branch.stdout) {
      const status = git(current.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
      const head = git(current.worktreePath, ['rev-parse', 'HEAD']);
      detachedContainedIdentity = status.ok
        && !status.stdout
        && head.ok
        && Boolean(head.stdout)
        && git(target.canonicalRoot, ['merge-base', '--is-ancestor', head.stdout, `refs/heads/${targetBranch}`]).ok;
    }
    if (!rootIdentityValid || (!branchIdentityValid && !detachedContainedIdentity)) {
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

  const { uniqueCommits, branchPreserved } = prepareManagedBranchPreservation(
    input,
    receipt,
    current,
    target,
    targetBranch,
  );
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
  if (!registeredPath && migratedManagedWorktree) {
    receipt.checkoutRegistry.reason = 'Checkout metadata was absent after Controller Home migration; canonical managed-worktree and Git identity checks passed before cleanup.';
  }

  applyManagedBranchCleanup(
    target,
    current,
    targetBranch,
    deleteBranch,
    receipt,
    uniqueCommits,
    branchPreserved,
  );

  const pruned = git(target.canonicalRoot, ['worktree', 'prune']);
  receipt.prune.status = pruned.ok ? 'done' : 'failed';
  if (!pruned.ok) {
    receipt.prune.reason = pruned.stderr || 'git worktree prune failed';
    addBlocker(receipt, `WORKTREE_PRUNE_FAILED: ${receipt.prune.reason}`);
  }

  receipt.complete = cleanupReceiptComplete(receipt, deleteBranch);
  receipt.partial = !receipt.complete;
  if (receipt.complete) receipt.completedAt = receipt.completedAt ?? nowIso();
  projectOwnedResourceCleanup(input.controllerHome, current, receipt);

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
        failureReason: landed ? undefined : preservedFailure,
        cleanupReceipt: receipt,
        finalization,
      })
    : writeWorkHandle(input.controllerHome, {
        ...current,
        state: landed ? 'merged' : 'failed_terminal_cleanup',
        failureReason: landed ? undefined : preservedFailure,
        cleanupReceipt: receipt,
        finalization,
      });
  return { handle: current, receipt };
}

export interface SingleTerminalWorkCleanupResult {
  status: 'cleaned' | 'retained' | 'blocked' | 'no_handle' | 'not_terminal';
  workId: string;
  handle?: WorkHandleState;
  receipt?: WorkCleanupReceipt;
  reason?: string;
}

/**
 * Reconcile physical resources for one already-terminal Work without reviving its
 * historical execution principal. WorkContract remains the terminal outcome
 * authority; this path owns only resource cleanup and refuses unproven active
 * Controller ownership or unsafe branch drift. A caller proving the exact
 * leftover owner epoch may release it before physical cleanup.
 */
function reconcileCancelledCleanupProjection(
  controllerHome: string,
  repoId: string,
  contract: WorkContract,
  receipt: WorkCleanupReceipt,
): void {
  if (contract.status !== 'cancelled' || receipt.complete !== true) return;
  if (contract.phase === 'cleanup' && contract.phaseEvidence.cleanup.state === 'satisfied'
    && contract.phaseEvidence.cleanup.receiptId === receipt.receiptId) return;
  recordCancelledWorkCleanupCompleted(
    { controllerHome, repoId },
    contract.workId,
    {
      summary: `Verified terminal resource cleanup completed with receipt ${receipt.receiptId}.`,
      receiptId: receipt.receiptId,
      evidenceRefs: [{
        title: 'cancelled Work terminal cleanup completed',
        summary: `Physical worktree/branch cleanup completed under receipt ${receipt.receiptId}; unexecuted semantic phases remain skipped rather than satisfied.`,
        detailLevel: 'summary',
      }, ...contract.evidenceRefs],
    },
  );
}

export async function reconcileSingleTerminalWorkCleanup(
  controllerHome: string,
  repositoryId: string,
  workId: string,
  options: {
    targetBranch?: string;
    deleteBranch?: boolean;
    /** Recovery authority for the narrow crash window after semantic terminalization but before owner release. */
    controllerAuthority?: ControllerTerminalizationAuthority;
  } = {},
): Promise<SingleTerminalWorkCleanupResult> {
  const repository = getRepository(repositoryId, controllerHome, { includeRemoved: true });
  const contract = getWorkContract({ controllerHome, repoId: repositoryId }, workId);
  if (!contract || !isTerminalWorkContractStatus(contract.status)) {
    return { status: 'not_terminal', workId, reason: 'Work is not terminal.' };
  }
  let controllerLease: WorkCleanupReceipt['ownership']['controllerLease'] = 'already_released';
  const owner = getControllerSession({ controllerHome, repoId: repositoryId }, workId);
  if (owner) {
    const authority = options.controllerAuthority;
    if (!authority) return { status: 'blocked', workId, reason: 'Active Controller ownership still exists.' };
    const ownerAuthority = controllerTerminalizationAuthorityFromSession(owner);
    if (!ownerAuthority
      || ownerAuthority.controllerId !== authority.controllerId
      || ownerAuthority.controllerType !== authority.controllerType
      || ownerAuthority.principalId !== authority.principalId
      || ownerAuthority.controllerInstanceId !== authority.controllerInstanceId
      || ownerAuthority.claimGeneration !== authority.claimGeneration) {
      return { status: 'blocked', workId, reason: 'Active Controller ownership does not match the cleanup authority.' };
    }
    const released = releaseControllerSessionWithAuthority(
      { controllerHome, repoId: repositoryId },
      { workId, actor: `terminal-cleanup:${workId}`, authority },
    );
    if (!released.allowed) {
      return { status: 'blocked', workId, reason: `Active Controller ownership release fenced: ${released.reason}.` };
    }
    controllerLease = 'released';
  }
  const originalHandle = readWorkHandle(controllerHome, repositoryId, workId)
    ?? recoverTerminalWorkHandle(controllerHome, repositoryId, workId);
  if (!originalHandle) return { status: 'no_handle', workId };
  if (cleanupRetainedByRequest(contract, originalHandle)) {
    return { status: 'retained', workId, handle: originalHandle, receipt: originalHandle.cleanupReceipt };
  }
  const targetBranch = resolveWorkDeliveryTargetBranch(originalHandle, repository.defaultBranch, options.targetBranch);
  const drift = reconcileLegacyTerminalBranchDrift(controllerHome, repository, originalHandle, targetBranch);
  if (drift.blocker) return { status: 'blocked', workId, handle: drift.handle, reason: drift.blocker };
  const cleaned = await cleanupTerminalWork({
    controllerHome,
    handle: drift.handle,
    targetBranch,
    deleteBranch: options.deleteBranch !== false,
    terminalOutcome: terminalOutcomeForContract(contract),
    failureReason: drift.handle.failureReason ?? drift.handle.finalization.lastError,
  });
  cleaned.receipt.ownership.controllerLease = controllerLease;
  const persisted = writeWorkHandle(controllerHome, { ...cleaned.handle, cleanupReceipt: cleaned.receipt });
  if (cleaned.receipt.complete) {
    reconcileCancelledCleanupProjection(controllerHome, repositoryId, contract, cleaned.receipt);
  }
  if (!cleaned.receipt.complete) {
    return {
      status: 'blocked',
      workId,
      handle: persisted,
      receipt: cleaned.receipt,
      reason: cleaned.receipt.blockers.join('; ') || cleaned.receipt.worktree.reason || cleaned.receipt.branchCleanup.reason || 'terminal cleanup incomplete',
    };
  }
  return { status: 'cleaned', workId, handle: persisted, receipt: cleaned.receipt };
}

export async function reconcileTerminalWorkCleanups(
  controllerHome: string,
  options: TerminalWorkCleanupReconcileOptions = {},
): Promise<TerminalWorkCleanupReconcileReport> {
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = Math.max(0, options.minAgeMs ?? 60_000);
  const maxWork = Math.max(1, Math.min(100, Math.trunc(options.maxWork ?? 20)));
  const report: TerminalWorkCleanupReconcileReport = {
    scanned: 0,
    eligible: 0,
    attempted: 0,
    cleaned: [],
    blocked: [],
    skippedRecent: [],
    skippedRetained: [],
    skippedNonTerminal: [],
    branchReconciled: [],
    errors: [],
    truncated: false,
  };

  const repositories = listRepositories(controllerHome).filter((repository) => repository.enabled && !repository.removedAt);
  outer: for (const repository of repositories) {
    const handles = listWorkHandles(controllerHome, repository.repoId, 10_000)
      .filter((handle) => handle.managedWorktree);
    const knownWorkIds = new Set(handles.map((handle) => handle.workId));
    const recoveredWorkIds = new Set<string>();
    for (const record of listControlPlaneRecords<WorkContract>(controllerHome, {
      namespace: 'work_contract',
      scope: repository.repoId,
      limit: 10_000,
    })) {
      const contract = record.value;
      if (knownWorkIds.has(contract.workId) || !isTerminalWorkContractStatus(contract.status)) continue;
      if (!contract.worktreeRef?.trim() || !existsSync(contract.worktreeRef)) continue;
      let recovered: WorkHandleState | undefined;
      try {
        recovered = recoverTerminalWorkHandle(controllerHome, repository.repoId, contract.workId);
      } catch (error) {
        report.errors.push({ workId: contract.workId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!recovered) continue;
      handles.push(recovered);
      knownWorkIds.add(recovered.workId);
      recoveredWorkIds.add(recovered.workId);
    }
    handles.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const originalHandle of handles) {
      report.scanned += 1;
      let contract: WorkContract | undefined;
      try {
        contract = getWorkContract({ controllerHome, repoId: repository.repoId }, originalHandle.workContractId ?? originalHandle.workId);
      } catch (error) {
        report.errors.push({ workId: originalHandle.workId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!contract || !isTerminalWorkContractStatus(contract.status)) {
        report.skippedNonTerminal.push(originalHandle.workId);
        continue;
      }
      // Stable semantic Work CAS is not a cleanup authorization. A model can
      // close/cancel working context without implicitly granting filesystem
      // deletion. Legacy delivery receipts and explicit cleanup requests remain
      // separate mechanical authorities.
      if ((contract.semanticState === 'completed' || contract.semanticState === 'cancelled')
        && !contract.completionReceipt
        && !originalHandle.cleanupReceipt) {
        report.skippedRetained.push(originalHandle.workId);
        markOwnedResourceRetained(controllerHome, managedWorkspaceOwnedResourceId(repository.repoId, originalHandle.checkoutId));
        markOwnedResourceRetained(controllerHome, managedBranchOwnedResourceId(repository.repoId, originalHandle.checkoutId));
        continue;
      }
      if (cleanupRetainedByRequest(contract, originalHandle)) {
        report.skippedRetained.push(originalHandle.workId);
        continue;
      }
      if (originalHandle.state === 'cleaned' && originalHandle.cleanupReceipt?.complete === true) {
        reconcileCancelledCleanupProjection(controllerHome, repository.repoId, contract, originalHandle.cleanupReceipt);
        const targetBranch = resolveWorkDeliveryTargetBranch(originalHandle, repository.defaultBranch);
        if (!cleanedManagedBranchRetirementCandidate(
          repository,
          contract,
          originalHandle,
          targetBranch,
          true,
        )) continue;
      }
      // Reconstructing a missing handle is metadata recovery, not new Work activity.
      // Do not let that write reset the terminal-age grace period indefinitely.
      const terminalAt = recoveredWorkIds.has(originalHandle.workId)
        ? (Date.parse(contract.updatedAt) || 0)
        : Math.max(Date.parse(contract.updatedAt) || 0, Date.parse(originalHandle.updatedAt) || 0);
      if (terminalAt > 0 && nowMs - terminalAt < minAgeMs) {
        report.skippedRecent.push(originalHandle.workId);
        continue;
      }
      report.eligible += 1;
      if (report.attempted >= maxWork) {
        report.truncated = true;
        break outer;
      }
      report.attempted += 1;
      try {
        const targetBranch = resolveWorkDeliveryTargetBranch(originalHandle, repository.defaultBranch);
        const drift = reconcileLegacyTerminalBranchDrift(controllerHome, repository, originalHandle, targetBranch);
        if (drift.blocker) {
          report.blocked.push({ workId: originalHandle.workId, reason: drift.blocker });
          continue;
        }
        if (drift.reconciled) report.branchReconciled.push({ workId: originalHandle.workId, ...drift.reconciled });
        const cleaned = await cleanupTerminalWork({
          controllerHome,
          handle: drift.handle,
          targetBranch,
          deleteBranch: true,
          terminalOutcome: terminalOutcomeForContract(contract),
          failureReason: drift.handle.failureReason ?? drift.handle.finalization.lastError,
        });
        const workId = cleaned.handle.workContractId ?? cleaned.handle.workId;
        const controllerSession = getControllerSession({ controllerHome, repoId: repository.repoId }, workId);
        if (controllerSession) {
          const released = releaseObservedControllerSession(
            { controllerHome, repoId: repository.repoId },
            { workId, actor: `terminal-cleanup:${originalHandle.workId}`, owner: controllerSession },
          );
          if (released.allowed) {
            cleaned.receipt.ownership.controllerLease = 'released';
          } else {
            cleaned.receipt.complete = false;
            cleaned.receipt.partial = true;
            cleaned.receipt.completedAt = undefined;
            cleaned.receipt.blockers = appendUnique(cleaned.receipt.blockers, `controller lease release fenced: ${released.reason}`);
          }
        } else {
          cleaned.receipt.ownership.controllerLease = 'already_released';
        }
        writeWorkHandle(controllerHome, { ...cleaned.handle, cleanupReceipt: cleaned.receipt });
        if (cleaned.receipt.complete) {
          reconcileCancelledCleanupProjection(controllerHome, repository.repoId, contract, cleaned.receipt);
          report.cleaned.push(originalHandle.workId);
        }
        else report.blocked.push({
          workId: originalHandle.workId,
          reason: cleaned.receipt.blockers.join('; ') || cleaned.receipt.worktree.reason || cleaned.receipt.branchCleanup.reason || 'terminal cleanup incomplete',
        });
      } catch (error) {
        report.errors.push({ workId: originalHandle.workId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return report;
}
