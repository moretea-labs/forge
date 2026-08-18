import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
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
  repoId: string;
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
  repoId: string;
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

const RISK_RANK: Record<AssistantPluginActionRisk, number> = {
  readonly: 0,
  workspace_write: 1,
  remote_write: 2,
  destructive: 3,
};

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
    repoId: string('repoId'),
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

function saveStore(controllerHome: string, store: PluginCapabilityAuthorizationGrantStore): void {
  const path = pluginCapabilityAuthorizationGrantStorePath(controllerHome);
  mkdirSync(join(controllerSystemRoot(controllerHome), 'plugin-capability-authorizations'), { recursive: true });
  writeJsonAtomic(path, store);
}

function targetMatches(left: AssistantPluginAuthorizationTarget, right: AssistantPluginAuthorizationTarget): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && (left.identityFingerprint ?? '') === (right.identityFingerprint ?? '');
}

function scopesContain(granted: readonly string[], requested: readonly string[]): boolean {
  const available = new Set(granted);
  return requested.every((scope) => available.has(scope));
}

export function findActivePluginCapabilityAuthorization(
  controllerHome: string,
  query: PluginCapabilityAuthorizationQuery,
): PluginCapabilityAuthorizationGrant | undefined {
  if (query.risk === 'destructive') return undefined;
  const ownerScope = required(query.ownerScope, 'ownerScope');
  const repoId = required(query.repoId, 'repoId');
  const pluginId = required(query.pluginId, 'pluginId');
  const capabilityId = required(query.capabilityId, 'capabilityId');
  const target = normalizeTarget(query.target);
  const scopes = normalizeScopes(query.scopes);
  const atMs = (query.at ?? new Date()).getTime();
  return loadStore(controllerHome).grants
    .filter((grant) => !grant.revokedAt && Date.parse(grant.expiresAt) > atMs)
    .filter((grant) => grant.ownerScope === ownerScope
      && grant.repoId === repoId
      && grant.pluginId === pluginId
      && grant.capabilityId === capabilityId
      && targetMatches(grant.target, target)
      && scopesContain(grant.scopes, scopes)
      && RISK_RANK[grant.riskCeiling] >= RISK_RANK[query.risk])
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
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
  const repoId = required(input.repoId, 'repoId');
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
        const store = loadStore(controllerHome);
        store.grants = store.grants.filter((entry) => !(entry.ownerScope === ownerScope
          && entry.repoId === repoId
          && entry.pluginId === pluginId
          && entry.capabilityId === capabilityId
          && entry.target.kind === target.kind
          && entry.target.id === target.id));
        store.grants.push(grant);
        saveStore(controllerHome, store);
        return grant;
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
        const store = loadStore(controllerHome);
        const index = store.grants.findIndex((grant) => grant.grantId === grantId);
        if (index < 0) throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_NOT_FOUND', `Grant ${grantId} was not found.`);
        const current = store.grants[index]!;
        if (current.ownerScope !== ownerScope) {
          throw new PluginCapabilityAuthorizationGrantError('PLUGIN_CAPABILITY_GRANT_OWNER_MISMATCH', `Grant ${grantId} belongs to another owner scope.`);
        }
        const revoked: PluginCapabilityAuthorizationGrant = {
          ...current,
          updatedAt: now.toISOString(),
          revokedAt: now.toISOString(),
          revokedReason: reason,
        };
        store.grants[index] = revoked;
        saveStore(controllerHome, store);
        return revoked;
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
  const normalizedOwner = ownerScope?.trim();
  return loadStore(controllerHome).grants
    .filter((grant) => !normalizedOwner || grant.ownerScope === normalizedOwner)
    .map((grant) => structuredClone(grant));
}
