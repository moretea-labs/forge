import { homedir } from 'os';
import { join, resolve } from 'path';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
  type ComputerRuntimeProviderCapabilityId,
} from '../../packages/protocols/computer/index';
import {
  ComputerProviderError,
  type ComputerProviderRegistrationLookup,
  type ComputerProviderRegistrationSnapshot,
} from '../../packages/plugin-runtime/computer/index';
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
  capabilityIds: ComputerRuntimeProviderCapabilityId[];
}

export type DesktopOperatorLegacyFallbackMode = 'disabled' | 'unregistered_v0_2';

export interface DesktopOperatorComputerProviderOptions {
  lookupRegistration?: ComputerProviderRegistrationLookup;
  legacyFallback?: DesktopOperatorLegacyFallbackMode;
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

function readRegisteredProvider(
  lookupRegistration: ComputerProviderRegistrationLookup,
): ComputerProviderRegistrationSnapshot | undefined {
  try {
    return lookupRegistration(DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID);
  } catch (error) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_REGISTRATION_INVALID',
      'Forge Desktop Operator registration could not be validated.',
      { retryable: false, details: { providerPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID, cause: error instanceof Error ? error.message : String(error) } },
    );
  }
}

function declaredComputerCapabilities(
  registration: ComputerProviderRegistrationSnapshot,
): ComputerRuntimeProviderCapabilityId[] {
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
  const capabilityIds = new Set(registration.capabilityIds);
  const recognized = [
    COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
    COMPUTER_OBSERVE_CAPABILITY,
    COMPUTER_INPUT_CAPABILITY,
    COMPUTER_CAPTURE_CAPABILITY,
  ].filter((capability): capability is ComputerRuntimeProviderCapabilityId => capabilityIds.has(capability));
  const legacyRegistrationCompatible = LEGACY_REGISTRATION_CAPABILITIES.every((capability) => capabilityIds.has(capability));
  if (recognized.length === 0 && !legacyRegistrationCompatible) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_CAPABILITY_UNDECLARED',
      'Forge Desktop Operator registration does not declare a supported Computer capability or the bounded legacy Desktop capability set required for compatibility.',
      {
        retryable: false,
        details: {
          supportedComputerCapabilities: [COMPUTER_BROWSER_AUTOMATION_CAPABILITY, COMPUTER_OBSERVE_CAPABILITY, COMPUTER_INPUT_CAPABILITY, COMPUTER_CAPTURE_CAPABILITY],
          legacyRequiredCapabilities: [...LEGACY_REGISTRATION_CAPABILITIES],
          registrationRevision: registration.revision,
        },
      },
    );
  }
  return recognized.length > 0 ? recognized : [COMPUTER_BROWSER_AUTOMATION_CAPABILITY];
}

function registeredEndpoint(
  lookupRegistration: ComputerProviderRegistrationLookup,
): DesktopOperatorComputerEndpoint | undefined {
  const registration = readRegisteredProvider(lookupRegistration);
  if (!registration) return undefined;
  const capabilityIds = declaredComputerCapabilities(registration);
  if (!registration.enabled) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_DISABLED',
      'Forge Desktop Operator is registered but disabled. Enable or reinstall the Computer provider instead of bypassing its registration.',
      { retryable: false, details: { providerPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID, registrationRevision: registration.revision } },
    );
  }
  if (registration.transport.kind !== 'unix_socket_jsonl' || !registration.transport.socketPath) {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_TRANSPORT_UNSUPPORTED',
      'Forge Desktop Operator registration must use the trusted Unix-socket transport.',
      { retryable: false, details: { transportKind: registration.transport.kind, registrationRevision: registration.revision } },
    );
  }
  return {
    socketPath: registration.transport.socketPath,
    source: 'registration',
    healthTimeoutMs: registration.transport.healthTimeoutMs ?? 2_000,
    actionTimeoutMs: registration.transport.actionTimeoutMs ?? 30_000,
    maxResponseBytes: registration.transport.maxResponseBytes ?? DESKTOP_OPERATOR_MAX_RESPONSE_BYTES,
    registrationRevision: registration.revision,
    capabilityIds,
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
      capabilityIds: [COMPUTER_BROWSER_AUTOMATION_CAPABILITY],
    };
  }
  if (options.lookupRegistration) {
    const registered = registeredEndpoint(options.lookupRegistration);
    if (registered) return registered;
  }
  if (options.legacyFallback !== 'unregistered_v0_2') {
    throw new ComputerProviderError(
      'PLUGIN_COMPUTER_PROVIDER_REGISTRATION_REQUIRED',
      'Computer provider registration is required unless the Runtime composition explicitly enables the bounded Desktop Operator 0.2.x compatibility fallback.',
      {
        retryable: false,
        details: {
          providerPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID,
          legacyFallback: options.legacyFallback ?? 'disabled',
        },
      },
    );
  }
  return {
    socketPath: desktopOperatorComputerSocketPath(),
    source: 'legacy_fallback',
    healthTimeoutMs: 2_000,
    actionTimeoutMs: 30_000,
    maxResponseBytes: DESKTOP_OPERATOR_MAX_RESPONSE_BYTES,
    capabilityIds: [COMPUTER_BROWSER_AUTOMATION_CAPABILITY],
  };
}

export function desktopOperatorComputerProviderCapabilities(
  options: DesktopOperatorComputerProviderOptions = {},
): ComputerRuntimeProviderCapabilityId[] {
  if (testSocketPath) return [COMPUTER_BROWSER_AUTOMATION_CAPABILITY];
  if (options.lookupRegistration) {
    const registration = readRegisteredProvider(options.lookupRegistration);
    if (registration) return declaredComputerCapabilities(registration);
  }
  if (options.legacyFallback === 'unregistered_v0_2') return [COMPUTER_BROWSER_AUTOMATION_CAPABILITY];
  throw new ComputerProviderError(
    'PLUGIN_COMPUTER_PROVIDER_REGISTRATION_REQUIRED',
    'Computer provider registration is required before capabilities can be declared.',
    { retryable: false, details: { providerPluginId: DESKTOP_OPERATOR_PROVIDER_PLUGIN_ID } },
  );
}
