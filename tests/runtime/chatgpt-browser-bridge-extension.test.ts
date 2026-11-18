import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'node:vm';
import { writeChatgptBridgeExtension } from '../../src/cli/chatgpt-browser/bridge-extension';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function bridgeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'forge-chatgpt-bridge-extension-'));
  roots.push(root);
  const extension = writeChatgptBridgeExtension(root, 'http://127.0.0.1:17651', 'bridge-token');
  const script = readFileSync(extension.contentScriptPath, 'utf8');
  const started = deferred<void>();
  const startAck = deferred<{ ok: boolean }>();
  const result = deferred<Record<string, any>>();
  const dispatched = deferred<Record<string, any>>();
  const task = {
    id: 'task-1',
    kind: 'consult',
    prompt: 'Reply exactly OK',
    timeoutMs: 1_000,
    dispatchOnly: true,
  };
  let taskFetched = false;
  let clicks = 0;
  let submits = 0;
  let userMessages: Array<{ innerText: string; textContent: string }> = [];

  const button = {
    disabled: false,
    getClientRects: () => [{}],
    click: () => {
      clicks += 1;
      composer.textContent = '';
      userMessages = [{ innerText: task.prompt, textContent: task.prompt }];
    },
  };
  const form = {
    hasAttribute: () => false,
    querySelector: (_selector: string) => button,
    requestSubmit: () => { submits += 1; },
  };
  const composer = {
    textContent: '',
    closest: (_selector: string) => form,
    getClientRects: () => [{}],
    focus: () => undefined,
    dispatchEvent: () => true,
  };
  const document = {
    title: 'ChatGPT',
    querySelector: (selector: string) => {
      if (selector === 'form[data-logged-out]') return null;
      if (selector.includes('composer') || selector === '#prompt-textarea' || selector.includes('textarea') || selector.includes('textbox')) return composer;
      if (selector.includes('Stop')) return null;
      if (selector.includes('send') || selector.includes('Send') || selector.includes('发送')) return button;
      return null;
    },
    querySelectorAll: (selector: string) => selector === '[data-message-author-role="user"]' ? userMessages : [],
    execCommand: (command: string, _showUi: boolean, value: string) => {
      if (command === 'insertText') composer.textContent = value;
      return true;
    },
  };
  const fetch = async (input: string, init?: { body?: string }) => {
    const url = String(input);
    if (url.endsWith('/api/extension/heartbeat')) return { ok: true };
    if (url.includes('/api/extension/task?pageUrl=')) {
      if (taskFetched) return { ok: true, json: async () => ({}) };
      taskFetched = true;
      return { ok: true, json: async () => task };
    }
    if (url.endsWith('/api/extension/task-started')) {
      started.resolve();
      return startAck.promise;
    }
    if (url.endsWith('/api/extension/result')) {
      result.resolve(JSON.parse(init?.body ?? '{}'));
      return { ok: true };
    }
    if (url.endsWith('/api/extension/dispatched')) {
      dispatched.resolve(JSON.parse(init?.body ?? '{}'));
      return { ok: true };
    }
    return { ok: false, json: async () => ({}) };
  };

  runInNewContext(script, {
    document,
    location: { href: 'https://chatgpt.com/c/test-conversation' },
    URL,
    fetch,
    setInterval: () => 0,
    setTimeout,
  });

  return {
    started: started.promise,
    acknowledgeStart: startAck.resolve,
    result: result.promise,
    dispatched: dispatched.promise,
    composer,
    button,
    clicks: () => clicks,
    submits: () => submits,
  };
}

describe('ChatGPT Bridge composer dispatch guard', () => {
  test('rejects a draft changed while awaiting the task-started acknowledgement', async () => {
    const bridge = bridgeHarness();
    await bridge.started;
    bridge.composer.textContent = 'A user-edited draft';
    bridge.acknowledgeStart({ ok: true });

    const receipt = await bridge.result;
    expect(receipt.error?.code).toBe('CHATGPT_BRIDGE_COMPOSER_CHANGED');
    expect(bridge.clicks()).toBe(0);
    expect(bridge.submits()).toBe(0);
    expect(bridge.composer.textContent).toBe('A user-edited draft');
  });

  test('rejects a submit control disabled while awaiting the task-started acknowledgement', async () => {
    const bridge = bridgeHarness();
    await bridge.started;
    bridge.button.disabled = true;
    bridge.acknowledgeStart({ ok: true });

    const receipt = await bridge.result;
    expect(receipt.error?.code).toBe('CHATGPT_BRIDGE_COMPOSER_CHANGED');
    expect(bridge.clicks()).toBe(0);
    expect(bridge.submits()).toBe(0);
  });

  test('submits exactly once when the acknowledged composer and submit control remain unchanged', async () => {
    const bridge = bridgeHarness();
    await bridge.started;
    bridge.acknowledgeStart({ ok: true });

    const receipt = await bridge.dispatched;
    expect(receipt.taskId).toBe('task-1');
    expect(bridge.clicks()).toBe(1);
    expect(bridge.submits()).toBe(0);
  });
});
