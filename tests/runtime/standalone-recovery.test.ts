import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import {
  activateRuntimeRelease,
  activatePinnedRuntimeRelease,
  attestKnownGood as attestKnownGoodWithCpu,
  createRecoveryConfig,
  decideWatchdog,
  defaultPrimaryRuntimeServiceConfig,
  initializeStandaloneRecovery,
  loadRecoveryConfig,
  observeOpenAiTunnelLocalHealthFallback,
  recoveryMachineIdentity,
  recoveryConfigPath,
  recoveryCommandPath,
  resolveRecoveryPackageConnectorExecutable,
  listReleases,
  pinRuntimeRelease,
  recoverPrimaryRuntime,
  recordWatchdogRuntimeHealthy,
  repairPublicTunnel,
  restartPrimaryConnector,
  restartPrimaryRuntime,
  restartRecoveryGateway,
  restartRecoveryWatchdog,
  scopeWatchdogStateToRuntimeRelease,
  stageAndActivateConfiguredRuntimeRelease,
  unpinRuntimeRelease,
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
  classifyRecoveryMcpRequest,
  dispatchRecoveryTool,
  RECOVERY_CLI_COMMANDS,
  RECOVERY_TOOLS,
  recoveryUnauthorizedBody,
  recoveryWwwAuthenticate,
  recoveryOAuthClientRegistrationIdentity,
  RECOVERY_VERIFIER_OAUTH_CLIENT_ID,
  RECOVERY_VERIFIER_OAUTH_CLIENT_NAME,
  RECOVERY_VERIFIER_OAUTH_REDIRECT_URI,
  resetWatchdogStateForRecoveryRelease,
} from '../../src/runtime/standalone-recovery/entry';
import { RecoveryMcpSessionServer } from '../../src/runtime/standalone-recovery/mcp-server';
import { readControlPlaneRecord, writeControlPlaneRecord } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { RECOVERY_MUTATION_IDENTITY_CONTRACT, RECOVERY_MUTATION_IDENTITY_FIELDS } from '../../src/runtime/standalone-recovery/mutation-identity-contract';
import {
  evaluateRecoveryWatchdogHealth,
  RECOVERY_WATCHDOG_MAX_TICK_AGE_MS,
} from '../../src/runtime/standalone-recovery/watchdog-heartbeat';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { acquireRuntimeOwnership, runtimeIncarnationPath, type RuntimeOwnershipHandle } from '../../src/runtime/root/ownership';
import {
  ensureActiveRuntimeRelease,
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
} from '../../src/runtime/root/release-store';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import { ensureForgeRuntimeLaunchAgentContract, forgeRuntimeServicePaths } from '../../src/runtime/root/service';
import { systemdUserUnitPath } from '../../src/cli/controller/systemd-user';
import {
  renderPackageRuntimeSystemdUserService,
  writePackageRuntimeSystemdUserService,
} from '../../src/runtime/root/package-runtime-service';
import {
  assertDistinctRecoveryOpenAiTunnelIdentity,
  recoveryConnectorDescriptor,
  recoveryConnectorHasExternalTransport,
  recoveryOpenAiTunnelDefaultAlias,
  verifyRecoveryConnector,
} from '../../src/cli/commands/recovery';
import { FORGE_VERSION } from '../../src/version';
import {
  defaultUserControllerHomeForMigration,
  recoveryControllerHomeOwnerLabels,
  scheduleRecoveryControllerHomeMigration,
} from '../../src/runtime/standalone-recovery/controller-home-migration';
import { ensureMcpControllerHomeOAuthPassphrase, writeMcpServiceLocalConfig } from '../../src/cli/mcp/auth';
import { installStandaloneRecovery, inspectPrimaryConnectorLaunchdContract, inspectPrimaryPublicTunnelLaunchdContract, inspectRecoveryTunnelLaunchdContract, recoverySystemdUserUnitInput, resolveRecoveryCompilerExecutable, retireStaleRecoveryLaunchAgents } from '../../src/runtime/standalone-recovery/installer';
import { acquireRecoveryOperationLock, recoveryOperationLockPath } from '../../src/runtime/standalone-recovery/operation-lock';

import { measureRuntimePerformance, assertRuntimePerformanceEvidence, readRuntimeCpu } from '../../src/runtime/standalone-recovery/performance';

function idleCpuDependencies() {
  let elapsed = 0;
  const base = Date.now() - 360_000;
  return {
    readCpu: () => ({ cpuMs: 0, processStartTime: 'fixture-process-start' }),
    monotonicNow: () => elapsed,
    wallNow: () => base + elapsed,
    sleep: async (ms: number) => { elapsed += ms; },
  };
}

function attestKnownGood(config: Parameters<typeof attestKnownGoodWithCpu>[0]) {
  return attestKnownGoodWithCpu(config, idleCpuDependencies());
}

const roots: string[] = [];
const servers: Server[] = [];
const ownerships: RuntimeOwnershipHandle[] = [];

function recoveryMutationIdentityArgs(config: ReturnType<typeof createRecoveryConfig>): Record<string, string> {
  const identity = recoveryMachineIdentity(config);
  return {
    expected_host: identity.host,
    expected_platform: identity.platform,
    expected_controller_home: identity.controllerHome,
    expected_recovery_release: identity.recovery.releaseRevision ?? 'none',
    expected_target_runtime: identity.targetRuntime.id,
  };
}

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

test('standalone Recovery compiler resolves account Bun when compiled Runtime PATH omits Bun', () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-recovery-bun-home-'));
  roots.push(home);
  const bun = join(home, '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  mkdirSync(dirname(bun), { recursive: true });
  writeFileSync(bun, 'fixture bun');
  chmodSync(bun, 0o700);

  expect(resolveRecoveryCompilerExecutable(
    join(home, 'runtime', 'forge-runtime'),
    { HOME: home, PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin' },
    home,
  )).toBe(bun);
  expect(resolveRecoveryCompilerExecutable('/tmp/forge-runtime', { FORGE_BUN_BIN: '/opt/forge/custom-bun' }, home))
    .toBe('/opt/forge/custom-bun');
});

test('standalone Recovery package Connector runner does not inherit the compiled Recovery executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-recovery-connector-bun-home-'));
  roots.push(home);
  const bun = join(home, '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  mkdirSync(dirname(bun), { recursive: true });
  writeFileSync(bun, 'fixture bun');
  chmodSync(bun, 0o700);

  expect(resolveRecoveryPackageConnectorExecutable(
    join(home, 'recovery', 'current', 'forge-recovery'),
    { HOME: home, PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin' },
    home,
  )).toBe(bun);
});

test('standalone Recovery stage-only build never rewrites installed durable source authority', async () => {
  const home = controllerHome();
  const durableSource = join(home, 'durable-source');
  committedRecoverySource(durableSource);
  const stageSource = join(home, 'managed-worktrees', 'repo_test', 'work-stage-only');
  const stageCommit = committedRecoverySource(stageSource);
  createRecoveryConfig(home, { primaryRuntimeSourceRoot: durableSource });
  const before = readFileSync(recoveryConfigPath(home), 'utf8');

  const result = await installStandaloneRecovery({
    controllerHome: home,
    repoRoot: stageSource,
    sourceRoot: stageSource,
    stageOnly: true,
  }, recoveryInstallerStubs());

  expect(result.activated).toBeUndefined();
  expect(result.staged.release.sourceCommit).toBe(stageCommit);
  expect(result.staged.release.productVersion).toBe('1.7.2');
  expect(result.config.primaryRuntimeSourceRoot).toBe(resolve(durableSource));
  expect(readFileSync(recoveryConfigPath(home), 'utf8')).toBe(before);
});

test('standalone Recovery non-stage install rejects managed-worktree durable source before config mutation', async () => {
  const home = controllerHome();
  const durableSource = join(home, 'durable-source');
  committedRecoverySource(durableSource);
  const managedSource = join(home, 'managed-worktrees', 'repo_test', 'work-install');
  createRecoveryConfig(home, { primaryRuntimeSourceRoot: durableSource });
  const before = readFileSync(recoveryConfigPath(home), 'utf8');

  await expect(installStandaloneRecovery({
    controllerHome: home,
    repoRoot: managedSource,
    sourceRoot: managedSource,
  }, recoveryInstallerStubs())).rejects.toThrow('RECOVERY_PRIMARY_RUNTIME_SOURCE_ROOT_DURABLE_REQUIRED');

  expect(loadRecoveryConfig(home).primaryRuntimeSourceRoot).toBe(resolve(durableSource));
  expect(readFileSync(recoveryConfigPath(home), 'utf8')).toBe(before);
});

test('standalone Recovery non-stage install persists a durable canonical source and activates the staged release', async () => {
  const home = controllerHome();
  const durableSource = join(home, 'canonical-source');
  const sourceCommit = committedRecoverySource(durableSource);
  const handoffResult = {
    bootstrapAttempts: 1,
    bootoutClean: true,
    pidWaitClean: true,
    portWaitClean: true,
    plistInstalled: true,
    serviceRegistered: true,
    diagnostics: { bootstrapResults: [], serviceProbeResults: [true], pidAliveChecks: [true], portChecks: [true] },
  };
  const result = await installStandaloneRecovery({
    controllerHome: home,
    repoRoot: durableSource,
    primaryRuntimeSourceRepositoryId: 'repo_durable_source',
    sourceRoot: durableSource,
  }, {
    ...recoveryInstallerStubs(),
    platform: 'darwin',
    uid: () => 501,
    installAgent: (sourcePath) => ({ path: sourcePath }),
    handoff: async () => handoffResult,
    currentPid: () => undefined,
    verify: async ({ expectedRelease }) => ({
      ok: true,
      expectedReleaseRevision: expectedRelease.releaseRevision,
      failures: [],
      gatewayPid: 4101,
      watchdogPid: 4102,
      healthStatus: 200,
    }),
  });

  expect(result.config.primaryRuntimeSourceRoot).toBe(resolve(durableSource));
  expect(result.config.primaryRuntimeSourceRepositoryId).toBe('repo_durable_source');
  expect(loadRecoveryConfig(home).primaryRuntimeSourceRoot).toBe(resolve(durableSource));
  expect(loadRecoveryConfig(home).primaryRuntimeSourceRepositoryId).toBe('repo_durable_source');
  expect(result.staged.release.sourceCommit).toBe(sourceCommit);
  expect(result.staged.release.productVersion).toBe('1.7.2');
  expect(result.activated?.release.sourceCommit).toBe(sourceCommit);
  expect(result.activated?.release.productVersion).toBe('1.7.2');
  const gatewayPlist = readFileSync(join(home, 'recovery', 'launchd', 'com.moretea.forge-recovery-gateway.plist'), 'utf8');
  expect(gatewayPlist).toContain('FORGE_BUILD_VERSION=1.7.2');
  expect(result.activated?.verification.ok).toBe(true);
});

test('Recovery command PATH includes the standard user binary directory outside interactive shells', () => {
  expect(recoveryCommandPath('/usr/bin:/bin', 'linux', '/home/forge-user')).toBe('/home/forge-user/.local/bin:/usr/bin:/bin');
  expect(recoveryCommandPath('/home/forge-user/.local/bin:/usr/bin', 'linux', '/home/forge-user')).toBe('/home/forge-user/.local/bin:/usr/bin');
  expect(recoveryCommandPath('C:\\Windows\\System32', 'win32', 'C:\\Users\\forge')).toBe('C:\\Windows\\System32');
});

function controllerHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'standalone-recovery-canonical-'));
  roots.push(home);
  inspectControlPlaneDatabase(home);
  // A known-good attestation is a real offline restore point, including the
  // declarative Runtime service contract. Keep the canonical fixture aligned
  // with production rather than accepting metadata-only attestations.
  runtimeServiceConfig(home);
  return home;
}

function committedRecoverySource(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'recovery source\n');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'forge-recovery-fixture', version: '1.7.2' })}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Forge Test', '-c', 'user.email=forge-test@example.invalid', 'commit', '-qm', 'recovery source'], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function recoveryInstallerStubs() {
  return {
    now: () => 1_788_650_000_000,
    uuid: () => '12345678-1234-1234-1234-123456789abc',
    compileBinary: ({ outputPath }: { sourceRoot: string; outputPath: string }) => {
      writeFileSync(outputPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      return { ok: true, status: 0, signal: null, timedOut: false, command: ['stub-compile'], stdout: 'compiled\n', stderr: '', error: '' };
    },
    runCanary: () => ({ ok: true, status: 0, signal: null, timedOut: false, command: ['stub-canary'], stdout: 'canary ok\n', stderr: '', error: '' }),
  };
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

function writeReleaseExecutionSurface(releaseRoot: string): {
  processRunnerArtifactIdentity: string;
  checkRunnerArtifactIdentity: string;
} {
  const processRunner = '#!/bin/sh\nif [ -f fail-process-runner ]; then exit 71; fi\nexit 0\n';
  const checkRunner = '#!/bin/sh\nif [ -f fail-check-runner ]; then exit 73; fi\nexit 0\n';
  const processRunnerPath = join(releaseRoot, 'process-runner.js');
  const checkRunnerPath = join(releaseRoot, 'forge-check-runner');
  writeFileSync(processRunnerPath, processRunner);
  writeFileSync(checkRunnerPath, checkRunner);
  chmodSync(processRunnerPath, 0o700);
  chmodSync(checkRunnerPath, 0o700);
  return {
    processRunnerArtifactIdentity: `sha256:${createHash('sha256').update(processRunner).digest('hex')}`,
    checkRunnerArtifactIdentity: `sha256:${createHash('sha256').update(checkRunner).digest('hex')}`,
  };
}

function manifest(home: string, releaseId: string, artifactIdentity: string, workerProtocolVersion = 1): string {
  const releaseRoot = join(home, 'runtime', 'releases', releaseId);
  const path = join(releaseRoot, 'manifest.json');
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(join(releaseRoot, 'forge-runtime'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const executionSurface = writeReleaseExecutionSurface(releaseRoot);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'forge-runtime',
    processRunnerEntrypoint: 'process-runner.js',
    processRunnerArtifactIdentity: executionSurface.processRunnerArtifactIdentity,
    checkRunnerEntrypoint: 'forge-check-runner',
    checkRunnerArtifactIdentity: executionSurface.checkRunnerArtifactIdentity,
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
  const executionSurface = writeReleaseExecutionSurface(releaseRoot);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'forge-runtime',
    processRunnerEntrypoint: 'process-runner.js',
    processRunnerArtifactIdentity: executionSurface.processRunnerArtifactIdentity,
    checkRunnerEntrypoint: 'forge-check-runner',
    checkRunnerArtifactIdentity: executionSurface.checkRunnerArtifactIdentity,
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
    if (request.method === 'GET' && (request.url === '/health' || request.url === '/ready' || request.url === '/transport-ready')) {
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

async function failingPublicGatewayServer(status = 530): Promise<{ endpoint: string; requests: RuntimeRequestRecord[] }> {
  const requests: RuntimeRequestRecord[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorizationPresent: typeof request.headers.authorization === 'string',
      accept: request.headers.accept,
      contentType: request.headers['content-type'],
      body: '',
    });
    response.statusCode = status;
    response.end(JSON.stringify({ error: 'upstream_transport_unavailable' }));
  });
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failing public Gateway test server unavailable');
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
}

async function saturatedPublicGatewayServer(): Promise<{ endpoint: string; requests: RuntimeRequestRecord[] }> {
  const requests: RuntimeRequestRecord[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorizationPresent: typeof request.headers.authorization === 'string',
      accept: request.headers.accept,
      contentType: request.headers['content-type'],
      body: '',
    });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/transport-ready') {
      response.statusCode = 503;
      response.end(JSON.stringify({
        status: 'saturated',
        sessionCapacity: {
          sessionCount: 8,
          maximumSessions: 8,
          admissibleSessionCount: 0,
          oldestActivePostAgeMs: 65_000,
          recoveryRecommended: true,
        },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/mcp') {
      response.statusCode = 401;
      response.setHeader('www-authenticate', 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
      response.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('public Gateway test server unavailable');
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
}

async function legacyConnectorTransportServer(mcpStatus = 401): Promise<{ endpoint: string; requests: RuntimeRequestRecord[] }> {
  const requests: RuntimeRequestRecord[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorizationPresent: typeof request.headers.authorization === 'string',
      accept: request.headers.accept,
      contentType: request.headers['content-type'],
      body: '',
    });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/transport-ready') {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/mcp') {
      response.statusCode = mcpStatus;
      if (mcpStatus === 401) response.setHeader('www-authenticate', 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
      response.end(JSON.stringify(mcpStatus === 401 ? { error: 'invalid_token' } : { error: 'connector_transport_failed' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/ready') {
      // Legacy whole-control-plane readiness deliberately never answers.
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('legacy Connector transport test server unavailable');
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
}

async function healthyTransportWithHungLegacyReadinessServer(): Promise<{ endpoint: string; requests: RuntimeRequestRecord[] }> {
  const requests: RuntimeRequestRecord[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorizationPresent: typeof request.headers.authorization === 'string',
      accept: request.headers.accept,
      contentType: request.headers['content-type'],
      body: '',
    });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/transport-ready') {
      response.statusCode = 200;
      response.end(JSON.stringify({
        ready: true,
        sessionCapacity: {
          active: 0,
          maximum: 64,
          acceptingNewSessions: true,
          activePosts: 0,
          activeStreams: 0,
          recoveryRecommended: false,
        },
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/mcp') {
      response.statusCode = 401;
      response.setHeader('www-authenticate', 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
      response.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/ready') {
      // Exact regression shape: the legacy whole-control-plane readiness route
      // never answers even though the public MCP transport itself is healthy.
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('hung legacy readiness test server unavailable');
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, requests };
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
  const acquired = acquireRuntimeOwnership(home, runtimeInstanceId);
  const ownership: RuntimeOwnershipHandle = {
    record: acquired.record,
    release: () => {
      acquired.release();
      rmSync(runtimeIncarnationPath(home), { force: true });
    },
  };
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

test('standalone Recovery restarts only the configured primary Connector service with durable request attribution', async () => {
  const home = controllerHome();
  const plistPath = join(home, 'connector.plist');
  writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway', plistPath },
  });
  const commands: string[][] = [];
  let observedLock: Record<string, unknown> | undefined;
  const result = await restartPrimaryConnector(config, {
    requestId: 'recovery-gateway:test-primary-connector-restart',
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => healthyVerify(),
    repairConnectorBinding: async () => {
      observedLock = JSON.parse(readFileSync(join(home, 'recovery', 'locks', 'operation.lock'), 'utf8')) as Record<string, unknown>;
      return { ok: true, attempted: false, noOp: true, detail: 'binding already current' };
    },
    reconnect: async () => ({ ok: true, detail: 'public MCP reachable', verify: healthyVerify() }),
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: 'gui/501/com.moretea.forge.mcp-gateway' });
  expect(observedLock).toMatchObject({
    action: 'restart_primary_connector',
    requestId: 'recovery-gateway:test-primary-connector-restart',
    pid: process.pid,
  });
  expect(commands).toContainEqual(['launchctl', 'print', 'gui/501/com.moretea.forge.mcp-gateway']);
  expect(commands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
});

test('standalone Recovery permits targeted Connector recovery when Runtime authority is healthy but gateway observation is stale', async () => {
  const home = controllerHome();
  const plistPath = join(home, 'connector-stale-gateway.plist');
  writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway-stale', plistPath },
  });
  const contradictoryLocal: VerifyResult = {
    ...healthyVerify(),
    ok: false,
    probes: {
      ...healthyVerify().probes,
      active_gateway: { ok: false, detail: 'request failed' },
      mcp_initialize: { ok: false, detail: 'MCP request failed' },
      runtime_execution_surface: { ok: true, detail: 'attested execution surface' },
    },
  };
  let localProbeCalls = 0;
  const commands: string[][] = [];
  const result = await restartPrimaryConnector(config, {
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => contradictoryLocal,
    repairConnectorBinding: async () => ({ ok: true, attempted: false, noOp: true, detail: 'binding current' }),
    probeConnectorLocal: async () => {
      localProbeCalls += 1;
      return localProbeCalls >= 2
        ? { ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 }
        : { ok: false, detail: 'connection refused' };
    },
    probeConnectorOwnership: async () => ({ ok: true, detail: 'listener owned' }),
    reconnect: async () => ({ ok: true, detail: 'public MCP reachable', verify: healthyVerify() }),
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });

  expect(result).toMatchObject({ ok: true, attempted: true });
  expect(commands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway-stale']);
});

test('standalone Recovery restarts the canonical Linux systemd-user primary Connector without launchd', async () => {
  const home = controllerHome();
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: {
      platform: 'systemd-user',
      localMcpUrl: 'http://127.0.0.1:8767/mcp',
      postRestartVerifyTimeoutMs: 5_000,
    },
  });
  let localProbeCalls = 0;
  let clock = 0;
  const commands: string[][] = [];
  const result = await restartPrimaryConnector(config, {
    platform: 'linux',
    currentUid: async () => 1000,
    verifyLocal: async () => healthyVerify(),
    repairConnectorBinding: async () => ({ ok: true, attempted: false, noOp: true, detail: 'binding current' }),
    probeConnectorLocal: async () => {
      localProbeCalls += 1;
      return localProbeCalls >= 2
        ? { ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 }
        : { ok: false, detail: 'connection refused' };
    },
    reconnect: async () => ({ ok: true, detail: 'public MCP reachable', verify: healthyVerify() }),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      if (name === 'systemctl' && args.includes('restart')) return { ok: true, status: 0, stdout: '', stderr: '' };
      if (name === 'systemctl' && args.includes('MainPID')) return { ok: true, status: 0, stdout: '4242\n', stderr: '' };
      if (name === 'lsof') return { ok: true, status: 0, stdout: '4242\n', stderr: '' };
      throw new Error(`unexpected command ${name} ${args.join(' ')}`);
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true });
  expect(commands.some((entry) => entry[0] === 'systemctl' && entry[1] === '--user' && entry[2] === 'restart')).toBe(true);
  expect(commands.some((entry) => entry[0] === 'systemctl' && entry.includes('MainPID'))).toBe(true);
  expect(commands.some((entry) => entry[0] === 'lsof' && entry.includes('4242'))).toBe(true);
  expect(commands.some((entry) => entry[0] === 'launchctl')).toBe(false);
});

test('standalone Recovery repairs a failed Connector when only the Connector loopback probe is unhealthy', async () => {
  const home = controllerHome();
  const plistPath = join(home, 'connector.plist');
  writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway', plistPath },
  });
  const commands: string[][] = [];
  const localFailure = {
    ...healthyVerify(),
    ok: false,
    probes: {
      ...healthyVerify().probes,
      primary_connector_local: { ok: false, detail: 'connection refused' },
    },
  };
  const result = await restartPrimaryConnector(config, {
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => localFailure,
    reconnect: async () => ({ ok: true, detail: 'public MCP reachable', verify: healthyVerify() }),
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: 'gui/501/com.moretea.forge.mcp-gateway' });
  expect(commands).toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
});

test('standalone Recovery fails closed on a live legacy mutation lock without request identity', async () => {
  const home = controllerHome();
  const plistPath = join(home, 'connector.plist');
  writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway', plistPath },
  });
  const lockFile = join(home, 'recovery', 'locks', 'operation.lock');
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    instanceId: 'legacy-live-lock',
    acquiredAt: new Date().toISOString(),
    action: 'restart_primary_connector',
  }));

  await expect(restartPrimaryConnector(config, {
    requestId: 'recovery-gateway:new-primary-connector-restart',
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => healthyVerify(),
  })).rejects.toThrow('RECOVERY_OPERATION_LOCK_IDENTITY_UNCERTAIN');

  expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ instanceId: 'legacy-live-lock' });
  expect(readFileSync(join(home, 'recovery', 'audit', 'recovery.jsonl'), 'utf8')).toContain('recovery_operation_lock_identity_uncertain');
});

test('shared Recovery operation locks synthesize core-compatible request attribution', async () => {
  const home = controllerHome();
  const plistPath = join(home, 'connector.plist');
  writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway', plistPath },
  });
  const aliasRoot = mkdtempSync(join(tmpdir(), 'forge-recovery-lock-alias-'));
  roots.push(aliasRoot);
  const aliasHome = join(aliasRoot, 'controller-home-link');
  symlinkSync(home, aliasHome, 'dir');
  expect(recoveryOperationLockPath(aliasHome)).toBe(recoveryOperationLockPath(home));
  expect(recoveryOperationLockPath(aliasHome)).toBe(join(realpathSync(home), 'recovery', 'locks', 'operation.lock'));

  const shared = acquireRecoveryOperationLock({
    controllerHome: home,
    action: 'install_recovery_release',
    instanceIdPrefix: 'test-shared-recovery-',
  });
  expect(shared.acquired).toBe(true);
  if (!shared.acquired) throw new Error('shared Recovery lock was not acquired');
  expect(shared.handle.record.requestId).toBe(`internal:install_recovery_release:${shared.handle.record.instanceId}`);
  try {
    const competing = await restartPrimaryConnector(config, {
      requestId: 'recovery-gateway:competing-restart',
      platform: 'darwin',
      currentUid: async () => 501,
      verifyLocal: async () => healthyVerify(),
    });
    expect(competing).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(competing.detail).toContain('Recovery mutation already in progress: action=install_recovery_release');
    expect(competing.detail).toContain(`request=${shared.handle.record.requestId}`);
  } finally {
    shared.handle.close();
  }
});

test('shared Recovery operation lock removes a malformed file when record persistence fails', () => {
  const home = controllerHome();
  const path = recoveryOperationLockPath(home);
  expect(() => acquireRecoveryOperationLock({
    controllerHome: home,
    action: 'certify_stable_baseline',
    requestId: 'test-write-failure',
  }, {
    writeRecord: (fd, content) => {
      writeFileSync(fd, content.slice(0, 1));
      throw new Error('synthetic lock write failure');
    },
  })).toThrow('synthetic lock write failure');
  expect(existsSync(path)).toBe(false);

  const retry = acquireRecoveryOperationLock({
    controllerHome: home,
    action: 'install_recovery_release',
    requestId: 'test-retry-after-write-failure',
  });
  expect(retry.acquired).toBe(true);
  if (retry.acquired) retry.handle.close();
  expect(existsSync(path)).toBe(false);
});

test('standalone Recovery repairs immutable Connector release binding before deciding whether kickstart is still needed', async () => {
  const home = controllerHome();
  const plistPath = join(home, 'connector.plist');
  writeFileSync(plistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: { platform: 'launchd', label: 'com.moretea.forge.mcp-gateway', plistPath },
  });
  let repairs = 0;
  const commands: string[][] = [];
  const result = await restartPrimaryConnector(config, {
    platform: 'darwin',
    currentUid: async () => 501,
    verifyLocal: async () => healthyVerify(),
    repairConnectorBinding: async () => {
      repairs += 1;
      return { ok: true, attempted: true, detail: 'synthetic immutable binding repair' };
    },
    probeConnectorLocal: async () => ({ ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 }),
    probeConnectorOwnership: async () => ({ ok: true, detail: 'configured launchd service owns TCP 8767' }),
    reconnect: async () => ({ ok: true, detail: 'public MCP reachable', verify: healthyVerify() }),
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  });
  expect(repairs).toBe(1);
  expect(result).toMatchObject({ ok: true, attempted: true });
  expect(result.noOp).not.toBe(true);
  expect(result.detail).toContain('immutable release binding was repaired');
  expect(commands).not.toContainEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.moretea.forge.mcp-gateway']);
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

test('standalone Recovery uses its client-owned loopback health only when a primary OpenAI tunnel status command is unavailable', async () => {
  const home = controllerHome();
  const profileDir = join(home, 'tunnel-client');
  const healthUrlFile = join(home, 'tunnel-health.url');
  const tunnelId = 'tunnel_abcdef0123456789abcdef0123456789';
  const endpoint = 'http://127.0.0.1:8767/mcp';
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(healthUrlFile, 'http://127.0.0.1:45613\n');
  writeFileSync(join(profileDir, 'forge.yaml'), JSON.stringify({
    control_plane: { tunnel_id: tunnelId },
    health: { url_file: healthUrlFile },
    mcp: { server_urls: [{ url: endpoint }] },
  }));
  const requests: string[] = [];
  const observed = await observeOpenAiTunnelLocalHealthFallback({
    platform: 'openai-secure-tunnel',
    alias: 'forge',
    tunnelId,
    mcpServerUrl: endpoint,
    profile: 'forge',
    profileDir,
  }, {
    request: async (url) => {
      requests.push(url);
      return { ok: true, status: 200 };
    },
  });
  expect(observed).toMatchObject({ ok: true, running: true, healthy: true, ready: true, tunnelMatches: true, endpointMatches: true, observedTunnelId: tunnelId });
  expect(requests).toEqual(['http://127.0.0.1:45613/healthz', 'http://127.0.0.1:45613/readyz']);
});

test('standalone Recovery repairs a Linux primary OpenAI Secure MCP Tunnel without restarting a healthy Connector', async () => {
  const home = controllerHome();
  const connectorEndpoint = 'http://127.0.0.1:8767/mcp';
  const tunnelId = 'tunnel_abcdef0123456789abcdef0123456789';
  const config = createRecoveryConfig(home, {
    publicMcpUrl: 'https://mcp.example.test/mcp',
    primaryConnectorService: {
      platform: 'systemd-user',
      localMcpUrl: connectorEndpoint,
      postRestartVerifyTimeoutMs: 5_000,
    },
    primaryPublicTunnelService: {
      platform: 'openai-secure-tunnel',
      alias: 'forge',
      tunnelId,
      mcpServerUrl: connectorEndpoint,
      runtimeApiKeyRef: 'env:FORGE_TUNNEL_RUNTIME_KEY',
      adminProfile: 'forge-admin',
      postRestartVerifyTimeoutMs: 5_000,
    },
  });
  let reconnectCalls = 0;
  let tunnelConnected = false;
  let clock = 0;
  const commands: string[][] = [];
  const result = await restartPrimaryConnector(config, {
    platform: 'linux',
    currentUid: async () => 1000,
    verifyLocal: async () => healthyVerify(),
    repairConnectorBinding: async () => ({ ok: true, attempted: false, noOp: true, detail: 'binding current' }),
    probeConnectorLocal: async () => ({ ok: true, detail: 'HTTP 401 OAuth challenge', status: 401 }),
    reconnect: async () => {
      reconnectCalls += 1;
      return reconnectCalls >= 2
        ? { ok: true, detail: 'public MCP reachable', verify: healthyVerify() }
        : { ok: false, detail: 'public tunnel unavailable', verify: { ...healthyVerify(), ok: false } };
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      if (name === 'systemctl' && args.includes('MainPID')) return { ok: true, status: 0, stdout: '4242\n', stderr: '' };
      if (name === 'lsof') return { ok: true, status: 0, stdout: '4242\n', stderr: '' };
      if (name === 'tunnel-client' && args[0] === 'runtimes' && args[1] === 'status') {
        return tunnelConnected
          ? { ok: true, status: 0, stdout: JSON.stringify({ process_running: true, healthy: true, ready: true, tunnel_id: tunnelId }), stderr: '' }
          : { ok: false, status: 1, stdout: '', stderr: 'stopped' };
      }
      if (name === 'tunnel-client' && args[0] === 'runtimes' && args[1] === 'connect') {
        tunnelConnected = true;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${name} ${args.join(' ')}`);
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true });
  expect(commands).toContainEqual(['tunnel-client', 'runtimes', 'status', 'forge', '--json', '--admin-profile', 'forge-admin']);
  expect(commands.some((entry) => entry[0] === 'tunnel-client' && entry[1] === 'runtimes' && entry[2] === 'connect')).toBe(true);
  expect(commands.some((entry) => entry[0] === 'systemctl' && entry.includes('restart'))).toBe(false);
  expect(commands.some((entry) => entry[0] === 'launchctl')).toBe(false);
  expect(reconnectCalls).toBe(2);
});

test('standalone Recovery repairs its dedicated OpenAI Secure MCP Tunnel without repointing the primary Forge alias', async () => {
  const home = controllerHome();
  const profilePath = join(home, 'forge-recovery-tunnel.yaml');
  const endpoint = 'http://127.0.0.1:8787/recovery/mcp';
  writeFileSync(profilePath, `target: ${endpoint}\n`);
  const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
  const config = createRecoveryConfig(home, {
    recoveryTunnelService: {
      platform: 'openai-secure-tunnel',
      alias: 'forge-recovery',
      tunnelId,
      mcpServerUrl: endpoint,
      runtimeApiKeyRef: 'file:/tmp/forge-recovery-runtime-key',
      profile: 'forge-recovery',
      profileDir: home,
      postRestartVerifyTimeoutMs: 3_000,
      cooldownMs: 0,
    },
  });
  let connected = false;
  let clock = 0;
  const commands: string[][] = [];
  const verification = (): VerifyResult => ({
    ...healthyVerify(),
    probes: {
      ...healthyVerify().probes,
      recovery_gateway: { ok: true, detail: 'HTTP 200' },
      recovery_tunnel_runtime: { ok: connected, detail: connected ? 'ready' : 'stopped' },
    },
  });
  const result = await repairPublicTunnel(config, {
    platform: 'linux',
    verify: async () => verification(),
    verifyLocal: async () => verification(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      if (args[0] === 'runtimes' && args[1] === 'connect') {
        connected = true;
        return { ok: true, status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'runtimes' && args[1] === 'status') {
        if (!connected) return { ok: false, status: 1, stdout: '', stderr: 'runtime alias not connected' };
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify({ process_running: true, healthy: true, ready: true, tunnel_id: tunnelId, profile_path: profilePath }),
          stderr: '',
        };
      }
      throw new Error(`unexpected command ${name} ${args.join(' ')}`);
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true, serviceLabel: 'forge-recovery', serviceTarget: 'tunnel-client:forge-recovery' });
  const connect = commands.find((entry) => entry[1] === 'runtimes' && entry[2] === 'connect');
  expect(connect).toEqual([
    'tunnel-client', 'runtimes', 'connect', '--alias', 'forge-recovery', '--tunnel-id', tunnelId,
    '--runtime-api-key', 'file:/tmp/forge-recovery-runtime-key', '--mcp-server-url', endpoint,
    '--profile', 'forge-recovery', '--profile-dir', home,
  ]);
  expect(commands.some((entry) => entry.includes('forge') && !entry.includes('forge-recovery'))).toBe(false);
});

test('standalone Recovery repairs its dedicated Linux systemd-user public tunnel by exact unit identity', async () => {
  const home = controllerHome();
  const unitName = 'com.moretea.forge-recovery-cloudflare.service';
  const config = createRecoveryConfig(home, {
    recoveryPublicUrl: 'https://recovery-wsl.example.test/recovery/mcp',
    recoveryTunnelService: { platform: 'systemd-user', unitName, cooldownMs: 0, postRestartVerifyTimeoutMs: 3_000 },
  });
  let restarted = false;
  let clock = 0;
  const commands: string[][] = [];
  const verification = (): VerifyResult => ({
    ...healthyVerify(),
    probes: {
      ...healthyVerify().probes,
      recovery_gateway: { ok: true, detail: 'HTTP 200' },
      recovery_external_http: { ok: restarted, detail: restarted ? 'HTTP 401 OAuth challenge' : 'HTTP 530' },
    },
  });
  const result = await repairPublicTunnel(config, {
    platform: 'linux',
    verify: async () => verification(),
    verifyLocal: async () => healthyVerify(),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      if (name !== 'systemctl') throw new Error(`unexpected command ${name}`);
      if (args[1] === 'show') return { ok: true, status: 0, stdout: 'loaded\n', stderr: '' };
      if (args[1] === 'restart' && args[2] === unitName) { restarted = true; return { ok: true, status: 0, stdout: '', stderr: '' }; }
      throw new Error(`unexpected systemctl args ${args.join(' ')}`);
    },
  });
  expect(result).toMatchObject({ ok: true, attempted: true, serviceLabel: unitName, serviceTarget: unitName });
  expect(commands).toContainEqual(['systemctl', '--user', 'show', '--property=LoadState', '--value', unitName]);
  expect(commands).toContainEqual(['systemctl', '--user', 'restart', unitName]);
  expect(commands.some((entry) => entry[0] === 'launchctl' || entry[0] === 'tunnel-client')).toBe(false);
});

test('standalone Recovery rejects invalid or unavailable systemd-user public tunnel identity', async () => {
  const home = controllerHome();
  const degraded: VerifyResult = {
    ...healthyVerify(),
    probes: { ...healthyVerify().probes, recovery_gateway: { ok: true, detail: 'HTTP 200' }, recovery_external_http: { ok: false, detail: 'HTTP 530' } },
  };
  const invalid = await repairPublicTunnel(createRecoveryConfig(home, {
    recoveryPublicUrl: 'https://recovery-wsl.example.test/recovery/mcp',
    recoveryTunnelService: { platform: 'systemd-user', unitName: '../bad.service', cooldownMs: 0 },
  }), { platform: 'linux', verify: async () => degraded, verifyLocal: async () => healthyVerify() });
  expect(invalid).toMatchObject({ ok: false, attempted: false, noOp: true, detail: 'public tunnel systemd-user configuration is invalid' });

  const commands: string[][] = [];
  const unavailable = await repairPublicTunnel(createRecoveryConfig(home, {
    recoveryPublicUrl: 'https://recovery-wsl.example.test/recovery/mcp',
    recoveryTunnelService: { platform: 'systemd-user', unitName: 'com.moretea.missing.service', cooldownMs: 0 },
  }), {
    platform: 'linux',
    verify: async () => degraded,
    verifyLocal: async () => healthyVerify(),
    runCommand: async (name, args) => { commands.push([name, ...args]); return { ok: true, status: 0, stdout: 'not-found\n', stderr: '' }; },
  });
  expect(unavailable).toMatchObject({ ok: false, attempted: false, noOp: true, detail: 'public tunnel systemd-user unit is not loaded: com.moretea.missing.service' });
  expect(commands).toEqual([['systemctl', '--user', 'show', '--property=LoadState', '--value', 'com.moretea.missing.service']]);
});

test('standalone Recovery refuses to repoint an OpenAI tunnel alias owned by another tunnel', async () => {
  const home = controllerHome();
  const endpoint = 'http://127.0.0.1:8787/recovery/mcp';
  const profilePath = join(home, 'foreign-tunnel.yaml');
  writeFileSync(profilePath, `target: ${endpoint}\n`);
  const config = createRecoveryConfig(home, {
    recoveryTunnelService: {
      platform: 'openai-secure-tunnel',
      alias: 'forge-recovery',
      tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
      mcpServerUrl: endpoint,
      runtimeApiKeyRef: 'env:RECOVERY_TUNNEL_KEY',
      cooldownMs: 0,
    },
  });
  const commands: string[][] = [];
  const degraded: VerifyResult = {
    ...healthyVerify(),
    probes: {
      ...healthyVerify().probes,
      recovery_gateway: { ok: true, detail: 'HTTP 200' },
      recovery_tunnel_runtime: { ok: false, detail: 'wrong tunnel' },
    },
  };
  const result = await repairPublicTunnel(config, {
    platform: 'linux',
    verify: async () => degraded,
    verifyLocal: async () => degraded,
    runCommand: async (name, args) => {
      commands.push([name, ...args]);
      return {
        ok: true,
        status: 0,
        stdout: JSON.stringify({
          process_running: true,
          healthy: true,
          ready: true,
          tunnel_id: 'tunnel_ffffffffffffffffffffffffffffffff',
          profile_path: profilePath,
        }),
        stderr: '',
      };
    },
  });
  expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
  expect(result.detail).toContain('already bound to a different tunnel id');
  expect(commands.filter((entry) => entry[1] === 'runtimes' && entry[2] === 'connect')).toHaveLength(0);
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

test('Recovery activate_runtime_release resolves release_path as an immutable release directory', async () => {
  const home = controllerHome();
  const candidate = verifiedManifest(home, 'release-directory-contract');
  for (const [requestId, releasePath] of [
    ['activate-directory-contract', dirname(candidate.path)],
    ['activate-manifest-compat', candidate.path],
  ] as const) {
    const config = createRecoveryConfig(home);
    const result = await dispatchRecoveryTool(config, 'activate_runtime_release', {
      request_id: requestId,
      ...recoveryMutationIdentityArgs(config),
      release_path: releasePath,
      expected_active_release_id: 'release-baseline',
      expected_authority_revision: 1,
    }) as { attempted?: boolean; noOp?: boolean; detail?: string };

    expect(result).toMatchObject({ attempted: false, noOp: true });
    expect(result.detail).not.toContain('EISDIR');
    expect(result.detail).not.toContain('RELEASE_MANIFEST_INVALID');
  }
});

test('legacy stage-and-activate ABI only prepares isolated Candidate B and never mutates Stable A', async () => {
  const home = controllerHome();
  const sourceRoot = join(home, 'source');
  const sourceRevision = committedRecoverySource(sourceRoot);
  const baseline = verifiedManifest(home, 'release-baseline');
  ensureActiveRuntimeRelease(home, baseline.path);
  const runtime = await runtimeServer();
  writeMainToken(home);
  startObservedRuntime(home, runtime.endpoint, 'release-baseline', baseline.artifactIdentity);
  const expectedAuthority = readRuntimeReleaseAuthority(home)!;
  const config = createRecoveryConfig(home, {
    primaryRuntimeSourceRoot: sourceRoot,
    primaryRuntimeSourceRepositoryId: 'repo_source_fixture',
  });
  let stagedFrom = '';
  let candidateHome = '';
  let activationCalled = false;
  const result = await stageAndActivateConfiguredRuntimeRelease(config, {
    stage: (input) => {
      stagedFrom = input.sourceRoot;
      candidateHome = input.controllerHome;
      expect(input.sourceRepositoryId).toBe('repo_source_fixture');
      expect(resolve(input.controllerHome)).not.toBe(resolve(home));
      const operationLock = JSON.parse(readFileSync(join(home, 'recovery', 'locks', 'operation.lock'), 'utf8')) as Record<string, unknown>;
      expect(operationLock).toMatchObject({
        pid: process.pid,
        action: 'release_session_prepare',
        requestId: 'recovery-gateway:stage-request-1',
      });
      const releasePath = join(input.controllerHome, 'runtime', 'releases', 'release-new');
      mkdirSync(releasePath, { recursive: true });
      const manifestPath = join(releasePath, 'manifest.json');
      const runtimePath = join(releasePath, 'forge-runtime');
      writeFileSync(runtimePath, '#!/bin/sh\n# release-new\nexit 0\n', { mode: 0o700 });
      const artifactIdentity = `sha256:${createHash('sha256').update(readFileSync(runtimePath)).digest('hex')}`;
      writeFileSync(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        releaseId: 'release-new',
        artifactIdentity,
        entrypoint: 'forge-runtime',
        futureSidecarEntrypoint: 'future-sidecar-v2',
        arguments: [],
        configurationSchemaVersion: 1,
        deploymentScope: 'portable',
        databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
        workerProtocolVersion: 1,
        sourceCommit: sourceRevision,
        createdAt: '2026-08-14T00:00:00.000Z',
      }, null, 2)}\n`);
      writeFileSync(join(releasePath, 'future-sidecar-v2'), 'future-sidecar');
      return {
        controllerHome: input.controllerHome,
        releasePath,
        manifestPath,
        releaseId: 'release-new',
        artifactIdentity,
        manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
        sourceCommit: sourceRevision,
      };
    },
    activate: async () => {
      activationCalled = true;
      throw new Error('compatibility alias must never activate Stable A');
    },
  }, 'recovery-gateway:stage-request-1');
  expect(stagedFrom).toBe(resolve(sourceRoot));
  expect(candidateHome).not.toBe(resolve(home));
  expect(activationCalled).toBe(false);
  expect(result).toMatchObject({
    ok: true,
    attempted: true,
    staged: { releaseId: 'release-new', sourceCommit: sourceRevision },
    releaseSession: {
      phase: 'built',
      stable: { controllerHome: resolve(home) },
      candidate: { controllerHome: candidateHome },
      candidateRelease: { releaseId: 'release-new', sourceCommit: sourceRevision },
    },
  });
  expect(readRuntimeReleaseAuthority(home)).toMatchObject({
    revision: expectedAuthority.revision,
    active: { releaseId: 'release-baseline', artifactIdentity: baseline.artifactIdentity },
  });
});

test('watchdog defers Recovery self-repair while an attributable mutation lock is live', async () => {
  const home = controllerHome();
  const activeManifest = manifest(home, 'release-watchdog-mutation', 'artifact-watchdog-mutation');
  ensureActiveRuntimeRelease(home, activeManifest);
  const runtime = await runtimeServer();
  writeMainToken(home);
  startObservedRuntime(
    home,
    runtime.endpoint,
    'release-watchdog-mutation',
    'artifact-watchdog-mutation',
    new Date(Date.now() - 120_000).toISOString(),
  );
  const config = createRecoveryConfig(home, {
    gateway: {
      host: '127.0.0.1',
      port: 65534,
      bearerTokenFile: join(home, 'recovery', 'config', 'gateway-token.json'),
    },
  });
  mkdirSync(join(home, 'recovery', 'locks'), { recursive: true });
  writeFileSync(join(home, 'recovery', 'locks', 'operation.lock'), JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    instanceId: 'test-live-stage-mutation',
    acquiredAt: new Date().toISOString(),
    action: 'stage_and_activate_runtime_release',
    requestId: 'recovery-gateway:test-live-stage-mutation',
  }));

  const tick = await watchdogTick(config, {
    failures: 2,
    firstFailureAt: Date.now() - 6_000,
    rollbackUsed: false,
    lastFullVerifyAt: Date.now(),
  });

  expect(tick.verify.probes.recovery_gateway?.ok).toBe(false);
  expect(tick.decision).toMatchObject({
    action: 'degraded',
    reason: expect.stringContaining('stage_and_activate_runtime_release'),
  });
  expect(tick.state.failures).toBe(0);
  expect(tick.state.firstFailureAt).toBeUndefined();
  expect(tick.recoveryGatewayRestart).toBeUndefined();
  expect(tick.primaryRuntimeRestart).toBeUndefined();
});

const TEST_LINUX_HOME = '/home' + '/forge-test';
const TEST_MAC_HOME = '/Users' + '/forge-test';

describe('standalone recovery systemd user ownership', () => {
  test('selects the installed primary Runtime owner from the host service manager', () => {
    expect(defaultPrimaryRuntimeServiceConfig('linux')).toEqual({ platform: 'systemd-user' });
    expect(defaultPrimaryRuntimeServiceConfig('darwin')).toEqual({ platform: 'launchd' });
  });

  test('pins Gateway and Watchdog units to the current immutable Recovery release', () => {
    const controllerHome = '/tmp/forge-recovery-systemd-fixture';
    const serviceEnv = { PATH: '/usr/bin:/bin', FORGE_CONNECTOR_EXECUTABLE: '/opt/forge/bin/bun' };
    const gateway = recoverySystemdUserUnitInput(controllerHome, 'gateway', serviceEnv);
    const watchdog = recoverySystemdUserUnitInput(controllerHome, 'watchdog', serviceEnv);
    expect(gateway).toMatchObject({
      executable: expect.stringContaining('/recovery/current/forge-recovery-gateway'),
      args: ['gateway', '--controller-home', controllerHome],
      restart: 'always',
      restartSec: 5,
      environment: { PATH: '/usr/bin:/bin', FORGE_CONNECTOR_EXECUTABLE: '/opt/forge/bin/bun' },
    });
    expect(watchdog).toMatchObject({
      executable: expect.stringContaining('/recovery/current/forge-recovery-watchdog'),
      args: ['watchdog', '--controller-home', controllerHome],
      restart: 'always',
      restartSec: 5,
      environment: { FORGE_CONNECTOR_EXECUTABLE: '/opt/forge/bin/bun' },
    });
  });
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

  test('authenticates every MCP transport method before method dispatch', () => {
    const request = (method: string, url: string, authorization?: string) => ({
      method,
      url,
      headers: authorization ? { authorization } : {},
    } as Pick<IncomingMessage, 'method' | 'url' | 'headers'>);
    for (const path of ['/mcp', '/recovery/mcp']) {
      expect(classifyRecoveryMcpRequest(request('GET', path), 'test-token')).toBe('auth_required');
      expect(classifyRecoveryMcpRequest(request('DELETE', path), 'test-token')).toBe('auth_required');
      expect(classifyRecoveryMcpRequest(request('POST', path), 'test-token')).toBe('auth_required');
      expect(classifyRecoveryMcpRequest(request('GET', path, 'Bearer test-token'), 'test-token')).toBe('mcp');
      expect(classifyRecoveryMcpRequest(request('DELETE', path, 'Bearer test-token'), 'test-token')).toBe('mcp');
      expect(classifyRecoveryMcpRequest(request('POST', path, 'Bearer test-token'), 'test-token')).toBe('mcp');
    }
    expect(classifyRecoveryMcpRequest(request('GET', '/recovery/health'), 'test-token')).toBe('not_mcp');
  });


  test('Recovery MCP reinitializes a stale session after gateway restart', async () => {
    const tools = [{
      name: 'runtime_status',
      description: 'test recovery status',
      inputSchema: { type: 'object' as const, additionalProperties: false },
    }];
    const start = async (port = 0) => {
      const mcp = new RecoveryMcpSessionServer({
        tools,
        dispatchTool: async () => ({ ok: true }),
      });
      const httpServer = createServer(async (request, response) => {
        let body: unknown;
        if (request.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        await mcp.handle(request, response, body);
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        httpServer.once('error', rejectListen);
        httpServer.listen(port, '127.0.0.1', () => resolveListen());
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('TEST_RECOVERY_MCP_ADDRESS_MISSING');
      return { mcp, httpServer, port: address.port };
    };
    const stop = async (instance: Awaited<ReturnType<typeof start>>) => {
      await instance.mcp.close();
      await new Promise<void>((resolveClose, rejectClose) => instance.httpServer.close((error) => error ? rejectClose(error) : resolveClose()));
    };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const initializeBody = (id: number) => JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'recovery-restart-test', version: '1.0.0' },
      },
    });
    const toolsListBody = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    const readMcpResponse = async (response: Response): Promise<{ result?: { tools?: unknown[] } }> => {
      const text = await response.text();
      if (/text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
        const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data: '));
        if (!dataLine) throw new Error(`TEST_MCP_SSE_DATA_MISSING: ${text}`);
        return JSON.parse(dataLine.slice('data: '.length)) as { result?: { tools?: unknown[] } };
      }
      return JSON.parse(text) as { result?: { tools?: unknown[] } };
    };

    const first = await start();
    let second: Awaited<ReturnType<typeof start>> | undefined;
    try {
      const initialized = await fetch(`http://127.0.0.1:${first.port}/recovery/mcp`, { method: 'POST', headers, body: initializeBody(1) });
      expect(initialized.status).toBe(200);
      const staleSessionId = initialized.headers.get('mcp-session-id');
      expect(staleSessionId).toBeTruthy();
      await initialized.text();

      const initializedNotification = await fetch(`http://127.0.0.1:${first.port}/recovery/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': staleSessionId! },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect([200, 202]).toContain(initializedNotification.status);
      await initializedNotification.text();

      const beforeRestart = await fetch(`http://127.0.0.1:${first.port}/recovery/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': staleSessionId! },
        body: toolsListBody(2),
      });
      expect(beforeRestart.status).toBe(200);
      expect((await readMcpResponse(beforeRestart)).result?.tools?.length).toBe(1);

      const restartPort = first.port;
      await stop(first);
      second = await start(restartPort);

      const staleCall = await fetch(`http://127.0.0.1:${second.port}/recovery/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': staleSessionId! },
        body: toolsListBody(3),
      });
      expect(staleCall.status).toBe(404);
      expect(staleCall.headers.get('mcp-session-reset')).toBe('reinitialize');
      expect((await staleCall.json() as { code?: string }).code).toBe('MCP_SESSION_EXPIRED');

      const replacement = await fetch(`http://127.0.0.1:${second.port}/recovery/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': staleSessionId! },
        body: initializeBody(4),
      });
      expect(replacement.status).toBe(200);
      expect(replacement.headers.get('mcp-session-reset')).toBe('reinitialized');
      const replacementSessionId = replacement.headers.get('mcp-session-id');
      expect(replacementSessionId).toBeTruthy();
      expect(replacementSessionId).not.toBe(staleSessionId);
      await replacement.text();

      const afterRestart = await fetch(`http://127.0.0.1:${second.port}/recovery/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': replacementSessionId! },
        body: toolsListBody(5),
      });
      expect(afterRestart.status).toBe(200);
      expect((await readMcpResponse(afterRestart)).result?.tools?.length).toBe(1);

      const deleted = await fetch(`http://127.0.0.1:${second.port}/recovery/mcp`, {
        method: 'DELETE',
        headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': replacementSessionId! },
      });
      expect(deleted.status).toBeGreaterThanOrEqual(200);
      expect(deleted.status).toBeLessThan(300);
      await deleted.text();

      const afterDelete = await fetch(`http://127.0.0.1:${second.port}/recovery/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': replacementSessionId! },
        body: toolsListBody(6),
      });
      expect(afterDelete.status).toBe(404);
      expect(afterDelete.headers.get('mcp-session-reset')).toBe('reinitialize');
      await afterDelete.text();
    } finally {
      if (second) await stop(second);
      else if (first.httpServer.listening) await stop(first);
    }
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
    expect(attested.recoveryBundle).toMatchObject({
      schemaVersion: 1,
      database: { schemaVersion: 1 },
      serviceContract: {},
    });
    expect(existsSync(attested.recoveryBundle!.database.path)).toBe(true);
    expect(existsSync(attested.recoveryBundle!.serviceContract.path)).toBe(true);
    const repairedKnownGood = JSON.parse(readFileSync(knownGoodPath, 'utf8')) as { schemaVersion: number; releases: Array<{ revision: string; recoveryBundle?: unknown }> };
    expect(repairedKnownGood.schemaVersion).toBe(2);
    expect(repairedKnownGood.releases.map((entry) => entry.revision)).toEqual(['release-a']);
    expect(repairedKnownGood.releases[0]?.recoveryBundle).toBeDefined();

    const listed = await listReleases(config) as { runtimeRunning: boolean; runtimeReady: boolean; knownGood: Array<{ revision: string }> };
    expect(listed.runtimeRunning).toBe(true);
    expect(listed.runtimeReady).toBe(true);
    expect(listed.knownGood.map((entry) => entry.revision)).toContain('release-a');

    expect(await runtimeStatus(config)).toMatchObject({
      running: true,
      ready: true,
      recoveryWatchdog: {
        failures: 0,
        rollbackUsed: false,
        runtimeRestartAttempts: 0,
        primaryConnectorRestartAttempts: 0,
      },
    });
    expect(await dispatchRecoveryTool(config, 'runtime_status', {})).toMatchObject({
      identity: {
        controllerHome: resolve(home),
        platform: process.platform,
        targetRuntime: { serviceLabel: forgeRuntimeServicePaths(home).label },
      },
      running: true,
      ready: true,
      recoveryWatchdog: { failures: 0, rollbackUsed: false },
    });
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('runtime_status');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('restart_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('recover_primary_runtime');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('activate_runtime_release');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('pin_runtime_release');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('unpin_runtime_release');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('activate_pinned_runtime_release');
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'release_session_status',
      'prepare_runtime_release_session',
      'verify_runtime_release_session_static',
      'verify_runtime_release_session_candidate',
      'cutover_runtime_release_session',
      'cancel_runtime_release_session',
      'rollback_runtime_release_session',
      'promote_runtime_release_session_known_good',
    ]));
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).toContain('migrate_controller_home');
    const migrateTool = RECOVERY_TOOLS.find((tool) => tool.name === 'migrate_controller_home');
    expect(migrateTool?.inputSchema.required).toEqual(expect.arrayContaining([
      'request_id',
      'canonical_source_root',
      'expected_source_revision',
    ]));
    expect(migrateTool?.inputSchema.properties).not.toHaveProperty('destination_home');
    const activateTool = RECOVERY_TOOLS.find((tool) => tool.name === 'activate_runtime_release');
    const activateSchema = activateTool?.inputSchema as { required?: readonly string[]; properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(RECOVERY_MUTATION_IDENTITY_CONTRACT)).toEqual([...RECOVERY_MUTATION_IDENTITY_FIELDS]);
    for (const field of RECOVERY_MUTATION_IDENTITY_FIELDS) {
      expect(activateSchema?.properties?.[field]).toEqual(RECOVERY_MUTATION_IDENTITY_CONTRACT[field]);
    }
    expect(activateSchema?.required).toEqual(expect.arrayContaining([
      'request_id',
      ...Array.from(RECOVERY_MUTATION_IDENTITY_FIELDS),
      'release_path',
      'expected_active_release_id',
      'expected_authority_revision',
    ]));
    expect(activateSchema?.properties?.release_path).toMatchObject({
      description: 'Absolute path to the staged immutable Runtime release directory.',
    });
    for (const toolName of [
      'attest_known_good',
      'rollback_previous',
      'restart_primary_runtime',
      'restart_primary_connector',
      'recover_primary_runtime',
      'activate_runtime_release',
      'pin_runtime_release',
      'unpin_runtime_release',
      'activate_pinned_runtime_release',
      'stage_and_activate_runtime_release',
      'prepare_runtime_release_session',
      'verify_runtime_release_session_static',
      'verify_runtime_release_session_candidate',
      'cutover_runtime_release_session',
      'rollback_runtime_release_session',
      'promote_runtime_release_session_known_good',
      'migrate_controller_home',
      'restart_public_tunnel',
    ]) {
      const tool = RECOVERY_TOOLS.find((candidate) => candidate.name === toolName);
      const schema = tool?.inputSchema as { required?: readonly string[] } | undefined;
      expect(schema?.required).toEqual(expect.arrayContaining(['request_id', ...Array.from(RECOVERY_MUTATION_IDENTITY_FIELDS)]));
    }
    expect(RECOVERY_TOOLS.map((tool) => tool.name)).not.toContain('supervisor_status');
    expect(RECOVERY_CLI_COMMANDS).toContain('list-releases');
    expect(RECOVERY_CLI_COMMANDS).toContain('restart-primary-runtime');
    expect(RECOVERY_CLI_COMMANDS).toContain('recover-primary-runtime');
    expect(RECOVERY_CLI_COMMANDS).toContain('activate-runtime-release');
    expect(RECOVERY_CLI_COMMANDS).toEqual(expect.arrayContaining([
      'release-session-status',
      'release-session-prepare',
      'release-session-static-verify',
      'release-session-candidate-verify',
      'release-session-cutover',
      'release-session-cancel',
      'release-session-rollback',
      'release-session-known-good',
    ]));
    expect(RECOVERY_CLI_COMMANDS).toContain('migrate-controller-home-worker');
  });
  test('frozen Recovery clients can use their exported activation schema while partial or wrong explicit identity still fails closed', async () => {
    const home = controllerHome();
    const config = createRecoveryConfig(home);
    const frozenActivation = await dispatchRecoveryTool(config, 'activate_runtime_release', {
      request_id: 'frozen-schema-client',
      release_path: join(home, 'runtime', 'releases', 'missing-release'),
      expected_active_release_id: 'release-baseline',
      expected_authority_revision: 1,
    }) as { attempted?: boolean; noOp?: boolean; detail?: string };
    expect(frozenActivation).toMatchObject({ attempted: false, noOp: true });
    expect(frozenActivation.detail).toContain('RUNTIME_RELEASE_CANDIDATE_MANIFEST_MISSING');
    expect(frozenActivation.detail).not.toContain('RECOVERY_TARGET_IDENTITY_REQUIRED');

    const identity = recoveryMachineIdentity(config);
    await expect(dispatchRecoveryTool(config, 'restart_primary_runtime', {
      request_id: 'partial-machine-test',
      expected_host: identity.host,
    })).rejects.toThrow('RECOVERY_TARGET_IDENTITY_REQUIRED:expected_platform');
    await expect(dispatchRecoveryTool(config, 'restart_primary_runtime', {
      request_id: 'wrong-machine-test',
      ...recoveryMutationIdentityArgs(config),
      expected_host: 'different-machine.example',
    })).rejects.toThrow('RECOVERY_TARGET_IDENTITY_MISMATCH:expected_host');
  });

  test('Recovery OpenAI tunnel identity is machine-specific and cannot reuse the primary tunnel identity', () => {
    const wslAlias = recoveryOpenAiTunnelDefaultAlias(`${TEST_LINUX_HOME}/.forge/controller`, 'linux', 'windows-wsl');
    const macAlias = recoveryOpenAiTunnelDefaultAlias(`${TEST_MAC_HOME}/.forge/controller`, 'darwin', 'macbook');
    expect(wslAlias).toStartWith('forge-recovery-');
    expect(macAlias).toStartWith('forge-recovery-');
    expect(wslAlias).not.toBe(macAlias);
    expect(recoveryConnectorHasExternalTransport({
      public: false,
      services: {
        gateway: { label: 'gateway', platform: 'systemd-user', serviceInstalled: true, plistInstalled: false, running: true },
        watchdog: { label: 'watchdog', platform: 'systemd-user', serviceInstalled: true, plistInstalled: false, running: true },
        tunnel: { configured: true, platform: 'openai-secure-tunnel', alias: wslAlias, tunnelId: 'recovery-wsl-1', plistInstalled: false, restartSafe: true, running: true, healthy: true, ready: true },
      },
    })).toBe(true);
    const recovery = { platform: 'openai-secure-tunnel' as const, alias: wslAlias, tunnelId: 'recovery-wsl-1', mcpServerUrl: 'http://127.0.0.1:8787/recovery/mcp' };
    expect(() => assertDistinctRecoveryOpenAiTunnelIdentity(recovery, {
      platform: 'openai-secure-tunnel', alias: wslAlias, tunnelId: 'primary-1', mcpServerUrl: 'http://127.0.0.1:8765/mcp',
    })).toThrow('RECOVERY_OPENAI_TUNNEL_ALIAS_CONFLICT');
    expect(() => assertDistinctRecoveryOpenAiTunnelIdentity(recovery, {
      platform: 'openai-secure-tunnel', alias: 'forge-primary', tunnelId: 'recovery-wsl-1', mcpServerUrl: 'http://127.0.0.1:8765/mcp',
    })).toThrow('RECOVERY_OPENAI_TUNNEL_ID_CONFLICT');
    expect(() => assertDistinctRecoveryOpenAiTunnelIdentity(recovery, {
      platform: 'openai-secure-tunnel', alias: 'forge-primary', tunnelId: 'primary-1', mcpServerUrl: 'http://127.0.0.1:8765/mcp',
    })).not.toThrow();
  });


  test('Controller Home migration derives a Linux user-level destination and never accepts the current configured authority as a destination override', () => {
    expect(defaultUserControllerHomeForMigration({
      FORGE_CONTROLLER_HOME: `${TEST_MAC_HOME}/.forge/controller`,
      XDG_STATE_HOME: '',
    }, TEST_LINUX_HOME)).toBe(`${TEST_LINUX_HOME}/.forge/controller`);
    const owners = recoveryControllerHomeOwnerLabels(`${TEST_LINUX_HOME}/src/forge/_ops/controller-home`);
    expect(owners).toHaveLength(4);
    expect(owners[0]).toMatch(/^com\.moretea\.forge\.runtime\.[a-f0-9]+$/);
    expect(owners[1]).toMatch(/^com\.moretea\.forge\.mcp-gateway\.[a-f0-9]+$/);
    expect(owners.slice(2)).toEqual([
      'com.moretea.forge-recovery-gateway',
      'com.moretea.forge-recovery-watchdog',
    ]);
    const home = repoLocalControllerHome();
    const config = createRecoveryConfig(home);
    expect(() => scheduleRecoveryControllerHomeMigration(config, {
      requestId: 'migration-test-request',
      canonicalSourceRoot: `${TEST_LINUX_HOME}/src/forge`,
      expectedSourceRevision: 'deadbeef',
    }, { platform: 'darwin' })).toThrow('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  });

  test('Watchdog full verification does not attest release performance', async () => {
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
    expect(existsSync(knownGoodPath)).toBe(false);
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
    expect(tick.verify.probes.active_gateway?.ok).toBe(true);
    expect(tick.verify.probes.runtime_execution_surface).toBeUndefined();
    expect(tick.verify.probes.external_mcp_http).toBeUndefined();
    expect(tick.verify.probes.mcp_initialize).toBeUndefined();
    expect(existsSync(join(home, 'recovery', 'state', 'known-good.json'))).toBe(false);
  });

  test('probes cheap Connector transport readiness at /transport-ready and MCP with POST initialize while accepting a Bearer challenge', async () => {
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
    expect(runtime.requests.some((request) => request.method === 'GET' && request.url === '/transport-ready')).toBe(true);
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

  test('keeps primary Connector readiness healthy when legacy /ready hangs but transport and external MCP are healthy', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-transport-ready-isolated', 'artifact-transport-ready-isolated');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    const publicGateway = await healthyTransportWithHungLegacyReadinessServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-transport-ready-isolated', 'artifact-transport-ready-isolated');
    const config = createRecoveryConfig(home, {
      publicMcpUrl: publicGateway.endpoint,
      primaryConnectorService: {
        platform: 'launchd',
        label: 'com.moretea.forge.mcp-gateway',
      },
    });

    const startedAt = Date.now();
    const verified = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(verified.runtime.ok).toBe(true);
    expect(verified.probes.active_gateway).toMatchObject({ ok: true, status: 200 });
    expect(verified.probes.external_mcp_http).toMatchObject({ ok: true, status: 401 });
    expect(verified.probes.primary_connector_ready).toMatchObject({
      ok: true,
      status: 200,
      detail: 'transport-ready HTTP 200',
    });
    expect(publicGateway.requests.some((request) => request.method === 'GET' && request.url === '/transport-ready')).toBe(true);
    expect(publicGateway.requests.some((request) => request.method === 'GET' && request.url === '/ready')).toBe(false);
  });

  test('uses the configured local legacy Connector transport without falling back to whole-control-plane /ready', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-legacy-connector', 'artifact-legacy-connector');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const publicGateway = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const connector = await legacyConnectorTransportServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-legacy-connector', 'artifact-legacy-connector');
    const config = createRecoveryConfig(home, {
      publicMcpUrl: publicGateway.endpoint,
      primaryConnectorService: {
        platform: 'launchd',
        label: 'com.moretea.forge.mcp-gateway',
        localMcpUrl: connector.endpoint,
        minimumFailures: 1,
        minimumFailureDurationMs: 0,
      },
    });

    const verified = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(verified.ok).toBe(true);
    expect(verified.probes.external_mcp_http).toMatchObject({ ok: true, status: 401 });
    expect(verified.probes.primary_connector_ready).toMatchObject({
      ok: true,
      status: 401,
      detail: 'legacy-mcp HTTP 401 OAuth challenge',
    });
    expect(verified.probes.primary_connector_local).toMatchObject({ ok: true, status: 401 });
    expect(connector.requests.some((request) => request.method === 'GET' && request.url === '/transport-ready')).toBe(true);
    expect(connector.requests.some((request) => request.method === 'POST' && request.url === '/mcp')).toBe(true);
    expect(connector.requests.some((request) => request.method === 'GET' && request.url === '/ready')).toBe(false);
    expect(publicGateway.requests.some((request) => request.method === 'GET' && request.url === '/transport-ready')).toBe(false);
  });

  test('fails closed when a Secure Tunnel Connector unexpectedly returns an OAuth challenge', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-secure-tunnel-auth-drift', 'artifact-secure-tunnel-auth-drift');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const publicGateway = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const connector = await legacyConnectorTransportServer();
    writeMainToken(home);
    writeMcpServiceLocalConfig(home, { auth: { mode: 'none' }, chatgpt: {} });
    startObservedRuntime(
      home,
      runtime.endpoint,
      'release-secure-tunnel-auth-drift',
      'artifact-secure-tunnel-auth-drift',
      new Date(Date.now() - 120_000).toISOString(),
    );
    const config = createRecoveryConfig(home, {
      publicMcpUrl: publicGateway.endpoint,
      primaryConnectorService: {
        platform: 'launchd',
        label: 'com.moretea.forge.mcp-gateway',
        localMcpUrl: connector.endpoint,
        minimumFailures: 1,
        minimumFailureDurationMs: 0,
      },
    });

    const verified = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(verified.ok).toBe(false);
    expect(verified.probes.primary_connector_ready).toMatchObject({
      ok: false,
      status: 401,
      detail: 'legacy-mcp HTTP 401 unexpected OAuth challenge for unauthenticated Connector',
    });
    expect(verified.probes.primary_connector_local).toMatchObject({
      ok: false,
      status: 401,
      detail: 'HTTP 401 unexpected OAuth challenge for unauthenticated Connector',
    });

    const tick = await watchdogTick(config, {
      failures: 0,
      rollbackUsed: false,
      lastFullVerifyAt: Date.now(),
    });
    expect(tick.decision.action).toBe('restart_primary_connector');
  });

  test('keeps legacy Connector MCP transport failures fail-closed', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-legacy-connector-failed', 'artifact-legacy-connector-failed');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const publicGateway = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const connector = await legacyConnectorTransportServer(503);
    writeMainToken(home);
    startObservedRuntime(
      home,
      runtime.endpoint,
      'release-legacy-connector-failed',
      'artifact-legacy-connector-failed',
      new Date(Date.now() - 120_000).toISOString(),
    );
    const config = createRecoveryConfig(home, {
      publicMcpUrl: publicGateway.endpoint,
      primaryConnectorService: {
        platform: 'launchd',
        label: 'com.moretea.forge.mcp-gateway',
        localMcpUrl: connector.endpoint,
        minimumFailures: 1,
        minimumFailureDurationMs: 0,
      },
    });

    const verified = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(verified.ok).toBe(false);
    expect(verified.probes.external_mcp_http).toMatchObject({ ok: true, status: 401 });
    expect(verified.probes.primary_connector_ready).toMatchObject({ ok: false, status: 503, detail: 'legacy-mcp HTTP 503' });
    expect(verified.probes.primary_connector_local).toMatchObject({ ok: false, status: 503 });
    expect(connector.requests.some((request) => request.method === 'GET' && request.url === '/ready')).toBe(false);

    const tick = await watchdogTick(config, {
      failures: 1,
      firstFailureAt: Date.now() - 6_000,
      rollbackUsed: false,
      primaryConnectorFailures: 1,
      primaryConnectorFirstFailureAt: Date.now() - 6_000,
      lastFullVerifyAt: Date.now(),
    });
    expect(tick.decision.action).toBe('restart_primary_connector');
    expect(tick.primaryRuntimeRestart).toBeUndefined();
  });

  test('keeps an unmanaged external 530 separate from a healthy local primary Connector', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-primary-transport-530', 'artifact-primary-transport-530');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const connector = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const publicGateway = await failingPublicGatewayServer(530);
    writeMainToken(home);
    startObservedRuntime(
      home,
      runtime.endpoint,
      'release-primary-transport-530',
      'artifact-primary-transport-530',
      new Date(Date.now() - 120_000).toISOString(),
    );
    const config = createRecoveryConfig(home, {
      publicMcpUrl: publicGateway.endpoint,
      primaryConnectorService: {
        platform: 'launchd',
        label: 'com.moretea.forge.mcp-gateway',
        localMcpUrl: connector.endpoint,
        minimumFailures: 1,
        minimumFailureDurationMs: 0,
      },
    });

    const verified = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(verified.ok).toBe(false);
    expect(verified.probes.external_mcp_http).toMatchObject({ ok: false, status: 530 });
    expect(verified.probes.primary_connector_ready).toMatchObject({ ok: true, status: 200, detail: 'transport-ready HTTP 200' });
    expect(verified.probes.primary_connector_local).toMatchObject({ ok: true, status: 401 });

    const tick = await watchdogTick(config, {
      failures: 0,
      rollbackUsed: false,
      lastFullVerifyAt: Date.now(),
    });
    expect(tick.decision).toMatchObject({
      action: 'degraded',
      reason: expect.stringContaining('no managed primary public tunnel is configured'),
    });
    expect(tick.state.primaryConnectorFailures ?? 0).toBe(0);
    expect(tick.state.primaryConnectorRestartAttempts ?? 0).toBe(0);
    expect(tick.verify.probes.primary_connector_local).toMatchObject({ ok: true, status: 401 });
  });

  test('attributes a managed primary public MCP failure to Connector recovery even when gateway observation is stale', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-managed-public-stale-gateway', 'artifact-managed-public-stale-gateway');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await failingPublicGatewayServer(503);
    const connector = await runtimeServer({ challengeUnauthenticatedMcp: true });
    const publicGateway = await failingPublicGatewayServer(530);
    const tunnelPlistPath = join(home, 'primary-tunnel-stale-gateway.plist');
    writeFileSync(tunnelPlistPath, '<plist><dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>');
    writeMainToken(home);
    startObservedRuntime(
      home,
      runtime.endpoint,
      'release-managed-public-stale-gateway',
      'artifact-managed-public-stale-gateway',
      new Date(Date.now() - 120_000).toISOString(),
    );
    const config = createRecoveryConfig(home, {
      publicMcpUrl: publicGateway.endpoint,
      primaryConnectorService: {
        platform: 'launchd',
        label: 'com.moretea.forge.mcp-gateway',
        localMcpUrl: connector.endpoint,
        minimumFailures: 2,
        minimumFailureDurationMs: 5_000,
      },
      primaryPublicTunnelService: {
        platform: 'launchd',
        label: 'com.cloudflare.cloudflared.primary',
        plistPath: tunnelPlistPath,
      },
    });

    const verified = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(verified.runtime).toMatchObject({ ok: true, running: true, ready: true, stale: false });
    expect(verified.probes.active_gateway).toMatchObject({ ok: false, status: 503 });
    expect(verified.probes.external_mcp_http).toMatchObject({ ok: false, status: 530 });
    expect(verified.probes.primary_connector_local).toMatchObject({ ok: true, status: 401 });

    const tick = await watchdogTick(config, {
      failures: 0,
      rollbackUsed: false,
      lastFullVerifyAt: Date.now(),
    });
    expect(tick.decision.action).toBe('degraded');
    expect(tick.state.primaryConnectorFailures).toBe(1);
    expect(tick.state.failures).toBe(1);
    expect(tick.state.runtimeRestartAttempts ?? 0).toBe(0);
    expect(tick.primaryRuntimeRestart).toBeUndefined();
  });

  test('turns public Gateway session-capacity exhaustion into the existing bounded Connector recovery decision', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-capacity', 'artifact-capacity');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    const gateway = await saturatedPublicGatewayServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-capacity', 'artifact-capacity');
    const config = createRecoveryConfig(home, {
      publicMcpUrl: gateway.endpoint,
      primaryConnectorService: {
        platform: 'launchd',
        label: 'com.moretea.forge.mcp-gateway',
        minimumFailures: 2,
        minimumFailureDurationMs: 5_000,
        maximumRestartAttempts: 3,
      },
    });

    const verified = await verifyStableRuntime(config, undefined, { probeMcpProtocol: false });
    expect(verified.runtime.ok).toBe(true);
    expect(verified.probes.external_mcp_http).toMatchObject({ ok: true, status: 401 });
    expect(verified.probes.primary_connector_ready).toMatchObject({
      ok: false,
      status: 503,
      value: { admissibleSessionCount: 0, recoveryRecommended: true },
    });
    expect(gateway.requests.some((request) => request.method === 'GET' && request.url === '/transport-ready')).toBe(true);

    const firstTick = await watchdogTick(config, {
      failures: 0,
      rollbackUsed: false,
      lastFullVerifyAt: Date.now(),
    });
    expect(firstTick.decision.action).toBe('degraded');
    expect(firstTick.state).toMatchObject({ failures: 1, primaryConnectorFailures: 1 });
    expect(firstTick.state.runtimeRestartAttempts ?? 0).toBe(0);

    const capacityFailed = (verified.probes.primary_connector_ready.value as { recoveryRecommended?: boolean }).recoveryRecommended === true;
    expect(decideWatchdog({
      failures: 2,
      firstFailureAt: Date.now() - 6_000,
      evidenceClasses: ['public_mcp'],
      activeKnownGood: true,
      previousKnownGood: true,
      rollbackUsed: false,
      primaryConnectorConfigured: true,
      primaryConnectorFailed: capacityFailed,
      primaryConnectorFailures: 2,
      primaryConnectorFirstFailureAt: Date.now() - 6_000,
      primaryConnectorRestartAttempts: 0,
      primaryConnectorMaximumRestartAttempts: 3,
    })).toMatchObject({ action: 'restart_primary_connector' });
  });

  test('does not attest an active release whose immutable Check Runner canary fails', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-execution-invalid', 'artifact-execution-invalid');
    ensureActiveRuntimeRelease(home, activeManifest);
    writeFileSync(join(dirname(activeManifest), 'fail-check-runner'), 'fail\n');
    const runtime = await runtimeServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-execution-invalid', 'artifact-execution-invalid');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });

    const verified = await verifyStableRuntime(config);
    expect(verified.ok).toBe(false);
    expect(verified.probes.runtime_execution_surface).toMatchObject({ ok: false });
    expect(verified.probes.runtime_execution_surface.detail).toContain('RUNTIME_RELEASE_EXECUTION_CANARY_FAILED: check_runner');
    await expect(attestKnownGood(config)).rejects.toThrow('RECOVERY_KNOWN_GOOD_ATTESTATION_REQUIRES_FULL_VERIFY_AND_RELEASE_AUTHORITY');
    expect(existsSync(join(home, 'recovery', 'state', 'known-good.json'))).toBe(false);
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

  test('refuses rollback when the independently attested previous release later fails its execution canary', async () => {
    const home = controllerHome();
    const first = manifest(home, 'release-canary-a', 'artifact-canary-a');
    const second = manifest(home, 'release-canary-b', 'artifact-canary-b', 2);
    ensureActiveRuntimeRelease(home, first);
    const runtime = await runtimeServer();
    writeMainToken(home);
    const ownership = startObservedRuntime(home, runtime.endpoint, 'release-canary-a', 'artifact-canary-a');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    await attestKnownGood(config);
    removeOwnership(ownership);

    publishRuntimeRelease(home, second, 'publish-release-canary-b');
    writeFileSync(join(dirname(first), 'fail-check-runner'), 'fail\n');
    const rolled = await rollbackPrevious(config, 'execution canary regression');
    expect(rolled.ok).toBe(false);
    expect(rolled.detail).toContain('previous whole-Runtime release failed Process Runtime execution verification');
    expect(rolled.detail).toContain('RUNTIME_RELEASE_EXECUTION_CANARY_FAILED: check_runner');
    expect(readRuntimeReleaseAuthority(home)).toMatchObject({
      active: { releaseId: 'release-canary-b' },
      previous: { releaseId: 'release-canary-a' },
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
      let launchdLoaded = true;
      const commands: string[][] = [];
      const result = await restartPrimaryRuntime(config, {
        platform: 'darwin',
        currentUid: async () => 501,
        runCommand: async (_command, args) => {
          commands.push(args);
          if (args[0] === 'bootout') launchdLoaded = false;
          if (args[0] === 'bootstrap') launchdLoaded = true;
          if (args[0] === 'print') return launchdLoaded
            ? { ok: true, status: 0, stdout: 'loaded', stderr: '' }
            : { ok: false, status: 3, stdout: '', stderr: 'service not found' };
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        verifyLocal: async () => ++probes >= 3
          ? healthyVerify()
          : { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });
      expect(result).toMatchObject({ ok: true, attempted: true });
      const bootoutIndex = commands.findIndex((args) => args.includes('bootout'));
      const kickstartIndex = commands.findIndex((args) => args.includes('kickstart'));
      expect(bootoutIndex).toBeGreaterThanOrEqual(0);
      expect(kickstartIndex).toBeGreaterThan(bootoutIndex);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('restarts an installed Linux systemd-user primary Runtime and requires whole-Runtime verification', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      const unitPath = systemdUserUnitPath(paths.label);
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, `[Unit]\nDescription=Forge Runtime\n[Service]\nExecStart=\"${paths.activeEntrypointPath}\"\n`);
      const config = createRecoveryConfig(home, {
        primaryRuntimeService: { platform: 'systemd-user', postRestartVerifyTimeoutMs: 10_000 },
      });
      let probes = 0;
      const commands: string[][] = [];
      const result = await restartPrimaryRuntime(config, {
        platform: 'linux',
        currentUid: async () => 1000,
        runCommand: async (name, args) => {
          commands.push([name, ...args]);
          if (name === 'systemctl' && args.includes('show')) return { ok: true, status: 0, stdout: 'inactive\n', stderr: '' };
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        verifyLocal: async () => ++probes >= 3
          ? healthyVerify()
          : { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });
      expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: `${paths.label}.service` });
      const stopIndex = commands.findIndex((entry) => entry.join(' ') === `systemctl --user stop ${paths.label}.service`);
      const restartIndex = commands.findIndex((entry) => entry.join(' ') === `systemctl --user restart ${paths.label}.service`);
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(restartIndex).toBeGreaterThan(stopIndex);
      expect(commands.some((entry) => entry[0] === 'launchctl')).toBe(false);
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
      const reboundLaunchContract = readFileSync(paths.installedPlistPath, 'utf8');
      expect(reboundLaunchContract).toContain(join(home, 'runtime', 'releases', 'release-a', 'manifest.json'));
      expect(reboundLaunchContract).not.toContain(join(home, 'runtime', 'releases', 'release-b', 'manifest.json'));
      expect(commands.some((args) => args.includes('bootout'))).toBe(true);
      expect(commands.some((args) => args.includes('kickstart'))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('fails closed without starting a stale Runtime when rollback launch-contract rebuild fails', async () => {
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

      let launchdLoaded = true;
      const commands: string[][] = [];
      const result = await recoverPrimaryRuntime(config, 'test rollback contract failure', {
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
        ensureRuntimeLaunchContract: () => { throw new Error('simulated launch contract write failure'); },
        verifyLocal: async () => ({
          ...healthyVerify(),
          ok: false,
          runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] },
        }),
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });

      expect(result).toMatchObject({ ok: false, attempted: true, rollback: { ok: true } });
      expect(result.detail).toContain('launchd contract rebuild failed after rollback');
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
      expect(commands.some((args) => args.includes('bootstrap') || args.includes('kickstart'))).toBe(false);
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

  test('skips behavior-equivalent Linux activation only when the installed systemd unit matches the active release', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const active = verifiedManifest(home, 'release-a', 'same-runtime');
      const candidate = verifiedManifest(home, 'release-b', 'same-runtime');
      ensureActiveRuntimeRelease(home, active.path);
      runtimeServiceConfig(home);
      writePackageRuntimeSystemdUserService(home);
      const commands: string[][] = [];
      const result = await activateRuntimeRelease(createRecoveryConfig(home, { primaryRuntimeService: { platform: 'systemd-user' } }), candidate.path, {
        platform: 'linux',
        currentUid: async () => 1000,
        runCommand: async (name, args) => { commands.push([name, ...args]); return { ok: true, status: 0, stdout: '', stderr: '' }; },
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

  test('activates a behavior-changing Runtime release through the installed Linux systemd-user owner', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const active = verifiedManifest(home, 'release-a', 'runtime-a');
      const candidate = verifiedManifest(home, 'release-b', 'runtime-b');
      ensureActiveRuntimeRelease(home, active.path);
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      const unitName = `${paths.label}.service`;
      const unitPath = writePackageRuntimeSystemdUserService(home);
      const beforeUnit = readFileSync(unitPath, 'utf8');
      expect(beforeUnit).toContain(join(home, 'runtime', 'releases', 'release-a', 'forge-runtime'));
      expect(beforeUnit).not.toContain(join(home, 'runtime', 'releases', 'release-b', 'forge-runtime'));
      let serviceActive = true;
      let connectorBindings = 0;
      const commands: string[][] = [];
      const activationOrder: string[] = [];
      const config = createRecoveryConfig(home, { primaryRuntimeService: { platform: 'systemd-user', postRestartVerifyTimeoutMs: 10_000 } });
      const result = await activateRuntimeRelease(config, candidate.path, {
        platform: 'linux',
        currentUid: async () => 1000,
        runCommand: async (name, args) => {
          commands.push([name, ...args]);
          if (name === 'lsof') return { ok: false, status: 1, stdout: '', stderr: '' };
          if (name === 'systemctl' && args[0] === '--user' && args[1] === 'stop') serviceActive = false;
          if (name === 'systemctl' && args[0] === '--user' && args[1] === 'start') {
            activationOrder.push('runtime-start');
            serviceActive = true;
          }
          if (name === 'systemctl' && args[0] === '--user' && args[1] === 'show') {
            return { ok: true, status: 0, stdout: serviceActive ? 'active\n' : 'inactive\n', stderr: '' };
          }
          return { ok: true, status: 0, stdout: '', stderr: '' };
        },
        runtimeRunning: () => false,
        repairPrimaryConnectorBinding: async () => {
          connectorBindings += 1;
          activationOrder.push('connector-bind');
          if (!serviceActive) {
            return { ok: false, attempted: true, detail: 'candidate Connector cannot become ready before the Runtime starts' };
          }
          return { ok: true, attempted: true, detail: 'candidate Connector binding refreshed' };
        },
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
      expect(result).toMatchObject({ ok: true, attempted: true, serviceTarget: unitName });
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-b');
      expect(commands).toContainEqual(['systemctl', '--user', 'stop', unitName]);
      expect(commands).toContainEqual(['systemctl', '--user', 'daemon-reload']);
      expect(commands).toContainEqual(['systemctl', '--user', 'enable', unitName]);
      expect(commands).toContainEqual(['systemctl', '--user', 'start', unitName]);
      expect(commands.some((entry) => entry[0] === 'launchctl')).toBe(false);
      expect(connectorBindings).toBe(1);
      expect(activationOrder).toEqual(['runtime-start', 'connector-bind']);
      const reboundUnit = readFileSync(unitPath, 'utf8');
      expect(reboundUnit).toBe(renderPackageRuntimeSystemdUserService(home));
      expect(reboundUnit).toContain(join(home, 'runtime', 'releases', 'release-b', 'forge-runtime'));
      expect(reboundUnit).not.toContain(join(home, 'runtime', 'releases', 'release-a', 'forge-runtime'));
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

  test('pins, lists, and explicitly unpins one immutable Runtime release', async () => {
    const home = controllerHome();
    const candidate = verifiedManifest(home, 'release-pinned');
    const config = createRecoveryConfig(home);

    const pinned = await pinRuntimeRelease(config, candidate.path, 'pin-release-pinned');
    expect(pinned).toMatchObject({ ok: true, attempted: true });
    expect(await listReleases(config)).toMatchObject({
      pinned: { revision: 'release-pinned', artifactIdentity: candidate.artifactIdentity },
    });

    const unpinned = await unpinRuntimeRelease(config, 'unpin-release-pinned');
    expect(unpinned).toMatchObject({ ok: true, attempted: true });
    expect((await listReleases(config)).pinned).toBeUndefined();
  });

  test('refuses to pin a Runtime release whose source repository identity does not match Recovery configuration', async () => {
    const home = controllerHome();
    const candidate = verifiedManifest(home, 'release-wrong-source');
    const config = createRecoveryConfig(home, { primaryRuntimeSourceRepositoryId: 'repo_expected' });

    const result = await pinRuntimeRelease(config, candidate.path, 'pin-wrong-source');

    expect(result).toMatchObject({ ok: false, attempted: false, noOp: true });
    expect(String(result.detail)).toContain('RUNTIME_PIN_SOURCE_REPOSITORY_MISMATCH');
    expect((await listReleases(config)).pinned).toBeUndefined();
  });

  test('activates an explicitly pinned current.previous Runtime without using the ordinary reverse-activation path', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const releaseA = verifiedManifest(home, 'release-a');
      const releaseB = verifiedManifest(home, 'release-b');
      ensureActiveRuntimeRelease(home, releaseA.path);
      publishRuntimeRelease(home, releaseB.path, 'activate-b');
      const observed = readRuntimeReleaseAuthority(home)!;
      const config = createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 10_000 } });
      await pinRuntimeRelease(config, releaseA.path, 'pin-release-a');
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let localProbes = 0;
      let launchdLoaded = true;
      const result = await activatePinnedRuntimeRelease(config, {
        platform: 'darwin',
        currentUid: async () => 501,
        ensureRuntimeLaunchContract: () => undefined,
        runCommand: async (_name, args) => {
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
                active: { path: releaseA.path, revision: 'release-a', artifactIdentity: releaseA.artifactIdentity, manifestSha256: 'release-a-sha', workerProtocolVersion: 1 },
                coherent: true,
              },
            }
          : { ...healthyVerify(), releases: { active: { path: releaseB.path, revision: 'release-b', artifactIdentity: releaseB.artifactIdentity, manifestSha256: 'release-b-sha', workerProtocolVersion: 1 }, coherent: true } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      }, {
        requestId: 'recovery-gateway:activate-pinned-a',
        expectedAuthorityRevision: observed.revision,
        expectedActiveReleaseId: observed.active.releaseId,
      });

      expect(result).toMatchObject({ ok: true, attempted: true });
      expect(result.detail).not.toContain('RUNTIME_RELEASE_REVERSE_ACTIVATION_REQUIRES_ROLLBACK');
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-a');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('restores the pre-activation Runtime artifact without rolling back current SQLite when pinned activation fails', async () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const releaseA = verifiedManifest(home, 'release-a');
      const releaseB = verifiedManifest(home, 'release-b');
      ensureActiveRuntimeRelease(home, releaseA.path);
      publishRuntimeRelease(home, releaseB.path, 'activate-b');
      writeControlPlaneRecord(home, {
        namespace: 'runtime_pin_probe', scope: 'controller', key: 'latest-state', schemaVersion: 1,
        value: { marker: 'must-survive-runtime-only-fallback' }, expectedRevision: null, action: 'seed_runtime_pin_probe',
      });
      const observed = readRuntimeReleaseAuthority(home)!;
      const config = createRecoveryConfig(home, { primaryRuntimeService: { platform: 'launchd', postRestartVerifyTimeoutMs: 5_000 } });
      await pinRuntimeRelease(config, releaseA.path, 'pin-release-a-for-failure');
      runtimeServiceConfig(home);
      const paths = forgeRuntimeServicePaths(home);
      mkdirSync(dirname(paths.installedPlistPath), { recursive: true });
      writeFileSync(paths.installedPlistPath, '<plist/>');

      let launchdLoaded = true;
      let kickstarts = 0;
      const result = await activatePinnedRuntimeRelease(config, {
        platform: 'darwin',
        currentUid: async () => 501,
        ensureRuntimeLaunchContract: () => undefined,
        runCommand: async (_name, args) => {
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
          if (kickstarts === 0 || kickstarts >= 2) {
            return {
              ...healthyVerify(),
              releases: {
                active: { path: authority.active.manifestPath, revision: authority.active.releaseId, artifactIdentity: authority.active.artifactIdentity, manifestSha256: authority.active.manifestSha256, workerProtocolVersion: 1 },
                coherent: true,
              },
            };
          }
          return { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } };
        },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      }, {
        requestId: 'recovery-gateway:activate-pinned-a-fails',
        expectedAuthorityRevision: observed.revision,
        expectedActiveReleaseId: observed.active.releaseId,
      });

      expect(result.ok).toBe(false);
      expect(result.rollback).toMatchObject({ ok: true });
      expect(readRuntimeReleaseAuthority(home)?.active.releaseId).toBe('release-b');
      expect(readControlPlaneRecord<{ marker: string }>(home, 'runtime_pin_probe', 'controller', 'latest-state')?.value.marker).toBe('must-survive-runtime-only-fallback');
      expect(kickstarts).toBeGreaterThanOrEqual(2);
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
      const executionSurface = writeReleaseExecutionSurface(candidateRoot);
      const candidateManifestPath = join(candidateRoot, 'manifest.json');
      writeFileSync(candidateManifestPath, `${JSON.stringify({
        schemaVersion: 1,
        releaseId: candidateReleaseId,
        artifactIdentity,
        entrypoint: 'forge-runtime',
        processRunnerEntrypoint: 'process-runner.js',
        processRunnerArtifactIdentity: executionSurface.processRunnerArtifactIdentity,
        checkRunnerEntrypoint: 'forge-check-runner',
        checkRunnerArtifactIdentity: executionSurface.checkRunnerArtifactIdentity,
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
    const executionSurface = writeReleaseExecutionSurface(candidateRoot);
    const candidateManifestPath = join(candidateRoot, 'manifest.json');
    writeFileSync(candidateManifestPath, `${JSON.stringify({
      schemaVersion: 1,
      releaseId: candidateReleaseId,
      artifactIdentity: 'sha256:deadbeef',
      entrypoint: 'forge-runtime',
      processRunnerEntrypoint: 'process-runner.js',
      processRunnerArtifactIdentity: executionSurface.processRunnerArtifactIdentity,
      checkRunnerEntrypoint: 'forge-check-runner',
      checkRunnerArtifactIdentity: executionSurface.checkRunnerArtifactIdentity,
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
      const executionSurface = writeReleaseExecutionSurface(candidateRoot);
      const candidateManifestPath = join(candidateRoot, 'manifest.json');
      writeFileSync(candidateManifestPath, `${JSON.stringify({
        schemaVersion: 1,
        releaseId: candidateReleaseId,
        artifactIdentity,
        entrypoint: 'forge-runtime',
        processRunnerEntrypoint: 'process-runner.js',
        processRunnerArtifactIdentity: executionSurface.processRunnerArtifactIdentity,
        checkRunnerEntrypoint: 'forge-check-runner',
        checkRunnerArtifactIdentity: executionSurface.checkRunnerArtifactIdentity,
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
      const connectorBindingStates: string[] = [];
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
        repairPrimaryConnectorBinding: async () => {
          const activeRelease = readRuntimeReleaseAuthority(home)?.active.releaseId ?? 'none';
          connectorBindingStates.push(`${activeRelease}:${launchdLoaded ? 'runtime-started' : 'runtime-stopped'}`);
          return launchdLoaded
            ? { ok: true, attempted: true, detail: `Connector rebound for ${activeRelease}` }
            : { ok: false, attempted: true, detail: `Connector bind attempted while ${activeRelease} Runtime was stopped` };
        },
        verifyLocal: async () => ++probes > 12
          ? healthyVerify()
          : { ...healthyVerify(), ok: false, runtime: { ok: false, running: false, ready: false, stale: false, reasonCodes: ['RUNTIME_UNAVAILABLE'] } },
        now: (() => { let value = 0; return () => value += 1_000; })(),
        sleep: async () => undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.rollback).toMatchObject({ ok: true });
      const restoredAuthority = readRuntimeReleaseAuthority(home);
      expect(restoredAuthority).toMatchObject({
        active: { releaseId: 'release-a', artifactIdentity: 'artifact-a' },
      });
      expect(restoredAuthority?.previous).toBeUndefined();
      expect(commands.filter((args) => args.includes('kickstart')).length).toBeGreaterThanOrEqual(2);
      expect(connectorBindingStates).toEqual(['release-a:runtime-started']);
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
      const restoredAuthority = readRuntimeReleaseAuthority(home);
      expect(restoredAuthority).toMatchObject({
        active: { releaseId: 'release-a', artifactIdentity: 'artifact-a' },
      });
      expect(restoredAuthority?.previous).toBeUndefined();
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
      platform: 'darwin',
      pathExists: () => false,
      launchdPid: () => undefined,
      tunnelLaunchdPid: () => undefined,
      processAlive: () => false,
    });
    expect(descriptor).toMatchObject({
      name: 'Forge Recovery',
      identity: {
        platform: 'darwin',
        controllerHome: resolve(home),
        targetRuntime: { servicePlatform: 'launchd', serviceLabel: forgeRuntimeServicePaths(home).label },
      },
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
  test('Recovery Connector verifier carries one MCP session through SSE responses and closes it', async () => {
    const home = controllerHome();
    ensureMcpControllerHomeOAuthPassphrase(home);
    initializeStandaloneRecovery(home, 8787, {
      recoveryPublicUrl: 'https://recovery.example.test/recovery/mcp',
    });
    const sessionId = 'recovery-verifier-session';
    const sessionMethods: string[] = [];
    let sessionDeleted = false;
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
    const sse = (value: unknown, headers: Record<string, string> = {}) => new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', ...headers },
    });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === 'https://recovery.example.test/recovery/health') {
        return json({ status: 'ok', version: FORGE_VERSION });
      }
      if (url === 'https://recovery.example.test/.well-known/oauth-authorization-server') {
        return json({
          issuer: 'https://recovery.example.test',
          authorization_endpoint: 'https://recovery.example.test/recovery/oauth/authorize',
          token_endpoint: 'https://recovery.example.test/recovery/oauth/token',
          registration_endpoint: 'https://recovery.example.test/recovery/oauth/register',
        });
      }
      if (url === 'https://recovery.example.test/.well-known/oauth-protected-resource/recovery/mcp') {
        return json({ resource: 'https://recovery.example.test/recovery/mcp', authorization_servers: ['https://recovery.example.test'] });
      }
      if (url === 'https://recovery.example.test/recovery/oauth/register') {
        return json({ client_id: RECOVERY_VERIFIER_OAUTH_CLIENT_ID, forge_client_owner: 'recovery_verifier', forge_client_reused: true }, 201);
      }
      if (url === 'https://recovery.example.test/recovery/oauth/authorize') {
        const form = new URLSearchParams(String(init?.body ?? ''));
        const state = form.get('state') ?? '';
        return new Response(null, {
          status: 302,
          headers: { location: `${RECOVERY_VERIFIER_OAUTH_REDIRECT_URI}?code=recovery-test-code&state=${encodeURIComponent(state)}` },
        });
      }
      if (url === 'https://recovery.example.test/recovery/oauth/token') {
        return json({ access_token: 'recovery-test-token', token_type: 'Bearer' });
      }
      if (url !== 'https://recovery.example.test/recovery/mcp') throw new Error(`unexpected verifier URL: ${url}`);
      if (!headers.has('authorization')) {
        return json({ error: 'invalid_token' }, 401, {
          'www-authenticate': 'Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://recovery.example.test/.well-known/oauth-protected-resource/recovery/mcp"',
        });
      }
      if (init?.method === 'DELETE') {
        expect(headers.get('mcp-session-id')).toBe(sessionId);
        sessionDeleted = true;
        return new Response(null, { status: 200 });
      }
      const rpc = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      if (rpc.method === 'initialize') {
        expect(headers.get('mcp-session-id')).toBeNull();
        return sse({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'forge-standalone-recovery', version: FORGE_VERSION },
          },
        }, { 'mcp-session-id': sessionId });
      }
      expect(headers.get('mcp-session-id')).toBe(sessionId);
      sessionMethods.push(rpc.method ?? '');
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (rpc.method === 'tools/list') return sse({ jsonrpc: '2.0', id: rpc.id, result: { tools: RECOVERY_TOOLS } });
      if (rpc.method === 'tools/call') return sse({ jsonrpc: '2.0', id: rpc.id, result: { content: [] } });
      return json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'unknown method' } }, 400);
    }) as typeof fetch;

    const result = await verifyRecoveryConnector(home, {
      fetcher,
      random: (size) => Buffer.alloc(size, 7),
    });
    expect(result.probes.oauthPkce.ok).toBe(true);
    expect(result.probes.mcp).toMatchObject({
      ok: true,
      initializeStatus: 200,
      initializedNotificationStatus: 202,
      protocolVersion: '2025-06-18',
      serverName: 'forge-standalone-recovery',
      serverVersion: FORGE_VERSION,
      tools: RECOVERY_TOOLS.map((tool) => tool.name),
      runtimeStatusCall: true,
      listReleasesCall: true,
    });
    expect(sessionMethods).toEqual(['notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
    expect(sessionDeleted).toBe(true);
    expect(result.failures.some((failure) => failure.startsWith('oauthPkce/mcp:'))).toBe(false);
  });

  test('reports Linux Recovery Gateway and Watchdog installation through systemd-user ownership', () => {
    const home = controllerHome();
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      initializeStandaloneRecovery(home, 8787);
      const gatewayUnit = systemdUserUnitPath('com.moretea.forge-recovery-gateway');
      const watchdogUnit = systemdUserUnitPath('com.moretea.forge-recovery-watchdog');
      const descriptor = recoveryConnectorDescriptor(home, {
        platform: 'linux',
        pathExists: (path) => path === gatewayUnit || path === watchdogUnit,
        systemdPid: () => undefined,
        processAlive: () => false,
      });
      expect(descriptor.services.gateway).toMatchObject({ platform: 'systemd-user', serviceInstalled: true, plistInstalled: false, running: false });
      expect(descriptor.services.watchdog).toMatchObject({ platform: 'systemd-user', serviceInstalled: true, plistInstalled: false, running: false });
      expect(descriptor.warnings).not.toContain('Forge Recovery systemd-user services are not fully installed. Run forge recovery install.');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
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
    expect(descriptor.warnings).toContain('Recovery is loopback-only. Configure a dedicated OpenAI Secure MCP Tunnel or an HTTPS tunnel service before adding it to ChatGPT.');
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

describe('Recovery verifier OAuth registration lifecycle', () => {
  test('keeps 1000 verifier registrations in one reserved client slot while external clients stay distinct', () => {
    const verifierBody = {
      client_id: RECOVERY_VERIFIER_OAUTH_CLIENT_ID,
      client_name: RECOVERY_VERIFIER_OAUTH_CLIENT_NAME,
      redirect_uris: [RECOVERY_VERIFIER_OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };
    const clients = new Map<string, string>();
    for (let index = 0; index < 1_000; index += 1) {
      const identity = recoveryOAuthClientRegistrationIdentity(verifierBody, `unused-${index}`);
      clients.set(identity.clientId, identity.owner);
    }
    expect(clients).toEqual(new Map([[RECOVERY_VERIFIER_OAUTH_CLIENT_ID, 'recovery_verifier']]));

    const externalA = recoveryOAuthClientRegistrationIdentity({ client_name: 'external-a' }, 'external-a-id');
    const externalB = recoveryOAuthClientRegistrationIdentity({ client_name: 'external-b' }, 'external-b-id');
    expect(externalA).toEqual({ clientId: 'external-a-id', owner: 'external' });
    expect(externalB).toEqual({ clientId: 'external-b-id', owner: 'external' });
  });

  test('rejects attempts to claim the reserved verifier id with different metadata', () => {
    expect(() => recoveryOAuthClientRegistrationIdentity({
      client_id: RECOVERY_VERIFIER_OAUTH_CLIENT_ID,
      client_name: 'not-the-verifier',
      redirect_uris: [RECOVERY_VERIFIER_OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })).toThrow('RECOVERY_OAUTH_VERIFIER_CLIENT_METADATA_INVALID');
  });
});


describe('Recovery explicit performance acceptance', () => {
  const identity = { releaseId: 'candidate', authorityRevision: 3, runtimeInstanceId: 'runtime', pid: 123, startedAt: 'start' };

  test('CPU-time samples enforce thresholds, identity, expiry and measurement availability', async () => {
    const deps = idleCpuDependencies();
    const evidence = await measureRuntimePerformance(() => identity, deps);
    expect(evidence).toMatchObject({ policy: 'idle-cpu-v1', sampleCount: 30, warmupMs: 60_000, durationMs: 300_000, meanCpuPercent: 0 });
    expect(() => assertRuntimePerformanceEvidence(evidence, identity, Date.parse(evidence.measuredUntil) + 60_001)).toThrow('RECOVERY_PERFORMANCE_UNKNOWN');
    expect(() => assertRuntimePerformanceEvidence(evidence, { ...identity, authorityRevision: 4 })).toThrow('RECOVERY_PERFORMANCE_UNKNOWN');
    expect(() => assertRuntimePerformanceEvidence({ ...evidence, p95CpuPercent: 11 }, identity)).toThrow('RECOVERY_PERFORMANCE_REJECTED');
    const busy = idleCpuDependencies();
    await expect(measureRuntimePerformance(() => identity, {
      ...busy, readCpu: () => ({ cpuMs: busy.monotonicNow(), processStartTime: 'same' }),
    })).rejects.toThrow('RECOVERY_PERFORMANCE_REJECTED');
    let readings = 0;
    await expect(measureRuntimePerformance(() => identity, {
      ...idleCpuDependencies(), readCpu: () => ({ cpuMs: 0, processStartTime: String(readings++) }),
    })).rejects.toThrow('RECOVERY_PERFORMANCE_UNKNOWN');
    const changed = idleCpuDependencies();
    await expect(measureRuntimePerformance(() => ({ ...identity, authorityRevision: changed.monotonicNow() > 60_000 ? 4 : 3 }), changed))
      .rejects.toThrow('RECOVERY_PERFORMANCE_UNKNOWN');
    await expect(measureRuntimePerformance(() => identity, {
      ...idleCpuDependencies(), readCpu: () => { throw new Error('sample unavailable'); },
    })).rejects.toThrow('sample unavailable');
    let warmupElapsed = 0;
    await expect(measureRuntimePerformance(() => identity, {
      readCpu: () => ({ cpuMs: 0, processStartTime: 'same' }),
      monotonicNow: () => warmupElapsed,
      wallNow: () => Date.now() + warmupElapsed,
      sleep: async () => { warmupElapsed += 20_000; },
    })).rejects.toThrow('RECOVERY_PERFORMANCE_UNKNOWN: interrupted CPU warmup window');
    expect(readRuntimeCpu(process.pid).cpuMs).toBeGreaterThanOrEqual(0);
  });

  test('performance observation does not hold the Recovery mutation lock and final attestation still requires it', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-cpu-lock', 'artifact-cpu-lock');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-cpu-lock', 'artifact-cpu-lock');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    const deps = idleCpuDependencies();
    let sleepCount = 0;
    let heldFinalLock: ReturnType<typeof acquireRecoveryOperationLock> | undefined;
    const pending = attestKnownGoodWithCpu(config, {
      ...deps,
      sleep: async (ms: number) => {
        sleepCount += 1;
        const probe = acquireRecoveryOperationLock({
          controllerHome: home,
          action: 'test_probe_during_performance_observation',
          requestId: `test-probe-${sleepCount}`,
        });
        expect(probe.acquired).toBe(true);
        if (sleepCount === 36) heldFinalLock = probe;
        else if (probe.acquired) probe.handle.close();
        await deps.sleep(ms);
      },
    });
    await expect(pending).rejects.toThrow('Recovery mutation already in progress');
    expect(sleepCount).toBe(36);
    expect(heldFinalLock?.acquired).toBe(true);
    if (heldFinalLock?.acquired) heldFinalLock.handle.close();
    expect(existsSync(join(home, 'recovery', 'state', 'known-good.json'))).toBe(false);

    const attested = await attestKnownGood(config);
    expect(attested.performance?.sampleCount).toBe(30);
  });

  test('functional health cannot attest a busy Runtime; explicit rollback of an attested live Runtime still requires stop', async () => {
    const home = controllerHome();
    const activeManifest = manifest(home, 'release-cpu', 'artifact-cpu');
    ensureActiveRuntimeRelease(home, activeManifest);
    const runtime = await runtimeServer();
    writeMainToken(home);
    startObservedRuntime(home, runtime.endpoint, 'release-cpu', 'artifact-cpu');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    const busy = idleCpuDependencies();
    await expect(attestKnownGoodWithCpu(config, {
      ...busy, readCpu: () => ({ cpuMs: busy.monotonicNow(), processStartTime: 'same' }),
    })).rejects.toThrow('RECOVERY_PERFORMANCE_REJECTED');
    expect(existsSync(join(home, 'recovery', 'state', 'known-good.json'))).toBe(false);
    const attested = await attestKnownGood(config);
    expect(attested.performance?.sampleCount).toBe(30);
    const result = await rollbackPrevious(config, 'explicit performance regression');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('stop the complete Canonical Runtime');
  });

  test('attestation rejects a release switch after functional verification and before CPU sampling', async () => {
    const home = controllerHome();
    const first = manifest(home, 'release-before-cpu', 'artifact-before-cpu');
    const second = manifest(home, 'release-after-verify', 'artifact-after-verify', 2);
    ensureActiveRuntimeRelease(home, first);
    const runtime = await runtimeServer();
    writeMainToken(home);
    const ownership = startObservedRuntime(home, runtime.endpoint, 'release-before-cpu', 'artifact-before-cpu');
    const config = createRecoveryConfig(home, { publicMcpUrl: runtime.endpoint });
    const dependencies = idleCpuDependencies();
    let switched = false;
    await expect(attestKnownGoodWithCpu(config, {
      ...dependencies,
      readCpu: () => {
        if (!switched) {
          switched = true;
          removeOwnership(ownership);
          publishRuntimeRelease(home, second, 'switch-after-functional-verify');
        }
        return { cpuMs: 0, processStartTime: 'same' };
      },
    })).rejects.toThrow('RECOVERY_PERFORMANCE_UNKNOWN');
    expect(existsSync(join(home, 'recovery', 'state', 'known-good.json'))).toBe(false);
  });
});
