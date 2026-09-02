import { randomUUID } from 'crypto';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  type ComputerBrowserAutomationRequest,
  type ComputerBrowserProduct,
} from '../../packages/protocols/computer/index';
import type { ComputerProvider } from '../../packages/plugin-runtime/computer/index';
import type { AssistantPluginActionExecutionInput } from '../../src/runtime/plugins/types';
import { getExternalPluginAdapter } from '../../src/runtime/plugins/external-adapter';
import { callExternalUnixSocket } from '../../src/runtime/plugins/external-unix-socket';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import {
  DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_CAPABILITY,
  DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION,
  DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
  DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION,
  resolveDesktopOperatorComputerEndpoint,
  type DesktopOperatorComputerEndpoint,
  type DesktopOperatorComputerProviderOptions,
} from './desktop-operator-discovery';

export {
  desktopOperatorComputerSocketPath,
  resetDesktopOperatorComputerSocketPathForTest,
  setDesktopOperatorComputerSocketPathForTest,
} from './desktop-operator-discovery';

function unavailable(error: AssistantPluginError, endpoint: DesktopOperatorComputerEndpoint): AssistantPluginError {
  if (!/^EXTERNAL_PLUGIN_(SOCKET_UNAVAILABLE|TIMEOUT|TRANSPORT_FAILED|PROTOCOL_ERROR)$/.test(error.code)) return error;
  return new AssistantPluginError(
    'PLUGIN_MACOS_CAPABILITY_BROKER_UNAVAILABLE',
    `Stable Forge Computer provider is unavailable at ${endpoint.socketPath}. Install or restore Forge Desktop Operator instead of granting macOS permissions to Runtime or release-specific helpers.`,
    {
      retryable: true,
      details: {
        socketPath: endpoint.socketPath,
        endpointSource: endpoint.source,
        registrationRevision: endpoint.registrationRevision,
        providerPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
        causeCode: error.code,
      },
    },
  );
}

export function validateDesktopOperatorComputerHandshake(
  handshake: Record<string, unknown>,
  requestedAction?: string,
): void {
  if (handshake.pluginId !== DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID
    || handshake.protocolVersion !== DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_IDENTITY_MISMATCH',
      'Computer provider returned an unexpected Desktop Operator identity.',
      {
        retryable: false,
        details: {
          expectedPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
          expectedProtocolVersion: DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION,
        },
      },
    );
  }
  const capabilities = Array.isArray(handshake.internalCapabilities)
    ? handshake.internalCapabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const actions = Array.isArray(handshake.browserAutomationActions)
    ? handshake.browserAutomationActions.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const browserProtocolVersion = handshake.browserAutomationProtocolVersion;
  if (!capabilities.includes(DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_CAPABILITY)
    || browserProtocolVersion !== DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION
    || (requestedAction && !actions.includes(requestedAction))) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED',
      requestedAction
        ? `Installed Forge Desktop Operator does not declare required Computer browser automation action ${requestedAction}.`
        : 'Installed Forge Desktop Operator does not declare the required Computer browser automation capability.',
      {
        retryable: false,
        details: {
          requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
          providerCompatibilityCapability: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_CAPABILITY,
          requiredBrowserAutomationProtocolVersion: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION,
          ...(requestedAction ? { requiredAction: requestedAction } : {}),
          declaredCapability: capabilities.includes(DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_CAPABILITY),
          declaredBrowserAutomationProtocolVersion: typeof browserProtocolVersion === 'number' ? browserProtocolVersion : null,
          declaredActionCount: actions.length,
        },
      },
    );
  }
}

async function verifyProvider(
  endpoint: DesktopOperatorComputerEndpoint,
  timeoutMs: number,
  requestedAction?: string,
): Promise<void> {
  const handshake = await callExternalUnixSocket({
    socketPath: endpoint.socketPath,
    requestId: `computer-provider-handshake:${randomUUID()}`,
    method: 'handshake',
    timeoutMs: Math.min(timeoutMs, endpoint.healthTimeoutMs),
    maxResponseBytes: 64 * 1024,
  });
  validateDesktopOperatorComputerHandshake(handshake, requestedAction);
}

export async function callDesktopOperatorComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
  options: DesktopOperatorComputerProviderOptions = {},
): Promise<Record<string, unknown>> {
  const endpoint = resolveDesktopOperatorComputerEndpoint(options);
  try {
    await verifyProvider(endpoint, timeoutMs, request.action);
    return await callExternalUnixSocket({
      socketPath: endpoint.socketPath,
      requestId: `computer-provider:${randomUUID()}`,
      method: 'macos_browser_automation',
      params: { ...request, timeoutMs, protocolVersion: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION },
      timeoutMs: Math.min(timeoutMs, endpoint.actionTimeoutMs),
      maxResponseBytes: endpoint.maxResponseBytes,
    });
  } catch (error) {
    if (error instanceof AssistantPluginError) throw unavailable(error, endpoint);
    throw error;
  }
}

const NATIVE_BROWSER_BUNDLE_IDS: Record<ComputerBrowserProduct, string> = {
  chrome: 'com.google.Chrome',
  vivaldi: 'com.vivaldi.Vivaldi',
};

export async function activateDesktopOperatorBrowserApplication(
  input: AssistantPluginActionExecutionInput,
  product: ComputerBrowserProduct,
): Promise<void> {
  const desktopOperator = getExternalPluginAdapter(input.controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
  if (!desktopOperator) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNAVAILABLE',
      'Native browser foreground activation requires an available Computer application provider.',
      { retryable: true, details: { browserProduct: product, providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } },
    );
  }
  await desktopOperator.executeAction({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    pluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
    actionId: 'desktop_session_open',
    requestId: `${input.requestId}:native-browser-foreground:${product}`,
    args: { bundle_id: NATIVE_BROWSER_BUNDLE_IDS[product], launch: false, activate: true },
    origin: input.origin,
    jobId: input.jobId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
  });
}

export function createDesktopOperatorComputerProvider(
  options: DesktopOperatorComputerProviderOptions = {},
): ComputerProvider {
  return {
    providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
    capabilities: [COMPUTER_BROWSER_AUTOMATION_CAPABILITY],
    executeBrowserAutomation: (request, timeoutMs) => callDesktopOperatorComputerBrowserAutomation(request, timeoutMs, options),
  };
}
