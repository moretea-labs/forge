/** Portable semantic scope. It must never encode a local checkout or filesystem path. */
export type ScopeKind = 'workspace' | 'project' | 'requirement' | 'plan' | 'plan_step' | 'work';

export interface ScopeRef {
  schemaVersion: 1;
  kind: ScopeKind;
  id: string;
}

/** Node-local execution placement. This is replaceable runtime state, not semantic identity. */
export interface ExecutionPlacement {
  schemaVersion: 1;
  forgeInstanceId?: string;
  repositoryId?: string;
  checkoutId?: string;
}

export type SemanticRecordOrigin = 'local' | 'imported' | 'synced' | 'migration';

/**
 * Bounded metadata for one revisioned semantic record. The payload remains owned
 * by its domain; this envelope supplies portable scope, provenance and revision.
 */
export interface SemanticRecordMetadata {
  schemaVersion: 1;
  scope: ScopeRef;
  revision: number;
  updatedAt: string;
  origin: SemanticRecordOrigin;
  forgeInstanceId?: string;
  principalId?: string;
  sourceRevision?: string;
}

/** Optimistic-concurrency precondition. null means the record must not exist. */
export interface SemanticRecordWriteCondition {
  expectedRevision: number | null;
}

export interface SemanticRecordEnvelope<T> {
  metadata: SemanticRecordMetadata;
  value: T;
}

export function scopeRef(kind: ScopeKind, id: string): ScopeRef {
  const normalized = id.trim();
  if (!normalized) throw new Error('SEMANTIC_SCOPE_ID_REQUIRED');
  return { schemaVersion: 1, kind, id: normalized.slice(0, 512) };
}

export function executionPlacement(input: Omit<ExecutionPlacement, 'schemaVersion'>): ExecutionPlacement {
  const forgeInstanceId = input.forgeInstanceId?.trim() || undefined;
  const repositoryId = input.repositoryId?.trim() || undefined;
  const checkoutId = input.checkoutId?.trim() || undefined;
  if (!forgeInstanceId && !repositoryId && !checkoutId) throw new Error('EXECUTION_PLACEMENT_IDENTITY_REQUIRED');
  return { schemaVersion: 1, ...(forgeInstanceId ? { forgeInstanceId } : {}), ...(repositoryId ? { repositoryId } : {}), ...(checkoutId ? { checkoutId } : {}) };
}

export function semanticRecordMetadata(input: Omit<SemanticRecordMetadata, 'schemaVersion'>): SemanticRecordMetadata {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('SEMANTIC_RECORD_REVISION_INVALID');
  if (Number.isNaN(Date.parse(input.updatedAt))) throw new Error('SEMANTIC_RECORD_UPDATED_AT_INVALID');
  return { schemaVersion: 1, ...input };
}
