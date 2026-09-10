import { randomUUID } from 'crypto';
import {
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_ELEMENT_ACTION_CAPABILITY,
  COMPUTER_ELEMENT_OBSERVE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
  type ComputerBrowserAutomationRequest,
  type ComputerRuntimeExecutionRequest,
} from '../../packages/protocols/computer/index';
import { ComputerProviderError, type ComputerProvider } from '../../packages/plugin-runtime/computer/index';
import {
  ExternalUnixJsonlChannel,
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
  negotiateDesktopOperatorComputerCapability,
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
    effectOutcome: error.effectOutcome,
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
      effectOutcome: error.effectOutcome,
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
  request: ComputerRuntimeExecutionRequest,
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
  if (request.capability === COMPUTER_ELEMENT_OBSERVE_CAPABILITY) {
    return {
      actionId: 'observe_elements',
      args: {
        interactionId: request.interactionId,
        ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
        ...(request.maxNodes !== undefined ? { maxNodes: request.maxNodes } : {}),
        ...(request.includeValues !== undefined ? { includeValues: request.includeValues } : {}),
        ...(request.rootSelector ? { rootSelector: request.rootSelector } : {}),
      },
    };
  }
  if (request.capability === COMPUTER_ELEMENT_ACTION_CAPABILITY) {
    return {
      actionId: request.action,
      args: {
        target: request.target,
        ref: request.ref,
        action: request.action,
        ...(request.value !== undefined ? { value: request.value } : {}),
      },
    };
  }
  throw new ComputerProviderError('COMPUTER_REQUEST_UNSUPPORTED', `Unsupported Desktop Operator Computer capability ${(request as ComputerRuntimeExecutionRequest).capability}.`, { retryable: false });
}

function endpointBindingKey(endpoint: DesktopOperatorComputerEndpoint): string {
  return [
    endpoint.source,
    endpoint.registrationRevision ?? 'legacy',
    endpoint.socketPath,
    endpoint.healthTimeoutMs,
    endpoint.actionTimeoutMs,
    endpoint.maxResponseBytes,
    [...endpoint.capabilityIds].sort().join(','),
  ].join('|');
}

class DesktopOperatorComputerBinding {
  private readonly channel: ExternalUnixJsonlChannel;
  private handshake: { generation: number; value: Record<string, unknown> } | undefined;
  private handshakePromise: Promise<{ generation: number; value: Record<string, unknown> }> | undefined;

  constructor(readonly endpoint: DesktopOperatorComputerEndpoint) {
    this.channel = new ExternalUnixJsonlChannel(endpoint.socketPath);
  }

  close(): void {
    this.handshake = undefined;
    this.handshakePromise = undefined;
    this.channel.close();
  }

  async execute(request: ComputerRuntimeExecutionRequest, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.endpoint.capabilityIds.includes(request.capability)) {
      throw new ComputerProviderError(
        'COMPUTER_PROVIDER_CAPABILITY_UNAVAILABLE',
        `Forge Desktop Operator does not declare ${request.capability}.`,
        { retryable: false, details: { providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID, capability: request.capability, declaredCapabilities: this.endpoint.capabilityIds } },
      );
    }
    try {
      const negotiated = await this.ensureHandshake(timeoutMs);
      const mapped = desktopOperatorActionForComputerRequest(request);
      const plan = negotiateDesktopOperatorComputerCapability(negotiated.value, request.capability, mapped.actionId);
      const computerArguments = request.capability === COMPUTER_OBSERVE_CAPABILITY
        || request.capability === COMPUTER_INPUT_CAPABILITY
        || request.capability === COMPUTER_CAPTURE_CAPABILITY
        ? { action: mapped.actionId, ...mapped.args }
        : mapped.args;
      const invocation = buildDesktopOperatorComputerInvocation(
        plan,
        computerArguments,
        timeoutMs,
      );
      return await this.call(invocation.method, invocation.params, timeoutMs, negotiated.generation);
    } catch (error) {
      if (error instanceof ExternalUnixJsonlTransportError) {
        if (error.source === 'transport') this.invalidateNegotiation();
        throw unavailable(toComputerProviderError(error), this.endpoint);
      }
      if (error instanceof ComputerProviderError) throw unavailable(error, this.endpoint);
      throw error;
    }
  }

  async executeBrowserCompatibility(request: ComputerBrowserAutomationRequest, timeoutMs: number): Promise<Record<string, unknown>> {
    try {
      const negotiated = await this.ensureHandshake(timeoutMs);
      const plan = negotiateDesktopOperatorComputerHandshake(negotiated.value, request.action);
      const { protocolVersion: _compatProtocolVersion, ...browserRequest } = request as ComputerBrowserAutomationRequest & { protocolVersion?: number };
      const invocation = buildDesktopOperatorComputerInvocation(
        plan,
        { ...browserRequest, timeoutMs },
        timeoutMs,
        request,
      );
      return await this.call(invocation.method, invocation.params, timeoutMs, negotiated.generation);
    } catch (error) {
      if (error instanceof ExternalUnixJsonlTransportError) {
        if (error.source === 'transport') this.invalidateNegotiation();
        throw unavailable(toComputerProviderError(error), this.endpoint);
      }
      if (error instanceof ComputerProviderError) throw unavailable(error, this.endpoint);
      throw error;
    }
  }

  private invalidateNegotiation(): void {
    this.handshake = undefined;
    this.handshakePromise = undefined;
  }

  private async ensureHandshake(timeoutMs: number): Promise<{ generation: number; value: Record<string, unknown> }> {
    if (this.handshake && this.channel.connected && this.handshake.generation === this.channel.generation) {
      return this.handshake;
    }
    if (this.handshakePromise) return await this.handshakePromise;
    const promise = this.channel.call({
      requestId: `computer-provider-handshake:${randomUUID()}`,
      method: 'handshake',
      timeoutMs: Math.min(timeoutMs, this.endpoint.healthTimeoutMs),
      maxResponseBytes: 64 * 1024,
    }).then((handshake) => {
      validateDesktopOperatorComputerProviderIdentity(handshake);
      const negotiated = { generation: this.channel.generation, value: handshake };
      this.handshake = negotiated;
      return negotiated;
    });
    this.handshakePromise = promise;
    try {
      return await promise;
    } finally {
      if (this.handshakePromise === promise) this.handshakePromise = undefined;
    }
  }

  private async call(method: string, params: Record<string, unknown>, timeoutMs: number, negotiatedGeneration: number): Promise<Record<string, unknown>> {
    const result = await this.channel.call({
      requestId: `computer-provider:${randomUUID()}`,
      method,
      params,
      timeoutMs: Math.min(timeoutMs, this.endpoint.actionTimeoutMs),
      maxResponseBytes: this.endpoint.maxResponseBytes,
      expectedGeneration: negotiatedGeneration,
    });
    if (!this.channel.connected || this.channel.generation !== negotiatedGeneration) this.invalidateNegotiation();
    return result;
  }
}

function createBinding(endpoint: DesktopOperatorComputerEndpoint): DesktopOperatorComputerBinding {
  return new DesktopOperatorComputerBinding(endpoint);
}

export interface DesktopOperatorComputerProvider extends ComputerProvider {
  /** Migration-only Browser bridge. It reuses the provider channel but is not a Unified Computer capability. */
  executeBrowserCompatibility(request: ComputerBrowserAutomationRequest, timeoutMs: number): Promise<Record<string, unknown>>;
}

export async function callDesktopOperatorComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
  options: DesktopOperatorComputerProviderOptions = {},
): Promise<Record<string, unknown>> {
  const provider = createDesktopOperatorComputerProvider(options);
  try {
    return await provider.executeBrowserCompatibility(request, timeoutMs);
  } finally {
    provider.dispose?.();
  }
}

export function createDesktopOperatorComputerProvider(
  options: DesktopOperatorComputerProviderOptions = {},
): DesktopOperatorComputerProvider {
  let active: { key: string; binding: DesktopOperatorComputerBinding } | undefined;
  const binding = (): DesktopOperatorComputerBinding => {
    const endpoint = resolveDesktopOperatorComputerEndpoint(options);
    const key = endpointBindingKey(endpoint);
    if (active?.key === key) return active.binding;
    active?.binding.close();
    active = { key, binding: createBinding(endpoint) };
    return active.binding;
  };
  return {
    providerId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
    capabilities: desktopOperatorComputerProviderCapabilities(options),
    execute: async (request, timeoutMs) => await binding().execute(request, timeoutMs),
    executeBrowserCompatibility: async (request, timeoutMs) => await binding().executeBrowserCompatibility(request, timeoutMs),
    dispose: () => {
      active?.binding.close();
      active = undefined;
    },
  };
}
