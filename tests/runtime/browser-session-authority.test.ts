import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildBrowserPluginManifest,
  executeBrowserPluginAction,
  resetBrowserPluginRuntimeHooksForTest,
  resolveBrowserPluginAuthorizationContext,
  setBrowserPluginRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-adapter';
import {
  invalidateMacOsBrowserPageHandles,
  reattachMacOsBrowserOwnedPage,
  resetMacOsBrowserRuntimeHooksForTest,
  setMacOsBrowserRuntimeHooksForTest,
} from '../../src/runtime/plugins/browser-macos-bridge';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import {
  cleanupBrowserSessionTombstones,
  closeLegacyBrowserSessionImportCutover,
  ensureLegacyBrowserSessionsImported,
  findBrowserSession,
  listAllBrowserSessionsForRepository,
  listBrowserSessions,
  saveBrowserSession,
  tombstoneBrowserSession,
} from '../../src/runtime/plugins/browser-session-authority';
import { findBrowserSession as findComputerBackedBrowserSession } from '../../src/runtime/plugins/browser-session-store';
import { readLegacyBrowserSessionMigrationEntries } from '../../src/runtime/plugins/browser-session-legacy-migration';
import { withRuntimeBrowserSessionAuthorityContext } from '../../src/runtime/root/browser-session-composition';
import {
  withControlPlaneTransaction,
  writeControlPlaneRecordWithinTransaction,
} from '../../src/runtime/control-plane/persistence/sqlite-store';

const roots: string[] = [];
afterEach(() => {
  resetBrowserPluginRuntimeHooksForTest();
  resetMacOsBrowserRuntimeHooksForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-browser-authority-'));
  roots.push(root);
  return {
    controllerHome: join(root, 'controller'),
    repoA: join(root, 'repo-a'),
    repoB: join(root, 'repo-b'),
  };
}

const SUPERVISOR_EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxFzo1eixjsWsZbN1pBuyzdKinJSAAuzTRavD0xFQFwrTIEQ7hxxueEBEhifpGq9nplNnmxmZvIL7PJycEAYT8mrbyXBLCPR1jQBuL4YR775phnlNVpF3dHX5OWDHLWRnHRgOO1FibQ54fM2rKylr66+x+J6/4C7a9dpiSMuxf3fOStXA6wJb0d7A4E22Q1+GGfWgs0NCyVI5k4aczK+J5Ao61ZXKBr8Qw/FCmwhCcDgQdIpURgoMHkyvQH3ryYWocucjRhMVsU8H65adIIKFHkEhPJCiVY64L6bu6kNR2fpf0yJ1GvI5ota6Hf4NAEi7Yt7PL7i3ISyv3pPQWW1nIwIDAQAB';
const SUPERVISOR_EXTENSION_ID = 'glinahpcibpcfcimdcceplmfkgcjehin';

function extensionFixture(repoRoot: string): string {
  const extensionPath = join(repoRoot, 'extension-fixture');
  mkdirSync(extensionPath, { recursive: true });
  writeFileSync(join(extensionPath, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Forge extension fixture', version: '1.0.0',
    key: SUPERVISOR_EXTENSION_KEY, background: { service_worker: 'background.js' },
  }));
  writeFileSync(join(extensionPath, 'background.js'), 'console.log("fixture");\n');
  return extensionPath;
}

function computerBackedSession(controllerHome: string, repoId: string, repoRoot: string, sessionId: string) {
  return withRuntimeBrowserSessionAuthorityContext(
    { controllerHome, repoId },
    () => findComputerBackedBrowserSession(repoRoot, sessionId),
  );
}

function session(
  sessionId: string,
  updatedAt: string,
  options: { native?: boolean; windowId?: string; tabId?: string; repoMarker?: string; product?: 'chrome' | 'vivaldi' } = {},
) {
  return {
    schemaVersion: 1 as const,
    sessionId,
    url: `https://example.com/${options.repoMarker ?? sessionId}`,
    title: sessionId,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt,
    browser: options.native ? {
      mode: 'attach_preferred',
      activeMode: 'attach_preferred',
      provider: 'macos-apple-events',
      browserProduct: options.product ?? 'chrome',
      tab: {
        key: sessionId,
        index: 0,
        url: `https://example.com/${sessionId}`,
        matchedBy: 'saved_url',
        inventoryCount: 1,
        capturedAt: updatedAt,
        ownership: 'user_owned',
        windowId: options.windowId ?? '7',
        tabId: options.tabId ?? '9',
      },
    } : {
      mode: 'managed_persistent',
      activeMode: 'managed_persistent',
      provider: 'playwright-persistent-context',
    },
  };
}

describe('browser session compatibility on Computer target authority', () => {
  test('imports repo-local legacy sessions only once', () => {
    const { controllerHome, repoA } = fixture();
    const legacyRoot = join(repoA, '.forge', 'browser', 'sessions');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'one.json'), JSON.stringify(session('legacy-one', '2026-08-24T01:00:00.000Z')));

    expect(ensureLegacyBrowserSessionsImported(controllerHome, 'repo-a', repoA)).toBe(1);
    expect(listBrowserSessions(controllerHome, 'repo-a', repoA).sessions.map((entry) => entry.sessionId)).toEqual(['legacy-one']);
    expect(existsSync(join(legacyRoot, 'one.json'))).toBe(false);

    writeFileSync(join(legacyRoot, 'two.json'), JSON.stringify(session('legacy-two', '2026-08-24T02:00:00.000Z')));
    expect(ensureLegacyBrowserSessionsImported(controllerHome, 'repo-a', repoA)).toBe(0);
    expect(listBrowserSessions(controllerHome, 'repo-a', repoA).sessions.map((entry) => entry.sessionId)).toEqual(['legacy-one']);
    expect(existsSync(join(legacyRoot, 'two.json'))).toBe(false);
  });

  test('deduplicates one native tab globally while keeping managed sessions repository-bound', () => {
    const { controllerHome, repoA, repoB } = fixture();
    const first = saveBrowserSession(controllerHome, 'repo-a', repoA, session('native-a', '2026-08-24T01:00:00.000Z', { native: true }));
    const second = saveBrowserSession(controllerHome, 'repo-b', repoB, session('native-b', '2026-08-24T02:00:00.000Z', { native: true }));
    expect(first.sessionId).toBe('native-a');
    expect(second.sessionId).toBe('native-a');
    expect(findBrowserSession(controllerHome, 'repo-b', repoB, 'native-b')?.sessionId).toBe('native-a');
    expect(listBrowserSessions(controllerHome, 'repo-b', repoB).sessions.map((entry) => entry.sessionId)).toEqual(['native-a']);

    saveBrowserSession(controllerHome, 'repo-a', repoA, session('managed-a', '2026-08-24T03:00:00.000Z'));
    expect(listBrowserSessions(controllerHome, 'repo-b', repoB).sessions.map((entry) => entry.sessionId)).toEqual(['native-a']);
    expect(listBrowserSessions(controllerHome, 'repo-a', repoA).sessions.map((entry) => entry.sessionId)).toEqual(['managed-a', 'native-a']);
  });

  test('Browser-owned retention is retired while Computer tombstones remain authoritative', () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(repoA, { recursive: true });
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('active-keep', '2026-08-24T01:00:00.000Z'));
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('stale-drop', '2026-08-24T02:00:00.000Z'));
    expect(tombstoneBrowserSession(controllerHome, 'repo-a', repoA, 'stale-drop')).toBe(true);

    const retiredRetention = cleanupBrowserSessionTombstones(controllerHome, {
      nowMs: Date.now() + 31 * 24 * 60 * 60_000,
      ttlMs: 30 * 24 * 60 * 60_000,
    });
    expect(retiredRetention).toMatchObject({ cutoverClosed: true, removed: 0, blockers: [] });
    const cutover = closeLegacyBrowserSessionImportCutover(controllerHome, [{ repoId: 'repo-a', repoRoot: repoA }]);
    expect(cutover).toMatchObject({ closed: true, alreadyClosed: true, migratedRecordCount: 0 });
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, 'stale-drop')).toBeUndefined();
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, 'active-keep')?.sessionId).toBe('active-keep');
  });

  test('tombstones canonical native identities across aliases', () => {
    const { controllerHome, repoA, repoB } = fixture();
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('native-a', '2026-08-24T01:00:00.000Z', { native: true }));
    saveBrowserSession(controllerHome, 'repo-b', repoB, session('native-b', '2026-08-24T02:00:00.000Z', { native: true }));
    expect(tombstoneBrowserSession(controllerHome, 'repo-b', repoB, 'native-b')).toBe(true);
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, 'native-a')).toBeUndefined();
    expect(findBrowserSession(controllerHome, 'repo-b', repoB, 'native-b')).toBeUndefined();
  });

  test('legacy import may observe but cannot resurrect a tombstoned native identity from another repository', () => {
    const { controllerHome, repoA, repoB } = fixture();
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('native-a', '2026-08-24T01:00:00.000Z', { native: true }));
    expect(tombstoneBrowserSession(controllerHome, 'repo-a', repoA, 'native-a')).toBe(true);

    const legacyRoot = join(repoB, '.forge', 'browser', 'sessions');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'native-b.json'), JSON.stringify(
      session('native-b', '2026-08-24T02:00:00.000Z', { native: true }),
    ));

    expect(ensureLegacyBrowserSessionsImported(controllerHome, 'repo-b', repoB)).toBe(1);
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, 'native-a')).toBeUndefined();
    expect(findBrowserSession(controllerHome, 'repo-b', repoB, 'native-b')).toBeUndefined();
    expect(listBrowserSessions(controllerHome, 'repo-b', repoB).sessions).toEqual([]);
  });

  test('bounds and paginates listing', () => {
    const { controllerHome, repoA } = fixture();
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('one', '2026-08-24T01:00:00.000Z'));
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('two', '2026-08-24T02:00:00.000Z'));
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('three', '2026-08-24T03:00:00.000Z'));

    const first = listBrowserSessions(controllerHome, 'repo-a', repoA, { limit: 2 });
    expect(first.sessions.map((entry) => entry.sessionId)).toEqual(['three', 'two']);
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).toBeTruthy();

    const second = listBrowserSessions(controllerHome, 'repo-a', repoA, { limit: 2, cursor: first.nextCursor });
    expect(second.sessions.map((entry) => entry.sessionId)).toEqual(['one']);
    expect(second.nextCursor).toBeUndefined();
  });
  test('legacy migration reader scans beyond the bounded 5000-record diagnostic limit without materializing Computer targets', () => {
    const { controllerHome, repoA } = fixture();
    const updatedAt = '2026-08-24T01:00:00.000Z';
    withControlPlaneTransaction(controllerHome, (database) => {
      for (let index = 0; index <= 5_000; index += 1) {
        const sessionId = `bulk-${String(index).padStart(5, '0')}`;
        writeControlPlaneRecordWithinTransaction(database, {
          namespace: 'browser_session',
          scope: 'controller',
          key: `bulk-record-${String(index).padStart(5, '0')}`,
          schemaVersion: 1,
          expectedRevision: null,
          action: 'test_seed',
          value: {
            schemaVersion: 1,
            status: 'active',
            session: session(sessionId, updatedAt),
            aliases: [sessionId],
            repositoryIds: ['repo-a'],
          },
        });
      }
    });

    const legacy = readLegacyBrowserSessionMigrationEntries({ controllerHome, repoId: 'repo-a', repoRoot: repoA });
    expect(legacy).toHaveLength(5_001);
    expect(legacy.some((entry) => entry.session.sessionId === 'bulk-05000')).toBe(true);
  });

  test('legacy migration canonicalizes historical numeric native tab ids before Computer authority', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1, enabled: true, provider: 'playwright', browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed', nativeAttachMode: 'auto',
    }));
    const updatedAt = '2026-08-24T01:00:00.000Z';
    const legacySession = session('legacy-numeric-native', updatedAt, { native: true });
    const legacyTab = legacySession.browser?.tab as unknown as Record<string, unknown>;
    legacyTab.windowId = 2_095_923_550;
    legacyTab.tabId = 2_095_923_553;
    withControlPlaneTransaction(controllerHome, (database) => {
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'browser_session', scope: 'controller', key: 'legacy-numeric-native', schemaVersion: 1,
        expectedRevision: null, action: 'test_seed',
        value: { schemaVersion: 1, status: 'active', session: legacySession, aliases: ['legacy-numeric-native'], repositoryIds: ['repo-a'] },
      });
    });

    const listed = await executeBrowserPluginAction({
      controllerHome, repoId: 'repo-a', repoRoot: repoA, pluginId: 'browser', requestId: 'legacy-numeric-list',
      origin: { surface: 'mcp', actor: 'test' }, actionId: 'list_sessions', args: {},
    });
    const migrated = (listed.sessions as Array<{ sessionId: string; browser?: { tab?: { windowId?: string; tabId?: string } } }>).find((entry) => entry.sessionId === 'legacy-numeric-native');
    expect(migrated?.browser?.tab).toMatchObject({ windowId: '2095923550', tabId: '2095923553' });
    expect(computerBackedSession(controllerHome, 'repo-a', repoA, 'legacy-numeric-native')?.browser?.tab)
      .toMatchObject({ windowId: '2095923550', tabId: '2095923553' });
  });

  test('legacy migration rejects malformed nested native ids with the Browser corruption contract', () => {
    const { controllerHome, repoA } = fixture();
    const legacySession = session('legacy-malformed-native', '2026-08-24T01:00:00.000Z', { native: true });
    const legacyTab = legacySession.browser?.tab as unknown as Record<string, unknown>;
    legacyTab.windowId = { unexpected: true };
    withControlPlaneTransaction(controllerHome, (database) => {
      writeControlPlaneRecordWithinTransaction(database, {
        namespace: 'browser_session', scope: 'controller', key: 'legacy-malformed-native', schemaVersion: 1,
        expectedRevision: null, action: 'test_seed',
        value: { schemaVersion: 1, status: 'active', session: legacySession, aliases: ['legacy-malformed-native'], repositoryIds: ['repo-a'] },
      });
    });

    let failure: unknown;
    try { readLegacyBrowserSessionMigrationEntries({ controllerHome, repoId: 'repo-a', repoRoot: repoA }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AssistantPluginError);
    expect((failure as AssistantPluginError).code).toBe('PLUGIN_BROWSER_SESSION_STATE_CORRUPT');
    expect((failure as AssistantPluginError).details?.field).toBe('browser.tab.windowId');
  });

  test('browser adapter lists central authority with bounded pagination and authorization sees migrated sessions', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
    }));
    const legacyRoot = join(repoA, '.forge', 'browser', 'sessions');
    mkdirSync(legacyRoot, { recursive: true });
    for (const [id, at] of [['one', '2026-08-24T01:00:00.000Z'], ['two', '2026-08-24T02:00:00.000Z'], ['three', '2026-08-24T03:00:00.000Z']] as const) {
      writeFileSync(join(legacyRoot, `${id}.json`), JSON.stringify(session(id, at, id === 'three' ? { native: true } : {})));
    }
    const baseInput = {
      controllerHome,
      repoId: 'repo-a',
      repoRoot: repoA,
      pluginId: 'browser',
      requestId: 'browser-authority-adapter',
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const first = await executeBrowserPluginAction({ ...baseInput, actionId: 'list_sessions', args: { limit: 2 } });
    expect(first.sessionCountSemantics).toBe('controller_authority');
    expect(first.totalCount).toBe(3);
    expect((first.sessions as Array<{ sessionId: string }>).map((entry) => entry.sessionId)).toEqual(['three', 'two']);
    expect(first.nextCursor).toBeTruthy();
    const second = await executeBrowserPluginAction({ ...baseInput, actionId: 'list_sessions', args: { limit: 2, cursor: first.nextCursor } });
    expect((second.sessions as Array<{ sessionId: string }>).map((entry) => entry.sessionId)).toEqual(['one']);

    const auth = await resolveBrowserPluginAuthorizationContext({
      ...baseInput,
      actionId: 'click',
      args: { session_id: 'three', selector: '#submit' },
    });
    expect(auth?.target.kind).toBe('browser-origin');
    expect(auth?.target.id).toBe('chrome@https://example.com');

    const navigateAuth = await resolveBrowserPluginAuthorizationContext({
      ...baseInput,
      actionId: 'navigate',
      args: { session_id: 'three', url: 'https://chatgpt.com/' },
    });
    expect(navigateAuth?.target.kind).toBe('browser-origin');
    expect(navigateAuth?.target.id).toBe('chrome@https://chatgpt.com');

    const createSessionAuth = await resolveBrowserPluginAuthorizationContext({
      ...baseInput,
      actionId: 'create_session',
      args: { session_id: 'three', url: 'https://chatgpt.com/' },
    });
    expect(createSessionAuth?.target.kind).toBe('browser-origin');
    expect(createSessionAuth?.target.id).toBe('chrome@https://example.com');
  });

  test('native active-tab adoption distinguishes browser-active from authoritative system foreground', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome'],
    }));

    const separator = String.fromCharCode(30);
    const url = 'https://example.com/native-adoption';
    const metadata = [
      'false', url, 'Native Adoption', '0', '0', '1200', '800', '7', '9', 'true', 'false',
    ].join(separator);
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async () => metadata,
    });

    const baseInput = {
      controllerHome,
      repoId: 'repo-a',
      repoRoot: repoA,
      pluginId: 'browser',
      requestId: 'native-adoption',
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const explicit = await executeBrowserPluginAction({
      ...baseInput,
      actionId: 'create_session',
      args: { url, native_active_tab: true, native_browser_product: 'chrome' },
    });
    const connection = explicit.browserConnection as { sessionResume?: { reason?: string } };
    expect(connection.sessionResume?.reason).toContain('system-frontmost authority was not established');

    await expect(executeBrowserPluginAction({
      ...baseInput,
      requestId: 'native-adoption-strict',
      actionId: 'create_session',
      args: { url, native_active_tab: true },
    })).rejects.toMatchObject({ code: 'PLUGIN_BROWSER_ACTIVE_TAB_UNAVAILABLE' });
  });

  test('activate_page recovers system foreground through Desktop Operator and preserves exact native tab for trusted input', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome', 'vivaldi'],
    }));

    const separator = String.fromCharCode(30);
    const fieldSeparator = String.fromCharCode(31);
    const url = 'https://example.com/native-foreground';
    let frontmost = false;
    const activations: string[] = [];
    const trustedRefs: Array<{ product?: string; windowId?: string; tabId?: string }> = [];
    const metadata = () => [
      frontmost ? 'true' : 'false', url, 'Native Foreground', '0', '0', '1200', '800', '7', '9', 'true', 'false',
    ].join(separator);
    const inventory = () => `false${separator}7${fieldSeparator}9${fieldSeparator}true${fieldSeparator}${url}${fieldSeparator}Native Foreground`;

    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => false,
      activateNativeBrowserApplication: async (_input, product) => {
        activations.push(product);
        frontmost = true;
      },
    });
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('set outputText to "false"')) return inventory();
        if (script.includes('set active tab index of targetWindow')) return '';
        if (script.includes('execute targetTab javascript')) {
          return JSON.stringify({ ok: true, value: { url, title: 'Native Foreground' } });
        }
        return metadata();
      },
      trustedInput: async (request) => {
        trustedRefs.push({
          product: request.product,
          windowId: request.ref.windowId,
          tabId: request.ref.tabId,
        });
      },
    });

    saveBrowserSession(controllerHome, 'repo-a', repoA, {
      ...session('native-foreground', '2026-08-24T04:00:00.000Z', { native: true, windowId: '7', tabId: '9' }),
      url,
      title: 'Native Foreground',
      browser: {
        ...session('native-foreground', '2026-08-24T04:00:00.000Z', { native: true, windowId: '7', tabId: '9' }).browser,
        tab: {
          key: 'native-foreground', index: 0, url, title: 'Native Foreground', matchedBy: 'saved_url', inventoryCount: 1,
          capturedAt: '2026-08-24T04:00:00.000Z', ownership: 'user_owned', windowId: '7', tabId: '9',
        },
      },
    });

    const baseInput = {
      controllerHome,
      repoId: 'repo-a',
      repoRoot: repoA,
      pluginId: 'browser',
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const activated = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'native-foreground-activate',
      actionId: 'activate_page',
      args: { session_id: 'native-foreground', post_action_wait_ms: 1 },
    });
    expect((activated.action as { summary?: string }).summary).toContain('authoritative foreground');
    expect(activations).toEqual(['chrome']);

    await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'native-foreground-trusted-input',
      actionId: 'trusted_input',
      args: { session_id: 'native-foreground', kind: 'click', x: 10, y: 20, post_action_wait_ms: 1 },
    });
    expect(trustedRefs).toEqual([{ product: 'chrome', windowId: '7', tabId: '9' }]);
  });

  test('legacy native broker without tab inventory creates and closes only the exact plugin-owned tab', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome'],
    }));

    const separator = String.fromCharCode(30);
    const url = 'https://example.com/legacy-inventory';
    let tabExists = false;
    let inventoryCalls = 0;
    let createCalls = 0;
    let closeCalls = 0;
    const metadata = () => [
      'false', url, 'Legacy Inventory', '0', '0', '1200', '800', '7', tabExists ? '9' : '3', tabExists ? 'false' : 'true', 'false',
    ].join(separator);

    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script) => {
        if (script.includes('set outputText to "false"')) {
          inventoryCalls += 1;
          throw new AssistantPluginError('BROWSER_AUTOMATION_ACTION_UNSUPPORTED', 'list_tabs is unavailable in the legacy broker.', { retryable: false });
        }
        if (script.includes('make new tab at end of tabs of targetWindow')) {
          createCalls += 1;
          tabExists = true;
          return `7${separator}9`;
        }
        if (script.includes('close targetTab')) {
          closeCalls += 1;
          tabExists = false;
          return '';
        }
        if (script.includes('execute targetTab javascript')) {
          return JSON.stringify({ ok: true, value: { url, title: 'Legacy Inventory' }, page: { url, title: 'Legacy Inventory' } });
        }
        if (script.includes('set targetTabId to "9"') && !tabExists) {
          throw new Error('Google Chrome got an error: Can’t get tab whose id = "9". Invalid index. (-1719)');
        }
        return metadata();
      },
    });

    const baseInput = {
      controllerHome,
      repoId: 'repo-a',
      repoRoot: repoA,
      pluginId: 'browser',
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const opened = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'legacy-inventory-open',
      actionId: 'create_session',
      args: { url, browser_mode: 'attach_preferred', native_browser_candidates: ['chrome'], cdp_attach_fallback: 'fail_closed' },
    });
    const openedSession = opened.session as { sessionId: string; browser?: { provider?: string; tab?: { ownership?: string; windowId?: string; tabId?: string } } };
    expect(openedSession.browser?.provider).toBe('macos-apple-events');
    expect(openedSession.browser?.tab).toMatchObject({ ownership: 'plugin_owned', windowId: '7', tabId: '9' });
    expect(createCalls).toBe(1);
    expect(inventoryCalls).toBe(1);

    const listed = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'legacy-inventory-list',
      actionId: 'list_sessions',
      args: {},
    });
    expect(listed).toMatchObject({ liveNativeSessionCount: 1, unverifiedSessionCount: 0 });
    expect(inventoryCalls).toBe(2);

    const closed = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'legacy-inventory-close',
      actionId: 'close_session',
      args: { session_id: openedSession.sessionId },
    });
    expect(closed).toMatchObject({ closed: true, resourceClosed: true });
    expect(closeCalls).toBe(1);
    expect(inventoryCalls).toBe(3);
  });

  test('replaces a missing plugin-owned native tab after exact identity becomes stale', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome'],
    }));

    const separator = String.fromCharCode(30);
    const fieldSeparator = String.fromCharCode(31);
    const url = 'https://example.com/forge-owned';
    const userUrl = 'https://user.example.net/keep';
    let ownedTabId = '';
    let ownedExists = false;
    let createCalls = 0;
    const metadata = () => [
      'false', ownedExists ? url : userUrl, ownedExists ? 'Forge Owned' : 'User Tab',
      '0', '0', '1200', '800', '7', ownedExists ? ownedTabId : '3', ownedExists ? 'false' : 'true', 'false',
    ].join(separator);
    const userTab = () => ({ windowId: '7', tabId: '3', active: true, url: userUrl, title: 'User Tab' });
    const inventoryRaw = () => {
      const records = [`7${fieldSeparator}3${fieldSeparator}true${fieldSeparator}${userUrl}${fieldSeparator}User Tab`];
      if (ownedExists) records.push(`7${fieldSeparator}${ownedTabId}${fieldSeparator}false${fieldSeparator}${url}${fieldSeparator}Forge Owned`);
      return `false${separator}${records.join(separator)}`;
    };

    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      tabInventory: async () => ({
        product: 'chrome',
        truncated: false,
        tabs: ownedExists
          ? [
              userTab(),
              { windowId: '7', tabId: ownedTabId, active: false, url, title: 'Forge Owned' },
            ]
          : [userTab()],
      }),
      runAppleScript: async (script, args = []) => {
        if (script.includes('set outputText to "false"')) return inventoryRaw();
        if (script.includes('make new tab at end of tabs of targetWindow')) {
          createCalls += 1;
          ownedTabId = createCalls === 1 ? '9' : '10';
          ownedExists = true;
          return `7${separator}${ownedTabId}`;
        }
        if (script.includes('close targetTab')) {
          ownedExists = false;
          return '';
        }
        if (script.includes('execute targetTab javascript')) {
          const source = args[0] ?? '';
          const value = source.includes('document.readyState')
            ? 'complete'
            : source.includes('textContent') || source.includes('innerText')
              ? 'Recovered Body'
              : { url, title: 'Forge Owned' };
          return JSON.stringify({ ok: true, value, page: { url, title: 'Forge Owned' } });
        }
        return metadata();
      },
    });

    const baseInput = {
      controllerHome,
      repoId: 'repo-a',
      repoRoot: repoA,
      pluginId: 'browser',
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const opened = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'stale-owned-open',
      actionId: 'create_session',
      args: { url, browser_mode: 'attach_preferred', native_browser_candidates: ['chrome'], cdp_attach_fallback: 'fail_closed' },
    });
    const sessionId = String((opened.session as { sessionId: string }).sessionId);
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, sessionId)?.browser?.tab).toMatchObject({ ownership: 'plugin_owned', tabId: '9' });
    expect(computerBackedSession(controllerHome, 'repo-a', repoA, sessionId)?.browser?.tab).toMatchObject({ ownership: 'plugin_owned', tabId: '9' });

    ownedExists = false;
    invalidateMacOsBrowserPageHandles();
    const observed = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'stale-owned-read',
      actionId: 'get_text',
      args: { session_id: sessionId, selector: 'body' },
    });

    expect(observed.text).toBe('Recovered Body');
    expect(createCalls).toBe(2);
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, sessionId)?.browser?.tab).toMatchObject({ ownership: 'plugin_owned', tabId: '10' });
    expect(computerBackedSession(controllerHome, 'repo-a', repoA, sessionId)?.browser?.tab).toMatchObject({ ownership: 'plugin_owned', tabId: '10' });
  });

  test('native cold rebind reports and persists the live same-origin URL after external drift', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome'],
    }));

    const separator = String.fromCharCode(30);
    const originalUrl = 'https://example.com/native-drift';
    const driftedUrl = 'https://example.com/native-drift/changed';
    let currentUrl = originalUrl;
    let tabExists = false;
    const metadata = () => [
      'false', currentUrl, 'Native Drift', '0', '0', '1200', '800', '7', '9', 'false', 'false',
    ].join(separator);

    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async (script, args = []) => {
        if (script.includes('set outputText to "false"')) {
          throw new AssistantPluginError('BROWSER_AUTOMATION_ACTION_UNSUPPORTED', 'list_tabs is unavailable.', { retryable: false });
        }
        if (script.includes('make new tab at end of tabs of targetWindow')) {
          tabExists = true;
          currentUrl = args[0] ?? originalUrl;
          return `7${separator}9`;
        }
        if (script.includes('set targetTabId to "9"') && !tabExists) {
          throw new Error('Google Chrome got an error: Can’t get tab whose id = "9". Invalid index. (-1719)');
        }
        if (script.includes('close targetTab')) {
          tabExists = false;
          return '';
        }
        if (script.includes('execute targetTab javascript')) {
          const source = args[0] ?? '';
          const value = source.includes('document.readyState')
            ? 'complete'
            : source.includes('textContent') || source.includes('innerText')
              ? 'Drifted Body'
              : { url: currentUrl, title: 'Native Drift' };
          return JSON.stringify({ ok: true, value, page: { url: currentUrl, title: 'Native Drift' } });
        }
        return metadata();
      },
    });

    const baseInput = {
      controllerHome,
      repoId: 'repo-a',
      repoRoot: repoA,
      pluginId: 'browser',
      origin: { surface: 'mcp' as const, actor: 'test' },
    };
    const opened = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'native-drift-open',
      actionId: 'create_session',
      args: { url: originalUrl, browser_mode: 'attach_preferred', native_browser_candidates: ['chrome'], cdp_attach_fallback: 'fail_closed' },
    });
    const sessionId = String((opened.session as { sessionId: string }).sessionId);

    currentUrl = driftedUrl;
    invalidateMacOsBrowserPageHandles();
    const observed = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'native-drift-read',
      actionId: 'get_text',
      args: { session_id: sessionId, selector: 'body' },
    });
    expect(observed.url).toBe(driftedUrl);
    expect(observed.text).toBe('Drifted Body');
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, sessionId)?.url).toBe(driftedUrl);
    expect(computerBackedSession(controllerHome, 'repo-a', repoA, sessionId)?.url).toBe(driftedUrl);

    const closed = await executeBrowserPluginAction({
      ...baseInput,
      requestId: 'native-drift-close',
      actionId: 'close_session',
      args: { session_id: sessionId },
    });
    expect(closed).toMatchObject({ closed: true, resourceClosed: true });
  });

  test('successful exact native reattach publishes Browser health evidence', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      provider: 'playwright',
      browserMode: 'attach_preferred',
      cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['chrome'],
    }));

    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    const separator = String.fromCharCode(30);
    const metadata = [
      'false', 'https://example.com/native-health', 'Native Health', '0', '0', '1200', '800', '7', '9', 'false', 'false',
    ].join(separator);
    setMacOsBrowserRuntimeHooksForTest({
      platform: 'darwin',
      appExists: () => true,
      processRunning: async () => true,
      runAppleScript: async () => metadata,
    });

    const manifestContext = { controllerHome, repoId: 'repo-a', repoRoot: repoA, controllerScoped: false };
    const before = buildBrowserPluginManifest(1, undefined, repoA, manifestContext);
    expect(before.health.state).toBe('degraded');
    expect(before.health.ready).toBe(false);
    expect(before.health.warnings).toContain('Native active-browser attach has not completed a live probe in this Runtime instance.');

    await reattachMacOsBrowserOwnedPage('chrome', { windowId: '7', tabId: '9' }, 1_000);

    const after = buildBrowserPluginManifest(2, undefined, repoA, manifestContext);
    expect(after.health.state).toBe('ready');
    expect(after.health.ready).toBe(true);
    expect(after.health.probed).toBe(true);
    expect(after.health.details?.nativeAttachObservation).toMatchObject({
      ready: true,
      selectedProduct: 'chrome',
      attempts: [{ product: 'chrome', status: 'selected' }],
    });
  });

  test('installs unpacked extension through browser-level CDP and verifies exact id/path before success', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    const extensionPath = extensionFixture(repoA);
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 2, enabled: true, provider: 'playwright', browserMode: 'attach_preferred',
      profileMode: 'repo_local', browserChannel: 'chrome', cdpEndpoint: 'http://127.0.0.1:9222',
      cdpAttachFallback: 'fail_closed', nativeAttachMode: 'disabled',
    }));
    const canonicalExtensionPath = realpathSync(extensionPath);
    const methods: string[] = [];
    let disconnected = 0;
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      fetchJson: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test', Browser: 'Chrome/153' }),
      loadPlaywright: () => ({
        chromium: {
          launchPersistentContext: async () => { throw new Error('managed launch must not run'); },
          connectOverCDP: async () => ({
            contexts: () => [],
            newBrowserCDPSession: async () => ({
              send: async (method: string, params?: Record<string, unknown>) => {
                methods.push(method);
                if (method === 'Extensions.loadUnpacked') {
                  expect(params).toEqual({ path: canonicalExtensionPath });
                  return { id: SUPERVISOR_EXTENSION_ID };
                }
                if (method === 'Extensions.getExtensions') {
                  return { extensions: [{ id: SUPERVISOR_EXTENSION_ID, name: 'Forge extension fixture', version: '1.0.0', path: canonicalExtensionPath, enabled: true }] };
                }
                throw new Error('unexpected method ' + method);
              },
            }),
            disconnect: () => { disconnected += 1; },
          }),
        },
      }),
    });
    const result = await executeBrowserPluginAction({
      controllerHome, repoId: 'repo-a', repoRoot: repoA, pluginId: 'browser',
      requestId: 'extension-cdp-install', actionId: 'install_unpacked_extension',
      args: { extension_path: extensionPath }, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(methods).toEqual(['Extensions.loadUnpacked', 'Extensions.getExtensions']);
    expect(disconnected).toBe(1);
    expect(result).toMatchObject({ provider: 'playwright-cdp', extension: { id: SUPERVISOR_EXTENSION_ID, path: canonicalExtensionPath, enabled: true }, verified: true });
  });

  test('managed extension install removes Playwright extension suppression and verifies the exact runtime target', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    const extensionPath = extensionFixture(repoA);
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 2, enabled: true, provider: 'playwright', browserMode: 'managed_persistent',
      profileMode: 'repo_local', browserChannel: 'chrome', cdpAttachFallback: 'fail_closed', nativeAttachMode: 'disabled',
    }));
    const canonicalExtensionPath = realpathSync(extensionPath);
    const nativeHostPath = join(repoA, 'forge-native-host');
    writeFileSync(nativeHostPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(extensionPath, 'forge-native-messaging-host.json'), JSON.stringify({
      name: 'com.moretea.forge.fixture',
      description: 'fixture',
      path: nativeHostPath,
      type: 'stdio',
      allowed_origins: ['chrome-extension://' + SUPERVISOR_EXTENSION_ID + '/'],
    }));
    let launchOptions: Record<string, unknown> | undefined;
    let launchedProfileDir = '';
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => ({
        chromium: {
          launchPersistentContext: async (_dir: string, options: Record<string, unknown>) => {
            launchedProfileDir = _dir;
            launchOptions = options;
            return {
              pages: () => [],
              newPage: async () => { throw new Error('page creation is not required'); },
              close: async () => undefined,
              serviceWorkers: () => [{ url: () => 'chrome-extension://' + SUPERVISOR_EXTENSION_ID + '/background.js' }],
            };
          },
        },
      }),
    });
    const result = await executeBrowserPluginAction({
      controllerHome, repoId: 'repo-a', repoRoot: repoA, pluginId: 'browser',
      requestId: 'extension-managed-install', actionId: 'install_unpacked_extension',
      args: { extension_path: extensionPath }, origin: { surface: 'mcp', actor: 'test' },
    });
    expect(launchOptions?.channel).toBeUndefined();
    expect(launchOptions?.ignoreDefaultArgs).toEqual(['--disable-extensions']);
    expect(launchOptions?.args).toEqual([
      '--disable-extensions-except=' + canonicalExtensionPath,
      '--load-extension=' + canonicalExtensionPath,
    ]);
    const projectedHost = JSON.parse(readFileSync(join(launchedProfileDir, 'NativeMessagingHosts', 'com.moretea.forge.fixture.json'), 'utf8')) as Record<string, unknown>;
    expect(projectedHost).toMatchObject({
      name: 'com.moretea.forge.fixture',
      path: realpathSync(nativeHostPath),
      type: 'stdio',
      allowed_origins: ['chrome-extension://' + SUPERVISOR_EXTENSION_ID + '/'],
    });
    expect(result).toMatchObject({
      provider: 'playwright-persistent-context',
      extension: { id: SUPERVISOR_EXTENSION_ID, path: canonicalExtensionPath, enabled: true },
      verified: true,
    });
  });

  test('rejects managed native messaging declarations whose allowed origin does not match the stable extension id', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    const extensionPath = extensionFixture(repoA);
    const nativeHostPath = join(repoA, 'forge-native-host');
    writeFileSync(nativeHostPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(extensionPath, 'forge-native-messaging-host.json'), JSON.stringify({
      name: 'com.moretea.forge.fixture',
      path: nativeHostPath,
      type: 'stdio',
      allowed_origins: ['chrome-extension://' + 'a'.repeat(32) + '/'],
    }));
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 2, enabled: true, provider: 'playwright', browserMode: 'managed_persistent',
      profileMode: 'repo_local', browserChannel: 'chrome', cdpAttachFallback: 'fail_closed', nativeAttachMode: 'disabled',
    }));
    let launched = false;
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => ({ chromium: { launchPersistentContext: async () => { launched = true; throw new Error('must not launch'); } } }),
    });
    await expect(executeBrowserPluginAction({
      controllerHome, repoId: 'repo-a', repoRoot: repoA, pluginId: 'browser',
      requestId: 'extension-native-origin-mismatch', actionId: 'install_unpacked_extension',
      args: { extension_path: extensionPath }, origin: { surface: 'mcp', actor: 'test' },
    })).rejects.toThrow(/exact stable extension origin/);
    expect(launched).toBe(false);
  });

  test('ordinary managed browsing still honors configured branded channel when no extension is requested', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 2, enabled: true, provider: 'playwright', browserMode: 'managed_persistent',
      profileMode: 'repo_local', browserChannel: 'chrome', cdpAttachFallback: 'fail_closed', nativeAttachMode: 'disabled',
    }));
    let launchOptions: Record<string, unknown> | undefined;
    setBrowserPluginRuntimeHooksForTest({
      moduleAvailable: () => true,
      loadPlaywright: () => ({
        chromium: {
          launchPersistentContext: async (_dir: string, options: Record<string, unknown>) => {
            launchOptions = options;
            const page = {
              url: () => 'https://example.com/',
              title: async () => 'Example',
              goto: async () => undefined,
              evaluate: async <T>() => undefined as T,
              screenshot: async () => Buffer.from(''),
              click: async () => undefined,
              fill: async () => undefined,
              press: async () => undefined,
              waitForSelector: async () => undefined,
              bringToFront: async () => undefined,
              close: async () => undefined,
            };
            return { pages: () => [page], newPage: async () => page, close: async () => undefined };
          },
        },
      }),
    });
    await executeBrowserPluginAction({
      controllerHome, repoId: 'repo-a', repoRoot: repoA, pluginId: 'browser',
      requestId: 'ordinary-managed-channel', actionId: 'create_session',
      args: { session_id: 'ordinary-managed-channel', url: 'https://example.com/' },
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(launchOptions?.channel).toBe('chrome');
    expect(launchOptions?.ignoreDefaultArgs).toBeUndefined();
  });

  test('attach-preferred extension install without CDP fails closed before native browser mutation', async () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    const extensionPath = extensionFixture(repoA);
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 2, enabled: true, provider: 'playwright', browserMode: 'attach_preferred',
      profileMode: 'repo_local', browserChannel: 'chrome', cdpAttachFallback: 'fail_closed',
      nativeAttachMode: 'auto', nativeBrowserCandidates: ['chrome'],
    }));
    setBrowserPluginRuntimeHooksForTest({ moduleAvailable: () => false });
    await expect(executeBrowserPluginAction({
      controllerHome, repoId: 'repo-a', repoRoot: repoA, pluginId: 'browser',
      requestId: 'extension-native-fail-closed', actionId: 'install_unpacked_extension',
      args: { extension_path: extensionPath }, origin: { surface: 'mcp', actor: 'test' },
    })).rejects.toMatchObject({ code: 'PLUGIN_BROWSER_EXTENSION_CONTROL_UNAVAILABLE' });
  });

  test('browser defaults fail closed and declares foreground effects per action', () => {
    const { repoA } = fixture();
    const manifest = buildBrowserPluginManifest(1, undefined, repoA);
    expect(manifest.health.details?.cdpAttachFallback).toBe('fail_closed');
    expect(manifest.actions.find((action) => action.actionId === 'list_sessions')?.foregroundEffect).toBe('none');
    expect(manifest.actions.find((action) => action.actionId === 'open_page')?.foregroundEffect).toBe('possible');
    expect(manifest.actions.find((action) => action.actionId === 'activate_page')?.foregroundEffect).toBe('required');
    expect(manifest.actions.find((action) => action.actionId === 'request_human_handoff')?.foregroundEffect).toBe('required');
    for (const action of manifest.actions) {
      expect(action.resourceClaims.some((claim) => claim.resource === 'repo-state')).toBe(false);
    }
    expect(manifest.actions.find((action) => action.actionId === 'open_page')?.resourceClaims).toEqual([
      { resource: 'remote', mode: 'read' },
      { resource: 'provider-state', mode: 'write' },
    ]);
  });

  test('legacy ChatGPT profile state cannot become general Browser authority, while schema-v2 explicit Browser config remains authoritative', () => {
    const { controllerHome, repoA } = fixture();
    mkdirSync(join(repoA, '.forge'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'chatgpt-browser.local.json'), JSON.stringify({
      version: 1,
      product: 'chatgpt',
      profileDir: '/tmp/forge-live-chrome',
      profileDirectory: 'Profile 1',
      browserChannel: 'chromium',
      chatgptUrl: 'https://chatgpt.com/',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }));

    const migrated = buildBrowserPluginManifest(1, undefined, repoA, { controllerHome, repoId: 'repo-a', repoRoot: repoA, controllerScoped: false });
    expect(migrated.health.details?.browserMode).toBe('attach_preferred');
    expect(migrated.health.details?.profileMode).toBe('repo_local');
    expect(migrated.health.details?.profileDir).toBeUndefined();
    expect(migrated.health.details?.profileDirectory).toBeUndefined();
    expect(migrated.health.details?.browserChannel).toBe('chrome');
    expect(migrated.health.details?.cdpAttachFallback).toBe('fail_closed');
    expect(migrated.health.details?.nativeBrowserCandidates).toEqual(['chrome']);
    expect(migrated.authority.sourceOfTruth).toContain('controller-home:sqlite/computer_interaction_target');
    expect(migrated.authority.sourceOfTruth).not.toContain('controller-home:sqlite/browser_session');
    expect(migrated.health.details?.sessionCountSemantics).toBe('controller_authority_unavailable');

    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      provider: 'playwright',
      browserMode: 'managed_persistent',
      profileMode: 'custom',
      profileDir: '/tmp/explicit-browser-profile',
      profileDirectory: 'Profile 2',
      browserChannel: 'chromium',
      cdpAttachFallback: 'managed_persistent',
      nativeAttachMode: 'auto',
      nativeBrowserCandidates: ['vivaldi'],
    }));
    const explicit = buildBrowserPluginManifest(1, undefined, repoA, { controllerHome, repoId: 'repo-a', repoRoot: repoA, controllerScoped: false });
    expect(explicit.health.details?.browserMode).toBe('managed_persistent');
    expect(explicit.health.details?.profileMode).toBe('custom');
    expect(explicit.health.details?.profileDir).toBe('/tmp/explicit-browser-profile');
    expect(explicit.health.details?.profileDirectory).toBe('Profile 2');
    expect(explicit.health.details?.browserChannel).toBe('chromium');
    expect(explicit.health.details?.cdpAttachFallback).toBe('managed_persistent');
    expect(explicit.health.details?.nativeBrowserCandidates).toEqual(['vivaldi']);
  });

});
