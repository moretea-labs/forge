import { spawnSync } from 'child_process';
import type { RepositoryRecord } from '../../core/repository/types';
import { isForgeSourceRemote, validateBranchName } from '../../core/git-branch-policy';
import { withControllerLock } from '../../effects/controller-locks';
import { resolveGitExecutable } from '../../effects/git-executable';

export const MAX_REPOSITORY_BRANCHES = 2;

/** Normalize local heads and origin tracking refs into unique logical branch names. */
export function repositoryBranchNamesFromRefs(refs: readonly string[]): string[] {
  const names = new Set<string>();
  for (const raw of refs) {
    const ref = String(raw ?? '').trim();
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      if (name) names.add(name);
    } else if (ref.startsWith('refs/remotes/origin/')) {
      const name = ref.slice('refs/remotes/origin/'.length);
      if (name && name !== 'HEAD') names.add(name);
    }
  }
  return [...names].sort();
}

/** Existing logical branches may be reused; creating a third distinct branch is forbidden. */
export function assertRepositoryBranchCapacity(
  refs: readonly string[],
  requestedBranch: unknown,
  maxBranches = MAX_REPOSITORY_BRANCHES,
  canonicalBranch?: string,
): string[] {
  const requested = validateBranchName(requestedBranch, { purpose: 'REPOSITORY_BRANCH_LIMIT' });
  if (canonicalBranch && requested !== canonicalBranch) {
    throw new Error('GIT_BRANCH_POLICY_MAIN_ONLY: only canonical branch ' + canonicalBranch + ' is permitted; requested: ' + requested);
  }
  const branches = repositoryBranchNamesFromRefs(refs);
  if (branches.includes(requested)) return branches;
  if (branches.length >= maxBranches) {
    throw new Error(
      'GIT_BRANCH_LIMIT_REACHED: repository permits at most ' + maxBranches
      + ' logical branch' + (maxBranches === 1 ? '' : 'es') + (canonicalBranch ? ' (' + canonicalBranch + ' only)' : ' (canonical plus shared working branch)') + '; observed ' + branches.length
      + ': ' + (branches.join(', ') || '(none)') + '; requested: ' + requested
      + '. Reconcile existing branches before creating another.',
    );
  }
  return branches;
}

function repositoryBranchLockResource(repoId: string): string {
  return 'repository-branch-governance-' + repoId;
}

function readRepositoryBranchRefs(repository: RepositoryRecord): string[] {
  const result = spawnSync(resolveGitExecutable(), [
    '-C', repository.canonicalRoot,
    'for-each-ref', '--format=%(refname)',
    'refs/heads', 'refs/remotes/origin',
  ], {
    cwd: repository.canonicalRoot,
    encoding: 'utf-8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || result.error) {
    const detail = [
      typeof result.stderr === 'string' ? result.stderr.trim() : '',
      result.error instanceof Error ? result.error.message : '',
    ].filter(Boolean).join('; ');
    throw new Error('GIT_BRANCH_INVENTORY_FAILED: unable to read local/origin branch refs' + (detail ? ': ' + detail : ''));
  }
  return String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * Serialize branch/worktree allocation per repository, then enforce the cap
 * against a fresh inventory before the operation can create a new branch.
 * The lock is shared by structured Git creation and managed Work worktrees.
 */
export function withRepositoryBranchCreation<T>(
  controllerHome: string,
  repository: RepositoryRecord,
  requestedBranch: string,
  owner: string,
  operation: () => T,
): T {
  return withControllerLock(
    controllerHome,
    { scope: 'global', resource: repositoryBranchLockResource(repository.repoId) },
    owner,
    () => {
      const forgeMainOnly = isForgeSourceRemote(repository.canonicalRemote ?? repository.remoteUrl);
      const canonicalBranch = forgeMainOnly ? (repository.defaultBranch?.trim() || 'main') : undefined;
      assertRepositoryBranchCapacity(
        readRepositoryBranchRefs(repository),
        requestedBranch,
        forgeMainOnly ? 1 : MAX_REPOSITORY_BRANCHES,
        canonicalBranch,
      );
      return operation();
    },
    120_000,
  );
}
