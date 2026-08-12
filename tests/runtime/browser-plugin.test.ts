import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import {
  buildBrowserPluginManifest,
  executeBrowserPluginAction,
  resetBrowserPluginRuntimeHooksForTest,
  setBrowserPluginRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-adapter';
import {
  resolveBrowserBridgeNodeExecutable,
  resolveBrowserNodeBridgeHostPath,
  shouldUseBrowserNodeBridge,
} from '../../src/runtime/plugins/browser-node-bridge';
import {
  listBrowserHandoffs,
  resetBrowserHandoffRuntimeHooksForTest,
  resolveBrowserHandoffHostExecutable,
  resolveBrowserHandoffHostPath,
  setBrowserHandoffRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-handoff';
import {
  activateMacOsBrowserOwnedTab,
  discoverMacOsBrowserAttachment,
  resetMacOsBrowserRuntimeHooksForTest,
  setMacOsBrowserRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-macos-bridge';
import { interactionCommandPath, patchInteractionSession } from '../../src/runtime/plugins/interaction-session';
import { resetMacOsCapabilityBrokerSocketPathForTest, setMacOsCapabilityBrokerSocketPathForTest } from '../../src/runtime/plugins/macos-capability-broker';
import {
  clearAssistantPluginManifestCacheForTest,
  getAssistantPluginManifest,
  submitAssistantPluginAction,
} from '../../src/runtime/plugins/store';
const roots: string[] = [];
beforeEach(() => {
  // Unit tests must never attach to a real user browser just because Chrome/Vivaldi is running.
  // Native-attach cases explicitly install darwin test hooks below.
  setMacOsBrowserRuntimeHooksForTest({ platform: 'linux' });
  setMacOsCapabilityBrokerSocketPathForTest(join(tmpdir(), `forge-test-macos-broker-unavailable-${process.pid}.sock`));
});
afterEach(() => {
  resetBrowserPluginRuntimeHooksForTest();
  resetBrowserHandoffRuntimeHooksForTest();
  resetMacOsBrowserRuntimeHooksForTest();
  resetMacOsCapabilityBrokerSocketPathForTest();
  clearAssistantPluginManifestCacheForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.FORGE_CONTROLLER_HOME;
  delete process.env.FORGE_BROWSER_NODE_BRIDGE_HOST;
  delete process.env.FORGE_NODE_EXECUTABLE;
});
function repoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-browser-plugin-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-browser-plugin-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.FORGE_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'tasks'), { recursive: true });
  mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
  mkdirSync(join(repoRoot, '.forge/plugins'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(repoRoot, 'tasks/current.md'), '# Current\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}
function writeBrowserConfig(repoRoot: string, value: Record<string, unknown>) {
  writeFileSync(join(repoRoot, '.forge/plugins/browser.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function mockPlaywright(options: { finalUrl?: string; title?: string; routeUrl?: string } = {}) {
  let currentUrl = 'https://example.com/';
  let currentTitle = options.title ?? 'Example';
  const routeDecisions: string[] = [];
  const launches: Array<{ userDataDir: string; options: Record<string, unknown> }> = [];
  const evaluatedExpressions: unknown[] = [];

  const page = {
    async goto(url: string) {
      currentUrl = url;
    },
    async title() {
      return currentTitle;
    },
    url() {
      return currentUrl;
    },
    async evaluate<T>(expression?: unknown) {
      evaluatedExpressions.push(expression);
      return 'Example page text' as T;
    },
    async screenshot(args: Record<string, unknown>) {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (path) writeFileSync(path, 'png');
      return Buffer.from('png');
    },
    async click() {
      currentUrl = options.finalUrl ?? currentUrl;
      currentTitle = options.title ?? 'Clicked Example';
    },
    async fill() {
      currentTitle = options.title ?? 'Typed Example';
    },
    async press() {
      currentTitle = options.title ?? 'Pressed Example';
    },
    async waitForSelector() {
      currentTitle = options.title ?? 'Waiting Example';
      return {};
    },
  };

  return {
    chromium: {
      async launchPersistentContext(userDataDir: string, launchOptions: Record<string, unknown>) {
        launches.push({ userDataDir, options: launchOptions });
        return {
          pages() {
            return [page];
          },
          async newPage() {
            return page;
          },
          async close() {},
          async route(_pattern: string, handler: (route: { request(): { url(): string }; continue(): Promise<void>; abort(code?: string): Promise<void> }) => Promise<void> | void) {
            if (!options.routeUrl) return;
            await handler({
              request: () => ({ url: () => options.routeUrl ?? '' }),
              continue: async () => { routeDecisions.push('continue'); },
              abort: async (code?: string) => { routeDecisions.push(`abort:${code ?? ''}`); },
            });
          },
        };
      },
    },
    routeDecisions,
    launches, evaluatedExpressions,
  } as never;
}

function mockAttachPlaywright(
  initialPages: Array<{ url: string; title: string; ownerToken?: string }> = [],
  options: { connectError?: string; managedTitle?: string } = {},
) {
  const events = {
    connects: [] as string[],
    disconnects: 0,
    launches: [] as Array<{ userDataDir: string; options: Record<string, unknown> }>,
    newPages: 0,
    gotos: [] as string[],
    broughtToFront: [] as string[],
  };

  const makePage = (state: { url: string; title: string; ownerToken?: string }) => ({
    async goto(url: string) {
      state.url = url;
      events.gotos.push(url);
    },
    async title() {
      return state.title;
    },
    url() {
      return state.url;
    },
    async evaluate<T>(expression?: string) {
      if (typeof expression === 'string' && expression.includes('window.name')) return (state.ownerToken ?? '') as T;
      return 'Attached page text' as T;
    },
    async screenshot(args: Record<string, unknown>) {
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (path) writeFileSync(path, 'png');
      return Buffer.from('png');
    },
    async click() {},
    async fill() {},
    async press() {},
    async waitForSelector() {
      return {};
    },
    async bringToFront() {
      events.broughtToFront.push(state.title);
    },
  });

  const states = initialPages.map((page) => ({ ...page }));
  const pages = states.map(makePage);
  const context = {
    pages() {
      return pages;
    },
    async newPage() {
      events.newPages += 1;
      const state = { url: 'about:blank', title: options.managedTitle ?? 'New Page' };
      states.push(state);
      const page = makePage(state);
      pages.push(page);
      return page;
    },
    async close() {},
    async route() {},
  };

  return {
    chromium: {
      async connectOverCDP(endpoint: string) {
        events.connects.push(endpoint);
        if (options.connectError) throw new Error(options.connectError);
        return {
          contexts: () => [context],
          disconnect: () => {
            events.disconnects += 1;
          },
        };
      },
      async launchPersistentContext(userDataDir: string, launchOptions: Record<string, unknown>) {
        events.launches.push({ userDataDir, options: launchOptions });
        return context;
      },
    },
    events,
  } as never;
}

function mockMacOsOwnedTabRuntime(product: 'chrome' | 'vivaldi' = 'vivaldi', options: { javaScriptEnabled?: boolean; targetTitleMetadataFails?: boolean } = {}) {
  const javaScriptEnabled = options.javaScriptEnabled !== false;
  const separator = '\x1e';
  const userTab = { id: '501', url: 'https://example.com/user-work', title: 'User Work' };
  const ownedTabs = new Map<string, { url: string; title: string; ownerToken?: string }>();
  const events = {
    created: [] as string[],
    closed: [] as string[],
    navigated: [] as Array<{ tabId: string; url: string }>,
    activeTabId: userTab.id,
  };
  let nextTabId = 9001;
  const appName = product === 'chrome' ? 'Google Chrome' : 'Vivaldi';

  const tabIdFromScript = (script: string): string | undefined => {
    const matches = [...script.matchAll(/whose id is "([^"]+)"/g)];
    return matches.at(-1)?.[1];
  };
  const metadata = (tabId: string, url: string, title: string, active: boolean) =>
    `true${separator}${url}${separator}${title}${separator}0${separator}25${separator}1280${separator}925${separator}77${separator}${tabId}${separator}${active ? 'true' : 'false'}`;

  return {
    events,
    hooks: {
      platform: 'darwin' as const,
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script: string, args: string[] = []) => {
        if (!script.includes(appName)) {
          return metadata('701', 'https://example.com/other-browser', 'Other Browser', false);
        }
        if (script.includes('make new tab at end of tabs of targetWindow')) {
          const tabId = String(nextTabId++);
          const url = args[0] ?? 'about:blank';
          ownedTabs.set(tabId, { url, title: `Forge ${tabId}` });
          events.created.push(tabId);
          return `window-77${separator}${tabId}`;
        }
        if (script.includes('close targetTab')) {
          const tabId = tabIdFromScript(script);
          if (tabId && ownedTabs.delete(tabId)) events.closed.push(tabId);
          return '';
        }
        if (script.includes('set URL of targetTab to targetUrl')) {
          const tabId = tabIdFromScript(script);
          const entry = tabId ? ownedTabs.get(tabId) : undefined;
          if (!tabId || !entry) throw new Error('missing owned tab');
          entry.url = args[0] ?? entry.url;
          events.navigated.push({ tabId, url: entry.url });
          return entry.url;
        }
        if (script.includes('execute targetTab javascript javascriptSource')) {
          if (!javaScriptEnabled) throw new Error('Executing JavaScript through AppleScript is turned off. Allow JavaScript from Apple Events.');
          const tabId = tabIdFromScript(script);
          const entry = tabId ? ownedTabs.get(tabId) : undefined;
          if (!tabId || !entry) throw new Error('missing owned tab');
          const source = args[0] ?? '';
          if (source.includes('document.readyState')) return JSON.stringify({ ok: true, value: 'complete' });
          if (source.includes('document.title')) return JSON.stringify({ ok: true, value: entry.title });
          if (source.includes('document.body ? document.body.innerText')) return JSON.stringify({ ok: true, value: 'Native page text' });
          if (source.includes('window.name =')) {
            const token = source.match(/forge-browser-owned:[a-f0-9]+/)?.[0];
            if (token) entry.ownerToken = token;
            return JSON.stringify({ ok: true, value: { __forgeUndefined: true } });
          }
          return JSON.stringify({ ok: true, value: true });
        }
        if (script.includes('set targetTabIndex to 1')) {
          const tabId = tabIdFromScript(script);
          if (!tabId || !ownedTabs.has(tabId)) throw new Error('missing owned tab');
          events.activeTabId = tabId;
          return '';
        }
        if (script.includes('set targetIsActive')) {
          if (options.targetTitleMetadataFails && script.includes('title of targetTab as text')) throw new Error('Can’t make name of background Chrome tab into type text. (-1700)');
          const tabId = tabIdFromScript(script);
          const entry = tabId ? ownedTabs.get(tabId) : undefined;
          if (!tabId || !entry) throw new Error('missing owned tab');
          return metadata(tabId, entry.url, entry.title, events.activeTabId === tabId);
        }
        if (script.includes('set targetTab to active tab of targetWindow')) {
          return metadata(userTab.id, userTab.url, userTab.title, true);
        }
        return '';
      },
      captureRegion: async (_region: { x: number; y: number; width: number; height: number }, path: string) => {
        writeFileSync(path, 'png');
        return Buffer.from('png');
      },
    },
  };
}

describe('browser plugin', () => {
  test('manifest keeps readonly actions readonly and only exposes the supported interaction surface', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
    });

    const manifest = buildBrowserPluginManifest(0, undefined, repoRoot);
    const actions = Object.fromEntries(manifest.actions.map((action) => [action.actionId, action]));

    expect(manifest.pluginId).toBe('browser');
    expect(Object.keys(actions)).toEqual(expect.arrayContaining([
      'configure',
      'create_session',
      'list_sessions',
      'close_session',
      'open_page',
      'navigate',
      'get_text',
      'get_html',
      'query_selector',
      'screenshot',
      'extract_links',
      'click',
      'fill',
      'type',
      'press',
      'wait_for_selector',
      'close_page',
      'await_file_transfer',
      'request_human_handoff',
      'get_handoff_status',
      'resolve_handoff',
    ]));

    for (const actionId of ['open_page', 'get_text', 'screenshot', 'list_sessions', 'extract_links']) {
      expect(actions[actionId]?.readOnly).toBe(true);
      expect(actions[actionId]?.risk).toBe('readonly');
      expect(actions[actionId]?.confirmation).toBe('none');
    }

    for (const actionId of ['create_session', 'close_session', 'close_page', 'request_human_handoff', 'resolve_handoff']) {
      expect(actions[actionId]?.readOnly).toBe(false);
      expect(actions[actionId]?.risk).toBe('workspace_write');
      expect(actions[actionId]?.confirmation).toBe('authorization');
      expect(actions[actionId]?.resourceClaims).toEqual(expect.arrayContaining([
        { resource: 'repo-state', mode: 'write' },
      ]));
    }

    expect(actions.click?.risk).toBe('remote_write');
    expect(actions.click?.confirmation).toBe('authorization');
    expect(actions.type?.risk).toBe('remote_write');
    expect(actions.type?.confirmation).toBe('authorization');
    expect(actions.fill?.risk).toBe('remote_write');
    expect(actions.press?.risk).toBe('remote_write');
    expect(actions.press?.confirmation).toBe('authorization');
    expect(actions.wait_for_selector?.risk).toBe('workspace_write');
    expect(actions.wait_for_selector?.confirmation).toBe('authorization');

    for (const unsupported of ['submit', 'delete', 'publish', 'payment', 'send']) {
      expect(Object.keys(actions).some((actionId) => actionId.includes(unsupported))).toBe(false);
    }
  });

  test('interaction actions inherit host authorization before job submission', async () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

        setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => ({
        chromium: {
          launchPersistentContext: async () => ({
            newPage: async () => ({
              goto: async () => undefined,
              click: async () => undefined,
              waitForSelector: async () => undefined,
              title: async () => 'ok',
              content: async () => '<html></html>',
              screenshot: async () => Buffer.from('x'),
              close: async () => undefined,
            }),
            close: async () => undefined,
            pages: () => [],
          }),
        },
      }) as any,
    });

    const accepted = getAssistantPluginManifest(controllerHome, repository, 'browser')
      .actions.find((action) => action.actionId === 'click');
    expect(accepted?.confirmation).toBe('authorization');
    expect(accepted?.risk).toBe('remote_write');
  });

  test('returns a clear dependency error when playwright is missing', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => false,
      loadPlaywright: () => {
        throw new AssistantPluginError('PLUGIN_DEPENDENCY_MISSING', 'Browser plugin requires playwright. Run bun install before using browser actions.', {
          retryable: false,
        });
      },
    });

    const manifest = buildBrowserPluginManifest(0, undefined, repoRoot);
    expect(manifest.health.state).toBe('error');
    expect(manifest.health.errors[0]).toContain('Browser plugin requires Playwright for the configured browser mode');

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-open-missing-dep',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_BROWSER_DEPENDENCY_UNAVAILABLE');
  });

  test('reuses a hot cached manifest instead of probing browser readiness on every read', async () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    let moduleChecks = 0;
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => {
        moduleChecks += 1;
        return true;
      },
    });

    const first = getAssistantPluginManifest(controllerHome, repository, 'browser');
    const second = getAssistantPluginManifest(controllerHome, repository, 'browser');

    expect(first.health.state).toBe('ready');
    expect(second.health.state).toBe('ready');
    expect(moduleChecks).toBe(1);
  });

  test('click returns url, title, summary, and a saved screenshot without bypassing allowed domains', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => mockPlaywright({ title: 'Clicked Example' }),
    });

    const result = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'click',
      requestId: 'browser-click-success',
      args: { url: 'https://example.com/', selector: '#cta', post_action_wait_ms: 1 },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(result.url).toBe('https://example.com/');
    expect(result.title).toBe('Clicked Example');
    expect((result.action as Record<string, unknown>).summary).toBe('Clicked #cta.');
    const screenshot = result.screenshot as Record<string, unknown>;
    expect(typeof screenshot.path).toBe('string');
    expect(readFileSync(String(screenshot.path), 'utf-8')).toBe('png');
    const session = result.session as Record<string, unknown>;
    expect(String(session.sessionId)).toContain('browser_');
  });

  test('requires explicit custom profile mode before using a configured profile path', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'configure',
      requestId: 'browser-config-reject-implicit-profile',
      args: { profile_dir: '/Users/example/Library/Application Support/Google/Chrome' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('profile_mode must be set to custom before profile_dir can be used');
  });

  test('custom profile mode can launch visible Chrome against an explicit user profile selection', async () => {
    const { repoRoot } = repoFixture();
    const chromeRoot = join(repoRoot, 'Chrome/User Data');
    const chromeProfile = join(chromeRoot, 'Profile 1');
    mkdirSync(chromeProfile, { recursive: true });
    writeFileSync(join(chromeRoot, 'Local State'), '{}\n');
    writeFileSync(join(chromeProfile, 'Preferences'), '{}\n');
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      profileMode: 'custom',
      profileDir: chromeProfile,
      browserChannel: 'chrome',
      allowedDomains: ['example.com'],
    });
    const runtime = mockPlaywright() as unknown as { launches: Array<{ userDataDir: string; options: Record<string, unknown> }> };

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
    });

    await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-open-custom-profile',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]?.userDataDir).toBe(chromeRoot);
    expect(runtime.launches[0]?.options).toMatchObject({
      headless: false,
      channel: 'chrome',
      args: ['--profile-directory=Profile 1'],
    });
  });

  test('attach_preferred falls back to managed persistent only when configured', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/stale',
      cdpAttachFallback: 'managed_persistent',
      nativeAttachMode: 'disabled',
      allowedDomains: ['example.com'],
    });
    const runtime = mockAttachPlaywright([], { connectError: 'ECONNREFUSED 127.0.0.1:9222' }) as unknown as {
      events: {
        connects: string[];
        launches: Array<{ userDataDir: string; options: Record<string, unknown> }>;
      };
    };

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
    });

    const result = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-attach-fallback',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(runtime.events.connects).toEqual(['ws://127.0.0.1:9222/devtools/browser/stale']);
    expect(runtime.events.launches).toHaveLength(1);
    expect(result.browserConnection).toMatchObject({
      requestedMode: 'attach_preferred',
      mode: 'managed_persistent',
      fallback: {
        policy: 'managed_persistent',
        from: 'attach_preferred',
      },
    });
  });

  test('attach_preferred discovers configured loopback CDP endpoints before connecting', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpEndpoint: 'http://127.0.0.1:9223',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'disabled',
      allowedDomains: ['example.com'],
    });
    const ownerToken = 'forge-browser-owned:cdp-discovery';
    const sessionId = 'cdp-discovery-session';
    mkdirSync(join(repoRoot, '.forge/browser/sessions'), { recursive: true });
    writeFileSync(join(repoRoot, '.forge/browser/sessions', `${sessionId}.json`), JSON.stringify({
      schemaVersion: 1, sessionId, url: 'https://example.com/', title: 'Discovered',
      createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
      browser: { mode: 'attach_preferred', activeMode: 'attach_preferred', provider: 'playwright-cdp', tab: {
        key: 'seed', index: 0, url: 'https://example.com/', title: 'Discovered', matchedBy: 'owned_token',
        inventoryCount: 1, capturedAt: '2026-08-10T00:00:00.000Z', ownership: 'plugin_owned', ownerToken,
      } },
    }), 'utf8');
    const runtime = mockAttachPlaywright([
      { url: 'https://example.com/', title: 'Discovered', ownerToken },
    ]) as unknown as {
      events: { connects: string[] };
    };
    const probes: Array<{ url: string; timeoutMs: number }> = [];

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
      fetchJson: async (url, timeoutMs) => {
        probes.push({ url, timeoutMs });
        return {
          webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser/live',
          Browser: 'Chrome/140.0.0.0',
        };
      },
    });

    const result = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-attach-discover',
      args: { session_id: sessionId, url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(probes).toEqual([{ url: 'http://127.0.0.1:9223/json/version', timeoutMs: 1500 }]);
    expect(runtime.events.connects).toEqual(['ws://127.0.0.1:9223/devtools/browser/live']);
    expect(result.browserConnection).toMatchObject({
      mode: 'attach_preferred',
      endpoint: 'ws://127.0.0.1:9223/devtools/browser/live',
      browserVersion: 'Chrome/140.0.0.0',
    });
  });

  test('native owned-tab foregrounding activates the exact plugin-owned tab without launching another browser', async () => {
    // The stable helper boundary is covered separately below; existing native
    // behavior tests keep using the script hook so they never touch the user's browser.

    const runtime = mockMacOsOwnedTabRuntime('chrome');
    setMacOsBrowserRuntimeHooksForTest(runtime.hooks);
    const discovered = await discoverMacOsBrowserAttachment(['chrome']);
    expect(discovered.attachment).toBeDefined();
    const attachment = discovered.attachment!;
    const page = await import('../../src/runtime/plugins/browser-macos-bridge').then(({ createMacOsBrowserOwnedPage }) =>
      createMacOsBrowserOwnedPage(attachment, 'https://example.com/native-handoff'));
    const ref = page.tabRef();
    expect(ref).toBeDefined();
    expect(runtime.events.activeTabId).toBe('501');
    const metadata = await activateMacOsBrowserOwnedTab('chrome', ref!);
    expect(runtime.events.activeTabId).toBe(ref!.tabId);
    expect(metadata.active).toBe(true);
  });

  test('native attach fails closed when the stable macOS capability broker is unavailable', async () => {
    repoFixture();
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
    });
    const discovered = await discoverMacOsBrowserAttachment(['chrome'], 250);
    expect(discovered.attachment).toBeUndefined();
    expect(discovered.attempts).toHaveLength(1);
    expect(discovered.attempts[0]?.status).toBe('unavailable');
    expect(discovered.attempts[0]?.error).toContain('Stable Forge macOS capability broker is unavailable');
    expect(discovered.attempts[0]?.error).not.toContain('/usr/bin/osascript');
  });

  test('macOS active-browser discovery prefers the frontmost Chrome or Vivaldi window', async () => {
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => script.includes('Google Chrome')
        ? `true\x1ehttps://example.com/chrome\x1eChrome\x1e10\x1e20\x1e1210\x1e820`
        : `false\x1ehttps://example.com/vivaldi\x1eVivaldi\x1e30\x1e40\x1e1230\x1e840`,
    });

    const discovered = await discoverMacOsBrowserAttachment(['vivaldi', 'chrome']);

    expect(discovered.attachment?.metadata).toMatchObject({
      product: 'chrome',
      appName: 'Google Chrome',
      frontmost: true,
      url: 'https://example.com/chrome',
    });
    expect(discovered.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ product: 'vivaldi', status: 'available' }),
      expect.objectContaining({ product: 'chrome', status: 'selected' }),
    ]));
    expect(discovered.attempts.every((attempt) => !('url' in attempt))).toBe(true);
  });

  test('fail-closed native attach health stays degraded until a live browser attach succeeds', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome'],
      allowedDomains: ['example.com'],
    });
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async () => { throw new Error('Chrome Apple Events timed out'); },
    });

    const unverified = buildBrowserPluginManifest(0, undefined, repoRoot);
    expect(unverified.health).toMatchObject({ state: 'degraded', ready: false, probed: false });

    const failed = await discoverMacOsBrowserAttachment(['chrome']);
    expect(failed.attachment).toBeUndefined();
    const degraded = buildBrowserPluginManifest(0, undefined, repoRoot);
    expect(degraded.health).toMatchObject({ state: 'degraded', ready: false, probed: true });
    expect(degraded.health.warnings.join('\n')).toContain('Chrome Apple Events timed out');

    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async () => `true\x1ehttps://example.com/chrome\x1eChrome\x1e10\x1e20\x1e1210\x1e820`,
    });
    const succeeded = await discoverMacOsBrowserAttachment(['chrome']);
    expect(succeeded.attachment?.metadata.product).toBe('chrome');
    const ready = buildBrowserPluginManifest(0, undefined, repoRoot);
    expect(ready.health).toMatchObject({ state: 'ready', ready: true, probed: true });
  });

  test('attach_preferred creates one plugin-owned Vivaldi tab, preserves the user tab, and reuses it across actions', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['vivaldi'],
      allowedDomains: ['example.com'],
    });
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    const nativeOptions = { targetTitleMetadataFails: false };
    const native = mockMacOsOwnedTabRuntime('vivaldi', nativeOptions);
    setMacOsBrowserRuntimeHooksForTest(native.hooks);

    const first = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'get_text',
      requestId: 'browser-owned-first', args: { url: 'https://example.com/first' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    const sessionId = String(first.sessionId);
    nativeOptions.targetTitleMetadataFails = true;
    const second = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'open_page',
      requestId: 'browser-owned-second', args: { session_id: sessionId, url: 'https://example.com/second' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(native.events.created).toEqual(['9001', '9002']);
    expect(native.events.activeTabId).toBe('501');
    expect(native.events.navigated).toEqual([]);
    expect(first.browserConnection).toMatchObject({
      provider: 'macos-apple-events',
      tab: { ownership: 'plugin_owned', windowId: 'window-77', tabId: '9001' },
    });
    expect(second.browserConnection).toMatchObject({
      provider: 'macos-apple-events',
      tab: { ownership: 'plugin_owned', windowId: 'window-77', tabId: '9002' },
      sessionResume: { status: 'matched' },
    });


    const closed = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'close_session',
      requestId: 'browser-owned-close', args: { session_id: sessionId }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(closed).toMatchObject({ closed: true, resourceClosed: true });
    expect(native.events.closed).toEqual(['9001', '9002']);
    expect(native.events.activeTabId).toBe('501');
  });

  test('native open_page preserves tab ownership when JavaScript from Apple Events is disabled and DOM actions fail clearly', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['vivaldi'],
      allowedDomains: ['example.com'],
    });
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    const native = mockMacOsOwnedTabRuntime('vivaldi', { javaScriptEnabled: false });
    setMacOsBrowserRuntimeHooksForTest(native.hooks);

    const opened = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'open_page',
      requestId: 'browser-native-no-js-open', args: { session_id: 'native-no-js', url: 'https://example.com/no-js' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(native.events.created).toEqual(['9001']);
    expect(native.events.activeTabId).toBe('501');
    expect(opened.browserConnection).toMatchObject({
      provider: 'macos-apple-events',
      tab: { ownership: 'plugin_owned', windowId: 'window-77', tabId: '9001' },
    });

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'get_text',
      requestId: 'browser-native-no-js-dom', args: { session_id: 'native-no-js' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED');
    expect(native.events.created).toEqual(['9001']);
    expect(native.events.activeTabId).toBe('501');
  });

  test('two attach_preferred sessions own separate native tabs and never reuse the user active tab', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome'],
      allowedDomains: ['example.com'],
    });
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    const native = mockMacOsOwnedTabRuntime('chrome');
    setMacOsBrowserRuntimeHooksForTest(native.hooks);

    const one = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'open_page',
      requestId: 'browser-native-session-one', args: { session_id: 'session-one', url: 'https://example.com/one' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    const two = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'open_page',
      requestId: 'browser-native-session-two', args: { session_id: 'session-two', url: 'https://example.com/two' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(native.events.created).toEqual(['9001', '9002']);
    expect(native.events.activeTabId).toBe('501');
    expect((one.browserConnection as Record<string, any>).tab.tabId).toBe('9001');
    expect((two.browserConnection as Record<string, any>).tab.tabId).toBe('9002');
  });

  test('CDP attach never consumes a blank user tab or opens a new user tab when no target tab exists', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/live',
      cdpAttachFallback: 'managed_persistent',
      nativeAttachMode: 'disabled',
      allowedDomains: ['example.com'],
    });
    const runtime = mockAttachPlaywright([
      { url: 'about:blank', title: 'User New Tab' },
      { url: 'https://example.com/unrelated', title: 'Unrelated' },
    ], { managedTitle: 'Managed Target' }) as unknown as {
      events: { launches: unknown[]; gotos: string[]; newPages: number; disconnects: number };
    };
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
    });

    const result = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-cdp-no-user-tab-hijack',
      args: { url: 'https://example.com/target' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(runtime.events.disconnects).toBe(1);
    expect(runtime.events.launches).toHaveLength(1);
    expect(result.browserConnection).toMatchObject({
      requestedMode: 'attach_preferred',
      mode: 'managed_persistent',
      provider: 'playwright-persistent-context',
    });
  });

  test('attach_preferred fail_closed reports stale CDP endpoint diagnostics', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/stale',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'disabled',
      allowedDomains: ['example.com'],
    });
    const runtime = mockAttachPlaywright([], { connectError: 'ECONNREFUSED 127.0.0.1:9222' }) as unknown as {
      events: { launches: unknown[] };
    };

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
    });

    let error: unknown;
    try {
      await executeBrowserPluginAction({
        controllerHome: repoRoot,
        repoId: 'repo',
        repoRoot,
        pluginId: 'browser',
        actionId: 'open_page',
        requestId: 'browser-attach-fail-closed',
        args: { url: 'https://example.com/' },
        origin: { surface: 'local-ui', actor: 'test' },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AssistantPluginError);
    expect((error as AssistantPluginError).code).toBe('PLUGIN_BROWSER_ATTACH_UNAVAILABLE');
    expect((error as Error).message).toContain('No configured browser attach provider was available');
    expect((error as AssistantPluginError).details).toMatchObject({
      browserMode: 'attach_preferred',
      fallbackPolicy: 'fail_closed',
      attempts: [
        {
          endpoint: 'ws://127.0.0.1:9222/devtools/browser/stale',
          error: 'ECONNREFUSED 127.0.0.1:9222',
        },
      ],
    });
    expect(runtime.events.launches).toHaveLength(0);
  });

  test('attach_preferred reuses matching tabs and persists resume metadata', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/live',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'disabled',
      allowedDomains: ['example.com'],
    });
    const ownerToken = 'forge-browser-owned:reuse-session';
    const sessionId = 'explicit-session-id';
    mkdirSync(join(repoRoot, '.forge/browser/sessions'), { recursive: true });
    writeFileSync(join(repoRoot, '.forge/browser/sessions', `${sessionId}.json`), JSON.stringify({
      schemaVersion: 1, sessionId, url: 'https://example.com/', title: 'Target',
      createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
      browser: { mode: 'attach_preferred', activeMode: 'attach_preferred', provider: 'playwright-cdp', tab: {
        key: 'seed', index: 1, url: 'https://example.com/', title: 'Target', matchedBy: 'owned_token',
        inventoryCount: 2, capturedAt: '2026-08-10T00:00:00.000Z', ownership: 'plugin_owned', ownerToken,
      } },
    }), 'utf8');
    const firstRuntime = mockAttachPlaywright([
      { url: 'https://example.com/other', title: 'Other' },
      { url: 'https://example.com/', title: 'Target', ownerToken },
    ]) as unknown as {
      events: { newPages: number; gotos: string[]; disconnects: number; broughtToFront: string[] };
    };
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => firstRuntime as never,
    });

    const opened = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-attach-reuse-open',
      args: { session_id: 'explicit-session-id', url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(String((opened.session as Record<string, unknown>).sessionId)).toBe(sessionId);
    const saved = JSON.parse(readFileSync(join(repoRoot, '.forge/browser/sessions', `${sessionId}.json`), 'utf8')) as Record<string, any>;

    expect(firstRuntime.events.newPages).toBe(0);
    expect(firstRuntime.events.gotos).toEqual([]);
    expect(firstRuntime.events.broughtToFront).toEqual([]);
    expect(firstRuntime.events.disconnects).toBe(1);
    expect(saved.browser).toMatchObject({
      mode: 'attach_preferred',
      activeMode: 'attach_preferred',
      tab: {
        url: 'https://example.com/',
        title: 'Target',
        matchedBy: 'owned_token',
        ownership: 'plugin_owned',
        ownerToken,
      },
    });

    const secondRuntime = mockAttachPlaywright([
      { url: 'https://example.com/', title: 'Wrong Duplicate' },
      { url: 'https://example.com/', title: 'Target', ownerToken },
    ]) as unknown as {
      events: { newPages: number; gotos: string[]; broughtToFront: string[] };
    };
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => secondRuntime as never,
    });

    await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'get_text',
      requestId: 'browser-attach-reuse-resume',
      args: { session_id: sessionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(secondRuntime.events.newPages).toBe(0);
    expect(secondRuntime.events.gotos).toEqual([]);
    expect(secondRuntime.events.broughtToFront).toEqual([]);
  });

  test('wait_for_selector keeps authorization despite being read-only', async () => {
    const { repoRoot, controllerHome, repository } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

        setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => ({
        chromium: {
          launchPersistentContext: async () => ({
            newPage: async () => ({
              goto: async () => undefined,
              click: async () => undefined,
              waitForSelector: async () => undefined,
              title: async () => 'ok',
              content: async () => '<html></html>',
              screenshot: async () => Buffer.from('x'),
              close: async () => undefined,
            }),
            close: async () => undefined,
            pages: () => [],
          }),
        },
      }) as any,
    });

    const accepted = getAssistantPluginManifest(controllerHome, repository, 'browser')
      .actions.find((action) => action.actionId === 'wait_for_selector');
    expect(accepted?.readOnly).toBe(true);
    expect(accepted?.risk).toBe('workspace_write');
    expect(accepted?.confirmation).toBe('authorization');
  });

  test('rejects mismatched url when a session_id is supplied', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });
    mkdirSync(join(repoRoot, '.forge/browser/sessions'), { recursive: true });
    writeFileSync(join(repoRoot, '.forge/browser/sessions/browser_saved.json'), JSON.stringify({
      schemaVersion: 1,
      sessionId: 'browser_saved',
      url: 'https://example.com/',
      title: 'Saved',
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    }));

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'get_text',
      requestId: 'browser-session-url-mismatch',
      args: { session_id: 'browser_saved', url: 'https://evil.test/' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('url does not match the saved session');
  });

  test('route guard aborts requests outside allowed domains', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });
    const runtime = mockPlaywright({ routeUrl: 'https://tracker.evil/pixel' }) as unknown as { routeDecisions: string[] };

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => runtime as never,
    });

    await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-route-guard',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(runtime.routeDecisions).toEqual(['abort:blockedbyclient']);
  });

  test('blocks interaction results that leave the allowed domain set', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => mockPlaywright({ finalUrl: 'https://evil.test/' }),
    });

    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'click',
      requestId: 'browser-click-blocked-domain',
      args: { url: 'https://example.com/', selector: '#cta', post_action_wait_ms: 1 },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_POLICY_BLOCKED');
  });

  test('supports session reuse, fill, selector extraction, and diagnostics capture', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });

    const runtime = mockPlaywright({ title: 'Extracted' }) as unknown as { evaluatedExpressions: unknown[] };
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => true, loadPlaywright: () => runtime as never });

    const opened = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'get_text',
      requestId: 'browser-session-create',
      args: { url: 'https://example.com/' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    const sessionId = String(opened.sessionId);

    const listed = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'list_sessions',
      requestId: 'browser-session-list',
      args: {},
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((listed.sessions as Array<Record<string, unknown>>).some((entry) => entry.sessionId === sessionId)).toBe(true);

    const filled = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'fill',
      requestId: 'browser-fill',
      args: { session_id: sessionId, selector: '#email', text: 'user@example.com', post_action_wait_ms: 1 },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((filled.action as Record<string, unknown>).actionId).toBe('fill');
    expect(filled.screenshot).toBeDefined();

    const extracted = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'snapshot_interactive',
      requestId: 'browser-extract-links',
      args: { session_id: sessionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(extracted.actionId).toBe('snapshot_interactive');
    const selectorScript = String(runtime.evaluatedExpressions.at(-1)); expect(selectorScript).toContain('data-legacy-thread-id');
    expect(selectorScript).toContain('previousElementSibling');
    expect(selectorScript).not.toContain('(index + 1)');

    const consoleErrors = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'get_console_errors',
      requestId: 'browser-console',
      args: { session_id: sessionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(Array.isArray(consoleErrors.consoleErrors)).toBe(true);

    const closed = await executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'close_session',
      requestId: 'browser-session-close',
      args: { session_id: sessionId },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(closed.closed).toBe(true);
  });

  test('keeps a durable handoff, fences its profile, and records explicit resolution', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, { schemaVersion: 1, enabled: true, provider: 'playwright', allowedDomains: ['example.com'] });
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => true, loadPlaywright: () => mockPlaywright() });
    const opened = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'create_session',
      requestId: 'handoff-create', args: { url: 'https://example.com/' }, origin: { surface: 'local-ui', actor: 'test' },
    });
    const sessionId = String((opened.session as Record<string, unknown>).sessionId);
    const specs: string[] = [];
    setBrowserHandoffRuntimeHooksForTest({
      now: () => '2026-07-19T08:00:00.000Z', pidAlive: (pid) => pid === 4242,
      spawnHost: (path) => {
        specs.push(path);
        const spec = JSON.parse(readFileSync(path, 'utf8')) as { interactionId: string };
        patchInteractionSession(repoRoot, 'browser', spec.interactionId, { status: 'waiting_for_user' });
        return { pid: 4242 };
      }, signal: () => undefined,
    });
    const requested = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'request_human_handoff',
      requestId: 'handoff-request', args: { session_id: sessionId, reason: 'captcha' }, origin: { surface: 'local-ui', actor: 'test' },
    });
    const interactionId = String((requested.handoff as Record<string, unknown>).interactionId);
    expect(existsSync(specs[0]!)).toBe(true);
    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'get_text',
      requestId: 'handoff-conflict', args: { session_id: sessionId }, origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_RESOURCE_BUSY');
    const resolved = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'resolve_handoff',
      requestId: 'handoff-resolve', args: { interaction_id: interactionId, resolution: 'resume' }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(resolved.resolutionRequested).toBe('resume');
    expect(existsSync(interactionCommandPath(repoRoot, 'browser', interactionId, 'resume'))).toBe(true);
    patchInteractionSession(repoRoot, 'browser', interactionId, { status: 'completed' });
    const closed = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'close_session',
      requestId: 'handoff-close', args: { session_id: sessionId }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(closed.closed).toBe(true);
  });

  test('reconciles dead and expired hosts without releasing a live profile early', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, { schemaVersion: 1, enabled: true, provider: 'playwright', allowedDomains: ['example.com'] });
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => true, loadPlaywright: () => mockPlaywright() });
    const opened = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'create_session',
      requestId: 'expiry-create', args: { url: 'https://example.com/' }, origin: { surface: 'local-ui', actor: 'test' },
    });
    const sessionId = String((opened.session as Record<string, unknown>).sessionId);
    let now = '2026-07-19T08:00:00.000Z';
    let live = true;
    let signals = 0;
    setBrowserHandoffRuntimeHooksForTest({
      now: () => now, pidAlive: () => live,
      spawnHost: (path) => {
        const spec = JSON.parse(readFileSync(path, 'utf8')) as { interactionId: string };
        patchInteractionSession(repoRoot, 'browser', spec.interactionId, { status: 'waiting_for_user' });
        return { pid: 4343 };
      }, signal: () => { signals += 1; },
    });
    const requested = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'request_human_handoff',
      requestId: 'expiry-request', args: { session_id: sessionId, handoff_timeout_ms: 1_000 }, origin: { surface: 'local-ui', actor: 'test' },
    });
    const interactionId = String((requested.handoff as Record<string, unknown>).interactionId);
    now = '2026-07-19T08:00:02.000Z';
    const closing = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'get_handoff_status',
      requestId: 'expiry-closing', args: { interaction_id: interactionId }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((closing.handoff as Record<string, unknown>).status).toBe('closing');
    expect(signals).toBe(0);
    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'get_text',
      requestId: 'expiry-fenced', args: { session_id: sessionId }, origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_RESOURCE_BUSY');
    live = false;
    const failed = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'get_handoff_status',
      requestId: 'expiry-failed', args: { interaction_id: interactionId }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((failed.handoff as Record<string, unknown>).status).toBe('failed');
    const after = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'get_text',
      requestId: 'expiry-released', args: { session_id: sessionId }, origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(after.url).toBe('https://example.com/');
  });

  test('fails the request instead of returning a stale starting handoff when the host exits before ready', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, { schemaVersion: 1, enabled: true, provider: 'playwright', allowedDomains: ['example.com'] });
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => true, loadPlaywright: () => mockPlaywright() });
    const opened = await executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'create_session',
      requestId: 'startup-failure-create', args: { url: 'https://example.com/' }, origin: { surface: 'local-ui', actor: 'test' },
    });
    const sessionId = String((opened.session as Record<string, unknown>).sessionId);
    setBrowserHandoffRuntimeHooksForTest({
      pidAlive: () => false,
      spawnHost: (path) => {
        writeFileSync(path.replace(/\.json$/u, '.log'), 'Cannot find browser-handoff-host.js');
        return { pid: 4444 };
      },
      signal: () => undefined,
    });
    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot, repoId: 'repo', repoRoot, pluginId: 'browser', actionId: 'request_human_handoff',
      requestId: 'startup-failure-request', args: { session_id: sessionId }, origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('Cannot find browser-handoff-host.js');
    expect(listBrowserHandoffs(repoRoot).at(-1)?.status).toBe('failed');
  });

  const liveSmokeMarker = join(process.cwd(), '.forge', 'run-browser-handoff-live-smoke');
  const liveSmokeEnabled = existsSync(liveSmokeMarker) && (statSync(liveSmokeMarker).mode & 0o111) !== 0;
  if (liveSmokeEnabled) {
    test('live foreground handoff survives the requesting action and releases its profile after resume', async () => {
      const { repoRoot, controllerHome } = repoFixture();
      writeBrowserConfig(repoRoot, {
        schemaVersion: 1,
        enabled: true,
        provider: 'playwright',
        browserChannel: 'chromium',
        allowedDomains: ['127.0.0.1'],
        defaultTimeoutMs: 15_000,
      });
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('<!doctype html><title>Handoff Smoke</title><main id="result">ready</main>', {
          headers: { 'content-type': 'text/html' },
        }),
      });
      const url = `http://127.0.0.1:${server.port}/`;
      const base = {
        controllerHome,
        repoId: 'repo',
        repoRoot,
        pluginId: 'browser',
        origin: { surface: 'local-ui' as const, actor: 'live-smoke' },
      };
      let interactionId: string | undefined;
      try {
        const opened = await executeBrowserPluginAction({
          ...base, actionId: 'create_session', requestId: 'live-smoke-create', args: { url },
        });
        const sessionId = String((opened.session as Record<string, unknown>).sessionId);
        const requested = await executeBrowserPluginAction({
          ...base, actionId: 'request_human_handoff', requestId: 'live-smoke-handoff',
          args: { session_id: sessionId, reason: 'manual_review', handoff_timeout_ms: 30_000 },
        });
        interactionId = String((requested.handoff as Record<string, unknown>).interactionId);
        let handoff: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 100; attempt += 1) {
          handoff = (await executeBrowserPluginAction({
            ...base, actionId: 'get_handoff_status', requestId: `live-smoke-ready-${attempt}`,
            args: { interaction_id: interactionId },
          })).handoff as Record<string, unknown>;
          if (handoff.status === 'waiting_for_user' || ['failed', 'closed'].includes(String(handoff.status))) break;
          await Bun.sleep(100);
        }
        expect(handoff.status).toBe('waiting_for_user');
        expect((handoff.host as Record<string, unknown>).foregroundPresented).toBe(true);
        await executeBrowserPluginAction({
          ...base, actionId: 'resolve_handoff', requestId: 'live-smoke-resume',
          args: { interaction_id: interactionId, resolution: 'resume' },
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          handoff = (await executeBrowserPluginAction({
            ...base, actionId: 'get_handoff_status', requestId: `live-smoke-complete-${attempt}`,
            args: { interaction_id: interactionId },
          })).handoff as Record<string, unknown>;
          if (['completed', 'failed', 'closed'].includes(String(handoff.status))) break;
          await Bun.sleep(100);
        }
        expect(handoff.status).toBe('completed');
        const after = await executeBrowserPluginAction({
          ...base, actionId: 'get_text', requestId: 'live-smoke-after', args: { session_id: sessionId, selector: '#result' },
        });
        expect(after.url).toBe(url);
      } finally {
        if (interactionId) {
          try {
            await executeBrowserPluginAction({
              ...base, actionId: 'resolve_handoff', requestId: 'live-smoke-final-cancel',
              args: { interaction_id: interactionId, resolution: 'cancel' },
            });
            for (let attempt = 0; attempt < 30; attempt += 1) {
              const final = (await executeBrowserPluginAction({
                ...base, actionId: 'get_handoff_status', requestId: `live-smoke-final-${attempt}`,
                args: { interaction_id: interactionId },
              })).handoff as Record<string, unknown>;
              if (['completed', 'closed', 'failed'].includes(String(final.status))) break;
              await Bun.sleep(100);
            }
          } catch {}
        }
        server.stop(true);
      }
    });
  }

  test('selects the Node bridge only for Bun-hosted attached page actions', () => {
    delete process.env.FORGE_BROWSER_NODE_BRIDGE_HOST;
    expect(shouldUseBrowserNodeBridge('open_page', 'attach_preferred', false, true)).toBe(true);
    expect(shouldUseBrowserNodeBridge('open_page', 'attach_preferred', false, false)).toBe(false);
    expect(shouldUseBrowserNodeBridge('list_sessions', 'attach_preferred', false, true)).toBe(false);
    expect(shouldUseBrowserNodeBridge('open_page', 'managed_persistent', false, true)).toBe(false);
    expect(shouldUseBrowserNodeBridge('open_page', 'attach_preferred', true, true)).toBe(false);
    process.env.FORGE_BROWSER_NODE_BRIDGE_HOST = '1';
    expect(shouldUseBrowserNodeBridge('open_page', 'attach_preferred', false, true)).toBe(false);
  });

  test('uses an explicitly configured executable for the Browser Node bridge and fails closed when invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-browser-node-'));
    roots.push(root);
    const executable = join(root, 'node');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executable, 0o700);
    expect(resolveBrowserBridgeNodeExecutable({ FORGE_NODE_EXECUTABLE: executable })).toBe(executable);
    expect(() => resolveBrowserBridgeNodeExecutable({ FORGE_NODE_EXECUTABLE: join(root, 'missing') }))
      .toThrow('PLUGIN_BROWSER_NODE_UNAVAILABLE');
  });

  test('uses a real Bun executable and immutable sibling sidecar for the browser handoff host', () => {
    expect(resolveBrowserHandoffHostExecutable('/opt/forge/forge-runtime', { FORGE_BUN_EXECUTABLE: 'bun' })).toBe('bun');
    expect(resolveBrowserHandoffHostExecutable('/usr/bin/node', {})).toBe('/usr/bin/node');
    expect(resolveBrowserHandoffHostExecutable('/usr/bin/nodejs', {})).toBe('/usr/bin/nodejs');
    const root = mkdtempSync(join(tmpdir(), 'forge-browser-handoff-release-'));
    roots.push(root);
    const runtimeExecutable = join(root, 'forge-runtime');
    const releaseHost = join(root, 'browser-handoff-host.js');
    writeFileSync(releaseHost, 'host');
    expect(resolveBrowserHandoffHostPath(runtimeExecutable, undefined)).toBe(releaseHost);
  });

  test('resolves the Browser Node bridge host from the immutable compiled release before virtual bunfs source', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-browser-node-release-'));
    roots.push(root);
    const runtimeExecutable = join(root, 'forge.js');
    const releaseHost = join(root, 'browser-node-bridge-host.js');
    writeFileSync(runtimeExecutable, 'runtime', 'utf8');
    writeFileSync(releaseHost, 'host', 'utf8');
    expect(resolveBrowserNodeBridgeHostPath({
      runtimeExecutable,
      argvEntry: '/$bunfs/root/forge.js',
      sourceHostPath: '/$bunfs/root/src/runtime/plugins/browser-node-bridge-host.ts',
    })).toBe(releaseHost);
  });

  test('fails closed when a compiled release omits the Browser Node bridge host', () => {
    expect(() => resolveBrowserNodeBridgeHostPath({
      runtimeExecutable: '/tmp/missing-release/forge.js',
      argvEntry: '/$bunfs/root/forge.js',
      sourceHostPath: '/$bunfs/root/src/runtime/plugins/browser-node-bridge-host.ts',
      pathExists: () => false,
    })).toThrow('PLUGIN_BROWSER_NODE_HOST_UNAVAILABLE');
  });

  test('keeps the source Browser Node bridge host for non-compiled development runtimes', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-browser-node-source-'));
    roots.push(root);
    const sourceHost = join(root, 'browser-node-bridge-host.ts');
    writeFileSync(sourceHost, 'host', 'utf8');
    expect(resolveBrowserNodeBridgeHostPath({
      runtimeExecutable: '/opt/homebrew/bin/bun',
      argvEntry: join(root, 'src', 'cli', 'index.ts'),
      sourceHostPath: sourceHost,
    })).toBe(sourceHost);
  });

  test('denies open_page outside allowed domains before launch', async () => {
    const { repoRoot } = repoFixture();
    writeBrowserConfig(repoRoot, {
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      allowedDomains: ['example.com'],
    });
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => mockPlaywright(),
    });
    await expect(executeBrowserPluginAction({
      controllerHome: repoRoot,
      repoId: 'repo',
      repoRoot,
      pluginId: 'browser',
      actionId: 'open_page',
      requestId: 'browser-deny-domain',
      args: { url: 'https://evil.test/' },
      origin: { surface: 'local-ui', actor: 'test' },
    })).rejects.toThrow('PLUGIN_POLICY_BLOCKED');
  });
});
