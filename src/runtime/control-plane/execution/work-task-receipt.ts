import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { getIssue, listIssues, recordTaskVerification, acceptVerifiedTask } from '../../../cli/controller/issue-store';
import { resolveCompletionTargetBranch } from '../../../cli/controller/completion-target';
import type { CompletionReceipt, ControllerIssue } from '../../../cli/controller/types';
import { getWorkContract } from '../facade/work-contract-store';
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

function changedPaths(repoRoot: string, baseRevision: string, targetRevision: string): string[] {
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

/**
 * Bind one completed controller-owned Work to one exact verified Task.
 * The explicit workId and integratedRevision equality prevent heuristic or
 * cross-Task completion. The original Task acceptance gate remains authoritative.
 */
export function acceptVerifiedTaskFromControllerWork(input: ControllerWorkTaskReceiptInput): ControllerWorkTaskReceiptResult {
  const issue = getIssue(input.repoRoot, input.issueId);
  const task = issue.tasks.find((entry) => entry.id === input.taskId);
  if (!task) throw new Error(`task not found: ${input.issueId}/${input.taskId}`);
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
  if (!contract || contract.repoId !== input.repoId || contract.status !== 'completed') {
    throw new Error(`CONTROLLER_WORK_RECEIPT_CONTRACT_INCOMPLETE: ${input.workId}`);
  }
  const stages = handle.finalization;
  const complete = handle.state === 'cleaned'
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
  assertCurrentRequiredChecks(contract, targetRevision);
  const baseRevision = commitRevision(input.repoRoot, handle.baseCommit, 'BASE_REVISION');
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
    changedPaths: changedPaths(input.repoRoot, baseRevision, targetRevision),
    delivery: {
      kind: 'commit',
      status: 'integrated',
      strategy: 'already_integrated',
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

  recordTaskVerification(input.repoRoot, input.issueId, input.taskId, {
    ...task.verification,
    completionReceipt: receipt,
  });
  const accepted = acceptVerifiedTask(
    input.repoRoot,
    input.issueId,
    input.taskId,
    input.note ?? `Accepted completed controller Work ${input.workId} with receipt ${receipt.receiptId}.`,
  );
  return { issue: accepted, receipt };
}
