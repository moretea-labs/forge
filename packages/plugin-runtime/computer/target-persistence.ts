export interface ComputerTargetPersistenceRecord<T> {
  key: string;
  revision: number;
  value: T;
  createdAt: string;
  updatedAt: string;
}

export interface ComputerTargetPersistenceWrite<T> {
  namespace: string;
  scope: string;
  key: string;
  schemaVersion: number;
  value: T;
  action?: string;
  expectedRevision?: number | null;
}

export interface ComputerTargetPersistenceListInput {
  namespace: string;
  scope?: string;
  limit?: number;
}

export interface ComputerTargetPersistenceDeleteInput {
  namespace: string;
  scope: string;
  key: string;
  action?: string;
  expectedRevision?: number;
}

/**
 * Provider-neutral persistence and serialization contract for durable Computer
 * interaction targets. Concrete Controller locking/SQLite ownership belongs to
 * Runtime composition, never the Computer adapter.
 */
export interface ComputerTargetPersistencePort {
  read<T>(controllerHome: string, namespace: string, scope: string, key: string): ComputerTargetPersistenceRecord<T> | undefined;
  list<T>(controllerHome: string, input: ComputerTargetPersistenceListInput): ComputerTargetPersistenceRecord<T>[];
  write<T>(controllerHome: string, input: ComputerTargetPersistenceWrite<T>): ComputerTargetPersistenceRecord<T>;
  delete(controllerHome: string, input: ComputerTargetPersistenceDeleteInput): boolean;
  withTargetLock<T>(controllerHome: string, targetId: string, operation: () => Promise<T>): Promise<T>;
}
