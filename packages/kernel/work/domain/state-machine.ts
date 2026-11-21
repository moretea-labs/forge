import { validateImplementationReviewRecord } from './implementation-review';
import { validateWorkObjectiveRelationShape } from './objective-relations';
import {
  WORK_PHASES,
  isDirectEditWorkCompletionReceipt,
  isReadOnlyReviewCompletionReceipt,
  isRemoteEffectCompletionReceipt,
  isRepositoryCompletionReceipt,
  type SuggestedNextAction,
  type WorkContract,
  type WorkPhase,
} from './types';

export function phaseIndex(phase: WorkPhase): number {
  return WORK_PHASES.indexOf(phase);
}

/** Historical Work row normalization/validation only; no active transition API. */
export function validateWorkSemantics(contract: WorkContract): WorkContract {
  if (!contract.objective.trim()) throw new Error('WORK_OBJECTIVE_REQUIRED');
  validateWorkObjectiveRelationShape(contract);
  if (!['open', 'completed', 'cancelled'].includes(contract.semanticState))
    throw new Error('WORK_SEMANTIC_STATE_INVALID');
  for (const review of contract.implementationReviews ?? []) validateImplementationReviewRecord(review);
  if (contract.completionReceipt) {
    const receipt = contract.completionReceipt;
    if (receipt.workId !== contract.workId) throw new Error('WORK_COMPLETION_RECEIPT_IDENTITY_MISMATCH');
    if (isRepositoryCompletionReceipt(receipt)) {
      if (!receipt.targetBranch.trim() || !receipt.targetRevision.trim())
        throw new Error('WORK_COMPLETION_RECEIPT_TARGET_REQUIRED');
      if (receipt.delivery.status !== 'integrated' || !receipt.delivery.reachable)
        throw new Error('WORK_COMPLETION_RECEIPT_DELIVERY_NOT_PROVEN');
      if (!['complete', 'maintenance_warning'].includes(receipt.cleanup.status) || receipt.cleanup.blockers.length > 0)
        throw new Error('WORK_COMPLETION_RECEIPT_CLEANUP_NOT_PROVEN');
    } else if (isDirectEditWorkCompletionReceipt(receipt)) {
      const directEditAuthorityCount =
        Number(Boolean(receipt.editSessionId?.trim())) + Number(Boolean(receipt.reconciliationId?.trim()));
      if (directEditAuthorityCount !== 1) throw new Error('WORK_COMPLETION_RECEIPT_DIRECT_EDIT_AUTHORITY_REQUIRED');
      if (!receipt.targetBranch.trim() || !receipt.targetRevision.trim())
        throw new Error('WORK_COMPLETION_RECEIPT_TARGET_REQUIRED');
      if (receipt.delivery.status !== 'integrated' || !receipt.delivery.reachable)
        throw new Error('WORK_COMPLETION_RECEIPT_DELIVERY_NOT_PROVEN');
      if (!['complete', 'maintenance_warning'].includes(receipt.cleanup.status) || receipt.cleanup.blockers.length > 0)
        throw new Error('WORK_COMPLETION_RECEIPT_CLEANUP_NOT_PROVEN');
      if (!['repository_change', 'completed_no_change'].includes(contract.workKind))
        throw new Error('WORK_COMPLETION_RECEIPT_DIRECT_EDIT_KIND_REQUIRED');
      const expectedOutcome = contract.workKind === 'completed_no_change' ? 'completed_no_change' : 'completed_changed';
      if (contract.completionOutcome !== expectedOutcome)
        throw new Error('WORK_COMPLETION_RECEIPT_DIRECT_EDIT_OUTCOME_REQUIRED');
    } else if (isReadOnlyReviewCompletionReceipt(receipt)) {
      if (contract.workKind !== 'read_only_review')
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_KIND_REQUIRED');
      if (contract.completionOutcome !== 'completed_no_change')
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_OUTCOME_REQUIRED');
      if (!receipt.baseRevision.trim() || receipt.baseRevision !== receipt.sourceRevision)
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_SOURCE_REQUIRED');
      if (contract.baseRevision && receipt.baseRevision !== contract.baseRevision)
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_BASE_MISMATCH');
      if (receipt.workspaceChangedPaths.length !== 0)
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_WORKSPACE_CHANGED');
      const reviewEvidence = contract.readOnlyReviewEvidence;
      if (!reviewEvidence || reviewEvidence.sourceRevision !== receipt.sourceRevision)
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_EVIDENCE_REQUIRED');
      // Findings are durable observations the model/user acts on; they never block
      // terminal completion. Only the exact inspected scope must stay consistent.
      if (receipt.inspectedPaths.length === 0)
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_SCOPE_REQUIRED');
      const evidencePaths = [...new Set(reviewEvidence.inspectedPaths)].sort();
      const receiptPaths = [...new Set(receipt.inspectedPaths)].sort();
      if (
        evidencePaths.length !== receiptPaths.length ||
        evidencePaths.some((path, index) => path !== receiptPaths[index])
      ) {
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_SCOPE_MISMATCH');
      }
      if (
        reviewEvidence.workspaceFingerprint &&
        receipt.workspaceFingerprint &&
        reviewEvidence.workspaceFingerprint !== receipt.workspaceFingerprint
      ) {
        throw new Error('WORK_COMPLETION_RECEIPT_READ_ONLY_REVIEW_WORKSPACE_MISMATCH');
      }
    } else if (isRemoteEffectCompletionReceipt(receipt)) {
      if (contract.workKind !== 'remote_effect') throw new Error('WORK_COMPLETION_RECEIPT_REMOTE_EFFECT_KIND_REQUIRED');
      if (contract.completionOutcome !== 'completed_remote')
        throw new Error('WORK_COMPLETION_RECEIPT_REMOTE_EFFECT_OUTCOME_REQUIRED');
      const authority = receipt.authority ?? 'plugin_action';
      if (
        !receipt.actionId.trim() ||
        !receipt.requestId.trim() ||
        !receipt.semanticKey.trim() ||
        !receipt.resultDigest.trim()
      ) {
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
      if (contract.completionOutcome !== 'completed_local')
        throw new Error('WORK_COMPLETION_RECEIPT_LOCAL_EFFECT_OUTCOME_REQUIRED');
      if (!receipt.operation.trim() || !receipt.target.id.trim())
        throw new Error('WORK_COMPLETION_RECEIPT_LOCAL_EFFECT_TARGET_REQUIRED');
    }
    // Delivery/effect receipts are mechanical evidence. They never require or imply semantic completion.
  }
  const outcome = contract.completionOutcome;
  if (!outcome) return contract;
  if (!contract.completionReceipt) {
    throw new Error(`WORK_SEMANTICS_INVALID: ${outcome} requires a delivery/effect receipt`);
  }
  // completionOutcome classifies the attached delivery/effect receipt only.
  // Dispatch and generic evidence axes remain independent execution observations.
  if (outcome === 'completed_changed' && contract.workKind !== 'repository_change') {
    throw new Error('WORK_SEMANTICS_INVALID: completed_changed requires repository_change WorkKind');
  }
  // An empty repository delivery is evidence, not authority to rewrite WorkKind.
  const emptyRepositoryDelivery =
    contract.workKind === 'repository_change' &&
    isRepositoryCompletionReceipt(contract.completionReceipt) &&
    contract.completionReceipt.delivery.kind === 'no_change' &&
    contract.completionReceipt.changedPaths.length === 0;
  if (
    outcome === 'completed_no_change' &&
    !['completed_no_change', 'read_only_review'].includes(contract.workKind) &&
    !emptyRepositoryDelivery
  ) {
    throw new Error(
      'WORK_SEMANTICS_INVALID: completed_no_change requires a no-change WorkKind or proven empty repository delivery',
    );
  }
  if (
    outcome === 'completed_no_change' &&
    contract.workKind === 'read_only_review' &&
    contract.completionReceipt?.source !== 'read_only_review'
  ) {
    throw new Error(
      'WORK_SEMANTICS_INVALID: read_only_review completed_no_change requires a read_only_review completion receipt',
    );
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

export function suggestedActionsForSemanticState(
  state: 'open' | 'completed' | 'cancelled',
  actions: readonly SuggestedNextAction[],
): SuggestedNextAction[] {
  if (state !== 'open') return [];
  return actions.slice(0, 8);
}
