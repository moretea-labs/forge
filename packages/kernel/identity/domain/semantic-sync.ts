import type { SemanticRecordEnvelope, SemanticRecordWriteCondition } from './scope';

export const SEMANTIC_SYNC_RECORD_KINDS = ['workspace', 'project', 'requirement', 'plan', 'work'] as const;
export type SemanticSyncRecordKind = (typeof SEMANTIC_SYNC_RECORD_KINDS)[number];

export const MAX_SEMANTIC_SYNC_RECORDS = 1_000;
export const MAX_SEMANTIC_SYNC_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_SEMANTIC_SYNC_JOURNAL_ENTRIES = 256;
export const MAX_SEMANTIC_SYNC_JOURNAL_KEY_SAMPLES = 4;

export interface SemanticSyncRecord<T = unknown> {
  schemaVersion: 1;
  kind: SemanticSyncRecordKind;
  id: string;
  envelope: SemanticRecordEnvelope<T>;
  /** Optimistic precondition against the destination replica-store revision. null means first import. */
  condition: SemanticRecordWriteCondition;
  fingerprint: string;
}

export interface SemanticSyncBundle {
  schemaVersion: 1;
  kind: 'forge_semantic_sync_bundle';
  workspaceId: string;
  projectId: string;
  sourceForgeInstanceId: string;
  generatedAt: string;
  records: SemanticSyncRecord[];
  contentFingerprint: string;
}

export interface SemanticSyncImportConflict {
  recordKey: string;
  code: 'local_authority_conflict' | 'replica_revision_conflict';
  expectedRevision?: number | null;
  actualRevision?: number;
}

export interface SemanticSyncImportReceipt {
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  sourceForgeInstanceId: string;
  targetForgeInstanceId: string;
  bundleFingerprint: string;
  importedAt: string;
  applied: string[];
  converged: string[];
  replicaRevisions: Record<string, number>;
}

export function semanticSyncRecordKey(kind: SemanticSyncRecordKind, id: string): string {
  const normalized = id.trim();
  if (!SEMANTIC_SYNC_RECORD_KINDS.includes(kind) || !normalized || normalized.length > 512) throw new Error('SEMANTIC_SYNC_RECORD_ID_INVALID');
  return `${kind}:${normalized}`;
}

export function assertSemanticSyncRecordBounds(records: readonly SemanticSyncRecord[]): void {
  if (records.length < 1 || records.length > MAX_SEMANTIC_SYNC_RECORDS) throw new Error('SEMANTIC_SYNC_RECORD_COUNT_INVALID');
  const keys = new Set<string>();
  for (const record of records) {
    if (record.schemaVersion !== 1) throw new Error('SEMANTIC_SYNC_RECORD_SCHEMA_INVALID');
    const key = semanticSyncRecordKey(record.kind, record.id);
    if (keys.has(key)) throw new Error(`SEMANTIC_SYNC_RECORD_DUPLICATE: ${key}`);
    keys.add(key);
    if (record.envelope.metadata.scope.kind !== record.kind || record.envelope.metadata.scope.id !== record.id) {
      throw new Error(`SEMANTIC_SYNC_SCOPE_MISMATCH: ${key}`);
    }
    const metadata = record.envelope.metadata;
    if (metadata.schemaVersion !== 1 || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 || Number.isNaN(Date.parse(metadata.updatedAt))) {
      throw new Error(`SEMANTIC_SYNC_METADATA_INVALID: ${key}`);
    }
    if (!['local', 'imported', 'synced', 'migration'].includes(metadata.origin)) {
      throw new Error(`SEMANTIC_SYNC_METADATA_ORIGIN_INVALID: ${key}`);
    }
    if (record.condition.expectedRevision !== null && (!Number.isSafeInteger(record.condition.expectedRevision) || record.condition.expectedRevision < 0)) {
      throw new Error(`SEMANTIC_SYNC_EXPECTED_REVISION_INVALID: ${key}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(record.fingerprint)) throw new Error(`SEMANTIC_SYNC_FINGERPRINT_INVALID: ${key}`);
  }
}
