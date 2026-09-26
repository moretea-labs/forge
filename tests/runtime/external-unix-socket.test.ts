import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  callExternalUnixSocket,
  probeExternalUnixSocketSync,
  resolveExternalPluginProbeRuntime,
  resolveExternalPluginProbeSidecarPath,
} from '../../src/runtime/plugins/external-unix-socket';
import { AssistantPluginError } from '../../src/runtime/plugins/errors';
import { ExternalUnixJsonlChannel, MAX_PLUGIN_ACTION_TIMEOUT_MS, normalizeExternalUnixJsonlCall } from '../../packages/plugin-runtime/external/unix-jsonl-transport';

const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const child of children.splice(0)) child.kill('SIGTERM');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function socketFixture(): { root: string; socketPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-external-socket-'));
  roots.push(root);
  return {
    root,
    socketPath: process.platform === 'win32'
      ? `\\\\.\\pipe\\forge-external-socket-${randomUUID()}`
      : join(root, 'provider.sock'),
  };
}

function startServer(socketPath: string): Promise<void> {
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
      if (request.method === 'execute' && request.params.action === 'fail') {
        socket.end(`${JSON.stringify({ id: request.id, ok: false, error: { code: 'ELEMENT_NOT_FOUND', message: 'missing', retryable: true, domain: 'accessibility' } })}\n`);
        return;
      }
      if (request.method === 'execute' && request.params.action === 'drop_after_dispatch') {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { method: request.method, echoed: request.params } })}\n`);
    });
  });
  servers.push(server);
  return new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
}

async function startChildServer(root: string, socketPath: string): Promise<ChildProcess> {
  const scriptPath = join(root, 'server.cjs');
  writeFileSync(scriptPath, `
const net = require('net');
const fs = require('fs');
const socketPath = process.argv[2];
try { fs.unlinkSync(socketPath); } catch (_) {}
const server = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const newline = buffer.indexOf('\\n');
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline));
    socket.end(JSON.stringify({ id: request.id, ok: true, result: { state: 'ready', method: request.method } }) + '\\n');
  });
});
server.listen(socketPath, () => process.stdout.write('ready\\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const child = spawn(process.execPath, [scriptPath, socketPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('child server did not start')), 5_000);
    child.once('error', reject);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('ready\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

describe('external local socket / named-pipe provider transport', () => {
  test('preserves action budgets above 120 seconds while enforcing the shared plugin-action maximum', () => {
    const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\forge-timeout-policy' : '/tmp/forge-timeout-policy.sock';
    expect(normalizeExternalUnixJsonlCall({
      socketPath,
      requestId: 'timeout-240s',
      method: 'execute',
      timeoutMs: 240_000,
    }).timeoutMs).toBe(240_000);
    expect(normalizeExternalUnixJsonlCall({
      socketPath,
      requestId: 'timeout-over-max',
      method: 'execute',
      timeoutMs: MAX_PLUGIN_ACTION_TIMEOUT_MS * 2,
    }).timeoutMs).toBe(MAX_PLUGIN_ACTION_TIMEOUT_MS);
  });

  test('executes bounded asynchronous JSONL RPC and returns object results', async () => {
    const { socketPath } = socketFixture();
    await startServer(socketPath);
    const result = await callExternalUnixSocket({
      socketPath,
      requestId: 'req-1',
      method: 'execute',
      params: { action: 'desktop_status', arguments: {} },
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ method: 'execute', echoed: { action: 'desktop_status' } });
  });

  test('preserves structured provider errors as failed outcomes', async () => {
    const { socketPath } = socketFixture();
    await startServer(socketPath);
    try {
      await callExternalUnixSocket({
        socketPath,
        requestId: 'req-2',
        method: 'execute',
        params: { action: 'fail', arguments: {} },
        timeoutMs: 2_000,
      });
      throw new Error('expected provider error');
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantPluginError);
      expect((error as AssistantPluginError).code).toBe('ELEMENT_NOT_FOUND');
      expect((error as AssistantPluginError).effectOutcome).toBe('failed');
    }
  });

  test('marks transport loss after effect dispatch as outcome_unknown', async () => {
    const { socketPath } = socketFixture();
    await startServer(socketPath);
    try {
      await callExternalUnixSocket({
        socketPath,
        requestId: 'req-outcome-unknown',
        method: 'execute',
        params: { action: 'drop_after_dispatch', arguments: {} },
        timeoutMs: 2_000,
      });
      throw new Error('expected transport failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantPluginError);
      expect((error as AssistantPluginError).effectOutcome).toBe('outcome_unknown');
    }
  });

  test('accepts bounded provider-specific RPC methods without transport allowlisting', async () => {
    const { socketPath } = socketFixture();
    await startServer(socketPath);
    const result = await callExternalUnixSocket({
      socketPath,
      requestId: 'provider-method-1',
      method: 'provider_capability_v2',
      params: { value: 1 },
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ method: 'provider_capability_v2', echoed: { value: 1 } });
  });

  test('rejects invalid RPC method names before either transport lane connects', async () => {
    const { socketPath } = socketFixture();
    await expect(callExternalUnixSocket({ socketPath, requestId: 'bad-method-1', method: 'Bad Method' })).rejects.toThrow('EXTERNAL_PLUGIN_METHOD_INVALID');
    expect(() => probeExternalUnixSocketSync({ socketPath, requestId: 'bad-method-2', method: 'a'.repeat(129) })).toThrow('EXTERNAL_PLUGIN_METHOD_INVALID');
  });

  test('compiled Runtime resolves the probe beside its executable and launches it with Bun', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-external-probe-release-'));
    roots.push(root);
    const releaseRoot = join(root, 'release');
    const home = join(root, 'home');
    const bunRoot = join(home, '.bun', 'bin');
    mkdirSync(releaseRoot, { recursive: true });
    mkdirSync(bunRoot, { recursive: true });
    const runtimePath = join(releaseRoot, 'forge-runtime');
    const sidecarPath = join(releaseRoot, 'external-unix-socket-probe.cjs');
    const bunPath = join(bunRoot, process.platform === 'win32' ? 'bun.exe' : 'bun');
    writeFileSync(runtimePath, 'compiled-runtime');
    writeFileSync(sidecarPath, 'probe-sidecar');
    writeFileSync(bunPath, 'bun-runtime');

    expect(resolveExternalPluginProbeSidecarPath(runtimePath, 'file:///missing/external-unix-socket.ts')).toBe(sidecarPath);
    expect(resolveExternalPluginProbeRuntime(runtimePath, { HOME: home }, home)).toBe(bunPath);
    expect(resolveExternalPluginProbeRuntime(runtimePath, { HOME: home }, home)).not.toBe(runtimePath);
  });

  test('source-hosted Runtime resolves the probe from the configured immutable release', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-external-probe-configured-release-'));
    roots.push(root);
    const releaseRoot = join(root, 'release');
    mkdirSync(releaseRoot, { recursive: true });
    const sidecarPath = join(releaseRoot, 'external-unix-socket-probe.cjs');
    writeFileSync(sidecarPath, 'probe-sidecar');

    expect(resolveExternalPluginProbeSidecarPath(
      join(root, 'bun'),
      'file:///missing/external-unix-socket.ts',
      { FORGE_RELEASE_PATH: releaseRoot },
    )).toBe(sidecarPath);
  });

  test('synchronous probe uses a separate bounded sidecar and preserves the response envelope', async () => {
    // Bun's Windows test runner can retain a child named-pipe server after a
    // synchronous spawn, despite the probe itself succeeding. The real
    // Windows JSONL path is exercised above without that runner artifact.
    if (process.platform === 'win32') return;
    const { root, socketPath } = socketFixture();
    await startChildServer(root, socketPath);
    const result = probeExternalUnixSocketSync({
      socketPath,
      requestId: 'probe-1',
      method: 'health',
      timeoutMs: 2_000,
    });
    expect(result).toEqual({ state: 'ready', method: 'health' });
  });

  test('rejects relative socket paths before any connection attempt', async () => {
    await expect(callExternalUnixSocket({ socketPath: 'relative.sock', requestId: 'bad-1', method: 'health' })).rejects.toThrow('EXTERNAL_PLUGIN_SOCKET_PATH_INVALID');
    expect(() => probeExternalUnixSocketSync({ socketPath: 'relative.sock', requestId: 'bad-2', method: 'health' })).toThrow('EXTERNAL_PLUGIN_SOCKET_PATH_INVALID');
  });
});

/**
 * A client that stops waiting must never tear the connection down under a
 * provider that is still computing the response. Doing so makes the provider's
 * own write fail (the macOS Desktop Operator dies on SIGPIPE) and a supervised
 * KeepAlive service then restarts into the same abandoned request forever.
 */
describe('abandoned in-flight provider requests keep the provider alive', () => {
  function slowServer(options: { socketPath: string; waitFor: Promise<void>; writes: Array<{ id: string; error?: Error }> }): Promise<Server> {
    const server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          const request = JSON.parse(raw) as { id: string };
          void options.waitFor.then(() => {
            socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { late: true } })}\n`, (error) => {
              options.writes.push({ id: request.id, ...(error ? { error } : {}) });
            });
          });
        }
      });
      socket.on('error', () => undefined);
    });
    servers.push(server);
    return new Promise<Server>((resolve, reject) => server.once('error', reject).listen(options.socketPath, () => resolve(server)));
  }

  function gate(): { waitFor: Promise<void>; open: () => void } {
    let open!: () => void;
    const waitFor = new Promise<void>((resolve) => { open = resolve; });
    return { waitFor, open };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  test('one-shot lane drains the late response instead of closing the socket', async () => {
    const { socketPath } = socketFixture();
    const { waitFor, open } = gate();
    const writes: Array<{ id: string; error?: Error }> = [];
    await slowServer({ socketPath, waitFor, writes });

    const call = callExternalUnixSocket({ socketPath, requestId: 'abandoned-one-shot', method: 'execute', params: { action: 'slow' }, timeoutMs: 150 });
    await expect(call).rejects.toMatchObject({ code: 'EXTERNAL_PLUGIN_TIMEOUT' });

    // The provider is still working when its caller already gave up.
    expect(writes).toEqual([]);
    open();
    await settle();

    expect(writes).toEqual([{ id: 'abandoned-one-shot' }]);
  });

  test('persistent channel drains the late response and still serves the next request', async () => {
    const { socketPath } = socketFixture();
    const { waitFor, open } = gate();
    const writes: Array<{ id: string; error?: Error }> = [];
    await slowServer({ socketPath, waitFor, writes });

    const channel = new ExternalUnixJsonlChannel(socketPath);
    try {
      const abandoned = channel.call({ requestId: 'abandoned-channel', method: 'execute', params: { action: 'slow' }, timeoutMs: 150 });
      await expect(abandoned).rejects.toMatchObject({ code: 'EXTERNAL_PLUGIN_TIMEOUT' });

      open();
      await settle();
      expect(writes).toEqual([{ id: 'abandoned-channel' }]);

      // The abandoned connection left service without ever killing the provider.
      const next = await channel.call({ requestId: 'after-abandon', method: 'execute', params: { action: 'slow' }, timeoutMs: 2_000 });
      expect(next).toEqual({ late: true });
    } finally {
      channel.close();
    }
  });

  test('channel disposal during an in-flight request neither kills the provider nor strands the caller', async () => {
    const { socketPath } = socketFixture();
    const { waitFor, open } = gate();
    const writes: Array<{ id: string; error?: Error }> = [];
    await slowServer({ socketPath, waitFor, writes });

    const channel = new ExternalUnixJsonlChannel(socketPath);
    const abandoned = channel.call({ requestId: 'abandoned-disposal', method: 'execute', params: { action: 'slow' }, timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    channel.close();

    open();
    await settle();
    expect(writes).toEqual([{ id: 'abandoned-disposal' }]);
    await expect(abandoned).resolves.toEqual({ late: true });
  });
});
