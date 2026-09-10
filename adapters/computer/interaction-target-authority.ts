import { createHash, randomUUID } from 'crypto';
import type {
  ComputerApplicationStableIdentity,
  ComputerApplicationTarget,
  ComputerApplicationTargetLease,
  ComputerCompatibilityMigrationMarker,
  ComputerInteractionTargetAuthorityPort,
  ComputerInteractionTargetCleanupReport,
  ComputerInteractionTargetEntry,
  ComputerProviderTargetBinding,
  ComputerSurfaceCompatibilityRecord,
  ComputerSurfaceProviderBinding,
  ComputerSurfaceUpsertInput,
  ComputerSurfaceUpsertResult,
  ComputerSurfaceStableIdentity,
  ComputerSurfaceTarget,
  ComputerSurfaceVisibility,
  ComputerSurfaceTargetLease,
} from '../../packages/plugin-runtime/computer/target-authority';
import type {
  ComputerTargetPersistencePort,
  ComputerTargetPersistenceRecord,
  ComputerTargetPersistenceTransaction,
} from '../../packages/plugin-runtime/computer/target-persistence';

const COMPUTER_TARGET_NAMESPACE = 'computer_interaction_target';
const COMPUTER_TARGET_SCOPE = 'controller';
const COMPUTER_TARGET_INDEX_NAMESPACE = 'computer_interaction_target_index';
const COMPUTER_TARGET_MIGRATION_NAMESPACE = 'computer_interaction_target_migration';
const COMPUTER_TARGET_RETENTION_POLICY_VERSION = 'computer-target-retention-v1' as const;
const DEFAULT_TARGET_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_TARGET_TOMBSTONES = 256;
const MAX_TARGET_RETENTION_SCAN = 1_000;
const DEFAULT_MAX_TARGET_REMOVALS = 32;
const MAX_SURFACE_ALIASES = 64;
const MAX_SURFACE_REPOSITORIES = 64;
const MAX_SURFACE_ALIAS_LENGTH = 256;
const MAX_REPOSITORY_ID_LENGTH = 256;
const MAX_SURFACE_COMPATIBILITY_RECORDS = 16;
const MAX_SURFACE_COMPATIBILITY_NAMESPACE_LENGTH = 128;
const MAX_SURFACE_COMPATIBILITY_VALUE_BYTES = 65_536;

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

function normalizeSurfaceVisibility(visibility: ComputerSurfaceVisibility | undefined): ComputerSurfaceVisibility {
  if (visibility === undefined || visibility === 'repositories') return 'repositories';
  if (visibility === 'controller') return 'controller';
  throw new Error(`COMPUTER_SURFACE_VISIBILITY_INVALID: ${String(visibility)}`);
}

function normalizeRepositoryIds(values?: readonly string[]): string[] {
  return normalizeBoundedStrings(values, {
    limit: MAX_SURFACE_REPOSITORIES,
    maxLength: MAX_REPOSITORY_ID_LENGTH,
    limitCode: 'COMPUTER_SURFACE_REPOSITORY_LIMIT_EXCEEDED',
    lengthCode: 'COMPUTER_SURFACE_REPOSITORY_ID_TOO_LONG',
  });
}

function normalizeCompatibilityRecord(record: ComputerSurfaceCompatibilityRecord): ComputerSurfaceCompatibilityRecord {
  const namespace = record.namespace.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(namespace) || namespace.length > MAX_SURFACE_COMPATIBILITY_NAMESPACE_LENGTH) {
    throw new Error(`COMPUTER_SURFACE_COMPATIBILITY_NAMESPACE_INVALID: ${record.namespace}`);
  }
  if (!Number.isInteger(record.schemaVersion) || record.schemaVersion < 1) {
    throw new Error(`COMPUTER_SURFACE_COMPATIBILITY_SCHEMA_INVALID: ${record.schemaVersion}`);
  }
  const updatedAt = record.updatedAt.trim();
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error('COMPUTER_SURFACE_COMPATIBILITY_UPDATED_AT_INVALID');
  const value = structuredClone(record.value);
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > MAX_SURFACE_COMPATIBILITY_VALUE_BYTES) throw new Error(`COMPUTER_SURFACE_COMPATIBILITY_VALUE_TOO_LARGE: ${bytes}`);
  return { namespace, schemaVersion: record.schemaVersion, value, updatedAt };
}

function normalizeCompatibilityRecords(records?: readonly ComputerSurfaceCompatibilityRecord[]): ComputerSurfaceCompatibilityRecord[] {
  const byNamespace = new Map<string, ComputerSurfaceCompatibilityRecord>();
  for (const record of records ?? []) byNamespace.set(record.namespace.trim(), normalizeCompatibilityRecord(record));
  if (byNamespace.size > MAX_SURFACE_COMPATIBILITY_RECORDS) {
    throw new Error(`COMPUTER_SURFACE_COMPATIBILITY_RECORD_LIMIT_EXCEEDED: ${byNamespace.size}`);
  }
  return [...byNamespace.values()].sort((left, right) => left.namespace.localeCompare(right.namespace));
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

function surfaceBindingMatches(left: ComputerSurfaceProviderBinding | undefined, right: ComputerSurfaceProviderBinding | undefined): boolean {
  if (!left || !right || !left.windowId || !right.windowId || !left.tabId || !right.tabId) return false;
  return left.providerId === right.providerId
    && (left.browserProduct ?? '') === (right.browserProduct ?? '')
    && left.windowId === right.windowId
    && left.tabId === right.tabId;
}

interface ComputerSurfaceIndexRecord {
  schemaVersion: 1;
  targetId: string;
}

interface ComputerSurfaceIndexReadyRecord {
  schemaVersion: 1;
  status: 'ready';
  indexedAt: string;
}

const COMPUTER_SURFACE_INDEX_READY_KEY = 'surface-index-v1-ready';

function digest40(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function surfaceBindingIndexKey(binding: ComputerSurfaceProviderBinding | undefined): string | undefined {
  if (!binding?.windowId || !binding.tabId) return undefined;
  return `binding-${digest40(`${binding.providerId}:${binding.browserProduct ?? ''}:${binding.windowId}:${binding.tabId}`)}`;
}

function surfaceAliasIndexKey(alias: string, repoId?: string): string {
  return repoId
    ? `alias-repo-${digest40(`${repoId}:${alias}`)}`
    : `alias-controller-${digest40(alias)}`;
}

function surfaceIndexKeysForTarget(target: ComputerSurfaceTarget): string[] {
  const keys: string[] = [];
  const bindingKey = surfaceBindingIndexKey(target.providerBinding);
  if (bindingKey) keys.push(bindingKey);
  for (const alias of target.compatibilityAliases) {
    if (target.visibility === 'controller') keys.push(surfaceAliasIndexKey(alias));
    for (const repoId of target.repositoryIds) keys.push(surfaceAliasIndexKey(alias, repoId));
  }
  return [...new Set(keys)];
}

function surfaceInputIndexKeys(input: {
  visibility: ComputerSurfaceVisibility;
  compatibilityAliases: string[];
  repositoryIds: string[];
  providerBinding?: ComputerSurfaceProviderBinding;
}): string[] {
  const keys: string[] = [];
  const bindingKey = surfaceBindingIndexKey(input.providerBinding);
  if (bindingKey) keys.push(bindingKey);
  for (const alias of input.compatibilityAliases) {
    if (input.visibility === 'controller') keys.push(surfaceAliasIndexKey(alias));
    for (const repoId of input.repositoryIds) keys.push(surfaceAliasIndexKey(alias, repoId));
  }
  return [...new Set(keys)];
}

function writeSurfaceIndexes(transaction: ComputerTargetPersistenceTransaction, target: ComputerSurfaceTarget): void {
  for (const key of surfaceIndexKeysForTarget(target)) {
    const current = transaction.read<ComputerSurfaceIndexRecord>(COMPUTER_TARGET_INDEX_NAMESPACE, COMPUTER_TARGET_SCOPE, key);
    if (current?.value.targetId === target.targetId) continue;
    if (current) {
      const referenced = transaction.read<ComputerInteractionTargetEntry>(COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, current.value.targetId);
      if (referenced?.value.target.kind === 'surface'
        && surfaceIndexKeysForTarget(normalizedSurfaceTarget(referenced.value.target)).includes(key)) {
        throw new Error(`COMPUTER_SURFACE_INDEX_CONFLICT: ${key}`);
      }
    }
    transaction.write({
      namespace: COMPUTER_TARGET_INDEX_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
      key,
      schemaVersion: 1,
      value: { schemaVersion: 1, targetId: target.targetId } satisfies ComputerSurfaceIndexRecord,
      action: current ? 'computer_surface_index_repair' : 'computer_surface_index_create',
      expectedRevision: current?.revision ?? null,
    });
  }
}

function ensureSurfaceIndexes(transaction: ComputerTargetPersistenceTransaction): void {
  const ready = transaction.read<ComputerSurfaceIndexReadyRecord>(
    COMPUTER_TARGET_INDEX_NAMESPACE,
    COMPUTER_TARGET_SCOPE,
    COMPUTER_SURFACE_INDEX_READY_KEY,
  );
  if (ready?.value.status === 'ready') return;
  const surfaces = transaction.listAll<ComputerInteractionTargetEntry>({
    namespace: COMPUTER_TARGET_NAMESPACE,
    scope: COMPUTER_TARGET_SCOPE,
  });
  for (const record of surfaces) {
    if (record.value.target.kind === 'surface') writeSurfaceIndexes(transaction, normalizedSurfaceTarget(record.value.target));
  }
  transaction.write({
    namespace: COMPUTER_TARGET_INDEX_NAMESPACE,
    scope: COMPUTER_TARGET_SCOPE,
    key: COMPUTER_SURFACE_INDEX_READY_KEY,
    schemaVersion: 1,
    value: { schemaVersion: 1, status: 'ready', indexedAt: now() } satisfies ComputerSurfaceIndexReadyRecord,
    action: ready ? 'computer_surface_index_ready_repair' : 'computer_surface_index_ready',
    expectedRevision: ready?.revision ?? null,
  });
}

function normalizedMigrationComponent(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`COMPUTER_COMPATIBILITY_MIGRATION_${label}_INVALID`);
  return normalized;
}

function compatibilityMigrationKey(migrationId: string, scopeId: string): string {
  return `migration-${digest40(`${migrationId}\u0000${scopeId}`)}`;
}

function readIndexedSurfaceRecord(
  transaction: ComputerTargetPersistenceTransaction,
  indexKey: string,
): ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry> | undefined {
  const index = transaction.read<ComputerSurfaceIndexRecord>(COMPUTER_TARGET_INDEX_NAMESPACE, COMPUTER_TARGET_SCOPE, indexKey);
  if (!index) return undefined;
  const target = transaction.read<ComputerInteractionTargetEntry>(COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, index.value.targetId);
  if (target?.value.target.kind === 'surface'
    && surfaceIndexKeysForTarget(normalizedSurfaceTarget(target.value.target)).includes(indexKey)) return target;
  transaction.delete({
    namespace: COMPUTER_TARGET_INDEX_NAMESPACE,
    scope: COMPUTER_TARGET_SCOPE,
    key: indexKey,
    action: 'computer_surface_index_remove_stale',
    expectedRevision: index.revision,
  });
  return undefined;
}

function deleteSurfaceIndexes(
  transaction: ComputerTargetPersistenceTransaction,
  target: ComputerSurfaceTarget,
): void {
  for (const key of surfaceIndexKeysForTarget(target)) {
    const index = transaction.read<ComputerSurfaceIndexRecord>(COMPUTER_TARGET_INDEX_NAMESPACE, COMPUTER_TARGET_SCOPE, key);
    if (!index || index.value.targetId !== target.targetId) continue;
    transaction.delete({
      namespace: COMPUTER_TARGET_INDEX_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
      key,
      action: 'computer_surface_index_delete',
      expectedRevision: index.revision,
    });
  }
}

function normalizedSurfaceTarget(target: ComputerSurfaceTarget): ComputerSurfaceTarget {
  return {
    ...target,
    compatibilityAliases: normalizeCompatibilityAliases(target.compatibilityAliases),
    visibility: normalizeSurfaceVisibility(target.visibility),
    repositoryIds: normalizeRepositoryIds(target.repositoryIds),
    compatibilityRecords: normalizeCompatibilityRecords(target.compatibilityRecords ?? []),
    ...(target.providerBinding ? { providerBinding: normalizeSurfaceProviderBinding(target.providerBinding) } : {}),
  };
}

function surfaceConvergenceLockKey(input: ComputerSurfaceUpsertInput): string {
  const binding = input.providerBinding ? normalizeSurfaceProviderBinding(input.providerBinding) : undefined;
  const nativeKey = binding?.windowId && binding.tabId
    ? `binding:${binding.providerId}:${binding.browserProduct ?? ''}:${binding.windowId}:${binding.tabId}`
    : undefined;
  const aliases = normalizeCompatibilityAliases(input.compatibilityAliases);
  const repositories = normalizeRepositoryIds(input.repositoryIds);
  const fallback = aliases[0] && repositories[0] ? `alias:${repositories[0]}:${aliases[0]}` : aliases[0] ? `alias:${aliases[0]}` : undefined;
  const source = nativeKey ?? fallback;
  if (!source) throw new Error('COMPUTER_SURFACE_CONVERGENCE_KEY_REQUIRED');
  return `surface-converge-${createHash('sha256').update(source).digest('hex').slice(0, 40)}`;
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
      visibility?: ComputerSurfaceVisibility;
      repositoryIds?: string[];
      compatibilityRecords?: ComputerSurfaceCompatibilityRecord[];
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
      visibility: normalizeSurfaceVisibility(input.visibility),
      repositoryIds: normalizeRepositoryIds(input.repositoryIds),
      compatibilityRecords: normalizeCompatibilityRecords(input.compatibilityRecords),
      ...(input.providerBinding ? { providerBinding: normalizeSurfaceProviderBinding(input.providerBinding) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    persistence.transaction(controllerHome, (transaction) => {
      transaction.write({
        namespace: COMPUTER_TARGET_NAMESPACE,
        scope: COMPUTER_TARGET_SCOPE,
        key: targetId,
        schemaVersion: 1,
        value: { schemaVersion: 1, status: 'active', target } satisfies ComputerInteractionTargetEntry,
        action: 'computer_surface_target_create',
        expectedRevision: null,
      });
      writeSurfaceIndexes(transaction, target);
    });
    return structuredClone(target);
  }

  function upsertSurface(controllerHome: string, rawInput: ComputerSurfaceUpsertInput): ComputerSurfaceUpsertResult {
    const stableIdentity = normalizeSurfaceStableIdentity(rawInput.stableIdentity);
    const compatibilityAliases = normalizeCompatibilityAliases(rawInput.compatibilityAliases);
    const visibility = normalizeSurfaceVisibility(rawInput.visibility);
    const repositoryIds = normalizeRepositoryIds(rawInput.repositoryIds);
    const compatibilityRecords = normalizeCompatibilityRecords(rawInput.compatibilityRecords);
    const providerBinding = rawInput.providerBinding ? normalizeSurfaceProviderBinding(rawInput.providerBinding) : undefined;
    const lockKey = surfaceConvergenceLockKey(rawInput);
    const inputIndexKeys = surfaceInputIndexKeys({ visibility, compatibilityAliases, repositoryIds, providerBinding });
    return persistence.transaction(controllerHome, (transaction) => {
      ensureSurfaceIndexes(transaction);
      const indexed = new Map<string, ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry>>();
      for (const indexKey of inputIndexKeys) {
        const candidate = readIndexedSurfaceRecord(transaction, indexKey);
        if (candidate) indexed.set(candidate.key, candidate);
      }
      const matches = [...indexed.values()];
      if (matches.length > 1) throw new Error(`COMPUTER_SURFACE_CONVERGENCE_AMBIGUOUS: ${lockKey}`);
      const existing = matches[0];
      const at = now();
      if (!existing) {
        const targetId = `computer_target_${randomUUID().replaceAll('-', '')}`;
        const target: ComputerSurfaceTarget = {
          schemaVersion: 1,
          targetId,
          kind: 'surface',
          stableIdentity,
          compatibilityAliases,
          visibility,
          repositoryIds,
          compatibilityRecords,
          ...(providerBinding ? { providerBinding } : {}),
          createdAt: at,
          updatedAt: at,
        };
        const status = rawInput.initialStatus ?? 'active';
        transaction.write({
          namespace: COMPUTER_TARGET_NAMESPACE,
          scope: COMPUTER_TARGET_SCOPE,
          key: targetId,
          schemaVersion: 1,
          value: {
            schemaVersion: 1,
            status,
            target,
            ...(status === 'tombstoned' ? { tombstonedAt: at } : {}),
          } satisfies ComputerInteractionTargetEntry,
          action: status === 'tombstoned' ? 'computer_surface_target_import_tombstone' : 'computer_surface_target_upsert_create',
          expectedRevision: null,
        });
        writeSurfaceIndexes(transaction, target);
        return { target: structuredClone(target), status, created: true };
      }

      const currentTarget = normalizedSurfaceTarget(existing.value.target as ComputerSurfaceTarget);
      const compatibilityByNamespace = new Map(currentTarget.compatibilityRecords.map((record) => [record.namespace, record]));
      for (const record of compatibilityRecords) compatibilityByNamespace.set(record.namespace, record);
      const nextStatus = existing.value.status === 'tombstoned' && rawInput.reactivate === true ? 'active' : existing.value.status;
      const target: ComputerSurfaceTarget = {
        ...currentTarget,
        stableIdentity,
        compatibilityAliases: normalizeCompatibilityAliases([...currentTarget.compatibilityAliases, ...compatibilityAliases]),
        visibility: currentTarget.visibility === 'controller' || visibility === 'controller' ? 'controller' : 'repositories',
        repositoryIds: normalizeRepositoryIds([...currentTarget.repositoryIds, ...repositoryIds]),
        compatibilityRecords: normalizeCompatibilityRecords([...compatibilityByNamespace.values()]),
        ...(providerBinding ? { providerBinding } : {}),
        updatedAt: at,
      };
      transaction.write({
        namespace: COMPUTER_TARGET_NAMESPACE,
        scope: COMPUTER_TARGET_SCOPE,
        key: existing.key,
        schemaVersion: 1,
        value: {
          schemaVersion: 1,
          status: nextStatus,
          target,
          ...(nextStatus === 'tombstoned' ? { tombstonedAt: existing.value.tombstonedAt ?? at } : {}),
        } satisfies ComputerInteractionTargetEntry,
        action: nextStatus !== existing.value.status ? 'computer_surface_target_reactivate' : 'computer_surface_target_upsert',
        expectedRevision: existing.revision,
      });
      writeSurfaceIndexes(transaction, target);
      return { target: structuredClone(target), status: nextStatus, created: false };
    });
  }

  function getSurface(controllerHome: string, targetId: string): ComputerSurfaceTarget | undefined {
    const target = readActiveTargetRecord(controllerHome, targetKey(targetId))?.value.target;
    return target?.kind === 'surface' ? structuredClone(normalizedSurfaceTarget(target)) : undefined;
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
      .map((record) => normalizedSurfaceTarget(record.value.target as ComputerSurfaceTarget))
      .filter((target) => !repoId || target.visibility === 'controller' || target.repositoryIds.includes(repoId))
      .slice(0, limit)
      .map((target) => structuredClone(target));
  }

  function listAllSurfaces(controllerHome: string, options: { repoId?: string } = {}): ComputerSurfaceTarget[] {
    const repoId = options.repoId?.trim();
    return persistence.listAll<ComputerInteractionTargetEntry>(controllerHome, {
      namespace: COMPUTER_TARGET_NAMESPACE,
      scope: COMPUTER_TARGET_SCOPE,
    })
      .filter((record) => record.value.status === 'active' && record.value.target.kind === 'surface')
      .map((record) => normalizedSurfaceTarget(record.value.target as ComputerSurfaceTarget))
      .filter((target) => !repoId || target.visibility === 'controller' || target.repositoryIds.includes(repoId))
      .map((target) => structuredClone(target));
  }

  function findSurfaceByAlias(controllerHome: string, alias: string, repoId?: string): ComputerSurfaceTarget | undefined {
    const normalizedAlias = surfaceAlias(alias);
    const normalizedRepoId = repoId?.trim();
    return persistence.transaction(controllerHome, (transaction) => {
      ensureSurfaceIndexes(transaction);
      const indexed = new Map<string, ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry>>();
      for (const indexKey of [surfaceAliasIndexKey(normalizedAlias), ...(normalizedRepoId ? [surfaceAliasIndexKey(normalizedAlias, normalizedRepoId)] : [])]) {
        const candidate = readIndexedSurfaceRecord(transaction, indexKey);
        if (candidate) indexed.set(candidate.key, candidate);
      }
      const matches = [...indexed.values()].filter((record) => {
        if (record.value.status !== 'active' || record.value.target.kind !== 'surface') return false;
        const target = normalizedSurfaceTarget(record.value.target);
        return target.compatibilityAliases.includes(normalizedAlias)
          && (!normalizedRepoId || target.visibility === 'controller' || target.repositoryIds.includes(normalizedRepoId));
      });
      if (matches.length > 1) throw new Error(`COMPUTER_SURFACE_ALIAS_AMBIGUOUS: ${normalizedAlias}`);
      const target = matches[0]?.value.target;
      return target?.kind === 'surface' ? structuredClone(normalizedSurfaceTarget(target)) : undefined;
    });
  }

  function findSurfaceByProviderBinding(controllerHome: string, rawBinding: ComputerSurfaceProviderBinding): ComputerSurfaceTarget | undefined {
    const binding = normalizeSurfaceProviderBinding(rawBinding);
    const indexKey = surfaceBindingIndexKey(binding);
    return persistence.transaction(controllerHome, (transaction) => {
      ensureSurfaceIndexes(transaction);
      let matches: ComputerTargetPersistenceRecord<ComputerInteractionTargetEntry>[] = [];
      if (indexKey) {
        const candidate = readIndexedSurfaceRecord(transaction, indexKey);
        if (candidate?.value.status === 'active' && candidate.value.target.kind === 'surface'
          && surfaceBindingMatches(candidate.value.target.providerBinding, binding)) matches = [candidate];
      }
      if (matches.length > 1) throw new Error('COMPUTER_SURFACE_PROVIDER_BINDING_AMBIGUOUS');
      const target = matches[0]?.value.target;
      return target?.kind === 'surface' ? structuredClone(normalizedSurfaceTarget(target)) : undefined;
    });
  }

  function compatibilityMigrationMarker(
    controllerHome: string,
    migrationId: string,
    scopeId: string,
  ): ComputerCompatibilityMigrationMarker | undefined {
    const normalizedMigrationId = normalizedMigrationComponent(migrationId, 'ID');
    const normalizedScopeId = normalizedMigrationComponent(scopeId, 'SCOPE');
    const record = persistence.read<ComputerCompatibilityMigrationMarker>(
      controllerHome,
      COMPUTER_TARGET_MIGRATION_NAMESPACE,
      COMPUTER_TARGET_SCOPE,
      compatibilityMigrationKey(normalizedMigrationId, normalizedScopeId),
    );
    if (!record) return undefined;
    if (record.value.migrationId !== normalizedMigrationId || record.value.scopeId !== normalizedScopeId || record.value.status !== 'closed') {
      throw new Error('COMPUTER_COMPATIBILITY_MIGRATION_MARKER_INVALID');
    }
    return structuredClone(record.value);
  }

  function closeCompatibilityMigration(
    controllerHome: string,
    input: { migrationId: string; scopeId: string; importedRecordCount: number },
  ): ComputerCompatibilityMigrationMarker {
    const migrationId = normalizedMigrationComponent(input.migrationId, 'ID');
    const scopeId = normalizedMigrationComponent(input.scopeId, 'SCOPE');
    if (!Number.isInteger(input.importedRecordCount) || input.importedRecordCount < 0) {
      throw new Error('COMPUTER_COMPATIBILITY_MIGRATION_COUNT_INVALID');
    }
    const key = compatibilityMigrationKey(migrationId, scopeId);
    return persistence.transaction(controllerHome, (transaction) => {
      const existing = transaction.read<ComputerCompatibilityMigrationMarker>(COMPUTER_TARGET_MIGRATION_NAMESPACE, COMPUTER_TARGET_SCOPE, key);
      if (existing) {
        if (existing.value.migrationId !== migrationId || existing.value.scopeId !== scopeId || existing.value.status !== 'closed') {
          throw new Error('COMPUTER_COMPATIBILITY_MIGRATION_MARKER_INVALID');
        }
        return structuredClone(existing.value);
      }
      const marker: ComputerCompatibilityMigrationMarker = {
        schemaVersion: 1,
        migrationId,
        scopeId,
        status: 'closed',
        closedAt: now(),
        importedRecordCount: input.importedRecordCount,
      };
      transaction.write({
        namespace: COMPUTER_TARGET_MIGRATION_NAMESPACE,
        scope: COMPUTER_TARGET_SCOPE,
        key,
        schemaVersion: 1,
        value: marker,
        action: 'computer_compatibility_migration_close',
        expectedRevision: null,
      });
      return structuredClone(marker);
    });
  }

  function tombstoneSurface(controllerHome: string, targetId: string): boolean {
    const key = targetKey(targetId);
    return persistence.transaction(controllerHome, (transaction) => {
      const current = transaction.read<ComputerInteractionTargetEntry>(COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, key);
      if (!current || current.value.status !== 'active' || current.value.target.kind !== 'surface') return false;
      const at = now();
      transaction.write({
        namespace: COMPUTER_TARGET_NAMESPACE,
        scope: COMPUTER_TARGET_SCOPE,
        key,
        schemaVersion: 1,
        value: {
          schemaVersion: 1,
          status: 'tombstoned',
          target: { ...normalizedSurfaceTarget(current.value.target), updatedAt: at },
          tombstonedAt: at,
        } satisfies ComputerInteractionTargetEntry,
        action: 'computer_surface_target_tombstone',
        expectedRevision: current.revision,
      });
      return true;
    });
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
        const previousTarget = normalizedSurfaceTarget(record.value.target);
        record = persistence.transaction(controllerHome, (transaction) => {
          const current = transaction.read<ComputerInteractionTargetEntry>(COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, key);
          if (!current || current.value.status !== 'active' || current.value.target.kind !== 'surface' || current.revision !== record.revision) {
            throw new Error(`COMPUTER_SURFACE_TARGET_CHANGED: ${key}`);
          }
          deleteSurfaceIndexes(transaction, previousTarget);
          const written = transaction.write({
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key,
            schemaVersion: 1,
            value: { schemaVersion: 1, status: 'active', target },
            action,
            expectedRevision: current.revision,
          });
          writeSurfaceIndexes(transaction, target);
          return written as typeof record;
        });
        return structuredClone(target);
      };
      const lease: ComputerSurfaceTargetLease = {
        current: () => structuredClone(normalizedSurfaceTarget(record.value.target)),
        bind(binding) {
          return persist({
            ...record.value.target,
            providerBinding: normalizeSurfaceProviderBinding(binding),
            updatedAt: now(),
          }, 'computer_surface_target_bind_provider');
        },
        mergeCompatibility(input) {
          const current = normalizedSurfaceTarget(record.value.target);
          const compatibilityAliases = normalizeCompatibilityAliases([
            ...current.compatibilityAliases,
            ...(input.compatibilityAliases ?? []),
          ]);
          const repositoryIds = normalizeRepositoryIds([
            ...current.repositoryIds,
            ...(input.repositoryIds ?? []),
          ]);
          return persist({
            ...current,
            compatibilityAliases,
            repositoryIds,
            updatedAt: now(),
          }, 'computer_surface_target_merge_compatibility');
        },
        putCompatibility(compatibility) {
          const current = normalizedSurfaceTarget(record.value.target);
          const next = new Map(current.compatibilityRecords.map((entry) => [entry.namespace, entry]));
          const normalized = normalizeCompatibilityRecord(compatibility);
          next.set(normalized.namespace, normalized);
          return persist({
            ...current,
            compatibilityRecords: normalizeCompatibilityRecords([...next.values()]),
            updatedAt: now(),
          }, 'computer_surface_target_put_compatibility');
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
        const deleted = await persistence.withTargetLock(controllerHome, record.key, async () => persistence.transaction(controllerHome, (transaction) => {
          const current = transaction.read<ComputerInteractionTargetEntry>(COMPUTER_TARGET_NAMESPACE, COMPUTER_TARGET_SCOPE, record.key);
          if (!current || current.value.status !== 'tombstoned') return false;
          const currentAtMs = Date.parse(current.value.tombstonedAt ?? current.updatedAt);
          const stillExpired = !Number.isFinite(currentAtMs) || nowMs - currentAtMs >= ttlMs;
          if (!stillExpired && !capacityEligible) return false;
          if (current.value.target.kind === 'surface') deleteSurfaceIndexes(transaction, normalizedSurfaceTarget(current.value.target));
          return transaction.delete({
            namespace: COMPUTER_TARGET_NAMESPACE,
            scope: COMPUTER_TARGET_SCOPE,
            key: record.key,
            action: 'computer_target_retention_delete',
            expectedRevision: current.revision,
          });
        }));
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
    upsertSurface,
    getSurface,
    requireSurface,
    findSurfaceByAlias,
    findSurfaceByProviderBinding,
    listSurfaces,
    listAllSurfaces,
    compatibilityMigrationMarker,
    closeCompatibilityMigration,
    tombstoneSurface,
    withSurfaceLease,
    cleanupTombstones,
  };
}
