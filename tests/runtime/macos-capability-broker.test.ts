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
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';

const roots: string[] = [];
const servers: Server[] = [];
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

async function startProvider(socketPath: string, input: { actions: string[]; calls: string[] }): Promise<void> {
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params?: Record<string, unknown> };
      input.calls.push(request.method);
      const result = request.method === 'handshake'
        ? {
            pluginId: 'desktop_operator',
            protocolVersion: '1.0',
            internalCapabilities: ['macos_browser_automation.v1'],
            browserAutomationProtocolVersion: 1,
            browserAutomationActions: input.actions,
          }
        : { acceptedAction: request.params?.action, value: 'ok' };
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

    const provider = createDesktopOperatorComputerProvider({ resolveControllerHome: () => controllerHome });
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

    const provider = createDesktopOperatorComputerProvider({ resolveControllerHome: () => controllerHome });
    await expect(provider.executeBrowserAutomation({ action: 'list_tabs', product: 'chrome' }, 2_000))
      .rejects.toThrow('PLUGIN_COMPUTER_PROVIDER_DISABLED');
  });
});
