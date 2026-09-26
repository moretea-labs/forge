import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type {
  Grant,
  GrantTarget,
  QueryGrantInput,
  ReconcileGrantsInput,
  ReconcileGrantsResult,
  RecordGrantInput,
  RevokeGrantInput,
} from '../domain/grant';
import type { ScopeRef } from '../domain/scope';

export const DEFAULT_GRANT_MINUTES = 30 * 24 * 60;
const MAX_GRANT_MINUTES = 90 * 24 * 60;

interface GrantStoreData {
  schemaVersion: 1;
  grants: Grant[];
}

const RISK_RANK: Record<string, number> = {
  readonly: 0,
  workspace_write: 1,
  remote_write: 2,
  destructive: 3,
};

export function canonicalGrantStorePath(controllerHome: string): string {
  return join(resolve(controllerHome), 'system', 'authorization-grants', 'grants.json');
}

const GRANT_RISKS = new Set(['readonly', 'workspace_write', 'remote_write', 'destructive']);
const SCOPE_KINDS = new Set(['workspace', 'project', 'requirement', 'plan', 'plan_step', 'work']);

function validateGrantTarget(value: unknown, label: string): GrantTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const target = value as Record<string, unknown>;
  const kind = typeof target.kind === 'string' ? target.kind.trim() : '';
  const id = typeof target.id === 'string' ? target.id.trim() : '';
  if (!kind || !id) throw new Error(`${label}.kind/id are required`);
  const optionalString = (field: 'repoId' | 'identityFingerprint') => {
    const current = target[field];
    if (current === undefined) return undefined;
    if (typeof current !== 'string' || !current.trim()) throw new Error(`${label}.${field} is invalid`);
    return current.trim();
  };
  let scopeRef: GrantTarget['scopeRef'];
  if (target.scopeRef !== undefined) {
    if (!target.scopeRef || typeof target.scopeRef !== 'object' || Array.isArray(target.scopeRef)) throw new Error(`${label}.scopeRef is invalid`);
    const scope = target.scopeRef as Record<string, unknown>;
    const scopeKind = typeof scope.kind === 'string' ? scope.kind.trim() : '';
    const scopeId = typeof scope.id === 'string' ? scope.id.trim() : '';
    if (scope.schemaVersion !== 1 || !SCOPE_KINDS.has(scopeKind) || !scopeId) throw new Error(`${label}.scopeRef is invalid`);
    scopeRef = { schemaVersion: 1, kind: scopeKind as ScopeRef['kind'], id: scopeId };
  }
  const repoId = optionalString('repoId');
  const identityFingerprint = optionalString('identityFingerprint');
  return { kind, id, ...(repoId ? { repoId } : {}), ...(scopeRef ? { scopeRef } : {}), ...(identityFingerprint ? { identityFingerprint } : {}) };
}

function validatePersistedGrant(value: unknown, index: number): Grant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`grants[${index}] must be an object`);
  const row = value as Record<string, unknown>;
  const requiredString = (field: string) => {
    const current = row[field];
    if (typeof current !== 'string' || !current.trim()) throw new Error(`grants[${index}].${field} is invalid`);
    return current.trim();
  };
  if (row.schemaVersion !== 1) throw new Error(`grants[${index}].schemaVersion is invalid`);
  if (!Array.isArray(row.capabilities) || row.capabilities.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error(`grants[${index}].capabilities is invalid`);
  if (row.scopes !== undefined && (!Array.isArray(row.scopes) || row.scopes.some((entry) => typeof entry !== 'string' || !entry.trim()))) throw new Error(`grants[${index}].scopes is invalid`);
  if (row.riskCeiling !== undefined && (typeof row.riskCeiling !== 'string' || !GRANT_RISKS.has(row.riskCeiling))) throw new Error(`grants[${index}].riskCeiling is invalid`);
  const createdAt = requiredString('createdAt');
  const updatedAt = requiredString('updatedAt');
  const expiresAt = requiredString('expiresAt');
  if (![createdAt, updatedAt, expiresAt].every((timestamp) => Number.isFinite(Date.parse(timestamp)))) throw new Error(`grants[${index}] timestamps are invalid`);
  const revokedAt = row.revokedAt;
  if (revokedAt !== undefined && (typeof revokedAt !== 'string' || !Number.isFinite(Date.parse(revokedAt)))) throw new Error(`grants[${index}].revokedAt is invalid`);
  if (row.revokedReason !== undefined && typeof row.revokedReason !== 'string') throw new Error(`grants[${index}].revokedReason is invalid`);
  if (row.ownerScope !== undefined && (typeof row.ownerScope !== 'string' || !row.ownerScope.trim())) throw new Error(`grants[${index}].ownerScope is invalid`);
  if (row.constraints !== undefined && (!row.constraints || typeof row.constraints !== 'object' || Array.isArray(row.constraints))) throw new Error(`grants[${index}].constraints is invalid`);
  const target = validateGrantTarget(row.target, `grants[${index}].target`);
  return {
    schemaVersion: 1,
    grantId: requiredString('grantId'),
    principalId: requiredString('principalId'),
    ...(typeof row.ownerScope === 'string' && row.ownerScope.trim() ? { ownerScope: row.ownerScope.trim() } : {}),
    capabilities: [...new Set((row.capabilities as string[]).map((entry) => entry.trim()))].sort(),
    ...(target ? { target } : {}),
    ...(Array.isArray(row.scopes) ? { scopes: [...new Set((row.scopes as string[]).map((entry) => entry.trim()))].sort() } : {}),
    ...(typeof row.riskCeiling === 'string' ? { riskCeiling: row.riskCeiling as Grant['riskCeiling'] } : {}),
    ...(row.constraints && typeof row.constraints === 'object' && !Array.isArray(row.constraints) ? { constraints: row.constraints as Record<string, unknown> } : {}),
    createdAt,
    updatedAt,
    expiresAt,
    ...(typeof revokedAt === 'string' ? { revokedAt } : {}),
    ...(typeof row.revokedReason === 'string' ? { revokedReason: row.revokedReason } : {}),
  };
}

function loadStore(controllerHome: string): GrantStoreData {
  const path = canonicalGrantStorePath(controllerHome);
  if (!existsSync(path)) return { schemaVersion: 1, grants: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('store must be an object');
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.grants)) throw new Error('schemaVersion/grants are invalid');
    return { schemaVersion: 1, grants: record.grants.map(validatePersistedGrant) };
  } catch (error) {
    throw new Error(`CANONICAL_GRANT_STORE_CORRUPT: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveStore(controllerHome: string, store: GrantStoreData): void {
  const path = canonicalGrantStorePath(controllerHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function targetMatches(left?: GrantTarget, right?: GrantTarget): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const scopeMatch = (!left.scopeRef && !right.scopeRef)
    || Boolean(left.scopeRef && right.scopeRef
      && left.scopeRef.schemaVersion === right.scopeRef.schemaVersion
      && left.scopeRef.kind === right.scopeRef.kind
      && left.scopeRef.id === right.scopeRef.id);
  return left.kind === right.kind
    && left.id === right.id
    && left.repoId === right.repoId
    && left.identityFingerprint === right.identityFingerprint
    && scopeMatch;
}

function scopesContain(granted: readonly string[] = [], requested: readonly string[] = []): boolean {
  const available = new Set(granted);
  return requested.every((scope) => available.has(scope));
}

function capabilityMatches(grantedCapabilities: readonly string[], requested: string): boolean {
  if (grantedCapabilities.includes('*') || grantedCapabilities.includes(requested)) return true;
  if (requested.includes(':')) {
    const prefix = requested.split(':')[0] + ':*';
    if (grantedCapabilities.includes(prefix)) return true;
  }
  return false;
}

export function recordCanonicalGrant(controllerHome: string, input: RecordGrantInput): Grant {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const expiresInMinutes = Math.min(
    Math.max(1, Math.trunc(input.expiresInMinutes ?? DEFAULT_GRANT_MINUTES)),
    MAX_GRANT_MINUTES,
  );
  const grantId = input.grantId?.trim() || `grant_${randomUUID().replaceAll('-', '')}`;
  const grant: Grant = {
    schemaVersion: 1,
    grantId,
    principalId: input.principalId.trim(),
    ...(input.ownerScope?.trim() ? { ownerScope: input.ownerScope.trim() } : {}),
    capabilities: [...new Set(input.capabilities.map((c) => c.trim()).filter(Boolean))].sort(),
    ...(input.target ? { target: input.target } : {}),
    ...(input.scopes ? { scopes: [...new Set(input.scopes.map((s) => s.trim()).filter(Boolean))].sort() } : {}),
    ...(input.riskCeiling ? { riskCeiling: input.riskCeiling } : {}),
    ...(input.constraints ? { constraints: input.constraints } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000).toISOString(),
  };

  const store = loadStore(controllerHome);
  store.grants = store.grants.filter((entry) => {
    if (entry.grantId === grantId) return false;
    const samePrincipal = entry.principalId === grant.principalId;
    const sameOwner = entry.ownerScope === grant.ownerScope;
    const sameTarget = targetMatches(entry.target, grant.target);
    const sameCapabilities = entry.capabilities.length === grant.capabilities.length
      && entry.capabilities.every((c, i) => c === grant.capabilities[i]);
    return !(samePrincipal && sameOwner && sameTarget && sameCapabilities);
  });
  store.grants.push(grant);
  saveStore(controllerHome, store);
  return grant;
}

export function revokeCanonicalGrant(controllerHome: string, input: RevokeGrantInput): Grant {
  const grantId = input.grantId.trim();
  const now = input.now ?? new Date();
  const store = loadStore(controllerHome);
  const index = store.grants.findIndex((g) => g.grantId === grantId);
  if (index < 0) throw new Error(`GRANT_NOT_FOUND: ${grantId}`);
  const current = store.grants[index]!;
  if (input.ownerScope && current.ownerScope && current.ownerScope !== input.ownerScope.trim()) {
    throw new Error(`GRANT_OWNER_MISMATCH: ${grantId}`);
  }
  const revoked: Grant = {
    ...current,
    updatedAt: now.toISOString(),
    revokedAt: now.toISOString(),
    revokedReason: input.reason.trim(),
  };
  store.grants[index] = revoked;
  saveStore(controllerHome, store);
  return revoked;
}

export function findActiveCanonicalGrant(controllerHome: string, query: QueryGrantInput): Grant | undefined {
  const store = loadStore(controllerHome);
  const nowMs = (query.at ?? new Date()).getTime();
  const requestedRiskRank = RISK_RANK[query.risk ?? 'readonly'] ?? 0;

  for (const grant of store.grants) {
    if (grant.revokedAt) continue;
    if (Date.parse(grant.expiresAt) <= nowMs) continue;
    if (query.principalId && grant.principalId !== query.principalId.trim()) continue;
    if (query.ownerScope && grant.ownerScope && grant.ownerScope !== query.ownerScope.trim()) continue;
    if (!capabilityMatches(grant.capabilities, query.capability)) continue;
    if (query.target && !targetMatches(grant.target, query.target)) continue;
    if (query.scopes && !scopesContain(grant.scopes, query.scopes)) continue;
    if (grant.riskCeiling) {
      const grantRiskRank = RISK_RANK[grant.riskCeiling] ?? 0;
      if (grantRiskRank < requestedRiskRank) continue;
    }
    return structuredClone(grant);
  }
  return undefined;
}

export function listCanonicalGrants(controllerHome: string, filter?: { principalId?: string; ownerScope?: string }): Grant[] {
  const store = loadStore(controllerHome);
  return store.grants
    .filter((grant) => {
      if (filter?.principalId && grant.principalId !== filter.principalId.trim()) return false;
      if (filter?.ownerScope && grant.ownerScope !== filter.ownerScope.trim()) return false;
      return true;
    })
    .map((grant) => structuredClone(grant));
}

export function reconcileCanonicalGrants(controllerHome: string, input: ReconcileGrantsInput = {}): ReconcileGrantsResult {
  const retiredOwnerScopes = new Set((input.retiredOwnerScopes ?? []).map((s) => s.trim()).filter(Boolean));
  const nowMs = (input.now ?? new Date()).getTime();
  const store = loadStore(controllerHome);
  let removedRetiredOwner = 0;
  let removedRevoked = 0;
  let removedExpired = 0;

  const grants = store.grants.filter((grant) => {
    if (grant.ownerScope && retiredOwnerScopes.has(grant.ownerScope)) {
      removedRetiredOwner += 1;
      return false;
    }
    if (grant.revokedAt) {
      removedRevoked += 1;
      return false;
    }
    if (Date.parse(grant.expiresAt) <= nowMs) {
      removedExpired += 1;
      return false;
    }
    return true;
  });

  const removedTotal = removedRetiredOwner + removedRevoked + removedExpired;
  if (removedTotal > 0) {
    store.grants = grants;
    saveStore(controllerHome, store);
  }
  return {
    removedRetiredOwner,
    removedRevoked,
    removedExpired,
    removedTotal,
    remaining: grants.length,
    changed: removedTotal > 0,
  };
}
