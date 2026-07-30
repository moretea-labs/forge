import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createServer as createSocketServer, type Server as SocketServer } from 'net';
import { join } from 'path';
import { tmpdir } from 'os';
import { attestKnownGood, createRecoveryConfig, decideWatchdog, recoveryReconnectOperation, restartGateway, restartSupervisor, rollbackPrevious, verifyStableRuntime } from '../../src/runtime/standalone-recovery/core';
import { dispatchRecoveryTool, RECOVERY_CLI_COMMANDS, RECOVERY_TOOLS } from '../../src/runtime/standalone-recovery/entry';
import { createRecoveryHttpTransport, ExternalHttpsRecoveryTransport, resolveTrustedRecoveryCurl, type RecoveryHttpTransportOptions } from '../../src/runtime/standalone-recovery/http-transport';

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

function fakeCurl(home: string): { executable: string; record: string } {
  const executable = join(home, 'fake-curl.mjs');
  const record = join(home, 'fake-curl-record.jsonl');
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, statSync } from 'fs';
import { dirname } from 'path';
const configPath = process.argv[process.argv.indexOf('--config') + 1];
const config = readFileSync(configPath, 'utf8');
const value = (name) => {
  const line = config.split(/\\n/).find((entry) => entry.startsWith(name + ' = '));
  return line ? JSON.parse(line.slice(name.length + 3)) : undefined;
};
const method = value('request') || 'GET';
const input = value('data-binary');
const bodyPath = input && input.startsWith('@') ? input.slice(1) : undefined;
const body = bodyPath ? readFileSync(bodyPath, 'utf8') : '';
const rpc = body ? JSON.parse(body) : undefined;
const headers = config.split(/\\n/).filter((entry) => entry.startsWith('header = ')).map((entry) => JSON.parse(entry.slice('header = '.length)));
const event = {
  pid: process.pid,
  argv: process.argv.slice(2), method, rpcMethod: rpc?.method, session: headers.some((header) => header.toLowerCase().startsWith('mcp-session-id: ')),
  inheritedHttpsProxy: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
  inheritedCurlCaBundle: Boolean(process.env.CURL_CA_BUNDLE),
  inheritedSslCertFile: Boolean(process.env.SSL_CERT_FILE),
  inheritedHome: Boolean(process.env.HOME),
  hasAuthorization: headers.some((header) => header.toLowerCase().startsWith('authorization: bearer ')),
  hasBody: Boolean(body), directoryMode: statSync(dirname(configPath)).mode & 0o777, configMode: statSync(configPath).mode & 0o777,
  bodyMode: bodyPath ? statSync(bodyPath).mode & 0o777 : undefined,
};
if (process.env.FAKE_CURL_RECORD) appendFileSync(process.env.FAKE_CURL_RECORD, JSON.stringify(event) + '\\n');
if (process.env.FAKE_CURL_MODE === 'timeout') setInterval(() => {}, 1_000);
if (process.env.FAKE_CURL_MODE === 'stderr') process.stderr.write('x'.repeat(Number(process.env.FAKE_CURL_STDERR_BYTES || 0)));
if (process.env.FAKE_CURL_MODE === 'exit') process.exit(22);
let response = process.env.FAKE_CURL_RESPONSE;
if (!response) {
  if (method === 'GET') response = 'HTTP/1.1 401 Unauthorized\\r\\nWWW-Authenticate: Bearer realm="recovery"\\r\\nContent-Type: application/json\\r\\n\\r\\n{"error":"invalid_token"}';
  else if (method === 'DELETE') response = 'HTTP/2 204 No Content\\r\\n\\r\\n';
  else if (rpc?.method === 'initialize') response = 'HTTP/1.1 200 Connection established\\r\\n\\r\\nHTTP/2 200 OK\\r\\nContent-Type: application/json\\r\\nMCP-Session-Id: recovery-session-1\\r\\n\\r\\n{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}';
  else if (rpc?.method === 'notifications/initialized') response = 'HTTP/2 202 Accepted\\r\\n\\r\\n';
  else if (rpc?.method === 'tools/list') response = 'HTTP/2 200 OK\\r\\nContent-Type: text/event-stream\\r\\n\\r\\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"controller_context"}]}}\\n\\n';
  else response = 'HTTP/2 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"jsonrpc":"2.0","id":3,"result":{"content":[]}}';
}
if (process.env.FAKE_CURL_DELAY_MS) setTimeout(() => process.stdout.write(response), Number(process.env.FAKE_CURL_DELAY_MS));
else process.stdout.write(response);
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { executable, record };
}

function fakeEvents(record: string): Array<Record<string, unknown>> {
  return readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function recoveryTmpEntries(home: string): string[] {
  const path = join(home, 'recovery', 'tmp');
  return readdirSync(path);
}

async function withFakeCurlEnvironment<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await action(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function fakeCurlOptions(executable: string, overrides: RecoveryHttpTransportOptions = {}): RecoveryHttpTransportOptions {
  return {
    resolveCurlExecutable: async () => executable,
    childEnvironment: () => {
      const environment: NodeJS.ProcessEnv = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (name.startsWith('FAKE_CURL_') && value !== undefined) environment[name] = value;
      }
      return environment;
    },
    ...overrides,
  };
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
      if (request.method === 'GET' && request.url === '/mcp') {
        response.statusCode = 401;
        response.setHeader('www-authenticate', 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
        response.end(JSON.stringify({ error: 'invalid_token' }));
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
    const config = createRecoveryConfig(home, { stableIngressUrl: `http://127.0.0.1:${port}`, publicMcpUrl: `http://127.0.0.1:${port}/mcp` });
    const verified = await verifyStableRuntime(config);
    expect(verified.ok).toBe(true);
    expect(verified.probes.external_mcp_http).toEqual({ ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 });
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

  test('uses protected curl transport for the complete external HTTPS MCP lifecycle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-curl-lifecycle-'));
    const active = release(home, 'active', 'release-active');
    const port = await http((_request, response) => { response.end(JSON.stringify({ status: 'ok' })); });
    mkdirSync(join(home, 'runtime-slots', 'blue'), { recursive: true });
    writeFileSync(join(home, 'runtime-slots', 'blue', 'slot.json'), JSON.stringify({ releasePath: active }));
    mkdirSync(join(home, 'mcp'), { recursive: true });
    const token = 't'.repeat(32);
    writeFileSync(join(home, 'mcp', 'mcp.tokens.json'), JSON.stringify({ bearerToken: token }));
    const socket = createSocketServer((client) => client.on('data', () => client.end(`${JSON.stringify({ ok: true, state: { observedState: 'healthy', activeSlot: 'blue', ingress: { state: 'running', activeUpstreamPort: port }, gatewayHost: { releasePath: active, releaseRevision: 'release-active' }, controllerDaemon: { releasePath: active, releaseRevision: 'release-active' } } })}\n`)));
    socketServers.push(socket); mkdirSync(join(home, 'supervisor'), { recursive: true });
    await new Promise<void>((resolveListen, reject) => { socket.once('error', reject); socket.listen(join(home, 'supervisor', 'control.sock'), () => resolveListen()); });
    const fake = fakeCurl(home);
    const config = createRecoveryConfig(home, { stableIngressUrl: `http://127.0.0.1:${port}`, publicMcpUrl: 'https://recovery.example.test/mcp' });
    const transport = createRecoveryHttpTransport(home, fakeCurlOptions(fake.executable));
    const verified = await withFakeCurlEnvironment({
      FAKE_CURL_RECORD: fake.record,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      CURL_CA_BUNDLE: '/tmp/untrusted-ca.pem',
      SSL_CERT_FILE: '/tmp/untrusted-ca.pem',
      HOME: join(home, 'hostile-home'),
    }, () => verifyStableRuntime(config, transport));

    expect(verified.ok).toBe(true);
    expect(verified.probes.external_mcp_http).toEqual({ ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 });
    expect(verified.probes.mcp_initialized_notification?.ok).toBe(true);
    expect(verified.probes.mcp_tools_list?.ok).toBe(true);
    expect(verified.probes.mcp_read_only_call?.ok).toBe(true);
    expect(verified.probes.mcp_session_close?.ok).toBe(true);
    const events = fakeEvents(fake.record);
    expect(events.map((entry) => entry.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'POST', 'DELETE']);
    expect(events.map((entry) => entry.rpcMethod).filter(Boolean)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(events.filter((entry) => entry.method === 'POST').every((entry) => entry.session === true || entry.rpcMethod === 'initialize')).toBe(true);
    expect(events.find((entry) => entry.method === 'DELETE')?.session).toBe(true);
    for (const event of events) {
      expect(event.argv).toEqual(['--disable', '--config', expect.any(String)]);
      expect(JSON.stringify(event.argv)).not.toContain(token);
      expect(JSON.stringify(event.argv)).not.toContain('jsonrpc');
      expect(event.inheritedHttpsProxy).toBe(false);
      expect(event.inheritedCurlCaBundle).toBe(false);
      expect(event.inheritedSslCertFile).toBe(false);
      expect(event.inheritedHome).toBe(false);
      expect(event.directoryMode).toBe(0o700);
      expect(event.configMode).toBe(0o600);
      if (event.hasBody) expect(event.bodyMode).toBe(0o600);
    }
    expect(recoveryTmpEntries(home)).toEqual([]);
    expect(readFileSync(join(home, 'recovery', 'audit', 'recovery.jsonl'), 'utf8')).not.toContain(token);
    rmSync(home, { recursive: true, force: true });
  });

  test('cleans protected curl material after HTTP, spawn, timeout, cancellation, and parsing failures', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-curl-cleanup-'));
    const fake = fakeCurl(home);
    const transport = new ExternalHttpsRecoveryTransport(home, fakeCurlOptions(fake.executable, { termGraceMs: 30 }));
    await withFakeCurlEnvironment({ FAKE_CURL_RECORD: fake.record, FAKE_CURL_RESPONSE: 'HTTP/2 500 Server Error\r\nContent-Type: application/json\r\n\r\n{}' }, async () => {
      await expect(transport.request({ url: 'https://recovery.example.test/mcp' })).resolves.toMatchObject({ status: 500 });
    });
    expect(recoveryTmpEntries(home)).toEqual([]);
    const missing = new ExternalHttpsRecoveryTransport(home, { resolveCurlExecutable: async () => join(home, 'missing-curl'), termGraceMs: 30 });
    await expect(missing.request({ url: 'https://recovery.example.test/mcp' })).rejects.toThrow('RECOVERY_HTTP_CURL_SPAWN_FAILED');
    expect(recoveryTmpEntries(home)).toEqual([]);
    await withFakeCurlEnvironment({ FAKE_CURL_RECORD: fake.record, FAKE_CURL_MODE: 'timeout' }, async () => {
      await expect(transport.request({ url: 'https://recovery.example.test/mcp', timeoutMs: 40 })).rejects.toThrow('RECOVERY_HTTP_TIMEOUT');
    });
    const timedOutPid = Number(fakeEvents(fake.record).at(-1)?.pid);
    expect(timedOutPid).toBeGreaterThan(0);
    expect(() => process.kill(timedOutPid, 0)).toThrow();
    expect(recoveryTmpEntries(home)).toEqual([]);
    const abort = new AbortController();
    await withFakeCurlEnvironment({ FAKE_CURL_RECORD: fake.record, FAKE_CURL_MODE: 'timeout' }, async () => {
      const pending = transport.request({ url: 'https://recovery.example.test/mcp', timeoutMs: 1_000, signal: abort.signal });
      setTimeout(() => abort.abort(), 20);
      await expect(pending).rejects.toThrow('RECOVERY_HTTP_ABORTED');
    });
    const cancelledPid = Number(fakeEvents(fake.record).at(-1)?.pid);
    expect(cancelledPid).toBeGreaterThan(0);
    expect(() => process.kill(cancelledPid, 0)).toThrow();
    expect(recoveryTmpEntries(home)).toEqual([]);
    await withFakeCurlEnvironment({ FAKE_CURL_RECORD: fake.record, FAKE_CURL_RESPONSE: 'not an HTTP response' }, async () => {
      await expect(transport.request({ url: 'https://recovery.example.test/mcp' })).rejects.toThrow('RECOVERY_HTTP_FINAL_RESPONSE_MISSING');
    });
    expect(recoveryTmpEntries(home)).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  test('bounds curl headers, body, stderr, does not block local HTTP, and leaves loopback on fetch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-curl-bounds-'));
    const fake = fakeCurl(home);
    const limitedHeaders = new ExternalHttpsRecoveryTransport(home, fakeCurlOptions(fake.executable, { maxHeaderBytes: 64 }));
    await withFakeCurlEnvironment({ FAKE_CURL_RESPONSE: `HTTP/2 200 OK\r\nX-Long: ${'x'.repeat(80)}\r\n\r\n` }, async () => {
      await expect(limitedHeaders.request({ url: 'https://recovery.example.test/mcp' })).rejects.toThrow('RECOVERY_HTTP_HEADER_TOO_LARGE');
    });
    const limitedBody = new ExternalHttpsRecoveryTransport(home, fakeCurlOptions(fake.executable, { maxHeaderBytes: 128, maxBodyBytes: 32 }));
    await withFakeCurlEnvironment({ FAKE_CURL_RESPONSE: `HTTP/2 200 OK\r\n\r\n${'x'.repeat(40)}` }, async () => {
      await expect(limitedBody.request({ url: 'https://recovery.example.test/mcp' })).rejects.toThrow('RECOVERY_HTTP_BODY_TOO_LARGE');
    });
    const limitedStderr = new ExternalHttpsRecoveryTransport(home, fakeCurlOptions(fake.executable, { maxStderrBytes: 32, termGraceMs: 30 }));
    await withFakeCurlEnvironment({ FAKE_CURL_MODE: 'stderr', FAKE_CURL_STDERR_BYTES: '64' }, async () => {
      await expect(limitedStderr.request({ url: 'https://recovery.example.test/mcp' })).rejects.toThrow('RECOVERY_HTTP_STDERR_TOO_LARGE');
    });
    const port = await http((_request, response) => response.end('ok'));
    const delayed = new ExternalHttpsRecoveryTransport(home, fakeCurlOptions(fake.executable));
    await withFakeCurlEnvironment({ FAKE_CURL_DELAY_MS: '150' }, async () => {
      const pending = delayed.request({ url: 'https://recovery.example.test/mcp' });
      const started = Date.now();
      const local = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await local.text()).toBe('ok');
      expect(Date.now() - started).toBeLessThan(120);
      await pending;
    });
    const localTransport = createRecoveryHttpTransport(home, { resolveCurlExecutable: async () => { throw new Error('curl must not run for loopback'); } });
    await expect(localTransport.request({ url: `http://127.0.0.1:${port}/health` })).resolves.toMatchObject({ status: 200, body: 'ok' });
    expect(recoveryTmpEntries(home)).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  test('fails closed without a trusted Windows system curl and supports a test-injected trusted executable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-curl-windows-'));
    await expect(resolveTrustedRecoveryCurl('win32', join(home, 'Windows'))).rejects.toThrow('RECOVERY_CURL_UNAVAILABLE');
    const fake = fakeCurl(home);
    const windowsRoot = join(home, 'Windows');
    const systemCurl = join(windowsRoot, 'System32', 'curl.exe');
    mkdirSync(join(windowsRoot, 'System32'), { recursive: true, mode: 0o700 });
    writeFileSync(systemCurl, readFileSync(fake.executable), { mode: 0o700 });
    chmodSync(systemCurl, 0o700);
    const trusted = await resolveTrustedRecoveryCurl('win32', realpathSync(windowsRoot));
    expect(trusted).toBe(realpathSync(systemCurl));
    const transport = new ExternalHttpsRecoveryTransport(home, { platform: 'win32', resolveCurlExecutable: async () => trusted });
    await expect(transport.request({ url: 'https://recovery.example.test/mcp' })).resolves.toMatchObject({ status: 401 });
    rmSync(home, { recursive: true, force: true });
  });
});
