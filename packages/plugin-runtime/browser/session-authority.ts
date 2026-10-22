export const DEFAULT_BROWSER_SESSION_LIST_LIMIT = 50;
export const MAX_BROWSER_SESSION_LIST_LIMIT = 200;

/** State-free Browser execution scope. Durable interaction identity belongs to Computer SurfaceTarget authority. */
export interface BrowserSessionExecutionContext {
  controllerHome: string;
  /** Optional repository visibility/migration context; never Browser session authority. */
  repoId?: string;
}

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
