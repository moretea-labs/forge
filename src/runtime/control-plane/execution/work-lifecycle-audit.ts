import { spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  getWorkContract,
  listWorkContracts,
  readActiveWorkCandidates,
  type WorkContract,
} from '../../../../packages/kernel/work/api/index';
import { isTerminalWorkContractStatus } from '../facade/types';
import { listControlPlaneRecords } from '../persistence/sqlite-store';
import { listWorkHandles } from './work-handle-store';

export interface WorkLifecycleAttention {
  jobId: string;
  status: string;
  message: string;
}

interface LinkedWorktree {
  path: string;
  branch?: string;
}

function git(repositoryRoot: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : undefined;
}

export interface WorktreeGitSnapshot {
  head?: string;
  branch?: string;
  clean: boolean;
}

export function gitCommitAtRef(repositoryRoot: string, ref: string): string | undefined {
  const value = git(repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return value?.trim() || undefined;
}

export function gitWorktreeSnapshot(repositoryRoot: string): WorktreeGitSnapshot | undefined {
  const head = gitCommitAtRef(repositoryRoot, 'HEAD');
  const branch = git(repositoryRoot, ['branch', '--show-current']);
  const porcelain = git(repositoryRoot, ['status', '--porcelain']);
  if (porcelain === undefined) return undefined;
  return { head, branch: branch?.trim() || undefined, clean: porcelain.length === 0 };
}

function linkedWorktrees(repositoryRoot: string): LinkedWorktree[] {
  const output = git(repositoryRoot, ['worktree', 'list', '--porcelain']);
  if (output === undefined) return [];
  const worktrees: LinkedWorktree[] = [];
  let current: LinkedWorktree | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function dirty(path: string): boolean | undefined {
  const status = git(path, ['status', '--porcelain']);
  return status === undefined ? undefined : status.length > 0;
}

function canonicalPath(path: string): string {
  try { return realpathSync.native(path); }
  catch { return resolve(path); }
}

function refReachableFromTarget(repositoryRoot: string, ref: string, targetBranch: string): boolean | undefined {
  const result = spawnSync('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', ref, targetBranch], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 10_000,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return undefined;
}

const EXACT_COMMIT_REVISION = /^[0-9a-f]{40}$/i;

function reachableCommitSet(repositoryRoot: string, targetBranch: string): ReadonlySet<string> | undefined {
  const output = git(repositoryRoot, ['rev-list', targetBranch]);
  if (output === undefined) return undefined;
  return new Set(output.split('\n').map((revision) => revision.trim()).filter(Boolean));
}

function exactCommitReachableFromTarget(
  repositoryRoot: string,
  ref: string,
  targetBranch: string,
  reachableCommits: ReadonlySet<string> | undefined,
): boolean | undefined {
  if (reachableCommits && EXACT_COMMIT_REVISION.test(ref)) return reachableCommits.has(ref);
  return refReachableFromTarget(repositoryRoot, ref, targetBranch);
}

function branchIntegrated(
  repositoryRoot: string,
  branch: string,
  targetBranch: string,
  reachableCommits?: ReadonlySet<string>,
  branchHead?: string,
): boolean | undefined {
  if (reachableCommits && branchHead && EXACT_COMMIT_REVISION.test(branchHead)) {
    if (reachableCommits.has(branchHead)) return true;
  } else {
    const reachable = refReachableFromTarget(repositoryRoot, branch, targetBranch);
    if (reachable !== false) return reachable;
  }

  // Rebase/cherry-pick delivery can preserve every patch while changing ancestry.
  // Treat the branch as integrated only when Git proves it has no unique patches.
  const cherry = spawnSync('git', ['-C', repositoryRoot, 'cherry', targetBranch, branch], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (cherry.status !== 0 || typeof cherry.stdout !== 'string') return false;
  return !cherry.stdout.split('\n').some((line) => line.startsWith('+ '));
}

function attention(code: string, identity: string, message: string): WorkLifecycleAttention {
  return { jobId: `lifecycle:${code}:${identity}`, status: code, message };
}

interface LifecycleWorkSnapshot {
  contracts: WorkContract[];
  invalid: Array<{ workId: string; error: string }>;
}

/**
 * Keep lifecycle diagnostics available when one historical active Work row is malformed.
 * Active Work semantics come only from the Kernel row-isolated projection. When that
 * projection reports corruption, enumerate bounded durable identities and re-read each
 * remaining row through exact Kernel authority so terminal receipt/cleanup diagnostics
 * are preserved without reimplementing Work normalization here.
 */
function readLifecycleWorkSnapshot(controllerHome: string, repoId: string): LifecycleWorkSnapshot {
  const store = { controllerHome, repoId };
  const active = readActiveWorkCandidates({ ...store, limit: 100 });
  if (active.invalid.length === 0) {
    return { contracts: listWorkContracts({ ...store, status: 'all', limit: 100 }), invalid: [] };
  }

  const contractsById = new Map(active.contracts.map((contract) => [contract.workId, contract]));
  const invalidById = new Map(active.invalid.map((entry) => [entry.workId, { workId: entry.workId, error: entry.error }]));
  const identities = listControlPlaneRecords<WorkContract>(controllerHome, {
    namespace: 'work_contract',
    scope: repoId,
    limit: 5_000,
  })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 100);

  for (const record of identities) {
    const workId = record.key;
    if (contractsById.has(workId) || invalidById.has(workId)) continue;
    try {
      const contract = getWorkContract(store, workId);
      if (contract) contractsById.set(workId, contract);
    } catch (error) {
      invalidById.set(workId, {
        workId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    contracts: [...contractsById.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 100),
    invalid: [...invalidById.values()]
      .sort((left, right) => left.workId.localeCompare(right.workId))
      .slice(0, 100),
  };
}

/**
 * Read-only reconciliation across canonical Work, WorkHandle, registry, and Git.
 * It reports contradictions and live Work through the existing Runtime projection;
 * it never changes lifecycle state or owns cleanup.
 */
export function collectWorkLifecycleAttention(
  controllerHome: string,
  repository: RepositoryRecord,
): WorkLifecycleAttention[] {
  const workSnapshot = readLifecycleWorkSnapshot(controllerHome, repository.repoId);
  const contracts = workSnapshot.contracts;
  const handles = listWorkHandles(controllerHome, repository.repoId, 5_000);
  const contractsByWork = new Map(contracts.map((contract) => [contract.workId, contract]));
  const handlesByWork = new Map(handles.map((handle) => [handle.workContractId ?? handle.workId, handle]));
  const findings: WorkLifecycleAttention[] = workSnapshot.invalid.map((entry) => attention(
    'work_contract_invalid',
    entry.workId,
    `Work ${entry.workId} is unreadable by Kernel semantics and is excluded from valid lifecycle authority: ${entry.error.slice(0, 180)}`,
  ));
  const targetBranch = repository.defaultBranch || 'main';
  const targetReachability = new Map<string, ReadonlySet<string> | undefined>();
  const reachableFrom = (branch: string): ReadonlySet<string> | undefined => {
    if (!targetReachability.has(branch)) {
      targetReachability.set(branch, reachableCommitSet(repository.canonicalRoot, branch));
    }
    return targetReachability.get(branch);
  };

  for (const contract of contracts) {
    const handle = handlesByWork.get(contract.workId);
    const terminal = isTerminalWorkContractStatus(contract.status);
    if (!terminal) {
      findings.push(attention(
        'work_active',
        contract.workId,
        `Work ${contract.workId} is ${contract.status} in ${contract.phase}; continue, block with a handoff, or finalize it explicitly.`,
      ));
      if (contract.workKind === 'repository_change' && !handle) {
        findings.push(attention(
          'active_work_handle_missing',
          contract.workId,
          `Repository Work ${contract.workId} is active but has no readable WorkHandle.`,
        ));
      }
      if (handle?.managedWorktree && !existsSync(handle.worktreePath)) {
        findings.push(attention(
          'active_worktree_missing',
          contract.workId,
          `Active Work ${contract.workId} owns missing managed worktree ${handle.worktreePath}.`,
        ));
      }
      continue;
    }

    if (contract.status === 'completed' && !contract.completionReceipt) {
      findings.push(attention(
        'completed_work_receipt_missing',
        contract.workId,
        `Completed Work ${contract.workId} has no Completion Receipt.`,
      ));
    }
    if (contract.status === 'completed' && contract.completionReceipt?.source === 'controller_work') {
      const receiptTargetRevision = contract.completionReceipt.targetRevision?.trim();
      const receiptTargetBranch = contract.completionReceipt.targetBranch?.trim() || targetBranch;
      if (!receiptTargetRevision || exactCommitReachableFromTarget(
        repository.canonicalRoot,
        receiptTargetRevision,
        receiptTargetBranch,
        reachableFrom(receiptTargetBranch),
      ) !== true) {
        findings.push(attention(
          'completion_receipt_target_not_integrated',
          contract.workId,
          `Work ${contract.workId} receipt target ${receiptTargetRevision || 'missing'} is not reachable from ${receiptTargetBranch}.`,
        ));
      }
    }
    if (!handle || handle.terminalResourceDisposition?.mode === 'retained_by_request') continue;
    const cleanupFailed = handle.finalization.branchCleanup === 'failed'
      || handle.finalization.worktreeCleanup === 'failed';
    const cleanupPending = handle.finalization.branchCleanup === 'pending'
      || handle.finalization.worktreeCleanup === 'pending';
    const repositoryOwnedCanonicalCheckout = !handle.managedWorktree
      && canonicalPath(handle.worktreePath) === canonicalPath(repository.canonicalRoot)
      && handle.branch === targetBranch;
    const cleanupUnsettled = cleanupFailed || (cleanupPending && !repositoryOwnedCanonicalCheckout);
    if (cleanupUnsettled) {
      findings.push(attention(
        'terminal_work_cleanup_unsettled',
        contract.workId,
        `Terminal Work ${contract.workId} still has unsettled branch/worktree cleanup stages.`,
      ));
    }
    if (handle.state === 'cleaned' && handle.managedWorktree && existsSync(handle.worktreePath)) {
      findings.push(attention(
        'cleaned_worktree_still_present',
        contract.workId,
        `WorkHandle ${contract.workId} is cleaned but managed worktree ${handle.worktreePath} still exists.`,
      ));
    }
  }

  const activeBranches = new Set(
    handles
      .filter((handle) => {
        const contract = contractsByWork.get(handle.workContractId ?? handle.workId);
        return contract ? !isTerminalWorkContractStatus(contract.status) : false;
      })
      .map((handle) => handle.branch),
  );
  const retainedBranches = new Set(
    handles
      .filter((handle) => handle.terminalResourceDisposition?.retainBranch === true)
      .map((handle) => handle.branch),
  );
  const activeRegistryRoots = new Set(
    repository.checkouts
      .filter((checkout) => (checkout.lifecycle ?? 'active') === 'active')
      .map((checkout) => canonicalPath(checkout.canonicalRoot)),
  );
  const handleRoots = new Map(handles.map((handle) => [canonicalPath(handle.worktreePath), handle]));

  for (const checkout of repository.checkouts) {
    if ((checkout.lifecycle ?? 'active') === 'active' && !existsSync(checkout.canonicalRoot)) {
      findings.push(attention(
        'active_checkout_missing',
        checkout.checkoutId,
        `Registry checkout ${checkout.checkoutId} is active but ${checkout.canonicalRoot} is missing.`,
      ));
    }
  }

  const linked = linkedWorktrees(repository.canonicalRoot);
  for (const worktree of linked) {
    const root = canonicalPath(worktree.path);
    if (activeRegistryRoots.has(root)) continue;
    const isDirty = dirty(root);
    const handle = handleRoots.get(root);
    const code = isDirty === true ? 'dirty_linked_worktree_unregistered' : 'linked_worktree_unregistered';
    findings.push(attention(
      code,
      handle?.workId ?? worktree.branch ?? root,
      `Git worktree ${root}${worktree.branch ? ` on ${worktree.branch}` : ''} is linked but absent from the active checkout registry${isDirty === true ? ' and has uncommitted changes' : ''}.`,
    ));
  }

  const branches = git(repository.canonicalRoot, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/work', 'refs/heads/codex'])
    ?.split('\n')
    .map((line) => {
      const [branch, head] = line.split('\t');
      return { branch: branch?.trim() ?? '', head: head?.trim() };
    })
    .filter((entry) => Boolean(entry.branch)) ?? [];
  const targetReachableCommits = reachableFrom(targetBranch);
  for (const { branch, head } of branches) {
    if (activeBranches.has(branch) || retainedBranches.has(branch)) continue;
    if (branchIntegrated(repository.canonicalRoot, branch, targetBranch, targetReachableCommits, head) !== false) continue;
    findings.push(attention(
      'work_branch_not_integrated',
      branch,
      `Work branch ${branch} is not reachable from ${targetBranch} and is not owned by an active or explicitly retained Work.`,
    ));
  }

  return Array.from(new Map(findings.map((finding) => [finding.jobId, finding])).values())
    .sort((left, right) => left.jobId.localeCompare(right.jobId))
    .slice(0, 100);
}
