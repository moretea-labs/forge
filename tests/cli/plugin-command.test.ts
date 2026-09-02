import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { externalPluginListItem, installerNextSteps, officialPluginCatalogItems, pluginCatalogCompatibility, registrationFrom } from '../../src/cli/commands/plugin';

describe('official plugin catalog', () => {
  test('includes the pinned Forge Figma Bridge release', () => {
    const registry = JSON.parse(readFileSync(resolve(import.meta.dir, '../../assets/plugin-registry.v1.json'), 'utf8')) as { plugins: Array<Record<string, unknown>> };
    const figma = registry.plugins.find((entry) => entry.id === 'figma');
    expect(figma).toMatchObject({
      id: 'figma', version: '0.3.0', ref: 'v0.3.0', installer: 'forge-plugin-install.mjs',
      repository: 'https://github.com/moretea-labs/forge-figma-bridge.git', platforms: ['darwin'],
    });
  });

  test('requires the Desktop Operator provider identity to match the catalog release', () => {
    const desktop = officialPluginCatalogItems('darwin').find((entry) => entry.id === 'desktop_operator');
    expect(desktop).toMatchObject({
      id: 'desktop_operator',
      version: '0.3.1',
      providerVersion: '0.3.1',
      ref: 'v0.3.1',
      protocolVersion: '1.0',
      compatible: true,
    });
    expect(pluginCatalogCompatibility(desktop!, 'darwin')).toEqual({ compatible: true });

    const registration = registrationFrom({
      providerInstall: {
        kind: 'desktop_operator',
        pluginVersion: '0.3.1',
        protocolVersion: '1.0',
        socketPath: '/tmp/forge-desktop-operator.sock',
        launchAgentLabel: 'com.moretea.forge.desktop-operator',
        expectedProgramContains: 'Forge Desktop Operator.app',
      },
    }, desktop!);
    expect(registration.pluginVersion).toBe('0.3.1');
    expect(() => registrationFrom({
      providerInstall: {
        kind: 'desktop_operator',
        pluginVersion: '0.2.0',
        protocolVersion: '1.0',
        socketPath: '/tmp/forge-desktop-operator.sock',
        launchAgentLabel: 'com.moretea.forge.desktop-operator',
        expectedProgramContains: 'Forge Desktop Operator.app',
      },
    }, desktop!)).toThrow(/PLUGIN_INSTALLER_PROVIDER_VERSION_MISMATCH/);
    const verifiedPackageRegistration = registrationFrom({
      providerInstall: {
        kind: 'desktop_operator',
        pluginVersion: '0.2.0',
        protocolVersion: '1.0',
        socketPath: '/tmp/forge-desktop-operator.sock',
        launchAgentLabel: 'com.moretea.forge.desktop-operator',
        expectedProgramContains: 'Forge Desktop Operator.app',
      },
    }, desktop!, { packageIdentityVerified: true });
    expect(verifiedPackageRegistration.pluginVersion).toBe('0.3.1');
  });

  test('controller-level listing does not report repository-scoped plugins as missing', () => {
    const item = externalPluginListItem('/tmp/forge-plugin-list-test', {
      pluginId: 'repository_plugin',
      pluginVersion: '1.0.0',
      provider: 'test-provider',
      enabled: true,
      scope: 'repository',
      transport: { kind: 'managed_cli', executable: '/usr/bin/false', args: [] },
    } as never);
    expect(item).toMatchObject({
      pluginId: 'repository_plugin',
      scope: 'repository',
      healthScope: 'repository_context_required',
    });
    expect(item).not.toHaveProperty('health');
  });

  test('bounds installer follow-up instructions before printing them', () => {
    expect(installerNextSteps({ nextSteps: ['  Open Figma\nDesktop  ', 4, '', ...Array.from({ length: 20 }, (_, i) => `step-${i}`)] })).toEqual([
      'Open Figma Desktop', 'step-0', 'step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6', 'step-7', 'step-8',
    ]);
    expect(installerNextSteps({ nextSteps: 'not-an-array' })).toEqual([]);
  });
});
