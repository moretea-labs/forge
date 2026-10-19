import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';


test('new bootstrap tab requires its hydrated editor, not a model picker, before preflight', async () => {
  const src = readFileSync(new URL('../../adapters/computer/chrome-extension/background.js', import.meta.url), 'utf8');
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
  const sandbox = {
    ForgeComputerChatgptCore: { projectId: () => 'g-p-abc', parseConversation: () => null },
    navigator: { userAgent: 'Chrome' },
    crypto: { randomUUID: () => 'model-ready-test' },
    chrome: {
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
    URL, Date, Map, Promise, setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1; },
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
  const src = readFileSync(new URL('../../adapters/computer/chrome-extension/background.js', import.meta.url), 'utf8');
  const worker = src.slice(0, src.indexOf('chrome.runtime.onMessage.addListener('))
    .replace("importScripts('core.js');", '')
    + '\nglobalThis.__testEnsureHydrated = executeEnsure;';
  const url = 'https://chatgpt.com/g/g-p-abc/project';
  const tab = { id: 508, windowId: 8, url };
  let created = 0;
  let snapshots = 0;
  const sandbox = {
    ForgeComputerChatgptCore: { projectId: () => 'g-p-abc', parseConversation: () => null },
    navigator: { userAgent: 'Chrome' }, crypto: { randomUUID: () => 'unready-test' },
    chrome: { runtime: { lastError: null }, tabs: {
      query: async () => [],
      create: (_options: unknown, callback: (t: typeof tab) => void) => { created++; callback(tab); },
      get: (_id: number, callback: (t: typeof tab) => void) => callback(tab),
      sendMessage: (_id: number, message: { type: string }, callback: (v: unknown) => void) => {
        if (message.type !== 'forge-computer-chatgpt-snapshot') throw new Error('Only snapshot allowed');
        snapshots++;callback({ url });
      },
    } },
    URL, Date, Map, Promise, setTimeout: (fn: () => void) => { queueMicrotask(fn); return 1; }, clearTimeout() {},
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
  const worker = readFileSync(new URL('../../adapters/computer/chrome-extension/background.js', import.meta.url), 'utf8');
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
  const source = readFileSync(new URL('../../adapters/computer/chrome-extension/background.js', import.meta.url), 'utf8');
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
  const sandbox = {
    ForgeComputerChatgptCore: {
      projectId: (value: string) => /^\/g\/(g-p-[a-z0-9]+)/i.exec(new URL(value).pathname)?.[1] ?? null,
    },
    crypto: { randomUUID: () => 'worker-test' },
    navigator: { userAgent: 'Chrome' },
    chrome: {
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
    testPrepare: (cmd: unknown) => Promise<Record<string, unknown>>;
    testDispatch: (cmd: unknown) => Promise<Record<string, unknown>>;
  };
  const command = {
    identity: { namespace: 'chatgpt.bootstrap', bootstrapKey: 'supervisor:saved', projectUrl },
    providerBinding: { providerId: 'browser.chrome-extension', providerSessionId: 'previous-worker',
      browserProduct: 'chrome', windowId: '8', tabId: '42' },
    prompt: '@forge <<<FORGE_WORKFLOW_EFFECT_V1:fx_test>>> body',
  };
  expect(await funcs.testPrepare(command)).toMatchObject({ kind: 'prepared', ready: true });
  expect(await funcs.testDispatch(command)).toMatchObject({ kind: 'dispatch', mutation: 'not_attempted', reasonCode: 'test_no_send' });
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
  expect(await funcs.testPrepare(command)).toMatchObject({ kind: 'prepared', ready: false,
    reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' });
  expect(await funcs.testDispatch(command)).toMatchObject({ kind: 'dispatch', mutation: 'not_attempted',
    reasonCode: 'COMPUTER_CHATGPT_BOOTSTRAP_PROJECT_GUARD_UNSUPPORTED' });
  expect(messages.map(x => x.message.type)).toEqual([
    'forge-computer-chatgpt-capabilities', 'forge-computer-chatgpt-capabilities',
  ]);
  expect(messages.map(x => x.tabId)).toEqual([42, 42]);
});
