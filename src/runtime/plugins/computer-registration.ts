import { createHash } from 'crypto';
import type {
  ComputerApplicationTarget,
  ComputerApplicationStableIdentity,
  ComputerApplicationTargetLease,
} from '../../../packages/plugin-runtime/computer/target-authority';
import { runtimeComputerInteractionTargetAuthority } from '../root/computer-target-composition';
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
  AssistantPluginActionExecutionInput,
  AssistantPluginAdapter,
  AssistantPluginAuthorizationContext,
  AssistantPluginBuildContext,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';

const DESKTOP_PROVIDER_ID = 'desktop_operator';
const computerTargetAuthority = runtimeComputerInteractionTargetAuthority();
const DESKTOP_TARGET_OPEN_ACTION = 'desktop_target_open';
const DESKTOP_TARGET_CLOSE_ACTION = 'desktop_target_close';
const DESKTOP_SEMANTIC_ACTION_IDS = new Set([
  'desktop_observe',
  'desktop_press',
  'desktop_type_text',
  'desktop_key',
  'desktop_open_url',
  'desktop_screenshot',
]);
const DESKTOP_PRODUCT_ACTION_IDS = new Set([
  DESKTOP_TARGET_OPEN_ACTION,
  DESKTOP_TARGET_CLOSE_ACTION,
  ...DESKTOP_SEMANTIC_ACTION_IDS,
]);

function providerActionDescriptor(actionId: string): AssistantPluginActionDescriptor {
  const descriptor = desktopOperatorActions().find((action) => action.actionId === actionId);
  if (!descriptor) throw new Error(`COMPUTER_DESKTOP_ACTION_DESCRIPTOR_MISSING: ${actionId}`);
  return structuredClone(descriptor);
}

function targetBoundDescriptor(actionId: string): AssistantPluginActionDescriptor {
  const descriptor = providerActionDescriptor(actionId);
  const schema = structuredClone(descriptor.argumentsSchema) as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === 'object'
    ? { ...(schema.properties as Record<string, unknown>) }
    : {};
  if ('interaction_id' in properties) {
    delete properties.interaction_id;
    properties.target_id = { type: 'string', description: 'Forge-owned durable Computer target id.' };
    schema.properties = properties;
    if (Array.isArray(schema.required)) {
      schema.required = schema.required.map((value) => value === 'interaction_id' ? 'target_id' : value);
    }
  }
  return { ...descriptor, argumentsSchema: schema };
}

function desktopProductActions(): AssistantPluginActionDescriptor[] {
  const open = providerActionDescriptor('desktop_session_open');
  const close = providerActionDescriptor('desktop_session_close');
  return [
    {
      ...open,
      actionId: DESKTOP_TARGET_OPEN_ACTION,
      title: 'Open Computer desktop target',
      description: 'Bind one application as a Forge-owned durable Computer target. Native provider session ids remain internal rebuildable bindings.',
    },
    {
      ...close,
      actionId: DESKTOP_TARGET_CLOSE_ACTION,
      title: 'Close Computer desktop target',
      description: 'Retire one Forge-owned Computer target after its live provider binding is closed or confirmed absent.',
      argumentsSchema: {
        type: 'object',
        properties: { target_id: { type: 'string' } },
        required: ['target_id'],
        additionalProperties: false,
      },
    },
    ...[...DESKTOP_SEMANTIC_ACTION_IDS].map(targetBoundDescriptor),
  ];
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
    { capabilityId: 'computer.desktop_target.v1', title: 'Desktop targets', description: 'Bind and retire Forge-owned desktop application targets.', scopes: ['desktop.session'], actions: [DESKTOP_TARGET_OPEN_ACTION, DESKTOP_TARGET_CLOSE_ACTION] },
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
  const browser = buildBrowserPluginManifest(previousRevision, previousUpdatedAt, repoRoot, context);
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
        'controllerHome:sqlite/computer_interaction_target',
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

function optionalDesktopProvider(input: AssistantPluginActionExecutionInput): AssistantPluginAdapter | undefined {
  return getExternalPluginAdapter(input.controllerHome, DESKTOP_PROVIDER_ID);
}

function desktopProvider(input: AssistantPluginActionExecutionInput): AssistantPluginAdapter {
  const provider = optionalDesktopProvider(input);
  if (!provider) {
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_DESKTOP_PROVIDER_UNAVAILABLE',
      'Computer native Desktop capabilities require the registered platform provider.',
      { retryable: true, details: { providerId: DESKTOP_PROVIDER_ID, actionId: input.actionId } },
    );
  }
  return provider;
}

function firstString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function providerSessions(status: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(status.sessions)
    ? status.sessions.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    : [];
}

function stableIdentityFromArgs(args: Record<string, unknown>): ComputerApplicationStableIdentity {
  const bundleId = typeof args.bundle_id === 'string' ? args.bundle_id.trim() : '';
  const appName = typeof args.app_name === 'string' ? args.app_name.trim() : '';
  if (!bundleId && !appName) throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_IDENTITY_REQUIRED', 'Desktop target requires bundle_id or app_name.', { retryable: false });
  return { ...(bundleId ? { bundleId } : {}), ...(appName ? { appName } : {}) };
}

function targetMatchesProviderSession(target: ComputerApplicationTarget, session: Record<string, unknown>): boolean {
  const bundleId = firstString(session, 'bundleIdentifier', 'bundle_id');
  const appName = firstString(session, 'appName', 'app_name');
  if (target.stableIdentity.bundleId) return bundleId === target.stableIdentity.bundleId;
  return Boolean(target.stableIdentity.appName && appName === target.stableIdentity.appName);
}

function providerInput(
  input: AssistantPluginActionExecutionInput,
  actionId: string,
  args: Record<string, unknown>,
  suffix = actionId,
): AssistantPluginActionExecutionInput {
  return { ...input, pluginId: DESKTOP_PROVIDER_ID, actionId, args, requestId: `${input.requestId}:${suffix}` };
}

function providerSessionId(result: Record<string, unknown>): string {
  const interactionId = firstString(result, 'interactionId', 'interaction_id');
  if (!interactionId) throw new AssistantPluginError('PLUGIN_COMPUTER_PROVIDER_BINDING_MISSING', 'Native Computer provider did not return a live interaction binding.', { retryable: true });
  return interactionId;
}

async function ensureProviderBinding(
  input: AssistantPluginActionExecutionInput,
  lease: ComputerApplicationTargetLease,
  provider: AssistantPluginAdapter,
): Promise<string> {
  const target = lease.current();
  if (target.providerBinding?.providerId === DESKTOP_PROVIDER_ID) {
    const status = await provider.executeAction(providerInput(input, 'desktop_status', { limit: 500 }, 'binding-status'));
    const current = providerSessions(status).find((session) =>
      firstString(session, 'interactionId', 'interaction_id') === target.providerBinding?.providerSessionId
      && targetMatchesProviderSession(target, session));
    if (current) return target.providerBinding.providerSessionId;
  }

  const rebound = await provider.executeAction(providerInput(input, 'desktop_session_open', {
    ...(target.stableIdentity.bundleId ? { bundle_id: target.stableIdentity.bundleId } : { app_name: target.stableIdentity.appName }),
    launch: false,
    activate: false,
  }, 'binding-reopen'));
  const interactionId = providerSessionId(rebound);
  if (!targetMatchesProviderSession(target, rebound)) {
    try {
      await provider.executeAction(providerInput(input, 'desktop_session_close', { interaction_id: interactionId }, 'binding-reopen-identity-compensate'));
    } catch (cleanupError) {
      throw new AssistantPluginError(
        'PLUGIN_COMPUTER_TARGET_REBIND_IDENTITY_CLEANUP_UNKNOWN',
        'Computer target rebind returned an unverifiable application identity and provider-session cleanup could not be confirmed.',
        { retryable: false, details: { targetId: target.targetId, cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) } },
      );
    }
    throw new AssistantPluginError(
      'PLUGIN_COMPUTER_TARGET_REBIND_IDENTITY_MISMATCH',
      'Computer target rebind did not return the durable target application identity.',
      { retryable: false, details: { targetId: target.targetId, stableIdentity: target.stableIdentity } },
    );
  }
  lease.bind({
    providerId: DESKTOP_PROVIDER_ID,
    providerSessionId: interactionId,
    observedAt: new Date().toISOString(),
  });
  return interactionId;
}

function stableIdentityFromProviderResult(
  result: Record<string, unknown>,
  requested: ComputerApplicationStableIdentity,
): ComputerApplicationStableIdentity {
  const returnedBundleId = firstString(result, 'bundleIdentifier', 'bundle_id');
  const returnedAppName = firstString(result, 'appName', 'app_name');
  if (requested.bundleId && returnedBundleId !== requested.bundleId) {
    throw new AssistantPluginError(
      returnedBundleId ? 'PLUGIN_COMPUTER_TARGET_IDENTITY_MISMATCH' : 'PLUGIN_COMPUTER_TARGET_IDENTITY_UNVERIFIED',
      returnedBundleId
        ? 'Native Computer provider opened a different application bundle than the authorized target.'
        : 'Native Computer provider did not return the application bundle required to verify the authorized target.',
      { retryable: false, details: { requestedBundleId: requested.bundleId, returnedBundleId } },
    );
  }
  if (!requested.bundleId && requested.appName && returnedAppName !== requested.appName) {
    throw new AssistantPluginError(
      returnedAppName ? 'PLUGIN_COMPUTER_TARGET_IDENTITY_MISMATCH' : 'PLUGIN_COMPUTER_TARGET_IDENTITY_UNVERIFIED',
      returnedAppName
        ? 'Native Computer provider opened a different application name than the authorized target.'
        : 'Native Computer provider did not return the application name required to verify the authorized target.',
      { retryable: false, details: { requestedAppName: requested.appName, returnedAppName } },
    );
  }
  return {
    ...(returnedBundleId ? { bundleId: returnedBundleId } : requested.bundleId ? { bundleId: requested.bundleId } : {}),
    ...(returnedAppName ? { appName: returnedAppName } : requested.appName ? { appName: requested.appName } : {}),
  };
}

async function openDesktopTarget(
  input: AssistantPluginActionExecutionInput,
  provider: AssistantPluginAdapter,
): Promise<Record<string, unknown>> {
  const opened = await provider.executeAction(providerInput(input, 'desktop_session_open', input.args, 'target-open'));
  const interactionId = providerSessionId(opened);
  const requested = stableIdentityFromArgs(input.args);
  let stableIdentity: ComputerApplicationStableIdentity;
  try {
    stableIdentity = stableIdentityFromProviderResult(opened, requested);
  } catch (error) {
    try {
      await provider.executeAction(providerInput(input, 'desktop_session_close', { interaction_id: interactionId }, 'target-open-identity-compensate'));
    } catch (cleanupError) {
      throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_IDENTITY_MISMATCH_CLEANUP_UNKNOWN', 'Computer target identity drift was detected but provider-session cleanup could not be confirmed.', {
        retryable: false,
        details: { cause: error instanceof Error ? error.message : String(error), cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
      });
    }
    throw error;
  }
  try {
    const target = computerTargetAuthority.create(input.controllerHome, {
      stableIdentity,
      providerBinding: { providerId: DESKTOP_PROVIDER_ID, providerSessionId: interactionId, observedAt: new Date().toISOString() },
    });
    return {
      targetId: target.targetId,
      kind: target.kind,
      stableIdentity: target.stableIdentity,
      providerBound: true,
    };
  } catch (error) {
    try {
      await provider.executeAction(providerInput(input, 'desktop_session_close', { interaction_id: interactionId }, 'target-open-compensate'));
    } catch (cleanupError) {
      throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_PERSIST_FAILED', 'Computer target persistence failed and provider-session cleanup could not be confirmed.', {
        retryable: false,
        details: { cause: error instanceof Error ? error.message : String(error), cleanupCause: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
      });
    }
    throw error;
  }
}

async function closeDesktopTarget(
  input: AssistantPluginActionExecutionInput,
  provider: AssistantPluginAdapter | undefined,
): Promise<Record<string, unknown>> {
  const targetId = typeof input.args.target_id === 'string' ? input.args.target_id.trim() : '';
  if (!targetId) throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_REQUIRED', 'desktop_target_close requires target_id.', { retryable: false });
  return computerTargetAuthority.withLease(input.controllerHome, targetId, async (lease) => {
    const target = lease.current();
    if (target.providerBinding) {
      if (target.providerBinding.providerId !== DESKTOP_PROVIDER_ID) {
        throw new AssistantPluginError(
          'PLUGIN_COMPUTER_TARGET_PROVIDER_MISMATCH',
          'Computer target is bound to a different provider and cannot be retired through the current Desktop provider.',
          { retryable: false, details: { targetId, providerId: target.providerBinding.providerId, expectedProviderId: DESKTOP_PROVIDER_ID } },
        );
      }
      if (provider) {
        const status = await provider.executeAction(providerInput(input, 'desktop_status', { limit: 500 }, 'target-close-status'));
        const stillBound = providerSessions(status).some((session) =>
          firstString(session, 'interactionId', 'interaction_id') === target.providerBinding?.providerSessionId
          && targetMatchesProviderSession(target, session));
        if (stillBound) {
          await provider.executeAction(providerInput(input, 'desktop_session_close', { interaction_id: target.providerBinding.providerSessionId }, 'target-close-provider'));
        }
      }
      // A missing registration is authoritative absence only because provider uninstall
      // must stop/remove its native lifecycle before the registration is deleted.
    }
    const retired = lease.tombstone();
    return { targetId: retired.targetId, retired: true, stableIdentity: retired.stableIdentity };
  });
}

async function executeDesktopSemanticAction(
  input: AssistantPluginActionExecutionInput,
  provider: AssistantPluginAdapter,
): Promise<Record<string, unknown>> {
  if (input.actionId === 'desktop_open_url') {
    return provider.executeAction(providerInput(input, input.actionId, input.args));
  }
  const targetId = typeof input.args.target_id === 'string' ? input.args.target_id.trim() : '';
  if (!targetId) {
    if (input.actionId === 'desktop_screenshot') {
      return provider.executeAction(providerInput(input, input.actionId, input.args));
    }
    throw new AssistantPluginError('PLUGIN_COMPUTER_TARGET_REQUIRED', `${input.actionId} requires target_id.`, { retryable: false });
  }
  return computerTargetAuthority.withLease(input.controllerHome, targetId, async (lease) => {
    const interactionId = await ensureProviderBinding(input, lease, provider);
    const { target_id: _targetId, ...rest } = input.args;
    // Binding verification/rebuild completes before the semantic dispatch. Once this
    // provider call starts, failures are returned unchanged and are never replayed here.
    return provider.executeAction(providerInput(input, input.actionId, { ...rest, interaction_id: interactionId }));
  });
}

function targetAuthorization(identity: ComputerApplicationStableIdentity): AssistantPluginAuthorizationContext {
  const id = identity.bundleId ?? `app-name:${identity.appName}`;
  const identityFingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { target: { kind: 'desktop-application', id, identityFingerprint } };
}

async function resolveDesktopAuthorizationContext(input: AssistantPluginActionExecutionInput): Promise<AssistantPluginAuthorizationContext | undefined> {
  if (input.actionId === DESKTOP_TARGET_OPEN_ACTION) return targetAuthorization(stableIdentityFromArgs(input.args));
  const targetId = typeof input.args.target_id === 'string' ? input.args.target_id.trim() : '';
  if (targetId) return targetAuthorization(computerTargetAuthority.require(input.controllerHome, targetId).stableIdentity);
  const provider = desktopProvider(input);
  return provider.resolveAuthorizationContext?.(providerInput(input, input.actionId, input.args));
}

export const computerPluginAdapter: AssistantPluginAdapter = {
  pluginId: 'computer',
  scope: 'controller_with_repository_overlay',
  buildManifest: buildComputerManifest,
  async resolveAuthorizationContext(input) {
    if (!isDesktopProductAction(input.actionId)) {
      return resolveBrowserPluginAuthorizationContext({ ...input, pluginId: 'browser' });
    }
    return resolveDesktopAuthorizationContext(input);
  },
  async executeAction(input) {
    if (!isDesktopProductAction(input.actionId)) {
      return executeBrowserPluginAction({ ...input, pluginId: 'browser' });
    }
    if (input.actionId === DESKTOP_TARGET_CLOSE_ACTION) return closeDesktopTarget(input, optionalDesktopProvider(input));
    const provider = desktopProvider(input);
    if (input.actionId === DESKTOP_TARGET_OPEN_ACTION) return openDesktopTarget(input, provider);
    return executeDesktopSemanticAction(input, provider);
  },
  shouldRefreshManifestAfterAction(actionId) {
    return actionId === 'configure';
  },
};
