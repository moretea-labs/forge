import { spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';

export interface WorkLifecycleAttention {
  jobId: string;
  status: string;
  message: string;
}

const CURRENT_READINESS_LIFECYCLE_STATUSES = new Set([
  'active_checkout_missing',
  'dirty_linked_worktree_unregistered',
  'linked_worktree_unregistered',
]);

/**
 * Runtime readiness consumes only repository/checkout/Git contradictions.
 * Historical Work and WorkHandle records are never consulted and cannot block
 * current execution. Unregistered dirty/unique linked worktrees remain physical
 * source-integrity blockers; unintegrated branch debt is advisory only.
 */
export function workLifecycleAttentionBlocksReadiness(
  finding: Pick<WorkLifecycleAttention, 'status'>,
): boolean {
  return CURRENT_READINESS_LIFECYCLE_STATUSES.has(finding.status);
}

interface LinkedWorktree {
  path: string;
  head?: string;
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
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim() || undefined;
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

/**
 * Compatibility-named read-only repository lifecycle audit.
 * It reports only Registry/Git contradictions through the existing Runtime projection.
 */
export function collectWorkLifecycleAttention(
  _controllerHome: string,
  repository: RepositoryRecord,
): WorkLifecycleAttention[] {
  const findings: WorkLifecycleAttention[] = [];
  const canonicalBranch = git(repository.canonicalRoot, ['branch', '--show-current'])?.trim();
  const targetBranch = canonicalBranch || repository.defaultBranch || 'main';
  const targetReachability = new Map<string, ReadonlySet<string> | undefined>();
  const reachableFrom = (branch: string): ReadonlySet<string> | undefined => {
    if (!targetReachability.has(branch)) {
      targetReachability.set(branch, reachableCommitSet(repository.canonicalRoot, branch));
    }
    return targetReachability.get(branch);
  };
  const activeRegistryRoots = new Set(
    repository.checkouts
      .filter((checkout) => (checkout.lifecycle ?? 'active') === 'active')
      .map((checkout) => canonicalPath(checkout.canonicalRoot)),
  );

  for (const checkout of repository.checkouts) {
    if ((checkout.lifecycle ?? 'active') === 'active' && !existsSync(checkout.canonicalRoot)) {
      findings.push(attention(
        'active_checkout_missing',
        checkout.checkoutId,
        'Registry checkout ' + checkout.checkoutId + ' is active but ' + checkout.canonicalRoot + ' is missing.',
      ));
    }
  }

  for (const worktree of linkedWorktrees(repository.canonicalRoot)) {
    const root = canonicalPath(worktree.path);
    if (activeRegistryRoots.has(root)) continue;
    const isDirty = dirty(root);
    if (isDirty === false) {
      const integrated = worktree.branch
        ? branchIntegrated(repository.canonicalRoot, worktree.branch, targetBranch, reachableFrom(targetBranch), worktree.head)
        : worktree.head
          ? exactCommitReachableFromTarget(repository.canonicalRoot, worktree.head, targetBranch, reachableFrom(targetBranch))
          : undefined;
      if (integrated === true) continue;
    }
    const code = isDirty === true ? 'dirty_linked_worktree_unregistered' : 'linked_worktree_unregistered';
    const identity = worktree.branch ?? root;
    const branchText = worktree.branch ? ' on ' + worktree.branch : '';
    const dirtyText = isDirty === true ? ' and has uncommitted changes' : '';
    findings.push(attention(
      code,
      identity,
      'Git worktree ' + root + branchText + ' is linked but absent from the active checkout registry' + dirtyText + '.',
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
    if (branchIntegrated(repository.canonicalRoot, branch, targetBranch, targetReachableCommits, head) !== false) continue;
    findings.push(attention(
      'branch_not_integrated',
      branch,
      'Git branch ' + branch + ' has unique patches not integrated into ' + targetBranch + '.',
    ));
  }

  return Array.from(new Map(findings.map((finding) => [finding.jobId, finding])).values())
    .sort((left, right) => left.jobId.localeCompare(right.jobId))
    .slice(0, 100);
}
