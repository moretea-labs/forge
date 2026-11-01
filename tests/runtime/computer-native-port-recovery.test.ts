import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { forwardNativeRequest } from '../../supervisor/native-messaging/host';
import { workflowSupervisorSocketPath } from '../../supervisor/paths';

test('silent native port is retired without replaying pending commands', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('let nativePort;'), source.indexOf('function tabMessage('));
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let id = 0;
  let ticks = 0;
  const ports: Array<{ sent: Array<{ id: string; method: string }>; message?: (value: unknown) => void; disconnectListener?: () => void; disconnected: boolean }> = [];
  const chrome = { runtime: { lastError: undefined, connectNative() {
    const port = { sent: [] as Array<{ id: string; method: string }>, message: undefined as undefined | ((value: unknown) => void),
      disconnectListener: undefined as undefined | (() => void), disconnected: false };
    ports.push(port);
    return { onMessage: { addListener(fn: (value: unknown) => void) { port.message = fn; } },
      onDisconnect: { addListener(fn: () => void) { port.disconnectListener = fn; } },
      postMessage(message: { id: string; method: string }) { port.sent.push(message); },
      disconnect() { port.disconnected = true; port.disconnectListener?.(); } };
  } } };
  const context = { chrome, NATIVE_HOST: 'test', RPC_TIMEOUT_MS: 30_000, HEARTBEAT_RPC_TIMEOUT_MS: 6_000, randomId: () => String(++id),
    setTimeout(fn: () => void) { const key = ++timerId; timers.set(key, fn); return key; },
    clearTimeout(key: number) { timers.delete(key); }, providerTick: async () => { ticks++; } };
  const rpc = runInNewContext(`${code}\nnativeRpc`, context) as (method: string) => Promise<unknown>;
  const heartbeat = rpc('computer_extension_heartbeat').catch((error: Error) => error.message);
  const completion = rpc('computer_extension_complete').catch((error: Error) => error.message);
  timers.get(1)?.();
  expect(await heartbeat).toContain('TIMEOUT');
  // A heartbeat timeout must not tear down an unrelated in-flight command RPC.
  expect(ports[0].disconnected).toBe(false);
  timers.get(2)?.();
  expect(await completion).toContain('TIMEOUT');
  expect(ports[0].disconnected).toBe(true);
  expect(ports[0].sent.map((message) => message.method)).toEqual(['computer_extension_heartbeat', 'computer_extension_complete']);

  const next = rpc('computer_extension_heartbeat');
  expect(ports).toHaveLength(2);
  ports[0].message?.({ id: ports[1].sent[0].id, ok: true, result: { stale: true } });
  ports[0].disconnectListener?.();
  ports[1].message?.({ id: ports[1].sent[0].id, ok: true, result: { fresh: true } });
  expect(await next).toEqual({ fresh: true });
  expect(ports[1].sent.map((message) => message.method)).toEqual(['computer_extension_heartbeat']);
  for (const callback of timers.values()) callback();
  expect(ticks).toBe(1);
});

test('heartbeat RPC has a sub-TTL deadline and cannot cancel an independent completion RPC', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('let nativePort;'), source.indexOf('function tabMessage('));
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const ports: Array<{ sent: Array<{ id: string; method: string }>; message?: (value: unknown) => void; disconnected: boolean }> = [];
  let timerId = 0;
  let requestId = 0;
  const chrome = { runtime: { lastError: undefined, connectNative() {
    const port = { sent: [] as Array<{ id: string; method: string }>, message: undefined as ((value: unknown) => void) | undefined, disconnected: false };
    ports.push(port);
    return {
      postMessage(message: { id: string; method: string }) { port.sent.push(message); },
      onMessage: { addListener(listener: (value: unknown) => void) { port.message = listener; } },
      onDisconnect: { addListener() {} },
      disconnect() { port.disconnected = true; },
    };
  } } };
  const context = {
    chrome, NATIVE_HOST: 'test', RPC_TIMEOUT_MS: 30_000, HEARTBEAT_RPC_TIMEOUT_MS: 6_000,
    randomId: () => String(++requestId),
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    providerTick: async () => undefined,
  };
  const rpc = runInNewContext(code + '\nnativeRpc', context) as (method: string) => Promise<unknown>;
  const heartbeat = rpc('computer_extension_heartbeat').catch((error: Error) => error.message);
  const completion = rpc('computer_extension_complete');
  expect([...timers.values()].map(timer => timer.delay)).toEqual([6_000, 30_000]);
  expect(ports[0]?.sent.map(message => message.method)).toEqual(['computer_extension_heartbeat', 'computer_extension_complete']);
  timers.get(1)?.callback();
  expect(await heartbeat).toContain('TIMEOUT');
  expect(ports[0]?.disconnected).toBe(false);
  ports[0]?.message?.({ id: ports[0]?.sent[1]?.id, ok: true, result: { recorded: true } });
  expect(await completion).toEqual({ recorded: true });
  expect(ports[0]?.disconnected).toBe(false);
  expect(ports).toHaveLength(1);
});

test('Chrome tabs query timeout retires a permanently hung read and allows recovery', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('function boundedTabsQuery('), source.indexOf('// Controller binding owns the durable source identity.'));
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  let queryCalls = 0;
  const chrome = { tabs: { query: () => {
    queryCalls += 1;
    if (queryCalls === 1) return new Promise<unknown[]>(() => {});
    return Promise.resolve([]);
  } } };
  const context = {
    chrome, TABS_QUERY_TIMEOUT_MS: 5_000, tabsQueryInFlight: new Map<string, Promise<unknown[]>>(),
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const chatgptTabs = runInNewContext(code + '\nchatgptTabs', context) as () => Promise<unknown[]>;
  const first = chatgptTabs().catch((error: Error) => error.message);
  await Promise.resolve();
  expect(queryCalls).toBe(1);
  expect([...timers.values()].map(timer => timer.delay)).toEqual([5_000]);
  timers.get(1)?.callback();
  expect(await first).toBe('COMPUTER_CHATGPT_EXTENSION_TABS_QUERY_TIMEOUT');

  // The first browser query never settles; a later read must recover.
  expect(await chatgptTabs()).toEqual([]);
  expect(queryCalls).toBe(2);

});

test('provider identity storage timeout releases its cache and retries with the same candidate', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('let providerInstancePromise;'), source.indexOf('const sleep ='));
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  let randomIdCalls = 0;
  let allowSet = false;
  let resolveFirstGet: ((value: Record<string, string>) => void) | undefined;
  let resolveGetStarted: (() => void) | undefined;
  let resolveWriteStarted: (() => void) | undefined;
  let resolveFirstSet: (() => void) | undefined;
  const getStarted = new Promise<void>((resolve) => { resolveGetStarted = resolve; });
  const writeStarted = new Promise<void>((resolve) => { resolveWriteStarted = resolve; });
  const writes: Array<Record<string, string>> = [];
  const chrome = { storage: { local: {
    get: () => {
      if (allowSet) return Promise.resolve({});
      resolveGetStarted?.();
      return new Promise<Record<string, string>>((resolve) => { resolveFirstGet = resolve; });
    },
    set: (value: Record<string, string>) => {
      writes.push(value);
      if (allowSet) return Promise.resolve();
      resolveWriteStarted?.();
      return new Promise<void>((resolve) => { resolveFirstSet = resolve; });
    },
  } } };
  const context = {
    chrome, HEARTBEAT_DEADLINE_MS: 10_000, randomId: () => `profile-${++randomIdCalls}`, Date: { now: () => 1_000 },
    setTimeout(callback: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { callback: () => { timers.delete(id); callback(); }, delay });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const providerInstanceId = runInNewContext(code + '\nproviderInstanceId', context) as (deadlineAt: number) => Promise<string>;
  const first = providerInstanceId(11_000).catch((error: Error) => error.message);
  await getStarted;
  resolveFirstGet?.({});
  await writeStarted;
  expect(writes).toEqual([{ forgeComputerProviderInstanceId: 'profile-1' }]);
  expect([...timers.values()].map(timer => timer.delay)).toEqual([10_000]);
  [...timers.values()][0]!.callback();
  expect(await first).toBe('COMPUTER_CHATGPT_EXTENSION_PROVIDER_ID_TIMEOUT');
  allowSet = true;
  expect(await providerInstanceId(11_000)).toBe('profile-1');
  expect(randomIdCalls).toBe(1);
  expect(writes).toEqual([
    { forgeComputerProviderInstanceId: 'profile-1' },
    { forgeComputerProviderInstanceId: 'profile-1' },
  ]);
  resolveFirstSet?.();
});

test('publishHeartbeat carries one absolute deadline through identity, parallel tab queries and Native RPC', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('async function publishHeartbeat()'), source.indexOf('let providerTickInFlight;'));
  const conversationId = '67676767-7878-9090-1212-343434343435';
  const tab = { id: 17, windowId: 4, url: `https://chatgpt.com/c/${conversationId}`, title: 'deadline' };
  let nowMs = 1_000_000;
  const deadlines: number[] = [];
  let rpcMethod = '';
  let rpcTimeout = 0;
  let rpcPayload: Record<string, unknown> | undefined;
  let recorded = true;
  const FakeDate = class extends Date { static now() { return nowMs; } };
  const context = {
    Date: FakeDate, HEARTBEAT_DEADLINE_MS: 10_000, HEARTBEAT_RPC_TIMEOUT_MS: 6_000, PROVIDER_ID: 'browser.chrome-extension',
    providerInstanceId: async (deadlineAt: number) => { deadlines.push(deadlineAt); nowMs += 2_000; return 'profile-one'; },
    chatgptTabs: async (deadlineAt: number) => { deadlines.push(deadlineAt); nowMs += 2_000; return [tab]; },
    boundedTabsQuery: async (_query: unknown, deadlineAt: number) => { deadlines.push(deadlineAt); nowMs += 1_000; return [tab]; },
    core: { parseConversation: (url: string) => ({ conversationId, canonicalUrl: url }) },
    browserProduct: () => 'chrome',
    binding: (value: typeof tab, instanceId: string) => ({ providerId: 'browser.chrome-extension', providerSessionId: instanceId,
      tabId: String(value.id), windowId: String(value.windowId), ownerToken: 'owner-one' }),
    nativeRpc: async (method: string, params: Record<string, unknown>, timeoutMs: number) => {
      rpcMethod = method; rpcPayload = params; rpcTimeout = timeoutMs; return { recorded };
    },
  };
  const publishHeartbeat = runInNewContext(code + '\npublishHeartbeat', context) as () => Promise<string>;
  expect(await publishHeartbeat()).toBe('profile-one');
  expect(deadlines).toEqual([1_010_000, 1_010_000, 1_010_000]);
  expect(rpcMethod).toBe('computer_extension_heartbeat');
  expect(rpcTimeout).toBe(5_000);
  expect(rpcPayload?.providerInstanceId).toBe('profile-one');
  expect((rpcPayload?.conversations as Array<Record<string, unknown>>)[0]).toMatchObject({
    conversationId, canonicalUrl: tab.url, isCurrent: true,
  });
  recorded = false;
  const rejected = await publishHeartbeat().then(() => undefined, (error: Error) => error.message);
  expect(rejected).toBe('COMPUTER_CHATGPT_EXTENSION_HEARTBEAT_NOT_RECORDED');
});

test('provider tick shares one heartbeat, claims only after success, and retries after heartbeat timeout', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('let providerTickInFlight;'), source.indexOf('async function discoveryScan('));
  let heartbeatCalls = 0;
  let resolveHeartbeat: ((value: string) => void) | undefined;
  let rejectHeartbeat: ((error: Error) => void) | undefined;
  const rpcCalls: string[] = [];
  const context = {
    publishHeartbeat: () => {
      heartbeatCalls += 1;
      return new Promise<string>((resolve, reject) => { resolveHeartbeat = resolve; rejectHeartbeat = reject; });
    },
    flushProviderTurnEvents: async () => undefined,
    nativeRpc: async (method: string) => { rpcCalls.push(method); return { command: undefined }; },
    executeCommand: async () => { throw new Error('no command expected'); },
  };
  const providerTick = runInNewContext(code + '\nproviderTick', context) as () => Promise<void>;
  const first = providerTick();
  const concurrent = providerTick();
  expect(heartbeatCalls).toBe(1);
  expect(rpcCalls).toEqual([]);
  resolveHeartbeat?.('profile-one');
  await Promise.all([first, concurrent]);
  expect(rpcCalls).toEqual(['computer_extension_claim']);

  const failed = providerTick().catch((error: Error) => error.message);
  expect(heartbeatCalls).toBe(2);
  rejectHeartbeat?.(new Error('heartbeat deadline'));
  expect(await failed).toBe('heartbeat deadline');
  expect(rpcCalls).toEqual(['computer_extension_claim']);

  const retry = providerTick();
  expect(heartbeatCalls).toBe(3);
  resolveHeartbeat?.('profile-one');
  await retry;
  expect(rpcCalls).toEqual(['computer_extension_claim', 'computer_extension_claim']);
});

test('late Broker completion refusal is surfaced without replaying the claimed command', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('let providerTickInFlight;'), source.indexOf('async function discoveryScan('));
  const rpcCalls: string[] = [];
  const warnings: unknown[][] = [];
  let executeCalls = 0;
  const command = { commandId: 'late-command-1', kind: 'dispatch',
    identity: { conversationId: '78787878-8989-0101-2323-454545454546' } };
  const context = {
    publishHeartbeat: async () => 'profile-one',
    flushProviderTurnEvents: async () => undefined,
    nativeRpc: async (method: string) => {
      rpcCalls.push(method);
      if (method === 'computer_extension_claim') return { command };
      return { recorded: false };
    },
    executeCommand: async () => { executeCalls += 1; return { kind: 'dispatch', mutation: 'attempted' }; },
    console: { warn: (...args: unknown[]) => { warnings.push(args); } },
  };
  const providerTick = runInNewContext(code + '\nproviderTick', context) as () => Promise<void>;
  await providerTick();
  expect(rpcCalls).toEqual(['computer_extension_claim', 'computer_extension_complete']);
  expect(executeCalls).toBe(1);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.[0]).toBe('COMPUTER_CHATGPT_EXTENSION_COMMAND_COMPLETION_NOT_RECORDED');
  expect(warnings[0]?.[1]).toMatchObject({ commandId: 'late-command-1', kind: 'dispatch',
    conversationId: command.identity.conversationId });
});

test('native host gives heartbeat a local deadline below the Broker freshness TTL', async () => {
  const forgeHome = mkdtempSync(join(tmpdir(), 'forge-native-heartbeat-timeout-'));
  const socketPath = workflowSupervisorSocketPath(forgeHome);
  mkdirSync(dirname(socketPath), { recursive: true });
  let acceptedSocket: Socket | undefined;
  const server = createServer((socket) => {
    acceptedSocket = socket;
    socket.on('data', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const startedAt = Date.now();
  try {
    const response = await forwardNativeRequest({ id: 'heartbeat-timeout', method: 'computer_extension_heartbeat', params: {} }, forgeHome);
    expect(response).toMatchObject({ id: 'heartbeat-timeout', ok: false });
    expect(JSON.stringify(response)).toContain('4000ms');
    expect(Date.now() - startedAt).toBeLessThan(6_000);
  } finally {
    acceptedSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(forgeHome, { recursive: true, force: true });
  }
});

test('postMessage failure invalidates the port and the next call reconnects', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('let nativePort;'), source.indexOf('function tabMessage('));
  let connections = 0;
  let disconnected = 0;
  let receive: ((value: unknown) => void) | undefined;
  let sentId = '';
  const chrome = { runtime: { lastError: undefined, connectNative() {
    const number = ++connections;
    return { onMessage: { addListener(fn: (value: unknown) => void) { receive = fn; } },
      onDisconnect: { addListener() {} }, disconnect() { disconnected++; },
      postMessage(message: { id: string }) { if (number === 1) throw new Error('port closed'); sentId = message.id; } };
  } } };
  let id = 0;
  const context = { chrome, NATIVE_HOST: 'test', RPC_TIMEOUT_MS: 30_000, HEARTBEAT_RPC_TIMEOUT_MS: 6_000, randomId: () => String(++id),
    setTimeout: () => 1, clearTimeout() {}, providerTick: async () => {} };
  const rpc = runInNewContext(`${code}\nnativeRpc`, context) as (method: string) => Promise<unknown>;
  expect(await rpc('computer_extension_claim').catch((error: Error) => error.message)).toBe('port closed');
  expect(disconnected).toBe(1);
  const next = rpc('computer_extension_heartbeat');
  expect(connections).toBe(2);
  receive?.({ id: sentId, ok: true, result: { connected: true } });
  expect(await next).toEqual({ connected: true });
});

test('a timed-out completion schedules a new heartbeat rather than replaying the claimed command', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('let nativePort;'), source.indexOf('function tabMessage('));
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let nextId = 0;
  let heartbeatTicks = 0;
  const ports: Array<{
    sent: Array<{ id: string; method: string }>;
    disconnected: boolean;
    onMessage?: (response: { id: string; ok: boolean; result: object }) => void;
  }> = [];
  const chrome = { runtime: { lastError: undefined, connectNative() {
    const p: (typeof ports)[number] = { sent: [], disconnected: false };
    ports.push(p);
    return {
      onMessage: { addListener(fn: typeof p.onMessage) { p.onMessage = fn; } },
      onDisconnect: { addListener() {} },
      postMessage(message: { id: string; method: string }) { p.sent.push(message); },
      disconnect() { p.disconnected = true; },
    };
  } } };
  let rpc: (method: string) => Promise<unknown>;
  const context = {
    chrome, NATIVE_HOST: 'test', RPC_TIMEOUT_MS: 30_000, HEARTBEAT_RPC_TIMEOUT_MS: 6_000, randomId: () => String(++nextId),
    setTimeout(fn: () => void) { const n = ++nextTimer; timers.set(n, fn); return n; },
    clearTimeout(n: number) { timers.delete(n); },
    providerTick: async () => {
      const heartbeat = rpc('computer_extension_heartbeat');
      const p = ports[ports.length - 1];
      const message = p.sent[0];
      p.onMessage?.({ id: message.id, ok: true, result: { fresh: true } });
      await heartbeat;
      heartbeatTicks++;
    },
  };
  rpc = runInNewContext(code + '\nnativeRpc', context) as typeof rpc;
  const completion = rpc('computer_extension_complete').catch((error: Error) => error.message);
  const expire = timers.get(1);
  expect(expire).toBeDefined();
  timers.delete(1);
  expire?.();
  expect(await completion).toContain('TIMEOUT');
  expect(ports[0].disconnected).toBe(true);

  // The recovery tick is transport-only: it must not repeat the old completion.
  const retry = timers.get(2);
  expect(retry).toBeDefined();
  retry?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(heartbeatTicks).toBe(1);
  expect(ports).toHaveLength(2);
  expect(ports[0].sent.map((entry) => entry.method)).toEqual(['computer_extension_complete']);
  expect(ports[1].sent.map((entry) => entry.method)).toEqual(['computer_extension_heartbeat']);
});


test('MAIN-world observer emits only a wake-up hint even for a finished SSE or HTTP 429', async () => {
  const manifest = JSON.parse(readFileSync('adapters/computer/chrome-extension/manifest.json', 'utf8')) as {
    permissions: string[]; content_scripts: Array<{ world?: string; js: string[]; run_at?: string }>;
  };
  expect(manifest.permissions).not.toContain('webRequest');
  expect(manifest.content_scripts.some((s) => s.world === 'MAIN' && s.run_at === 'document_start'
    && s.js.includes('provider-turn-main.js'))).toBe(true);
  const source = readFileSync('adapters/computer/chrome-extension/provider-turn-main.js', 'utf8');
  const bridge = readFileSync('adapters/computer/chrome-extension/provider-turn-readback.js', 'utf8');
  expect(manifest.content_scripts.some((script) => script.world !== 'MAIN'
    && script.js.includes('provider-turn-readback.js'))).toBe(true);
  const background = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  expect(bridge).toContain("'forge-computer-provider-turn-v1'");
  expect(background).toContain("req");
  expect(background).toContain("'computer_extension_turn_event'");
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const url = 'https://chatgpt.com/c/' + conversationId;
  const events: Array<{ event: Record<string, unknown> }> = [];
  let statusCode = 200;
  let sse = '';
  const windowMock = {
    postMessage(data: { event: Record<string, unknown> }) { events.push(data); },
    fetch: async (_input: unknown, _init: unknown) => ({
      status: statusCode,
      headers: { get(name: string) {
        if (name === 'content-type') return statusCode === 200 ? 'text/event-stream' : 'application/json';
        if (name === 'retry-after') return '45';
        return null;
      } },
      clone() {
        let read = false;
        return { body: { getReader() { return { async read() {
          if (read) return { done: true };
          read = true;
          return { done: false, value: new TextEncoder().encode(sse) };
        }, async cancel() {} }; } } };
      },
    }),
  };
  runInNewContext(source, {
    window: windowMock,
    location: { href: url, origin: 'https://chatgpt.com' },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    URL, Request, Blob, URLSearchParams, TextDecoder, TextEncoder, Uint8Array,
  });
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:fx_0123456789abcdef0123456789abcdef>>>' +
    '\ntask_id:"supervisor:test"\nreceipt:abc1234\nprovider_turn:sse-final-v1\nContinue.';
  const body = JSON.stringify({ conversation_id: conversationId,
    messages: [{ id: 'turn-user-1', author: { role: 'user' }, content: { parts: [prompt] } }] });
  async function send() {
    await windowMock.fetch('https://chatgpt.com/backend-api/conversation', { method: 'POST', body });
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    const last = events.pop()?.event;
    expect(last).toBeDefined();
    return last!;
  }
  sse = 'data: ' + JSON.stringify({ message: { id: 'assistant-1', author: { role: 'assistant' },
    status: 'finished_successfully', end_turn: true } }) + '\n\n' + 'data: [DONE]\n\n';
  expect(await send()).toMatchObject({ task_id: 'supervisor:test', turn_id: 'turn-user-1',
    effect_id: 'fx_0123456789abcdef0123456789abcdef', conversation_id: conversationId,
    outcome: 'unknown', status_code: 200 });
  expect(source).not.toContain('function processPayload(');
  sse = 'data: ' + JSON.stringify({ message: { id: 'assistant-2', author: { role: 'assistant' },
    status: 'finished_successfully', end_turn: true } }) + '\n\n';
  expect(await send()).toMatchObject({ outcome: 'unknown', status_code: 200 });
  statusCode = 429;
  expect(await send()).toMatchObject({ outcome: 'unknown', status_code: 429 });
  expect(JSON.stringify(events)).not.toContain('assistant-1');
});

test('isolated conversation readback proves an exact persisted user and final assistant', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/provider-turn-readback.js', 'utf8');
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const effectId = 'fx_0123456789abcdef0123456789abcdef';
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:' + effectId + '>>>'
    + '\ntask_id:"supervisor:test"\nreceipt:abc1234\nprovider_turn:sse-final-v1\nContinue.';
  const hint = {
    task_id: 'supervisor:test', effect_id: effectId, receipt_challenge: 'abc1234',
    turn_id: 'user-turn-1', request_id: '00000000-0000-4000-8000-000000000001',
    started_at_ms: 1793490000000, conversation_id: conversationId,
    outcome: 'completed', status_code: 200, content_type: 'text/event-stream',
    assistant_message_id: 'attacker-supplied-id', assistant_status: 'finished_successfully',
    assistant_end_turn: true, stream_done: true,
  };
  const messages = [
    { id: 'user-turn-1', author: { role: 'user' }, content: { parts: [prompt] } },
    { id: 'assistant-from-server', author: { role: 'assistant' },
      status: 'finished_successfully', end_turn: true, recipient: 'all' },
  ];
  const conversation = {
    conversation_id: conversationId,
    current_node: 'node-assistant',
    messages,
    page_info: { has_previous_page: false, has_next_page: false },
  };
  const outbound: Array<{ event: Record<string, unknown> }> = [];
  const calls: string[] = [];
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const windowMock = { addEventListener(_name: string, callback: (event: Record<string, unknown>) => void) { listener = callback; } };
  let sessionStatus = 200;
  const response = (body: unknown, status = 200) => ({
    ok: status === 200, status,
    headers: { get(name: string) { return name === 'content-type' ? 'application/json' : null; } },
    async json() { return body; }, async text() { return JSON.stringify(body); },
  });
  runInNewContext(source, {
    window: windowMock, location: { pathname: '/g/g-p-forge/c/' + conversationId, origin: 'https://chatgpt.com' },
    chrome: { runtime: { async sendMessage(message: { event: Record<string, unknown> }) { outbound.push(message); } } },
    fetch: async (url: string) => {
      calls.push(url);
      if (url === '/api/auth/session') return response({ accessToken: 'secret-not-to-forward' }, sessionStatus);
      return response(conversation);
    },
    Number, JSON, Set,
  });
  const send = async (input: Record<string, unknown>) => {
    listener?.({ source: windowMock, origin: 'https://chatgpt.com',
      data: { source: 'forge-computer-provider-turn-v1', type: 'turn-event', event: input } });
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  // Even a parser-level unknown hint can prompt a server-verified readback.
  await send({ ...hint, outcome: 'unknown', status_code: 0, stream_done: false });
  expect(outbound).toHaveLength(1);
  expect(outbound[0].event).toMatchObject({
    assistant_message_id: 'assistant-from-server', proof_source: 'chatgpt-conversation-readback-v1',
    status_code: 200, content_type: 'application/json', outcome: 'completed', assistant_end_turn: true,
  });
  expect(JSON.stringify(outbound)).not.toContain('secret-not-to-forward');
  expect(calls).toEqual(['/api/auth/session',
    '/backend-api/conversations/' + conversationId + '?include_has_versions=true&num_turns=100']);
  messages[1].status = 'in_progress';
  await send({ ...hint, request_id: '00000000-0000-4000-8000-000000000002' });
  expect(outbound).toHaveLength(1);
  // A stale complete assistant cannot authorize the wrong latest user Turn.
  messages.push({ id: 'next-user', author: { role: 'user' }, content: { parts: ['new request'] } });
  await send({ ...hint, request_id: '00000000-0000-4000-8000-000000000005' });
  expect(outbound).toHaveLength(1);
  messages.pop();
  messages[1].status = 'finished_successfully';
  messages[0].id = 'different-user';
  await send({ ...hint, request_id: '00000000-0000-4000-8000-000000000003' });
  expect(outbound).toHaveLength(1);
  messages[0].id = 'user-turn-1';
  conversation.page_info.has_next_page = true;
  await send({ ...hint, request_id: '00000000-0000-4000-8000-000000000006' });
  expect(outbound).toHaveLength(1);
  conversation.page_info.has_next_page = false;
  await send({ ...hint, conversation_id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' });
  expect(outbound).toHaveLength(1);
  sessionStatus = 403;
  await send({ ...hint, request_id: '00000000-0000-4000-8000-000000000004' });
  expect(outbound).toHaveLength(1);
  await send({ ...hint, outcome: 'failed', status_code: 429 });
  expect(outbound).toHaveLength(1);
});

test('isolated readback retries only its GET after a lagging final status, never replays Send', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/provider-turn-readback.js', 'utf8');
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const effectId = 'fx_0123456789abcdef0123456789abcdef';
  const prompt = '<<<FORGE_WORKFLOW_EFFECT_V1:' + effectId + '>>>'
    + '\ntask_id:"supervisor:test"\nreceipt:abc1234\nprovider_turn:sse-final-v1\nContinue.';
  let fetches = 0;
  let completedOnSecondRead = true;
  const outbound: Array<Record<string, unknown>> = [];
  const user = { id: 'user-turn', author: { role: 'user' }, content: { parts: [prompt] } };
  const hint = { task_id: 'supervisor:test', effect_id: effectId, receipt_challenge: 'abc1234',
    turn_id: 'user-turn', conversation_id: conversationId, started_at_ms: 1793490000000,
    request_id: '00000000-0000-4000-8000-000000000001', outcome: 'unknown' };
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const windowMock = { addEventListener(_type: string, callback: (event: Record<string, unknown>) => void) {
    listener = callback;
  } };
  const response = (body: unknown) => ({
    ok: true, status: 200, headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
    async json() { return body; }, async text() { return JSON.stringify(body); },
  });
  runInNewContext(source, {
    window: windowMock, location: { pathname: '/c/' + conversationId, origin: 'https://chatgpt.com' },
    chrome: { runtime: { async sendMessage(message: { event: Record<string, unknown> }) { outbound.push(message.event); } } },
    fetch: async (url: string) => {
      if (url === '/api/auth/session') return response({ accessToken: 'fake-token' });
      expect(url).toContain('/backend-api/conversations/' + conversationId);
      fetches += 1;
      return response({ conversation_id: conversationId, page_info: { has_next_page: false },
        messages: [user, { id: 'server-assistant', author: { role: 'assistant' }, recipient: 'all',
          status: completedOnSecondRead && fetches === 2 ? 'finished_successfully' : 'in_progress',
          end_turn: completedOnSecondRead && fetches === 2 }] });
    },
    setTimeout: (callback: () => void) => { queueMicrotask(callback); return 1; },
    Number, JSON, Set,
  });
  const notify = (event: Record<string, unknown>) => listener?.({
    source: windowMock, origin: 'https://chatgpt.com',
    data: { source: 'forge-computer-provider-turn-v1', type: 'turn-event', event },
  });
  notify(hint);
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fetches).toBe(2);
  expect(outbound).toHaveLength(1);
  expect(outbound[0]).toMatchObject({ outcome: 'completed',
    assistant_message_id: 'server-assistant', proof_source: 'chatgpt-conversation-readback-v1' });
  // Replayed hints for the same exact turn cannot trigger a third authenticated GET.
  notify({ ...hint, request_id: '00000000-0000-4000-8000-000000000009' });
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fetches).toBe(2);
  completedOnSecondRead = false;
  user.id = 'second-user';
  notify({ ...hint, turn_id: 'second-user', request_id: '00000000-0000-4000-8000-000000000002' });
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(fetches).toBe(4);
  expect(outbound).toHaveLength(1);
});

test('page Provider event cannot claim a different conversation in the same Chrome tab', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const start = source.indexOf('const PROVIDER_TURN_EVENT_PREFIX');
  const end = source.indexOf('chrome.runtime.onMessage.addListener((message, sender', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const code = source.slice(start, end);
  const actualId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const foreignId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  const fns = runInNewContext(code + '\n({ persistProviderTurnEvent })', {
    core: { parseConversation(url: string) {
      const id = /\/c\/([0-9a-f-]{36})/.exec(url)?.[1];
      return id ? { conversationId: id, canonicalUrl: url } : undefined;
    } },
  }) as { persistProviderTurnEvent(event: Record<string, unknown>, sender: Record<string, unknown>): Promise<{ accepted: boolean; reason: string }> };
  const event = {
    task_id: 'supervisor:test', effect_id: 'fx_0123456789abcdef0123456789abcdef',
    receipt_challenge: 'abc1234', turn_id: 'user-turn',
    request_id: '00000000-0000-4000-8000-000000000001',
    conversation_id: foreignId, started_at_ms: 1793490000000, outcome: 'completed',
    status_code: 200, content_type: 'application/json',
    proof_source: 'chatgpt-conversation-readback-v1',
    assistant_message_id: 'assistant-1', assistant_status: 'finished_successfully',
    assistant_end_turn: true,
  };
  const sender = { frameId: 0, tab: { id: 7, windowId: 8, url: 'https://chatgpt.com/c/' + actualId } };
  expect(await fns.persistProviderTurnEvent(event, sender)).toMatchObject({
    accepted: false, reason: 'provider_turn_conversation_invalid',
  });
});

test('page-origin completed or failed claims cannot become trusted Computer provider receipts', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const start = source.indexOf('const PROVIDER_TURN_EVENT_PREFIX');
  const end = source.indexOf('chrome.runtime.onMessage.addListener((message, sender', start);
  const writes: Array<Record<string, unknown>> = [];
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const binding = { ownerToken: 'owned-tab-token', tabId: '7', windowId: '8' };
  const event = {
    task_id: 'supervisor:test', effect_id: 'fx_0123456789abcdef0123456789abcdef',
    receipt_challenge: 'abc1234', turn_id: 'user-turn',
    request_id: '00000000-0000-4000-8000-000000000001',
    conversation_id: id, started_at_ms: 1793490000000,
    outcome: 'completed', status_code: 200, content_type: 'text/event-stream',
    assistant_message_id: 'assistant-1', assistant_status: 'finished_successfully',
    assistant_end_turn: true, stream_done: true,
  };
  const sender = { frameId: 0, tab: { id: 7, windowId: 8, url: 'https://chatgpt.com/c/' + id } };
  const chrome = {
    storage: {
      session: {
        get: async (_key: string) => ({ 'forgeComputerOwnedTabV1:7': 'owned-tab-token' }),
        set: async (_value: unknown) => undefined,
        remove: async (_key: unknown) => undefined,
      },
      local: { get: async (_key: unknown) => ({}), set: async (value: Record<string, unknown>) => {
        writes.push(value);
      }, remove: async (_key: unknown) => undefined },
    },
  };
  const fns = runInNewContext(source.slice(start, end) + '\n({ persistProviderTurnEvent })', {
    chrome, PROVIDER_ID: 'browser.chrome-extension',
    ownedTabKey: (tabId: number) => 'forgeComputerOwnedTabV1:' + tabId,
    providerInstanceId: async () => 'extension-session',
    binding: () => binding,
    core: { parseConversation(url: string) { return { conversationId: id, canonicalUrl: url }; } },
  }) as { persistProviderTurnEvent(event: Record<string, unknown>, sender: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }> };
  // A script in this same tab can post this payload without observing a real SSE response.
  expect(await fns.persistProviderTurnEvent(event, sender)).toMatchObject({
    accepted: false, reason: 'provider_turn_completion_evidence_invalid',
  });
  expect(await fns.persistProviderTurnEvent({
    ...event, outcome: 'failed', status_code: 429, content_type: 'application/json',
    failure_code: 'CHATGPT_AUTOMATION_RATE_LIMITED',
  }, sender)).toMatchObject({ accepted: false, reason: 'provider_turn_page_origin_untrusted' });
  expect(writes).toHaveLength(0);
  const { stream_done: _ignored, ...untrusted } = event;
  const attested = {
    ...untrusted, proof_source: 'chatgpt-conversation-readback-v1',
    content_type: 'application/json',
  };
  expect(await fns.persistProviderTurnEvent(attested, sender)).toMatchObject({
    accepted: true, duplicate: false,
  });
  expect(writes).toHaveLength(1);
});

test('provider turn receipt delivery cannot block the next Supervisor command claim', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const start = source.indexOf('let providerTickInFlight;');
  const end = source.indexOf('async function discoveryScan', start);
  const code = source.slice(start, end);
  const calls: string[] = [];
  const context = {
    publishHeartbeat: async () => 'provider-instance',
    flushProviderTurnEvents: () => new Promise<void>(() => {}),
    nativeRpc: async (method: string) => { calls.push(method); return { command: null }; },
    executeCommand: async () => undefined,
    console: { warn: () => undefined },
  };
  const providerTick = runInNewContext(code + '\nproviderTick', context) as () => Promise<void>;
  await providerTick();
  expect(calls).toEqual(['computer_extension_claim']);
});
