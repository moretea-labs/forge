import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { appendWorkEvidence, getWorkContract, promoteWorkToRepositoryChange, updateWorkContract } from '../../../../packages/kernel/work/api/index';
import { isTerminalWorkContractStatus } from '../facade/types';
import { currentPermissionSnapshotVersion } from './validation';
import { listWorkHandles, readWorkHandle, transitionWorkHandle, writeWorkHandle, type WorkHandleState } from './work-handle-store';
import { inspectDirectCanonicalPreMutationReconciliation } from './direct-canonical-work-reconciliation';

export interface RepositoryWorkHandleControllerIdentity {
  sessionId: string;
  principalId: string;
}

const DURABLE_CANONICAL_MUTATION_OWNER_STATES = new Set<WorkHandleState['state']>([
  'editing',
  'validating',
  'failed_terminal_cleanup',
  'failed',
]);

/**
 * Fences repository mutations across Process/Lease lifetimes using the existing
 * durable WorkHandle authority. Process leases prevent overlapping execution;
 * this check prevents a later mutation call from taking over a canonical
 * checkout whose mutable lifecycle still belongs to another Work.
 */
export function assertCanonicalRepositoryMutationWorkHandleAvailable(input: {
  controllerHome: string;
  repositoryId: string;
  checkoutId: string;
  workId?: string;
}): void {
  const owners = listWorkHandles(input.controllerHome, input.repositoryId, 5_000)
    .filter((handle) => {
      if (handle.workId === input.workId
        || handle.checkoutId !== input.checkoutId
        || handle.managedWorktree === true
        || !DURABLE_CANONICAL_MUTATION_OWNER_STATES.has(handle.state)) {
        return false;
      }
      const contract = getWorkContract(
        { controllerHome: input.controllerHome, repoId: input.repositoryId },
        handle.workId,
      );
      // A stale physical handle cannot outlive canonical Work lifecycle authority.
      // Missing WorkContract evidence remains fail-closed for legacy/unreconciled
      // handles; only an explicit terminal status or completion receipt releases
      // durable canonical writer ownership.
      return !contract || (!isTerminalWorkContractStatus(contract.status) && !contract.completionReceipt);
    })
    .sort((left, right) => left.workId.localeCompare(right.workId));
  if (owners.length === 0) return;
  if (owners.length > 1) {
    throw new Error(
      `WORK_CANONICAL_MUTATION_OWNERSHIP_AMBIGUOUS: checkout=${input.checkoutId}; owners=${owners.map((owner) => owner.workId).join(',')}; requested=${input.workId ?? 'unattributed'}`,
    );
  }
  throw new Error(
    `WORK_CANONICAL_MUTATION_OWNED: checkout=${input.checkoutId}; owner=${owners[0]!.workId}; state=${owners[0]!.state}; requested=${input.workId ?? 'unattributed'}`,
  );
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
  allowEffectWork?: boolean;
}): WorkHandleState | undefined {
  const existing = readWorkHandle(input.controllerHome, input.repository.repoId, input.workId);
  if (existing) return existing;
  const contract = getWorkContract(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
  );
  const supportedKind = contract?.workKind === 'repository_change'
    || contract?.workKind === 'completed_no_change'
    || contract?.workKind === 'reconciliation'
    || (input.allowEffectWork === true && (contract?.workKind === 'local_effect' || contract?.workKind === 'remote_effect'));
  if (!contract || !supportedKind || contract.mode !== 'goal_workloop' || !contract.checkoutId) {
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

export function assertManagedRepositoryMutationAuthority(input: {
  repository: RepositoryRecord;
  handle: WorkHandleState;
}): void {
  if (!input.handle.managedWorktree) return;
  if (input.handle.state !== 'prepared' && input.handle.state !== 'editing') {
    throw new Error(`WORK_REPOSITORY_MUTATION_LIFECYCLE_INVALID: ${input.handle.workId}:${input.handle.state}`);
  }
  if (input.repository.activeCheckoutId !== input.handle.checkoutId) {
    throw new Error(`WORK_REPOSITORY_MUTATION_CHECKOUT_MISMATCH: expected ${input.handle.checkoutId}, found ${input.repository.activeCheckoutId}`);
  }
  const status = repositoryGitStatus(input.repository);
  if (status.branch !== input.handle.branch) {
    throw new Error(`WORK_REPOSITORY_MUTATION_BRANCH_CHANGED: expected ${input.handle.branch}, found ${status.branch ?? 'detached'}`);
  }
  if (!input.handle.expectedHead || status.head !== input.handle.expectedHead) {
    throw new Error(`WORK_REPOSITORY_MUTATION_HEAD_CHANGED: expected ${input.handle.expectedHead ?? 'missing'}, found ${status.head ?? 'missing'}`);
  }
}

function alignRepositoryMutationBase(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  contract: NonNullable<ReturnType<typeof getWorkContract>>;
  handle: WorkHandleState;
  freshlyMaterialized: boolean;
}): WorkHandleState {
  if (input.handle.managedWorktree || input.handle.state !== 'prepared') return input.handle;
  if (input.contract.phase !== 'implementation') {
    throw new Error(`WORK_DIRECT_PRE_MUTATION_PHASE_INVALID: ${input.workId}:${input.contract.phase}`);
  }
  if (!input.contract.checkoutId) throw new Error(`WORK_REPOSITORY_MUTATION_CHECKOUT_REQUIRED: ${input.workId}`);

  const placement = resolveRepositoryWorkHandlePlacement({
    controllerHome: input.controllerHome,
    repositoryId: input.repository.repoId,
    checkoutId: input.contract.checkoutId,
    worktreeRef: input.contract.worktreeRef,
  });
  // A managed checkout has its own source lineage and does not participate in
  // shared-canonical target-base alignment.
  if (placement.managedWorktree) return input.handle;

  const targetBranch = input.handle.deliveryTargetBranch ?? placement.branch;
  const inspection = inspectDirectCanonicalPreMutationReconciliation({
    handle: input.handle,
    root: placement.checkout.canonicalRoot,
    targetBranch,
    status: placement.status,
    freshlyMaterialized: input.freshlyMaterialized,
  });
  if (inspection.reason === 'no_target_advance') return input.handle;
  if (!inspection.alignable || !inspection.targetHead) {
    throw new Error(`WORK_DIRECT_PRE_MUTATION_RECONCILIATION_BLOCKED: ${inspection.reason}`);
  }

  const aligned = transitionWorkHandle(input.controllerHome, input.handle, input.handle.state, {
    deliveryBaseCommit: inspection.targetHead,
    expectedHead: inspection.targetHead,
    failureReason: undefined,
  });
  appendWorkEvidence(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
    {
      title: 'direct canonical pre-mutation target base aligned',
      summary: `Before the first Work-owned repository mutation, canonical target ${targetBranch} advanced linearly ${inspection.previousDeliveryBase} -> ${inspection.targetHead} while the shared checkout remained clean. Forge advanced only deliveryBaseCommit/expectedHead; the Work remains prepared until the mutation surface proves that repository mutation actually started.`,
      detailLevel: 'summary',
    },
  );
  return aligned;
}

export function markRepositoryMutationStarted(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  expectedDeliveryBase?: string;
}): WorkHandleState | undefined {
  const store = { controllerHome: input.controllerHome, repoId: input.repository.repoId };
  const contract = getWorkContract(store, input.workId);
  if (contract?.workKind === 'local_effect' || contract?.workKind === 'remote_effect') {
    promoteWorkToRepositoryChange(store, input.workId);
  }
  const handle = readWorkHandle(input.controllerHome, input.repository.repoId, input.workId);
  if (!handle || handle.managedWorktree || handle.state !== 'prepared') return handle;
  const boundWorkId = handle.workContractId ?? handle.workId;
  if (boundWorkId !== input.workId) {
    throw new Error(`WORK_REPOSITORY_MUTATION_HANDLE_IDENTITY_MISMATCH: expected ${boundWorkId}, found ${input.workId}`);
  }
  const deliveryBase = handle.deliveryBaseCommit ?? handle.baseCommit;
  if (input.expectedDeliveryBase && deliveryBase !== input.expectedDeliveryBase) {
    throw new Error(`WORK_REPOSITORY_MUTATION_BASE_CHANGED: expected ${input.expectedDeliveryBase}, found ${deliveryBase ?? 'none'}`);
  }
  return transitionWorkHandle(input.controllerHome, handle, 'editing');
}

/**
 * Upgrades an effect-only Work before the first governed repository mutation
 * and materializes the existing repository delivery authority. Work is not a
 * controller mutex: authenticated caller identity is recorded only as provenance,
 * while checkout/head/CAS/resource fences own mutation safety.
 */
export function ensureRepositoryMutationWorkHandle(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  principalId: string;
  sessionId?: string;
  deferEffectPromotion?: boolean;
}): { handle: WorkHandleState; promotedFrom?: 'local_effect' | 'remote_effect' } {
  const store = { controllerHome: input.controllerHome, repoId: input.repository.repoId };
  let contract = getWorkContract(store, input.workId);
  if (!contract) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (isTerminalWorkContractStatus(contract.status) || contract.completionReceipt) {
    throw new Error(`WORK_REPOSITORY_MUTATION_TERMINAL: ${input.workId}`);
  }
  const principalId = input.principalId.trim();
  if (!principalId) throw new Error(`WORK_AUTHENTICATED_PRINCIPAL_REQUIRED: ${input.workId}`);
  const provenanceSessionId = input.sessionId?.trim() || `sessionless:${principalId}`;

  let mutationCheckoutId = contract.checkoutId;
  if (!mutationCheckoutId) {
    if (contract.worktreeRef?.trim()) {
      throw new Error(`WORK_REPOSITORY_MUTATION_CHECKOUT_REQUIRED: ${input.workId}`);
    }
    mutationCheckoutId = input.repository.activeCheckoutId;
    contract = updateWorkContract(store, input.workId, { checkoutId: mutationCheckoutId });
  }
  assertCanonicalRepositoryMutationWorkHandleAvailable({
    controllerHome: input.controllerHome,
    repositoryId: input.repository.repoId,
    checkoutId: mutationCheckoutId,
    workId: input.workId,
  });

  let promotedFrom: 'local_effect' | 'remote_effect' | undefined;
  if (contract.workKind === 'local_effect' || contract.workKind === 'remote_effect') {
    promotedFrom = contract.workKind;
    if (input.deferEffectPromotion !== true) {
      contract = promoteWorkToRepositoryChange(store, input.workId);
    }
  }
  if (contract.workKind !== 'repository_change' && input.deferEffectPromotion !== true) {
    throw new Error(`WORK_REPOSITORY_MUTATION_KIND_INVALID: ${input.workId}:${contract.workKind}`);
  }

  const existingHandle = readWorkHandle(input.controllerHome, input.repository.repoId, input.workId);
  let handle = ensureRepositoryWorkHandle({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    identity: { sessionId: provenanceSessionId, principalId },
    allowEffectWork: input.deferEffectPromotion === true,
  });
  if (!handle) throw new Error(`WORK_REPOSITORY_MUTATION_HANDLE_REQUIRED: ${input.workId}`);
  handle = alignRepositoryMutationBase({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    contract,
    handle,
    freshlyMaterialized: !existingHandle,
  });
  assertManagedRepositoryMutationAuthority({ repository: input.repository, handle });
  return { handle, ...(promotedFrom ? { promotedFrom } : {}) };
}

/**
 * Refreshes legacy WorkHandle principal/session fields as provenance only.
 * These fields do not grant or deny repository mutation authority; WorkHandle
 * CAS plus concrete checkout/resource fences preserve fail-closed concurrency.
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
