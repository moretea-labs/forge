/**
 * Historical Work read boundary.
 *
 * Work lifecycle is retired. This module exposes only read/query compatibility
 * for existing records plus the derived candidate index used by legacy reads.
 * Requirement/Plan/Run/Git owners handle all current mutable state.
 */
export {
  readWorkContractStore,
  getWorkContractByRequestId,
  listWorkContracts,
  readActiveWorkCandidates,
  readWorkContractLineageSnapshot,
  readWorkGoalSnapshot,
  initializeWorkCandidateIndex,
  isCurrentWorkContract,
  getWorkContract,
  semanticWorkState,
  workSemanticView,
  listWorkSemanticRevisionRecords,
  summarizeWorkContract,
  canonicalizeWorkContractForAuthority,
} from '../infrastructure/work-contract-store';

export type {
  ListWorkContractOptions,
  InvalidActiveWorkCandidate,
  ActiveWorkCandidateSnapshot,
  WorkContractLineageSnapshot,
  WorkContractSummary,
  WorkSemanticRevisionRecord,
  WorkContractStoreLocation,
  WorkContractStoreOptions,
} from '../infrastructure/work-contract-store';
