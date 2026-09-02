import { createHash } from 'crypto';

export const IMPLEMENTATION_REVIEW_DECISIONS = ['approved', 'changes_required', 'blocked'] as const;
export const MAX_IMPLEMENTATION_REVIEW_HISTORY = 256;
export type ImplementationReviewDecision = (typeof IMPLEMENTATION_REVIEW_DECISIONS)[number];

export const IMPLEMENTATION_REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type ImplementationReviewFindingSeverity = (typeof IMPLEMENTATION_REVIEW_FINDING_SEVERITIES)[number];

export interface WorkImplementationReviewFinding {
  severity: ImplementationReviewFindingSeverity;
  category: string;
  summary: string;
  path?: string;
  symbol?: string;
}

export interface WorkImplementationReviewEvidenceIdentity {
  evidenceId: string;
  digest: string;
}

/**
 * Durable Controller review authority for one exact Work delivery candidate.
 * Historical records are immutable. The latest exact source-bound record is the
 * only current review authority; a gateway string or passing check is never one.
 */
export interface WorkImplementationReviewRecord {
  schemaVersion: 1;
  reviewId: string;
  workId: string;
  reviewerPrincipalId: string;
  reviewerControllerSessionId?: string;
  reviewerControllerRoundId?: string;
  decision: ImplementationReviewDecision;
  rationale: string;
  findings: WorkImplementationReviewFinding[];
  sourceRevision: string;
  workspaceFingerprint: string;
  /** Exact verification-input workspace identity reviewed before Git representation changes. */
  verificationWorkspaceFingerprint: string;
  changedPaths: string[];
  changedPathDigest: string;
  acceptanceCriteriaSummary: string;
  verificationEvidence: WorkImplementationReviewEvidenceIdentity[];
  architectureEvidence: WorkImplementationReviewEvidenceIdentity[];
  recordedAt: string;
  /** Present only when Forge derived an approval from a proven content-equivalent commit. */
  derivedFromReviewId?: string;
  derivation?: 'content_equivalent_commit';
}

export interface ImplementationReviewVerificationReceipt {
  receiptId: string;
  resultDigest: string;
  repoId: string;
  workId?: string;
  checkId: string;
  status: string;
  runtimeStatus: string;
  ok: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface ImplementationReviewVerificationRecord {
  checkId: string;
  outcome: string;
  recordedAt: string;
  sourceRevision?: string;
  workspaceFingerprint?: string;
  resultArtifactId?: string;
  verificationInputFingerprint?: string;
  receipt?: ImplementationReviewVerificationReceipt;
}

/**
 * Return the exact current verification receipt identities required by review.
 * Legacy/weak pass text is intentionally insufficient: every declared check
 * must have a current Work-bound successful Process receipt.
 */
export function authoritativeImplementationReviewVerificationEvidence(input: {
  repoId: string;
  workId: string;
  requiredCheckIds: readonly string[];
  records: readonly ImplementationReviewVerificationRecord[];
  sourceRevision: string;
  workspaceFingerprint: string;
}): { evidence: WorkImplementationReviewEvidenceIdentity[]; missingCheckIds: string[] } {
  const evidence: WorkImplementationReviewEvidenceIdentity[] = [];
  const missingCheckIds: string[] = [];
  for (const checkId of normalizedStrings(input.requiredCheckIds)) {
    // Work checkRefs are durable newest-first history. Select the newest exact
    // source/input record regardless of outcome; a newer fail/infrastructure
    // result must invalidate an older pass rather than being filtered away.
    const current = input.records.find((record) =>
      record.checkId === checkId
      && record.sourceRevision === input.sourceRevision
      && record.workspaceFingerprint === input.workspaceFingerprint);
    const receipt = current?.receipt;
    const authoritativePass = Boolean(
      current?.outcome === 'valid_pass'
      && receipt
      && receipt.repoId === input.repoId
      && receipt.workId === input.workId
      && receipt.checkId === checkId
      && receipt.ok === true
      && receipt.timedOut === false
      && receipt.cancelled === false
      && receipt.status === 'passed'
      && receipt.runtimeStatus === 'succeeded',
    );
    const evidenceId = authoritativePass ? receipt!.receiptId : undefined;
    const digest = authoritativePass ? receipt!.resultDigest : undefined;
    if (!evidenceId?.trim() || !digest?.trim()) missingCheckIds.push(checkId);
    else evidence.push({ evidenceId: evidenceId.trim(), digest: digest.trim() });
  }
  return { evidence: normalizeImplementationReviewEvidence(evidence), missingCheckIds };
}

export interface ImplementationReviewCandidateIdentity {
  sourceRevision: string;
  /** Stage-insensitive identity of the exact reviewed filesystem content. */
  workspaceFingerprint: string;
  /** Existing verification-input identity; may change when Git representation changes. */
  verificationWorkspaceFingerprint: string;
  changedPaths: readonly string[];
  verificationEvidence: readonly WorkImplementationReviewEvidenceIdentity[];
  architectureEvidence?: readonly WorkImplementationReviewEvidenceIdentity[];
}

export type ImplementationReviewGateCode =
  | 'WORK_IMPLEMENTATION_REVIEW_REQUIRED'
  | 'WORK_IMPLEMENTATION_REVIEW_STALE'
  | 'WORK_IMPLEMENTATION_REVIEW_CHANGES_REQUIRED'
  | 'WORK_IMPLEMENTATION_REVIEW_BLOCKED';

export interface ImplementationReviewGateResult {
  required: boolean;
  approved: boolean;
  code?: ImplementationReviewGateCode;
  reason: string;
  review?: WorkImplementationReviewRecord;
}

function normalizedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeImplementationReviewEvidence(
  values: readonly WorkImplementationReviewEvidenceIdentity[],
): WorkImplementationReviewEvidenceIdentity[] {
  const byId = new Map<string, string>();
  for (const value of values) {
    const evidenceId = value.evidenceId.trim();
    const digest = value.digest.trim();
    if (!evidenceId || !digest) throw new Error('WORK_IMPLEMENTATION_REVIEW_EVIDENCE_IDENTITY_REQUIRED');
    const prior = byId.get(evidenceId);
    if (prior && prior !== digest) throw new Error(`WORK_IMPLEMENTATION_REVIEW_EVIDENCE_ID_CONFLICT: ${evidenceId}`);
    byId.set(evidenceId, digest);
  }
  return [...byId.entries()].map(([evidenceId, digest]) => ({ evidenceId, digest }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId) || left.digest.localeCompare(right.digest));
}

function sameEvidenceIdentity(
  left: readonly WorkImplementationReviewEvidenceIdentity[],
  right: readonly WorkImplementationReviewEvidenceIdentity[],
): boolean {
  const a = normalizeImplementationReviewEvidence(left);
  const b = normalizeImplementationReviewEvidence(right);
  return a.length === b.length && a.every((entry, index) => entry.evidenceId === b[index]!.evidenceId && entry.digest === b[index]!.digest);
}

export function normalizeImplementationReviewChangedPaths(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  for (const path of normalized) {
    if (path.startsWith('/') || path.includes('\0') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`WORK_IMPLEMENTATION_REVIEW_PATH_INVALID: ${path}`);
    }
  }
  return normalizedStrings(normalized);
}

export function implementationReviewChangedPathDigest(paths: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeImplementationReviewChangedPaths(paths)))
    .digest('hex');
}

export function implementationReviewEvidenceDigest(values: readonly WorkImplementationReviewEvidenceIdentity[]): string {
  return createHash('sha256').update(JSON.stringify(normalizeImplementationReviewEvidence(values))).digest('hex');
}

export function latestImplementationReview(
  reviews: readonly WorkImplementationReviewRecord[] | undefined,
): WorkImplementationReviewRecord | undefined {
  if (!reviews?.length) return undefined;
  // Durable append order is the review authority order. Wall-clock timestamps
  // are audit metadata and must never reorder Controller decisions under clock skew.
  return reviews[reviews.length - 1];
}

/**
 * Work-kind gate. Source-free effect/investigation/reconciliation Work may skip
 * code review only while they truly have no repository source delta.
 */
export function workRequiresImplementationReview(workKind: string, changedPaths: readonly string[]): boolean {
  if (workKind === 'read_only_review' || workKind === 'superseded') return false;
  if (workKind === 'repository_change' || workKind === 'completed_no_change') return true;
  return normalizeImplementationReviewChangedPaths(changedPaths).length > 0;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizedStrings(left);
  const b = normalizedStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function validateImplementationReviewRecord(review: WorkImplementationReviewRecord): void {
  if (!review.reviewId.trim() || !review.workId.trim() || !review.reviewerPrincipalId.trim() || !review.recordedAt.trim()) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_IDENTITY_REQUIRED');
  }
  if (!IMPLEMENTATION_REVIEW_DECISIONS.includes(review.decision)) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_DECISION_REQUIRED');
  }
  if (!review.rationale.trim() || !review.acceptanceCriteriaSummary.trim()) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_RATIONALE_REQUIRED');
  }
  if (!review.sourceRevision.trim() || !review.workspaceFingerprint.trim() || !review.verificationWorkspaceFingerprint.trim()) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_SOURCE_IDENTITY_REQUIRED');
  }
  const changedPaths = normalizeImplementationReviewChangedPaths(review.changedPaths);
  if (!sameStringSet(review.changedPaths, changedPaths) || review.changedPaths.length !== changedPaths.length) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_CHANGED_PATHS_NOT_CANONICAL');
  }
  if (review.changedPathDigest !== implementationReviewChangedPathDigest(changedPaths)) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_CHANGED_PATH_IDENTITY_MISMATCH');
  }
  if (Number.isNaN(Date.parse(review.recordedAt))) throw new Error('WORK_IMPLEMENTATION_REVIEW_RECORDED_AT_INVALID');
  const verificationEvidence = normalizeImplementationReviewEvidence(review.verificationEvidence);
  const architectureEvidence = normalizeImplementationReviewEvidence(review.architectureEvidence);
  if (!sameEvidenceIdentity(review.verificationEvidence, verificationEvidence)
    || review.verificationEvidence.length !== verificationEvidence.length
    || !sameEvidenceIdentity(review.architectureEvidence, architectureEvidence)
    || review.architectureEvidence.length !== architectureEvidence.length) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_EVIDENCE_NOT_CANONICAL');
  }
  for (const finding of review.findings) {
    if (!IMPLEMENTATION_REVIEW_FINDING_SEVERITIES.includes(finding.severity) || !finding.category.trim() || !finding.summary.trim()) {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_FINDING_INVALID');
    }
    if (finding.path) normalizeImplementationReviewChangedPaths([finding.path]);
  }
  if (review.decision === 'changes_required' && review.findings.length === 0) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_FINDINGS_REQUIRED');
  }
  if (review.derivation && (!review.derivedFromReviewId || review.decision !== 'approved')) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_DERIVATION_INVALID');
  }
  if (review.derivedFromReviewId && review.derivation !== 'content_equivalent_commit') {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_DERIVATION_INVALID');
  }
}

/**
 * Evaluate current review authority without mutating history. Candidate identity
 * is checked before the decision so negative records also become historical when
 * source/evidence changes instead of remaining a permanent blocker.
 */
export function evaluateImplementationReviewGate(input: {
  workKind: string;
  reviews?: readonly WorkImplementationReviewRecord[];
  candidate: ImplementationReviewCandidateIdentity;
}): ImplementationReviewGateResult {
  const required = workRequiresImplementationReview(input.workKind, input.candidate.changedPaths);
  if (!required) {
    return { required: false, approved: true, reason: 'Implementation review is not required for this source-free Work candidate.' };
  }

  const review = latestImplementationReview(input.reviews);
  if (!review) {
    return {
      required: true,
      approved: false,
      code: 'WORK_IMPLEMENTATION_REVIEW_REQUIRED',
      reason: 'No durable implementation review exists for this Work delivery candidate.',
    };
  }

  const staleReasons: string[] = [];
  if (review.sourceRevision !== input.candidate.sourceRevision) staleReasons.push('source revision changed');
  if (review.workspaceFingerprint !== input.candidate.workspaceFingerprint) staleReasons.push('workspace content fingerprint changed');
  if (review.verificationWorkspaceFingerprint !== input.candidate.verificationWorkspaceFingerprint) staleReasons.push('verification workspace identity changed');
  if (review.changedPathDigest !== implementationReviewChangedPathDigest(input.candidate.changedPaths)) staleReasons.push('changed-path identity changed');
  if (!sameEvidenceIdentity(review.verificationEvidence, input.candidate.verificationEvidence)) staleReasons.push('verification evidence identity changed');
  if (!sameEvidenceIdentity(review.architectureEvidence, input.candidate.architectureEvidence ?? [])) staleReasons.push('architecture evidence identity changed');
  if (staleReasons.length > 0) {
    return {
      required: true,
      approved: false,
      code: 'WORK_IMPLEMENTATION_REVIEW_STALE',
      reason: `Implementation review ${review.reviewId} is stale: ${staleReasons.join('; ')}.`,
      review,
    };
  }

  if (review.decision === 'changes_required') {
    return {
      required: true,
      approved: false,
      code: 'WORK_IMPLEMENTATION_REVIEW_CHANGES_REQUIRED',
      reason: `Implementation review ${review.reviewId} requires changes before delivery.`,
      review,
    };
  }
  if (review.decision === 'blocked') {
    return {
      required: true,
      approved: false,
      code: 'WORK_IMPLEMENTATION_REVIEW_BLOCKED',
      reason: `Implementation review ${review.reviewId} is blocked and cannot authorize delivery.`,
      review,
    };
  }
  return {
    required: true,
    approved: true,
    reason: `Implementation review ${review.reviewId} approves the exact current delivery candidate.`,
    review,
  };
}


/**
 * Canonical semantic/physical pre-delivery gate. It re-selects the newest exact
 * Work-bound check records, so a later fail cannot hide behind review-time ids.
 */
export function assertImplementationReviewPreDeliveryBoundary(input: {
  repoId: string;
  workId: string;
  workKind: string;
  reviews?: readonly WorkImplementationReviewRecord[];
  candidate: ImplementationReviewCandidateIdentity;
  requiredCheckIds: readonly string[];
  verificationRecords: readonly ImplementationReviewVerificationRecord[];
}): WorkImplementationReviewRecord | undefined {
  const verification = authoritativeImplementationReviewVerificationEvidence({
    repoId: input.repoId,
    workId: input.workId,
    requiredCheckIds: input.requiredCheckIds,
    records: input.verificationRecords,
    sourceRevision: input.candidate.sourceRevision,
    workspaceFingerprint: input.candidate.verificationWorkspaceFingerprint,
  });
  if (verification.missingCheckIds.length > 0
    || !sameEvidenceIdentity(verification.evidence, input.candidate.verificationEvidence)) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_VERIFICATION_REQUIRED: ${verification.missingCheckIds.join(', ')}`);
  }
  const gate = evaluateImplementationReviewGate({ workKind: input.workKind, reviews: input.reviews, candidate: input.candidate });
  if (!gate.approved) throw new Error(`${gate.code ?? 'WORK_IMPLEMENTATION_REVIEW_REQUIRED'}: ${gate.reason}`);
  if (gate.review && gate.review.workId !== input.workId) throw new Error('WORK_IMPLEMENTATION_REVIEW_WORK_MISMATCH');
  return gate.review;
}


/** Existing review history is immutable and append-only even for internal Work transitions. */
export function assertImplementationReviewHistoryAppendOnly(
  current: readonly WorkImplementationReviewRecord[] | undefined,
  next: readonly WorkImplementationReviewRecord[] | undefined,
): void {
  const before = current ?? [];
  const after = next ?? [];
  if (after.length < before.length) throw new Error('WORK_IMPLEMENTATION_REVIEW_HISTORY_IMMUTABLE');
  if (after.length > MAX_IMPLEMENTATION_REVIEW_HISTORY) {
    // Never discard old review authority to enforce a storage bound. Stop and
    // require an explicit archival/migration design instead.
    throw new Error('WORK_IMPLEMENTATION_REVIEW_HISTORY_LIMIT');
  }
  const ids = new Set<string>();
  for (let index = 0; index < after.length; index += 1) {
    const record = after[index];
    validateImplementationReviewRecord(record);
    if (ids.has(record.reviewId)) throw new Error('WORK_IMPLEMENTATION_REVIEW_ID_CONFLICT');
    ids.add(record.reviewId);
    if (index < before.length && JSON.stringify(before[index]) !== JSON.stringify(record)) {
      throw new Error('WORK_IMPLEMENTATION_REVIEW_HISTORY_IMMUTABLE');
    }
  }
}

export function implementationReviewDecisionTarget(
  decision: ImplementationReviewDecision,
): { phase: 'implementation' | 'review' | 'delivery'; status: 'running' | 'blocked' } {
  if (decision === 'approved') return { phase: 'delivery', status: 'running' };
  if (decision === 'changes_required') return { phase: 'implementation', status: 'running' };
  return { phase: 'review', status: 'blocked' };
}

export interface ContentEquivalentCommitTransferProof {
  preCommitCandidate: ImplementationReviewCandidateIdentity;
  postCommitCandidate: ImplementationReviewCandidateIdentity;
  /** Exact dirty Work-owned path set Forge intended to materialize in this commit. */
  preCommitDirtyPaths: readonly string[];
  /** Exact path set actually changed by the resulting commit. */
  committedPaths: readonly string[];
  /** Digest over the complete reviewed Work changed-path content before/after commit. */
  preCommitContentDigest: string;
  postCommitContentDigest: string;
  /** Exact post-commit verification authority. The derivation re-checks it; callers cannot self-certify with a boolean. */
  postCommitVerificationAuthority: {
    repoId: string;
    workId: string;
    requiredCheckIds: readonly string[];
    records: readonly ImplementationReviewVerificationRecord[];
  };
}

/**
 * Derive approval across a Forge-owned commit only. The caller must prove that
 * the commit changed representation, not reviewed Work content or scope.
 */
export function deriveImplementationReviewAcrossCommit(input: {
  workId: string;
  reviews: readonly WorkImplementationReviewRecord[];
  proof: ContentEquivalentCommitTransferProof;
  derivedReviewId: string;
  recordedAt: string;
}): WorkImplementationReviewRecord {
  const gate = evaluateImplementationReviewGate({
    workKind: 'repository_change',
    reviews: input.reviews,
    candidate: input.proof.preCommitCandidate,
  });
  if (!gate.approved || !gate.review) {
    throw new Error(`${gate.code ?? 'WORK_IMPLEMENTATION_REVIEW_REQUIRED'}: ${gate.reason}`);
  }
  if (gate.review.workId !== input.workId) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_WORK_MISMATCH');
  }
  const postVerification = authoritativeImplementationReviewVerificationEvidence({
    repoId: input.proof.postCommitVerificationAuthority.repoId,
    workId: input.proof.postCommitVerificationAuthority.workId,
    requiredCheckIds: input.proof.postCommitVerificationAuthority.requiredCheckIds,
    records: input.proof.postCommitVerificationAuthority.records,
    sourceRevision: input.proof.postCommitCandidate.sourceRevision,
    workspaceFingerprint: input.proof.postCommitCandidate.verificationWorkspaceFingerprint,
  });
  if (postVerification.missingCheckIds.length > 0
    || !sameEvidenceIdentity(postVerification.evidence, input.proof.postCommitCandidate.verificationEvidence)) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_VERIFICATION_REQUIRED');
  }
  if (input.proof.postCommitVerificationAuthority.workId !== input.workId) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_WORK_MISMATCH');
  }
  if (!input.proof.preCommitContentDigest.trim() || !input.proof.postCommitContentDigest.trim()) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_CONTENT_IDENTITY_REQUIRED');
  }
  if (input.proof.preCommitContentDigest !== input.proof.preCommitCandidate.workspaceFingerprint
    || input.proof.postCommitContentDigest !== input.proof.postCommitCandidate.workspaceFingerprint) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_CONTENT_IDENTITY_MISMATCH');
  }
  if (input.proof.preCommitContentDigest !== input.proof.postCommitContentDigest) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_CONTENT_CHANGED');
  }

  const reviewedPaths = normalizeImplementationReviewChangedPaths(gate.review.changedPaths);
  const postPaths = normalizeImplementationReviewChangedPaths(input.proof.postCommitCandidate.changedPaths);
  const dirtyPaths = normalizeImplementationReviewChangedPaths(input.proof.preCommitDirtyPaths);
  const committedPaths = normalizeImplementationReviewChangedPaths(input.proof.committedPaths);
  if (!sameStringSet(reviewedPaths, postPaths)) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_CHANGED_PATHS_MISMATCH');
  }
  if (!sameEvidenceIdentity(gate.review.architectureEvidence, input.proof.postCommitCandidate.architectureEvidence ?? [])) {
    // A representation-only commit may transfer existing architecture review
    // evidence, but it cannot add/drop architecture evidence without a new review.
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_ARCHITECTURE_EVIDENCE_CHANGED');
  }
  const reviewedSet = new Set(reviewedPaths);
  const dirtyOutsideReview = dirtyPaths.filter((path) => !reviewedSet.has(path));
  if (dirtyOutsideReview.length > 0) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_TRANSFER_UNREVIEWED_DIRTY_PATH: ${dirtyOutsideReview.join(', ')}`);
  }
  // A controlled representation-only commit must materialize the complete
  // reviewed changed-path set. Allowing a caller-supplied dirty subset would
  // leave reviewed content in the workspace while moving sourceRevision,
  // creating a mixed committed/dirty candidate that the original approval did
  // not authorize.
  if (!sameStringSet(dirtyPaths, reviewedPaths) || !sameStringSet(committedPaths, reviewedPaths)) {
    throw new Error('WORK_IMPLEMENTATION_REVIEW_TRANSFER_COMMIT_SCOPE_MISMATCH');
  }

  const derived: WorkImplementationReviewRecord = {
    ...gate.review,
    reviewId: input.derivedReviewId,
    sourceRevision: input.proof.postCommitCandidate.sourceRevision,
    workspaceFingerprint: input.proof.postCommitCandidate.workspaceFingerprint,
    verificationWorkspaceFingerprint: input.proof.postCommitCandidate.verificationWorkspaceFingerprint,
    changedPaths: postPaths,
    changedPathDigest: implementationReviewChangedPathDigest(postPaths),
    verificationEvidence: normalizeImplementationReviewEvidence(input.proof.postCommitCandidate.verificationEvidence),
    architectureEvidence: normalizeImplementationReviewEvidence(input.proof.postCommitCandidate.architectureEvidence ?? []),
    recordedAt: input.recordedAt,
    derivedFromReviewId: gate.review.reviewId,
    derivation: 'content_equivalent_commit',
  };
  validateImplementationReviewRecord(derived);
  return derived;
}
