import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { resolve, sep } from 'path';
import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import { getRepository, repositoryCheckoutLifecycle, resolveRepositorySelection, selectRepositoryCheckout } from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { ensureManagedWorkspace } from '../../execution/managed-workspace';
import { listRecoverableProcessRecords } from '../../execution/process-runtime/store';
import { listActiveLeases } from '../../resources/leases/store';
import { proveWorkPreservationContained } from '../cleanup-artifact-retention';
import { readRepositoryAccessPolicy } from '../governance/access-policy';
import { activateWorkContract, failWorkContract, getWorkContract } from '../../../../packages/kernel/work/api/index';
import { admitPreparedRepositoryWorkContract, updateRepositoryWorkPlacement } from '../facade/repository-work-admission';
import { isTerminalSemanticWorkState } from '../facade/types';
import { updateExecutionSession, type ExecutionSessionContext } from './session-store';
import { currentPermissionSnapshotVersion, validateWorkHandle, workHandlePlacementLoss } from './validation';
import { withWorkPrepareRequest } from './work-prepare-request-store';
import { listWorkHandles, markWorkHandleFailed, newWorkId, readWorkHandle, relocateWorkHandlePlacementAtomically, writeWorkHandle, listWorkHandlesFailClosed, type WorkFinalizationStages, type WorkHandleState } from './work-handle-store';
import { createGoalDelegation } from '../governance/authorization';
import { compactHandle, contractFor, findWorkHandle, gitHead, gitIsAncestor, identityFor, requireSession } from './work-execution-support';

function requireExplicitRepoId(args: Record<string, unknown>): string {
  const value = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (!value) throw new Error('REPOSITORY_ID_REQUIRED: repository selection must be explicit for session binding');
  return value;
}

function selectedRepository(ctx: McpExecutionContext, session: ExecutionSessionContext, args: Record<string, unknown>, allowSession = true) {
  const requested = typeof args.repo_id === 'string' && args.repo_id.trim() ? args.repo_id.trim() : undefined;
  const selectedRepoId = requested ?? (allowSession ? session.activeRepositoryId : undefined);
  if (!selectedRepoId) throw new Error('SESSION_REPOSITORY_REQUIRED: bind a repository before using this work tool');
  if (session.activeRepositoryId && requested && session.activeRepositoryId !== requested) {
    throw new Error('SESSION_REPOSITORY_MISMATCH: call session_bind_repository before switching repositories');
  }
  return resolveRepositorySelection({ repoId: selectedRepoId, checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : session.activeCheckoutId, controllerHome: ctx.controllerHome, allowSoleRepository: false });
}

function initialStage(): WorkFinalizationStages {
  return { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' };
}



function boundedStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.map(String).slice(0, limit) : [];
}

function requestedWorkPrepareIsolation(args: Record<string, unknown>): 'reuse' | 'new_worktree' | 'auto' | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, 'isolation')) return undefined;
  return args.isolation === 'reuse' || args.isolation === 'new_worktree' || args.isolation === 'auto' ? args.isolation : 'auto';
}

function workPrepareFingerprint(input: {
  repoId: string;
  requestedCheckoutId?: string;
  isolation: 'reuse' | 'new_worktree' | 'auto';
  objective: string;
  goalId?: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  checks: string[];
  baseRef?: string;
  needsDependencies: boolean;
  workContractId?: string;
  expectedPreviousHead?: string;
  adoptCandidateHead?: string;
}): string {
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, operation: 'work_prepare', ...input })).digest('hex');
}

function invalidateActiveWork(ctx: McpExecutionContext, session: ExecutionSessionContext, reason: string): void {
  if (!session.activeRepositoryId || !session.activeWorkId) return;
  const handle = readWorkHandle(ctx.controllerHome, session.activeRepositoryId, session.activeWorkId);
  if (!handle || handle.state === 'cleaned') return;
  const contract = contractFor(ctx, handle);
  if (contract?.semanticState === 'completed') return;
  markWorkHandleFailed(ctx.controllerHome, handle, reason);
}

export function bindSessionRepository(ctx: McpExecutionContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = resolveRepositorySelection({ repoId: requireExplicitRepoId(args), checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined, controllerHome: ctx.controllerHome, allowSoleRepository: false });
  const permissionSnapshotVersion = currentPermissionSnapshotVersion(ctx.controllerHome, repository.repoId);
  const repositoryBinding = { repoId: repository.repoId, checkoutId: repository.activeCheckoutId, canonicalRoot: repository.canonicalRoot, branch: repository.checkouts.find((entry) => entry.checkoutId === repository.activeCheckoutId)?.branch ?? null };
  const switching = session.activeRepositoryId !== undefined && (session.activeRepositoryId !== repository.repoId || session.activeCheckoutId !== repository.activeCheckoutId);
  // Binding an unchanged target must preserve the active Work and session revision.
  if (!switching && session.activeRepositoryId === repository.repoId && session.activeCheckoutId === repository.activeCheckoutId && session.permissionSnapshotVersion === permissionSnapshotVersion) {
    return { session, repository: repositoryBinding, switched: false };
  }
  if (switching) invalidateActiveWork(ctx, session, 'explicit repository or checkout switch invalidated the previous active work handle');
  const next = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: repository.repoId,
    activeCheckoutId: repository.activeCheckoutId,
    activeWorkId: undefined,
    goalDelegation: undefined,
    permissionSnapshotVersion,
    lastValidatedAt: new Date().toISOString(),
  });
  return { session: next, repository: repositoryBinding, switched: switching };
}

function gitPathSet(root: string, args: string[], code: string): Set<string> {
  const result = spawnSync('git', ['-C', root, ...args, '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error(`${code}: ${result.error?.message ?? result.stderr?.trim() ?? `git ${args.join(' ')} failed`}`);
  return new Set(String(result.stdout ?? '').split('\0').map((value) => value.trim()).filter(Boolean));
}

function currentDirtyPaths(root: string): Set<string> {
  const paths = new Set<string>();
  for (const path of gitPathSet(root, ['diff', '--name-only'], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PATHS_UNAVAILABLE')) paths.add(path);
  for (const path of gitPathSet(root, ['diff', '--cached', '--name-only'], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PATHS_UNAVAILABLE')) paths.add(path);
  for (const path of gitPathSet(root, ['ls-files', '--others', '--exclude-standard'], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PATHS_UNAVAILABLE')) paths.add(path);
  return paths;
}

function verifyExplicitOverlappingDirtyProofs(
  root: string,
  currentHead: string,
  overlap: string[],
  rawProofs: unknown,
): void {
  // Adoption is metadata-only. An overlap is permitted only with a complete,
  // caller-reviewed byte fingerprint of the current source and HEAD index.
  // Neither the worktree nor the index is edited or temporarily stashed.
  if (!Array.isArray(rawProofs) || rawProofs.length !== overlap.length || overlap.length > 20) {
    throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PROOFS_REQUIRED: exactly one explicit content proof per overlapping path');
  }
  const proofs = new Map<string, { path: string; worktreeSha256: string; indexBlobOid: string }>();
  for (const input of rawProofs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PROOF_INVALID');
    }
    const record = input as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    const worktreeSha256 = typeof record.worktree_sha256 === 'string' ? record.worktree_sha256 : '';
    const indexBlobOid = typeof record.index_blob_oid === 'string' ? record.index_blob_oid : '';
    if (!overlap.includes(path) || proofs.has(path) || !/^[0-9a-f]{64}$/.test(worktreeSha256)
        || !/^[0-9a-f]{40}$/.test(indexBlobOid)) {
      throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PROOF_INVALID: ' + path);
    }
    proofs.set(path, { path, worktreeSha256, indexBlobOid });
  }
  for (const path of overlap) {
    const proof = proofs.get(path);
    if (!proof) throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PROOF_MISSING: ' + path);
    const original = resolve(root);
    const pathname = resolve(original, path);
    if (!pathname.startsWith(original + sep) || !lstatSync(pathname).isFile()
        || !realpathSync(pathname).startsWith(realpathSync(original) + sep)) {
      throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PROOF_PATH_INVALID: ' + path);
    }
    const object = (ref: string): string => {
      const run = spawnSync('git', ['-C', root, 'rev-parse', '--verify', ref], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      });
      if (run.status !== 0 || run.error) {
        throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PROOF_GIT_UNAVAILABLE: ' + path);
      }
      return String(run.stdout ?? '').trim();
    };
    // No staged overlap may be laundered into the new Work authority.
    const committedBlob = object(currentHead + ':' + path);
    const indexBlob = object(':' + path);
    const workingHash = createHash('sha256').update(readFileSync(pathname)).digest('hex');
    if (indexBlob !== committedBlob || indexBlob !== proof.indexBlobOid
        || workingHash !== proof.worktreeSha256) {
      throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_PROOF_DRIFT: ' + path);
    }
  }
}

interface RecoveryHeadProof {
  previousHead: string;
  candidateHead: string;
  candidateAlreadyIntegrated: boolean;
}

const LIVE_RECOVERY_HANDLE_STATES = new Set<WorkHandleState['state']>([
  'prepared', 'editing', 'validating', 'committed', 'merged',
]);

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function pathMaySharePhysicalRoot(left: string, right: string): boolean {
  try {
    if (!pathEntryExists(left) || !pathEntryExists(right)) return false;
    return realpathSync(left) === realpathSync(right);
  } catch {
    return true;
  }
}

function cleanupReceiptProvesNoUniqueSource(handle: WorkHandleState, canonicalRoot: string): boolean {
  const receipt = handle.cleanupReceipt;
  const cleanupVerified = handle.state === 'cleaned'
    && handle.managedWorktree
    && Boolean(receipt)
    && receipt!.workId === handle.workId
    && receipt!.repoId === handle.repositoryId
    && receipt!.checkoutId === handle.checkoutId
    && receipt!.branch === handle.branch
    && receipt!.worktree.path === handle.worktreePath
    && receipt!.terminalOutcome === 'completed_cleanup'
    && receipt!.complete
    && !receipt!.partial
    && receipt!.blockers.length === 0
    && receipt!.processes.allTerminal
    && receipt!.processes.blocking.length === 0
    && receipt!.ownership.controllerLease !== 'pending'
    && receipt!.ownership.processLeases === 'released'
    && ['removed', 'already_removed'].includes(receipt!.worktree.status)
    && ['deleted', 'already_deleted'].includes(receipt!.branchCleanup.status)
    && receipt!.branchCleanup.uniqueCommits === 0
    && ['removed', 'already_removed'].includes(receipt!.checkoutRegistry.status)
    && receipt!.prune.status === 'done'
    && receipt!.preservation.status === 'not_needed'
    && Boolean(handle.expectedHead);
  if (!cleanupVerified || !receipt) return false;
  const attestation = receipt.preservation.bundleRetirement;
  if (attestation) {
    return attestation.status === 'not_needed'
      && attestation.reason === 'no_source_delta'
      && attestation.protectedRevision === handle.expectedHead;
  }
  // A legacy zero-unique-commit cleanup already proved that deleting this
  // branch would discard no source-exclusive commits. The immutable recorded
  // head being reachable from the exact cleanup target ref proves containment
  // even after main advances: today's source/base trees need not match.
  // Do not accept a missing ref, an abbreviated/symbolic head, or an unrelated
  // target branch. All physical cleanup, lease, and zero-unique receipt checks
  // above must be satisfied before this Git proof is considered.
  if (exactGitCommit(canonicalRoot, handle.expectedHead!) === handle.expectedHead) {
    try {
      if (gitIsAncestor(canonicalRoot, handle.expectedHead!, `refs/heads/${receipt.targetBranch}`)) return true;
    } catch {
      // A corrupt or vanished target ref must not turn into proof of recovery.
    }
  }
  // Keep the old no-source-delta proof for legacy histories whose target ref
  // no longer exists but whose recorded source/base trees are still identical.
  const proof = proveWorkPreservationContained(canonicalRoot, handle, receipt.targetBranch, handle.expectedHead);
  return proof.contained && proof.reason === 'no_source_delta'
    && proof.protectedRevision === handle.expectedHead;
}

function exactGitCommit(root: string, revision: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${revision}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return undefined;
  return String(result.stdout ?? '').trim() || undefined;
}

function requireRecoveryHeadProof(
  root: string,
  expectedPreviousHead: string,
  adoptCandidateHead: string,
  recordedPreviousHead: string | undefined,
  requireIntegrated: boolean,
  sourceHandle: WorkHandleState,
): RecoveryHeadProof {
  if (!expectedPreviousHead || !adoptCandidateHead || recordedPreviousHead !== expectedPreviousHead) {
    throw new Error('WORK_HANDLE_RECOVERY_HEAD_PROOF_MISMATCH');
  }
  const previousHead = exactGitCommit(root, expectedPreviousHead);
  if (previousHead !== expectedPreviousHead) throw new Error('WORK_HANDLE_RECOVERY_PREVIOUS_HEAD_UNAVAILABLE');
  const candidateHead = exactGitCommit(root, adoptCandidateHead);
  if (candidateHead !== adoptCandidateHead) throw new Error('WORK_HANDLE_RECOVERY_CANDIDATE_HEAD_NOT_EXACT');
  if (!gitIsAncestor(root, previousHead, candidateHead)) throw new Error('WORK_HANDLE_RECOVERY_NON_LINEAR_HISTORY');
  const canonicalHead = gitHead(root);
  const candidateAlreadyIntegrated = Boolean(canonicalHead && gitIsAncestor(root, candidateHead, canonicalHead));
  if (requireIntegrated && !candidateAlreadyIntegrated) throw new Error('WORK_HANDLE_RECOVERY_CLEANED_SOURCE_NOT_INTEGRATED');
  if (candidateHead !== previousHead && !candidateAlreadyIntegrated) throw new Error('WORK_HANDLE_RECOVERY_CANDIDATE_NOT_LANDED');
  if (requireIntegrated) {
    const recordedRevisions = [sourceHandle.baseCommit, sourceHandle.deliveryBaseCommit, sourceHandle.expectedHead]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    if (recordedRevisions.some((revision) => !gitIsAncestor(root, revision, candidateHead))) {
      throw new Error('WORK_HANDLE_RECOVERY_SOURCE_REVISION_NOT_CONTAINED');
    }
  }
  return { previousHead, candidateHead, candidateAlreadyIntegrated };
}

function recordedRecoveryPreviousHead(args: Record<string, unknown>, sourceHandle: WorkHandleState): string {
  const recorded = sourceHandle.expectedHead?.trim() ?? '';
  const requested = typeof args.expected_previous_head === 'string' ? args.expected_previous_head.trim() : '';
  if (!recorded || (requested && requested !== recorded)) {
    throw new Error('WORK_HANDLE_RECOVERY_HEAD_PROOF_MISMATCH');
  }
  return recorded;
}

/**
 * The recorded Work head is the exact frozen baseline. When no landed candidate
 * is named, re-basing the replacement placement on that same revision is not an
 * inference: it is the revision the WorkHandle already owned.
 */
function recoveryCandidateHead(args: Record<string, unknown>, sourceHandle: WorkHandleState): string {
  return (typeof args.adopt_candidate_head === 'string' ? args.adopt_candidate_head.trim() : '')
    || sourceHandle.expectedHead?.trim()
    || '';
}

function materializeArchivedWorkPlacement(
  ctx: McpExecutionContext,
  args: Record<string, unknown>,
  repository: ReturnType<typeof selectedRepository>,
  sourceHandle: WorkHandleState,
  contract: NonNullable<ReturnType<typeof contractFor>>,
  workspaceRequestId: string,
  targetWorkHandleId: string,
): {
  workspace: ReturnType<typeof ensureManagedWorkspace>;
  contract: NonNullable<ReturnType<typeof contractFor>>;
  proof: RecoveryHeadProof;
  baseStatus: ReturnType<typeof repositoryGitStatus>;
  checkout: ReturnType<typeof selectRepositoryCheckout>;
} {
  const expectedPreviousHead = recordedRecoveryPreviousHead(args, sourceHandle);
  const adoptCandidateHead = recoveryCandidateHead(args, sourceHandle);
  if (!adoptCandidateHead) throw new Error('WORK_HANDLE_RECOVERY_CANDIDATE_HEAD_REQUIRED');
  const registered = getRepository(repository.repoId, ctx.controllerHome, { includeRemoved: true });
  if (repository.activeCheckoutId !== registered.activeCheckoutId || repository.canonicalRoot !== registered.canonicalRoot) {
    throw new Error('WORK_HANDLE_RECOVERY_CANONICAL_BASE_REQUIRED');
  }
  const baseStatus = repositoryGitStatus(repository);
  // Placement recovery creates a new worktree from exact commits. Unrelated
  // dirty files in the canonical checkout are preserved and are not a merge
  // gate; only an unresolvable base branch/revision blocks the recovery.
  if (!baseStatus.branch || !baseStatus.head) {
    throw new Error('WORK_HANDLE_RECOVERY_CANONICAL_BASE_UNRESOLVED');
  }
  if (!sourceHandle.managedWorktree || sourceHandle.repositoryId !== repository.repoId
    || (sourceHandle.workContractId && sourceHandle.workContractId !== contract.workId)) {
    throw new Error('WORK_HANDLE_RECOVERY_WORK_IDENTITY_MISMATCH');
  }
  // The managed source handle and cleanup receipt prove physical isolation.
  // A legacy semantic policy may be optional even when the actual execution
  // used a managed worktree; that policy is not evidence against recovery.
  if (contract.repoId !== repository.repoId || contract.workKind !== 'repository_change') {
    throw new Error('WORK_HANDLE_RECOVERY_CONTRACT_POLICY_MISMATCH');
  }
  // semanticState is the sole Work lifecycle authority. Completion evidence may
  // be recorded while an explicitly open Work still needs continued execution.
  if (contract.semanticState !== 'open') {
    throw new Error(`WORK_HANDLE_RECOVERY_WORK_NOT_OPEN: ${contract.workId}`);
  }
  if (sourceHandle.state === 'cleaned') {
    if (!cleanupReceiptProvesNoUniqueSource(sourceHandle, registered.canonicalRoot)) throw new Error('WORK_HANDLE_RECOVERY_CLEANUP_NOT_PROVEN');
  } else if (!['prepared', 'editing', 'failed'].includes(sourceHandle.state)) {
    // A lost placement can leave a mechanically failed handle behind. Its exact
    // recorded head and the still-open contract are the authority; the
    // replacement handle starts at `prepared`, so failure is never laundered
    // into success and no delivery/completion state is copied.
    throw new Error(`WORK_HANDLE_RECOVERY_SOURCE_STATE_INVALID: ${sourceHandle.state}`);
  }
  const oldCheckout = registered.checkouts.find((checkout) => checkout.checkoutId === sourceHandle.checkoutId);
  if (oldCheckout && repositoryCheckoutLifecycle(oldCheckout) === 'active') {
    throw new Error(`WORK_HANDLE_RECOVERY_SOURCE_CHECKOUT_STILL_ACTIVE: ${sourceHandle.checkoutId}`);
  }
  if (pathEntryExists(sourceHandle.worktreePath)) throw new Error('WORK_HANDLE_RECOVERY_SOURCE_PATH_PRESENT');
  const activeLeases = listActiveLeases(ctx.controllerHome, repository.repoId).filter((lease) =>
    lease.workId === sourceHandle.workId || lease.workId === contract.workId || lease.checkoutId === sourceHandle.checkoutId);
  if (activeLeases.length > 0) throw new Error('WORK_HANDLE_RECOVERY_ACTIVE_LEASE');
  const activeProcesses = listRecoverableProcessRecords(ctx.controllerHome, repository.repoId).filter((process) =>
    process.workId === sourceHandle.workId || process.workId === contract.workId);
  if (activeProcesses.length > 0) throw new Error('WORK_HANDLE_RECOVERY_ACTIVE_PROCESS');
  const proof = requireRecoveryHeadProof(
    repository.canonicalRoot,
    expectedPreviousHead,
    adoptCandidateHead,
    sourceHandle.expectedHead,
    sourceHandle.state === 'cleaned',
    sourceHandle,
  );
  const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
    requestId: workspaceRequestId,
    title: contract.objective,
    associatedWorkId: contract.workId,
    baseRef: proof.candidateHead,
    prepareDependencies: args.needs_dependencies === true,
  });
  const workspaceRoot = workspace.root;
  const workspaceCheckoutId = workspace.checkoutId;
  if (!workspace.managed || !workspaceRoot || !workspaceCheckoutId
    || workspaceCheckoutId === sourceHandle.checkoutId || workspaceCheckoutId === repository.activeCheckoutId) {
    throw new Error('WORK_HANDLE_RECOVERY_SUCCESSOR_CHECKOUT_INVALID');
  }
  if (workspaceRoot === sourceHandle.worktreePath || !existsSync(workspaceRoot) || gitHead(workspaceRoot) !== proof.candidateHead) {
    throw new Error('WORK_HANDLE_RECOVERY_SUCCESSOR_SOURCE_MISMATCH');
  }
  const refreshed = getRepository(repository.repoId, ctx.controllerHome);
  const checkoutRecord = refreshed.checkouts.find((checkout) => checkout.checkoutId === workspaceCheckoutId);
  if (!checkoutRecord || repositoryCheckoutLifecycle(checkoutRecord) !== 'active' || checkoutRecord.canonicalRoot !== workspaceRoot) {
    throw new Error('WORK_HANDLE_RECOVERY_SUCCESSOR_CHECKOUT_NOT_ACTIVE');
  }
  const checkout = selectRepositoryCheckout(refreshed, workspaceCheckoutId);
  if (checkout.activeCheckoutId !== workspaceCheckoutId || checkout.canonicalRoot !== workspaceRoot) {
    throw new Error('WORK_HANDLE_RECOVERY_SUCCESSOR_CHECKOUT_NOT_SELECTED');
  }
  const competing = listWorkHandlesFailClosed(ctx.controllerHome, repository.repoId).filter((handle) =>
    handle.workId !== sourceHandle.workId
    && handle.workId !== targetWorkHandleId
    && LIVE_RECOVERY_HANDLE_STATES.has(handle.state)
    && (handle.checkoutId === workspaceCheckoutId || pathMaySharePhysicalRoot(handle.worktreePath, workspaceRoot)));
  if (competing.length > 0) throw new Error(`WORK_HANDLE_RECOVERY_SUCCESSOR_ALREADY_OWNED: ${competing[0]?.workId ?? 'unknown'}`);
  // The cleaned WorkHandle and its receipt prove the actual managed source.
  // Keep one canonical WorkContract CAS writer, even for historical optional
  // semantic policies that predate their physical managed checkout.
  const alreadyRecovered = contract.checkoutId === workspaceCheckoutId
    && contract.worktreeRef === workspaceRoot && contract.worktreePolicy.required;
  if (!alreadyRecovered && (contract.checkoutId !== sourceHandle.checkoutId
    || (contract.worktreeRef && contract.worktreeRef !== sourceHandle.worktreePath))) {
    throw new Error('WORK_HANDLE_RECOVERY_SOURCE_PLACEMENT_MISMATCH');
  }
  const updatedContract = updateRepositoryWorkPlacement(
    { controllerHome: ctx.controllerHome, repoId: repository.repoId },
    contract.workId,
    {
      kind: 'rebind',
      expectedCheckoutId: contract.checkoutId,
      expectedWorktreeRef: contract.worktreeRef,
      checkoutId: workspaceCheckoutId,
      worktreeRef: workspaceRoot,
      baseRevision: proof.candidateHead,
      ...(!contract.worktreePolicy.required ? {
        worktreePolicy: { required: true, reason: 'Recovered proven managed WorkHandle placement' },
        constraints: { ...contract.constraints, workspaceMode: 'isolated' as const },
      } : {}),
    },
  );
  if (!updatedContract || updatedContract.checkoutId !== workspaceCheckoutId || updatedContract.worktreeRef !== workspaceRoot) {
    throw new Error('WORK_HANDLE_RECOVERY_CONTRACT_PLACEMENT_NOT_COMMITTED');
  }
  return { workspace, contract: updatedContract, proof, baseStatus, checkout };
}

function recoverLostWorkPlacement(
  ctx: McpExecutionContext,
  args: Record<string, unknown>,
  session: ExecutionSessionContext,
  repository: ReturnType<typeof selectedRepository>,
  sourceHandle: WorkHandleState,
): Record<string, unknown> {
  const expectedPreviousHead = recordedRecoveryPreviousHead(args, sourceHandle);
  const adoptCandidateHead = recoveryCandidateHead(args, sourceHandle);
  if (!adoptCandidateHead) throw new Error('WORK_HANDLE_RECOVERY_CANDIDATE_HEAD_REQUIRED');
  if (sourceHandle.checkoutId === repository.activeCheckoutId) throw new Error('WORK_HANDLE_RECOVERY_SOURCE_CHECKOUT_STILL_ACTIVE');
  const contract = contractFor(ctx, sourceHandle);
  if (!contract) throw new Error(`WORK_HANDLE_RECOVERY_CONTRACT_NOT_FOUND: ${sourceHandle.workContractId ?? sourceHandle.workId}`);
  if (contract.semanticState !== 'open') {
    throw new Error(`WORK_HANDLE_RECOVERY_WORK_NOT_OPEN: ${contract.workId}`);
  }
  const fingerprint = workPrepareFingerprint({
    repoId: repository.repoId,
    requestedCheckoutId: repository.activeCheckoutId,
    isolation: 'new_worktree',
    objective: contract.objective,
    goalId: sourceHandle.goalId ?? contract.workId,
    acceptanceCriteria: contract.acceptanceCriteria ?? [],
    allowedPaths: boundedStringArray(args.allowed_paths, 50),
    checks: contract.checks ?? [],
    baseRef: adoptCandidateHead,
    needsDependencies: args.needs_dependencies === true,
    workContractId: contract.workId,
    expectedPreviousHead,
    adoptCandidateHead,
  });
  // A deterministic request id makes the recovery retry-safe across tool
  // failures and process restarts without asking the caller to invent one.
  const requestId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : `recover-${fingerprint.slice(0, 32)}`;
  const policy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
  return withWorkPrepareRequest({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    sessionId: session.sessionId,
    principalId: session.principalId,
    requestId,
    fingerprint,
    proposedWorkId: newWorkId(),
  }, (request, requestReused) => {
    const existingSuccessor = readWorkHandle(ctx.controllerHome, repository.repoId, request.workId);
    if (existingSuccessor && !LIVE_RECOVERY_HANDLE_STATES.has(existingSuccessor.state)) {
      throw new Error(`WORK_HANDLE_RECOVERY_SUCCESSOR_NOT_ACTIVE: ${existingSuccessor.state}`);
    }
    const recovered = materializeArchivedWorkPlacement(
      ctx,
      args,
      repository,
      sourceHandle,
      contract,
      `work-rebind-${sourceHandle.workId}`,
      request.workId,
    );
    if (existingSuccessor && (
      existingSuccessor.workContractId !== contract.workId
      || existingSuccessor.checkoutId !== recovered.checkout.activeCheckoutId
      || existingSuccessor.worktreePath !== recovered.checkout.canonicalRoot
      || existingSuccessor.expectedHead !== recovered.proof.candidateHead
    )) throw new Error('WORK_HANDLE_RECOVERY_SUCCESSOR_IDENTITY_MISMATCH');
    const at = new Date().toISOString();
    const delegation = session.goalDelegation?.workId === request.workId
      ? session.goalDelegation
      : createGoalDelegation({
        sessionId: session.sessionId,
        repositoryId: repository.repoId,
        workId: request.workId,
        goalId: sourceHandle.goalId ?? contract.workId,
        allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
        deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
        permissionSnapshotVersion: policy.revision,
        source: 'gpt_risk_delegate',
      });
    const successor = existingSuccessor ?? writeWorkHandle(ctx.controllerHome, {
      schemaVersion: 1,
      workId: request.workId,
      sessionId: session.sessionId,
      principalId: session.principalId,
      repositoryId: repository.repoId,
      checkoutId: recovered.checkout.activeCheckoutId,
      worktreePath: recovered.checkout.canonicalRoot,
      branch: recovered.workspace.branch || recovered.baseStatus.branch!,
      sourceCheckoutId: repository.activeCheckoutId,
      deliveryTargetBranch: recovered.baseStatus.branch!,
      managedWorktree: true,
      baseCommit: sourceHandle.baseCommit ?? recovered.proof.previousHead,
      deliveryBaseCommit: recovered.proof.candidateAlreadyIntegrated
        ? recovered.proof.candidateHead
        : sourceHandle.deliveryBaseCommit ?? sourceHandle.baseCommit,
      expectedHead: recovered.proof.candidateHead,
      workContractId: contract.workId,
      goalId: sourceHandle.goalId,
      delegationVersion: delegation.version,
      permissionSnapshotVersion: policy.revision,
      state: 'prepared',
      createdAt: at,
      updatedAt: at,
      finalization: initialStage(),
      cleanupResponsibility: { owner: 'work_finalizer', registeredAt: at },
    });
    // Retire the source placement while preserving the canonical Work. Leaving
    // it live would keep a deleted checkout competing as a recovery owner.
    // Cleanup-complete handles keep their receipt and are never rewritten here.
    if (sourceHandle.state !== 'cleaned') {
      markWorkHandleFailed(ctx.controllerHome, sourceHandle, `placement_lost_rebound_to:${successor.workId}`);
    }
    const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
      activeRepositoryId: repository.repoId,
      activeCheckoutId: successor.checkoutId,
      activeWorkId: successor.workId,
      permissionSnapshotVersion: policy.revision,
      goalDelegation: delegation,
      lastValidatedAt: at,
    });
    return {
      session: nextSession,
      work: compactHandle(successor),
      reused: requestReused || Boolean(existingSuccessor),
      isolation: 'isolated',
      recoveredFromWorkId: sourceHandle.workId,
      adoptedSuccessor: { previousHead: recovered.proof.previousHead, currentHead: recovered.proof.candidateHead },
    };
  });

}

function adoptExplicitSuccessorHead(
  ctx: McpExecutionContext,
  args: Record<string, unknown>,
  repository: ReturnType<typeof selectedRepository>,
  existing: WorkHandleState,
): WorkHandleState | undefined {
  const expectedPreviousHead = typeof args.expected_previous_head === 'string' ? args.expected_previous_head.trim() : '';
  const adoptCandidateHead = typeof args.adopt_candidate_head === 'string' ? args.adopt_candidate_head.trim() : '';
  const requestedDeliveryBase = typeof args.base_ref === 'string' ? args.base_ref.trim() : '';
  if (!expectedPreviousHead && !adoptCandidateHead) {
    if (requestedDeliveryBase) throw new Error('WORK_HANDLE_REBASE_ADOPTION_PAIR_REQUIRED');
    return undefined;
  }
  if (!expectedPreviousHead || !adoptCandidateHead) {
    throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_PAIR_REQUIRED: expected_previous_head and adopt_candidate_head must be supplied together');
  }
  // Exact retry is read-only after the original CAS settlement, never a
  // second candidate adoption or new checkout authority.
  if (requestedDeliveryBase && existing.expectedHead === adoptCandidateHead
      && existing.deliveryBaseCommit === requestedDeliveryBase
      && gitHead(existing.worktreePath) === adoptCandidateHead) return existing;
  // A failed validation attempt may need an explicit, audited successor
  // adoption before it can retry against the current checkout. Keep its
  // failed state: only a fresh valid check may restore execution authority.
  const retryableValidationFailure = existing.state === 'failed'
    && existing.finalization.validation === 'failed';
  if (existing.state !== 'prepared' && existing.state !== 'editing' && !retryableValidationFailure) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_STATE_INVALID: ${existing.state}`);
  }
  if (existing.expectedHead !== expectedPreviousHead) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_PREVIOUS_HEAD_MISMATCH: expected ${existing.expectedHead ?? 'missing'}, received ${expectedPreviousHead}`);
  }
  if (existing.repositoryId !== repository.repoId || existing.checkoutId !== repository.activeCheckoutId) {
    throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_CHECKOUT_MISMATCH');
  }
  const root = existing.worktreePath;
  const currentHead = gitHead(root);
  if (!currentHead || currentHead !== adoptCandidateHead) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_CURRENT_HEAD_MISMATCH: expected ${adoptCandidateHead}, found ${currentHead ?? 'missing'}`);
  }
  if (!gitIsAncestor(root, expectedPreviousHead, adoptCandidateHead)) {
    throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_NONLINEAR: ${expectedPreviousHead} is not an ancestor of ${adoptCandidateHead}`);
  }
  const changedPaths = gitPathSet(root, ['diff', '--name-only', `${expectedPreviousHead}..${adoptCandidateHead}`], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIFF_UNAVAILABLE');
  const dirtyPaths = currentDirtyPaths(root);
  if (existing.managedWorktree) {
    if (dirtyPaths.size > 0) {
      throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_MANAGED_DIRTY: ${[...dirtyPaths].sort().slice(0, 20).join(',')}`);
    }
    const blockingProcesses = listRecoverableProcessRecords(ctx.controllerHome, existing.repositoryId)
      .filter((record) => record.workId === existing.workId)
      .map((record) => record.processId)
      .sort();
    if (blockingProcesses.length > 0) {
      throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_ACTIVE_PROCESS: ${blockingProcesses.slice(0, 20).join(',')}`);
    }
  } else {
    const overlap = [...changedPaths].filter((path) => dirtyPaths.has(path)).sort();
    if (overlap.length > 0) {
      if (args.dirty_overlap_proofs === undefined) {
        throw new Error(`WORK_HANDLE_SUCCESSOR_ADOPTION_DIRTY_OVERLAP: ${overlap.slice(0, 20).join(',')}`);
      }
      verifyExplicitOverlappingDirtyProofs(root, adoptCandidateHead, overlap, args.dirty_overlap_proofs);
    }
  }
  // Rebase is an explicit source-Work baseline decision, separate from
  // candidate HEAD adoption. The target must still be the clean, exact
  // registered delivery checkout and contain every previously owned revision.
  if (requestedDeliveryBase) {
    if (!/^[0-9a-f]{40}$/.test(requestedDeliveryBase) || !existing.managedWorktree
        || !existing.sourceCheckoutId || existing.checkoutId === existing.sourceCheckoutId) {
      throw new Error('WORK_HANDLE_REBASE_MANAGED_SOURCE_REQUIRED');
    }
    const registered = getRepository(existing.repositoryId, ctx.controllerHome);
    const target = selectRepositoryCheckout(registered, existing.sourceCheckoutId);
    const observedTarget = repositoryGitStatus(target);
    if (!observedTarget.clean || observedTarget.head !== requestedDeliveryBase
        || observedTarget.branch !== (existing.deliveryTargetBranch ?? registered.defaultBranch)) {
      throw new Error('WORK_HANDLE_REBASE_TARGET_HEAD_CHANGED');
    }
    if (!gitIsAncestor(root, expectedPreviousHead, requestedDeliveryBase)
        || !gitIsAncestor(root, requestedDeliveryBase, adoptCandidateHead)) {
      throw new Error('WORK_HANDLE_REBASE_UNINTEGRATED_HISTORY');
    }
  }
  const candidate: WorkHandleState = {
    ...existing,
    // Existing non-rebase adoption preserves the original delivery base;
    // an explicit verified rebase advances only the delivery base, not the
    // Work start commit or the semantic Work's durable identity.
    ...(requestedDeliveryBase ? { deliveryBaseCommit: requestedDeliveryBase } : {}),
    expectedHead: adoptCandidateHead,
    validationRun: undefined,
    validatedInputFingerprint: undefined,
    finalization: initialStage(),
    failureReason: undefined,
  };
  validateWorkHandle(ctx.controllerHome, candidate, identityFor(ctx, args), 'cheap', 'inspect');
  // Revalidate proof immediately before this metadata-only transition in case
  // another local writer changed the overlapping source while validating.
  if (gitHead(root) !== adoptCandidateHead) {
    throw new Error('WORK_HANDLE_SUCCESSOR_ADOPTION_CURRENT_HEAD_CHANGED');
  }
  if (!existing.managedWorktree && args.dirty_overlap_proofs !== undefined) {
    const refreshedDirty = currentDirtyPaths(root);
    const overlap = [...gitPathSet(root, ['diff', '--name-only', `${expectedPreviousHead}..${adoptCandidateHead}`], 'WORK_HANDLE_SUCCESSOR_ADOPTION_DIFF_UNAVAILABLE')]
      .filter((path) => refreshedDirty.has(path)).sort();
    verifyExplicitOverlappingDirtyProofs(root, adoptCandidateHead, overlap, args.dirty_overlap_proofs);
  }
  return writeWorkHandle(ctx.controllerHome, candidate);
}

function relocateExistingWorkToManagedCheckout(
  ctx: McpExecutionContext,
  args: Record<string, unknown>,
  session: ExecutionSessionContext,
  repository: ReturnType<typeof selectedRepository>,
  existing: WorkHandleState,
): Record<string, unknown> {
  // Existing Work already owns an exact frozen HEAD. Ordinary relocation
  // reuses that fact, rather than asking the model to repeat it three times.
  // A candidate different from that HEAD remains an explicit, audited adoption.
  const recordedHead = existing.expectedHead?.trim() ?? '';
  const prior = (typeof args.expected_previous_head === 'string' ? args.expected_previous_head.trim() : '') || recordedHead;
  const candidate = (typeof args.adopt_candidate_head === 'string' ? args.adopt_candidate_head.trim() : '') || prior;
  const baseRef = (typeof args.base_ref === 'string' ? args.base_ref.trim() : '') || candidate;
  if (!prior || !candidate || baseRef !== candidate || !/^[0-9a-f]{40}$/.test(candidate)) {
    throw new Error('WORK_RELOCATION_EXACT_HEADS_REQUIRED: requested HEADs must be exact and internally consistent');
  }
  if (!args.adopt_candidate_head && gitHead(existing.worktreePath) !== candidate) {
    throw new Error('WORK_RELOCATION_SOURCE_HEAD_CHANGED: recorded HEAD no longer matches the source');
  }
  if (existing.principalId !== session.principalId) throw new Error('WORK_HANDLE_ACCESS_DENIED');
  if (existing.expectedHead !== prior && !(existing.managedWorktree && existing.expectedHead === candidate)) {
    throw new Error('WORK_RELOCATION_PREVIOUS_HEAD_MISMATCH');
  }
  if (existing.managedWorktree) {
    if (existing.expectedHead !== candidate) throw new Error('WORK_RELOCATION_ALREADY_ISOLATED');
    validateWorkHandle(ctx.controllerHome, existing, identityFor(ctx, args), 'cheap', 'inspect');
    updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
      activeRepositoryId: existing.repositoryId, activeCheckoutId: existing.checkoutId,
      activeWorkId: existing.workId, permissionSnapshotVersion: existing.permissionSnapshotVersion,
    });
    return { session: requireSession(ctx, args), work: compactHandle(existing), reused: true, relocated: true };
  }
  if (existing.state !== 'prepared' && existing.state !== 'editing') throw new Error('WORK_RELOCATION_STATE_INVALID');
  if (existing.finalization.validation !== 'pending' || existing.finalization.commit !== 'pending' || existing.finalization.merge !== 'pending'
      || existing.finalization.worktreeCleanup !== 'pending' || existing.finalization.branchCleanup !== 'pending'
      || existing.cleanupReceipt || existing.validatedInputFingerprint || existing.validationRun) {
    throw new Error('WORK_RELOCATION_FINALIZATION_IN_PROGRESS');
  }
  const contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: existing.repositoryId }, existing.workId);
  if (!contract || contract.semanticState !== 'open' || contract.checkoutId !== existing.checkoutId) {
    throw new Error('WORK_RELOCATION_CONTRACT_MISMATCH');
  }
  if (existing.checkoutId !== repository.activeCheckoutId || existing.worktreePath !== repository.canonicalRoot
      || existing.branch !== repositoryGitStatus(repository).branch) throw new Error('WORK_RELOCATION_SOURCE_MISMATCH');
  if (!gitIsAncestor(existing.worktreePath, prior, candidate)) throw new Error('WORK_RELOCATION_NONLINEAR');
  const changedPaths = gitPathSet(existing.worktreePath, ['diff', '--name-only', prior + '..' + candidate], 'WORK_RELOCATION_DIFF_UNAVAILABLE');
  const dirtyPaths = currentDirtyPaths(existing.worktreePath);
  const overlap = [...changedPaths].filter((path) => dirtyPaths.has(path));
  if (overlap.length) throw new Error('WORK_RELOCATION_DIRTY_OVERLAP: ' + overlap.sort().join(','));
  if (listRecoverableProcessRecords(ctx.controllerHome, existing.repositoryId).some((record) => record.workId === existing.workId)) {
    throw new Error('WORK_RELOCATION_ACTIVE_PROCESS');
  }
  // Existing Work id plus frozen HEAD already provides a stable relocation
  // identity. No caller-generated request id is necessary for this transition.
  // A deterministic request identity makes physical worktree creation safe to
  // resume after a process crash before the authoritative database transaction.
  const workspace = ensureManagedWorkspace(ctx.controllerHome, repository, {
    requestId: 'relocate:' + existing.workId + ':' + candidate,
    title: 'Relocate existing Work to managed checkout',
    associatedWorkId: existing.workId,
    baseRef: candidate,
    prepareDependencies: false,
  });
  if (!workspace.managed || !workspace.checkoutId || !workspace.root || !workspace.branch) {
    throw new Error('WORK_RELOCATION_TARGET_NOT_MANAGED');
  }
  const selectedTarget = resolveRepositorySelection({
    repoId: existing.repositoryId, checkoutId: workspace.checkoutId,
    controllerHome: ctx.controllerHome, allowSoleRepository: false,
  });
  const targetStatus = repositoryGitStatus(selectedTarget);
  if (!targetStatus.clean || targetStatus.head !== candidate || targetStatus.branch !== workspace.branch
      || workspace.checkoutId === existing.checkoutId || selectedTarget.canonicalRoot !== workspace.root) {
    throw new Error('WORK_RELOCATION_TARGET_CHANGED');
  }
  const refreshed = relocateWorkHandlePlacementAtomically(ctx.controllerHome, existing, {
    checkoutId: workspace.checkoutId, root: workspace.root,
    branch: workspace.branch, head: candidate,
  });
  updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
    activeRepositoryId: refreshed.repositoryId, activeCheckoutId: refreshed.checkoutId,
    activeWorkId: refreshed.workId, permissionSnapshotVersion: refreshed.permissionSnapshotVersion,
  });
  return { session: requireSession(ctx, args), work: compactHandle(refreshed), relocated: true,
    previousCheckoutId: existing.checkoutId, previousHead: prior, currentHead: candidate };
}

export function prepareWork(ctx: McpExecutionContext, args: Record<string, unknown>): Record<string, unknown> {
  const session = requireSession(ctx, args);
  const repository = selectedRepository(ctx, session, args, true);
  // Prepare only after all applicable validation; each successful branch binds
  // its final Work/checkout directly, without a provisional session write.
  const existingId = typeof args.work_id === 'string' ? args.work_id.trim() : '';
  if (args.relocate_to_new_worktree === true && !existingId) throw new Error('WORK_RELOCATION_EXISTING_WORK_ID_REQUIRED');
  const requestedIsolation = requestedWorkPrepareIsolation(args);
  if (existingId) {
    const existing = readWorkHandle(ctx.controllerHome, repository.repoId, existingId)
      ?? findWorkHandle(ctx, session, { ...args, work_id: existingId, repo_id: repository.repoId });
    if (existing.principalId !== session.principalId) throw new Error('WORK_HANDLE_ACCESS_DENIED');
    if (existing.state === 'cleaned') {
      const semanticContract = contractFor(ctx, existing);
      if (semanticContract && isTerminalSemanticWorkState(semanticContract.semanticState)) {
        return { session: requireSession(ctx, args), work: compactHandle(existing), reused: true, terminal: true, workContractStatus: semanticContract.semanticState };
      }
      if (requestedIsolation !== undefined) throw new Error('WORK_RELOCATION_ISOLATION_CONFLICT');
      return recoverLostWorkPlacement(ctx, args, session, repository, existing);
    }
    // The recorded checkout is placement. When it is gone, the still-open
    // canonical Work can re-establish an exact managed placement instead of
    // being permanently vetoed by a deleted execution location.
    const placementLoss = workHandlePlacementLoss(repository, existing);
    if (placementLoss) {
      const semanticContract = contractFor(ctx, existing);
      if (semanticContract && isTerminalSemanticWorkState(semanticContract.semanticState)) {
        return { session: requireSession(ctx, args), work: compactHandle(existing), reused: true, terminal: true, workContractStatus: semanticContract.semanticState };
      }
      if (requestedIsolation === 'reuse') throw new Error('WORK_RELOCATION_ISOLATION_CONFLICT');
      return recoverLostWorkPlacement(ctx, args, session, repository, existing);
    }
    if (args.relocate_to_new_worktree === true) {
      // Explicit new_worktree agrees with relocation; other isolation values
      // select the current checkout. Exact HEAD and writer fences stay intact.
      if (requestedIsolation !== undefined && requestedIsolation !== 'new_worktree') {
        throw new Error('WORK_RELOCATION_ISOLATION_CONFLICT');
      }
      return relocateExistingWorkToManagedCheckout(ctx, args, session, repository, existing);
    }
    if (requestedIsolation !== undefined) {
      // Fixed placement contract: only `new_worktree` requests an isolated
      // managed checkout. `reuse` and `auto` both share the selected current
      // checkout, so an existing placement conflicts only across that boundary.
      const requestedWorkspaceMode = requestedIsolation === 'new_worktree' ? 'isolated' : 'current';
      const existingWorkspaceMode = existing.managedWorktree ? 'isolated' : 'current';
      if (requestedWorkspaceMode !== existingWorkspaceMode) {
        throw new Error(`WORK_PREPARE_PLACEMENT_CONFLICT: ${existingId}; existing=${existingWorkspaceMode}; requested=${requestedWorkspaceMode}`);
      }
    }
    const adopted = adoptExplicitSuccessorHead(ctx, args, repository, existing);
    const active = adopted ?? existing;
    if (!adopted) validateWorkHandle(ctx.controllerHome, active, identityFor(ctx, args), 'cheap', 'inspect');
    // Skip redundant Session update when already bound to the exact same Work/permission.
    const unchanged = session.activeRepositoryId === active.repositoryId
      && session.activeCheckoutId === active.checkoutId
      && session.activeWorkId === active.workId
      && session.permissionSnapshotVersion === active.permissionSnapshotVersion;
    const boundSession = unchanged ? session : updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
      activeRepositoryId: active.repositoryId, activeCheckoutId: active.checkoutId,
      activeWorkId: active.workId, permissionSnapshotVersion: active.permissionSnapshotVersion,
    });
    return {
      session: boundSession,
      work: compactHandle(active),
      reused: true,
      ...(adopted ? { adoptedSuccessor: { previousHead: existing.expectedHead, currentHead: adopted.expectedHead } } : {}),
    };
  }

  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new Error('WORK_PREPARE_REQUEST_ID_REQUIRED: new work preparation requires request_id');
  const isolation = requestedWorkPrepareIsolation(args) ?? 'auto';
  const objective = String(args.objective ?? 'Controller-managed repository work').trim().slice(0, 2_000);
  const goalId = typeof args.goal_id === 'string' && args.goal_id.trim() ? args.goal_id.trim() : undefined;
  const acceptanceCriteria = boundedStringArray(args.acceptance_criteria, 20);
  const allowedPaths = boundedStringArray(args.allowed_paths, 50);
  const checks = boundedStringArray(args.checks, 30);
  const baseRef = typeof args.base_ref === 'string' && args.base_ref.trim() ? args.base_ref.trim() : undefined;
  const requestedCheckoutId = typeof args.checkout_id === 'string' && args.checkout_id.trim() ? args.checkout_id.trim() : undefined;
  const needsDependencies = args.needs_dependencies === true;
  const baseCheckoutId = repository.activeCheckoutId;
  const baseStatus = repositoryGitStatus(repository);
  const deliveryTargetBranch = baseStatus.branch;
  if (!deliveryTargetBranch) throw new Error(`WORK_DELIVERY_TARGET_DETACHED: source checkout ${baseCheckoutId} has no branch`);
  // Fixed placement contract: `auto` (the default) and `reuse` share the
  // selected current checkout; only an explicit `new_worktree` freezes a fresh
  // isolated base. A dirty current checkout is normal development state, not a
  // placement gate: record the exact pre-Work dirty baseline on the handle so
  // delivery/cleanup can attribute bytes later instead of failing closed.
  const useWorktree = isolation === 'new_worktree';
  let baselineDirtyPaths: string[] | undefined;
  let baselineDirtyPathCount: number | undefined;
  if (!useWorktree && !baseStatus.clean) {
    const dirty = [...currentDirtyPaths(repository.canonicalRoot)].sort();
    baselineDirtyPathCount = dirty.length;
    baselineDirtyPaths = dirty.slice(0, 2_000);
  }
  const policy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
  const fingerprint = workPrepareFingerprint({
    repoId: repository.repoId,
    requestedCheckoutId,
    isolation,
    objective,
    goalId,
    acceptanceCriteria,
    allowedPaths,
    checks,
    baseRef,
    needsDependencies,
  });

  return withWorkPrepareRequest({
    controllerHome: ctx.controllerHome,
    repoId: repository.repoId,
    sessionId: session.sessionId,
    principalId: session.principalId,
    requestId,
    fingerprint,
    proposedWorkId: newWorkId(),
  }, (request, requestReused) => {
    const createdWorkId = request.workId;
    const existingHandle = readWorkHandle(ctx.controllerHome, repository.repoId, createdWorkId);
    if (existingHandle) {
      const existingContract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
      if (!existingContract) throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} has a Work handle without its WorkContract`);
      const terminal = isTerminalSemanticWorkState(existingContract.semanticState);
      if (terminal) {
        return {
          session: requireSession(ctx, args),
          work: compactHandle(existingHandle),
          reused: true,
          terminal: true,
          workContractStatus: existingContract.semanticState,
        };
      }
      if (existingContract.semanticState === 'open') {
        activateWorkContract(
          { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          createdWorkId,
          { phase: 'implementation', summary: 'Prepared Work resumed on the existing WorkHandle.', worktreeRef: existingHandle.worktreePath },
        );
      }
      // A replay already bound to this Work reuses its original delegation.
      const delegation = session.goalDelegation?.workId === createdWorkId
        && session.goalDelegation.permissionSnapshotVersion === policy.revision
        ? session.goalDelegation : createGoalDelegation({
        sessionId: session.sessionId,
        repositoryId: repository.repoId,
        workId: createdWorkId,
        goalId,
        allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
        deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
        permissionSnapshotVersion: policy.revision,
        source: 'gpt_risk_delegate',
      });
      const unchanged = session.activeRepositoryId === repository.repoId
        && session.activeCheckoutId === existingHandle.checkoutId
        && session.activeWorkId === createdWorkId
        && session.permissionSnapshotVersion === policy.revision
        && session.goalDelegation === delegation;
      const nextSession = unchanged ? session : updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), {
        activeRepositoryId: repository.repoId, activeCheckoutId: existingHandle.checkoutId,
        activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision,
        goalDelegation: delegation, lastValidatedAt: new Date().toISOString(),
      });
      return { session: nextSession, work: compactHandle(existingHandle), reused: true, isolation: existingHandle.managedWorktree ? 'isolated' : 'current' };
    }

    let contract = getWorkContract({ controllerHome: ctx.controllerHome, repoId: repository.repoId }, createdWorkId);
    if (contract?.requestId && contract.requestId !== requestId) throw new Error(`WORK_PREPARE_REQUEST_INDEX_CORRUPT: ${requestId}`);
    if (request.status === 'prepared') {
      throw new Error(`WORK_PREPARE_RESULT_LOST: ${requestId} completed without a readable Work handle`);
    }
    if (contract && (contract.semanticState === 'completed' || contract.semanticState === 'cancelled')) {
      throw new Error(`WORK_PREPARE_REQUEST_TERMINAL: ${requestId} belongs to ${contract.semanticState} Work ${createdWorkId}`);
    }
    if (!contract) {
      contract = admitPreparedRepositoryWorkContract(
        { controllerHome: ctx.controllerHome, repoId: repository.repoId },
        {
          workId: createdWorkId,
          repoId: repository.repoId,
          objective,
          acceptanceCriteria,
          allowedPaths,
          checks,
          accessMode: policy.mode,
          isolated: useWorktree,
          requestedBy: 'chatgpt',
          requestId,
        },
      );
    }
    const delegation = createGoalDelegation({
      sessionId: session.sessionId,
      repositoryId: repository.repoId,
      workId: createdWorkId,
      goalId,
      allowedRiskClasses: ['readonly', 'local_repo_write', 'workspace_write', 'local_command', 'dependency_change', 'local_git'],
      deniedRiskClasses: ['remote_write', 'destructive', 'secret_access', 'outside_repository'],
      permissionSnapshotVersion: policy.revision,
      source: 'gpt_risk_delegate',
    });
    try {
      const workspace = useWorktree
        ? ensureManagedWorkspace(ctx.controllerHome, repository, {
          requestId: createdWorkId,
          title: objective,
          associatedWorkId: createdWorkId,
          baseRef,
          prepareDependencies: needsDependencies,
        })
        : { mode: 'current' as const, checkoutId: baseCheckoutId, root: repository.canonicalRoot, branch: baseStatus.branch ?? 'detached', baseRevision: baseStatus.head ?? undefined, managed: false };
      if (workspace.managed) {
        if (!workspace.checkoutId || !workspace.root) throw new Error('MANAGED_WORKSPACE_NOT_MATERIALIZED');
        const materialized = updateRepositoryWorkPlacement(
          { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          contract.workId,
          {
            kind: 'materialize',
            expectedCheckoutId: contract.checkoutId,
            expectedWorktreeRef: contract.worktreeRef,
            checkoutId: workspace.checkoutId,
            worktreeRef: workspace.root,
            baseRevision: workspace.baseRevision ?? contract.baseRevision,
          },
        );
        if (!materialized) throw new Error(`WORK_PLACEMENT_MATERIALIZATION_LOST: ${contract.workId}`);
        contract = materialized;
      } else {
        // Direct reuse must also record its one physical checkout in the same
        // WorkContract authority. Otherwise identity-preserving relocation
        // later sees a handle/contract mismatch and rejects a valid Work.
        contract = updateRepositoryWorkPlacement(
          { controllerHome: ctx.controllerHome, repoId: repository.repoId },
          contract.workId,
          {
            kind: 'bind_current',
            expectedCheckoutId: contract.checkoutId,
            expectedWorktreeRef: contract.worktreeRef,
            checkoutId: baseCheckoutId,
            baseRevision: workspace.baseRevision ?? contract.baseRevision,
            worktreePolicy: { ...contract.worktreePolicy, required: false },
            constraints: { ...contract.constraints, workspaceMode: 'current' },
          },
        );
      }
      const refreshed = getRepository(repository.repoId, ctx.controllerHome);
      const checkout = selectRepositoryCheckout(refreshed, workspace.checkoutId);
      if (workspace.managed && (
        contract.checkoutId !== checkout.activeCheckoutId
        || contract.worktreeRef !== checkout.canonicalRoot
      )) {
        throw new Error(`WORK_PLACEMENT_IDENTITY_DRIFT: contract=${contract.checkoutId ?? 'missing'}:${contract.worktreeRef ?? 'missing'}; checkout=${checkout.activeCheckoutId}:${checkout.canonicalRoot}`);
      }
      const branch = workspace.branch || repositoryGitStatus(checkout).branch;
      if (!branch) throw new Error('WORKTREE_DETACHED: selected worktree has no branch');
      const head = gitHead(checkout.canonicalRoot);
      const handle: WorkHandleState = {
        schemaVersion: 1, workId: createdWorkId, sessionId: session.sessionId, principalId: session.principalId,
        repositoryId: repository.repoId, checkoutId: checkout.activeCheckoutId, worktreePath: checkout.canonicalRoot, branch,
        sourceCheckoutId: baseCheckoutId, deliveryTargetBranch, managedWorktree: workspace.managed, workContractId: contract.workId, goalId, delegationVersion: delegation.version,
        baseCommit: workspace.baseRevision ?? head, deliveryBaseCommit: workspace.baseRevision ?? head, expectedHead: head, permissionSnapshotVersion: policy.revision,
        ...(baselineDirtyPaths ? { baselineDirtyPaths, baselineDirtyPathCount } : {}),
        state: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalization: initialStage(),
        cleanupResponsibility: { owner: 'work_finalizer', registeredAt: new Date().toISOString() },
      };
      writeWorkHandle(ctx.controllerHome, handle);
      activateWorkContract(
        { controllerHome: ctx.controllerHome, repoId: repository.repoId },
        contract.workId,
        { phase: 'implementation', summary: 'Repository Work preparation completed and execution ownership is active.', worktreeRef: checkout.canonicalRoot },
      );
      const nextSession = updateExecutionSession(ctx.controllerHome, identityFor(ctx, args), { activeRepositoryId: repository.repoId, activeCheckoutId: checkout.activeCheckoutId, activeWorkId: createdWorkId, permissionSnapshotVersion: policy.revision, goalDelegation: delegation, lastValidatedAt: new Date().toISOString() });
      return { session: nextSession, work: compactHandle(handle), reused: requestReused, isolation: workspace.mode };
    } catch (error) {
      failWorkContract(
        { controllerHome: ctx.controllerHome, repoId: repository.repoId },
        contract.workId,
        { phase: 'implementation', summary: `Repository Work preparation failed: ${error instanceof Error ? error.message : String(error)}` },
      );
      throw error;
    }
  });
}
