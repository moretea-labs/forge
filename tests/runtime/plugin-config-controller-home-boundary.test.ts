import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateRepositoryPluginConfigLegacyFiles } from '../../src/runtime/plugins/store';
import { readRepositoryPluginConfig } from '../../src/runtime/plugins/config-store';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

describe('plugin config Controller Home boundary', () => {
  test('migrates legacy repo config into Controller Home and retires physical repo-local copies', () => {
    const controllerHome = root('forge-plugin-home-');
    const repoRoot = root('forge-plugin-repo-');
    const legacy = join(repoRoot, '.forge', 'plugins');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'browser.json'), '{"schemaVersion":1,"enabled":true}\n');
    const legacyHarness = join(repoRoot, '.repo-harness', 'plugins');
    mkdirSync(legacyHarness, { recursive: true });
    writeFileSync(join(legacyHarness, 'app-store-connect.json'), '{"schemaVersion":1,"enabled":true}\n');

    const target = migrateRepositoryPluginConfigLegacyFiles(controllerHome, { repoId: 'repo-a', canonicalRoot: repoRoot });
    expect(readFileSync(join(target, 'browser.json'), 'utf8')).toContain('"enabled":true');
    expect(readFileSync(join(target, 'app-store-connect.json'), 'utf8')).toContain('"enabled":true');
    expect(existsSync(join(repoRoot, '.repo-harness', 'plugins'))).toBe(false);
    expect(existsSync(join(repoRoot, '.forge', 'plugins'))).toBe(false);
  });

  test('keeps existing Controller Home config authoritative on migration conflict', () => {
    const controllerHome = root('forge-plugin-home-');
    const repoRoot = root('forge-plugin-repo-');
    const target = join(controllerHome, 'repositories', 'repo-a', 'plugins', 'config');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'browser.json'), 'controller\n');
    const legacy = join(repoRoot, '.forge', 'plugins');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'browser.json'), 'legacy\n');

    migrateRepositoryPluginConfigLegacyFiles(controllerHome, { repoId: 'repo-a', canonicalRoot: repoRoot });
    expect(readFileSync(join(target, 'browser.json'), 'utf8')).toBe('controller\n');
    expect(existsSync(legacy)).toBe(false);
  });

  test('ignores a stale compatibility symlink instead of crossing Controller Home identity', () => {
    const controllerHome = root('forge-plugin-home-');
    const otherControllerHome = root('forge-plugin-other-home-');
    const repoRoot = root('forge-plugin-repo-');
    const otherTarget = join(otherControllerHome, 'repositories', 'repo-a', 'plugins', 'config');
    mkdirSync(otherTarget, { recursive: true });
    writeFileSync(join(otherTarget, 'browser.json'), '{"schemaVersion":1,"enabled":true}\n');
    const compatibilityRoot = join(repoRoot, '.forge', 'plugins');
    mkdirSync(join(repoRoot, '.forge'), { recursive: true });
    symlinkSync(otherTarget, compatibilityRoot, 'dir');

    const target = migrateRepositoryPluginConfigLegacyFiles(controllerHome, { repoId: 'repo-a', canonicalRoot: repoRoot });
    expect(existsSync(join(target, 'browser.json'))).toBe(false);
    expect(existsSync(compatibilityRoot)).toBe(false);
    expect(readRepositoryPluginConfig({ controllerHome, repoId: 'repo-a', repoRoot }, 'browser')).toBeUndefined();
  });

  test('rejects malformed Controller Home config instead of falling back to a legacy copy', () => {
    const controllerHome = root('forge-plugin-home-');
    const repoRoot = root('forge-plugin-repo-');
    const target = join(controllerHome, 'repositories', 'repo-a', 'plugins', 'config');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'browser.json'), '{malformed');
    const legacy = join(repoRoot, '.forge', 'plugins');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'browser.json'), '{"schemaVersion":1,"enabled":true}\n');

    expect(() => readRepositoryPluginConfig({ controllerHome, repoId: 'repo-a', repoRoot }, 'browser'))
      .toThrow(/PLUGIN_CONFIG_AUTHORITY_INVALID/);
  });
});
