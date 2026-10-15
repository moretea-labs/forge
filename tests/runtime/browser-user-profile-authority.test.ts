import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildBrowserPluginManifest, resetBrowserPluginRuntimeHooksForTest, setBrowserPluginRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-adapter';
import { resetMacOsBrowserRuntimeHooksForTest, setMacOsBrowserRuntimeHooksForTest } from '../../src/runtime/plugins/browser-macos-bridge';
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-browser-user-authority-'));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function browserDetails(root: string): Record<string, unknown> {
  const manifest = buildBrowserPluginManifest(1, '2026-08-30T00:00:00.000Z', root, {
    controllerHome: join(root, 'controller-home'),
    repoId: 'repo-browser-user-authority',
    repoRoot: root,
    controllerScoped: false,
  });
  return (manifest.health.details ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  resetBrowserPluginRuntimeHooksForTest();
  resetMacOsBrowserRuntimeHooksForTest();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('browser user-profile authority', () => {
  test('defaults to existing user Chromium-family browsers and disables silent managed fallback', () => {
    const details = browserDetails(fixture());
    expect(details.browserMode).toBe('attach_preferred');
    expect(details.profileMode).toBe('repo_local');
    expect(details.browserChannel).toBe('chrome');
    expect(details.cdpAttachFallback).toBe('fail_closed');
    expect(details.nativeAttachMode).toBe('auto');
    expect(details.nativeBrowserCandidates).toEqual(['chrome', 'vivaldi']);
    expect(details.provider).not.toBe('playwright-persistent-context');
    const root = fixture();
    const manifest = computerPluginAdapter.buildManifest(1, undefined, root, {
      controllerHome: join(root, 'controller-home'), repoId: 'repo-browser-user-authority',
      repoRoot: root, controllerScoped: false,
    });
    expect(manifest.capabilities.find((capability) => capability.capabilityId === 'browser-interaction')?.description).toContain('native Computer');
    expect(manifest.actions.some((action) => action.actionId === 'configure' || action.actionId === 'install_unpacked_extension')).toBe(false);
    // Native Computer is built into Forge, regardless of Browser scripting
    // setup, and has no separate per-project activation step.
    expect(manifest.enabled).toBe(true);
    writeJson(join(root, '.forge', 'plugins', 'browser.json'), {
      schemaVersion: 3, enabled: false, provider: 'playwright', browserMode: 'managed_persistent',
    });
    const disabledScriptOnly = computerPluginAdapter.buildManifest(1, undefined, root, {
      controllerHome: join(root, 'controller-home'), repoId: 'repo-browser-user-authority',
      repoRoot: root, controllerScoped: false,
    });
    expect(disabledScriptOnly.enabled).toBe(true);
    expect(disabledScriptOnly.health.details?.browser).toMatchObject({ state: 'degraded' });
    expect((disabledScriptOnly.health.details?.browser as Record<string, unknown>).state).not.toBe('disabled');
  });

  test('does not let a legacy ChatGPT managed-profile binding become general browser authority', () => {
    const root = fixture();
    writeJson(join(root, '.forge', 'chatgpt-browser.local.json'), {
      version: 1,
      product: 'chatgpt',
      profileDir: '/tmp/legacy-chatgpt-profile',
      profileDirectory: 'Profile 7',
      browserChannel: 'chromium',
      chatgptUrl: 'https://chatgpt.com/',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });
    const details = browserDetails(root);
    expect(details.profileMode).toBe('repo_local');
    expect(details.profileDir).toBeUndefined();
    expect(details.browserChannel).toBe('chrome');
    expect(details.nativeBrowserCandidates).toEqual(['chrome', 'vivaldi']);
  });

  test('migrates repository-local v1 managed routing to Chromium-family attach fail-closed defaults', () => {
    const root = fixture();
    writeJson(join(root, '.forge', 'plugins', 'browser.json'), {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'managed_persistent',
      profileMode: 'custom',
      profileDir: '.forge/browser/profiles/legacy',
      browserChannel: 'chromium',
      cdpAttachFallback: 'managed_persistent',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['vivaldi'],
    });
    const details = browserDetails(root);
    expect(details.browserMode).toBe('attach_preferred');
    expect(details.profileMode).toBe('repo_local');
    expect(details.profileDir).toBeUndefined();
    expect(details.browserChannel).toBe('chrome');
    expect(details.cdpAttachFallback).toBe('fail_closed');
    expect(details.nativeBrowserCandidates).toEqual(['chrome', 'vivaldi']);
  });

  test('preserves an explicit current-schema managed override instead of banning intentional isolation', async () => {
    const root = fixture();
    writeJson(join(root, '.forge', 'plugins', 'browser.json'), {
      schemaVersion: 2,
      enabled: true,
      provider: 'playwright',
      browserMode: 'managed_persistent',
      profileMode: 'repo_local',
      browserChannel: 'chrome',
      cdpAttachFallback: 'managed_persistent',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['vivaldi'],
    });
    const details = browserDetails(root);
    expect(details.browserMode).toBe('managed_persistent');
    expect(details.cdpAttachFallback).toBe('managed_persistent');
    expect(details.nativeBrowserCandidates).toEqual(['vivaldi']);
    expect(details.provider).toBe('playwright-persistent-context');
    const nativeManifest = computerPluginAdapter.buildManifest(1, undefined, root, {
      controllerHome: join(root, 'controller-home'), repoId: 'repo-browser-user-authority',
      repoRoot: root, controllerScoped: false,
    });
    expect(nativeManifest.enabled).toBe(true);
    expect(nativeManifest.health.details?.browser).not.toMatchObject({ state: 'disabled' });
    // The standalone Browser profile must never leak into Computer's native
    // action, even when a persisted repository configuration opts into it.
    let loadedPlaywright = false;
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => { loadedPlaywright = true; throw new Error('Computer must never load Playwright'); },
    });
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'win32', appExists: () => false, processRunning: async () => false,
    });
    await expect(computerPluginAdapter.executeAction({
      controllerHome: join(root, 'controller-home'), repoId: 'repo-browser-user-authority',
      repoRoot: root, pluginId: 'computer', actionId: 'create_session',
      requestId: 'native-computer-never-launches-managed-profile',
      args: { url: 'https://example.com/' },
      origin: { surface: 'mcp', actor: 'native-computer-verification' },
    })).rejects.toMatchObject({ code: 'PLUGIN_COMPUTER_NATIVE_BROWSER_UNAVAILABLE' });
    expect(loadedPlaywright).toBe(false);

    // An explicitly named new Computer session must still adopt the user's
    // background Chrome tab rather than frontmost Vivaldi, even when the
    // independent Browser script config is managed.
    const targetUrl = 'https://example.com/signed-in-background';
    const recordSeparator = String.fromCharCode(30);
    const fieldSeparator = String.fromCharCode(31);
    let createdTabs = 0;
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin', appExists: () => true,
      processRunning: async () => true,
      tabInventory: async (product) => ({
        product, truncated: false,
        tabs: product === 'chrome'
          ? [{ windowId: '7', tabId: '9', active: false, frontmost: false, url: targetUrl, title: 'Already signed in' }]
          : [{ windowId: '8', tabId: '10', active: true, frontmost: true, url: 'https://other.example.net/', title: 'Front Vivaldi' }],
      }),
      runAppleScript: async (script, args = []) => {
        const vivaldi = script.includes('Vivaldi');
        if (script.includes('set outputText to "false"')) return vivaldi
          ? ['false', ['8', '10', 'true', 'true', 'https://other.example.net/', 'Front Vivaldi'].join(fieldSeparator)].join(recordSeparator)
          : ['false', ['7', '9', 'false', 'false', targetUrl, 'Already signed in'].join(fieldSeparator)].join(recordSeparator);
        if (script.includes('make new tab') || script.includes('make new window')) {
          createdTabs += 1;
          throw new Error('Existing background tab must be reused');
        }
        if (script.includes('execute targetTab javascript')) {
          return JSON.stringify({
            ok: true, value: { url: targetUrl, title: 'Already signed in' },
            page: { url: targetUrl, title: 'Already signed in' },
          });
        }
        return vivaldi
          ? ['true', 'https://other.example.net/', 'Front Vivaldi', '0', '0', '1200', '800', '8', '10', 'true', 'false'].join(recordSeparator)
          : ['false', targetUrl, 'Already signed in', '0', '0', '1200', '800', '7', '9', 'false', 'false'].join(recordSeparator);
      },
    });
    const adopted = await computerPluginAdapter.executeAction({
      controllerHome: join(root, 'controller-home'), repoId: 'repo-browser-user-authority',
      repoRoot: root, pluginId: 'computer', actionId: 'create_session',
      requestId: 'computer-attach-background-explicit-new-session',
      args: { url: targetUrl, session_id: 'new-explicit-computer-session' },
      origin: { surface: 'mcp', actor: 'native-computer-verification' },
    });
    expect((adopted.session as { browser?: { provider?: string; tab?: { tabId?: string; ownership?: string } } }).browser)
      .toMatchObject({ provider: 'macos-apple-events', tab: { tabId: '9', ownership: 'user_owned' } });
    expect(createdTabs).toBe(0);
    expect(loadedPlaywright).toBe(false);
    await expect(computerPluginAdapter.executeAction({
      controllerHome: join(root, 'controller-home'), repoId: 'repo-browser-user-authority',
      repoRoot: root, pluginId: 'computer', actionId: 'create_session',
      requestId: 'computer-existing-only-missing-tab',
      args: {
        url: 'https://example.invalid/forge-computer-unmatched',
        session_id: 'computer-existing-only-missing-tab',
        __forge_require_existing_resource: true,
      },
      origin: { surface: 'mcp', actor: 'native-computer-verification' },
    })).rejects.toMatchObject({ code: 'PLUGIN_BROWSER_EXISTING_TAB_NOT_FOUND' });
    expect(createdTabs).toBe(0);

    // A running Chrome process without a window is NOT consent to create a
    // new Chrome window; the same native-only Computer request fails closed.
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin', appExists: () => true,
      processRunning: async (name) => name === 'Google Chrome',
      tabInventory: async (product) => ({ product, truncated: false, tabs: [] }),
      runAppleScript: async (script) => {
        if (script.includes('make new window') || script.includes('make new tab')) {
          createdTabs += 1;
          throw new Error('Computer must not create a new Chrome window');
        }
        throw new Error('FORGE_NO_BROWSER_WINDOW');
      },
    });
    await expect(computerPluginAdapter.executeAction({
      controllerHome: join(root, 'controller-home'), repoId: 'repo-browser-user-authority',
      repoRoot: root, pluginId: 'computer', actionId: 'create_session',
      requestId: 'computer-no-window-means-no-new-browser',
      args: { url: 'https://example.com/other', session_id: 'other-new-computer-session' },
      origin: { surface: 'mcp', actor: 'native-computer-verification' },
    })).rejects.toMatchObject({ code: 'PLUGIN_COMPUTER_BROWSER_INVENTORY_UNAVAILABLE' });
    expect(createdTabs).toBe(0);
    expect(loadedPlaywright).toBe(false);
  });
});
