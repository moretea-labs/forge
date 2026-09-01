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
