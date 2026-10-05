import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import {
  getWorkContract,
  isRepositoryCompletionReceipt,
  semanticWorkState,
  type CompletionMaintenanceWarning,
  type RepositoryCompletionReceipt,
} from '../../../../packages/kernel/work/api/index';
import {
  getRepository,
  repositoryCheckoutLifecycle,
  selectRepositoryCheckout,
} from '../../../cli/repositories/registry';
import { repositoryGitStatus } from '../../../cli/repositories/structured-git';
import { listActiveLeases } from '../../resources/leases/store';
import { assertRuntimeMayWriteOrThrow, isRuntimeWriteFenceError } from '../../root/write-fence';
import { cleanupTerminalWork } from './work-terminal-cleanup';
import { recordWorkDeliveryReceipt } from './work-completion-authority';
import {
  listWorkHandles,
  readWorkHandle,
  resolveWorkDeliveryTargetBranch,
  transitionWorkHandle,
  type WorkCleanupReceipt,
  type WorkHandleState,
} from './work-handle-store';
import { hasCurrentWorkValidationAuthority } from './work-validation-reconciler';
import { workspaceValidationFingerprint, workValidationInputFingerprint } from './verification-evidence';
import { selectDefaultWorkValidationChecks } from './work-operation-service';
import { changedPaths } from './work-revision-diff';
import { compactHandle, identityFor, makeBoundedWorkResult, requireSession, workForSession } from './work-execution-support';
import { validateWorkHandle } from './validation';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(root: string, args: string[], timeout = 30_000): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

function exactRevision(root: string, revision: string | undefined, label: string): string {
  const value = revision?.trim();
  if (!value) throw new Error(`WORK_DELIVERY_${label}_MISSING`);
  const result = git(root, ['rev-parse', `${value}^{commit}`]);
  if (!result.ok || !result.stdout) throw new Error(`WORK_DELIVERY_${label}_UNPROVEN: ${value}`);
  return result.stdout;
}

function commonGitDir(root: string): string | undefined {
  const result = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return result.ok && result.stdout ? result.stdout : undefined;
}

function deterministicReceiptId(input: {
  workId: string;
  targetBranch: string;
  targetRevision: string;
  sourceRevision: string;
}): string {
  return `repository-delivery:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function deliveryTargetCheckout(
  repository: ReturnType<typeof getRepository>,
  handle: WorkHandleState,
  explicitTargetBranch?: string,
) {
  const sourceCheckoutId = handle.sourceCheckoutId?.trim();
  if (sourceCheckoutId) {
    const candidates = repository.checkouts.filter((checkout) =>
      checkout.checkoutId === sourceCheckoutId
      && repositoryCheckoutLifecycle(checkout) === 'active');
    if (candidates.length !== 1) {
      throw new Error(`WORK_DELIVERY_TARGET_CHECKOUT_UNPROVEN: ${sourceCheckoutId}`);
    }
    const target = selectRepositoryCheckout(repository, sourceCheckoutId);
    const targetStatus = repositoryGitStatus(target);
    const targetBranch = resolveWorkDeliveryTargetBranch(
      handle,
      targetStatus.branch ?? repository.defaultBranch,
      explicitTargetBranch,
    );
    if (!targetStatus.clean) throw new Error(`WORK_DELIVERY_TARGET_DIRTY: ${target.activeCheckoutId}`);
    if (targetStatus.branch !== targetBranch) {
      throw new Error(`WORK_DELIVERY_TARGET_BRANCH_MISMATCH: expected ${targetBranch}, found ${targetStatus.branch ?? 'detached'}`);
    }
    return { target, targetStatus, targetBranch };
  }

  const targetBranch = resolveWorkDeliveryTargetBranch(handle, repository.defaultBranch, explicitTargetBranch);
  const candidates = repository.checkouts.filter((checkout) =>
    checkout.checkoutId !== handle.checkoutId
    && repositoryCheckoutLifecycle(checkout) === 'active'
    && checkout.branch === targetBranch);
  if (candidates.length !== 1) {
    throw new Error(`WORK_DELIVERY_TARGET_CHECKOUT_UNPROVEN: expected one active checkout for ${targetBranch}, found ${candidates.length}`);
  }
  const target = selectRepositoryCheckout(repository, candidates[0]!.checkoutId);
  const targetStatus = repositoryGitStatus(target);
  if (!targetStatus.clean) throw new Error(`WORK_DELIVERY_TARGET_DIRTY: ${target.activeCheckoutId}`);
  if (targetStatus.branch !== targetBranch) {
    throw new Error(`WORK_DELIVERY_TARGET_BRANCH_MISMATCH: expected ${targetBranch}, found ${targetStatus.branch ?? 'detached'}`);
  }
  return { target, targetStatus, targetBranch };
}

function workHandleHasTerminalSemanticAuthority(
  controllerHome: string,
  repositoryId: string,
  workId: string,
): boolean {
  try {
    const contract = getWorkContract({ controllerHome, repoId: repositoryId }, workId);
    if (!contract) return false;
    const state = semanticWorkState(contract);
    return state === 'completed' || state === 'cancelled';
  } catch {
    return false;
  }
}

function assertTargetMutationAvailable(
  controllerHome: string,
  handle: WorkHandleState,
  targetCheckoutId: string,
  targetBranch: string,
  expectedTargetHead: string,
  targetRoot: string,
): void {
  const blockingLease = listActiveLeases(controllerHome, handle.repositoryId)
    .find((lease) => lease.checkoutId === targetCheckoutId && lease.workId !== handle.workId);
  if (blockingLease) {
    throw new Error(`WORK_DELIVERY_TARGET_LEASE_ACTIVE: ${blockingLease.leaseId}`);
  }
  const blockingWork = listWorkHandles(controllerHome, handle.repositoryId)
    .find((other) => other.workId !== handle.workId
      && other.checkoutId === targetCheckoutId
      && other.state !== 'cleaned'
      && other.state !== 'failed'
      && !workHandleHasTerminalSemanticAuthority(controllerHome, handle.repositoryId, other.workId));
  if (blockingWork) {
    throw new Error(`WORK_DELIVERY_TARGET_WORK_ACTIVE: ${blockingWork.workId}`);
  }
  const currentBranch = git(targetRoot, ['branch', '--show-current']);
  if (!currentBranch.ok || currentBranch.stdout !== targetBranch) {
    throw new Error(`WORK_DELIVERY_TARGET_BRANCH_MISMATCH: expected ${targetBranch}, found ${currentBranch.stdout || 'detached'}`);
  }
  const status = git(targetRoot, ['status', '--porcelain=v1']);
  if (!status.ok || status.stdout) throw new Error('WORK_DELIVERY_TARGET_DIRTY');
  const currentHead = exactRevision(targetRoot, 'HEAD', 'TARGET_HEAD');
  if (currentHead !== expectedTargetHead) {
    throw new Error(`WORK_DELIVERY_TARGET_HEAD_CHANGED: expected ${expectedTargetHead}, found ${currentHead}`);
  }
}

function cleanupWarnings(receipt: WorkCleanupReceipt, recordedAt: string): CompletionMaintenanceWarning[] {
  const warnings: CompletionMaintenanceWarning[] = [];
  if (receipt.worktree.status === 'failed') {
    warnings.push({
      code: 'worktree_cleanup_failed',
      message: receipt.worktree.reason ?? 'Managed Work worktree cleanup failed.',
      resourceKind: 'worktree',
      resourceId: receipt.worktree.path,
      recordedAt,
    });
  } else if (receipt.worktree.status === 'retained') {
    warnings.push({
      code: 'cleanup_retained_by_request',
      message: receipt.worktree.reason ?? 'Managed Work worktree was retained.',
      resourceKind: 'worktree',
      resourceId: receipt.worktree.path,
      recordedAt,
    });
  }
  if (receipt.branchCleanup.status === 'failed') {
    warnings.push({
      code: 'branch_cleanup_failed',
      message: receipt.branchCleanup.reason ?? 'Managed Work branch cleanup failed.',
      resourceKind: 'branch',
      resourceId: receipt.branchCleanup.branch,
      recordedAt,
    });
  } else if (receipt.branchCleanup.status === 'retained' || receipt.branchCleanup.status === 'archived') {
    warnings.push({
      code: 'cleanup_retained_by_request',
      message: receipt.branchCleanup.reason ?? `Managed Work branch was ${receipt.branchCleanup.status}.`,
      resourceKind: 'branch',
      resourceId: receipt.branchCleanup.branch,
      recordedAt,
    });
  }
  return warnings;
}

function cleanupEvidence(receipt: WorkCleanupReceipt, recordedAt: string): RepositoryCompletionReceipt['cleanup'] {
  const warnings = cleanupWarnings(receipt, recordedAt);
  if (receipt.complete && receipt.blockers.length === 0) {
    return { status: warnings.length > 0 ? 'maintenance_warning' : 'complete', warnings, blockers: [], recordedAt };
  }
  if (receipt.blockers.length > 0) {
    return {
      status: 'blocked',
      warnings,
      blockers: receipt.blockers.map((message) => ({
        code: 'unknown_resource_ownership' as const,
        message,
        resourceKind: 'workspace' as const,
        resourceId: receipt.workId,
        recordedAt,
      })),
      recordedAt,
    };
  }
  if (warnings.length === 0) {
    warnings.push({
      code: 'cleanup_retained_by_request',
      message: 'Work cleanup is incomplete without a blocking ownership failure.',
      resourceKind: 'workspace',
      resourceId: receipt.workId,
      recordedAt,
    });
  }
  return { status: 'maintenance_warning', warnings, blockers: [], recordedAt };
}

function recordDelivery(
  ctx: McpExecutionContext,
  handle: WorkHandleState,
  targetRoot: string,
  targetBranch: string,
  targetRevision: string,
  sourceRevision: string,
  strategy: RepositoryCompletionReceipt['delivery']['strategy'],
  cleanupReceipt: WorkCleanupReceipt,
): RepositoryCompletionReceipt {
  const baseRevision = handle.deliveryBaseCommit ?? handle.baseCommit;
  const paths = baseRevision ? changedPaths(targetRoot, baseRevision, sourceRevision) : [];
  const recordedAt = new Date().toISOString();
  const receipt: RepositoryCompletionReceipt = {
    schemaVersion: 1,
    receiptId: deterministicReceiptId({ workId: handle.workId, targetBranch, targetRevision, sourceRevision }),
    source: 'controller_work',
    issueId: 'work',
    taskId: handle.workId,
    workId: handle.workId,
    targetBranch,
    targetRevision,
    sourceRevision,
    ...(baseRevision ? { baseRevision } : {}),
    changedPaths: paths,
    delivery: {
      kind: paths.length > 0 ? 'commit' : 'no_change',
      status: 'integrated',
      strategy,
      reachable: true,
      recordedAt,
    },
    cleanup: cleanupEvidence(cleanupReceipt, recordedAt),
    verifiedAt: recordedAt,
    recordedAt,
  };
  recordWorkDeliveryReceipt(
    { controllerHome: ctx.controllerHome, repoId: handle.repositoryId },
    handle.workContractId ?? handle.workId,
    receipt,
    paths.length > 0 ? 'completed_changed' : 'completed_no_change',
    'repository_change',
  );
  return receipt;
}

async function reconcileDeliveredWork(
  ctx: McpExecutionContext,
  session: ReturnType<typeof requireSession>,
  handle: WorkHandleState,
  targetBranch: string,
  targetRoot: string,
  sourceRevision: string,
): Promise<Record<string, unknown>> {
  const targetRevision = exactRevision(targetRoot, targetBranch, 'TARGET_HEAD');
  if (!git(targetRoot, ['merge-base', '--is-ancestor', sourceRevision, targetRevision]).ok) {
    throw new Error(`WORK_DELIVERY_TARGET_REVISION_UNREACHABLE: ${sourceRevision}`);
  }
  const cleanup = await cleanupTerminalWork({
    controllerHome: ctx.controllerHome,
    handle,
    targetBranch,
    deleteBranch: true,
    terminalOutcome: 'completed_cleanup',
  });
  const refreshed = readWorkHandle(ctx.controllerHome, handle.repositoryId, handle.workId) ?? handle;
  const contract = getWorkContract(
    { controllerHome: ctx.controllerHome, repoId: handle.repositoryId },
    handle.workContractId ?? handle.workId,
  );
  const prior = contract?.completionReceipt;
  const strategy = prior && isRepositoryCompletionReceipt(prior)
    ? prior.delivery.strategy
    : 'already_integrated';
  const receipt = recordDelivery(
    ctx,
    handle,
    targetRoot,
    targetBranch,
    targetRevision,
    sourceRevision,
    strategy,
    cleanup.receipt,
  );
  return makeBoundedWorkResult(ctx, session, handle.repositoryId, handle.workId, 'finalization', {
    work: compactHandle(refreshed),
    delivery: receipt,
    cleanup: cleanup.receipt,
    recoveredAfterDelivery: true,
    semanticCompletionRequired: true,
  });
}

export async function deliverWork(ctx: McpExecutionContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    assertRuntimeMayWriteOrThrow('integrate_worktree', ctx.controllerHome);
  } catch (error) {
    if (isRuntimeWriteFenceError(error)) throw error;
    // Test and legacy controller homes can be intentionally unbound to a packaged Runtime.
  }

  const session = requireSession(ctx, args);
  let handle = workForSession(ctx, session, args, { reconcileValidation: false });
  const contract = getWorkContract(
    { controllerHome: ctx.controllerHome, repoId: handle.repositoryId },
    handle.workContractId ?? handle.workId,
  );
  if (!contract) throw new Error(`WORK_CONTRACT_MISSING: ${handle.workContractId ?? handle.workId}`);
  if (semanticWorkState(contract) !== 'open') {
    throw new Error(`WORK_DELIVERY_SEMANTIC_WORK_NOT_OPEN: ${semanticWorkState(contract)}`);
  }
  if (contract.workKind !== 'repository_change') {
    throw new Error(`WORK_DELIVERY_WORK_KIND_INVALID: ${contract.workKind}`);
  }

  const repository = getRepository(handle.repositoryId, ctx.controllerHome, { includeRemoved: true });
  const explicitTargetBranch = typeof args.target_branch === 'string' ? args.target_branch.trim() || undefined : undefined;
  const { target, targetStatus, targetBranch } = deliveryTargetCheckout(repository, handle, explicitTargetBranch);
  const targetRoot = target.canonicalRoot;
  const targetHead = exactRevision(targetRoot, targetStatus.head ?? 'HEAD', 'TARGET_HEAD');

  if (
    (handle.state === 'merged' || handle.state === 'failed_terminal_cleanup' || handle.state === 'cleaned')
    && handle.expectedHead
  ) {
    return reconcileDeliveredWork(
      ctx,
      session,
      handle,
      targetBranch,
      targetRoot,
      exactRevision(targetRoot, handle.expectedHead, 'SOURCE_REVISION'),
    );
  }

  const validated = validateWorkHandle(ctx.controllerHome, handle, identityFor(ctx, args), 'full', 'deliver');
  const sourceStatus = repositoryGitStatus(validated.worktreeRepository);
  if (!sourceStatus.clean) throw new Error(`WORK_DELIVERY_SOURCE_DIRTY: ${handle.checkoutId}`);
  if (sourceStatus.branch !== handle.branch) {
    throw new Error(`WORK_DELIVERY_SOURCE_BRANCH_MISMATCH: expected ${handle.branch}, found ${sourceStatus.branch ?? 'detached'}`);
  }
  const sourceRevision = exactRevision(
    validated.worktreeRepository.canonicalRoot,
    sourceStatus.head ?? 'HEAD',
    'SOURCE_REVISION',
  );
  const workspaceFingerprint = workspaceValidationFingerprint(validated.worktreeRepository.canonicalRoot, sourceStatus);
  const validationBaseRevision = handle.deliveryBaseCommit ?? handle.baseCommit;
  const validationChangedPaths = validationBaseRevision
    ? changedPaths(validated.worktreeRepository.canonicalRoot, validationBaseRevision, sourceRevision)
    : [];
  const expectedValidationChecks = selectDefaultWorkValidationChecks(contract, validationChangedPaths);
  const expectedValidationFingerprint = workValidationInputFingerprint(
    sourceRevision,
    workspaceFingerprint,
    expectedValidationChecks,
  );
  if (!hasCurrentWorkValidationAuthority({
    finalizationValidation: handle.finalization.validation,
    validatedInputFingerprint: handle.validatedInputFingerprint,
    evidenceState: contract.evidenceState,
    expectedFingerprint: expectedValidationFingerprint,
  })) {
    throw new Error('WORK_DELIVERY_CURRENT_VALIDATION_REQUIRED');
  }

  const sourceCommonDir = commonGitDir(validated.worktreeRepository.canonicalRoot);
  const targetCommonDir = commonGitDir(targetRoot);
  if (!sourceCommonDir || !targetCommonDir || sourceCommonDir !== targetCommonDir) {
    throw new Error('WORK_DELIVERY_GIT_IDENTITY_MISMATCH');
  }

  let strategy: RepositoryCompletionReceipt['delivery']['strategy'];
  let integratedTargetHead = targetHead;
  if (git(targetRoot, ['merge-base', '--is-ancestor', sourceRevision, targetHead]).ok) {
    strategy = 'already_integrated';
  } else {
    if (!git(targetRoot, ['merge-base', '--is-ancestor', targetHead, sourceRevision]).ok) {
      throw new Error(`WORK_DELIVERY_NON_FAST_FORWARD: target ${targetHead} and source ${sourceRevision} diverged`);
    }
    assertTargetMutationAvailable(
      ctx.controllerHome,
      handle,
      target.activeCheckoutId,
      targetBranch,
      targetHead,
      targetRoot,
    );
    if (handle.state !== 'committed') {
      handle = transitionWorkHandle(ctx.controllerHome, handle, 'committed', {
        expectedHead: sourceRevision,
        failureReason: undefined,
        finalization: { ...handle.finalization, commit: 'done', lastError: undefined },
      });
    }
    const merged = git(targetRoot, ['merge', '--ff-only', sourceRevision], 60_000);
    if (!merged.ok) {
      throw new Error(`WORK_DELIVERY_FAST_FORWARD_FAILED: ${merged.stderr || merged.stdout || 'git merge failed'}`);
    }
    integratedTargetHead = exactRevision(targetRoot, 'HEAD', 'TARGET_HEAD');
    if (integratedTargetHead !== sourceRevision) {
      throw new Error(`WORK_DELIVERY_TARGET_HEAD_UNEXPECTED: expected ${sourceRevision}, found ${integratedTargetHead}`);
    }
    strategy = 'work_fast_forward';
  }

  if (!git(targetRoot, ['merge-base', '--is-ancestor', sourceRevision, integratedTargetHead]).ok) {
    throw new Error(`WORK_DELIVERY_TARGET_REVISION_UNREACHABLE: ${sourceRevision}`);
  }
  if (handle.state !== 'merged') {
    handle = transitionWorkHandle(ctx.controllerHome, handle, 'merged', {
      expectedHead: sourceRevision,
      failureReason: undefined,
      finalization: {
        ...handle.finalization,
        validation: 'done',
        commit: 'done',
        merge: 'done',
        lastError: undefined,
      },
    });
  }

  const cleanup = await cleanupTerminalWork({
    controllerHome: ctx.controllerHome,
    handle,
    targetBranch,
    deleteBranch: true,
    terminalOutcome: 'completed_cleanup',
  });
  const receipt = recordDelivery(
    ctx,
    handle,
    targetRoot,
    targetBranch,
    integratedTargetHead,
    sourceRevision,
    strategy,
    cleanup.receipt,
  );
  const refreshed = readWorkHandle(ctx.controllerHome, handle.repositoryId, handle.workId) ?? handle;
  const persisted = getWorkContract(
    { controllerHome: ctx.controllerHome, repoId: handle.repositoryId },
    handle.workContractId ?? handle.workId,
  );
  if (!persisted?.completionReceipt || !isRepositoryCompletionReceipt(persisted.completionReceipt)) {
    throw new Error('WORK_DELIVERY_RECEIPT_NOT_PERSISTED');
  }

  return makeBoundedWorkResult(ctx, session, handle.repositoryId, handle.workId, 'finalization', {
    work: compactHandle(refreshed),
    delivery: receipt,
    cleanup: cleanup.receipt,
    semanticCompletionRequired: true,
  });
}
