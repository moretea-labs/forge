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
  dispatch?: { dispatched: boolean; reasoningVerified?: string };
};
function fixture(scenario: Scenario) {
  const tab = { id: 42, windowId: 8, url, title: 'Test conversation' };
  const messages: string[] = [];
  let submissions = 0;
  const chrome = {
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
        if (message.type === 'forge-computer-chatgpt-dispatch') {
          submissions += 1;
          callback(scenario.dispatch ?? { dispatched: true, reasoningVerified: 'xhigh' });
          return;
        }
        if (message.type === 'forge-computer-chatgpt-snapshot') {
          callback({ latestUserText: 'source delivery' });
          return;
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
      if (ms === 200 || ms === 400 || ms === 600 || ms === 800) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    setInterval() { return 1; },
  };
  const scope = runInNewContext(
    source + '\n;globalThis.__testDispatch = executeDispatch;',
    testContext,
    { filename: 'background.js' },
  ) as unknown;
  void scope;
  const dispatch = (reasoning?: 'xhigh') =>
    (testContext as typeof testContext & {
      __testDispatch: (value: object) => Promise<Response>;
    }).__testDispatch({ kind: 'dispatch', identity, prompt: 'source delivery', ...(reasoning ? { reasoning } : {}) });
  return { dispatch, messages, get submissions() { return submissions; } };
}

test('old content script lacking reasoning preflight cannot receive a Supervisor send', async () => {
  const f = fixture({ capability: undefined });
  expect(await f.dispatch('xhigh')).toMatchObject({
    mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_REASONING_PREFLIGHT_UNSUPPORTED',
  });
  expect(f.submissions).toBe(0);
  expect(f.messages).toEqual(['forge-computer-chatgpt-capabilities']);
});

test('capability transport failure remains pre-mutation and never triggers an ambiguous replay', async () => {
  const f = fixture({ preflightTransportError: true });
  expect(await f.dispatch('xhigh')).toMatchObject({
    mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_REASONING_PREFLIGHT_UNAVAILABLE',
  });
  expect(f.submissions).toBe(0);
});

test('exact target tab capability permits verified reasoning dispatch and observation', async () => {
  const f = fixture({ capability: { reasoningPreflight: 'verified_before_send_v1' } });
  expect(await f.dispatch('xhigh')).toMatchObject({
    mutation: 'attempted', confirmed: true, reasoningVerified: 'xhigh',
  });
  expect(f.submissions).toBe(1);
  expect(f.messages).toEqual([
    'forge-computer-chatgpt-capabilities',
    'forge-computer-chatgpt-dispatch',
    'forge-computer-chatgpt-snapshot',
  ]);
});

test('legacy ordinary dispatch omits the reasoning handshake', async () => {
  const f = fixture({});
  expect(await f.dispatch()).toMatchObject({ mutation: 'attempted', confirmed: true });
  expect(f.submissions).toBe(1);
  expect(f.messages).not.toContain('forge-computer-chatgpt-capabilities');
});

test('preflight cannot retroactively declare a send not attempted when execution lacks attestation', async () => {
  const f = fixture({ capability: { reasoningPreflight: 'verified_before_send_v1' }, dispatch: { dispatched: true } });
  expect(await f.dispatch('xhigh')).toMatchObject({ mutation: 'attempted', confirmed: false });
  expect(f.submissions).toBe(1);
});

function bootstrapFixture(initialTabs: Array<{ id: number; windowId: number; url: string }> = []) {
  const tabs = [...initialTabs];
  let nextTabId = 200;
  const projectId = (value: string) => /\/g\/(g-p-[^/]+)/.exec(value)?.[1] ?? null;
  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }; },
      onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    tabs: {
      async query() { return [...tabs]; },
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
      parseConversation() { return null; }, projectId,
      normalizeText(value: unknown) { return String(value ?? '').trim(); },
    },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; },
  };
  runInNewContext(source + '\n;globalThis.__resolveTarget = resolveTarget;globalThis.__matchingTabs = matchingTabs;', context);
  return {
    tabs,
    resolve: (identity: object, create: boolean, pinned?: object) =>
      (context as typeof context & { __resolveTarget: (identity: object, create: boolean, pinned?: object) => Promise<{ tab: { id: number; windowId: number; url: string }; created: boolean }> }).__resolveTarget(identity, create, pinned),
  };
}

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
    providerSessionId: 'fresh-extension-instance', windowId: '8', tabId: '82' };
  const recovered = await fixture.resolve(android, true, pin);
  expect(recovered.created).toBe(false);
  expect(recovered.tab.id).toBe(82);
  expect(fixture.tabs).toHaveLength(2);
  await expect(fixture.resolve(android, true, { ...pin, tabId: '999' }))
    .rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_MISSING');
  await expect(fixture.resolve({ ...android, projectUrl: 'https://chatgpt.com/g/g-p-unrelated' }, true, { ...pin, tabId: '81' }))
    .rejects.toThrow('COMPUTER_CHATGPT_BOOTSTRAP_PINNED_TAB_IDENTITY_CHANGED');
  expect(fixture.tabs).toHaveLength(2);
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
    const composer = { value: rendered };
    const sendButton = { disabled: false, getAttribute: () => null, click: () => { sends += 1; } };
    let sends = 0;
    let listener: ((message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
    const empty = Object.assign([], { item: () => undefined });
    const document = {
      documentElement: {},
      querySelector: (selector: string) => selector.includes('#prompt-textarea') ? composer
        : selector.includes('send-button') ? sendButton : null,
      querySelectorAll: (_selector: string) => empty,
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
      MutationObserver: class { observe() {} },
      setTimeout: (callback: () => void, ms: number) => { if (ms === 75) queueMicrotask(callback); return 1; },
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
