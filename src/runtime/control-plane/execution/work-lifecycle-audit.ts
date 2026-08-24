import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { listWorkContracts } from '../facade/work-contract-store';
import { isTerminalWorkContractStatus } from '../facade/types';
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

function branchIntegrated(repositoryRoot: string, branch: string, targetBranch: string): boolean | undefined {
  const result = spawnSync('git', ['-C', repositoryRoot, 'merge-base', '--is-ancestor', branch, targetBranch], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 10_000,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return undefined;
}

function attention(code: string, identity: string, message: string): WorkLifecycleAttention {
  return { jobId: `lifecycle:${code}:${identity}`, status: code, message };
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
  const contracts = listWorkContracts({
    controllerHome,
    repoId: repository.repoId,
    status: 'all',
    limit: 100,
  });
  const handles = listWorkHandles(controllerHome, repository.repoId, 5_000);
  const contractsByWork = new Map(contracts.map((contract) => [contract.workId, contract]));
  const handlesByWork = new Map(handles.map((handle) => [handle.workContractId ?? handle.workId, handle]));
  const findings: WorkLifecycleAttention[] = [];

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
    if (
      contract.completionReceipt?.source === 'controller_work'
      && handle?.expectedHead
      && contract.completionReceipt.sourceRevision !== handle.expectedHead
    ) {
      findings.push(attention(
        'completion_receipt_source_mismatch',
        contract.workId,
        `Work ${contract.workId} receipt source ${contract.completionReceipt.sourceRevision ?? 'missing'} does not match delivered head ${handle.expectedHead}.`,
      ));
    }
    if (!handle || handle.terminalResourceDisposition?.mode === 'retained_by_request') continue;
    const cleanupUnsettled = handle.finalization.branchCleanup === 'pending'
      || handle.finalization.branchCleanup === 'failed'
      || handle.finalization.worktreeCleanup === 'pending'
      || handle.finalization.worktreeCleanup === 'failed';
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
      .map((checkout) => resolve(checkout.canonicalRoot)),
  );
  const handleRoots = new Map(handles.map((handle) => [resolve(handle.worktreePath), handle]));

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
    const root = resolve(worktree.path);
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

  const targetBranch = repository.defaultBranch || 'main';
  const branches = git(repository.canonicalRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/work', 'refs/heads/codex'])
    ?.split('\n')
    .map((branch) => branch.trim())
    .filter(Boolean) ?? [];
  for (const branch of branches) {
    if (activeBranches.has(branch) || retainedBranches.has(branch)) continue;
    if (branchIntegrated(repository.canonicalRoot, branch, targetBranch) !== false) continue;
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
