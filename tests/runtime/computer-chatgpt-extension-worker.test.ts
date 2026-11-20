import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function runChromeContentScript(source: string, scope: Record<string, unknown>): unknown {
  const existing = scope.window && typeof scope.window === 'object' ? scope.window as Record<string, unknown> : {};
  const events = new EventTarget();
  if (typeof existing.addEventListener !== 'function') {
    existing.addEventListener = events.addEventListener.bind(events);
    existing.removeEventListener = events.removeEventListener.bind(events);
  }
  scope.window = existing;
  return runInNewContext(source, scope, { filename: 'content.js' });
}

test('invalidated content context stops observing the page without throwing', () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/content.js', import.meta.url), 'utf8');
  let pending: (() => void) | undefined;
  let onMutation: (() => void) | undefined;
  let disconnects = 0;
  let sends = 0;
  const scope = {
    ForgeComputerChatgptCore: { parseConversation: () => null },
    document: { documentElement: {}, querySelectorAll: () => [] },
    location: { href: 'https://chatgpt.com/' },
    chrome: { runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: () => { sends++; throw new Error('Extension context invalidated.'); },
    } },
    MutationObserver: class {
      constructor(callback: () => void) { onMutation = callback; }
      observe() {}
      disconnect() { disconnects++; }
    },
    setTimeout: (callback: () => void) => { pending = callback; return 1; },
    clearTimeout: () => {}, URL,
  };
  runChromeContentScript(source, scope);
  expect(() => pending!()).not.toThrow();
  expect(disconnects).toBe(1);
  pending = undefined;
  onMutation!();
  expect(pending).toBeUndefined();
  expect(sends).toBe(1);
});

test('content context stops observing when runtime is absent after reload', () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/content.js', import.meta.url), 'utf8');
  let pending: (() => void) | undefined;
  let disconnected = false;
  const runtime: { onMessage: { addListener: () => void } } | undefined = { onMessage: { addListener: () => {} } };
  const chrome: { runtime: { onMessage: { addListener: () => void } } | undefined } = { runtime };
  const scope = {
    ForgeComputerChatgptCore: { parseConversation: () => null },
    document: { documentElement: {} }, location: { href: 'https://chatgpt.com/' }, chrome,
    MutationObserver: class { observe() {} disconnect() { disconnected = true; } },
    setTimeout: (callback: () => void) => { pending = callback; return 1; },
    clearTimeout: () => {}, URL,
  };
  runChromeContentScript(source, scope);
  chrome.runtime = undefined;
  expect(() => pending!()).not.toThrow();
  expect(disconnected).toBe(true);
});


test('new owned exact tab waits for navigation identity before receiver recovery', () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  expect(source).toContain('async function waitForCreatedTargetIdentity(tabId, identity)');
  expect(source).toContain("if (tab?.status === 'complete') break;");
  expect(source).toContain('? restoreCreatedExactContentReceiver(target.tab.id, command.identity)');
  expect(source).toContain(': restoreExactContentReceiver(target.tab.id, command.identity)');
});

test('MV3 provider re-arms its single command pump after transient failure without waiting for port disconnect', () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  expect(source).toContain('const PROVIDER_RESTART_DELAY_MS = 1_000;');
  expect(source).toContain('let providerRestartTimer;');
  expect(source).toContain('function scheduleProviderPumpRestart()');
  expect(source).toContain('if (providerRestartTimer !== undefined) return;');
  expect(source).toContain("console.warn('COMPUTER_CHATGPT_EXTENSION_PROVIDER_PUMP_RESTART'");
  expect(source).toContain('scheduleProviderPumpRestart();');
  expect(source).not.toContain("setTimeout(() => { void providerTick().catch(() => undefined); }, 500);");
});

test('MV3 provider keeps a native command pump alive between alarm wakes', () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  expect(source).toContain('const PROVIDER_COMMAND_POLL_MS = 1_000;');
  expect(source).toContain('const PROVIDER_HEARTBEAT_REFRESH_MS = 8_000;');
  expect(source).toContain('async function runProviderPump()');
  expect(source).toContain("await nativeRpc('computer_extension_claim', { provider_instance_id: instanceId });");
  expect(source).toContain('await sleep(PROVIDER_COMMAND_POLL_MS);');
  expect(source).toContain('if (providerTickInFlight) return providerTickInFlight;');
  expect(source).not.toContain('setInterval(() => { void providerTick()');
});

test('heartbeat promotes only extension-owned conversation tabs with their session owner token', async () => {
  const src = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  const worker = src.slice(0, src.indexOf('chrome.runtime.onMessage.addListener('))
    .replace("importScripts('core.js');", '')
    + '\nglobalThis.__testPublishHeartbeat = publishHeartbeat;';
  const ownedUrl = 'https://chatgpt.com/c/owned-heartbeat-1';
  const userUrl = 'https://chatgpt.com/c/user-heartbeat-2';
  const owned = { id: 71, windowId: 8, url: ownedUrl, title: 'Owned', active: true };
  const user = { id: 72, windowId: 8, url: userUrl, title: 'User', active: false };
  const ownerTokens = new Map<string, string>([['forgeComputerOwnedTabV1:71', 'owned-token-71']]);
  let heartbeatParams: Record<string, unknown> | undefined;
  let messageListener: ((value: unknown) => void) | undefined;
  const port = {
    onMessage: { addListener(listener: (value: unknown) => void) { messageListener = listener; } },
    onDisconnect: { addListener() {} },
    disconnect() {},
    postMessage(message: { id: string; method: string; params: Record<string, unknown> }) {
      if (message.method === 'computer_extension_heartbeat') heartbeatParams = message.params;
      queueMicrotask(() => messageListener?.({ id: message.id, ok: true, result: { recorded: true } }));
    },
  };
  const sandbox = {
    ForgeComputerChatgptCore: {
      parseConversation: (raw: string) => {
        const match = raw.match(/^https:\/\/chatgpt\.com\/c\/(.+)$/);
        return match ? { conversationId: match[1], canonicalUrl: raw } : null;
      },
      projectId: () => undefined,
    },
    navigator: { userAgent: 'Chrome' },
    crypto: { randomUUID: () => 'heartbeat-rpc-id' },
    chrome: {
      runtime: { lastError: null, connectNative: () => port },
      storage: {
        local: {
          async get() { return { forgeComputerProviderInstanceId: 'centbrowser-profile' }; },
          async set() {},
        },
        session: {
          async get(key: string) { return { [key]: ownerTokens.get(key) }; },
        },
      },
      tabs: {
        query: async (query: { active?: boolean }) => query.active ? [owned] : [owned, user],
      },
    },
    URL, Date, Map, Promise,
    setTimeout, clearTimeout, queueMicrotask,
  };
  runInNewContext(worker, sandbox);
  await (sandbox as typeof sandbox & {
    __testPublishHeartbeat: () => Promise<string>;
  }).__testPublishHeartbeat();

  const conversations = (heartbeatParams?.conversations as Array<{
    conversationId: string;
    providerBinding: { ownerToken?: string };
  }>) ?? [];
  expect(conversations).toHaveLength(2);
  expect(conversations.find((entry) => entry.conversationId === 'owned-heartbeat-1')?.providerBinding.ownerToken)
    .toBe('owned-token-71');
  expect(conversations.find((entry) => entry.conversationId === 'user-heartbeat-2')?.providerBinding.ownerToken)
    .toBeUndefined();
});

test('new bootstrap tab requires its hydrated editor, not a model picker, before preflight', async () => {
  const src = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  const worker = src.slice(0, src.indexOf('chrome.runtime.onMessage.addListener('))
    .replace("importScripts('core.js');", '')
    + '\nglobalThis.__testEnsureHydrated = executeEnsure;';
  const projectUrl = 'https://chatgpt.com/g/g-p-abc/project';
  const tab = { id: 507, windowId: 8, url: projectUrl };
  const snapshots = [
    { url: projectUrl },
    { url: projectUrl, composerText: '' },
  ];
  let snapshotCount = 0;
  let created = 0;
  const ownerTokens = new Map<string, string>();
  const sandbox = {
    ForgeComputerChatgptCore: { projectId: () => 'g-p-abc', parseConversation: () => null },
    navigator: { userAgent: 'Chrome' },
    crypto: { randomUUID: () => 'model-ready-test' },
    chrome: {
      storage: { session: {
        async set(values: Record<string, string>) { for (const [k, v] of Object.entries(values)) ownerTokens.set(k, v); },
        async get(k: string) { return { [k]: ownerTokens.get(k) }; },
      } },
      runtime: { lastError: null },
      tabs: {
        query: async () => [],
        create: (_options: unknown, callback: (createdTab: typeof tab) => void) => {
          created += 1; callback(tab);
        },
        get: (_id: number, callback: (liveTab: typeof tab) => void) => callback(tab),
        sendMessage: (_id: number, message: { type: string }, callback: (value: unknown) => void) => {
          if (message.type !== 'forge-computer-chatgpt-snapshot') {
            throw new Error('Readiness only probes page snapshots; no Send or Prepare allowed');
          }
          callback(snapshots[Math.min(snapshotCount++, snapshots.length - 1)]);
        },
      },
    },
    URL, Date, Map, Promise, setTimeout: (callback: () => void, delay = 0) => { if (delay < 5_000) queueMicrotask(callback); return 1; },
    clearTimeout() {},
  };
  runInNewContext(worker, sandbox);
  const run = (sandbox as typeof sandbox & {
    __testEnsureHydrated: (command: unknown, instance: string) => Promise<Record<string, unknown>>;
  }).__testEnsureHydrated;
  const result = await run({ kind: 'ensure',
    identity: { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:forge', projectUrl } }, 'real-chrome');
  expect(result).toMatchObject({ kind: 'ensured', providerBinding: { tabId: '507', windowId: '8' } });
  expect(created).toBe(1);
  expect(snapshotCount).toBe(2);
});

test('unhydrated bootstrap remains bound to its one created tab without creating or sending again', async () => {
  const src = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  const worker = src.slice(0, src.indexOf('chrome.runtime.onMessage.addListener('))
    .replace("importScripts('core.js');", '')
    + '\nglobalThis.__testEnsureHydrated = executeEnsure;';
  const url = 'https://chatgpt.com/g/g-p-abc/project';
  const tab = { id: 508, windowId: 8, url };
  let created = 0;
  let snapshots = 0;
  const ownerTokens = new Map<string, string>();
  const sandbox = {
    ForgeComputerChatgptCore: { projectId: () => 'g-p-abc', parseConversation: () => null },
    navigator: { userAgent: 'Chrome' }, crypto: { randomUUID: () => 'unready-test' },
    chrome: { runtime: { lastError: null }, storage: { session: {
      async set(values: Record<string, string>) { for (const [k, v] of Object.entries(values)) ownerTokens.set(k, v); },
      async get(k: string) { return { [k]: ownerTokens.get(k) }; },
    } }, tabs: {
      query: async () => [],
      create: (_options: unknown, callback: (t: typeof tab) => void) => { created++; callback(tab); },
      get: (_id: number, callback: (t: typeof tab) => void) => callback(tab),
      sendMessage: (_id: number, message: { type: string }, callback: (v: unknown) => void) => {
        if (message.type !== 'forge-computer-chatgpt-snapshot') throw new Error('Only snapshot allowed');
        snapshots++;callback({ url });
      },
    } },
    URL, Date, Map, Promise, setTimeout: (fn: () => void, delay = 0) => { if (delay < 5_000) queueMicrotask(fn); return 1; }, clearTimeout() {},
  };
  runInNewContext(worker, sandbox);
  const result = await (sandbox as typeof sandbox & {
    __testEnsureHydrated: (command: unknown, instance: string) => Promise<Record<string, unknown>>;
  }).__testEnsureHydrated({ kind: 'ensure',
    identity: { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:forge', projectUrl: url } }, 'real-chrome');
  expect(result).toMatchObject({ kind: 'failed', code: 'COMPUTER_CHATGPT_TAB_NOT_READY', failoverSafe: false,
    providerBinding: { providerSessionId: 'real-chrome', windowId: '8', tabId: '508' } });
  expect(created).toBe(1);
  expect(snapshots).toBeGreaterThanOrEqual(8);
});

test('Chrome extension worker marks ambiguous bootstrap tabCreate outcomes as unsafe to fail over', async () => {
  const worker = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  // Evaluate the genuine worker implementation up to its startup listeners,
  // avoiding any timers, Chrome connections, or external browser side effects.
  const runtimeCode = worker.slice(0, worker.indexOf('chrome.runtime.onMessage.addListener('))
    .replace("importScripts('core.js');", '') + '\nglobalThis.testExecuteEnsure = executeEnsure;';
  let physicalTabsCreated = 0;
  const runtime: { lastError: { message: string } | null } = { lastError: null };
  const sandbox = {
    ForgeComputerChatgptCore: { projectId: () => undefined },
    navigator: { userAgent: 'Chrome' },
    crypto: { randomUUID: () => 'test-instance' },
    chrome: {
      runtime,
      tabs: {
        query: async () => [],
        create: (_options: unknown, callback: (tab: { id: number; windowId: number }) => void) => {
          // Browser created a physical tab but its callback transport reported
          // failure. This must NOT be classified as proof of no tab mutation.
          physicalTabsCreated += 1;
          runtime.lastError = { message: 'BROWSER_TAB_CREATE_RESPONSE_LOST' };
          callback({ id: 1000, windowId: 21 });
        },
      },
    },
    URL, Date, Map, Promise, setTimeout, clearTimeout,
  };
  const vmContext = runInNewContext(runtimeCode, sandbox) as unknown;
  void vmContext;
  const runEnsure = (sandbox as typeof sandbox & {
    testExecuteEnsure: (command: unknown, instanceId: string) => Promise<Record<string, unknown>>
  }).testExecuteEnsure;
  const result = await runEnsure({
    kind: 'ensure',
    identity: { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:unique', projectUrl: 'https://chatgpt.com/g/g-p-abc/project' },
  }, 'test-profile');
  expect(physicalTabsCreated).toBe(1);
  expect(result).toMatchObject({ kind: 'failed', code: 'BROWSER_TAB_CREATE_RESPONSE_LOST', failoverSafe: false });
});

test('restarted worker prepares and dispatches only the Controller-pinned bootstrap tab', async () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  const worker = source.slice(0, source.indexOf('chrome.runtime.onMessage.addListener('))
    .replace("importScripts('core.js');", '') +
    '\nglobalThis.testPrepare = executePrepare; globalThis.testDispatch = executeDispatch;';
  const projectUrl = 'https://chatgpt.com/g/g-p-abc-project/project';
  const tabUrl = projectUrl;
  const messages: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  let oldContentScript = false;
  const tabs = [
    { id: 41, windowId: 8, url: tabUrl },
    // Moving the pinned tab to another window preserves its physical tab id.
    { id: 42, windowId: 9, url: tabUrl },
  ];
  const ownerStorage = new Map([['forgeComputerOwnedTabV1:42', 'verified-worker-tab']]);
  const sandbox = {
    ForgeComputerChatgptCore: {
      projectId: (value: string) => /^\/g\/(g-p-[a-z0-9]+)/i.exec(new URL(value).pathname)?.[1] ?? null,
    },
    crypto: { randomUUID: () => 'worker-test' },
    navigator: { userAgent: 'Chrome' },
    chrome: {
      storage: { session: { async get(k: string) {
        return ownerStorage.has(k) ? { [k]: ownerStorage.get(k) } : {};
      } } },
      runtime: { lastError: null },
      tabs: {
        query: async () => tabs,
        sendMessage: (tabId: number, message: Record<string, unknown>, callback: (value: unknown) => void) => {
          messages.push({ tabId, message });
          callback(message.type === 'forge-computer-chatgpt-capabilities'
            ? oldContentScript ? {}
              : { bootstrapTargetGuard: 'project-checked-before-send-v1' }
            : message.type === 'forge-computer-chatgpt-prepare'
              ? { prepared: true } : { dispatched: false, reason: 'test_no_send' });
        },
      },
    },
    URL, Date, Map, Promise, setTimeout, clearTimeout,
  };
  runInNewContext(worker, sandbox);
  const funcs = sandbox as typeof sandbox & {
    testPrepare: (cmd: unknown, instanceId: string) => Promise<Record<string, unknown>>;
    testDispatch: (cmd: unknown, instanceId: string) => Promise<Record<string, unknown>>;
  };
  const command = {
    identity: { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:saved', projectUrl },
    providerBinding: { providerId: 'browser.chrome-extension', providerSessionId: 'previous-worker',
      browserProduct: 'chrome', windowId: '8', tabId: '42', ownerToken: 'verified-worker-tab' },
    prompt: '@forge <<<FORGE_WORKFLOW_EFFECT_V1:fx_test>>> body',
  };
  expect(await funcs.testPrepare(command, 'previous-worker')).toMatchObject({ kind: 'prepared', ready: true });
  expect(await funcs.testDispatch(command, 'previous-worker')).toMatchObject({ kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'test_no_send' });
  expect(messages).toHaveLength(4);
  expect(messages.map(x => x.tabId)).toEqual([42, 42, 42, 42]);
  expect(messages.map(x => x.message.expectedProjectId)).toEqual([undefined, 'g-p-abc', undefined, 'g-p-abc']);
  expect(messages.map(x => x.message.type)).toEqual([
    'forge-computer-chatgpt-capabilities', 'forge-computer-chatgpt-prepare',
    'forge-computer-chatgpt-capabilities', 'forge-computer-chatgpt-dispatch',
  ]);
  // After worker upgrade, a tab can still run old content code. The worker
  // must reject both preparation and submission before reaching its Send path.
  oldContentScript = true;
  messages.length = 0;
  expect(await funcs.testPrepare(command, 'previous-worker')).toMatchObject({ kind: 'prepared', ready: false,
    reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' });
  expect(await funcs.testDispatch(command, 'previous-worker')).toMatchObject({ kind: 'dispatch', mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' });
  expect(messages.map(x => x.message.type)).toEqual([
    'forge-computer-chatgpt-capabilities', 'forge-computer-chatgpt-capabilities',
  ]);
  expect(messages.map(x => x.tabId)).toEqual([42, 42]);
});

test('content snapshot reports only live provider status, not quoted historical status markup', () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/content.js', import.meta.url), 'utf8');
  const capacityText = "You've reached the maximum length for this conversation.";
  const historyStatus = {
    innerText: capacityText, textContent: capacityText,
    getClientRects: () => [{}],
    closest: (selector: string) => selector.includes('conversation-turn-') ? {} : null,
  };
  let statuses: Array<typeof historyStatus> = [historyStatus];
  let unrelatedLayoutReads = 0;
  const unrelatedBannerCandidate = {
    innerText: 'ordinary conversation chrome', textContent: 'ordinary conversation chrome',
    getClientRects: () => { unrelatedLayoutReads += 1; return [{}]; },
    closest: () => null,
  };
  const emptyNodes = Object.assign([], { item: () => undefined });
  const main = {
    getClientRects: () => [{}],
    querySelectorAll: (selector: string) => selector === 'p, span, div'
      ? [unrelatedBannerCandidate] : emptyNodes,
  };
  const listeners: Array<(message: unknown, sender: unknown, respond: (value: Record<string, unknown>) => void) => void> = [];
  const scope = {
    ForgeComputerChatgptCore: {
      normalizeText: (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim(),
      parseConversation: () => null,
    },
    document: {
      title: 'Conversation',
      documentElement: {},
      querySelectorAll: (selector: string) => selector === 'main'
        ? [main]
        : selector.includes('[role="alert"]') ? statuses : [],
    },
    location: { href: 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc' },
    chrome: { runtime: {
      onMessage: { addListener: (listener: typeof listeners[number]) => { listeners.push(listener); } },
      sendMessage: () => undefined,
    } },
    MutationObserver: class { observe() {} },
    setTimeout: () => 1, clearTimeout: () => {},
    URL,
  };
  runChromeContentScript(source, scope);
  const snapshot = () => {
    let result: Record<string, unknown> | undefined;
    listeners[0]!({ type: 'forge-computer-chatgpt-snapshot' }, {}, (value) => { result = value; });
    return result!;
  };
  expect(snapshot().providerFailureText).toBe('');
  expect(unrelatedLayoutReads).toBe(0);
  statuses = [historyStatus, { ...historyStatus, closest: () => null }];
  expect(snapshot().providerFailureText).toBe(capacityText);
  expect(unrelatedLayoutReads).toBe(0);
});

test('read-only ChatGPT generation status ignores a historical user turn while send admission stays conservative', async () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/content.js', import.meta.url), 'utf8');
  const nodeList = <T>(items: T[]) => Object.assign(items, { item: (index: number) => items[index] });
  const userTurn = {
    innerText: 'Previously submitted user message', textContent: 'Previously submitted user message',
    getAttribute: (key: string) => key === 'data-message-author-role' ? 'user' : null,
    querySelector: () => null, getClientRects: () => [{}],
  };
  let liveStopVisible = false;
  const main = {
    getClientRects: () => [{}],
    querySelectorAll: (selector: string) => selector.includes('[data-message-author-role="user"]')
      ? nodeList([userTurn]) : nodeList([]),
  };
  const listeners: Array<(message: unknown, sender: unknown, respond: (value: Record<string, unknown>) => void) => void> = [];
  const scope = {
    ForgeComputerChatgptCore: {
      normalizeText: (value: unknown) => String(value ?? '').replace(/\\s+/g, ' ').trim(),
      parseConversation: () => null,
    },
    document: {
      title: 'Conversation', documentElement: {},
      querySelectorAll: (selector: string) => selector === 'main' ? [main]
        : selector.includes('stop-button') || selector.includes('[data-is-streaming="true"]')
          ? (liveStopVisible ? [{ getClientRects: () => [{}] }] : []) : [],
    },
    location: { href: 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc' },
    chrome: { runtime: {
      onMessage: { addListener: (listener: typeof listeners[number]) => { listeners.push(listener); } },
      sendMessage: () => undefined,
    } },
    MutationObserver: class { observe() {} },
    setTimeout: () => 1, clearTimeout: () => {}, URL,
  };
  runChromeContentScript(source, scope);
  const snapshot = () => {
    let result: Record<string, unknown> | undefined;
    listeners[0]!({ type: 'forge-computer-chatgpt-snapshot' }, {}, (value) => { result = value; });
    return result!;
  };
  expect(snapshot()).toMatchObject({ latestTurnRole: 'user', isGenerating: false });
  liveStopVisible = true;
  expect(snapshot()).toMatchObject({ latestTurnRole: 'user', isGenerating: true });
  liveStopVisible = false;
  let prepare: Record<string, unknown> | undefined;
  listeners[0]!({ type: 'forge-computer-chatgpt-prepare', mode: 'send', prompt: 'probe' }, {}, (value) => { prepare = value; });
  await Promise.resolve();
  expect(prepare).toMatchObject({ prepared: false, reason: 'provider_busy' });
});


test('MV3 fallback alarm uses the measured three-second cadence and wakes the existing claim pump', () => {
  const source = readFileSync(new URL('../../adapters/computer/chatgpt-provider-extension/background.js', import.meta.url), 'utf8');
  const target = readFileSync(new URL('../../adapters/computer/chatgpt-target-provider.ts', import.meta.url), 'utf8');
  expect(source).toContain('const ALARM_PERIOD_MINUTES = 0.05;');
  const alarmRegistrations = [...source.matchAll(/chrome\.alarms\.create\(ALARM, \{ periodInMinutes: ([A-Z_]+) \}\)/g)];
  expect(alarmRegistrations).toHaveLength(3);
  expect(alarmRegistrations.every((match) => match[1] === 'ALARM_PERIOD_MINUTES')).toBe(true);
  expect(source).toContain("chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void providerTick().catch(() => undefined); });");
  expect(source).toContain("await nativeRpc('computer_extension_claim', { provider_instance_id: instanceId });");
  expect(source).toContain("await nativeRpc('computer_extension_complete', { provider_instance_id: instanceId, command_id: command.commandId, result });");
  expect(target).toContain('const COMMAND_TIMEOUT_MS = 12_000;');
});
