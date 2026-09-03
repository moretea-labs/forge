import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { externalPluginListItem, installerNextSteps, officialPluginCatalogItems, pluginCatalogCompatibility, registrationFrom, trustedExternalPluginCatalogEntry } from '../../src/cli/commands/plugin';
import { assertExternalPluginRepositoryTrusted, assertFirstPartyPluginRepositoryTrusted, trustExternalPluginRepository, untrustExternalPluginRepository } from '../../src/runtime/plugins/catalog-trust';

describe('official plugin catalog', () => {
  test('includes the pinned Forge Figma Bridge release', () => {
    const registry = JSON.parse(readFileSync(resolve(import.meta.dir, '../../assets/plugin-registry.v1.json'), 'utf8')) as { plugins: Array<Record<string, unknown>> };
    const figma = registry.plugins.find((entry) => entry.id === 'figma');
    expect(figma).toMatchObject({
      id: 'figma', version: '0.3.0', ref: 'v0.3.0', installer: 'forge-plugin-install.mjs',
      repository: 'https://github.com/moretea-labs/forge-figma-bridge.git', platforms: ['darwin'],
    });
  });

  test('advertises provider-neutral Computer capabilities for Desktop Operator bootstrap resolution', () => {
    const desktop = officialPluginCatalogItems('darwin').find((entry) => entry.id === 'desktop_operator');
    expect(desktop?.semanticCapabilities).toEqual([
      'computer.observe.v1', 'computer.input.v1', 'computer.capture.v1', 'computer.browser_automation.v1',
    ]);
  });

  test('requires the Desktop Operator provider identity to match the catalog release', () => {
    const desktop = officialPluginCatalogItems('darwin').find((entry) => entry.id === 'desktop_operator');
    expect(desktop).toMatchObject({
      id: 'desktop_operator',
      version: '0.3.2',
      providerVersion: '0.3.2',
      ref: 'v0.3.2',
      protocolVersion: '1.0',
      compatible: true,
    });
    expect(pluginCatalogCompatibility(desktop!, 'darwin')).toEqual({ compatible: true });

    const registration = registrationFrom({
      providerInstall: {
        kind: 'desktop_operator',
        pluginVersion: '0.3.2',
        protocolVersion: '1.0',
        socketPath: '/tmp/forge-desktop-operator.sock',
        launchAgentLabel: 'com.moretea.forge.desktop-operator',
        expectedProgramContains: 'Forge Desktop Operator.app',
      },
    }, desktop!);
    expect(registration.pluginVersion).toBe('0.3.2');
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
    expect(verifiedPackageRegistration.pluginVersion).toBe('0.3.2');
  });


  test('keeps first-party trust in explicit packaged policy instead of command source semantics', () => {
    const policyPath = resolve(import.meta.dir, '../../assets/plugin-trust-policy.v1.json');
    expect(assertFirstPartyPluginRepositoryTrusted('https://github.com/moretea-labs/example-plugin.git', policyPath)).toBe('https://github.com/moretea-labs/example-plugin.git');
    expect(() => assertFirstPartyPluginRepositoryTrusted('https://github.com/other-org/example-plugin.git', policyPath)).toThrow(/PLUGIN_CATALOG_UNTRUSTED_REPOSITORY/);
    const commandSource = readFileSync(resolve(import.meta.dir, '../../src/cli/commands/plugin.ts'), 'utf8');
    expect(commandSource).not.toContain("startsWith('https://github.com/moretea-labs/');");
  });

  test('requires exact Controller Home trust for non-first-party catalog repositories', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-plugin-trust-'));
    try {
      const repository = 'https://github.com/example-vendor/portable-plugin.git';
      expect(() => assertExternalPluginRepositoryTrusted(home, repository)).toThrow(/PLUGIN_EXTERNAL_REPOSITORY_TRUST_REQUIRED/);
      trustExternalPluginRepository(home, repository);
      expect(assertExternalPluginRepositoryTrusted(home, repository)).toBe(repository);
      expect(() => assertExternalPluginRepositoryTrusted(home, 'https://github.com/example-vendor/another-plugin.git')).toThrow(/PLUGIN_EXTERNAL_REPOSITORY_TRUST_REQUIRED/);

      const catalogPath = join(home, 'catalog.json');
      writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, plugins: [{
        id: 'portable_plugin', name: 'Portable Plugin', version: '1.0.0', description: 'fixture', repository,
        ref: 'v1.0.0', installer: 'forge-plugin-install.mjs', platforms: ['darwin', 'linux'],
      }] }), 'utf8');
      expect(trustedExternalPluginCatalogEntry('portable_plugin', catalogPath, home)).toMatchObject({ id: 'portable_plugin', repository });
      untrustExternalPluginRepository(home, repository);
      expect(() => trustedExternalPluginCatalogEntry('portable_plugin', catalogPath, home)).toThrow(/PLUGIN_EXTERNAL_REPOSITORY_TRUST_REQUIRED/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
