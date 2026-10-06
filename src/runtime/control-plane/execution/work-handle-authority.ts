import { resolve } from 'path';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { appendWorkEvidence, getWorkContract, recordWorkEvidenceState, semanticWorkState } from '../../../../packages/kernel/work/api/index';
import { currentPermissionSnapshotVersion } from './validation';
import { listWorkHandles, readWorkHandle, transitionWorkHandle, writeWorkHandle, type WorkHandleState } from './work-handle-store';
import { gitIsAncestor } from './work-execution-support';

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
      // Delivery receipts are mechanical evidence only; an explicitly open Work
      // continues to own its concrete mutation surface until semantic completion
      // or cancellation releases that authority.
      if (!contract) return false;
      return semanticWorkState(contract) === 'open';
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
 * Materialize concrete repository-mutation ownership for an optional semantic
 * Work attribution. Thin Work does not classify execution kind; checkout/CAS
 * placement and the WorkHandle resource fence own mutation safety.
 * Transport layers provide only the authenticated Controller identity.
 */
export function ensureRepositoryWorkHandle(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  identity: RepositoryWorkHandleControllerIdentity;
  checkoutId?: string;
  allowEffectWork?: boolean;
}): WorkHandleState | undefined {
  const existing = readWorkHandle(input.controllerHome, input.repository.repoId, input.workId);
  if (existing) {
    if (input.checkoutId?.trim() && existing.checkoutId !== input.checkoutId.trim()) {
      throw new Error(`WORK_HANDLE_PLACEMENT_CHECKOUT_MISMATCH: ${input.workId}`);
    }
    return existing;
  }
  const contract = getWorkContract(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
  );
  // allowEffectWork is retained only for source compatibility while old
  // repository callers cut over. workKind is no longer an execution authority.
  void input.allowEffectWork;
  const checkoutId = input.checkoutId?.trim() || contract?.checkoutId?.trim();
  if (!contract || !checkoutId) return undefined;
  // Callers may already be scoped to the Work checkout. Re-read the unselected
  // registry record so WorkHandle source/delivery authority never mistakes an
  // isolated execution worktree for the canonical source checkout. Legacy
  // WorkContract checkout/worktree fields remain migration-era placement hints;
  // new Thin Work receives its concrete checkout from the repository target.
  const placement = resolveRepositoryWorkHandlePlacement({
    controllerHome: input.controllerHome,
    repositoryId: input.repository.repoId,
    checkoutId,
    worktreeRef: contract.checkoutId === checkoutId ? contract.worktreeRef : undefined,
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
    checkoutId,
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
  if (!contract || !contract.checkoutId) return existing;
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

export function rearmFailedPreservedWorkHandle(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  contract: NonNullable<ReturnType<typeof getWorkContract>>;
  handle: WorkHandleState;
  principalId: string;
  sessionId: string;
}): WorkHandleState {
  const { handle } = input;
  if (!handle.managedWorktree || handle.state !== 'failed') return handle;
  const validationRecoverable = handle.finalization.validation === 'pending'
    || handle.finalization.validation === 'failed';
  if (!validationRecoverable
    || handle.finalization.commit !== 'pending'
    || handle.finalization.merge !== 'pending'
    || handle.finalization.branchCleanup !== 'pending'
    || handle.finalization.worktreeCleanup !== 'pending'
    || handle.cleanupReceipt
    || input.contract.completionReceipt
    || input.contract.completionOutcome) {
    return handle;
  }
  if (handle.principalId !== input.principalId) {
    throw new Error(`WORK_REPOSITORY_MUTATION_PRINCIPAL_MISMATCH: ${input.workId}`);
  }
  const placement = resolveRepositoryWorkHandlePlacement({
    controllerHome: input.controllerHome,
    repositoryId: input.repository.repoId,
    checkoutId: handle.checkoutId,
    worktreeRef: handle.worktreePath,
  });
  if (!placement.managedWorktree || placement.registeredCheckout.lifecycle !== 'active') {
    throw new Error(`WORK_REPOSITORY_MUTATION_FAILED_CHECKOUT_NOT_ACTIVE: ${input.workId}`);
  }
  if (resolve(placement.checkout.canonicalRoot) !== resolve(handle.worktreePath)
    || placement.branch !== handle.branch
    || (handle.expectedHead && placement.status.head !== handle.expectedHead)) {
    throw new Error(`WORK_REPOSITORY_MUTATION_FAILED_CHECKOUT_OWNERSHIP_MISMATCH: ${input.workId}`);
  }
  if (input.contract.evidenceState === 'valid') {
    recordWorkEvidenceState(
      { controllerHome: input.controllerHome, repoId: input.repository.repoId },
      input.workId,
      'stale',
    );
  }
  const next = writeWorkHandle(input.controllerHome, {
    ...handle,
    principalId: input.principalId,
    sessionId: input.sessionId,
    state: 'editing',
    validationRun: undefined,
    validatedInputFingerprint: undefined,
    failureReason: undefined,
    finalization: { ...handle.finalization, validation: 'pending' },
    updatedAt: new Date().toISOString(),
  });
  appendWorkEvidence(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
    {
      title: 'failed retained Work re-armed for same-Work mutation',
      summary: `Re-armed preserved managed checkout ${handle.checkoutId} after proving the Work remained open, commit/merge/cleanup had not started, and exact checkout/path/branch/HEAD ownership still matched.`,
      detailLevel: 'summary',
    },
  );
  return next;
}

function rearmRetainedMergedWorkForMutation(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  contract: NonNullable<ReturnType<typeof getWorkContract>>;
  handle: WorkHandleState;
}): WorkHandleState {
  const { handle } = input;
  if (!handle.managedWorktree || handle.state !== 'merged') return handle;
  const retained = handle.terminalResourceDisposition;
  if (retained?.mode !== 'retained_by_request' || retained.retainWorktree !== true || retained.retainBranch !== true) return handle;
  if (semanticWorkState(input.contract) !== 'open') throw new Error(`WORK_RETAINED_REARM_SEMANTIC_STATE_INVALID: ${input.workId}`);
  if (!handle.expectedHead?.trim()) throw new Error(`WORK_RETAINED_REARM_EXPECTED_HEAD_REQUIRED: ${input.workId}`);

  const placement = resolveRepositoryWorkHandlePlacement({
    controllerHome: input.controllerHome,
    repositoryId: input.repository.repoId,
    checkoutId: handle.checkoutId,
    worktreeRef: input.contract.worktreeRef,
  });
  if (!placement.managedWorktree || placement.registeredCheckout.lifecycle !== 'active') {
    throw new Error(`WORK_RETAINED_REARM_CHECKOUT_NOT_ACTIVE: ${input.workId}`);
  }
  if (resolve(placement.checkout.canonicalRoot) !== resolve(handle.worktreePath) || placement.branch !== handle.branch) {
    throw new Error(`WORK_RETAINED_REARM_OWNERSHIP_MISMATCH: ${input.workId}`);
  }
  if (!placement.status.clean) throw new Error(`WORK_RETAINED_REARM_WORKTREE_DIRTY: ${input.workId}`);
  if (placement.status.head !== handle.expectedHead) {
    throw new Error(`WORK_RETAINED_REARM_HEAD_CHANGED: expected ${handle.expectedHead}, found ${placement.status.head ?? 'missing'}`);
  }
  const sourceCheckout = selectRepositoryCheckout(
    placement.registeredRepository,
    handle.sourceCheckoutId ?? placement.registeredRepository.activeCheckoutId,
    { allowArchived: true },
  );
  const targetBranch = handle.deliveryTargetBranch?.trim();
  if (!targetBranch || !gitIsAncestor(sourceCheckout.canonicalRoot, handle.expectedHead, targetBranch)) {
    throw new Error(`WORK_RETAINED_REARM_TARGET_CONTAINMENT_REQUIRED: ${input.workId}`);
  }

  const evidenceState = input.contract.evidenceState === 'valid' || input.contract.evidenceState === 'stale' ? 'stale' : 'partial';
  if (input.contract.evidenceState !== evidenceState) recordWorkEvidenceState(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId }, input.workId, evidenceState,
  );
  const next = writeWorkHandle(input.controllerHome, {
    ...handle,
    state: 'editing',
    terminalResourceDisposition: undefined,
    validatedInputFingerprint: undefined,
    validationRun: undefined,
    cleanupReceipt: undefined,
    failureReason: undefined,
    finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
  });
  appendWorkEvidence(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
    {
      title: 'retained merged Work re-armed for same-Work mutation',
      summary: `Re-armed retained merged Work at ${handle.expectedHead} only after proving semantic Work remains open, retained branch/worktree ownership, clean exact checkout identity, and target containment on ${targetBranch}. Prior validation/delivery authority is stale; no new Work was created.`,
      detailLevel: 'summary',
    },
  );
  return next;
}

export function markRepositoryMutationStarted(input: {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  expectedDeliveryBase?: string;
}): WorkHandleState | undefined {
  const store = { controllerHome: input.controllerHome, repoId: input.repository.repoId };
  const contract = getWorkContract(store, input.workId);
  if (!contract) return undefined;
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
 * Materializes repository delivery authority for an optional semantic Work.
 * Work is not a controller mutex or an execution-kind gate: authenticated caller
 * identity is provenance while checkout/head/CAS/resource fences own mutation safety.
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
  const contract = getWorkContract(store, input.workId);
  if (!contract) throw new Error(`WORK_NOT_FOUND: ${input.workId}`);
  if (semanticWorkState(contract) !== 'open') {
    throw new Error(`WORK_REPOSITORY_MUTATION_TERMINAL: ${input.workId}`);
  }
  const principalId = input.principalId.trim();
  if (!principalId) throw new Error(`WORK_AUTHENTICATED_PRINCIPAL_REQUIRED: ${input.workId}`);
  const provenanceSessionId = input.sessionId?.trim() || `sessionless:${principalId}`;

  const mutationCheckoutId = contract.checkoutId?.trim() || input.repository.activeCheckoutId;
  if (!mutationCheckoutId) throw new Error(`WORK_REPOSITORY_MUTATION_CHECKOUT_REQUIRED: ${input.workId}`);
  assertCanonicalRepositoryMutationWorkHandleAvailable({
    controllerHome: input.controllerHome,
    repositoryId: input.repository.repoId,
    checkoutId: mutationCheckoutId,
    workId: input.workId,
  });

  // deferEffectPromotion is a compatibility input from the retired Work-kind
  // lifecycle. Repository mutation is now admitted by the concrete target fence.
  void input.deferEffectPromotion;

  let handle = ensureRepositoryWorkHandle({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    identity: { sessionId: provenanceSessionId, principalId },
    checkoutId: mutationCheckoutId,
    allowEffectWork: true,
  });
  if (!handle) throw new Error(`WORK_REPOSITORY_MUTATION_HANDLE_REQUIRED: ${input.workId}`);
  handle = rearmFailedPreservedWorkHandle({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    contract,
    handle,
    principalId,
    sessionId: provenanceSessionId,
  });
  handle = rearmRetainedMergedWorkForMutation({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    contract,
    handle,
  });
  assertManagedRepositoryMutationAuthority({ repository: input.repository, handle });
  return { handle };
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
