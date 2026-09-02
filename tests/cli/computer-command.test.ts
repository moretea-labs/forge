import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildComputerCommand,
  formatComputerStatus,
  readComputerStatus,
  runComputerUninstall,
} from '../../src/cli/commands/computer';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { installExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-computer-command-'));
  roots.push(root);
  return join(root, 'controller');
}

function registerProvider(home: string, options: { version?: string; enabled?: boolean } = {}) {
  return installExternalPluginRegistration(home, createDesktopOperatorRegistrationInput({
    socketPath: join(home, 'missing-desktop-operator.sock'),
    launchAgentLabel: 'com.moretea.forge.desktop-operator',
    expectedProgramContains: 'Forge Desktop Operator.app',
    pluginVersion: options.version ?? '0.3.0',
    protocolVersion: '1.0',
    enabled: options.enabled,
  }));
}

describe('Computer product facade', () => {
  test('projects an uninstalled provider as Computer without inventing provider state', () => {
    const home = controllerHome();
    const status = readComputerStatus({ controllerHome: home });
    expect(status).toMatchObject({
      schemaVersion: 1,
      product: 'computer',
      installed: false,
      ready: false,
      provider: {
        implementation: 'Forge Desktop Operator',
        pluginId: 'desktop_operator',
        catalogVersion: '0.3.0',
        enabled: false,
        releaseIndependent: true,
        health: { state: 'not_installed', ready: false, probed: false },
      },
    });
    expect(status.supported).toBe(process.platform === 'darwin');
  });

  test('projects trusted registration and pinned-release drift without making provider identity the product', () => {
    const home = controllerHome();
    registerProvider(home, { version: '0.2.3', enabled: false });
    const status = readComputerStatus({ controllerHome: home });
    expect(status.product).toBe('computer');
    expect(status.installed).toBe(true);
    expect(status.provider).toMatchObject({
      implementation: 'Forge Desktop Operator',
      pluginId: 'desktop_operator',
      installedVersion: '0.2.3',
      catalogVersion: '0.3.0',
      protocolVersion: '1.0',
      enabled: false,
      updateAvailable: true,
      releaseIndependent: true,
    });
    expect(formatComputerStatus(status)).not.toContain('desktop_operator');
  });

  test('fails closed instead of forgetting a registered native provider when its uninstaller is missing', () => {
    const home = controllerHome();
    registerProvider(home);
    expect(() => runComputerUninstall({ controllerHome: home })).toThrow(/COMPUTER_PROVIDER_UNINSTALLER_MISSING/);
    expect(readComputerStatus({ controllerHome: home }).installed).toBe(true);
  });

  test('keeps uninstall idempotent when no provider registration or package exists', () => {
    const home = controllerHome();
    expect(runComputerUninstall({ controllerHome: home })).toEqual({ removed: false, purged: false });
    expect(runComputerUninstall({ controllerHome: home, purge: true })).toEqual({ removed: false, purged: true });
  });

  test('exposes the complete Computer management command surface', () => {
    expect(buildComputerCommand().commands.map((command) => command.name()).sort()).toEqual([
      'doctor',
      'setup',
      'status',
      'uninstall',
      'update',
    ]);
  });
});
