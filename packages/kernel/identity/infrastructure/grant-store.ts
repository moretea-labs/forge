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

function loadStore(controllerHome: string): GrantStoreData {
  const path = canonicalGrantStorePath(controllerHome);
  if (!existsSync(path)) return { schemaVersion: 1, grants: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('store must be an object');
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.grants)) throw new Error('schemaVersion/grants are invalid');
    return { schemaVersion: 1, grants: record.grants as Grant[] };
  } catch {
    return { schemaVersion: 1, grants: [] };
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
  const kindMatch = left.kind === right.kind;
  const idMatch = left.id === right.id;
  const repoMatch = !left.repoId || !right.repoId || left.repoId === right.repoId;
  const fpMatch = !left.identityFingerprint || !right.identityFingerprint || left.identityFingerprint === right.identityFingerprint;
  return kindMatch && idMatch && repoMatch && fpMatch;
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
  if (query.risk === 'destructive') return undefined;
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
