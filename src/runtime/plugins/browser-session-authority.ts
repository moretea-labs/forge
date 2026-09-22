/** @deprecated Compatibility facade. Durable Browser interaction identity belongs to Computer SurfaceTarget authority. */
import type {
  BrowserSessionAuthorityPage,
  BrowserSessionAuthoritySession,
  BrowserSessionLegacyCutoverRepository,
  BrowserSessionLegacyCutoverReport,
  BrowserSessionTombstoneCleanupReport,
} from '../../../packages/plugin-runtime/browser/session-authority';
import {
  DEFAULT_BROWSER_SESSION_LIST_LIMIT,
  MAX_BROWSER_SESSION_LIST_LIMIT,
} from '../../../packages/plugin-runtime/browser/session-authority';
import {
  currentRuntimeBrowserSessionExecutionContext,
  withRuntimeBrowserSessionExecutionContext,
} from '../root/browser-session-composition';
import {
  ensureBrowserSessionsMigratedToComputer,
  findBrowserSession as findComputerBackedBrowserSession,
  listSavedBrowserSessions,
  removeBrowserSession,
  saveBrowserSession as saveComputerBackedBrowserSession,
} from './browser-session-store';

export {
  DEFAULT_BROWSER_SESSION_LIST_LIMIT,
  MAX_BROWSER_SESSION_LIST_LIMIT,
  type BrowserSessionAuthorityContext,
  type BrowserSessionExecutionContext,
  type BrowserSessionAuthorityPage,
  type BrowserSessionAuthoritySession,
  type BrowserSessionLegacyCutoverRepository,
  type BrowserSessionLegacyCutoverReport,
  type BrowserSessionTombstoneCleanupReport,
} from '../../../packages/plugin-runtime/browser/session-authority';

export {
  currentRuntimeBrowserSessionExecutionContext as currentBrowserSessionAuthorityContext,
  withRuntimeBrowserSessionExecutionContext as withBrowserSessionAuthorityContext,
} from '../root/browser-session-composition';

function withContext<T>(controllerHome: string, repoId: string, operation: () => T): T {
  return withRuntimeBrowserSessionExecutionContext({ controllerHome, repoId }, operation);
}

export function ensureLegacyBrowserSessionsImported(controllerHome: string, repoId: string, repoRoot: string): number {
  return withContext(controllerHome, repoId, () => ensureBrowserSessionsMigratedToComputer(repoRoot));
}

export function saveBrowserSession<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  session: T,
): T {
  return withContext(controllerHome, repoId, () => saveComputerBackedBrowserSession(repoRoot, session as never) as unknown as T);
}

export function findBrowserSession<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  sessionId: string,
): T | undefined {
  return withContext(controllerHome, repoId, () => findComputerBackedBrowserSession(repoRoot, sessionId) as unknown as T | undefined);
}

export function listBrowserSessions<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  options: { limit?: number; cursor?: string } = {},
): BrowserSessionAuthorityPage<T> {
  return withContext(controllerHome, repoId, () => {
    const sessions = listSavedBrowserSessions(repoRoot) as unknown as T[];
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? DEFAULT_BROWSER_SESSION_LIST_LIMIT), MAX_BROWSER_SESSION_LIST_LIMIT));
    let offset = 0;
    if (options.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as { offset?: unknown };
        if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error('invalid offset');
        offset = Number(parsed.offset);
      } catch {
        throw new Error('PLUGIN_BROWSER_SESSION_CURSOR_INVALID: cursor is invalid or expired');
      }
    }
    const page = sessions.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      limit,
      totalCount: sessions.length,
      nextCursor: nextOffset < sessions.length
        ? Buffer.from(JSON.stringify({ offset: nextOffset }), 'utf8').toString('base64url')
        : undefined,
    };
  });
}

export function listAllBrowserSessionsForRepository<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
): T[] {
  return withContext(controllerHome, repoId, () => listSavedBrowserSessions(repoRoot) as unknown as T[]);
}

export function tombstoneBrowserSession(controllerHome: string, repoId: string, repoRoot: string, sessionId: string): boolean {
  return withContext(controllerHome, repoId, () => {
    const existing = findComputerBackedBrowserSession(repoRoot, sessionId);
    if (!existing) return false;
    removeBrowserSession(repoRoot, sessionId);
    return true;
  });
}

/** Browser-owned legacy cutover authority is retired; Computer migration markers own cutover state. */
export function closeLegacyBrowserSessionImportCutover(
  _controllerHome: string,
  repositories: readonly BrowserSessionLegacyCutoverRepository[],
): BrowserSessionLegacyCutoverReport {
  return { closed: true, alreadyClosed: true, repositoryCount: repositories.length, migratedRecordCount: 0 };
}

/** Browser-owned tombstone retention is retired; Computer target retention is authoritative. */
export function cleanupBrowserSessionTombstones(
  _controllerHome: string,
  _options?: { nowMs?: number; ttlMs?: number; maxTombstones?: number; maxRemovals?: number },
): BrowserSessionTombstoneCleanupReport {
  return {
    policyVersion: 'browser-session-tombstone-retention-v1',
    cutoverClosed: true,
    inspected: 0,
    eligible: 0,
    removed: 0,
    retained: 0,
    blockers: [],
    budgetExhausted: false,
  };
}

void currentRuntimeBrowserSessionExecutionContext;
