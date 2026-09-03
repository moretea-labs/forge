import { randomUUID } from 'crypto';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
  type ComputerBrowserAutomationRequest,
  type ComputerExecutionRequest,
} from '../../packages/protocols/computer/index';
import { ComputerProviderError, type ComputerProvider } from '../../packages/plugin-runtime/computer/index';
import {
  callExternalUnixJsonl,
  ExternalUnixJsonlTransportError,
} from '../../packages/plugin-runtime/external/index';
import { DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } from './desktop-operator-contract';
import {
  desktopOperatorComputerProviderCapabilities,
  resolveDesktopOperatorComputerEndpoint,
  type DesktopOperatorComputerEndpoint,
  type DesktopOperatorComputerProviderOptions,
} from './desktop-operator-discovery';
import {
  buildDesktopOperatorComputerInvocation,
  negotiateDesktopOperatorComputerHandshake,
  validateDesktopOperatorComputerHandshake,
  validateDesktopOperatorComputerProviderIdentity,
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

export function desktopOperatorActionForComputerRequest(
  request: Exclude<ComputerExecutionRequest, { capability: typeof COMPUTER_BROWSER_AUTOMATION_CAPABILITY }>,
): { actionId: string; args: Record<string, unknown> } {
  if (request.capability === COMPUTER_OBSERVE_CAPABILITY) {
    return {
      actionId: 'desktop_observe',
      args: {
        interaction_id: request.interactionId,
        ...(request.maxDepth !== undefined ? { max_depth: request.maxDepth } : {}),
        ...(request.maxNodes !== undefined ? { max_nodes: request.maxNodes } : {}),
        ...(request.includeValues !== undefined ? { include_values: request.includeValues } : {}),
        ...(request.includeActions !== undefined ? { include_actions: request.includeActions } : {}),
        ...(request.includeWindows !== undefined ? { include_windows: request.includeWindows } : {}),
        ...(request.rootSelector ? { root_selector: request.rootSelector } : {}),
      },
    };
  }
  if (request.capability === COMPUTER_INPUT_CAPABILITY) {
    if (request.action === 'press') return { actionId: 'desktop_press', args: { interaction_id: request.interactionId, selector: request.selector, ...(request.semanticAction ? { semantic_action: request.semanticAction } : {}) } };
    if (request.action === 'type_text') return { actionId: 'desktop_type_text', args: { interaction_id: request.interactionId, selector: request.selector, text: request.text, ...(request.replace !== undefined ? { replace: request.replace } : {}) } };
    if (request.action === 'key') return { actionId: 'desktop_key', args: { interaction_id: request.interactionId, keys: request.keys } };
    return { actionId: 'desktop_open_url', args: { url: request.url } };
  }
  if (request.capability === COMPUTER_CAPTURE_CAPABILITY) {
    return {
      actionId: 'desktop_screenshot',
      args: {
        ...(request.scope ? { scope: request.scope } : {}),
        ...(request.interactionId ? { interaction_id: request.interactionId } : {}),
        ...(request.windowId !== undefined ? { window_id: request.windowId } : {}),
        ...(request.label ? { label: request.label } : {}),
      },
    };
  }
  throw new ComputerProviderError('COMPUTER_REQUEST_UNSUPPORTED', `Unsupported Desktop Operator Computer capability ${(request as ComputerExecutionRequest).capability}.`, { retryable: false });
}

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

async function callDesktopOperatorComputerAction(
  request: Exclude<ComputerExecutionRequest, { capability: typeof COMPUTER_BROWSER_AUTOMATION_CAPABILITY }>,
  timeoutMs: number,
  options: DesktopOperatorComputerProviderOptions,
): Promise<Record<string, unknown>> {
  const endpoint = resolveDesktopOperatorComputerEndpoint(options);
  if (!endpoint.capabilityIds.includes(request.capability)) {
    throw new ComputerProviderError(
      'COMPUTER_PROVIDER_CAPABILITY_UNAVAILABLE',
      `Forge Desktop Operator does not declare ${request.capability}.`,
      { retryable: false, details: { providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID, capability: request.capability, declaredCapabilities: endpoint.capabilityIds } },
    );
  }
  const mapped = desktopOperatorActionForComputerRequest(request);
  try {
    const handshake = await callExternalUnixJsonl({
      socketPath: endpoint.socketPath,
      requestId: `computer-provider-handshake:${randomUUID()}`,
      method: 'handshake',
      timeoutMs: Math.min(timeoutMs, endpoint.healthTimeoutMs),
      maxResponseBytes: 64 * 1024,
    });
    validateDesktopOperatorComputerProviderIdentity(handshake);
    return await callExternalUnixJsonl({
      socketPath: endpoint.socketPath,
      requestId: `computer-provider:${randomUUID()}`,
      method: 'execute',
      params: { action: mapped.actionId, arguments: mapped.args },
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
    capabilities: desktopOperatorComputerProviderCapabilities(options),
    execute: async (request, timeoutMs) => request.capability === COMPUTER_BROWSER_AUTOMATION_CAPABILITY
      ? await callDesktopOperatorComputerBrowserAutomation(request.request, timeoutMs, options)
      : await callDesktopOperatorComputerAction(request, timeoutMs, options),
  };
}
