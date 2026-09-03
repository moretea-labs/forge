import {
  buildBrowserPluginManifest,
  executeBrowserPluginAction,
  resolveBrowserPluginAuthorizationContext,
} from './browser-adapter';
import { desktopOperatorActions } from './desktop-operator-registration';
import { getExternalPluginAdapter } from './external-adapter';
import { AssistantPluginError } from './errors';
import type {
  AssistantPluginActionDescriptor,
  AssistantPluginAdapter,
  AssistantPluginBuildContext,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';

const DESKTOP_PROVIDER_ID = 'desktop_operator';
const DESKTOP_PRODUCT_ACTION_IDS = new Set([
  'desktop_session_open',
  'desktop_session_close',
  'desktop_observe',
  'desktop_press',
  'desktop_type_text',
  'desktop_key',
  'desktop_open_url',
  'desktop_screenshot',
]);

function desktopProductActions(): AssistantPluginActionDescriptor[] {
  return desktopOperatorActions().filter((action) => DESKTOP_PRODUCT_ACTION_IDS.has(action.actionId));
}

function desktopProductPermissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    { scope: 'desktop.session', mode: 'write', description: 'Bind a desktop application target for Computer interaction.', granted: ready, required: false },
    { scope: 'desktop.observe', mode: 'read', description: 'Observe bounded desktop accessibility state.', granted: ready, required: false },
    { scope: 'desktop.interact', mode: 'write', description: 'Perform bounded semantic desktop interaction.', granted: ready, required: false },
    { scope: 'desktop.capture', mode: 'read', description: 'Capture an authorized desktop target.', granted: ready, required: false },
  ];
}

function desktopProductCapabilities(): AssistantPluginCapability[] {
  return [
    { capabilityId: 'computer.desktop_target.v1', title: 'Desktop targets', description: 'Bind and release desktop application targets through Computer.', scopes: ['desktop.session'], actions: ['desktop_session_open', 'desktop_session_close'] },
    { capabilityId: 'computer.observe.v1', title: 'Computer observation', description: 'Observe bounded desktop semantic state.', scopes: ['desktop.observe'], actions: ['desktop_observe'] },
    { capabilityId: 'computer.input.v1', title: 'Computer input', description: 'Perform bounded semantic desktop input.', scopes: ['desktop.interact'], actions: ['desktop_press', 'desktop_type_text', 'desktop_key', 'desktop_open_url'] },
    { capabilityId: 'computer.capture.v1', title: 'Computer capture', description: 'Capture authorized desktop state.', scopes: ['desktop.capture'], actions: ['desktop_screenshot'] },
  ];
}

function desktopProviderManifest(context: AssistantPluginBuildContext | undefined): AssistantPluginManifest | undefined {
  if (!context) return undefined;
  const adapter = getExternalPluginAdapter(context.controllerHome, DESKTOP_PROVIDER_ID);
  return adapter?.buildManifest(0, undefined, context.repoRoot, context);
}

function buildComputerManifest(
  previousRevision = 0,
  previousUpdatedAt?: string,
  repoRoot?: string,
  context?: AssistantPluginBuildContext,
): AssistantPluginManifest {
  const browser = buildBrowserPluginManifest(previousRevision, previousUpdatedAt, repoRoot);
  const desktop = desktopProviderManifest(context);
  const desktopSupported = process.platform === 'darwin';
  const browserReady = browser.enabled && browser.health.ready;
  const desktopReady = desktopSupported && desktop?.enabled === true && desktop.health.ready;
  const ready = browserReady && desktopReady;
  const partial = browserReady || desktopReady;
  const checkedAt = new Date().toISOString();
  return {
    ...browser,
    pluginId: 'computer',
    provider: 'forge-computer',
    displayName: 'Forge Computer',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: [
        ...browser.authority.sourceOfTruth,
        'controllerHome:system/plugins/external/registrations/desktop_operator.json',
      ],
    },
    enabled: browser.enabled || desktop?.enabled === true,
    lifecycle: {
      state: ready ? 'enabled' : partial ? 'degraded' : 'error',
      reason: ready
        ? 'Computer Browser and native Desktop semantic capabilities are ready.'
        : desktopSupported
          ? 'Computer is only partially ready; inspect Browser and native Desktop capability health.'
          : `Computer has partial Browser-only support on ${process.platform}; native Desktop capabilities are unsupported on this platform.`,
    },
    health: {
      state: ready ? 'ready' : partial ? 'degraded' : 'error',
      checkedAt,
      ready,
      probed: browser.health.probed || desktop?.health.probed === true,
      errors: ready ? [] : [...browser.health.errors, ...(desktopSupported ? (desktop?.health.errors ?? (desktop ? [] : ['Native Computer provider is not installed.'])) : [])],
      warnings: [
        ...browser.health.warnings,
        ...(desktopSupported ? (desktop?.health.warnings ?? []) : [`Native Desktop Computer capabilities are unsupported on ${process.platform}.`]),
      ],
      details: {
        partial: !ready && partial,
        browser: { ready: browserReady, state: browser.health.state },
        desktop: { supported: desktopSupported, ready: desktopReady, state: desktop?.health.state ?? (desktopSupported ? 'not_installed' : 'unsupported'), provider: DESKTOP_PROVIDER_ID },
      },
    },
    permissions: [...browser.permissions, ...desktopProductPermissions(desktopReady)],
    capabilities: [...browser.capabilities, ...desktopProductCapabilities()],
    actions: [...browser.actions, ...desktopProductActions()],
    updatedAt: previousUpdatedAt ?? checkedAt,
  };
}

function isDesktopProductAction(actionId: string): boolean {
  return DESKTOP_PRODUCT_ACTION_IDS.has(actionId);
}

export const computerPluginAdapter: AssistantPluginAdapter = {
  pluginId: 'computer',
  scope: 'controller_with_repository_overlay',
  buildManifest: buildComputerManifest,
  async resolveAuthorizationContext(input) {
    if (!isDesktopProductAction(input.actionId)) {
      return resolveBrowserPluginAuthorizationContext({ ...input, pluginId: 'browser' });
    }
    const provider = getExternalPluginAdapter(input.controllerHome, DESKTOP_PROVIDER_ID);
    if (!provider?.resolveAuthorizationContext) return undefined;
    return provider.resolveAuthorizationContext({ ...input, pluginId: DESKTOP_PROVIDER_ID });
  },
  async executeAction(input) {
    if (!isDesktopProductAction(input.actionId)) {
      return executeBrowserPluginAction({ ...input, pluginId: 'browser' });
    }
    const provider = getExternalPluginAdapter(input.controllerHome, DESKTOP_PROVIDER_ID);
    if (!provider) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_DESKTOP_PROVIDER_UNAVAILABLE',
        'Computer native Desktop capabilities require the registered platform provider.',
        { retryable: true, details: { providerId: DESKTOP_PROVIDER_ID, actionId: input.actionId } },
      );
    }
    return provider.executeAction({ ...input, pluginId: DESKTOP_PROVIDER_ID });
  },
  shouldRefreshManifestAfterAction(actionId) {
    return actionId === 'configure';
  },
};
