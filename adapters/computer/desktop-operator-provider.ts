import { randomUUID } from 'crypto';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  type ComputerBrowserAutomationRequest,
} from '../../packages/protocols/computer/index';
import { ComputerProviderError, type ComputerProvider } from '../../packages/plugin-runtime/computer/index';
import {
  callExternalUnixJsonl,
  ExternalUnixJsonlTransportError,
} from '../../packages/plugin-runtime/external/index';
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

function toComputerProviderError(error: ExternalUnixJsonlTransportError): ComputerProviderError {
  return new ComputerProviderError(error.code, error.detailMessage, {
    retryable: error.retryable,
    details: error.details,
  });
}

function unavailable(error: ComputerProviderError, endpoint: DesktopOperatorComputerEndpoint): ComputerProviderError {
  if (!/^EXTERNAL_PLUGIN_(SOCKET_UNAVAILABLE|TIMEOUT|TRANSPORT_FAILED|PROTOCOL_ERROR)$/.test(error.code)) return error;
  return new ComputerProviderError(
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
  const handshake = await callExternalUnixJsonl({
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
    return await callExternalUnixJsonl({
      socketPath: endpoint.socketPath,
      requestId: `computer-provider:${randomUUID()}`,
      method: invocation.method,
      params: invocation.params,
      timeoutMs: Math.min(timeoutMs, endpoint.actionTimeoutMs),
      maxResponseBytes: endpoint.maxResponseBytes,
    });
  } catch (error) {
    if (error instanceof ComputerProviderError) throw unavailable(error, endpoint);
    if (error instanceof ExternalUnixJsonlTransportError) throw unavailable(toComputerProviderError(error), endpoint);
    throw error;
  }
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
