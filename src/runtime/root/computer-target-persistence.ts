import type { ComputerTargetPersistencePort } from '../../../packages/plugin-runtime/computer/target-persistence';
import { CONTROLLER_SCOPE_REPO_ID } from '../../cli/repositories/controller-home';
import { withControllerLockAsync } from '../../cli/repositories/locks';
import {
  deleteControlPlaneRecord,
  deleteControlPlaneRecordWithinTransaction,
  listAllControlPlaneRecords,
  listAllControlPlaneRecordsWithinTransaction,
  listControlPlaneRecords,
  listControlPlaneRecordsWithinTransaction,
  readControlPlaneRecord,
  readControlPlaneRecordWithinTransaction,
  withControlPlaneTransaction,
  writeControlPlaneRecord,
  writeControlPlaneRecordWithinTransaction,
} from '../control-plane/persistence/sqlite-store';

export function createRuntimeComputerTargetPersistence(): ComputerTargetPersistencePort {
  return {
    read: (controllerHome, namespace, scope, key) => readControlPlaneRecord(controllerHome, namespace, scope, key),
    list: (controllerHome, input) => listControlPlaneRecords(controllerHome, input),
    listAll: (controllerHome, input) => listAllControlPlaneRecords(controllerHome, input),
    write: (controllerHome, input) => writeControlPlaneRecord(controllerHome, input),
    delete: (controllerHome, input) => deleteControlPlaneRecord(controllerHome, input),
    transaction: (controllerHome, operation) => withControlPlaneTransaction(controllerHome, (database) => operation({
      read: (namespace, scope, key) => readControlPlaneRecordWithinTransaction(database, namespace, scope, key),
      list: (input) => listControlPlaneRecordsWithinTransaction(database, input),
      listAll: (input) => listAllControlPlaneRecordsWithinTransaction(database, input),
      write: (input) => writeControlPlaneRecordWithinTransaction(database, input),
      delete: (input) => deleteControlPlaneRecordWithinTransaction(database, input),
    })),
    withTargetLock: (controllerHome, targetId, operation) => withControllerLockAsync(
      controllerHome,
      { scope: 'task', repoId: CONTROLLER_SCOPE_REPO_ID, taskId: `computer-target-${targetId}` },
      `computer-target:${targetId}`,
      operation,
    ),
  };
}
