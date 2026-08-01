import type { WorkContract, WorkReconciliationRecord } from './types';
import { redactMcpText } from '../../../cli/mcp/redaction';

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
    status: WorkContract['status'];
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
  continuationPrompt?: string;
  reconciliationRequired: boolean;
  nextSafeAction: string;
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? redactMcpText(normalized.slice(0, maximum)).text : undefined;
}

function nextSafeAction(contract: WorkContract, reconciliationRequired: boolean): string {
  if (reconciliationRequired) return 'Inspect the recorded reconciliation and decide whether to accept, reject, or supersede it; do not infer completion.';
  if (contract.evidenceState === 'stale' || contract.evidenceState === 'contradictory') return 'Re-run required validation against the current bound revision before finalization.';
  if (contract.status === 'open' || contract.status === 'ready') return 'Claim controller ownership before starting mutating execution.';
  if (contract.status === 'running') return 'Inspect the bound Work and its durable process/check evidence; do not resubmit the same request ID.';
  if (contract.status === 'completed') return 'Read the completion receipt and retain the exact revision evidence; no further mutation is implied.';
  if (contract.status === 'failed') return 'Inspect failure evidence and choose an explicit repair, reconciliation, or stop action.';
  return 'Inspect retained evidence before any further action.';
}

/**
 * Redacted, bounded state needed by a fresh controller session. This is a
 * projection only: it never upgrades a status or interprets a reconciliation
 * as completion.
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
      status: contract.status,
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
    continuationPrompt: boundedText(contract.continuationPrompt, 500),
    reconciliationRequired,
    nextSafeAction: nextSafeAction(contract, reconciliationRequired),
  };
}
