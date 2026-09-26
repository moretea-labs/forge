import type { WorkContract, WorkContractStore, WorkContractStatus } from '../domain/types';

export interface WorkContractStoreLocation {
  controllerHome?: string;
  /** Canonical storage scope. Semantic Work uses the portable semantic scope; repository Work may omit this and use repoId. */
  scopeKey?: string;
  /** Legacy/repository execution storage scope and optional placement context. */
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
