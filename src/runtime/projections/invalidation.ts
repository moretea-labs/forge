import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { assertRuntimeMayWrite } from '../root/write-fence';
import { withControllerLock } from '../../cli/repositories/locks';

export type ProjectionRefreshStatus = 'pending' | 'running' | 'failed';

export interface ProjectionRefreshOwner {
  pid: number;
  acquiredAt: string;
  runtimeInstanceId?: string;
}

export interface ProjectionRefreshFailure {
  message: string;
  failedAt: string;
  attempt: number;
  retryable: true;
  nextAttemptAt: string;
  owner?: ProjectionRefreshOwner;
}

export interface ProjectionDirtyMarker {
  schemaVersion: 1;
  repoId: string;
  reason: string;
  markedAt: string;
  nonce: string;
  /** Canonical source revision that requires materialization. Legacy markers omit this. */
  sourceRevision?: string;
  refreshStatus?: ProjectionRefreshStatus;
  refreshAttempt?: number;
  refreshRequestedAt?: string;
  refreshUpdatedAt?: string;
  runningStartedAt?: string;
  refreshOwner?: ProjectionRefreshOwner;
  nextAttemptAt?: string;
  lastFailure?: ProjectionRefreshFailure;
  staleOwnerRecoveredAt?: string;
  staleOwnerRecoveryReason?: string;
  supersedesNonce?: string;
}

export const PROJECTION_REFRESH_RETRY_BASE_MS = 1_000;
export const PROJECTION_REFRESH_RETRY_MAX_MS = 30_000;
export const PROJECTION_REFRESH_STALE_OWNER_MS = Math.max(
  5_000,
  Number(process.env.REPO_HARNESS_PROJECTION_REFRESH_STALE_OWNER_MS ?? 60_000),
);

export function repositoryProjectionDirtyPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'projections', 'runtime.dirty.json');
}

function dirtyPath(controllerHome: string, repoId: string): string {
  return repositoryProjectionDirtyPath(controllerHome, repoId);
}

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function randomNonce(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeGitRevision(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized;
}

function isHexRevision(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

export function gitRevisionsEquivalent(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeGitRevision(left);
  const normalizedRight = normalizeGitRevision(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (!isHexRevision(normalizedLeft) || !isHexRevision(normalizedRight)) return false;
  const shortLength = Math.min(normalizedLeft.length, normalizedRight.length);
  if (shortLength < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

export function projectionRefreshRetryDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(1, Math.min(Math.trunc(attempt), 10));
  return Math.min(PROJECTION_REFRESH_RETRY_MAX_MS, PROJECTION_REFRESH_RETRY_BASE_MS * (2 ** (boundedAttempt - 1)));
}

function normalizeMarker(marker: ProjectionDirtyMarker): ProjectionDirtyMarker {
  const refreshAttempt = Number.isFinite(marker.refreshAttempt)
    ? Math.max(0, Math.trunc(marker.refreshAttempt!))
    : 0;
  const sourceRevision = normalizeGitRevision(marker.sourceRevision);
  return {
    ...marker,
    repoId: marker.repoId || '',
    markedAt: marker.markedAt || nowIso(),
    nonce: marker.nonce || randomNonce(),
    ...(sourceRevision ? { sourceRevision } : {}),
    refreshStatus: marker.refreshStatus ?? 'pending',
    refreshAttempt,
    refreshRequestedAt: marker.refreshRequestedAt ?? marker.markedAt,
    refreshUpdatedAt: marker.refreshUpdatedAt ?? marker.markedAt,
  };
}

export function withRepositoryProjectionRefreshLock<T>(
  controllerHome: string,
  repoId: string,
  owner: string,
  operation: () => T,
  waitMs = 5_000,
): T {
  return withControllerLock(
    controllerHome,
    { scope: 'task', repoId, taskId: 'projection-refresh' },
    owner,
    operation,
    undefined,
    waitMs,
  );
}

export function persistRepositoryProjectionDirty(
  controllerHome: string,
  repoId: string,
  marker: ProjectionDirtyMarker,
): ProjectionDirtyMarker {
  const normalized = normalizeMarker({ ...marker, repoId });
  writeJsonAtomic(dirtyPath(controllerHome, repoId), normalized);
  return normalized;
}

export function updateRepositoryProjectionRefreshRequest(
  controllerHome: string,
  repoId: string,
  input: {
    reason: string;
    sourceRevision?: string;
    nowMs?: number;
  },
  options: { lock?: boolean } = {},
): ProjectionDirtyMarker | undefined {
  try {
    const fence = assertRuntimeMayWrite('update_active_projection', controllerHome);
    if (!fence.allowed) {
      // Passive candidates must not mutate projections.
      return undefined;
    }
  } catch {
    /* unbound / legacy */
  }

  const writeRequest = (): ProjectionDirtyMarker => {
    const current = readRepositoryProjectionDirty(controllerHome, repoId);
    const sourceRevision = normalizeGitRevision(input.sourceRevision);
    const now = nowIso(input.nowMs);
    const sameSource = Boolean(
      current
      && (
        (sourceRevision && gitRevisionsEquivalent(current.sourceRevision, sourceRevision))
        || (!sourceRevision && !current.sourceRevision)
      ),
    );

    if (current && sameSource) {
      const normalized = normalizeMarker(current);
      const enriched: ProjectionDirtyMarker = {
        ...normalized,
        reason: normalized.reason || input.reason,
        ...(sourceRevision && !normalized.sourceRevision ? { sourceRevision } : {}),
        refreshUpdatedAt: normalized.refreshUpdatedAt ?? now,
      };
      if (JSON.stringify(enriched) !== JSON.stringify(normalized)) {
        return persistRepositoryProjectionDirty(controllerHome, repoId, enriched);
      }
      return normalized;
    }

    return persistRepositoryProjectionDirty(controllerHome, repoId, {
      schemaVersion: 1,
      repoId,
      reason: input.reason,
      markedAt: now,
      nonce: randomNonce(),
      ...(sourceRevision ? { sourceRevision } : {}),
      refreshStatus: 'pending',
      refreshAttempt: 0,
      refreshRequestedAt: now,
      refreshUpdatedAt: now,
      ...(current?.nonce ? { supersedesNonce: current.nonce } : {}),
    });
  };

  return options.lock === false
    ? writeRequest()
    : withRepositoryProjectionRefreshLock(controllerHome, repoId, `projection-dirty:${process.pid}`, writeRequest);
}

export function markRepositoryProjectionDirty(
  controllerHome: string,
  repoId: string,
  reason: string,
  options: { sourceRevision?: string; nowMs?: number } = {},
): ProjectionDirtyMarker | undefined {
  return updateRepositoryProjectionRefreshRequest(controllerHome, repoId, {
    reason,
    sourceRevision: options.sourceRevision,
    nowMs: options.nowMs,
  });
}

export function readRepositoryProjectionDirty(controllerHome: string, repoId: string): ProjectionDirtyMarker | undefined {
  const path = dirtyPath(controllerHome, repoId);
  if (!existsSync(path)) return undefined;
  try { return normalizeMarker(readJsonFile<ProjectionDirtyMarker>(path)); } catch { return undefined; }
}

export function repositoryProjectionIsDirty(controllerHome: string, repoId: string): boolean {
  return existsSync(dirtyPath(controllerHome, repoId));
}

export function clearRepositoryProjectionDirty(
  controllerHome: string,
  repoId: string,
  expected?: ProjectionDirtyMarker,
  generatedRevision?: string,
): void {
  if (!expected) return;
  const current = readRepositoryProjectionDirty(controllerHome, repoId);
  if (current?.nonce !== expected.nonce) return;
  if (
    expected.sourceRevision
    && current.sourceRevision
    && !gitRevisionsEquivalent(expected.sourceRevision, current.sourceRevision)
  ) return;
  if (
    generatedRevision
    && current.sourceRevision
    && !gitRevisionsEquivalent(generatedRevision, current.sourceRevision)
  ) return;
  rmSync(dirtyPath(controllerHome, repoId), { force: true });
}
