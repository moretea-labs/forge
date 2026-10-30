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

test('Chrome tabs query deadline releases a stuck heartbeat read and permits a later retry', async () => {
  const source = readFileSync('adapters/computer/chrome-extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('function boundedTabsQuery('), source.indexOf('// Controller binding owns the durable source identity.'));
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  let queryCalls = 0;
  const chrome = { tabs: { query: () => { queryCalls += 1; return new Promise<unknown[]>(() => undefined); } } };
  const context = {
    chrome, TABS_QUERY_TIMEOUT_MS: 5_000,
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const chatgptTabs = runInNewContext(code + '\nchatgptTabs', context) as () => Promise<unknown[]>;
  const first = chatgptTabs().catch((error: Error) => error.message);
  expect([...timers.values()].map(timer => timer.delay)).toEqual([5_000]);
  timers.get(1)?.callback();
  expect(await first).toBe('COMPUTER_CHATGPT_EXTENSION_TABS_QUERY_TIMEOUT');
  expect(queryCalls).toBe(1);
  chrome.tabs.query = async () => { queryCalls += 1; return []; };
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
  let resolveFirstSet: (() => void) | undefined;
  const writes: Array<Record<string, string>> = [];
  const chrome = { storage: { local: {
    get: async () => ({}),
    set: (value: Record<string, string>) => {
      writes.push(value);
      if (allowSet) return Promise.resolve();
      return new Promise<void>((resolve) => { resolveFirstSet = resolve; });
    },
  } } };
  const context = {
    chrome, HEARTBEAT_DEADLINE_MS: 10_000, randomId: () => `profile-${++randomIdCalls}`, Date,
    setTimeout(callback: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { callback: () => { timers.delete(id); callback(); }, delay });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const providerInstanceId = runInNewContext(code + '\nproviderInstanceId', context) as (deadlineAt: number) => Promise<string>;
  const first = providerInstanceId(Date.now() + 10_000).catch((error: Error) => error.message);
  await Promise.resolve();
  await Promise.resolve();
  expect(writes).toEqual([{ forgeComputerProviderInstanceId: 'profile-1' }]);
  expect([...timers.values()].map(timer => timer.delay)).toEqual([10_000]);
  [...timers.values()][0]!.callback();
  expect(await first).toBe('COMPUTER_CHATGPT_EXTENSION_PROVIDER_ID_TIMEOUT');
  allowSet = true;
  expect(await providerInstanceId(Date.now() + 10_000)).toBe('profile-1');
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
      rpcMethod = method; rpcPayload = params; rpcTimeout = timeoutMs; return { recorded: true };
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
