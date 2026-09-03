import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { externalPluginListItem, installTrustedExternalPlugin, installerNextSteps, officialPluginCatalogItems, pluginCatalogCompatibility, registrationFrom, trustedExternalPluginCatalogEntry } from '../../src/cli/commands/plugin';
import { assertExternalPluginRepositoryTrusted, assertFirstPartyPluginRepositoryTrusted, trustExternalPluginRepository, untrustExternalPluginRepository } from '../../src/runtime/plugins/catalog-trust';
import { getExternalPluginRegistration } from '../../src/runtime/plugins/external-registration';

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

  test('installs an explicitly trusted third-party catalog package without source changes', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-plugin-install-home-'));
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'forge-plugin-install-fixture-'));
    const packageRepo = join(fixtureRoot, 'portable-plugin.git');
    const repository = 'https://plugins.example.test/portable-plugin.git';
    const catalogPath = join(fixtureRoot, 'catalog.json');
    const commandSourcePath = resolve(import.meta.dir, '../../src/cli/commands/plugin.ts');
    const commandSourceBefore = readFileSync(commandSourcePath, 'utf8');
    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const gitConfigPath = join(fixtureRoot, 'gitconfig');
    try {
      mkdirSync(packageRepo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: packageRepo });
      execFileSync('git', ['config', 'user.email', 'portable-fixture@example.invalid'], { cwd: packageRepo });
      execFileSync('git', ['config', 'user.name', 'Portable Fixture'], { cwd: packageRepo });
      writeFileSync(join(packageRepo, 'forge-plugin.json'), JSON.stringify({ id: 'portable_plugin', version: '1.0.0' }));
      writeFileSync(join(packageRepo, 'provider.mjs'), `
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw.trim());
console.log(JSON.stringify({ schemaVersion: 1, type: 'handshake', protocolVersion: 1, pluginId: 'portable_plugin', helperVersion: '1.0.0', capabilities: [] }));
const result = request.actionId === 'manifest'
  ? { id: 'portable_plugin', name: 'Portable Plugin', version: '1.0.0', protocolVersion: '1.0', mode: 'managed_cli', scope: 'controller', provider: 'fixture-vendor', capabilities: [], actions: [] }
  : request.actionId === 'health' ? { state: 'ready' } : {};
console.log(JSON.stringify({ schemaVersion: 1, type: 'result', requestId: request.requestId, ok: true, result }));
`.trimStart());
      writeFileSync(join(packageRepo, 'forge-plugin-install.mjs'), `
import { fileURLToPath } from 'url';
console.log(JSON.stringify({
  schemaVersion: 1,
  registration: {
    pluginId: 'portable_plugin',
    displayName: 'Portable Plugin',
    provider: 'fixture-vendor',
    pluginVersion: '1.0.0',
    protocolVersion: '1.0',
    scope: 'controller',
    enabled: true,
    transport: {
      kind: 'managed_cli_json',
      runtimeExecutable: process.execPath,
      helperPath: fileURLToPath(new URL('./provider.mjs', import.meta.url)),
      healthTimeoutMs: 2_000,
      actionTimeoutMs: 2_000,
    },
    permissions: [],
    capabilities: [],
    actions: [],
  },
}));
`.trimStart());
      execFileSync('git', ['add', '.'], { cwd: packageRepo });
      execFileSync('git', ['commit', '-qm', 'portable plugin fixture'], { cwd: packageRepo });
      execFileSync('git', ['tag', 'v1.0.0'], { cwd: packageRepo });

      writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, plugins: [{
        id: 'portable_plugin', name: 'Portable Plugin', version: '1.0.0', description: 'trusted fixture', repository,
        ref: 'v1.0.0', installer: 'forge-plugin-install.mjs', platforms: [process.platform],
      }] }));

      expect(() => installTrustedExternalPlugin('portable_plugin', catalogPath, home)).toThrow(/PLUGIN_EXTERNAL_REPOSITORY_TRUST_REQUIRED/);
      trustExternalPluginRepository(home, repository);
      writeFileSync(gitConfigPath, `[url "${pathToFileURL(`${fixtureRoot}/`).toString()}"]\n  insteadOf = https://plugins.example.test/\n`);
      process.env.GIT_CONFIG_GLOBAL = gitConfigPath;

      const installed = installTrustedExternalPlugin('portable_plugin', catalogPath, home);
      expect(installed).toMatchObject({ pluginId: 'portable_plugin', version: '1.0.0', enabled: true, health: { state: 'ready', ready: true } });
      expect(getExternalPluginRegistration(home, 'portable_plugin')).toMatchObject({
        pluginId: 'portable_plugin', provider: 'fixture-vendor', pluginVersion: '1.0.0', enabled: true,
        transport: { kind: 'managed_cli_json' },
      });
      expect(readFileSync(commandSourcePath, 'utf8')).toBe(commandSourceBefore);
    } finally {
      if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
      rmSync(home, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
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
