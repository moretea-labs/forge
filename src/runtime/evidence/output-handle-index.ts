import { deleteControlPlaneRecord, mutateControlPlaneRecord, readControlPlaneRecord } from '../control-plane/persistence/sqlite-store';

export const OUTPUT_HANDLE_INDEX_NAMESPACE = 'output_handle_index';
const OUTPUT_HANDLE_INDEX_SCOPE = 'instance';
const OUTPUT_HANDLE_INDEX_SCHEMA_VERSION = 1;

export type OutputHandleKind = 'result' | 'artifact' | 'evidence';
export type OutputHandleStorage =
  | { scope: 'instance' }
  | { scope: 'legacy_repository'; repositoryId: string };

export interface OutputHandleIndexEntry {
  schemaVersion: 1;
  handleId: string;
  kind: OutputHandleKind;
  storage: OutputHandleStorage;
  /** Repository provenance is descriptive context, never the locator namespace. */
  repositoryId?: string;
  /** Opaque ids locate this record; authorization is bound separately. */
  principalId?: string;
  sessionId?: string;
  workId?: string;
  operationId?: string;
  fingerprint: string;
  recordedAt: string;
  updatedAt: string;
}

function bounded(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

function normalizedStorage(storage: OutputHandleStorage): OutputHandleStorage {
  if (storage.scope === 'instance') return { scope: 'instance' };
  const repositoryId = bounded(storage.repositoryId);
  if (!repositoryId) throw new Error('OUTPUT_HANDLE_LEGACY_REPOSITORY_REQUIRED');
  return { scope: 'legacy_repository', repositoryId };
}

function bindingsConflict(current: OutputHandleIndexEntry, input: {
  principalId?: string;
  sessionId?: string;
  workId?: string;
  operationId?: string;
}): boolean {
  for (const key of ['principalId', 'sessionId', 'workId', 'operationId'] as const) {
    const left = bounded(current[key]);
    const right = bounded(input[key]);
    if (left && right && left !== right) return true;
  }
  return false;
}

export function recordOutputHandleIndexEntry(
  controllerHome: string,
  input: {
    handleId: string;
    kind: OutputHandleKind;
    storage: OutputHandleStorage;
    repositoryId?: string;
    principalId?: string;
    sessionId?: string;
    workId?: string;
    operationId?: string;
    fingerprint: string;
    now?: string;
  },
): OutputHandleIndexEntry {
  const handleId = bounded(input.handleId);
  const fingerprint = bounded(input.fingerprint);
  if (!handleId || !fingerprint) throw new Error('OUTPUT_HANDLE_IDENTITY_REQUIRED');
  const storage = normalizedStorage(input.storage);
  const now = input.now ?? new Date().toISOString();
  const repositoryId = bounded(input.repositoryId);
  const principalId = bounded(input.principalId);
  const sessionId = bounded(input.sessionId);
  const workId = bounded(input.workId);
  const operationId = bounded(input.operationId);

  const record = mutateControlPlaneRecord<OutputHandleIndexEntry>(controllerHome, {
    namespace: OUTPUT_HANDLE_INDEX_NAMESPACE,
    scope: OUTPUT_HANDLE_INDEX_SCOPE,
    key: handleId,
    schemaVersion: OUTPUT_HANDLE_INDEX_SCHEMA_VERSION,
    action: 'output_handle_index_record',
    mutate: (currentRecord) => {
      const current = currentRecord?.value;
      if (current) {
        if (current.schemaVersion !== OUTPUT_HANDLE_INDEX_SCHEMA_VERSION
          || current.handleId !== handleId
          || current.kind !== input.kind
          || current.fingerprint !== fingerprint
          || bindingsConflict(current, { principalId, sessionId, workId, operationId })) {
          throw new Error(`OUTPUT_HANDLE_ID_COLLISION: ${handleId}`);
        }
        // Identical historical duplicates collapse to one locator. Canonical
        // instance storage always outranks a legacy repository location.
        const nextStorage = current.storage.scope === 'instance' || storage.scope !== 'instance'
          ? current.storage
          : storage;
        return {
          ...current,
          storage: nextStorage,
          ...(current.repositoryId || repositoryId ? { repositoryId: current.repositoryId ?? repositoryId } : {}),
          ...(current.principalId || principalId ? { principalId: current.principalId ?? principalId } : {}),
          ...(current.sessionId || sessionId ? { sessionId: current.sessionId ?? sessionId } : {}),
          ...(current.workId || workId ? { workId: current.workId ?? workId } : {}),
          ...(current.operationId || operationId ? { operationId: current.operationId ?? operationId } : {}),
          updatedAt: now,
        };
      }
      return {
        schemaVersion: OUTPUT_HANDLE_INDEX_SCHEMA_VERSION,
        handleId,
        kind: input.kind,
        storage,
        ...(repositoryId ? { repositoryId } : {}),
        ...(principalId ? { principalId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(workId ? { workId } : {}),
        ...(operationId ? { operationId } : {}),
        fingerprint,
        recordedAt: now,
        updatedAt: now,
      };
    },
  });
  return record.value;
}

export function refreshOutputHandleFingerprint(
  controllerHome: string,
  input: {
    handleId: string;
    kind: OutputHandleKind;
    expectedFingerprint: string;
    nextFingerprint: string;
    now?: string;
  },
): OutputHandleIndexEntry {
  const handleId = bounded(input.handleId);
  const expectedFingerprint = bounded(input.expectedFingerprint);
  const nextFingerprint = bounded(input.nextFingerprint);
  if (!handleId || !expectedFingerprint || !nextFingerprint) throw new Error('OUTPUT_HANDLE_FINGERPRINT_REFRESH_REQUIRED');
  const now = input.now ?? new Date().toISOString();
  const record = mutateControlPlaneRecord<OutputHandleIndexEntry>(controllerHome, {
    namespace: OUTPUT_HANDLE_INDEX_NAMESPACE,
    scope: OUTPUT_HANDLE_INDEX_SCOPE,
    key: handleId,
    schemaVersion: OUTPUT_HANDLE_INDEX_SCHEMA_VERSION,
    action: 'output_handle_index_fingerprint_refresh',
    mutate: (currentRecord) => {
      const current = currentRecord?.value;
      if (!current
        || current.schemaVersion !== OUTPUT_HANDLE_INDEX_SCHEMA_VERSION
        || current.handleId !== handleId
        || current.kind !== input.kind
        || current.storage.scope !== 'instance') {
        throw new Error(`OUTPUT_HANDLE_FINGERPRINT_REFRESH_SCOPE_MISMATCH: ${handleId}`);
      }
      if (current.fingerprint !== expectedFingerprint) {
        throw new Error(`OUTPUT_HANDLE_FINGERPRINT_REFRESH_CONFLICT: ${handleId}`);
      }
      return { ...current, fingerprint: nextFingerprint, updatedAt: now };
    },
  });
  return record.value;
}

export function deleteOutputHandleIndexEntry(
  controllerHome: string,
  input: { handleId: string; kind: OutputHandleKind; expectedFingerprint?: string },
): boolean {
  const handleId = bounded(input.handleId);
  if (!handleId) return false;
  const record = readControlPlaneRecord<OutputHandleIndexEntry>(
    controllerHome,
    OUTPUT_HANDLE_INDEX_NAMESPACE,
    OUTPUT_HANDLE_INDEX_SCOPE,
    handleId,
  );
  if (!record) return false;
  const current = record.value;
  if (current.schemaVersion !== OUTPUT_HANDLE_INDEX_SCHEMA_VERSION
    || current.handleId !== handleId
    || current.kind !== input.kind
    || current.storage.scope !== 'instance') {
    throw new Error(`OUTPUT_HANDLE_INDEX_DELETE_SCOPE_MISMATCH: ${handleId}`);
  }
  const expectedFingerprint = bounded(input.expectedFingerprint);
  if (expectedFingerprint && current.fingerprint !== expectedFingerprint) {
    throw new Error(`OUTPUT_HANDLE_INDEX_DELETE_CONFLICT: ${handleId}`);
  }
  return deleteControlPlaneRecord(controllerHome, {
    namespace: OUTPUT_HANDLE_INDEX_NAMESPACE,
    scope: OUTPUT_HANDLE_INDEX_SCOPE,
    key: handleId,
    action: 'output_handle_index_delete',
    expectedRevision: record.revision,
  });
}

export function readOutputHandleIndexEntry(
  controllerHome: string,
  handleId: string,
): OutputHandleIndexEntry | undefined {
  const key = bounded(handleId);
  if (!key) return undefined;
  const record = readControlPlaneRecord<OutputHandleIndexEntry>(
    controllerHome,
    OUTPUT_HANDLE_INDEX_NAMESPACE,
    OUTPUT_HANDLE_INDEX_SCOPE,
    key,
  );
  const value = record?.value;
  if (!value) return undefined;
  if (value.schemaVersion !== OUTPUT_HANDLE_INDEX_SCHEMA_VERSION || value.handleId !== key) {
    throw new Error(`OUTPUT_HANDLE_INDEX_CORRUPT: ${key}`);
  }
  if (!value.fingerprint || !value.kind || !value.storage) {
    throw new Error(`OUTPUT_HANDLE_INDEX_CORRUPT: ${key}`);
  }
  return value;
}
