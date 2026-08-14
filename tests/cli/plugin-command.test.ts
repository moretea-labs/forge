import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { externalPluginListItem, installerNextSteps, officialPluginCatalogItems, pluginCatalogCompatibility } from '../../src/cli/commands/plugin';

describe('official plugin catalog', () => {
  test('includes the pinned Forge Figma Bridge release', () => {
    const registry = JSON.parse(readFileSync(resolve(import.meta.dir, '../../assets/plugin-registry.v1.json'), 'utf8')) as { plugins: Array<Record<string, unknown>> };
    const figma = registry.plugins.find((entry) => entry.id === 'figma');
    expect(figma).toMatchObject({
      id: 'figma', version: '0.1.1', ref: 'v0.1.1', installer: 'forge-plugin-install.mjs',
      repository: 'https://github.com/moretea-labs/forge-figma-bridge.git', platforms: ['darwin'],
    });
  });

  test('does not advertise a pinned provider-version mismatch as compatible', () => {
    const desktop = officialPluginCatalogItems('darwin').find((entry) => entry.id === 'desktop_operator');
    expect(desktop).toMatchObject({
      id: 'desktop_operator',
      version: '0.2.1',
      providerVersion: '0.2.0',
      compatible: false,
    });
    expect(desktop?.reason).toContain('catalog version 0.2.1');
    expect(desktop?.reason).toContain('provider version 0.2.0');
    expect(pluginCatalogCompatibility({ ...desktop!, providerVersion: '0.2.1' }, 'darwin')).toEqual({ compatible: true });
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
