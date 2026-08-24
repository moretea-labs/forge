import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { callExternalUnixSocket } from './external-unix-socket';
import { AssistantPluginError } from './errors';

const BROKER_PLUGIN_ID = 'desktop_operator';
const BROKER_PROTOCOL_VERSION = '1.0';
const BROWSER_AUTOMATION_CAPABILITY = 'macos_browser_automation.v1';
const BROWSER_AUTOMATION_PROTOCOL_VERSION = 1;
const MAX_RESPONSE_BYTES = 4 * 1_048_576;
let testSocketPath: string | undefined;

export function macOsCapabilityBrokerSocketPath(accountHome = process.env.HOME?.trim() || homedir()): string {
  return join(resolve(accountHome), 'Library', 'Caches', 'Forge', 'desktop-operator.sock');
}

export function setMacOsCapabilityBrokerSocketPathForTest(socketPath: string | undefined): void {
  testSocketPath = socketPath;
}

export function resetMacOsCapabilityBrokerSocketPathForTest(): void {
  testSocketPath = undefined;
}

function socketPath(): string {
  return testSocketPath ?? macOsCapabilityBrokerSocketPath();
}

function unavailable(error: AssistantPluginError, path: string): AssistantPluginError {
  if (!/^EXTERNAL_PLUGIN_(SOCKET_UNAVAILABLE|TIMEOUT|TRANSPORT_FAILED|PROTOCOL_ERROR)$/.test(error.code)) return error;
  return new AssistantPluginError(
    'PLUGIN_MACOS_CAPABILITY_BROKER_UNAVAILABLE',
    `Stable Forge macOS capability broker is unavailable at ${path}. Install or restore Forge Desktop Operator instead of granting macOS permissions to Runtime or release-specific helpers.`,
    { retryable: true, details: { socketPath: path, providerPluginId: BROKER_PLUGIN_ID, causeCode: error.code } },
  );
}

async function verifyBrokerIdentity(path: string, timeoutMs: number, requestedAction?: string): Promise<void> {
  const handshake = await callExternalUnixSocket({
    socketPath: path,
    requestId: `macos-broker-handshake:${randomUUID()}`,
    method: 'handshake',
    timeoutMs: Math.min(timeoutMs, 2_000),
    maxResponseBytes: 64 * 1024,
  });
  if (handshake.pluginId !== BROKER_PLUGIN_ID || handshake.protocolVersion !== BROKER_PROTOCOL_VERSION) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_IDENTITY_MISMATCH',
      'Stable macOS capability broker returned an unexpected provider identity.',
      { retryable: false, details: { expectedPluginId: BROKER_PLUGIN_ID, expectedProtocolVersion: BROKER_PROTOCOL_VERSION } },
    );
  }
  const capabilities = Array.isArray(handshake.internalCapabilities)
    ? handshake.internalCapabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const actions = Array.isArray(handshake.browserAutomationActions)
    ? handshake.browserAutomationActions.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const browserProtocolVersion = handshake.browserAutomationProtocolVersion;
  if (!capabilities.includes(BROWSER_AUTOMATION_CAPABILITY)
    || browserProtocolVersion !== BROWSER_AUTOMATION_PROTOCOL_VERSION
    || (requestedAction && !actions.includes(requestedAction))) {
    throw new AssistantPluginError(
      'PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED',
      requestedAction
        ? `Installed Forge Desktop Operator does not declare required browser automation action ${requestedAction}.`
        : 'Installed Forge Desktop Operator does not declare the required browser automation capability.',
      {
        retryable: false,
        details: {
          requiredCapability: BROWSER_AUTOMATION_CAPABILITY,
          requiredBrowserAutomationProtocolVersion: BROWSER_AUTOMATION_PROTOCOL_VERSION,
          ...(requestedAction ? { requiredAction: requestedAction } : {}),
          declaredCapability: capabilities.includes(BROWSER_AUTOMATION_CAPABILITY),
          declaredBrowserAutomationProtocolVersion: typeof browserProtocolVersion === 'number' ? browserProtocolVersion : null,
          declaredActionCount: actions.length,
        },
      },
    );
  }
}

export async function callMacOsCapabilityBroker(
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const path = socketPath();
  try {
    const requestedAction = typeof params.action === 'string' ? params.action : undefined;
    await verifyBrokerIdentity(path, timeoutMs, requestedAction);
    return await callExternalUnixSocket({
      socketPath: path,
      requestId: `macos-broker:${randomUUID()}`,
      method: 'macos_browser_automation',
      params,
      timeoutMs,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (error instanceof AssistantPluginError) throw unavailable(error, path);
    throw error;
  }
}
