import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureRepositoryPluginConfigCompatibilityLink } from '../../src/runtime/plugins/store';

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
  test('migrates legacy repo config and leaves only a compatibility symlink', () => {
    const controllerHome = root('forge-plugin-home-');
    const repoRoot = root('forge-plugin-repo-');
    const legacy = join(repoRoot, '.forge', 'plugins');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'browser.json'), '{"schemaVersion":1,"enabled":true}\n');
    const legacyHarness = join(repoRoot, '.repo-harness', 'plugins');
    mkdirSync(legacyHarness, { recursive: true });
    writeFileSync(join(legacyHarness, 'app-store-connect.json'), '{"schemaVersion":1,"enabled":true}\n');

    const target = ensureRepositoryPluginConfigCompatibilityLink(controllerHome, { repoId: 'repo-a', canonicalRoot: repoRoot });
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'browser.json'), 'utf8')).toContain('"enabled":true');
    expect(readFileSync(join(target, 'app-store-connect.json'), 'utf8')).toContain('"enabled":true');
    expect(existsSync(join(repoRoot, '.repo-harness', 'plugins'))).toBe(false);
    expect(existsSync(join(repoRoot, '.forge', 'plugins', 'browser.json'))).toBe(true);
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

    ensureRepositoryPluginConfigCompatibilityLink(controllerHome, { repoId: 'repo-a', canonicalRoot: repoRoot });
    expect(readFileSync(join(target, 'browser.json'), 'utf8')).toBe('controller\n');
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
  });
});
