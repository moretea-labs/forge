import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer as createSocketServer, type Server as SocketServer } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { attestKnownGood, createRecoveryConfig, decideWatchdog, rollbackPrevious, verifyStableRuntime } from '../../src/runtime/standalone-recovery/core';

const httpServers: Server[] = [];
const socketServers: SocketServer[] = [];

afterEach(async () => {
  await Promise.all(httpServers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(socketServers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
});

async function http(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const server = createServer(handler); httpServers.push(server);
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen()); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test HTTP address unavailable');
  return address.port;
}

function release(home: string, name: string, revision: string): string {
  const path = join(home, 'supervisor', 'releases', name); mkdirSync(path, { recursive: true });
  for (const file of ['supervisor.js', 'repo-harness.js', 'daemon.js']) writeFileSync(join(path, file), 'fixture');
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ schemaVersion: 1, releaseRevision: revision }));
  return path;
}

describe('standalone disaster recovery core', () => {
  test('attests only a fully verified coherent active release and refuses an unknown previous release', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-'));
    const active = release(home, 'active', 'release-active');
    const previous = release(home, 'previous', 'release-previous');
    const port = await http((request, response) => {
      if (request.url === '/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ok' })); return; }
      let body = ''; request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); }); request.on('end', () => {
        const rpc = JSON.parse(body) as { method: string; id: number };
        if (rpc.method === 'tools/list') response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'controller_context' }, { name: 'runtime_status' }] } }));
        else response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [] } }));
      });
    });
    mkdirSync(join(home, 'runtime-slots', 'blue'), { recursive: true });
    mkdirSync(join(home, 'runtime-slots', 'green'), { recursive: true });
    writeFileSync(join(home, 'runtime-slots', 'blue', 'slot.json'), JSON.stringify({ releasePath: active }));
    writeFileSync(join(home, 'runtime-slots', 'green', 'slot.json'), JSON.stringify({ releasePath: previous }));
    mkdirSync(join(home, 'mcp'), { recursive: true });
    writeFileSync(join(home, 'mcp', 'mcp.tokens.json'), JSON.stringify({ bearerToken: 'a'.repeat(32) }));
    const socket = createSocketServer((client) => client.on('data', () => client.end(`${JSON.stringify({ ok: true, state: { observedState: 'healthy', activeSlot: 'blue', previousSlot: 'green', ingress: { state: 'running', activeUpstreamPort: port }, gatewayHost: { releasePath: active, releaseRevision: 'release-active' }, controllerDaemon: { releasePath: active, releaseRevision: 'release-active' } } })}\n`)));
    socketServers.push(socket); mkdirSync(join(home, 'supervisor'), { recursive: true });
    await new Promise<void>((resolveListen, reject) => { socket.once('error', reject); socket.listen(join(home, 'supervisor', 'control.sock'), () => resolveListen()); });
    const config = createRecoveryConfig(home, { stableIngressUrl: `http://127.0.0.1:${port}` });
    const verified = await verifyStableRuntime(config);
    expect(verified.ok).toBe(true);
    expect((await attestKnownGood(config)).revision).toBe('release-active');
    const rollback = await rollbackPrevious(config);
    expect(rollback.ok).toBe(true);
    expect(rollback.noOp).toBe(true);
    expect(rollback.detail).toContain('known-good');
    rmSync(home, { recursive: true, force: true });
  });

  test('requires sustained multi-signal evidence before automatic rollback', () => {
    expect(decideWatchdog({ failures: 1, firstFailureAt: Date.now() - 60_000, evidenceClasses: ['external'], activeKnownGood: false, previousKnownGood: true, operationInFlight: false, rollbackUsed: false }).action).toBe('degraded');
    expect(decideWatchdog({ failures: 6, firstFailureAt: Date.now() - 31_000, evidenceClasses: ['external', 'mcp'], activeKnownGood: false, previousKnownGood: true, operationInFlight: false, rollbackUsed: false }).action).toBe('rollback');
    expect(decideWatchdog({ failures: 6, firstFailureAt: Date.now() - 31_000, evidenceClasses: ['external', 'mcp'], activeKnownGood: true, previousKnownGood: true, operationInFlight: false, rollbackUsed: false }).action).toBe('degraded');
  });
});
