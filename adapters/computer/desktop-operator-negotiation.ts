import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CAPABILITY_EXECUTION_METHOD,
  computerCapabilityProtocolVersion,
  type ComputerBrowserAutomationRequest,
  type ComputerCapabilityAdvertisement,
  type ComputerRuntimeProviderCapabilityId,
} from '../../packages/protocols/computer/index';
import { ComputerProviderError } from '../../packages/plugin-runtime/computer/index';
import {
  DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_CAPABILITY,
  DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_METHOD,
  DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION,
  DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
  DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION,
} from './desktop-operator-contract';

export type DesktopOperatorComputerTransportPlan =
  | {
      kind: 'computer';
      capability: ComputerRuntimeProviderCapabilityId;
      protocolVersion: 1 | 2;
      method: typeof COMPUTER_CAPABILITY_EXECUTION_METHOD;
    }
  | {
      kind: 'legacy';
      capability: typeof COMPUTER_BROWSER_AUTOMATION_CAPABILITY;
      protocolVersion: typeof DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION;
      method: typeof DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_METHOD;
    };

export interface DesktopOperatorComputerInvocation {
  method: typeof COMPUTER_CAPABILITY_EXECUTION_METHOD | typeof DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_METHOD;
  params: Record<string, unknown>;
}

function unsupported(message: string, details: Record<string, unknown>): never {
  throw new ComputerProviderError(
    'PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED',
    message,
    { retryable: false, details },
  );
}

export function validateDesktopOperatorComputerProviderIdentity(handshake: Record<string, unknown>): void {
  if (handshake.pluginId === DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID
    && handshake.protocolVersion === DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION) return;
  throw new ComputerProviderError(
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

function parseComputerAdvertisements(raw: unknown, requiredCapability: ComputerRuntimeProviderCapabilityId): ComputerCapabilityAdvertisement[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    unsupported('Installed Forge Desktop Operator returned a malformed Computer capability advertisement.', {
      requiredCapability,
      genericAdvertisementPresent: true,
      malformedReason: 'computerCapabilities must be an array',
    });
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      unsupported('Installed Forge Desktop Operator returned a malformed Computer capability advertisement.', { requiredCapability, genericAdvertisementPresent: true, malformedIndex: index });
    }
    const value = entry as Record<string, unknown>;
    const actions = value.actions;
    if (typeof value.capabilityId !== 'string'
      || typeof value.protocolVersion !== 'number'
      || typeof value.method !== 'string'
      || !Array.isArray(actions)
      || actions.some((action) => typeof action !== 'string')) {
      unsupported('Installed Forge Desktop Operator returned a malformed Computer capability advertisement.', { requiredCapability, genericAdvertisementPresent: true, malformedIndex: index });
    }
    return { capabilityId: value.capabilityId, protocolVersion: value.protocolVersion, method: value.method, actions: actions as string[] };
  });
}

function legacyPlan(handshake: Record<string, unknown>, requestedAction?: string): DesktopOperatorComputerTransportPlan {
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
    unsupported(
      requestedAction
        ? `Installed Forge Desktop Operator does not declare required legacy Browser compatibility action ${requestedAction}.`
        : 'Installed Forge Desktop Operator does not declare the required legacy Browser compatibility capability.',
      {
        requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
        providerCompatibilityCapability: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_CAPABILITY,
        requiredBrowserAutomationProtocolVersion: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION,
        ...(requestedAction ? { requiredAction: requestedAction } : {}),
        declaredCapability: capabilities.includes(DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_CAPABILITY),
        declaredBrowserAutomationProtocolVersion: typeof browserProtocolVersion === 'number' ? browserProtocolVersion : null,
        declaredActionCount: actions.length,
      },
    );
  }
  return { kind: 'legacy', capability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY, protocolVersion: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION, method: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_METHOD };
}

export function negotiateDesktopOperatorComputerCapability(
  handshake: Record<string, unknown>,
  capability: ComputerRuntimeProviderCapabilityId,
  requestedAction?: string,
): DesktopOperatorComputerTransportPlan {
  validateDesktopOperatorComputerProviderIdentity(handshake);
  const advertisements = parseComputerAdvertisements(handshake.computerCapabilities, capability);
  const matching = advertisements?.filter((entry) => entry.capabilityId === capability) ?? [];
  if (matching.length > 1) {
    unsupported('Installed Forge Desktop Operator declared a duplicate Computer capability.', { requiredCapability: capability, declaredCount: matching.length });
  }
  const advertisement = matching[0];
  if (!advertisement) {
    unsupported('Installed Forge Desktop Operator does not advertise the required Unified Computer capability.', { requiredCapability: capability, genericAdvertisementPresent: advertisements !== undefined });
  }
  const requiredProtocolVersion = computerCapabilityProtocolVersion(capability);
  if (advertisement.protocolVersion !== requiredProtocolVersion
    || advertisement.method !== COMPUTER_CAPABILITY_EXECUTION_METHOD
    || (requestedAction && !advertisement.actions.includes(requestedAction))) {
    unsupported(
      requestedAction
        ? `Installed Forge Desktop Operator does not support ${requestedAction} through ${capability}.`
        : `Installed Forge Desktop Operator declares an incompatible ${capability} capability.`,
      {
        requiredCapability: capability,
        requiredComputerProtocolVersion: requiredProtocolVersion,
        requiredMethod: COMPUTER_CAPABILITY_EXECUTION_METHOD,
        ...(requestedAction ? { requiredAction: requestedAction } : {}),
        declaredComputerProtocolVersion: advertisement.protocolVersion,
        declaredMethod: advertisement.method,
        declaredActionCount: advertisement.actions.length,
      },
    );
  }
  return { kind: 'computer', capability, protocolVersion: requiredProtocolVersion, method: COMPUTER_CAPABILITY_EXECUTION_METHOD };
}

/** Compatibility wrapper retained for the thin macOS Browser broker while that adapter is retired. */
export function negotiateDesktopOperatorComputerHandshake(handshake: Record<string, unknown>, requestedAction?: string): DesktopOperatorComputerTransportPlan {
  validateDesktopOperatorComputerProviderIdentity(handshake);
  return legacyPlan(handshake, requestedAction);
}

export function validateDesktopOperatorComputerHandshake(handshake: Record<string, unknown>, requestedAction?: string): void {
  negotiateDesktopOperatorComputerHandshake(handshake, requestedAction);
}

export function buildDesktopOperatorComputerInvocation(
  plan: DesktopOperatorComputerTransportPlan,
  argumentsValue: Record<string, unknown>,
  timeoutMs: number,
  legacyBrowserRequest?: ComputerBrowserAutomationRequest,
): DesktopOperatorComputerInvocation {
  if (plan.kind === 'computer') {
    return { method: plan.method, params: { capability: plan.capability, protocolVersion: plan.protocolVersion, arguments: argumentsValue } };
  }
  if (!legacyBrowserRequest) throw new ComputerProviderError('COMPUTER_REQUEST_UNSUPPORTED', 'Legacy Browser compatibility invocation requires an explicit browser request.', { retryable: false });
  return { method: plan.method, params: { ...legacyBrowserRequest, timeoutMs, protocolVersion: plan.protocolVersion } };
}
