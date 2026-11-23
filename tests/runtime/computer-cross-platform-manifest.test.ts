import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
    const contract = (actions: typeof mac.actions) => actions.map((action) => ({
      id: action.actionId,
      risk: action.risk,
      confirmation: action.confirmation,
      scopes: action.scopes,
      argumentsSchema: action.argumentsSchema,
    })).sort((a, b) => a.id.localeCompare(b.id));

    expect(contract(linux.actions)).toEqual(contract(mac.actions));
    expect(contract(windows.actions)).toEqual(contract(mac.actions));
    const actionIds = new Set(mac.actions.map((action) => action.actionId));
    expect(actionIds.has('autofill_saved_password')).toBe(true);
    expect(actionIds.has('desktop_element_action')).toBe(true);
    const desktopAction = mac.actions.find((action) => action.actionId === 'desktop_element_action');
    const actionEnum = (desktopAction?.argumentsSchema as {
      properties?: { action?: { enum?: string[] } };
    })?.properties?.action?.enum;
    expect(actionEnum).toContain('click');
  });

  test('platform-specific Computer execution readiness must not be mistaken for cross-host native support', () => {
    const mac = manifestFor('darwin');
    const linux = manifestFor('linux');
    expect(linux.health.details?.desktop).toMatchObject({
      supported: false, ready: false,
    });
    expect(linux.health.details?.iphone).toMatchObject({
      supported: false, ready: false,
    });
    expect(mac.health.details?.desktop).toHaveProperty('supported', true);
  });
});
