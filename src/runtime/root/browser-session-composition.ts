import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BrowserSessionAuthorityContext,
  BrowserSessionAuthorityPort,
  BrowserSessionLegacyCutoverRepository,
  BrowserSessionLegacyCutoverReport,
  BrowserSessionTombstoneCleanupReport,
} from '../../../packages/plugin-runtime/browser/session-authority';
import { createBrowserSessionAuthority } from '../../../adapters/browser/index';
import { createRuntimeBrowserSessionPersistence } from './browser-session-persistence';

const browserSessionAuthorityContext = new AsyncLocalStorage<BrowserSessionAuthorityContext>();
const browserSessionAuthority = createBrowserSessionAuthority(createRuntimeBrowserSessionPersistence());

export function withRuntimeBrowserSessionAuthorityContext<T>(
  context: BrowserSessionAuthorityContext,
  operation: () => T,
): T {
  return browserSessionAuthorityContext.run(context, operation);
}

export function currentRuntimeBrowserSessionAuthorityContext(): BrowserSessionAuthorityContext | undefined {
  return browserSessionAuthorityContext.getStore();
}

export function runtimeBrowserSessionAuthority(): BrowserSessionAuthorityPort {
  return browserSessionAuthority;
}

export function closeRuntimeBrowserSessionLegacyImportCutover(
  controllerHome: string,
  repositories: readonly BrowserSessionLegacyCutoverRepository[],
): BrowserSessionLegacyCutoverReport {
  return browserSessionAuthority.closeLegacyImportCutover(controllerHome, repositories);
}

export function cleanupRuntimeBrowserSessionTombstones(
  controllerHome: string,
  options?: { nowMs?: number; ttlMs?: number; maxTombstones?: number; maxRemovals?: number },
): BrowserSessionTombstoneCleanupReport {
  return browserSessionAuthority.cleanupTombstones(controllerHome, options);
}
