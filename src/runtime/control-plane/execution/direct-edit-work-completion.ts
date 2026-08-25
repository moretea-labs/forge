import { createHash } from 'crypto';
import { getEditSession, listEditSessions, type EditSession } from '../../../cli/editing/edit-session';
import { globMatches } from '../../../cli/mcp/paths';
import { runProcess } from '../../../effects/process-runner';
import { completeRequirementFromWork } from '../persistence/requirement-store';
import { appendWorkEvidence, getWorkContract, recordWorkCompletionReceipt, updateWorkContract } from '../facade/work-contract-store';
import { isDirectEditWorkCompletionReceipt, isTerminalWorkContractStatus, type DirectEditWorkCompletionReceipt, type WorkReconciliationRecord } from '../facade/types';
import { historicalVerificationEvidenceAtRevision } from './verification-evidence';
import { readWorkHandle } from './work-handle-store';

export interface DirectEditWorkCompletionReconciliation {
  completedWorkIds: string[];
  examinedSessionIds: string[];
  skipped: Array<{ sessionId: string; workId?: string; reason: string }>;
  targetBranch?: string;
  targetRevision?: string;
}

function git(repoRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcess('git', args, { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 4 * 1024 * 1024 });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.error || '' };
}

function changedPaths(session: EditSession): string[] {
  return Array.from(new Set(session.operations.map((operation) => operation.path).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

function latestOperations(session: EditSession): Map<string, EditSession['operations'][number]> {
  const latest = new Map<string, EditSession['operations'][number]>();
  for (const operation of session.operations) latest.set(operation.path, operation);
  return latest;
}

function revisionMismatches(repoRoot: string, revision: string, session: EditSession): string[] {
  const mismatches: string[] = [];
  for (const operation of latestOperations(session).values()) {
    const object = `${revision}:${operation.path}`;
    if (operation.type === 'delete') {
      if (git(repoRoot, ['cat-file', '-e', object]).ok) mismatches.push(operation.path);
      continue;
    }
    const content = git(repoRoot, ['show', object]);
    if (!content.ok || !operation.afterSha256 || createHash('sha256').update(content.stdout).digest('hex') !== operation.afterSha256) {
      mismatches.push(operation.path);
    }
  }
  return mismatches;
}

function requestedChecksPassed(session: EditSession): boolean {
  return session.requestedChecks.every((checkId) => session.checkResults.some((result) => result.checkId === checkId && result.ok));
}

export function reconcileFinalizedDirectEditWorksAfterCommit(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  committedPaths: string[];
  fallbackBranch?: string;
  limit?: number;
}): DirectEditWorkCompletionReconciliation {
  const committedPathSet = new Set(input.committedPaths);
  const targetRevisionResult = git(input.repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!targetRevisionResult.ok) {
    return { completedWorkIds: [], examinedSessionIds: [], skipped: [], targetRevision: undefined, targetBranch: undefined };
  }
  const targetRevision = targetRevisionResult.stdout.trim();
  const branchResult = git(input.repoRoot, ['branch', '--show-current']);
  const targetBranch = branchResult.ok && branchResult.stdout.trim()
    ? branchResult.stdout.trim()
    : input.fallbackBranch?.trim();
  if (!targetBranch) {
    return { completedWorkIds: [], examinedSessionIds: [], skipped: [], targetRevision, targetBranch: undefined };
  }
  const reachable = git(input.repoRoot, ['merge-base', '--is-ancestor', targetRevision, targetBranch]).ok;
  if (!reachable) {
    return { completedWorkIds: [], examinedSessionIds: [], skipped: [], targetRevision, targetBranch };
  }

  const completedWorkIds: string[] = [];
  const examinedSessionIds: string[] = [];
  const skipped: DirectEditWorkCompletionReconciliation['skipped'] = [];
  const summaries = listEditSessions(input.repoRoot, input.limit ?? 200);
  for (const summary of summaries) {
    const session = getEditSession(input.repoRoot, summary.sessionId);
    if (session.status !== 'finalized' || !session.workId) continue;
    if (session.repoId && session.repoId !== input.repoId) continue;
    if (session.checkoutId && session.checkoutId !== input.checkoutId) continue;
    const paths = changedPaths(session);
    if (paths.length === 0 || !paths.every((path) => committedPathSet.has(path))) continue;
    examinedSessionIds.push(session.sessionId);

    const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, session.workId);
    if (!work) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: 'work_not_found' });
      continue;
    }
    if (isTerminalWorkContractStatus(work.status)) continue;
    if (!requestedChecksPassed(session)) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: 'configured_checks_not_passed' });
      continue;
    }
    const status = git(input.repoRoot, ['status', '--porcelain=v1', '--', ...paths]);
    if (!status.ok || status.stdout.trim()) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: 'owned_paths_not_clean' });
      continue;
    }
    const mismatches = revisionMismatches(input.repoRoot, targetRevision, session);
    if (mismatches.length > 0) {
      skipped.push({ sessionId: session.sessionId, workId: session.workId, reason: `revision_mismatch:${mismatches.join(',')}` });
      continue;
    }

    const recordedAt = new Date().toISOString();
    const receipt: DirectEditWorkCompletionReceipt = {
      schemaVersion: 1,
      receiptId: `REC-direct-edit-work-${createHash('sha256').update(`${input.repoId}\0${session.workId}\0${session.sessionId}\0${targetRevision}`).digest('hex').slice(0, 20)}`,
      source: 'direct_edit_work',
      workId: session.workId,
      editSessionId: session.sessionId,
      targetBranch,
      targetRevision,
      sourceRevision: targetRevision,
      baseRevision: session.baseRevision,
      changedPaths: paths,
      delivery: {
        kind: 'commit',
        status: 'integrated',
        strategy: 'edit_session_commit',
        reachable: true,
        recordedAt,
      },
      cleanup: {
        status: 'complete',
        warnings: [],
        blockers: [],
        recordedAt,
      },
      verifiedAt: session.verifiedAt ?? session.finalizedAt ?? recordedAt,
      recordedAt,
    };
    recordWorkCompletionReceipt(
      { controllerHome: input.controllerHome, repoId: input.repoId },
      session.workId,
      receipt,
      'completed_changed',
      'repository_change',
    );
    completedWorkIds.push(session.workId);
  }

  return { completedWorkIds, examinedSessionIds, skipped, targetBranch, targetRevision };
}

export interface ReviewedDirectEditWorkReconciliationInput {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  workId: string;
  targetBranch: string;
  targetRevision: string;
  comparedPaths: string[];
  reviewer: string;
  rationale: string;
  cleanupOwnershipProof: string;
  reviewedAt?: string;
}

function exactCommit(repoRoot: string, revision: string, label: string): string {
  const result = git(repoRoot, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (!result.ok || !result.stdout.trim()) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_${label}_INVALID`);
  return result.stdout.trim();
}

function comparedRevisionPaths(repoRoot: string, baseRevision: string, targetRevision: string): string[] {
  const result = git(repoRoot, ['diff', '--name-only', '-z', baseRevision, targetRevision]);
  if (!result.ok) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_CHANGED_PATHS_UNAVAILABLE');
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizedComparedPaths(paths: string[]): string[] {
  const normalized = [...new Set(paths.map((path) => path.trim()))].sort((left, right) => left.localeCompare(right));
  if (normalized.length === 0 || normalized.length > 100 || normalized.some((path) => !path || path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '' || part === '.' || part === '..'))) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_PATHS_INVALID');
  }
  return normalized;
}

/**
 * Explicitly close a historically delivered Direct Edit Work whose original
 * edit-session binding was missed. This is never inferred: the caller must
 * supply the exact accepted revision and the complete reviewed path set.
 */
export function acceptReviewedDirectEditWorkReconciliation(input: ReviewedDirectEditWorkReconciliationInput): {
  workId: string;
  reconciliation: WorkReconciliationRecord;
  receipt: DirectEditWorkCompletionReceipt;
} {
  const work = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId);
  if (!work || work.repoId !== input.repoId) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_WORK_NOT_FOUND: ${input.workId}`);
  if (work.checkoutId && work.checkoutId !== input.checkoutId) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CHECKOUT_MISMATCH: ${input.workId}`);
  if (work.completionReceipt) {
    const completionReceipt = work.completionReceipt;
    if (isDirectEditWorkCompletionReceipt(completionReceipt) && completionReceipt.reconciliationId) {
      const existing = work.reconciliations.find((entry) => entry.reconciliationId === completionReceipt.reconciliationId);
      if (existing) return { workId: work.workId, reconciliation: existing, receipt: completionReceipt };
    }
    throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_WORK_TERMINAL: ${input.workId}`);
  }
  const failedHandle = work.status === 'failed'
    ? readWorkHandle(input.controllerHome, input.repoId, input.workId)
    : undefined;
  const failedReviewedRecovery = work.workKind === 'repository_change'
    && work.status === 'failed'
    && failedHandle?.managedWorktree === false
    && failedHandle.state === 'failed'
    && failedHandle.finalization.validation === 'failed'
    && String(failedHandle.finalization.lastError ?? failedHandle.failureReason ?? '').includes('WORK_HANDLE_HEAD_CHANGED');
  if ((isTerminalWorkContractStatus(work.status) && !failedReviewedRecovery) || work.workKind !== 'repository_change') {
    throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_WORK_NOT_ELIGIBLE: ${input.workId}`);
  }
  if (!work.baseRevision?.trim()) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_BASE_REVISION_MISSING');

  const baseRevision = exactCommit(input.repoRoot, work.baseRevision, 'BASE_REVISION');
  const targetRevision = exactCommit(input.repoRoot, input.targetRevision.trim(), 'TARGET_REVISION');
  const targetBranch = input.targetBranch.trim();
  if (!targetBranch) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_BRANCH_REQUIRED');
  if (!git(input.repoRoot, ['merge-base', '--is-ancestor', baseRevision, targetRevision]).ok) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_NOT_DESCENDANT');
  }
  if (!git(input.repoRoot, ['merge-base', '--is-ancestor', targetRevision, targetBranch]).ok) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_UNREACHABLE');
  }

  const comparedPaths = normalizedComparedPaths(input.comparedPaths);
  let comparisonBaseRevision = baseRevision;
  if (failedReviewedRecovery) {
    const targetParent = exactCommit(input.repoRoot, `${targetRevision}^`, 'TARGET_PARENT_REVISION');
    if (!git(input.repoRoot, ['merge-base', '--is-ancestor', baseRevision, targetParent]).ok) {
      throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_TARGET_PARENT_NOT_DESCENDANT');
    }
    comparisonBaseRevision = targetParent;
  }
  const actualPaths = comparedRevisionPaths(input.repoRoot, comparisonBaseRevision, targetRevision);
  if (comparedPaths.length !== actualPaths.length || comparedPaths.some((path, index) => path !== actualPaths[index])) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_PATH_COMPARISON_MISMATCH');
  }
  for (const path of comparedPaths) {
    if (work.forbiddenPaths.some((pattern) => globMatches(pattern, path))) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_FORBIDDEN_PATH: ${path}`);
    if (work.allowedPaths.length > 0 && !work.allowedPaths.some((pattern) => globMatches(pattern, path))) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_PATH_OUT_OF_SCOPE: ${path}`);
  }
  const dirty = git(input.repoRoot, ['status', '--porcelain=v1', '--', ...comparedPaths]);
  if (!dirty.ok || dirty.stdout.trim()) throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_OWNED_PATHS_DIRTY');

  let verifiedAt = new Date().toISOString();
  for (const checkId of work.checks) {
    const candidates = historicalVerificationEvidenceAtRevision(work.checkRefs, {
      sourceRevision: targetRevision,
      repoId: input.repoId,
      workId: work.workId,
      checkoutId: work.checkoutId,
      checkId,
      requestedChecks: work.checks,
    }).filter((entry) => entry.current && entry.record.outcome === 'valid_pass');
    const distinctReceipts = new Map(candidates.map((entry) => [entry.record.receipt!.receiptId, entry]));
    if (distinctReceipts.size === 0) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_STALE: ${checkId}`);
    if (distinctReceipts.size > 1) throw new Error(`DIRECT_EDIT_WORK_RECONCILIATION_CHECK_EVIDENCE_AMBIGUOUS: ${checkId}`);
    const current = [...distinctReceipts.values()][0]!;
    verifiedAt = current.record.completedAt ?? current.record.recordedAt ?? verifiedAt;
  }

  const reviewer = input.reviewer.trim();
  const rationale = input.rationale.trim();
  const cleanupOwnershipProof = input.cleanupOwnershipProof.trim();
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (!reviewer || !rationale || !cleanupOwnershipProof || Number.isNaN(Date.parse(reviewedAt))) {
    throw new Error('DIRECT_EDIT_WORK_RECONCILIATION_REVIEW_METADATA_INVALID');
  }
  const reconciliationId = `RECNC-${createHash('sha256').update([input.repoId, input.workId, baseRevision, targetRevision, comparedPaths.join('\0'), reviewer, reviewedAt].join('\0')).digest('hex').slice(0, 16)}`;
  const reconciliation: WorkReconciliationRecord = {
    schemaVersion: 1,
    reconciliationId,
    originalExpectedRevision: targetRevision,
    observedTargetRevision: targetRevision,
    baseRevision,
    targetBranch,
    reachable: true,
    method: 'owned_path_tree',
    comparedPaths,
    reviewer: reviewer.slice(0, 200),
    reviewedAt,
    unrecoverableStages: ['receipt'],
    cleanupOwnershipProof: cleanupOwnershipProof.slice(0, 2_000),
    rationale: rationale.slice(0, 2_000),
    outcome: 'accepted_equivalence',
  };
  updateWorkContract({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId, {
    reconciliations: [reconciliation, ...work.reconciliations.filter((entry) => entry.reconciliationId !== reconciliationId)],
  });

  const recordedAt = new Date().toISOString();
  const receipt: DirectEditWorkCompletionReceipt = {
    schemaVersion: 1,
    receiptId: `REC-direct-edit-reconciled-${createHash('sha256').update(`${input.repoId}\0${input.workId}\0${reconciliationId}\0${targetRevision}`).digest('hex').slice(0, 20)}`,
    source: 'direct_edit_work',
    workId: input.workId,
    reconciliationId,
    targetBranch,
    targetRevision,
    sourceRevision: targetRevision,
    baseRevision,
    changedPaths: comparedPaths,
    delivery: { kind: 'commit', status: 'integrated', strategy: 'already_integrated', reachable: true, recordedAt },
    cleanup: { status: 'complete', warnings: [], blockers: [], recordedAt },
    verifiedAt,
    recordedAt,
  };
  const recorded = recordWorkCompletionReceipt(
    { controllerHome: input.controllerHome, repoId: input.repoId },
    input.workId,
    receipt,
    'completed_changed',
    'repository_change',
  );
  if (recorded.requirementId) {
    try {
      completeRequirementFromWork({ controllerHome: input.controllerHome }, { requirementId: recorded.requirementId, work: recorded });
    } catch (error) {
      try {
        appendWorkEvidence({ controllerHome: input.controllerHome, repoId: input.repoId }, input.workId, {
          title: 'requirement completion projection pending',
          summary: `Work completion remains authoritative; Requirement projection could not be applied: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
          detailLevel: 'summary',
        });
      } catch {
        // Reconciliation already recorded the terminal receipt. A diagnostic
        // write failure cannot make that completed Work non-terminal again.
      }
    }
  }
  return { workId: input.workId, reconciliation, receipt };
}
