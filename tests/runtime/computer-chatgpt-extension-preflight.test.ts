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
  dispatch?: { dispatched: boolean; confirmed?: boolean; reasoningVerified?: string };
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

test('exact target tab capability permits verified reasoning dispatch with in-page commit acknowledgment', async () => {
  const f = fixture({ capability: { reasoningPreflight: 'verified_before_send_v1' } });
  expect(await f.dispatch('xhigh')).toMatchObject({
    mutation: 'attempted', confirmed: true, reasoningVerified: 'xhigh',
  });
  expect(f.submissions).toBe(1);
  expect(f.messages).toEqual([
    'forge-computer-chatgpt-capabilities',
    'forge-computer-chatgpt-dispatch',
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
    const composer = { value: rendered, querySelector: () => null, getClientRects: () => [{}] };
    const sendButton = { disabled: false, getAttribute: () => null, click: () => { sends += 1; } };
    let sends = 0;
    let listener: ((message: Record<string, unknown>, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
    const empty = Object.assign([], { item: () => undefined });
    const document = {
      documentElement: {},
      querySelector: (selector: string) => selector.includes('#prompt-textarea') ? composer
        : selector.includes('send-button') ? sendButton : null,
      querySelectorAll: (selector: string) => selector.includes('#prompt-textarea') ? [composer] : empty,
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

test('reasoning preflight finds the visible top-header model control outside main and records highest available level', async () => {
  const content = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  // Exercise the genuine closure-scoped verifier without a provider Send.
  const instrumented = content.replace(
    '  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
    '  globalThis.__testEnsureReasoning = ensureReasoning;\n  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
  );
  expect(instrumented).not.toBe(content);
  let menuOpened = false;
  let label = 'GPT-6';
  let selected = '';
  const visible = () => [1];
  const headerButton = {
    getClientRects: visible,
    getAttribute: (name: string) => name === 'aria-label' ? label : null,
    get innerText() { return label; },
    click() { menuOpened = true; },
  };
  const option = (value: string) => ({
    getClientRects: visible,
    innerText: value,
    hasAttribute: () => false,
    getAttribute: (name: string) => name === 'aria-disabled' ? 'false' : null,
    click() { selected = value; label = value; menuOpened = false; },
  });
  const main = { getClientRects: visible, querySelectorAll: () => [] };
  const document = {
    documentElement: {},
    querySelectorAll: (selector: string) => selector === 'main' ? [main]
      : selector.includes('[aria-haspopup="menu"]') ? [headerButton]
        : selector.includes('menuitemradio') && menuOpened ? [option('High'), option('Medium')]
          : [],
  };
  const context = {
    document, location: { href: 'https://chatgpt.com/g/g-p-forge/project' }, URL,
    ForgeComputerChatgptCore: {
      normalizeText: (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim(),
      parseConversation: () => null,
    },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    MutationObserver: class { observe() {} },
    // Advance only the 80 ms menu-acknowledgement sleeps. The page's 200 ms
    // discovery notification is unrelated to this reasoning-only regression.
    setTimeout(callback: () => void, ms: number) { if (ms === 80) queueMicrotask(callback); return 1; }, clearTimeout() {},
  };
  runInNewContext(instrumented, context);
  const verifier = (context as typeof context & {
    __testEnsureReasoning: (level: string) => Promise<{ verified: boolean; level?: string; reason?: string }>
  }).__testEnsureReasoning;
  expect(typeof verifier).toBe('function');
  expect(await verifier('xhigh')).toEqual({ verified: true, level: 'high' });
  expect(selected).toBe('High');
});

test('real GPT-6 Chinese picker verifies the strongest available three-step reasoning level via its keyboard-control parent', async () => {
  const content = readFileSync(new URL('../../adapters/computer/chrome-extension/content.js', import.meta.url), 'utf8');
  const instrumented = content.replace(
    '  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
    '  globalThis.__testEnsureReasoning = ensureReasoning; globalThis.__testPageSnapshot = pageSnapshot;\n  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {',
  );
  let menuOpen = false;
  let value = 1;
  let focused = false;
  let keypresses = 0;
  let pickerVisible = true;
  const visible = () => [1];
  const status = { innerText: '中，第 2 项，共 3 项。' };
  const headerMode = {
    getClientRects: visible, innerText: 'ChatGPT',
    getAttribute: (key: string) => key === 'aria-label' ? '切换模式，当前模式：ChatGPT' : null,
  };
  const modelButton = {
    getClientRects: () => pickerVisible ? [1] : [], innerText: '中',
    getAttribute: (key: string) => key === 'aria-label' ? '选择 ChatGPT 模型' : key === 'aria-expanded' ? String(menuOpen) : null,
    click() { menuOpen = !menuOpen; },
  };
  const menu = { querySelectorAll: (s: string) => s === '[role="status"]' ? [status] : [] };
  const strength = {
    getClientRects: visible,
    getAttribute: (key: string) => key === 'aria-disabled' ? 'false' : null,
    focus() { focused = true; },
    closest: (s: string) => s === '[role="menu"]' ? menu : null,
    dispatchEvent(event: { key?: string }) {
      if (!focused || event.key !== 'ArrowRight') return;
      keypresses += 1;
      value = Math.min(2, value + 1);
      status.innerText = '高，第 3 项，共 3 项。';
      modelButton.innerText = '高';
    },
  };
  const slider = {
    getClientRects: visible,
    getAttribute: (key: string) => key === 'aria-valuemin' ? '0'
      : key === 'aria-valuemax' ? '2'
        : key === 'aria-valuenow' ? String(value)
          : key === 'aria-valuetext' ? null : null,
    closest: (s: string) => s === '[data-reasoning-slider="true"]' ? strength
      : s === '[aria-disabled="true"]' ? null : null,
    dispatchEvent() { throw new Error('aria-hidden slider must not receive keyboard input'); },
  };
  const empty = Object.assign([], { item: () => undefined });
  let composerDraft = '';
  let editorParagraphs: string[] | undefined;
  const document = {
    documentElement: {}, body: { innerText: '' }, title: 'Forge project',
    querySelector: (selector: string) => selector.includes('#prompt-textarea')
      ? editorParagraphs ? {
        isContentEditable: true, getClientRects: visible,
        innerText: editorParagraphs.join('\n\n'),
        children: editorParagraphs.map((text) => ({ tagName: 'P', innerText: text, textContent: text })),
      } : { value: composerDraft, getClientRects: visible }
      : null,
    querySelectorAll: (selector: string) => selector.includes('#prompt-textarea') ? [document.querySelector(selector)]
      : selector === 'main' ? [{ getClientRects: visible, querySelectorAll: () => empty }]
      : selector.includes('[aria-haspopup="menu"]') ? [headerMode, modelButton]
        : selector.includes('[role="slider"][aria-valuenow]') && menuOpen ? [slider]
          : selector.includes('menuitemradio') ? [] : [],
  };
  const context = {
    document, location: { href: 'https://chatgpt.com/g/g-p-forge/project' }, URL,
    ForgeComputerChatgptCore: {
      normalizeText: (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim(),
      parseConversation: () => null,
    },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
    MutationObserver: class { observe() {} },
    KeyboardEvent: class { key: string; constructor(_type: string, opts: { key: string }) { this.key = opts.key; } },
    setTimeout(fn: () => void, ms: number) { if (ms === 80 || ms === 40) queueMicrotask(fn); return 1; },
    clearTimeout() {},
  };
  runInNewContext(instrumented, context);
  const verifier = (context as typeof context & {
    __testEnsureReasoning: (level: string) => Promise<{ verified: boolean; level?: string; reason?: string }>
  }).__testEnsureReasoning;
  expect(await verifier('xhigh')).toEqual({ verified: true, level: 'high' });
  expect(value).toBe(2);
  expect(keypresses).toBe(1);
  // A previous preflight may leave the actual model menu open. Repeating the
  // same prepare must read that live menu, not click the toggle and close it.
  expect(menuOpen).toBe(true);
  expect(await verifier('xhigh')).toEqual({ verified: true, level: 'high' });
  expect(keypresses).toBe(1);
  expect(menuOpen).toBe(true);
  const snapshot = (context as typeof context & {
    __testPageSnapshot: () => { composerText?: string; reasoningControlReady?: boolean };
  }).__testPageSnapshot;
  expect(snapshot()).toMatchObject({ composerText: '', reasoningControlReady: true });
  pickerVisible = false;
  expect(snapshot()).toMatchObject({ composerText: '', reasoningControlReady: false });
  // A real empty ChatGPT ProseMirror paragraph presents innerText as a single
  // newline. That blank UI must not be mistaken for another user's draft.
  composerDraft = '\n';
  expect(snapshot()).toMatchObject({ composerText: '' });
  composerDraft = ' \n \t ';
  expect(snapshot()).toMatchObject({ composerText: '' });
  // Once any payload exists, preserve its whitespace byte-for-byte.
  composerDraft = '  first\n\nsecond  ';
  expect(snapshot()).toMatchObject({ composerText: composerDraft });
  // Real Chrome ProseMirror uses direct P blocks. HTMLElement.innerText
  // inserts TWO newlines between blocks, although the original effect has
  // exactly ONE; content script must reconstruct the original line breaks.
  editorParagraphs = ['<<<EFFECT>>>', 'line two', 'line three', '@'];
  expect(snapshot()).toMatchObject({ composerText: '<<<EFFECT>>>\nline two\nline three\n@' });
  editorParagraphs = ['  leading', '', 'trailing  ', '@'];
  expect(snapshot()).toMatchObject({ composerText: '  leading\n\ntrailing  \n@' });
  editorParagraphs = [''];
  expect(snapshot()).toMatchObject({ composerText: '' });
});
