import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mcpControllerHomeOAuthPath, mcpControllerHomeTokenPath } from '../../src/cli/mcp/auth';
import { runMcpSetupChatgpt } from '../../src/cli/mcp/setup';
import { mergeNoProxy, withDirectNetworkProxyBypass } from '../../src/cli/mcp/proxy-env';

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

        const modernProbe = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: {} }),
        });
        expect(modernProbe.status).toBe(404);
        expect(await modernProbe.json()).toEqual({
          jsonrpc: '2.0',
          id: 'discover-1',
          error: { code: -32601, message: 'Method not found' },
        });
        const postProbeHealth = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
        expect(postProbeHealth.sessions.active).toBe(0);

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
        });
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
