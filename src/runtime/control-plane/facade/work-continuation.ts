import type { WorkContract, WorkReconciliationRecord } from './types';
import { redactMcpText } from '../../../../adapters/mcp/redaction';

export interface WorkContinuationSnapshot {
  schemaVersion: 1;
  workId: string;
  repoId: string;
  requestId?: string;
  binding: {
    issueId?: string;
    taskId?: string;
    planId?: string;
    planStepId?: string;
    worktreeRef?: string;
  };
  semantics: {
    state: WorkContract['semanticState'];
    phase: WorkContract['phase'];
    workKind: WorkContract['workKind'];
    dispatchState: WorkContract['dispatchState'];
    evidenceState: WorkContract['evidenceState'];
    completionOutcome?: WorkContract['completionOutcome'];
  };
  verification: Array<{
    checkId: string;
    outcome: string;
    sourceRevision?: string;
    recordedAt: string;
    staleReason?: string;
  }>;
  reconciliations: Array<Pick<WorkReconciliationRecord,
    'reconciliationId' | 'outcome' | 'method' | 'originalExpectedRevision' | 'observedTargetRevision' | 'reachable' | 'reviewer' | 'reviewedAt'>>;
  reconciliationRequired: boolean;
  nextSafeAction: string;
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? redactMcpText(normalized.slice(0, maximum)).text : undefined;
}

function nextSafeAction(contract: WorkContract, reconciliationRequired: boolean): string {
  const currentOwner = 'Resolve the current Requirement/Plan/Issue and selected Git checkout/Process/Check facts before continuing; historical Work is read-only.';
  if (reconciliationRequired) return `Historical reconciliation requires interpretation only. ${currentOwner}`;
  if (contract.semanticState === 'completed' || contract.semanticState === 'cancelled') {
    return `Read retained result/evidence references for provenance only. ${currentOwner}`;
  }
  if (contract.evidenceState === 'failed' || contract.evidenceState === 'stale' || contract.evidenceState === 'contradictory') {
    return `Read the historical failure/validation evidence; do not re-run or finalize through Work. ${currentOwner}`;
  }
  return currentOwner;
}

/**
 * Redacted, bounded historical Work projection. It never changes semantic state,
 * emits a continuation prompt, or authorizes successor/repair/finalize actions.
 */
export function buildWorkContinuationSnapshot(contract: WorkContract): WorkContinuationSnapshot {
  const reconciliations = (contract.reconciliations ?? []).slice(0, 5).map((record) => ({
    reconciliationId: record.reconciliationId,
    outcome: record.outcome,
    method: record.method,
    originalExpectedRevision: record.originalExpectedRevision,
    observedTargetRevision: record.observedTargetRevision,
    reachable: record.reachable,
    reviewer: record.reviewer,
    reviewedAt: record.reviewedAt,
  }));
  const reconciliationRequired = contract.evidenceState === 'stale'
    || contract.evidenceState === 'contradictory'
    || reconciliations.some((record) => record.outcome !== 'accepted_equivalence');
  return {
    schemaVersion: 1,
    workId: contract.workId,
    repoId: contract.repoId,
    requestId: contract.requestId,
    binding: {
      issueId: contract.issueId,
      taskId: contract.taskId,
      planId: contract.planId,
      planStepId: contract.planStepId,
      worktreeRef: contract.worktreeRef,
    },
    semantics: {
      state: contract.semanticState,
      phase: contract.phase,
      workKind: contract.workKind,
      dispatchState: contract.dispatchState,
      evidenceState: contract.evidenceState,
      completionOutcome: contract.completionOutcome,
    },
    verification: contract.checkRefs.slice(0, 20).map((record) => ({
      checkId: record.checkId,
      outcome: record.outcome,
      sourceRevision: record.sourceRevision,
      recordedAt: record.recordedAt,
      staleReason: boundedText(record.staleReason, 240),
    })),
    reconciliations,
    reconciliationRequired,
    nextSafeAction: nextSafeAction(contract, reconciliationRequired),
  };
}
