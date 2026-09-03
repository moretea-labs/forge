import { AssistantPluginError } from './errors';
import { getExternalPluginRegistration, listExternalPluginRegistrations, type ExternalPluginRegistration } from './external-registration';
import { callExternalUnixSocket, probeExternalUnixSocketSync, type ExternalUnixSocketCallOptions } from './external-unix-socket';
import { executeManagedPluginProcess, executeManagedPluginProcessSync, type ManagedPluginProcessSpec } from './managed-process-adapter';
import { activateAndVerifyFrontmostApplication, restartVerifiedUserLaunchAgent, startVerifiedUserLaunchAgent, stopVerifiedUserLaunchAgent } from './local-system-adapter';
import {
  resolveExternalProviderPolicy,
  type ExternalProviderPolicyContext,
} from './external-provider-policy';
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
  activateAndVerifyFrontmostApplication?: typeof activateAndVerifyFrontmostApplication;
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
  const providerPolicy = resolveExternalProviderPolicy(registration);
  const missingActions = registration.actions
    .map((action) => action.actionId)
    .filter((actionId) => !(providerPolicy?.allowsMissingProviderAction?.(actionId) ?? false))
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

async function resolveExternalAuthorizationContext(
  registration: ExternalPluginRegistration,
  input: Parameters<NonNullable<AssistantPluginAdapter['resolveAuthorizationContext']>>[0],
  dependencies: ExternalPluginAdapterDependencies,
): Promise<AssistantPluginAuthorizationContext | undefined> {
  if (EXTERNAL_PROVIDER_LIFECYCLE_ACTIONS.has(input.actionId)) {
    return externalProviderAuthorizationContext(registration);
  }
  const providerPolicy = resolveExternalProviderPolicy(registration);
  if (!providerPolicy?.resolveAuthorizationContext) return undefined;
  return await providerPolicy.resolveAuthorizationContext(
    registration,
    input,
    externalProviderPolicyContext(registration, dependencies),
  );
}

function externalProviderPolicyContext(
  registration: ExternalPluginRegistration,
  dependencies: ExternalPluginAdapterDependencies,
): ExternalProviderPolicyContext {
  return {
    callProvider: (requestId, actionId, args, timeoutMs, signal) => callProvider(
      registration,
      requestId,
      actionId,
      args,
      timeoutMs,
      signal,
      dependencies,
    ),
    verifyProviderIdentity: async (requestId, signal) => {
      const providerManifest = await callProvider(
        registration,
        requestId,
        'manifest',
        {},
        undefined,
        signal,
        dependencies,
      );
      parseProviderManifest(providerManifest, registration);
    },
    activateAndVerifyFrontmostApplication: dependencies.activateAndVerifyFrontmostApplication ?? activateAndVerifyFrontmostApplication,
  };
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
    exposure: registration.exposure === 'provider' ? 'internal' : 'product',
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
      const providerPolicy = resolveExternalProviderPolicy(registration);
      if (providerPolicy?.executeAction) {
        const policyResult = await providerPolicy.executeAction(
          input,
          externalProviderPolicyContext(registration, dependencies),
        );
        if (policyResult.handled) return policyResult.result ?? {};
      }

      return await callProvider(
        registration,
        input.requestId,
        input.actionId,
        input.args,
        input.timeoutMs,
        input.signal,
        dependencies,
      );
    },
    shouldRefreshManifestAfterAction(actionId) {
      return EXTERNAL_PROVIDER_LIFECYCLE_ACTIONS.has(actionId);
    },
  };
}
