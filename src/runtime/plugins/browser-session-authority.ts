/** @deprecated C0 compatibility shim. Session contracts live in plugin-runtime; persistence lives in adapters/browser. */
export {
  DEFAULT_BROWSER_SESSION_LIST_LIMIT,
  MAX_BROWSER_SESSION_LIST_LIMIT,
  type BrowserSessionAuthorityContext,
  type BrowserSessionAuthorityPage,
  type BrowserSessionAuthorityPort,
  type BrowserSessionAuthoritySession,
} from '../../../packages/plugin-runtime/browser/session-authority';
export {
  ensureLegacyBrowserSessionsImported,
  findBrowserSession,
  listAllBrowserSessionsForRepository,
  listBrowserSessions,
  saveBrowserSession,
  tombstoneBrowserSession,
} from '../../../adapters/browser/sqlite-session-authority';
export {
  currentRuntimeBrowserSessionAuthorityContext as currentBrowserSessionAuthorityContext,
  withRuntimeBrowserSessionAuthorityContext as withBrowserSessionAuthorityContext,
} from '../root/browser-session-composition';
