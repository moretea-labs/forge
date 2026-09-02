import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CAPABILITY_EXECUTION_METHOD,
  COMPUTER_CAPABILITY_PROTOCOL_VERSION,
  type ComputerBrowserAutomationRequest,
  type ComputerCapabilityAdvertisement,
} from '../../packages/protocols/computer/index';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
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
      capability: typeof COMPUTER_BROWSER_AUTOMATION_CAPABILITY;
      protocolVersion: typeof COMPUTER_CAPABILITY_PROTOCOL_VERSION;
      method: typeof COMPUTER_CAPABILITY_EXECUTION_METHOD;
    }
  | {
      kind: 'legacy';
      protocolVersion: typeof DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION;
      method: typeof DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_METHOD;
    };

export interface DesktopOperatorComputerInvocation {
  method: typeof COMPUTER_CAPABILITY_EXECUTION_METHOD | typeof DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_METHOD;
  params: Record<string, unknown>;
}

function unsupported(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new AssistantPluginError(
    'PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED',
    message,
    { retryable: false, details },
  );
}

function validateIdentity(handshake: Record<string, unknown>): void {
  if (handshake.pluginId === DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID
    && handshake.protocolVersion === DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION) return;
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

function parseComputerAdvertisements(raw: unknown): ComputerCapabilityAdvertisement[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    unsupported('Installed Forge Desktop Operator returned a malformed Computer capability advertisement.', {
      requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
      genericAdvertisementPresent: true,
      malformedReason: 'computerCapabilities must be an array',
    });
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      unsupported('Installed Forge Desktop Operator returned a malformed Computer capability advertisement.', {
        requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
        genericAdvertisementPresent: true,
        malformedIndex: index,
      });
    }
    const value = entry as Record<string, unknown>;
    const actions = value.actions;
    if (typeof value.capabilityId !== 'string'
      || typeof value.protocolVersion !== 'number'
      || typeof value.method !== 'string'
      || !Array.isArray(actions)
      || actions.some((action) => typeof action !== 'string')) {
      unsupported('Installed Forge Desktop Operator returned a malformed Computer capability advertisement.', {
        requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
        genericAdvertisementPresent: true,
        malformedIndex: index,
      });
    }
    return {
      capabilityId: value.capabilityId,
      protocolVersion: value.protocolVersion,
      method: value.method,
      actions: actions as string[],
    };
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
        ? `Installed Forge Desktop Operator does not declare required Computer browser automation action ${requestedAction}.`
        : 'Installed Forge Desktop Operator does not declare the required Computer browser automation capability.',
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
  return {
    kind: 'legacy',
    protocolVersion: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION,
    method: DESKTOP_OPERATOR_LEGACY_BROWSER_AUTOMATION_METHOD,
  };
}

export function negotiateDesktopOperatorComputerHandshake(
  handshake: Record<string, unknown>,
  requestedAction?: string,
): DesktopOperatorComputerTransportPlan {
  validateIdentity(handshake);
  const advertisements = parseComputerAdvertisements(handshake.computerCapabilities);
  const browserAdvertisements = advertisements?.filter(
    (entry) => entry.capabilityId === COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  ) ?? [];
  if (browserAdvertisements.length > 1) {
    unsupported('Installed Forge Desktop Operator declared duplicate Computer browser automation capabilities.', {
      requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
      declaredCount: browserAdvertisements.length,
    });
  }
  const browser = browserAdvertisements[0];
  if (browser) {
    if (browser.protocolVersion !== COMPUTER_CAPABILITY_PROTOCOL_VERSION
      || browser.method !== COMPUTER_CAPABILITY_EXECUTION_METHOD
      || (requestedAction && !browser.actions.includes(requestedAction))) {
      unsupported(
        requestedAction
          ? `Installed Forge Desktop Operator does not support ${requestedAction} through the negotiated Computer browser automation capability.`
          : 'Installed Forge Desktop Operator declares an incompatible Computer browser automation capability.',
        {
          requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
          requiredComputerProtocolVersion: COMPUTER_CAPABILITY_PROTOCOL_VERSION,
          requiredMethod: COMPUTER_CAPABILITY_EXECUTION_METHOD,
          ...(requestedAction ? { requiredAction: requestedAction } : {}),
          declaredComputerProtocolVersion: browser.protocolVersion,
          declaredMethod: browser.method,
          declaredActionCount: browser.actions.length,
        },
      );
    }
    return {
      kind: 'computer',
      capability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
      protocolVersion: COMPUTER_CAPABILITY_PROTOCOL_VERSION,
      method: COMPUTER_CAPABILITY_EXECUTION_METHOD,
    };
  }
  return legacyPlan(handshake, requestedAction);
}

/** Compatibility validator retained for the thin macOS broker facade and existing callers. */
export function validateDesktopOperatorComputerHandshake(
  handshake: Record<string, unknown>,
  requestedAction?: string,
): void {
  negotiateDesktopOperatorComputerHandshake(handshake, requestedAction);
}

export function buildDesktopOperatorComputerInvocation(
  plan: DesktopOperatorComputerTransportPlan,
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
): DesktopOperatorComputerInvocation {
  if (plan.kind === 'computer') {
    const argumentsValue = { ...request } as Record<string, unknown>;
    delete argumentsValue.protocolVersion;
    return {
      method: plan.method,
      params: {
        capability: plan.capability,
        protocolVersion: plan.protocolVersion,
        arguments: { ...argumentsValue, timeoutMs },
      },
    };
  }
  return {
    method: plan.method,
    params: { ...request, timeoutMs, protocolVersion: plan.protocolVersion },
  };
}
