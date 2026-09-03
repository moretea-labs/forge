export interface ComputerTargetPersistenceRecord<T> {
  key: string;
  revision: number;
  value: T;
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

/**
 * Provider-neutral persistence and serialization contract for durable Computer
 * interaction targets. Concrete Controller locking/SQLite ownership belongs to
 * Runtime composition, never the Computer adapter.
 */
export interface ComputerTargetPersistencePort {
  read<T>(controllerHome: string, namespace: string, scope: string, key: string): ComputerTargetPersistenceRecord<T> | undefined;
  write<T>(controllerHome: string, input: ComputerTargetPersistenceWrite<T>): ComputerTargetPersistenceRecord<T>;
  withTargetLock<T>(controllerHome: string, targetId: string, operation: () => Promise<T>): Promise<T>;
}
