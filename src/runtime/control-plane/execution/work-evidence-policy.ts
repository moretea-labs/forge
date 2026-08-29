import { reconcileVerificationHistory } from '../facade/check-normalization';
import type { VerificationRecord, WorkContract } from '../facade/types';

type ReconciledVerificationHistory = ReturnType<typeof reconcileVerificationHistory>;

export interface WorkCompletionEvidenceEvaluation {
  status: 'complete' | 'failed' | 'incomplete';
  history: ReconciledVerificationHistory;
  missingChecks: string[];
  durableResultEvidence: boolean;
  reasons: string[];
}

export function verificationRecordAppliesToCurrentWorkspace(
  record: VerificationRecord,
  currentRevision?: string,
  currentWorkspaceFingerprint?: string,
): boolean {
  if (currentRevision && record.sourceRevision && record.sourceRevision !== currentRevision) return false;
  if (
    currentWorkspaceFingerprint
    && record.workspaceFingerprint
    && record.workspaceFingerprint !== currentWorkspaceFingerprint
  ) return false;
  return true;
}

function isAuthoritativeCurrentWorkVerification(
  work: WorkContract,
  record: VerificationRecord,
  currentRevision?: string,
): boolean {
  const receipt = record.receipt;
  return Boolean(
    currentRevision
    && record.outcome === 'valid_pass'
    && record.sourceRevision === currentRevision
    && receipt
    && receipt.repoId === work.repoId
    && receipt.workId === work.workId
    && receipt.checkId === record.checkId
    && receipt.ok === true
    && receipt.timedOut === false
    && receipt.cancelled === false,
  );
}

export interface WorkImplementationEvidenceEvaluation {
  status: 'complete' | 'incomplete';
  changedPaths: string[];
  reasons: string[];
}

export function evaluateWorkImplementationEvidence(
  work: WorkContract,
  currentWorkspaceChangedPaths: readonly string[] = [],
): WorkImplementationEvidenceEvaluation {
  if (work.workKind !== 'repository_change') {
    return { status: 'complete', changedPaths: [], reasons: [] };
  }

  const changedPaths = [...new Set(currentWorkspaceChangedPaths.map((path) => path.trim()).filter(Boolean))].sort();
  if (changedPaths.length > 0) {
    return { status: 'complete', changedPaths, reasons: [] };
  }

  return {
    status: 'incomplete',
    changedPaths: [],
    reasons: ['Repository-change Work has no current net source changes relative to its base revision. Verification evidence cannot substitute for implementation evidence.'],
  };
}

export function evaluateReadOnlyReviewSourceIdentity(
  work: WorkContract,
  currentRevision?: string,
  currentWorkspaceChangedPaths?: readonly string[],
): { status: 'complete' | 'incomplete'; reasons: string[] } {
  if (work.workKind !== 'read_only_review') return { status: 'complete', reasons: [] };
  const reasons: string[] = [];
  if (!work.baseRevision?.trim()) reasons.push('Read-only review has no frozen base revision.');
  if (!currentRevision?.trim()) reasons.push('Current source revision is unavailable, so unchanged-source proof is incomplete.');
  if (work.baseRevision && currentRevision && work.baseRevision !== currentRevision) {
    reasons.push(`Read-only review source drifted from frozen base ${work.baseRevision} to ${currentRevision}.`);
  }
  if (currentWorkspaceChangedPaths === undefined) {
    reasons.push('Current workspace changed-path proof is unavailable for read-only review.');
  } else if (currentWorkspaceChangedPaths.length > 0) {
    reasons.push(`Read-only review workspace is not unchanged: ${[...new Set(currentWorkspaceChangedPaths)].slice(0, 12).join(', ')}.`);
  }
  return { status: reasons.length === 0 ? 'complete' : 'incomplete', reasons };
}

export function evaluateWorkCompletionEvidence(
  work: WorkContract,
  currentRevision?: string,
  currentWorkspaceFingerprint?: string,
  workBoundProcessEvidenceIds: readonly string[] = [],
  currentWorkspaceChangedPaths?: readonly string[],
): WorkCompletionEvidenceEvaluation {
  const applicableCheckRefs = work.checkRefs.filter((record) =>
    verificationRecordAppliesToCurrentWorkspace(record, currentRevision, currentWorkspaceFingerprint));
  const history = reconcileVerificationHistory(
    applicableCheckRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  );
  const missingChecks = work.checks.filter((checkId) => !history.validPasses.includes(checkId));
  const readOnlySourceIdentity = evaluateReadOnlyReviewSourceIdentity(work, currentRevision, currentWorkspaceChangedPaths);
  const readOnlyEvidence = work.readOnlyReviewEvidence;
  const readOnlyEvidenceMatchesCurrentSource = Boolean(
    work.workKind === 'read_only_review'
    && readOnlyEvidence
    && currentRevision
    && readOnlyEvidence.sourceRevision === currentRevision
    && (readOnlyEvidence.workspaceFingerprint === undefined
      || currentWorkspaceFingerprint === undefined
      || readOnlyEvidence.workspaceFingerprint === currentWorkspaceFingerprint),
  );
  const cleanReadOnlyReviewEvidence = Boolean(
    readOnlyEvidenceMatchesCurrentSource
    && readOnlySourceIdentity.status === 'complete'
    && (readOnlyEvidence?.inspectedPaths.length ?? 0) > 0
    && (readOnlyEvidence?.findings.length ?? 0) === 0,
  );
  const durableResultEvidence = work.evidenceRefs.some((evidence) => Boolean(evidence.evidenceId || evidence.artifactId))
    || applicableCheckRefs.some((record) => isAuthoritativeCurrentWorkVerification(work, record, currentRevision))
    || workBoundProcessEvidenceIds.length > 0
    || cleanReadOnlyReviewEvidence;
  const reasons: string[] = [];

  if (history.acceptanceFailures.length > 0) {
    reasons.push(`Acceptance checks failed: ${history.acceptanceFailures.join(', ')}.`);
    return { status: 'failed', history, missingChecks, durableResultEvidence, reasons };
  }
  if (history.infrastructureIssues.length > 0) {
    reasons.push(`Infrastructure issues remain: ${history.infrastructureIssues.join(', ')}.`);
  }
  if (history.invalidCheckIds.length > 0) {
    reasons.push(`Invalid check ids remain: ${history.invalidCheckIds.join(', ')}.`);
  }
  if (missingChecks.length > 0) {
    reasons.push(`Declared checks are missing valid_pass evidence: ${missingChecks.join(', ')}.`);
  }
  if (work.workKind === 'read_only_review') {
    reasons.push(...readOnlySourceIdentity.reasons);
    if (!readOnlyEvidence || readOnlyEvidence.inspectedPaths.length === 0) {
      reasons.push('Read-only review has no persisted inspected-path evidence.');
    } else if (!readOnlyEvidenceMatchesCurrentSource) {
      reasons.push('Persisted read-only review evidence is stale for the current source/workspace identity.');
    }
    if ((readOnlyEvidence?.findings.length ?? 0) > 0) {
      reasons.push(`Read-only review has unresolved semantic findings (${readOnlyEvidence!.findings.length}); clean no-change completion is not allowed.`);
    }
  }
  if (work.checks.length === 0 && !durableResultEvidence) {
    const staleWorkVerification = work.checkRefs.some((record) =>
      Boolean(record.receipt)
      && !verificationRecordAppliesToCurrentWorkspace(record, currentRevision, currentWorkspaceFingerprint));
    reasons.push(staleWorkVerification
      ? 'Work-bound verification evidence is stale for the current source/workspace identity.'
      : 'No durable result evidence (evidenceId, artifactId, or current Work-bound verification receipt) was recorded for this no-check WorkContract.');
  }

  const complete = history.infrastructureIssues.length === 0
    && history.invalidCheckIds.length === 0
    && missingChecks.length === 0
    && (work.checks.length > 0 || durableResultEvidence)
    && (work.workKind !== 'read_only_review' || cleanReadOnlyReviewEvidence);
  return {
    status: complete ? 'complete' : 'incomplete',
    history,
    missingChecks,
    durableResultEvidence,
    reasons,
  };
}
