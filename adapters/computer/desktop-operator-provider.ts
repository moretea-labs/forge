import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, resolve } from 'path';
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

const PROVIDER_PLUGIN_ID = 'desktop_operator';
const PROVIDER_PROTOCOL_VERSION = '1.0';
const LEGACY_BROWSER_AUTOMATION_CAPABILITY = 'macos_browser_automation.v1';
const LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 4 * 1_048_576;
let testSocketPath: string | undefined;

export function desktopOperatorComputerSocketPath(accountHome = process.env.HOME?.trim() || homedir()): string {
  return join(resolve(accountHome), 'Library', 'Caches', 'Forge', 'desktop-operator.sock');
}

export function setDesktopOperatorComputerSocketPathForTest(socketPath: string | undefined): void {
  testSocketPath = socketPath;
}

export function resetDesktopOperatorComputerSocketPathForTest(): void {
  testSocketPath = undefined;
}

function socketPath(): string {
  return testSocketPath ?? desktopOperatorComputerSocketPath();
}

function unavailable(error: AssistantPluginError, path: string): AssistantPluginError {
  if (!/^EXTERNAL_PLUGIN_(SOCKET_UNAVAILABLE|TIMEOUT|TRANSPORT_FAILED|PROTOCOL_ERROR)$/.test(error.code)) return error;
  return new AssistantPluginError(
    'PLUGIN_MACOS_CAPABILITY_BROKER_UNAVAILABLE',
    `Stable Forge Computer provider is unavailable at ${path}. Install or restore Forge Desktop Operator instead of granting macOS permissions to Runtime or release-specific helpers.`,
    { retryable: true, details: { socketPath: path, providerPluginId: PROVIDER_PLUGIN_ID, causeCode: error.code } },
  );
}

export function validateDesktopOperatorComputerHandshake(
  handshake: Record<string, unknown>,
  requestedAction?: string,
): void {
  if (handshake.pluginId !== PROVIDER_PLUGIN_ID || handshake.protocolVersion !== PROVIDER_PROTOCOL_VERSION) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_IDENTITY_MISMATCH',
      'Computer provider returned an unexpected Desktop Operator identity.',
      { retryable: false, details: { expectedPluginId: PROVIDER_PLUGIN_ID, expectedProtocolVersion: PROVIDER_PROTOCOL_VERSION } },
    );
  }
  const capabilities = Array.isArray(handshake.internalCapabilities)
    ? handshake.internalCapabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const actions = Array.isArray(handshake.browserAutomationActions)
    ? handshake.browserAutomationActions.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const browserProtocolVersion = handshake.browserAutomationProtocolVersion;
  if (!capabilities.includes(LEGACY_BROWSER_AUTOMATION_CAPABILITY)
    || browserProtocolVersion !== LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION
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
          providerCompatibilityCapability: LEGACY_BROWSER_AUTOMATION_CAPABILITY,
          requiredBrowserAutomationProtocolVersion: LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION,
          ...(requestedAction ? { requiredAction: requestedAction } : {}),
          declaredCapability: capabilities.includes(LEGACY_BROWSER_AUTOMATION_CAPABILITY),
          declaredBrowserAutomationProtocolVersion: typeof browserProtocolVersion === 'number' ? browserProtocolVersion : null,
          declaredActionCount: actions.length,
        },
      },
    );
  }
}

async function verifyProvider(path: string, timeoutMs: number, requestedAction?: string): Promise<void> {
  const handshake = await callExternalUnixSocket({
    socketPath: path,
    requestId: `computer-provider-handshake:${randomUUID()}`,
    method: 'handshake',
    timeoutMs: Math.min(timeoutMs, 2_000),
    maxResponseBytes: 64 * 1024,
  });
  validateDesktopOperatorComputerHandshake(handshake, requestedAction);
}

export async function callDesktopOperatorComputerBrowserAutomation(
  request: ComputerBrowserAutomationRequest,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const path = socketPath();
  try {
    await verifyProvider(path, timeoutMs, request.action);
    return await callExternalUnixSocket({
      socketPath: path,
      requestId: `computer-provider:${randomUUID()}`,
      method: 'macos_browser_automation',
      params: { ...request, timeoutMs, protocolVersion: LEGACY_BROWSER_AUTOMATION_PROTOCOL_VERSION },
      timeoutMs,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (error instanceof AssistantPluginError) throw unavailable(error, path);
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
  const desktopOperator = getExternalPluginAdapter(input.controllerHome, PROVIDER_PLUGIN_ID);
  if (!desktopOperator) {
    throw new AssistantPluginError(
      'PLUGIN_BROWSER_NATIVE_FOREGROUND_ACTIVATOR_UNAVAILABLE',
      'Native browser foreground activation requires an available Computer application provider.',
      { retryable: true, details: { browserProduct: product, providerId: PROVIDER_PLUGIN_ID } },
    );
  }
  await desktopOperator.executeAction({
    controllerHome: input.controllerHome,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    pluginId: PROVIDER_PLUGIN_ID,
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

export function createDesktopOperatorComputerProvider(): ComputerProvider {
  return {
    providerId: PROVIDER_PLUGIN_ID,
    capabilities: [COMPUTER_BROWSER_AUTOMATION_CAPABILITY],
    executeBrowserAutomation: callDesktopOperatorComputerBrowserAutomation,
  };
}
