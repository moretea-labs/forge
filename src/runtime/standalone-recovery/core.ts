import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { connect } from 'net';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { createRecoveryHttpTransport, type RecoveryHttpTransport } from './http-transport';

/**
 * This module deliberately imports only Node built-ins.  It is compiled into
 * the recovery binary and never follows current/active release symlinks.
 */
export interface PublicTunnelServiceConfig {
  platform: 'launchd';
  label: string;
  plistPath?: string;
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  cooldownMs?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface RecoveryConfig {
  schemaVersion: 1;
  controllerHome: string;
  stableIngressUrl: string;
  publicMcpUrl?: string;
  publicTunnelService?: PublicTunnelServiceConfig;
  recoveryPublicUrl?: string;
  recoveryTunnelService?: PublicTunnelServiceConfig;
  mainMcpTokenFile?: string;
  expectedToolFingerprint?: string;
  readOnlyTool?: { name: string; arguments?: Record<string, unknown> };
  gateway?: { host: string; port: number; bearerTokenFile: string };
}

interface SupervisorState {
  observedState?: string;
  activeSlot?: string;
  previousSlot?: string;
  currentOperationId?: string | null;
  supervisor?: { pid?: number; releasePath?: string; releaseRevision?: string };
  gatewayHost?: { releasePath?: string; releaseRevision?: string; slot?: string };
  controllerDaemon?: { releasePath?: string; releaseRevision?: string; slot?: string };
  restartBudget?: Record<string, { component?: string; lockedOut?: boolean; attempts?: number; consecutiveFailures?: number }>;
}

interface ReleaseEvidence {
  path: string;
  revision: string;
  manifestSha256: string;
  controllerHome?: string;
  configRevision?: string;
  configHash?: string;
  runtimeGeneration?: string;
  runtimeFencingTokenSha256?: string;
  attestedAt?: string;
}

interface KnownGoodStore {
  schemaVersion: 1;
  releases: ReleaseEvidence[];
  updatedAt: string;
}

interface RuntimeBinding {
  controllerHome: string;
  configRevision: string;
  configHash: string;
  runtimeGeneration: string;
  authorityTerm: string;
  releaseRevision?: string;
  releasePath?: string;
  manifestHash?: string;
  gatewayHost: string;
  gatewayPort: number;
  runtimeFencingTokenSha256: string;
}

export type RecoveryMutationAction =
  | 'attest_known_good'
  | 'rollback_previous'
  | 'restart_gateway'
  | 'restart_recovery_gateway'
  | 'repair_public_tunnel'
  | 'restart_supervisor';

interface RecoveryLock {
  schemaVersion?: 1;
  pid: number;
  instanceId: string;
  processStartTime?: string;
  acquiredAt: string;
  action?: RecoveryMutationAction;
  requestId?: string;
}

interface RecoveryLockIntent {
  action: RecoveryMutationAction;
  requestId?: string;
}

type RecoveryLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false; owner: RecoveryLock };

export interface VerifyResult {
  ok: boolean;
  at: string;
  supervisor: { ok: boolean; observedState?: string; activeSlot?: string; previousSlot?: string };
  releases: { active?: ReleaseEvidence; previous?: ReleaseEvidence; knownGood?: ReleaseEvidence; coherent: boolean };
  probes: Record<string, { ok: boolean; detail: string; status?: number; value?: unknown }>;
}

export interface RollbackResult {
  ok: boolean;
  noOp?: boolean;
  operationId?: string;
  detail: string;
  verify?: VerifyResult;
}

export interface RestartSupervisorResult {
  ok: boolean;
  noOp?: boolean;
  reused?: boolean;
  inProgress?: boolean;
  beforePid?: number;
  afterPid?: number;
  activeAction?: RecoveryMutationAction;
  activeRequestId?: string;
  detail: string;
  verify: VerifyResult;
}

interface RestartSupervisorReceipt {
  schemaVersion: 1;
  action: 'restart_supervisor';
  requestId: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  ownerInstanceId: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: RestartSupervisorResult;
}

export interface WatchdogDecision {
  action: 'healthy' | 'degraded' | 'repair_public_tunnel' | 'restart_recovery_gateway' | 'restart_gateway' | 'restart_supervisor' | 'rollback';
  reason: string;
}

export interface WatchdogState {
  failures: number;
  firstFailureAt?: number;
  rollbackUsed: boolean;
  publicTunnelFailures?: number;
  publicTunnelFirstFailureAt?: number;
  publicTunnelRepairFailures?: number;
  recoveryGatewayRestartUsed?: boolean;
  gatewayRestartUsed?: boolean;
  supervisorRestartUsed?: boolean;
  lastDecision?: WatchdogDecision['action'];
  updatedAt?: string;
}

export interface PublicTunnelRepairResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceLabel?: string;
  serviceTarget?: string;
  verify: VerifyResult;
  localVerify?: VerifyResult;
}

const DEFAULT_CONFIG: Omit<RecoveryConfig, 'controllerHome'> = {
  schemaVersion: 1,
  stableIngressUrl: 'http://127.0.0.1:8765',
  readOnlyTool: { name: 'controller_context' },
};

function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, path);
}

function recoveryRoot(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'recovery'); }
function statePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'known-good.json'); }
function lockPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'locks', 'operation.lock'); }
function recoveryRequestPath(config: RecoveryConfig, action: RecoveryMutationAction, requestId: string): string {
  const digest = createHash('sha256').update(`${action}\0${requestId}`).digest('hex');
  return join(recoveryRoot(config), 'operations', `${digest}.json`);
}
function auditPath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'audit', 'recovery.jsonl'); }
function quarantinePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'quarantine.json'); }
function publicTunnelRepairStatePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'public-tunnel-repair.json'); }
function watchdogStatePath(config: RecoveryConfig): string { return join(recoveryRoot(config), 'state', 'watchdog.json'); }
export function loadWatchdogState(config: RecoveryConfig): WatchdogState {
  const state = json<WatchdogState>(watchdogStatePath(config));
  if (!state || !Number.isInteger(state.failures) || state.failures < 0 || typeof state.rollbackUsed !== 'boolean') {
    return { failures: 0, rollbackUsed: false, publicTunnelFailures: 0, publicTunnelRepairFailures: 0 };
  }
  return state;
}

export function saveWatchdogState(config: RecoveryConfig, state: WatchdogState): WatchdogState {
  const persisted = { ...state, updatedAt: new Date().toISOString() };
  writeJson(watchdogStatePath(config), persisted);
  return persisted;
}

function configuredRecoveryTunnel(config: RecoveryConfig): PublicTunnelServiceConfig | undefined {
  return config.recoveryTunnelService ?? config.publicTunnelService;
}

function configuredRecoveryPublicUrl(config: RecoveryConfig): string | undefined {
  if (config.recoveryPublicUrl) return config.recoveryPublicUrl;
  return config.recoveryTunnelService ? undefined : config.publicTunnelService ? config.publicMcpUrl : undefined;
}

function socketPath(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'supervisor', 'control.sock'); }
function supervisorStateFilePath(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'supervisor', 'state.json'); }
function supervisorActivationPath(config: RecoveryConfig): string { return join(resolve(config.controllerHome), 'supervisor', 'activation.json'); }

// Keep the standalone recovery bundle dependent only on Node built-ins and its
// local transport. A regression test compares this compatibility list with the
// Supervisor release contract so the two surfaces cannot drift silently.
export const STANDALONE_RECOVERY_REQUIRED_RELEASE_FILES = [
  'supervisor.js',
  'repo-harness.js',
  'daemon.js',
  'worker.js',
  'process-runner.js',
  'browser-handoff-host.js',
  'browser-node-bridge-host.js',
  'repo-harness-desktop-helper.mjs',
] as const;
const REQUIRED_RELEASE_FILES = STANDALONE_RECOVERY_REQUIRED_RELEASE_FILES;

export function recoveryConfigPath(controllerHome: string): string {
  return join(resolve(controllerHome), 'recovery', 'config', 'recovery.json');
}

export function loadRecoveryConfig(controllerHome: string, explicit?: string): RecoveryConfig {
  const loaded = json<Partial<RecoveryConfig> & { agentRepair?: unknown }>(explicit ?? recoveryConfigPath(controllerHome)) ?? {};
  delete loaded.agentRepair;
  const config: RecoveryConfig = {
    ...DEFAULT_CONFIG,
    ...loaded,
    schemaVersion: 1,
    controllerHome: resolve(loaded.controllerHome ?? controllerHome),
    gateway: loaded.gateway,
  };
  if (!config.controllerHome) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
  return config;
}

export function createRecoveryConfig(controllerHome: string, input?: Partial<RecoveryConfig>): RecoveryConfig {
  const config = loadRecoveryConfig(controllerHome);
  const next: RecoveryConfig = { ...config, ...input, schemaVersion: 1, controllerHome: resolve(controllerHome) };
  writeJson(recoveryConfigPath(controllerHome), next);
  return next;
}

function releaseEvidence(path: string | undefined): ReleaseEvidence | undefined {
  if (!path) return undefined;
  try {
    const real = realpathSync(path);
    const manifestPath = join(real, 'manifest.json');
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { releaseRevision?: unknown };
    if (typeof manifest.releaseRevision !== 'string' || !/^[A-Za-z0-9._-]{6,128}$/.test(manifest.releaseRevision)) return undefined;
    for (const entry of REQUIRED_RELEASE_FILES) if (!existsSync(join(real, entry))) return undefined;
    return { path: real, revision: manifest.releaseRevision, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') };
  } catch { return undefined; }
}

function runtimeBinding(config: RecoveryConfig): RuntimeBinding | undefined {
  const home = realpathSync(resolve(config.controllerHome));
  try {
    const configPath = join(home, 'bootstrap', 'runtime-config.json');
    const configBytes = readFileSync(configPath);
    const runtimeConfig = JSON.parse(configBytes.toString('utf8')) as {
      schemaVersion?: unknown;
      controllerHome?: unknown;
      configRevision?: unknown;
      revision?: unknown;
      gateway?: { host?: unknown; port?: unknown };
    };
    if (runtimeConfig.schemaVersion !== 1 || resolve(String(runtimeConfig.controllerHome ?? '')) !== home) return undefined;
    const configRevision = typeof runtimeConfig.configRevision === 'string'
      ? runtimeConfig.configRevision
      : typeof runtimeConfig.revision === 'string' ? runtimeConfig.revision : undefined;
    if (!configRevision) return undefined;
    const authority = json<{
      schemaVersion?: unknown;
      status?: unknown;
      authorityTerm?: unknown;
      generation?: unknown;
      configRevision?: unknown;
      configHash?: unknown;
      fencingToken?: unknown;
      active?: { releasePath?: unknown; releaseRevision?: unknown; manifestHash?: unknown };
      gateway?: { host?: unknown; port?: unknown };
    }>(join(home, 'bootstrap', 'runtime-authority.json'));
    const configHash = createHash('sha256').update(configBytes).digest('hex');
    const gatewayHost = typeof runtimeConfig.gateway?.host === 'string' ? runtimeConfig.gateway.host : undefined;
    const gatewayPort = typeof runtimeConfig.gateway?.port === 'number' && Number.isInteger(runtimeConfig.gateway.port)
      ? runtimeConfig.gateway.port
      : undefined;
    if (
      authority?.schemaVersion !== 2
      || authority.status !== 'committed'
      || authority.configRevision !== configRevision
      || authority.configHash !== configHash
      || typeof authority.authorityTerm !== 'string'
      || typeof authority.generation !== 'string'
      || typeof authority.fencingToken !== 'string'
      || typeof gatewayHost !== 'string'
      || gatewayPort === undefined
      || authority.gateway?.host !== gatewayHost
      || authority.gateway?.port !== gatewayPort
    ) return undefined;
    return {
      controllerHome: home,
      configRevision,
      configHash,
      runtimeGeneration: authority.generation,
      authorityTerm: authority.authorityTerm,
      ...(typeof authority.active?.releaseRevision === 'string' ? { releaseRevision: authority.active.releaseRevision } : {}),
      ...(typeof authority.active?.releasePath === 'string' ? { releasePath: realpathSync(authority.active.releasePath) } : {}),
      ...(typeof authority.active?.manifestHash === 'string' ? { manifestHash: authority.active.manifestHash } : {}),
      gatewayHost,
      gatewayPort,
      runtimeFencingTokenSha256: createHash('sha256').update(authority.fencingToken).digest('hex'),
    };
  } catch {
    return undefined;
  }
}

function knownGoodEvidence(config: RecoveryConfig, entry: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!entry || !entry.configRevision || !entry.configHash || !entry.runtimeGeneration || !entry.runtimeFencingTokenSha256 || !entry.attestedAt) return undefined;
  const binding = runtimeBinding(config);
  if (!binding || typeof entry.controllerHome !== 'string' || entry.controllerHome !== binding.controllerHome) return undefined;
  const release = releaseEvidence(entry.path);
  if (!release) return undefined;
  const releasesRoot = realpathSync(join(resolve(config.controllerHome), 'supervisor', 'releases'));
  if (!release.path.startsWith(`${releasesRoot}${sep}`)) return undefined;
  if (release.path !== entry.path || release.revision !== entry.revision || release.manifestSha256 !== entry.manifestSha256) return undefined;
  if (entry.configRevision !== binding.configRevision || entry.configHash !== binding.configHash) return undefined;
  if (entry.runtimeGeneration !== binding.runtimeGeneration) return undefined;
  if (entry.runtimeFencingTokenSha256 !== binding.runtimeFencingTokenSha256) return undefined;
  return entry;
}

function selectKnownGoodRelease(config: RecoveryConfig, active: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  const candidates = knownGood(config).releases
    .map((entry) => knownGoodEvidence(config, entry))
    .filter((entry): entry is ReleaseEvidence => Boolean(entry))
    .filter((entry) => !active || entry.path !== active.path)
    .sort((left, right) => Date.parse(right.attestedAt!) - Date.parse(left.attestedAt!));
  return candidates[0];
}

function currentSupervisorRelease(config: RecoveryConfig): ReleaseEvidence | undefined {
  return releaseEvidence(join(resolve(config.controllerHome), 'supervisor', 'current'));
}

function previousSupervisorRelease(config: RecoveryConfig): ReleaseEvidence | undefined {
  return releaseEvidence(join(resolve(config.controllerHome), 'supervisor', 'previous'));
}

function activeAuthorityRelease(config: RecoveryConfig): ReleaseEvidence | undefined {
  const binding = runtimeBinding(config);
  const release = releaseEvidence(binding?.releasePath);
  if (!binding || !release) return undefined;
  if (binding.releaseRevision && release.revision !== binding.releaseRevision) return undefined;
  if (binding.manifestHash && release.manifestSha256 !== binding.manifestHash) return undefined;
  return release;
}

function readSupervisorStateFile(config: RecoveryConfig): SupervisorState | undefined {
  return json<SupervisorState>(supervisorStateFilePath(config));
}

function knownGood(config: RecoveryConfig): KnownGoodStore {
  return json<KnownGoodStore>(statePath(config)) ?? { schemaVersion: 1, releases: [], updatedAt: new Date(0).toISOString() };
}

function matchingKnownGood(config: RecoveryConfig, release: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!release) return undefined;
  return knownGoodEvidence(config, knownGood(config).releases.find((entry) =>
    entry.revision === release.revision && entry.manifestSha256 === release.manifestSha256 && entry.path === release.path,
  ));
}


function audit(config: RecoveryConfig, event: string, detail: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, detail });
  mkdirSync(dirname(auditPath(config)), { recursive: true, mode: 0o700 });
  writeFileSync(auditPath(config), `${line}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

function processStartTime(pid: number): string | undefined {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 4_096,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return result.stdout.trim() || undefined;
}

function recoveryLockOwnerAlive(lock: RecoveryLock): boolean {
  if (!pidAlive(lock.pid)) return false;
  if (!lock.processStartTime) return true;
  const observed = processStartTime(lock.pid);
  return observed === undefined || observed === lock.processStartTime;
}

function recoveryBusyDetail(owner: RecoveryLock): string {
  return `Recovery mutation already in progress: action=${owner.action ?? 'unknown'} request=${owner.requestId ?? 'unknown'} pid=${owner.pid}`;
}

async function withLock<T>(
  config: RecoveryConfig,
  intent: RecoveryLockIntent,
  action: (lock: RecoveryLock) => Promise<T>,
): Promise<RecoveryLockAttempt<T>> {
  const path = lockPath(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock: RecoveryLock = {
    schemaVersion: 1,
    pid: process.pid,
    instanceId: randomUUID(),
    processStartTime: processStartTime(process.pid),
    acquiredAt: new Date().toISOString(),
    action: intent.action,
    ...(intent.requestId ? { requestId: intent.requestId } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    let acquired = false;
    try {
      try {
        fd = openSync(path, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify(lock));
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = json<RecoveryLock>(path);
        if (!existing || !Number.isInteger(existing.pid) || typeof existing.instanceId !== 'string') {
          throw new Error('RECOVERY_OPERATION_LOCK_UNCERTAIN');
        }
        if (recoveryLockOwnerAlive(existing)) return { acquired: false, owner: existing };
        const latest = json<RecoveryLock>(path);
        if (!latest || latest.instanceId !== existing.instanceId) {
          if (attempt === 1) return { acquired: false, owner: latest ?? existing };
          continue;
        }
        if (recoveryLockOwnerAlive(latest)) return { acquired: false, owner: latest };
        try { writeFileSync(`${path}.stale-${Date.now()}-${existing.instanceId}`, readFileSync(path)); } catch { /* evidence best effort */ }
        rmSync(path, { force: true });
        continue;
      }
      return { acquired: true, value: await action(lock) };
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (acquired) {
        const current = json<RecoveryLock>(path);
        if (current?.instanceId === lock.instanceId) rmSync(path, { force: true });
      }
    }
  }
  throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
}

function control(config: RecoveryConfig, command: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolveControl, reject) => {
    const socket = connect(socketPath(config));
    let text = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('RECOVERY_CONTROL_TIMEOUT')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on('data', (chunk: string) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try { resolveControl(JSON.parse(text.slice(0, newline)) as Record<string, unknown>); } catch { reject(new Error('RECOVERY_CONTROL_INVALID_RESPONSE')); }
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(new Error(`RECOVERY_CONTROL_UNAVAILABLE: ${error.message}`)); });
  });
}

export async function supervisorStatus(config: RecoveryConfig): Promise<SupervisorState> {
  const response = await control(config, { command: 'status' });
  if (response.ok !== true || !response.state || typeof response.state !== 'object') throw new Error('RECOVERY_SUPERVISOR_STATUS_UNAVAILABLE');
  return response.state as SupervisorState;
}

async function probe(transport: RecoveryHttpTransport, url: string, timeoutMs = 4_000): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport.request({ url, headers: { accept: 'application/json' }, timeoutMs, signal: controller.signal });
    return { ok: response.ok, detail: `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'request failed' };
  } finally { clearTimeout(timer); }
}

async function probeExternalMcp(transport: RecoveryHttpTransport, url: string): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await transport.request({ url, headers: { accept: 'application/json' }, timeoutMs: 4_000, signal: controller.signal });
    const challenge = response.headers['www-authenticate'] ?? '';
    const ok = response.ok || (response.status === 401 && /\bBearer\b/i.test(challenge));
    return { ok, detail: ok && response.status === 401 ? 'HTTP 401 OAuth challenge' : `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'request failed' };
  } finally { clearTimeout(timer); }
}

function mainToken(config: RecoveryConfig): string | undefined {
  const candidate = config.mainMcpTokenFile ?? join(config.controllerHome, 'mcp', 'mcp.tokens.json');
  const parsed = json<{ bearerToken?: unknown }>(candidate);
  return typeof parsed?.bearerToken === 'string' && parsed.bearerToken.length >= 24 ? parsed.bearerToken : undefined;
}

interface RecoveryMcpCallResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  detail: string;
  sessionId?: string;
}

function parseRecoveryMcpPayload(text: string, contentType: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (contentType.includes('text/event-stream')) {
    const data = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .find((line) => line && line !== '[DONE]');
    if (!data) return undefined;
    try { return JSON.parse(data) as Record<string, unknown>; } catch { return undefined; }
  }
  try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { return undefined; }
}

async function mcpCall(
  transport: RecoveryHttpTransport,
  url: string,
  token: string,
  id: number | undefined,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<RecoveryMcpCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await transport.request({
      url, method: 'POST', timeoutMs: 8_000, signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
    });
    const payload = parseRecoveryMcpPayload(response.body, response.headers['content-type'] ?? '');
    const returnedSessionId = response.headers['mcp-session-id']?.trim() || sessionId;
    return {
      ok: response.ok && !payload?.error,
      payload,
      detail: `HTTP ${response.status}`,
      ...(returnedSessionId ? { sessionId: returnedSessionId } : {}),
    };
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'MCP request failed' }; } finally { clearTimeout(timer); }
}

async function closeRecoveryMcpSession(transport: RecoveryHttpTransport, url: string, token: string, sessionId: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await transport.request({
      url,
      method: 'DELETE',
      timeoutMs: 5_000,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
    });
    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'MCP session close failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function probeMcp(config: RecoveryConfig, transport: RecoveryHttpTransport): Promise<Record<string, { ok: boolean; detail: string; value?: unknown }>> {
  const binding = runtimeBinding(config);
  const url = config.publicMcpUrl
    ?? (binding ? `http://${binding.gatewayHost}:${binding.gatewayPort}/mcp` : undefined);
  if (!url) return { mcp_initialize: { ok: false, detail: 'canonical Runtime MCP binding is unavailable' } };
  const token = mainToken(config);
  if (!token) return { mcp_initialize: { ok: false, detail: 'main MCP probe credential is unavailable' } };
  const initialized = await mcpCall(transport, url, token, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'standalone-recovery', version: '1' },
  });
  if (!initialized.ok || !initialized.sessionId) {
    return {
      mcp_initialize: {
        ok: false,
        detail: initialized.ok ? `${initialized.detail}; session id missing` : initialized.detail,
      },
    };
  }
  const sessionId = initialized.sessionId;
  const acknowledged = await mcpCall(transport, url, token, undefined, 'notifications/initialized', undefined, sessionId);
  if (!acknowledged.ok) {
    const closed = await closeRecoveryMcpSession(transport, url, token, sessionId);
    return {
      mcp_initialize: { ok: true, detail: initialized.detail },
      mcp_initialized_notification: { ok: false, detail: acknowledged.detail },
      mcp_session_close: { ok: closed.ok, detail: closed.detail },
    };
  }
  const listed = await mcpCall(transport, url, token, 2, 'tools/list', undefined, sessionId);
  const tools = Array.isArray((listed.payload?.result as { tools?: unknown } | undefined)?.tools)
    ? ((listed.payload!.result as { tools: Array<{ name?: unknown }> }).tools)
    : [];
  const names = tools.map((tool) => typeof tool.name === 'string' ? tool.name : '').filter(Boolean).sort();
  const fingerprint = createHash('sha256').update(names.join('\n')).digest('hex');
  const expected = config.expectedToolFingerprint;
  const expectedMatches = !expected || (expected.length === fingerprint.length && timingSafeEqual(Buffer.from(expected), Buffer.from(fingerprint)));
  const toolListOk = listed.ok && names.length > 0 && expectedMatches;
  const readOnly = config.readOnlyTool ?? { name: 'controller_context' };
  const called = toolListOk
    ? await mcpCall(transport, url, token, 3, 'tools/call', { name: readOnly.name, arguments: readOnly.arguments ?? {} }, sessionId)
    : undefined;
  const closed = await closeRecoveryMcpSession(transport, url, token, sessionId);
  return {
    mcp_initialize: { ok: initialized.ok, detail: initialized.detail },
    mcp_initialized_notification: { ok: acknowledged.ok, detail: acknowledged.detail },
    mcp_tools_list: { ok: toolListOk, detail: `${listed.detail}; count=${names.length}; fingerprint=${fingerprint}`, value: { count: names.length, fingerprint } },
    mcp_read_only_call: { ok: Boolean(called?.ok), detail: called?.detail ?? 'tools/list failed' },
    mcp_session_close: { ok: closed.ok, detail: closed.detail },
  };
}

export async function verifyStableRuntime(config: RecoveryConfig, transport = createRecoveryHttpTransport(config.controllerHome)): Promise<VerifyResult> {
  let state: SupervisorState | undefined;
  const probes: VerifyResult['probes'] = {};
  try { state = await supervisorStatus(config); probes.supervisor_socket = { ok: true, detail: 'status received' }; }
  catch (error) { probes.supervisor_socket = { ok: false, detail: error instanceof Error ? error.message : 'status failed' }; }
  const active = activeAuthorityRelease(config)
    ?? releaseEvidence(state?.gatewayHost?.releasePath)
    ?? releaseEvidence(state?.controllerDaemon?.releasePath)
    ?? currentSupervisorRelease(config);
  const previous = previousSupervisorRelease(config);
  const known = matchingKnownGood(config, active);
  const binding = runtimeBinding(config);
  probes.stable_ingress = await probe(transport, `${config.stableIngressUrl.replace(/\/$/, '')}/health`);
  if (binding) probes.active_gateway = await probe(transport, `http://${binding.gatewayHost}:${binding.gatewayPort}/health`);
  else probes.active_gateway = { ok: false, detail: 'canonical Runtime Gateway binding unavailable' };
  if (config.publicMcpUrl) probes.external_mcp_http = await probeExternalMcp(transport, config.publicMcpUrl);
  if (config.gateway) probes.recovery_gateway = await probe(transport, `http://${config.gateway.host}:${config.gateway.port}/health`);
  const recoveryPublicUrl = configuredRecoveryPublicUrl(config);
  if (recoveryPublicUrl) probes.recovery_external_http = await probeExternalMcp(transport, recoveryPublicUrl);
  Object.assign(probes, await probeMcp(config, transport));
  const coreChecks = Object.entries(probes)
    .filter(([name]) => !name.startsWith('recovery_') && name !== 'stable_ingress')
    .every(([, entry]) => entry.ok);
  const supervisorHealthy = state?.observedState === 'healthy';
  const coherent = Boolean(
    active
    && state?.gatewayHost?.releaseRevision === active.revision
    && state?.controllerDaemon?.releaseRevision === active.revision,
  );
  const ok = Boolean(coreChecks && supervisorHealthy && coherent);
  const result: VerifyResult = {
    ok, at: new Date().toISOString(),
    supervisor: { ok: supervisorHealthy, observedState: state?.observedState, activeSlot: state?.activeSlot, previousSlot: state?.previousSlot },
    releases: { active, previous, knownGood: known, coherent }, probes,
  };
  audit(config, 'verify', { ok, activeRevision: active?.revision, previousRevision: previous?.revision, coherent });
  return result;
}
/** Explicitly records evidence only after the full independent verification passed. */
export async function attestKnownGood(config: RecoveryConfig): Promise<ReleaseEvidence> {
  const locked = await withLock(config, { action: 'attest_known_good' }, async () => {
  const verified = await verifyStableRuntime(config);
  const binding = runtimeBinding(config);
  const active = verified.releases.active;
  if (
    !verified.ok
    || !active
    || !binding
    || binding.releaseRevision !== active.revision
    || binding.manifestHash !== active.manifestSha256
    || !binding.releasePath
    || binding.releasePath !== active.path
  ) {
    throw new Error('RECOVERY_KNOWN_GOOD_ATTESTATION_REQUIRES_FULL_VERIFY_AND_RUNTIME_BINDING');
  }
  const attested: ReleaseEvidence = {
    ...active,
    controllerHome: binding.controllerHome,
    configRevision: binding.configRevision,
    configHash: binding.configHash,
    runtimeGeneration: binding.runtimeGeneration,
    runtimeFencingTokenSha256: binding.runtimeFencingTokenSha256,
    attestedAt: new Date().toISOString(),
  };
  const store = knownGood(config);
  const releases = [attested, ...store.releases.filter((entry) => entry.path !== active.path)].slice(0, 8);
  writeJson(statePath(config), { schemaVersion: 1, releases, updatedAt: new Date().toISOString() } satisfies KnownGoodStore);
  audit(config, 'known_good_attested', {
    revision: active.revision,
    manifestSha256: active.manifestSha256,
    configRevision: binding.configRevision,
    configHash: binding.configHash,
    runtimeGeneration: binding.runtimeGeneration,
  });
  return attested;
  });
  if (!locked.acquired) throw new Error(recoveryBusyDetail(locked.owner));
  return locked.value;
}

function quarantine(config: RecoveryConfig, release: ReleaseEvidence | undefined, reason: string): void {
  if (!release) return;
  const current = json<{ schemaVersion: 1; releases: Array<ReleaseEvidence & { reason: string; at: string }> }>(quarantinePath(config)) ?? { schemaVersion: 1, releases: [] };
  const releases = [{ ...release, reason, at: new Date().toISOString() }, ...current.releases.filter((item) => item.path !== release.path)].slice(0, 32);
  writeJson(quarantinePath(config), { schemaVersion: 1, releases });
}

async function operation(
  config: RecoveryConfig,
  requestId: string,
  kind: string,
  reason: string,
  targetReleasePath?: string,
): Promise<{ operationId?: string; phase?: string; deduplicated?: boolean }> {
  const response = await control(config, {
    command: 'operation_submit',
    requestId,
    kind,
    actor: 'standalone-recovery',
    reason,
    ...(targetReleasePath ? { targetReleasePath } : {}),
  });
  if (response.ok !== true || !response.operation || typeof response.operation !== 'object') throw new Error('RECOVERY_OPERATION_REJECTED');
  const accepted = response.operation as { operationId?: unknown; phase?: unknown };
  return {
    operationId: typeof accepted.operationId === 'string' ? accepted.operationId : undefined,
    phase: typeof accepted.phase === 'string' ? accepted.phase : undefined,
    deduplicated: response.deduplicated === true,
  };
}

async function waitForOperation(config: RecoveryConfig, operationId: string): Promise<{ phase?: string; error?: string }> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await control(config, { command: 'operation_get', operationId });
    const operationValue = response.operation;
    if (operationValue && typeof operationValue === 'object') {
      const operationState = operationValue as { phase?: unknown; error?: unknown };
      const phase = typeof operationState.phase === 'string' ? operationState.phase : undefined;
      if (phase === 'succeeded' || phase === 'failed' || phase === 'locked_out') return { phase, error: typeof operationState.error === 'string' ? operationState.error : undefined };
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
  }
  return { phase: 'timeout', error: 'RECOVERY_OPERATION_TIMEOUT' };
}

export async function rollbackPrevious(config: RecoveryConfig, reason = 'standalone recovery'): Promise<RollbackResult> {
  const locked = await withLock(config, { action: 'rollback_previous' }, async () => {
    const before = await verifyStableRuntime(config);
    const active = before.releases.active;
    const knownActive = matchingKnownGood(config, active);
    if (knownActive) return { ok: true, noOp: true, detail: 'active release is already independently attested known-good', verify: before };
    const registeredPrevious = matchingKnownGood(config, before.releases.previous);
    const target = registeredPrevious ?? selectKnownGoodRelease(config, active);
    if (!active || !target) {
      audit(config, 'rollback_refused', {
        reason: 'no registered known-good release satisfies manifest, config, Controller Home, and writer-fencing evidence',
        activeRevision: active?.revision,
      });
      return {
        ok: false,
        detail: 'rollback refused: no registered known-good release passed manifest, config, Controller Home, and writer-fencing validation',
        verify: before,
      };
    }
    const requestId = `recovery-rollback:${active.revision}:${target.revision}:${target.manifestSha256.slice(0, 12)}`;
    const accepted = await operation(config, requestId, 'rollback', reason.slice(0, 500), target.path);
    if (!accepted.operationId) return { ok: false, detail: 'rollback operation did not return an operation id' };
    const completed = await waitForOperation(config, accepted.operationId);
    if (completed.phase !== 'succeeded') {
      quarantine(config, active, completed.error ?? completed.phase ?? 'rollback failed');
      audit(config, 'rollback_failed', {
        operationId: accepted.operationId,
        activeRevision: active.revision,
        targetRevision: target.revision,
        targetManifestSha256: target.manifestSha256,
        reason: completed.error ?? completed.phase,
      });
      return { ok: false, operationId: accepted.operationId, detail: completed.error ?? 'rollback did not succeed' };
    }
    const after = await verifyStableRuntime(config);
    if (!after.ok || after.releases.active?.revision !== target.revision || !matchingKnownGood(config, after.releases.active)) {
      quarantine(config, active, 'post-rollback verification failed');
      return { ok: false, operationId: accepted.operationId, detail: 'rollback completed but independent verification failed', verify: after };
    }
    quarantine(config, active, 'rollback completed');
    audit(config, 'rollback_succeeded', {
      operationId: accepted.operationId,
      activeRevision: active.revision,
      restoredRevision: target.revision,
      restoredManifestSha256: target.manifestSha256,
    });
    return { ok: true, operationId: accepted.operationId, detail: 'known-good release restored and independently verified', verify: after };
  });
  if (!locked.acquired) return { ok: false, noOp: true, detail: recoveryBusyDetail(locked.owner), verify: await verifyStableRuntime(config) };
  return locked.value;
}

export async function reconnectMain(config: RecoveryConfig): Promise<{ ok: boolean; detail: string; verify: VerifyResult }> {
  // A recovery connector must survive a main failure; this action is therefore
  // intentionally a bounded health/reconnect observation, never a rollout.
  const verified = await verifyStableRuntime(config);
  const publicProbe = verified.probes.external_mcp_http;
  const ok = verified.probes.active_gateway?.ok === true && (publicProbe?.ok === true || publicProbe?.status === 401);
  audit(config, 'reconnect_main', { ok, externalStatus: publicProbe?.status });
  return { ok, detail: ok ? 'canonical Runtime Gateway and primary endpoint are reachable; client session may refresh' : 'primary endpoint remains unavailable; recovery channel remains independent', verify: verified };
}

async function verifyLocalRuntime(config: RecoveryConfig): Promise<VerifyResult> {
  // Do not let an external tunnel outage masquerade as a local MCP failure.
  return verifyStableRuntime({ ...config, publicMcpUrl: undefined, recoveryPublicUrl: undefined });
}

function isExternalTunnelFailure(config: RecoveryConfig, verified: VerifyResult, localVerify: VerifyResult): boolean {
  const external = verified.probes.recovery_external_http ?? verified.probes.external_mcp_http;
  const localRecoveryGatewayHealthy = localVerify.probes.recovery_gateway?.ok ?? true;
  return Boolean(configuredRecoveryTunnel(config) && configuredRecoveryPublicUrl(config) && localVerify.ok && localRecoveryGatewayHealthy && external?.ok !== true);
}

export function decideWatchdog(input: {
  failures: number;
  firstFailureAt?: number;
  evidenceClasses: string[];
  activeKnownGood: boolean;
  previousKnownGood: boolean;
  operationInFlight: boolean;
  rollbackUsed: boolean;
  recoveryGatewayFailed?: boolean;
  gatewayFailed?: boolean;
  supervisorFailed?: boolean;
  recoveryGatewayRestartUsed?: boolean;
  gatewayRestartUsed?: boolean;
  supervisorRestartUsed?: boolean;
  publicTunnelConfigured?: boolean;
  publicTunnelFailed?: boolean;
  publicTunnelFailures?: number;
  publicTunnelFirstFailureAt?: number;
  publicTunnelRepairFailures?: number;
  publicTunnelMinimumFailures?: number;
  publicTunnelMinimumFailureDurationMs?: number;
}): WatchdogDecision {
  if (input.publicTunnelConfigured && input.publicTunnelFailed) {
    const failures = input.publicTunnelFailures ?? 0;
    const minimumFailures = input.publicTunnelMinimumFailures ?? 2;
    const minimumDuration = input.publicTunnelMinimumFailureDurationMs ?? 5_000;
    const sustained = input.publicTunnelFirstFailureAt !== undefined && Date.now() - input.publicTunnelFirstFailureAt >= minimumDuration;
    if (!input.operationInFlight && failures >= minimumFailures && sustained) return { action: 'repair_public_tunnel', reason: 'local runtime and Recovery Gateway are healthy while the dedicated Recovery public endpoint is unavailable' };
    if (input.operationInFlight) return { action: 'degraded', reason: 'Recovery tunnel repair deferred while a Supervisor operation owns runtime changes' };
    return { action: 'degraded', reason: 'Recovery tunnel failure has not yet met the bounded repair threshold' };
  }
  if (input.failures === 0) return { action: 'healthy', reason: 'all recovery probes healthy' };
  const restartSustained = input.firstFailureAt !== undefined && Date.now() - input.firstFailureAt >= 5_000;
  if (!input.operationInFlight && input.failures >= 2 && restartSustained) {
    if (input.recoveryGatewayFailed && !input.recoveryGatewayRestartUsed) return { action: 'restart_recovery_gateway', reason: 'the independent Recovery Gateway health endpoint failed after a sustained bounded failure window' };
    if (input.supervisorFailed && !input.supervisorRestartUsed) return { action: 'restart_supervisor', reason: 'Supervisor control is unavailable after a sustained bounded failure window' };
    if (input.gatewayFailed && !input.gatewayRestartUsed) return { action: 'restart_gateway', reason: 'active Gateway health failed after a sustained bounded failure window' };
  }
  const sustained = input.firstFailureAt !== undefined && Date.now() - input.firstFailureAt >= 30_000;
  const independentEvidence = new Set(input.evidenceClasses).size >= 2;
  if (input.failures >= 6 && sustained && independentEvidence && !input.activeKnownGood && input.previousKnownGood && !input.operationInFlight && !input.rollbackUsed) {
    return { action: 'rollback', reason: 'restart paths were exhausted and six sustained failures have two independent evidence classes plus a verified previous release' };
  }
  return { action: 'degraded', reason: 'failure threshold, duration, recovery ordering, or independent-evidence quorum not met' };
}

export async function diagnose(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const verified = await verifyStableRuntime(config);
  return { verified, knownGood: knownGood(config), quarantine: json(quarantinePath(config)) ?? { releases: [] } };
}

export async function listSlots(config: RecoveryConfig): Promise<Record<string, unknown>> {
  let state: SupervisorState | undefined;
  let controlAvailable = true;
  try { state = await supervisorStatus(config); }
  catch { controlAvailable = false; state = readSupervisorStateFile(config); }
  return {
    controlAvailable,
    activeSlot: state?.activeSlot,
    previousSlot: state?.previousSlot,
    active: activeAuthorityRelease(config) ?? currentSupervisorRelease(config),
    previous: previousSupervisorRelease(config),
    knownGood: knownGood(config).releases,
  };
}

export function recoveryReconnectOperation(verified: VerifyResult): 'none' | 'restart_gateway' {
  // MCP/session probe failures are never grounds for restarting the whole
  // runtime. Only an independently failed active-Gateway health probe can
  // select a bounded Gateway-only restart.
  if (!verified.probes.supervisor_socket?.ok) return 'none';
  if (verified.probes.active_gateway?.ok) return 'none';
  return 'restart_gateway';
}

function gatewayRestartLockedOut(verified: VerifyResult, state: SupervisorState | undefined): boolean {
  if (verified.supervisor.observedState === 'locked_out' || state?.observedState === 'locked_out') return true;
  return Object.values(state?.restartBudget ?? {}).some((entry) => entry.component === 'gatewayHost' && entry.lockedOut === true);
}

export async function restartGateway(config: RecoveryConfig, requestId?: string): Promise<{ ok: boolean; noOp?: boolean; operationId?: string; detail: string; verify: VerifyResult }> {
  const locked = await withLock(config, { action: 'restart_gateway', requestId }, async () => {
    const verified = await verifyStableRuntime(config);
    if (!verified.probes.supervisor_socket?.ok) {
      audit(config, 'restart_gateway_refused', { reason: 'supervisor_control_unavailable' });
      return { ok: false, noOp: true, detail: 'Gateway restart refused: Supervisor control is unavailable.', verify: verified };
    }
    if (verified.probes.active_gateway?.ok) {
      audit(config, 'restart_gateway_refused', { reason: 'active_gateway_healthy' });
      return { ok: true, noOp: true, detail: 'Gateway is already healthy; no Gateway restart performed.', verify: verified };
    }
    const state = await supervisorStatus(config);
    if (gatewayRestartLockedOut(verified, state)) {
      audit(config, 'restart_gateway_refused', { reason: 'gateway_restart_budget_locked_out', observedState: state.observedState });
      return { ok: false, noOp: true, detail: 'Gateway restart refused: Gateway restart budget is locked out; use restart_stable_supervisor.', verify: verified };
    }
    if (state.currentOperationId) return { ok: false, detail: 'Supervisor already has an operation in flight', verify: verified };
    const accepted = await operation(
      config,
      requestId ? `recovery-gateway:${requestId}` : `recovery-gateway:${Date.now()}`,
      'restart_gateway',
      'bounded standalone recovery Gateway restart after independent active-Gateway failure',
    );
    audit(config, 'restart_gateway_requested', { operationId: accepted.operationId });
    return {
      ok: Boolean(accepted.operationId),
      operationId: accepted.operationId,
      detail: accepted.operationId ? 'Gateway restart accepted' : 'Gateway restart rejected',
      verify: verified,
    };
  });
  if (!locked.acquired) return { ok: false, noOp: true, detail: recoveryBusyDetail(locked.owner), verify: await verifyStableRuntime(config) };
  return locked.value;
}

interface CommandResult { ok: boolean; status: number | null; stdout: string; stderr: string; }
type CommandRunner = (commandName: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
interface LaunchdService { uid: number; domain: string; target: string; label: string; plistPath: string; }

export interface PublicTunnelRepairDependencies {
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  verify?: (config: RecoveryConfig) => Promise<VerifyResult>;
  verifyLocal?: (config: RecoveryConfig) => Promise<VerifyResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function command(commandName: string, args: string[], timeoutMs = 10_000, options: { cwd?: string; maxOutputBytes?: number } = {}): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(commandName, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: options.cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveCommand(result);
    };
    const signalChild = (signalName: NodeJS.Signals) => {
      if (!child.pid || child.exitCode != null) return;
      try { process.kill(child.pid, signalName); } catch { /* Process already exited. */ }
    };
    const stop = () => {
      if (child.exitCode != null) return;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), 1_000);
    };
    const timeout = setTimeout(stop, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutputBytes) stdout.push(Buffer.from(chunk)); else stop();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutputBytes) stderr.push(Buffer.from(chunk)); else stop();
    });
    child.once('error', () => finish({ ok: false, status: null, stdout: '', stderr: 'command spawn failed' }));
    child.once('close', (status) => finish({ ok: status === 0, status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function currentUid(): Promise<number | undefined> {
  if (typeof process.getuid === 'function') return process.getuid();
  const result = await command('id', ['-u'], 2_000);
  const value = Number(result.stdout.trim());
  return result.ok && Number.isInteger(value) ? value : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function plistValue(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`<key>${escaped}</key>\\s*<string>([\\s\\S]*?)</string>`));
  return match ? decodeXml(match[1] ?? '') : undefined;
}

function generatedLaunchdPlist(config: RecoveryConfig): string | undefined {
  const root = join(resolve(config.controllerHome), 'supervisor', 'launchd');
  try {
    return readdirSync(root)
      .filter((name) => name.endsWith('.plist'))
      .sort()
      .map((name) => join(root, name))
      .find((candidate) => existsSync(candidate));
  } catch {
    return undefined;
  }
}

async function launchdService(config: RecoveryConfig): Promise<LaunchdService | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const uid = await currentUid();
  if (uid === undefined) return undefined;
  const activation = json<{
    serviceLabel?: unknown;
    plistPath?: unknown;
    service?: { plistPath?: unknown };
  }>(supervisorActivationPath(config));
  let label = typeof activation?.serviceLabel === 'string' ? activation.serviceLabel : undefined;
  let plistPath = typeof activation?.plistPath === 'string'
    ? activation.plistPath
    : typeof activation?.service?.plistPath === 'string'
      ? activation.service.plistPath
      : undefined;
  const generated = generatedLaunchdPlist(config);
  if (!plistPath && generated) plistPath = generated;
  if (!label && plistPath && existsSync(plistPath)) label = plistValue(readFileSync(plistPath, 'utf8'), 'Label');
  if (!label && generated && generated !== plistPath && existsSync(generated)) {
    label = plistValue(readFileSync(generated, 'utf8'), 'Label');
    if (!plistPath || !existsSync(plistPath)) plistPath = generated;
  }
  if (!plistPath && label) {
    const installed = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    plistPath = existsSync(installed) ? installed : generated;
  }
  if (!label || !plistPath) return undefined;
  return { uid, domain: `gui/${uid}`, target: `gui/${uid}/${label}`, label, plistPath };
}

async function ensureLaunchdServiceStarted(service: LaunchdService, runCommand: CommandRunner = command): Promise<{ ok: boolean; detail: string }> {
  const printed = await runCommand('launchctl', ['print', service.target], 5_000);
  if (!printed.ok) {
    if (!existsSync(service.plistPath)) return { ok: false, detail: `launchd plist is missing: ${service.plistPath}` };
    const bootstrapped = await runCommand('launchctl', ['bootstrap', service.domain, service.plistPath], 15_000);
    if (!bootstrapped.ok && !/already|in progress|Input\/output error/i.test(`${bootstrapped.stderr}\n${bootstrapped.stdout}`)) {
      return { ok: false, detail: `launchd bootstrap failed: ${bootstrapped.stderr || bootstrapped.stdout || bootstrapped.status}` };
    }
    await runCommand('launchctl', ['enable', service.target], 5_000);
  }
  const started = await runCommand('launchctl', ['kickstart', '-k', service.target], 15_000);
  if (!started.ok && !/already|in progress/i.test(`${started.stderr}\n${started.stdout}`)) {
    return { ok: false, detail: `launchd kickstart failed: ${started.stderr || started.stdout || started.status}` };
  }
  return { ok: true, detail: service.target };
}

function publicTunnelService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  const configured = configuredRecoveryTunnel(config);
  if (!configured || configured.platform !== 'launchd') return undefined;
  if (!/^com\.[A-Za-z0-9._-]{1,180}$/.test(configured.label)) return undefined;
  const plistPath = configured.plistPath;
  if (plistPath !== undefined && (!isAbsolute(plistPath) || !existsSync(plistPath))) return undefined;
  return {
    uid,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${configured.label}`,
    label: configured.label,
    plistPath: plistPath ?? join(homedir(), 'Library', 'LaunchAgents', `${configured.label}.plist`),
  };
}

function tunnelRepairAllowed(config: RecoveryConfig, now: number): boolean {
  const cooldownMs = configuredRecoveryTunnel(config)?.cooldownMs ?? 60_000;
  const prior = json<{ lastAttemptAt?: unknown }>(publicTunnelRepairStatePath(config));
  return typeof prior?.lastAttemptAt !== 'number' || now - prior.lastAttemptAt >= cooldownMs;
}

export async function repairPublicTunnel(config: RecoveryConfig, dependencies: PublicTunnelRepairDependencies = {}): Promise<PublicTunnelRepairResult> {
  const verify = dependencies.verify ?? verifyStableRuntime;
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const initial = await verify(config);
  const configured = configuredRecoveryTunnel(config);
  if (!configured) return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is not configured', verify: initial };
  const localVerify = await verifyLocal(config);
  if (!isExternalTunnelFailure(config, initial, localVerify)) {
    return { ok: (initial.probes.recovery_external_http ?? initial.probes.external_mcp_http)?.ok === true, attempted: false, noOp: true, detail: 'Recovery tunnel repair requires a healthy local runtime and failed Recovery external endpoint', verify: initial, localVerify };
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is only supported for explicitly configured launchd services', verify: initial, localVerify };
  }
  const supervisor = await bestEffortSupervisorState(config);
  if (supervisor?.currentOperationId) {
    return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair deferred while a Supervisor operation owns runtime changes', verify: initial, localVerify };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : publicTunnelService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'public tunnel launchd configuration is invalid or unavailable', verify: initial, localVerify };
  if (!tunnelRepairAllowed(config, now())) {
    return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair is in cooldown', serviceLabel: service.label, serviceTarget: service.target, verify: initial, localVerify };
  }
  const locked = await withLock(config, { action: 'repair_public_tunnel' }, async () => {
    // Recheck after acquiring ownership so a concurrent watchdog never causes a restart storm.
    const before = await verify(config);
    const localBefore = await verifyLocal(config);
    if (!isExternalTunnelFailure(config, before, localBefore)) {
      return { ok: (before.probes.recovery_external_http ?? before.probes.external_mcp_http)?.ok === true, attempted: false, noOp: true, detail: 'Recovery tunnel recovered before restart', serviceLabel: service.label, serviceTarget: service.target, verify: before, localVerify: localBefore };
    }
    const supervisorBeforeRestart = await bestEffortSupervisorState(config);
    if (supervisorBeforeRestart?.currentOperationId) {
      return { ok: false, attempted: false, noOp: true, detail: 'public tunnel repair deferred while a Supervisor operation owns runtime changes', serviceLabel: service.label, serviceTarget: service.target, verify: before, localVerify: localBefore };
    }
    writeJson(publicTunnelRepairStatePath(config), { lastAttemptAt: now(), serviceLabel: service.label });
    const started = await ensureLaunchdServiceStarted(service, dependencies.runCommand ?? command);
    if (!started.ok) {
      audit(config, 'public_tunnel_restart_failed', { serviceLabel: service.label, detail: started.detail });
      return { ok: false, attempted: true, detail: started.detail, serviceLabel: service.label, serviceTarget: service.target, verify: before, localVerify: localBefore };
    }
    const timeoutMs = configured.postRestartVerifyTimeoutMs ?? 20_000;
    const deadline = now() + timeoutMs;
    let after = before;
    while (now() < deadline) {
      await wait(1_000);
      after = await verify(config);
      if ((after.probes.recovery_external_http ?? after.probes.external_mcp_http)?.ok === true) {
        audit(config, 'public_tunnel_restart_succeeded', { serviceLabel: service.label, serviceTarget: service.target });
        return { ok: true, attempted: true, detail: 'public tunnel service restarted and external endpoint verified', serviceLabel: service.label, serviceTarget: service.target, verify: after, localVerify: await verifyLocal(config) };
      }
    }
    audit(config, 'public_tunnel_restart_unverified', { serviceLabel: service.label, serviceTarget: service.target });
    return { ok: false, attempted: true, detail: 'public tunnel service restarted but external endpoint did not recover before timeout', serviceLabel: service.label, serviceTarget: service.target, verify: after, localVerify: await verifyLocal(config) };
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceLabel: service.label, serviceTarget: service.target, verify: initial, localVerify };
  return locked.value;
}


export interface RecoveryGatewayRestartResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
}

export interface RecoveryGatewayRestartDependencies {
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  probeGateway?: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function recoveryGatewayLaunchdService(config: RecoveryConfig, uid: number): LaunchdService {
  const label = 'com.moretea.repo-harness-recovery-gateway';
  const generated = join(recoveryRoot(config), 'launchd', `${label}.plist`);
  const installed = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  return {
    uid,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
    label,
    plistPath: existsSync(installed) ? installed : generated,
  };
}

async function probeRecoveryGateway(config: RecoveryConfig): Promise<{ ok: boolean; detail: string }> {
  if (!config.gateway) return { ok: false, detail: 'Recovery Gateway is not configured' };
  return probe(createRecoveryHttpTransport(config.controllerHome), `http://${config.gateway.host}:${config.gateway.port}/health`);
}

export async function restartRecoveryGateway(
  config: RecoveryConfig,
  dependencies: RecoveryGatewayRestartDependencies = {},
): Promise<RecoveryGatewayRestartResult> {
  if (!config.gateway) return { ok: false, attempted: false, noOp: true, detail: 'Recovery Gateway is not configured' };
  if ((dependencies.platform ?? process.platform) !== 'darwin') return { ok: false, attempted: false, noOp: true, detail: 'Recovery Gateway launchd restart is only supported on macOS' };
  const check = dependencies.probeGateway ?? probeRecoveryGateway;
  const initial = await check(config);
  if (initial.ok) return { ok: true, attempted: false, noOp: true, detail: 'Recovery Gateway is already healthy' };
  const uid = await (dependencies.currentUid ?? currentUid)();
  if (uid === undefined) return { ok: false, attempted: false, noOp: true, detail: 'Recovery Gateway launchd UID is unavailable' };
  const service = recoveryGatewayLaunchdService(config, uid);
  if (!existsSync(service.plistPath)) return { ok: false, attempted: false, noOp: true, detail: `Recovery Gateway launchd plist is missing: ${service.plistPath}`, serviceTarget: service.target };
  const locked = await withLock(config, { action: 'restart_recovery_gateway' }, async () => {
    const before = await check(config);
    if (before.ok) return { ok: true, attempted: false, noOp: true, detail: 'Recovery Gateway recovered before restart', serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
    const started = await ensureLaunchdServiceStarted(service, dependencies.runCommand ?? command);
    if (!started.ok) {
      audit(config, 'recovery_gateway_restart_failed', { serviceTarget: service.target, detail: started.detail });
      return { ok: false, attempted: true, detail: started.detail, serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
    }
    const now = dependencies.now ?? Date.now;
    const wait = dependencies.sleep ?? sleep;
    const deadline = now() + 20_000;
    let observed = before;
    while (now() < deadline) {
      await wait(1_000);
      observed = await check(config);
      if (observed.ok) {
        audit(config, 'recovery_gateway_restart_succeeded', { serviceTarget: service.target });
        return { ok: true, attempted: true, detail: 'Recovery Gateway restarted and its local health endpoint recovered', serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
      }
    }
    audit(config, 'recovery_gateway_restart_unverified', { serviceTarget: service.target, detail: observed.detail });
    return { ok: false, attempted: true, detail: 'Recovery Gateway restarted but did not pass local health verification before timeout', serviceTarget: service.target } satisfies RecoveryGatewayRestartResult;
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target };
  return locked.value;
}

function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function supervisorPid(state: SupervisorState | undefined): number | undefined {
  return Number.isInteger(state?.supervisor?.pid) ? state!.supervisor!.pid : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function bestEffortSupervisorState(config: RecoveryConfig): Promise<SupervisorState | undefined> {
  try { return await supervisorStatus(config); } catch { return readSupervisorStateFile(config); }
}

async function waitForSupervisorControl(config: RecoveryConfig, previousPid: number | undefined, expectedRevision: string | undefined): Promise<{ ok: boolean; pid?: number; detail: string }> {
  const deadline = Date.now() + 120_000;
  let lastDetail = 'Supervisor control did not become available';
  while (Date.now() < deadline) {
    try {
      const state = await supervisorStatus(config);
      const pid = supervisorPid(state);
      const revision = state.supervisor?.releaseRevision;
      const changed = previousPid === undefined || pid !== previousPid;
      const revisionMatches = expectedRevision === undefined || revision === expectedRevision;
      if (pid && changed && revisionMatches) return { ok: true, pid, detail: 'Supervisor control is available after launchd restart' };
      lastDetail = `pid=${pid ?? 'missing'} revision=${revision ?? 'missing'} changed=${changed} revisionMatches=${revisionMatches}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : 'Supervisor control unavailable';
    }
    await sleep(1_000);
  }
  return { ok: false, detail: lastDetail };
}

function localRuntimeHealthyForSupervisorRestart(verified: VerifyResult, state: SupervisorState | undefined): boolean {
  return Boolean(
    state?.observedState === 'healthy'
    && verified.supervisor.ok
    && verified.releases.coherent
    && state?.supervisor?.releaseRevision === verified.releases.active?.revision
    && releaseEvidence(state?.supervisor?.releasePath)?.path === verified.releases.active?.path
    && verified.probes.supervisor_socket?.ok
    && verified.probes.active_gateway?.ok,
  );
}

function normalizedRecoveryRequestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(value)) throw new Error('RECOVERY_REQUEST_ID_INVALID');
  return value;
}

function restartReceipt(config: RecoveryConfig, requestId: string): RestartSupervisorReceipt | undefined {
  const receipt = json<RestartSupervisorReceipt>(recoveryRequestPath(config, 'restart_supervisor', requestId));
  return receipt?.schemaVersion === 1 && receipt.action === 'restart_supervisor' && receipt.requestId === requestId ? receipt : undefined;
}

function writeRestartReceipt(config: RecoveryConfig, receipt: RestartSupervisorReceipt): void {
  writeJson(recoveryRequestPath(config, 'restart_supervisor', receipt.requestId), receipt);
}

async function waitForSupervisorLocalHealth(config: RecoveryConfig, expectedRevision: string): Promise<{ ok: boolean; verify: VerifyResult }> {
  const deadline = Date.now() + 120_000;
  let verified = await verifyLocalRuntime(config);
  while (Date.now() < deadline) {
    const state = await bestEffortSupervisorState(config);
    if (verified.releases.active?.revision === expectedRevision && localRuntimeHealthyForSupervisorRestart(verified, state)) return { ok: true, verify: verified };
    await sleep(2_000);
    verified = await verifyLocalRuntime(config);
  }
  return { ok: false, verify: verified };
}

async function performSupervisorRestart(config: RecoveryConfig, requestId?: string): Promise<RestartSupervisorResult> {
  const verified = await verifyStableRuntime(config);
  const state = await bestEffortSupervisorState(config);
  const beforePid = supervisorPid(state);
  if (localRuntimeHealthyForSupervisorRestart(verified, state)) {
    audit(config, 'restart_supervisor_noop', { reason: 'local_runtime_healthy', requestId, beforePid });
    return { ok: true, noOp: true, beforePid, detail: 'Local Supervisor, ingress, Gateway, and release identity are already healthy; no restart performed.', verify: verified };
  }
  if (state?.currentOperationId) return { ok: false, noOp: true, beforePid, detail: `Supervisor operation ${state.currentOperationId} is already in progress.`, verify: verified };
  const activeRelease = verified.releases.active ?? currentSupervisorRelease(config);
  if (!activeRelease) return { ok: false, detail: 'Supervisor restart refused: active immutable release evidence is unavailable.', verify: verified };
  if (verified.probes.supervisor_socket?.ok !== true && pidAlive(beforePid)) return { ok: false, detail: `Supervisor restart refused: PID ${beforePid} is alive but control socket is unavailable.`, verify: verified };
  const service = await launchdService(config);
  if (!service) return { ok: false, detail: 'Supervisor restart refused: registered launchd service metadata is unavailable.', verify: verified };
  if (verified.probes.supervisor_socket?.ok === true) {
    try { await control(config, { command: 'handoff' }, 10_000); } catch { /* launchd remains the bounded owner */ }
    await sleep(500);
  }
  const started = await ensureLaunchdServiceStarted(service);
  if (!started.ok) return { ok: false, beforePid, detail: started.detail, verify: verified };
  const after = await waitForSupervisorControl(config, beforePid, activeRelease.revision);
  if (!after.ok || !after.pid) return { ok: false, beforePid, detail: after.detail, verify: verified };
  const stabilized = await waitForSupervisorLocalHealth(config, activeRelease.revision);
  if (!stabilized.ok) return { ok: false, beforePid, afterPid: after.pid, detail: 'Supervisor restarted but the local managed runtime did not stabilize before timeout.', verify: stabilized.verify };
  audit(config, 'restart_supervisor_succeeded', { beforePid, afterPid: after.pid, requestId, target: service.target, releaseRevision: activeRelease.revision });
  return { ok: true, beforePid, afterPid: after.pid, detail: `Stable Supervisor restarted via launchd (${service.target}) at release ${activeRelease.revision} and the local managed runtime stabilized.`, verify: stabilized.verify };
}

export async function restartSupervisor(config: RecoveryConfig, requestId?: string): Promise<RestartSupervisorResult> {
  const normalized = normalizedRecoveryRequestId(requestId);
  const prior = normalized ? restartReceipt(config, normalized) : undefined;
  if (prior?.result && prior.status !== 'running') return { ...prior.result, reused: true };
  const locked = await withLock(config, { action: 'restart_supervisor', requestId: normalized }, async (owner) => {
    const current = normalized ? restartReceipt(config, normalized) : undefined;
    if (current?.result && current.status !== 'running') return { ...current.result, reused: true };
    if (normalized && current?.status === 'running') {
      const verify = await verifyStableRuntime(config);
      const interrupted: RestartSupervisorResult = { ok: false, noOp: true, detail: 'The prior restart request lost its owner before recording a terminal result; automatic replay is blocked.', verify };
      writeRestartReceipt(config, { ...current, status: 'interrupted', result: interrupted, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return interrupted;
    }
    const startedAt = new Date().toISOString();
    if (normalized) writeRestartReceipt(config, { schemaVersion: 1, action: 'restart_supervisor', requestId: normalized, status: 'running', ownerInstanceId: owner.instanceId, startedAt, updatedAt: startedAt });
    const result = await performSupervisorRestart(config, normalized);
    if (normalized) writeRestartReceipt(config, { schemaVersion: 1, action: 'restart_supervisor', requestId: normalized, status: result.ok ? 'succeeded' : 'failed', ownerInstanceId: owner.instanceId, startedAt, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), result });
    return result;
  });
  if (locked.acquired) return locked.value;
  const completed = normalized ? restartReceipt(config, normalized) : undefined;
  if (completed?.result && completed.status !== 'running') return { ...completed.result, reused: true };
  return { ok: false, noOp: true, inProgress: true, activeAction: locked.owner.action, activeRequestId: locked.owner.requestId, detail: recoveryBusyDetail(locked.owner), verify: await verifyStableRuntime(config) };
}

export function gatewayToken(config: RecoveryConfig): string | undefined {
  const file = config.gateway?.bearerTokenFile;
  const parsed = file ? json<{ token?: unknown; expiresAt?: unknown }>(file) : undefined;
  if (typeof parsed?.expiresAt === 'string' && Date.parse(parsed.expiresAt) <= Date.now()) return undefined;
  return typeof parsed?.token === 'string' && parsed.token.length >= 32 ? parsed.token : undefined;
}

export function initializeStandaloneRecovery(
  controllerHome: string,
  port = 8787,
  publicTunnelService?: PublicTunnelServiceConfig,
  extensions: Partial<Pick<RecoveryConfig, 'publicMcpUrl' | 'recoveryPublicUrl' | 'recoveryTunnelService'>> = {},
): RecoveryConfig {
  const root = resolve(controllerHome);
  const tokenPath = join(root, 'recovery', 'config', 'gateway-token.json');
  if (!existsSync(tokenPath)) {
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, `${JSON.stringify({ token: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    try { chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
  }
  return createRecoveryConfig(root, {
    gateway: { host: '127.0.0.1', port, bearerTokenFile: tokenPath },
    ...(publicTunnelService ? { publicTunnelService } : {}),
    ...extensions,
  });
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function watchdogTick(config: RecoveryConfig, prior: WatchdogState): Promise<{ state: WatchdogState; decision: WatchdogDecision; verify: VerifyResult; rollback?: RollbackResult; publicTunnelRepair?: PublicTunnelRepairResult; recoveryGatewayRestart?: RecoveryGatewayRestartResult; gatewayRestart?: Awaited<ReturnType<typeof restartGateway>>; supervisorRestart?: RestartSupervisorResult }> {
  const verified = await verifyStableRuntime(config);
  const recoveryHealthy = verified.probes.recovery_gateway?.ok !== false
    && verified.probes.recovery_external_http?.ok !== false;
  if (verified.ok && recoveryHealthy) {
    const state = { failures: 0, rollbackUsed: false, publicTunnelFailures: 0, publicTunnelRepairFailures: 0, recoveryGatewayRestartUsed: false, gatewayRestartUsed: false, supervisorRestartUsed: false, lastDecision: 'healthy' as const };
    return { state, decision: { action: 'healthy', reason: 'primary runtime and standalone Recovery verification passed' }, verify: verified };
  }
  const localVerify = configuredRecoveryTunnel(config) && configuredRecoveryPublicUrl(config) ? await verifyLocalRuntime(config) : undefined;
  const publicTunnelFailed = localVerify ? isExternalTunnelFailure(config, verified, localVerify) : false;
  const evidenceClasses = Object.entries(verified.probes)
    .filter(([name, value]) => !name.startsWith('recovery_') && !value.ok)
    .map(([name]) => name.startsWith('external') ? 'external' : name.startsWith('mcp') ? 'mcp' : name.startsWith('active') ? 'gateway' : name);
  const activeKnownGood = Boolean(matchingKnownGood(config, verified.releases.active));
  const previousKnownGood = Boolean(matchingKnownGood(config, verified.releases.previous));
  const state: WatchdogState = publicTunnelFailed
    ? {
      ...prior,
      failures: prior.failures + 1,
      firstFailureAt: prior.firstFailureAt ?? Date.now(),
      publicTunnelFailures: (prior.publicTunnelFailures ?? 0) + 1,
      publicTunnelFirstFailureAt: prior.publicTunnelFirstFailureAt ?? Date.now(),
    }
    : {
      ...prior,
      failures: prior.failures + 1,
      firstFailureAt: prior.firstFailureAt ?? Date.now(),
      publicTunnelFailures: 0,
      publicTunnelFirstFailureAt: undefined,
    };
  let operationInFlight = false;
  try { operationInFlight = Boolean((await supervisorStatus(config)).currentOperationId); } catch { operationInFlight = false; }
  const decision = decideWatchdog({
    ...state,
    evidenceClasses,
    activeKnownGood,
    previousKnownGood,
    operationInFlight,
    recoveryGatewayFailed: verified.probes.recovery_gateway?.ok === false,
    gatewayFailed: verified.probes.supervisor_socket?.ok === true && verified.probes.active_gateway?.ok !== true,
    supervisorFailed: verified.probes.supervisor_socket?.ok !== true,
    publicTunnelConfigured: Boolean(configuredRecoveryTunnel(config)),
    publicTunnelFailed,
    publicTunnelMinimumFailures: configuredRecoveryTunnel(config)?.minimumFailures,
    publicTunnelMinimumFailureDurationMs: configuredRecoveryTunnel(config)?.minimumFailureDurationMs,
  });
  state.lastDecision = decision.action;
  if (decision.action === 'repair_public_tunnel') {
    const publicTunnelRepair = await repairPublicTunnel(config);
    const nextState = publicTunnelRepair.ok
      ? { ...state, failures: 0, publicTunnelFailures: 0, publicTunnelRepairFailures: 0, firstFailureAt: undefined, publicTunnelFirstFailureAt: undefined }
      : { ...state, publicTunnelRepairFailures: (state.publicTunnelRepairFailures ?? 0) + 1 };
    return { state: nextState, decision, verify: verified, publicTunnelRepair };
  }
  if (decision.action === 'restart_recovery_gateway') {
    const recoveryGatewayRestart = await restartRecoveryGateway(config);
    return { state: { ...state, recoveryGatewayRestartUsed: true }, decision, verify: verified, recoveryGatewayRestart };
  }
  if (decision.action === 'restart_gateway') {
    const gatewayRestart = await restartGateway(config, `watchdog-gateway-${verified.releases.active?.revision ?? 'unknown'}`);
    return { state: { ...state, gatewayRestartUsed: true }, decision, verify: verified, gatewayRestart };
  }
  if (decision.action === 'restart_supervisor') {
    const supervisorRestart = await restartSupervisor(config, `watchdog-supervisor-${verified.releases.active?.revision ?? 'unknown'}`);
    return { state: { ...state, supervisorRestartUsed: true }, decision, verify: verified, supervisorRestart };
  }
  if (decision.action === 'rollback') {
    const rollback = await rollbackPrevious(config, 'watchdog sustained multi-signal failure after bounded restart paths');
    return { state: { ...state, rollbackUsed: true }, decision, verify: verified, rollback };
  }
  return { state, decision, verify: verified };
}
