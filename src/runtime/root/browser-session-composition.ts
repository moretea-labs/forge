import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BrowserSessionAuthorityContext,
  BrowserSessionExecutionContext,
  BrowserSessionLegacyCutoverRepository,
  BrowserSessionLegacyCutoverReport,
  BrowserSessionTombstoneCleanupReport,
} from '../../../packages/plugin-runtime/browser/session-authority';

const browserSessionExecutionContext = new AsyncLocalStorage<BrowserSessionExecutionContext>();

export function withRuntimeBrowserSessionExecutionContext<T>(
  context: BrowserSessionExecutionContext,
  operation: () => T,
): T {
  return browserSessionExecutionContext.run(context, operation);
}

export function currentRuntimeBrowserSessionExecutionContext(): BrowserSessionExecutionContext | undefined {
  return browserSessionExecutionContext.getStore();
}

/** @deprecated Frozen-call compatibility alias. No Browser authority is constructed here. */
export function withRuntimeBrowserSessionAuthorityContext<T>(
  context: BrowserSessionAuthorityContext,
  operation: () => T,
): T {
  return withRuntimeBrowserSessionExecutionContext(context, operation);
}

/** @deprecated Frozen-call compatibility alias. This returns execution scope only. */
export function currentRuntimeBrowserSessionAuthorityContext(): BrowserSessionAuthorityContext | undefined {
  return currentRuntimeBrowserSessionExecutionContext();
}

/** @deprecated Browser no longer owns legacy-import cutover state; Computer per-repository migration markers are authoritative. */
export function closeRuntimeBrowserSessionLegacyImportCutover(
  _controllerHome: string,
  repositories: readonly BrowserSessionLegacyCutoverRepository[],
): BrowserSessionLegacyCutoverReport {
  return { closed: true, alreadyClosed: true, repositoryCount: repositories.length, migratedRecordCount: 0 };
}

/** @deprecated Browser no longer owns tombstone retention; scheduler separately invokes Computer target cleanup. */
export function cleanupRuntimeBrowserSessionTombstones(
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
