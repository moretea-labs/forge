import type { ComputerTargetPersistencePort } from '../../../packages/plugin-runtime/computer/target-persistence';
import { CONTROLLER_SCOPE_REPO_ID } from '../../cli/repositories/controller-home';
import { withControllerLockAsync } from '../../cli/repositories/locks';
import { deleteControlPlaneRecord, listControlPlaneRecords, readControlPlaneRecord, writeControlPlaneRecord } from '../control-plane/persistence/sqlite-store';

export function createRuntimeComputerTargetPersistence(): ComputerTargetPersistencePort {
  return {
    read: (controllerHome, namespace, scope, key) => readControlPlaneRecord(controllerHome, namespace, scope, key),
    list: (controllerHome, input) => listControlPlaneRecords(controllerHome, input),
    write: (controllerHome, input) => writeControlPlaneRecord(controllerHome, input),
    delete: (controllerHome, input) => deleteControlPlaneRecord(controllerHome, input),
    withTargetLock: (controllerHome, targetId, operation) => withControllerLockAsync(
      controllerHome,
      { scope: 'task', repoId: CONTROLLER_SCOPE_REPO_ID, taskId: `computer-target-${targetId}` },
      `computer-target:${targetId}`,
      operation,
    ),
  };
}
