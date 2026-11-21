/**
 * Historical Work read boundary.
 *
 * Work lifecycle is retired. This module exposes only read/query compatibility
 * for existing records. Runtime startup does not create a Work admission index.
 * Requirement/Plan/Run/Git owners handle all current mutable state.
 */
export {
  readWorkContractStore,
  getWorkContractByRequestId,
  listWorkContracts,
  readWorkContractLineageSnapshot,
  readWorkGoalSnapshot,
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
  WorkContractLineageSnapshot,
  WorkContractSummary,
  WorkSemanticRevisionRecord,
  WorkContractStoreLocation,
  WorkContractStoreOptions,
} from '../infrastructure/work-contract-store';
