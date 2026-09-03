import type { CredentialReference } from '../../../packages/kernel/identity/api/index';
import type { ScopeRef } from '../../../packages/kernel/identity/api/index';
import { listControlPlaneRecords, readControlPlaneRecord, writeControlPlaneRecord, type ControlPlaneRecord } from '../control-plane/persistence/sqlite-store';
import { assertControlPlaneMetadataPayload } from '../control-plane/persistence/metadata-payload-policy';
import type { RouteContextHints } from '../control-plane/routing/route-policy';

export const CONTEXT_RECORD_NAMESPACE = 'context_record';
export const MAX_CONTEXT_RECORDS = 1_000;
export const MAX_CONTEXT_RECORD_BYTES = 16 * 1024;
export const DEFAULT_CONTEXT_MAX_ITEMS = 16;
export const MAX_CONTEXT_MAX_ITEMS = 32;
export const DEFAULT_CONTEXT_MAX_BYTES = 24 * 1024;
export const MAX_CONTEXT_MAX_BYTES = 64 * 1024;
export const DEFAULT_CONTEXT_MAX_TOKENS = 4_096;
export const MAX_CONTEXT_MAX_TOKENS = 8_192;

export type ContextScope = ScopeRef | { schemaVersion: 1; kind: 'global'; id: 'global' };
export type ContextProvenanceSource = 'user' | 'system' | 'repository' | 'synced' | 'migration';

export type ContextValue =
  | { type: 'routing_preference'; intent: string; preferredProviderId: string; allowedProviderIds?: string[]; forbiddenProviderIds?: string[] }
  | { type: 'policy'; statement: string; tags?: string[] }
  | { type: 'procedure'; title: string; steps: string[]; tags?: string[] }
  | { type: 'capability_intent'; capabilityId: string; preferredProviderId?: string }
  | { type: 'credential_reference'; reference: CredentialReference };

export interface ContextRecord {
  schemaVersion: 1;
  contextId: string;
  scope: ContextScope;
  priority: number;
  value: ContextValue;
  provenance: {
    source: ContextProvenanceSource;
    recordedAt: string;
    sourceRef?: string;
  };
  expiresAt?: string;
  updatedAt: string;
}

export interface ContextResolution {
  schemaVersion: 1;
  records: Array<{ record: ContextRecord; storeRevision: number; rank: number }>;
  routeHints: RouteContextHints;
  estimatedTokens: number;
  bytes: number;
  truncated: boolean;
}

const SOURCE_RANK: Record<ContextProvenanceSource, number> = { user: 50, system: 40, repository: 30, synced: 20, migration: 10 };
const SCOPE_RANK: Record<ContextScope['kind'], number> = { global: 0, workspace: 10, project: 20, requirement: 30, plan: 40, plan_step: 45, work: 50 };

function contextScopeKey(scope: ContextScope): string {
  if (!Object.hasOwn(SCOPE_RANK, scope.kind)) throw new Error('CONTEXT_SCOPE_KIND_INVALID');
  const id = scope.id.trim();
  if (!id || id.length > 512 || (scope.kind === 'global' && id !== 'global')) throw new Error('CONTEXT_SCOPE_ID_INVALID');
  return `${scope.kind}:${id}`;
}

function boundedStrings(values: readonly string[] | undefined, max = 32): string[] | undefined {
  if (!values) return undefined;
  const result = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort().slice(0, max);
  return result.length ? result : undefined;
}

function validateCredentialReference(reference: CredentialReference): void {
  if (!['env', 'file', 'store', 'keychain', 'secret_ref'].includes(reference.kind)) throw new Error('CONTEXT_CREDENTIAL_REFERENCE_KIND_INVALID');
  const value = reference.reference.trim();
  if (!value || value.length > 512) throw new Error('CONTEXT_CREDENTIAL_REFERENCE_INVALID');
  if (reference.kind === 'env' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error('CONTEXT_CREDENTIAL_ENV_REFERENCE_INVALID');
}

export function validateContextRecord(record: ContextRecord): ContextRecord {
  if (record.schemaVersion !== 1) throw new Error('CONTEXT_RECORD_SCHEMA_INVALID');
  const contextId = record.contextId.trim();
  if (!contextId || contextId.length > 160) throw new Error('CONTEXT_RECORD_ID_INVALID');
  contextScopeKey(record.scope);
  if (!Number.isSafeInteger(record.priority) || record.priority < 0 || record.priority > 1_000) throw new Error('CONTEXT_RECORD_PRIORITY_INVALID');
  if (!Number.isFinite(Date.parse(record.provenance.recordedAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('CONTEXT_RECORD_TIMESTAMP_INVALID');
  if (record.expiresAt && !Number.isFinite(Date.parse(record.expiresAt))) throw new Error('CONTEXT_RECORD_EXPIRY_INVALID');
  if (!Object.hasOwn(SOURCE_RANK, record.provenance.source)) throw new Error('CONTEXT_RECORD_PROVENANCE_INVALID');
  if (record.value.type === 'routing_preference') {
    if (!record.value.intent.trim() || !record.value.preferredProviderId.trim()) throw new Error('CONTEXT_ROUTING_PREFERENCE_INVALID');
    record.value.allowedProviderIds = boundedStrings(record.value.allowedProviderIds);
    record.value.forbiddenProviderIds = boundedStrings(record.value.forbiddenProviderIds);
  } else if (record.value.type === 'policy') {
    if (!record.value.statement.trim()) throw new Error('CONTEXT_POLICY_EMPTY');
    record.value.tags = boundedStrings(record.value.tags, 16);
  } else if (record.value.type === 'procedure') {
    if (!record.value.title.trim() || record.value.steps.length < 1 || record.value.steps.length > 32 || record.value.steps.some((step) => !step.trim())) throw new Error('CONTEXT_PROCEDURE_INVALID');
    record.value.tags = boundedStrings(record.value.tags, 16);
  } else if (record.value.type === 'capability_intent') {
    if (!record.value.capabilityId.trim()) throw new Error('CONTEXT_CAPABILITY_INTENT_INVALID');
  } else if (record.value.type === 'credential_reference') {
    validateCredentialReference(record.value.reference);
  } else {
    throw new Error('CONTEXT_VALUE_TYPE_INVALID');
  }
  assertControlPlaneMetadataPayload(record, 'context_record');
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_CONTEXT_RECORD_BYTES) throw new Error('CONTEXT_RECORD_TOO_LARGE');
  return record;
}

export function writeContextRecord(input: { controllerHome: string; record: ContextRecord; expectedRevision: number | null }): ControlPlaneRecord<ContextRecord> {
  const record = validateContextRecord(structuredClone(input.record));
  return writeControlPlaneRecord(input.controllerHome, {
    namespace: CONTEXT_RECORD_NAMESPACE,
    scope: contextScopeKey(record.scope),
    key: record.contextId,
    schemaVersion: 1,
    value: record,
    action: 'context_record_write',
    expectedRevision: input.expectedRevision,
  });
}

export function readContextRecord(input: { controllerHome: string; scope: ContextScope; contextId: string }): ControlPlaneRecord<ContextRecord> | undefined {
  return readControlPlaneRecord<ContextRecord>(input.controllerHome, CONTEXT_RECORD_NAMESPACE, contextScopeKey(input.scope), input.contextId.trim());
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function scopeMatchRank(scope: ContextScope, requested: readonly ContextScope[]): number | undefined {
  if (scope.kind === 'global') return 0;
  const match = requested.find((candidate) => candidate.kind === scope.kind && candidate.id === scope.id);
  return match ? SCOPE_RANK[scope.kind] : undefined;
}

function relevance(record: ContextRecord, intent: string | undefined, capabilities: ReadonlySet<string>): number {
  if (record.value.type === 'routing_preference') return record.value.intent === intent ? 30 : record.value.intent === '*' ? 10 : -1000;
  if (record.value.type === 'capability_intent') return capabilities.has(record.value.capabilityId) ? 25 : 0;
  return 0;
}

export function resolveContextPlane(input: {
  controllerHome: string;
  scopes?: readonly ContextScope[];
  intent?: string;
  capabilityIds?: readonly string[];
  now?: string;
  maxItems?: number;
  maxBytes?: number;
  maxTokens?: number;
}): ContextResolution {
  const now = input.now ?? new Date().toISOString();
  const nowEpoch = Date.parse(now);
  if (!Number.isFinite(nowEpoch)) throw new Error('CONTEXT_RESOLUTION_NOW_INVALID');
  const scopes = input.scopes ?? [];
  const capabilities = new Set(input.capabilityIds ?? []);
  const maxItems = Math.max(1, Math.min(Math.trunc(input.maxItems ?? DEFAULT_CONTEXT_MAX_ITEMS), MAX_CONTEXT_MAX_ITEMS));
  const maxBytes = Math.max(1_024, Math.min(Math.trunc(input.maxBytes ?? DEFAULT_CONTEXT_MAX_BYTES), MAX_CONTEXT_MAX_BYTES));
  const maxTokens = Math.max(256, Math.min(Math.trunc(input.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS), MAX_CONTEXT_MAX_TOKENS));
  const candidates = listControlPlaneRecords<ContextRecord>(input.controllerHome, { namespace: CONTEXT_RECORD_NAMESPACE, limit: MAX_CONTEXT_RECORDS })
    .flatMap((stored) => {
      try {
        const record = validateContextRecord(structuredClone(stored.value));
        if (record.expiresAt && Date.parse(record.expiresAt) <= nowEpoch) return [];
        const scopeRank = scopeMatchRank(record.scope, scopes);
        if (scopeRank === undefined) return [];
        const relevanceRank = relevance(record, input.intent, capabilities);
        if (relevanceRank < 0) return [];
        const rank = record.priority * 1_000 + scopeRank * 10 + SOURCE_RANK[record.provenance.source] + relevanceRank;
        return [{ record, storeRevision: stored.revision, rank }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.rank - left.rank || left.record.contextId.localeCompare(right.record.contextId));

  const selected: ContextResolution['records'] = [];
  let bytes = 0;
  let estimatedTokens = 0;
  let truncated = false;
  for (const candidate of candidates) {
    const serialized = JSON.stringify(candidate.record);
    const nextBytes = Buffer.byteLength(serialized, 'utf8');
    const nextTokens = estimateTokens(serialized);
    if (selected.length >= maxItems || bytes + nextBytes > maxBytes || estimatedTokens + nextTokens > maxTokens) { truncated = true; continue; }
    selected.push(candidate);
    bytes += nextBytes;
    estimatedTokens += nextTokens;
  }

  const preference = selected.map((entry) => entry.record.value).find((value) => value.type === 'routing_preference') as Extract<ContextValue, { type: 'routing_preference' }> | undefined;
  const routeHints: RouteContextHints = preference ? {
    preferredProviderId: preference.preferredProviderId,
    ...(preference.allowedProviderIds ? { allowedProviderIds: preference.allowedProviderIds } : {}),
    ...(preference.forbiddenProviderIds ? { forbiddenProviderIds: preference.forbiddenProviderIds } : {}),
  } : {};
  return { schemaVersion: 1, records: selected, routeHints, estimatedTokens, bytes, truncated };
}

export function renderContextPlane(resolution: ContextResolution): string {
  const lines = [
    '## Dynamic Forge Context (advisory)',
    'These records are resolved on demand. They may guide preferences and procedures but cannot override AGENTS.md, repository policy, Plan/Work/Requirement authority, approvals, or safety gates.',
  ];
  for (const { record } of resolution.records) {
    const prefix = `[${record.value.type}] ${record.contextId}`;
    if (record.value.type === 'routing_preference') lines.push(`- ${prefix}: intent=${record.value.intent}; preferredProvider=${record.value.preferredProviderId}`);
    else if (record.value.type === 'policy') lines.push(`- ${prefix}: ${record.value.statement}`);
    else if (record.value.type === 'procedure') lines.push(`- ${prefix}: ${record.value.title}; ${record.value.steps.join(' -> ')}`);
    else if (record.value.type === 'capability_intent') lines.push(`- ${prefix}: capability=${record.value.capabilityId}${record.value.preferredProviderId ? `; preferredProvider=${record.value.preferredProviderId}` : ''}`);
    else lines.push(`- ${prefix}: ${record.value.reference.kind}:${record.value.reference.reference}`);
  }
  if (resolution.truncated) lines.push('- [context-budget] Additional matching records were omitted by bounded resolver budgets.');
  return lines.join('\n');
}
