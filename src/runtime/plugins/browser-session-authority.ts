/** @deprecated C0 compatibility shim. Session contracts live in plugin-runtime; persistence is bound by Runtime composition. */
import type {
  BrowserSessionAuthorityPage,
  BrowserSessionAuthoritySession,
} from '../../../packages/plugin-runtime/browser/session-authority';
import { runtimeBrowserSessionAuthority } from '../root/browser-session-composition';

export {
  DEFAULT_BROWSER_SESSION_LIST_LIMIT,
  MAX_BROWSER_SESSION_LIST_LIMIT,
  type BrowserSessionAuthorityContext,
  type BrowserSessionAuthorityPage,
  type BrowserSessionAuthorityPort,
  type BrowserSessionAuthoritySession,
  type BrowserSessionLegacyCutoverRepository,
  type BrowserSessionLegacyCutoverReport,
  type BrowserSessionTombstoneCleanupReport,
} from '../../../packages/plugin-runtime/browser/session-authority';
export {
  currentRuntimeBrowserSessionAuthorityContext as currentBrowserSessionAuthorityContext,
  withRuntimeBrowserSessionAuthorityContext as withBrowserSessionAuthorityContext,
} from '../root/browser-session-composition';

function context(controllerHome: string, repoId: string) {
  return { controllerHome, repoId };
}

export function ensureLegacyBrowserSessionsImported(controllerHome: string, repoId: string, repoRoot: string): number {
  return runtimeBrowserSessionAuthority().ensureLegacyImported(context(controllerHome, repoId), repoRoot);
}

export function saveBrowserSession<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  session: T,
): T {
  return runtimeBrowserSessionAuthority().save(context(controllerHome, repoId), repoRoot, session) as T;
}

export function findBrowserSession<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  sessionId: string,
): T | undefined {
  return runtimeBrowserSessionAuthority().find(context(controllerHome, repoId), repoRoot, sessionId) as T | undefined;
}

export function listBrowserSessions<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  options: { limit?: number; cursor?: string } = {},
): BrowserSessionAuthorityPage<T> {
  return runtimeBrowserSessionAuthority().list(context(controllerHome, repoId), repoRoot, options) as BrowserSessionAuthorityPage<T>;
}

export function listAllBrowserSessionsForRepository<T extends BrowserSessionAuthoritySession>(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
): T[] {
  return runtimeBrowserSessionAuthority().listAll(context(controllerHome, repoId), repoRoot) as T[];
}

export function tombstoneBrowserSession(controllerHome: string, repoId: string, repoRoot: string, sessionId: string): boolean {
  return runtimeBrowserSessionAuthority().tombstone(context(controllerHome, repoId), repoRoot, sessionId);
}

export function closeLegacyBrowserSessionImportCutover(
  controllerHome: string,
  repositories: readonly import('../../../packages/plugin-runtime/browser/session-authority').BrowserSessionLegacyCutoverRepository[],
) {
  return runtimeBrowserSessionAuthority().closeLegacyImportCutover(controllerHome, repositories);
}

export function cleanupBrowserSessionTombstones(
  controllerHome: string,
  options?: { nowMs?: number; ttlMs?: number; maxTombstones?: number; maxRemovals?: number },
) {
  return runtimeBrowserSessionAuthority().cleanupTombstones(controllerHome, options);
}
