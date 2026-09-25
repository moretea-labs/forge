import { reconcileVerificationHistory } from '../facade/check-normalization';
import type { VerificationRecord, WorkContract } from '../facade/types';

type ReconciledVerificationHistory = ReturnType<typeof reconcileVerificationHistory>;

export interface WorkCompletionEvidenceEvaluation {
  status: 'complete' | 'failed' | 'incomplete';
  history: ReconciledVerificationHistory;
  missingChecks: string[];
  durableResultEvidence: boolean;
  semanticAcceptanceComplete: boolean;
  missingSemanticAcceptanceCriteria: string[];
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

function verificationRecordHasExactInputIdentity(record: VerificationRecord): boolean {
  return Boolean(record.sourceRevision && record.workspaceFingerprint && record.verificationInputFingerprint);
}

export function effectiveCurrentWorkVerificationRecords(
  work: WorkContract,
  currentRevision?: string,
  currentWorkspaceFingerprint?: string,
): VerificationRecord[] {
  const applicable = work.checkRefs.filter((record) =>
    verificationRecordAppliesToCurrentWorkspace(record, currentRevision, currentWorkspaceFingerprint));
  const authoritativePasses = new Set(
    applicable
      .filter((record) => verificationRecordHasExactInputIdentity(record)
        && isAuthoritativeCurrentWorkVerification(work, record, currentRevision))
      .map((record) => record.checkId),
  );
  return applicable.filter((record) => !(
    record.outcome === 'infrastructure_failure'
    && authoritativePasses.has(record.checkId)
    && !verificationRecordHasExactInputIdentity(record)
  ));
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


export function evaluateWorkCompletionEvidence(
  work: WorkContract,
  currentRevision?: string,
  currentWorkspaceFingerprint?: string,
  workBoundProcessEvidenceIds: readonly string[] = [],
  currentWorkspaceChangedPaths?: readonly string[],
): WorkCompletionEvidenceEvaluation {
  const applicableCheckRefs = effectiveCurrentWorkVerificationRecords(
    work,
    currentRevision,
    currentWorkspaceFingerprint,
  );
  const history = reconcileVerificationHistory(
    applicableCheckRefs.map((record) => ({ checkId: record.checkId, outcome: record.outcome, recordedAt: record.recordedAt })),
  );
  const missingChecks = work.checks.filter((checkId) => !history.validPasses.includes(checkId));
  // Review findings are recorded observations, never a completion gate. A
  // read-only review Work closes like any other Work; its inspected paths and
  // findings stay durable evidence for the model/user to act on.
  const workEvidenceIds = work.evidenceRefs.flatMap((evidence) => [evidence.evidenceId, evidence.artifactId])
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const availableDurableEvidenceIds = new Set([
    ...workEvidenceIds,
    ...workBoundProcessEvidenceIds.map((value) => value.trim()).filter(Boolean),
  ]);
  // Recorded read-only review scope is durable observation evidence for this Work
  // kind; findings inside it never gate completion.
  const readOnlyReviewEvidenceRecorded = Boolean(
    work.workKind === 'read_only_review'
    && work.readOnlyReviewEvidence
    && (work.readOnlyReviewEvidence.inspectedPaths.length > 0 || work.readOnlyReviewEvidence.findings.length > 0),
  );
  const durableResultEvidence = availableDurableEvidenceIds.size > 0
    || applicableCheckRefs.some((record) => isAuthoritativeCurrentWorkVerification(work, record, currentRevision))
    || readOnlyReviewEvidenceRecorded;
  const sourceDeltaRequiresImplementationReview = work.workKind === 'local_effect'
    && (currentWorkspaceChangedPaths?.length ?? 0) > 0;
  const requiresSemanticAcceptance = work.workKind === 'local_effect'
    && work.checks.length === 0
    && !sourceDeltaRequiresImplementationReview;
  const acceptedCriteria = new Set((work.semanticAcceptanceEvidence ?? [])
    .filter((review) => review.evidenceIds.length > 0 && review.evidenceIds.every((evidenceId) => availableDurableEvidenceIds.has(evidenceId)))
    .map((review) => review.criterion));
  const missingSemanticAcceptanceCriteria = requiresSemanticAcceptance
    ? work.acceptanceCriteria.filter((criterion) => !acceptedCriteria.has(criterion))
    : [];
  const semanticAcceptanceComplete = !requiresSemanticAcceptance
    || (work.acceptanceCriteria.length > 0 && missingSemanticAcceptanceCriteria.length === 0);
  const reasons: string[] = [];

  if (history.acceptanceFailures.length > 0) {
    reasons.push(`Acceptance checks failed: ${history.acceptanceFailures.join(', ')}.`);
    return { status: 'failed', history, missingChecks, durableResultEvidence, semanticAcceptanceComplete, missingSemanticAcceptanceCriteria, reasons };
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
  if (work.checks.length === 0 && !durableResultEvidence) {
    const staleWorkVerification = work.checkRefs.some((record) =>
      Boolean(record.receipt)
      && !verificationRecordAppliesToCurrentWorkspace(record, currentRevision, currentWorkspaceFingerprint));
    reasons.push(staleWorkVerification
      ? 'Work-bound verification evidence is stale for the current source/workspace identity.'
      : 'No durable result evidence (evidenceId, artifactId, or current Work-bound verification receipt) was recorded for this no-check WorkContract.');
  }
  if (requiresSemanticAcceptance && !semanticAcceptanceComplete) {
    reasons.push(work.acceptanceCriteria.length === 0
      ? 'No-check local-effect Work has no declared acceptance criteria to review.'
      : `Controller-reviewed semantic acceptance evidence is incomplete; missing criteria: ${missingSemanticAcceptanceCriteria.join(' | ')}.`);
  }

  const complete = history.infrastructureIssues.length === 0
    && history.invalidCheckIds.length === 0
    && missingChecks.length === 0
    && (work.checks.length > 0 || durableResultEvidence)
    && semanticAcceptanceComplete;
  return {
    status: complete ? 'complete' : 'incomplete',
    history,
    missingChecks,
    durableResultEvidence,
    semanticAcceptanceComplete,
    missingSemanticAcceptanceCriteria,
    reasons,
  };
}
