import {
  findActiveCanonicalGrant,
  listCanonicalGrants,
  reconcileCanonicalGrants,
  recordCanonicalGrant,
  revokeCanonicalGrant,
  type Grant,
} from '../../../packages/kernel/identity/api/index';
import { randomUUID } from 'crypto';
import { existsSync, renameSync } from 'fs';
import { join } from 'path';
import { controllerSystemRoot } from '../../cli/repositories/controller-home';
import { ControllerLockContentionError, withControllerLock } from '../../cli/repositories/locks';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import type { AssistantPluginActionRisk, AssistantPluginAuthorizationTarget } from './types';

export const DEFAULT_PLUGIN_CAPABILITY_GRANT_MINUTES = 30 * 24 * 60;
const MAX_PLUGIN_CAPABILITY_GRANT_MINUTES = 90 * 24 * 60;

export type PluginCapabilityAuthorizationGrantErrorCode =
  | 'PLUGIN_CAPABILITY_GRANT_STORE_CORRUPT'
  | 'PLUGIN_CAPABILITY_GRANT_STORE_BUSY'
  | 'PLUGIN_CAPABILITY_GRANT_ARGUMENT_INVALID'
  | 'PLUGIN_CAPABILITY_GRANT_DESTRUCTIVE_DENIED'
  | 'PLUGIN_CAPABILITY_GRANT_NOT_FOUND'
  | 'PLUGIN_CAPABILITY_GRANT_OWNER_MISMATCH';

export class PluginCapabilityAuthorizationGrantError extends Error {
  constructor(
    public readonly code: PluginCapabilityAuthorizationGrantErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginCapabilityAuthorizationGrantError';
  }
}

export interface PluginCapabilityAuthorizationGrant {
  schemaVersion: 1;
  grantId: string;
  ownerScope: string;
  repoId?: string;
  pluginId: string;
  capabilityId: string;
  target: AssistantPluginAuthorizationTarget;
  scopes: string[];
  riskCeiling: Exclude<AssistantPluginActionRisk, 'destructive'>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedReason?: string;
}

interface PluginCapabilityAuthorizationGrantStore {
  schemaVersion: 1;
  grants: PluginCapabilityAuthorizationGrant[];
}

export interface PluginCapabilityAuthorizationQuery {
  ownerScope: string;
  repoId?: string;
  pluginId: string;
  capabilityId: string;
  target: AssistantPluginAuthorizationTarget;
  scopes: readonly string[];
  risk: AssistantPluginActionRisk;
  at?: Date;
}

export interface RecordPluginCapabilityAuthorizationInput extends Omit<PluginCapabilityAuthorizationQuery, 'risk' | 'at'> {
  riskCeiling: AssistantPluginActionRisk;
  expiresInMinutes?: number;
  now?: Date;
}

export interface RevokePluginCapabilityAuthorizationInput {
  grantId: string;
  ownerScope: string;
  reason: string;
  now?: Date;
}

export interface ReconcilePluginCapabilityAuthorizationsInput {
  retiredOwnerScopes?: readonly string[];
  now?: Date;
}

export interface ReconcilePluginCapabilityAuthorizationsResult {
  removedRetiredOwner: number;
  removedRevoked: number;
  removedExpired: number;
  removedTotal: number;
  remaining: number;
  changed: boolean;
}

const GENERIC_PLUGIN_AUTHORIZATION_ACTORS = new Set(['', 'anonymous', 'plugin_action_execute']);

export function pluginCapabilityAuthorizationOwnerScope(origin: { surface: string; actor?: string }): string {
  const actor = origin.actor?.trim() ?? '';
  if (GENERIC_PLUGIN_AUTHORIZATION_ACTORS.has(actor)) return 'controller:shared';
  return `${origin.surface}:${actor}`;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new PluginCapabilityAuthorizationGrantError(
      'PLUGIN_CAPABILITY_GRANT_ARGUMENT_INVALID',
      `${label} is required.`,
    );
  }
  return normalized;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function normalizeTarget(target: AssistantPluginAuthorizationTarget): AssistantPluginAuthorizationTarget {
  const kind = required(target.kind, 'target.kind');
  const id = required(target.id, 'target.id');
  const identityFingerprint = target.identityFingerprint?.trim();
  return {
    kind,
    id,
    ...(identityFingerprint ? { identityFingerprint } : {}),
  };
}

function validateRisk(value: unknown, index: number): Exclude<AssistantPluginActionRisk, 'destructive'> {
  if (value === 'readonly' || value === 'workspace_write' || value === 'remote_write') return value;
  throw new Error(`grants[${index}].riskCeiling is invalid`);
}

function validatePersistedGrant(value: unknown, index: number): PluginCapabilityAuthorizationGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`grants[${index}] must be an object`);
  const record = value as Record<string, unknown>;
  const string = (field: string) => {
    const current = record[field];
    if (typeof current !== 'string' || !current.trim()) throw new Error(`grants[${index}].${field} is invalid`);
    return current.trim();
  };
  const targetValue = record.target;
  if (!targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue)) throw new Error(`grants[${index}].target is invalid`);
  const targetRecord = targetValue as Record<string, unknown>;
  if (typeof targetRecord.kind !== 'string' || !targetRecord.kind.trim() || typeof targetRecord.id !== 'string' || !targetRecord.id.trim()) {
    throw new Error(`grants[${index}].target identity is invalid`);
  }
  if (targetRecord.identityFingerprint !== undefined && typeof targetRecord.identityFingerprint !== 'string') {
    throw new Error(`grants[${index}].target.identityFingerprint is invalid`);
  }
  if (!Array.isArray(record.scopes) || record.scopes.some((scope) => typeof scope !== 'string')) {
    throw new Error(`grants[${index}].scopes is invalid`);
  }
  const createdAt = string('createdAt');
  const updatedAt = string('updatedAt');
  const expiresAt = string('expiresAt');
  if (![createdAt, updatedAt, expiresAt].every((timestamp) => Number.isFinite(Date.parse(timestamp)))) {
    throw new Error(`grants[${index}] has invalid timestamps`);
  }
  if (Date.parse(expiresAt) < Date.parse(createdAt)) throw new Error(`grants[${index}] expires before creation`);
  const revokedAt = record.revokedAt;
  const revokedReason = record.revokedReason;
  if (revokedAt !== undefined && (typeof revokedAt !== 'string' || !Number.isFinite(Date.parse(revokedAt)))) {
    throw new Error(`grants[${index}].revokedAt is invalid`);
  }
  if (revokedReason !== undefined && typeof revokedReason !== 'string') throw new Error(`grants[${index}].revokedReason is invalid`);
  return {
    schemaVersion: 1,
    grantId: string('grantId'),
    ownerScope: string('ownerScope'),
    // Pre-canonical plugin grants could omit repoId for controller/account targets.
    // Normalize that omission once during the one-way migration; authorization
    // against the canonical Grant store is exact after this point.
    repoId: typeof record.repoId === 'string' && record.repoId.trim() ? record.repoId.trim() : 'controller:global',
    pluginId: string('pluginId'),
    capabilityId: string('capabilityId'),
    target: normalizeTarget({
      kind: targetRecord.kind,
      id: targetRecord.id,
      ...(typeof targetRecord.identityFingerprint === 'string' && targetRecord.identityFingerprint.trim()
        ? { identityFingerprint: targetRecord.identityFingerprint.trim() }
        : {}),
    }),
    scopes: normalizeScopes(record.scopes as string[]),
    riskCeiling: validateRisk(record.riskCeiling, index),
    createdAt,
    updatedAt,
    expiresAt,
    ...(typeof revokedAt === 'string' ? { revokedAt } : {}),
    ...(typeof revokedReason === 'string' ? { revokedReason } : {}),
  };
}

export function pluginCapabilityAuthorizationGrantStorePath(controllerHome: string): string {
  return join(controllerSystemRoot(controllerHome), 'plugin-capability-authorizations', 'grants.json');
}

function legacyPluginGrantMigrationMarkerPath(controllerHome: string): string {
  return join(controllerSystemRoot(controllerHome), 'plugin-capability-authorizations', 'migration.json');
}

/**
 * Durable proof that this Controller Home already ran the one-way migration, so
 * authorization reads stop consulting the legacy file at all.
 */
interface LegacyPluginGrantMigrationMarker {
  schemaVersion: 1;
  migratedAt: string;
  legacyGrantCount: number;
  canonicalGrantCount: number;
}

function readLegacyPluginGrantMigrationMarker(controllerHome: string): LegacyPluginGrantMigrationMarker | undefined {
  const path = legacyPluginGrantMigrationMarkerPath(controllerHome);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readJsonFile<Record<string, unknown>>(path);
    if (raw?.schemaVersion !== 1
      || typeof raw.migratedAt !== 'string'
      || typeof raw.legacyGrantCount !== 'number'
      || typeof raw.canonicalGrantCount !== 'number') {
      throw new Error('migration marker schema is invalid');
    }
    return raw as unknown as LegacyPluginGrantMigrationMarker;
  } catch (error) {
    throw new PluginCapabilityAuthorizationGrantError(
      'PLUGIN_CAPABILITY_GRANT_STORE_CORRUPT',
      `Plugin capability authorization migration marker is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadStore(controllerHome: string): PluginCapabilityAuthorizationGrantStore {
  const path = pluginCapabilityAuthorizationGrantStorePath(controllerHome);
  if (!existsSync(path)) return { schemaVersion: 1, grants: [] };
  try {
    const raw = readJsonFile<unknown>(path);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('store must be an object');
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.grants)) throw new Error('schemaVersion/grants are invalid');
    return { schemaVersion: 1, grants: record.grants.map(validatePersistedGrant) };
  } catch (error) {
    throw new PluginCapabilityAuthorizationGrantError(
      'PLUGIN_CAPABILITY_GRANT_STORE_CORRUPT',
      `Plugin capability authorization store is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function pluginMetadataFromCanonicalGrant(grant: Grant): { pluginId: string; capabilityId: string } | undefined {
  const constraints = grant.constraints;
  if (!constraints || constraints.kind !== 'plugin_capability_authorization') return undefined;
  const pluginId = typeof constraints.pluginId === 'string' ? constraints.pluginId.trim() : '';
  const capabilityId = typeof constraints.capabilityId === 'string' ? constraints.capabilityId.trim() : '';
  return pluginId && capabilityId ? { pluginId, capabilityId } : undefined;
}

function pluginGrantFromCanonical(
  grant: Grant,
  fallback?: { pluginId: string; capabilityId: string; repoId?: string; target?: AssistantPluginAuthorizationTarget },
): PluginCapabilityAuthorizationGrant | undefined {
  const metadata = pluginMetadataFromCanonicalGrant(grant)
    ?? (fallback ? { pluginId: fallback.pluginId, capabilityId: fallback.capabilityId } : undefined);
  if (!metadata || !grant.target) return undefined;
  if (grant.riskCeiling === 'destructive') return undefined;
  const ownerScope = grant.ownerScope?.trim() || grant.principalId.trim();
  if (!ownerScope) return undefined;
  const target: AssistantPluginAuthorizationTarget = {
    kind: grant.target.kind,
    id: grant.target.id,
    ...(grant.target.identityFingerprint ? { identityFingerprint: grant.target.identityFingerprint } : fallback?.target?.identityFingerprint ? { identityFingerprint: fallback.target.identityFingerprint } : {}),
  };
  return {
    schemaVersion: 1,
    grantId: grant.grantId,
    ownerScope,
    repoId: grant.target.repoId ?? fallback?.repoId ?? 'controller:global',
    pluginId: metadata.pluginId,
    capabilityId: metadata.capabilityId,
    target,
    scopes: [...(grant.scopes ?? [])],
    riskCeiling: grant.riskCeiling ?? 'readonly',
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    expiresAt: grant.expiresAt,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
    ...(grant.revokedReason ? { revokedReason: grant.revokedReason } : {}),
  };
}

function recordCanonicalPluginGrant(
  controllerHome: string,
  grant: PluginCapabilityAuthorizationGrant,
  now?: Date,
): PluginCapabilityAuthorizationGrant {
  const expiresInMinutes = Math.max(1, Math.ceil((Date.parse(grant.expiresAt) - (now ?? new Date()).getTime()) / 60_000));
  const canonical = recordCanonicalGrant(controllerHome, {
    grantId: grant.grantId,
    principalId: grant.ownerScope,
    ownerScope: grant.ownerScope,
    capabilities: [`${grant.pluginId}:${grant.capabilityId}`, grant.capabilityId],
    target: {
      kind: grant.target.kind,
      id: grant.target.id,
      repoId: grant.repoId,
      ...(grant.target.identityFingerprint ? { identityFingerprint: grant.target.identityFingerprint } : {}),
    },
    scopes: grant.scopes,
    riskCeiling: grant.riskCeiling,
    constraints: { kind: 'plugin_capability_authorization', pluginId: grant.pluginId, capabilityId: grant.capabilityId },
    expiresInMinutes,
    now,
  });
  return pluginGrantFromCanonical(canonical, grant)!;
}

/**
 * One-way migration input. The legacy plugin grant file is read-only history:
 * every still-authorizable legacy grant is copied into the canonical Grant
 * authority exactly once, and this module never writes the legacy file again.
 * A corrupt migration input still fails closed so un-migrated grants cannot be
 * silently dropped.
 *
 * Removal trigger: once a released Runtime baseline has shipped with the
 * `migration.json` marker (so every install has migrated at least once), delete
 * this migration, `loadStore`/`validatePersistedGrant`, the legacy path getter
 * and the PLUGIN_CAPABILITY_GRANT_STORE_CORRUPT error code in the same slice.
 * The archived `grants.json.migrated-*` file is recoverable history, not input.
 */
function migrateLegacyPluginCapabilityGrants(controllerHome: string, at = new Date()): void {
  if (readLegacyPluginGrantMigrationMarker(controllerHome)) return;
  const legacyGrants = loadStore(controllerHome).grants;
  const canonicalById = new Map(listCanonicalGrants(controllerHome).map((grant) => [grant.grantId, grant]));
  const atMs = at.getTime();
  for (const grant of legacyGrants) {
    if (grant.revokedAt) continue;
    if (Date.parse(grant.expiresAt) <= atMs) continue;
    const existing = canonicalById.get(grant.grantId);
    if (existing) {
      // A canonical row written before plugin metadata existed cannot be projected
      // back into a plugin grant. Repair it in place instead of leaving a live grant
      // that neither list nor by-id resolution can see.
      if (existing.revokedAt || pluginMetadataFromCanonicalGrant(existing)) continue;
      recordCanonicalPluginGrant(controllerHome, grant, new Date(grant.createdAt));
      continue;
    }
    recordCanonicalPluginGrant(controllerHome, grant, new Date(grant.createdAt));
    canonicalById.set(grant.grantId, { grantId: grant.grantId } as Grant);
  }
  // The migration is complete for this Controller Home: prove it durably, then
  // move the legacy file aside so no authorization read can ever depend on it
  // again. The archive is recoverable; a failed rename leaves an inert file.
  writeJsonAtomic(legacyPluginGrantMigrationMarkerPath(controllerHome), {
    schemaVersion: 1,
    migratedAt: at.toISOString(),
    legacyGrantCount: legacyGrants.length,
    canonicalGrantCount: listCanonicalGrants(controllerHome).length,
  } satisfies LegacyPluginGrantMigrationMarker);
  const legacyPath = pluginCapabilityAuthorizationGrantStorePath(controllerHome);
  if (existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, `${legacyPath}.migrated-${at.getTime()}`);
    } catch {
      // Inert history; the marker already prevents any further legacy read.
    }
  }
}

export function findActivePluginCapabilityAuthorization(
  controllerHome: string,
  query: PluginCapabilityAuthorizationQuery,
): PluginCapabilityAuthorizationGrant | undefined {
  if (query.risk === 'destructive') return undefined;
  const ownerScope = required(query.ownerScope, 'ownerScope');
  const repoId = (query.repoId?.trim()) || 'controller:global';
  const pluginId = required(query.pluginId, 'pluginId');
  const capabilityId = required(query.capabilityId, 'capabilityId');
  const target = normalizeTarget(query.target);
  const scopes = normalizeScopes(query.scopes);
  migrateLegacyPluginCapabilityGrants(controllerHome, query.at ?? new Date());
  const canonical = findActiveCanonicalGrant(controllerHome, {
    ownerScope,
    capability: `${pluginId}:${capabilityId}`,
    target: { kind: target.kind, id: target.id, repoId, ...(target.identityFingerprint ? { identityFingerprint: target.identityFingerprint } : {}) },
    scopes,
    risk: query.risk,
    at: query.at,
  });
  return canonical ? pluginGrantFromCanonical(canonical, { pluginId, capabilityId, repoId, target }) : undefined;
}

/**
 * Resolve one exact grant reference for a trusted Workflow/Controller caller.
 * The caller still has to validate plugin, capability, target, scope and risk;
 * this helper only enforces that the referenced grant is live and unrevoked.
 */
export function findActivePluginCapabilityAuthorizationById(
  controllerHome: string,
  grantId: string,
  at = new Date(),
): PluginCapabilityAuthorizationGrant | undefined {
  const normalizedGrantId = required(grantId, 'grantId');
  const atMs = at.getTime();
  migrateLegacyPluginCapabilityGrants(controllerHome, at);
  const canonical = listCanonicalGrants(controllerHome).find((entry) => entry.grantId === normalizedGrantId);
  if (canonical && !canonical.revokedAt && Date.parse(canonical.expiresAt) > atMs) {
    return pluginGrantFromCanonical(canonical);
  }
  return undefined;
}

export function recordPluginCapabilityAuthorization(
  controllerHome: string,
  input: RecordPluginCapabilityAuthorizationInput,
): PluginCapabilityAuthorizationGrant {
  if (input.riskCeiling === 'destructive') {
    throw new PluginCapabilityAuthorizationGrantError(
      'PLUGIN_CAPABILITY_GRANT_DESTRUCTIVE_DENIED',
      'Destructive plugin actions can never establish reusable capability authorization.',
    );
  }
  const now = input.now ?? new Date();
  const ownerScope = required(input.ownerScope, 'ownerScope');
  const repoId = (input.repoId?.trim()) || 'controller:global';
  const pluginId = required(input.pluginId, 'pluginId');
  const capabilityId = required(input.capabilityId, 'capabilityId');
  const target = normalizeTarget(input.target);
  const scopes = normalizeScopes(input.scopes);
  const rawMinutes = input.expiresInMinutes ?? DEFAULT_PLUGIN_CAPABILITY_GRANT_MINUTES;
  if (!Number.isFinite(rawMinutes) || rawMinutes <= 0) {
    throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_ARGUMENT_INVALID', 'expiresInMinutes must be positive.');
  }
  const expiresInMinutes = Math.min(Math.max(1, Math.trunc(rawMinutes)), MAX_PLUGIN_CAPABILITY_GRANT_MINUTES);
  const timestamp = now.toISOString();
  migrateLegacyPluginCapabilityGrants(controllerHome, now);
  const grant: PluginCapabilityAuthorizationGrant = {
    schemaVersion: 1,
    grantId: `plugin-grant-${randomUUID()}`,
    ownerScope,
    repoId,
    pluginId,
    capabilityId,
    target,
    scopes,
    riskCeiling: input.riskCeiling,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000).toISOString(),
  };
  try {
    return withControllerLock(
      controllerHome,
      { scope: 'global', resource: 'plugin-capability-authorization-grants' },
      `plugin-capability-grant:${ownerScope}`,
      () => {
        const canonicalGrant = recordCanonicalGrant(controllerHome, {
          grantId: grant.grantId,
          principalId: grant.ownerScope,
          ownerScope: grant.ownerScope,
          capabilities: [`${grant.pluginId}:${grant.capabilityId}`, grant.capabilityId],
          target: { kind: grant.target.kind, id: grant.target.id, repoId: grant.repoId, ...(grant.target.identityFingerprint ? { identityFingerprint: grant.target.identityFingerprint } : {}) },
          scopes: grant.scopes,
          riskCeiling: grant.riskCeiling,
          constraints: { kind: 'plugin_capability_authorization', pluginId: grant.pluginId, capabilityId: grant.capabilityId },
          expiresInMinutes,
          now,
        });
        return pluginGrantFromCanonical(canonicalGrant, grant)!;
      },
      5_000,
    );
  } catch (error) {
    if (error instanceof ControllerLockContentionError) {
      throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_STORE_BUSY', error.message);
    }
    throw error;
  }
}

export function revokePluginCapabilityAuthorization(
  controllerHome: string,
  input: RevokePluginCapabilityAuthorizationInput,
): PluginCapabilityAuthorizationGrant {
  const grantId = required(input.grantId, 'grantId');
  const ownerScope = required(input.ownerScope, 'ownerScope');
  const reason = required(input.reason, 'reason');
  const now = input.now ?? new Date();
  try {
    return withControllerLock(
      controllerHome,
      { scope: 'global', resource: 'plugin-capability-authorization-grants' },
      `plugin-capability-revoke:${ownerScope}`,
      () => {
        const current = findActivePluginCapabilityAuthorizationById(controllerHome, grantId, now);
        if (!current) throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_NOT_FOUND', `Grant ${grantId} was not found.`);
        if (current.ownerScope !== ownerScope) {
          throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_OWNER_MISMATCH', `Grant ${grantId} belongs to another owner scope.`);
        }
        const canonical = revokeCanonicalGrant(controllerHome, { grantId, ownerScope, reason, now });
        return pluginGrantFromCanonical(canonical, current)!;
      },
      5_000,
    );
  } catch (error) {
    if (error instanceof ControllerLockContentionError) {
      throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_STORE_BUSY', error.message);
    }
    throw error;
  }
}

export function reconcilePluginCapabilityAuthorizations(
  controllerHome: string,
  input: ReconcilePluginCapabilityAuthorizationsInput = {},
): ReconcilePluginCapabilityAuthorizationsResult {
  const retiredOwnerScopes = new Set(
    (input.retiredOwnerScopes ?? [])
      .map((ownerScope) => required(ownerScope, 'retiredOwnerScopes[]')),
  );
  const nowMs = (input.now ?? new Date()).getTime();
  try {
    return withControllerLock(
      controllerHome,
      { scope: 'global', resource: 'plugin-capability-authorization-grants' },
      'plugin-capability-reconcile',
      () => {
        void nowMs;
        migrateLegacyPluginCapabilityGrants(controllerHome, input.now ?? new Date());
        const canonical = reconcileCanonicalGrants(controllerHome, {
          retiredOwnerScopes: [...retiredOwnerScopes],
          now: input.now,
        });
        const grants = listCanonicalGrants(controllerHome)
          .map((grant) => pluginGrantFromCanonical(grant))
          .filter((grant): grant is PluginCapabilityAuthorizationGrant => Boolean(grant));
        return {
          removedRetiredOwner: canonical.removedRetiredOwner,
          removedRevoked: canonical.removedRevoked,
          removedExpired: canonical.removedExpired,
          removedTotal: canonical.removedTotal,
          remaining: grants.length,
          changed: canonical.changed,
        };
      },
      5_000,
    );
  } catch (error) {
    if (error instanceof ControllerLockContentionError) {
      throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_STORE_BUSY', error.message);
    }
    throw error;
  }
}

export function listPluginCapabilityAuthorizations(
  controllerHome: string,
  ownerScope?: string,
): PluginCapabilityAuthorizationGrant[] {
  migrateLegacyPluginCapabilityGrants(controllerHome);
  const normalizedOwner = ownerScope?.trim();
  return listCanonicalGrants(controllerHome, normalizedOwner ? { ownerScope: normalizedOwner } : undefined)
    .map((grant) => pluginGrantFromCanonical(grant))
    .filter((grant): grant is PluginCapabilityAuthorizationGrant => Boolean(grant));
}
