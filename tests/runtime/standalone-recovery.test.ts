import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
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
  restartPrimaryConnector,
  restartPrimaryRuntime,
  restartRecoveryGateway,
  stageAndActivateConfiguredRuntimeRelease,
  rollbackPrevious,
  runtimeStatus,
  runtimeWithinWatchdogStartupGrace,
  verifyStableRuntime,
  type VerifyResult,
} from '../../src/runtime/standalone-recovery/core';
import {
  dispatchRecoveryTool,
  RECOVERY_CLI_COMMANDS,
  RECOVERY_TOOLS,
  resetWatchdogStateForRecoveryRelease,
} from '../../src/runtime/standalone-recovery/entry';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { acquireRuntimeOwnership, type RuntimeOwnershipHandle } from '../../src/runtime/root/ownership';
import {
  ensureActiveRuntimeRelease,
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
} from '../../src/runtime/root/release-store';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { recoveryConnectorDescriptor } from '../../src/cli/commands/recovery';
import { ensureMcpControllerHomeOAuthPassphrase } from '../../src/cli/mcp/auth';
import { inspectPrimaryConnectorLaunchdContract, inspectRecoveryTunnelLaunchdContract, retireStaleRecoveryLaunchAgents } from '../../src/runtime/standalone-recovery/installer';

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

function verifiedManifest(home: string, releaseId: string): { path: string; artifactIdentity: string } {
  const releaseRoot = join(home, 'runtime', 'releases', releaseId);
  const path = join(releaseRoot, 'manifest.json');
  mkdirSync(releaseRoot, { recursive: true });
  const binaryPath = join(releaseRoot, 'forge-runtime');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
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
  return { port: address.port, endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
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

test('standalone Recovery stages only its configured Runtime source and hands activation to the transaction', async () => {
  const home = controllerHome();
  const sourceRoot = join(home, 'source');
  mkdirSync(sourceRoot, { recursive: true });
  const releasePath = join(home, 'runtime', 'releases', 'release-new');
  mkdirSync(releasePath, { recursive: true });
  const manifestPath = join(releasePath, 'manifest.json');
  writeFileSync(manifestPath, '{}');
  writeFileSync(join(releasePath, 'forge-runtime'), 'binary');
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
    activate: async (_config, path) => {
      activatedManifest = path;
      return { ok: true, attempted: true, detail: 'activated' };
    },
  });
  expect(stagedFrom).toBe(resolve(sourceRoot));
  expect(activatedManifest).toBe(manifestPath);
  expect(result).toMatchObject({ ok: true, attempted: true, staged: { releaseId: 'release-new' } });
});

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
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('restart_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('recover_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('activate_runtime_release');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).not.toContain('supervisor_status');
    expect(RECOVERY_CLI_COMMANDS).toContain('list-releases');
    expect(RECOVERY_CLI_COMMANDS).toContain('restart-primary-runtime');
    expect(RECOVERY_CLI_COMMANDS).toContain('recover-primary-runtime');
    expect(RECOVERY_CLI_COMMANDS).toContain('activate-runtime-release');
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

  test('resolves the installed Runtime launch agent from the OS home when HOME is absent', () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const paths = forgeRuntimeServicePaths(home);
      expect(paths.installedPlistPath).toBe(join(homedir(), 'Library', 'LaunchAgents', `${paths.label}.plist`));
      expect(paths.installedPlistPath.startsWith(resolve(home))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
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
      const result = await activateRuntimeRelease(config, candidate.path, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (commandName, args) => {
          if (commandName === 'lsof') return { ok: true, status: 0, stdout: 'forge-runtime 123 greyson TCP *:8765 (LISTEN)', stderr: '' };
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
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(kickstarts).toBe(0);
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

  test('describes one independent HTTPS Recovery MCP connector without exposing credentials', () => {
    const home = controllerHome();
    const credential = ensureMcpControllerHomeOAuthPassphrase(home);
    initializeStandaloneRecovery(home, 8787, {
      publicMcpUrl: 'https://mcp.example.test/mcp',
      recoveryPublicUrl: 'https://recovery.example.test/recovery/mcp',
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
      gateway: { host: '127.0.0.1', port: 8787, bearerTokenFile: join(home, 'recovery', 'config', 'gateway-token.json') },
    }));

    const loaded = loadRecoveryConfig(home);
    expect(loaded).not.toHaveProperty('stableIngressUrl');
    expect(loaded).not.toHaveProperty('publicTunnelService');
    expect(loaded).not.toHaveProperty('agentRepair');
    expect(loaded.recoveryPublicUrl).toBe('https://recovery.example.test/recovery/mcp');

    createRecoveryConfig(home, {});
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('stableIngressUrl');
    expect(persisted).not.toHaveProperty('publicTunnelService');
    expect(persisted).not.toHaveProperty('agentRepair');
  });

  test('resets inherited Watchdog failures when the Recovery release changes', () => {
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
    expect(reset).toEqual({
      failures: 0,
      rollbackUsed: false,
      runtimeRestartAttempts: 0,
      runtimeRestartFailures: 0,
      runtimeRecoveryFailures: 0,
      publicTunnelFailures: 0,
      publicTunnelRepairFailures: 0,
      recoveryGatewayRestartUsed: false,
      recoveryReleaseRevision: 'release-new',
    });
    expect(resetWatchdogStateForRecoveryRelease(reset, 'release-new')).toBe(reset);
  });

  test('grants startup grace only to a live non-stale Runtime owner', () => {
    const now = Date.parse('2026-08-09T06:20:00.000Z');
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
