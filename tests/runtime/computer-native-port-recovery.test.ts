import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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
  const context = { chrome, NATIVE_HOST: 'test', RPC_TIMEOUT_MS: 30_000, randomId: () => String(++id),
    setTimeout(fn: () => void) { const key = ++timerId; timers.set(key, fn); return key; },
    clearTimeout(key: number) { timers.delete(key); }, providerTick: async () => { ticks++; } };
  const rpc = runInNewContext(`${code}\nnativeRpc`, context) as (method: string) => Promise<unknown>;
  const heartbeat = rpc('computer_extension_heartbeat').catch((error: Error) => error.message);
  const completion = rpc('computer_extension_complete').catch((error: Error) => error.message);
  timers.get(1)?.();
  expect(await heartbeat).toContain('TIMEOUT');
  expect(ports[0].disconnected).toBe(true);
  expect(await completion).toContain('TIMEOUT');
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
  const context = { chrome, NATIVE_HOST: 'test', RPC_TIMEOUT_MS: 30_000, randomId: () => String(++id),
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
    chrome, NATIVE_HOST: 'test', RPC_TIMEOUT_MS: 30_000, randomId: () => String(++nextId),
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
