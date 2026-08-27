import { createHash } from 'crypto';
import { AssistantPluginError } from './errors';
import { getExternalPluginRegistration, listExternalPluginRegistrations, type ExternalPluginRegistration } from './external-registration';
import { callExternalUnixSocket, probeExternalUnixSocketSync, type ExternalUnixSocketCallOptions } from './external-unix-socket';
import { executeManagedPluginProcess, executeManagedPluginProcessSync, type ManagedPluginProcessSpec } from './managed-process-adapter';
import { restartVerifiedUserLaunchAgent, startVerifiedUserLaunchAgent, stopVerifiedUserLaunchAgent } from './local-system-adapter';
import type { AssistantPluginActionDescriptor, AssistantPluginAdapter, AssistantPluginAuthorizationContext, AssistantPluginCapability, AssistantPluginHealth, AssistantPluginManifest, AssistantPluginPermissionScope } from './types';

interface ProviderManifest {
  id: string;
  name: string;
  version: string;
  protocolVersion: string;
  mode: string;
  scope: string;
  provider: string;
  capabilities: string[];
  actions: string[];
}

interface ProviderHealth {
  state: string;
  warnings?: string[];
  [key: string]: unknown;
}

export interface ExternalPluginAdapterDependencies {
  probe?: (options: ExternalUnixSocketCallOptions) => Record<string, unknown>;
  call?: (options: ExternalUnixSocketCallOptions) => Promise<Record<string, unknown>>;
  managedProbe?: typeof executeManagedPluginProcessSync;
  managedCall?: typeof executeManagedPluginProcess;
  startVerifiedUserLaunchAgent?: (label: unknown, expectedProgram: unknown) => Record<string, unknown>;
  stopVerifiedUserLaunchAgent?: (label: unknown, expectedProgram: unknown) => Record<string, unknown>;
  restartVerifiedUserLaunchAgent?: (label: unknown, expectedProgram: unknown) => Record<string, unknown>;
  now?: () => Date;
}

function providerError(code: string, message: string, retryable = false): AssistantPluginError {
  return new AssistantPluginError(code, message, { retryable });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseProviderManifest(value: Record<string, unknown>, registration: ExternalPluginRegistration): ProviderManifest {
  const manifest: ProviderManifest = {
    id: typeof value.id === 'string' ? value.id : '',
    name: typeof value.name === 'string' ? value.name : '',
    version: typeof value.version === 'string' ? value.version : '',
    protocolVersion: typeof value.protocolVersion === 'string' ? value.protocolVersion : '',
    mode: typeof value.mode === 'string' ? value.mode : '',
    scope: typeof value.scope === 'string' ? value.scope : '',
    provider: typeof value.provider === 'string' ? value.provider : '',
    capabilities: stringArray(value.capabilities),
    actions: stringArray(value.actions),
  };
  if (manifest.id !== registration.providerPluginId) throw providerError('EXTERNAL_PLUGIN_IDENTITY_MISMATCH', `Expected provider plugin ${registration.providerPluginId}, received ${manifest.id || 'unknown'}.`);
  if (manifest.version !== registration.pluginVersion) throw providerError('EXTERNAL_PLUGIN_VERSION_MISMATCH', `Expected provider version ${registration.pluginVersion}, received ${manifest.version || 'unknown'}.`);
  if (manifest.protocolVersion !== registration.protocolVersion) throw providerError('EXTERNAL_PLUGIN_PROTOCOL_MISMATCH', `Expected provider protocol ${registration.protocolVersion}, received ${manifest.protocolVersion || 'unknown'}.`);
  if (manifest.scope !== registration.scope) throw providerError('EXTERNAL_PLUGIN_SCOPE_MISMATCH', `Expected provider scope ${registration.scope}, received ${manifest.scope || 'unknown'}.`);
  if (manifest.provider !== registration.provider) throw providerError('EXTERNAL_PLUGIN_PROVIDER_MISMATCH', `Expected provider ${registration.provider}, received ${manifest.provider || 'unknown'}.`);
  const missingActions = registration.actions
    .map((action) => action.actionId)
    .filter((actionId) => !(registration.pluginId === 'desktop_operator' && ['desktop_pointer_click', 'desktop_foreground_pointer_click'].includes(actionId)))
    .filter((actionId) => !manifest.actions.includes(actionId));
  if (missingActions.length > 0) throw providerError('EXTERNAL_PLUGIN_ACTION_MISMATCH', `Provider is missing registered actions: ${missingActions.join(', ')}.`);
  return manifest;
}

function healthFromProvider(value: Record<string, unknown>, checkedAt: string): AssistantPluginHealth {
  const health = value as ProviderHealth;
  const providerState = typeof health.state === 'string' ? health.state : 'degraded';
  const state = providerState === 'ready' ? 'ready' : providerState === 'error' ? 'error' : 'degraded';
  const details = Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['warnings'].includes(key))
    .slice(0, 30));
  return {
    state,
    checkedAt,
    ready: state === 'ready',
    probed: true,
    errors: state === 'error' ? ['External provider reported an error health state.'] : [],
    warnings: stringArray(health.warnings).slice(0, 20),
    details,
  };
}

function failedHealth(error: unknown, checkedAt: string): AssistantPluginHealth {
  const message = error instanceof Error ? error.message : String(error);
  return {
    state: 'degraded',
    checkedAt,
    ready: false,
    probed: true,
    errors: [message.slice(0, 1_000)],
    warnings: [],
  };
}

const EXTERNAL_PROVIDER_LIFECYCLE_ACTIONS = new Set(['provider_start', 'provider_stop', 'provider_restart']);

function lifecyclePolicy(registration: ExternalPluginRegistration): {
  permissions: AssistantPluginPermissionScope[];
  capabilities: AssistantPluginCapability[];
  actions: AssistantPluginActionDescriptor[];
} {
  if (!registration.lifecycle) return { permissions: [], capabilities: [], actions: [] };
  const scope = 'external-provider.lifecycle';
  const actions: AssistantPluginActionDescriptor[] = [
    { actionId: 'provider_start', title: 'Start external provider', description: 'Start the registration-bound verified macOS user LaunchAgent for this external provider.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true, scopes: [scope], resourceClaims: [{ resource: 'repo-state', mode: 'write' }], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'provider_stop', title: 'Stop external provider', description: 'Stop the registration-bound verified macOS user LaunchAgent for this external provider.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: true, scopes: [scope], resourceClaims: [{ resource: 'repo-state', mode: 'write' }], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { actionId: 'provider_restart', title: 'Restart external provider', description: 'Restart the registration-bound verified macOS user LaunchAgent for this external provider.', readOnly: false, risk: 'workspace_write', confirmation: 'authorization', defaultTimeoutMs: 30_000, cancellable: true, idempotent: false, scopes: [scope], resourceClaims: [{ resource: 'repo-state', mode: 'write' }], argumentsSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ];
  return {
    permissions: [{ scope, mode: 'write', description: 'Control only the verified user LaunchAgent bound to this external provider registration.', granted: true, required: false }],
    capabilities: [{ capabilityId: 'external-provider-lifecycle', title: 'External provider lifecycle', description: 'Start, stop, or restart only the verified macOS user LaunchAgent identity stored in this registration.', scopes: [scope], actions: actions.map((action) => action.actionId) }],
    actions,
  };
}

function socketCallOptions(registration: ExternalPluginRegistration, input: Omit<ExternalUnixSocketCallOptions, 'socketPath' | 'maxRequestBytes' | 'maxResponseBytes'>): ExternalUnixSocketCallOptions {
  if (registration.transport.kind !== 'unix_socket_jsonl') throw providerError('EXTERNAL_PLUGIN_TRANSPORT_MISMATCH', 'Expected Unix socket transport.', false);
  return {
    ...input,
    socketPath: registration.transport.socketPath,
    maxRequestBytes: registration.transport.maxRequestBytes,
    maxResponseBytes: registration.transport.maxResponseBytes,
  };
}

function managedSpec(registration: ExternalPluginRegistration): ManagedPluginProcessSpec {
  if (registration.transport.kind !== 'managed_cli_json') throw providerError('EXTERNAL_PLUGIN_TRANSPORT_MISMATCH', 'Expected managed CLI transport.', false);
  return {
    pluginId: registration.providerPluginId,
    runtimeExecutable: registration.transport.runtimeExecutable,
    runtimeArgs: registration.transport.runtimeArgs,
    helperPath: registration.transport.helperPath,
    cwd: registration.transport.cwd,
    requiredCapabilities: registration.transport.requiredCapabilities,
    timeoutMs: registration.transport.actionTimeoutMs,
    maxRequestBytes: registration.transport.maxRequestBytes,
    maxResponseBytes: registration.transport.maxResponseBytes,
  };
}

function probeProvider(
  registration: ExternalPluginRegistration,
  requestId: string,
  method: 'manifest' | 'health',
  dependencies: ExternalPluginAdapterDependencies,
): Record<string, unknown> {
  if (registration.transport.kind === 'unix_socket_jsonl') {
    return (dependencies.probe ?? probeExternalUnixSocketSync)(socketCallOptions(registration, {
      requestId,
      method,
      timeoutMs: registration.transport.healthTimeoutMs,
    }));
  }
  return (dependencies.managedProbe ?? executeManagedPluginProcessSync)(managedSpec(registration), {
    requestId,
    actionId: method,
    input: {},
    timeoutMs: registration.transport.healthTimeoutMs,
  });
}

async function callProvider(
  registration: ExternalPluginRegistration,
  requestId: string,
  actionId: string,
  args: Record<string, unknown>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  dependencies: ExternalPluginAdapterDependencies,
): Promise<Record<string, unknown>> {
  if (registration.transport.kind === 'unix_socket_jsonl') {
    const isProviderMethod = actionId === 'manifest' || actionId === 'health';
    return await (dependencies.call ?? callExternalUnixSocket)(socketCallOptions(registration, {
      requestId,
      method: isProviderMethod ? actionId : 'execute',
      params: isProviderMethod ? undefined : { action: actionId, arguments: args },
      timeoutMs: timeoutMs ?? (isProviderMethod ? registration.transport.healthTimeoutMs : registration.transport.actionTimeoutMs),
      signal,
    }));
  }
  return await (dependencies.managedCall ?? executeManagedPluginProcess)(managedSpec(registration), {
    requestId,
    actionId,
    input: args,
    timeoutMs: timeoutMs ?? (actionId === 'manifest' || actionId === 'health' ? registration.transport.healthTimeoutMs : registration.transport.actionTimeoutMs),
    signal,
  });
}

function externalProviderAuthorizationContext(registration: ExternalPluginRegistration): AssistantPluginAuthorizationContext {
  return {
    target: {
      kind: 'external-provider',
      id: registration.pluginId,
      identityFingerprint: registration.registrationFingerprint,
    },
    expiresInMinutes: 30 * 24 * 60,
  };
}

function desktopApplicationAuthorizationContext(
  registration: ExternalPluginRegistration,
  stableApplicationId: string,
): AssistantPluginAuthorizationContext {
  const normalized = stableApplicationId.trim();
  return {
    target: {
      kind: 'desktop-application',
      id: normalized,
      identityFingerprint: createHash('sha256')
        .update(`${registration.registrationFingerprint}\0${normalized}`)
        .digest('hex'),
    },
    expiresInMinutes: 30 * 24 * 60,
  };
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function desktopSession(status: Record<string, unknown>, interactionId: string): Record<string, unknown> | undefined {
  return recordArray(status.sessions).find((session) => firstString(session, 'interactionId', 'interaction_id') === interactionId);
}

function desktopApplicationIsActive(status: Record<string, unknown>, bundleId: string, appName: string): boolean {
  return recordArray(status.applications).some((application) => {
    if (application.active !== true || application.terminated === true) return false;
    const candidateBundleId = firstString(application, 'bundle_id', 'bundleIdentifier');
    const candidateName = firstString(application, 'name', 'appName');
    return bundleId ? candidateBundleId === bundleId : Boolean(appName) && candidateName === appName;
  });
}

async function resolveExternalAuthorizationContext(
  registration: ExternalPluginRegistration,
  input: Parameters<NonNullable<AssistantPluginAdapter['resolveAuthorizationContext']>>[0],
  dependencies: ExternalPluginAdapterDependencies,
): Promise<AssistantPluginAuthorizationContext | undefined> {
  if (EXTERNAL_PROVIDER_LIFECYCLE_ACTIONS.has(input.actionId)) {
    return externalProviderAuthorizationContext(registration);
  }
  if (registration.pluginId !== 'desktop_operator') return undefined;
  if (input.actionId === 'desktop_permissions_request') {
    return externalProviderAuthorizationContext(registration);
  }
  if (input.actionId === 'desktop_session_open') {
    const bundleId = typeof input.args.bundle_id === 'string' ? input.args.bundle_id.trim() : '';
    return bundleId ? desktopApplicationAuthorizationContext(registration, bundleId) : undefined;
  }

  const interactionId = typeof input.args.interaction_id === 'string' ? input.args.interaction_id.trim() : '';
  if (!interactionId) return undefined;

  const providerManifest = await callProvider(
    registration,
    `${input.requestId}:authorization-target:manifest`,
    'manifest',
    {},
    undefined,
    input.signal,
    dependencies,
  );
  parseProviderManifest(providerManifest, registration);
  const status = await callProvider(
    registration,
    `${input.requestId}:authorization-target:desktop-status`,
    'desktop_status',
    { limit: 500 },
    input.timeoutMs,
    input.signal,
    dependencies,
  );
  const sessions = Array.isArray(status.sessions) ? status.sessions : [];
  const session = sessions.find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    const id = typeof record.interactionId === 'string' ? record.interactionId : typeof record.interaction_id === 'string' ? record.interaction_id : '';
    return id === interactionId;
  }) as Record<string, unknown> | undefined;
  if (!session) {
    throw providerError('EXTERNAL_PLUGIN_AUTHORIZATION_TARGET_UNAVAILABLE', `Desktop session ${interactionId} was not found while resolving its stable authorization target.`, false);
  }
  const bundleId = typeof session.bundleIdentifier === 'string' ? session.bundleIdentifier.trim()
    : typeof session.bundle_identifier === 'string' ? session.bundle_identifier.trim()
      : '';
  const appName = typeof session.appName === 'string' ? session.appName.trim()
    : typeof session.app_name === 'string' ? session.app_name.trim()
      : '';
  const stableApplicationId = bundleId || (appName ? `name:${appName.toLowerCase()}` : '');
  if (!stableApplicationId) {
    throw providerError('EXTERNAL_PLUGIN_AUTHORIZATION_TARGET_UNAVAILABLE', `Desktop session ${interactionId} has no stable application identity.`, false);
  }
  return desktopApplicationAuthorizationContext(registration, stableApplicationId);
}

export function getExternalPluginAdapter(controllerHome: string, pluginId: string): AssistantPluginAdapter | undefined {
  const registration = getExternalPluginRegistration(controllerHome, pluginId);
  return registration ? createExternalPluginAdapter(registration) : undefined;
}

export function listExternalPluginAdapters(controllerHome: string): AssistantPluginAdapter[] {
  return listExternalPluginRegistrations(controllerHome).map((registration) => createExternalPluginAdapter(registration));
}

export function createExternalPluginAdapter(
  registration: ExternalPluginRegistration,
  dependencies: ExternalPluginAdapterDependencies = {},
): AssistantPluginAdapter {
  const startProvider = dependencies.startVerifiedUserLaunchAgent ?? startVerifiedUserLaunchAgent;
  const stopProvider = dependencies.stopVerifiedUserLaunchAgent ?? stopVerifiedUserLaunchAgent;
  const restartProvider = dependencies.restartVerifiedUserLaunchAgent ?? restartVerifiedUserLaunchAgent;
  const now = dependencies.now ?? (() => new Date());
  const lifecycle = lifecyclePolicy(registration);

  return {
    pluginId: registration.pluginId,
    scope: registration.scope,
    resolveAuthorizationContext: (input) => resolveExternalAuthorizationContext(registration, input, dependencies),
    buildManifest(previousRevision = 0, previousUpdatedAt?: string): AssistantPluginManifest {
      const checkedAt = now().toISOString();
      if (!registration.enabled) {
        return {
          schemaVersion: 1,
          manifestVersion: 1,
          revision: Math.max(previousRevision, 1),
          pluginId: registration.pluginId,
          provider: registration.provider,
          displayName: registration.displayName,
          pluginVersion: registration.pluginVersion,
          authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: [`controllerHome:system/plugins/external/registrations/${registration.pluginId}.json`] },
          enabled: false,
          lifecycle: { state: 'disabled', reason: 'External provider registration is disabled.' },
          health: { state: 'disabled', checkedAt, ready: false, probed: false, errors: [], warnings: [] },
          permissions: structuredClone([...registration.permissions, ...lifecycle.permissions]),
          capabilities: structuredClone([...registration.capabilities, ...lifecycle.capabilities]),
          actions: structuredClone([...registration.actions, ...lifecycle.actions]),
          updatedAt: previousUpdatedAt ?? checkedAt,
        };
      }

      let providerManifest: ProviderManifest | undefined;
      let health: AssistantPluginHealth;
      try {
        providerManifest = parseProviderManifest(probeProvider(
          registration,
          `forge-manifest-${registration.pluginId}-${registration.revision}`,
          'manifest',
          dependencies,
        ), registration);
        health = healthFromProvider(probeProvider(
          registration,
          `forge-health-${registration.pluginId}-${registration.revision}`,
          'health',
          dependencies,
        ), checkedAt);
      } catch (error) {
        health = failedHealth(error, checkedAt);
      }
      const lifecycleState = health.ready ? 'enabled' : health.state === 'error' ? 'error' : 'degraded';
      return {
        schemaVersion: 1,
        manifestVersion: 1,
        revision: Math.max(previousRevision, 1),
        pluginId: registration.pluginId,
        provider: registration.provider,
        displayName: registration.displayName,
        pluginVersion: registration.pluginVersion,
        authority: {
          strategy: 'derived',
          duplicateStateAllowed: false,
          sourceOfTruth: [
            `controllerHome:system/plugins/external/registrations/${registration.pluginId}.json`,
            `external-provider:${registration.providerPluginId}@${registration.pluginVersion}`,
          ],
        },
        enabled: true,
        lifecycle: {
          state: lifecycleState,
          reason: health.ready
            ? 'External provider identity and health are ready.'
            : providerManifest
              ? 'External provider identity is valid but health is not ready.'
              : 'External provider identity/transport could not be verified.',
        },
        health,
        permissions: structuredClone([...registration.permissions, ...lifecycle.permissions]),
        capabilities: structuredClone([...registration.capabilities, ...lifecycle.capabilities]),
        actions: structuredClone([...registration.actions, ...lifecycle.actions]),
        updatedAt: previousUpdatedAt ?? checkedAt,
      };
    },
    async executeAction(input) {
      if (!registration.enabled) throw providerError('EXTERNAL_PLUGIN_DISABLED', `External provider ${registration.pluginId} is disabled.`);
      if (EXTERNAL_PROVIDER_LIFECYCLE_ACTIONS.has(input.actionId)) {
        const bound = registration.lifecycle;
        if (!bound) throw providerError('EXTERNAL_PLUGIN_LIFECYCLE_NOT_CONFIGURED', `External provider ${registration.pluginId} has no verified lifecycle binding.`);
        if (input.actionId === 'provider_start') return startProvider(bound.label, bound.expectedProgramContains);
        if (input.actionId === 'provider_stop') return stopProvider(bound.label, bound.expectedProgramContains);
        return restartProvider(bound.label, bound.expectedProgramContains);
      }
      if (input.providerIdentityPrevalidated !== true) {
        const providerManifest = await callProvider(
          registration,
          `${input.requestId}:manifest`,
          'manifest',
          {},
          undefined,
          input.signal,
          dependencies,
        );
        parseProviderManifest(providerManifest, registration);
      }
      if (registration.pluginId === 'desktop_operator' && input.actionId === 'desktop_foreground_pointer_click') {
        const sourceInteractionId = typeof input.args.interaction_id === 'string' ? input.args.interaction_id.trim() : '';
        const requestedWindowId = typeof input.args.window_id === 'number' && Number.isInteger(input.args.window_id) ? input.args.window_id : undefined;
        const x = typeof input.args.x === 'number' && Number.isFinite(input.args.x) ? input.args.x : undefined;
        const y = typeof input.args.y === 'number' && Number.isFinite(input.args.y) ? input.args.y : undefined;
        if (!sourceInteractionId || !requestedWindowId || x === undefined || y === undefined) {
          throw providerError('DESKTOP_FOREGROUND_POINTER_ARGUMENT_INVALID', 'desktop_foreground_pointer_click requires interaction_id, window_id, x, and y.');
        }

        const sourceStatus = await callProvider(
          registration,
          `${input.requestId}:source-status`,
          'desktop_status',
          { limit: 500 },
          input.timeoutMs,
          input.signal,
          dependencies,
        );
        const sourceSession = desktopSession(sourceStatus, sourceInteractionId);
        if (!sourceSession) {
          throw providerError('DESKTOP_FOREGROUND_POINTER_SESSION_NOT_FOUND', `Desktop session ${sourceInteractionId} is no longer available.`, true);
        }
        const bundleId = firstString(sourceSession, 'bundleIdentifier', 'bundle_id');
        const appName = firstString(sourceSession, 'appName', 'app_name');
        if (!bundleId && !appName) {
          throw providerError('DESKTOP_FOREGROUND_POINTER_TARGET_UNAVAILABLE', `Desktop session ${sourceInteractionId} has no stable application identity.`);
        }

        const activation = await callProvider(
          registration,
          `${input.requestId}:activate`,
          'desktop_session_open',
          { ...(bundleId ? { bundle_id: bundleId } : { app_name: appName }), launch: false, activate: true },
          input.timeoutMs,
          input.signal,
          dependencies,
        );
        const activationInteractionId = firstString(activation, 'interactionId', 'interaction_id');
        if (!activationInteractionId) {
          throw providerError('DESKTOP_ACTIVATION_SESSION_MISSING', 'Desktop Operator activated the application without returning a bound interaction session.', true);
        }
        const activeStatus = await callProvider(
          registration,
          `${input.requestId}:active-status`,
          'desktop_status',
          { limit: 500 },
          input.timeoutMs,
          input.signal,
          dependencies,
        );
        if (!desktopApplicationIsActive(activeStatus, bundleId, appName)) {
          throw providerError('DESKTOP_ACTIVATION_NOT_CONFIRMED', `Desktop Operator did not confirm ${bundleId || appName} as the frontmost application after activation.`, true);
        }

        const screenshot = await callProvider(
          registration,
          `${input.requestId}:screenshot`,
          'desktop_screenshot',
          {
            interaction_id: activationInteractionId,
            scope: 'window',
            window_id: requestedWindowId,
            ...(typeof input.args.label === 'string' && input.args.label.trim() ? { label: input.args.label.trim() } : {}),
          },
          input.timeoutMs,
          input.signal,
          dependencies,
        );
        const visualRevision = firstNumber(screenshot, 'visual_revision', 'visualRevision');
        const capturedWindowId = firstNumber(screenshot, 'windowId', 'window_id') ?? requestedWindowId;
        if (!visualRevision || !capturedWindowId) {
          throw providerError('DESKTOP_FOREGROUND_CAPTURE_INVALID', 'Desktop Operator did not return a fresh visual revision for the foreground window.', true);
        }

        const click = await callProvider(
          registration,
          `${input.requestId}:click`,
          'desktop_pointer_click',
          {
            interaction_id: activationInteractionId,
            window_id: capturedWindowId,
            visual_revision: visualRevision,
            x,
            y,
          },
          input.timeoutMs,
          input.signal,
          dependencies,
        );
        return {
          interactionId: activationInteractionId,
          activationVerified: true,
          windowId: capturedWindowId,
          visualRevision,
          screenshot,
          click,
        };
      }

      const result = await callProvider(
        registration,
        input.requestId,
        input.actionId,
        input.args,
        input.timeoutMs,
        input.signal,
        dependencies,
      );
      if (registration.pluginId === 'desktop_operator' && input.actionId === 'desktop_session_open' && input.args.activate === true) {
        const bundleId = typeof input.args.bundle_id === 'string' ? input.args.bundle_id.trim() : '';
        const appName = typeof input.args.app_name === 'string' ? input.args.app_name.trim() : '';
        const activeStatus = await callProvider(
          registration,
          `${input.requestId}:active-status`,
          'desktop_status',
          { limit: 500 },
          input.timeoutMs,
          input.signal,
          dependencies,
        );
        if (!desktopApplicationIsActive(activeStatus, bundleId, appName)) {
          throw providerError('DESKTOP_ACTIVATION_NOT_CONFIRMED', `Desktop Operator did not confirm ${bundleId || appName || 'the requested application'} as the frontmost application after activation.`, true);
        }
      }
      return result;
    },
    shouldRefreshManifestAfterAction(actionId) {
      return EXTERNAL_PROVIDER_LIFECYCLE_ACTIONS.has(actionId);
    },
  };
}
