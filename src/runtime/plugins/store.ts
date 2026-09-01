import { createHash } from 'crypto';
import { join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { CONTROLLER_SCOPE_REPO_ID, controllerSystemRoot, ensureControllerHome, repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import type { ExecutionJob, ResourceClaimSpec } from '../execution/jobs/types';
import { appendRuntimeEvent } from '../evidence/event-ledger';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import { createFirstPartyPluginAdapterMap } from './first-party-registry';
import { getExternalPluginAdapter, listExternalPluginAdapters } from './external-adapter';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import {
  findActivePluginCapabilityAuthorization,
  pluginCapabilityAuthorizationOwnerScope,
  recordPluginCapabilityAuthorization,
  type PluginCapabilityAuthorizationGrant,
} from './capability-authorization-grants';
import { markControllerContextProjectionDirty } from '../projections/controller-context';
import { classifyRepositoryCommand } from '../../cli/repositories/command-classifier';
import {
  acceptSubmittedWorkContract,
  appendWorkEvidence,
  getWorkContract,
  recordWorkCompletionReceipt,
  updateWorkContract,
} from '../../../packages/kernel/work/api/index';
import { isTerminalWorkContractStatus, type LocalEffectCompletionReceipt, type RemoteEffectCompletionReceipt, type WorkContract, type WorkRisk } from '../control-plane/facade/types';
import type {
  AssistantPluginAdapter,
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginActionRequest,
  AssistantPluginAuthorizationContext,
  AssistantPluginManifest,
  AssistantPluginRegistryIndex,
  AssistantPluginRegistryIndexEntry,
} from './types';

const PLUGIN_ADAPTERS = createFirstPartyPluginAdapterMap();

function resolvePluginAdapter(controllerHome: string, pluginId: string): AssistantPluginAdapter | undefined {
  return PLUGIN_ADAPTERS.get(pluginId) ?? getExternalPluginAdapter(controllerHome, pluginId);
}

function listPluginAdapters(controllerHome: string): AssistantPluginAdapter[] {
  const external = listExternalPluginAdapters(controllerHome).filter((adapter) => !PLUGIN_ADAPTERS.has(adapter.pluginId));
  return [...PLUGIN_ADAPTERS.values(), ...external];
}

export function assistantPluginScope(pluginId: string, controllerHome?: string): AssistantPluginAdapter['scope'] | undefined {
  return PLUGIN_ADAPTERS.get(pluginId)?.scope ?? (controllerHome ? getExternalPluginAdapter(controllerHome, pluginId)?.scope : undefined);
}

const PLUGIN_MANIFEST_LIVE_CACHE_TTL_MS = 5_000;
const PLUGIN_MANIFEST_STORED_CACHE_TTL_MS = Number.POSITIVE_INFINITY;


interface PluginManifestCacheEntry<T> {
  createdAt: number;
  value: T;
}

const pluginManifestListCache = new Map<string, PluginManifestCacheEntry<AssistantPluginManifest[]>>();
const pluginManifestItemCache = new Map<string, PluginManifestCacheEntry<AssistantPluginManifest>>();

function now(): string {
  return new Date().toISOString();
}

export function controllerPluginRepository(controllerHome: string): RepositoryRecord {
  const root = controllerSystemRoot(controllerHome);
  const timestamp = now();
  return {
    schemaVersion: 1,
    repoId: CONTROLLER_SCOPE_REPO_ID,
    displayName: 'Controller local system',
    canonicalRoot: root,
    localRoot: root,
    activeCheckoutId: 'controller',
    checkouts: [],
    defaultBranch: 'none',
    repositoryType: 'local-git',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: join(root, 'local-system', 'targets.json'),
    stateStorageStrategy: 'controller-home',
  };
}

function adapterMatchesRepository(adapter: AssistantPluginAdapter, repository: RepositoryRecord): boolean {
  const scope = adapter.scope ?? 'repository';
  if (scope === 'controller_with_repository_overlay') return true;
  return repository.repoId === CONTROLLER_SCOPE_REPO_ID ? scope === 'controller' : scope === 'repository';
}

function cloneCacheValue<T>(value: T): T {
  return structuredClone(value);
}

function listCacheKey(controllerHome: string, repoId: string, preferStored: boolean): string {
  return `${controllerHome}::${repoId}::list::${preferStored ? 'stored' : 'live'}`;
}

function itemCacheKey(controllerHome: string, repoId: string, pluginId: string, preferStored: boolean): string {
  return `${controllerHome}::${repoId}::item::${pluginId}::${preferStored ? 'stored' : 'live'}`;
}

function readPluginManifestCache<T>(
  cache: Map<string, PluginManifestCacheEntry<T>>,
  key: string,
  maxAgeMs = PLUGIN_MANIFEST_LIVE_CACHE_TTL_MS,
): T | undefined {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (Number.isFinite(maxAgeMs) && Date.now() - cached.createdAt > maxAgeMs) {
    cache.delete(key);
    return undefined;
  }
  return cloneCacheValue(cached.value);
}

function writePluginManifestCache<T>(
  cache: Map<string, PluginManifestCacheEntry<T>>,
  key: string,
  value: T,
): T {
  cache.set(key, {
    createdAt: Date.now(),
    value: cloneCacheValue(value),
  });
  return cloneCacheValue(value);
}

function primePluginManifestItemCache(
  controllerHome: string,
  repoId: string,
  manifests: AssistantPluginManifest[],
  preferStored: boolean,
): void {
  for (const manifest of manifests) {
    pluginManifestItemCache.set(itemCacheKey(controllerHome, repoId, manifest.pluginId, preferStored), {
      createdAt: Date.now(),
      value: cloneCacheValue(manifest),
    });
  }
}

function cacheAssistantPluginManifest(
  controllerHome: string,
  repoId: string,
  manifest: AssistantPluginManifest,
  preferStored: boolean,
): void {
  pluginManifestItemCache.set(itemCacheKey(controllerHome, repoId, manifest.pluginId, preferStored), {
    createdAt: Date.now(),
    value: cloneCacheValue(manifest),
  });
}

function invalidateAssistantPluginManifestCache(
  controllerHome: string,
  repoId: string,
  pluginId?: string,
): void {
  const prefix = `${controllerHome}::${repoId}::`;
  for (const key of pluginManifestListCache.keys()) {
    if (key.startsWith(prefix)) pluginManifestListCache.delete(key);
  }
  if (pluginId) {
    pluginManifestItemCache.delete(itemCacheKey(controllerHome, repoId, pluginId, false));
    pluginManifestItemCache.delete(itemCacheKey(controllerHome, repoId, pluginId, true));
    return;
  }
  for (const key of pluginManifestItemCache.keys()) {
    if (key.startsWith(prefix)) pluginManifestItemCache.delete(key);
  }
}

export function clearAssistantPluginManifestCacheForTest(): void {
  pluginManifestListCache.clear();
  pluginManifestItemCache.clear();
}

function pluginsRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'plugins');
}

function manifestPath(controllerHome: string, repoId: string, pluginId: string): string {
  return join(pluginsRoot(controllerHome, repoId), 'manifests', `${sanitizeFileComponent(pluginId)}.json`);
}

function indexPath(controllerHome: string, repoId: string): string {
  return join(pluginsRoot(controllerHome, repoId), 'index.json');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function fingerprintManifest(value: AssistantPluginManifest): string {
  return JSON.stringify({
    ...value,
    revision: 0,
    updatedAt: '',
    health: { ...value.health, checkedAt: '' },
  });
}

function pluginIndexEntry(controllerHome: string, repoId: string, manifest: AssistantPluginManifest): AssistantPluginRegistryIndexEntry {
  return {
    pluginId: manifest.pluginId,
    provider: manifest.provider,
    displayName: manifest.displayName,
    enabled: manifest.enabled,
    lifecycleState: manifest.lifecycle.state,
    healthState: manifest.health.state,
    revision: manifest.revision,
    manifestPath: manifestPath(controllerHome, repoId, manifest.pluginId),
    updatedAt: manifest.updatedAt,
  };
}

function readStoredManifest(controllerHome: string, repoId: string, pluginId: string): AssistantPluginManifest | undefined {
  try {
    return readJsonFile<AssistantPluginManifest>(manifestPath(controllerHome, repoId, pluginId));
  } catch {
    return undefined;
  }
}

function cachedManifestForRepository(
  controllerHome: string,
  repoId: string,
  pluginId: string,
): AssistantPluginManifest | undefined {
  return readPluginManifestCache(
    pluginManifestItemCache,
    itemCacheKey(controllerHome, repoId, pluginId, true),
    PLUGIN_MANIFEST_STORED_CACHE_TTL_MS,
  ) ?? readPluginManifestCache(pluginManifestItemCache, itemCacheKey(controllerHome, repoId, pluginId, false));
}

function computeManifest(
  controllerHome: string,
  repository: RepositoryRecord,
  pluginId: string,
  resolvedAdapter?: AssistantPluginAdapter,
): AssistantPluginManifest {
  const adapter = resolvedAdapter ?? resolvePluginAdapter(controllerHome, pluginId);
  if (!adapter || !adapterMatchesRepository(adapter, repository)) throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
  const previous = readStoredManifest(controllerHome, repository.repoId, pluginId);
  const built = adapter.buildManifest(previous?.revision ?? 0, previous?.updatedAt, repository.canonicalRoot, {
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    controllerScoped: repository.repoId === CONTROLLER_SCOPE_REPO_ID,
  });
  const changed = !previous || fingerprintManifest(previous) !== fingerprintManifest(built);
  return {
    ...built,
    revision: previous ? (changed ? previous.revision + 1 : previous.revision) : 1,
    updatedAt: changed ? now() : previous?.updatedAt ?? built.updatedAt,
  };
}

function writeRegistry(controllerHome: string, repoId: string, manifests: AssistantPluginManifest[]): AssistantPluginRegistryIndex {
  const index: AssistantPluginRegistryIndex = {
    schemaVersion: 1,
    updatedAt: now(),
    plugins: manifests
      .map((manifest) => pluginIndexEntry(controllerHome, repoId, manifest))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
  };
  writeJsonAtomic(indexPath(controllerHome, repoId), index);
  return index;
}

export function claimsForAssistantPluginAction(
  action: AssistantPluginActionDescriptor,
  repository: RepositoryRecord,
  trustedPluginId: string,
): ResourceClaimSpec[] {
  const controllerScoped = repository.repoId === CONTROLLER_SCOPE_REPO_ID;
  const pluginId = trustedPluginId.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!pluginId) throw new Error('PLUGIN_ID_REQUIRED_FOR_RESOURCE_CLAIMS');
  return action.resourceClaims.map((claim) => ({
    resourceKey: claim.resource === 'remote' || claim.resource === 'provider-state'
      // The manifest/plugin id was resolved from the trusted registration; a
      // provider never supplies arbitrary resource-key text.
      ? `provider-state:${pluginId}`
      : controllerScoped
        ? `controller-system:${claim.resource}`
        : claim.resource === 'workspace'
          ? `workspace:${repository.activeCheckoutId}`
          : claim.resource === 'git-refs'
            ? `git-refs:${repository.repoId}`
            : `repo-state:${repository.repoId}`,
    mode: claim.mode,
  }));
}

function semanticKey(repository: RepositoryRecord, pluginId: string, actionId: string, args: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex').slice(0, 20);
  return `plugin-action:${repository.repoId}:${pluginId}:${actionId}:${digest}`;
}

function validatePrimitive(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  return true;
}

function validateSchemaNode(schema: Record<string, unknown>, value: unknown, path: string): void {
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type && !validatePrimitive(type, value)) {
    throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path} must be ${type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path} must be one of ${schema.enum.join(', ')}`);
  }
  if (type === 'object') {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in objectValue)) throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue && objectValue[key] !== undefined) {
        validateSchemaNode(childSchema, objectValue[key], `${path}.${key}`);
      }
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((entry, index) => validateSchemaNode(schema.items as Record<string, unknown>, entry, `${path}[${index}]`));
  }
}

function validateActionArguments(action: AssistantPluginActionDescriptor, args: Record<string, unknown>): Record<string, unknown> {
  validateSchemaNode(action.argumentsSchema, args, 'arguments');
  return canonical(args) as Record<string, unknown>;
}

function enforceConfirmation(action: AssistantPluginActionDescriptor, request: AssistantPluginActionRequest): void {
  // Ordinary authorization is delegated to the host AI/tool permission model.
  // Forge keeps only the explicit strong-confirmation boundary for
  // destructive or irreversible plugin operations.
  if (action.confirmation === 'none' || action.confirmation === 'authorization') return;
  if (action.confirmation === 'strong_confirmation') {
    if (request.confirmAuthorization !== true) {
      throw new Error(`PLUGIN_CONFIRMATION_REQUIRED: ${request.pluginId}/${request.actionId} requires confirmAuthorization=true`);
    }
    if (!action.requiredConfirmationText || request.confirmationText !== action.requiredConfirmationText) {
      throw new Error(`PLUGIN_CONFIRMATION_TEXT_REQUIRED: provide confirmationText=${action.requiredConfirmationText ?? ''}`);
    }
  }
}

export interface PluginActionAuthorizationEvidence {
  source: 'none' | 'host_permission_model' | 'capability_grant' | 'strong_confirmation';
  reusable: boolean;
  capabilityId?: string;
  target?: { kind: string; id: string };
  grantId?: string;
  established?: boolean;
  lookupError?: string;
  persistenceError?: string;
}

function actionForManifest(manifest: AssistantPluginManifest, actionId: string): AssistantPluginActionDescriptor {
  const action = manifest.actions.find((entry) => entry.actionId === actionId);
  if (!action) throw new Error(`PLUGIN_ACTION_NOT_FOUND: ${manifest.pluginId}/${actionId}`);
  return action;
}

function reusableCapabilityId(manifest: AssistantPluginManifest, action: AssistantPluginActionDescriptor): string {
  const matches = manifest.capabilities
    .filter((capability) => capability.actions.includes(action.actionId))
    .map((capability) => capability.capabilityId)
    .filter(Boolean)
    .sort();
  // Overlapping capability groups are ambiguous privilege boundaries. Fall back
  // to action-local reuse instead of silently choosing a broader capability.
  return matches.length === 1 ? matches[0]! : `action:${action.actionId}`;
}

const INTERACTIVE_PLUGIN_AUTHORIZATION_SURFACES = new Set(['mcp', 'local-ui', 'chatgpt-action']);

function originMayEstablishCapabilityAuthorization(origin: AssistantPluginActionExecutionInput['origin']): boolean {
  return INTERACTIVE_PLUGIN_AUTHORIZATION_SURFACES.has(origin.surface);
}

function authorizationTargetSummary(context: AssistantPluginAuthorizationContext): { kind: string; id: string } {
  return { kind: context.target.kind, id: context.target.id };
}

function authorizationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function initialAuthorizationEvidence(
  manifest: AssistantPluginManifest,
  action: AssistantPluginActionDescriptor,
): PluginActionAuthorizationEvidence {
  if (action.confirmation === 'none') return { source: 'none', reusable: false };
  const capabilityId = reusableCapabilityId(manifest, action);
  if (action.confirmation === 'strong_confirmation') {
    return { source: 'strong_confirmation', reusable: false, capabilityId };
  }
  return { source: 'host_permission_model', reusable: false, capabilityId };
}

function denyAutomatedWrite(manifest: AssistantPluginManifest, action: AssistantPluginActionDescriptor, origin: AssistantPluginActionExecutionInput['origin']): void {
  if (!['schedule', 'reconciliation', 'system'].includes(origin.surface)) return;
  if (action.readOnly) return;
  throw new Error(`EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED: ${manifest.pluginId}/${action.actionId} cannot run from ${origin.surface}`);
}

export type ListAssistantPluginManifestsOptions = {
  /**
   * Prefer previously persisted manifests for connector/status hot paths.
   * Live adapter rebuild (including host probes such as Xcode) runs only when
   * no stored manifest exists, or when forceRefresh is true.
   */
  preferStored?: boolean;
  forceRefresh?: boolean;
};

function listAssistantPluginIds(controllerHome: string, repository: RepositoryRecord): string[] {
  return listPluginAdapters(controllerHome)
    .filter((adapter) => adapterMatchesRepository(adapter, repository))
    .map((adapter) => adapter.pluginId)
    .sort((left, right) => left.localeCompare(right));
}

export function listAssistantPluginManifests(
  controllerHome: string,
  repository: RepositoryRecord,
  options: ListAssistantPluginManifestsOptions = {},
): AssistantPluginManifest[] {
  const preferStored = options.preferStored === true && options.forceRefresh !== true;
  const cacheKey = listCacheKey(controllerHome, repository.repoId, preferStored);
  if (options.forceRefresh !== true) {
    // Stored manifests are persisted snapshots. Their freshness is governed by
    // explicit registry/config mutation invalidation, not a wall-clock trust
    // window. Live execution manifests retain the short identity-validation TTL.
    const cached = readPluginManifestCache(
      pluginManifestListCache,
      cacheKey,
      preferStored ? PLUGIN_MANIFEST_STORED_CACHE_TTL_MS : PLUGIN_MANIFEST_LIVE_CACHE_TTL_MS,
    );
    if (cached) return cached;
  }
  const manifests = listAssistantPluginIds(controllerHome, repository)
    .map((pluginId) => {
      if (preferStored) {
        const stored = readStoredManifest(controllerHome, repository.repoId, pluginId);
        if (stored) return stored;
      }
      return computeManifest(controllerHome, repository, pluginId);
    })
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  primePluginManifestItemCache(controllerHome, repository.repoId, manifests, preferStored);
  return writePluginManifestCache(pluginManifestListCache, cacheKey, manifests);
}

function getAssistantPluginManifestForExecution(
  controllerHome: string,
  repository: RepositoryRecord,
  pluginId: string,
  adapter: AssistantPluginAdapter,
): { manifest: AssistantPluginManifest; providerIdentityPrevalidated: boolean } {
  const executionResult = (manifest: AssistantPluginManifest) => ({
    manifest,
    // A cached manifest is only a bounded proof when the probe itself passed.
    // If it is degraded or stale, make the external adapter revalidate its
    // identity before it can route an action.
    providerIdentityPrevalidated: manifest.enabled && manifest.health.probed && manifest.health.ready,
  });
  const cacheKey = itemCacheKey(controllerHome, repository.repoId, pluginId, false);
  const cached = readPluginManifestCache(pluginManifestItemCache, cacheKey);
  // The live item cache is populated only from computeManifest(), which already
  // validates external provider identity/health. Its 5s TTL is therefore the
  // bounded identity-validation window; do not repeat a manifest RPC on every
  // hot action inside that same window. Stored-cache entries use a distinct key.
  if (cached) return executionResult(cached);
  const manifest = computeManifest(controllerHome, repository, pluginId, adapter);
  return executionResult(writePluginManifestCache(pluginManifestItemCache, cacheKey, manifest));
}

export function getAssistantPluginManifest(
  controllerHome: string,
  repository: RepositoryRecord,
  pluginId: string,
): AssistantPluginManifest {
  const adapter = resolvePluginAdapter(controllerHome, pluginId);
  if (!adapter || !adapterMatchesRepository(adapter, repository)) throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
  return getAssistantPluginManifestForExecution(controllerHome, repository, pluginId, adapter).manifest;
}

export function syncAssistantPluginRegistry(
  controllerHome: string,
  repository: RepositoryRecord,
): { manifests: AssistantPluginManifest[]; index: AssistantPluginRegistryIndex } {
  invalidateAssistantPluginManifestCache(controllerHome, repository.repoId);
  const manifests = listAssistantPluginManifests(controllerHome, repository, { forceRefresh: true });
  for (const manifest of manifests) {
    writeJsonAtomic(manifestPath(controllerHome, repository.repoId, manifest.pluginId), manifest);
  }
  markControllerContextProjectionDirty(repository.canonicalRoot, 'plugin:registry-synced');
  return {
    manifests,
    index: writeRegistry(controllerHome, repository.repoId, manifests),
  };
}

function syncAssistantPluginManifest(
  controllerHome: string,
  repository: RepositoryRecord,
  pluginId: string,
): { manifest: AssistantPluginManifest; index: AssistantPluginRegistryIndex } {
  invalidateAssistantPluginManifestCache(controllerHome, repository.repoId, pluginId);
  const manifest = computeManifest(controllerHome, repository, pluginId);
  writeJsonAtomic(manifestPath(controllerHome, repository.repoId, manifest.pluginId), manifest);
  markControllerContextProjectionDirty(repository.canonicalRoot, `plugin:${pluginId}:synced`);
  cacheAssistantPluginManifest(controllerHome, repository.repoId, manifest, false);
  cacheAssistantPluginManifest(controllerHome, repository.repoId, manifest, true);
  const manifests = listAssistantPluginIds(controllerHome, repository)
    .map((candidatePluginId) => {
      if (candidatePluginId === pluginId) return manifest;
      return readStoredManifest(controllerHome, repository.repoId, candidatePluginId)
        ?? cachedManifestForRepository(controllerHome, repository.repoId, candidatePluginId);
    })
    .filter((entry): entry is AssistantPluginManifest => Boolean(entry))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  return {
    manifest,
    index: writeRegistry(controllerHome, repository.repoId, manifests),
  };
}

export function isDirectPluginReadAction(action: AssistantPluginActionDescriptor): boolean {
  return action.readOnly === true
    && action.risk === 'readonly'
    && action.confirmation === 'none'
    && action.idempotent === true;
}

export async function executeAssistantPluginReadDirect(
  controllerHome: string,
  repository: RepositoryRecord,
  request: AssistantPluginActionRequest,
): Promise<{ manifest: AssistantPluginManifest; action: AssistantPluginActionDescriptor; result: Record<string, unknown> }> {
  const manifest = getAssistantPluginManifest(controllerHome, repository, request.pluginId);
  const action = actionForManifest(manifest, request.actionId);
  if (!manifest.enabled && action.actionId !== 'configure') {
    throw new Error(`PLUGIN_DISABLED: ${request.pluginId} is disabled`);
  }
  if (!isDirectPluginReadAction(action)) {
    throw new Error(`PLUGIN_DIRECT_READ_NOT_ALLOWED: ${request.pluginId}/${request.actionId}`);
  }
  const normalizedArgs = validateActionArguments(action, request.args ?? {});
  enforceConfirmation(action, { ...request, args: normalizedArgs });
  const result = await executeAssistantPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    pluginId: request.pluginId,
    actionId: request.actionId,
    requestId: request.requestId,
    args: normalizedArgs,
    origin: request.origin,
  });
  return { manifest, action, result };
}

export interface PluginActionReceipt {
  schemaVersion: 1;
  receiptId: string;
  requestId: string;
  repoId: string;
  /** Work authority repository when it differs from controller/provider receipt scope. */
  workRepoId?: string;
  pluginId: string;
  actionId: string;
  semanticKey: string;
  status: 'succeeded' | 'failed';
  createdAt: string;
  workId?: string;
  origin?: { surface: string; actor?: string; correlationId?: string };
  authorization?: PluginActionAuthorizationEvidence;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface PluginActionRequestIndex {
  requestId: string;
  repoId: string;
  workRepoId?: string;
  receiptId: string;
  semanticKey: string;
  createdAt: string;
}

function pluginActionReceiptRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'plugin-action-receipts');
  mkdirSync(root, { recursive: true });
  return root;
}

function pluginActionRequestPath(controllerHome: string, requestId: string): string {
  const hash = createHash('sha256').update(requestId).digest('hex');
  const root = join(ensureControllerHome(controllerHome), 'indexes', 'plugin-actions', 'requests');
  mkdirSync(root, { recursive: true });
  return join(root, `${hash}.json`);
}

function pluginActionReceiptPath(controllerHome: string, repoId: string, receiptId: string): string {
  return join(pluginActionReceiptRoot(controllerHome, repoId), `${sanitizeFileComponent(receiptId)}.json`);
}

function readPluginActionReceipt(controllerHome: string, repoId: string, receiptId: string): PluginActionReceipt | undefined {
  const path = pluginActionReceiptPath(controllerHome, repoId, receiptId);
  if (!existsSync(path)) return undefined;
  return readJsonFile<PluginActionReceipt>(path);
}

export function findPluginActionReceipt(
  controllerHome: string,
  receiptId: string,
): PluginActionReceipt | undefined {
  const home = ensureControllerHome(controllerHome);
  const repositoriesRoot = join(home, 'repositories');
  try {
    for (const repoId of readdirSync(repositoriesRoot)) {
      const receipt = readPluginActionReceipt(home, repoId, receiptId);
      if (receipt) return receipt;
    }
  } catch {
    /* no repositories */
  }
  return undefined;
}

export function compatibilityPluginJobFromReceipt(
  receipt: PluginActionReceipt,
  checkoutId = 'unknown',
): ExecutionJob {
  return compatibilityJobFromReceipt(receipt, checkoutId);
}

const LOCAL_SYSTEM_MUTATION_ACTIONS = new Set([
  'authorize_target',
  'revoke_target',
  'create_directory',
  'write_text',
  'delete_file',
  'delete_empty_directory',
  'initialize_git',
  'execute_project_script',
  'copy_file',
  'move_file',
  'rename_file',
  'open_application',
  'reveal_in_finder',
  'open_file',
]);

function localSystemActionRequiresWork(
  repository: RepositoryRecord,
  pluginId: string,
  actionId: string,
  args: Record<string, unknown>,
): boolean {
  if (repository.repoId !== CONTROLLER_SCOPE_REPO_ID || pluginId !== 'local_system') return false;
  if (LOCAL_SYSTEM_MUTATION_ACTIONS.has(actionId)) return true;
  if (actionId !== 'execute_command' || !Array.isArray(args.command)) return false;
  return classifyRepositoryCommand(args.command.map(String)).risk !== 'readonly';
}

function workRiskForPluginAction(action: AssistantPluginActionDescriptor): WorkRisk {
  if (action.risk === 'readonly') return 'readonly';
  if (action.risk === 'workspace_write') return 'medium';
  if (action.risk === 'remote_write') return 'high';
  return 'destructive';
}

function localEffectTarget(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): LocalEffectCompletionReceipt['target'] {
  const inner = result.result && typeof result.result === 'object' && !Array.isArray(result.result)
    ? result.result as Record<string, unknown>
    : result;
  const target = inner.target && typeof inner.target === 'object' && !Array.isArray(inner.target)
    ? inner.target as Record<string, unknown>
    : undefined;
  const id = String(
    target?.workspaceId
      ?? inner.workspaceId
      ?? args.target_key
      ?? args.destination_target_key
      ?? args.source_target_key
      ?? 'controller-local',
  );
  const identityFingerprint = typeof target?.identityFingerprint === 'string'
    ? target.identityFingerprint
    : typeof inner.identityFingerprint === 'string'
      ? inner.identityFingerprint
      : undefined;
  return {
    kind: id.startsWith('workspace_') || args.target_key || args.destination_target_key || args.source_target_key
      ? 'workspace_target'
      : 'controller_local',
    id,
    ...(identityFingerprint ? { identityFingerprint } : {}),
  };
}

function workAttributionRepoId(repository: RepositoryRecord, request: AssistantPluginActionRequest): string {
  const explicit = request.workRepoId?.trim();
  if (!request.workId?.trim()) {
    if (explicit) throw new Error(`WORK_PLUGIN_ATTRIBUTION_REPO_WITHOUT_WORK: ${explicit}`);
    return repository.repoId;
  }
  return explicit || repository.repoId;
}

function remoteEffectWorkForPluginAction(
  controllerHome: string,
  repository: RepositoryRecord,
  action: AssistantPluginActionDescriptor,
  request: AssistantPluginActionRequest,
  receiptId?: string,
): WorkContract | undefined {
  const workId = request.workId?.trim();
  if (!workId) return undefined;
  if (action.risk !== 'remote_write') {
    throw new Error(`WORK_PLUGIN_RECEIPT_BINDING_REQUIRES_REMOTE_WRITE: ${action.actionId}`);
  }
  const workRepoId = workAttributionRepoId(repository, request);
  const work = getWorkContract({ controllerHome, repoId: workRepoId }, workId);
  if (!work) throw new Error(`WORK_PLUGIN_RECEIPT_BINDING_NOT_FOUND: ${workId}`);
  if (work.workKind !== 'remote_effect') {
    throw new Error(`WORK_PLUGIN_RECEIPT_BINDING_KIND_MISMATCH: ${workId} is ${work.workKind}, expected remote_effect`);
  }
  if (work.checks.length > 0) {
    throw new Error(`WORK_PLUGIN_RECEIPT_BINDING_CHECKS_PRESENT: ${workId} declares repository checks and cannot be completed by a plugin receipt alone`);
  }
  if (isTerminalWorkContractStatus(work.status)) {
    const receiptAlreadyBound = Boolean(receiptId) && (
      work.completionReceipt?.receiptId === receiptId
      || work.evidenceRefs.some((evidence) => evidence.evidenceId === receiptId)
    );
    if (work.status === 'completed' && receiptAlreadyBound) return work;
    throw new Error(`WORK_PLUGIN_RECEIPT_BINDING_TERMINAL: ${workId} is ${work.status}`);
  }
  return work;
}

function attributedWorkForPluginAction(
  controllerHome: string,
  repository: RepositoryRecord,
  action: AssistantPluginActionDescriptor,
  request: AssistantPluginActionRequest,
): WorkContract | undefined {
  const workId = request.workId?.trim();
  if (!workId || action.risk === 'remote_write') return undefined;
  const workRepoId = workAttributionRepoId(repository, request);
  const work = getWorkContract({ controllerHome, repoId: workRepoId }, workId);
  if (!work) throw new Error(`WORK_PLUGIN_ATTRIBUTION_NOT_FOUND: ${workRepoId}:${workId}`);
  if (isTerminalWorkContractStatus(work.status)) {
    throw new Error(`WORK_PLUGIN_ATTRIBUTION_TERMINAL: ${workId} is ${work.status}`);
  }
  return work;
}

function bindLocalEffectReceiptToAttributedWork(
  controllerHome: string,
  repository: RepositoryRecord,
  action: AssistantPluginActionDescriptor,
  request: AssistantPluginActionRequest,
  receipt: PluginActionReceipt,
  work?: WorkContract,
): WorkContract | undefined {
  if (!request.workId || receipt.status !== 'succeeded') return work;
  const workRepoId = workAttributionRepoId(repository, request);
  const attributed = work ?? getWorkContract({ controllerHome, repoId: workRepoId }, request.workId.trim());
  if (!attributed) throw new Error(`WORK_PLUGIN_ATTRIBUTION_NOT_FOUND: ${workRepoId}:${request.workId.trim()}`);
  if (attributed.workKind !== 'local_effect' || action.readOnly || action.risk === 'readonly') return attributed;
  if (attributed.evidenceRefs.some((evidence) => evidence.evidenceId === receipt.receiptId)) return attributed;
  if (isTerminalWorkContractStatus(attributed.status)) return attributed;
  return appendWorkEvidence({ controllerHome, repoId: workRepoId }, attributed.workId, {
    evidenceId: receipt.receiptId,
    title: 'typed local plugin effect completed',
    summary: `${receipt.pluginId}/${receipt.actionId} completed with durable receipt ${receipt.receiptId}.`,
    detailLevel: 'summary',
  });
}

export function finalizeRemoteEffectWorkFromActionReceipt(
  controllerHome: string,
  repoId: string,
  workId: string,
): WorkContract {
  const work = getWorkContract({ controllerHome, repoId }, workId);
  if (!work) throw new Error(`WORK_PLUGIN_RECEIPT_BINDING_NOT_FOUND: ${workId}`);
  if (work.workKind !== 'remote_effect') {
    throw new Error(`WORK_REMOTE_EFFECT_FINALIZE_KIND_MISMATCH: ${workId} is ${work.workKind}, expected remote_effect`);
  }
  if (work.status === 'completed' && work.completionReceipt?.source === 'remote_effect') return work;
  if (isTerminalWorkContractStatus(work.status)) {
    throw new Error(`WORK_REMOTE_EFFECT_FINALIZE_TERMINAL: ${workId} is ${work.status}`);
  }
  const receipt = work.evidenceRefs
    .map((evidence) => {
      if (!evidence.evidenceId) return undefined;
      return readPluginActionReceipt(controllerHome, repoId, evidence.evidenceId)
        ?? readPluginActionReceipt(controllerHome, CONTROLLER_SCOPE_REPO_ID, evidence.evidenceId);
    })
    .find((candidate) => candidate?.workId === workId && candidate.status === 'succeeded');
  if (!receipt) {
    throw new Error(`WORK_REMOTE_EFFECT_FINALIZE_RECEIPT_REQUIRED: ${workId} has no successful durable plugin action receipt`);
  }
  const remoteReceipt: RemoteEffectCompletionReceipt = {
    schemaVersion: 1,
    receiptId: receipt.receiptId,
    source: 'remote_effect',
    workId,
    pluginId: receipt.pluginId,
    actionId: receipt.actionId,
    requestId: receipt.requestId,
    semanticKey: receipt.semanticKey,
    resultDigest: createHash('sha256').update(JSON.stringify(receipt.result ?? null)).digest('hex'),
    recordedAt: new Date().toISOString(),
  };
  return recordWorkCompletionReceipt(
    { controllerHome, repoId },
    workId,
    remoteReceipt,
    'completed_remote',
    'remote_effect',
  );
}

function bindRemoteEffectReceiptToWork(
  controllerHome: string,
  repository: RepositoryRecord,
  action: AssistantPluginActionDescriptor,
  request: AssistantPluginActionRequest,
  receipt: PluginActionReceipt,
): WorkContract | undefined {
  if (!request.workId) return undefined;
  if (receipt.status !== 'succeeded') return remoteEffectWorkForPluginAction(controllerHome, repository, action, request);
  const work = remoteEffectWorkForPluginAction(controllerHome, repository, action, request, receipt.receiptId);
  if (!work) return undefined;
  if (work.status === 'completed') return work;
  const workRepoId = workAttributionRepoId(repository, request);
  let updated = work;
  if (!work.evidenceRefs.some((evidence) => evidence.evidenceId === receipt.receiptId)) {
    updated = appendWorkEvidence({ controllerHome, repoId: workRepoId }, work.workId, {
      evidenceId: receipt.receiptId,
      title: 'typed remote plugin effect completed',
      summary: `${receipt.pluginId}/${receipt.actionId} completed with durable receipt ${receipt.receiptId}.`,
      detailLevel: 'summary',
    });
  }
  if (action.remoteEffectWorkCompletion !== 'terminal') return updated;
  const remoteReceipt: RemoteEffectCompletionReceipt = {
    schemaVersion: 1,
    receiptId: receipt.receiptId,
    source: 'remote_effect',
    workId: work.workId,
    pluginId: receipt.pluginId,
    actionId: receipt.actionId,
    requestId: receipt.requestId,
    semanticKey: receipt.semanticKey,
    resultDigest: createHash('sha256').update(JSON.stringify(receipt.result ?? null)).digest('hex'),
    recordedAt: new Date().toISOString(),
  };
  return recordWorkCompletionReceipt(
    { controllerHome, repoId: workRepoId },
    work.workId,
    remoteReceipt,
    'completed_remote',
    'remote_effect',
  );
}

function compatibilityJobFromReceipt(receipt: PluginActionReceipt, checkoutId: string): ExecutionJob {
  return {
    schemaVersion: 1,
    revision: 1,
    jobId: receipt.receiptId,
    repoId: receipt.repoId,
    checkoutId,
    type: 'plugin-action',
    status: receipt.status === 'succeeded' ? 'succeeded' : 'failed',
    priority: 'P2',
    requestId: receipt.requestId,
    semanticKey: receipt.semanticKey,
    payload: {
      operation: 'plugin_action_execute',
      target: 'runtime',
      arguments: {
        pluginId: receipt.pluginId,
        actionId: receipt.actionId,
      },
    },
    origin: receipt.origin ?? { surface: 'mcp', actor: 'plugin_action_execute', correlationId: receipt.requestId },
    resourceClaims: [],
    createdAt: receipt.createdAt,
    updatedAt: receipt.createdAt,
    attempt: 1,
    maxAttempts: 1,
    result: receipt.result,
    error: receipt.error ? { code: receipt.error.code, message: receipt.error.message } : undefined,
  } as unknown as ExecutionJob;
}

/**
 * Deterministic plugin action path: validate → authorize/confirm → invoke adapter → receipt.
 * Does not create ExecutionJobs or call a model.
 */
export async function submitAssistantPluginAction(
  controllerHome: string,
  repository: RepositoryRecord,
  request: AssistantPluginActionRequest,
): Promise<{
  manifest: AssistantPluginManifest;
  action: AssistantPluginActionDescriptor;
  job: ExecutionJob;
  deduplicated: boolean;
  result?: Record<string, unknown>;
  receipt: PluginActionReceipt;
  authorization?: PluginActionAuthorizationEvidence;
  workId?: string;
}> {
  const adapter = resolvePluginAdapter(controllerHome, request.pluginId);
  if (!adapter) throw new Error(`PLUGIN_NOT_FOUND: ${request.pluginId}`);
  const manifest = getAssistantPluginManifest(controllerHome, repository, request.pluginId);
  const action = actionForManifest(manifest, request.actionId);
  if (!manifest.enabled && action.actionId !== 'configure') {
    throw new Error(`PLUGIN_DISABLED: ${request.pluginId} is disabled`);
  }
  const normalizedArgs = validateActionArguments(action, request.args ?? {});
  enforceConfirmation(action, { ...request, args: normalizedArgs });

  const key = semanticKey(repository, request.pluginId, request.actionId, normalizedArgs);
  const requestPath = pluginActionRequestPath(controllerHome, request.requestId);
  if (existsSync(requestPath)) {
    const index = readJsonFile<PluginActionRequestIndex>(requestPath);
    if (index.semanticKey !== key) {
      throw new Error(`REQUEST_ID_CONFLICT: ${request.requestId} already belongs to ${index.semanticKey}`);
    }
    if (index.repoId !== repository.repoId) {
      throw new Error(`REQUEST_ID_REPO_CONFLICT: ${request.requestId} already belongs to repository ${index.repoId}`);
    }
    const existing = readPluginActionReceipt(controllerHome, index.repoId, index.receiptId);
    if (!existing) {
      throw new Error(`PLUGIN_RECEIPT_LOST: ${request.requestId}`);
    }
    if (request.workId && existing.workId !== request.workId) {
      throw new Error(`WORK_PLUGIN_RECEIPT_BINDING_CONFLICT: ${request.requestId} already belongs to Work ${existing.workId ?? 'none'}`);
    }
    const requestedWorkRepoId = request.workId ? workAttributionRepoId(repository, request) : undefined;
    if (requestedWorkRepoId && (index.workRepoId ?? index.repoId) !== requestedWorkRepoId) {
      throw new Error(`WORK_PLUGIN_ATTRIBUTION_REPO_CONFLICT: ${request.requestId} already belongs to Work repository ${index.workRepoId ?? index.repoId}`);
    }
    if (request.workId && action.risk === 'remote_write') {
      bindRemoteEffectReceiptToWork(controllerHome, repository, action, request, existing);
    } else if (request.workId) {
      bindLocalEffectReceiptToAttributedWork(controllerHome, repository, action, request, existing);
    }
    return {
      manifest,
      action,
      job: compatibilityJobFromReceipt(existing, repository.activeCheckoutId),
      deduplicated: true,
      result: existing.result,
      receipt: existing,
      authorization: existing.authorization,
      workId: existing.workId,
    };
  }

  const createdAt = new Date().toISOString();
  const receiptId = `PLG-${Date.now()}-${createHash('sha256').update(request.requestId).digest('hex').slice(0, 8)}`;
  const capabilityId = reusableCapabilityId(manifest, action);
  let authorization = initialAuthorizationEvidence(manifest, action);
  let authorizationContext: AssistantPluginAuthorizationContext | undefined;
  let activeAuthorizationGrant: PluginCapabilityAuthorizationGrant | undefined;
  const requiresLocalEffectWork = localSystemActionRequiresWork(
    repository,
    request.pluginId,
    request.actionId,
    normalizedArgs,
  );
  const boundRemoteWork = action.risk === 'remote_write'
    ? remoteEffectWorkForPluginAction(controllerHome, repository, action, request)
    : undefined;
  const attributedWork = !requiresLocalEffectWork
    ? attributedWorkForPluginAction(controllerHome, repository, action, request)
    : undefined;
  const acceptedWork = requiresLocalEffectWork
    ? acceptSubmittedWorkContract(controllerHome, {
        requestId: request.requestId,
        repoId: repository.repoId,
        semanticKey: `local-effect:${key}`,
        operation: {
          name: `plugin:${request.pluginId}/${request.actionId}`,
          semanticKey: key,
          argumentHash: createHash('sha256').update(JSON.stringify(normalizedArgs)).digest('hex'),
          mode: 'mutating',
          idempotent: action.idempotent,
          replayable: action.idempotent,
          resourceClaims: claimsForAssistantPluginAction(action, repository, manifest.pluginId),
        },
        objective: `Execute bounded controller-local effect ${request.pluginId}/${request.actionId}`,
        mode: 'direct_control',
        requestedBy: 'chatgpt',
        principalId: request.origin.actor,
        controllerInstanceId: process.env.FORGE_RUNTIME_INSTANCE_ID?.trim()
          || process.env.FORGE_WRITER_INSTANCE_ID?.trim()
          || process.env.FORGE_DAEMON_INSTANCE_ID?.trim(),
        workKind: 'local_effect',
        risk: workRiskForPluginAction(action),
        acceptanceCriteria: ['The requested local effect completes within its authorized Target Grant boundary.'],
        constraints: {
          requireHandoffOnAmbiguity: true,
          allowDestructive: action.risk === 'destructive'
            && request.confirmAuthorization === true
            && request.confirmationText === action.requiredConfirmationText,
        },
      }).contract
    : undefined;
  if (acceptedWork) {
    updateWorkContract({ controllerHome, repoId: repository.repoId }, acceptedWork.workId, {
      status: 'running',
      workKind: 'local_effect',
      dispatchState: 'running',
      evidenceState: 'partial',
    });
  }
  appendRuntimeEvent(controllerHome, {
    repoId: repository.repoId,
    entityType: 'plugin',
    entityId: manifest.pluginId,
    eventType: 'plugin_action_requested',
    requestId: request.requestId,
    revision: manifest.revision,
    data: {
      actionId: action.actionId,
      receiptId,
      risk: action.risk,
      confirmation: action.confirmation,
      capabilityId,
      authorizationReuseSupported: action.confirmation === 'authorization' && Boolean(adapter.resolveAuthorizationContext),
    },
  });

  try {
    if (action.confirmation === 'authorization'
      && adapter.resolveAuthorizationContext
      && originMayEstablishCapabilityAuthorization(request.origin)) {
      authorizationContext = await adapter.resolveAuthorizationContext({
        controllerHome,
        repoId: repository.repoId,
        repoRoot: repository.canonicalRoot,
        pluginId: request.pluginId,
        actionId: request.actionId,
        requestId: request.requestId,
        args: normalizedArgs,
        origin: request.origin,
        jobId: receiptId,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      if (authorizationContext) {
        authorization = {
          source: 'host_permission_model',
          reusable: false,
          capabilityId,
          target: authorizationTargetSummary(authorizationContext),
        };
        try {
          activeAuthorizationGrant = findActivePluginCapabilityAuthorization(controllerHome, {
            ownerScope: pluginCapabilityAuthorizationOwnerScope(request.origin),
            repoId: repository.repoId,
            pluginId: request.pluginId,
            capabilityId,
            target: authorizationContext.target,
            scopes: action.scopes,
            risk: action.risk,
          });
          if (activeAuthorizationGrant) {
            authorization = {
              source: 'capability_grant',
              reusable: true,
              capabilityId,
              target: authorizationTargetSummary(authorizationContext),
              grantId: activeAuthorizationGrant.grantId,
            };
          }
        } catch (error) {
          authorization = {
            ...authorization,
            lookupError: authorizationError(error),
          };
        }
      }
    }

    const result = await executeAssistantPluginAction({
      controllerHome,
      repoId: repository.repoId,
      repoRoot: repository.canonicalRoot,
      pluginId: request.pluginId,
      actionId: request.actionId,
      requestId: request.requestId,
      args: normalizedArgs,
      origin: request.origin,
      jobId: receiptId,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      deadlineAtMs: typeof request.timeoutMs === 'number'
        ? Date.now() + Math.max(1, Math.trunc(request.timeoutMs))
        : undefined,
    });
    if (action.confirmation === 'authorization'
      && authorizationContext
      && !activeAuthorizationGrant
      && originMayEstablishCapabilityAuthorization(request.origin)) {
      try {
        const grant = recordPluginCapabilityAuthorization(controllerHome, {
          ownerScope: pluginCapabilityAuthorizationOwnerScope(request.origin),
          repoId: repository.repoId,
          pluginId: request.pluginId,
          capabilityId,
          target: authorizationContext.target,
          scopes: action.scopes,
          riskCeiling: action.risk,
          expiresInMinutes: authorizationContext.expiresInMinutes,
        });
        authorization = {
          source: 'host_permission_model',
          reusable: true,
          capabilityId,
          target: authorizationTargetSummary(authorizationContext),
          grantId: grant.grantId,
          established: true,
          ...(authorization.lookupError ? { lookupError: authorization.lookupError } : {}),
        };
      } catch (error) {
        authorization = {
          ...authorization,
          reusable: false,
          persistenceError: authorizationError(error),
        };
      }
    }

    let resultWithLineage = result;
    if (boundRemoteWork) {
      const terminalRemoteEffect = action.remoteEffectWorkCompletion === 'terminal';
      resultWithLineage = {
        ...result,
        work: {
          workId: boundRemoteWork.workId,
          workKind: 'remote_effect',
          ...(terminalRemoteEffect ? { completionOutcome: 'completed_remote' as const } : {}),
          status: terminalRemoteEffect ? 'completed' : 'running',
        },
      };
    }
    if (acceptedWork) {
      const recordedAt = new Date().toISOString();
      const target = localEffectTarget(normalizedArgs, result);
      appendWorkEvidence({ controllerHome, repoId: repository.repoId }, acceptedWork.workId, {
        title: 'controller-local effect completed',
        summary: `${request.pluginId}/${request.actionId} completed for ${target.id}.`,
        detailLevel: 'summary',
      });
      recordWorkCompletionReceipt(
        { controllerHome, repoId: repository.repoId },
        acceptedWork.workId,
        {
          schemaVersion: 1,
          receiptId: `LFX-${Date.now()}-${createHash('sha256').update(`${request.requestId}:${acceptedWork.workId}`).digest('hex').slice(0, 8)}`,
          source: 'local_effect',
          workId: acceptedWork.workId,
          operation: `${request.pluginId}/${request.actionId}`,
          target,
          changed: true,
          recordedAt,
        },
        'completed_local',
        'local_effect',
      );
      resultWithLineage = {
        ...result,
        work: {
          workId: acceptedWork.workId,
          workKind: 'local_effect',
          completionOutcome: 'completed_local',
          status: 'completed',
        },
      };
    }
    const receipt: PluginActionReceipt = {
      schemaVersion: 1,
      receiptId,
      requestId: request.requestId,
      repoId: repository.repoId,
      ...(request.workId ? { workRepoId: workAttributionRepoId(repository, request) } : {}),
      pluginId: request.pluginId,
      actionId: request.actionId,
      semanticKey: key,
      status: 'succeeded',
      createdAt,
      ...(acceptedWork
        ? { workId: acceptedWork.workId }
        : boundRemoteWork
          ? { workId: boundRemoteWork.workId }
          : attributedWork
            ? { workId: attributedWork.workId }
            : {}),
      origin: request.origin,
      authorization,
      result: resultWithLineage,
    };
    writeJsonAtomic(pluginActionReceiptPath(controllerHome, repository.repoId, receiptId), receipt);
    writeJsonAtomic(requestPath, {
      requestId: request.requestId,
      repoId: repository.repoId,
      ...(request.workId ? { workRepoId: workAttributionRepoId(repository, request) } : {}),
      receiptId,
      semanticKey: key,
      createdAt,
    } satisfies PluginActionRequestIndex);
    if (boundRemoteWork) {
      bindRemoteEffectReceiptToWork(controllerHome, repository, action, request, receipt);
    } else if (attributedWork) {
      bindLocalEffectReceiptToAttributedWork(controllerHome, repository, action, request, receipt, attributedWork);
    }
    const nextManifest = getAssistantPluginManifest(controllerHome, repository, request.pluginId);
    return {
      manifest: nextManifest,
      action,
      job: compatibilityJobFromReceipt(receipt, repository.activeCheckoutId),
      deduplicated: false,
      result: resultWithLineage,
      receipt,
      authorization,
      workId: acceptedWork?.workId ?? boundRemoteWork?.workId ?? attributedWork?.workId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/.exec(message)?.[1] ?? 'PLUGIN_ACTION_FAILED';
    if (boundRemoteWork) {
      appendWorkEvidence({ controllerHome, repoId: workAttributionRepoId(repository, request) }, boundRemoteWork.workId, {
        title: 'typed remote plugin effect failed',
        summary: `${request.pluginId}/${request.actionId}: ${message}`.slice(0, 1_000),
        detailLevel: 'summary',
      });
    }
    if (acceptedWork) {
      const current = getWorkContract({ controllerHome, repoId: repository.repoId }, acceptedWork.workId);
      updateWorkContract({ controllerHome, repoId: repository.repoId }, acceptedWork.workId, {
        status: 'failed',
        workKind: 'local_effect',
        dispatchState: 'terminal',
        evidenceState: 'failed',
        evidenceRefs: [{
          title: 'controller-local effect failed',
          summary: `${request.pluginId}/${request.actionId}: ${message}`.slice(0, 1_000),
          detailLevel: 'summary',
        }, ...(current?.evidenceRefs ?? [])],
      });
    }
    const receipt: PluginActionReceipt = {
      schemaVersion: 1,
      receiptId,
      requestId: request.requestId,
      repoId: repository.repoId,
      ...(request.workId ? { workRepoId: workAttributionRepoId(repository, request) } : {}),
      pluginId: request.pluginId,
      actionId: request.actionId,
      semanticKey: key,
      status: 'failed',
      createdAt,
      ...(acceptedWork
        ? { workId: acceptedWork.workId }
        : boundRemoteWork
          ? { workId: boundRemoteWork.workId }
          : attributedWork
            ? { workId: attributedWork.workId }
            : {}),
      origin: request.origin,
      authorization,
      error: { code, message },
    };
    writeJsonAtomic(pluginActionReceiptPath(controllerHome, repository.repoId, receiptId), receipt);
    writeJsonAtomic(requestPath, {
      requestId: request.requestId,
      repoId: repository.repoId,
      receiptId,
      semanticKey: key,
      createdAt,
    } satisfies PluginActionRequestIndex);
    throw error;
  }
}

export async function executeAssistantPluginAction(
  input: AssistantPluginActionExecutionInput,
): Promise<Record<string, unknown>> {
  const adapter = resolvePluginAdapter(input.controllerHome, input.pluginId);
  if (!adapter) throw new Error(`PLUGIN_NOT_FOUND: ${input.pluginId}`);
  const repository = {
    repoId: input.repoId,
    canonicalRoot: input.repoRoot,
    activeCheckoutId: 'active',
  } as RepositoryRecord;
  const manifestLookup = getAssistantPluginManifestForExecution(input.controllerHome, repository, input.pluginId, adapter);
  const manifest = manifestLookup.manifest;
  const action = actionForManifest(manifest, input.actionId);
  denyAutomatedWrite(manifest, action, input.origin);
  const normalizedArgs = validateActionArguments(action, input.args);
  try {
    const result = await adapter.executeAction({
      ...input,
      args: normalizedArgs,
      providerIdentityPrevalidated: manifestLookup.providerIdentityPrevalidated,
    });
    for (const affectedPluginId of adapter.affectedPluginIdsAfterAction?.(input.actionId, result) ?? []) {
      if (!affectedPluginId || affectedPluginId === input.pluginId) continue;
      invalidateAssistantPluginManifestCache(input.controllerHome, repository.repoId, affectedPluginId);
      const affectedAdapter = resolvePluginAdapter(input.controllerHome, affectedPluginId);
      if (affectedAdapter && adapterMatchesRepository(affectedAdapter, repository)) {
        syncAssistantPluginManifest(input.controllerHome, repository, affectedPluginId);
      } else {
        rmSync(manifestPath(input.controllerHome, repository.repoId, affectedPluginId), { force: true });
      }
    }
    const refreshManifest = adapter.shouldRefreshManifestAfterAction?.(input.actionId) ?? true;
    const nextManifest = refreshManifest
      ? syncAssistantPluginManifest(input.controllerHome, repository, input.pluginId).manifest
      : manifest;
    appendRuntimeEvent(input.controllerHome, {
      repoId: input.repoId,
      entityType: 'plugin',
      entityId: input.pluginId,
      eventType: 'plugin_action_succeeded',
      requestId: input.requestId,
      revision: nextManifest.revision,
      data: {
        actionId: input.actionId,
        jobId: input.jobId,
        resultKeys: Object.keys(result).slice(0, 20),
        lifecycleState: nextManifest.lifecycle.state,
        healthState: nextManifest.health.state,
      },
    });
    return {
      schemaVersion: 1,
      plugin: {
        pluginId: nextManifest.pluginId,
        provider: nextManifest.provider,
        revision: nextManifest.revision,
        lifecycle: nextManifest.lifecycle,
        health: nextManifest.health,
      },
      action: {
        actionId: action.actionId,
        confirmation: action.confirmation,
        risk: action.risk,
        requestId: input.requestId,
      },
      result,
    };
  } catch (error) {
    const pluginError = toAssistantPluginError(error, {
      code: 'PLUGIN_ACTION_FAILED',
      message: `Plugin action ${input.pluginId}/${input.actionId} failed.`,
      retryable: true,
      details: {
        pluginId: input.pluginId,
        actionId: input.actionId,
      },
    });
    const refreshed = syncAssistantPluginManifest(input.controllerHome, repository, input.pluginId);
    const nextManifest = refreshed.manifest;
    appendRuntimeEvent(input.controllerHome, {
      repoId: input.repoId,
      entityType: 'plugin',
      entityId: input.pluginId,
      eventType: 'plugin_action_failed',
      requestId: input.requestId,
      revision: nextManifest.revision,
      data: {
        actionId: input.actionId,
        jobId: input.jobId,
        code: pluginError.code,
        retryable: pluginError.retryable,
      },
    });
    throw new AssistantPluginError(pluginError.code, pluginError.message.replace(/^[^:]+:\s*/, ''), {
      retryable: pluginError.retryable,
      details: pluginError.details,
    });
  }
}
