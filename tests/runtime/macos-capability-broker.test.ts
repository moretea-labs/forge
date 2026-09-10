import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  callMacOsCapabilityBroker,
  resetMacOsCapabilityBrokerSocketPathForTest,
  setMacOsCapabilityBrokerSocketPathForTest,
} from '../../src/runtime/plugins/macos-capability-broker';
import { createDesktopOperatorComputerProvider, desktopOperatorActionForComputerRequest } from '../../adapters/computer/desktop-operator-provider';
import {
  COMPUTER_BROWSER_AUTOMATION_CAPABILITY,
  COMPUTER_CAPTURE_CAPABILITY,
  COMPUTER_INPUT_CAPABILITY,
  COMPUTER_OBSERVE_CAPABILITY,
} from '../../packages/protocols/computer/index';
import { computerProviderRegistrationSnapshot } from '../../packages/plugin-runtime/computer/index';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { getExternalPluginRegistration, installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';

const roots: string[] = [];
const servers: Server[] = [];
const providerSockets = new Set<Socket>();
function registrationLookup(controllerHome: string) {
  return (providerPluginId: string) => {
    const registration = getExternalPluginRegistration(controllerHome, providerPluginId);
    return registration ? computerProviderRegistrationSnapshot(registration) : undefined;
  };
}
afterEach(async () => {
  resetMacOsCapabilityBrokerSocketPathForTest();
  for (const socket of providerSockets) socket.destroy();
  providerSockets.clear();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-macos-broker-'));
  roots.push(root);
  return join(root, 'desktop-operator.sock');
}

type ProviderFixtureMode = 'legacy' | 'generic' | 'generic_missing_browser' | 'generic_malformed' | 'generic_unsupported';

async function startProvider(
  socketPath: string,
  input: { actions: string[]; calls: string[]; mode?: ProviderFixtureMode; connections?: { count: number }; closeAfterFirstHandshake?: { done: boolean } },
): Promise<void> {
  const server = createServer((socket) => {
    providerSockets.add(socket);
    input.connections && (input.connections.count += 1);
    socket.once('close', () => providerSockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
        input.calls.push(request.method);
      const mode = input.mode ?? 'legacy';
      let result: Record<string, unknown>;
      if (request.method === 'handshake') {
        result = {
          pluginId: 'desktop_operator',
          pluginVersion: mode === 'legacy' ? '0.2.3' : '0.3.0',
          protocolVersion: '1.0',
          internalCapabilities: ['macos_browser_automation.v1'],
          browserAutomationProtocolVersion: 1,
          browserAutomationActions: input.actions,
        };
        if (mode === 'generic') {
          result.computerCapabilities = [{
            capabilityId: 'computer.browser_automation.v1',
            protocolVersion: 1,
            method: 'computer_execute',
            actions: input.actions,
          }];
        } else if (mode === 'generic_missing_browser') {
          result.computerCapabilities = [{
            capabilityId: 'computer.observe.v1',
            protocolVersion: 1,
            method: 'execute',
            actions: ['desktop_observe'],
          }];
        } else if (mode === 'generic_malformed') {
          result.computerCapabilities = 'malformed';
        } else if (mode === 'generic_unsupported') {
          result.computerCapabilities = [{
            capabilityId: 'computer.browser_automation.v1',
            protocolVersion: 2,
            method: 'computer_execute',
            actions: input.actions,
          }];
        }
      } else {
        const params = request.params ?? {};
        const genericArguments = params.arguments && typeof params.arguments === 'object'
          ? params.arguments as Record<string, unknown>
          : undefined;
        result = {
          acceptedAction: genericArguments?.action ?? params.action,
          value: 'ok',
          legacyProtocolVersionLeaked: genericArguments ? Object.hasOwn(genericArguments, 'protocolVersion') : false,
        };
      }
        const response = `${JSON.stringify({ id: request.id, ok: true, result })}\n`;
        if (request.method === 'handshake' && input.closeAfterFirstHandshake && !input.closeAfterFirstHandshake.done) {
          input.closeAfterFirstHandshake.done = true;
          socket.end(response);
        } else {
          socket.write(response);
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
}

describe('macOS capability broker handshake', () => {
  test('executes only after the provider declares the requested browser action', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    const result = await callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000);
    expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok' });
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
  });


  test('uses explicit Browser compatibility even when an obsolete generic Browser capability is advertised', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    const result = await callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000);
    expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok', legacyProtocolVersionLeaked: false });
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
  });

  test('uses explicit Browser compatibility when the obsolete generic Browser capability is absent', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic_missing_browser' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    await callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000);
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
  });

  test('ignores malformed obsolete generic Browser advertisement and uses explicit compatibility authority', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic_malformed' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    const result = await callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000);
    expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok' });
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
  });

  test('ignores unsupported obsolete generic Browser protocol and uses explicit compatibility authority', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic_unsupported' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    const result = await callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000);
    expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok' });
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
  });

  test('rejects an installed provider missing list_tabs before attempting browser automation', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata'], calls });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    await expect(callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000))
      .rejects.toThrow('PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED');
    expect(calls).toEqual(['handshake']);
  });

  test('rejects undeclared trusted_input instead of discovering the mismatch after dispatch', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    await expect(callMacOsCapabilityBroker({ action: 'trusted_input', product: 'chrome', protocolVersion: 1 }, 2_000))
      .rejects.toThrow('PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED');
    expect(calls).toEqual(['handshake']);
  });

  test('uses trusted registration as the Computer provider endpoint authority', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'forge-computer-registration-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const socketPath = join(root, 'registered-desktop-operator.sock');
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls });
    installExternalPluginRegistration(controllerHome, createDesktopOperatorRegistrationInput({
      socketPath,
      pluginVersion: '0.2.3',
      protocolVersion: '1.0',
    }));

    const provider = createDesktopOperatorComputerProvider({ lookupRegistration: registrationLookup(controllerHome) });
    const result = await provider.executeBrowserCompatibility({ action: 'list_tabs', product: 'chrome' }, 2_000);
    expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok' });
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
  });

  test('reuses one negotiated live provider binding across warm Browser compatibility actions', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    const connections = { count: 0 };
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic', connections });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    const provider = createDesktopOperatorComputerProvider({ legacyFallback: 'unregistered_v0_2' });
    try {
      await provider.executeBrowserCompatibility({ action: 'list_tabs', product: 'chrome' }, 2_000);
      await provider.executeBrowserCompatibility({ action: 'metadata', product: 'chrome' }, 2_000);
      expect(calls).toEqual(['handshake', 'macos_browser_automation', 'macos_browser_automation']);
      expect(connections.count).toBe(1);
    } finally {
      provider.dispose?.();
    }
  });

  test('does not dispatch an action after the provider connection changes until identity is renegotiated', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    const connections = { count: 0 };
    const closeAfterFirstHandshake = { done: false };
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic', connections, closeAfterFirstHandshake });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    const provider = createDesktopOperatorComputerProvider({ legacyFallback: 'unregistered_v0_2' });
    try {
      await expect(provider.executeBrowserCompatibility({ action: 'list_tabs', product: 'chrome' }, 2_000))
        .rejects.toThrow('renegotiate before executing the action');
      expect(calls).toEqual(['handshake']);
      expect(connections.count).toBe(2);

      const result = await provider.executeBrowserCompatibility({ action: 'list_tabs', product: 'chrome' }, 2_000);
      expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok' });
      expect(calls).toEqual(['handshake', 'handshake', 'macos_browser_automation']);
      expect(connections.count).toBe(2);
    } finally {
      provider.dispose?.();
    }
  });

  test('invalidates the negotiated provider binding when registration revision changes', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'forge-computer-revision-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    const socketPath = join(root, 'registered-desktop-operator.sock');
    const calls: string[] = [];
    const connections = { count: 0 };
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic', connections });
    installExternalPluginRegistration(controllerHome, createDesktopOperatorRegistrationInput({
      socketPath,
      pluginVersion: '0.3.0',
      protocolVersion: '1.0',
    }));
    const installed = getExternalPluginRegistration(controllerHome, 'desktop_operator');
    if (!installed) throw new Error('fixture registration missing');
    const initial = computerProviderRegistrationSnapshot(installed);
    let current = initial;
    const provider = createDesktopOperatorComputerProvider({ lookupRegistration: () => current });
    try {
      await provider.executeBrowserCompatibility({ action: 'list_tabs', product: 'chrome' }, 2_000);
      current = { ...initial, revision: initial.revision + 1 };
      await provider.executeBrowserCompatibility({ action: 'metadata', product: 'chrome' }, 2_000);
      expect(calls).toEqual(['handshake', 'macos_browser_automation', 'handshake', 'macos_browser_automation']);
      expect(connections.count).toBe(2);
    } finally {
      provider.dispose?.();
    }
  });

  test('fails closed when the trusted Computer provider registration is disabled', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'forge-computer-disabled-'));
    roots.push(root);
    const controllerHome = join(root, 'controller');
    installExternalPluginRegistration(controllerHome, createDesktopOperatorRegistrationInput({
      socketPath: join(root, 'disabled-desktop-operator.sock'),
      pluginVersion: '0.2.3',
      protocolVersion: '1.0',
      enabled: false,
    }));

    const provider = createDesktopOperatorComputerProvider({ lookupRegistration: registrationLookup(controllerHome) });
    await expect(provider.executeBrowserCompatibility({ action: 'list_tabs', product: 'chrome' }, 2_000))
      .rejects.toThrow('PLUGIN_COMPUTER_PROVIDER_DISABLED');
  });

  test('maps typed Computer desktop semantics onto the existing Desktop Operator action contract', () => {
    expect(desktopOperatorActionForComputerRequest({
      capability: COMPUTER_OBSERVE_CAPABILITY,
      action: 'observe',
      interactionId: 'interaction-1',
      maxDepth: 4,
      rootSelector: { role: 'AXButton', title: 'Continue' },
    })).toEqual({
      actionId: 'desktop_observe',
      args: { interaction_id: 'interaction-1', max_depth: 4, root_selector: { role: 'AXButton', title: 'Continue' } },
    });
    expect(desktopOperatorActionForComputerRequest({
      capability: COMPUTER_INPUT_CAPABILITY,
      action: 'type_text',
      interactionId: 'interaction-1',
      selector: { identifier: 'prompt' },
      text: 'hello',
      replace: true,
    })).toEqual({
      actionId: 'desktop_type_text',
      args: { interaction_id: 'interaction-1', selector: { identifier: 'prompt' }, text: 'hello', replace: true },
    });
    expect(desktopOperatorActionForComputerRequest({
      capability: COMPUTER_CAPTURE_CAPABILITY,
      action: 'screenshot',
      scope: 'window',
      windowId: 42,
    })).toEqual({ actionId: 'desktop_screenshot', args: { scope: 'window', window_id: 42 } });
  });
});
