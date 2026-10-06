import {
  WORK_PHASES,
  type WorkContract,
} from '../../../packages/kernel/work/api/index';

const MAX_DETAIL_VERIFICATIONS = 50;
const MAX_DETAIL_CHECKS = 30;
const MAX_DETAIL_EVIDENCE_REFS = 100;
const MAX_PHASE_EVIDENCE_REFS = 20;

/**
 * Read-only bounded projection of mechanical Work execution/evidence facts.
 * This adapter never mutates Work or derives semantic state/completion.
 */
export function projectWorkExecutionEvidence(work: WorkContract) {
  const maxEvidenceRefs = Math.max(0, Math.min(work.evidencePolicy.maxEvidenceRefs, MAX_DETAIL_EVIDENCE_REFS));
  return {
    dispatchState: work.dispatchState,
    evidenceState: work.evidenceState,
    phase: work.phase,
    workKind: work.workKind,
    ...(work.completionOutcome ? { completionOutcome: work.completionOutcome } : {}),
    checks: work.checks.slice(0, MAX_DETAIL_CHECKS),
    phaseEvidence: WORK_PHASES.map((phase) => ({
      phase,
      state: work.phaseEvidence[phase].state,
      source: work.phaseEvidence[phase].source,
      summary: work.phaseEvidence[phase].summary,
      evidenceRefs: work.phaseEvidence[phase].evidenceRefs.slice(0, MAX_PHASE_EVIDENCE_REFS),
      recordedAt: work.phaseEvidence[phase].recordedAt,
      ...(work.phaseEvidence[phase].receiptId ? { receiptId: work.phaseEvidence[phase].receiptId } : {}),
    })),
    evidenceRefs: maxEvidenceRefs === 0 ? [] : work.evidenceRefs.slice(-maxEvidenceRefs),
    verifications: work.checkRefs.slice(-MAX_DETAIL_VERIFICATIONS).map((verification) => ({
      checkId: verification.checkId,
      outcome: verification.outcome,
      summary: verification.summary,
      recordedAt: verification.recordedAt,
      ...(verification.sourceRevision ? { sourceRevision: verification.sourceRevision } : {}),
      ...(verification.startedAt ? { startedAt: verification.startedAt } : {}),
      ...(verification.completedAt ? { completedAt: verification.completedAt } : {}),
      ...(verification.staleReason ? { staleReason: verification.staleReason } : {}),
      ...(verification.evidenceRef ? { evidenceRef: verification.evidenceRef } : {}),
      ...(verification.receipt ? {
        receipt: {
          receiptId: verification.receipt.receiptId,
          processId: verification.receipt.processId,
          status: verification.receipt.status,
          runtimeStatus: verification.receipt.runtimeStatus,
          ok: verification.receipt.ok,
          timedOut: verification.receipt.timedOut,
          cancelled: verification.receipt.cancelled,
          ...(verification.receipt.reusedExecution !== undefined ? { reusedExecution: verification.receipt.reusedExecution } : {}),
          startedAt: verification.receipt.startedAt,
          finishedAt: verification.receipt.finishedAt,
        },
      } : {}),
    })),
  };
}
