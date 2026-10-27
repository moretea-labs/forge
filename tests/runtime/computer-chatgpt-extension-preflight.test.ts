import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(join(process.cwd(), 'adapters/computer/chrome-extension/background.js'), 'utf8');
const url = 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
const identity = { namespace: 'chatgpt.conversation', conversationId: '12345678-1234-1234-1234-123456789abc', canonicalUrl: url };

type Response = { kind: string; mutation: string; reasonCode?: string; reasoningVerified?: string; confirmed?: boolean };
type Scenario = {
  capability?: unknown;
  preflightTransportError?: boolean;
  unbound?: boolean;
  prepareTransportError?: 'receiver' | 'timeout' | 'other';
  prepareDraftWrittenBeforeTimeout?: boolean;
  prepare?: { prepared: boolean; reason?: string; reasoningVerified?: string };
  dispatch?: { dispatched: boolean; confirmed?: boolean; reasoningVerified?: string };
};
function fixture(scenario: Scenario) {
  const tab = { id: 42, windowId: 8, url, title: 'Test conversation' };
  const messages: string[] = [];
  let submissions = 0;
  let draftWrites = 0;
  const ownerStorage = new Map([['forgeComputerOwnedTabV1:42', 'verified-conversation-owner']]);
  const providerBinding = { providerId: 'browser.chrome-extension', providerSessionId: 'test-profile',
    tabId: '42', windowId: '8', ownerToken: 'verified-conversation-owner' };
  const chrome = {
    storage: { session: { async get(key: string) {
      return ownerStorage.has(key) ? { [key]: ownerStorage.get(key) } : {};
    } } },
    runtime: {
      lastError: undefined as undefined | { message: string },
      connectNative() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    tabs: {
      async query() { return [tab]; },
      get(_id: number, callback: (value: typeof tab) => void) { callback(tab); },
      sendMessage(_id: number, message: { type: string }, callback: (value: unknown) => void) {
        messages.push(message.type);
        if (message.type === 'forge-computer-chatgpt-capabilities') {
          if (scenario.preflightTransportError) {
            chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
            callback(undefined);
            chrome.runtime.lastError = undefined;
            return;
          }
          callback(scenario.capability);
          return;
        }
        if (message.type === 'forge-computer-chatgpt-prepare') {
          if (scenario.prepareTransportError === 'timeout') {
            if (scenario.prepareDraftWrittenBeforeTimeout) draftWrites += 1;
            return; // callback lost, possibly after the exact draft was written
          }
          if (scenario.prepareTransportError) {
            chrome.runtime.lastError = { message: scenario.prepareTransportError === 'receiver'
              ? 'Could not establish connection. Receiving end does not exist.'
              : 'The message port closed before a response was received.' };
            callback(undefined);
            chrome.runtime.lastError = undefined;
            return;
          }
          callback(scenario.prepare ?? { prepared: true, reasoningVerified: 'xhigh' });
          return;
        }
        if (message.type === 'forge-computer-chatgpt-dispatch') {
          submissions += 1;
          callback(scenario.dispatch ?? { dispatched: true, confirmed: true, reasoningVerified: 'xhigh' });
          return;
        }
        if (message.type === 'forge-computer-chatgpt-snapshot') {
          throw new Error('Send confirmation must not poll another page snapshot');
        }
        callback({});
      },
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} } },
  };
  const testContext = {
    chrome,
    URL,
    Date,
    Math,
    importScripts() {},
    ForgeComputerChatgptCore: {
      parseConversation(value: string) {
        return value === url ? { conversationId: identity.conversationId, canonicalUrl: url } : null;
      },
      projectId() { return null; },
      normalizeText(value: unknown) { return String(value ?? '').replace(/\s+/g, ' ').trim(); },
    },
    setTimeout(callback: () => void, ms: number) {
      // Run only the bounded post-send observation sleep; never schedule the
      // extension's actual background heartbeat/discovery loops in this test.
      if (ms === 200 || ms === 400 || ms === 600 || ms === 800 || ms === 7_000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    setInterval() { return 1; },
  };
  const scope = runInNewContext(
    source + '\n;globalThis.__testDispatch = executeDispatch; globalThis.__testPrepare = executePrepare;',
    testContext,
    { filename: 'background.js' },
  ) as unknown;
  void scope;
  const dispatch = (reasoning?: 'xhigh') =>
    (testContext as typeof testContext & {
      __testDispatch: (value: object, instanceId: string) => Promise<Response>;
    }).__testDispatch({ kind: 'dispatch', identity, prompt: 'source delivery',
      ...(!scenario.unbound ? { providerBinding } : {}), ...(reasoning ? { reasoning } : {}) }, 'test-profile');
  const prepare = (reasoning?: 'xhigh') =>
    (testContext as typeof testContext & {
      __testPrepare: (value: object, instanceId: string) => Promise<{ kind: string; ready: boolean; reasoningVerified?: string; reasonCode?: string }>;
    }).__testPrepare({ kind: 'prepare', identity, prompt: 'source delivery',
      ...(!scenario.unbound ? { providerBinding } : {}), ...(reasoning ? { reasoning } : {}) }, 'test-profile');
  return { dispatch, prepare, messages, get submissions() { return submissions; }, get draftWrites() { return draftWrites; } };
}

test('exact conversation send requires no model-picker capability', async () => {
  const f = fixture({ capability: undefined });
  expect(await f.dispatch()).toMatchObject({ mutation: 'attempted', confirmed: true });
  expect(f.submissions).toBe(1);
  expect(f.messages).toEqual(['forge-computer-chatgpt-dispatch']);
});

test('capability transport failure cannot veto an exact conversation send', async () => {
  const f = fixture({ preflightTransportError: true });
  expect(await f.dispatch()).toMatchObject({ mutation: 'attempted', confirmed: true });
  expect(f.submissions).toBe(1);
});

test('exact target prepare never clicks Send and dispatch runs only once', async () => {
  const f = fixture({ prepare: { prepared: true } });
  expect(await f.prepare()).toMatchObject({ kind: 'prepared', ready: true });
  expect(f.submissions).toBe(0);
  expect(await f.dispatch()).toMatchObject({ mutation: 'attempted', confirmed: true });
  expect(f.submissions).toBe(1);
  expect(f.messages).toEqual(['forge-computer-chatgpt-prepare', 'forge-computer-chatgpt-dispatch']);
});

test('ordinary exact dispatch does not perform a model-picker handshake', async () => {
  const f = fixture({});
  expect(await f.dispatch()).toMatchObject({ mutation: 'attempted', confirmed: true });
  expect(f.submissions).toBe(1);
  expect(f.messages).not.toContain('forge-computer-chatgpt-capabilities');
});

test('preflight cannot retroactively declare a send not attempted when execution lacks attestation', async () => {
  const f = fixture({ dispatch: { dispatched: true } });
  expect(await f.dispatch()).toMatchObject({ mutation: 'attempted', confirmed: false });
  expect(f.submissions).toBe(1);
});

function bootstrapFixture(initialTabs: Array<{ id: number; windowId: number; url: string }> = [],
  options: { ownerWriteFails?: boolean; ownerWriteDrops?: boolean; markerObservation?: boolean; validEnsureSnapshot?: boolean } = {}) {
  const tabs = [...initialTabs];
  let nextTabId = 200;
  let dispatchSends = 0;
  let snapshotReads = 0;
  let tabQueries = 0;
  const ownerTokens = new Map<string, string>();
  const projectId = (value: string) => /\/g\/(g-p-[^/]+)/.exec(value)?.[1] ?? null;
  const chrome = {
    storage: { session: {
      async get(key: string) { return { [key]: ownerTokens.get(key) }; },
      async set(values: Record<string, string>) {
        if (options.ownerWriteFails) throw new Error('CHROME_STORAGE_SESSION_UNAVAILABLE');
        if (!options.ownerWriteDrops) for (const [key, token] of Object.entries(values)) ownerTokens.set(key, token);
      },
    } },
    runtime: {
      lastError: undefined,
      connectNative() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
      onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    tabs: {
      async query() { tabQueries++; return [...tabs]; },
      sendMessage(_tabId: number, message: { type: string }, callback: (result: object) => void) {
        if (message.type === 'forge-computer-chatgpt-snapshot' && options.validEnsureSnapshot) {
          snapshotReads++;
          callback({ url: tabs.find((tab) => tab.id === _tabId)?.url,
            composerText: '', latestUserText: '', latestAssistantResponse: '', isGenerating: false });
        } else if (message.type === 'forge-computer-chatgpt-snapshot' && options.markerObservation) {
          snapshotReads++;
          callback({ url: tabs.find((tab) => tab.id === _tabId)?.url,
            latestUserText: 'exact-marker-test-v1', userMessages: ['exact-marker-test-v1'] });
        } else if (message.type === 'forge-computer-chatgpt-dispatch') {
          dispatchSends += 1;
          callback({ dispatched: true });
        } else if (message.type === 'forge-computer-chatgpt-prepare') callback({ prepared: true });
        else callback({ bootstrapTargetGuard: 'project-checked-before-send-v1' });
      },
      get(tabId: number, callback: (tab: { id: number; windowId: number; url: string } | undefined) => void) {
        callback(tabs.find((tab) => tab.id === tabId));
      },
      create({ url }: { url: string }, callback: (value: { id: number; windowId: number; url: string }) => void) {
        const tab = { id: nextTabId++, windowId: 8, url };
        tabs.push(tab);
        callback(tab);
      },
      onUpdated: { addListener() {} }, onActivated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} } },
  };
  const context = {
    chrome, URL, Date, Math, importScripts() {},
    ForgeComputerChatgptCore: {
      parseConversation(value: string) {
        const found = /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/.exec(value);
        return found ? { conversationId: found[1], canonicalUrl: value } : null;
      }, projectId,
      normalizeText(value: unknown) { return String(value ?? '').trim(); },
    },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
  };
  runInNewContext(source + '\n;globalThis.__resolveTarget = resolveTarget;globalThis.__matchingTabs = matchingTabs;globalThis.__matchesReceiver = receiverMatchesIdentity;globalThis.__markerReadIdentity = markerReconciliationReadIdentity;globalThis.__shouldReload = shouldReloadUnreadableConversation;globalThis.__testPrepare=executePrepare;globalThis.__testDispatch=executeDispatch;globalThis.__testFindMarker=executeFindMarker;globalThis.__testEnsure=executeEnsure;globalThis.__testObserve=executeObserve;', context);
  return {
    tabs,
    get dispatchSends() { return dispatchSends; },
    get snapshotReads() { return snapshotReads; },
    get tabQueries() { return tabQueries; },
    ensure: (identity: object, pinned: object, instanceId: string) => (context as typeof context & {
      __testEnsure: (cmd: object, instanceId: string) => Promise<{ kind: string; code?: string }>;
    }).__testEnsure({ kind: 'ensure', identity, providerBinding: pinned }, instanceId),
    observe: (identity: object, pinned: object, instanceId: string) => (context as typeof context & {
      __testObserve: (cmd: object, instanceId: string) => Promise<{ kind: string; code?: string }>;
    }).__testObserve({ kind: 'observe', identity, providerBinding: pinned }, instanceId),
    findMarker: (identity: object, pinned: object, instanceId: string) => (context as typeof context & {
      __testFindMarker: (cmd: object, instanceId: string) => Promise<{ kind: string; code?: string; matches?: Array<{ providerBinding?: object }> }>;
    }).__testFindMarker({ kind: 'find_marker', identity, providerBinding: pinned, marker: 'exact-marker-test-v1' }, instanceId),
    prepare: (identity: object, pinned: object, instanceId = 'test-provider') => (context as typeof context & {
      __testPrepare: (cmd: object, instanceId: string) => Promise<{ ready: boolean; reasonCode?: string }>;
    }).__testPrepare({ kind: 'prepare', identity, providerBinding: pinned, prompt: 'test only' }, instanceId),
    dispatch: (identity: object, pinned: object, instanceId = 'test-provider') => (context as typeof context & {
      __testDispatch: (cmd: object, instanceId: string) => Promise<{ mutation: string; reasonCode?: string }>;
    }).__testDispatch({ kind: 'dispatch', identity, providerBinding: pinned, prompt: 'test only' }, instanceId),
    attestOwner(tabId: number, token: string) { ownerTokens.set(`forgeComputerOwnedTabV1:${tabId}`, token); },
    shouldReload: (tabId: number, identity: object, observation: object, nowMs: number) =>
      (context as typeof context & { __shouldReload: (tabId: number, identity: object, observation: object, nowMs: number) => boolean })
        .__shouldReload(tabId, identity, observation, nowMs),
    matchesReceiver: (tab: { id: number; windowId: number; url: string }, identity: object) =>
      (context as typeof context & { __matchesReceiver: (tab: object, identity: object) => boolean }).__matchesReceiver(tab, identity),
    markerReadIdentity: (tab: { id: number; windowId: number; url: string }, identity: object) =>
      (context as typeof context & { __markerReadIdentity: (tab: object, identity: object) => object }).__markerReadIdentity(tab, identity),
    resolve: (identity: object, create: boolean, pinned?: object, instanceId = 'profile-1') =>
      (context as typeof context & { __resolveTarget: (identity: object, create: boolean, pinned?: object, instanceId?: string) => Promise<{ tab: { id: number; windowId: number; url: string }; created: boolean; ownerToken?: string }> }).__resolveTarget(identity, create, pinned, instanceId),
  };
}

test('receiver identity and unreadable-page recovery preserve the exact target without Send', async () => {
  {
  const projectUrl = 'https://chatgpt.com/g/g-p-avela-project';
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:avela', projectUrl };
  const fixture = bootstrapFixture();
  expect(fixture.matchesReceiver({ id: 11, windowId: 8, url: projectUrl }, identity)).toBe(true);
  expect(fixture.matchesReceiver({
    id: 12, windowId: 8,
    url: projectUrl + '/c/12345678-1234-1234-1234-123456789abc',
  }, identity)).toBe(false);

  }
  {
  const f = bootstrapFixture();
  const obs = {
    url, providerFailureText: '无法加载此 ChatGPT 对话',
    latestUserText: '', latestAssistantResponse: '', composerText: undefined, isGenerating: false,
  };
  expect(f.shouldReload(42, identity, obs, 10_000)).toBe(false);
  expect(f.shouldReload(42, identity, obs, 69_999)).toBe(false);
  expect(f.shouldReload(42, identity, obs, 70_000)).toBe(true);
  expect(f.shouldReload(42, identity, obs, 80_000)).toBe(false);
  expect(f.shouldReload(42, identity, obs, 369_999)).toBe(false);
  expect(f.shouldReload(42, identity, obs, 370_000)).toBe(true);
  expect(f.shouldReload(42, identity, { ...obs, latestUserText: 'Original effect already submitted' }, 380_000)).toBe(false);
  expect(f.shouldReload(42, identity, obs, 440_000)).toBe(false);
  expect(f.shouldReload(42, identity, obs, 500_000)).toBe(false);
  expect(f.shouldReload(42, identity, obs, 670_000)).toBe(true);
  expect(f.shouldReload(55, { namespace: 'chatgpt.bootstrap', projectUrl: 'https://chatgpt.com/g/g-p-abc/project' }, obs, 900_000)).toBe(false);
  expect(f.shouldReload(55, identity, { ...obs, url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 900_000)).toBe(false);
  expect(f.shouldReload(55, identity, { ...obs, composerText: 'Unowned user draft' }, 900_000)).toBe(false);
  expect(f.shouldReload(55, identity, { ...obs, isGenerating: true }, 900_000)).toBe(false);
  }
  {
  const source = readFileSync(new URL('../../adapters/computer/chrome-extension/background.js', import.meta.url), 'utf8');
  const tab = { id: 76, windowId: 8, url, discarded: false };
  let nowMs = 10_000;
  let reloads = 0;
  let sends = 0;
  const ownerStorage = new Map([['forgeComputerOwnedTabV1:76', 'unreadable-owner']]);
  const snapshot = { url, title: 'Unreadable conversation', latestUserText: '', latestAssistantResponse: '',
    providerFailureText: '无法加载此 ChatGPT 对话', providerActivityText: '', isGenerating: false };
  const idle = { addListener() {} };
  const chrome = {
    runtime: { lastError: undefined, connectNative() { return { onMessage: idle, onDisconnect: idle, postMessage() {} }; },
      onMessage: idle, onInstalled: idle, onStartup: idle },
    storage: { local: { async get() { return { forgeComputerProviderInstanceId: 'test-profile' }; },
      async set() {} }, session: { async get(key: string) {
        return ownerStorage.has(key) ? { [key]: ownerStorage.get(key) } : {};
      } } },
    tabs: {
      async query() { return [tab]; },
      get(_tabId: number, callback: (value: typeof tab) => void) { callback(tab); },
      sendMessage(_tabId: number, message: { type: string }, callback: (value: object) => void) {
        if (message.type === 'forge-computer-chatgpt-snapshot') callback(snapshot);
        else if (message.type === 'forge-computer-chatgpt-dispatch') { sends += 1; callback({ dispatched: true }); }
        else callback({});
      },
      reload(_tabId: number, callback: () => void) { reloads++; callback(); },
      onUpdated: idle, onActivated: idle, onRemoved: idle,
    },
    alarms: { create() {}, onAlarm: idle },
    windows: { onFocusChanged: idle },
  };
  const clock = class extends Date { static now() { return nowMs; } };
  const context = {
    chrome, URL, Date: clock, Math,
    ForgeComputerChatgptCore: {
      parseConversation: (value: string) => value === url ? { conversationId: identity.conversationId, canonicalUrl: url } : null,
      projectId: () => null, normalizeText: (value: unknown) => String(value ?? '').trim(),
    },
    importScripts() {}, setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
  };
  runInNewContext(source + '\n;globalThis.__ensureUnreadable = executeEnsure;', context);
  const ensure = (context as typeof context & {
    __ensureUnreadable: (command: object, instanceId: string) => Promise<{ kind: string; observation?: object }>;
  }).__ensureUnreadable;
  const command = { identity, kind: 'ensure', providerBinding: {
    providerId: 'browser.chrome-extension', providerSessionId: 'profile-test',
    tabId: '76', windowId: '8', ownerToken: 'unreadable-owner',
  } };
  expect((await ensure(command, 'profile-test')).kind).toBe('ensured');
  expect(reloads).toBe(0);
  nowMs = 70_000;
  expect((await ensure(command, 'profile-test')).kind).toBe('ensured');
  expect(reloads).toBe(1);
  nowMs = 72_000;
  await ensure(command, 'profile-test');
  expect(reloads).toBe(1);
  expect(sends).toBe(0);
  expect(tab.url).toBe(url);
  }
  {
  const content = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  const instrumented = content.replace(
    '  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
    '  globalThis.__failureText = providerFailureText;\n  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
  );
  expect(instrumented).not.toBe(content);
  let isMessage = false;
  const failure = {
    innerText: '无法加载此 ChatGPT 对话',
    getClientRects: () => [{}],
    closest: () => isMessage ? {} : null,
  };
  const main = { getClientRects: () => [{}],
    querySelectorAll: (selector: string) => selector === 'p, span, div' ? [failure] : [] };
  const context = {
    document: { querySelectorAll: (selector: string) => selector === 'main' ? [main] : [] },
    location: { href: url }, URL, Date, Map, Promise,
    ForgeComputerChatgptCore: { normalizeText: (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim(), parseConversation: () => null },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout() { return 1; }, clearTimeout() {},
  };
  runInNewContext(instrumented, context);
  const failureText = (context as typeof context & { __failureText: () => string }).__failureText;
  expect(failureText()).toContain('无法加载此 ChatGPT 对话');
  isMessage = true;
  expect(failureText()).toBe('');
  }
});

test('pinned bootstrap marker reconciliation reads migrated exact conversation without granting a Send receiver', () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-avela-project';
  const otherProject = 'https://chatgpt.com/g/g-p-other-project';
  const id = '12345678-1234-1234-1234-123456789abc';
  const newer = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const initial = { id: 41, windowId: 8, url: projectUrl };
  const migrated = { id: 41, windowId: 8, url: projectUrl + '/c/' + id };
  const foreign = { id: 41, windowId: 8, url: otherProject + '/c/' + id };
  const switched = { id: 41, windowId: 8, url: projectUrl + '/c/' + newer };
  const bootstrap = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:ios', projectUrl };
  const fixture = bootstrapFixture([initial]);
  expect(fixture.markerReadIdentity(initial, bootstrap)).toMatchObject(bootstrap);
  const read = fixture.markerReadIdentity(migrated, bootstrap);
  expect(read).toMatchObject({ namespace: 'chatgpt.conversation', conversationId: id });
  expect(fixture.matchesReceiver(migrated, read)).toBe(true);
  // This narrower identity only restores read observation, not a bootstrap Send.
  expect(fixture.matchesReceiver(migrated, bootstrap)).toBe(false);
  expect(fixture.matchesReceiver(switched, read)).toBe(false);
  expect(fixture.markerReadIdentity(foreign, bootstrap)).toMatchObject(bootstrap);
  expect(fixture.matchesReceiver(foreign, bootstrap)).toBe(false);
});

test('find_marker hydrates only the exact pinned migrated conversation after receiver loss', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-forge-test';
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  const conversationUrl = projectUrl + '/c/' + conversationId;
  const marker = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_attested_123456789>>>';
  const pinned = { id: 81, windowId: 8, url: conversationUrl };
  const decoy = { id: 82, windowId: 8, url: projectUrl };
  const tabs = [pinned, decoy];
  const ownerStorage = new Map([['forgeComputerOwnedTabV1:81', 'marker-reader-attested']]);
  let receiverInstalled = false;
  let reinjections = 0;
  let sends = 0;
  const chrome = {
    runtime: {
      lastError: undefined as undefined | { message: string },
      connectNative() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
      onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    tabs: {
      async query() { return [...tabs]; },
      get(id: number, cb: (value: typeof pinned | undefined) => void) {
        cb(tabs.find((tab) => tab.id === id));
      },
      sendMessage(id: number, message: { type: string }, cb: (value?: object) => void) {
        if (message.type !== 'forge-computer-chatgpt-snapshot') {
          sends++;
          cb({ dispatched: false });
          return;
        }
        if (id !== pinned.id) { cb({ url: decoy.url, latestUserText: '', userMessages: [] }); return; }
        if (!receiverInstalled) {
          chrome.runtime.lastError = { message: 'Receiving end does not exist' };
          cb();
          chrome.runtime.lastError = undefined;
          return;
        }
        cb({ url: pinned.url, latestUserText: marker + '\nSafe owner message',
          userMessages: [marker + '\nSafe owner message'] });
      },
      onUpdated: { addListener() {} }, onActivated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    scripting: {
      executeScript(args: { target: { tabId: number }; files: string[] }, cb: () => void) {
        expect(args.target.tabId).toBe(pinned.id);
        expect(args.files).toEqual(['core.js', 'content.js']);
        reinjections++;
        receiverInstalled = true;
        cb();
      },
    },
    storage: { session: { async get(k: string) {
      return ownerStorage.has(k) ? { [k]: ownerStorage.get(k) } : {};
    } } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} } },
  };
  const projectId = (value: string) => /\/g\/(g-p-[^/]+)/.exec(value)?.[1] ?? null;
  const context = {
    chrome, URL, Date, Math, importScripts() {},
    ForgeComputerChatgptCore: {
      parseConversation(value: string) {
        const match = /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/.exec(value);
        return match ? { conversationId: match[1], canonicalUrl: value } : null;
      },
      projectId,
      normalizeText(value: unknown) { return String(value ?? '').trim(); },
    },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
  };
  runInNewContext(source + '\n;globalThis.__findMarker = executeFindMarker;', context);
  const find = (context as typeof context & { __findMarker: (
    args: object, id: string) => Promise<{ matches: Array<{
      identity: { conversationId: string }; providerBinding: { tabId: string };
    }> }> }).__findMarker;
  const command = { identity: { namespace: 'chatgpt.bootstrap',
    bootstrapKey: 'supervisor:exact', projectUrl },
    providerBinding: { providerId: 'browser.chrome-extension',
      providerSessionId: 'same-provider', windowId: '8', tabId: '81', ownerToken: 'marker-reader-attested' },
    marker };
  const found = await find(command, 'same-provider');
  expect(found.matches).toHaveLength(1);
  expect(found.matches[0]?.identity.conversationId).toBe(conversationId);
  expect(found.matches[0]?.providerBinding.tabId).toBe('81');
  expect(reinjections).toBe(1);
  expect(sends).toBe(0);
  // Foreign providerId cannot launder its exact Chrome tab/session/Token
  // through marker reconciliation into a fresh Chrome Send authorization.
  const foreign = await find({ ...command, providerBinding: {
    ...command.providerBinding, providerId: 'browser.other',
  } }, 'same-provider');
  expect(foreign).toMatchObject({ kind: 'failed',
    code: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH' });
  expect(sends).toBe(0);
  // A receiver may only be rehydrated while the exact pin still belongs to
  // the original Project. Another Project's tab never earns a read repair.
  receiverInstalled = false;
  pinned.url = 'https://chatgpt.com/g/g-p-other-project/c/' + conversationId;
  const rejected = await find(command, 'same-provider');
  expect(rejected.matches).toHaveLength(0);
  expect(reinjections).toBe(1);
  expect(sends).toBe(0);
});

test('two fresh Supervisor tasks in one Project receive distinct new tabs, never a borrowed Project tab', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-avela-project';
  const fixture = bootstrapFixture([{ id: 41, windowId: 8, url: projectUrl }]);
  const ios = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:ios', projectUrl };
  const android = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:android', projectUrl };
  const iosTab = await fixture.resolve(ios, true);
  const androidTab = await fixture.resolve(android, true);
  expect(iosTab.created).toBe(true);
  expect(androidTab.created).toBe(true);
  expect(iosTab.tab.id).not.toBe(41);
  expect(androidTab.tab.id).not.toBe(41);
  expect(androidTab.tab.id).not.toBe(iosTab.tab.id);
});

test('service-worker restart reattaches only the exact Controller-pinned bootstrap tab', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-avela-project';
  const tabs = [
    { id: 81, windowId: 8, url: projectUrl },
    { id: 82, windowId: 8, url: projectUrl },
  ];
  const fixture = bootstrapFixture(tabs); // no ephemeral bootstrap map on this worker
  const android = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:android', projectUrl };
  const pin = { providerId: 'browser.chrome-extension', browserProduct: 'chrome',
    providerSessionId: 'fresh-extension-instance', windowId: '8', tabId: '82', ownerToken: 'restart-owner' };
  fixture.attestOwner(82, 'restart-owner');
  const recovered = await fixture.resolve(android, true, pin, 'fresh-extension-instance');
  expect(recovered.created).toBe(false);
  expect(recovered.tab.id).toBe(82);
  expect(fixture.tabs).toHaveLength(2);
  await expect(fixture.resolve(android, true, { ...pin, tabId: '999' }, 'fresh-extension-instance'))
    .rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING');
  await expect(fixture.resolve({ ...android, projectUrl: 'https://chatgpt.com/g/g-p-unrelated' }, true, { ...pin, tabId: '81' }, 'fresh-extension-instance'))
    .rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_IDENTITY_CHANGED');
  expect(fixture.tabs).toHaveLength(2);
});

test('Chrome content script awaits delayed exact editor readback without duplicate Send', async () => {
  const source = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  const id = '12345678-1234-1234-1234-123456789abc';
  const url = `https://chatgpt.com/c/${id}`;
  const prompt = 'alpha  beta\nline two';
  for (const [rendered, expectedSend] of [[prompt, true], ['alpha beta\nline two', false]] as const) {
    let sends = 0;
    let listener: ((message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
    const observers: Array<() => void> = [];
    class TextArea {
      private text = '';
      get value() { return this.text; }
      set value(_next: string) {
        queueMicrotask(() => { this.text = rendered; for (const notify of [...observers]) notify(); });
      }
      focus() {}
      dispatchEvent() { return true; }
      querySelector() { return null; }
      getClientRects() { return [1]; }
    }
    const editor = new TextArea();
    const send = { isConnected: true, disabled: false, getClientRects: () => [1],
      getAttribute: () => null, click: () => { sends++; } };
    const empty = Object.assign([], { item: () => undefined });
    const document = { documentElement: {}, addEventListener() {}, removeEventListener() {},
      querySelectorAll: (selector: string) => selector.includes('#prompt-textarea') ? [editor]
        : selector.includes('send-button') ? [send] : empty };
    const context = {
      document, location: { href: url }, URL, Date, Map, Promise,
      HTMLTextAreaElement: TextArea, HTMLInputElement: class {},
      InputEvent: class { constructor(_type: string, _options: unknown) {} },
      ForgeComputerChatgptCore: {
        parseConversation: (value: string) => value === url ? { conversationId: id } : undefined,
        normalizeText: (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim(),
      },
      chrome: { runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, sendMessage() {} } },
      MutationObserver: class {
        constructor(private callback: () => void) {}
        observe() { observers.push(this.callback); }
        disconnect() { const index = observers.indexOf(this.callback); if (index >= 0) observers.splice(index, 1); }
      },
      setTimeout: (callback: () => void, ms: number) => { if (ms === 2_000 || ms === 75) queueMicrotask(callback); return 1; },
      clearTimeout() {},
    };
    runInNewContext(source, context);
    if (!listener) throw new Error('Chrome content listener missing');
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      listener!({ type: 'forge-computer-chatgpt-dispatch', prompt, expectedConversationId: id }, null, (value) => resolve(value as Record<string, unknown>));
    });
    expect(result.dispatched).toBe(expectedSend);
    if (!expectedSend) expect(result.reason).toBe('composer_write_unconfirmed');
    expect(sends).toBe(expectedSend ? 1 : 0);
  }
});

test('real Chrome content script preserves all prompt spaces and newlines during send readback', async () => {
  const content = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  const prompt = 'alpha  beta\nline two';
  const identity = { conversationId: '12345678-1234-1234-1234-123456789abc' };
  const currentUrl = 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
  for (const [rendered, shouldSend] of [
    ['alpha beta\nline two', false],
    ['alpha  beta line two', false],
    [prompt, true],
  ] as const) {
    const composer = { value: rendered, querySelector: () => null, getClientRects: () => [{}] };
    const sendButton = {
      isConnected: true, disabled: false, getClientRects: () => [{}],
      getAttribute: () => null, click: () => { sends += 1; },
    };
    let sends = 0;
    let listener: ((message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
    const empty = Object.assign([], { item: () => undefined });
    const documentEvents = new EventTarget();
    const document = {
      documentElement: {},
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      querySelector: (selector: string) => selector.includes('#prompt-textarea') ? composer
        : selector.includes('send-button') ? sendButton : null,
      querySelectorAll: (selector: string) => selector.includes('#prompt-textarea') ? [composer]
        : selector.includes('send-button') ? [sendButton] : empty,
    };
    const context = {
      document, location: { href: currentUrl }, URL, Date, Map, Promise,
      ForgeComputerChatgptCore: {
        parseConversation: (value: string) => value === currentUrl ? { conversationId: identity.conversationId } : undefined,
        normalizeText: (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim(),
      },
      chrome: { runtime: {
        onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
        sendMessage: () => undefined,
      } },
      MutationObserver: class { observe() {} disconnect() {} },
      setTimeout: (callback: () => void, ms: number) => { if (ms === 75 || ms === 2_000) queueMicrotask(callback); return 1; },
      clearTimeout: () => undefined,
    };
    runInNewContext(content, context);
    if (!listener) throw new Error('content script listener was not installed');
    const response = await new Promise<Record<string, unknown>>((resolve) => {
      listener!({ type: 'forge-computer-chatgpt-dispatch', prompt, expectedConversationId: identity.conversationId }, null, (value) => resolve(value as Record<string, unknown>));
    });
    expect(response.dispatched).toBe(shouldSend);
    expect(sends).toBe(shouldSend ? 1 : 0);
  }
  // The very same content-script snapshot must preserve the final assistant
  // receipt's newline; UI-label normalization would flatten it to one line.
  const instrumented = content.replace(
    '  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
    '  globalThis.__receiptSnapshot = pageSnapshot;\n  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
  );
  expect(instrumented).not.toBe(content);
  const assistantText = 'Delivered useful work.\n\nC ef207b8';
  const message = (role: string, value: string) => ({
    innerText: value,
    getAttribute: (name: string) => name === 'data-message-author-role' ? role : '',
    querySelector: () => null,
  });
  const user = message('user', 'Source effect sent');
  const assistant = message('assistant', assistantText);
  const main = {
    getClientRects: () => [1],
    querySelectorAll: (selector: string) => {
      const matches = selector.includes('conversation-turn') ? []
        : selector.includes('data-message-author-role="user"') && selector.includes('data-message-author-role="assistant"') ? [user, assistant]
          : selector.includes('data-message-author-role="user"') ? [user]
            : selector.includes('data-message-author-role="assistant"') ? [assistant] : [];
      return Object.assign(matches, { item: (index: number) => matches[index] });
    },
  };
  let fullPageTextReads = 0;
  const snapshotContext = {
    document: { title: 'Forge', body: { get innerText() { fullPageTextReads += 1; return 'Full page text'; } }, documentElement: {},
      querySelectorAll: (selector: string) => selector === 'main' ? [main] : [] },
    location: { href: currentUrl }, URL,
    ForgeComputerChatgptCore: { normalizeText: (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim(),
      parseConversation: () => null },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    MutationObserver: class { observe() {} },
    setTimeout() { return 1; }, clearTimeout() {},
  };
  runInNewContext(instrumented, snapshotContext);
  const snapshotReader = (snapshotContext as typeof snapshotContext & {
    __receiptSnapshot: (options?: { includePageText?: boolean }) => { latestAssistantResponse: string; latestTurnRole: string; pageText?: string };
  }).__receiptSnapshot;
  const snapshot = snapshotReader();
  expect(snapshot.latestAssistantResponse).toBe(assistantText);
  expect(snapshot.latestTurnRole).toBe('assistant');
  expect(fullPageTextReads).toBe(0);
  expect(snapshotReader({ includePageText: true }).pageText).toBe('Full page text');
  expect(fullPageTextReads).toBe(1);
});

test('recovery never clicks Stop and requires an exact idle assistant turn before editor mutation', () => {
  const source = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  expect(source).not.toContain('stop.click()');
  const instrumented = source.replace(
    '  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
    '  globalThis.__recoverNoStopReadiness = recoverNoStopReadiness;\n  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
  );
  expect(instrumented).not.toBe(source);
  const collection = <T,>(values: T[]) => Object.assign(values, { item: (index: number) => values[index] });
  const run = (options: { lastRole?: 'user' | 'assistant'; mapped?: boolean; turnBusy?: boolean; messageBusy?: boolean }) => {
    const turn = {
      getClientRects: () => [1],
      matches: (selector: string) => options.turnBusy === true && selector.includes('aria-busy'),
      querySelectorAll: (selector: string) => selector.includes('aria-busy') && options.turnBusy ? collection([{ getClientRects: () => [1] }]) : collection([] as unknown[]),
    };
    const message = {
      getClientRects: () => [1],
      getAttribute: (name: string) => name === 'data-message-author-role' ? options.lastRole ?? 'assistant' : '',
      closest: (selector: string) => selector.includes('conversation-turn') && options.mapped !== false ? turn : null,
      matches: (selector: string) => options.messageBusy === true && selector.includes('aria-busy'),
      querySelectorAll: (selector: string) => selector.includes('aria-busy') && options.messageBusy ? collection([{ getClientRects: () => [1] }]) : collection([] as unknown[]),
    };
    const main = {
      getClientRects: () => [1],
      querySelectorAll: (selector: string) => selector.includes('conversation-turn') ? collection([turn])
        : selector.includes('data-message-author-role="user"') && selector.includes('data-message-author-role="assistant"') ? collection([message])
          : selector.includes('data-message-author-role="user"') ? collection(options.lastRole === 'user' ? [message] : [])
            : selector.includes('data-message-author-role="assistant"') ? collection(options.lastRole === 'user' ? [] : [message])
              : collection([] as unknown[]),
    };
    const context = {
      document: { documentElement: {}, querySelectorAll: (selector: string) => selector === 'main' ? collection([main]) : collection([] as unknown[]) },
      location: { href: 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc' },
      URL, Date, Map, Promise,
      ForgeComputerChatgptCore: { normalizeText: (value: unknown) => String(value ?? '').trim(), parseConversation: () => null },
      chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
      MutationObserver: class { observe() {} disconnect() {} },
      setTimeout() { return 1; }, clearTimeout() {},
    };
    runInNewContext(instrumented, context);
    return (context as typeof context & { __recoverNoStopReadiness: () => { ready: boolean; reason?: string; capability?: string } }).__recoverNoStopReadiness();
  };
  expect(run({ lastRole: 'assistant' })).toMatchObject({ ready: true, capability: 'recover-no-stop-prewrite-v1' });
  expect(run({ lastRole: 'user' })).toMatchObject({ ready: false, reason: 'provider_recovery_turn_unknown' });
  expect(run({ lastRole: 'assistant', mapped: false })).toMatchObject({ ready: false, reason: 'provider_recovery_turn_unknown' });
  expect(run({ lastRole: 'assistant', turnBusy: true })).toMatchObject({ ready: false, reason: 'provider_recovery_turn_live' });
  expect(run({ lastRole: 'assistant', messageBusy: true })).toMatchObject({ ready: false, reason: 'provider_recovery_turn_live' });
});

test('live current-turn activity changes before the assistant role commits', () => {
  const content = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  const instrumented = content.replace(
    '  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
    '  globalThis.__providerActivitySnapshot = pageSnapshot;\n  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
  );
  expect(instrumented).not.toBe(content);
  const collection = <T,>(values: T[]) => Object.assign(values, { item: (index: number) => values[index] });
  const message = (role: 'user' | 'assistant', value: string) => ({
    innerText: value,
    textContent: value,
    getAttribute: (name: string) => name === 'data-message-author-role' ? role : '',
    querySelector: () => null,
  });
  const priorAssistant = message('assistant', 'Previously committed answer');
  const latestUser = message('user', 'Exact effect marker');
  let liveTurnText = 'Reasoning: inspecting the repository';
  let liveStopVisible = true;
  const turn = {
    get innerText() { return liveTurnText; },
    get textContent() { return liveTurnText; },
    getClientRects: () => [1],
    querySelectorAll: () => collection([] as unknown[]),
  };
  const main = {
    getClientRects: () => [1],
    querySelectorAll: (selector: string) => selector.includes('conversation-turn') ? collection([turn])
      : selector.includes('data-message-author-role="user"') && selector.includes('data-message-author-role="assistant"') ? collection([priorAssistant, latestUser])
        : selector.includes('data-message-author-role="user"') ? collection([latestUser])
          : selector.includes('data-message-author-role="assistant"') ? collection([priorAssistant])
            : collection([] as unknown[]),
  };
  const context = {
    document: { title: 'Forge', body: { innerText: '' }, documentElement: {},
      querySelectorAll: (selector: string) => selector === 'main' ? collection([main])
        : selector.includes('stop-button')
          ? (liveStopVisible ? collection([{ getClientRects: () => [1] }]) : collection([] as unknown[]))
          : collection([] as unknown[]) },
    location: { href: 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc' },
    URL, Date, Map, Promise,
    ForgeComputerChatgptCore: {
      normalizeText: (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim(),
      parseConversation: () => null,
    },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout() { return 1; }, clearTimeout() {},
  };
  runInNewContext(instrumented, context);
  const snapshot = (context as typeof context & {
    __providerActivitySnapshot: () => {
      latestAssistantResponse: string; latestTurnRole?: string; providerActivityText: string; isGenerating: boolean;
    };
  }).__providerActivitySnapshot;
  const first = snapshot();
  expect(first).toMatchObject({
    latestAssistantResponse: 'Previously committed answer',
    latestTurnRole: 'user',
    providerActivityText: 'Reasoning: inspecting the repository',
    isGenerating: true,
  });

  liveTurnText = 'Reasoning: inspecting the repository. Tool output: 4 files found.';
  const next = snapshot();
  expect(next.latestAssistantResponse).toBe(first.latestAssistantResponse);
  expect(next.latestTurnRole).toBe('user');
  expect(next.providerActivityText).toBe('Reasoning: inspecting the repository. Tool output: 4 files found.');
  expect(next.providerActivityText).not.toBe(first.providerActivityText);
  expect(next.isGenerating).toBe(true);
  liveStopVisible = false;
  expect(snapshot().isGenerating).toBe(false);
});

test('content script fences bootstrap sends to the exact Project and rejects migrated conversation URLs', async () => {
  const source = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  const expectedProjectId = 'g-p-abc';
  for (const [url, expectedReason] of [
    ['https://chatgpt.com/g/g-p-other/project', 'target_identity_changed'],
    ['https://chatgpt.com/g/g-p-abc-project/c/already-exists', 'target_identity_changed'],
    ['https://chatgpt.com/g/g-p-abc-project/project', 'composer_missing'],
  ]) {
    let listener: ((message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
    let clicks = 0;
    const document = {
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: () => Object.assign([], { item: () => undefined }),
    };
    const ctx = {
      URL, Date, Promise, location: { href: url }, document,
      ForgeComputerChatgptCore: {
        projectId: (href: string) => /^\/g\/(g-p-[a-z0-9]+)/i.exec(new URL(href).pathname)?.[1] ?? null,
        parseConversation: (href: string) => /\/c\/[^/]+/.test(new URL(href).pathname) ? { conversationId: 'already-exists' } : undefined,
        normalizeText: (value: unknown) => String(value ?? '').trim(),
      },
      chrome: { runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } }, sendMessage: () => { clicks++; } } },
      MutationObserver: class { observe() {} },
      setTimeout: () => 1, clearTimeout: () => undefined,
    };
    runInNewContext(source, ctx);
    if (!listener) throw new Error('No content listener');
    const result = await new Promise<Record<string, unknown>>(resolve => {
      listener!({
        type: 'forge-computer-chatgpt-dispatch',
        expectedProjectId,
        prompt: '@forge <<<FORGE_WORKFLOW_EFFECT_V1:fx_safe>>> original\nbody',
      }, null, (value) => resolve(value as Record<string, unknown>));
    });
    expect(result).toMatchObject({ dispatched: false, reason: expectedReason });
    expect(clicks).toBe(0);
  }
});

// F01: inject each pre-Send Chrome transport failure against the actual extension
// worker. None may submit, and the diagnostic must preserve the useful cause.
for (const [failure, expected] of [
  ['receiver', 'COMPUTER_CHATGPT_EXTENSION_CONTENT_UNAVAILABLE'],
  ['timeout', 'COMPUTER_CHATGPT_EXTENSION_TAB_MESSAGE_TIMEOUT'],
  ['other', 'COMPUTER_CHATGPT_EXTENSION_PREPARE_UNAVAILABLE'],
] as const) {
  test(`F01 injected prepare ${failure} remains pre-Send and actionable`, async () => {
    const f = fixture({ prepareTransportError: failure });
    expect(await f.prepare()).toMatchObject({ kind: 'prepared', ready: false, reasonCode: expected });
    expect(f.submissions).toBe(0);
    expect(f.messages).toEqual(['forge-computer-chatgpt-prepare']);
  });
}

// F01: Lost Prepare acknowledgment after a draft write grants no Send authority.
test('F01 prepare timeout after draft write remains unconfirmed without dispatch', async () => {
  const f = fixture({ prepareTransportError: 'timeout', prepareDraftWrittenBeforeTimeout: true });
  expect(await f.prepare()).toMatchObject({ kind: 'prepared', ready: false,
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TAB_MESSAGE_TIMEOUT' });
  expect(f.draftWrites).toBe(1);
  expect(f.submissions).toBe(0);
  expect(f.messages).toEqual(['forge-computer-chatgpt-prepare']);
});

// F11: An old physical tab ID can be reused in another Chrome window after
// restart. Even the same Project URL does not prove it is the Controller's tab.
test('F11 reused bootstrap tab id with missing owner token cannot be adopted or sent to', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-test/project';
  const f = bootstrapFixture([{ id: 707, windowId: 99, url: projectUrl }]);
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:pinned', projectUrl };
  const pin = { providerId: 'browser.chrome-extension', providerSessionId: 'profile-1',
    tabId: '707', windowId: '7', ownerToken: 'previous-physical-tab' };
  await expect(f.resolve(identity, true, pin)).rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_MISMATCH');
  // Moving the SAME physical tab to another Chrome window is safe when the
  // browser-session owner token still proves its identity.
  f.attestOwner(707, 'previous-physical-tab');
  expect((await f.resolve(identity, true, pin)).tab).toMatchObject({ id: 707, windowId: 99, url: projectUrl });
  expect(f.tabs).toHaveLength(1);
});

test('F11 reused conversation tab id must also prove owner token before binding', async () => {
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  const f = bootstrapFixture([{ id: 708, windowId: 19, url: conversationUrl }]);
  const identity = { namespace: 'chatgpt.conversation', conversationId, canonicalUrl: conversationUrl };
  const pin = { providerId: 'browser.chrome-extension', providerSessionId: 'profile-1',
    tabId: '708', windowId: '8', ownerToken: 'original-conversation-tab' };
  await expect(f.resolve(identity, false, pin)).rejects.toThrow('COMPUTER_CHATGPT_EXTENSION_PINNED_OWNER_TOKEN_MISMATCH');
  f.attestOwner(708, 'original-conversation-tab');
  expect((await f.resolve(identity, false, pin)).tab).toMatchObject({ id: 708, windowId: 19 });
});

// F11/P1: Pre-token legacy pinned bindings cannot borrow another task's
// same-Project tab. Never upgrade URL or Tab ID alone into Send authority.
test('F11 legacy pinned Chrome binding without owner token fails closed', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-test/project';
  const f = bootstrapFixture([{ id: 707, windowId: 99, url: projectUrl }]);
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:legacy', projectUrl };
  const legacy = { providerId: 'browser.chrome-extension', providerSessionId: 'old-profile', tabId: '707', windowId: '99' };
  await expect(f.resolve(identity, true, legacy)).rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_MISSING');
  expect(await f.resolve(identity, false)).toBeUndefined(); // failure must not seed a same-Project bootstrap map
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  const url = `https://chatgpt.com/c/${conversationId}`;
  const g = bootstrapFixture([{ id: 708, windowId: 19, url }]);
  await expect(g.resolve({ namespace: 'chatgpt.conversation', conversationId, canonicalUrl: url }, false,
    { ...legacy, tabId: '708', windowId: '19' })).rejects.toThrow('COMPUTER_CHATGPT_EXTENSION_PINNED_OWNER_TOKEN_MISSING');
});

// A successful tab.create is insufficient: failed OR dropped session writes
// leave an unowned shell, never a Controller-pinned Send receiver.
for (const options of [{ ownerWriteFails: true }, { ownerWriteDrops: true }]) {
  test(`F11 untrusted new tab owner storage ${options.ownerWriteFails ? 'reject' : 'drop'} never returns success`, async () => {
    const f = bootstrapFixture([], options);
    const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:new',
      projectUrl: 'https://chatgpt.com/g/g-p-test/project' };
    await expect(f.resolve(identity, true)).rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_UNAVAILABLE');
    expect(f.tabs).toHaveLength(1); // preserve, do not close or steal a user-visible tab
    expect(await f.resolve(identity, false)).toBeUndefined(); // no unverified tab reuse
  });
}

// Third independent Review P1: an ownerless pinned conversation can have no
// surviving physical tab; target creation still must fail BEFORE lookup or tab.create.
test('F11 absent pinned legacy tab never silently creates replacement', async () => {
  const f = bootstrapFixture();
  const conversationId = '12345678-1234-1234-1234-123456789abc';
  const url = `https://chatgpt.com/c/${conversationId}`;
  const pin = { providerId: 'browser.chrome-extension', providerSessionId: 'legacy-instance',
    tabId: '999', windowId: '19' };
  await expect(f.resolve({ namespace: 'chatgpt.conversation', conversationId, canonicalUrl: url }, true, pin))
    .rejects.toThrow('COMPUTER_CHATGPT_EXTENSION_PINNED_OWNER_TOKEN_MISSING');
  expect(f.tabs).toHaveLength(0);
  const bootstrapIdentity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:old',
    projectUrl: 'https://chatgpt.com/g/g-p-test/project' };
  await expect(f.resolve(bootstrapIdentity, true, pin)).rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_OWNER_TOKEN_MISSING');
  expect(f.tabs).toHaveLength(0);
});

// Fourth independent Review P1: URL-only discovery may inspect an existing
// conversation, but it is not physical-tab ownership and cannot authorize Send.
test('F11 unbound existing conversation refuses Prepare and Dispatch without Send', async () => {
  const f = fixture({ unbound: true });
  expect(await f.prepare()).toMatchObject({ kind: 'prepared', ready: false,
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING' });
  expect(await f.dispatch()).toMatchObject({ kind: 'dispatch', mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_TARGET_MISSING' });
  expect(f.submissions).toBe(0);
  expect(f.messages).toEqual([]);
});

test('F11 first conversation Ensure creates a dedicated attested tab, never borrows an unbound existing tab', async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const url = `https://chatgpt.com/c/${id}`;
  const f = bootstrapFixture([{ id: 55, windowId: 3, url }]);
  const resolved = await f.resolve({ namespace: 'chatgpt.conversation', conversationId: id, canonicalUrl: url }, true);
  expect(resolved.created).toBe(true);
  expect(resolved.tab.id).not.toBe(55);
  expect(resolved.ownerToken).toBeTruthy();
  expect(f.tabs).toHaveLength(2);
  expect(f.tabs[0]?.id).toBe(55);
});

// Fifth independent Review P1: a task may own an in-memory Bootstrap tab from
// a previous Ensure, but an explicit different Provider is a conflicting owner.
test('F11 conflicting bootstrap Provider cannot bypass cached map or execute Send', async () => {
  const f = bootstrapFixture();
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:cached',
    projectUrl: 'https://chatgpt.com/g/g-p-test/project' };
  const created = await f.resolve(identity, true);
  const foreign = { providerId: 'browser.other', providerSessionId: 'other-provider',
    tabId: String(created.tab.id), windowId: '8', ownerToken: created.ownerToken };
  await expect(f.resolve(identity, false, foreign)).rejects.toThrow('COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH');
  expect(await f.prepare(identity, foreign)).toMatchObject({ ready: false,
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH' });
  expect(await f.dispatch(identity, foreign)).toMatchObject({ mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH' });
  const incomplete = { providerId: 'browser.chrome-extension', ownerToken: created.ownerToken };
  await expect(f.resolve(identity, false, incomplete)).rejects.toThrow('COMPUTER_CHATGPT_EXTENSION_PINNED_BINDING_INCOMPLETE');
  expect(await f.prepare(identity, incomplete)).toMatchObject({ ready: false,
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PINNED_BINDING_INCOMPLETE' });
  await expect(f.resolve(identity, false)).rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_BINDING_REQUIRED');
  expect(f.dispatchSends).toBe(0);
  expect(f.tabs).toHaveLength(1);
  const valid = { providerId: 'browser.chrome-extension', providerSessionId: 'test-provider',
    tabId: String(created.tab.id), windowId: '8', ownerToken: created.ownerToken };
  expect((await f.resolve(identity, false, valid, 'test-provider')).tab.id).toBe(created.tab.id);
});

// Sixth independent Review P1: marker discovery must not launder another
// Provider's explicit binding into this Chrome profile's owned tab.
test('F11 find_marker rejects foreign Provider before reading tabs or returning a Chrome binding', async () => {
  const conversationUrl = 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
  const f = bootstrapFixture([{ id: 88, windowId: 8, url: conversationUrl }], { markerObservation: true });
  f.attestOwner(88, 'real-chrome-owner');
  const foreign = { providerId: 'browser.other', providerSessionId: 'profile-attested',
    tabId: '88', windowId: '8', ownerToken: 'real-chrome-owner' };
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:foreign',
    projectUrl: 'https://chatgpt.com/g/g-p-test/project' };
  expect(await f.findMarker(identity, foreign, 'profile-attested')).toMatchObject({
    kind: 'failed', code: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH',
  });
  expect(f.tabQueries).toBe(0);
  expect(f.snapshotReads).toBe(0);
  expect(f.dispatchSends).toBe(0);
});

test('F11 Prepare and Dispatch retain typed refusal reasons, never Send on a conflicting Provider', async () => {
  const f = bootstrapFixture();
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:typed',
    projectUrl: 'https://chatgpt.com/g/g-p-test/project' };
  const own = await f.resolve(identity, true);
  const foreign = { providerId: 'browser.other', providerSessionId: 'foreign',
    tabId: String(own.tab.id), windowId: '8', ownerToken: own.ownerToken };
  expect(await f.prepare(identity, foreign)).toMatchObject({ kind: 'prepared', ready: false,
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH' });
  expect(await f.dispatch(identity, foreign)).toMatchObject({ kind: 'dispatch', mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_BINDING_MISMATCH' });
  const incomplete = { providerId: 'browser.chrome-extension', ownerToken: own.ownerToken };
  expect(await f.prepare(identity, incomplete)).toMatchObject({ ready: false,
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PINNED_BINDING_INCOMPLETE' });
  expect(await f.dispatch(identity, incomplete)).toMatchObject({ mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_EXTENSION_PINNED_BINDING_INCOMPLETE' });
  expect(f.dispatchSends).toBe(0);
});

// Seventh independent Review P1: valid tab ID and Chrome session owner token
// do NOT override an incompatible providerSessionId. Every direct target entry
// fails before a chrome.tabs.query, snapshot, or Send side effect.
test('F11 stale providerSessionId with valid token fails closed before any browser tab access', async () => {
  const f = bootstrapFixture([{ id: 88, windowId: 99, url: 'https://chatgpt.com/g/g-p-test/project' }]);
  f.attestOwner(88, 'legit-owned-tab');
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:stale-profile',
    projectUrl: 'https://chatgpt.com/g/g-p-test/project' };
  const stale = { providerId: 'browser.chrome-extension', providerSessionId: 'stale-chrome-profile',
    tabId: '88', windowId: '8', ownerToken: 'legit-owned-tab' };
  const reason = 'COMPUTER_CHATGPT_EXTENSION_PROVIDER_SESSION_MISMATCH';
  await expect(f.resolve(identity, false, stale, 'active-chrome-profile')).rejects.toThrow(reason);
  expect(await f.ensure(identity, stale, 'active-chrome-profile')).toMatchObject({ kind: 'failed', code: reason });
  expect(await f.observe(identity, stale, 'active-chrome-profile')).toMatchObject({ kind: 'failed', code: reason });
  expect(await f.prepare(identity, stale, 'active-chrome-profile')).toMatchObject({ ready: false, reasonCode: reason });
  expect(await f.dispatch(identity, stale, 'active-chrome-profile')).toMatchObject({ mutation: 'not_attempted', reasonCode: reason });
  expect(await f.findMarker(identity, stale, 'active-chrome-profile')).toMatchObject({ kind: 'failed', code: reason });
  expect(f.tabQueries).toBe(0);
  expect(f.snapshotReads).toBe(0);
  expect(f.dispatchSends).toBe(0);
});

// Eighth independent Review P2: a validated previously-owned Bootstrap pin
// must still be recoverable by Ensure after the tab moves to another window.
test('F11 valid pinned Ensure with matching providerSessionId and owner Token succeeds after window move', async () => {
  const projectUrl = 'https://chatgpt.com/g/g-p-test/project';
  const f = bootstrapFixture([{ id: 88, windowId: 99, url: projectUrl }], { validEnsureSnapshot: true });
  f.attestOwner(88, 'verified-bootstrap-owner');
  const identity = { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:valid-ensure', projectUrl };
  const pinned = { providerId: 'browser.chrome-extension', providerSessionId: 'active-chrome-profile',
    tabId: '88', windowId: '8', ownerToken: 'verified-bootstrap-owner' };
  expect(await f.ensure(identity, pinned, 'active-chrome-profile')).toMatchObject({ kind: 'ensured',
    providerBinding: { providerId: 'browser.chrome-extension', providerSessionId: 'active-chrome-profile',
      tabId: '88', windowId: '99', ownerToken: 'verified-bootstrap-owner' } });
  expect(f.tabQueries).toBe(1);
  expect(f.snapshotReads).toBe(1);
  expect(f.dispatchSends).toBe(0);
  expect(f.tabs).toHaveLength(1);
});
