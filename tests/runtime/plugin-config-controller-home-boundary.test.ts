import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  controllerPluginConfigPath,
  migrateLegacyControllerPluginConfigs,
  readControllerPluginConfig,
  writeControllerPluginConfig,
  type LegacyPluginConfigRepository,
} from '../../src/runtime/plugins/config-store';
import { createFirstPartyPluginAdapterMap } from '../../src/runtime/plugins/first-party-registry';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}
function legacyConfig(repositoryRoot: string, name: string, value: unknown, folder = '.forge'): string {
  const directory = join(repositoryRoot, folder, 'plugins');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function normalize(pluginId: string, value: unknown): object {
  if (pluginId === 'browser') return createFirstPartyPluginAdapterMap().get('browser')!.normalizeLegacyConfig!(value);
  return value as object;
}
function migrate(home: string, repositories: LegacyPluginConfigRepository[]) {
  return migrateLegacyControllerPluginConfigs(home, normalize, repositories);
}

describe('Controller global plugin config authority', () => {
  test('migrates all registered repository candidates in one pass and retires only migrated plugin copies', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const b = root('forge-plugin-b-');
    const first = legacyConfig(a, 'browser.json', { schemaVersion: 1, enabled: true });
    const second = legacyConfig(b, 'browser.json', { enabled: true, schemaVersion: 1 }, '.repo-harness');
    const unrelated = legacyConfig(a, 'github.json', { enabled: true });
    const repositories = [{ repoId: 'repo-a', canonicalRoot: a }, { repoId: 'repo-b', canonicalRoot: b }];
    expect(migrate(home, repositories)).toContain('browser');
    expect(readControllerPluginConfig<Record<string, unknown>>(home, 'browser')).toMatchObject({
      schemaVersion: 3, enabled: true, browserMode: 'attach_preferred', profileMode: 'repo_local',
    });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    const saved = readFileSync(controllerPluginConfigPath(home, 'browser'), 'utf8');
    expect(migrate(home, repositories)).toEqual([]);
    expect(readFileSync(controllerPluginConfigPath(home, 'browser'), 'utf8')).toBe(saved);
  });

  test('conflicting active Browser identities are preserved without selecting one', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const b = root('forge-plugin-b-');
    const first = legacyConfig(a, 'browser.json', { schemaVersion: 3, enabled: true, browserMode: 'isolated' });
    const second = legacyConfig(b, 'browser.json', { schemaVersion: 3, enabled: true, browserMode: 'managed_persistent' });
    expect(migrate(home, [{ repoId: 'a', canonicalRoot: a }, { repoId: 'b', canonicalRoot: b }])).not.toContain('browser');
    expect(readControllerPluginConfig(home, 'browser')).toBeUndefined();
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  test('selects the only enabled config over disabled historical copies', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const b = root('forge-plugin-b-');
    const first = legacyConfig(a, 'google-calendar.json', { schemaVersion: 1, enabled: true, provider: 'mock' });
    const second = legacyConfig(b, 'google-calendar.json', { schemaVersion: 1, enabled: false, provider: 'mock' });
    expect(migrate(home, [{ repoId: 'a', canonicalRoot: a }, { repoId: 'b', canonicalRoot: b }])).toContain('google_calendar');
    expect(readControllerPluginConfig<Record<string, unknown>>(home, 'google_calendar')?.enabled).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  test('conflicting App Store Connect identities stay intact until a global configure', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const b = root('forge-plugin-b-');
    const first = legacyConfig(a, 'app-store-connect.json', { schemaVersion: 1, enabled: true, issuerId: 'issuer-a' });
    const second = legacyConfig(b, 'app-store-connect.json', { schemaVersion: 1, enabled: true, issuerId: 'issuer-b' });
    const repositories = [{ repoId: 'a', canonicalRoot: a }, { repoId: 'b', canonicalRoot: b }];
    expect(migrate(home, repositories)).not.toContain('app_store_connect');
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    writeControllerPluginConfig(home, 'app_store_connect', { schemaVersion: 1, enabled: true, issuerId: 'chosen' }, repositories);
    expect(readControllerPluginConfig<Record<string, unknown>>(home, 'app_store_connect')?.issuerId).toBe('chosen');
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  test('legacy Controller repository config and legacy global App Store profile migrate to one path', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const managed = join(home, 'repositories', 'a', 'plugins', 'config');
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, 'gmail.json'), JSON.stringify({ enabled: true, provider: 'mock' }));
    const profile = join(home, 'system', 'plugins', 'profiles', 'app-store-connect.json');
    mkdirSync(join(home, 'system', 'plugins', 'profiles'), { recursive: true });
    writeFileSync(profile, JSON.stringify({ schemaVersion: 1, enabled: true, issuerId: 'global' }));
    expect(migrate(home, [{ repoId: 'a', canonicalRoot: a }])).toEqual(expect.arrayContaining(['gmail', 'app_store_connect']));
    expect(readControllerPluginConfig<Record<string, unknown>>(home, 'gmail')?.enabled).toBe(true);
    expect(readControllerPluginConfig<Record<string, unknown>>(home, 'app_store_connect')?.issuerId).toBe('global');
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(join(managed, 'gmail.json'))).toBe(false);
  });

  test('canonical configuration remains authoritative and never reads a stale repository copy', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const source = legacyConfig(a, 'gmail.json', { enabled: true, accountEmail: 'old@example.test' });
    const repository = [{ repoId: 'a', canonicalRoot: a }];
    writeControllerPluginConfig(home, 'gmail', { enabled: true, accountEmail: 'new@example.test' }, repository);
    expect(readControllerPluginConfig<Record<string, unknown>>(home, 'gmail')?.accountEmail).toBe('new@example.test');
    expect(existsSync(source)).toBe(false);
  });

  test('invalid legacy Browser JSON remains intact and does not become authority', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const path = join(a, '.forge', 'plugins', 'browser.json');
    mkdirSync(join(a, '.forge', 'plugins'), { recursive: true });
    writeFileSync(path, '{ invalid');
    expect(migrate(home, [{ repoId: 'a', canonicalRoot: a }])).not.toContain('browser');
    expect(existsSync(path)).toBe(true);
    expect(readControllerPluginConfig(home, 'browser')).toBeUndefined();
  });

  test('malformed Controller authority rejects reads and migration without using legacy data', () => {
    const home = root('forge-plugin-home-');
    const a = root('forge-plugin-a-');
    const path = controllerPluginConfigPath(home, 'browser');
    mkdirSync(join(home, 'system', 'plugins', 'config'), { recursive: true });
    writeFileSync(path, '{invalid');
    legacyConfig(a, 'browser.json', { schemaVersion: 1, enabled: true });
    expect(() => readControllerPluginConfig(home, 'browser')).toThrow(/PLUGIN_CONFIG_AUTHORITY_INVALID/);
    expect(() => migrate(home, [{ repoId: 'a', canonicalRoot: a }])).toThrow(/PLUGIN_CONFIG_AUTHORITY_INVALID/);
  });

  test('stale symlink is removed without reading another Controller home', () => {
    const home = root('forge-plugin-home-');
    const other = root('forge-plugin-other-');
    const a = root('forge-plugin-a-');
    const target = join(other, 'plugins');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'browser.json'), JSON.stringify({ enabled: true, schemaVersion: 1 }));
    mkdirSync(join(a, '.forge'), { recursive: true });
    const link = join(a, '.forge', 'plugins');
    symlinkSync(target, link, 'dir');
    expect(migrate(home, [{ repoId: 'a', canonicalRoot: a }])).not.toContain('browser');
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(target, 'browser.json'))).toBe(true);
  });
});
