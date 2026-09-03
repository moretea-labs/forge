import { appStoreConnectPluginAdapter } from './app-store-connect-adapter';
import { browserPluginAdapter } from './browser-registration';
import { computerPluginAdapter } from './computer-registration';
import { githubPluginAdapter } from './github-adapter';
import { gmailPluginAdapter } from './gmail-adapter';
import { googleCalendarPluginAdapter } from './google-calendar-adapter';
import { googleTasksPluginAdapter } from './google-tasks-adapter';
import { iosPluginAdapter } from './ios-adapter';
import { localSystemPluginAdapter } from './local-system-adapter';
import { pluginManagementAdapter } from './plugin-management-adapter';
import { resendPluginAdapter } from './resend-adapter';
import { xiaohongshuPluginAdapter } from './xiaohongshu-publish';
import type { AssistantPluginAdapter } from './types';

const FIRST_PARTY_PLUGIN_ADAPTERS: readonly AssistantPluginAdapter[] = [
  githubPluginAdapter,
  computerPluginAdapter,
  browserPluginAdapter,
  appStoreConnectPluginAdapter,
  iosPluginAdapter,
  gmailPluginAdapter,
  googleCalendarPluginAdapter,
  googleTasksPluginAdapter,
  resendPluginAdapter,
  xiaohongshuPluginAdapter,
  localSystemPluginAdapter,
  pluginManagementAdapter,
];

export function listFirstPartyPluginAdapters(): readonly AssistantPluginAdapter[] {
  return FIRST_PARTY_PLUGIN_ADAPTERS;
}

export function createFirstPartyPluginAdapterMap(): Map<string, AssistantPluginAdapter> {
  const entries = FIRST_PARTY_PLUGIN_ADAPTERS.map((adapter) => [adapter.pluginId, adapter] as const);
  const registry = new Map<string, AssistantPluginAdapter>(entries);
  if (registry.size !== entries.length) {
    throw new Error('PLUGIN_REGISTRY_DUPLICATE_ID: first-party plugin ids must be unique');
  }
  return registry;
}
