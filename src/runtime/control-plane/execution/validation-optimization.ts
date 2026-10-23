import type { McpExecutionContext } from '../../../../packages/protocols/mcp/execution-context';
import type { ExecutionSessionContext } from './session-store';

/**
 * Git status cache to avoid repeated calls within a short time window.
 *
 * Benefits:
 * - Reduces Git process spawns from 4-10 to 1-2
 * - Safe to cache for 5 seconds (typical operation duration)
 * - Automatically invalidated after TTL
 */

interface CachedGitStatus {
  status: unknown;
  cachedAt: number;
}

const GIT_STATUS_CACHE_TTL_MS = 5000;
const gitStatusCache = new Map<string, CachedGitStatus>();

function cacheKey(repoId: string, checkoutId: string): string {
  return `${repoId}:${checkoutId}`;
}

/**
 * Runtime owns cache lifetime; the existing caller owns Git status reads.
 * Do not import the CLI Git implementation into Runtime.
 */
export function getCachedGitStatus<T>(
  repository: { repoId: string; activeCheckoutId: string },
  readStatus: () => T,
): T {
  const key = cacheKey(repository.repoId, repository.activeCheckoutId);
  const now = Date.now();
  const cached = gitStatusCache.get(key);
  if (cached && now - cached.cachedAt < GIT_STATUS_CACHE_TTL_MS) {
    return cached.status as T;
  }
  const status = readStatus();
  gitStatusCache.set(key, { status, cachedAt: now });
  if (gitStatusCache.size > 100) {
    const oldest = gitStatusCache.keys().next().value;
    if (oldest) gitStatusCache.delete(oldest);
  }
  return status;
}

/**
 * Invalidate Git status cache for a repository.
 * Call this after mutations that change Git state.
 */
export function invalidateGitStatusCache(repoId: string, checkoutId?: string): void {
  if (checkoutId) {
    gitStatusCache.delete(cacheKey(repoId, checkoutId));
  } else {
    // Invalidate all entries for this repo
    for (const key of gitStatusCache.keys()) {
      if (key.startsWith(`${repoId}:`)) {
        gitStatusCache.delete(key);
      }
    }
  }
}

/**
 * Clear entire Git status cache.
 * Useful for testing or when memory pressure is high.
 */
export function clearGitStatusCache(): void {
  gitStatusCache.clear();
}

/**
 * Validation mode for work preparation.
 */
export type ValidationMode = 'full' | 'fast' | 'minimal';

/**
 * Determine appropriate validation mode based on operation type.
 *
 * - 'minimal': Trust session state, only check critical fences
 * - 'fast': Basic checks, skip expensive operations
 * - 'full': Complete validation (default for new Work)
 */
export function selectValidationMode(
  args: Record<string, unknown>,
  session: ExecutionSessionContext,
): ValidationMode {
  // Reusing existing Work - trust existing validation
  if (args.work_id) return 'fast';

  // Reuse isolation - minimal checks needed
  const isolation = typeof args.isolation === 'string' ? args.isolation : 'auto';
  if (isolation === 'reuse') return 'fast';

  // New isolated Work - full validation
  return 'full';
}

/**
 * Check if expensive operations should be skipped.
 *
 * Expensive operations include:
 * - Multiple Git status checks
 * - Worktree enumeration
 * - Lease/process scanning
 * - Permission rechecks
 */
export function shouldSkipExpensiveChecks(mode: ValidationMode): boolean {
  return mode === 'minimal' || mode === 'fast';
}

/**
 * Delayed validation: validate only when actually needed.
 *
 * For reuse mode:
 * - Skip worktree checks (not creating worktree)
 * - Skip integration checkout validation (staying on current branch)
 * - Defer permission checks to actual mutation time
 */
export interface DelayedValidation {
  mode: ValidationMode;
  skipWorktreeChecks: boolean;
  skipIntegrationChecks: boolean;
  deferPermissionCheck: boolean;
}

export function createDelayedValidation(
  args: Record<string, unknown>,
  session: ExecutionSessionContext,
): DelayedValidation {
  const mode = selectValidationMode(args, session);
  const isolation = typeof args.isolation === 'string' ? args.isolation : 'auto';
  const useWorktree = isolation !== 'reuse';

  return {
    mode,
    skipWorktreeChecks: !useWorktree,
    skipIntegrationChecks: !useWorktree,
    deferPermissionCheck: mode === 'fast',
  };
}
