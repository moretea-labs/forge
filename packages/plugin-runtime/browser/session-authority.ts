export const DEFAULT_BROWSER_SESSION_LIST_LIMIT = 50;
export const MAX_BROWSER_SESSION_LIST_LIMIT = 200;

/** State-free Browser execution scope. Durable interaction identity belongs to Computer SurfaceTarget authority. */
export interface BrowserSessionExecutionContext {
  controllerHome: string;
  repoId: string;
}

/** @deprecated Compatibility alias for frozen callers; this is context, not an authority capability. */
export type BrowserSessionAuthorityContext = BrowserSessionExecutionContext;

/** Compatibility shape for Browser-facing session metadata. It is persisted only inside a Computer SurfaceTarget record. */
export interface BrowserSessionAuthoritySession {
  schemaVersion: 1;
  sessionId: string;
  url: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  browser?: {
    provider?: string;
    browserProduct?: string;
    tab?: {
      windowId?: string;
      tabId?: string;
      ownership?: string;
    };
  };
}

export interface BrowserSessionAuthorityPage<T extends BrowserSessionAuthoritySession = BrowserSessionAuthoritySession> {
  sessions: T[];
  limit: number;
  totalCount: number;
  nextCursor?: string;
}

export interface BrowserSessionLegacyCutoverRepository {
  repoId: string;
  repoRoot: string;
}

export interface BrowserSessionLegacyCutoverReport {
  closed: boolean;
  alreadyClosed: boolean;
  repositoryCount: number;
  migratedRecordCount: number;
}

/** Compatibility-only report shape; Browser no longer owns tombstone retention. */
export interface BrowserSessionTombstoneCleanupReport {
  policyVersion: 'browser-session-tombstone-retention-v1';
  cutoverClosed: boolean;
  inspected: number;
  eligible: number;
  removed: number;
  retained: number;
  blockers: string[];
  budgetExhausted: boolean;
}
