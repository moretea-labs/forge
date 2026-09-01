import {
  appendWorkEvidence as persistWorkEvidence,
  getWorkContract as readWorkContract,
  recordWorkCompletionReceipt as persistWorkCompletionReceipt,
} from '../infrastructure/work-contract-store';
import type { WorkContract, WorkContractStoreOptions } from '../domain/types';

export interface CompleteRemoteEffectProcessInput {
  processId: string;
  actionId: string;
  requestId: string;
  semanticKey: string;
  resultDigest: string;
  recordedAt: string;
}

/**
 * Application command for terminalizing a Work from one trusted repository
 * remote-effect Process receipt. Gateway supplies evidence identity only; Work
 * kind checks, evidence append, and terminal lifecycle mutation stay here.
 */
export function completeRemoteEffectWorkFromProcessReceipt(
  options: WorkContractStoreOptions,
  workId: string,
  input: CompleteRemoteEffectProcessInput,
): WorkContract {
  const work = readWorkContract(options, workId);
  if (!work) throw new Error(`WORK_REMOTE_EFFECT_PROCESS_BINDING_NOT_FOUND: ${workId}`);
  if (work.workKind !== 'remote_effect') {
    throw new Error(`WORK_REMOTE_EFFECT_PROCESS_KIND_MISMATCH: ${workId} is ${work.workKind}, expected remote_effect`);
  }
  if (work.status === 'completed' && work.completionReceipt?.source === 'remote_effect') return work;
  if (!work.evidenceRefs.some((candidate) => candidate.evidenceId === input.processId)) {
    persistWorkEvidence(options, workId, {
      evidenceId: input.processId,
      title: 'trusted repository remote effect completed',
      summary: `Trusted Work-attributed git push completed with durable Process ${input.processId}.`,
      detailLevel: 'summary',
    });
  }
  return persistWorkCompletionReceipt(
    options,
    workId,
    {
      schemaVersion: 1,
      receiptId: input.processId,
      source: 'remote_effect',
      workId,
      authority: 'repository_process',
      actionId: input.actionId,
      requestId: input.requestId,
      semanticKey: input.semanticKey,
      resultDigest: input.resultDigest,
      processId: input.processId,
      recordedAt: input.recordedAt,
    },
    'completed_remote',
    'remote_effect',
  );
}

/**
 * Canonical Work application boundary.
 *
 * Domain transition/review rules live in ../domain. Durable storage lives in
 * ../infrastructure. Runtime/Gateway/Controller callers consume this module (or
 * ../api) instead of importing persistence implementation directly.
 */
export {
  workContractRoot,
  workContractStorePath,
  emptyWorkContractStore,
  readWorkContractStore,
  writeWorkContractStore,
  createWorkContract,
  getWorkContractByRequestId,
  acceptSubmittedWorkContract,
  listWorkContracts,
  reconcileStaleWorkContracts,
  getWorkContract,
  summarizeWorkContract,
  updateWorkContract,
  resumeRetainedCancelledWorkContract,
  recordWorkScopeEvidence,
  transitionWorkContractPhase,
  requestWorkImplementationReview,
  recordWorkImplementationReview,
  appendWorkEvidence,
  appendWorkHandoffRef,
  appendVerificationRecord,
  recordWorkCompletionReceipt,
} from '../infrastructure/work-contract-store';
export type {
  CreateWorkContractInput,
  ListWorkContractOptions,
  WorktreeAvailability,
  WorkContractReconciliationInput,
  WorkContractReconciliationResult,
  WorkContractSummary,
  AcceptSubmittedWorkInput,
  WorkContractStoreLocation,
  WorkContractStoreOptions,
} from '../infrastructure/work-contract-store';
