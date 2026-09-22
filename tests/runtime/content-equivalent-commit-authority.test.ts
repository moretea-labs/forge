import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../../src/cli/repositories/registry';
import { repositoryGitStatus } from '../../src/cli/repositories/structured-git';
import {
  appendVerificationRecord,
  createWorkContract,
  getWorkContract,
  recordContentEquivalentCommitAuthorityTransfer,
  recordWorkEvidenceState,
  recordWorkImplementationReview,
  requestWorkImplementationReview,
  transitionWorkContractPhase,
  updateWorkContract,
} from '../../packages/kernel/work/api/index';
import {
  implementationReviewChangedPathDigest,
  type WorkImplementationReviewRecord,
} from '../../packages/kernel/work/api/index';
import { implementationReviewContentFingerprint } from '../../src/runtime/control-plane/execution/implementation-review-content';
import { verificationInputFingerprint, workspaceValidationFingerprint } from '../../src/runtime/control-plane/execution/verification-evidence';
import { transferReviewedWorkAuthorityAcrossContentEquivalentRevision } from '../../src/runtime/control-plane/execution/content-equivalent-commit-authority';
import type { VerificationRecord } from '../../packages/kernel/work/api/index';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-content-transfer-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-content-transfer-home-'));
  roots.push(repoRoot, controllerHome);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'example.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'example.ts'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repoRoot });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  const workId = 'work-content-transfer-atomic';
  const checkId = 'check:atomic-transfer';
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  createWorkContract({ controllerHome, repoId: repository.repoId }, {
    workId,
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    baseRevision: sourceRevision,
    mode: 'direct_control',
    objective: 'Prove content-equivalent commit authority transfer is atomic.',
    acceptanceCriteria: ['No partial post-commit authority persists on failure.'],
    allowedPaths: ['example.ts'],
    forbiddenPaths: [],
    checks: [checkId],
    constraints: { requireHandoffOnAmbiguity: true },
    requestedBy: 'chatgpt',
    workKind: 'repository_change',
    status: 'running',
    phase: 'verification',
  });
  return { repoRoot, controllerHome, repository, workId, checkId, sourceRevision };
}

function verificationRecord(input: {
  repoId: string;
  checkoutId: string;
  workId: string;
  checkId: string;
  sourceRevision: string;
  workspaceFingerprint: string;
  receiptId: string;
}): VerificationRecord {
  const recordedAt = new Date().toISOString();
  return {
    checkId: input.checkId,
    outcome: 'valid_pass',
    summary: 'exact verification fixture',
    recordedAt,
    sourceRevision: input.sourceRevision,
    workspaceFingerprint: input.workspaceFingerprint,
    verificationInputFingerprint: verificationInputFingerprint({
      sourceRevision: input.sourceRevision,
      workspaceFingerprint: input.workspaceFingerprint,
      checkId: input.checkId,
      requestedChecks: [input.checkId],
    }),
    receipt: {
      schemaVersion: 1,
      receiptId: input.receiptId,
      resultDigest: `digest-${input.receiptId}`,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      workId: input.workId,
      checkId: input.checkId,
      processId: `process-${input.receiptId}`,
      commandId: input.checkId,
      status: 'passed',
      runtimeStatus: 'succeeded',
      ok: true,
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      artifactPath: `.ai/harness/checks/${input.receiptId}.json`,
      summary: 'exact verification fixture',
      startedAt: recordedAt,
      finishedAt: recordedAt,
    },
  };
}

describe('content-equivalent commit authority transfer', () => {
  test('does not persist transferred verification when derived-review evidence is invalid', () => {
    const fx = fixture();
    const preStatus = repositoryGitStatus(fx.repository);
    const preWorkspace = workspaceValidationFingerprint(fx.repoRoot, preStatus);
    const preContent = implementationReviewContentFingerprint(fx.repoRoot, ['example.ts']);
    const preRecord = verificationRecord({
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      workId: fx.workId,
      checkId: fx.checkId,
      sourceRevision: fx.sourceRevision,
      workspaceFingerprint: preWorkspace,
      receiptId: 'receipt-pre',
    });
    appendVerificationRecord({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, preRecord);
    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, {
      phase: 'verification', status: 'running', state: 'satisfied', summary: 'Pre-commit verification passed.',
    });
    recordWorkEvidenceState({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, 'valid');
    requestWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, 'Review exact pre-commit candidate.');
    const parent: WorkImplementationReviewRecord = {
      schemaVersion: 1,
      reviewId: 'review-parent',
      workId: fx.workId,
      reviewerPrincipalId: 'test-reviewer',
      decision: 'approved',
      rationale: 'Exact candidate approved.',
      findings: [],
      sourceRevision: fx.sourceRevision,
      workspaceFingerprint: preContent,
      verificationWorkspaceFingerprint: preWorkspace,
      changedPaths: ['example.ts'],
      changedPathDigest: implementationReviewChangedPathDigest(['example.ts']),
      acceptanceCriteriaSummary: 'Exact candidate approved.',
      verificationEvidence: [{ evidenceId: 'receipt-pre', digest: 'digest-receipt-pre' }],
      architectureEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, parent);

    writeFileSync(join(fx.repoRoot, 'example.ts'), 'export const value = 2;\n');
    execFileSync('git', ['add', 'example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'content-equivalent representation'], { cwd: fx.repoRoot });
    const postRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const postWorkspace = workspaceValidationFingerprint(fx.repoRoot, repositoryGitStatus(fx.repository));
    const postRecord = verificationRecord({
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      workId: fx.workId,
      checkId: fx.checkId,
      sourceRevision: postRevision,
      workspaceFingerprint: postWorkspace,
      receiptId: 'receipt-post',
    });
    const before = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId)!;
    const derived: WorkImplementationReviewRecord = {
      ...parent,
      reviewId: 'review-derived-invalid',
      sourceRevision: postRevision,
      verificationWorkspaceFingerprint: postWorkspace,
      verificationEvidence: [{ evidenceId: 'wrong-receipt', digest: 'wrong-digest' }],
      recordedAt: new Date().toISOString(),
      derivedFromReviewId: parent.reviewId,
      derivation: 'content_equivalent_commit',
    };

    expect(() => recordContentEquivalentCommitAuthorityTransfer(
      { controllerHome: fx.controllerHome, repoId: fx.repository.repoId },
      fx.workId,
      { transferredVerificationRecords: [postRecord], derivedReview: derived },
    )).toThrow('WORK_IMPLEMENTATION_REVIEW_TRANSFER_VERIFICATION_IDENTITY_MISMATCH');

    const after = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId)!;
    expect(after.checkRefs).toEqual(before.checkRefs);
    expect(after.implementationReviews).toEqual(before.implementationReviews);
    expect(after.phase).toBe(before.phase);
    expect(after.evidenceState).toBe(before.evidenceState);
  });
});


describe('content-equivalent revision authority transfer', () => {
  test('rebinds exact review authority when revision identity changes but reviewed content and scope do not', () => {
    const fx = fixture();
    writeFileSync(join(fx.repoRoot, 'example.ts'), 'export const value = 2;\n');
    const preStatus = repositoryGitStatus(fx.repository);
    const preWorkspace = workspaceValidationFingerprint(fx.repoRoot, preStatus);
    const contentDigest = implementationReviewContentFingerprint(fx.repoRoot, ['example.ts']);
    const preRecord = verificationRecord({
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      workId: fx.workId,
      checkId: fx.checkId,
      sourceRevision: fx.sourceRevision,
      workspaceFingerprint: preWorkspace,
      receiptId: 'receipt-revision-pre',
    });
    appendVerificationRecord({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, preRecord);
    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, {
      phase: 'verification', status: 'running', state: 'satisfied', summary: 'Pre-revision verification passed.',
    });
    recordWorkEvidenceState({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, 'valid');
    requestWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, 'Review exact pre-revision candidate.');
    const parent: WorkImplementationReviewRecord = {
      schemaVersion: 1,
      reviewId: 'review-revision-parent',
      workId: fx.workId,
      reviewerPrincipalId: 'test-reviewer',
      decision: 'approved',
      rationale: 'Exact pre-revision candidate approved.',
      findings: [],
      sourceRevision: fx.sourceRevision,
      workspaceFingerprint: contentDigest,
      verificationWorkspaceFingerprint: preWorkspace,
      changedPaths: ['example.ts'],
      changedPathDigest: implementationReviewChangedPathDigest(['example.ts']),
      acceptanceCriteriaSummary: 'Exact pre-revision candidate approved.',
      verificationEvidence: [{ evidenceId: 'receipt-revision-pre', digest: 'digest-receipt-revision-pre' }],
      architectureEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, parent);

    execFileSync('git', ['add', 'example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'materialize reviewed content'], { cwd: fx.repoRoot });
    const postRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const postWorkspace = workspaceValidationFingerprint(fx.repoRoot, repositoryGitStatus(fx.repository));
    expect(implementationReviewContentFingerprint(fx.repoRoot, ['example.ts'])).toBe(contentDigest);
    const postRecord = verificationRecord({
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      workId: fx.workId,
      checkId: fx.checkId,
      sourceRevision: postRevision,
      workspaceFingerprint: postWorkspace,
      receiptId: 'receipt-revision-post',
    });

    const transferred = transferReviewedWorkAuthorityAcrossContentEquivalentRevision({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      workId: fx.workId,
      preRevisionCandidate: {
        sourceRevision: parent.sourceRevision,
        workspaceFingerprint: parent.workspaceFingerprint,
        verificationWorkspaceFingerprint: parent.verificationWorkspaceFingerprint,
        changedPaths: parent.changedPaths,
        verificationEvidence: parent.verificationEvidence,
        architectureEvidence: parent.architectureEvidence,
      },
      transferredVerificationRecords: [postRecord],
      postRevisionSourceRevision: postRevision,
      postRevisionContentDigest: contentDigest,
      postRevisionVerificationWorkspaceFingerprint: postWorkspace,
      postRevisionChangedPaths: ['example.ts'],
    });

    expect(transferred.transferred).toBe(true);
    expect(transferred.reusedExistingTransfer).toBe(false);
    expect(transferred.invalidatedCheckIds).toEqual([]);
    const derivedReview = transferred.derivedReview;
    expect(derivedReview).toBeDefined();
    if (!derivedReview) throw new Error('Expected a derived review for a successful content-equivalent revision transfer.');
    expect(derivedReview.sourceRevision).toBe(postRevision);
    expect(derivedReview.workspaceFingerprint).toBe(contentDigest);
    expect(derivedReview.changedPaths).toEqual(['example.ts']);
    expect(derivedReview.derivedFromReviewId).toBe(parent.reviewId);
    const after = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId)!;
    expect(after.checkRefs.some((record) => record.receipt?.receiptId === 'receipt-revision-post')).toBe(true);
    expect(after.implementationReviews.at(-1)?.reviewId).toBe(derivedReview.reviewId);
  });

  test('rejects revision transfer when reviewed content digest changes', () => {
    const fx = fixture();
    const preStatus = repositoryGitStatus(fx.repository);
    const preWorkspace = workspaceValidationFingerprint(fx.repoRoot, preStatus);
    const preContent = implementationReviewContentFingerprint(fx.repoRoot, ['example.ts']);
    const preRecord = verificationRecord({
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      workId: fx.workId,
      checkId: fx.checkId,
      sourceRevision: fx.sourceRevision,
      workspaceFingerprint: preWorkspace,
      receiptId: 'receipt-content-change-pre',
    });
    appendVerificationRecord({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, preRecord);
    transitionWorkContractPhase({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, {
      phase: 'verification', status: 'running', state: 'satisfied', summary: 'Pre-change verification passed.',
    });
    recordWorkEvidenceState({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, 'valid');
    requestWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, 'Review pre-change candidate.');
    const parent: WorkImplementationReviewRecord = {
      schemaVersion: 1,
      reviewId: 'review-content-change-parent',
      workId: fx.workId,
      reviewerPrincipalId: 'test-reviewer',
      decision: 'approved',
      rationale: 'Pre-change candidate approved.',
      findings: [],
      sourceRevision: fx.sourceRevision,
      workspaceFingerprint: preContent,
      verificationWorkspaceFingerprint: preWorkspace,
      changedPaths: ['example.ts'],
      changedPathDigest: implementationReviewChangedPathDigest(['example.ts']),
      acceptanceCriteriaSummary: 'Pre-change candidate approved.',
      verificationEvidence: [{ evidenceId: 'receipt-content-change-pre', digest: 'digest-receipt-content-change-pre' }],
      architectureEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    recordWorkImplementationReview({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId, parent);

    writeFileSync(join(fx.repoRoot, 'example.ts'), 'export const value = 99;\n');
    execFileSync('git', ['add', 'example.ts'], { cwd: fx.repoRoot });
    execFileSync('git', ['commit', '-qm', 'change reviewed content'], { cwd: fx.repoRoot });
    const postRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repoRoot, encoding: 'utf8' }).trim();
    const postWorkspace = workspaceValidationFingerprint(fx.repoRoot, repositoryGitStatus(fx.repository));
    const postContent = implementationReviewContentFingerprint(fx.repoRoot, ['example.ts']);
    const postRecord = verificationRecord({
      repoId: fx.repository.repoId,
      checkoutId: fx.repository.activeCheckoutId,
      workId: fx.workId,
      checkId: fx.checkId,
      sourceRevision: postRevision,
      workspaceFingerprint: postWorkspace,
      receiptId: 'receipt-content-change-post',
    });
    const before = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId)!;

    expect(() => transferReviewedWorkAuthorityAcrossContentEquivalentRevision({
      controllerHome: fx.controllerHome,
      repository: fx.repository,
      workId: fx.workId,
      preRevisionCandidate: {
        sourceRevision: parent.sourceRevision,
        workspaceFingerprint: parent.workspaceFingerprint,
        verificationWorkspaceFingerprint: parent.verificationWorkspaceFingerprint,
        changedPaths: parent.changedPaths,
        verificationEvidence: parent.verificationEvidence,
        architectureEvidence: parent.architectureEvidence,
      },
      transferredVerificationRecords: [postRecord],
      postRevisionSourceRevision: postRevision,
      postRevisionContentDigest: postContent,
      postRevisionVerificationWorkspaceFingerprint: postWorkspace,
      postRevisionChangedPaths: ['example.ts'],
    })).toThrow('WORK_IMPLEMENTATION_REVIEW_TRANSFER_CONTENT_CHANGED');

    const after = getWorkContract({ controllerHome: fx.controllerHome, repoId: fx.repository.repoId }, fx.workId)!;
    expect(after.checkRefs).toEqual(before.checkRefs);
    expect(after.implementationReviews).toEqual(before.implementationReviews);
  });
});
