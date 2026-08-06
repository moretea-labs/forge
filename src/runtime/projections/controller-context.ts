import { createHash } from 'crypto';
import { readdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { isProcessAlive } from '../shared/process-tree';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

export type ControllerContextProjectionVariant = 'summary' | 'detail';
export type ControllerContextProjectionRefreshState = 'idle' | 'pending' | 'refreshing' | 'failed';

export interface ControllerContextProjectionSourceIdentity {
  repoId: string;
  checkoutId?: string;
  canonicalRoot?: string;
  head?: string | null;
  branch?: string | null;
  workingTreeFingerprint?: string;
  runtimeGeneration?: string;
  sourceRevision?: string;
  variant: ControllerContextProjectionVariant;
  toolset?: string;
  profile?: string;
}

export interface ControllerContextProjectionRefreshError {
  message: string;
  failedAt: string;
  attempt: number;
  retryable: true;
}

export interface ControllerContextProjectionRefreshOwner {
  pid: number;
  acquiredAt: string;
}

export interface ControllerContextProjection {
  schemaVersion: 1;
  repoId: string;
  generatedAt: string;
  /** Additive projection variant. Legacy records are treated as summary records. */
  variant?: ControllerContextProjectionVariant;
  /** Full source identity prevents repo/checkout/detail cache pollution. */
  sourceIdentity?: ControllerContextProjectionSourceIdentity;
  /** Monotonic generation within a refresh key; old builders cannot publish over newer ones. */
  projectionGeneration?: string;
  refreshState?: ControllerContextProjectionRefreshState;
  refreshAttempt?: number;
  refreshOwner?: ControllerContextProjectionRefreshOwner;
  lastRefreshError?: ControllerContextProjectionRefreshError;
  nextAttemptAt?: string;
  /** Source identity is additive and is not a heartbeat. */
  sourceRevision?: string;
  contentFingerprint?: string;
  /** Invalidation marker nonce observed when this record was built. A mismatch forces a refresh. */
  invalidationNonce?: string;
  lastSuccessfulBuildAt?: string;
  payload: Record<string, unknown>;
}

export interface ControllerContextProjectionReadOptions {
  sourceIdentity: ControllerContextProjectionSourceIdentity;
}

export interface ControllerContextProjectionWriteOptions {
  sourceIdentity: ControllerContextProjectionSourceIdentity;
  sourceRevision?: string;
  contentFingerprint?: string;
  invalidationNonce?: string;
  variant?: ControllerContextProjectionVariant;
  projectionGeneration?: string;
  refreshState?: ControllerContextProjectionRefreshState;
  refreshAttempt?: number;
  refreshOwner?: ControllerContextProjectionRefreshOwner;
  lastRefreshError?: ControllerContextProjectionRefreshError;
  nextAttemptAt?: string;
}

export interface ControllerContextProjectionRefreshRequest {
  variant: ControllerContextProjectionVariant;
  sourceIdentity: ControllerContextProjectionSourceIdentity;
  projectionGeneration?: string;
  force?: boolean;
  /** Invalidation marker nonce observed at queue time; persisted with the rebuilt record. */
  invalidationNonce?: string;
  build: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ControllerContextProjectionRefreshResult {
  key: string;
  refreshJobId: string;
  projectionGeneration: string;
  queued: boolean;
  skippedReason?: 'single_flight' | 'refreshing' | 'retry_deferred';
}

const CONTROLLER_CONTEXT_REFRESH_STALE_OWNER_MS = Math.max(
  5_000,
  Number(process.env.FORGE_CONTEXT_PROJECTION_STALE_OWNER_MS ?? 60_000),
);

/** Hard ceiling for the in-memory refresh generation ledger. */
const REFRESH_GENERATION_LEDGER_MAX = 1_024;

export interface ControllerContextProjectionInvalidation {
  schemaVersion: 1;
  markedAt: string;
  nonce: string;
  reason: string;
}

export interface ControllerContextPerformanceSnapshot {
  reads: number;
  cacheHits: number;
  staleReads: number;
  refreshRequests: number;
  totalDurationMs: number;
  maxDurationMs: number;
  maxResponseBytes: number;
  lastResponseBytes?: number;
  phaseDurationsMs: Record<string, number>;
  lastDurationMs?: number;
  lastCacheHit?: boolean;
  lastReadAt?: string;
}

const performanceSnapshot: ControllerContextPerformanceSnapshot = {
  reads: 0,
  cacheHits: 0,
  staleReads: 0,
  refreshRequests: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
  maxResponseBytes: 0,
  phaseDurationsMs: {},
};

function contextInvalidationPath(repoRoot: string): string {
  return join(repoRoot, '.ai', 'harness', 'controller-context-invalidation.json');
}

/**
 * Mutation paths use this tiny repository-local marker to invalidate the
 * materialized context without making a hot read rescan Issues or plugins.
 */
export function markControllerContextProjectionDirty(
  repoRoot: string,
  reason: string,
  now = new Date(),
): ControllerContextProjectionInvalidation {
  const marker: ControllerContextProjectionInvalidation = {
    schemaVersion: 1,
    markedAt: now.toISOString(),
    nonce: `${now.getTime()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    reason: reason.slice(0, 240),
  };
  try { writeJsonAtomic(contextInvalidationPath(repoRoot), marker); } catch { /* best-effort invalidation */ }
  return marker;
}

export function readControllerContextProjectionInvalidation(
  repoRoot: string,
): ControllerContextProjectionInvalidation | undefined {
  try {
    const marker = readJsonFile<ControllerContextProjectionInvalidation>(contextInvalidationPath(repoRoot));
    if (marker.schemaVersion !== 1 || !marker.markedAt || !marker.nonce) return undefined;
    return marker;
  } catch {
    return undefined;
  }
}

export function recordControllerContextRead(input: {
  durationMs: number;
  cacheHit: boolean;
  stale: boolean;
  responseBytes?: number;
  phaseDurationsMs?: Record<string, number>;
}): void {
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
  performanceSnapshot.reads += 1;
  if (input.cacheHit) performanceSnapshot.cacheHits += 1;
  if (input.stale) performanceSnapshot.staleReads += 1;
  performanceSnapshot.totalDurationMs += durationMs;
  performanceSnapshot.maxDurationMs = Math.max(performanceSnapshot.maxDurationMs, durationMs);
  if (typeof input.responseBytes === 'number' && Number.isFinite(input.responseBytes)) {
    const responseBytes = Math.max(0, Math.trunc(input.responseBytes));
    performanceSnapshot.lastResponseBytes = responseBytes;
    performanceSnapshot.maxResponseBytes = Math.max(performanceSnapshot.maxResponseBytes, responseBytes);
  }
  for (const [phase, phaseDuration] of Object.entries(input.phaseDurationsMs ?? {})) {
    if (Number.isFinite(phaseDuration)) {
      performanceSnapshot.phaseDurationsMs[phase] = Math.max(performanceSnapshot.phaseDurationsMs[phase] ?? 0, Math.max(0, phaseDuration));
    }
  }
  performanceSnapshot.lastDurationMs = durationMs;
  performanceSnapshot.lastCacheHit = input.cacheHit;
  performanceSnapshot.lastReadAt = new Date().toISOString();
}

export function controllerContextPerformanceSnapshot(): ControllerContextPerformanceSnapshot {
  return { ...performanceSnapshot };
}

export function clearControllerContextPerformanceSnapshotForTest(): void {
  performanceSnapshot.reads = 0;
  performanceSnapshot.cacheHits = 0;
  performanceSnapshot.staleReads = 0;
  performanceSnapshot.refreshRequests = 0;
  performanceSnapshot.totalDurationMs = 0;
  performanceSnapshot.maxDurationMs = 0;
  performanceSnapshot.maxResponseBytes = 0;
  performanceSnapshot.phaseDurationsMs = {};
  delete performanceSnapshot.lastResponseBytes;
  delete performanceSnapshot.lastDurationMs;
  delete performanceSnapshot.lastCacheHit;
  delete performanceSnapshot.lastReadAt;
  refreshFlights.clear();
  refreshGenerations.clear();
}

function sourceIdentityValue(identity: ControllerContextProjectionSourceIdentity): Record<string, unknown> {
  return {
    repoId: identity.repoId,
    checkoutId: identity.checkoutId ?? null,
    canonicalRoot: identity.canonicalRoot ? resolve(identity.canonicalRoot) : null,
    head: identity.head ?? null,
    branch: identity.branch ?? null,
    workingTreeFingerprint: identity.workingTreeFingerprint ?? null,
    runtimeGeneration: identity.runtimeGeneration ?? null,
    sourceRevision: identity.sourceRevision ?? null,
    variant: identity.variant,
    toolset: identity.toolset ?? null,
    profile: identity.profile ?? null,
  };
}

export function controllerContextProjectionKey(identity: ControllerContextProjectionSourceIdentity): string {
  return createHash('sha256').update(JSON.stringify(sourceIdentityValue(identity))).digest('hex').slice(0, 32);
}

/**
 * Remove superseded keyed projection files for the same repo/checkout/variant.
 * Source identity is content-based, so every commit would otherwise leave a
 * new file behind; only the newest generation is needed for SWR reads.
 */
function pruneContextProjectionFiles(
  controllerHome: string,
  repoId: string,
  sourceIdentity: ControllerContextProjectionSourceIdentity,
  keepPath: string,
): void {
  try {
    const projectionsRoot = join(repositoryControllerRoot(controllerHome, repoId), 'projections');
    const entries = readdirSync(projectionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('controller-context-') || !entry.name.endsWith('.json')) continue;
      const candidatePath = join(projectionsRoot, entry.name);
      if (resolve(candidatePath) === resolve(keepPath)) continue;
      try {
        const candidate = readJsonFile<ControllerContextProjection>(candidatePath);
        const identity = candidate?.sourceIdentity;
        if (!identity) continue;
        if (identity.repoId === repoId
          && (identity.checkoutId ?? null) === (sourceIdentity.checkoutId ?? null)
          && identity.variant === sourceIdentity.variant) {
          rmSync(candidatePath, { force: true });
        }
      } catch {
        /* keep unreadable files; never delete on parse noise */
      }
    }
  } catch {
    /* projections dir may not exist yet */
  }
}

function contextProjectionPath(
  controllerHome: string,
  repoId: string,
  sourceIdentity: ControllerContextProjectionSourceIdentity,
): string {
  return join(
    repositoryControllerRoot(controllerHome, repoId),
    'projections',
    `controller-context-${controllerContextProjectionKey(sourceIdentity)}.json`,
  );
}

function sourceIdentityMatches(
  left: ControllerContextProjectionSourceIdentity | undefined,
  right: ControllerContextProjectionSourceIdentity,
): boolean {
  return JSON.stringify(sourceIdentityValue(left ?? {
    repoId: '',
    variant: 'summary',
  })) === JSON.stringify(sourceIdentityValue(right));
}

function projectionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function controllerContextProjectionPayloadMatchesSourceIdentity(
  payload: Record<string, unknown>,
  sourceIdentity: ControllerContextProjectionSourceIdentity,
): boolean {
  const repository = projectionRecord(payload.repository);
  const git = projectionRecord(payload.git);
  if (payload.repoId !== sourceIdentity.repoId || repository.repoId !== sourceIdentity.repoId) return false;
  if (sourceIdentity.checkoutId) {
    const checkoutId = repository.checkoutId ?? repository.activeCheckoutId;
    if (checkoutId !== sourceIdentity.checkoutId) return false;
  }
  if (sourceIdentity.canonicalRoot) {
    const root = repository.root ?? repository.canonicalRoot ?? repository.localRoot;
    if (typeof root !== 'string' || resolve(root) !== resolve(sourceIdentity.canonicalRoot)) return false;
  }
  if (sourceIdentity.head !== undefined) {
    const head = git.head ?? repository.head ?? null;
    if (head !== sourceIdentity.head) return false;
  }
  if (sourceIdentity.branch !== undefined) {
    const branch = git.branch ?? repository.branch ?? null;
    if (branch !== sourceIdentity.branch) return false;
  }
  return true;
}

function normalizeProjection(
  projection: ControllerContextProjection,
  repoId: string,
  sourceIdentity: ControllerContextProjectionSourceIdentity,
): ControllerContextProjection | undefined {
  if (projection.schemaVersion !== 1 || projection.repoId !== repoId || !projection.payload) return undefined;
  if (!projection.sourceIdentity || !sourceIdentityMatches(projection.sourceIdentity, sourceIdentity)) return undefined;
  if (!controllerContextProjectionPayloadMatchesSourceIdentity(projection.payload, sourceIdentity)) return undefined;
  return {
    ...projection,
    variant: projection.variant ?? 'summary',
    refreshState: projection.refreshState ?? 'idle',
    refreshAttempt: Number.isFinite(projection.refreshAttempt) ? Math.max(0, Math.trunc(projection.refreshAttempt!)) : 0,
  };
}

function readProjectionAt(
  path: string,
  repoId: string,
  sourceIdentity: ControllerContextProjectionSourceIdentity,
): ControllerContextProjection | undefined {
  try {
    return normalizeProjection(readJsonFile<ControllerContextProjection>(path), repoId, sourceIdentity);
  } catch {
    return undefined;
  }
}

function refreshOwnerIsStale(owner: ControllerContextProjectionRefreshOwner | undefined, nowMs = Date.now()): boolean {
  if (!owner) return true;
  const ageMs = nowMs - Date.parse(owner.acquiredAt);
  return !Number.isFinite(ageMs)
    || ageMs >= CONTROLLER_CONTEXT_REFRESH_STALE_OWNER_MS
    || !isProcessAlive(owner.pid);
}

function recoverStaleRefresh(
  controllerHome: string,
  repoId: string,
  sourceIdentity: ControllerContextProjectionSourceIdentity,
  projection: ControllerContextProjection,
): ControllerContextProjection {
  if (projection.refreshState !== 'refreshing' || !refreshOwnerIsStale(projection.refreshOwner)) return projection;
  const recovered: ControllerContextProjection = {
    ...projection,
    refreshState: 'pending',
    refreshOwner: undefined,
    nextAttemptAt: undefined,
  };
  writeJsonAtomic(contextProjectionPath(controllerHome, repoId, sourceIdentity), recovered);
  return recovered;
}

export function readControllerContextProjection(
  controllerHome: string,
  repoId: string,
  options: ControllerContextProjectionReadOptions,
): ControllerContextProjection | undefined {
  const keyed = readProjectionAt(
    contextProjectionPath(controllerHome, repoId, options.sourceIdentity),
    repoId,
    options.sourceIdentity,
  );
  return keyed ? recoverStaleRefresh(controllerHome, repoId, options.sourceIdentity, keyed) : undefined;
}

function writeProjectionState(
  controllerHome: string,
  repoId: string,
  sourceIdentity: ControllerContextProjectionSourceIdentity,
  state: Pick<ControllerContextProjection, 'refreshState' | 'refreshAttempt' | 'refreshOwner' | 'lastRefreshError' | 'nextAttemptAt' | 'projectionGeneration'>,
  payload?: Record<string, unknown>,
): ControllerContextProjection {
  const existing = readProjectionAt(contextProjectionPath(controllerHome, repoId, sourceIdentity), repoId, sourceIdentity);
  const generatedAt = existing?.generatedAt ?? new Date().toISOString();
  const projection: ControllerContextProjection = {
    schemaVersion: 1,
    repoId,
    generatedAt,
    variant: sourceIdentity.variant,
    sourceIdentity,
    projectionGeneration: state.projectionGeneration ?? existing?.projectionGeneration,
    refreshState: state.refreshState ?? existing?.refreshState ?? 'idle',
    refreshAttempt: state.refreshAttempt ?? existing?.refreshAttempt ?? 0,
    ...(state.refreshOwner ? { refreshOwner: state.refreshOwner } : {}),
    ...(state.lastRefreshError ? { lastRefreshError: state.lastRefreshError } : {}),
    ...(state.nextAttemptAt ? { nextAttemptAt: state.nextAttemptAt } : {}),
    ...(existing?.sourceRevision ? { sourceRevision: existing.sourceRevision } : sourceIdentity.sourceRevision ? { sourceRevision: sourceIdentity.sourceRevision } : {}),
    ...(existing?.contentFingerprint ? { contentFingerprint: existing.contentFingerprint } : {}),
    ...(existing?.invalidationNonce ? { invalidationNonce: existing.invalidationNonce } : {}),
    ...(existing?.lastSuccessfulBuildAt ? { lastSuccessfulBuildAt: existing.lastSuccessfulBuildAt } : {}),
    payload: payload ?? existing?.payload ?? {},
  };
  writeJsonAtomic(contextProjectionPath(controllerHome, repoId, sourceIdentity), projection);
  return projection;
}

export function writeControllerContextProjection(
  controllerHome: string,
  repoId: string,
  payload: Record<string, unknown>,
  options: ControllerContextProjectionWriteOptions,
): ControllerContextProjection {
  const generatedAt = new Date().toISOString();
  const sourceIdentity = options.sourceIdentity;
  if (sourceIdentity.repoId !== repoId) {
    throw new Error('CONTEXT_PROJECTION_REPOSITORY_ID_MISMATCH: source identity must match the target repository');
  }
  if (!controllerContextProjectionPayloadMatchesSourceIdentity(payload, sourceIdentity)) {
    throw new Error('CONTEXT_PROJECTION_SOURCE_MISMATCH: payload repository and Git identity must match sourceIdentity');
  }
  const projection: ControllerContextProjection = {
    schemaVersion: 1,
    repoId,
    generatedAt,
    variant: sourceIdentity.variant,
    sourceIdentity,
    projectionGeneration: options.projectionGeneration,
    refreshState: options.refreshState ?? 'idle',
    refreshAttempt: options.refreshAttempt ?? 0,
    ...(options.refreshOwner ? { refreshOwner: options.refreshOwner } : {}),
    ...(options.lastRefreshError ? { lastRefreshError: options.lastRefreshError } : {}),
    ...(options.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
    ...(options.sourceRevision || sourceIdentity.sourceRevision ? { sourceRevision: options.sourceRevision ?? sourceIdentity.sourceRevision } : {}),
    ...(options.contentFingerprint ? { contentFingerprint: options.contentFingerprint } : {}),
    ...(options.invalidationNonce ? { invalidationNonce: options.invalidationNonce } : {}),
    lastSuccessfulBuildAt: generatedAt,
    payload,
  };
  const path = contextProjectionPath(controllerHome, repoId, sourceIdentity);
  writeJsonAtomic(path, projection);
  pruneContextProjectionFiles(controllerHome, repoId, sourceIdentity, path);
  return projection;
}

export function controllerContextProjectionAgeMs(projection: ControllerContextProjection | undefined): number {
  if (!projection) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(projection.generatedAt);
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY;
}

export function controllerContextProjectionNeedsRefresh(
  projection: ControllerContextProjection | undefined,
  sourceRevision?: string,
  sourceIdentity?: ControllerContextProjectionSourceIdentity,
): boolean {
  if (!projection) return true;
  if (sourceIdentity && (!projection.sourceIdentity || !sourceIdentityMatches(projection.sourceIdentity, sourceIdentity))) return true;
  if (projection.refreshState === 'pending' || projection.refreshState === 'refreshing' || projection.refreshState === 'failed') return true;
  if (!sourceRevision) return false;
  return projection.sourceRevision !== sourceRevision;
}

const refreshFlights = new Map<string, Promise<void>>();
const refreshGenerations = new Map<string, number>();

function refreshBaseKey(request: ControllerContextProjectionRefreshRequest): string {
  const identity = request.sourceIdentity;
  return [identity.repoId, identity.checkoutId ?? '', identity.variant, identity.toolset ?? '', identity.profile ?? ''].join('|');
}

export function controllerContextProjectionGeneration(sourceIdentity: ControllerContextProjectionSourceIdentity): string {
  return controllerContextProjectionKey(sourceIdentity);
}

export function queueControllerContextProjectionRefresh(
  controllerHome: string,
  repoId: string,
  request: ControllerContextProjectionRefreshRequest,
): ControllerContextProjectionRefreshResult {
  const key = controllerContextProjectionKey(request.sourceIdentity);
  const existingFlight = refreshFlights.get(key);
  const existing = readControllerContextProjection(controllerHome, repoId, { sourceIdentity: request.sourceIdentity });
  if (existingFlight) {
    return {
      key,
      refreshJobId: `ctx-refresh-${key}`,
      projectionGeneration: existing?.projectionGeneration ?? request.projectionGeneration ?? key,
      queued: false,
      skippedReason: 'single_flight',
    };
  }
  if (existing?.refreshState === 'refreshing' && !refreshOwnerIsStale(existing.refreshOwner)) {
    return {
      key,
      refreshJobId: `ctx-refresh-${key}`,
      projectionGeneration: existing.projectionGeneration ?? request.projectionGeneration ?? key,
      queued: false,
      skippedReason: 'refreshing',
    };
  }
  if (!request.force && existing?.refreshState === 'failed' && existing.nextAttemptAt && Date.parse(existing.nextAttemptAt) > Date.now()) {
    return {
      key,
      refreshJobId: `ctx-refresh-${key}`,
      projectionGeneration: existing.projectionGeneration ?? request.projectionGeneration ?? key,
      queued: false,
      skippedReason: 'retry_deferred',
    };
  }

  const baseKey = refreshBaseKey(request);
  const generation = (refreshGenerations.get(baseKey) ?? 0) + 1;
  refreshGenerations.set(baseKey, generation);
  if (refreshGenerations.size > REFRESH_GENERATION_LEDGER_MAX) {
    // Bounded ledger: drop the oldest base keys. Only in-flight builds are
    // protected by the generation check; a completed build no longer needs it.
    const overflow = refreshGenerations.size - REFRESH_GENERATION_LEDGER_MAX;
    const keysToDrop = [...refreshGenerations.keys()].slice(0, overflow);
    for (const staleKey of keysToDrop) refreshGenerations.delete(staleKey);
  }
  const projectionGeneration = request.projectionGeneration ?? `${key}-${generation}`;
  const attempt = (existing?.refreshAttempt ?? 0) + 1;
  const owner: ControllerContextProjectionRefreshOwner = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  writeProjectionState(controllerHome, repoId, request.sourceIdentity, {
    refreshState: 'refreshing',
    refreshAttempt: attempt,
    refreshOwner: owner,
    projectionGeneration,
    lastRefreshError: undefined,
    nextAttemptAt: undefined,
  });
  const refreshJobId = `ctx-refresh-${key}-${generation}`;
  const flight = Promise.resolve().then(async () => {
    try {
      const payload = await request.build();
      if (refreshGenerations.get(baseKey) !== generation) return;
      writeControllerContextProjection(controllerHome, repoId, payload, {
        sourceIdentity: request.sourceIdentity,
        variant: request.variant,
        projectionGeneration,
        sourceRevision: request.sourceIdentity.sourceRevision,
        ...(request.invalidationNonce ? { invalidationNonce: request.invalidationNonce } : {}),
        refreshState: 'idle',
        refreshAttempt: attempt,
      });
    } catch (error) {
      if (refreshGenerations.get(baseKey) !== generation) return;
      const failedAt = new Date().toISOString();
      const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 5)));
      const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
      writeProjectionState(controllerHome, repoId, request.sourceIdentity, {
        refreshState: 'failed',
        refreshAttempt: attempt,
        projectionGeneration,
        lastRefreshError: {
          message: error instanceof Error ? error.message : String(error),
          failedAt,
          attempt,
          retryable: true,
        },
        nextAttemptAt,
      });
    }
  }).finally(() => {
    if (refreshFlights.get(key) === flight) refreshFlights.delete(key);
    // An older flight must never delete the fencing generation of a newer one.
    if (refreshGenerations.get(baseKey) === generation) refreshGenerations.delete(baseKey);
  });
  refreshFlights.set(key, flight);
  return { key, refreshJobId, projectionGeneration, queued: true };
}
