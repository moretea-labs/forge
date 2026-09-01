import type { WorkContract, WorkContractStore, WorkContractStatus } from '../domain/types';

export interface WorkContractStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface WorkContractStoreOptions extends WorkContractStoreLocation {
  now?: () => string;
}

/** Infrastructure contract only. Lifecycle mutation policy belongs to application/domain. */
export interface WorkContractPersistencePort {
  read(options: WorkContractStoreOptions): WorkContractStore;
  get(options: WorkContractStoreOptions, workId: string): WorkContract | undefined;
  list(options: WorkContractStoreOptions & { status?: WorkContractStatus | 'active' | 'all'; limit?: number }): WorkContract[];
}
