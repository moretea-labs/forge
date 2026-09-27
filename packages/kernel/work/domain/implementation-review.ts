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
 * Historical implementation-review evidence captured before the Thin cutover.
 * Records remain immutable/readable for audit, but never authorize or block
 * execution, Git delivery, checks, or semantic Work completion.
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

function normalizedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizedStrings(left);
  const b = normalizedStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
 * Candidate review gate. Low engineering-risk delivery relies on exact durable
 * completion evidence and may skip a separate Controller review round; normal,
 * high, and critical repository candidates retain the exact review authority.
 * Source-free effect/investigation/reconciliation Work may also skip review only
 * while they truly have no repository source delta.
 */
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
