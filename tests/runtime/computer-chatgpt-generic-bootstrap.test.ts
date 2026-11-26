import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';

function loadBootstrapHelpers() {
  const src = readFileSync(
    new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url),
    'utf8',
  );
  const worker =
    src.slice(0, src.indexOf('chrome.runtime.onMessage.addListener(')).replace("importScripts('core.js');", '') +
    '\nObject.assign(globalThis, { __genericBootstrapSeed: genericBootstrapSeed, __bootstrapTabBelongsToProject: bootstrapTabBelongsToProject, __markerReconciliationReadIdentity: markerReconciliationReadIdentity, __resolvePinnedBootstrapMarkerTarget: resolvePinnedBootstrapMarkerTarget });';
  const sandbox = {
    ForgeComputerChatgptCore: {
      projectId(value: string) {
        const parts = new URL(value).pathname.split('/').filter(Boolean);
        return parts[0] === 'g' && parts[1]?.startsWith('g-p-') ? parts[1] : null;
      },
      parseConversation(value: string) {
        const parts = new URL(value).pathname.split('/').filter(Boolean);
        return parts[0] === 'c' && parts[1]
          ? { conversationId: parts[1], canonicalUrl: 'https://chatgpt.com/c/' + parts[1] }
          : null;
      },
    },
    navigator: { userAgent: 'Chrome' },
    crypto: { randomUUID: () => 'generic-bootstrap-test' },
    chrome: {
      storage: {
        session: {
          async get(key: string) {
            return { [key]: 'owner-token' };
          },
          async set() {},
        },
      },
      runtime: { lastError: null },
      tabs: {
        get(tabId: number, callback: (tab: unknown) => void) {
          callback({
            id: tabId,
            windowId: 9,
            url: 'https://chatgpt.com/c/new-avela-thread',
          });
        },
      },
    },
    URL,
    Date,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(worker, sandbox);
  return sandbox as typeof sandbox & {
    __genericBootstrapSeed: (identity: unknown) => boolean;
    __bootstrapTabBelongsToProject: (tab: unknown, identity: unknown) => boolean;
    __markerReconciliationReadIdentity: (tab: unknown, identity: unknown) => Record<string, unknown>;
    __resolvePinnedBootstrapMarkerTarget: (
      identity: unknown,
      binding: unknown,
      instanceId: string,
    ) => Promise<{ tab: { id: number; url: string }; ownerToken: string }>;
  };
}

test('generic ChatGPT bootstrap owns only the exact root page before first send', () => {
  const helpers = loadBootstrapHelpers();
  const identity = {
    namespace: 'chatgpt.bootstrap',
    bootstrapKey: 'avela-android:successor',
    projectUrl: 'https://chatgpt.com/',
  };
  expect(helpers.__genericBootstrapSeed(identity)).toBe(true);
  expect(helpers.__bootstrapTabBelongsToProject({ url: 'https://chatgpt.com/' }, identity)).toBe(true);
  expect(helpers.__bootstrapTabBelongsToProject({ url: 'https://chatgpt.com/c/unrelated' }, identity)).toBe(false);
  expect(helpers.__bootstrapTabBelongsToProject({ url: 'https://chatgpt.com/?temporary-chat=true' }, identity)).toBe(
    false,
  );
});

test('generic bootstrap promotes only its pinned migrated tab to exact conversation identity', () => {
  const helpers = loadBootstrapHelpers();
  const identity = {
    namespace: 'chatgpt.bootstrap',
    bootstrapKey: 'avela-android:successor',
    projectUrl: 'https://chatgpt.com/',
  };
  expect(
    helpers.__markerReconciliationReadIdentity({ url: 'https://chatgpt.com/c/new-avela-thread' }, identity),
  ).toEqual({
    namespace: 'chatgpt.conversation',
    conversationId: 'new-avela-thread',
    canonicalUrl: 'https://chatgpt.com/c/new-avela-thread',
  });
});

test('marker reconciliation follows only the owner-token-pinned generic bootstrap tab after /c migration', async () => {
  const helpers = loadBootstrapHelpers();
  const identity = {
    namespace: 'chatgpt.bootstrap',
    bootstrapKey: 'avela-android:successor',
    projectUrl: 'https://chatgpt.com/',
  };
  const target = await helpers.__resolvePinnedBootstrapMarkerTarget(
    identity,
    {
      providerId: 'browser.chrome-extension',
      providerSessionId: 'provider-session',
      browserProduct: 'chrome',
      windowId: '9',
      tabId: '42',
      ownerToken: 'owner-token',
    },
    'provider-session',
  );
  expect(target.ownerToken).toBe('owner-token');
  expect(target.tab).toMatchObject({
    id: 42,
    url: 'https://chatgpt.com/c/new-avela-thread',
  });
});

test('marker reconciliation rejects a migrated bootstrap tab without the original owner token', async () => {
  const helpers = loadBootstrapHelpers();
  const identity = {
    namespace: 'chatgpt.bootstrap',
    bootstrapKey: 'avela-android:successor',
    projectUrl: 'https://chatgpt.com/',
  };
  await expect(
    helpers.__resolvePinnedBootstrapMarkerTarget(
      identity,
      {
        providerId: 'browser.chrome-extension',
        providerSessionId: 'provider-session',
        browserProduct: 'chrome',
        windowId: '9',
        tabId: '42',
        ownerToken: 'different-token',
      },
      'provider-session',
    ),
  ).rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_MISMATCH');
});
