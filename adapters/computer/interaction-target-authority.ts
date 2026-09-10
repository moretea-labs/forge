import { randomUUID } from 'crypto';
import type {
  ComputerApplicationStableIdentity,
  ComputerApplicationTarget,
  ComputerApplicationTargetLease,
  ComputerInteractionTargetAuthorityPort,
  ComputerInteractionTargetCleanupReport,
  ComputerInteractionTargetEntry,
  ComputerProviderTargetBinding,
  ComputerSurfaceProviderBinding,
  ComputerSurfaceStableIdentity,
  ComputerSurfaceTarget,
  ComputerSurfaceTargetLease,
} from '../../packages/plugin-runtime/computer/target-authority';
import type {
  ComputerTargetPersistencePort,
  ComputerTargetPersistenceRecord,
} from '../../packages/plugin-runtime/computer/target-persistence';

const COMPUTER_TARGET_NAMESPACE = 'computer_interaction_target';
const COMPUTER_TARGET_SCOPE = 'controller';
const COMPUTER_TARGET_RETENTION_POLICY_VERSION = 'computer-target-retention-v1' as const;
const DEFAULT_TARGET_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_TARGET_TOMBSTONES = 256;
const MAX_TARGET_RETENTION_SCAN = 1_000;
const DEFAULT_MAX_TARGET_REMOVALS = 32;
const MAX_SURFACE_ALIASES = 64;
const MAX_SURFACE_REPOSITORIES = 64;
const MAX_SURFACE_ALIAS_LENGTH = 256;
const MAX_REPOSITORY_ID_LENGTH = 256;

function now(): string { return new Date().toISOString(); }

function normalizeStableIdentity(identity: ComputerApplicationStableIdentity): ComputerApplicationStableIdentity {
  const bundleId = identity.bundleId?.trim();
  const appName = identity.appName?.trim();
  if (!bundleId && !appName) throw new Error('COMPUTER_TARGET_STABLE_IDENTITY_REQUIRED: bundleId or appName is required');
  return { ...(bundleId ? { bundleId } : {}), ...(appName ? { appName } : {}) };
}

function normalizeProviderBinding(binding: ComputerProviderTargetBinding): ComputerProviderTargetBinding {
  const providerId = binding.providerId.trim();
  const providerSessionId = binding.providerSessionId.trim();
  const observedAt = binding.observedAt.trim();
  if (!providerId) throw new Error('COMPUTER_TARGET_PROVIDER_ID_REQUIRED');
  if (!providerSessionId) throw new Error('COMPUTER_TARGET_PROVIDER_SESSION_ID_REQUIRED');
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) throw new Error('COMPUTER_TARGET_PROVIDER_OBSERVED_AT_INVALID');
  return { providerId, providerSessionId, observedAt };
}

function normalizeSurfaceStableIdentity(identity: ComputerSurfaceStableIdentity): ComputerSurfaceStableIdentity {
  if (identity.surfaceType !== 'browser-tab' && identity.surfaceType !== 'browser-page') {
    throw new Error(`COMPUTER_SURFACE_TYPE_INVALID: ${String(identity.surfaceType)}`);
  }
  if (identity.ownership !== 'plugin_owned' && identity.ownership !== 'user_owned' && identity.ownership !== 'provider_owned') {
    throw new Error(`COMPUTER_SURFACE_OWNERSHIP_INVALID: ${String(identity.ownership)}`);
  }
  return {
    surfaceType: identity.surfaceType,
    ownership: identity.ownership,
    ...(identity.application ? { application: normalizeStableIdentity(identity.application) } : {}),
  };
}

function normalizeBoundedStrings(
  values: readonly string[] | undefined,
  options: { limit: number; maxLength: number; limitCode: string; lengthCode: string },
): string[] {
  const normalized: string[] = [];
  for (const raw of values ?? []) {
    const value = raw.trim();
    if (!value) continue;
    if (value.length > options.maxLength) throw new Error(`${options.lengthCode}: ${value.length}`);
    if (!normalized.includes(value)) normalized.push(value);
  }
  if (normalized.length > options.limit) throw new Error(`${options.limitCode}: ${normalized.length}`);
  return normalized;
}

function normalizeCompatibilityAliases(values?: readonly string[]): string[] {
  return normalizeBoundedStrings(values, {
    limit: MAX_SURFACE_ALIASES,
    maxLength: MAX_SURFACE_ALIAS_LENGTH,
    limitCode: 'COMPUTER_SURFACE_ALIAS_LIMIT_EXCEEDED',
    lengthCode: 'COMPUTER_SURFACE_ALIAS_TOO_LONG',
  });
}

function normalizeRepositoryIds(values?: readonly string[]): string[] {
  return normalizeBoundedStrings(values, {
    limit: MAX_SURFACE_REPOSITORIES,
    maxLength: MAX_REPOSITORY_ID_LENGTH,
    limitCode: 'COMPUTER_SURFACE_REPOSITORY_LIMIT_EXCEEDED',
    lengthCode: 'COMPUTER_SURFACE_REPOSITORY_ID_TOO_LONG',
  });
}

function normalizeSurfaceProviderBinding(binding: ComputerSurfaceProviderBinding): ComputerSurfaceProviderBinding {
  const providerId = binding.providerId.trim();
  const observedAt = binding.observedAt.trim();
  if (!providerId) throw new Error('COMPUTER_SURFACE_PROVIDER_ID_REQUIRED');
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) throw new Error('COMPUTER_SURFACE_PROVIDER_OBSERVED_AT_INVALID');
  const optional = (value: string | undefined): string | undefined => {
    const normalized = value?.trim();
    return normalized || undefined;
  };
  const providerSessionId = optional(binding.providerSessionId);
  const browserProduct = optional(binding.browserProduct);
  const windowId = optional(binding.windowId);
  const tabId = optional(binding.tabId);
  const ownerToken = optional(binding.ownerToken);
  return {
    providerId,
    observedAt,
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(browserProduct ? { browserProduct } : {}),
    ...(windowId ? { windowId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(ownerToken ? { ownerToken } : {}),
  };
}

function targetKey(targetId: string): string {
  const normalized = targetId.trim();
  if (!/^computer_target_[a-f0-9]{32}$/.test(normalized)) throw new Error(`COMPUTER_TARGET_ID_INVALID: ${targetId}`);
  return normalized;
}

function surfaceAlias(alias: string): string {
  const normalized = alias.trim();
  if (!normalized) throw new Error('COMPUTER_SURFACE_ALIAS_REQUIRED');
  if (normalized.length > MAX_SURFACE_ALIAS_LENGTH) throw new Error(`COMPUTER_SURFACE_ALIAS_TOO_LONG: ${normalized.length}`);
  return normalized;
}

export function createComputerInteractionTargetAuthority(
  persistence: ComputerTargetPersistencePort,
): ComputerInteractionTargetAuthorityPort {
  function readActiveTargetRecord(
    controllerHome: string,
    targetId: string,
  ): ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry> | undefined {
    const current = persistence.read<ComputerInteractionTargetEntry>(
      controllerHome, COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, targetId,
    );
    return current?.value.status === 'active' ? current : undefined;
  }

  function requireActiveApplicationTargetRecord(
    controllerHome: string,
    targetId: string,
  ): ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry & { target: ComputerApplicationTarget }> {
    const current = readActiveTargetRecord(controllerHome, targetId);
    if (!current || current.value.target.kind !== 'application') throw new Error(`COMPUTER_TARGET_NOT_FOUND: ${targetId}`);
    return current as ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry & { target: ComputerApplicationTarget }>;
  }

  function requireActiveSurfaceTargetRecord(
    controllerHome: string,
    targetId: string,
  ): ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry & { target: ComputerSurfaceTarget }> {
    const current = readActiveTargetRecord(controllerHome, targetId);
    if (!current || current.value.target.kind !== 'surface') throw new Error(`COMPUTER_SURFACE_TARGET_NOT_FOUND: ${targetId}`);
    return current as ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry & { target: ComputerSurfaceTarget }>;
  }

  function create(
    controllerHome: string,
    input: { stableIdentity: ComputerApplicationStableIdentity; providerBinding?: ComputerProviderTargetBinding },
  ): ComputerApplicationTarget {
    const at = now();
    const targetId = `computer_target_${randomUUID().replaceAll('-', '')}`;
    const target: ComputerApplicationTarget = {
      schemaVersion: 1,
      targetId,
      kind: 'application',
      stableIdentity: normalizeStableIdentity(input.stableIdentity),
      ...(input.providerBinding ? { providerBinding: normalizeProviderBinding(input.providerBinding) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    persistence.write(controllerHome, {
      namespace: COMPUTER_TARGET_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
      key: targetId,
      schemaVersion: 1,
      value: { schemaVersion: 1, status: 'active', target } satisfies ComputerInteractionTargetEntry,
      action: 'computer_target_create',
      expectedRevision: null,
    });
    return target;
  }

  function get(controllerHome: string, targetId: string): ComputerApplicationTarget | undefined {
    const target = readActiveTargetRecord(controllerHome, targetKey(targetId))?.value.target;
    return target?.kind === 'application' ? structuredClone(target) : undefined;
  }

  function requireTarget(controllerHome: string, targetId: string): ComputerApplicationTarget {
    const target = get(controllerHome, targetId);
    if (!target) throw new Error(`COMPUTER_TARGET_NOT_FOUND: ${targetId}`);
    return target;
  }

  async function withLease<T>(
    controllerHome: string,
    targetId: string,
    operation: (lease: ComputerApplicationTargetLease) => Promise<T>,
  ): Promise<T> {
    const key = targetKey(targetId);
    return persistence.withTargetLock(controllerHome, key, async () => {
      let record = requireActiveApplicationTargetRecord(controllerHome, key);
      const lease: ComputerApplicationTargetLease = {
        current: () => structuredClone(record.value.target),
        bind(binding) {
          const target: ComputerApplicationTarget = {
            ...record.value.target,
            providerBinding: normalizeProviderBinding(binding),
            updatedAt: now(),
          };
          record = persistence.write(controllerHome, {
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key,
            schemaVersion: 1,
            value: { schemaVersion: 1, status: 'active', target },
            action: 'computer_target_bind_provider',
            expectedRevision: record.revision,
          }) as typeof record;
          return structuredClone(target);
        },
        tombstone() {
          const at = now();
          const target: ComputerApplicationTarget = { ...record.value.target, updatedAt: at };
          persistence.write(controllerHome, {
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key,
            schemaVersion: 1,
            value: { schemaVersion: 1, status: 'tombstoned', target, tombstonedAt: at },
            action: 'computer_target_tombstone',
            expectedRevision: record.revision,
          });
          return structuredClone(target);
        },
      };
      return operation(lease);
    });
  }

  function createSurface(
    controllerHome: string,
    input: {
      stableIdentity: ComputerSurfaceStableIdentity;
      compatibilityAliases?: string[];
      repositoryIds?: string[];
      providerBinding?: ComputerSurfaceProviderBinding;
    },
  ): ComputerSurfaceTarget {
    const at = now();
    const targetId = `computer_target_${randomUUID().replaceAll('-', '')}`;
    const target: ComputerSurfaceTarget = {
      schemaVersion: 1,
      targetId,
      kind: 'surface',
      stableIdentity: normalizeSurfaceStableIdentity(input.stableIdentity),
      compatibilityAliases: normalizeCompatibilityAliases(input.compatibilityAliases),
      repositoryIds: normalizeRepositoryIds(input.repositoryIds),
      ...(input.providerBinding ? { providerBinding: normalizeSurfaceProviderBinding(input.providerBinding) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    persistence.write(controllerHome, {
      namespace: COMPUTER_TARGET_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
      key: targetId,
      schemaVersion: 1,
      value: { schemaVersion: 1, status: 'active', target } satisfies ComputerInteractionTargetEntry,
      action: 'computer_surface_target_create',
      expectedRevision: null,
    });
    return structuredClone(target);
  }

  function getSurface(controllerHome: string, targetId: string): ComputerSurfaceTarget | undefined {
    const target = readActiveTargetRecord(controllerHome, targetKey(targetId))?.value.target;
    return target?.kind === 'surface' ? structuredClone(target) : undefined;
  }

  function requireSurface(controllerHome: string, targetId: string): ComputerSurfaceTarget {
    const target = getSurface(controllerHome, targetId);
    if (!target) throw new Error(`COMPUTER_SURFACE_TARGET_NOT_FOUND: ${targetId}`);
    return target;
  }

  function listSurfaces(
    controllerHome: string,
    options: { repoId?: string; limit?: number } = {},
  ): ComputerSurfaceTarget[] {
    const repoId = options.repoId?.trim();
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 200), MAX_TARGET_RETENTION_SCAN));
    return persistence.list<ComputerInteractionTargetEntry>(controllerHome, {
      namespace: COMPUTER_TARGET_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
      limit: MAX_TARGET_RETENTION_SCAN,
    })
      .filter((record) => record.value.status === 'active' && record.value.target.kind === 'surface')
      .map((record) => record.value.target as ComputerSurfaceTarget)
      .filter((target) => !repoId || target.repositoryIds.includes(repoId))
      .slice(0, limit)
      .map((target) => structuredClone(target));
  }

  function findSurfaceByAlias(controllerHome: string, alias: string, repoId?: string): ComputerSurfaceTarget | undefined {
    const normalizedAlias = surfaceAlias(alias);
    const matches = listSurfaces(controllerHome, { ...(repoId ? { repoId } : {}), limit: MAX_TARGET_RETENTION_SCAN })
      .filter((target) => target.compatibilityAliases.includes(normalizedAlias));
    if (matches.length > 1) throw new Error(`COMPUTER_SURFACE_ALIAS_AMBIGUOUS: ${normalizedAlias}`);
    return matches[0];
  }

  async function withSurfaceLease<T>(
    controllerHome: string,
    targetId: string,
    operation: (lease: ComputerSurfaceTargetLease) => Promise<T>,
  ): Promise<T> {
    const key = targetKey(targetId);
    return persistence.withTargetLock(controllerHome, key, async () => {
      let record = requireActiveSurfaceTargetRecord(controllerHome, key);
      const persist = (target: ComputerSurfaceTarget, action: string): ComputerSurfaceTarget => {
        record = persistence.write(controllerHome, {
          namespace: COMPUTER_TARGET_NAMESPACE,
          scope: COMPUTER_TARGET_SCOPE,
          key,
          schemaVersion: 1,
          value: { schemaVersion: 1, status: 'active', target },
          action,
          expectedRevision: record.revision,
        }) as typeof record;
        return structuredClone(target);
      };
      const lease: ComputerSurfaceTargetLease = {
        current: () => structuredClone(record.value.target),
        bind(binding) {
          return persist({
            ...record.value.target,
            providerBinding: normalizeSurfaceProviderBinding(binding),
            updatedAt: now(),
          }, 'computer_surface_target_bind_provider');
        },
        mergeCompatibility(input) {
          const compatibilityAliases = normalizeCompatibilityAliases([
            ...record.value.target.compatibilityAliases,
            ...(input.compatibilityAliases ?? []),
          ]);
          const repositoryIds = normalizeRepositoryIds([
            ...record.value.target.repositoryIds,
            ...(input.repositoryIds ?? []),
          ]);
          return persist({
            ...record.value.target,
            compatibilityAliases,
            repositoryIds,
            updatedAt: now(),
          }, 'computer_surface_target_merge_compatibility');
        },
        tombstone() {
          const at = now();
          const target: ComputerSurfaceTarget = { ...record.value.target, updatedAt: at };
          persistence.write(controllerHome, {
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key,
            schemaVersion: 1,
            value: { schemaVersion: 1, status: 'tombstoned', target, tombstonedAt: at },
            action: 'computer_surface_target_tombstone',
            expectedRevision: record.revision,
          });
          return structuredClone(target);
        },
      };
      return operation(lease);
    });
  }

  async function cleanupTombstones(
    controllerHome: string,
    options: { nowMs?: number; ttlMs?: number; maxTombstones?: number; maxRemovals?: number } = {},
  ): Promise<ComputerInteractionTargetCleanupReport> {
    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    const ttlMs = Math.max(60_000, Math.trunc(options.ttlMs ?? DEFAULT_TARGET_TOMBSTONE_TTL_MS));
    const maxTombstones = Math.max(0, Math.min(Math.trunc(options.maxTombstones ?? DEFAULT_MAX_TARGET_TOMBSTONES), MAX_TARGET_RETENTION_SCAN));
    const maxRemovals = Math.max(1, Math.min(Math.trunc(options.maxRemovals ?? DEFAULT_MAX_TARGET_REMOVALS), 128));
    const records = persistence.list<ComputerInteractionTargetEntry>(controllerHome, {
      namespace: COMPUTER_TARGET_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
      limit: MAX_TARGET_RETENTION_SCAN,
    });
    const activeProtected = records.filter((record) => record.value.status === 'active').length;
    const tombstones = records
      .filter((record) => record.value.status === 'tombstoned')
      .sort((left, right) => {
        const leftAt = Date.parse(left.value.tombstonedAt ?? left.updatedAt);
        const rightAt = Date.parse(right.value.tombstonedAt ?? right.updatedAt);
        return (Number.isFinite(leftAt) ? leftAt : Number.MIN_SAFE_INTEGER) - (Number.isFinite(rightAt) ? rightAt : Number.MIN_SAFE_INTEGER);
      });
    let overCapacityCount = Math.max(0, tombstones.length - maxTombstones);
    let removed = 0;
    const blockers: string[] = [];

    for (const record of tombstones) {
      const tombstonedAtMs = Date.parse(record.value.tombstonedAt ?? record.updatedAt);
      const expired = !Number.isFinite(tombstonedAtMs) || nowMs - tombstonedAtMs >= ttlMs;
      const capacityEligible = overCapacityCount > 0;
      if (!expired && !capacityEligible) continue;
      if (removed >= maxRemovals) break;
      try {
        const deleted = await persistence.withTargetLock(controllerHome, record.key, async () => {
          const current = persistence.read<ComputerInteractionTargetEntry>(
            controllerHome, COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, record.key,
          );
          if (!current || current.value.status !== 'tombstoned') return false;
          const currentAtMs = Date.parse(current.value.tombstonedAt ?? current.updatedAt);
          const stillExpired = !Number.isFinite(currentAtMs) || nowMs - currentAtMs >= ttlMs;
          if (!stillExpired && !capacityEligible) return false;
          return persistence.delete(controllerHome, {
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key: record.key,
            action: 'computer_target_retention_delete',
            expectedRevision: current.revision,
          });
        });
        if (deleted) {
          removed += 1;
          if (capacityEligible) overCapacityCount = Math.max(0, overCapacityCount - 1);
        }
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
      }
    }

    const retained = Math.max(0, tombstones.length - removed);
    const eligibleCount = tombstones.filter((record) => {
      const atMs = Date.parse(record.value.tombstonedAt ?? record.updatedAt);
      return !Number.isFinite(atMs) || nowMs - atMs >= ttlMs;
    }).length + Math.max(0, tombstones.length - maxTombstones);
    return {
      policyVersion: COMPUTER_TARGET_RETENTION_POLICY_VERSION,
      inspected: records.length,
      activeProtected,
      tombstones: tombstones.length,
      removed,
      retained,
      overCapacity: retained > maxTombstones,
      budgetExhausted: removed >= maxRemovals && eligibleCount > removed,
      blockers: blockers.slice(0, 16),
    };
  }

  return {
    create,
    get,
    require: requireTarget,
    withLease,
    createSurface,
    getSurface,
    requireSurface,
    findSurfaceByAlias,
    listSurfaces,
    withSurfaceLease,
    cleanupTombstones,
  };
}
