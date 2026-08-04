import { spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import {
  getRepository,
  repositoryCheckoutRootMatches,
  selectRepositoryCheckout,
} from '../../../cli/repositories/registry';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import type { WorkHandleState } from './work-handle-store';

export type ExecutionIdentityErrorCode =
  | 'EXECUTION_IDENTITY_MISMATCH'
  | 'EXECUTION_IDENTITY_REQUIRED'
  | 'CHECKOUT_ROUTE_MISMATCH'
  | 'CHECKOUT_NOT_REGISTERED'
  | 'CHECKOUT_NOT_ACTIVE'
  | 'WORK_HANDLE_CHECKOUT_DRIFT'
  | 'WORK_HANDLE_BRANCH_CHANGED'
  | 'WORK_HANDLE_HEAD_CHANGED'
  | 'GIT_TOPLEVEL_MISMATCH'
  | 'GIT_COMMON_DIR_MISMATCH'
  | 'WORKTREE_MISSING'
  | 'WORKTREE_PATH_MISMATCH'
  | 'REPOSITORY_NOT_EXECUTABLE'
  | 'LEGACY_WORK_IDENTITY_AMBIGUOUS'
  | 'LEGACY_WORK_IDENTITY_REJECTED';

export interface ResolvedExecutionIdentity {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly checkoutId: string;
  readonly canonicalRoot: string;
  readonly workId?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly expectedHead?: string;
  readonly allowArchived?: boolean;
}

export interface GuardedExecutionIdentity extends ResolvedExecutionIdentity {
  readonly resolvedCwd: string;
  readonly gitTopLevel: string;
  readonly gitCommonDirectory: string;
  readonly currentBranch?: string;
  readonly currentHead?: string;
}

export class ExecutionIdentityError extends Error {
  readonly code: ExecutionIdentityErrorCode;
  readonly details: Record<string, string | undefined>;

  constructor(code: ExecutionIdentityErrorCode, message: string, details: Record<string, string | undefined> = {}) {
    const summary = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    super(summary ? `${code}: ${message} (${summary})` : `${code}: ${message}`);
    this.name = 'ExecutionIdentityError';
    this.code = code;
    this.details = details;
  }
}

function fail(
  code: ExecutionIdentityErrorCode,
  message: string,
  details: Record<string, string | undefined> = {},
): never {
  throw new ExecutionIdentityError(code, message, details);
}

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function realpathOrFail(path: string, code: ExecutionIdentityErrorCode, label: string): string {
  if (!existsSync(path)) fail(code, `${label} does not exist`, { path });
  try {
    return realpathSync(path);
  } catch (error) {
    fail(code, `${label} cannot be resolved`, {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function gitText(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

function gitPath(root: string, args: string[]): string | undefined {
  const value = gitText(root, args);
  if (!value) return undefined;
  try {
    return realpathSync(isAbsolute(value) ? value : resolve(root, value));
  } catch {
    return undefined;
  }
}

export function executionIdentityForRepository(
  repository: RepositoryRecord,
  patch: Partial<Pick<ResolvedExecutionIdentity, 'workId' | 'worktreePath' | 'branch' | 'expectedHead' | 'allowArchived'>> = {},
): ResolvedExecutionIdentity {
  return Object.freeze({
    schemaVersion: 1 as const,
    repositoryId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    canonicalRoot: repository.canonicalRoot,
    ...patch,
  });
}

export function executionIdentityForWork(
  repository: RepositoryRecord,
  handle: WorkHandleState,
): ResolvedExecutionIdentity {
  if (repository.repoId !== handle.repositoryId) {
    fail('EXECUTION_IDENTITY_MISMATCH', 'validated repository does not match WorkHandle', {
      expectedRepoId: handle.repositoryId,
      actualRepoId: repository.repoId,
      workId: handle.workId,
    });
  }

  // Once a Work exists, its immutable coordinates are the execution authority.
  // Repository.activeCheckoutId/canonicalRoot are mutable UI/session projection
  // fields and must never veto or rewrite an explicit Work-bound invocation.
  return Object.freeze({
    schemaVersion: 1 as const,
    repositoryId: handle.repositoryId,
    checkoutId: handle.checkoutId,
    canonicalRoot: handle.worktreePath,
    workId: handle.workId,
    worktreePath: handle.worktreePath,
    branch: handle.branch,
    expectedHead: handle.expectedHead,
  });
}

export function executionIdentityFromCoordinates(input: {
  repositoryId: string;
  checkoutId: string;
  canonicalRoot: string;
  workId?: string;
  worktreePath?: string;
  branch?: string;
  expectedHead?: string;
  allowArchived?: boolean;
}): ResolvedExecutionIdentity {
  if (!input.repositoryId.trim() || !input.checkoutId.trim() || !input.canonicalRoot.trim()) {
    fail('EXECUTION_IDENTITY_REQUIRED', 'repositoryId, checkoutId, and canonicalRoot are required');
  }
  return Object.freeze({ schemaVersion: 1 as const, ...input });
}

/**
 * Resolve legacy WorkContract identity only through a unique exact WorkHandle match.
 * Ambiguous or incomplete identity fails closed — never falls back to Session/main.
 */
export function resolveLegacyWorkContractIdentity(input: {
  workId: string;
  repoId?: string;
  checkoutId?: string;
  canonicalRoot?: string;
  branch?: string;
  head?: string;
  candidates: readonly WorkHandleState[];
}): WorkHandleState {
  const exact = input.candidates.filter((handle) => {
    if (handle.workId !== input.workId) return false;
    if (input.repoId && handle.repositoryId !== input.repoId) return false;
    if (input.checkoutId && handle.checkoutId !== input.checkoutId) return false;
    if (input.canonicalRoot) {
      try {
        if (!samePath(realpathSync(handle.worktreePath), realpathSync(input.canonicalRoot))) return false;
      } catch {
        return false;
      }
    }
    if (input.branch && handle.branch !== input.branch) return false;
    if (input.head && handle.expectedHead && handle.expectedHead !== input.head) return false;
    return true;
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    fail('LEGACY_WORK_IDENTITY_AMBIGUOUS', 'legacy WorkContract matches multiple WorkHandles', {
      workId: input.workId,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      matchCount: String(exact.length),
    });
  }
  fail('LEGACY_WORK_IDENTITY_REJECTED', 'legacy WorkContract has no unique exact WorkHandle match', {
    workId: input.workId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    candidateCount: String(input.candidates.length),
  });
}

export function assertExecutionIdentity(input: {
  controllerHome: string;
  identity: ResolvedExecutionIdentity;
  cwd: string;
  requestedRepoId?: string;
  requestedCheckoutId?: string;
}): GuardedExecutionIdentity {
  const { identity } = input;
  if (input.requestedRepoId && input.requestedRepoId !== identity.repositoryId) {
    fail('EXECUTION_IDENTITY_MISMATCH', 'requested repository differs from execution identity', {
      expectedRepoId: identity.repositoryId,
      actualRepoId: input.requestedRepoId,
      checkoutId: identity.checkoutId,
      workId: identity.workId,
    });
  }
  if (input.requestedCheckoutId && input.requestedCheckoutId !== identity.checkoutId) {
    fail('CHECKOUT_ROUTE_MISMATCH', 'requested checkout differs from execution identity', {
      expectedCheckoutId: identity.checkoutId,
      actualCheckoutId: input.requestedCheckoutId,
      repoId: identity.repositoryId,
      workId: identity.workId,
    });
  }

  const registered = getRepository(identity.repositoryId, input.controllerHome, { includeRemoved: true });
  if (registered.removedAt || registered.enabled === false) {
    fail('REPOSITORY_NOT_EXECUTABLE', `repository ${identity.repositoryId} is disabled or removed`, {
      repoId: identity.repositoryId,
    });
  }
  const checkout = registered.checkouts.find((entry) => entry.checkoutId === identity.checkoutId);
  if (!checkout) {
    fail('CHECKOUT_NOT_REGISTERED', 'checkout is not registered on the repository', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
    });
  }
  const lifecycle = checkout.lifecycle ?? 'active';
  if (lifecycle !== 'active' && !(identity.allowArchived && lifecycle === 'archived')) {
    fail('CHECKOUT_NOT_ACTIVE', `checkout is ${lifecycle}`, {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      lifecycle,
    });
  }
  const selected = selectRepositoryCheckout(registered, identity.checkoutId, {
    allowArchived: identity.allowArchived === true,
  });
  const registeredRoot = realpathOrFail(selected.canonicalRoot, 'WORKTREE_MISSING', 'registered checkout root');
  const identityRoot = realpathOrFail(identity.canonicalRoot, 'WORKTREE_MISSING', 'execution identity root');
  if (!samePath(registeredRoot, identityRoot)) {
    fail('CHECKOUT_ROUTE_MISMATCH', 'identity root differs from registered checkout', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      expected: registeredRoot,
      actual: identityRoot,
    });
  }
  if (identity.worktreePath) {
    const worktreePath = realpathOrFail(identity.worktreePath, 'WORKTREE_MISSING', 'WorkHandle worktree');
    if (!samePath(worktreePath, registeredRoot)) {
      fail('WORKTREE_PATH_MISMATCH', 'WorkHandle path differs from registered checkout', {
        repoId: identity.repositoryId,
        checkoutId: identity.checkoutId,
        expected: registeredRoot,
        actual: worktreePath,
        workId: identity.workId,
      });
    }
  }
  if (!repositoryCheckoutRootMatches(registered, registeredRoot)) {
    fail('GIT_COMMON_DIR_MISMATCH', 'checkout Git common directory does not belong to the registered repository', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      root: registeredRoot,
    });
  }

  const requestedCwd = isAbsolute(input.cwd) ? input.cwd : resolve(registeredRoot, input.cwd);
  const resolvedCwd = realpathOrFail(requestedCwd, 'WORKTREE_MISSING', 'process cwd');
  const cwdRelative = relative(registeredRoot, resolvedCwd);
  if (cwdRelative === '..' || cwdRelative.startsWith('../') || cwdRelative.startsWith('..\\')) {
    fail('CHECKOUT_ROUTE_MISMATCH', 'process cwd escapes checkout root', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      expected: registeredRoot,
      actual: resolvedCwd,
    });
  }

  const gitTopLevel = gitPath(resolvedCwd, ['rev-parse', '--show-toplevel']);
  if (!gitTopLevel || !samePath(gitTopLevel, registeredRoot)) {
    fail('GIT_TOPLEVEL_MISMATCH', 'Git top-level differs from expected checkout root', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      expected: registeredRoot,
      actual: gitTopLevel ?? 'missing',
    });
  }

  const gitCommonDirectory = gitPath(resolvedCwd, ['rev-parse', '--git-common-dir']);
  const registeredCommonDirectory = gitPath(registeredRoot, ['rev-parse', '--git-common-dir']);
  const repositoryCommonDirectory = gitPath(registered.canonicalRoot, ['rev-parse', '--git-common-dir']);
  if (
    !gitCommonDirectory
    || !registeredCommonDirectory
    || !repositoryCommonDirectory
    || !samePath(gitCommonDirectory, registeredCommonDirectory)
    || !samePath(gitCommonDirectory, repositoryCommonDirectory)
  ) {
    fail('GIT_COMMON_DIR_MISMATCH', 'Git common directory does not match registered repository ownership', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      expected: repositoryCommonDirectory ?? 'missing',
      actual: gitCommonDirectory ?? 'missing',
    });
  }

  const currentBranch = gitText(registeredRoot, ['branch', '--show-current']);
  const currentHead = gitText(registeredRoot, ['rev-parse', '--verify', 'HEAD']);
  if (identity.branch && currentBranch !== identity.branch) {
    fail('WORK_HANDLE_BRANCH_CHANGED', 'branch drifted from execution identity', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      expected: identity.branch,
      actual: currentBranch ?? 'detached',
      workId: identity.workId,
    });
  }
  if (identity.expectedHead && currentHead !== identity.expectedHead) {
    fail('WORK_HANDLE_HEAD_CHANGED', 'HEAD drifted from execution identity; re-prepare required', {
      repoId: identity.repositoryId,
      checkoutId: identity.checkoutId,
      expected: identity.expectedHead,
      actual: currentHead ?? 'missing',
      workId: identity.workId,
    });
  }

  return Object.freeze({
    ...identity,
    canonicalRoot: registeredRoot,
    resolvedCwd,
    gitTopLevel,
    gitCommonDirectory,
    currentBranch,
    currentHead,
  });
}
