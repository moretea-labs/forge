import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildBrowserPluginManifest, executeBrowserPluginAction, resolveBrowserPluginAuthorizationContext } from '../../src/runtime/plugins/browser-adapter';
import {
  ensureLegacyBrowserSessionsImported,
  findBrowserSession,
  listBrowserSessions,
  saveBrowserSession,
  tombstoneBrowserSession,
} from '../../src/runtime/plugins/browser-session-authority';

const roots: string[] = [];
afterEach(() => {
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

function session(
  sessionId: string,
  updatedAt: string,
  options: { native?: boolean; windowId?: string; tabId?: string; repoMarker?: string } = {},
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
      browserProduct: 'chrome',
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

describe('browser session controller authority', () => {
  test('imports repo-local legacy sessions only once', () => {
    const { controllerHome, repoA } = fixture();
    const legacyRoot = join(repoA, '.forge', 'browser', 'sessions');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'one.json'), JSON.stringify(session('legacy-one', '2026-08-24T01:00:00.000Z')));

    expect(ensureLegacyBrowserSessionsImported(controllerHome, 'repo-a', repoA)).toBe(1);
    expect(listBrowserSessions(controllerHome, 'repo-a', repoA).sessions.map((entry) => entry.sessionId)).toEqual(['legacy-one']);

    writeFileSync(join(legacyRoot, 'two.json'), JSON.stringify(session('legacy-two', '2026-08-24T02:00:00.000Z')));
    expect(ensureLegacyBrowserSessionsImported(controllerHome, 'repo-a', repoA)).toBe(0);
    expect(listBrowserSessions(controllerHome, 'repo-a', repoA).sessions.map((entry) => entry.sessionId)).toEqual(['legacy-one']);
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

  test('tombstones canonical native identities across aliases', () => {
    const { controllerHome, repoA, repoB } = fixture();
    saveBrowserSession(controllerHome, 'repo-a', repoA, session('native-a', '2026-08-24T01:00:00.000Z', { native: true }));
    saveBrowserSession(controllerHome, 'repo-b', repoB, session('native-b', '2026-08-24T02:00:00.000Z', { native: true }));
    expect(tombstoneBrowserSession(controllerHome, 'repo-b', repoB, 'native-b')).toBe(true);
    expect(findBrowserSession(controllerHome, 'repo-a', repoA, 'native-a')).toBeUndefined();
    expect(findBrowserSession(controllerHome, 'repo-b', repoB, 'native-b')).toBeUndefined();
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
      writeFileSync(join(legacyRoot, `${id}.json`), JSON.stringify(session(id, at)));
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

    saveBrowserSession(controllerHome, 'repo-a', repoA, session('native-auth', '2026-08-24T04:00:00.000Z', { native: true }));
    const auth = await resolveBrowserPluginAuthorizationContext({
      ...baseInput,
      actionId: 'click',
      args: { session_id: 'native-auth', selector: '#submit' },
    });
    expect(auth?.target.kind).toBe('browser-origin');
    expect(auth?.target.id).toBe('chrome@https://example.com');
  });

  test('browser defaults fail closed and declares foreground effects per action', () => {
    const { repoA } = fixture();
    const manifest = buildBrowserPluginManifest(1, undefined, repoA);
    expect(manifest.health.details?.cdpAttachFallback).toBe('fail_closed');
    expect(manifest.actions.find((action) => action.actionId === 'list_sessions')?.foregroundEffect).toBe('none');
    expect(manifest.actions.find((action) => action.actionId === 'open_page')?.foregroundEffect).toBe('possible');
    expect(manifest.actions.find((action) => action.actionId === 'activate_page')?.foregroundEffect).toBe('required');
    expect(manifest.actions.find((action) => action.actionId === 'request_human_handoff')?.foregroundEffect).toBe('required');
  });

  test('legacy ChatGPT browser binding seeds Browser profile configuration without overriding explicit Browser config', () => {
    const { repoA } = fixture();
    mkdirSync(join(repoA, '.forge'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'chatgpt-browser.local.json'), JSON.stringify({
      version: 1,
      product: 'chatgpt',
      profileDir: '/tmp/forge-live-chrome',
      profileDirectory: 'Profile 1',
      browserChannel: 'chrome',
      chatgptUrl: 'https://chatgpt.com/',
      updatedAt: '2026-08-24T00:00:00.000Z',
    }));

    const migrated = buildBrowserPluginManifest(1, undefined, repoA);
    expect(migrated.health.details?.profileMode).toBe('custom');
    expect(migrated.health.details?.profileDir).toBe('/tmp/forge-live-chrome');
    expect(migrated.health.details?.profileDirectory).toBe('Profile 1');
    expect(migrated.health.details?.browserChannel).toBe('chrome');
    expect(migrated.health.details?.cdpAttachFallback).toBe('fail_closed');
    expect(migrated.authority.sourceOfTruth).toContain('controller-home:sqlite/browser_session');
    expect(migrated.health.details?.sessionCountSemantics).toBe('controller_authority_unavailable');

    mkdirSync(join(repoA, '.forge', 'plugins'), { recursive: true });
    writeFileSync(join(repoA, '.forge', 'plugins', 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'playwright',
      profileMode: 'repo_local',
      browserChannel: 'chromium',
    }));
    const explicit = buildBrowserPluginManifest(1, undefined, repoA);
    expect(explicit.health.details?.profileMode).toBe('repo_local');
    expect(explicit.health.details?.profileDir).toBeUndefined();
    expect(explicit.health.details?.browserChannel).toBe('chromium');
  });

});
