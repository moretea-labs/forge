import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildBrowserPluginManifest } from '../../src/runtime/plugins/browser-adapter';
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';
import { setComputerPlatformForTest } from '../../src/runtime/platform/computer-platform';

const roots: string[] = [];
afterEach(() => {
  setComputerPlatformForTest(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifestFor(platform: 'darwin' | 'linux' | 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'forge-computer-platform-contract-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"forge-computer-platform-contract","private":true}');
  setComputerPlatformForTest(platform);
  return computerPluginAdapter.buildManifest(1, undefined, root);
}

describe('Computer cross-platform manifest contract', () => {
  test('all platforms advertise the same action IDs, schemas, permissions and confirmation fences', () => {
    const mac = manifestFor('darwin');
    const linux = manifestFor('linux');
    const windows = manifestFor('win32');
    const contract = (actions: typeof mac.actions) =>
      actions
        .map((action) => ({
          id: action.actionId,
          risk: action.risk,
          confirmation: action.confirmation,
          scopes: action.scopes,
          argumentsSchema: action.argumentsSchema,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    expect(contract(linux.actions)).toEqual(contract(mac.actions));
    expect(contract(windows.actions)).toEqual(contract(mac.actions));
    const actionIds = new Set(mac.actions.map((action) => action.actionId));
    expect(actionIds.has('autofill_saved_password')).toBe(true);
    expect(actionIds.has('desktop_element_action')).toBe(true);
    const desktopAction = mac.actions.find((action) => action.actionId === 'desktop_element_action');
    const actionEnum = (
      desktopAction?.argumentsSchema as {
        properties?: { action?: { enum?: string[] } };
      }
    )?.properties?.action?.enum;
    expect(actionEnum).toContain('click');
    const desktopActionSchema = desktopAction?.argumentsSchema as {
      properties?: { selector?: { properties?: Record<string, unknown> } };
      anyOf?: Array<{ required?: string[] }>;
    };
    expect(desktopActionSchema.properties?.selector?.properties).toHaveProperty('identifier');
    expect(desktopActionSchema.properties?.selector?.properties).not.toHaveProperty('ref');
    expect(desktopActionSchema.anyOf).toContainEqual({ required: ['selector'] });
  });

  test('platform-specific Computer execution readiness must not be mistaken for cross-host native support', () => {
    const mac = manifestFor('darwin');
    const linux = manifestFor('linux');
    expect(linux.health.details?.desktop).toMatchObject({
      supported: false,
      ready: false,
    });
    expect(linux.health.details?.iphone).toMatchObject({
      supported: false,
      ready: false,
    });
    expect(mac.health.details?.desktop).toHaveProperty('supported', true);
  });

  test('WSL native Computer Browser reports missing provider, not missing packaged Playwright', () => {
    if (process.platform !== 'linux') return;
    const root = mkdtempSync(join(tmpdir(), 'forge-computer-linux-provider-'));
    roots.push(root);
    const release = join(root, 'release');
    const playwright = join(release, 'package', 'node_modules', 'playwright');
    mkdirSync(playwright, { recursive: true });
    writeFileSync(join(release, 'manifest.json'), '{"schemaVersion":1}');
    writeFileSync(join(release, 'package', 'package.json'), '{"name":"forge-release"}');
    writeFileSync(join(playwright, 'package.json'), '{"name":"playwright","main":"index.js"}');
    writeFileSync(join(playwright, 'index.js'), 'module.exports = {};');
    const old = process.env.FORGE_RELEASE_PATH;
    try {
      process.env.FORGE_RELEASE_PATH = release;
      const manifest = buildBrowserPluginManifest(1, undefined, root, undefined, true);
      expect(manifest.health.details?.dependencyReady).toBe(true);
      expect(manifest.health.details?.providerUnavailable).toBe(true);
      expect(manifest.health.errors[0]).toContain('no authorized native, CDP or managed provider');
    } finally {
      if (old === undefined) delete process.env.FORGE_RELEASE_PATH;
      else process.env.FORGE_RELEASE_PATH = old;
    }
  });
});
