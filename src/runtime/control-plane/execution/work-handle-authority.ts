import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { getWorkContract } from '../facade/work-contract-store';
import { currentPermissionSnapshotVersion } from './validation';
import { readWorkHandle, writeWorkHandle, type WorkHandleState } from './work-handle-store';

export interface RepositoryWorkHandleControllerIdentity {
  sessionId: string;
  principalId: string;
}

/**
 * Canonical compatibility repair for a goal-workloop Work whose durable
 * WorkContract exists but whose WorkHandle has not yet been materialized.
 * Transport layers provide only the authenticated Controller identity.
 */
export function ensureRepositoryWorkHandle(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  identity: RepositoryWorkHandleControllerIdentity;
}): WorkHandleState | undefined {
  const existing = readWorkHandle(input.controllerHome, input.repository.repoId, input.workId);
  if (existing) return existing;
  const contract = getWorkContract(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
  );
  if (!contract || contract.workKind !== 'repository_change' || contract.mode !== 'goal_workloop' || !contract.checkoutId) {
    return undefined;
  }
  const executionRepository = resolveRepositorySelection({
    repoId: input.repository.repoId,
    checkoutId: contract.checkoutId,
    controllerHome: input.controllerHome,
    allowSoleRepository: false,
  });
  const checkout = selectRepositoryCheckout(executionRepository, contract.checkoutId, { allowArchived: true });
  const status = repositoryGitStatus(checkout);
  if (!status.branch) throw new Error(`WORKTREE_DETACHED: ${contract.checkoutId} has no branch`);
  const at = new Date().toISOString();
  const managedWorktree = Boolean(contract.worktreeRef)
    && resolve(contract.worktreeRef!) === resolve(checkout.canonicalRoot)
    && resolve(checkout.canonicalRoot) !== resolve(input.repository.canonicalRoot);
  return writeWorkHandle(input.controllerHome, {
    schemaVersion: 1,
    workId: input.workId,
    sessionId: input.identity.sessionId,
    principalId: input.identity.principalId,
    repositoryId: input.repository.repoId,
    checkoutId: contract.checkoutId,
    worktreePath: checkout.canonicalRoot,
    branch: status.branch,
    sourceCheckoutId: input.repository.activeCheckoutId,
    managedWorktree,
    workContractId: contract.workId,
    baseCommit: contract.baseRevision ?? status.head ?? undefined,
    deliveryBaseCommit: contract.baseRevision ?? status.head ?? undefined,
    expectedHead: status.head ?? contract.baseRevision,
    permissionSnapshotVersion: currentPermissionSnapshotVersion(input.controllerHome, input.repository.repoId),
    state: 'prepared',
    createdAt: at,
    updatedAt: at,
    finalization: {
      validation: 'pending',
      commit: 'pending',
      merge: 'pending',
      branchCleanup: 'pending',
      worktreeCleanup: 'pending',
    },
    cleanupResponsibility: { owner: 'work_finalizer', registeredAt: at },
  });
}

/**
 * Rebinds the durable WorkHandle to the Controller session that has already
 * been admitted by the ControllerSession authority. The compare-and-swap
 * revision on the read handle preserves fail-closed concurrent ownership.
 */
export function rebindRepositoryWorkHandleControllerIdentity(input: {
  controllerHome: string;
  repositoryId: string;
  workId: string;
  identity: RepositoryWorkHandleControllerIdentity;
}): WorkHandleState | undefined {
  const existing = readWorkHandle(input.controllerHome, input.repositoryId, input.workId);
  if (!existing) return undefined;
  if (existing.principalId === input.identity.principalId && existing.sessionId === input.identity.sessionId) return existing;
  return writeWorkHandle(input.controllerHome, {
    ...existing,
    principalId: input.identity.principalId,
    sessionId: input.identity.sessionId,
  });
}
