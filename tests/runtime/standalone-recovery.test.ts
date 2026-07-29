import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer as createSocketServer, type Server as SocketServer } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { attestKnownGood, createRecoveryConfig, decideWatchdog, recoveryReconnectOperation, restartGateway, restartSupervisor, rollbackPrevious, verifyStableRuntime } from '../../src/runtime/standalone-recovery/core';
import { dispatchRecoveryTool, RECOVERY_CLI_COMMANDS, RECOVERY_TOOLS } from '../../src/runtime/standalone-recovery/entry';

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
  for (const file of ['supervisor.js', 'repo-harness.js', 'daemon.js', 'worker.js', 'process-runner.js', 'browser-handoff-host.js']) writeFileSync(join(path, file), 'fixture');
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ schemaVersion: 1, releaseRevision: revision }));
  return path;
}

describe('standalone disaster recovery core', () => {
  test('attests only a fully verified coherent active release and refuses an unknown previous release', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-'));
    const active = release(home, 'active', 'release-active');
    const previous = release(home, 'previous', 'release-previous');
    const mcpSessionId = 'recovery-test-session';
    const port = await http((request, response) => {
      if (request.url === '/health') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      const accept = String(request.headers.accept ?? '');
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        response.statusCode = 406;
        response.end();
        return;
      }
      if (request.method === 'DELETE') {
        if (request.headers['mcp-session-id'] !== mcpSessionId) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 204;
        response.end();
        return;
      }
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      request.on('end', () => {
        const rpc = JSON.parse(body) as { method: string; id?: number };
        if (rpc.method === 'initialize') {
          response.setHeader('content-type', 'application/json');
          response.setHeader('mcp-session-id', mcpSessionId);
          response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } }));
          return;
        }
        if (request.headers['mcp-session-id'] !== mcpSessionId) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: { code: 'MCP_SESSION_EXPIRED' } }));
          return;
        }
        if (rpc.method === 'notifications/initialized') {
          response.statusCode = 202;
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        if (rpc.method === 'tools/list') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'controller_context' }, { name: 'runtime_status' }] } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [] } }));
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
    expect(RECOVERY_CLI_COMMANDS).toContain('attest-known-good');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('attest_known_good');
    const attested = await dispatchRecoveryTool(config, 'attest_known_good', { request_id: 'attest-release-active' }) as { revision: string };
    expect(attested.revision).toBe('release-active');
    const slots = await dispatchRecoveryTool(config, 'list_slots', {}) as { knownGood: Array<{ revision: string }> };
    expect(slots.knownGood.map((entry) => entry.revision)).toContain('release-active');
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

  test('Gateway reconnect recovery remains Gateway-only and requires Supervisor control', () => {
    const base = {
      ok: false,
      at: new Date().toISOString(),
      supervisor: { ok: true, observedState: 'healthy', activeSlot: 'green', previousSlot: 'blue' },
      releases: { coherent: true },
      probes: {
        supervisor_socket: { ok: true, detail: 'status received' },
        stable_ingress: { ok: true, detail: 'HTTP 200' },
        active_gateway: { ok: true, detail: 'HTTP 200' },
        mcp_initialize: { ok: false, detail: 'HTTP 406' },
      },
    };
    expect(recoveryReconnectOperation(base)).toBe('none');
    expect(recoveryReconnectOperation({
      ...base,
      probes: { ...base.probes, active_gateway: { ok: false, detail: 'connection refused' } },
    })).toBe('restart_gateway');
    expect(recoveryReconnectOperation({
      ...base,
      probes: {
        ...base.probes,
        supervisor_socket: { ok: false, detail: 'unavailable' },
        active_gateway: { ok: false, detail: 'unavailable' },
      },
    })).toBe('none');
  });

  test('Gateway restart refuses locked-out Supervisors', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-gateway-lockout-'));
    const active = release(home, 'active', 'release-active');
    const stablePort = await http((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    });
    let operationSubmits = 0;
    mkdirSync(join(home, 'runtime-slots', 'blue'), { recursive: true });
    writeFileSync(join(home, 'runtime-slots', 'blue', 'slot.json'), JSON.stringify({ releasePath: active }));
    const socket = createSocketServer((client) => client.on('data', (chunk) => {
      const rpc = JSON.parse(String(chunk)) as { command?: string };
      if (rpc.command === 'operation_submit') operationSubmits += 1;
      client.end(`${JSON.stringify({
        ok: true,
        state: {
          observedState: 'locked_out',
          activeSlot: 'blue',
          ingress: { state: 'running', activeUpstreamPort: 9 },
          gatewayHost: { releasePath: active, releaseRevision: 'release-active' },
          controllerDaemon: { releasePath: active, releaseRevision: 'release-active' },
          restartBudget: {
            'gatewayHost:test': { component: 'gatewayHost', lockedOut: true, attempts: 5, consecutiveFailures: 5 },
          },
        },
      })}\n`);
    }));
    socketServers.push(socket); mkdirSync(join(home, 'supervisor'), { recursive: true });
    await new Promise<void>((resolveListen, reject) => { socket.once('error', reject); socket.listen(join(home, 'supervisor', 'control.sock'), () => resolveListen()); });
    const result = await restartGateway(createRecoveryConfig(home, { stableIngressUrl: `http://127.0.0.1:${stablePort}` }), 'lockout-test');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('locked out');
    expect(operationSubmits).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test('Supervisor restart never downgrades to a Gateway-only operation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-supervisor-restart-'));
    const active = release(home, 'active', 'release-active');
    const stablePort = await http((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    });
    let operationSubmits = 0;
    mkdirSync(join(home, 'runtime-slots', 'blue'), { recursive: true });
    writeFileSync(join(home, 'runtime-slots', 'blue', 'slot.json'), JSON.stringify({ releasePath: active }));
    const socket = createSocketServer((client) => client.on('data', (chunk) => {
      const rpc = JSON.parse(String(chunk)) as { command?: string };
      if (rpc.command === 'operation_submit') operationSubmits += 1;
      client.end(`${JSON.stringify({
        ok: true,
        state: {
          observedState: 'locked_out',
          activeSlot: 'blue',
          ingress: { state: 'running', activeUpstreamPort: 9 },
          gatewayHost: { releasePath: active, releaseRevision: 'release-active' },
          controllerDaemon: { releasePath: active, releaseRevision: 'release-active' },
          supervisor: { pid: 999999, releasePath: active, releaseRevision: 'release-active' },
        },
      })}\n`);
    }));
    socketServers.push(socket); mkdirSync(join(home, 'supervisor'), { recursive: true });
    await new Promise<void>((resolveListen, reject) => { socket.once('error', reject); socket.listen(join(home, 'supervisor', 'control.sock'), () => resolveListen()); });
    const result = await restartSupervisor(createRecoveryConfig(home, { stableIngressUrl: `http://127.0.0.1:${stablePort}` }), 'supervisor-test');
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain('Gateway-only');
    expect(operationSubmits).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });
});
