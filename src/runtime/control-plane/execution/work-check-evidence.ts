import {
  appendVerificationRecord,
  appendWorkEvidence,
  getWorkContract,
  semanticWorkState,
  summarizeWorkContract,
  updateWorkContract,
  type WorkContractStoreOptions,
} from '../../../../packages/kernel/work/api/index';
import { buildFacadeResult } from '../facade/facade-result';
import { classifyVerificationOutcome, type CheckDefinitionLike } from '../facade/check-normalization';
import type { FacadeResult, VerificationRecord } from '../facade/types';

export interface RecordWorkCheckEvidenceInput {
  store: WorkContractStoreOptions;
  workId: string;
  checkId: string;
  availableChecks: readonly CheckDefinitionLike[];
  sourceRevision?: string;
  workspaceFingerprint?: string;
  verificationInputFingerprint?: string;
  commandFingerprint?: string;
  receipt?: VerificationRecord['receipt'];
  infrastructureFailed?: boolean;
  checkFailed?: boolean;
  skipped?: boolean;
}

/**
 * Attribute one check outcome to semantic Work as durable evidence only.
 * This cannot advance Work lifecycle, request review, authorize Git, or choose
 * the model's next semantic action.
 */
export function recordWorkCheckEvidence(input: RecordWorkCheckEvidenceInput): FacadeResult {
  const work = getWorkContract(input.store, input.workId);
  if (!work) {
    return buildFacadeResult({
      status: 'not_found',
      summary: `WorkContract ${input.workId} not found.`,
      data: { workId: input.workId },
    });
  }

  const classified = classifyVerificationOutcome({
    checkId: input.checkId,
    available: input.availableChecks,
    infrastructureFailed: input.infrastructureFailed,
    checkFailed: input.checkFailed,
    skipped: input.skipped,
  });
  const resolvedCheckId = classified.normalizedCheckId ?? classified.checkId;

  if (semanticWorkState(work) !== 'open') {
    const existing = [...work.checkRefs].reverse().find((record) => record.checkId === resolvedCheckId);
    return buildFacadeResult({
      status: semanticWorkState(work) === 'completed' ? 'ok' : 'blocked',
      summary: `WorkContract ${work.workId} is terminal (${semanticWorkState(work)}); check evidence was not rewritten.`,
      data: {
        work: summarizeWorkContract(work),
        verification: {
          checkId: resolvedCheckId,
          ...(existing ? { outcome: existing.outcome } : {}),
          terminal: true,
          idempotent: true,
          reexecuted: false,
          isAcceptanceFailure: existing?.outcome === 'valid_fail',
          isInfrastructureIssue: existing?.outcome === 'invalid_check_id' || existing?.outcome === 'infrastructure_failure',
          doesNotRequestTaskChanges: existing?.outcome !== 'valid_fail',
        },
      },
      evidenceRefs: existing?.evidenceRef ? [existing.evidenceRef] : [],
      warnings: classified.warnings,
      suggestedNextActions: [],
    });
  }

  const receipt = input.receipt
    && input.receipt.repoId === work.repoId
    && input.receipt.workId === work.workId
    && input.receipt.checkId === resolvedCheckId
    ? input.receipt
    : undefined;
  const sourceRevision = receipt && input.sourceRevision?.trim() ? input.sourceRevision.trim() : undefined;
  const summary = receipt
    ? `${classified.summary} Durable Process receipt ${receipt.receiptId}.`
    : classified.summary;
  const recordedAt = new Date().toISOString();
  const record: VerificationRecord = {
    checkId: resolvedCheckId,
    outcome: classified.outcome,
    summary,
    recordedAt,
    sourceRevision,
    workspaceFingerprint: receipt && sourceRevision ? input.workspaceFingerprint : undefined,
    verificationInputFingerprint: receipt && sourceRevision ? input.verificationInputFingerprint : undefined,
    commandFingerprint: receipt && sourceRevision ? input.commandFingerprint : undefined,
    startedAt: receipt?.startedAt,
    completedAt: receipt?.finishedAt,
    receipt,
    evidenceRef: {
      title: `verification:${classified.outcome}`,
      summary,
      detailLevel: 'summary',
    },
  };

  if (classified.outcome === 'valid_pass' || classified.outcome === 'valid_fail') {
    const checkRefs = work.checkRefs.map((existing) => (
      existing.checkId === record.checkId
      && (existing.outcome === 'invalid_check_id' || existing.outcome === 'infrastructure_failure')
        ? { ...existing, outcome: 'superseded' as const, summary: `Superseded by ${classified.outcome} at ${recordedAt}` }
        : existing
    ));
    updateWorkContract(input.store, work.workId, { checkRefs });
  }

  const updated = appendVerificationRecord(input.store, work.workId, record);
  if (record.evidenceRef) appendWorkEvidence(input.store, work.workId, record.evidenceRef);

  return buildFacadeResult({
    status: classified.outcome === 'valid_fail' ? 'failed' : 'ok',
    summary: classified.summary,
    data: {
      work: summarizeWorkContract(updated),
      verification: {
        checkId: record.checkId,
        outcome: classified.outcome,
        isAcceptanceFailure: classified.isAcceptanceFailure,
        isInfrastructureIssue: classified.isInfrastructureIssue,
        doesNotRequestTaskChanges: !classified.isAcceptanceFailure,
      },
    },
    warnings: classified.warnings,
    evidenceRefs: record.evidenceRef ? [record.evidenceRef] : [],
    suggestedNextActions: [],
  });
}
