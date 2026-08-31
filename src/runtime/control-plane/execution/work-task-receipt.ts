import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { getIssue, listIssues, recordTaskVerification, acceptVerifiedTask, projectTaskFromWork } from '../../../cli/controller/issue-store';
import { resolveCompletionTargetBranch } from '../../../cli/controller/completion-target';
import type { CompletionReceipt, ControllerIssue } from '../../../cli/controller/types';
import { getWorkContract, updateWorkContract } from '../facade/work-contract-store';
import { completeWorkWithReceipt } from './work-completion-authority';
import { isRepositoryCompletionReceipt, WORK_RECONCILIATION_METHODS, WORK_RECONCILIATION_OUTCOMES } from '../facade/types';
import type {
  WorkReconciliationMethod,
  WorkReconciliationOutcome,
  WorkReconciliationRecord,
} from '../facade/types';
import { readWorkHandle } from './work-handle-store';
import { effectiveVerificationEvidence } from './verification-evidence';

function gitText(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error(`CONTROLLER_WORK_RECEIPT_GIT_FAILED: git ${args.join(' ')}`);
  }
  return result.stdout.trim();
}

function commitRevision(repoRoot: string, revision: string | undefined, label: string): string {
  if (!revision?.trim()) throw new Error(`CONTROLLER_WORK_RECEIPT_${label}_MISSING`);
  return gitText(repoRoot, ['rev-parse', `${revision.trim()}^{commit}`]);
}

export function changedPaths(repoRoot: string, baseRevision: string, targetRevision: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', '-z', baseRevision, targetRevision], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error('CONTROLLER_WORK_RECEIPT_CHANGED_PATHS_UNAVAILABLE');
  }
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}

/**
 * Net tracked paths for a Work whose authoritative repository baseline was an
 * unborn HEAD. The baseline is the empty repository, so every tracked path in
 * the current target tree is a net implementation path. This remains correct
 * after more than one commit, unlike a single-commit diff-tree comparison.
 */
export function changedPathsFromUnbornBase(repoRoot: string, targetRevision: string): string[] {
  const targetCommit = commitRevision(repoRoot, targetRevision, 'TARGET_REVISION');
  const result = spawnSync('git', ['ls-tree', '-r', '--name-only', '-z', targetCommit], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') {
    throw new Error('CONTROLLER_WORK_RECEIPT_UNBORN_CHANGED_PATHS_UNAVAILABLE');
  }
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}


function completionReceiptChangedPaths(
  contract: NonNullable<ReturnType<typeof getWorkContract>>,
  repoRoot: string,
  baseRevision: string,
  targetRevision: string,
): string[] {
  const reconciled = contract.reconciliations.find((entry) =>
    entry.outcome === 'accepted_equivalence'
    && entry.reachable
    && entry.baseRevision === baseRevision
    && entry.observedTargetRevision === targetRevision);
  if (!reconciled) return changedPaths(repoRoot, baseRevision, targetRevision);
  return [...new Set(reconciled.comparedPaths.map((path) => path.trim()).filter(Boolean))].sort();
}

function assertWorkNotBoundElsewhere(repoRoot: string, workId: string, issueId: string, taskId: string): void {
  for (const issue of listIssues(repoRoot)) {
    for (const task of issue.tasks) {
      const receipt = task.verification?.completionReceipt;
      if (receipt?.workId !== workId) continue;
      if (issue.id === issueId && task.id === taskId) continue;
      throw new Error(`CONTROLLER_WORK_RECEIPT_ALREADY_BOUND: ${workId} -> ${issue.id}/${task.id}`);
    }
  }
}

function assertCurrentRequiredChecks(contract: NonNullable<ReturnType<typeof getWorkContract>>, targetRevision: string): void {
  for (const checkId of contract.checks) {
    const current = effectiveVerificationEvidence(contract.checkRefs, {
      sourceRevision: targetRevision,
      checkId,
      requestedChecks: contract.checks,
    }).some((entry) => entry.current && entry.record.outcome === 'valid_pass');
    if (!current) throw new Error(`CONTROLLER_WORK_RECEIPT_CHECK_EVIDENCE_STALE: ${checkId}`);
  }
}

export interface ControllerWorkTaskReceiptInput {
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  issueId: string;
  taskId: string;
  workId: string;
  note?: string;
}

export interface ControllerWorkTaskReceiptResult {
  issue: ControllerIssue;
  receipt: CompletionReceipt;
}

const RECONCILABLE_FINALIZATION_STAGES = new Set([
  'validation', 'commit', 'merge', 'branch_cleanup', 'worktree_cleanup', 'receipt',
]);

export interface ControllerWorkReconciliationInput extends ControllerWorkTaskReceiptInput {
  method: WorkReconciliationMethod;
  outcome: WorkReconciliationOutcome;
  /** Exact bounded paths compared by the reviewer, rather than a claim of semantic equality. */
  comparedPaths: string[];
  reviewer: string;
  reviewedAt?: string;
  /** Stage facts that cannot be reconstructed from the historical Work. */
  unrecoverableStages: string[];
  /** Concrete proof that any cleanup is owned and complete, or no cleanup was owned. */
  cleanupOwnershipProof: string;
  rationale: string;
}

export interface ControllerWorkReconciliationResult {
  contractId: string;
  record: WorkReconciliationRecord;
}

function normalizedReviewedPaths(paths: string[]): string[] {
  const normalized = [...new Set(paths.map((path) => path.trim()))].sort();
  if (normalized.length === 0 || normalized.length > 50) {
    throw new Error('CONTROLLER_WORK_RECONCILIATION_PATHS_INVALID');
  }
  if (normalized.some((path) => !path || path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
    throw new Error('CONTROLLER_WORK_RECONCILIATION_PATHS_INVALID');
  }
  return normalized;
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function globMatchesPath(pattern: string, path: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

function assertReviewedPathScope(contract: NonNullable<ReturnType<typeof getWorkContract>>, task: NonNullable<ControllerIssue['tasks'][number]>, paths: string[]): void {
  const forbidden = [...new Set([...contract.forbiddenPaths, ...task.forbiddenPaths])];
  for (const path of paths) {
    if (forbidden.some((pattern) => globMatchesPath(pattern, path))) {
      throw new Error(`CONTROLLER_WORK_RECONCILIATION_FORBIDDEN_PATH: ${path}`);
    }
    if (contract.allowedPaths.length > 0 && !contract.allowedPaths.some((pattern) => globMatchesPath(pattern, path))) {
      throw new Error(`CONTROLLER_WORK_RECONCILIATION_PATH_OUT_OF_SCOPE: ${path}`);
    }
    if (task.allowedPaths.length > 0 && !task.allowedPaths.some((pattern) => globMatchesPath(pattern, path))) {
      throw new Error(`CONTROLLER_WORK_RECONCILIATION_PATH_OUT_OF_SCOPE: ${path}`);
    }
  }
}

/**
 * Record a bounded reviewer-approved exception for manual/equivalent delivery.
 * This deliberately does not alter legacy Work status or accept the Task.
 */
export function recordControllerWorkReconciliation(input: ControllerWorkReconciliationInput): ControllerWorkReconciliationResult {
  if (!WORK_RECONCILIATION_METHODS.includes(input.method) || !WORK_RECONCILIATION_OUTCOMES.includes(input.outcome)) {
    throw new Error('CONTROLLER_WORK_RECONCILIATION_KIND_INVALID');
  }
  const issue = getIssue(input.repoRoot, input.issueId);
  const task = issue.tasks.find((entry) => entry.id === input.taskId);
  if (!task?.verification || task.status !== 'verified') {
    throw new Error(`CONTROLLER_WORK_RECONCILIATION_TASK_NOT_VERIFIED: ${input.issueId}/${input.taskId}`);
  }
  const handle = readWorkHandle(input.controllerHome, input.repoId, input.workId);
  if (!handle) throw new Error(`CONTROLLER_WORK_RECONCILIATION_WORK_NOT_FOUND: ${input.workId}`);
  if (handle.repositoryId !== input.repoId) throw new Error(`CONTROLLER_WORK_RECONCILIATION_REPOSITORY_MISMATCH: ${input.workId}`);
  const contract = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, handle.workContractId ?? input.workId);
  if (!contract || contract.repoId !== input.repoId) {
    throw new Error(`CONTROLLER_WORK_RECONCILIATION_CONTRACT_NOT_FOUND: ${input.workId}`);
  }

  const originalExpectedRevision = commitRevision(input.repoRoot, handle.expectedHead, 'ORIGINAL_EXPECTED_REVISION');
  const observedTargetRevision = commitRevision(input.repoRoot, task.verification.integratedRevision, 'OBSERVED_TARGET_REVISION');
  const baseRevision = commitRevision(input.repoRoot, handle.baseCommit, 'BASE_REVISION');
  if (originalExpectedRevision === observedTargetRevision) {
    throw new Error('CONTROLLER_WORK_RECONCILIATION_EXACT_REVISION_REQUIRED');
  }
  const comparedPaths = normalizedReviewedPaths(input.comparedPaths);
  const originalPaths = changedPaths(input.repoRoot, baseRevision, originalExpectedRevision);
  const observedPaths = changedPaths(input.repoRoot, baseRevision, observedTargetRevision);
  if (!samePaths(comparedPaths, originalPaths) || !samePaths(comparedPaths, observedPaths)) {
    throw new Error('CONTROLLER_WORK_RECONCILIATION_PATH_COMPARISON_MISMATCH');
  }
  assertReviewedPathScope(contract, task, comparedPaths);

  const reviewer = input.reviewer.trim();
  const rationale = input.rationale.trim();
  const cleanupOwnershipProof = input.cleanupOwnershipProof.trim();
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (!reviewer || !rationale || !cleanupOwnershipProof || Number.isNaN(Date.parse(reviewedAt))) {
    throw new Error('CONTROLLER_WORK_RECONCILIATION_REVIEW_METADATA_INVALID');
  }
  const unrecoverableStages = [...new Set(input.unrecoverableStages.map((stage) => stage.trim()))].sort();
  if (unrecoverableStages.length === 0 || unrecoverableStages.some((stage) => !RECONCILABLE_FINALIZATION_STAGES.has(stage))) {
    throw new Error('CONTROLLER_WORK_RECONCILIATION_STAGES_INVALID');
  }
  const targetBranch = resolveCompletionTargetBranch(input.repoRoot);
  const reachableResult = spawnSync('git', ['merge-base', '--is-ancestor', observedTargetRevision, targetBranch], {
    cwd: input.repoRoot,
    encoding: 'utf-8',
  });
  const reachable = reachableResult.status === 0 && !reachableResult.error;
  const reconciliationId = `RECNC-${createHash('sha256').update([
    input.repoId, input.workId, originalExpectedRevision, observedTargetRevision, input.method,
    comparedPaths.join('\0'), reviewer, reviewedAt,
  ].join('\0')).digest('hex').slice(0, 16)}`;
  const record: WorkReconciliationRecord = {
    schemaVersion: 1,
    reconciliationId,
    originalExpectedRevision,
    observedTargetRevision,
    baseRevision,
    targetBranch,
    reachable,
    method: input.method,
    comparedPaths,
    reviewer: reviewer.slice(0, 200),
    reviewedAt,
    unrecoverableStages,
    cleanupOwnershipProof: cleanupOwnershipProof.slice(0, 2_000),
    rationale: rationale.slice(0, 2_000),
    outcome: input.outcome,
  };
  updateWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, contract.workId, {
    reconciliations: [record, ...contract.reconciliations.filter((entry) => entry.reconciliationId !== reconciliationId)],
  });
  return { contractId: contract.workId, record };
}

/**
 * Produce a Task receipt only from an explicit accepted reconciliation record.
 * Unlike the normal path this records historical gaps instead of inventing
 * finalization stages, then atomically records the accepted Work completion
 * before projecting any legacy Task state.
 */
export function acceptVerifiedTaskFromReviewedWorkReconciliation(input: ControllerWorkReconciliationInput): ControllerWorkTaskReceiptResult {
  const issue = getIssue(input.repoRoot, input.issueId);
  const task = issue.tasks.find((entry) => entry.id === input.taskId);
  if (!task) throw new Error(`task not found: ${input.issueId}/${input.taskId}`);
  if (task.workId && task.workId !== input.workId) throw new Error(`CONTROLLER_WORK_RECEIPT_TASK_WORK_MISMATCH: ${task.workId} != ${input.workId}`);
  if (task.status === 'done' && task.verification?.completionReceipt?.workId === input.workId) {
    return { issue, receipt: task.verification.completionReceipt };
  }
  const reconciliation = recordControllerWorkReconciliation(input);
  if (reconciliation.record.outcome !== 'accepted_equivalence') {
    throw new Error(`CONTROLLER_WORK_RECONCILIATION_NOT_ACCEPTED: ${reconciliation.record.outcome}`);
  }
  if (!reconciliation.record.reachable) {
    throw new Error(`CONTROLLER_WORK_RECONCILIATION_TARGET_UNREACHABLE: ${reconciliation.record.observedTargetRevision}`);
  }
  const contract = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, reconciliation.contractId)!;
  assertCurrentRequiredChecks(contract, reconciliation.record.observedTargetRevision);
  assertWorkNotBoundElsewhere(input.repoRoot, input.workId, input.issueId, input.taskId);

  const recordedAt = new Date().toISOString();
  const noChange = contract.workKind === 'completed_no_change';
  const receipt: CompletionReceipt = {
    schemaVersion: 1,
    receiptId: `REC-work-reconciled-${createHash('sha256').update(`${input.repoId}\0${input.issueId}\0${input.taskId}\0${input.workId}\0${reconciliation.record.reconciliationId}`).digest('hex').slice(0, 16)}`,
    source: 'controller_work',
    issueId: input.issueId,
    taskId: input.taskId,
    workId: input.workId,
    targetBranch: reconciliation.record.targetBranch,
    targetRevision: reconciliation.record.observedTargetRevision,
    sourceRevision: reconciliation.record.originalExpectedRevision,
    baseRevision: reconciliation.record.baseRevision,
    changedPaths: noChange ? [] : reconciliation.record.comparedPaths,
    delivery: { kind: noChange ? 'no_change' : 'commit', status: 'integrated', strategy: noChange ? 'no_change' : 'already_integrated', reachable: true, recordedAt },
    cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
    verifiedAt: task.verification!.verifiedAt,
    recordedAt,
  };
  const completionOutcome = noChange ? 'completed_no_change' : contract.workKind === 'remote_effect' ? 'completed_remote' : 'completed_changed';
  const recorded = completeWorkWithReceipt(
    { controllerHome: input.controllerHome, repoId: input.repoId },
    input.workId,
    receipt,
    completionOutcome,
    contract.workKind,
  );
  const recordedReceipt = recorded.completionReceipt;
  const projectedReceipt = recordedReceipt && isRepositoryCompletionReceipt(recordedReceipt) ? recordedReceipt : receipt;
  const projectedVerification = { ...task.verification!, completionReceipt: projectedReceipt };
  const accepted = task.workId
    ? projectTaskFromWork(input.repoRoot, input.issueId, input.taskId, recorded, {
        verification: projectedVerification,
        note: input.note ?? `Projected reviewed Work reconciliation ${reconciliation.record.reconciliationId} for ${input.workId}.`,
      })
    : (() => {
        recordTaskVerification(input.repoRoot, input.issueId, input.taskId, projectedVerification);
        return acceptVerifiedTask(
          input.repoRoot,
          input.issueId,
          input.taskId,
          input.note ?? `Accepted reviewed Work reconciliation ${reconciliation.record.reconciliationId} for ${input.workId}.`,
        );
      })();
  return { issue: accepted, receipt: projectedReceipt };
}

/**
 * Bind one completed controller-owned Work to one exact verified Task.
 * The explicit workId and integratedRevision equality prevent heuristic or
 * cross-Task completion. The original Task acceptance gate remains authoritative.
 */
export function acceptVerifiedTaskFromControllerWork(input: ControllerWorkTaskReceiptInput): ControllerWorkTaskReceiptResult {
  const issue = getIssue(input.repoRoot, input.issueId);
  const task = issue.tasks.find((entry) => entry.id === input.taskId);
  if (!task) throw new Error(`task not found: ${input.issueId}/${input.taskId}`);
  if (task.workId && task.workId !== input.workId) throw new Error(`CONTROLLER_WORK_RECEIPT_TASK_WORK_MISMATCH: ${task.workId} != ${input.workId}`);
  if (task.status === 'done' && task.verification?.completionReceipt?.workId === input.workId) {
    return { issue, receipt: task.verification.completionReceipt };
  }
  if (task.status !== 'verified' || !task.verification) {
    throw new Error(`CONTROLLER_WORK_RECEIPT_TASK_NOT_VERIFIED: ${input.issueId}/${input.taskId}`);
  }

  const handle = readWorkHandle(input.controllerHome, input.repoId, input.workId);
  if (!handle) throw new Error(`CONTROLLER_WORK_RECEIPT_WORK_NOT_FOUND: ${input.workId}`);
  if (handle.repositoryId !== input.repoId) throw new Error(`CONTROLLER_WORK_RECEIPT_REPOSITORY_MISMATCH: ${input.workId}`);
  const contract = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, handle.workContractId ?? input.workId);
  if (!contract || contract.repoId !== input.repoId) {
    throw new Error(`CONTROLLER_WORK_RECEIPT_CONTRACT_NOT_FOUND: ${input.workId}`);
  }
  if (contract.status === 'cancelled') throw new Error(`CONTROLLER_WORK_RECEIPT_CONTRACT_CANCELLED: ${input.workId}`);
  const noChange = contract.workKind === 'completed_no_change'
    && contract.evidenceState === 'valid';
  const stages = handle.finalization;
  const complete = noChange
    ? handle.state !== 'failed'
      && stages.validation === 'done'
      && stages.commit === 'skipped'
      && stages.merge === 'skipped'
      && stages.branchCleanup === 'skipped'
      && ['skipped', 'done'].includes(stages.worktreeCleanup)
      && !stages.lastError
    : handle.state === 'cleaned'
    && stages.validation === 'done'
    && stages.commit === 'done'
    && stages.merge === 'done'
    && stages.branchCleanup === 'done'
    && stages.worktreeCleanup === 'done'
    && !stages.lastError;
  if (!complete) throw new Error(`CONTROLLER_WORK_RECEIPT_FINALIZATION_INCOMPLETE: ${input.workId}`);

  const targetRevision = commitRevision(input.repoRoot, handle.expectedHead, 'TARGET_REVISION');
  const verifiedRevision = commitRevision(input.repoRoot, task.verification.integratedRevision, 'VERIFIED_REVISION');
  if (targetRevision !== verifiedRevision) {
    throw new Error(`CONTROLLER_WORK_RECEIPT_REVISION_MISMATCH: work=${targetRevision} task=${verifiedRevision}`);
  }
  if (noChange && !contract.evidenceRefs.some((entry) => entry.title === 'objective-specific no-change proof' && entry.summary?.trim())) {
    throw new Error(`CONTROLLER_WORK_RECEIPT_NO_CHANGE_PROOF_MISSING: ${input.workId}`);
  }
  assertCurrentRequiredChecks(contract, targetRevision);
  const baseRevision = commitRevision(input.repoRoot, handle.baseCommit, 'BASE_REVISION');
  const receiptChangedPaths = completionReceiptChangedPaths(contract, input.repoRoot, baseRevision, targetRevision);
  if (noChange && receiptChangedPaths.length > 0) {
    throw new Error(`CONTROLLER_WORK_RECEIPT_NO_CHANGE_DIRTY: ${input.workId}`);
  }
  const targetBranch = resolveCompletionTargetBranch(input.repoRoot);
  const reachable = spawnSync('git', ['merge-base', '--is-ancestor', targetRevision, targetBranch], {
    cwd: input.repoRoot,
    encoding: 'utf-8',
  });
  if (reachable.status !== 0 || reachable.error) {
    throw new Error(`CONTROLLER_WORK_RECEIPT_TARGET_UNREACHABLE: ${targetRevision} from ${targetBranch}`);
  }
  assertWorkNotBoundElsewhere(input.repoRoot, input.workId, input.issueId, input.taskId);

  const recordedAt = new Date().toISOString();
  const receipt: CompletionReceipt = {
    schemaVersion: 1,
    receiptId: `REC-work-${createHash('sha256').update(`${input.repoId}\0${input.issueId}\0${input.taskId}\0${input.workId}\0${targetRevision}`).digest('hex').slice(0, 16)}`,
    source: 'controller_work',
    issueId: input.issueId,
    taskId: input.taskId,
    workId: input.workId,
    targetBranch,
    targetRevision,
    sourceRevision: targetRevision,
    baseRevision,
    changedPaths: receiptChangedPaths,
    delivery: {
      kind: noChange ? 'no_change' : 'commit',
      status: 'integrated',
      strategy: noChange ? 'no_change' : 'already_integrated',
      reachable: true,
      recordedAt,
    },
    cleanup: {
      status: 'complete',
      warnings: [],
      blockers: [],
      recordedAt,
    },
    verifiedAt: task.verification.verifiedAt,
    recordedAt,
  };

  // Persist the Work receipt before touching the legacy Task projection. If a
  // historical Task write is interrupted, the Work authority is still
  // durable and a retry can safely rebuild the projection.
  const completionOutcome = noChange ? 'completed_no_change' : contract.workKind === 'remote_effect' ? 'completed_remote' : 'completed_changed';
  const recorded = completeWorkWithReceipt(
    { controllerHome: input.controllerHome, repoId: input.repoId },
    input.workId,
    receipt,
    completionOutcome,
  );
  const recordedReceipt = recorded.completionReceipt;
  const projectedReceipt = recordedReceipt && isRepositoryCompletionReceipt(recordedReceipt) ? recordedReceipt : receipt;
  const projectedVerification = {
    ...task.verification,
    completionReceipt: projectedReceipt,
  };
  if (task.workId) {
    const projected = projectTaskFromWork(input.repoRoot, input.issueId, input.taskId, recorded, {
      verification: projectedVerification,
      note: input.note ?? `Projected completed Work ${input.workId} with receipt ${receipt.receiptId}.`,
    });
    return { issue: projected, receipt: projectedReceipt };
  }
  recordTaskVerification(input.repoRoot, input.issueId, input.taskId, projectedVerification);
  const accepted = acceptVerifiedTask(
    input.repoRoot,
    input.issueId,
    input.taskId,
    input.note ?? `Accepted completed controller Work ${input.workId} with receipt ${receipt.receiptId}.`,
  );
  return { issue: accepted, receipt };
}
