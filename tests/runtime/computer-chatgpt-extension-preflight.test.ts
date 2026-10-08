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
