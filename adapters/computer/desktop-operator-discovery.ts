import { homedir } from 'os';
import { join, resolve } from 'path';
import { COMPUTER_BROWSER_AUTOMATION_CAPABILITY } from '../../packages/protocols/computer/index';
import { ComputerProviderError } from '../../packages/plugin-runtime/computer/index';
import { getExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';
import {
  DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
  DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION,
} from './desktop-operator-contract';

export const DESKTOP_OPERATOR_MAX_RESPONSE_BYTES = 4 * 1_048_576;
const LEGACY_REGISTRATION_CAPABILITIES = ['desktop.observe', 'desktop.interact', 'desktop.capture'] as const;
let testSocketPath: string | undefined;

export interface DesktopOperatorComputerEndpoint {
  socketPath: string;
  source: 'registration' | 'legacy_fallback' | 'test_override';
  healthTimeoutMs: number;
  actionTimeoutMs: number;
  maxResponseBytes: number;
  registrationRevision?: number;
}

export interface DesktopOperatorComputerProviderOptions {
  resolveControllerHome?: () => string;
}

export function desktopOperatorComputerSocketPath(accountHome = process.env.HOME?.trim() || homedir()): string {
  return join(resolve(accountHome), 'Library', 'Caches', 'Forge', 'desktop-operator.sock');
}

export function setDesktopOperatorComputerSocketPathForTest(socketPath: string | undefined): void {
  testSocketPath = socketPath;
}

export function resetDesktopOperatorComputerSocketPathForTest(): void {
  testSocketPath = undefined;
}

function registeredEndpoint(controllerHome: string): DesktopOperatorComputerEndpoint | undefined {
  let registration;
  try {
    registration = getExternalPluginRegistration(controllerHome, DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
  } catch (error) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_REGISTRATION_INVALID',
      'Forge Desktop Operator registration could not be validated.',
      { retryable: false, details: { providerPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID, cause: error instanceof Error ? error.message : String(error) } },
    );
  }
  if (!registration) return undefined;
  if (!registration.enabled) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_DISABLED',
      'Forge Desktop Operator is registered but disabled. Enable or reinstall the Computer provider instead of bypassing its registration.',
      { retryable: false, details: { providerPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID, registrationRevision: registration.revision } },
    );
  }
  if (registration.providerPluginId !== DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID
    || registration.protocolVersion !== DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_REGISTRATION_IDENTITY_MISMATCH',
      'Forge Desktop Operator registration does not match the required Computer provider identity.',
      {
        retryable: false,
        details: {
          providerPluginId: registration.providerPluginId,
          protocolVersion: registration.protocolVersion,
          expectedProviderPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
          expectedProtocolVersion: DESKTOP_OPERATOR_PROVIDER_PROTOCOL_VERSION,
          registrationRevision: registration.revision,
        },
      },
    );
  }
  if (registration.transport.kind !== 'unix_socket_jsonl') {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_TRANSPORT_UNSUPPORTED',
      'Forge Desktop Operator registration must use the trusted Unix-socket transport.',
      { retryable: false, details: { transportKind: registration.transport.kind, registrationRevision: registration.revision } },
    );
  }
  const capabilityIds = new Set(registration.capabilities.map((capability) => capability.capabilityId));
  const declaresComputerCapability = capabilityIds.has(COMPUTER_BROWSER_AUTOMATION_CAPABILITY);
  const legacyRegistrationCompatible = LEGACY_REGISTRATION_CAPABILITIES.every((capability) => capabilityIds.has(capability));
  if (!declaresComputerCapability && !legacyRegistrationCompatible) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_CAPABILITY_UNDECLARED',
      'Forge Desktop Operator registration does not declare the Computer browser capability or the bounded legacy Desktop capability set required for compatibility.',
      {
        retryable: false,
        details: {
          requiredCapability: COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
          legacyRequiredCapabilities: [...LEGACY_REGISTRATION_CAPABILITIES],
          registrationRevision: registration.revision,
        },
      },
    );
  }
  return {
    socketPath: registration.transport.socketPath,
    source: 'registration',
    healthTimeoutMs: registration.transport.healthTimeoutMs ?? 2_000,
    actionTimeoutMs: registration.transport.actionTimeoutMs ?? 30_000,
    maxResponseBytes: registration.transport.maxResponseBytes ?? DESKTOP_OPERATOR_MAX_RESPONSE_BYTES,
    registrationRevision: registration.revision,
  };
}

export function resolveDesktopOperatorComputerEndpoint(
  options: DesktopOperatorComputerProviderOptions = {},
): DesktopOperatorComputerEndpoint {
  if (testSocketPath) {
    return {
      socketPath: testSocketPath,
      source: 'test_override',
      healthTimeoutMs: 2_000,
      actionTimeoutMs: 30_000,
      maxResponseBytes: DESKTOP_OPERATOR_MAX_RESPONSE_BYTES,
    };
  }
  const controllerHome = options.resolveControllerHome?.();
  if (controllerHome) {
    const registered = registeredEndpoint(controllerHome);
    if (registered) return registered;
  }
  return {
    socketPath: desktopOperatorComputerSocketPath(),
    source: 'legacy_fallback',
    healthTimeoutMs: 2_000,
    actionTimeoutMs: 30_000,
    maxResponseBytes: DESKTOP_OPERATOR_MAX_RESPONSE_BYTES,
  };
}
