export interface BrowserSessionPersistenceRecord<T> {
  key: string;
  revision: number;
  value: T;
}

export interface BrowserSessionPersistenceWrite<T> {
  namespace: string;
  scope: string;
  key: string;
  schemaVersion: number;
  value: T;
  action?: string;
  expectedRevision?: number | null;
}

export interface BrowserSessionPersistenceTransaction {
  read<T>(namespace: string, scope: string, key: string): BrowserSessionPersistenceRecord<T> | undefined;
  write<T>(input: BrowserSessionPersistenceWrite<T>): BrowserSessionPersistenceRecord<T>;
}

/** Provider-neutral persistence contract. Concrete SQLite ownership remains in Runtime composition. */
export interface BrowserSessionPersistencePort {
  read<T>(controllerHome: string, namespace: string, scope: string, key: string): BrowserSessionPersistenceRecord<T> | undefined;
  list<T>(controllerHome: string, input: { namespace: string; scope?: string; limit?: number }): BrowserSessionPersistenceRecord<T>[];
  /** Internal authority scan. Unlike public list surfaces, this must not truncate durable facts. */
  listAll<T>(controllerHome: string, input: { namespace: string; scope?: string }): BrowserSessionPersistenceRecord<T>[];
  transaction<T>(controllerHome: string, operation: (transaction: BrowserSessionPersistenceTransaction) => T): T;
}
