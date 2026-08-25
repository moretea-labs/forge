import { createHash } from 'crypto';
import { join } from 'path';
import { listActiveExecutionJobs, listExecutionJobs } from '../execution/jobs/store';
import { TERMINAL_JOB_STATUSES, type ExecutionJob } from '../execution/jobs/types';
import { listActiveLeases } from '../resources/leases/store';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { listRepositories } from '../../cli/repositories/registry';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { repositoryGitStatus } from '../../cli/repositories/structured-git';
import {
  clearRepositoryProjectionDirty,
  gitRevisionsEquivalent,
  normalizeGitRevision,
  persistRepositoryProjectionDirty,
  projectionRefreshRetryDelayMs,
  PROJECTION_REFRESH_STALE_OWNER_MS,
  readRepositoryProjectionDirty,
  updateRepositoryProjectionRefreshRequest,
  withRepositoryProjectionRefreshLock,
  type ProjectionDirtyMarker,
  type ProjectionRefreshOwner,
} from './invalidation';
import { readRepositoryGitStatusSample } from './git-status-sampler';
import { listAssistantPluginManifests } from '../plugins/store';
import type { ProjectionObservation, ProjectionSourceReconciliation } from '../health';
import { RUNTIME_HEALTH_THRESHOLDS } from '../health/evaluator';
import { isProcessAlive } from '../shared/process-tree';
import type { TaskLedgerProjection } from '../../cli/controller/task-ledger';
import { collectWorkLifecycleAttention } from '../control-plane/execution/work-lifecycle-audit';

export interface ProjectionMetadata {
  contentRevision: number;
  generatedFromRevision?: string;
  contentFingerprint?: string;
  lastSuccessfulBuildAt: string;
  lastBuildAttemptAt?: string;
  lastBuildError?: string;
  producerGeneration?: string;
}

export interface RepositoryRuntimeProjection {
  schemaVersion: 1;
  repoId: string;
  generatedAt: string;
  revision: number;
  /** Additive metadata; revision remains the compatibility field. */
  metadata?: ProjectionMetadata;
  releaseFrozen: boolean;
  activeJobs: Array<Pick<ExecutionJob, 'jobId' | 'type' | 'status' | 'priority' | 'updatedAt' | 'workerPid'>>;
  queueDepth: number;
  runningWorkers: number;
  activeLeases: number;
  currentAttention: Array<{ jobId: string; status: string; message?: string }>;
  attention: Array<{ jobId: string; status: string; message?: string }>;
  plugins?: {
    total: number;
    enabled: number;
    ready: number;
    degraded: number;
    error: number;
  };
}

interface DirtyProjectionReadCacheEntry {
  dirtyNonce: string;
  persistedRevision: number | null;
  dirtyUpdatedAt?: string;
  value: RepositoryRuntimeProjectionSnapshot;
}

const dirtyProjectionReadCache = new Map<string, DirtyProjectionReadCacheEntry>();

function projectionPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'runtime.json');
}

function dirtyProjectionReadCacheKey(controllerHome: string, repoId: string): string {
  return `${controllerHome}::${repoId}`;
}

function emptyProjection(repoId: string, reason?: string): RepositoryRuntimeProjection {
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    repoId,
    generatedAt,
    revision: 0,
    metadata: {
      contentRevision: 0,
      lastSuccessfulBuildAt: generatedAt,
      lastBuildAttemptAt: generatedAt,
      ...(reason ? { generatedFromRevision: reason } : {}),
    },
    releaseFrozen: false,
    activeJobs: [],
    queueDepth: 0,
    runningWorkers: 0,
    activeLeases: 0,
    currentAttention: [],
    attention: [],
    plugins: {
      total: 0,
      enabled: 0,
      ready: 0,
      degraded: 0,
      error: 0,
    },
  };
}

const ATTENTION_JOB_STATUSES = new Set(['orphaned', 'human_attention_required', 'stale']);

function executionJobSummary(job: ExecutionJob): RepositoryRuntimeProjection['activeJobs'][number] {
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    priority: job.priority,
    updatedAt: job.updatedAt,
    workerPid: job.workerPid,
  };
}

function attentionSummary(job: ExecutionJob): RepositoryRuntimeProjection['attention'][number] {
  return { jobId: job.jobId, status: job.status, message: job.error?.message };
}

function executionAttentionIsCurrent(job: ExecutionJob, activeJobIds: ReadonlySet<string>): boolean {
  // Status is the durable lifecycle authority. Legacy/migrated terminal records may
  // lack finishedAt, but that omission must not resurrect terminal attention as a
  // current release blocker. If a future attention status is non-terminal, retain
  // the legacy timestamp/index fallback for that genuinely active state.
  if (TERMINAL_JOB_STATUSES.has(job.status)) return false;
  return !job.finishedAt || activeJobIds.has(job.jobId);
}

function projectionVisibleLeases(leases: ReturnType<typeof listActiveLeases>) {
  // Ephemeral leases protect fast-path Process execution from conflicting writes,
  // but by contract they do not represent Scheduler/Worker durable activity.
  // Counting them here can freeze readiness if a projection is rebuilt while a
  // short-lived local Process is active and the ephemeral release intentionally
  // skips projection invalidation.
  return leases.filter((lease) => lease.visibility !== 'ephemeral');
}

function projectionWithExecutionIndexOverlay(
  controllerHome: string,
  repoId: string,
  base: RepositoryRuntimeProjection,
): RepositoryRuntimeProjection {
  let activeJobs: ExecutionJob[] | undefined;
  let recentJobs: ExecutionJob[] | undefined;
  let leases: ReturnType<typeof listActiveLeases> | undefined;
  try { activeJobs = listActiveExecutionJobs(controllerHome, repoId); }
  catch { activeJobs = undefined; }
  try { recentJobs = listExecutionJobs(controllerHome, repoId, 100); }
  catch { recentJobs = undefined; }
  try { leases = listActiveLeases(controllerHome, repoId); }
  catch { leases = undefined; }

  const projectionLeases = leases ? projectionVisibleLeases(leases) : undefined;
  const activeJobSummaries = activeJobs?.map(executionJobSummary) ?? base.activeJobs;
  const activeJobIds = new Set(activeJobSummaries.map((job) => job.jobId));
  const attentionJobs = recentJobs?.filter((job) => ATTENTION_JOB_STATUSES.has(job.status));
  const attention = attentionJobs?.map(attentionSummary) ?? base.attention;
  const currentAttention = attentionJobs
    ?.filter((job) => executionAttentionIsCurrent(job, activeJobIds))
    .map(attentionSummary)
    ?? base.currentAttention;
  const repository = listRepositories(controllerHome, { includeRemoved: true }).find((entry) => entry.repoId === repoId);
  const lifecycleAttention = repository ? collectWorkLifecycleAttention(controllerHome, repository) : [];

  return {
    ...base,
    activeJobs: activeJobSummaries,
    queueDepth: activeJobs
      ? activeJobs.filter((job) => job.status !== 'running' && job.status !== 'dispatched').length
      : base.queueDepth,
    runningWorkers: activeJobs
      ? activeJobs.filter((job) => job.status === 'running').length
      : base.runningWorkers,
    activeLeases: projectionLeases ? projectionLeases.length : base.activeLeases,
    releaseFrozen: projectionLeases
      ? projectionLeases.some((lease) => lease.resourceKey.startsWith('release:'))
      : base.releaseFrozen,
    currentAttention: [...currentAttention, ...lifecycleAttention].slice(0, 100),
    attention: [...attention, ...lifecycleAttention].slice(0, 100),
  };
}

function dirtyReasonImpliesActiveRisk(reason: string | undefined): boolean {
  return Boolean(reason && /^(job:|leases-|schedule:|worker:|process:|cleanup:)/.test(reason));
}

function buildRepositoryProjection(
  controllerHome: string,
  repoId: string,
  previous?: RepositoryRuntimeProjection,
  sourceRevision?: string,
): RepositoryRuntimeProjection {
  const generatedAt = new Date().toISOString();
  const revision = (previous?.revision ?? 0) + 1;
  const activeJobs = listActiveExecutionJobs(controllerHome, repoId);
  const activeJobIds = new Set(activeJobs.map((job) => job.jobId));
  const leases = projectionVisibleLeases(listActiveLeases(controllerHome, repoId));
  const attentionJobs = listExecutionJobs(controllerHome, repoId, 100)
    .filter((job) => ATTENTION_JOB_STATUSES.has(job.status));
  // Terminal attention records remain in history for diagnosis and audit, but only
  // active/unresolved records should influence "current readiness" decisions.
  // Terminal status wins over a missing legacy finishedAt timestamp.
  const currentAttentionJobs = attentionJobs.filter((job) => executionAttentionIsCurrent(job, activeJobIds));
  const repository = listRepositories(controllerHome).find((entry) => entry.repoId === repoId);
  const lifecycleAttention = repository ? collectWorkLifecycleAttention(controllerHome, repository) : [];
  const plugins = repository ? listAssistantPluginManifests(controllerHome, repository, {
    preferStored: true,
  }) : [];
  const projection: RepositoryRuntimeProjection = {
    schemaVersion: 1,
    repoId,
    generatedAt,
    revision,
    metadata: {
      contentRevision: revision,
      generatedFromRevision: sourceRevision,
      lastSuccessfulBuildAt: generatedAt,
      lastBuildAttemptAt: generatedAt,
      ...(previous?.metadata?.producerGeneration ? { producerGeneration: previous.metadata.producerGeneration } : {}),
    },
    releaseFrozen: leases.some((lease) => lease.resourceKey.startsWith('release:')),
    activeJobs: activeJobs.map((job) => ({
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      priority: job.priority,
      updatedAt: job.updatedAt,
      workerPid: job.workerPid,
    })),
    queueDepth: activeJobs.filter((job) => job.status !== 'running' && job.status !== 'dispatched').length,
    runningWorkers: activeJobs.filter((job) => job.status === 'running').length,
    activeLeases: leases.length,
    currentAttention: [
      ...currentAttentionJobs.map((job) => ({ jobId: job.jobId, status: job.status, message: job.error?.message })),
      ...lifecycleAttention,
    ].slice(0, 100),
    attention: [
      ...attentionJobs.map((job) => ({ jobId: job.jobId, status: job.status, message: job.error?.message })),
      ...lifecycleAttention,
    ].slice(0, 100),
    plugins: {
      total: plugins.length,
      enabled: plugins.filter((plugin) => plugin.enabled).length,
      ready: plugins.filter((plugin) => plugin.health.state === 'ready').length,
      degraded: plugins.filter((plugin) => plugin.health.state === 'degraded').length,
      error: plugins.filter((plugin) => plugin.health.state === 'error').length,
    },
  };
  projection.metadata = {
    ...projection.metadata!,
    contentFingerprint: createHash('sha256').update(JSON.stringify({
      repoId: projection.repoId,
      releaseFrozen: projection.releaseFrozen,
      activeJobs: projection.activeJobs,
      queueDepth: projection.queueDepth,
      runningWorkers: projection.runningWorkers,
      activeLeases: projection.activeLeases,
      currentAttention: projection.currentAttention,
      attention: projection.attention,
      plugins: projection.plugins,
    })).digest('hex'),
  };
  return projection;
}

export function rebuildRepositoryProjection(controllerHome: string, repoId: string): RepositoryRuntimeProjection {
  const repository = listRepositories(controllerHome).find((entry) => entry.repoId === repoId);
  const result = refreshRepositoryProjection(controllerHome, repoId, {
    repository,
    reason: 'manual-rebuild',
    force: true,
  });
  if (result.projection) return result.projection;
  return readRepositoryProjectionSnapshot(controllerHome, repoId).projection;
}

export interface RepositoryRuntimeProjectionSnapshot {
  projection: RepositoryRuntimeProjection;
  stale: boolean;
  persisted: boolean;
  dirtySinceAt?: string;
  dirtyReason?: string;
  dirtySourceRevision?: string;
  sourceRevisionChanged?: boolean;
  refreshStatus?: ProjectionDirtyMarker['refreshStatus'];
  refreshAttempt?: number;
  nextAttemptAt?: string;
  activeInvariantAtRisk?: boolean;
  buildError?: string;
}

export interface RepositoryProjectionRefreshResult {
  refreshed: boolean;
  skippedReason?: 'clean' | 'running' | 'retry_deferred' | 'superseded' | 'passive_runtime';
  projection?: RepositoryRuntimeProjection;
  marker?: ProjectionDirtyMarker;
}

/**
 * Compare the projection's active worker count with the controller Task Ledger.
 * Task status describes workflow progress, not live process ownership, so every
 * mismatch is repository-scoped diagnostic evidence and never a runtime gate.
 */
export function reconcileProjectionWithTaskLedger(
  snapshot: RepositoryRuntimeProjectionSnapshot,
  ledger: TaskLedgerProjection,
): ProjectionSourceReconciliation {
  const runningTasks = ledger.issues
    .flatMap((issue) => issue.tasks)
    .filter((task) => task.effectiveStatus === 'running' || task.activeRunStatus === 'running');
  const projectionRunningWorkers = Math.max(0, snapshot.projection.runningWorkers);
  const ledgerRunningTasks = runningTasks.length;
  const status = projectionRunningWorkers === ledgerRunningTasks ? 'consistent' : 'mismatch';
  return {
    status,
    projectionRunningWorkers,
    ledgerRunningTasks,
    ...(runningTasks.length > 0 ? { ledgerRunningTaskIds: runningTasks.map((task) => `${task.issueId}/${task.taskId}`) } : {}),
    ...(status === 'mismatch'
      ? { detail: `projection runningWorkers=${projectionRunningWorkers}, ledger runningTasks=${ledgerRunningTasks}` }
      : {}),
  };
}

export interface RepositoryProjectionRefreshOptions {
  repository?: RepositoryRecord;
  sourceRevision?: string;
  reason?: string;
  force?: boolean;
  owner?: Omit<ProjectionRefreshOwner, 'pid' | 'acquiredAt'> & { pid?: number };
  nowMs?: number;
}

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function projectionSourceRevisionFromRepository(
  controllerHome: string,
  repository: RepositoryRecord | undefined,
): string | undefined {
  if (!repository) return undefined;
  const sampled = readRepositoryGitStatusSample(controllerHome, repository.repoId, repository.activeCheckoutId);
  const sampledHead = normalizeGitRevision(sampled?.head);
  if (sampledHead) return sampledHead;
  try {
    return normalizeGitRevision(repositoryGitStatus(repository).head);
  } catch {
    return undefined;
  }
}

function sourceRevisionChanged(
  generatedFromRevision: string | undefined,
  sourceRevision: string | undefined,
  stale: boolean,
  persisted: boolean,
): boolean {
  const source = normalizeGitRevision(sourceRevision);
  if (!persisted) return true;
  if (!source) return stale;
  return !gitRevisionsEquivalent(generatedFromRevision, source);
}

function refreshOwner(input: RepositoryProjectionRefreshOptions, acquiredAt: string): ProjectionRefreshOwner {
  return {
    pid: input.owner?.pid ?? process.pid,
    acquiredAt,
    ...(input.owner?.runtimeInstanceId ? { runtimeInstanceId: input.owner.runtimeInstanceId } : {}),
  };
}

function ownerStillOwnsRefresh(marker: ProjectionDirtyMarker, nowMs: number, currentOwner?: ProjectionRefreshOwner): boolean {
  if (marker.refreshStatus !== 'running') return false;
  const startedAt = Date.parse(marker.runningStartedAt ?? marker.refreshOwner?.acquiredAt ?? marker.refreshUpdatedAt ?? marker.markedAt);
  const ageMs = Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : Number.POSITIVE_INFINITY;
  if (ageMs >= PROJECTION_REFRESH_STALE_OWNER_MS) return false;
  const owner = marker.refreshOwner;
  if (!owner?.pid || !isProcessAlive(owner.pid)) return false;
  if (
    currentOwner?.runtimeInstanceId
    && owner.runtimeInstanceId
    && currentOwner.runtimeInstanceId !== owner.runtimeInstanceId
  ) return false;
  return true;
}

function markRunning(
  controllerHome: string,
  repoId: string,
  marker: ProjectionDirtyMarker,
  owner: ProjectionRefreshOwner,
  now: string,
): ProjectionDirtyMarker {
  return persistRepositoryProjectionDirty(controllerHome, repoId, {
    ...marker,
    refreshStatus: 'running',
    refreshAttempt: (marker.refreshAttempt ?? 0) + 1,
    refreshUpdatedAt: now,
    runningStartedAt: now,
    refreshOwner: owner,
    nextAttemptAt: undefined,
  });
}

function markFailed(
  controllerHome: string,
  repoId: string,
  marker: ProjectionDirtyMarker,
  owner: ProjectionRefreshOwner,
  error: unknown,
  nowMs: number,
): ProjectionDirtyMarker {
  const attempt = Math.max(1, marker.refreshAttempt ?? 1);
  const nextAttemptAt = nowIso(nowMs + projectionRefreshRetryDelayMs(attempt));
  const message = error instanceof Error ? error.message : String(error);
  return persistRepositoryProjectionDirty(controllerHome, repoId, {
    ...marker,
    refreshStatus: 'failed',
    refreshUpdatedAt: nowIso(nowMs),
    runningStartedAt: undefined,
    refreshOwner: undefined,
    nextAttemptAt,
    lastFailure: {
      message,
      failedAt: nowIso(nowMs),
      attempt,
      retryable: true,
      nextAttemptAt,
      owner,
    },
  });
}

function recoverStaleOwner(
  controllerHome: string,
  repoId: string,
  marker: ProjectionDirtyMarker,
  now: string,
  reason: string,
): ProjectionDirtyMarker {
  return persistRepositoryProjectionDirty(controllerHome, repoId, {
    ...marker,
    refreshStatus: 'pending',
    refreshUpdatedAt: now,
    runningStartedAt: undefined,
    refreshOwner: undefined,
    nextAttemptAt: undefined,
    staleOwnerRecoveredAt: now,
    staleOwnerRecoveryReason: reason,
  });
}

function refreshRepositoryProjection(
  controllerHome: string,
  repoId: string,
  options: RepositoryProjectionRefreshOptions = {},
): RepositoryProjectionRefreshResult {
  const nowMs = options.nowMs ?? Date.now();
  const acquiredAt = nowIso(nowMs);
  const owner = refreshOwner(options, acquiredAt);
  return withRepositoryProjectionRefreshLock(
    controllerHome,
    repoId,
    `projection-refresh:${owner.pid}`,
    () => {
      dirtyProjectionReadCache.delete(dirtyProjectionReadCacheKey(controllerHome, repoId));
      const previous = readJsonFile<RepositoryRuntimeProjection | undefined>(projectionPath(controllerHome, repoId), undefined);
      const sourceRevision = normalizeGitRevision(options.sourceRevision)
        ?? projectionSourceRevisionFromRepository(controllerHome, options.repository)
        ?? normalizeGitRevision(previous?.metadata?.generatedFromRevision);
      let marker = readRepositoryProjectionDirty(controllerHome, repoId);
      const changed = sourceRevisionChanged(
        previous?.metadata?.generatedFromRevision,
        sourceRevision,
        Boolean(marker) || !previous,
        Boolean(previous),
      );
      if (!marker && (changed || options.force === true)) {
        marker = updateRepositoryProjectionRefreshRequest(controllerHome, repoId, {
          reason: options.reason ?? (changed ? 'git-source-revision-changed' : 'projection-refresh-requested'),
          sourceRevision,
          nowMs,
        }, { lock: false });
        if (!marker) return { refreshed: false, skippedReason: 'passive_runtime' };
      }
      if (!marker) return { refreshed: false, skippedReason: 'clean', projection: previous };

      const currentOwner = refreshOwner(options, acquiredAt);
      if (ownerStillOwnsRefresh(marker, nowMs, currentOwner)) {
        return { refreshed: false, skippedReason: 'running', marker, projection: previous };
      }
      if (marker.refreshStatus === 'running' && !ownerStillOwnsRefresh(marker, nowMs, currentOwner)) {
        marker = recoverStaleOwner(controllerHome, repoId, marker, acquiredAt, 'stale_owner_or_restart');
      }
      if (
        marker.refreshStatus === 'failed'
        && options.force !== true
        && marker.nextAttemptAt
        && Date.parse(marker.nextAttemptAt) > nowMs
      ) {
        return { refreshed: false, skippedReason: 'retry_deferred', marker, projection: previous };
      }

      const running = markRunning(controllerHome, repoId, {
        ...marker,
        sourceRevision: marker.sourceRevision ?? sourceRevision,
      }, owner, acquiredAt);
      try {
        const latestPrevious = readJsonFile<RepositoryRuntimeProjection | undefined>(projectionPath(controllerHome, repoId), undefined);
        const buildRevision = normalizeGitRevision(running.sourceRevision) ?? sourceRevision;
        const projection = buildRepositoryProjection(controllerHome, repoId, latestPrevious, buildRevision);
        const current = readRepositoryProjectionDirty(controllerHome, repoId);
        if (
          !current
          || current.nonce !== running.nonce
          || (
            running.sourceRevision
            && current.sourceRevision
            && !gitRevisionsEquivalent(running.sourceRevision, current.sourceRevision)
          )
        ) {
          return { refreshed: false, skippedReason: 'superseded', marker: current, projection: latestPrevious };
        }
        writeJsonAtomic(projectionPath(controllerHome, repoId), projection);
        clearRepositoryProjectionDirty(controllerHome, repoId, current, projection.metadata?.generatedFromRevision);
        dirtyProjectionReadCache.delete(dirtyProjectionReadCacheKey(controllerHome, repoId));
        return { refreshed: true, projection };
      } catch (error) {
        const current = readRepositoryProjectionDirty(controllerHome, repoId);
        if (current?.nonce === running.nonce) {
          markFailed(controllerHome, repoId, running, owner, error, options.nowMs ?? Date.now());
        }
        throw error;
      }
    },
  );
}

export function refreshRepositoryProjectionForRepository(
  controllerHome: string,
  repository: RepositoryRecord,
  options: Omit<RepositoryProjectionRefreshOptions, 'repository'> = {},
): RepositoryProjectionRefreshResult {
  return refreshRepositoryProjection(controllerHome, repository.repoId, { ...options, repository });
}

export function projectionBlocksReadiness(
  snapshot: RepositoryRuntimeProjectionSnapshot,
): boolean {
  const ageMs = snapshot.dirtySinceAt
    ? Math.max(0, Date.now() - Date.parse(snapshot.dirtySinceAt))
    : 0;
  const activeInvariantAtRisk = snapshot.projection.activeJobs.length > 0
    || snapshot.projection.queueDepth > 0
    || snapshot.projection.runningWorkers > 0
    || snapshot.projection.activeLeases > 0
    || snapshot.activeInvariantAtRisk === true
    || dirtyReasonImpliesActiveRisk(snapshot.dirtyReason);
  const requiredRefresh = snapshot.stale && (
    snapshot.sourceRevisionChanged !== false
    || activeInvariantAtRisk
    || Boolean(snapshot.buildError)
    || snapshot.refreshStatus === 'running'
    || snapshot.refreshStatus === 'failed'
  );
  return requiredRefresh && ageMs >= RUNTIME_HEALTH_THRESHOLDS.projectionRefreshGraceMs;
}

export function projectionObservation(
  snapshot: RepositoryRuntimeProjectionSnapshot,
  sourceReconciliation?: ProjectionSourceReconciliation,
): ProjectionObservation {
  const dirtyAgeMs = snapshot.dirtySinceAt
    ? Math.max(0, Date.now() - Date.parse(snapshot.dirtySinceAt))
    : undefined;
  const activeInvariantAtRisk = snapshot.projection.activeJobs.length > 0
    || snapshot.projection.queueDepth > 0
    || snapshot.projection.runningWorkers > 0
    || snapshot.projection.activeLeases > 0
    || snapshot.activeInvariantAtRisk === true
    || dirtyReasonImpliesActiveRisk(snapshot.dirtyReason);
  const sourceChanged = snapshot.sourceRevisionChanged ?? sourceRevisionChanged(
    snapshot.projection.metadata?.generatedFromRevision,
    snapshot.dirtySourceRevision,
    snapshot.stale,
    snapshot.persisted,
  );
  const refreshPending = snapshot.stale && (
    sourceChanged
    || activeInvariantAtRisk
    || Boolean(snapshot.buildError)
    || snapshot.refreshStatus === 'running'
    || snapshot.refreshStatus === 'failed'
  );
  return {
    readable: Boolean(snapshot.projection),
    persisted: snapshot.persisted,
    dirty: snapshot.stale,
    sourceRevisionChanged: sourceChanged,
    refreshPending,
    refreshGraceElapsed: dirtyAgeMs !== undefined && dirtyAgeMs >= RUNTIME_HEALTH_THRESHOLDS.projectionRefreshGraceMs,
    activeInvariantAtRisk,
    lastBuildError: snapshot.buildError ?? snapshot.projection.metadata?.lastBuildError,
    contentRevision: snapshot.projection.metadata?.contentRevision ?? snapshot.projection.revision,
    generatedFromRevision: snapshot.projection.metadata?.generatedFromRevision ?? snapshot.dirtySourceRevision ?? snapshot.dirtyReason,
    ...(sourceReconciliation ? { sourceReconciliation } : {}),
  };
}

export function readRepositoryProjectionSnapshot(
  controllerHome: string,
  repoId: string,
): RepositoryRuntimeProjectionSnapshot {
  const dirtyMarker = readRepositoryProjectionDirty(controllerHome, repoId);
  let persisted: RepositoryRuntimeProjection | undefined;
  try {
    persisted = readJsonFile<RepositoryRuntimeProjection>(projectionPath(controllerHome, repoId));
  } catch {
    // No persisted projection exists yet.
  }
  const stale = Boolean(dirtyMarker) || !persisted;
  const sourceChanged = sourceRevisionChanged(
    persisted?.metadata?.generatedFromRevision,
    dirtyMarker?.sourceRevision,
    stale,
    Boolean(persisted),
  );

  if (!stale && persisted) {
    dirtyProjectionReadCache.delete(dirtyProjectionReadCacheKey(controllerHome, repoId));
    return { projection: projectionWithExecutionIndexOverlay(controllerHome, repoId, persisted), stale: false, persisted: true };
  }

  // A hot read must remain read-only and must not rebuild the full projection in
  // the MCP request path. Return the last materialized view with explicit stale
  // metadata; the Daemon/Scheduler producer owns refresh.
  const cacheKey = dirtyProjectionReadCacheKey(controllerHome, repoId);
  const persistedRevision = persisted?.revision ?? null;
  const cached = dirtyMarker ? dirtyProjectionReadCache.get(cacheKey) : undefined;
  if (
    cached
    && dirtyMarker
    && cached.dirtyNonce === dirtyMarker.nonce
    && cached.dirtyUpdatedAt === dirtyMarker.refreshUpdatedAt
    && cached.persistedRevision === persistedRevision
  ) {
    return cached.value;
  }
  const value: RepositoryRuntimeProjectionSnapshot = {
    projection: projectionWithExecutionIndexOverlay(
      controllerHome,
      repoId,
      persisted ?? emptyProjection(repoId, 'Projection has not been materialized yet.'),
    ),
    stale,
    persisted: Boolean(persisted),
    dirtySinceAt: dirtyMarker?.markedAt,
    dirtyReason: dirtyMarker?.reason,
    dirtySourceRevision: dirtyMarker?.sourceRevision,
    sourceRevisionChanged: sourceChanged,
    refreshStatus: dirtyMarker?.refreshStatus,
    refreshAttempt: dirtyMarker?.refreshAttempt,
    nextAttemptAt: dirtyMarker?.nextAttemptAt,
    activeInvariantAtRisk: dirtyReasonImpliesActiveRisk(dirtyMarker?.reason),
    buildError: dirtyMarker?.lastFailure?.message,
  };
  if (dirtyMarker) {
    dirtyProjectionReadCache.set(cacheKey, {
      dirtyNonce: dirtyMarker.nonce,
      dirtyUpdatedAt: dirtyMarker.refreshUpdatedAt,
      persistedRevision,
      value,
    });
  }
  return value;
}

export function readRepositoryProjection(controllerHome: string, repoId: string): RepositoryRuntimeProjection {
  return readRepositoryProjectionSnapshot(controllerHome, repoId).projection;
}
