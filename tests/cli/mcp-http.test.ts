import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { processToolDefinitions } from '../../adapters/mcp/runtime-gateway/process-tools';
import { mcpToolDefinitionToSdk } from '../../packages/protocols/mcp/tool-contract';
import { routeDurableMcpCall } from '../../adapters/mcp/runtime-gateway/router';
import { callProcessTool } from '../../src/runtime/execution/process-runtime/tool-dispatch';
import { createCanonicalRuntimeProxy, createMcpToolContext, deriveCanonicalForwardingTiming } from '../../adapters/mcp/server';
import { Server } from '@modelcontextprotocol/server';
import { Client, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startRuntimeMcpTransport } from '../../src/runtime/root/mcp-transport';
import { writeRuntimeStatusSnapshot } from '../../src/runtime/root/status';
import express from 'express';
import { drainMcpPosts, terminateReclaimedMcpPost } from '../../adapters/mcp/transports/http-post-lifecycle';
import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'net';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { mcpControllerHomeOAuthPath, mcpControllerHomeTokenPath } from '../../adapters/mcp/auth';
import { runMcpSetupChatgpt } from '../../adapters/mcp/setup';
import { mergeNoProxy, withDirectNetworkProxyBypass } from '../../adapters/mcp/proxy-env';
import { McpSessionRegistry } from '../../adapters/mcp/transports/session-registry';
import { admitMcpPost, createMcpHttpSessionRegistry, mcpRequestError } from '../../adapters/mcp/transports/http';
import { recentMcpTransportEvidence } from '../../adapters/mcp/transports/http-observation';
import { flushMcpDiagnostics, readRecentMcpTransportEvents, recordMcpTransportEvent } from '../../src/runtime/diagnostics/mcp-timing';
import { readExecutionSession, startExecutionSession } from '../../src/runtime/control-plane/execution/session-store';
import {
  armPackageConnectorCutoverDrain,
  clearPackageConnectorCutoverDrain,
  packageConnectorServicePaths,
  type PackageConnectorServiceAuthority,
} from '../../src/runtime/root/package-connector-service';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close(() => reject(new Error('unable to allocate test port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (_error) {
      // Server is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error('MCP HTTP server did not become healthy');
}

function initializeBody(clientName = 'forge-test'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '0' },
    },
  });
}

async function withTestControllerHome<T>(repoRoot: string, fn: (controllerHome: string) => Promise<T>): Promise<T> {
  const previous = process.env.FORGE_CONTROLLER_HOME;
  const controllerHome = join(repoRoot, '.controller-home');
  process.env.FORGE_CONTROLLER_HOME = controllerHome;
  try {
    return await fn(controllerHome);
  } finally {
    if (previous === undefined) delete process.env.FORGE_CONTROLLER_HOME;
    else process.env.FORGE_CONTROLLER_HOME = previous;
  }
}

async function stopMcpServerProcess(proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null): Promise<void> {
  if (!proc) return;
  proc.kill();
  await proc.exited.catch(() => undefined);
}

function isolatedMcpProcessEnv(
  controllerHome: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'FORGE_MCP_PUBLIC_ORIGIN',
    'FORGE_MCP_INSTANCE_ID',
    'FORGE_SUPERVISOR_PUBLIC_HEALTH_ENDPOINT',
    'FORGE_SUPERVISOR_CHILD',
    'FORGE_CONTROLLER_LIFECYCLE_OWNER',
    'FORGE_CONTROLLER_INSTANCE_ID',
    'FORGE_DAEMON_INSTANCE_ID',
    'FORGE_RUNTIME_SLOT',
    'FORGE_WRITER_SLOT',
    'FORGE_WRITER_GENERATION',
    'FORGE_RUNTIME_INSTANCE_ID',
    'FORGE_RUNTIME_OWNER_PID',
    'FORGE_RELEASE_AUTHORITY_REVISION',
    'FORGE_RELEASE_FENCING_TOKEN',
    'FORGE_RELEASE_ID',
    'FORGE_ARTIFACT_IDENTITY',
    'FORGE_WORKER_PROTOCOL_VERSION',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    FORGE_CONTROLLER_HOME: controllerHome,
    ...overrides,
  };
}

describe('mcp http transport', () => {
  test('projects Runtime cutover as outcome-unknown reconciliation rather than retry', () => {
    expect(mcpRequestError(new Error('MCP_RUNTIME_CUTOVER_OUTCOME_UNKNOWN: cutover'))).toEqual({
      status: 503,
      body: {
        error: 'runtime_cutover_outcome_unknown',
        code: 'MCP_RUNTIME_CUTOVER_OUTCOME_UNKNOWN',
        message: 'The Canonical Runtime changed after this request was admitted. Reconcile the original request/effect identity before retrying.',
        recoverable: true,
        retryable: false,
        sessionPreserved: true,
        action: 'reconcile',
      },
    });
  });

  test('bounds MCP POST ingress with one shared capacity authority', () => {
    const stats = { initializing: 0, activePostStartedAt: new Map<import('express').Response, number>(), rejectedOverload: 0 };
    for (let i = 0; i < 31; i++) stats.activePostStartedAt.set({} as import('express').Response, Date.now() - 1_000);
    const response = () => {
      const emitter = new EventEmitter();
      let statusCode = 200;
      let body: unknown;
      const res = Object.assign(emitter, {
        setHeader: () => undefined,
        status(code: number) {
          statusCode = code;
          return res;
        },
        json(value: unknown) {
          body = value;
          emitter.emit('finish');
          return res;
        },
      });
      return {
        res: res as unknown as import('express').Response,
        statusCode: () => statusCode,
        body: () => body,
        finish: () => emitter.emit('finish'),
      };
    };

    const admitted = response();
    expect(admitMcpPost(stats, admitted.res)).toBe(true);
    expect(stats.activePostStartedAt.size).toBe(32);

    const rejected = response();
    expect(admitMcpPost(stats, rejected.res)).toBe(false);
    expect(rejected.statusCode()).toBe(503);
    expect(rejected.body()).toMatchObject({ code: 'MCP_SERVER_BUSY', action: 'retry' });
    expect(stats.rejectedOverload).toBe(1);
    expect(stats.activePostStartedAt.size).toBe(32);

    admitted.finish();
    expect(stats.activePostStartedAt.size).toBe(31);
    admitted.finish();
    expect(stats.activePostStartedAt.size).toBe(31);

    const closed = response();
    expect(admitMcpPost(stats, closed.res)).toBe(true);
    expect(stats.activePostStartedAt.size).toBe(32);
    closed.res.emit('close');
    expect(stats.activePostStartedAt.size).toBe(31);
    closed.res.emit('finish');
    expect(stats.activePostStartedAt.size).toBe(31);

    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-mcp-cutover-drain-'));
    try {
      const endpoint = 'http://127.0.0.1:8767/mcp';
      const connectorAuthority: PackageConnectorServiceAuthority = {
        schemaVersion: 1,
        endpoint,
        releaseId: 'stable-release-a',
        releaseRoot: join(controllerHome, 'runtime', 'releases', 'stable-release-a'),
        packageRoot: join(controllerHome, 'runtime', 'releases', 'stable-release-a', 'package'),
        mode: 'launchd',
        persistent: true,
        installedAt: '2026-10-09T20:00:00.000Z',
      };
      const connectorPaths = packageConnectorServicePaths(controllerHome);
      mkdirSync(connectorPaths.serviceRoot, { recursive: true });
      writeFileSync(connectorPaths.authorityPath, `${JSON.stringify(connectorAuthority, null, 2)}\n`);
      armPackageConnectorCutoverDrain({
        controllerHome,
        sessionId: 'release-session-cutover-drain-12345678',
        stableReleaseId: connectorAuthority.releaseId,
        connectorAuthority,
      });

      const draining = response();
      expect(admitMcpPost(stats, draining.res, { controllerHome, connectorEndpoint: endpoint })).toBe(false);
      expect(draining.statusCode()).toBe(503);
      expect(draining.body()).toMatchObject({ code: 'MCP_RELEASE_CUTOVER_DRAINING', action: 'retry' });
      expect(stats.activePostStartedAt.size).toBe(31);

      // The fence belongs to the exact old Connector service generation. A
      // Candidate or rollback rebind changes installedAt before strict MCP
      // verification, so the replacement process is not trapped behind the
      // predecessor's drain marker even when it serves the same endpoint.
      writeFileSync(connectorPaths.authorityPath, `${JSON.stringify({
        ...connectorAuthority,
        installedAt: '2026-10-09T20:01:00.000Z',
      }, null, 2)}\n`);
      const rebound = response();
      expect(admitMcpPost(stats, rebound.res, { controllerHome, connectorEndpoint: endpoint })).toBe(true);
      expect(stats.activePostStartedAt.size).toBe(32);
      rebound.finish();
      expect(stats.activePostStartedAt.size).toBe(31);
    } finally {
      clearPackageConnectorCutoverDrain(controllerHome);
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('reclaims stalled POST admission slots that never receive a terminal event', () => {
    // Bun 1.3 never emits close/aborted and never updates destroyed/closed when
    // a client disconnects before the response settles. Without the bounded
    // reclaim these entries hold all 32 slots forever and every POST returns
    // MCP_SERVER_BUSY until the gateway restarts.
    const stats = {
      initializing: 0,
      activePostStartedAt: new Map<import('express').Response, number>(),
      rejectedOverload: 0,
      reclaimedStalePosts: 0,
    };
    const mockResponse = (startedAt: number, streaming = false) => {
      let statusCode = 0;
      let body: unknown;
      const emitter = new EventEmitter();
      const res = Object.assign(emitter, {
        headersSent: streaming,
        setHeader: () => undefined,
        status(code: number) {
          statusCode = code;
          return res;
        },
        json(value: unknown) {
          body = value;
          res.headersSent = true;
          emitter.emit('finish');
          return res;
        },
        destroy() {
          emitter.emit('close');
        },
      });
      stats.activePostStartedAt.set(res as unknown as import('express').Response, startedAt);
      return {
        res: res as unknown as import('express').Response,
        statusCode: () => statusCode,
        body: () => body,
      };
    };
    const admitFresh = () => {
      const emitter = new EventEmitter();
      const res = Object.assign(emitter, {
        headersSent: false,
        setHeader: () => undefined,
        status() { return res; },
        json() { return res; },
        destroy() { emitter.emit('close'); },
      });
      return { res: res as unknown as import('express').Response, admitted: admitMcpPost(stats, res as unknown as import('express').Response) };
    };

    // A fresh in-flight POST is retained.
    for (let i = 0; i < 31; i++) mockResponse(Date.now());
    expect(admitFresh().admitted).toBe(true);
    expect(stats.reclaimedStalePosts ?? 0).toBe(0);
    expect(stats.activePostStartedAt.size).toBe(32);

    stats.activePostStartedAt.clear();
    const stalled = [];
    for (let i = 0; i < 32; i++) stalled.push(mockResponse(Date.now() - 11 * 60_000));
    const afterStall = admitFresh();
    expect(afterStall.admitted).toBe(true);
    expect(stats.reclaimedStalePosts).toBe(32);
    expect(stats.activePostStartedAt.size).toBe(1);
    for (const entry of stalled) {
      expect(entry.statusCode()).toBe(504);
      expect(entry.body()).toMatchObject({ code: 'MCP_ACTIVE_POST_STALLED', retryable: false, action: 'reconcile', executionOutcome: 'unknown' });
    }

    // A streaming POST (for example subscriptions/listen) is retained within
    // its existing stream lease even when it has not started responding.
    stats.activePostStartedAt.clear();
    stats.reclaimedStalePosts = 0;
    for (let i = 0; i < 31; i++) mockResponse(Date.now());
    mockResponse(Date.now() - 11 * 60_000, true);
    expect(admitFresh().admitted).toBe(false);
    expect(stats.reclaimedStalePosts).toBe(0);

    stats.activePostStartedAt.clear();
    for (let i = 0; i < 31; i++) mockResponse(Date.now());
    const expiredStream = mockResponse(Date.now() - 31 * 60_000, true);
    expect(admitFresh().admitted).toBe(true);
    expect(stats.reclaimedStalePosts).toBe(1);
    expect(expiredStream.statusCode()).toBe(0);
    expect(stats.activePostStartedAt.size).toBe(32);
  });

  test('transport session retirement does not invalidate durable execution session authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-mcp-transport-durable-session-'));
    try {
      const controllerHome = join(root, 'controller');
      const execution = startExecutionSession(controllerHome, {
        sessionId: 'durable-execution-session',
        principalId: 'transport-test-principal',
        controllerInstanceId: 'runtime-before-transport-close',
      });
      let transportClosed = 0;
      const registry = createMcpHttpSessionRegistry<{ close(): void }, { sessionId: string; controllerHome: string }>();
      registry.register({
        sessionId: 'mcp-transport-session',
        transport: { close: () => { transportClosed += 1; } },
        toolContext: { sessionId: execution.sessionId, controllerHome },
        route: '/mcp',
        principalId: 'transport-test-principal',
        connectionId: 'transport-connection',
        clientIdentity: 'transport-client',
      });

      await registry.close('mcp-transport-session', 'transport_close');

      expect(transportClosed).toBe(1);
      expect(registry.get('mcp-transport-session')).toBeUndefined();
      expect(readExecutionSession(controllerHome, {
        sessionId: execution.sessionId,
        principalId: execution.principalId,
        controllerInstanceId: 'runtime-after-transport-close',
      })).toMatchObject({
        sessionId: execution.sessionId,
        principalId: execution.principalId,
        controllerInstanceId: 'runtime-after-transport-close',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  test('health keeps current transport health separate from recent interruption and recovery evidence', () => {
    const startedAt = '2026-09-22T09:50:00.000Z';
    const now = Date.parse('2026-09-22T10:10:00.000Z');
    const interrupted = recentMcpTransportEvidence([{
      schemaVersion: 1,
      at: '2026-09-22T10:00:00.000Z',
      kind: 'interruption',
      sessionId: 'session-a',
      connectionId: 'connection-a',
      route: '/mcp',
      principalId: 'controller-http-client',
      reason: 'transport_close',
    }], startedAt, now);
    expect(interrupted).toMatchObject({
      current: 'healthy',
      recentStatus: 'recovering',
      gatewayStartedAt: startedAt,
      lastInterruption: { sessionId: 'session-a' },
      lastSessionClose: { sessionId: 'session-a', reason: 'transport_close' },
    });

    const recovered = recentMcpTransportEvidence([{
      schemaVersion: 1,
      at: '2026-09-22T10:00:05.000Z',
      kind: 'session_initialized',
      sessionId: 'session-b',
      connectionId: 'connection-a',
      route: '/mcp',
      principalId: 'controller-http-client',
    }, {
      schemaVersion: 1,
      at: '2026-09-22T10:00:00.000Z',
      kind: 'interruption',
      sessionId: 'session-a',
      connectionId: 'connection-a',
      route: '/mcp',
      principalId: 'controller-http-client',
      reason: 'transport_close',
    }], startedAt, now);
    expect(recovered).toMatchObject({
      current: 'healthy',
      recentStatus: 'recovered',
      lastRecoveryAt: '2026-09-22T10:00:05.000Z',
    });
  });

  test('persists non-transport session close reasons in the durable controller ledger', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-mcp-session-close-evidence-'));
    const restartedHome = mkdtempSync(join(tmpdir(), 'forge-mcp-session-close-restart-'));
    try {
      recordMcpTransportEvent(home, {
        at: '2026-09-22T10:00:00.000Z',
        kind: 'session_closed',
        sessionId: 'session-idle',
        connectionId: 'connection-a',
        route: '/mcp',
        principalId: 'controller-http-client',
        reason: 'idle_ttl',
      });
      await flushMcpDiagnostics(home);

      const ledger = readFileSync(join(home, 'audit', 'mcp-transport-events.jsonl'), 'utf8');
      expect(ledger).toContain('"reason":"idle_ttl"');
      mkdirSync(join(restartedHome, 'audit'), { recursive: true });
      writeFileSync(join(restartedHome, 'audit', 'mcp-transport-events.jsonl'), ledger);

      // Read through a fresh Controller Home so no process-local event cache can
      // make this assertion pass; this is the same durable path after restart.
      const events = readRecentMcpTransportEvents(restartedHome);
      expect(events).toMatchObject([{
        kind: 'session_closed',
        sessionId: 'session-idle',
        reason: 'idle_ttl',
      }]);
      expect(recentMcpTransportEvidence(
        events,
        '2026-09-22T09:50:00.000Z',
        Date.parse('2026-09-22T10:10:00.000Z'),
      )).toMatchObject({
        current: 'healthy',
        recentStatus: 'stable',
        lastSessionClose: {
          kind: 'session_closed',
          sessionId: 'session-idle',
          reason: 'idle_ttl',
          route: '/mcp',
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(restartedHome, { recursive: true, force: true });
    }
  });

  test('starts a controller Gateway without selecting or registering its launch directory as a repository', async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'forge-mcp-controller-no-repo-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(workingDirectory, async (controllerHome) => {
        runMcpSetupChatgpt({ repo: workingDirectory, port: String(port) });
        proc = Bun.spawn(
          ['bun', join(process.cwd(), 'src/cli/index.ts'), 'mcp', 'serve', '--controller-home', controllerHome, '--transport', 'http', '--host', '127.0.0.1', '--port', String(port), '--profile', 'controller', '--auth', 'bearer'],
          {
            cwd: workingDirectory,
            stdout: 'ignore',
            stderr: 'pipe',
            env: isolatedMcpProcessEnv(controllerHome, { FORGE_CONTROLLER_LIFECYCLE_OWNER: '1' }),
          },
        );
        await waitForHealth(port);
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test('allows explicit no-auth MCP behind an external secure tunnel boundary', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-mcp-http-none-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        proc = Bun.spawn(
          [
            'bun',
            'src/cli/index.ts',
            'mcp',
            'serve',
            '--repo',
            repoRoot,
            '--transport',
            'http',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--profile',
            'planner',
            '--auth',
            'none',
          ],
          { cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe', env: isolatedMcpProcessEnv(controllerHome) },
        );
        await waitForHealth(port);
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(health.auth).toBe('none');

        const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initialized.status).toBe(200);
        expect(initialized.headers.get('mcp-session-id')).toBeTruthy();
        expect(await initialized.text()).toContain('forge-mcp');
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('cloud tunnel host uses MCP initialize readiness for none instead of OAuth metadata', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/host-temporary-cloud-mcp-e2e.sh'), 'utf8');
    const setupIndex = script.indexOf('mcp setup chatgpt');
    const suppressPackageConnectorIndex = script.indexOf('delete config.chatgpt.localEndpoint');
    const installPackageIndex = script.indexOf('runtime service install-package');
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(suppressPackageConnectorIndex).toBeGreaterThan(setupIndex);
    expect(installPackageIndex).toBeGreaterThan(suppressPackageConnectorIndex);
    const authGate = script.slice(script.indexOf('case \"$MCP_AUTH_MODE\" in'), script.indexOf('mkdir -p \"$TUNNEL_DIR\"'));
    expect(authGate).toContain('oauth)');
    expect(authGate).toContain('/.well-known/oauth-authorization-server');
    expect(authGate).toContain('none)');
    expect(authGate).toContain('\"method\":\"initialize\"');
    expect(authGate).toContain('mcp-session-id:');
    expect(authGate).toContain('\"http://127.0.0.1:${GATEWAY_PORT}/mcp\"');
    const noneGate = authGate.slice(authGate.indexOf('none)'), authGate.indexOf('bearer)'));
    expect(noneGate).not.toContain('/.well-known/oauth-authorization-server');
  });

  test('cloud tunnel host bounds readiness races and cleanup teardown', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/host-temporary-cloud-mcp-e2e.sh'), 'utf8');
    expect(script).toContain('wait_for_tunnel_ready()');
    expect(script).toContain('if ! wait_for_tunnel_ready 30; then');
    expect(script).toContain('FORGE_CLOUD_TUNNEL_STATUS process_running=');
    expect(script).toContain('if ! wait_for_tunnel_ready 5; then');
    expect(script).toContain('stop_pid()');
    expect(script).toContain('stop_pid "$GATEWAY_PID"');
    expect(script).toContain('stop_pid "$RUNTIME_PID"');
    expect(script).toContain('FORGE_CLOUD_MCP_CLEANUP_FAILED');
    expect(script).toContain('for _ in $(seq 1 20); do');
  });

  test('preserves existing proxy settings while bypassing direct Runtime endpoints', () => {
    const merged = mergeNoProxy('127.0.0.1,localhost', '.ts.net', '127.0.0.1');
    expect(merged.split(',')).toEqual(['127.0.0.1', 'localhost', '.ts.net']);
    const env = withDirectNetworkProxyBypass({
      NO_PROXY: 'mirrors.aliyun.com',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
    });
    expect(env.NO_PROXY).toContain('mirrors.aliyun.com');
    expect(env.NO_PROXY).toContain('.ts.net');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
  });

  test('requires bearer auth and accepts authenticated initialize requests', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-mcp-http-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        const token = (await Bun.file(mcpControllerHomeTokenPath(controllerHome)).json()).bearerToken;

        proc = Bun.spawn(
          [
            'bun',
            'src/cli/index.ts',
            'mcp',
            'serve',
            '--repo',
            repoRoot,
            '--transport',
            'http',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--profile',
            'planner',
            '--auth',
            'bearer',
          ],
          { cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe', env: isolatedMcpProcessEnv(controllerHome) },
        );
        await waitForHealth(port);

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(await health.json()).toMatchObject({
          status: 'ok',
          auth: 'required',
          mcpEndpoint: `http://127.0.0.1:${port}/mcp`,
          grokEndpoint: `http://127.0.0.1:${port}/mcp`,
          bearerEndpoint: `http://127.0.0.1:${port}/mcp-bearer`,
          sessions: {
            active: 0,
            maximum: 64,
            activePosts: 0,
            activeStreams: 0,
            maximumActivePosts: 32,
          },
        });

        const transportReady = await fetch(`http://127.0.0.1:${port}/transport-ready`);
        expect(transportReady.status).toBe(200);
        expect(await transportReady.json()).toMatchObject({
          ready: true,
          gateway: 'ready',
          sessionCapacity: {
            active: 0,
            maximum: 64,
            admissionMode: 'immediate',
            acceptingNewSessions: true,
            activePosts: 0,
            activeStreams: 0,
            recoveryRecommended: false,
          },
          runtimeCapacity: {
            initializing: 0,
            activePosts: 0,
          },
        });

        const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(noAuth.status).toBe(401);

        const badJson = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{bad',
        });
        expect(badJson.status).toBe(400);

        const modernMeta = {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'forge-modern-http-test', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        };
        const modernHeaders = {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
        };
        const modernProbe = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { ...modernHeaders, 'mcp-method': 'server/discover' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: { _meta: modernMeta } }),
        });
        expect(modernProbe.status).toBe(200);
        expect(modernProbe.headers.get('mcp-session-id')).toBeNull();
        const modernDiscover = await modernProbe.json() as { result?: { supportedVersions?: string[] } };
        expect(modernDiscover.result?.supportedVersions).toContain('2026-07-28');

        const modernTools = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { ...modernHeaders, 'mcp-method': 'tools/list' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'tools-modern-1', method: 'tools/list', params: { _meta: modernMeta } }),
        });
        expect(modernTools.status).toBe(200);
        expect(modernTools.headers.get('mcp-session-id')).toBeNull();
        const modernToolsBody = await modernTools.json() as { result?: { tools?: unknown[] } };
        expect(Array.isArray(modernToolsBody.result?.tools)).toBe(true);

        const postProbeHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(postProbeHealth.sessions.active).toBe(0);
        expect(postProbeHealth.sessions.activePosts).toBe(0);
        expect(postProbeHealth.sessions.oldestActivePostAgeMs).toBe(0);

        const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initialized.status).toBe(200);
        const sessionId = initialized.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();
        expect(await initialized.text()).toContain('forge-mcp');

        const streamController = new AbortController();
        const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
          headers: {
            authorization: `Bearer ${token}`,
            'mcp-session-id': sessionId!,
            accept: 'text/event-stream',
          },
          signal: streamController.signal,
        });
        expect(stream.status).toBe(200);
        await Bun.sleep(25);
        const streamingHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(streamingHealth.sessions.active).toBe(1);
        expect(streamingHealth.sessions.activeStreams).toBe(1);
        streamController.abort();
        await stream.body?.cancel().catch(() => undefined);
        await Bun.sleep(100);
        const closedStreamHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(closedStreamHealth.sessions.activeStreams).toBe(0);

        const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${token}`,
            'mcp-session-id': sessionId!,
          },
        });
        expect(deleted.status).toBe(200);
        await Bun.sleep(25);
        const deletedHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(deletedHealth.sessions).toMatchObject({
          active: 0,
          capacityAvailable: 64,
          acceptingNewSessions: true,
          closed: { clientDelete: 1 },
          lastClosed: { reason: 'client_delete', route: '/mcp', closedAt: expect.any(String) },
        });
        expect(deletedHealth.transportEvidence.lastSessionClose).toMatchObject({
          kind: 'session_closed',
          sessionId,
          reason: 'client_delete',
          route: '/mcp',
        });

        const expiredSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId!,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'expired-session-ping', method: 'ping' }),
        });
        expect(expiredSession.status).toBe(404);
        expect(expiredSession.headers.get('Mcp-Session-Reset')).toBe('reinitialize');
        expect(expiredSession.headers.get('x-forge-session-reset')).toBe('reinitialize');
        expect(await expiredSession.json()).toMatchObject({ code: 'MCP_SESSION_EXPIRED', recoverable: true, action: 'reinitialize' });

        const reinitialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody('forge-reconnected'),
        });
        expect(reinitialized.status).toBe(200);
        const reinitializedSessionId = reinitialized.headers.get('mcp-session-id');
        expect(reinitializedSessionId).toBeTruthy();
        expect(reinitializedSessionId).not.toBe(sessionId);
        const reinitializedDelete = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}`, 'mcp-session-id': reinitializedSessionId! },
        });
        expect(reinitializedDelete.status).toBe(200);
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('bounds 500 real reconnect cycles without applying the OAuth principal quota to shared bearer clients', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-mcp-reconnect-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        const token = (await Bun.file(mcpControllerHomeTokenPath(controllerHome)).json()).bearerToken;

        proc = Bun.spawn(
          ['bun', 'src/cli/index.ts', 'mcp', 'serve', '--repo', repoRoot, '--transport', 'http', '--host', '127.0.0.1', '--port', String(port), '--profile', 'planner', '--auth', 'bearer'],
          {
            cwd: process.cwd(),
            stdout: 'ignore',
            stderr: 'pipe',
            env: isolatedMcpProcessEnv(controllerHome, {
              FORGE_MCP_MAX_SESSIONS: '16',
              FORGE_MCP_MAX_SESSIONS_PER_PRINCIPAL: '2',
              FORGE_MCP_MAX_INITIALIZING_SESSIONS: '32',
            }),
          },
        );
        await waitForHealth(port);

        const burst = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
          const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: initializeBody(`burst-${index}`),
          });
          await response.body?.cancel().catch(() => undefined);
          return response.status;
        }));
        expect(burst.filter((status) => status === 200).length).toBeGreaterThanOrEqual(9);
        expect(burst.every((status) => status === 200 || status === 503)).toBe(true);
        const burstHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(burstHealth.sessions.active).toBeLessThanOrEqual(16);
        expect(burstHealth.sessions.closed.principalCapacity).toBe(0);

        for (let cycle = 0; cycle < 500; cycle += 1) {
          const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: initializeBody(`reconnect-${cycle}`),
          });
          expect(initialized.status).toBe(200);
          const sessionId = initialized.headers.get('mcp-session-id');
          expect(sessionId).toBeTruthy();
          await initialized.body?.cancel().catch(() => undefined);

          const streamController = new AbortController();
          const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
            headers: {
              authorization: `Bearer ${token}`,
              'mcp-session-id': sessionId!,
              accept: 'text/event-stream',
            },
            signal: streamController.signal,
          });
          expect(stream.status).toBe(200);
          streamController.abort();
          await stream.body?.cancel().catch(() => undefined);

        }

        await Bun.sleep(50);
        const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(health.sessions.active).toBeLessThanOrEqual(16);
        expect(health.sessions.acceptingNewSessions).toBe(true);

        const finalInitialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody('post-storm'),
        });
        expect(finalInitialize.status).toBe(200);
        await finalInitialize.body?.cancel().catch(() => undefined);
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test('shares capacity across all MCP routes and evicts a stale session instead of rejecting reconnect', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-mcp-capacity-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        const token = (await Bun.file(mcpControllerHomeTokenPath(controllerHome)).json()).bearerToken;

        proc = Bun.spawn(
          [
            'bun',
            'src/cli/index.ts',
            'mcp',
            'serve',
            '--repo',
            repoRoot,
            '--transport',
            'http',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--profile',
            'planner',
            '--auth',
            'bearer',
          ],
          {
            cwd: process.cwd(),
            stdout: 'ignore',
            stderr: 'pipe',
            env: isolatedMcpProcessEnv(controllerHome, {
              FORGE_MCP_MAX_SESSIONS: '2',
              FORGE_MCP_MAX_SESSIONS_PER_PRINCIPAL: '2',
            }),
          },
        );
        await waitForHealth(port);

        const initialize = async (route: '/mcp' | '/mcp-grok' | '/mcp-bearer', clientName: string): Promise<string> => {
          const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: initializeBody(clientName),
          });
          expect(response.status).toBe(200);
          await response.body?.cancel().catch(() => undefined);
          const sessionId = response.headers.get('mcp-session-id');
          expect(sessionId).toBeTruthy();
          return sessionId!;
        };

        const oldestSessionId = await initialize('/mcp', 'client-a');
        await initialize('/mcp-grok', 'client-b');
        await initialize('/mcp-bearer', 'client-c');

        const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(health.sessions).toMatchObject({
          active: 2,
          maximum: 2,
          capacityAvailable: 0,
          admissionMode: 'eviction',
          acceptingNewSessions: true,
        });
        expect(health.sessions.closed.principalCapacity + health.sessions.closed.capacityEviction).toBe(1);

        const evicted = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'mcp-session-id': oldestSessionId,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
        expect(evicted.status).toBe(404);
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('capacity eviction releases initialize admission before slow transport cleanup completes', async () => {
    let releaseClose!: () => void;
    const blockedClose = new Promise<void>((resolve) => { releaseClose = resolve; });
    const registry = new McpSessionRegistry<{ close(): Promise<void> }, { id: string }>({
      maximumSessions: 1,
      maximumSessionsPerPrincipal: 1,
    });
    registry.register({
      sessionId: 'old-session',
      transport: { close: () => blockedClose },
      toolContext: { id: 'old' },
      route: '/mcp',
      principalId: 'principal-a',
      connectionId: 'connection-a',
      clientIdentity: 'client-a',
    });

    expect(registry.snapshot()).toMatchObject({
      active: 1,
      maximum: 1,
      capacityAvailable: 0,
      admissionMode: 'eviction',
      acceptingNewSessions: true,
    });

    const reservation = await Promise.race([
      registry.reserveForInitialize({
        principalId: 'principal-b',
        connectionId: 'connection-b',
        route: '/mcp',
      }),
      Bun.sleep(100).then(() => 'timed-out' as const),
    ]);
    expect(reservation).not.toBe('timed-out');
    expect(typeof reservation).toBe('string');
    expect(registry.get('old-session')).toBeUndefined();
    expect(registry.snapshot().closed.capacityEviction).toBe(1);

    registry.releaseInitialize(reservation as string);
    releaseClose();
    await Bun.sleep(0);
  });

  test('reclaims the oldest stream-only session before returning capacity backpressure', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-mcp-active-capacity-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        const token = (await Bun.file(mcpControllerHomeTokenPath(controllerHome)).json()).bearerToken;

        proc = Bun.spawn(
          ['bun', 'src/cli/index.ts', 'mcp', 'serve', '--repo', repoRoot, '--transport', 'http', '--host', '127.0.0.1', '--port', String(port), '--profile', 'planner', '--auth', 'bearer'],
          {
            cwd: process.cwd(),
            stdout: 'ignore',
            stderr: 'pipe',
            env: isolatedMcpProcessEnv(controllerHome, {
              FORGE_MCP_MAX_SESSIONS: '2',
              FORGE_MCP_MAX_SESSIONS_PER_PRINCIPAL: '2',
            }),
          },
        );
        await waitForHealth(port);

        const initialize = async (clientName: string): Promise<string> => {
          const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: initializeBody(clientName),
          });
          expect(response.status).toBe(200);
          const sessionId = response.headers.get('mcp-session-id');
          expect(sessionId).toBeTruthy();
          await response.body?.cancel().catch(() => undefined);
          return sessionId!;
        };

        const firstSessionId = await initialize('active-a');
        const secondSessionId = await initialize('active-b');
        const firstController = new AbortController();
        const secondController = new AbortController();
        const firstStream = await fetch(`http://127.0.0.1:${port}/mcp`, {
          headers: {
            authorization: `Bearer ${token}`,
            'mcp-session-id': firstSessionId,
            accept: 'text/event-stream',
          },
          signal: firstController.signal,
        });
        const secondStream = await fetch(`http://127.0.0.1:${port}/mcp`, {
          headers: {
            authorization: `Bearer ${token}`,
            'mcp-session-id': secondSessionId,
            accept: 'text/event-stream',
          },
          signal: secondController.signal,
        });
        expect(firstStream.status).toBe(200);
        expect(secondStream.status).toBe(200);
        await Bun.sleep(25);

        const overflow = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody('overflow'),
        });
        expect(overflow.status).toBe(200);
        const overflowSessionId = overflow.headers.get('mcp-session-id');
        expect(overflowSessionId).toBeTruthy();
        await overflow.body?.cancel().catch(() => undefined);

        const afterOverflow = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(afterOverflow.sessions).toMatchObject({
          active: 2,
          activeStreams: 1,
          evictable: 2,
          protected: 0,
          acceptingNewSessions: true,
        });
        expect(afterOverflow.sessions.closed.capacityEviction).toBe(1);

        const evicted = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'mcp-session-id': firstSessionId,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
        expect(evicted.status).toBe(404);

        firstController.abort();
        await firstStream.body?.cancel().catch(() => undefined);
        secondController.abort();
        await secondStream.body?.cancel().catch(() => undefined);
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('supports ChatGPT-compatible OAuth authorization flow', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-mcp-oauth-'));
    const port = await freePort();
    let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
    try {
      await withTestControllerHome(repoRoot, async (controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        runMcpSetupChatgpt({ repo: repoRoot, port: String(port) });
        const passphrase = (await Bun.file(mcpControllerHomeOAuthPath(controllerHome)).json()).passphrase;
        const staticBearerToken = 'static-bearer-token';
        writeFileSync(
          mcpControllerHomeTokenPath(controllerHome),
          `${JSON.stringify({ version: 1, bearerToken: staticBearerToken }, null, 2)}\n`,
        );

        proc = Bun.spawn(
          [
            'bun',
            'src/cli/index.ts',
            'mcp',
            'serve',
            '--repo',
            repoRoot,
            '--transport',
            'http',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--profile',
            'planner',
          ],
          { cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe', env: isolatedMcpProcessEnv(controllerHome) },
        );
        await waitForHealth(port);

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(await health.json()).toMatchObject({
          status: 'ok',
          auth: 'oauth',
          oauthAuthorizationCodes: { pending: 0, expired: 0, evicted: 0 },
          mcpEndpoint: `http://127.0.0.1:${port}/mcp`,
          grokEndpoint: `http://127.0.0.1:${port}/mcp`,
          bearerEndpoint: `http://127.0.0.1:${port}/mcp-bearer`,
        });

        const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' },
        });
        expect(await metadata.json()).toMatchObject({
          resource: 'https://example.test/mcp',
          authorization_servers: ['https://example.test'],
        });

        const grokMetadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp-grok`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' },
        });
        expect(await grokMetadata.json()).toMatchObject({
          resource: 'https://example.test/mcp-grok',
          authorization_servers: ['https://example.test'],
        });

        const registered = await fetch(`http://127.0.0.1:${port}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['http://localhost/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: 'forge-test',
          }),
        });
        expect(registered.status).toBe(201);
        const client = await registered.json() as { client_id: string };
        expect(typeof client.client_id).toBe('string');

        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const authorizeBody = new URLSearchParams({
          passphrase,
          client_id: client.client_id,
          redirect_uri: 'http://localhost/callback',
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'state-1',
        });
        const authorized = await fetch(`http://127.0.0.1:${port}/authorize`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authorizeBody,
          redirect: 'manual',
        });
        expect(authorized.status).toBe(302);
        const redirect = new URL(authorized.headers.get('location') ?? '');
        const code = redirect.searchParams.get('code');
        expect(code).toBeTruthy();

        const token = await fetch(`http://127.0.0.1:${port}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            code: code ?? '',
            code_verifier: verifier,
            redirect_uri: 'http://localhost/callback',
          }),
        });
        expect(token.status).toBe(200);
        const tokenJson = await token.json() as { access_token: string; token_type: string };
        expect(tokenJson.token_type).toBe('Bearer');

        // A single authenticated developer may have many concurrent ChatGPT
        // conversations. The default principal limit must therefore inherit the
        // globally bounded session capacity instead of making the ninth client
        // evict an otherwise healthy peer and trigger a reconnect feedback loop.
        for (let index = 0; index < 10; index += 1) {
          const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${tokenJson.access_token}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: initializeBody(`parallel-chatgpt-${index}`),
          });
          expect(initialized.status).toBe(200);
          expect(initialized.headers.get('mcp-session-id')).toBeTruthy();
          await initialized.body?.cancel().catch(() => undefined);
        }
        const parallelHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(parallelHealth.sessions.active).toBe(10);
        expect(parallelHealth.sessions.closed.principalCapacity).toBe(0);

        const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(noAuth.status).toBe(401);
        expect(noAuth.headers.get('www-authenticate')).toContain('resource_metadata');
        expect(noAuth.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');

        const grokNoAuth = await fetch(`http://127.0.0.1:${port}/mcp-grok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(grokNoAuth.status).toBe(401);
        expect(grokNoAuth.headers.get('www-authenticate')).toContain('resource_metadata');
        expect(grokNoAuth.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp-grok');

        // Bearer-only endpoint must not advertise OAuth resource_metadata.
        const bearerNoAuth = await fetch(`http://127.0.0.1:${port}/mcp-bearer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: initializeBody(),
        });
        expect(bearerNoAuth.status).toBe(401);
        const bearerWwwAuth = bearerNoAuth.headers.get('www-authenticate') ?? '';
        expect(bearerWwwAuth).toContain('Bearer realm="forge-mcp"');
        expect(bearerWwwAuth).not.toContain('resource_metadata');
        expect(await bearerNoAuth.json()).toMatchObject({ error: 'unauthorized' });

        const bearerAuthed = await fetch(`http://127.0.0.1:${port}/mcp-bearer`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${staticBearerToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(bearerAuthed.status).toBe(200);
        expect(await bearerAuthed.text()).toContain('forge-mcp');

        // Incomplete OAuth authorize must not render the passphrase form.
        const incompleteAuthorize = await fetch(`http://127.0.0.1:${port}/authorize`);
        expect(incompleteAuthorize.status).toBe(400);
        expect(incompleteAuthorize.headers.get('content-type') ?? '').toContain('application/json');
        const incompleteText = await incompleteAuthorize.text();
        expect(incompleteText).not.toContain('type="password"');
        expect(incompleteText).not.toContain('name="passphrase"');
        const incompleteBody = JSON.parse(incompleteText) as { message?: string; error?: string };
        expect(incompleteBody.error).toBe('invalid_request');
        expect(incompleteBody.message ?? '').toContain('/mcp-bearer');

        // Valid authorize request still shows passphrase page before submission.
        const authorizeForm = await fetch(
          `http://127.0.0.1:${port}/authorize?${new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: 'http://localhost/callback',
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'state-form',
            resource: `http://127.0.0.1:${port}/mcp-grok`,
          }).toString()}`,
        );
        expect(authorizeForm.status).toBe(200);
        expect(authorizeForm.headers.get('content-type') ?? '').toContain('text/html');
        const formHtml = await authorizeForm.text();
        expect(formHtml).toContain('type="password"');
        expect(formHtml).toContain('name="passphrase"');
        expect(formHtml).toContain('Authorize forge');
        expect(formHtml).toContain('name="resource"');
        expect(formHtml).toContain(encodeURI(`http://127.0.0.1:${port}/mcp-grok`).replace(/&/g, '&amp;'));

        const initializedGrokWithOAuth = await fetch(`http://127.0.0.1:${port}/mcp-grok`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenJson.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initializedGrokWithOAuth.status).toBe(200);
        expect(await initializedGrokWithOAuth.text()).toContain('forge-mcp');

        const fallbackVerifier = randomBytes(32).toString('base64url');
        const fallbackChallenge = createHash('sha256').update(fallbackVerifier).digest('base64url');
        const fallbackClientId = `grok-client-${randomBytes(4).toString('hex')}`;
        // Current Grok custom connectors use the canonical MCP resource and
        // this OAuth exchange callback. They may authorize without calling
        // dynamic registration first, so retain the public-client fallback.
        const fallbackRedirectUri = 'https://grok.com/connectors-oauth-exchange-code/';
        const fallbackAuthorized = await fetch(`http://127.0.0.1:${port}/authorize`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            passphrase,
            client_id: fallbackClientId,
            redirect_uri: fallbackRedirectUri,
            response_type: 'code',
            code_challenge: fallbackChallenge,
            code_challenge_method: 'S256',
            state: 'grok-state-1',
            resource: `http://127.0.0.1:${port}/mcp`,
          }),
          redirect: 'manual',
        });
        expect(fallbackAuthorized.status).toBe(302);
        const fallbackRedirect = new URL(fallbackAuthorized.headers.get('location') ?? '');
        expect(fallbackRedirect.origin).toBe('https://grok.com');
        expect(fallbackRedirect.searchParams.get('state')).toBe('grok-state-1');
        const fallbackCode = fallbackRedirect.searchParams.get('code');
        expect(fallbackCode).toBeTruthy();

        const fallbackToken = await fetch(`http://127.0.0.1:${port}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: fallbackClientId,
            code: fallbackCode ?? '',
            code_verifier: fallbackVerifier,
            redirect_uri: fallbackRedirectUri,
            resource: `http://127.0.0.1:${port}/mcp`,
          }),
        });
        expect(fallbackToken.status).toBe(200);
        const fallbackTokenJson = await fallbackToken.json() as { access_token: string; token_type: string };
        expect(fallbackTokenJson.token_type).toBe('Bearer');

        const fallbackInitializedGrok = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${fallbackTokenJson.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(fallbackInitializedGrok.status).toBe(200);
        expect(await fallbackInitializedGrok.text()).toContain('forge-mcp');

        const initializedWithStaticBearer = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${staticBearerToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initializedWithStaticBearer.status).toBe(200);
        expect(await initializedWithStaticBearer.text()).toContain('forge-mcp');

        const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenJson.access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: initializeBody(),
        });
        expect(initialized.status).toBe(200);
        expect(await initialized.text()).toContain('forge-mcp');
      });
    } finally {
      await stopMcpServerProcess(proc);
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('the ChatGPT setup hint points only to existing Runtime service commands', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-mcp-setup-hint-'));
    try {
      await withTestControllerHome(repoRoot, async (_controllerHome) => {
        mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
        writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
        const result = runMcpSetupChatgpt({ repo: repoRoot, port: '8765' });
        const config = JSON.parse(readFileSync(join(_controllerHome, 'mcp', 'mcp.local.json'), 'utf8'));
        expect(config.devMode).toMatchObject({ agentRunner: false, allowedAgents: [] });
        expect(config.localController).toMatchObject({ enabled: true, host: '127.0.0.1' });
        const next = result.lines.find((line) => line.startsWith('Next: forge '));
        expect(next).toBeDefined();
        expect(next).not.toContain('keepalive');
        const parts = next!.replace(/^Next: /, '').split(' ');
        const probe = Bun.spawnSync(['bun', 'src/cli/index.ts', ...parts.slice(1, 4), '--help'], {
          cwd: process.cwd(),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout.toString()).toContain('--controller-home');

        const guide = readFileSync(join(repoRoot, 'docs', 'forge-chatgpt-mcp-setup.md'), 'utf8');
        expect(guide).not.toContain('forge mcp keepalive');
        expect(guide).not.toContain('forge mcp serve --repo');
        expect(guide).toContain('forge runtime service install-package');
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

test('shutdown preserves admitted HTTP response before closing transport', async () => {
  const app = express();
  const stats = { activePostStartedAt: new Map(), initializing: 0, rejectedOverload: 0 };
  let release!: () => void;
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  let response: express.Response;
  app.post('/mcp', (_req, res) => {
    response = res;
    admitMcpPost(stats, res);
    release = () => res.json({ result: 'original-result' });
    admitted();
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const result = fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }).then(r => r.json()).catch(() => null);
    await admission;
    let closed = false;
    const draining = drainMcpPosts(stats, async () => { closed = true; response.destroy(); });
    expect(closed).toBe(false);
    release();
    expect(await result).toEqual({ result: 'original-result' });
    await draining;
    expect(closed).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('shutdown rejects unadmitted requests without consuming capacity', () => {
  const stats = { activePostStartedAt: new Map(), initializing: 0, rejectedOverload: 0, draining: true };
  let body: unknown;
  let status: number;
  const res = {
    setHeader() {},
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; },
  } as unknown as express.Response;
  expect(admitMcpPost(stats, res)).toBe(false);
  expect(status!).toBe(503);
  expect(body).toMatchObject({ code: 'MCP_GATEWAY_DRAINING', action: 'reconnect' });
  expect(stats.activePostStartedAt.size).toBe(0);
});

test('shutdown deadline reports observation unknown before transport closes', async () => {
  const app = express();
  const stats = { activePostStartedAt: new Map(), initializing: 0, rejectedOverload: 0 };
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  let response!: express.Response;
  app.post('/mcp', (_req, res) => {
    response = res;
    admitMcpPost(stats, res);
    admitted();
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    await admission;
    const draining = drainMcpPosts(stats, async () => { expect(response.writableFinished).toBe(true); }, 10);
    const reply = await result;
    expect(reply.status).toBe(503);
    expect(await reply.json()).toMatchObject({ code: 'MCP_GATEWAY_SHUTDOWN_OUTCOME_UNKNOWN', retryable: false, action: 'reconcile' });
    await draining;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('real Gateway SIGTERM drains admitted MCP tool result and rejects new requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-gateway-sigterm-'));
  const controllerHome = join(root, 'controller');
  const port = await freePort();
  const token = 'isolated-shutdown-runtime-token';
  mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
  writeFileSync(join(controllerHome, 'mcp', 'runtime-token'), token);
  let admitted!: () => void;
  let release!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const readiness = { ready: true, reasonCodes: [], observedAt: new Date().toISOString(), diagnostics: { database: { outcome: 'pass' as const }, scheduler: { outcome: 'pass' as const }, releaseCoherence: { outcome: 'pass' as const }, mcpEndToEnd: { outcome: 'pass' as const } } };
  const runtime = await startRuntimeMcpTransport({
    host: '127.0.0.1', port: 0, authToken: token, readiness: () => readiness,
    createServer: () => {
      const server = new Server({ name: 'shutdown-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'controller_ready', inputSchema: { type: 'object' as const } }] }));
      server.setRequestHandler('tools/call', async () => {
        admitted();
        await gate;
        return { content: [{ type: 'text' as const, text: 'original-read-result' }] };
      });
      return server;
    },
  });
  const now = new Date().toISOString();
  writeRuntimeStatusSnapshot(controllerHome, {
    schemaVersion: 1, runtimeInstanceId: 'shutdown-fixture', pid: process.pid,
    releaseId: 'shutdown-fixture', artifactIdentity: 'shutdown-fixture',
    endpoint: runtime.endpoint, readiness, startedAt: now, updatedAt: now,
  });
  const proc = Bun.spawn(['bun', '-e', `import { startMcpHttp } from './adapters/mcp/transports/http'; await startMcpHttp({host:'127.0.0.1',port:${port},profile:'controller',auth:'none'});`], {
    cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe', env: isolatedMcpProcessEnv(controllerHome),
  });
  const client = new Client({ name: 'shutdown-client', version: '1' }, { capabilities: {} });
  try {
    try { await waitForHealth(port); } catch (error) {
      if (proc.exitCode !== null) throw new Error(await new Response(proc.stderr).text());
      throw error;
    }
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const result = client.callTool({ name: 'controller_ready', arguments: {} });
    await admission;
    proc.kill('SIGTERM');
    // Health is still served during drain; synchronize on explicit admission refusal.
    let rejected = false;
    for (let i = 0; i < 40; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await response.json() as { code?: string };
      if (body.code === 'MCP_GATEWAY_DRAINING') { rejected = true; break; }
      await Bun.sleep(5);
    }
    expect(rejected).toBe(true);
    release();
    expect((await result).content).toEqual([{ type: 'text', text: 'original-read-result' }]);
    expect(await proc.exited).toBe(0);
  } finally {
    release();
    await client.close();
    if (proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test('retired Runtime sockets cannot initialize sessions after same-endpoint replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-runtime-retired-sockets-'));
  const token = 'retired-socket-fixture';
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'runtime-token'), token);
  const context = createMcpToolContext({ controllerHome: root, profile: 'controller' });
  if (!('controllerHome' in context)) throw new Error('controller context required');
  const previousLaneLimit = process.env.FORGE_CANONICAL_RUNTIME_PROXY_LANES;
  process.env.FORGE_CANONICAL_RUNTIME_PROXY_LANES = '1';
  const proxy = createCanonicalRuntimeProxy(context);
  if (previousLaneLimit === undefined) delete process.env.FORGE_CANONICAL_RUNTIME_PROXY_LANES;
  else process.env.FORGE_CANONICAL_RUNTIME_PROXY_LANES = previousLaneLimit;
  let admitted!: () => void;
  let release!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const readiness = { ready: true, reasonCodes: [], observedAt: new Date().toISOString(), diagnostics: { database: { outcome: 'pass' as const }, scheduler: { outcome: 'pass' as const }, releaseCoherence: { outcome: 'pass' as const }, mcpEndToEnd: { outcome: 'pass' as const } } };
  const start = async (port: number, generation: string) => {
    const transport = await startRuntimeMcpTransport({
      host: '127.0.0.1', port, authToken: token, readiness: () => readiness,
      createServer: () => {
        const server = new Server({ name: generation, version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler('tools/list', async () => ({ tools: [] }));
        server.setRequestHandler('tools/call', async request => {
          if (request.params.arguments?.block) { admitted(); await gate; }
          return { content: [{ type: 'text' as const, text: generation }], structuredContent: { responseMeta: { traceId: '30a0144f-1c29-4b01-8a4a-c34a36b197a5' } } };
        });
        return server;
      },
    });
    const now = new Date().toISOString();
    writeRuntimeStatusSnapshot(root, {
      schemaVersion: 1, runtimeInstanceId: generation, pid: process.pid,
      releaseId: generation, artifactIdentity: generation, endpoint: transport.endpoint,
      readiness, startedAt: now, updatedAt: now,
    });
    return transport;
  };
  let runtime = await start(0, 'first');
  try {
    expect((await proxy.callTool(context, 'controller_ready', {})).content).toEqual([{ type: 'text', text: 'first' }]);
    const blocking = proxy.callTool(context, 'controller_ready', { block: true });
    await admission;
    const timing: NonNullable<Parameters<typeof proxy.callTool>[3]> = {};
    const queued = proxy.callTool(context, 'controller_ready', {}, timing);
    await Bun.sleep(50);
    release();
    await Promise.all([blocking, queued]);
    expect(timing.gatewayProxyLaneWaitMs).toBeGreaterThanOrEqual(30);
    expect(timing.gatewayProxyHandoffWaitMs).toBeLessThan(timing.gatewayProxyLaneWaitMs!);
    const port = runtime.port;
    await runtime.close();
    runtime = await start(port, 'replacement');
    const replacementTiming: NonNullable<Parameters<typeof proxy.callTool>[3]> = {};
    expect((await proxy.callTool(context, 'controller_ready', {}, replacementTiming)).content).toEqual([{ type: 'text', text: 'replacement' }]);
    expect(replacementTiming.gatewayProxyCanonicalTraceId).toBe('30a0144f-1c29-4b01-8a4a-c34a36b197a5');
    expect(runtime.sessionSnapshot?.().active).toBe(1);
  } finally {
    release();
    await proxy.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);


test('Gateway transport failures cannot authorize replay of an admitted mutation', () => {
  for (const reason of ['HTTP 502', 'ECONNRESET', 'ETIMEDOUT', 'CANONICAL_RUNTIME_TIMEOUT', 'unexpected transport EOF']) {
    expect(mcpRequestError(new Error(reason)).body).toMatchObject({
      recoverable: true, retryable: false, action: 'reconcile', executionOutcome: 'unknown',
    });
  }
});


test('stalled admitted HTTP observation reports unknown while original execution completes', async () => {
  const app = express();
  let executions = 0;
  let completed!: () => void;
  const execution = new Promise<void>(resolve => { completed = resolve; });
  app.post('/mcp', (_req, res) => {
    executions += 1;
    setTimeout(completed, 10);
    terminateReclaimedMcpPost(res);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ executionOutcome: 'unknown', retryable: false, action: 'reconcile' });
    await execution;
    expect(executions).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const loseReceipt of [false, true]) {
test(`durable Process survives real Gateway process replacement (lost receipt=${loseReceipt})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-durable-gateway-replacement-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Gateway Test'], ['config', 'user.email', 'gateway@example.test']]) {
    const result = spawnSync('git', args, { cwd: repoRoot });
    if (result.status !== 0) throw new Error(result.stderr.toString());
  }
  writeFileSync(join(repoRoot, 'README.md'), 'Gateway replacement fixture\n');
  for (const args of [['add', 'README.md'], ['commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: repoRoot });
    if (result.status !== 0) throw new Error(result.stderr.toString());
  }
  const gate = join(root, 'release-process');
  const marker = join(root, 'effects');
  writeFileSync(join(repoRoot, '.forge', 'checks.json'), JSON.stringify({ version: 1, checks: {
    survival: {
      description: 'Gateway-independent durable execution',
      command: [process.execPath, '-e', `const fs=require('node:fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);fs.appendFileSync(${JSON.stringify(marker)},'1');console.log('completed');}},20);`],
      timeoutMs: 15_000,
    },
  } }));
  const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: 'main' });
  const context = { ...createMcpToolContext({ controllerHome, profile: 'controller', repo: repoRoot }),
    principalId: 'gateway-replacement-fixture', sessionId: 'runtime-fixture', controllerInstanceId: 'runtime-fixture', controllerType: 'chatgpt' as const };
  const definitions = processToolDefinitions.filter(tool => ['run_check', 'process_get', 'process_wait'].includes(tool.name));
  const readiness = { ready: true, reasonCodes: [], observedAt: new Date().toISOString(), diagnostics: { database: { outcome: 'pass' as const }, scheduler: { outcome: 'pass' as const }, releaseCoherence: { outcome: 'pass' as const }, mcpEndToEnd: { outcome: 'pass' as const } } };
  let processId: string | undefined;
  let firstSubmission = true;
  let accepted!: () => void;
  let releaseReceipt!: () => void;
  const admission = new Promise<void>(resolve => { accepted = resolve; });
  const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const token = 'gateway-replacement-fixture-token';
  mkdirSync(join(controllerHome, 'mcp'), { recursive: true });
  writeFileSync(join(controllerHome, 'mcp', 'runtime-token'), token);
  const runtime = await startRuntimeMcpTransport({
    host: '127.0.0.1', port: 0, authToken: token, readiness: () => readiness,
    createServer: () => {
      const server = new Server({ name: 'durable-runtime-fixture', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', async () => ({ tools: definitions.map(mcpToolDefinitionToSdk) }));
      server.setRequestHandler('tools/call', async request => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const result = request.params.name === 'run_check'
          ? await routeDurableMcpCall(context, request.params.name, args)
          : await callProcessTool(context, request.params.name, args);
        if (!result) throw new Error('unhandled fixture tool');
        if (request.params.name === 'run_check' && firstSubmission) {
          firstSubmission = false;
          processId = String((result.structuredContent as Record<string, unknown>).processId);
          accepted();
          if (loseReceipt) await receiptGate;
        }
        return result;
      });
      return server;
    },
  });
  const now = new Date().toISOString();
  writeRuntimeStatusSnapshot(controllerHome, { schemaVersion: 1, runtimeInstanceId: 'durable-runtime-fixture', pid: process.pid,
    releaseId: 'durable-runtime-fixture', artifactIdentity: 'durable-runtime-fixture', endpoint: runtime.endpoint,
    readiness, startedAt: now, updatedAt: now });
  const port = await freePort();
  const gateways: Bun.Subprocess<'ignore', 'ignore', 'pipe'>[] = [];
  const clients: Client[] = [];
  const connect = async () => {
    const proc = Bun.spawn(['bun', '-e', `import { startMcpHttp } from './adapters/mcp/transports/http';await startMcpHttp({host:'127.0.0.1',port:${port},profile:'controller',auth:'none'});`], {
      cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe', env: isolatedMcpProcessEnv(controllerHome),
    });
    gateways.push(proc);
    await waitForHealth(port);
    const client = new Client({ name: 'durable-gateway-client', version: '1' }, { capabilities: {} });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    return { proc, client };
  };
  const args = { repo_id: repository.repoId, check_id: 'survival', request_id: 'gateway-replacement-original', interactive_wait_ms: 25 };
  try {
    const first = await connect();
    if (loseReceipt) {
      // Inject a caller observation deadline; it never changes Process execution.
      const observation = first.client.callTool({ name: 'run_check', arguments: args }, { timeout: 1_000 }).then(
        result => ({ result, failed: false, error: undefined }),
        error => ({ failed: true, error }),
      );
      await admission;
      first.proc.kill('SIGKILL');
      await first.proc.exited;
      releaseReceipt();
      const lost = await observation;
      expect(lost.failed).toBe(true);
      expect(lost.error).toMatchObject({ code: SdkErrorCode.RequestTimeout });
    } else {
      const started = await first.client.callTool({ name: 'run_check', arguments: args });
      expect(started.isError).not.toBe(true);
      expect(started.structuredContent).toMatchObject({ path: 'process_managed', completed: false, processId });
      first.proc.kill('SIGTERM');
      expect(await first.proc.exited).toBe(0);
    }
    expect(processId).toBeTruthy();
    expect(existsSync(marker)).toBe(false);
    await first.client.close();

    const second = await connect();
    expect(second.proc.pid).not.toBe(first.proc.pid);
    // Recover by the caller's original key even when no Process ID reached it.
    const reconciled = await second.client.callTool({ name: 'run_check', arguments: args });
    expect(reconciled.isError).not.toBe(true);
    expect(reconciled.structuredContent).toMatchObject({ processId });
    const recoveredProcessId = String((reconciled.structuredContent as Record<string, unknown>).processId);
    const running = await second.client.callTool({ name: 'process_get', arguments: { repo_id: repository.repoId, process_id: recoveredProcessId } });
    expect(running.structuredContent).toMatchObject({ process: { processId, status: 'running', completed: false } });
    writeFileSync(gate, 'release');
    const terminal = await second.client.callTool({ name: 'process_wait', arguments: { repo_id: repository.repoId, process_id: processId, timeout_ms: 10_000 } });
    expect(terminal.structuredContent).toMatchObject({ synchronization: 'terminal_result_available', process: { processId, completed: true, ok: true } });
    const replayed = await second.client.callTool({ name: 'run_check', arguments: args });
    expect(replayed.structuredContent).toMatchObject({ processId });
    expect(readFileSync(marker, 'utf8')).toBe('1');
  } finally {
    releaseReceipt();
    writeFileSync(gate, 'release');
    if (processId) await callProcessTool(context, 'process_wait', { repo_id: repository.repoId, process_id: processId, timeout_ms: 5_000 }).catch(() => undefined);
    for (const client of clients) await client.close().catch(() => undefined);
    for (const proc of gateways) {
      if (proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
    }
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
}


test('proxy audit correlation retains Canonical trace identity without requiring timing fields', () => {
  const traceId = '30a0144f-1c29-4b01-8a4a-c34a36b197a5';
  expect(deriveCanonicalForwardingTiming({
    gatewayCallStartedAtMs: 0, gatewayCallDurationMs: 5,
    response: { content: [], structuredContent: { responseMeta: { traceId } } },
  })).toEqual({ gatewayProxyCanonicalTraceId: traceId });
  expect(deriveCanonicalForwardingTiming({
    gatewayCallStartedAtMs: 0, gatewayCallDurationMs: 5,
    response: { content: [], structuredContent: { responseMeta: { traceId: 'untrusted arbitrary data' } } },
  })).toEqual({});
});
