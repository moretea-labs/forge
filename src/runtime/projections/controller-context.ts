import { createHash } from 'crypto';
import { join } from 'path';
import { isProcessAlive } from '../shared/process-tree';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';

export type ControllerContextProjectionVariant = 'summary' | 'detail';
export type ControllerContextProjectionRefreshState = 'idle' | 'pending' | 'refreshing' | 'failed';

export interface ControllerContextProjectionSourceIdentity {
  repoId: string;
  checkoutId?: string;
  head?: string | null;
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
  ownerEpoch?: string;
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
  lastSuccessfulBuildAt?: string;
  payload: Record<string, unknown>;
}

export interface ControllerContextProjectionReadOptions {
  sourceIdentity?: ControllerContextProjectionSourceIdentity;
  allowLegacySummary?: boolean;
}

export interface ControllerContextProjectionWriteOptions {
  sourceRevision?: string;
  contentFingerprint?: string;
  variant?: ControllerContextProjectionVariant;
  sourceIdentity?: ControllerContextProjectionSourceIdentity;
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
  ownerEpoch?: string;
  force?: boolean;
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
  Number(process.env.REPO_HARNESS_CONTEXT_PROJECTION_STALE_OWNER_MS ?? 60_000),
);

function legacyContextProjectionPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'controller-context.json');
}

function sourceIdentityValue(identity: ControllerContextProjectionSourceIdentity): Record<string, unknown> {
  return {
    repoId: identity.repoId,
    checkoutId: identity.checkoutId ?? null,
    head: identity.head ?? null,
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

function contextProjectionPath(
  controllerHome: string,
  repoId: string,
  sourceIdentity?: ControllerContextProjectionSourceIdentity,
): string {
  if (!sourceIdentity) return legacyContextProjectionPath(controllerHome, repoId);
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

function normalizeProjection(
  projection: ControllerContextProjection,
  repoId: string,
  sourceIdentity?: ControllerContextProjectionSourceIdentity,
): ControllerContextProjection | undefined {
  if (projection.schemaVersion !== 1 || projection.repoId !== repoId || !projection.payload) return undefined;
  if (sourceIdentity && projection.sourceIdentity && !sourceIdentityMatches(projection.sourceIdentity, sourceIdentity)) return undefined;
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
  sourceIdentity?: ControllerContextProjectionSourceIdentity,
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
  options: ControllerContextProjectionReadOptions = {},
): ControllerContextProjection | undefined {
  if (options.sourceIdentity) {
    const keyed = readProjectionAt(
      contextProjectionPath(controllerHome, repoId, options.sourceIdentity),
      repoId,
      options.sourceIdentity,
    );
    if (keyed) return recoverStaleRefresh(controllerHome, repoId, options.sourceIdentity, keyed);
    if (options.allowLegacySummary !== false && options.sourceIdentity.variant === 'summary') {
      return readProjectionAt(legacyContextProjectionPath(controllerHome, repoId), repoId);
    }
    return undefined;
  }
  return readProjectionAt(legacyContextProjectionPath(controllerHome, repoId), repoId);
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
  options: ControllerContextProjectionWriteOptions = {},
): ControllerContextProjection {
  const generatedAt = new Date().toISOString();
  const sourceIdentity = options.sourceIdentity ?? (options.variant ? {
    repoId,
    variant: options.variant,
    sourceRevision: options.sourceRevision,
  } : undefined);
  const projection: ControllerContextProjection = {
    schemaVersion: 1,
    repoId,
    generatedAt,
    ...(sourceIdentity ? {
      variant: sourceIdentity.variant,
      sourceIdentity,
      projectionGeneration: options.projectionGeneration,
      refreshState: options.refreshState ?? 'idle',
      refreshAttempt: options.refreshAttempt ?? 0,
    } : {}),
    ...(options.refreshOwner ? { refreshOwner: options.refreshOwner } : {}),
    ...(options.lastRefreshError ? { lastRefreshError: options.lastRefreshError } : {}),
    ...(options.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
    ...(options.sourceRevision || sourceIdentity?.sourceRevision ? { sourceRevision: options.sourceRevision ?? sourceIdentity?.sourceRevision } : {}),
    ...(options.contentFingerprint ? { contentFingerprint: options.contentFingerprint } : {}),
    lastSuccessfulBuildAt: generatedAt,
    payload,
  };
  writeJsonAtomic(contextProjectionPath(controllerHome, repoId, sourceIdentity), projection);
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
  const existing = readControllerContextProjection(controllerHome, repoId, { sourceIdentity: request.sourceIdentity, allowLegacySummary: false });
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
  const projectionGeneration = request.projectionGeneration ?? `${key}-${generation}`;
  const attempt = (existing?.refreshAttempt ?? 0) + 1;
  const owner: ControllerContextProjectionRefreshOwner = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ...(request.ownerEpoch ? { ownerEpoch: request.ownerEpoch } : {}),
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
      if (refreshGenerations.get(baseKey) !== generation) {
        writeProjectionState(controllerHome, repoId, request.sourceIdentity, {
          refreshState: 'pending',
          refreshAttempt: attempt,
          projectionGeneration,
        });
        return;
      }
      writeControllerContextProjection(controllerHome, repoId, payload, {
        sourceIdentity: request.sourceIdentity,
        variant: request.variant,
        projectionGeneration,
        sourceRevision: request.sourceIdentity.sourceRevision,
        refreshState: 'idle',
        refreshAttempt: attempt,
      });
    } catch (error) {
      if (refreshGenerations.get(baseKey) !== generation) {
        writeProjectionState(controllerHome, repoId, request.sourceIdentity, {
          refreshState: 'pending',
          refreshAttempt: attempt,
          projectionGeneration,
        });
        return;
      }
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
  });
  refreshFlights.set(key, flight);
  return { key, refreshJobId, projectionGeneration, queued: true };
}
