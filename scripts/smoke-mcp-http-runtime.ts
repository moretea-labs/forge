import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../src/cli/repositories/registry';
import { readForgeRuntimeStatus } from '../src/runtime/control-plane/runtime-status-client';
import { FORGE_TOOL_SURFACE } from '../src/cli/controller/runtime-config';
import { CORE_CONTROLLER_TOOL_NAMES } from '../src/cli/mcp/toolset';
import { writeMcpServiceLocalConfig } from '../adapters/mcp/auth';
import { buildMcpToolDefinitions } from '../src/cli/mcp/tools';
import { runtimePolicy } from '../src/cli/mcp/multi-repository';
import { resolveControllerToolsetSelection } from '../src/cli/mcp/toolset-selection';
import { RUNTIME_WRITE_CLAIM_ENV } from '../src/runtime/root/write-fence';
import { createMcpToolContext, readCanonicalRuntimeToolSchema } from '../src/cli/mcp/server';

const root = mkdtempSync(join(tmpdir(), 'forge-mcp-http-smoke-'));
const repoRoot = join(root, 'repo');
const controllerHome = join(root, 'controller');
let serverPid: number | undefined;
let runtimePid: number | undefined;

function git(...args: string[]): void { execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' }); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('PORT_DISCOVERY_FAILED'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
async function waitJson(url: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, body };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(100);
    }
  }
  throw new Error(`HTTP_SMOKE_TIMEOUT: ${url}: ${lastError}`);
}

try {
  execFileSync('mkdir', ['-p', repoRoot]);
  git('init');
  git('config', 'user.email', 'mcp-smoke@example.invalid');
  git('config', 'user.name', 'MCP Smoke');
  writeFileSync(join(repoRoot, 'README.md'), '# MCP HTTP smoke\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'initial');
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'mcp-http-smoke' });
  // This smoke validates the HTTP MCP Gateway and daemon readiness only. Keep
  // the optional Local Controller out of its readiness contract so the fixture
  // never depends on or collides with a host-level bridge at the default port.
  writeMcpServiceLocalConfig(controllerHome, {
    profile: 'controller',
    localController: {
      enabled: false,
      mode: 'disabled',
      host: '127.0.0.1',
      port: 8766,
    },
  });
  const childEnv = { ...process.env };
  for (const key of Object.values(RUNTIME_WRITE_CLAIM_ENV)) delete childEnv[key];
  const runtimeToken = 'forge-mcp-http-smoke-runtime-token';
  const runtimeTokenFile = join(controllerHome, 'mcp', 'runtime-token');
  writeFileSync(runtimeTokenFile, `${runtimeToken}\n`, { encoding: 'utf8', mode: 0o600 });
  const releaseManifestPath = join(root, 'runtime-release.json');
  writeFileSync(releaseManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    releaseId: 'mcp-http-smoke-runtime',
    artifactIdentity: 'sha256:mcp-http-smoke-runtime',
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome,
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion: 1,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  const runtimePort = await freePort();
  const runtimeChild = spawn('bun', [
    join(process.cwd(), 'src/runtime/root/entry.ts'),
    '--controller-home', controllerHome,
    '--repo', repoRoot,
    '--release-manifest', releaseManifestPath,
    '--host', '127.0.0.1',
    '--port', String(runtimePort),
    '--auth-token-file', runtimeTokenFile,
  ], {
    env: { ...childEnv, FORGE_CONTROLLER_HOME: controllerHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runtimePid = runtimeChild.pid;
  let runtimeStderr = '';
  runtimeChild.stderr?.on('data', (chunk) => { runtimeStderr += String(chunk); });
  runtimeChild.once('exit', (code) => {
    if (code && code !== 0) runtimeStderr += `\nruntime exited ${code}`;
  });
  try {
    let runtimeReady = await waitJson(`http://127.0.0.1:${runtimePort}/ready`, 20_000);
    const runtimeReadyDeadline = Date.now() + 20_000;
    while (runtimeReady.status !== 200 && Date.now() < runtimeReadyDeadline) {
      await sleep(100);
      runtimeReady = await waitJson(`http://127.0.0.1:${runtimePort}/ready`, 2_000);
    }
    if (runtimeReady.status !== 200 || runtimeReady.body.ready !== true) throw new Error(`RUNTIME_READINESS_FAILED: ${JSON.stringify(runtimeReady)}`);
  } catch (error) {
    throw new Error(`RUNTIME_START_FAILED: ${error instanceof Error ? error.message : String(error)} ${runtimeStderr}`);
  }

  const port = await freePort();
  const child = spawn(process.execPath, [
    '--loader', join(process.cwd(), 'src/runtime/shared/node-ts-loader.mjs'),
    join(process.cwd(), 'src/cli/index.ts'), 'mcp', 'serve', '--repo', repoRoot,
    '--transport', 'http', '--enable-dev-runner', '--dev-runner-agents', 'codex,claude', '--host', '127.0.0.1', '--port', String(port), '--profile', 'controller', '--auth', 'oauth',
  ], {
    env: {
      ...childEnv,
      FORGE_CONTROLLER_HOME: controllerHome,
      FORGE_CONTROLLER_LIFECYCLE_OWNER: '1',
      FORGE_RUNTIME_MAX_LIFETIME_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverPid = child.pid;
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.once('exit', (code) => {
    if (code && code !== 0) stderr += `\nserver exited ${code}`;
  });

  let health: { status: number; body: Record<string, unknown> };
  try {
    health = await waitJson(`http://127.0.0.1:${port}/health`, 20_000);
  } catch (error) {
    throw new Error(`GATEWAY_START_FAILED: ${error instanceof Error ? error.message : String(error)} ${stderr}`);
  }
  if (health.status !== 200 || health.body.status !== 'ok') throw new Error(`HEALTH_FAILED: ${JSON.stringify(health)} ${stderr}`);
  const expectedPolicy = runtimePolicy(repoRoot, {
    repo: repoRoot,
    controllerHome,
    profile: 'controller',
    enableDevRunner: true,
    devRunnerAgents: 'codex,claude',
  });
  // Unmarked Controller startup intentionally preserves the Advanced compatibility label.
  const expectedToolset = resolveControllerToolsetSelection(null).toolset;
  if (health.body.toolset !== expectedToolset) throw new Error(`TOOLSET_CHANGED: ${String(health.body.toolset)}`);
  if (health.body.toolSurface !== FORGE_TOOL_SURFACE) throw new Error(`TOOL_SURFACE_CHANGED: ${String(health.body.toolSurface)}`);
  const expectedCompatibilityToolCount = buildMcpToolDefinitions(expectedPolicy).length;
  if (health.body.compatibilityToolCount !== expectedCompatibilityToolCount) throw new Error(`LEGACY_MCP_TOOL_COUNT_CHANGED: ${String(health.body.compatibilityToolCount)}`);

  let ready = await waitJson(`http://127.0.0.1:${port}/ready`, 20_000);
  const readyDeadline = Date.now() + 20_000;
  while (ready.status !== 200 && Date.now() < readyDeadline) {
    await sleep(100);
    ready = await waitJson(`http://127.0.0.1:${port}/ready`, 2_000);
  }
  if (ready.status !== 200 || ready.body.ready !== true) throw new Error(`READINESS_FAILED: ${JSON.stringify(ready)} ${stderr}`);
  const repoHealth = await waitJson(`http://127.0.0.1:${port}/repos/${repository.repoId}/health`, 10_000);
  if (repoHealth.status !== 200 || repoHealth.body.status !== 'ok') throw new Error(`REPOSITORY_HEALTH_FAILED: ${JSON.stringify(repoHealth)}`);
  const runtimeContext = createMcpToolContext({
    repo: repoRoot,
    controllerHome,
    profile: 'controller',
    enableDevRunner: true,
    devRunnerAgents: 'codex,claude',
  });
  const runtimeSchema = await readCanonicalRuntimeToolSchema(runtimeContext);
  const expectedRuntimeNames = [...CORE_CONTROLLER_TOOL_NAMES].sort();
  if (JSON.stringify(runtimeSchema.toolNames) !== JSON.stringify(expectedRuntimeNames)) {
    throw new Error(`RUNTIME_TOOL_SCHEMA_CHANGED: ${JSON.stringify(runtimeSchema.toolNames)}`);
  }
  health = await waitJson(`http://127.0.0.1:${port}/health`, 5_000);
  if (health.body.runtimeToolSurfaceFingerprint !== runtimeSchema.fingerprint) throw new Error(`RUNTIME_FINGERPRINT_CHANGED: ${String(health.body.runtimeToolSurfaceFingerprint)}`);
  if (health.body.toolSurfaceFingerprint !== runtimeSchema.fingerprint) throw new Error(`GATEWAY_FINGERPRINT_CHANGED: ${String(health.body.toolSurfaceFingerprint)}`);
  const observedRuntimePid = readForgeRuntimeStatus(controllerHome).pid;
  if (!observedRuntimePid || observedRuntimePid !== runtimePid) throw new Error(`RUNTIME_PID_CHANGED: expected=${String(runtimePid)} observed=${String(observedRuntimePid)}`);

  console.log(JSON.stringify({
    status: 'ok', port, repoId: repository.repoId,
    toolset: health.body.toolset,
    toolCount: runtimeSchema.toolNames.length,
    runtimeFingerprint: runtimeSchema.fingerprint,
    compatibilityToolCount: health.body.compatibilityToolCount,
    fingerprint: health.body.toolSurfaceFingerprint,
    ready: ready.body.ready,
    repositoryHealth: repoHealth.body.status,
  }, null, 2));
} finally {
  if (!runtimePid) runtimePid = readForgeRuntimeStatus(controllerHome).pid;
  if (serverPid) { try { process.kill(serverPid, 'SIGTERM'); } catch { /* stopped */ } }
  if (runtimePid) { try { process.kill(runtimePid, 'SIGTERM'); } catch { /* stopped */ } }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const serverAlive = serverPid ? (() => { try { process.kill(serverPid, 0); return true; } catch { return false; } })() : false;
    const daemonAlive = runtimePid ? (() => { try { process.kill(runtimePid, 0); return true; } catch { return false; } })() : false;
    if (!serverAlive && !daemonAlive) break;
    await sleep(50);
  }
  if (serverPid) { try { process.kill(serverPid, 'SIGKILL'); } catch { /* stopped */ } }
  if (runtimePid) { try { process.kill(runtimePid, 'SIGKILL'); } catch { /* stopped */ } }
  rmSync(root, { recursive: true, force: true });
}
