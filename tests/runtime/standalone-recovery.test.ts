import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createServer as createSocketServer, type Server as SocketServer } from 'net';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { attestKnownGood, createRecoveryConfig, decideWatchdog, initializeStandaloneRecovery, loadWatchdogState, recoveryReconnectOperation, repairPublicTunnel, restartGateway, restartRecoveryGateway, restartSupervisor, rollbackPrevious, runAgentRepair, saveWatchdogState, verifyStableRuntime, type VerifyResult } from '../../src/runtime/standalone-recovery/core';
import { dispatchRecoveryTool, recoveryRuntimeRoleFromExecutable, RECOVERY_CLI_COMMANDS, RECOVERY_TOOLS } from '../../src/runtime/standalone-recovery/entry';
import { createRecoveryHttpTransport, ExternalHttpsRecoveryTransport, resolveTrustedRecoveryCurl, type RecoveryHttpTransportOptions } from '../../src/runtime/standalone-recovery/http-transport';
import { activateRecoveryRelease, captureLegacyRecoveryRelease, stageRecoveryRelease, verifyRecoveryReleaseActivation, type RecoveryActivationVerification } from '../../src/runtime/standalone-recovery/installer';
import {
  RECOVERY_AGENT_PROMPT,
  RECOVERY_RELEASE_BINARIES,
  publishRecoveryCompatibilityLinks,
  publishRecoveryRelease,
  readCurrentRecoveryRelease,
  readPreviousRecoveryRelease,
  readRecoveryRelease,
  readRecoveryRuntimeIdentity,
  recoveryIdentityFromExecutable,
  writeRecoveryReleaseManifest,
  writeRecoveryRuntimeIdentity,
  type RecoveryReleaseDescriptor,
} from '../../src/runtime/standalone-recovery/release';

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
  for (const file of ['supervisor.js', 'repo-harness.js', 'daemon.js', 'worker.js', 'process-runner.js', 'browser-handoff-host.js', 'browser-node-bridge-host.js', 'repo-harness-desktop-helper.mjs']) writeFileSync(join(path, file), 'fixture');
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

function publicTunnelVerification(externalOk: boolean): VerifyResult {
  return {
    ok: externalOk,
    at: new Date().toISOString(),
    supervisor: { ok: true, observedState: 'healthy', activeSlot: 'green', previousSlot: 'blue' },
    releases: { coherent: true },
    probes: {
      supervisor_socket: { ok: true, detail: 'status received' },
      stable_ingress: { ok: true, detail: 'HTTP 200', status: 200 },
      active_gateway: { ok: true, detail: 'HTTP 200', status: 200 },
      mcp_initialize: { ok: true, detail: 'MCP initialized' },
      external_mcp_http: externalOk
        ? { ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 }
        : { ok: false, detail: 'HTTP 530', status: 530 },
    },
  };
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

function successfulProcess(stdout = '') {
  return { ok: true, status: 0, signal: null, timedOut: false, command: [], stdout, stderr: '', error: '' };
}

function recoveryReleaseFixture(home: string, name: string, revision: string, legacy = false): RecoveryReleaseDescriptor {
  const releasePath = join(home, 'recovery', 'releases', name);
  mkdirSync(releasePath, { recursive: true, mode: 0o700 });
  const artifacts = {} as Record<(typeof RECOVERY_RELEASE_BINARIES)[number], { sha256: string }>;
  for (const binary of RECOVERY_RELEASE_BINARIES) {
    const content = `${revision}:${binary}`;
    writeFileSync(join(releasePath, binary), content, { mode: 0o700 });
    artifacts[binary] = { sha256: createHash('sha256').update(content).digest('hex') };
  }
  writeRecoveryReleaseManifest(releasePath, {
    schemaVersion: 1,
    releaseRevision: revision,
    sourceCommit: legacy ? 'legacy-unattributed' : revision,
    sourceRoot: home,
    cleanWorkspace: !legacy,
    builtAt: '2026-08-03T00:00:00.000Z',
    ...(legacy ? { legacy: true } : {}),
    artifacts,
  });
  const release = readRecoveryRelease(releasePath);
  if (!release) throw new Error('test recovery release invalid');
  return release;
}

function cleanRecoverySourceRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'recovery-release-source-'));
  mkdirSync(join(root, 'src', 'runtime', 'standalone-recovery'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'recovery', 'prompts'), { recursive: true });
  writeFileSync(join(root, 'src', 'runtime', 'standalone-recovery', 'entry.ts'), 'console.log("fixture")\n');
  writeFileSync(join(root, 'scripts', 'install-standalone-recovery.ts'), '// fixture\n');
  writeFileSync(join(root, 'scripts', 'load-standalone-recovery.sh'), '#!/bin/sh\n');
  writeFileSync(join(root, 'recovery', 'prompts', RECOVERY_AGENT_PROMPT), '# fixed recovery prompt\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'bun.lock'), 'fixture\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Recovery Test', '-c', 'user.email=recovery@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, head };
}

function successfulHandoff() {
  return {
    bootstrapAttempts: 1,
    bootoutClean: true,
    pidWaitClean: true,
    portWaitClean: true,
    plistInstalled: true,
    serviceRegistered: true,
    diagnostics: { bootstrapResults: [], serviceProbeResults: [], pidAliveChecks: [], portChecks: [] },
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
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'bootstrap', 'runtime-config.json'), JSON.stringify({
      schemaVersion: 1,
      controllerHome: realpathSync(home),
      configRevision: 'config-test-1',
      ingress: { host: '127.0.0.1', port },
    }));
    writeFileSync(join(home, 'bootstrap', 'runtime-authority.json'), JSON.stringify({
      schemaVersion: 1,
      authorityTerm: 'term-test-1',
      configRevision: 'config-test-1',
      configHash: createHash('sha256').update(readFileSync(join(home, 'bootstrap', 'runtime-config.json'))).digest('hex'),
      activeSlot: 'blue',
      active: {
        releasePath: realpathSync(active),
        releaseRevision: 'release-active',
        manifestHash: createHash('sha256').update(readFileSync(join(active, 'manifest.json'))).digest('hex'),
      },
    }));
    writeFileSync(join(home, 'bootstrap', 'writer-authority.json'), JSON.stringify({
      schemaVersion: 1,
      activeSlot: 'blue',
      epoch: 'epoch-test-1',
      fencingToken: 'fencing-token-test-1',
    }));
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

  test('refuses directory-only previous releases when active runtime is unavailable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-deadlock-'));
    const active = release(home, 'active', 'release-active');
    const previous = release(home, 'previous', 'release-previous');
    mkdirSync(join(home, 'supervisor'), { recursive: true });
    symlinkSync(active, join(home, 'supervisor', 'current'), 'dir');
    symlinkSync(previous, join(home, 'supervisor', 'previous'), 'dir');
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'bootstrap', 'runtime-config.json'), JSON.stringify({
      schemaVersion: 1,
      controllerHome: realpathSync(home),
      configRevision: 'config-deadlock-1',
    }));
    writeFileSync(join(home, 'bootstrap', 'runtime-authority.json'), JSON.stringify({
      schemaVersion: 1,
      authorityTerm: 'term-deadlock-1',
      configRevision: 'config-deadlock-1',
      configHash: createHash('sha256').update(readFileSync(join(home, 'bootstrap', 'runtime-config.json'))).digest('hex'),
      activeSlot: 'blue',
      active: {
        releasePath: realpathSync(active),
        releaseRevision: 'release-active',
        manifestHash: createHash('sha256').update(readFileSync(join(active, 'manifest.json'))).digest('hex'),
      },
    }));
    writeFileSync(join(home, 'bootstrap', 'writer-authority.json'), JSON.stringify({
      schemaVersion: 1,
      activeSlot: 'blue',
      epoch: 'epoch-deadlock-1',
      fencingToken: 'fencing-token-deadlock-1',
    }));
    const manifestSha256 = createHash('sha256').update(readFileSync(join(previous, 'manifest.json'))).digest('hex');
    mkdirSync(join(home, 'recovery', 'state'), { recursive: true });
    writeFileSync(join(home, 'recovery', 'state', 'known-good.json'), JSON.stringify({
      schemaVersion: 1,
      releases: [{ path: realpathSync(previous), revision: 'release-previous', manifestSha256 }],
      updatedAt: new Date().toISOString(),
    }));
    const result = await rollbackPrevious(createRecoveryConfig(home));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no registered known-good release');
    rmSync(home, { recursive: true, force: true });
  });

  test('requires sustained multi-signal evidence before automatic rollback', () => {
    expect(decideWatchdog({ failures: 1, firstFailureAt: Date.now() - 60_000, evidenceClasses: ['external'], activeKnownGood: false, previousKnownGood: true, operationInFlight: false, rollbackUsed: false }).action).toBe('degraded');
    expect(decideWatchdog({ failures: 6, firstFailureAt: Date.now() - 31_000, evidenceClasses: ['external', 'mcp'], activeKnownGood: false, previousKnownGood: true, operationInFlight: false, rollbackUsed: false }).action).toBe('rollback');
    expect(decideWatchdog({ failures: 6, firstFailureAt: Date.now() - 31_000, evidenceClasses: ['external', 'mcp'], activeKnownGood: true, previousKnownGood: true, operationInFlight: false, rollbackUsed: false }).action).toBe('degraded');
  });

  test('prioritizes configured public tunnel repair over application recovery and defers to Supervisor ownership', () => {
    const input = {
      failures: 0,
      evidenceClasses: ['external'],
      activeKnownGood: false,
      previousKnownGood: true,
      rollbackUsed: false,
      publicTunnelConfigured: true,
      publicTunnelFailed: true,
      publicTunnelFailures: 2,
      publicTunnelFirstFailureAt: Date.now() - 5_001,
    };
    expect(decideWatchdog({ ...input, operationInFlight: false }).action).toBe('repair_public_tunnel');
    expect(decideWatchdog({ ...input, operationInFlight: true }).action).toBe('degraded');
  });

  test('restarts only an explicitly configured public tunnel after local verification passes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-public-tunnel-'));
    const plistPath = join(home, 'com.cloudflare.cloudflared.plist');
    writeFileSync(plistPath, '<plist/>', { mode: 0o600 });
    const config = createRecoveryConfig(home, {
      stableIngressUrl: 'http://127.0.0.1:8765',
      publicMcpUrl: 'https://mcp.example.test/mcp',
      publicTunnelService: {
        platform: 'launchd',
        label: 'com.cloudflare.cloudflared',
        plistPath,
        cooldownMs: 0,
        postRestartVerifyTimeoutMs: 10_000,
      },
    });
    const commands: string[][] = [];
    let externalChecks = 0;
    let clock = 0;
    const result = await repairPublicTunnel(config, {
      platform: 'darwin',
      currentUid: async () => 501,
      verify: async () => publicTunnelVerification(++externalChecks >= 3),
      verifyLocal: async () => publicTunnelVerification(true),
      runCommand: async (_name, args) => {
        commands.push(args);
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      now: () => { clock += 1_000; return clock; },
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: 'gui/501/com.cloudflare.cloudflared' });
    expect(commands).toEqual([
      ['print', 'gui/501/com.cloudflare.cloudflared'],
      ['kickstart', '-k', 'gui/501/com.cloudflare.cloudflared'],
    ]);
    expect(readFileSync(join(home, 'recovery', 'audit', 'recovery.jsonl'), 'utf8')).toContain('public_tunnel_restart_succeeded');
    rmSync(home, { recursive: true, force: true });
  });

  test('refuses tunnel restart when the local runtime is also unhealthy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-public-tunnel-local-failure-'));
    const plistPath = join(home, 'com.cloudflare.cloudflared.plist');
    writeFileSync(plistPath, '<plist/>', { mode: 0o600 });
    const config = createRecoveryConfig(home, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      publicTunnelService: { platform: 'launchd', label: 'com.cloudflare.cloudflared', plistPath },
    });
    let commands = 0;
    const result = await repairPublicTunnel(config, {
      platform: 'darwin',
      currentUid: async () => 501,
      verify: async () => publicTunnelVerification(false),
      verifyLocal: async () => ({ ...publicTunnelVerification(false), probes: { ...publicTunnelVerification(false).probes, stable_ingress: { ok: false, detail: 'connection refused' } } }),
      runCommand: async () => {
        commands += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
    });
    expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(commands).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test('defers tunnel restart while the Supervisor owns an operation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-public-tunnel-operation-'));
    const plistPath = join(home, 'com.cloudflare.cloudflared.plist');
    writeFileSync(plistPath, '<plist/>', { mode: 0o600 });
    mkdirSync(join(home, 'supervisor'), { recursive: true });
    const socket = createSocketServer((client) => client.on('data', () => client.end(`${JSON.stringify({ ok: true, state: { currentOperationId: 'activate-green' } })}\n`)));
    socketServers.push(socket);
    await new Promise<void>((resolveListen, reject) => { socket.once('error', reject); socket.listen(join(home, 'supervisor', 'control.sock'), () => resolveListen()); });
    const config = createRecoveryConfig(home, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      publicTunnelService: { platform: 'launchd', label: 'com.cloudflare.cloudflared', plistPath },
    });
    let commands = 0;
    const result = await repairPublicTunnel(config, {
      platform: 'darwin',
      currentUid: async () => 501,
      verify: async () => publicTunnelVerification(false),
      verifyLocal: async () => publicTunnelVerification(true),
      runCommand: async () => {
        commands += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
    });
    expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(result.detail).toContain('Supervisor operation');
    expect(commands).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test('fails closed for unconfigured or invalid public tunnel services', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-public-tunnel-unconfigured-'));
    const base = {
      publicMcpUrl: 'https://mcp.example.test/mcp',
    };
    let commands = 0;
    const dependencies = {
      platform: 'darwin' as const,
      currentUid: async () => 501,
      verify: async () => publicTunnelVerification(false),
      verifyLocal: async () => publicTunnelVerification(true),
      runCommand: async () => {
        commands += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
    };

    const unconfigured = await repairPublicTunnel(createRecoveryConfig(home, base), dependencies);
    expect(unconfigured).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(unconfigured.detail).toContain('not configured');

    const invalid = await repairPublicTunnel(createRecoveryConfig(home, {
      ...base,
      publicTunnelService: { platform: 'launchd', label: 'cloudflared' },
    }), dependencies);
    expect(invalid).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(invalid.detail).toContain('invalid or unavailable');
    expect(commands).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test('enforces public tunnel repair cooldown without invoking launchctl', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-public-tunnel-cooldown-'));
    const plistPath = join(home, 'com.cloudflare.cloudflared.plist');
    writeFileSync(plistPath, '<plist/>', { mode: 0o600 });
    const config = createRecoveryConfig(home, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      publicTunnelService: {
        platform: 'launchd',
        label: 'com.cloudflare.cloudflared',
        plistPath,
        cooldownMs: 60_000,
      },
    });
    const stateDir = join(home, 'recovery', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'public-tunnel-repair.json'), `${JSON.stringify({ lastAttemptAt: 10_000 })}\n`, { mode: 0o600 });
    let commands = 0;
    const result = await repairPublicTunnel(config, {
      platform: 'darwin',
      currentUid: async () => 501,
      verify: async () => publicTunnelVerification(false),
      verifyLocal: async () => publicTunnelVerification(true),
      runCommand: async () => {
        commands += 1;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      now: () => 20_000,
    });
    expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(result.detail).toContain('cooldown');
    expect(commands).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test('reports launchctl failure and an unverified post-restart tunnel', async () => {
    const failedHome = mkdtempSync(join(tmpdir(), 'standalone-recovery-public-tunnel-kickstart-failure-'));
    const failedPlist = join(failedHome, 'com.cloudflare.cloudflared.plist');
    writeFileSync(failedPlist, '<plist/>', { mode: 0o600 });
    const failedConfig = createRecoveryConfig(failedHome, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      publicTunnelService: {
        platform: 'launchd',
        label: 'com.cloudflare.cloudflared',
        plistPath: failedPlist,
        cooldownMs: 0,
      },
    });
    const failed = await repairPublicTunnel(failedConfig, {
      platform: 'darwin',
      currentUid: async () => 501,
      verify: async () => publicTunnelVerification(false),
      verifyLocal: async () => publicTunnelVerification(true),
      runCommand: async (_name, args) => args[0] === 'kickstart'
        ? { ok: false, status: 1, stdout: '', stderr: 'simulated kickstart failure' }
        : { ok: true, status: 0, stdout: '', stderr: '' },
    });
    expect(failed).toMatchObject({ ok: false, attempted: true });
    expect(failed.detail).toContain('launchd kickstart failed');
    expect(readFileSync(join(failedHome, 'recovery', 'audit', 'recovery.jsonl'), 'utf8')).toContain('public_tunnel_restart_failed');

    const timeoutHome = mkdtempSync(join(tmpdir(), 'standalone-recovery-public-tunnel-unverified-'));
    const timeoutPlist = join(timeoutHome, 'com.cloudflare.cloudflared.plist');
    writeFileSync(timeoutPlist, '<plist/>', { mode: 0o600 });
    const timeoutConfig = createRecoveryConfig(timeoutHome, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      publicTunnelService: {
        platform: 'launchd',
        label: 'com.cloudflare.cloudflared',
        plistPath: timeoutPlist,
        cooldownMs: 0,
        postRestartVerifyTimeoutMs: 2_000,
      },
    });
    let clock = 0;
    const unverified = await repairPublicTunnel(timeoutConfig, {
      platform: 'darwin',
      currentUid: async () => 501,
      verify: async () => publicTunnelVerification(false),
      verifyLocal: async () => publicTunnelVerification(true),
      runCommand: async () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
      now: () => { clock += 1_000; return clock; },
      sleep: async () => {},
    });
    expect(unverified).toMatchObject({ ok: false, attempted: true });
    expect(unverified.detail).toContain('did not recover before timeout');
    expect(readFileSync(join(timeoutHome, 'recovery', 'audit', 'recovery.jsonl'), 'utf8')).toContain('public_tunnel_restart_unverified');

    rmSync(failedHome, { recursive: true, force: true });
    rmSync(timeoutHome, { recursive: true, force: true });
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

  test('deduplicates cross-session Supervisor recovery and preserves a live global owner lock', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-singleflight-'));
    const active = release(home, 'active', 'release-active');
    const port = await http((_request, response) => { response.end(JSON.stringify({ status: 'ok' })); });
    mkdirSync(join(home, 'runtime-slots', 'blue'), { recursive: true });
    writeFileSync(join(home, 'runtime-slots', 'blue', 'slot.json'), JSON.stringify({ releasePath: active }));
    const socket = createSocketServer((client) => client.on('data', () => client.end(`${JSON.stringify({ ok: true, state: { observedState: 'healthy', activeSlot: 'blue', ingress: { state: 'running', activeUpstreamPort: port }, gatewayHost: { releasePath: active, releaseRevision: 'release-active' }, controllerDaemon: { releasePath: active, releaseRevision: 'release-active' }, supervisor: { pid: process.pid, releasePath: active, releaseRevision: 'release-active' } } })}\n`)));
    socketServers.push(socket); mkdirSync(join(home, 'supervisor'), { recursive: true });
    await new Promise<void>((resolveListen, reject) => { socket.once('error', reject); socket.listen(join(home, 'supervisor', 'control.sock'), () => resolveListen()); });
    const config = createRecoveryConfig(home, { stableIngressUrl: `http://127.0.0.1:${port}` });
    const first = await restartSupervisor(config, 'same-restart-request');
    const repeated = await restartSupervisor(config, 'same-restart-request');
    const afterHealthy = await restartSupervisor(config, 'different-restart-request');
    expect(first.noOp).toBe(true); expect(repeated.reused).toBe(true); expect(afterHealthy.noOp).toBe(true);
    const lock = join(home, 'recovery', 'locks', 'operation.lock');
    mkdirSync(join(home, 'recovery', 'locks'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, instanceId: 'other-session', acquiredAt: new Date(0).toISOString(), action: 'restart_supervisor', requestId: 'other-session-request' }));
    const busy = await restartSupervisor(config, 'busy-restart-request');
    expect(busy.inProgress).toBe(true); expect(busy.activeRequestId).toBe('other-session-request');
    expect((JSON.parse(readFileSync(lock, 'utf8')) as { instanceId: string }).instanceId).toBe('other-session');
    rmSync(home, { recursive: true, force: true });
  });

  test('persists watchdog failure windows and restart decisions across process restarts', () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-watchdog-state-'));
    try {
      const config = createRecoveryConfig(home);
      const saved = saveWatchdogState(config, {
        failures: 7,
        firstFailureAt: 1234,
        rollbackUsed: true,
        publicTunnelFailures: 3,
        publicTunnelRepairFailures: 2,
        recoveryGatewayRestartUsed: true,
        lastDecision: 'degraded',
      });
      expect(saved.updatedAt).toBeString();
      expect(loadWatchdogState(config)).toEqual(saved);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('restarts the independent Recovery Gateway before touching primary runtime recovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-gateway-self-heal-'));
    try {
      const label = 'com.moretea.repo-harness-recovery-gateway';
      const plist = join(home, 'recovery', 'launchd', `${label}.plist`);
      mkdirSync(dirname(plist), { recursive: true });
      writeFileSync(plist, '<plist/>', { mode: 0o600 });
      const config = initializeStandaloneRecovery(home, 8787);
      const commands: string[][] = [];
      let probes = 0;
      let clock = 0;
      const result = await restartRecoveryGateway(config, {
        platform: 'darwin',
        currentUid: async () => 501,
        probeGateway: async () => ({ ok: ++probes >= 3, detail: probes >= 3 ? 'healthy' : 'connection refused' }),
        runCommand: async (_command, args) => { commands.push(args); return { ok: true, status: 0, stdout: '', stderr: '' }; },
        now: () => { clock += 1_000; return clock; },
        sleep: async () => {},
      });
      expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: `gui/501/${label}` });
      expect(commands).toEqual([['print', `gui/501/${label}`], ['kickstart', '-k', `gui/501/${label}`]]);
      expect(readFileSync(join(home, 'recovery', 'audit', 'recovery.jsonl'), 'utf8')).toContain('recovery_gateway_restart_succeeded');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('uses the PI agent only when explicitly enabled with an active manifest-bound prompt and cooldown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-pi-agent-'));
    try {
      const releasePath = join(home, 'recovery', 'releases', 'agent-release');
      const repoRoot = join(home, 'repair-worktree');
      mkdirSync(releasePath, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      const prompt = '# immutable PI repair prompt\n';
      const promptPath = join(releasePath, RECOVERY_AGENT_PROMPT);
      writeFileSync(promptPath, prompt, { mode: 0o400 });
      writeFileSync(join(releasePath, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        resources: { [RECOVERY_AGENT_PROMPT]: { sha256: createHash('sha256').update(prompt).digest('hex') } },
      }));
      symlinkSync(join('releases', 'agent-release'), join(home, 'recovery', 'current'), 'dir');
      const config = createRecoveryConfig(home, {
        agentRepair: {
          enabled: true,
          command: 'pi',
          promptFile: join(home, 'recovery', 'current', RECOVERY_AGENT_PROMPT),
          repoRoot,
          cooldownMs: 60_000,
        },
      });
      const invocations: Array<{ command: string; args: string[]; cwd: string }> = [];
      const first = await runAgentRepair(config, publicTunnelVerification(false), {
        now: () => 100_000,
        runCommand: async (command, args, _timeout, cwd) => {
          invocations.push({ command, args, cwd });
          return { ok: true, status: 0, stdout: 'repaired', stderr: '' };
        },
      });
      expect(first).toMatchObject({ ok: true, attempted: true, status: 0 });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.command).toBe('pi');
      expect(invocations[0]?.cwd).toBe(realpathSync(repoRoot));
      expect(invocations[0]?.args.slice(0, 2)).toEqual(['-p', `@${realpathSync(promptPath)}`]);
      expect(invocations[0]?.args.at(-1)).toContain('exhausted bounded restart/tunnel/rollback paths');
      const repeated = await runAgentRepair(config, publicTunnelVerification(false), {
        now: () => 120_000,
        runCommand: async () => { throw new Error('cooldown must suppress PI'); },
      });
      expect(repeated).toMatchObject({ ok: false, attempted: false, noOp: true });
      expect(repeated.detail).toContain('cooldown');
      expect(readFileSync(join(home, 'recovery', 'audit', 'recovery.jsonl'), 'utf8')).not.toContain('repaired');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps PI disabled by default and orders local Recovery restart before rollback or agent repair', async () => {
    const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-pi-disabled-'));
    try {
      const disabled = await runAgentRepair(createRecoveryConfig(home), publicTunnelVerification(false));
      expect(disabled).toMatchObject({ ok: false, attempted: false, noOp: true });
      expect(decideWatchdog({
        failures: 2,
        firstFailureAt: Date.now() - 6_000,
        evidenceClasses: ['recovery_gateway'],
        activeKnownGood: true,
        previousKnownGood: true,
        operationInFlight: false,
        rollbackUsed: false,
        recoveryGatewayFailed: true,
      }).action).toBe('restart_recovery_gateway');
      expect(decideWatchdog({
        failures: 12,
        firstFailureAt: Date.now() - 121_000,
        evidenceClasses: [],
        activeKnownGood: false,
        previousKnownGood: true,
        operationInFlight: false,
        rollbackUsed: false,
        recoveryGatewayRestartUsed: true,
        agentRepairEnabled: true,
        agentRepairCooldownElapsed: true,
      }).action).toBe('run_agent_repair');
      expect(decideWatchdog({
        failures: 12,
        firstFailureAt: Date.now() - 121_000,
        evidenceClasses: [],
        activeKnownGood: false,
        previousKnownGood: true,
        operationInFlight: true,
        rollbackUsed: false,
        publicTunnelConfigured: true,
        publicTunnelFailed: true,
        publicTunnelFailures: 12,
        publicTunnelFirstFailureAt: Date.now() - 121_000,
        publicTunnelRepairFailures: 2,
        agentRepairEnabled: true,
        agentRepairCooldownElapsed: true,
      }).action).toBe('degraded');
      expect(decideWatchdog({
        failures: 12,
        firstFailureAt: Date.now() - 121_000,
        evidenceClasses: [],
        activeKnownGood: false,
        previousKnownGood: true,
        operationInFlight: false,
        rollbackUsed: false,
        recoveryGatewayFailed: true,
        recoveryGatewayRestartUsed: true,
      }).action).not.toBe('rollback');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

describe('immutable standalone Recovery releases', () => {
  test('detects compiled role binaries from the executable path rather than argv metadata', () => {
    expect(recoveryRuntimeRoleFromExecutable('/tmp/repo-harness-recovery')).toBeUndefined();
    expect(recoveryRuntimeRoleFromExecutable('/tmp/repo-harness-recovery-gateway')).toBe('gateway');
    expect(recoveryRuntimeRoleFromExecutable('/tmp/repo-harness-recovery-watchdog')).toBe('watchdog');
  });

  test('stages one exact clean revision with complete binary hashes and no staging residue', () => {
    const source = cleanRecoverySourceRepo();
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-stage-'));
    try {
      const canaries: Array<{ binary: string; role?: string }> = [];
      const staged = stageRecoveryRelease({ controllerHome: home, sourceRoot: source.root }, {
        now: () => 1000,
        uuid: () => 'stage-test-uuid',
        compileBinary: ({ outputPath }) => {
          writeFileSync(outputPath, 'compiled recovery fixture', { mode: 0o700 });
          return successfulProcess('built');
        },
        runCanary: ({ binaryPath, role }) => {
          canaries.push({ binary: basename(binaryPath), role });
          return successfulProcess('{"status":"ok"}');
        },
      });
      expect(canaries).toEqual([
        { binary: 'repo-harness-recovery', role: undefined },
        { binary: 'repo-harness-recovery-gateway', role: 'gateway' },
        { binary: 'repo-harness-recovery-watchdog', role: 'watchdog' },
      ]);
      expect(staged.release.releaseRevision).toBe(source.head);
      expect(staged.release.sourceCommit).toBe(source.head);
      expect(staged.release.cleanWorkspace).toBe(true);
      expect(Object.keys(staged.release.artifacts).sort()).toEqual([...RECOVERY_RELEASE_BINARIES].sort());
      expect(staged.release.resources[RECOVERY_AGENT_PROMPT]?.sha256).toBe(createHash('sha256').update('# fixed recovery prompt\n').digest('hex'));
      expect(readFileSync(join(staged.release.releasePath, RECOVERY_AGENT_PROMPT), 'utf8')).toBe('# fixed recovery prompt\n');
      expect(readdirSync(join(home, 'recovery', 'releases')).some((entry) => entry.startsWith('.staging-'))).toBe(false);
      writeFileSync(join(source.root, 'scripts', 'load-standalone-recovery.sh'), '# dirty\n');
      expect(() => stageRecoveryRelease({ controllerHome: home, sourceRoot: source.root }, {
        compileBinary: () => successfulProcess(),
        runCanary: () => successfulProcess(),
      })).toThrow('RECOVERY_RELEASE_DIRTY_SOURCE');
    } finally {
      rmSync(source.root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('captures flat binaries as an exact legacy release before first activation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-legacy-'));
    try {
      const binRoot = join(home, 'recovery', 'bin');
      mkdirSync(binRoot, { recursive: true });
      for (const binary of RECOVERY_RELEASE_BINARIES) writeFileSync(join(binRoot, binary), `legacy:${binary}`, { mode: 0o700 });
      const candidate = recoveryReleaseFixture(home, 'candidate', 'candidate-revision');
      const lockPath = join(home, 'recovery', 'locks', 'operation.lock');
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: 999999, instanceId: 'dead-installer', acquiredAt: new Date(0).toISOString() }));
      const config = createRecoveryConfig(home, { gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: join(home, 'token.json') } });
      const activated = await activateRecoveryRelease({ controllerHome: home, config, candidate }, {
        uid: () => 501,
        currentPid: () => undefined,
        installAgent: (sourcePath) => ({ path: sourcePath }),
        handoff: async () => successfulHandoff(),
        verify: async ({ expectedRelease }): Promise<RecoveryActivationVerification> => ({
          ok: true,
          expectedReleaseRevision: expectedRelease.releaseRevision,
          failures: [],
          gatewayPid: 100,
          watchdogPid: 101,
          healthStatus: 200,
        }),
      });
      expect(activated.migratedLegacy?.legacy).toBe(true);
      expect(activated.migratedLegacy?.sourceRoot).toBe(activated.migratedLegacy?.releasePath);
      expect(readdirSync(dirname(lockPath)).some((name) => name.includes('stale-') && name.includes('dead-installer'))).toBe(true);
      expect(readCurrentRecoveryRelease(home)?.releaseRevision).toBe('candidate-revision');
      expect(readPreviousRecoveryRelease(home)?.releaseRevision).toBe(activated.migratedLegacy?.releaseRevision);
      for (const binary of RECOVERY_RELEASE_BINARIES) {
        expect(realpathSync(join(binRoot, binary))).toBe(join(candidate.releasePath, binary));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no-ops a repeated activation with the same healthy release payload', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-repeat-noop-'));
    try {
      const current = recoveryReleaseFixture(home, 'current-release', 'same-revision');
      const candidate = recoveryReleaseFixture(home, 'candidate-release', 'same-revision');
      publishRecoveryRelease(home, current.releasePath);
      publishRecoveryCompatibilityLinks(home);
      let handoffs = 0;
      const result = await activateRecoveryRelease({ controllerHome: home, config: createRecoveryConfig(home), candidate }, {
        uid: () => 501,
        installAgent: (sourcePath) => ({ path: sourcePath }),
        handoff: async () => { handoffs += 1; return successfulHandoff(); },
        verify: async ({ expectedRelease }) => ({
          ok: true,
          expectedReleaseRevision: expectedRelease.releaseRevision,
          failures: [],
          gatewayPid: 300,
          watchdogPid: 301,
          healthStatus: 200,
        }),
      });
      expect(result.noOp).toBe(true);
      expect(handoffs).toBe(0);
      expect(result.release.releasePath).toBe(current.releasePath);
      expect(readCurrentRecoveryRelease(home)?.releasePath).toBe(current.releasePath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('strict verification binds role identity PIDs to launchd service PIDs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-launchd-pid-'));
    const release = recoveryReleaseFixture(home, 'current-release', 'current-revision');
    publishRecoveryRelease(home, release.releasePath);
    publishRecoveryCompatibilityLinks(home);
    writeRecoveryRuntimeIdentity(home, 'gateway', join(release.releasePath, 'repo-harness-recovery-gateway'));
    writeRecoveryRuntimeIdentity(home, 'watchdog', join(release.releasePath, 'repo-harness-recovery-watchdog'));
    const port = await http((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        status: 'ok',
        releaseRevision: release.releaseRevision,
        manifestSha256: release.manifestSha256,
      }));
    });
    try {
      const verification = await verifyRecoveryReleaseActivation({
        controllerHome: home,
        config: createRecoveryConfig(home, { gateway: { host: '127.0.0.1', port, bearerTokenFile: join(home, 'token.json') } }),
        expectedRelease: release,
        timeoutMs: 10,
      }, {
        servicePid: (_controllerHome, role) => role === 'gateway' ? process.pid : process.pid + 1,
      });
      expect(verification.ok).toBe(false);
      expect(verification.failures).toContain('watchdog runtime identity PID does not match launchd PID');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('restores the exact previous release when candidate verification fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-rollback-'));
    try {
      const previous = recoveryReleaseFixture(home, 'previous', 'previous-revision');
      const candidate = recoveryReleaseFixture(home, 'candidate', 'candidate-revision');
      publishRecoveryRelease(home, previous.releasePath);
      publishRecoveryCompatibilityLinks(home);
      const config = createRecoveryConfig(home, { gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: join(home, 'token.json') } });
      const verified: string[] = [];
      let handoffs = 0;
      await expect(activateRecoveryRelease({ controllerHome: home, config, candidate }, {
        uid: () => 501,
        currentPid: () => undefined,
        installAgent: (sourcePath) => ({ path: sourcePath }),
        handoff: async () => { handoffs += 1; return successfulHandoff(); },
        verify: async ({ expectedRelease }): Promise<RecoveryActivationVerification> => {
          verified.push(expectedRelease.releaseRevision);
          return {
            ok: expectedRelease.releaseRevision === 'previous-revision',
            expectedReleaseRevision: expectedRelease.releaseRevision,
            failures: expectedRelease.releaseRevision === 'previous-revision' ? [] : ['candidate identity mismatch'],
            gatewayPid: 200,
            watchdogPid: 201,
            healthStatus: 200,
          };
        },
      })).rejects.toThrow('RECOVERY_RELEASE_ACTIVATION_FAILED_ROLLED_BACK');
      expect(handoffs).toBe(4);
      expect(verified).toEqual(['candidate-revision', 'previous-revision']);
      expect(readCurrentRecoveryRelease(home)?.releaseRevision).toBe('previous-revision');
      expect(readPreviousRecoveryRelease(home)?.releaseRevision).toBe('candidate-revision');
      expect(existsSync(join(home, 'recovery', 'locks', 'operation.lock'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('preserves a live Recovery release activation owner across sessions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-live-lock-'));
    try {
      const candidate = recoveryReleaseFixture(home, 'candidate', 'candidate-revision');
      const lockPath = join(home, 'recovery', 'locks', 'operation.lock');
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instanceId: 'live-installer', acquiredAt: new Date(0).toISOString() }));
      await expect(activateRecoveryRelease({ controllerHome: home, config: createRecoveryConfig(home), candidate }, {
        uid: () => 501,
        handoff: async () => successfulHandoff(),
        installAgent: (sourcePath) => ({ path: sourcePath }),
        verify: async ({ expectedRelease }) => ({ ok: true, expectedReleaseRevision: expectedRelease.releaseRevision, failures: [] }),
      })).rejects.toThrow('RECOVERY_OPERATION_LOCK_BUSY');
      expect((JSON.parse(readFileSync(lockPath, 'utf8')) as { instanceId: string }).instanceId).toBe('live-installer');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('refuses current authority outside the canonical Recovery releases root', () => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-contained-'));
    const outside = mkdtempSync(join(tmpdir(), 'recovery-release-outside-'));
    try {
      const external = recoveryReleaseFixture(outside, 'external', 'external-revision');
      expect(() => publishRecoveryRelease(home, external.releasePath)).toThrow('RECOVERY_RELEASE_OUTSIDE_AUTHORITY');
      expect(() => publishRecoveryCompatibilityLinks(home)).toThrow('RECOVERY_CURRENT_RELEASE_INVALID');
      mkdirSync(join(home, 'recovery'), { recursive: true });
      symlinkSync(external.releasePath, join(home, 'recovery', 'current'), 'dir');
      expect(() => publishRecoveryCompatibilityLinks(home)).toThrow('RECOVERY_RELEASE_OUTSIDE_AUTHORITY');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('derives and persists Gateway runtime identity from the immutable executable', () => {
    const home = mkdtempSync(join(tmpdir(), 'recovery-release-identity-'));
    try {
      const release = recoveryReleaseFixture(home, 'identity', 'identity-revision');
      const executable = join(release.releasePath, 'repo-harness-recovery-gateway');
      expect(recoveryIdentityFromExecutable(executable)).toMatchObject({
        releasePath: release.releasePath,
        releaseRevision: 'identity-revision',
        manifestSha256: release.manifestSha256,
      });
      const written = writeRecoveryRuntimeIdentity(home, 'gateway', executable);
      expect(written?.pid).toBe(process.pid);
      expect(readRecoveryRuntimeIdentity(home, 'gateway')).toEqual(written);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
