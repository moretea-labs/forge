import {
  buildBrowserPluginManifest,
  executeBrowserPluginAction,
  resolveBrowserPluginAuthorizationContext,
} from './browser-adapter';
import type { AssistantPluginAdapter } from './types';

/** Browser manifests derive from config plus saved-session and active-handoff authority. */
const BROWSER_MANIFEST_MUTATING_ACTIONS = new Set([
  'configure',
  'reconcile_sessions',
  'close_session',
  'close_page',
  'clear_session',
  'request_human_handoff',
  'resolve_handoff',
  'create_session',
  'open_page',
]);

/** Thin first-party registration. Browser execution remains an adapter implementation detail. */
export const browserPluginAdapter: AssistantPluginAdapter = {
  pluginId: 'browser',
  scope: 'controller_with_repository_overlay',
  exposure: 'internal',
  buildManifest: buildBrowserPluginManifest,
  executeAction: executeBrowserPluginAction,
  resolveAuthorizationContext: resolveBrowserPluginAuthorizationContext,
  shouldRefreshManifestAfterAction(actionId) {
    return BROWSER_MANIFEST_MUTATING_ACTIONS.has(actionId);
  },
};
