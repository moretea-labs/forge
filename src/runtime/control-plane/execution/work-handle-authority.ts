import { spawnSync } from 'child_process';
import { realpathSync } from 'fs';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getRepository, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { appendWorkEvidence, getWorkContract, promoteWorkToRepositoryChange, recordWorkEvidenceState, semanticWorkState } from '../../../../packages/kernel/work/api/index';
import { currentPermissionSnapshotVersion } from './validation';
import { listActiveLeases } from '../../resources/leases/store';
import { listRecoverableProcessRecords } from '../../execution/process-runtime/store';
import { listWorkHandlesFailClosed, readWorkHandle, transitionWorkHandle, writeWorkHandle, type WorkHandleState } from './work-handle-store';
import { gitIsAncestor } from './work-execution-support';

export interface RepositoryWorkHandleControllerIdentity {
  sessionId: string;
  principalId: string;
}

const DURABLE_CANONICAL_MUTATION_OWNER_STATES = new Set<WorkHandleState['state']>([
  'editing',
  'validating',
  'committed',
  'failed_terminal_cleanup',
  'failed',
]);

/** All WorkHandle checkout comparisons use physical identity, not path spelling. */
function samePhysicalCheckout(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    throw new Error('WORK_CHECKOUT_PHYSICAL_IDENTITY_UNAVAILABLE');
  }
}
export interface CanonicalMutationTargetEvidence {
  checkoutId: string;
  branch?: string;
  head?: string;
  root: string;
  clean: boolean;
  activeLeaseWorkIds?: ReadonlySet<string>;
  recoverableProcessWorkIds?: ReadonlySet<string>;
}

/**
 * Decide whether one WorkHandle still owns the physical mutation surface of a
 * canonical checkout. Semantic Work may remain open after its repository delta
 * has already been absorbed; semantic openness alone is not a checkout mutex.
 *
 * Semantic openness and the WorkHandle `prepared` state do not by themselves
 * own a physical mutation surface. Only distinct source revisions, active
 * leases/processes, or ambiguous physical checkout evidence retain ownership.
 */
export function workHandleRetainsCanonicalMutationOwnership(input: {
  controllerHome: string;
  repositoryId: string;
  handle: WorkHandleState;
  target: CanonicalMutationTargetEvidence;
}): boolean {
  const { handle, target } = input;
  if (handle.checkoutId !== target.checkoutId || handle.managedWorktree) return false;

  let contract: ReturnType<typeof getWorkContract>;
  try {
    contract = getWorkContract(
      { controllerHome: input.controllerHome, repoId: input.repositoryId },
      handle.workContractId ?? handle.workId,
    );
  } catch {
    return true;
  }
  if (contract && semanticWorkState(contract) !== 'open') return false;

  let sameCheckout: boolean;
  try {
    sameCheckout = samePhysicalCheckout(handle.worktreePath, target.root);
  } catch {
    return true;
  }
  if (!sameCheckout
    || !target.branch
    || handle.branch !== target.branch
    || !target.clean
    || !target.head
    || !handle.expectedHead?.trim()) {
    return true;
  }

  const activeLeaseWorkIds = input.target.activeLeaseWorkIds
    ?? new Set(listActiveLeases(input.controllerHome, input.repositoryId).map((lease) => lease.workId));
  if (activeLeaseWorkIds.has(handle.workId)) return true;

  const recoverableProcessWorkIds = input.target.recoverableProcessWorkIds
    ?? new Set(listRecoverableProcessRecords(input.controllerHome, input.repositoryId)
      .map((record) => record.workId)
      .filter((value): value is string => Boolean(value)));
  if (recoverableProcessWorkIds.has(handle.workId)) return true;

  const revisions = [...new Set([
    handle.expectedHead,
    handle.deliveryBaseCommit,
    handle.baseCommit,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  if (!revisions.length) return true;

  const uncontainedRevisions = revisions.filter((revision) => !gitIsAncestor(target.root, revision, target.head!));
  if (uncontainedRevisions.length === 0) return false;

  // An archive ref that merely contains a source revision does not prove that
  // the canonical target contains it. Keep the fence while any recorded source
  // revision is outside the exact target HEAD, even if the WorkContract is gone.
  return true;
}

/**
 * Fences repository mutations across Process/Lease lifetimes using the existing
 * durable WorkHandle authority. Process leases prevent overlapping execution;
 * semantic Work is advisory context and does not retain an already-absorbed
 * canonical mutation surface forever.
 */
export function assertCanonicalRepositoryMutationWorkHandleAvailable(input: {
  controllerHome: string;
  repositoryId: string;
  checkoutId: string;
  workId?: string;
}): void {
  const repository = getRepository(input.repositoryId, input.controllerHome, { includeRemoved: true });
  const target = selectRepositoryCheckout(repository, input.checkoutId, { allowArchived: true });
  const targetStatus = repositoryGitStatus(target);
  const activeLeaseWorkIds = new Set(
    listActiveLeases(input.controllerHome, input.repositoryId)
      .map((lease) => lease.workId)
      .filter((value): value is string => Boolean(value)),
  );
  const recoverableProcessWorkIds = new Set(
    listRecoverableProcessRecords(input.controllerHome, input.repositoryId)
      .map((record) => record.workId)
      .filter((value): value is string => Boolean(value)),
  );
  const targetEvidence: CanonicalMutationTargetEvidence = {
    checkoutId: input.checkoutId,
    branch: targetStatus.branch ?? undefined,
    head: targetStatus.head ?? undefined,
    root: target.canonicalRoot,
    clean: targetStatus.clean,
    activeLeaseWorkIds,
    recoverableProcessWorkIds,
  };

  const scannedHandles = listWorkHandlesFailClosed(input.controllerHome, input.repositoryId);
  const owners = scannedHandles
    .filter((handle) => handle.workId !== input.workId
      && DURABLE_CANONICAL_MUTATION_OWNER_STATES.has(handle.state)
      && workHandleRetainsCanonicalMutationOwnership({
        controllerHome: input.controllerHome,
        repositoryId: input.repositoryId,
        handle,
        target: targetEvidence,
      }))
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
    && samePhysicalCheckout(input.worktreeRef!, checkout.canonicalRoot)
    && input.checkoutId !== registeredRepository.activeCheckoutId
    && !samePhysicalCheckout(checkout.canonicalRoot, registeredRepository.canonicalRoot);
  return { registeredRepository, registeredCheckout, checkout, status, branch, managedWorktree };
}

/**
 * Resolve the active physical WorkHandle for a given Work ID, which may be either
 * a semantic Work Contract ID or a physical WorkHandle ID. When a semantic ID is
 * provided and no direct WorkHandle match exists, scan for the active physical
 * Handle that references this semantic Work via workContractId.
 *
 * After Work recovery/succession, the semantic Work Contract may be bound to a new
 * physical WorkHandle with a different checkout. Only the unique active successor
 * matching the canonical WorkContract.checkoutId is selected; fail closed on conflict.
 */
export function resolveActiveWorkHandle(
  controllerHome: string,
  repositoryId: string,
  workId: string,
  purpose: 'execution' | 'preparation' = 'execution',
): WorkHandleState | undefined {
  const direct = readWorkHandle(controllerHome, repositoryId, workId);
  const contract = getWorkContract({ controllerHome, repoId: repositoryId }, workId);

  // Without a semantic Contract this is an exact physical Handle lookup.
  // Historical inspection remains available separately from mutation attribution.
  if (!contract) return direct;

  const canonicalCheckoutId = contract.checkoutId?.trim();
  if (!canonicalCheckoutId) {
    // Legacy Contract without explicit checkout: exact physical lookup only
    return direct;
  }

  const ACTIVE_STATES = new Set<WorkHandleState['state']>(['prepared', 'editing', 'validating', 'committed', 'merged']);
  // Even a live direct Handle must compete with any successor on the same
  // checkout. An early return would silently admit two physical Writers.
  const scannedHandles = listWorkHandlesFailClosed(controllerHome, repositoryId);
  const candidates = scannedHandles
    .filter((handle) =>
      (handle.workId === workId || handle.workContractId === workId)
      && handle.checkoutId === canonicalCheckoutId
      && (ACTIVE_STATES.has(handle.state)
        // Only an exact failed physical Handle of an open Work can resume editing.
        // A failed successor cannot revive a cleaned historical semantic ID.
        || (handle.workId === workId && handle.state === 'failed' && semanticWorkState(contract) === 'open'))
    );
  // Exact lookup may find a Handle outside a bounded scan. Count it once,
  // without making the historical direct identity authoritative over a peer.
  if (direct && direct.checkoutId === canonicalCheckoutId && ACTIVE_STATES.has(direct.state)
      && !candidates.some((candidate) => candidate.workId === direct.workId)) {
    candidates.push(direct);
  }

  if (candidates.length === 0) {
    // Preparation owns terminal inspection and lost-placement recovery. Only
    // after ruling out a live successor may it examine the exact old Handle.
    if (purpose === 'preparation') return direct;
    // A recorded historical Handle is not fresh placement authority.
    if (direct && direct.checkoutId !== canonicalCheckoutId) {
      throw new Error(`WORK_HANDLE_PLACEMENT_CHECKOUT_MISMATCH: ${workId}`);
    }
    if (direct) throw new Error(`WORK_HANDLE_NOT_ACTIVE: ${workId}`);
    return undefined;
  }

  if (candidates.length === 1) return candidates[0];

  // Multiple active handles: fail-closed
  throw new Error(
    `WORK_HANDLE_AMBIGUOUS: semantic Work ${workId} has multiple active physical handles on checkout ${canonicalCheckoutId}: ${candidates.map((h) => h.workId).join(', ')}`,
  );
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
}): WorkHandleState | undefined {
  const existing = resolveActiveWorkHandle(input.controllerHome, input.repository.repoId, input.workId);
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
  const existing = resolveActiveWorkHandle(input.controllerHome, input.repositoryId, input.workId);
  if (!existing || existing.managedWorktree) return existing;
  const contract = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repositoryId }, input.workId);
  if (!contract || !contract.checkoutId) return existing;
  if (contract.checkoutId !== existing.checkoutId) throw new Error(`WORK_HANDLE_PLACEMENT_CHECKOUT_MISMATCH: ${input.workId}`);
  const placement = resolveRepositoryWorkHandlePlacement({ controllerHome: input.controllerHome, repositoryId: input.repositoryId, checkoutId: contract.checkoutId, worktreeRef: contract.worktreeRef });
  if (!placement.managedWorktree) return existing;
  if (placement.registeredCheckout.lifecycle !== 'active') throw new Error(`WORK_HANDLE_PLACEMENT_CHECKOUT_NOT_ACTIVE: ${input.workId}`);
  if (!samePhysicalCheckout(existing.worktreePath, placement.checkout.canonicalRoot)) throw new Error(`WORK_HANDLE_PLACEMENT_PATH_MISMATCH: ${input.workId}`);
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
  if (!samePhysicalCheckout(placement.checkout.canonicalRoot, handle.worktreePath)
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
  if (!samePhysicalCheckout(placement.checkout.canonicalRoot, handle.worktreePath) || placement.branch !== handle.branch) {
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
  const handle = resolveActiveWorkHandle(input.controllerHome, input.repository.repoId, input.workId);
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
}): { handle: WorkHandleState; promotedFrom?: 'investigation' | 'local_effect' | 'remote_effect' } {
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


  let handle = ensureRepositoryWorkHandle({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    identity: { sessionId: provenanceSessionId, principalId },
    checkoutId: mutationCheckoutId,
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
  // This is the first point at which concrete repository mutation has passed
  // the exact WorkHandle checkout, ownership, and managed-worktree fences.
  // WorkContract remains the sole writer for its semantic classification.
  const promotedFrom = contract.workKind === 'investigation'
    || contract.workKind === 'local_effect'
    || contract.workKind === 'remote_effect'
    ? contract.workKind
    : undefined;
  // Already-classified repository work must not reenter the Work-store write lock
  // for every file edit / command. Promotion is a one-time semantic transition.
  if (promotedFrom) promoteWorkToRepositoryChange(store, input.workId);
  return promotedFrom ? { handle, promotedFrom } : { handle };
}
