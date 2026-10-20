import { existsSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { getRepository, repositoryCheckoutLifecycle, selectRepositoryCheckout, validateRepository } from '../../../cli/repositories/registry';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { getWorkContract } from '../../../../packages/kernel/work/api/index';
import type { WorkContract } from '../facade/types';
import { requireExecutionSession, type ExecutionSessionContext, type SessionIdentity } from './session-store';
import type { WorkHandleState } from './work-handle-store';

export type ValidationLevel = 'none' | 'cheap' | 'full';

/**
 * A WorkHandle's checkout is placement, not semantic identity. The checkout can
 * disappear while the canonical WorkContract remains valid; that must not grant
 * the retired execution location a permanent veto over the Work.
 */
export type WorkHandlePlacementLoss = 'checkout_unregistered' | 'worktree_missing';

export interface ValidatedWorkHandle {
  session: ExecutionSessionContext;
  repository: RepositoryRecord;
  worktreeRepository: RepositoryRecord;
  contract?: WorkContract;
  handle: WorkHandleState;
  currentHead?: string;
  currentBranch?: string;
  warnings: string[];
  /**
   * Set only for a read-only inspection whose recorded placement is gone. The
   * Work contract is still authoritative, but no Git claim is made and every
   * mutating operation remains rejected until prepare re-establishes placement.
   */
  placementLoss?: WorkHandlePlacementLoss;
}

/**
 * One definition of "the recorded placement is gone", shared by inspection and
 * prepare recovery. It consumes the repository record the caller already read,
 * so validation does not repeat a registry lookup. The canonical checkout is
 * never treated as lost: its own validation owns that failure domain.
 */
export function workHandlePlacementLoss(repository: RepositoryRecord, handle: WorkHandleState): WorkHandlePlacementLoss | undefined {
  const checkout = repository.checkouts.find((entry) => entry.checkoutId === handle.checkoutId);
  if (!checkout || repositoryCheckoutLifecycle(checkout) !== 'active') return 'checkout_unregistered';
  if (checkout.checkoutId === repository.activeCheckoutId) return undefined;
  if (!existsSync(handle.worktreePath)) return 'worktree_missing';
  return undefined;
}

function gitText(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

function gitSucceeds(root: string, args: string[]): boolean {
  return spawnSync('git', ['-C', root, ...args], { stdio: 'ignore', timeout: 10_000 }).status === 0;
}

export type WorkHandleValidationErrorCode =
  | 'CHECKOUT_NOT_REGISTERED'
  | 'REPOSITORY_NOT_EXECUTABLE'
  | 'REPOSITORY_VALIDATION_FAILED'
  | 'WORKTREE_INVALID'
  | 'WORKTREE_MISSING'
  | 'WORKTREE_PATH_MISMATCH'
  | 'WORK_CONTRACT_MISSING'
  | 'WORK_CONTRACT_REPOSITORY_MISMATCH'
  | 'WORK_HANDLE_BRANCH_CHANGED'
  | 'WORK_HANDLE_HEAD_CHANGED'
  | 'WORK_HANDLE_LIFECYCLE_INVALID'
  | 'WORK_HANDLE_PRINCIPAL_MISMATCH'
  | 'WORK_HANDLE_STALE_PERMISSION';

export class WorkHandleValidationError extends Error {
  readonly code: WorkHandleValidationErrorCode;

  constructor(code: WorkHandleValidationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorkHandleValidationError';
    this.code = code;
  }
}

function fail(code: WorkHandleValidationErrorCode, message: string): never {
  throw new WorkHandleValidationError(code, message);
}

export function currentPermissionSnapshotVersion(controllerHome: string, repoId: string): number {
  return readRepositoryAccessPolicy(controllerHome, repoId).revision;
}

export function assertWorkHandleLifecycle(handle: WorkHandleState, operation: 'inspect' | 'execute' | 'validate' | 'deliver'): void {
  const allowed: Record<typeof operation, readonly WorkHandleState['state'][]> = {
    inspect: ['prepared', 'editing', 'validating', 'committed', 'merged', 'failed', 'failed_terminal_cleanup', 'cleaned'],
    execute: ['prepared', 'editing'],
    validate: ['prepared', 'editing', 'validating', 'committed', 'merged', 'failed'],
    deliver: ['editing', 'committed', 'merged', 'failed'],
  };
  if (!allowed[operation].includes(handle.state)) {
    fail('WORK_HANDLE_LIFECYCLE_INVALID', `${operation} is not valid while handle is ${handle.state}`);
  }
}

export function validateWorkHandle(
  controllerHome: string,
  handle: WorkHandleState,
  identity: SessionIdentity,
  level: ValidationLevel,
  operation: 'inspect' | 'execute' | 'validate' | 'deliver',
): ValidatedWorkHandle {
  const session = requireExecutionSession(controllerHome, identity);
  if (handle.principalId !== session.principalId) fail('WORK_HANDLE_PRINCIPAL_MISMATCH', 'work handle belongs to another principal');
  assertWorkHandleLifecycle(handle, operation);
  const warnings: string[] = [];
  if (handle.sessionId !== session.sessionId) {
    warnings.push('Work is controller-owned and was created by a different MCP session; current session is observing it by principal identity.');
  }
  if (session.activeRepositoryId && session.activeRepositoryId !== handle.repositoryId) {
    warnings.push('Current session repository focus differs from the Work repository; using the Work handle repository authority.');
  }
  if (session.activeCheckoutId && session.activeCheckoutId !== handle.checkoutId) {
    warnings.push('Current session checkout focus differs from the Work checkout; using the Work handle checkout authority.');
  }
  if (session.activeWorkId && session.activeWorkId !== handle.workId) {
    warnings.push('Current session work focus differs from the requested Work; using the explicit Work handle.');
  }

  const repository = getRepository(handle.repositoryId, controllerHome, { includeRemoved: true });
  if (repository.removedAt || repository.enabled === false) fail('REPOSITORY_NOT_EXECUTABLE', `repository ${repository.repoId} is disabled or removed`);

  const permissionVersion = currentPermissionSnapshotVersion(controllerHome, repository.repoId);
  if (permissionVersion !== handle.permissionSnapshotVersion) {
    fail('WORK_HANDLE_STALE_PERMISSION', `permission snapshot ${handle.permissionSnapshotVersion} is stale; current version is ${permissionVersion}`);
  }

  // A deleted checkout is a lost execution location, not a cancelled Work.
  // Read-only inspection keeps the semantic Work visible; every operation that
  // needs real Git state still fails until prepare re-establishes placement.
  const placementLoss = workHandlePlacementLoss(repository, handle);
  if (placementLoss) {
    if (operation === 'inspect' && level !== 'full') {
      warnings.push(`Work placement is lost (${placementLoss}); the canonical Work is retained but no Git state is reported. Call work_prepare with this work_id to re-establish an exact managed placement.`);
      return { session, repository, worktreeRepository: repository, handle, warnings, placementLoss };
    }
    fail(
      placementLoss === 'checkout_unregistered' ? 'CHECKOUT_NOT_REGISTERED' : 'WORKTREE_MISSING',
      `recorded Work placement is lost (${placementLoss}); re-establish it with work_prepare before ${operation}`,
    );
  }

  const worktreeRepository = selectRepositoryCheckout(repository, handle.checkoutId);
  if (worktreeRepository.activeCheckoutId !== handle.checkoutId) fail('CHECKOUT_NOT_REGISTERED', handle.checkoutId);

  if (level === 'none') return { session, repository, worktreeRepository, handle, warnings };

  const root = worktreeRepository.canonicalRoot;
  if (!existsSync(root)) fail('WORKTREE_MISSING', `worktree no longer exists: ${root}`);
  const resolvedRoot = realpathSync(root);
  if (resolvedRoot !== realpathSync(handle.worktreePath)) fail('WORKTREE_PATH_MISMATCH', 'registered checkout and work handle path differ');
  const gitRoot = gitText(root, ['rev-parse', '--show-toplevel']);
  if (!gitRoot || realpathSync(gitRoot) !== resolvedRoot) fail('WORKTREE_INVALID', 'worktree is no longer a valid Git checkout');
  const currentBranch = gitText(root, ['branch', '--show-current']);
  const currentHead = gitText(root, ['rev-parse', '--verify', 'HEAD']);
  if (currentBranch !== handle.branch) fail('WORK_HANDLE_BRANCH_CHANGED', `expected ${handle.branch}, found ${currentBranch ?? 'detached'}`);
  const managedWorkProgress = (operation === 'inspect' || operation === 'validate' || operation === 'deliver')
    && handle.managedWorktree
    && Boolean(handle.expectedHead && currentHead)
    && gitSucceeds(root, ['merge-base', '--is-ancestor', handle.expectedHead!, currentHead!]);
  if (handle.expectedHead && currentHead !== handle.expectedHead && !managedWorkProgress) {
    fail('WORK_HANDLE_HEAD_CHANGED', `expected ${handle.expectedHead}, found ${currentHead ?? 'missing'}`);
  }
  if (managedWorkProgress && currentHead !== handle.expectedHead) {
    warnings.push('Managed Worktree HEAD advanced from the prepared revision by Work-owned descendant commits; inspection/validation will use the current Work state.');
  }

  if (level === 'full') {
    const validation = validateRepository(repository.repoId, controllerHome);
    if (handle.checkoutId === repository.activeCheckoutId && !validation.ok) {
      fail('REPOSITORY_VALIDATION_FAILED', validation.errors.join('; ') || 'repository validation failed');
    }
    const contract = handle.workContractId
      ? getWorkContract({ controllerHome, repoId: repository.repoId }, handle.workContractId)
      : undefined;
    if (handle.workContractId && !contract) fail('WORK_CONTRACT_MISSING', handle.workContractId);
    if (contract && contract.repoId !== handle.repositoryId) fail('WORK_CONTRACT_REPOSITORY_MISMATCH', handle.workContractId ?? '');
    return { session, repository, worktreeRepository, contract, handle, currentHead, currentBranch, warnings };
  }
  return { session, repository, worktreeRepository, handle, currentHead, currentBranch, warnings };
}
