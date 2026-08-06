import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  attestKnownGood,
  createRecoveryConfig,
  decideWatchdog,
  initializeStandaloneRecovery,
  listReleases,
  restartRecoveryGateway,
  rollbackPrevious,
  runtimeStatus,
  verifyStableRuntime,
  type VerifyResult,
} from '../../src/runtime/standalone-recovery/core';
import {
  dispatchRecoveryTool,
  RECOVERY_CLI_COMMANDS,
  RECOVERY_TOOLS,
} from '../../src/runtime/standalone-recovery/entry';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { acquireRuntimeOwnership, type RuntimeOwnershipHandle } from '../../src/runtime/root/ownership';
import {
  ensureActiveRuntimeRelease,
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
} from '../../src/runtime/root/release-store';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';

const roots: string[] = [];
const servers: Server[] = [];
const ownerships: RuntimeOwnershipHandle[] = [];

afterEach(async () => {
  while (ownerships.length > 0) ownerships.pop()!.release();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function controllerHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-canonical-'));
  roots.push(home);
  inspectControlPlaneDatabase(home);
  return home;
}

function manifest(home: string, releaseId: string, artifactIdentity: string, workerProtocolVersion = 1): string {
  const path = join(home, 'manifests', `${releaseId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'repo-harness-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: resolve(home),
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return path;
}

function diagnostics() {
  return {
    database: { outcome: 'pass' as const },
    scheduler: { outcome: 'pass' as const },
    releaseCoherence: { outcome: 'pass' as const },
    mcpEndToEnd: { outcome: 'pass' as const },
  };
}

async function runtimeServer(): Promise<{ port: number; endpoint: string }> {
  const sessionId = 'recovery-runtime-session';
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url === '/health') {
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
    if (request.method === 'DELETE' && request.url === '/mcp') {
      response.statusCode = request.headers['mcp-session-id'] === sessionId ? 204 : 404;
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.statusCode = 404;
      response.end();
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      const rpc = JSON.parse(body) as { id?: number; method: string };
      if (rpc.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', sessionId);
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } }));
        return;
      }
      if (request.headers['mcp-session-id'] !== sessionId) {
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
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('runtime test server unavailable');
  return { port: address.port, endpoint: `http://127.0.0.1:${address.port}/mcp` };
}

function writeMainToken(home: string): void {
  const path = join(home, 'mcp', 'mcp.tokens.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ bearerToken: 't'.repeat(32) }));
}

function startObservedRuntime(home: string, endpoint: string, releaseId: string, artifactIdentity: string): RuntimeOwnershipHandle {
  const runtimeInstanceId = `runtime-${releaseId}`;
  const ownership = acquireRuntimeOwnership(home, runtimeInstanceId);
  ownerships.push(ownership);
  writeRuntimeStatusSnapshot(home, {
    schemaVersion: 1,
    runtimeInstanceId,
    pid: process.pid,
    releaseId,
    artifactIdentity,
    endpoint,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    updatedAt: new Date().toISOString(),
    readiness: {
      ready: true,
      reasonCodes: [],
      diagnostics: diagnostics(),
      observedAt: new Date().toISOString(),
    },
  });
  return ownership;
}

function removeOwnership(handle: RuntimeOwnershipHandle): void {
  handle.release();
  const index = ownerships.indexOf(handle);
  if (index >= 0) ownerships.splice(index, 1);
}

function healthyVerify(): VerifyResult {
  return {
    ok: true,
    at: new Date().toISOString(),
    runtime: { ok: true, running: true, ready: true, stale: false, reasonCodes: [] },
    releases: { coherent: true },
    probes: {
      runtime_status: { ok: true, detail: 'live' },
      active_gateway: { ok: true, detail: 'HTTP 200' },
      mcp_initialize: { ok: true, detail: 'HTTP 200' },
    },
  };
}

describe('standalone recovery on canonical Runtime', () => {
  test('verifies and attests the single active whole-Runtime release', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-a', 'artifact-a');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });

    const verified = await verifyStableRuntime(config);
    expect(verified.ok).toBe(true);
    expect(verified.runtime).toMatchObject({ running: true, ready: true, stale: false });
    expect(verified.releases).toMatchObject({ active: { revision: 'release-a', artifactIdentity: 'artifact-a' }, coherent: true });

    const attested = await attestKnownGood(config);
    expect(attested).toMatchObject({ revision: 'release-a', artifactIdentity: 'artifact-a', controllerHome: resolve(home) });
    expect(attested.releaseAuthorityRevision).toBe(1);
    expect(attested.releaseFencingTokenSha256).toHaveLength(64);

    const listed = await listReleases(config) as { runtimeRunning: boolean; runtimeReady: boolean; knownGood: Array<{ revision: string }> };
    expect(listed.runtimeRunning).toBe(true);
    expect(listed.runtimeReady).toBe(true);
    expect(listed.knownGood.map((entry) => entry.revision)).toContain('release-a');

    expect(await runtimeStatus(config)).toMatchObject({ running: true, ready: true });
    expect(await dispatchRecoveryTool(config, 'runtime_status', {})).toMatchObject({ running: true, ready: true });
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('runtime_status');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).not.toContain('supervisor_status');
    expect(RECOVERY_CLI_COMMANDS).toContain('list-releases');
  });

  test('restores only the attested previous whole-Runtime release while Runtime is stopped', async () => {
    const home = controllerHome();
    const first = manifest(home, 'release-a', 'artifact-a');
    const second = manifest(home, 'release-b', 'artifact-b', 2);
    ensureActiveRuntimeRelease(home, first);
    const runtime = await runtimeServer();
    writeMainToken(home);
    const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    await attestKnownGood(config);
    removeOwnership(ownership);

    publishRuntimeRelease(home, second, 'publish-release-b');
    const rolled = await rollbackPrevious(config, 'test rollback');
    expect(rolled.ok).toBe(true);
    expect(rolled.detail).toContain('SQLite backup restored');
    expect(readRuntimeReleaseAuthority(home)).toMatchObject({
      revision: 3,
      active: { releaseId: 'release-a', artifactIdentity: 'artifact-a' },
      previous: { releaseId: 'release-b', artifactIdentity: 'artifact-b' },
    });
  });

  test('refuses rollback while the canonical Runtime owner is live', async () => {
    const home = controllerHome();
    const first = manifest(home, 'release-a', 'artifact-a');
    const second = manifest(home, 'release-b', 'artifact-b');
    ensureActiveRuntimeRelease(home, first);
    const runtime = await runtimeServer();
    writeMainToken(home);
    const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    await attestKnownGood(config);
    removeOwnership(ownership);
    publishRuntimeRelease(home, second, 'publish-release-b');
    startObservedRuntime(home, runtime.endpoint, 'release-b', 'artifact-b');

    const result = await rollbackPrevious(config);
    expect(result.ok).toBe(false);
    expect(result.noOp).toBe(true);
    expect(result.detail).toContain('stop the complete Canonical Runtime');
  });

  test('requires sustained independent evidence before whole-Runtime rollback', () => {
    expect(decideWatchdog({
      failures: 5,
      firstFailureAt: Date.now() - 60_000,
      evidenceClasses: ['runtime', 'mcp'],
      activeKnownGood: false,
      previousKnownGood: true,
      rollbackUsed: false,
    }).action).toBe('degraded');
    expect(decideWatchdog({
      failures: 6,
      firstFailureAt: Date.now() - 31_000,
      evidenceClasses: ['runtime', 'mcp'],
      activeKnownGood: false,
      previousKnownGood: true,
      rollbackUsed: false,
    }).action).toBe('rollback');
  });

  test('restarts only the independent Recovery Gateway through its own bounded lock', async () => {
    const home = controllerHome();
    const config = initializeStandaloneRecovery(home, 8787);
    const plist = join(home, 'recovery', 'launchd', 'com.moretea.repo-harness-recovery-gateway.plist');
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, '<plist/>');
    let probes = 0;
    const commands: string[][] = [];
    const result = await restartRecoveryGateway(config, {
      platform: 'darwin',
      currentUid: async () => 501,
      runCommand: async (_command, args) => {
        commands.push(args);
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      probeGateway: async () => ({ ok: ++probes >= 3, detail: probes >= 3 ? 'healthy' : 'unavailable' }),
      now: (() => { let now = 0; return () => now += 1_000; })(),
      sleep: async () => undefined,
    });
    expect(result).toMatchObject({ ok: true, attempted: true });
    expect(commands.some((args) => args.includes('kickstart'))).toBe(true);
  });

  test('keeps watchdog state decisions independent from any Supervisor operation field', () => {
    const base = healthyVerify();
    expect(base).not.toHaveProperty('supervisor');
    expect(decideWatchdog({
      failures: 0,
      evidenceClasses: [],
      activeKnownGood: true,
      previousKnownGood: true,
      rollbackUsed: false,
    })).toEqual({ action: 'healthy', reason: 'all recovery probes healthy' });
  });
});
