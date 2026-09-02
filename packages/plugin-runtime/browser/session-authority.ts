export const DEFAULT_BROWSER_SESSION_LIST_LIMIT = 50;
export const MAX_BROWSER_SESSION_LIST_LIMIT = 200;

export interface BrowserSessionAuthorityContext {
  controllerHome: string;
  repoId: string;
}

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

/** Durable Browser session persistence port. Runtime context binding is owned by composition. */
export interface BrowserSessionAuthorityPort {
  ensureLegacyImported(context: BrowserSessionAuthorityContext, repoRoot: string): number;
  save<T extends BrowserSessionAuthoritySession>(context: BrowserSessionAuthorityContext, repoRoot: string, session: T): T;
  find<T extends BrowserSessionAuthoritySession>(context: BrowserSessionAuthorityContext, repoRoot: string, sessionId: string): T | undefined;
  list<T extends BrowserSessionAuthoritySession>(context: BrowserSessionAuthorityContext, repoRoot: string, options?: { limit?: number; cursor?: string }): BrowserSessionAuthorityPage<T>;
  listAll<T extends BrowserSessionAuthoritySession>(context: BrowserSessionAuthorityContext, repoRoot: string): T[];
  tombstone(context: BrowserSessionAuthorityContext, repoRoot: string, sessionId: string): boolean;
}
