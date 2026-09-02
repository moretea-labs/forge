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
import { DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } from './desktop-operator-contract';
import {
  resolveDesktopOperatorComputerEndpoint,
  type DesktopOperatorComputerEndpoint,
  type DesktopOperatorComputerProviderOptions,
} from './desktop-operator-discovery';
import {
  buildDesktopOperatorComputerInvocation,
  negotiateDesktopOperatorComputerHandshake,
  validateDesktopOperatorComputerHandshake,
  type DesktopOperatorComputerTransportPlan,
} from './desktop-operator-negotiation';

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

export { validateDesktopOperatorComputerHandshake } from './desktop-operator-negotiation';

async function verifyProvider(
  endpoint: DesktopOperatorComputerEndpoint,
  timeoutMs: number,
  requestedAction?: string,
): Promise<DesktopOperatorComputerTransportPlan> {
  const handshake = await callExternalUnixSocket({
    socketPath: endpoint.socketPath,
    requestId: `computer-provider-handshake:${randomUUID()}`,
    method: 'handshake',
    timeoutMs: Math.min(timeoutMs, endpoint.healthTimeoutMs),
    maxResponseBytes: 64 * 1024,
  });
  return negotiateDesktopOperatorComputerHandshake(handshake, requestedAction);
}

export async function callDesktopOperatorComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
  options: DesktopOperatorComputerProviderOptions = {},
): Promise<Record<string, unknown>> {
  const endpoint = resolveDesktopOperatorComputerEndpoint(options);
  try {
    const plan = await verifyProvider(endpoint, timeoutMs, request.action);
    const invocation = buildDesktopOperatorComputerInvocation(plan, request, timeoutMs);
    return await callExternalUnixSocket({
      socketPath: endpoint.socketPath,
      requestId: `computer-provider:${randomUUID()}`,
      method: invocation.method,
      params: invocation.params,
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
