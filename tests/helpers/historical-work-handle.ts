import { sanitizeFileComponent } from '../../src/runtime/shared/json-files';
import { writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';

/** Test fixture only: seeds historical WorkHandle bytes for read/migration compatibility tests. */
export function seedHistoricalWorkHandle<T extends { workId: string; repositoryId: string; recordRevision?: number }>(
  controllerHome: string,
  handle: T,
): Omit<T, 'recordRevision'> & { recordRevision: number } {
  const { recordRevision, ...value } = handle;
  const record = writeControlPlaneRecord(controllerHome, {
    namespace: 'execution_work_handle',
    scope: value.repositoryId,
    key: sanitizeFileComponent(value.workId),
    schemaVersion: 1,
    value,
    action: 'test_seed_historical_work_handle',
    ...(recordRevision !== undefined ? { expectedRevision: recordRevision } : {}),
  });
  return { ...record.value, recordRevision: record.revision };
}
