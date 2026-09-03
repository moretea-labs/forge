import type {
  BrowserSessionPersistencePort,
  BrowserSessionPersistenceTransaction,
} from '../../../packages/plugin-runtime/browser/session-persistence';
import {
  listAllControlPlaneRecords,
  listControlPlaneRecords,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../control-plane/persistence/sqlite-store';

export function createRuntimeBrowserSessionPersistence(): BrowserSessionPersistencePort {
  return {
    read: (controllerHome, namespace, scope, key) => readControlPlaneRecord(controllerHome, namespace, scope, key),
    list: (controllerHome, input) => listControlPlaneRecords(controllerHome, input),
    listAll: (controllerHome, input) => listAllControlPlaneRecords(controllerHome, input),
    transaction: (controllerHome, operation) => withControlPlaneTransaction(controllerHome, (database) => {
      const transaction: BrowserSessionPersistenceTransaction = {
        read: (namespace, scope, key) => readControlPlaneRecordWithinTransaction(database, namespace, scope, key),
        write: (input) => writeControlPlaneRecordWithinTransaction(database, input),
      };
      return operation(transaction);
    }),
  };
}
