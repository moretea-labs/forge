import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
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
  return { root, socketPath: join(root, 'provider.sock') };
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

describe('external Unix socket provider transport', () => {
  test('executes bounded asynchronous JSONL RPC and returns object results', async () => {
    if (process.platform === 'win32') return;
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

  test('preserves structured provider errors', async () => {
    if (process.platform === 'win32') return;
    const { socketPath } = socketFixture();
    await startServer(socketPath);
    await expect(callExternalUnixSocket({
      socketPath,
      requestId: 'req-2',
      method: 'execute',
      params: { action: 'fail', arguments: {} },
      timeoutMs: 2_000,
    })).rejects.toThrow('ELEMENT_NOT_FOUND');
  });

  test('accepts bounded provider-specific RPC methods without transport allowlisting', async () => {
    if (process.platform === 'win32') return;
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
