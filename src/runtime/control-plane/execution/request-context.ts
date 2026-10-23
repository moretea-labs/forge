import type { BatchContext } from '../persistence/batch-writes';
import type { ExecutionSessionContext } from './session-store';

/**
 * Request-level context that maintains caches and state across
 * a single MCP request execution.
 *
 * Benefits:
 * - Eliminates duplicate Git calls (save ~6-9ms)
 * - Shares validation results (save ~10ms)
 * - Provides batch write context (save ~28ms for 10 writes)
 * - Total savings: ~44-47ms per request
 *
 * Lifecycle:
 * - Created at request start
 * - Passed through all operations
 * - Destroyed at request end
 */

export interface CachedGitStatus {
  branch: string | null;
  head: string | null;
  clean: boolean;
  cachedAt: number;
}

export interface CachedPermission {
  allowed: boolean;
  reason?: string;
  cachedAt: number;
}

export interface CachedValidation {
  valid: boolean;
  errors?: string[];
  cachedAt: number;
}

export interface RequestMetrics {
  startMs: number;
  gitCallCount: number;
  gitCacheHits: number;
  sqliteWriteCount: number;
  validationCount: number;
  validationCacheHits: number;
  lockWaitMs: number;
}

export interface RequestContext {
  // Identity
  requestId: string;
  sessionId: string;

  // Session reference
  session?: ExecutionSessionContext;

  // Caches (cleared at request end)
  gitStatusCache: Map<string, CachedGitStatus>;
  permissionCache: Map<string, CachedPermission>;
  validationCache: Map<string, CachedValidation>;

  // Batch write context (optional)
  batchContext?: BatchContext;

  // Metrics
  metrics: RequestMetrics;

  // Flags
  enableBatchWrites: boolean;
  enableCaching: boolean;
}

/**
 * Create a new request context.
 */
export function createRequestContext(
  requestId: string,
  sessionId: string,
  options?: {
    enableBatchWrites?: boolean;
    enableCaching?: boolean;
  },
): RequestContext {
  return {
    requestId,
    sessionId,
    gitStatusCache: new Map(),
    permissionCache: new Map(),
    validationCache: new Map(),
    metrics: {
      startMs: performance.now(),
      gitCallCount: 0,
      gitCacheHits: 0,
      sqliteWriteCount: 0,
      validationCount: 0,
      validationCacheHits: 0,
      lockWaitMs: 0,
    },
    enableBatchWrites: options?.enableBatchWrites ?? true,
    enableCaching: options?.enableCaching ?? true,
  };
}

/**
 * Get or compute Git status with request-level caching.
 */
export function getGitStatusCached(
  reqCtx: RequestContext,
  key: string,
  compute: () => CachedGitStatus,
): CachedGitStatus {
  reqCtx.metrics.gitCallCount++;

  if (!reqCtx.enableCaching) {
    return compute();
  }

  const cached = reqCtx.gitStatusCache.get(key);
  const now = Date.now();

  // Cache valid for 5 seconds
  if (cached && (now - cached.cachedAt) < 5000) {
    reqCtx.metrics.gitCacheHits++;
    return cached;
  }

  const fresh = compute();
  reqCtx.gitStatusCache.set(key, fresh);
  return fresh;
}

/**
 * Get or compute permission with request-level caching.
 */
export function getPermissionCached(
  reqCtx: RequestContext,
  key: string,
  compute: () => CachedPermission,
): CachedPermission {
  if (!reqCtx.enableCaching) {
    return compute();
  }

  const cached = reqCtx.permissionCache.get(key);
  if (cached) {
    return cached;
  }

  const fresh = compute();
  reqCtx.permissionCache.set(key, fresh);
  return fresh;
}

/**
 * Get or compute validation with request-level caching.
 */
export function getValidationCached(
  reqCtx: RequestContext,
  key: string,
  compute: () => CachedValidation,
): CachedValidation {
  reqCtx.metrics.validationCount++;

  if (!reqCtx.enableCaching) {
    return compute();
  }

  const cached = reqCtx.validationCache.get(key);
  if (cached) {
    reqCtx.metrics.validationCacheHits++;
    return cached;
  }

  const fresh = compute();
  reqCtx.validationCache.set(key, fresh);
  return fresh;
}

/**
 * Invalidate Git status cache for a specific repository.
 */
export function invalidateGitStatus(
  reqCtx: RequestContext,
  repoId: string,
  checkoutId?: string,
): void {
  if (checkoutId) {
    reqCtx.gitStatusCache.delete(`${repoId}:${checkoutId}`);
  } else {
    // Invalidate all entries for this repo
    for (const key of reqCtx.gitStatusCache.keys()) {
      if (key.startsWith(`${repoId}:`)) {
        reqCtx.gitStatusCache.delete(key);
      }
    }
  }
}

/**
 * Clear all caches in the request context.
 */
export function clearRequestCaches(reqCtx: RequestContext): void {
  reqCtx.gitStatusCache.clear();
  reqCtx.permissionCache.clear();
  reqCtx.validationCache.clear();
}

/**
 * Get request metrics summary.
 */
export function getRequestMetrics(reqCtx: RequestContext): RequestMetrics & { durationMs: number } {
  const durationMs = performance.now() - reqCtx.metrics.startMs;
  return {
    ...reqCtx.metrics,
    durationMs,
  };
}

/**
 * Calculate cache efficiency.
 */
export function getCacheEfficiency(reqCtx: RequestContext): {
  gitCacheHitRate: number;
  validationCacheHitRate: number;
  overallEfficiency: number;
} {
  const gitHitRate = reqCtx.metrics.gitCallCount > 0
    ? reqCtx.metrics.gitCacheHits / reqCtx.metrics.gitCallCount
    : 0;

  const validationHitRate = reqCtx.metrics.validationCount > 0
    ? reqCtx.metrics.validationCacheHits / reqCtx.metrics.validationCount
    : 0;

  const totalCalls = reqCtx.metrics.gitCallCount + reqCtx.metrics.validationCount;
  const totalHits = reqCtx.metrics.gitCacheHits + reqCtx.metrics.validationCacheHits;
  const overallEfficiency = totalCalls > 0 ? totalHits / totalCalls : 0;

  return {
    gitCacheHitRate: gitHitRate,
    validationCacheHitRate: validationHitRate,
    overallEfficiency,
  };
}

/**
 * Record lock wait time.
 */
export function recordLockWait(reqCtx: RequestContext, waitMs: number): void {
  reqCtx.metrics.lockWaitMs += waitMs;
}

/**
 * Record SQLite write.
 */
export function recordSQLiteWrite(reqCtx: RequestContext): void {
  reqCtx.metrics.sqliteWriteCount++;
}
