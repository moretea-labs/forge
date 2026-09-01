import { assertImplementationReviewHistoryAppendOnly, validateImplementationReviewRecord } from './work-implementation-review';
import {
  WORK_PHASES,
  isDirectEditWorkCompletionReceipt,
  isReadOnlyReviewCompletionReceipt,
  isRemoteEffectCompletionReceipt,
  isRepositoryCompletionReceipt,
  type DispatchState,
  type EvidenceRef,
  type EvidenceState,
  type SuggestedNextAction,
  type WorkContract,
  type WorkContractStatus,
  type WorkPhase,
  type WorkPhaseEvidence,
  type WorkPhaseEvidenceMap,
} from './types';

export function phaseIndex(phase: WorkPhase): number {
  return WORK_PHASES.indexOf(phase);
}

export function transitionPhaseEvidence(
  current: Pick<WorkContract, 'phaseEvidence' | 'evidenceRefs'>,
  targetPhase: WorkPhase,
  input: {
    status: WorkContractStatus;
    summary: string;
    evidenceRefs?: EvidenceRef[];
    recordedAt: string;
    source?: WorkPhaseEvidence['source'];
  },
): WorkPhaseEvidenceMap {
  const targetIndex = phaseIndex(targetPhase);
  const evidenceRefs = (input.evidenceRefs ?? current.evidenceRefs).slice(0, 20);
  const source = input.source ?? 'recorded';
  const phaseEvidence = { ...current.phaseEvidence };
  for (const phase of WORK_PHASES) {
    const index = phaseIndex(phase);
    if (index < targetIndex) {
      phaseEvidence[phase] = {
        state: ['satisfied', 'skipped'].includes(phaseEvidence[phase].state) ? phaseEvidence[phase].state : 'satisfied',
        source,
        summary: `Advanced to ${targetPhase}: ${input.summary}`.slice(0, 1_000),
        evidenceRefs,
        recordedAt: input.recordedAt,
      };
    } else if (index > targetIndex) {
      phaseEvidence[phase] = {
        state: 'pending',
        source,
        summary: `Waiting for Work phase ${phase}.`,
        evidenceRefs: [],
        recordedAt: input.recordedAt,
      };
    }
  }
  phaseEvidence[targetPhase] = {
    state: input.status === 'failed'
      ? 'failed'
      : input.status === 'cancelled'
        ? 'skipped'
        : input.status === 'blocked' || input.status === 'ready'
          ? 'blocked'
          : 'active',
    source,
    summary: input.summary.trim().slice(0, 1_000) || `Work entered ${targetPhase}.`,
    evidenceRefs,
    recordedAt: input.recordedAt,
  };
  return phaseEvidence;
}

export function validateWorkSemantics(contract: WorkContract): WorkContract {
  if (!contract.objective.trim()) throw new Error('WORK_OBJECTIVE_REQUIRED');
  if (contract.status === 'completed' && !contract.completionReceipt) {
    throw new Error('WORK_COMPLETION_RECEIPT_REQUIRED');
  }
  const currentPhaseIndex = phaseIndex(contract.phase);
  for (const phase of WORK_PHASES) {
    const checkpoint = contract.phaseEvidence?.[phase];
    if (!checkpoint) throw new Error(`WORK_PHASE_EVIDENCE_REQUIRED: ${phase}`);
    const index = phaseIndex(phase);
    if (index < currentPhaseIndex && !['satisfied', 'skipped'].includes(checkpoint.state)) {
      throw new Error(`WORK_PHASE_EVIDENCE_PREVIOUS_NOT_SATISFIED: ${phase}`);
    }
    if (index === currentPhaseIndex && checkpoint.state === 'pending') {
      throw new Error(`WORK_PHASE_EVIDENCE_REQUIRED: ${phase}`);
    }
    if (index > currentPhaseIndex && checkpoint.state !== 'pending') {
      throw new Error(`WORK_PHASE_EVIDENCE_FUTURE_NOT_PENDING: ${phase}`);
    }
  }
  for (const review of contract.implementationReviews ?? []) validateImplementationReviewRecord(review);
  if (contract.completionReceipt) {
    const receipt = contract.completionReceipt;
    if (receipt.workId !== contract.workId) throw new Error('WORK_COMPLETION_RECEIPT_IDENTITY_MISMATCH');
    if (isRepositoryCompletionReceipt(receipt)) {
      if (!receipt.targetBranch.trim() || !receipt.targetRevision.trim()) throw new Error('WORK_COMPLETION_RECEIPT_TARGET_REQUIRED');
      if (receipt.delivery.status !== 'integrated' || !receipt.delivery.reachable) throw new Error('WORK_COMPLETION_RECEIPT_DELIVERY_NOT_PROVEN');
      if (!['complete', 'maintenance_warning'].includes(receipt.cleanup.status) || receipt.cleanup.blockers.length > 0) throw new Error('WORK_COMPLETION_RECEIPT_CLEANUP_NOT_PROVEN');
    } else if (isDirectEditWorkCompletionReceipt(receipt)) {
      const directEditAuthorityCount = Number(Boolean(receipt.editSessionId?.trim())) + Number(Boolean(receipt.reconciliationId?.trim()));
      if (directEditAuthorityCount !== 1) throw new Error('WORK_COMPLETION_RECEIPT_DIRECT_EDIT_AUTHORITY_REQUIRED');
      if (!receipt.targetBranch.trim() || !receipt.targetRevision.trim()) throw new Error('WORK_COMPLETION_RECEIPT_TARGET_REQUIRED');
      if (receipt.delivery.status !== 'integrated' || !receipt.delivery.reachable) throw new Error('WORK_COMPLETION_RECEIPT_DELIVERY_NOT_PROVEN');
      if (!['complete', 'maintenance_warning'].includes(receipt.cleanup.status) || receipt.cleanup.blockers.length > 0) throw new Error('WORK_COMPLETION_RECEIPT_CLEANUP_NOT_PROVEN');
      if (!['repository_change', 'completed_no_change'].includes(contract.workKind)) throw new Error('WORK_COMPLETION_RECEIPT_DIRECT_EDIT_KIND_REQUIRED');
      const expectedOutcome = contract.workKind === 'completed_no_change' ? 'completed_no_change' : 'completed_changed';
      if (contract.completionOutcome !== expectedOutcome) throw new Error('WORK_COMPLETION_RECEIPT_DIRECT_EDIT_OUTCOME_REQUIRED');
    } else if (isReadOnlyReviewCompletionReceipt(receipt)) {
      if (contract.workKind !== 'read_only_review') throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_KIND_REQUIRED');
      if (contract.completionOutcome !== 'completed_no_change') throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_OUTCOME_REQUIRED');
      if (!receipt.baseRevision.trim() || receipt.baseRevision !== receipt.sourceRevision) throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_SOURCE_REQUIRED');
      if (contract.baseRevision && receipt.baseRevision !== contract.baseRevision) throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_BASE_MISMATCH');
      if (receipt.workspaceChangedPaths.length !== 0) throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_WORKSPACE_CHANGED');
      const reviewEvidence = contract.readOnlyReviewEvidence;
      if (!reviewEvidence || reviewEvidence.sourceRevision !== receipt.sourceRevision) throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_EVIDENCE_REQUIRED');
      if (reviewEvidence.findings.length !== 0 || receipt.findingCount !== 0 || receipt.inspectedPaths.length === 0) throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_CLEAN_SCOPE_REQUIRED');
      const evidencePaths = [...new Set(reviewEvidence.inspectedPaths)].sort();
      const receiptPaths = [...new Set(receipt.inspectedPaths)].sort();
      if (evidencePaths.length !== receiptPaths.length || evidencePaths.some((path, index) => path !== receiptPaths[index])) {
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_SCOPE_MISMATCH');
      }
      if (reviewEvidence.workspaceFingerprint && receipt.workspaceFingerprint && reviewEvidence.workspaceFingerprint !== receipt.workspaceFingerprint) {
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_WORKSPACE_MISMATCH');
      }
    } else if (isRemoteEffectCompletionReceipt(receipt)) {
      if (contract.workKind !== 'remote_effect') throw new Error('WORK_COMPLETION_RECEIPT_REMOTE_EFFECT_KIND_REQUIRED');
      if (contract.completionOutcome !== 'completed_remote') throw new Error('WORK_COMPLETION_RECEIPT_REMOTE_EFFECT_OUTCOME_REQUIRED');
      const authority = receipt.authority ?? 'plugin_action';
      if (!receipt.actionId.trim() || !receipt.requestId.trim() || !receipt.semanticKey.trim() || !receipt.resultDigest.trim()) {
        throw new Error('WORK_COMPLETION_RECEIPT_REMOTE_EFFECT_IDENTITY_REQUIRED');
      }
      if (authority === 'plugin_action' && !receipt.pluginId?.trim()) {
        throw new Error('WORK_COMPLETION_RECEIPT_REMOTE_EFFECT_PLUGIN_IDENTITY_REQUIRED');
      }
      if (authority === 'repository_process' && !receipt.processId?.trim()) {
        throw new Error('WORK_COMPLETION_RECEIPT_REMOTE_EFFECT_PROCESS_IDENTITY_REQUIRED');
      }
    } else {
      if (contract.workKind !== 'local_effect') throw new Error('WORK_COMPLETION_RECEIPT_LOCAL_EFFECT_KIND_REQUIRED');
      if (contract.completionOutcome !== 'completed_local') throw new Error('WORK_COMPLETION_RECEIPT_LOCAL_EFFECT_OUTCOME_REQUIRED');
      if (!receipt.operation.trim() || !receipt.target.id.trim()) throw new Error('WORK_COMPLETION_RECEIPT_LOCAL_EFFECT_TARGET_REQUIRED');
    }
    if (contract.status !== 'completed') throw new Error('WORK_COMPLETION_RECEIPT_REQUIRES_COMPLETED_WORK');
    for (const phase of WORK_PHASES) {
      if (!['satisfied', 'skipped'].includes(contract.phaseEvidence[phase].state)) {
        throw new Error(`WORK_COMPLETION_PHASE_NOT_SATISFIED: ${phase}`);
      }
    }
    for (const phase of ['delivery', 'cleanup'] as WorkPhase[]) {
      if (contract.phaseEvidence[phase].receiptId !== receipt.receiptId) {
        throw new Error(`WORK_COMPLETION_PHASE_RECEIPT_MISMATCH: ${phase}`);
      }
    }
  }
  const outcome = contract.completionOutcome;
  if (!outcome) return contract;
  if (contract.status !== 'completed' || !contract.completionReceipt) {
    throw new Error(`WORK_SEMANTICS_INVALID: ${outcome} requires a completed Work receipt`);
  }
  if (contract.dispatchState !== 'terminal') {
    throw new Error(`WORK_SEMANTICS_INVALID: ${outcome} requires terminal dispatch`);
  }
  if (contract.evidenceState !== 'valid') {
    throw new Error(`WORK_SEMANTICS_INVALID: ${outcome} requires valid evidence`);
  }
  if (outcome === 'completed_changed' && contract.workKind !== 'repository_change') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_changed requires repository_change WorkKind');
  }
  if (outcome === 'completed_no_change' && !['completed_no_change', 'read_only_review'].includes(contract.workKind)) {
    throw new Error('WORK_SEMANTICS_INVALID: completed_no_change requires completed_no_change or read_only_review WorkKind');
  }
  if (outcome === 'completed_no_change' && contract.workKind === 'read_only_review' && contract.completionReceipt?.source !== 'read_only_review') {
    throw new Error('WORK_SEMANTICS_INVALID: read_only_review completed_no_change requires a read_only_review completion receipt');
  }
  if (outcome === 'completed_local' && contract.workKind !== 'local_effect') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_local requires local_effect WorkKind');
  }
  if (outcome === 'completed_local' && contract.completionReceipt?.source !== 'local_effect') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_local requires a local_effect completion receipt');
  }
  if (outcome === 'completed_remote' && contract.workKind !== 'remote_effect') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_remote requires remote_effect WorkKind');
  }
  if (outcome === 'completed_remote' && contract.completionReceipt?.source !== 'remote_effect') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_remote requires a remote_effect completion receipt');
  }
  if (outcome === 'superseded' && contract.workKind !== 'superseded') {
    throw new Error('WORK_SEMANTICS_INVALID: superseded requires superseded WorkKind');
  }
  return contract;
}

const DISPATCH_TRANSITIONS: Readonly<Record<DispatchState, readonly DispatchState[]>> = {
  not_dispatched: ['not_dispatched', 'claimed', 'launching', 'running', 'blocked', 'terminal'],
  claimed: ['claimed', 'launching', 'running', 'blocked', 'terminal'],
  launching: ['launching', 'running', 'blocked', 'terminal'],
  running: ['running', 'blocked', 'terminal'],
  blocked: ['blocked', 'claimed', 'launching', 'running', 'terminal'],
  terminal: ['terminal'],
};

const EVIDENCE_TRANSITIONS: Readonly<Record<EvidenceState, readonly EvidenceState[]>> = {
  none: ['none', 'partial', 'valid', 'failed'],
  partial: ['partial', 'valid', 'stale', 'contradictory', 'failed'],
  valid: ['valid', 'stale', 'contradictory', 'failed'],
  stale: ['stale', 'partial', 'valid', 'contradictory', 'failed'],
  contradictory: ['contradictory', 'partial', 'valid', 'failed'],
  failed: ['failed', 'partial', 'valid', 'contradictory'],
};

export function validateWorkSemanticTransition(
  current: WorkContract,
  next: WorkContract,
  options: { allowRetainedCancelledResume?: boolean } = {},
): WorkContract {
  const retryingFailedWork = current.status === 'failed'
    && !current.completionOutcome
    && ['claimed', 'launching', 'running', 'blocked'].includes(next.dispatchState);
  const resumingRetainedCancelledWork = options.allowRetainedCancelledResume === true
    && current.status === 'cancelled'
    && current.dispatchState === 'terminal'
    && current.phase === 'cleanup'
    && current.phaseEvidence.cleanup.state === 'skipped'
    && !current.completionReceipt
    && !current.completionOutcome
    && next.status === 'running'
    && next.dispatchState === 'running'
    && next.phase === 'implementation';
  if (!retryingFailedWork && !resumingRetainedCancelledWork && !DISPATCH_TRANSITIONS[current.dispatchState].includes(next.dispatchState)) {
    throw new Error(`WORK_SEMANTICS_TRANSITION_INVALID: dispatch ${current.dispatchState} -> ${next.dispatchState}`);
  }
  if (!EVIDENCE_TRANSITIONS[current.evidenceState].includes(next.evidenceState)) {
    throw new Error(`WORK_SEMANTICS_TRANSITION_INVALID: evidence ${current.evidenceState} -> ${next.evidenceState}`);
  }
  if (current.completionOutcome && current.completionOutcome !== next.completionOutcome) {
    throw new Error(`WORK_SEMANTICS_TRANSITION_INVALID: completion outcome ${current.completionOutcome} is immutable`);
  }
  if ((current.lifecycleRole ?? 'primary') !== (next.lifecycleRole ?? 'primary')) {
    throw new Error('WORK_SEMANTICS_TRANSITION_INVALID: lifecycleRole is immutable');
  }
  if (current.parentWorkId !== next.parentWorkId) {
    throw new Error('WORK_SEMANTICS_TRANSITION_INVALID: parentWorkId is immutable');
  }
  assertImplementationReviewHistoryAppendOnly(current.implementationReviews ?? [], next.implementationReviews ?? []);
  return next;
}

export function suggestedActionsForStatus(status: WorkContractStatus, actions: readonly SuggestedNextAction[]): SuggestedNextAction[] {
  if (status === 'completed' || status === 'cancelled') return [];
  return actions.slice(0, 8);
}
