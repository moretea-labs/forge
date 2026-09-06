import {
  buildBrowserPluginManifest,
  executeBrowserPluginAction,
  resolveBrowserPluginAuthorizationContext,
} from './browser-adapter';
import type { AssistantPluginAdapter } from './types';

/** Thin first-party registration. Browser execution remains an adapter implementation detail. */
export const browserPluginAdapter: AssistantPluginAdapter = {
  pluginId: 'browser',
  scope: 'controller_with_repository_overlay',
  exposure: 'internal',
  buildManifest: buildBrowserPluginManifest,
  executeAction: executeBrowserPluginAction,
  resolveAuthorizationContext: resolveBrowserPluginAuthorizationContext,
};
