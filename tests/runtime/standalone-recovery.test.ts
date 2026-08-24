import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  activateRuntimeRelease,
  attestKnownGood,
  createRecoveryConfig,
  decideWatchdog,
  initializeStandaloneRecovery,
  loadRecoveryConfig,
  recoveryConfigPath,
  listReleases,
  recoverPrimaryRuntime,
  recordWatchdogRuntimeHealthy,
  restartPrimaryConnector,
  restartPrimaryRuntime,
  restartRecoveryGateway,
  restartRecoveryWatchdog,
  scopeWatchdogStateToRuntimeRelease,
  stageAndActivateConfiguredRuntimeRelease,
  rollbackPrevious,
  runtimeStatus,
  runtimeWithinWatchdogStartupGrace,
  WATCHDOG_RUNTIME_RESTART_BUDGET_STABLE_MS,
  watchdogRuntimeRestartBudgetStableMs,
  watchdogRuntimeStartupGraceMs,
  verifyStableRuntime,
  watchdogTick,
  type VerifyResult,
} from '../../src/runtime/standalone-recovery/core';
import {
  dispatchRecoveryTool,
  RECOVERY_CLI_COMMANDS,
  RECOVERY_TOOLS,
  recoveryUnauthorizedBody,
  recoveryWwwAuthenticate,
  resetWatchdogStateForRecoveryRelease,
} from '../../src/runtime/standalone-recovery/entry';
import {
  evaluateRecoveryWatchdogHealth,
  RECOVERY_WATCHDOG_MAX_TICK_AGE_MS,
} from '../../src/runtime/standalone-recovery/watchdog-heartbeat';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { acquireRuntimeOwnership, type RuntimeOwnershipHandle } from '../../src/runtime/root/ownership';
import {
  ensureActiveRuntimeRelease,
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
} from '../../src/runtime/root/release-store';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureForgeRuntimeLaunchAgentContract, forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { recoveryConnectorDescriptor } from '../../src/cli/commands/recovery';
import { ensureMcpControllerHomeOAuthPassphrase } from '../../src/cli/mcp/auth';
import { inspectPrimaryConnectorLaunchdContract, inspectPrimaryPublicTunnelLaunchdContract, inspectRecoveryTunnelLaunchdContract, retireStaleRecoveryLaunchAgents } from '../../src/runtime/standalone-recovery/installer';

const roots: string[] = [];
const servers: Server[] = [];
const ownerships: RuntimeOwnershipHandle[] = [];

interface RuntimeRequestRecord {
  method?: string;
  url?: string;
  authorizationPresent: boolean;
  accept?: string;
  contentType?: string;
  body: string;
}

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

function repoLocalControllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'standalone-recovery-repo-local-'));
  roots.push(root);
  const home = join(root, '_ops', 'controller-home');
  mkdirSync(home, { recursive: true });
  inspectControlPlaneDatabase(home);
  return home;
}

function runtimeServiceConfig(home: string): void {
  const paths = forgeRuntimeServicePaths(home);
  const repositoryRoot = join(home, 'runtime-source');
  const authTokenFile = join(home, 'mcp', 'runtime-token');
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(dirname(authTokenFile), { recursive: true });
  writeFileSync(authTokenFile, 'test-token\n');
  mkdirSync(paths.serviceRoot, { recursive: true });
  writeFileSync(paths.configPath, `${JSON.stringify({
    schemaVersion: 1,
    controllerHome: resolve(home),
    repositoryRoot,
    host: '127.0.0.1',
    port: 8765,
    authTokenFile,
  }, null, 2)}\n`);
}

function manifest(home: string, releaseId: string, artifactIdentity: string, workerProtocolVersion = 1): string {
  const releaseRoot = join(home, 'runtime', 'releases', releaseId);
  const path = join(releaseRoot, 'manifest.json');
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(join(releaseRoot, 'forge-runtime'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: resolve(home),
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return path;
}

function verifiedManifest(home: string, releaseId: string, runtimeMarker = releaseId): { path: string; artifactIdentity: string } {
  const releaseRoot = join(home, 'runtime', 'releases', releaseId);
  const path = join(releaseRoot, 'manifest.json');
  mkdirSync(releaseRoot, { recursive: true });
  const binaryPath = join(releaseRoot, 'forge-runtime');
  writeFileSync(binaryPath, `#!/bin/sh\n# ${runtimeMarker}\nexit 0\n`, { mode: 0o700 });
  const artifactIdentity = `sha256:${createHash('sha256').update(readFileSync(binaryPath)).digest('hex')}`;
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: resolve(home),
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return { path, artifactIdentity };
}

function diagnostics() {
  return {
    database: { outcome: 'pass' as const },
    scheduler: { outcome: 'pass' as const },
    releaseCoherence: { outcome: 'pass' as const },
    mcpEndToEnd: { outcome: 'pass' as const },
  };
}

async function runtimeServer(options: { challengeUnauthenticatedMcp?: boolean } = {}): Promise<{ port: number; endpoint: string; requests: RuntimeRequestRecord[] }> {
  const sessionId = 'recovery-runtime-session';
  const requests: RuntimeRequestRecord[] = [];
  const record = (request: IncomingMessage, body = '') => requests.push({
    method: request.method,
    url: request.url,
    authorizationPresent: typeof request.headers.authorization === 'string',
    accept: request.headers.accept,
    contentType: request.headers['content-type'],
    body,
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && (request.url === '/health' || request.url === '/ready')) {
      record(request);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/mcp') {
      record(request);
      response.statusCode = 401;
      response.setHeader('www-authenticate', 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
      response.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    if (request.method === 'DELETE' && request.url === '/mcp') {
      record(request);
      response.statusCode = request.headers['mcp-session-id'] === sessionId ? 204 : 404;
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/mcp') {
      record(request);
      response.statusCode = 404;
      response.end();
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      record(request, body);
      if (options.challengeUnauthenticatedMcp && typeof request.headers.authorization !== 'string') {
        response.statusCode = 401;
        response.setHeader('www-authenticate', 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
        response.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
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
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'repository_list' }, { name: 'runtime_status' }] } }));
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
  return { port: address.port, endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
}

function writeMainToken(home: string): void {
  const path = join(home, 'mcp', 'mcp.tokens.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ bearerToken: 't'.repeat(32) }));
}

function startObservedRuntime(
  home: string,
  endpoint: string,
  releaseId: string,
  artifactIdentity: string,
  startedAt = new Date(Date.now() - 1_000).toISOString(),
): RuntimeOwnershipHandle {
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
    startedAt,
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

test('standalone Recovery restarts only the configured primary Connector service', async () => {
  const home = controllerHome();
  const plistPath = join(home, 'connector.plist');
  writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway', plistPath },
  });
  const commands: string[][] = [];
  const result = await restartPrimaryConnector(config, {
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => healthyVerify(),
    reconnect: async () => ({ ok: true, detail: 'public MCP reachable', verify: healthyVerify() }),
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: 'gui/501/com.moretea.forge.mcp-gateway' });
  expect(commands).toContainEqual(['launchctl', 'print', 'gui/501/com.moretea.forge.mcp-gateway']);
  expect(commands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
});

test('standalone Recovery restarts the configured primary public tunnel when the local Connector is healthy but public MCP stays unavailable', async () => {
  const home = controllerHome();
  const connectorPlistPath = join(home, 'connector.plist');
  const tunnelPlistPath = join(home, 'primary-tunnel.plist');
  writeFileSync(connectorPlistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  writeFileSync(tunnelPlistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: {
      platform: 'launchd',
      label: 'com.moretea.forge.mcp-gateway',
      plistPath: connectorPlistPath,
      localMcpUrl: 'http://127.0.0.1:8767/mcp',
      postRestartVerifyTimeoutMs: 0,
    },
    primaryPublicTunnelService: {
      platform: 'launchd',
      label: 'com.cloudflare.cloudflared',
      plistPath: tunnelPlistPath,
      postRestartVerifyTimeoutMs: 5_000,
    },
  });
  const commands: string[][] = [];
  let reconnectCalls = 0;
  let clock = 0;
  const result = await restartPrimaryConnector(config, {
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => healthyVerify(),
    probeConnectorLocal: async () => ({ ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 }),
    probeConnectorOwnership: async () => ({ ok: true, detail: 'configured launchd service owns TCP 8767' }),
    reconnect: async () => {
      reconnectCalls += 1;
      return reconnectCalls >= 2
        ? { ok: true, detail: 'public MCP reachable', verify: healthyVerify() }
        : { ok: false, detail: 'HTTP 530', verify: { ...healthyVerify(), ok: false } };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: 'gui/501/com.moretea.forge.mcp-gateway' });
  expect(commands).not.toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
  expect(commands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.cloudflare.cloudflared']);
  expect(reconnectCalls).toBe(2);
});

test('standalone Recovery refuses a no-op when another process owns the configured primary Connector port', async () => {
  const home = controllerHome();
  const connectorPlistPath = join(home, 'connector.plist');
  writeFileSync(connectorPlistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: {
      platform: 'launchd',
      label: 'com.moretea.forge.mcp-gateway',
      plistPath: connectorPlistPath,
      localMcpUrl: 'http://127.0.0.1:8767/mcp',
      postRestartVerifyTimeoutMs: 0,
    },
  });
  const commands: string[][] = [];
  let connectorRestarted = false;
  const result = await restartPrimaryConnector(config, {
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => healthyVerify(),
    probeConnectorLocal: async () => ({ ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 }),
    reconnect: async () => ({ ok: true, detail: 'public MCP reachable', verify: healthyVerify() }),
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      if (name === 'launchctl' && args[0] === 'print') {
        return { ok: true, status: 0, stdout: 'pid = 4242\n', stderr: '' };
      }
      if (name === 'launchctl' && args[0] === 'kickstart') {
        connectorRestarted = true;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (name === 'lsof') {
        return connectorRestarted
          ? { ok: true, status: 0, stdout: '4242\n', stderr: '' }
          : { ok: false, status: 1, stdout: '', stderr: '' };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: 'gui/501/com.moretea.forge.mcp-gateway' });
  expect(result.noOp).not.toBe(true);
  expect(commands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
  expect(commands.some(([name]) => name === 'lsof')).toBe(true);
});

test('standalone Recovery stages only its configured Runtime source and hands a first-generation future sidecar release to activation', async () => {
  const home = controllerHome();
  const sourceRoot = join(home, 'source');
  mkdirSync(sourceRoot, { recursive: true });
  const releasePath = join(home, 'runtime', 'releases', 'release-new');
  mkdirSync(releasePath, { recursive: true });
  const manifestPath = join(releasePath, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: 'release-new',
    futureSidecarEntrypoint: 'future-sidecar-v2',
  }));
  writeFileSync(join(releasePath, 'forge-runtime'), 'binary');
  writeFileSync(join(releasePath, 'future-sidecar-v2'), 'future-sidecar');
  const baseline = verifiedManifest(home, 'release-baseline');
  ensureActiveRuntimeRelease(home, baseline.path);
  const expectedAuthority = readRuntimeReleaseAuthority(home)!;
  const config = createRecoveryConfig(home, { primaryRuntimeSourceRoot: sourceRoot });
  let stagedFrom = '';
  let activatedManifest = '';
  const result = await stageAndActivateConfiguredRuntimeRelease(config, {
    stage: (input) => {
      stagedFrom = input.sourceRoot;
      return {
        releasePath,
        manifestPath,
        releaseId: 'release-new',
        artifactIdentity: 'sha256:test',
        manifestSha256: 'manifest-sha',
        sourceCommit: 'a'.repeat(40),
      };
    },
    activate: async (_config, path, guard) => {
      activatedManifest = path;
      expect(existsSync(join(dirname(path), 'future-sidecar-v2'))).toBe(true);
      expect(guard).toMatchObject({
        requestId: 'recovery-gateway:stage-request-1',
        expectedAuthorityRevision: expectedAuthority.revision,
        expectedActiveReleaseId: 'release-baseline',
      });
      return { ok: true, attempted: true, detail: 'activated' };
    },
  }, 'recovery-gateway:stage-request-1');
  expect(stagedFrom).toBe(resolve(sourceRoot));
  expect(activatedManifest).toBe(manifestPath);
  expect(result).toMatchObject({ ok: true, attempted: true, staged: { releaseId: 'release-new' } });
});

describe('standalone recovery on canonical Runtime', () => {
  test('uses the same minimal OAuth bearer challenge shape as the primary MCP Gateway', () => {
    const request = {
      headers: { host: '127.0.0.1:8787' },
      socket: { encrypted: false },
      url: '/recovery/mcp',
    } as unknown as IncomingMessage;
    const challenge = recoveryWwwAuthenticate(request, { recoveryPublicUrl: 'https://recovery.example.test/recovery/mcp' });
    expect(challenge).toBe('Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://recovery.example.test/.well-known/oauth-protected-resource/recovery/mcp"');
    expect(recoveryUnauthorizedBody()).toEqual({ error: 'invalid_token', message: 'Missing Authorization header' });
  });

  test('verifies and attests the single active whole-Runtime release', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-a', 'artifact-a');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    const knownGoodPath = join(home, 'recovery', 'state', 'known-good.json');
    mkdirSync(dirname(knownGoodPath), { recursive: true });
    writeFileSync(knownGoodPath, `${JSON.stringify({
      schemaVersion: 1,
      releases: [{
        path: join(home, 'runtime', 'releases', 'deleted-release', 'manifest.json'),
        revision: 'deleted-release',
        artifactIdentity: 'artifact-deleted',
        manifestSha256: '0'.repeat(64),
        workerProtocolVersion: 1,
        controllerHome: resolve(home),
        releaseAuthorityRevision: 1,
        releaseFencingTokenSha256: '0'.repeat(64),
        attestedAt: new Date().toISOString(),
      }],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const verified = await verifyStableRuntime(config);
    expect(verified.ok).toBe(true);
    expect(verified.runtime).toMatchObject({ running: true, ready: true, stale: false });
    expect(verified.releases).toMatchObject({ active: { revision: 'release-a', artifactIdentity: 'artifact-a' }, coherent: true });

    const attested = await attestKnownGood(config);
    expect(attested).toMatchObject({ revision: 'release-a', artifactIdentity: 'artifact-a', controllerHome: resolve(home) });
    expect(attested.releaseAuthorityRevision).toBe(1);
    expect(attested.releaseFencingTokenSha256).toHaveLength(64);
    const repairedKnownGood = JSON.parse(readFileSync(knownGoodPath, 'utf8')) as { releases: Array<{ revision: string }> };
    expect(repairedKnownGood.releases.map((entry) => entry.revision)).toEqual(['release-a']);

    const listed = await listReleases(config) as { runtimeRunning: boolean; runtimeReady: boolean; knownGood: Array<{ revision: string }> };
    expect(listed.runtimeRunning).toBe(true);
    expect(listed.runtimeReady).toBe(true);
    expect(listed.knownGood.map((entry) => entry.revision)).toContain('release-a');

    expect(await runtimeStatus(config)).toMatchObject({ running: true, ready: true });
    expect(await dispatchRecoveryTool(config, 'runtime_status', {})).toMatchObject({ running: true, ready: true });
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('runtime_status');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('restart_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('recover_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('activate_runtime_release');
    const activateTool = RECOVERY_TOOLS.find((tool) => tool.name === 'activate_runtime_release');
    expect(activateTool?.inputSchema.required).toEqual(expect.arrayContaining([
      'request_id',
      'release_path',
      'expected_active_release_id',
      'expected_authority_revision',
    ]));
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).not.toContain('supervisor_status');
    expect(RECOVERY_CLI_COMMANDS).toContain('list-releases');
    expect(RECOVERY_CLI_COMMANDS).toContain('restart-primary-runtime');
    expect(RECOVERY_CLI_COMMANDS).toContain('recover-primary-runtime');
    expect(RECOVERY_CLI_COMMANDS).toContain('activate-runtime-release');
  });
  test('Watchdog full verification automatically attests a healthy active Runtime release', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-watchdog-known-good', 'artifact-watchdog-known-good');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    writeMainToken(home);
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    startObservedRuntime(
      home,
      runtime.endpoint,
      'release-watchdog-known-good',
      'artifact-watchdog-known-good',
      new Date(Date.now() - watchdogRuntimeStartupGraceMs(config) - 1_000).toISOString(),
    );

    const tick = await watchdogTick(config, { failures: 0, rollbackUsed: false });
    expect(tick.decision.action).toBe('healthy');
    expect(tick.state.lastFullVerifyAt).toBeNumber();
    const knownGoodPath = join(home, 'recovery', 'state', 'known-good.json');
    const stored = JSON.parse(readFileSync(knownGoodPath, 'utf8')) as { releases: Array<{ revision: string; path: string }> };
    expect(stored.releases).toHaveLength(1);
    expect(stored.releases[0]).toMatchObject({ revision: 'release-watchdog-known-good', path: activeManifest });
  });

  test('Watchdog cheap healthy ticks do not create known-good evidence without a full verification', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-watchdog-cheap', 'artifact-watchdog-cheap');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    writeMainToken(home);
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    startObservedRuntime(
      home,
      runtime.endpoint,
      'release-watchdog-cheap',
      'artifact-watchdog-cheap',
      new Date(Date.now() - watchdogRuntimeStartupGraceMs(config) - 1_000).toISOString(),
    );
    const lastFullVerifyAt = Date.now();

    const tick = await watchdogTick(config, { failures: 0, rollbackUsed: false, lastFullVerifyAt });
    expect(tick.decision.action).toBe('healthy');
    expect(tick.state.lastFullVerifyAt).toBe(lastFullVerifyAt);
    expect(existsSync(join(home, 'recovery', 'state', 'known-good.json'))).toBe(false);
  });

  test('probes Runtime readiness at /ready and MCP with POST initialize while accepting a Bearer challenge', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-probe', 'artifact-probe');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer({ challengeUnauthenticatedMcp: true });
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-probe', 'artifact-probe');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });

    const verified = await verifyStableRuntime(config);
    expect(verified.ok).toBe(true);
    expect(verified.probes.active_gateway).toMatchObject({ ok: true, detail: 'HTTP 200' });
    expect(verified.probes.external_mcp_http).toMatchObject({ ok: true, detail: 'HTTP 401 OAuth challenge' });
    const failedTransport = { request: async () => ({ ok: false, status: 503, headers: {}, body: '' }) };
    await verifyStableRuntime(config, failedTransport); await verifyStableRuntime(config, failedTransport);
    const diagnostics = JSON.parse(readFileSync(join(home, 'recovery', 'state', 'watchdog-diagnostics.json'), 'utf8')); expect(diagnostics.entries).toHaveLength(1);
    expect(diagnostics.entries[0]).toMatchObject({ components: expect.arrayContaining(['gateway', 'public_mcp']), occurrences: 2, failedProbes: expect.arrayContaining([expect.objectContaining({ name: 'active_gateway', status: 503 })]) });
    expect(runtime.requests.some((request) => request.method === 'GET' && request.url === '/ready')).toBe(true);
    expect(runtime.requests.some((request) => request.method === 'GET' && request.url === '/health')).toBe(false);
    expect(runtime.requests.some((request) => request.method === 'GET' && request.url === '/mcp')).toBe(false);

    const requestCountBeforeLightVerify = runtime.requests.length;
    const lightweight = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(lightweight.ok).toBe(true);
    expect(lightweight.probes.mcp_tools_list).toBeUndefined();
    expect(runtime.requests.slice(requestCountBeforeLightVerify).some((request) => request.method === 'POST' && request.url === '/mcp' && request.authorizationPresent)).toBe(false);

    const externalInitialize = runtime.requests.find((request) => (
      request.method === 'POST'
      && request.url === '/mcp'
      && !request.authorizationPresent
    ));
    expect(externalInitialize).toBeDefined();
    expect(externalInitialize?.accept).toBe('application/json, text/event-stream');
    expect(externalInitialize?.contentType).toBe('application/json');
    expect(JSON.parse(externalInitialize?.body ?? '{}')).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
    });
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

  test('rolls back when the active release was attested previously but is currently unhealthy', async () => {
    const home = controllerHome();
    const first = manifest(home, 'release-a', 'artifact-a');
    const second = manifest(home, 'release-b', 'artifact-b', 2);
    ensureActiveRuntimeRelease(home, first);
    const runtime = await runtimeServer();
    writeMainToken(home);
    const firstOwnership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    await attestKnownGood(config);
    removeOwnership(firstOwnership);

    publishRuntimeRelease(home, second, 'publish-release-b');
    const secondOwnership = startObservedRuntime(home, runtime.endpoint, 'release-b', 'artifact-b');
    await attestKnownGood(config);
    removeOwnership(secondOwnership);

    const rolled = await rollbackPrevious(config, 'active release became unhealthy after attestation');
    expect(rolled.ok).toBe(true);
    expect(rolled.noOp).not.toBe(true);
    expect(readRuntimeReleaseAuthority(home)).toMatchObject({
      revision: 3,
      active: { releaseId: 'release-a', artifactIdentity: 'artifact-a' },
      previous: { releaseId: 'release-b', artifactIdentity: 'artifact-b' },
    });
  });

  test('fails closed when an existing authority is invalid instead of rebuilding revision 1', () => {
    const home = controllerHome();
    const first = manifest(home, 'release-a', 'artifact-a');
    const second = manifest(home, 'release-b', 'artifact-b');
    const third = manifest(home, 'release-c', 'artifact-c');
    ensureActiveRuntimeRelease(home, first);
    publishRuntimeRelease(home, second, 'publish-release-b');
    const authorityPath = join(home, 'runtime', 'releases', 'authority.json');
    const committedAuthority = readFileSync(authorityPath, 'utf8');
    writeFileSync(first, `${readFileSync(first, 'utf8')}\n`);
    expect(readRuntimeReleaseAuthority(home)).toBeUndefined();
    expect(() => publishRuntimeRelease(home, third, 'must-not-reset-authority'))
      .toThrow('RUNTIME_RELEASE_AUTHORITY_INVALID_EXISTING');
    expect(readFileSync(authorityPath, 'utf8')).toBe(committedAuthority);
    expect(JSON.parse(committedAuthority)).toMatchObject({ revision: 2, active: { releaseId: 'release-b' }, previous: { releaseId: 'release-a' } });
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

  test('restarts the primary Runtime before allowing previous-release rollback', () => {
    const now = Date.now();
    expect(decideWatchdog({
      failures: 2,
      firstFailureAt: now - 6_000,
      evidenceClasses: ['runtime', 'mcp'],
      activeKnownGood: false,
      previousKnownGood: true,
      rollbackUsed: false,
      primaryRuntimeFailed: true,
      runtimeRestartAttempts: 0,
      runtimeMaximumRestartAttempts: 3,
      nowMs: now,
    }).action).toBe('restart_primary_runtime');
    expect(decideWatchdog({
      failures: 6,
      firstFailureAt: now - 31_000,
      evidenceClasses: ['runtime', 'mcp'],
      activeKnownGood: false,
      previousKnownGood: true,
      rollbackUsed: false,
      primaryRuntimeFailed: true,
      runtimeRestartAttempts: 3,
      runtimeMaximumRestartAttempts: 3,
      runtimeRecoveryLastAttemptAt: now - 61_000,
      runtimeRecoveryCooldownMs: 60_000,
      nowMs: now,
    }).action).toBe('rollback');
    expect(decideWatchdog({
      failures: 6,
      firstFailureAt: now - 31_000,
      evidenceClasses: ['runtime', 'mcp'],
      activeKnownGood: false,
      previousKnownGood: true,
      rollbackUsed: false,
      primaryRuntimeFailed: true,
      runtimeRestartAttempts: 3,
      runtimeMaximumRestartAttempts: 3,
      runtimeRecoveryLastAttemptAt: now - 1_000,
      runtimeRecoveryCooldownMs: 60_000,
      nowMs: now,
    }).action).toBe('degraded');
  });

  test('restarts the installed primary Forge Runtime service and requires whole-Runtime verification', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');
      const config = createRecoveryConfig(home, {
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      let probes = 0;
      const commands: string[][] = [];
      const result = await restartPrimaryRuntime(config, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          commands.push(args);
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        verifyLocal: async () => ++probes >= 3
          ? healthyVerify()
          : { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });
      expect(result).toMatchObject({ ok: true, attempted: true });
      expect(commands.some((args) => args.includes('kickstart'))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('stops, rolls back, restarts, and verifies the previous whole-Runtime release after restart exhaustion', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const second = manifest(home, 'release-b', 'artifact-b', 2);
      ensureActiveRuntimeRelease(home, first);
      const runtime = await runtimeServer();
      writeMainToken(home);
      const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
      const config = createRecoveryConfig(home, {
        publicMcpUrl: runtime.endpoint,
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      await attestKnownGood(config);
      removeOwnership(ownership);
      publishRuntimeRelease(home, second, 'publish-release-b');
      const paths = forgeRuntimeServicePaths(home);
      runtimeServiceConfig(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let localProbes = 0;
      let launchdLoaded = true;
      const commands: string[][] = [];
      const result = await recoverPrimaryRuntime(config, 'test exhausted restarts', {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          commands.push(args);
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap') launchdLoaded = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => ++localProbes >= 3
          ? healthyVerify()
          : { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });
      expect(result).toMatchObject({ ok: true, attempted: true, rollback: { ok: true } });
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(commands.some((args) => args.includes('bootout'))).toBe(true);
      expect(commands.some((args) => args.includes('kickstart'))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('skips activation when a new release id has identical Runtime behavior', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const active = verifiedManifest(home, 'release-a', 'same-runtime');
      const candidate = verifiedManifest(home, 'release-b', 'same-runtime');
      ensureActiveRuntimeRelease(home, active.path);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      ensureForgeRuntimeLaunchAgentContract({ controllerHome: home, installUserLaunchAgent: true });
      const commands: string[][] = [];

      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd' } }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (name, args) => {
          commands.push([name, ...args]);
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        verifyLocal: async () => healthyVerify(),
      });

      expect(result).toMatchObject({ ok: true, attempted: false, noOp: true });
      expect(result.detail).toContain('restart skipped');
      expect(commands).toEqual([]);
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('does not skip behavior-identical activation when the installed Runtime service contract is stale', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const active = verifiedManifest(home, 'release-a', 'same-runtime');
      const candidate = verifiedManifest(home, 'release-b', 'same-runtime');
      ensureActiveRuntimeRelease(home, active.path);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.sourcePlistPath, '<plist/>');
      writeFileSync(paths.installedPlistPath, '<plist/>');
      let launchdLoaded = true;
      const commands: string[][] = [];

      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd' } }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (name, args) => {
          commands.push([name, ...args]);
          if (name === 'lsof') return { ok: false, status: 1, stdout: '', stderr: '' };
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap' || args[0] === 'kickstart') launchdLoaded = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => {
          const authority = readRuntimeReleaseAuthority(home)!;
          return {
            ...healthyVerify(),
            releases: {
              active: { path: authority.active.manifestPath, revision: authority.active.releaseId, artifactIdentity: authority.active.artifactIdentity, manifestSha256: 'test-sha', workerProtocolVersion: 1 },
              coherent: true,
            },
          };
        },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: true, attempted: true });
      expect(commands.some((command) => command.includes('bootout'))).toBe(true);
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-b');
      expect(readFileSync(paths.sourcePlistPath, 'utf8')).not.toBe('<plist/>');
      expect(readFileSync(paths.installedPlistPath, 'utf8')).toBe(readFileSync(paths.sourcePlistPath, 'utf8'));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('does not skip behavior-identical activation when an existing repo-local Controller Home needs .noindex migration', async () => {
    const home = repoLocalControllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = dirname(dirname(home));
    try {
      const active = verifiedManifest(home, 'release-a', 'same-runtime');
      const candidate = verifiedManifest(home, 'release-b', 'same-runtime');
      ensureActiveRuntimeRelease(home, active.path);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');
      let launchdLoaded = true;

      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd' } }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (name, args) => {
          if (name === 'lsof') return { ok: false, status: 1, stdout: '', stderr: '' };
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap') launchdLoaded = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => {
          const authority = readRuntimeReleaseAuthority(home)!;
          return {
            ...healthyVerify(),
            releases: {
              active: { path: authority.active.manifestPath, revision: authority.active.releaseId, artifactIdentity: authority.active.artifactIdentity, manifestSha256: 'test-sha', workerProtocolVersion: 1 },
              coherent: true,
            },
          };
        },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: true, attempted: true });
      expect(result.detail).toContain('.noindex');
      expect(lstatSync(home).isSymbolicLink()).toBe(true);
      expect(realpathSync(home)).toBe(realpathSync(`${home}.noindex`));
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-b');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('does not skip activation when Runtime behavior changes despite an identical executable', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const active = verifiedManifest(home, 'release-a', 'same-runtime');
      const candidate = verifiedManifest(home, 'release-b', 'same-runtime');
      const candidateManifest = JSON.parse(readFileSync(candidate.path, 'utf8')) as Record<string, unknown>;
      candidateManifest.arguments = ['--changed-runtime-behavior'];
      writeFileSync(candidate.path, `${JSON.stringify(candidateManifest, null, 2)}\n`);
      ensureActiveRuntimeRelease(home, active.path);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');
      const commands: string[][] = [];

      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd' } }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (name, args) => {
          commands.push([name, ...args]);
          if (args[0] === 'print') return { ok: true, status: 0, stdout: 'still loaded', stderr: '' };
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => healthyVerify(),
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: false, attempted: true });
      expect(commands.some((command) => command.includes('bootout'))).toBe(true);
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('does not publish a candidate while the primary launchd service is still loaded after bootout', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidate = verifiedManifest(home, 'release-still-loaded');
      ensureActiveRuntimeRelease(home, first);
      const runtime = await runtimeServer();
      writeMainToken(home);
      const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
      const config = createRecoveryConfig(home, {
        publicMcpUrl: runtime.endpoint,
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      removeOwnership(ownership);
      const paths = forgeRuntimeServicePaths(home);
      runtimeServiceConfig(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let kickstarts = 0;
      const result = await activateRuntimeRelease(config, candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          if (args[0] === 'print') return { ok: true, status: 0, stdout: 'still loaded', stderr: '' };
          if (args[0] === 'kickstart') kickstarts += 1;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => healthyVerify(),
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: false, attempted: true });
      expect(result.detail).toContain('launchd service remained loaded');
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(kickstarts).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('does not publish a candidate while the primary Runtime TCP port is still occupied after bootout', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidate = verifiedManifest(home, 'release-port-busy');
      ensureActiveRuntimeRelease(home, first);
      const runtime = await runtimeServer();
      writeMainToken(home);
      const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
      const config = createRecoveryConfig(home, {
        publicMcpUrl: runtime.endpoint,
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      removeOwnership(ownership);
      const paths = forgeRuntimeServicePaths(home);
      runtimeServiceConfig(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let launchdLoaded = true;
      let kickstarts = 0;
      const killSignals: string[][] = [];
      const result = await activateRuntimeRelease(config, candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (commandName, args) => {
          if (commandName === 'lsof') return { ok: true, status: 0, stdout: 'p123\n', stderr: '' };
          if (commandName === 'ps') return { ok: true, status: 0, stdout: '501 /usr/bin/python3 -m http.server 8765\n', stderr: '' };
          if (commandName === 'kill') {
            killSignals.push(args);
            return { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'kickstart') kickstarts += 1;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => healthyVerify(),
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: false, attempted: true });
      expect(result.detail).toContain('TCP port remained occupied');
      expect(result.detail).toContain('not the active Forge Runtime entrypoint');
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(kickstarts).toBe(0);
      expect(killSignals).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('cleans a uniquely verified stale Forge Runtime listener before publishing a candidate', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidate = verifiedManifest(home, 'release-stale-listener-cleanup');
      ensureActiveRuntimeRelease(home, first);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');
      const activeEntrypoint = join(dirname(first), 'forge-runtime');
      let launchdLoaded = true;
      let occupied = true;
      let kickstarts = 0;
      const killSignals: string[][] = [];

      const result = await activateRuntimeRelease(createRecoveryConfig(home, {
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (commandName, args) => {
          if (commandName === 'lsof') return occupied
            ? { ok: true, status: 0, stdout: 'p123\n', stderr: '' }
            : { ok: false, status: 1, stdout: '', stderr: '' };
          if (commandName === 'ps') return {
            ok: true,
            status: 0,
            stdout: `501 ${activeEntrypoint} --controller-home ${resolve(home)} --release-manifest ${resolve(first)} --port 8765\n`,
            stderr: '',
          };
          if (commandName === 'kill') {
            killSignals.push(args);
            if (args[0] === '-TERM' && args[1] === '123') occupied = false;
            return { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap') launchdLoaded = true;
          if (args[0] === 'kickstart') kickstarts += 1;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => {
          const authority = readRuntimeReleaseAuthority(home)!;
          return {
            ...healthyVerify(),
            releases: {
              active: {
                path: authority.active.manifestPath,
                revision: authority.active.releaseId,
                artifactIdentity: authority.active.artifactIdentity,
                manifestSha256: 'test-sha',
                workerProtocolVersion: 1,
              },
              coherent: true,
            },
          };
        },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: true, attempted: true });
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-stale-listener-cleanup');
      expect(killSignals).toEqual([['-TERM', '123']]);
      expect(kickstarts).toBeGreaterThan(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('refuses SIGKILL when the listener identity changes after SIGTERM', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidate = verifiedManifest(home, 'release-listener-pid-reuse');
      ensureActiveRuntimeRelease(home, first);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');
      const activeEntrypoint = join(dirname(first), 'forge-runtime');
      let launchdLoaded = true;
      let psReads = 0;
      const killSignals: string[][] = [];

      const result = await activateRuntimeRelease(createRecoveryConfig(home, {
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (commandName, args) => {
          if (commandName === 'lsof') return { ok: true, status: 0, stdout: 'p123\n', stderr: '' };
          if (commandName === 'ps') {
            psReads += 1;
            return psReads === 1
              ? { ok: true, status: 0, stdout: `501 ${activeEntrypoint} --controller-home ${resolve(home)} --release-manifest ${resolve(first)} --port 8765\n`, stderr: '' }
              : { ok: true, status: 0, stdout: '501 /usr/bin/python3 -m http.server 8765\n', stderr: '' };
          }
          if (commandName === 'kill') {
            killSignals.push(args);
            return { ok: true, status: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => healthyVerify(),
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: false, attempted: true });
      expect(result.detail).toContain('listener identity changed after SIGTERM');
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(killSignals).toEqual([['-TERM', '123']]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('rejects stale-base activation before stopping Runtime when authority advanced after the caller decision', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const releaseA = verifiedManifest(home, 'release-a');
      const releaseB = verifiedManifest(home, 'release-b');
      const candidate = verifiedManifest(home, 'release-candidate');
      ensureActiveRuntimeRelease(home, releaseA.path);
      const observed = readRuntimeReleaseAuthority(home)!;
      publishRuntimeRelease(home, releaseB.path, 'newer-activation');
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');
      const commands: string[][] = [];

      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd' } }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (name, args) => {
          commands.push([name, ...args]);
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
      }, {
        requestId: 'recovery-gateway:stale-request',
        expectedAuthorityRevision: observed.revision,
        expectedActiveReleaseId: observed.active.releaseId,
      });

      expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
      expect(result.detail).toContain('RUNTIME_RELEASE_ACTIVATION_STALE_BASE');
      expect(commands).toEqual([]);
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-b');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('rejects ordinary reverse activation of current.previous and leaves rollback to the explicit recovery path', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const releaseA = verifiedManifest(home, 'release-a');
      const releaseB = verifiedManifest(home, 'release-b');
      ensureActiveRuntimeRelease(home, releaseA.path);
      publishRuntimeRelease(home, releaseB.path, 'activate-b');
      const observed = readRuntimeReleaseAuthority(home)!;
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');
      const commands: string[][] = [];

      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd' } }), releaseA.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (name, args) => {
          commands.push([name, ...args]);
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
      }, {
        requestId: 'recovery-gateway:reverse-request',
        expectedAuthorityRevision: observed.revision,
        expectedActiveReleaseId: observed.active.releaseId,
      });

      expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
      expect(result.detail).toContain('RUNTIME_RELEASE_REVERSE_ACTIVATION_REQUIRES_ROLLBACK');
      expect(commands).toEqual([]);
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-b');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('activates an already staged immutable Runtime release and keeps the previous whole release for rollback', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidateReleaseId = 'release-candidate';
      const candidateRoot = join(home, 'runtime', 'releases', candidateReleaseId);
      mkdirSync(candidateRoot, { recursive: true });
      writeFileSync(join(candidateRoot, 'forge-runtime'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const artifactIdentity = `sha256:${createHash('sha256').update(readFileSync(join(candidateRoot, 'forge-runtime'))).digest('hex')}`;
      const candidateManifestPath = join(candidateRoot, 'manifest.json');
      writeFileSync(candidateManifestPath, `${JSON.stringify({
        schemaVersion: 1,
        releaseId: candidateReleaseId,
        artifactIdentity,
        entrypoint: 'forge-runtime',
        arguments: [],
        configurationSchemaVersion: 1,
        controllerHome: resolve(home),
        databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
        workerProtocolVersion: 1,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`);

      ensureActiveRuntimeRelease(home, first);
      const runtime = await runtimeServer();
      writeMainToken(home);
      const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
      const config = createRecoveryConfig(home, {
        publicMcpUrl: runtime.endpoint,
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      removeOwnership(ownership);
      const paths = forgeRuntimeServicePaths(home);
      runtimeServiceConfig(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let localProbes = 0;
      let launchdLoaded = true;
      const commands: string[][] = [];
      const result = await activateRuntimeRelease(config, candidateManifestPath, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          commands.push(args);
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap') launchdLoaded = true;
          if (args[0] === 'kickstart') return { ok: false, status: 37, stdout: '', stderr: '' };
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => ++localProbes >= 2
          ? {
              ...healthyVerify(),
              releases: {
                active: { path: candidateManifestPath, revision: candidateReleaseId, artifactIdentity, manifestSha256: 'candidate-sha', workerProtocolVersion: 1 },
                coherent: true,
              },
            }
          : { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });
      expect(result).toMatchObject({ ok: true, attempted: true });
      const authority = readRuntimeReleaseAuthority(home)!;
      expect(authority.active.releaseId).toBe(candidateReleaseId);
      expect(authority.active.artifactIdentity).toBe(artifactIdentity);
      expect(authority.previous?.releaseId).toBe('release-a');
      expect(authority.previous?.databaseBackup).toBeDefined();
      expect(commands.some((args) => args.includes('bootout'))).toBe(true);
      expect(commands.some((args) => args.includes('kickstart'))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('rejects a staged Runtime release whose artifact identity does not match its binary', async () => {
    const home = controllerHome();
    const candidateReleaseId = 'release-bad-artifact';
    const candidateRoot = join(home, 'runtime', 'releases', candidateReleaseId);
    mkdirSync(candidateRoot, { recursive: true });
    writeFileSync(join(candidateRoot, 'forge-runtime'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const candidateManifestPath = join(candidateRoot, 'manifest.json');
    writeFileSync(candidateManifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: candidateReleaseId,
      artifactIdentity: 'sha256:deadbeef',
      entrypoint: 'forge-runtime',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome: resolve(home),
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: 1,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const config = createRecoveryConfig(home);
    const result = await activateRuntimeRelease(config, candidateManifestPath);
    expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(result.detail).toContain('ARTIFACT_MISMATCH');
  });

  test('restores the pre-activation active whole release and restarts the service when activation verification fails', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidateReleaseId = 'release-failed-activation';
      const candidateRoot = join(home, 'runtime', 'releases', candidateReleaseId);
      mkdirSync(candidateRoot, { recursive: true });
      writeFileSync(join(candidateRoot, 'forge-runtime'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const artifactIdentity = `sha256:${createHash('sha256').update(readFileSync(join(candidateRoot, 'forge-runtime'))).digest('hex')}`;
      const candidateManifestPath = join(candidateRoot, 'manifest.json');
      writeFileSync(candidateManifestPath, `${JSON.stringify({
        schemaVersion: 1,
        releaseId: candidateReleaseId,
        artifactIdentity,
        entrypoint: 'forge-runtime',
        arguments: [],
        configurationSchemaVersion: 1,
        controllerHome: resolve(home),
        databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
        workerProtocolVersion: 1,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`);

      ensureActiveRuntimeRelease(home, first);
      const runtime = await runtimeServer();
      writeMainToken(home);
      const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
      const config = createRecoveryConfig(home, {
        publicMcpUrl: runtime.endpoint,
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      removeOwnership(ownership);
      const paths = forgeRuntimeServicePaths(home);
      runtimeServiceConfig(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      const commands: string[][] = [];
      let probes = 0;
      let launchdLoaded = true;
      const result = await activateRuntimeRelease(config, candidateManifestPath, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          commands.push(args);
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap') launchdLoaded = true;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => ++probes > 12
          ? healthyVerify()
          : { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.rollback).toMatchObject({ ok: true });
      expect(readRuntimeReleaseAuthority(home)).toMatchObject({
        active: { releaseId: 'release-a', artifactIdentity: 'artifact-a' },
        previous: { releaseId: candidateReleaseId, artifactIdentity },
      });
      expect(commands.filter((args) => args.includes('kickstart')).length).toBeGreaterThanOrEqual(2);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('rolls back Controller Home layout together with the previous whole Runtime when activation verification fails', async () => {
    const home = repoLocalControllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = dirname(dirname(home));
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidate = verifiedManifest(home, 'release-failed-noindex');
      ensureActiveRuntimeRelease(home, first);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let launchdLoaded = true;
      let kickstarts = 0;
      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 5_000 } }), candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (name, args) => {
          if (name === 'lsof') return { ok: false, status: 1, stdout: '', stderr: '' };
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap') launchdLoaded = true;
          if (args[0] === 'kickstart') kickstarts += 1;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => {
          if (kickstarts === 0 || kickstarts >= 2) {
            const authority = readRuntimeReleaseAuthority(home)!;
            return {
              ...healthyVerify(),
              releases: {
                active: { path: authority.active.manifestPath, revision: authority.active.releaseId, artifactIdentity: authority.active.artifactIdentity, manifestSha256: 'test-sha', workerProtocolVersion: 1 },
                coherent: true,
              },
            };
          }
          return { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } };
        },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result.ok).toBe(false);
      expect(result.rollback).toMatchObject({ ok: true });
      expect(lstatSync(home).isDirectory()).toBe(true);
      expect(existsSync(`${home}.noindex`)).toBe(false);
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(kickstarts).toBeGreaterThanOrEqual(2);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('rolls back the previous whole Runtime when candidate kickstart fails', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidate = verifiedManifest(home, 'release-start-failure');
      ensureActiveRuntimeRelease(home, first);
      const runtime = await runtimeServer();
      writeMainToken(home);
      const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
      const config = createRecoveryConfig(home, {
        publicMcpUrl: runtime.endpoint,
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      removeOwnership(ownership);
      const paths = forgeRuntimeServicePaths(home);
      runtimeServiceConfig(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let kickstarts = 0;
      let launchdLoaded = true;
      const result = await activateRuntimeRelease(config, candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          if (args[0] === 'bootstrap') launchdLoaded = true;
          if (args[0] === 'kickstart') {
            kickstarts += 1;
            if (kickstarts === 1) return { ok: false, status: 78, stdout: '', stderr: '' };
          }
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => healthyVerify(),
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('failed to start');
      expect(result.rollback).toMatchObject({ ok: true });
      expect(readRuntimeReleaseAuthority(home)).toMatchObject({
        active: { releaseId: 'release-a', artifactIdentity: 'artifact-a' },
        previous: { releaseId: 'release-start-failure', artifactIdentity: candidate.artifactIdentity },
      });
      expect(kickstarts).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('does not kickstart a candidate when tolerated bootstrap EIO did not actually load the service', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const first = manifest(home, 'release-a', 'artifact-a');
      const candidate = verifiedManifest(home, 'release-bootstrap-eio');
      ensureActiveRuntimeRelease(home, first);
      const runtime = await runtimeServer();
      writeMainToken(home);
      const ownership = startObservedRuntime(home, runtime.endpoint, 'release-a', 'artifact-a');
      const config = createRecoveryConfig(home, {
        publicMcpUrl: runtime.endpoint,
        primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 },
      });
      removeOwnership(ownership);
      const paths = forgeRuntimeServicePaths(home);
      runtimeServiceConfig(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let printCalls = 0;
      let kickstarts = 0;
      let bootstraps = 0;
      let launchdLoaded = true;
      const result = await activateRuntimeRelease(config, candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'print') {
            printCalls += 1;
            return launchdLoaded
              ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
              : { ok: false, status: 113, stdout: '', stderr: 'service not loaded' };
          }
          if (args[0] === 'bootstrap') {
            bootstraps += 1;
            if (bootstraps === 1) return { ok: false, status: 5, stdout: '', stderr: 'Input/output error' };
            launchdLoaded = true;
          }
          if (args[0] === 'kickstart') kickstarts += 1;
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        verifyLocal: async () => healthyVerify(),
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('bootstrap did not load service');
      expect(result.rollback).toMatchObject({ ok: true });
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(bootstraps).toBe(2);
      expect(kickstarts).toBe(1);
      expect(printCalls).toBe(6);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('restarts only the independent Recovery Gateway through its own bounded lock', async () => {
    const home = controllerHome();
    const config = initializeStandaloneRecovery(home, 8787);
    const plist = join(home, 'recovery', 'launchd', 'com.moretea.forge-recovery-gateway.plist');
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

  test('restarts a failed primary Connector automatically only after a bounded sustained failure', () => {
    const now = Date.parse('2026-08-19T01:40:00.000Z');
    expect(decideWatchdog({
      failures: 2,
      firstFailureAt: now - 6_000,
      evidenceClasses: [],
      activeKnownGood: true,
      previousKnownGood: true,
      rollbackUsed: false,
      primaryConnectorConfigured: true,
      primaryConnectorFailed: true,
      primaryConnectorFailures: 2,
      primaryConnectorFirstFailureAt: now - 6_000,
      primaryConnectorRestartAttempts: 0,
      primaryConnectorMaximumRestartAttempts: 3,
      nowMs: now,
    })).toMatchObject({ action: 'restart_primary_connector' });

    expect(decideWatchdog({
      failures: 2,
      firstFailureAt: now - 6_000,
      evidenceClasses: [],
      activeKnownGood: true,
      previousKnownGood: true,
      rollbackUsed: false,
      primaryConnectorConfigured: true,
      primaryConnectorFailed: true,
      primaryConnectorFailures: 2,
      primaryConnectorFirstFailureAt: now - 6_000,
      primaryConnectorRestartAttempts: 3,
      primaryConnectorMaximumRestartAttempts: 3,
      nowMs: now,
    })).toMatchObject({ action: 'degraded' });
  });

  test('proves Recovery Watchdog liveness with heartbeat, PID, release identity, and stuck-tick fencing', () => {
    const now = Date.parse('2026-08-19T01:40:00.000Z');
    const release = {
      releasePath: '/controller/recovery/releases/recovery-r1',
      releaseRevision: 'recovery-r1',
      sourceCommit: 'commit-r1',
      manifestSha256: 'manifest-r1',
    };
    const runtimeIdentity = {
      schemaVersion: 1 as const,
      role: 'watchdog' as const,
      pid: 4242,
      startedAt: new Date(now - 60_000).toISOString(),
      ...release,
    };
    const heartbeat = {
      schemaVersion: 1 as const,
      pid: runtimeIdentity.pid,
      startedAt: runtimeIdentity.startedAt,
      ...release,
      lastPulseAt: new Date(now - 1_000).toISOString(),
      lastTickStartedAt: new Date(now - 5_000).toISOString(),
      lastTickCompletedAt: new Date(now - 2_000).toISOString(),
    };

    expect(evaluateRecoveryWatchdogHealth({ heartbeat, runtimeIdentity, currentRelease: release, nowMs: now, pidAlive: () => true })).toMatchObject({ ok: true });
    expect(evaluateRecoveryWatchdogHealth({
      heartbeat: { ...heartbeat, lastPulseAt: new Date(now - 60_000).toISOString() },
      runtimeIdentity,
      currentRelease: release,
      nowMs: now,
      pidAlive: () => true,
    })).toMatchObject({ ok: false, detail: 'Recovery Watchdog heartbeat is stale' });
    expect(evaluateRecoveryWatchdogHealth({
      heartbeat: {
        ...heartbeat,
        lastPulseAt: new Date(now - 1_000).toISOString(),
        lastTickStartedAt: new Date(now - RECOVERY_WATCHDOG_MAX_TICK_AGE_MS - 1).toISOString(),
        lastTickCompletedAt: new Date(now - RECOVERY_WATCHDOG_MAX_TICK_AGE_MS - 10_000).toISOString(),
      },
      runtimeIdentity,
      currentRelease: release,
      nowMs: now,
      pidAlive: () => true,
    })).toMatchObject({ ok: false, detail: 'Recovery Watchdog tick is stuck beyond its bounded recovery window' });
    expect(evaluateRecoveryWatchdogHealth({
      heartbeat: { ...heartbeat, releaseRevision: 'stale-recovery' },
      runtimeIdentity,
      currentRelease: release,
      nowMs: now,
      pidAlive: () => true,
    })).toMatchObject({ ok: false, detail: 'Recovery Watchdog is not running the current immutable Recovery release' });
  });

  test('Recovery Gateway can restart a stale independent Watchdog through the shared bounded launchd primitive', async () => {
    const home = controllerHome();
    const config = initializeStandaloneRecovery(home, 8787);
    const plist = join(home, 'recovery', 'launchd', 'com.moretea.forge-recovery-watchdog.plist');
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, '<plist/>');
    let probes = 0;
    const commands: string[][] = [];
    const result = await restartRecoveryWatchdog(config, {
      platform: 'darwin',
      currentUid: async () => 501,
      runCommand: async (_command, args) => {
        commands.push(args);
        return { ok: true, status: 0, stdout: '', stderr: '' };
      },
      probeWatchdog: async () => ({ ok: ++probes >= 3, detail: probes >= 3 ? 'healthy' : 'stale' }),
      now: (() => { let now = 0; return () => now += 1_000; })(),
      sleep: async () => undefined,
    });
    expect(result).toMatchObject({ ok: true, attempted: true });
    expect(commands.some((args) => args.includes('kickstart'))).toBe(true);
  });

  test('describes one independent HTTPS Recovery MCP connector without exposing credentials', () => {
    const home = controllerHome();
    const credential = ensureMcpControllerHomeOAuthPassphrase(home);
    initializeStandaloneRecovery(home, 8787, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      recoveryPublicUrl: 'https://recovery.example.test/recovery/mcp',
      readOnlyTool: { name: 'controller_context' },
      recoveryTunnelService: {
        platform: 'launchd',
        label: 'com.moretea.forge-recovery-tunnel',
        plistPath: '/tmp/forge-test-home/Library/LaunchAgents/com.moretea.forge-recovery-tunnel.plist',
      },
    });
    const descriptor = recoveryConnectorDescriptor(home, {
      pathExists: () => false,
      launchdPid: () => undefined,
      tunnelLaunchdPid: () => undefined,
      processAlive: () => false,
    });
    expect(descriptor).toMatchObject({
      name: 'Forge Recovery',
      transport: 'streamable_http',
      url: 'https://recovery.example.test/recovery/mcp',
      public: true,
      installed: false,
      readyForChatGPT: false,
      oauth: {
        passphraseConfigured: true,
        authorizationServerMetadataUrl: 'https://recovery.example.test/.well-known/oauth-authorization-server',
        protectedResourceMetadataUrl: 'https://recovery.example.test/.well-known/oauth-protected-resource/recovery/mcp',
      },
      healthUrl: 'https://recovery.example.test/recovery/health',
      services: {
        gateway: {
          label: 'com.moretea.forge-recovery-gateway',
          plistInstalled: false,
          running: false,
        },
        watchdog: {
          label: 'com.moretea.forge-recovery-watchdog',
          plistInstalled: false,
          running: false,
        },
        tunnel: {
          configured: true,
          label: 'com.moretea.forge-recovery-tunnel',
          plistInstalled: false,
          restartSafe: false,
          running: false,
        },
      },
    });
    expect(descriptor.tools).toContain('recover_primary_runtime');
    expect(descriptor.tools).toContain('rollback_previous');
    expect(descriptor.warnings).toContain('No current immutable Forge Recovery release is installed. Run forge recovery install.');
    expect(descriptor.warnings).toContain('Forge Recovery launchd services are not fully installed. Run forge recovery install.');
    expect(descriptor.warnings).toContain('Forge Recovery Gateway or Watchdog is not running on the current Recovery release.');
    expect(descriptor.warnings).toContain('The dedicated Forge Recovery tunnel plist is not installed.');
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain(credential.passphrase);
    expect(serialized).not.toContain('bearerToken');
    expect(serialized).not.toContain('gateway-token');
  });
  test('fails closed for ChatGPT readiness when only a loopback Recovery endpoint exists', () => {
    const home = controllerHome();
    initializeStandaloneRecovery(home, 8787);
    const descriptor = recoveryConnectorDescriptor(home, {
      pathExists: () => false,
      launchdPid: () => undefined,
      tunnelLaunchdPid: () => undefined,
      processAlive: () => false,
    });
    expect(descriptor.url).toBe('http://127.0.0.1:8787/recovery/mcp');
    expect(descriptor.public).toBe(false);
    expect(descriptor.readyForChatGPT).toBe(false);
    expect(descriptor.warnings).toContain('Recovery is loopback-only. Configure --recovery-public-url and a dedicated tunnel service before adding it to ChatGPT.');
  });
  test('requires RunAtLoad and unconditional KeepAlive for the Recovery tunnel launch agent', () => {
    const home = controllerHome();
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.moretea.forge-recovery-tunnel.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>');
    expect(inspectRecoveryTunnelLaunchdContract({
      platform: 'launchd',
      label: 'com.moretea.forge-recovery-tunnel',
      plistPath,
    })).toMatchObject({ plistInstalled: true, runAtLoad: true, keepAliveAlways: false, restartSafe: false });

    writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
    expect(inspectRecoveryTunnelLaunchdContract({
      platform: 'launchd',
      label: 'com.moretea.forge-recovery-tunnel',
      plistPath,
    })).toMatchObject({ plistInstalled: true, runAtLoad: true, keepAliveAlways: true, restartSafe: true });
  });
  test('accepts failure-triggered KeepAlive for the explicitly managed primary public tunnel', () => {
    const home = controllerHome();
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.cloudflare.cloudflared.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>');
    expect(inspectPrimaryPublicTunnelLaunchdContract({
      platform: 'launchd',
      label: 'com.cloudflare.cloudflared',
      plistPath,
    })).toMatchObject({
      plistInstalled: true,
      runAtLoad: true,
      keepAliveAlways: false,
      keepAliveOnFailure: true,
      restartSafe: true,
    });
  });

  test('accepts failure-triggered KeepAlive for the explicitly managed primary Connector', () => {
    const home = controllerHome();
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.moretea.forge.mcp-gateway.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>');
    expect(inspectPrimaryConnectorLaunchdContract({
      platform: 'launchd',
      label: 'com.moretea.forge.mcp-gateway',
      plistPath,
    })).toMatchObject({
      plistInstalled: true,
      runAtLoad: true,
      keepAliveAlways: false,
      keepAliveOnFailure: true,
      restartSafe: true,
    });
  });
  test('retires stale Recovery launch agents before the Forge services are installed', () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const generatedRoot = join(home, 'recovery', 'launchd');
      const retiredLabel = 'com.moretea.retired-recovery-gateway';
      const currentLabel = 'com.moretea.forge-recovery-gateway';
      mkdirSync(generatedRoot, { recursive: true });
      const plist = (label: string) => `<plist><dict><key>Label</key><string>${label}</string></dict></plist>`;
      writeFileSync(join(generatedRoot, `${retiredLabel}.plist`), plist(retiredLabel));
      writeFileSync(join(generatedRoot, `${currentLabel}.plist`), plist(currentLabel));
      const installedRetired = join(home, 'Library', 'LaunchAgents', `${retiredLabel}.plist`);
      mkdirSync(dirname(installedRetired), { recursive: true });
      writeFileSync(installedRetired, plist(retiredLabel));
      const calls: string[][] = [];
      const retired = retireStaleRecoveryLaunchAgents(home, 501, (args) => {
        calls.push(args);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      });
      expect(retired).toEqual([retiredLabel]);
      expect(calls).toContainEqual(['print', `gui/501/${retiredLabel}`]);
      expect(calls).toContainEqual(['bootout', `gui/501/${retiredLabel}`]);
      expect(existsSync(join(generatedRoot, `${retiredLabel}.plist`))).toBe(false);
      expect(existsSync(installedRetired)).toBe(false);
      expect(existsSync(join(generatedRoot, `${currentLabel}.plist`))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
  test('drops retired Recovery configuration keys instead of persisting a compatibility surface', () => {
    const home = controllerHome();
    const path = recoveryConfigPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      controllerHome: home,
      stableIngressUrl: 'http://127.0.0.1:8765',
      publicTunnelService: { platform: 'launchd', label: 'com.moretea.retired-recovery' },
      agentRepair: { enabled: true, command: 'pi' },
      publicMcpUrl: 'https://mcp.example.test/mcp',
      recoveryPublicUrl: 'https://recovery.example.test/recovery/mcp',
      recoveryTunnelService: { platform: 'launchd', label: 'com.moretea.forge-recovery-tunnel' },
      readOnlyTool: { name: 'controller_ready' },
      gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: join(home, 'recovery', 'config', 'gateway-token.json') },
    }));
    const loaded = loadRecoveryConfig(home);
    expect(loaded).not.toHaveProperty('stableIngressUrl');
    expect(loaded).not.toHaveProperty('publicTunnelService');
    expect(loaded).not.toHaveProperty('agentRepair');
    expect(loaded.recoveryPublicUrl).toBe('https://recovery.example.test/recovery/mcp');
    expect(loaded.readOnlyTool).toEqual({ name: 'repository_list', arguments: {} });
    const migrated = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(migrated.readOnlyTool).toEqual({ name: 'controller_ready' });

    writeFileSync(path, JSON.stringify({ ...migrated, readOnlyTool: { name: 'controller_context', arguments: { stale: true } } }));
    expect(loadRecoveryConfig(home).readOnlyTool).toEqual({ name: 'repository_list', arguments: {} });
    expect((JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).readOnlyTool)
      .toEqual({ name: 'controller_context', arguments: { stale: true } });

    createRecoveryConfig(home, {});
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('stableIngressUrl');
    expect(persisted).not.toHaveProperty('publicTunnelService');
    expect(persisted).not.toHaveProperty('agentRepair');
    expect(persisted.readOnlyTool).toEqual({ name: 'repository_list', arguments: {} });
  });

  test('does not reset primary Runtime recovery accounting when the Recovery release changes', () => {
    const stale = {
      failures: 7,
      firstFailureAt: 123,
      rollbackUsed: true,
      runtimeRestartAttempts: 3,
      runtimeRestartFailures: 3,
      runtimeRecoveryFailures: 2,
      publicTunnelFailures: 4,
      publicTunnelFirstFailureAt: 456,
      publicTunnelRepairFailures: 2,
      recoveryGatewayRestartUsed: true,
      recoveryReleaseRevision: 'release-old',
      lastFullVerifyAt: 789,
      lastDecision: 'restart_primary_runtime' as const,
    };
    const reset = resetWatchdogStateForRecoveryRelease(stale, 'release-new');
    expect(reset).toMatchObject({
      failures: 7,
      rollbackUsed: true,
      runtimeRestartAttempts: 3,
      runtimeRestartFailures: 3,
      runtimeRecoveryFailures: 2,
      recoveryGatewayRestartUsed: false,
      recoveryReleaseRevision: 'release-new',
    });
    expect(resetWatchdogStateForRecoveryRelease(reset, 'release-new')).toBe(reset);
  });

  test('binds restart budgets to immutable Runtime identity without losing legacy watchdog counters', () => {
    const legacy = { failures: 2, rollbackUsed: false, runtimeRestartAttempts: 3, runtimeRestartFailures: 1 };
    const releaseA = { revision: 'release-a', artifactIdentity: 'sha256:a', manifestSha256: 'manifest-a' };
    const bound = scopeWatchdogStateToRuntimeRelease(legacy, releaseA);
    expect(bound).toMatchObject({ runtimeRestartAttempts: 3 });
    expect(bound.runtimeRestartBudgetIdentity).toContain('release-a');

    const releaseB = { revision: 'release-b', artifactIdentity: 'sha256:b', manifestSha256: 'manifest-b' };
    expect(scopeWatchdogStateToRuntimeRelease(bound, releaseB)).toMatchObject({
      failures: 0,
      runtimeRestartAttempts: 0,
      runtimeRestartFailures: 0,
      runtimeRestartBudgetIdentity: expect.stringContaining('release-b'),
    });
  });

  test('restores a release restart budget only after continuous healthy time', () => {
    const state = {
      failures: 0,
      rollbackUsed: false,
      runtimeRestartAttempts: 3,
      runtimeRestartFailures: 2,
      runtimeRestartBudgetExhaustedAt: 10,
    };
    const firstHealthy = recordWatchdogRuntimeHealthy(state, 1_000);
    expect(firstHealthy.runtimeRestartAttempts).toBe(3);
    expect(recordWatchdogRuntimeHealthy(firstHealthy, 1_000 + WATCHDOG_RUNTIME_RESTART_BUDGET_STABLE_MS - 1).runtimeRestartAttempts).toBe(3);
    expect(recordWatchdogRuntimeHealthy(firstHealthy, 1_000 + WATCHDOG_RUNTIME_RESTART_BUDGET_STABLE_MS)).toMatchObject({
      runtimeRestartAttempts: 0,
      runtimeRestartFailures: 0,
      runtimeRestartBudgetExhaustedAt: undefined,
    });
    expect(watchdogRuntimeRestartBudgetStableMs({ primaryRuntimeService: { platform: 'launchd', restartBudgetStableDurationMs: 12_345 } })).toBe(12_345);
  });

  test('enters explicit operator handoff when the active release has exhausted its restart budget', () => {
    const now = Date.parse('2026-08-09T06:20:00.000Z');
    expect(decideWatchdog({
      failures: 2,
      firstFailureAt: now - 6_000,
      evidenceClasses: ['runtime'],
      activeKnownGood: true,
      previousKnownGood: false,
      rollbackUsed: false,
      primaryRuntimeFailed: true,
      runtimeRestartAttempts: 3,
      runtimeMaximumRestartAttempts: 3,
      nowMs: now,
    })).toMatchObject({ action: 'recovery_exhausted' });
  });

  test('grants startup grace only to a live non-stale Runtime owner and never shorter than release verification', () => {
    const now = Date.parse('2026-08-09T06:20:00.000Z');
    expect(watchdogRuntimeStartupGraceMs({ primaryRuntimeService: { platform: 'launchd' } })).toBe(60_000);
    expect(watchdogRuntimeStartupGraceMs({
      primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 120_000 },
    })).toBe(120_000);
    expect(runtimeWithinWatchdogStartupGrace({
      running: true,
      stale: false,
      snapshot: { startedAt: '2026-08-09T06:19:30.000Z' },
    }, now)).toBe(true);
    expect(runtimeWithinWatchdogStartupGrace({
      running: true,
      stale: false,
      snapshot: { startedAt: '2026-08-09T06:18:00.000Z' },
    }, now)).toBe(false);
    expect(runtimeWithinWatchdogStartupGrace({
      running: false,
      stale: false,
      snapshot: { startedAt: '2026-08-09T06:19:30.000Z' },
    }, now)).toBe(false);
    expect(runtimeWithinWatchdogStartupGrace({
      running: true,
      stale: true,
      snapshot: { startedAt: '2026-08-09T06:19:30.000Z' },
    }, now)).toBe(false);
  });

});
