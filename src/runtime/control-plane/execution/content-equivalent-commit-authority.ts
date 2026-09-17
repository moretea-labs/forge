import { createHash } from 'crypto';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import {
  authoritativeImplementationReviewVerificationEvidence,
  deriveImplementationReviewAcrossCommit,
  deriveImplementationReviewAcrossContentEquivalentRevision,
  getWorkContract,
  implementationReviewChangedPathDigest,
  implementationReviewEvidenceDigest,
  latestImplementationReview,
  recordContentEquivalentCommitAuthorityTransfer,
  type ImplementationReviewCandidateIdentity,
  type WorkContract,
  type WorkImplementationReviewRecord,
} from '../../../../packages/kernel/work/api/index';
import { planWorkVerificationAcrossContentEquivalentCommit } from './work-verification-service';

export interface ReviewedContentEquivalentCommitTransferInput {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  preCommitCandidate: ImplementationReviewCandidateIdentity;
  preCommitDirtyPaths: readonly string[];
  committedPaths: readonly string[];
  preCommitContentDigest: string;
  postCommitSourceRevision: string;
  postCommitContentDigest: string;
  postCommitVerificationWorkspaceFingerprint: string;
  postCommitChangedPaths: readonly string[];
  recordedAt?: string;
}

export interface ReviewedContentEquivalentCommitTransferResult {
  transferred: boolean;
  reusedExistingTransfer: boolean;
  reusableCheckIds: string[];
  invalidatedCheckIds: string[];
  derivedReview?: WorkImplementationReviewRecord;
  contract?: WorkContract;
  recordedAt: string;
}

interface PostRevisionReviewIdentity {
  sourceRevision: string;
  contentDigest: string;
  verificationWorkspaceFingerprint: string;
  changedPaths: readonly string[];
  architectureEvidence: ImplementationReviewCandidateIdentity['architectureEvidence'];
}

function existingTransferMatches(input: PostRevisionReviewIdentity, work: WorkContract): WorkImplementationReviewRecord | undefined {
  const review = latestImplementationReview(work.implementationReviews);
  if (!review || review.derivation !== 'content_equivalent_commit' || review.decision !== 'approved') return undefined;
  if (review.sourceRevision !== input.sourceRevision
    || review.workspaceFingerprint !== input.contentDigest
    || review.verificationWorkspaceFingerprint !== input.verificationWorkspaceFingerprint
    || review.changedPathDigest !== implementationReviewChangedPathDigest(input.changedPaths)
    || implementationReviewEvidenceDigest(review.architectureEvidence) !== implementationReviewEvidenceDigest(input.architectureEvidence ?? [])) {
    return undefined;
  }
  const verification = authoritativeImplementationReviewVerificationEvidence({
    repoId: work.repoId,
    workId: work.workId,
    requiredCheckIds: work.checks,
    records: work.checkRefs,
    sourceRevision: input.sourceRevision,
    workspaceFingerprint: input.verificationWorkspaceFingerprint,
  });
  if (verification.missingCheckIds.length > 0
    || implementationReviewEvidenceDigest(verification.evidence) !== implementationReviewEvidenceDigest(review.verificationEvidence)) {
    return undefined;
  }
  return review;
}

export interface ReviewedContentEquivalentRevisionTransferInput {
  controllerHome: string;
  repository: RepositoryRecord;
  workId: string;
  preRevisionCandidate: ImplementationReviewCandidateIdentity;
  transferredVerificationRecords: Readonly<WorkContract['checkRefs']>;
  postRevisionSourceRevision: string;
  postRevisionContentDigest: string;
  postRevisionVerificationWorkspaceFingerprint: string;
  postRevisionChangedPaths: readonly string[];
  recordedAt?: string;
}

/**
 * Re-bind exact review authority after delivery-time revision reconciliation.
 * The caller owns the Git mutation and supplies only verification records whose
 * authority has already been proven transferable. This helper atomically binds
 * those records and a derived review to the same immutable post-revision candidate.
 */
export function transferReviewedWorkAuthorityAcrossContentEquivalentRevision(
  input: ReviewedContentEquivalentRevisionTransferInput,
): ReviewedContentEquivalentCommitTransferResult {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const current = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repository.repoId }, input.workId);
  if (!current || current.completionReceipt) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${input.workId}`);

  const postIdentity: PostRevisionReviewIdentity = {
    sourceRevision: input.postRevisionSourceRevision,
    contentDigest: input.postRevisionContentDigest,
    verificationWorkspaceFingerprint: input.postRevisionVerificationWorkspaceFingerprint,
    changedPaths: input.postRevisionChangedPaths,
    architectureEvidence: input.preRevisionCandidate.architectureEvidence ?? [],
  };
  const existing = existingTransferMatches(postIdentity, current);
  if (existing) {
    return {
      transferred: true,
      reusedExistingTransfer: true,
      reusableCheckIds: [...current.checks],
      invalidatedCheckIds: [],
      derivedReview: existing,
      contract: current,
      recordedAt,
    };
  }

  const plannedRecords = [...input.transferredVerificationRecords, ...current.checkRefs];
  const postVerification = authoritativeImplementationReviewVerificationEvidence({
    repoId: current.repoId,
    workId: current.workId,
    requiredCheckIds: current.checks,
    records: plannedRecords,
    sourceRevision: input.postRevisionSourceRevision,
    workspaceFingerprint: input.postRevisionVerificationWorkspaceFingerprint,
  });
  if (postVerification.missingCheckIds.length > 0) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_TRANSFER_VERIFICATION_REQUIRED: ${postVerification.missingCheckIds.join(', ')}`);
  }
  const postCandidate: ImplementationReviewCandidateIdentity = {
    sourceRevision: input.postRevisionSourceRevision,
    workspaceFingerprint: input.postRevisionContentDigest,
    verificationWorkspaceFingerprint: input.postRevisionVerificationWorkspaceFingerprint,
    changedPaths: input.postRevisionChangedPaths,
    verificationEvidence: postVerification.evidence,
    architectureEvidence: input.preRevisionCandidate.architectureEvidence ?? [],
  };
  const derivedReview = deriveImplementationReviewAcrossContentEquivalentRevision({
    workId: current.workId,
    reviews: current.implementationReviews,
    proof: {
      preRevisionCandidate: input.preRevisionCandidate,
      postRevisionCandidate: postCandidate,
      preRevisionContentDigest: input.preRevisionCandidate.workspaceFingerprint,
      postRevisionContentDigest: input.postRevisionContentDigest,
      postRevisionVerificationAuthority: {
        repoId: current.repoId,
        workId: current.workId,
        requiredCheckIds: current.checks,
        records: plannedRecords,
      },
    },
    derivedReviewId: `REV-revision-${createHash('sha256').update(`${current.workId}\0${input.postRevisionSourceRevision}\0${input.postRevisionContentDigest}`).digest('hex').slice(0, 20)}`,
    recordedAt,
  });
  const contract = recordContentEquivalentCommitAuthorityTransfer(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
    {
      transferredVerificationRecords: [...input.transferredVerificationRecords],
      derivedReview,
    },
  );
  return {
    transferred: true,
    reusedExistingTransfer: false,
    reusableCheckIds: [...current.checks],
    invalidatedCheckIds: [],
    derivedReview,
    contract,
    recordedAt,
  };
}

/**
 * The single control-plane owner for representation-only commit authority
 * transfer. Planning is side-effect free; persistence happens only after the
 * exact post-commit verification and review derivation proof both succeed.
 */
export function transferReviewedWorkAuthorityAcrossContentEquivalentCommit(
  input: ReviewedContentEquivalentCommitTransferInput,
): ReviewedContentEquivalentCommitTransferResult {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const current = getWorkContract({ controllerHome: input.controllerHome, repoId: input.repository.repoId }, input.workId);
  if (!current || current.completionReceipt) throw new Error(`WORK_IMPLEMENTATION_REVIEW_CONTRACT_REQUIRED: ${input.workId}`);

  const existing = existingTransferMatches({
    sourceRevision: input.postCommitSourceRevision,
    contentDigest: input.postCommitContentDigest,
    verificationWorkspaceFingerprint: input.postCommitVerificationWorkspaceFingerprint,
    changedPaths: input.postCommitChangedPaths,
    architectureEvidence: input.preCommitCandidate.architectureEvidence ?? [],
  }, current);
  if (existing) {
    return {
      transferred: true,
      reusedExistingTransfer: true,
      reusableCheckIds: [...current.checks],
      invalidatedCheckIds: [],
      derivedReview: existing,
      contract: current,
      recordedAt,
    };
  }

  const verificationPlan = planWorkVerificationAcrossContentEquivalentCommit({
    controllerHome: input.controllerHome,
    repository: input.repository,
    workId: input.workId,
    preCommitSourceRevision: input.preCommitCandidate.sourceRevision,
    preCommitWorkspaceFingerprint: input.preCommitCandidate.verificationWorkspaceFingerprint,
    postCommitSourceRevision: input.postCommitSourceRevision,
    postCommitWorkspaceFingerprint: input.postCommitVerificationWorkspaceFingerprint,
    recordedAt,
  });
  if (verificationPlan.invalidatedCheckIds.length > 0) {
    return {
      transferred: false,
      reusedExistingTransfer: false,
      reusableCheckIds: verificationPlan.reusableCheckIds,
      invalidatedCheckIds: verificationPlan.invalidatedCheckIds,
      recordedAt,
    };
  }

  const plannedRecords = [...verificationPlan.transferredRecords, ...current.checkRefs];
  const postVerification = authoritativeImplementationReviewVerificationEvidence({
    repoId: current.repoId,
    workId: current.workId,
    requiredCheckIds: current.checks,
    records: plannedRecords,
    sourceRevision: input.postCommitSourceRevision,
    workspaceFingerprint: input.postCommitVerificationWorkspaceFingerprint,
  });
  if (postVerification.missingCheckIds.length > 0) {
    throw new Error(`WORK_IMPLEMENTATION_REVIEW_TRANSFER_VERIFICATION_REQUIRED: ${postVerification.missingCheckIds.join(', ')}`);
  }
  const postCandidate: ImplementationReviewCandidateIdentity = {
    sourceRevision: input.postCommitSourceRevision,
    workspaceFingerprint: input.postCommitContentDigest,
    verificationWorkspaceFingerprint: input.postCommitVerificationWorkspaceFingerprint,
    changedPaths: input.postCommitChangedPaths,
    verificationEvidence: postVerification.evidence,
    architectureEvidence: input.preCommitCandidate.architectureEvidence ?? [],
  };
  const derivedReview = deriveImplementationReviewAcrossCommit({
    workId: current.workId,
    reviews: current.implementationReviews,
    proof: {
      preCommitCandidate: input.preCommitCandidate,
      postCommitCandidate: postCandidate,
      preCommitDirtyPaths: input.preCommitDirtyPaths,
      committedPaths: input.committedPaths,
      preCommitContentDigest: input.preCommitContentDigest,
      postCommitContentDigest: input.postCommitContentDigest,
      postCommitVerificationAuthority: {
        repoId: current.repoId,
        workId: current.workId,
        requiredCheckIds: current.checks,
        records: plannedRecords,
      },
    },
    derivedReviewId: `REV-commit-${createHash('sha256').update(`${current.workId}\0${input.postCommitSourceRevision}\0${input.postCommitContentDigest}`).digest('hex').slice(0, 20)}`,
    recordedAt,
  });
  const contract = recordContentEquivalentCommitAuthorityTransfer(
    { controllerHome: input.controllerHome, repoId: input.repository.repoId },
    input.workId,
    {
      transferredVerificationRecords: verificationPlan.transferredRecords,
      derivedReview,
    },
  );
  return {
    transferred: true,
    reusedExistingTransfer: false,
    reusableCheckIds: verificationPlan.reusableCheckIds,
    invalidatedCheckIds: [],
    derivedReview,
    contract,
    recordedAt,
  };
}
