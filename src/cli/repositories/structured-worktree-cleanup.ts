import { spawnSync } from 'child_process';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { listOwnedResources } from '../../../packages/kernel/identity/api/index';
import { withRepositoryMutationExclusion } from '../../runtime/resources/leases/store';
import { listWorkHandlesFailClosed } from '../../runtime/control-plane/execution/work-handle-store';
import { getRepository, setRepositoryCheckoutLifecycle } from './registry';
import { executeRepositoryGitCommand, type RepositoryGitExecution } from './git-command-executor';
import type { RepositoryRecord } from './types';

export interface RepositoryWorktreeCleanupResult {
  repoId: string;
  checkoutId: string;
  targetRoot: string;
  expectedHead: string;
  physicalIdentity?: string;
  status: 'preview' | 'approval_required' | 'removed' | 'already_removed' | 'cleanup_pending';
  execution?: RepositoryGitExecution;
  reason?: string;
}

function git(root: string, args: string[]): { ok: boolean; text: string } {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' },
    timeout: 10_000,
  });
  return { ok: result.status === 0 && !result.error, text: String(result.stdout ?? '').trim() };
}

function gitWorktreeListed(root: string, targetRoot: string): boolean {
  const listed = git(root, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) throw new Error('GIT_WORKTREE_INVENTORY_UNAVAILABLE');
  return listed.text.split(/\r?\n/).some((line) =>
    line.startsWith('worktree ') && resolve(line.slice('worktree '.length)) === targetRoot);
}


/**
 * Native Git HEAD lock, not a second Forge lease. Git commit/switch/reset
 * cannot update this linked worktree's HEAD while it is held, including from
 * external Git processes outside Forge's cooperative Process lease.
 *
 * Git worktree remove does not acquire this lock; it deletes the administrative
 * HEAD.lock along with the checkout. On failure release only our exact inode,
 * never a replacement foreign lock.
 */
function withNativeWorktreeHeadLock<T>(
  canonicalRoot: string,
  targetRoot: string,
  run: () => T,
): T {
  const common = git(canonicalRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const admin = git(targetRoot, ['rev-parse', '--absolute-git-dir']);
  if (!common.ok || !admin.ok) throw new Error('GIT_WORKTREE_HEAD_LOCK_AUTHORITY_MISSING');
  const adminRoot = realpathSync(admin.text);
  if (dirname(adminRoot) !== join(realpathSync(common.text), 'worktrees')) {
    throw new Error('GIT_WORKTREE_HEAD_LOCK_SCOPE_MISMATCH');
  }
  const lockPath = join(adminRoot, 'HEAD.lock');
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('GIT_WORKTREE_HEAD_LOCK_HELD');
  }
  try {
    return run();
  } finally {
    try {
      const own = fstatSync(fd);
      if (existsSync(lockPath)) {
        const current = lstatSync(lockPath);
        if (own.dev !== current.dev || own.ino !== current.ino) {
          throw new Error('GIT_WORKTREE_HEAD_LOCK_REPLACED');
        }
        unlinkSync(lockPath);
      }
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * The registry Checkout ID is the target authority. Neither caller-supplied
 * filesystem paths nor a historical WorkHandle can authorize deletion.
 * Repository/Git/Process ownership checks share the existing repository lock.
 */
export function repositoryGitRemoveWorktree(
  controllerHome: string,
  repository: RepositoryRecord,
  input: { checkoutId: string; expectedHead?: string; expectedIdentity?: string; previewToken?: string; confirmCleanup?: boolean },
): RepositoryWorktreeCleanupResult {
  return withRepositoryMutationExclusion(controllerHome, repository.repoId, 'structured-worktree-remove', () => {
    const current = getRepository(repository.repoId, controllerHome);
    if (!current || current.canonicalRoot !== repository.canonicalRoot
      || current.activeCheckoutId !== repository.activeCheckoutId) {
      throw new Error('GIT_WORKTREE_REPOSITORY_REGISTRY_STALE');
    }
    const target = current.checkouts.find((entry) => entry.checkoutId === input.checkoutId);
    if (!target) throw new Error('GIT_WORKTREE_CHECKOUT_UNREGISTERED: ' + input.checkoutId);
    const targetRoot = resolve(target.localRoot);
    const base = { repoId: repository.repoId, checkoutId: target.checkoutId, targetRoot };
    if (target.lifecycle === 'removed') {
      if (existsSync(targetRoot) || gitWorktreeListed(repository.canonicalRoot, targetRoot)) {
        throw new Error('GIT_WORKTREE_REMOVED_RECORD_REUSED');
      }
      return { ...base, expectedHead: input.expectedHead ?? '', status: 'already_removed' };
    }
    if (!target.worktree || target.checkoutId === repository.activeCheckoutId
      || targetRoot === resolve(repository.canonicalRoot)) {
      throw new Error('GIT_WORKTREE_PRIMARY_OR_ACTIVE_PROTECTED');
    }
    const owner = listOwnedResources(controllerHome, { kind: 'worktree', repoId: repository.repoId })
      .find((item) => {
        if (item.status === 'released') return false;
        // macOS /var and /private/var may name the same owned inode.
        // Path string comparison must never silently release its real owner.
        const recorded = resolve(item.targetRef);
        return recorded === targetRoot
          || (existsSync(recorded) && realpathSync(recorded) === realpathSync(targetRoot));
      });
    if (owner) throw new Error('GIT_WORKTREE_OWNED_RESOURCE_PROTECTED: ' + owner.resourceId);
    // Legacy WorkHandles may predate OwnedResource registration. Keep their
    // checkout authority fenced; do not reinterpret absence of metadata as
    // permission to delete another Work's physical source.
    const legacyOwner = listWorkHandlesFailClosed(controllerHome, repository.repoId)
      .find((handle) => handle.state !== 'cleaned'
        && (handle.checkoutId === target.checkoutId
          || resolve(handle.worktreePath) === targetRoot
          || (existsSync(handle.worktreePath) && existsSync(targetRoot)
            && realpathSync(handle.worktreePath) === realpathSync(targetRoot))));
    if (legacyOwner) throw new Error('GIT_WORKTREE_LEGACY_WORK_HANDLE_PROTECTED: ' + legacyOwner.workId);
    // No path-based adoption: registry identity and live Git linkage must agree.
    const listed = gitWorktreeListed(repository.canonicalRoot, targetRoot);
    if (!existsSync(targetRoot)) {
      if (listed) throw new Error('GIT_WORKTREE_MISSING_BUT_LINKED');
      setRepositoryCheckoutLifecycle({ controllerHome, repoId: repository.repoId,
        checkoutId: target.checkoutId, lifecycle: 'removed', reason: 'Git already removed this checkout' });
      return { ...base, expectedHead: input.expectedHead ?? '', status: 'already_removed' };
    }
    if (!listed || lstatSync(targetRoot).isSymbolicLink() || !lstatSync(targetRoot).isDirectory()
      || realpathSync(targetRoot) !== targetRoot) {
      throw new Error('GIT_WORKTREE_PHYSICAL_IDENTITY_MISMATCH');
    }
    const originalCommon = git(repository.canonicalRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const targetCommon = git(targetRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!originalCommon.ok || !targetCommon.ok
      || realpathSync(originalCommon.text) !== realpathSync(targetCommon.text)) {
      throw new Error('GIT_WORKTREE_REPOSITORY_IDENTITY_MISMATCH');
    }
    const currentHead = git(targetRoot, ['rev-parse', '--verify', 'HEAD']);
    if (!currentHead.ok || !/^[0-9a-f]{40,64}$/.test(currentHead.text)) {
      throw new Error('GIT_WORKTREE_HEAD_UNVERIFIED');
    }
    const physicalStat = lstatSync(targetRoot);
    const physicalIdentity = String(physicalStat.dev) + ':' + String(physicalStat.ino);
    if (input.confirmCleanup && (!input.expectedHead || !input.expectedIdentity || !input.previewToken)) {
      throw new Error('GIT_WORKTREE_PREVIEW_PROOF_REQUIRED');
    }
    if (input.expectedHead && currentHead.text !== input.expectedHead) {
      throw new Error('GIT_WORKTREE_STALE_HEAD');
    }
    if (input.expectedIdentity && physicalIdentity !== input.expectedIdentity) {
      throw new Error('GIT_WORKTREE_PHYSICAL_IDENTITY_CHANGED');
    }
    const dirty = git(targetRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!dirty.ok || dirty.text) throw new Error('GIT_WORKTREE_DIRTY_PROTECTED');
    const merged = git(repository.canonicalRoot, ['merge-base', '--is-ancestor',
      currentHead.text, 'refs/heads/' + (repository.defaultBranch || 'main')]);
    if (!merged.ok) throw new Error('GIT_WORKTREE_UNMERGED_HEAD_PROTECTED');
    // The Git approval token binds target path plus canonical Git snapshot.
    // On confirmation, the native target HEAD.lock must fence standard Git
    // writers not using Forge; recheck target-specific facts under that lock.
    const args = ['worktree', 'remove', targetRoot];
    if (!input.confirmCleanup) {
      const execution = executeRepositoryGitCommand(controllerHome, repository, { args, dryRun: true });
      return { ...base, expectedHead: currentHead.text, physicalIdentity,
        status: 'preview', execution };
    }
    const execution = withNativeWorktreeHeadLock(repository.canonicalRoot, targetRoot, () => {
      const heldHead = git(targetRoot, ['rev-parse', '--verify', 'HEAD']);
      const heldStat = lstatSync(targetRoot);
      if (!heldHead.ok || heldHead.text !== currentHead.text
        || heldStat.dev !== physicalStat.dev || heldStat.ino !== physicalStat.ino) {
        throw new Error('GIT_WORKTREE_CHANGED_BEFORE_REMOVE');
      }
      const heldDirty = git(targetRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (!heldDirty.ok || heldDirty.text) throw new Error('GIT_WORKTREE_DIRTY_PROTECTED');
      if (!git(repository.canonicalRoot, ['merge-base', '--is-ancestor',
        heldHead.text, 'refs/heads/' + (repository.defaultBranch || 'main')]).ok) {
        throw new Error('GIT_WORKTREE_UNMERGED_HEAD_PROTECTED');
      }
      // The general-purpose Git executor can grant approved operations even
      // when the optional approvalToken differs. This destructive path must
      // independently compare the exact current preview before invoking it.
      const fresh = executeRepositoryGitCommand(controllerHome, repository, { args, dryRun: true });
      if (fresh.approvalToken !== input.previewToken) {
        throw new Error('GIT_WORKTREE_APPROVAL_TOKEN_STALE');
      }
      return executeRepositoryGitCommand(controllerHome, repository, {
        args, approvalToken: input.previewToken, authorization: 'confirmed_plan',
      });
    });
    if (execution.status !== 'executed') return {
      ...base, expectedHead: currentHead.text, physicalIdentity, status: 'approval_required', execution,
      reason: 'Exact Git confirmation required',
    };
    if (!execution.ok) return {
      ...base, expectedHead: currentHead.text, physicalIdentity, status: 'cleanup_pending', execution,
      reason: execution.stderr || 'Git removal failed; checkout remains pending',
    };
    // A successful Git unlink is not final until the same Registry says removed.
    // If persistence fails, the next identical request can reconcile absence.
    try {
      setRepositoryCheckoutLifecycle({ controllerHome, repoId: repository.repoId,
        checkoutId: target.checkoutId, lifecycle: 'removed', reason: 'Structured Git worktree cleanup' });
    } catch (error) {
      return { ...base, expectedHead: currentHead.text, physicalIdentity, status: 'cleanup_pending', execution,
        reason: error instanceof Error ? error.message : String(error) };
    }
    if (existsSync(targetRoot) || gitWorktreeListed(repository.canonicalRoot, targetRoot)) {
      return { ...base, expectedHead: currentHead.text, physicalIdentity, status: 'cleanup_pending', execution,
        reason: 'Git worktree removal did not converge after Registry settlement' };
    }
    return { ...base, expectedHead: currentHead.text, physicalIdentity, status: 'removed', execution };
  });
}
