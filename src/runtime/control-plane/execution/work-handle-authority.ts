import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { getWorkContract, updateWorkContract } from '../../../../packages/kernel/work/api/index';
import { controllerSessionPrincipalId, getControllerSession } from '../../../../packages/kernel/controller/api/index';
import { isTerminalWorkContractStatus } from '../facade/types';
import { currentPermissionSnapshotVersion } from './validation';
import { readWorkHandle, writeWorkHandle, type WorkHandleState } from './work-handle-store';

export interface RepositoryWorkHandleControllerIdentity {
  sessionId: string;
  principalId: string;
}

function resolveRepositoryWorkHandlePlacement(input: {
  controllerHome: string;
  repositoryId: string;
  checkoutId: string;
  worktreeRef?: string;
}) {
  const registeredRepository = getRepository(input.repositoryId, input.controllerHome, { includeRemoved: true });
  const executionRepository = resolveRepositorySelection({ repoId: registeredRepository.repoId, checkoutId: input.checkoutId, controllerHome: input.controllerHome, allowSoleRepository: false });
  const checkout = selectRepositoryCheckout(executionRepository, input.checkoutId, { allowArchived: true });
  const registeredCheckout = registeredRepository.checkouts.find((entry) => entry.checkoutId === input.checkoutId);
  if (!registeredCheckout) throw new Error(`WORK_CHECKOUT_NOT_REGISTERED: ${input.checkoutId}`);
  const status = repositoryGitStatus(checkout);
  const branch = status.branch;
  if (!branch) throw new Error(`WORKTREE_DETACHED: ${input.checkoutId} has no branch`);
  const managedWorktree = registeredCheckout.worktree === true
    && Boolean(input.worktreeRef)
    && resolve(input.worktreeRef!) === resolve(checkout.canonicalRoot)
    && input.checkoutId !== registeredRepository.activeCheckoutId
    && resolve(checkout.canonicalRoot) !== resolve(registeredRepository.canonicalRoot);
  return { registeredRepository, registeredCheckout, checkout, status, branch, managedWorktree };
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
  // Callers may already be scoped to the Work checkout. Re-read the unselected
  // registry record so WorkHandle source/delivery authority never mistakes an
  // isolated execution worktree for the canonical source checkout.
  const placement = resolveRepositoryWorkHandlePlacement({
    controllerHome: input.controllerHome,
    repositoryId: input.repository.repoId,
    checkoutId: contract.checkoutId,
    worktreeRef: contract.worktreeRef,
  });
  const { registeredRepository, checkout, status, branch, managedWorktree } = placement;
  const sourceCheckoutId = registeredRepository.activeCheckoutId;
  const sourceCheckout = selectRepositoryCheckout(registeredRepository, sourceCheckoutId, { allowArchived: true });
  const sourceStatus = repositoryGitStatus(sourceCheckout);
  if (!sourceStatus.branch) throw new Error(`WORK_DELIVERY_TARGET_DETACHED: source checkout ${sourceCheckoutId} has no branch`);
  const at = new Date().toISOString();
  return writeWorkHandle(input.controllerHome, {
    schemaVersion: 1,
    workId: input.workId,
    sessionId: input.identity.sessionId,
    principalId: input.identity.principalId,
    repositoryId: input.repository.repoId,
    checkoutId: contract.checkoutId,
    worktreePath: checkout.canonicalRoot,
    branch,
    sourceCheckoutId,
    deliveryTargetBranch: sourceStatus.branch,
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

/** Upgrade only a legacy false-negative managed-worktree classification after all durable placement authorities agree. */
export function reconcileRepositoryWorkHandlePlacement(input: {
  controllerHome: string;
  repositoryId: string;
  workId: string;
}): WorkHandleState | undefined {
  const existing = readWorkHandle(input.controllerHome, input.repositoryId, input.workId);
  if (!existing || existing.managedWorktree) return existing;
  const contract = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repositoryId }, input.workId);
  if (!contract || contract.workKind !== 'repository_change' || contract.mode !== 'goal_workloop' || !contract.checkoutId) return existing;
  if (contract.checkoutId !== existing.checkoutId) throw new Error(`WORK_HANDLE_PLACEMENT_CHECKOUT_MISMATCH: ${input.workId}`);
  const placement = resolveRepositoryWorkHandlePlacement({ controllerHome: input.controllerHome, repositoryId: input.repositoryId, checkoutId: contract.checkoutId, worktreeRef: contract.worktreeRef });
  if (!placement.managedWorktree) return existing;
  if (placement.registeredCheckout.lifecycle !== 'active') throw new Error(`WORK_HANDLE_PLACEMENT_CHECKOUT_NOT_ACTIVE: ${input.workId}`);
  if (resolve(existing.worktreePath) !== resolve(placement.checkout.canonicalRoot)) throw new Error(`WORK_HANDLE_PLACEMENT_PATH_MISMATCH: ${input.workId}`);
  if (existing.branch !== placement.branch || (placement.registeredCheckout.branch && placement.registeredCheckout.branch !== placement.branch)) throw new Error(`WORK_HANDLE_PLACEMENT_BRANCH_MISMATCH: ${input.workId}`);
  return writeWorkHandle(input.controllerHome, { ...existing, sourceCheckoutId: placement.registeredRepository.activeCheckoutId, managedWorktree: true });
}

/**
 * Upgrades an effect-only Work before the first governed repository mutation
 * and materializes the existing repository delivery authority. The durable
 * ControllerSession is the ownership source; the MCP transport session is not
 * allowed to become a second mutation authority.
 */
export function ensureRepositoryMutationWorkHandle(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  principalId: string;
}): { handle: WorkHandleState; promotedFrom?: 'local_effect' | 'remote_effect' } {
  const store = { controllerHome: input.controllerHome, repoId: input.repository.repoId };
  let contract = getWorkContract(store, input.workId);
  if (!contract) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (isTerminalWorkContractStatus(contract.status) || contract.completionReceipt) {
    throw new Error(`WORK_REPOSITORY_MUTATION_TERMINAL: ${input.workId}`);
  }
  const principalId = input.principalId.trim();
  if (!principalId) throw new Error(`WORK_CONTROLLER_AUTHENTICATED_PRINCIPAL_REQUIRED: ${input.workId}`);
  const owner = getControllerSession(store, input.workId);
  if (!owner) throw new Error(`WORK_CONTROLLER_CLAIM_REQUIRED: ${input.workId}`);
  if (controllerSessionPrincipalId(owner) !== principalId) {
    throw new Error(`WORK_CONTROLLER_OWNERSHIP_MISMATCH: ${input.workId}`);
  }

  if (!contract.checkoutId) {
    if (contract.worktreeRef?.trim()) {
      throw new Error(`WORK_REPOSITORY_MUTATION_CHECKOUT_REQUIRED: ${input.workId}`);
    }
    contract = updateWorkContract(store, input.workId, { checkoutId: input.repository.activeCheckoutId });
  }

  let promotedFrom: 'local_effect' | 'remote_effect' | undefined;
  if (contract.workKind === 'local_effect' || contract.workKind === 'remote_effect') {
    promotedFrom = contract.workKind;
    contract = updateWorkContract(store, input.workId, { workKind: 'repository_change' });
  }
  if (contract.workKind !== 'repository_change') {
    throw new Error(`WORK_REPOSITORY_MUTATION_KIND_INVALID: ${input.workId}:${contract.workKind}`);
  }

  const handle = ensureRepositoryWorkHandle({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    identity: { sessionId: owner.sessionId, principalId },
  });
  if (!handle) throw new Error(`WORK_REPOSITORY_MUTATION_HANDLE_REQUIRED: ${input.workId}`);
  return { handle, ...(promotedFrom ? { promotedFrom } : {}) };
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
