import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  attestKnownGood,
  createRecoveryConfig,
  decideWatchdog,
  initializeStandaloneRecovery,
  loadRecoveryConfig,
  recoveryConfigPath,
  listReleases,
  recoverPrimaryRuntime,
  restartPrimaryRuntime,
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
import { forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { recoveryConnectorDescriptor } from '../../src/cli/commands/recovery';
import { ensureMcpControllerHomeOAuthPassphrase } from '../../src/cli/mcp/auth';
import { retireStaleRecoveryLaunchAgents } from '../../src/runtime/standalone-recovery/installer';

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
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('restart_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('recover_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).not.toContain('supervisor_status');
    expect(RECOVERY_CLI_COMMANDS).toContain('list-releases');
    expect(RECOVERY_CLI_COMMANDS).toContain('restart-primary-runtime');
    expect(RECOVERY_CLI_COMMANDS).toContain('recover-primary-runtime');
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
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let localProbes = 0;
      const commands: string[][] = [];
      const result = await recoverPrimaryRuntime(config, 'test exhausted restarts', {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          commands.push(args);
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
