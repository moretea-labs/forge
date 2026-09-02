import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  callMacOsCapabilityBroker,
  resetMacOsCapabilityBrokerSocketPathForTest,
  setMacOsCapabilityBrokerSocketPathForTest,
} from '../../src/runtime/plugins/macos-capability-broker';
import { createDesktopOperatorComputerProvider } from '../../adapters/computer/desktop-operator-provider';
import { computerProviderRegistrationSnapshot } from '../../packages/plugin-runtime/computer/index';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { getExternalPluginRegistration, installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';

const roots: string[] = [];
const servers: Server[] = [];
function registrationLookup(controllerHome: string) {
  return (providerPluginId: string) => {
    const registration = getExternalPluginRegistration(controllerHome, providerPluginId);
    return registration ? computerProviderRegistrationSnapshot(registration) : undefined;
  };
}
afterEach(async () => {
  resetMacOsCapabilityBrokerSocketPathForTest();
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
  input: { actions: string[]; calls: string[]; mode?: ProviderFixtureMode },
): Promise<void> {
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params?: Record<string, unknown> };
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
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
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


  test('prefers provider-neutral computer_execute when the provider advertises the generic Computer capability', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    const result = await callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000);
    expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok', legacyProtocolVersionLeaked: false });
    expect(calls).toEqual(['handshake', 'computer_execute']);
  });

  test('falls back to legacy only when the generic browser capability is absent', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic_missing_browser' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    await callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000);
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
  });

  test('fails closed on a malformed generic Computer advertisement instead of downgrading to legacy', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic_malformed' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    await expect(callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000))
      .rejects.toThrow('PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED');
    expect(calls).toEqual(['handshake']);
  });

  test('fails closed on an explicitly unsupported generic Computer protocol instead of downgrading to legacy', async () => {
    if (process.platform === 'win32') return;
    const socketPath = fixture();
    const calls: string[] = [];
    await startProvider(socketPath, { actions: ['metadata', 'list_tabs'], calls, mode: 'generic_unsupported' });
    setMacOsCapabilityBrokerSocketPathForTest(socketPath);

    await expect(callMacOsCapabilityBroker({ action: 'list_tabs', product: 'chrome', protocolVersion: 1 }, 2_000))
      .rejects.toThrow('PLUGIN_MACOS_CAPABILITY_BROKER_CAPABILITY_UNSUPPORTED');
    expect(calls).toEqual(['handshake']);
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
    const result = await provider.executeBrowserAutomation({ action: 'list_tabs', product: 'chrome' }, 2_000);
    expect(result).toMatchObject({ acceptedAction: 'list_tabs', value: 'ok' });
    expect(calls).toEqual(['handshake', 'macos_browser_automation']);
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
    await expect(provider.executeBrowserAutomation({ action: 'list_tabs', product: 'chrome' }, 2_000))
      .rejects.toThrow('PLUGIN_COMPUTER_PROVIDER_DISABLED');
  });
});
