import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { observeRuntimeStatus } from '../root/status';
import { forgeRuntimeServicePaths } from '../root/service';
import { loadRuntimeReleaseManifest } from '../root/release-manifest';
import { assertRuntimeReleaseFiles, stageRuntimeRelease, type StagedRuntimeRelease } from '../root/release-materialize';
import {
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
  rollbackRuntimeRelease,
  type RuntimePublishedRelease,
  type RuntimeReleaseAuthority,
} from '../root/release-store';
import type { RuntimeReleaseManifest } from '../root/types';
import { createRecoveryHttpTransport, type RecoveryHttpTransport } from './http-transport';

/** Standalone recovery reads only canonical Runtime observation and whole-release authority. */
export interface PublicTunnelServiceConfig {
  platform: 'launchd';
  label: string;
  plistPath?: string;
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  cooldownMs?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface PrimaryRuntimeServiceConfig {
  platform: 'launchd';
  minimumFailures?: number;
  minimumFailureDurationMs?: number;
  restartCooldownMs?: number;
  maximumRestartAttempts?: number;
  recoveryCooldownMs?: number;
  postRestartVerifyTimeoutMs?: number;
}

export interface PrimaryConnectorServiceConfig {
  platform: 'launchd';
  label: string;
  plistPath?: string;
  postRestartVerifyTimeoutMs?: number;
}

export interface RecoveryConfig {
  schemaVersion: 1;
  controllerHome: string;
  publicMcpUrl?: string;
  recoveryPublicUrl?: string;
  recoveryTunnelService?: PublicTunnelServiceConfig;
  primaryRuntimeService?: PrimaryRuntimeServiceConfig;
  primaryRuntimeSourceRoot?: string;
  primaryConnectorService?: PrimaryConnectorServiceConfig;
  mainMcpTokenFile?: string;
  expectedToolFingerprint?: string;
  readOnlyTool?: { name: string; arguments?: Record<string, unknown> };
  gateway?: { host: string; port: number; bearerTokenFile: string };
}

interface ReleaseEvidence {
  path: string;
  revision: string;
  artifactIdentity: string;
  manifestSha256: string;
  workerProtocolVersion: number;
  controllerHome?: string;
  releaseAuthorityRevision?: number;
  releaseFencingTokenSha256?: string;
  attestedAt?: string;
}

interface KnownGoodStore {
  schemaVersion: 1;
  releases: ReleaseEvidence[];
  updatedAt: string;
}

export type RecoveryMutationAction =
  | 'attest_known_good'
  | 'rollback_previous'
  | 'restart_primary_runtime'
  | 'recover_primary_runtime'
  | 'activate_runtime_release'
  | 'stage_and_activate_runtime_release'
  | 'restart_primary_connector'
  | 'restart_recovery_gateway'
  | 'repair_public_tunnel';

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
  runtime: { ok: boolean; running: boolean; ready: boolean; stale: boolean; reasonCodes: string[] };
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

export interface WatchdogDecision {
  action: 'healthy' | 'degraded' | 'repair_public_tunnel' | 'restart_recovery_gateway' | 'restart_primary_runtime' | 'rollback';
  reason: string;
}

export interface WatchdogState {
  failures: number;
  firstFailureAt?: number;
  rollbackUsed: boolean;
  runtimeRestartAttempts?: number;
  runtimeRestartFailures?: number;
  runtimeRestartLastAttemptAt?: number;
  runtimeRecoveryFailures?: number;
  runtimeRecoveryLastAttemptAt?: number;
  publicTunnelFailures?: number;
  publicTunnelFirstFailureAt?: number;
  publicTunnelRepairFailures?: number;
  recoveryGatewayRestartUsed?: boolean;
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

export interface PrimaryRuntimeRestartResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  verify: VerifyResult;
}

export interface PrimaryConnectorRestartResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  verify: VerifyResult;
}

export interface ConfiguredRuntimeActivationResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  staged?: StagedRuntimeRelease;
  activation?: RuntimeReleaseActivationResult;
}

export interface PrimaryRuntimeRecoveryResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  rollback?: RollbackResult;
  verify: VerifyResult;
}

export interface RuntimeReleaseActivationResult {
  ok: boolean;
  attempted: boolean;
  noOp?: boolean;
  detail: string;
  serviceTarget?: string;
  operationId?: string;
  rollback?: RollbackResult;
  verify?: VerifyResult;
}

const DEFAULT_CONFIG: Omit<RecoveryConfig, 'controllerHome'> = {
  schemaVersion: 1,
  readOnlyTool: { name: 'controller_context' },
  primaryRuntimeService: { platform: 'launchd' },
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
  return config.recoveryTunnelService;
}

function configuredRecoveryPublicUrl(config: RecoveryConfig): string | undefined {
  return config.recoveryPublicUrl;
}

export const STANDALONE_RECOVERY_REQUIRED_RELEASE_FILES = [
  'manifest.json',
  'forge-runtime.mjs',
] as const;

export function recoveryConfigPath(controllerHome: string): string {
  return join(resolve(controllerHome), 'recovery', 'config', 'recovery.json');
}

export function loadRecoveryConfig(controllerHome: string, explicit?: string): RecoveryConfig {
  const loaded = json<Partial<RecoveryConfig> & Record<string, unknown>>(explicit ?? recoveryConfigPath(controllerHome)) ?? {};
  const config: RecoveryConfig = {
    ...DEFAULT_CONFIG,
    schemaVersion: 1,
    controllerHome: resolve(typeof loaded.controllerHome === 'string' ? loaded.controllerHome : controllerHome),
    ...(typeof loaded.publicMcpUrl === 'string' ? { publicMcpUrl: loaded.publicMcpUrl } : {}),
    ...(typeof loaded.recoveryPublicUrl === 'string' ? { recoveryPublicUrl: loaded.recoveryPublicUrl } : {}),
    ...(loaded.recoveryTunnelService ? { recoveryTunnelService: loaded.recoveryTunnelService } : {}),
    ...(loaded.primaryRuntimeService ? { primaryRuntimeService: loaded.primaryRuntimeService } : {}),
    ...(typeof loaded.primaryRuntimeSourceRoot === 'string' ? { primaryRuntimeSourceRoot: resolve(loaded.primaryRuntimeSourceRoot) } : {}),
    ...(loaded.primaryConnectorService ? { primaryConnectorService: loaded.primaryConnectorService } : {}),
    ...(typeof loaded.mainMcpTokenFile === 'string' ? { mainMcpTokenFile: loaded.mainMcpTokenFile } : {}),
    ...(typeof loaded.expectedToolFingerprint === 'string' ? { expectedToolFingerprint: loaded.expectedToolFingerprint } : {}),
    ...(loaded.readOnlyTool ? { readOnlyTool: loaded.readOnlyTool } : {}),
    ...(loaded.gateway ? { gateway: loaded.gateway } : {}),
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

function releaseEvidence(
  controllerHome: string,
  release: RuntimePublishedRelease | undefined,
  authority: RuntimeReleaseAuthority | undefined,
): ReleaseEvidence | undefined {
  if (!release || !authority) return undefined;
  return {
    path: release.manifestPath,
    revision: release.releaseId,
    artifactIdentity: release.artifactIdentity,
    manifestSha256: release.manifestSha256,
    workerProtocolVersion: release.workerProtocolVersion,
    controllerHome: resolve(controllerHome),
    releaseAuthorityRevision: authority.revision,
    releaseFencingTokenSha256: createHash('sha256').update(authority.fencingToken).digest('hex'),
  };
}

function releaseAuthority(config: RecoveryConfig): RuntimeReleaseAuthority | undefined {
  return readRuntimeReleaseAuthority(config.controllerHome);
}

function activeAuthorityRelease(config: RecoveryConfig): ReleaseEvidence | undefined {
  const authority = releaseAuthority(config);
  return releaseEvidence(config.controllerHome, authority?.active, authority);
}

function previousAuthorityRelease(config: RecoveryConfig): ReleaseEvidence | undefined {
  const authority = releaseAuthority(config);
  return releaseEvidence(config.controllerHome, authority?.previous, authority);
}

function knownGoodEvidence(config: RecoveryConfig, entry: ReleaseEvidence | undefined): ReleaseEvidence | undefined {
  if (!entry || !entry.attestedAt || !entry.releaseFencingTokenSha256 || typeof entry.controllerHome !== 'string') return undefined;
  if (resolve(entry.controllerHome) !== resolve(config.controllerHome)) return undefined;
  const authority = releaseAuthority(config);
  const candidates = [
    releaseEvidence(config.controllerHome, authority?.active, authority),
    releaseEvidence(config.controllerHome, authority?.previous, authority),
  ].filter((item): item is ReleaseEvidence => Boolean(item));
  const matched = candidates.find((release) =>
    release.path === entry.path
    && release.revision === entry.revision
    && release.artifactIdentity === entry.artifactIdentity
    && release.manifestSha256 === entry.manifestSha256
    && release.workerProtocolVersion === entry.workerProtocolVersion,
  );
  return matched ? entry : undefined;
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

export async function runtimeStatus(config: RecoveryConfig) {
  return observeRuntimeStatus(config.controllerHome);
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
    // The MCP transport is POST-based. A GET on the MCP path returns 404 on
    // some gateway implementations, so probe with an initialize request and
    // accept the unauthenticated OAuth Bearer challenge.
    const response = await transport.request({
      url,
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'forge-standalone-recovery', version: '1' } },
      }),
      timeoutMs: 4_000,
      signal: controller.signal,
    });
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

function runtimeEndpoint(config: RecoveryConfig): string | undefined {
  return observeRuntimeStatus(config.controllerHome).snapshot?.endpoint;
}

function runtimeHealthEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  // The canonical Runtime serves the whole-Runtime readiness probe at /ready.
  url.pathname = '/ready';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function probeMcp(config: RecoveryConfig, transport: RecoveryHttpTransport): Promise<Record<string, { ok: boolean; detail: string; value?: unknown }>> {
  const url = config.publicMcpUrl ?? runtimeEndpoint(config);
  if (!url) return { mcp_initialize: { ok: false, detail: 'canonical Runtime MCP endpoint is unavailable' } };
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
  const observation = observeRuntimeStatus(config.controllerHome);
  const authority = releaseAuthority(config);
  const active = activeAuthorityRelease(config);
  const previous = previousAuthorityRelease(config);
  const known = matchingKnownGood(config, active);
  const probes: VerifyResult['probes'] = {
    runtime_status: {
      ok: observation.running && !observation.stale,
      detail: observation.running
        ? observation.stale ? 'canonical Runtime status is stale' : 'canonical Runtime owner is live'
        : 'canonical Runtime is not running',
    },
  };
  const endpoint = observation.snapshot?.endpoint;
  probes.active_gateway = endpoint
    ? await probe(transport, runtimeHealthEndpoint(endpoint))
    : { ok: false, detail: 'canonical Runtime endpoint is unavailable' };
  if (config.publicMcpUrl) probes.external_mcp_http = await probeExternalMcp(transport, config.publicMcpUrl);
  if (config.gateway) probes.recovery_gateway = await probe(transport, `http://${config.gateway.host}:${config.gateway.port}/health`);
  const recoveryPublicUrl = configuredRecoveryPublicUrl(config);
  if (recoveryPublicUrl) probes.recovery_external_http = await probeExternalMcp(transport, recoveryPublicUrl);
  Object.assign(probes, await probeMcp(config, transport));
  const coreChecks = Object.entries(probes)
    .filter(([name]) => !name.startsWith('recovery_'))
    .every(([, entry]) => entry.ok);
  const runtimeHealthy = observation.running && observation.ready && !observation.stale;
  const coherent = Boolean(
    authority
    && active
    && observation.snapshot?.releaseId === active.revision
    && observation.snapshot?.artifactIdentity === active.artifactIdentity
    && authority.active.workerProtocolVersion === active.workerProtocolVersion,
  );
  const ok = Boolean(coreChecks && runtimeHealthy && coherent);
  const result: VerifyResult = {
    ok,
    at: new Date().toISOString(),
    runtime: {
      ok: runtimeHealthy,
      running: observation.running,
      ready: observation.ready,
      stale: observation.stale,
      reasonCodes: [...observation.reasonCodes],
    },
    releases: { active, previous, knownGood: known, coherent },
    probes,
  };
  audit(config, 'verify', { ok, activeRevision: active?.revision, previousRevision: previous?.revision, coherent });
  return result;
}
/** Explicitly records evidence only after the full independent verification passed. */
export async function attestKnownGood(config: RecoveryConfig): Promise<ReleaseEvidence> {
  const locked = await withLock(config, { action: 'attest_known_good' }, async () => {
    const verified = await verifyStableRuntime(config);
    const authority = releaseAuthority(config);
    const active = verified.releases.active;
    if (
      !verified.ok
      || !authority
      || !active
      || authority.active.releaseId !== active.revision
      || authority.active.artifactIdentity !== active.artifactIdentity
      || authority.active.manifestSha256 !== active.manifestSha256
      || authority.active.workerProtocolVersion !== active.workerProtocolVersion
    ) {
      throw new Error('RECOVERY_KNOWN_GOOD_ATTESTATION_REQUIRES_FULL_VERIFY_AND_RELEASE_AUTHORITY');
    }
    const attested: ReleaseEvidence = {
      ...active,
      controllerHome: resolve(config.controllerHome),
      releaseAuthorityRevision: authority.revision,
      releaseFencingTokenSha256: createHash('sha256').update(authority.fencingToken).digest('hex'),
      attestedAt: new Date().toISOString(),
    };
    const store = knownGood(config);
    const releases = [attested, ...store.releases.filter((entry) => entry.path !== active.path)].slice(0, 8);
    writeJson(statePath(config), { schemaVersion: 1, releases, updatedAt: new Date().toISOString() } satisfies KnownGoodStore);
    audit(config, 'known_good_attested', {
      revision: active.revision,
      artifactIdentity: active.artifactIdentity,
      manifestSha256: active.manifestSha256,
      releaseAuthorityRevision: authority.revision,
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

async function rollbackPreviousLocked(config: RecoveryConfig, reason: string): Promise<RollbackResult> {
  const before = await verifyStableRuntime(config);
  const active = before.releases.active;
  if (matchingKnownGood(config, active)) {
    return { ok: true, noOp: true, detail: 'active whole-Runtime release is already independently attested known-good', verify: before };
  }
  if (before.runtime.running) {
    return {
      ok: false,
      noOp: true,
      detail: 'rollback refused: stop the complete Canonical Runtime before restoring its release and SQLite backup',
      verify: before,
    };
  }
  const target = matchingKnownGood(config, before.releases.previous);
  if (!active || !target) {
    audit(config, 'rollback_refused', {
      reason: 'the atomic previous whole-Runtime release is not independently attested known-good',
      activeRevision: active?.revision,
    });
    return {
      ok: false,
      detail: 'rollback refused: no attested previous whole-Runtime release with a bound SQLite backup is available',
      verify: before,
    };
  }
  const operationId = `recovery-rollback-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    const committed = rollbackRuntimeRelease(config.controllerHome, operationId);
    if (
      committed.active.releaseId !== target.revision
      || committed.active.artifactIdentity !== target.artifactIdentity
      || committed.active.manifestSha256 !== target.manifestSha256
    ) throw new Error('RECOVERY_ROLLBACK_AUTHORITY_MISMATCH');
    quarantine(config, active, 'whole-Runtime rollback completed');
    audit(config, 'rollback_succeeded', {
      operationId,
      reason: reason.slice(0, 500),
      activeRevision: active.revision,
      restoredRevision: target.revision,
      restoredManifestSha256: target.manifestSha256,
    });
    return {
      ok: true,
      operationId,
      detail: 'whole-Runtime release and SQLite backup restored; Canonical Runtime remains stopped until its sole launcher starts it',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'whole-Runtime rollback failed';
    audit(config, 'rollback_failed', { operationId, activeRevision: active.revision, targetRevision: target.revision, detail });
    return { ok: false, operationId, detail };
  }
}

export async function rollbackPrevious(config: RecoveryConfig, reason = 'standalone recovery'): Promise<RollbackResult> {
  const locked = await withLock(config, { action: 'rollback_previous' }, () => rollbackPreviousLocked(config, reason));
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
  // The canonical Runtime MCP gateway exposes only controller_ready; the public
  // gateway additionally exposes controller_context, so local verification must
  // probe the tool the Runtime actually serves.
  return verifyStableRuntime({
    ...config,
    publicMcpUrl: undefined,
    recoveryPublicUrl: undefined,
    readOnlyTool: { name: 'controller_ready' },
  });
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
  rollbackUsed: boolean;
  recoveryGatewayFailed?: boolean;
  recoveryGatewayRestartUsed?: boolean;
  primaryRuntimeFailed?: boolean;
  runtimeRestartAttempts?: number;
  runtimeMaximumRestartAttempts?: number;
  runtimeRestartLastAttemptAt?: number;
  runtimeRestartCooldownMs?: number;
  runtimeMinimumFailures?: number;
  runtimeMinimumFailureDurationMs?: number;
  runtimeRecoveryLastAttemptAt?: number;
  runtimeRecoveryCooldownMs?: number;
  publicTunnelConfigured?: boolean;
  publicTunnelFailed?: boolean;
  publicTunnelFailures?: number;
  publicTunnelFirstFailureAt?: number;
  publicTunnelRepairFailures?: number;
  publicTunnelMinimumFailures?: number;
  publicTunnelMinimumFailureDurationMs?: number;
  nowMs?: number;
}): WatchdogDecision {
  const now = input.nowMs ?? Date.now();
  if (input.publicTunnelConfigured && input.publicTunnelFailed) {
    const failures = input.publicTunnelFailures ?? 0;
    const minimumFailures = input.publicTunnelMinimumFailures ?? 2;
    const minimumDuration = input.publicTunnelMinimumFailureDurationMs ?? 5_000;
    const sustained = input.publicTunnelFirstFailureAt !== undefined && now - input.publicTunnelFirstFailureAt >= minimumDuration;
    if (failures >= minimumFailures && sustained) return { action: 'repair_public_tunnel', reason: 'local runtime and Recovery Gateway are healthy while the dedicated Recovery public endpoint is unavailable' };
    return { action: 'degraded', reason: 'Recovery tunnel failure has not yet met the bounded repair threshold' };
  }
  if (input.failures === 0) return { action: 'healthy', reason: 'all recovery probes healthy' };
  const recoveryRestartSustained = input.firstFailureAt !== undefined && now - input.firstFailureAt >= 5_000;
  if (input.failures >= 2 && recoveryRestartSustained && input.recoveryGatewayFailed && !input.recoveryGatewayRestartUsed) {
    return { action: 'restart_recovery_gateway', reason: 'the independent Recovery Gateway health endpoint failed after a sustained bounded failure window' };
  }

  const restartAttempts = input.runtimeRestartAttempts ?? 0;
  const maximumRestartAttempts = Math.max(1, input.runtimeMaximumRestartAttempts ?? 3);
  const restartMinimumFailures = Math.max(1, input.runtimeMinimumFailures ?? 2);
  const restartMinimumDurationMs = Math.max(0, input.runtimeMinimumFailureDurationMs ?? 5_000);
  const restartSustained = input.firstFailureAt !== undefined && now - input.firstFailureAt >= restartMinimumDurationMs;
  const restartCooldownMs = Math.max(0, input.runtimeRestartCooldownMs ?? 10_000);
  const restartCooldownElapsed = input.runtimeRestartLastAttemptAt === undefined || now - input.runtimeRestartLastAttemptAt >= restartCooldownMs;
  if (
    input.primaryRuntimeFailed
    && input.failures >= restartMinimumFailures
    && restartSustained
    && restartAttempts < maximumRestartAttempts
    && restartCooldownElapsed
  ) {
    return { action: 'restart_primary_runtime', reason: `canonical Runtime failed sustained verification; attempt bounded whole-Runtime restart ${restartAttempts + 1}/${maximumRestartAttempts}` };
  }

  const rollbackSustained = input.firstFailureAt !== undefined && now - input.firstFailureAt >= 30_000;
  const recoveryCooldownMs = Math.max(0, input.runtimeRecoveryCooldownMs ?? 60_000);
  const recoveryCooldownElapsed = input.runtimeRecoveryLastAttemptAt === undefined || now - input.runtimeRecoveryLastAttemptAt >= recoveryCooldownMs;
  const independentEvidence = new Set(input.evidenceClasses).size >= 2;
  if (
    input.primaryRuntimeFailed
    && restartAttempts >= maximumRestartAttempts
    && input.failures >= 6
    && rollbackSustained
    && independentEvidence
    && !input.activeKnownGood
    && input.previousKnownGood
    && !input.rollbackUsed
    && recoveryCooldownElapsed
  ) {
    return { action: 'rollback', reason: 'bounded primary Runtime restarts were exhausted and sustained multi-signal evidence permits previous whole-release recovery' };
  }
  return { action: 'degraded', reason: 'restart or rollback threshold, duration, cooldown, or independent-evidence quorum not met' };
}

export async function diagnose(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const verified = await verifyStableRuntime(config);
  return { verified, knownGood: knownGood(config), quarantine: json(quarantinePath(config)) ?? { releases: [] } };
}

export async function listReleases(config: RecoveryConfig): Promise<Record<string, unknown>> {
  const observation = observeRuntimeStatus(config.controllerHome);
  return {
    runtimeRunning: observation.running,
    runtimeReady: observation.ready,
    active: activeAuthorityRelease(config),
    previous: previousAuthorityRelease(config),
    knownGood: knownGood(config).releases,
  };
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

export interface PrimaryRuntimeRecoveryDependencies {
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  verifyLocal?: (config: RecoveryConfig) => Promise<VerifyResult>;
  runtimeRunning?: (config: RecoveryConfig) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function configuredPrimaryRuntimeService(config: RecoveryConfig): PrimaryRuntimeServiceConfig {
  return config.primaryRuntimeService ?? { platform: 'launchd' };
}

function primaryRuntimeLaunchdService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  const configured = configuredPrimaryRuntimeService(config);
  if (configured.platform !== 'launchd') return undefined;
  const paths = forgeRuntimeServicePaths(config.controllerHome);
  if (!existsSync(paths.installedPlistPath)) return undefined;
  const domain = `gui/${uid}`;
  return {
    uid,
    domain,
    target: `${domain}/${paths.label}`,
    label: paths.label,
    plistPath: paths.installedPlistPath,
  };
}

export interface PrimaryConnectorRecoveryDependencies {
  platform?: NodeJS.Platform;
  currentUid?: () => Promise<number | undefined>;
  runCommand?: CommandRunner;
  verifyLocal?: (config: RecoveryConfig) => Promise<VerifyResult>;
  reconnect?: (config: RecoveryConfig) => Promise<{ ok: boolean; detail: string; verify: VerifyResult }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function primaryConnectorLaunchdService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
  const configured = config.primaryConnectorService;
  if (!configured || configured.platform !== 'launchd' || !configured.label.trim()) return undefined;
  const label = configured.label.trim();
  const plistPath = resolve(configured.plistPath ?? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`));
  if (!existsSync(plistPath)) return undefined;
  const domain = `gui/${uid}`;
  return { uid, domain, target: `${domain}/${label}`, label, plistPath };
}

export async function restartPrimaryConnector(
  config: RecoveryConfig,
  dependencies: PrimaryConnectorRecoveryDependencies = {},
): Promise<PrimaryConnectorRestartResult> {
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const initialLocal = await verifyLocal(config);
  if (!initialLocal.ok) {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: 'Canonical Runtime must be locally healthy before the primary Connector is restarted',
      verify: initialLocal,
    };
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Connector restart currently requires the configured macOS launchd service', verify: initialLocal };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryConnectorLaunchdService(config, uid);
  if (!service) {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Connector launchd service is not configured or installed', verify: initialLocal };
  }
  const reconnect = dependencies.reconnect ?? reconnectMain;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const timeoutMs = config.primaryConnectorService?.postRestartVerifyTimeoutMs ?? 30_000;
  const locked = await withLock(config, { action: 'restart_primary_connector' }, async () => {
    const restarted = await ensureLaunchdServiceStarted(service, dependencies.runCommand ?? command);
    if (!restarted.ok) {
      audit(config, 'primary_connector_restart_failed', { serviceTarget: service.target, detail: restarted.detail });
      return { ok: false, attempted: true, detail: restarted.detail, serviceTarget: service.target, verify: initialLocal } satisfies PrimaryConnectorRestartResult;
    }
    const deadline = now() + timeoutMs;
    let observed = await reconnect(config);
    while (!observed.ok && now() < deadline) {
      await wait(1_000);
      observed = await reconnect(config);
    }
    audit(config, observed.ok ? 'primary_connector_restart_succeeded' : 'primary_connector_restart_unverified', {
      serviceTarget: service.target,
      detail: observed.detail,
    });
    return {
      ok: observed.ok,
      attempted: true,
      detail: observed.ok ? 'primary Connector restarted and the public MCP endpoint is reachable' : 'primary Connector restarted but the public MCP endpoint did not recover before timeout',
      serviceTarget: service.target,
      verify: observed.verify,
    } satisfies PrimaryConnectorRestartResult;
  });
  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: initialLocal };
  }
  return locked.value;
}

async function waitForPrimaryRuntimeState(input: {
  config: RecoveryConfig;
  expectedRunning: boolean;
  timeoutMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  runtimeRunning: (config: RecoveryConfig) => boolean;
}): Promise<boolean> {
  const deadline = input.now() + input.timeoutMs;
  while (input.now() < deadline) {
    if (input.runtimeRunning(input.config) === input.expectedRunning) return true;
    await input.wait(500);
  }
  return input.runtimeRunning(input.config) === input.expectedRunning;
}

async function verifyPrimaryRuntimeAfterStart(input: {
  config: RecoveryConfig;
  timeoutMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  verifyLocal: (config: RecoveryConfig) => Promise<VerifyResult>;
}): Promise<VerifyResult> {
  const deadline = input.now() + input.timeoutMs;
  let observed = await input.verifyLocal(input.config);
  while (!observed.ok && input.now() < deadline) {
    await input.wait(1_000);
    observed = await input.verifyLocal(input.config);
  }
  return observed;
}

export async function restartPrimaryRuntime(
  config: RecoveryConfig,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
): Promise<PrimaryRuntimeRestartResult> {
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const initial = await verifyLocal(config);
  if (initial.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime is already healthy', verify: initial };
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Runtime automatic restart currently requires the configured macOS launchd service', verify: initial };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryRuntimeLaunchdService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'primary Forge Runtime launchd service is not installed', verify: initial };
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const locked = await withLock(config, { action: 'restart_primary_runtime' }, async () => {
    const before = await verifyLocal(config);
    if (before.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime recovered before restart', serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRestartResult;
    const started = await ensureLaunchdServiceStarted(service, dependencies.runCommand ?? command);
    if (!started.ok) {
      audit(config, 'primary_runtime_restart_failed', { serviceTarget: service.target, detail: started.detail });
      return { ok: false, attempted: true, detail: started.detail, serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRestartResult;
    }
    const after = await verifyPrimaryRuntimeAfterStart({
      config,
      timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 30_000,
      now,
      wait,
      verifyLocal,
    });
    if (after.ok) {
      audit(config, 'primary_runtime_restart_succeeded', { serviceTarget: service.target, release: after.releases.active?.revision });
      return { ok: true, attempted: true, detail: 'Canonical Forge Runtime restarted and passed whole-Runtime verification', serviceTarget: service.target, verify: after } satisfies PrimaryRuntimeRestartResult;
    }
    audit(config, 'primary_runtime_restart_unverified', { serviceTarget: service.target, reasonCodes: after.runtime.reasonCodes });
    return { ok: false, attempted: true, detail: 'Canonical Forge Runtime restarted but did not pass whole-Runtime verification before timeout', serviceTarget: service.target, verify: after } satisfies PrimaryRuntimeRestartResult;
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: initial };
  return locked.value;
}

export async function recoverPrimaryRuntime(
  config: RecoveryConfig,
  reason = 'watchdog exhausted bounded primary Runtime restarts',
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
): Promise<PrimaryRuntimeRecoveryResult> {
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const initial = await verifyLocal(config);
  if (initial.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime recovered before rollback', verify: initial };
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'automatic whole-Runtime recovery currently requires the configured macOS launchd service', verify: initial };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryRuntimeLaunchdService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'primary Forge Runtime launchd service is not installed', verify: initial };
  const runCommand = dependencies.runCommand ?? command;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const runtimeRunning = dependencies.runtimeRunning ?? ((value: RecoveryConfig) => observeRuntimeStatus(value.controllerHome).running);
  const locked = await withLock(config, { action: 'recover_primary_runtime' }, async () => {
    const before = await verifyLocal(config);
    if (before.ok) return { ok: true, attempted: false, noOp: true, detail: 'Canonical Forge Runtime recovered before rollback', serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRecoveryResult;

    const stopped = await runCommand('launchctl', ['bootout', service.target], 15_000);
    const stoppedCleanly = stopped.ok || /not found|no such process|could not find service|service is not loaded/i.test(`${stopped.stderr}\n${stopped.stdout}`);
    if (!stoppedCleanly) {
      const detail = `primary Runtime bootout failed: ${stopped.stderr || stopped.stdout || stopped.status}`;
      audit(config, 'primary_runtime_recovery_stop_failed', { serviceTarget: service.target, detail });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: before } satisfies PrimaryRuntimeRecoveryResult;
    }
    const runtimeStopped = await waitForPrimaryRuntimeState({ config, expectedRunning: false, timeoutMs: 20_000, now, wait, runtimeRunning });
    if (!runtimeStopped) {
      const detail = 'primary Runtime owner remained live after bounded launchd bootout';
      audit(config, 'primary_runtime_recovery_stop_unverified', { serviceTarget: service.target });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies PrimaryRuntimeRecoveryResult;
    }

    const rollback = await rollbackPreviousLocked(config, reason);
    if (!rollback.ok) {
      audit(config, 'primary_runtime_recovery_rollback_failed', { serviceTarget: service.target, detail: rollback.detail });
      return { ok: false, attempted: true, detail: rollback.detail, serviceTarget: service.target, rollback, verify: rollback.verify ?? await verifyLocal(config) } satisfies PrimaryRuntimeRecoveryResult;
    }

    const started = await ensureLaunchdServiceStarted(service, runCommand);
    if (!started.ok) {
      audit(config, 'primary_runtime_recovery_start_failed', { serviceTarget: service.target, detail: started.detail, rollbackOperationId: rollback.operationId });
      return { ok: false, attempted: true, detail: started.detail, serviceTarget: service.target, rollback, verify: await verifyLocal(config) } satisfies PrimaryRuntimeRecoveryResult;
    }
    const after = await verifyPrimaryRuntimeAfterStart({
      config,
      timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 45_000,
      now,
      wait,
      verifyLocal,
    });
    if (after.ok) {
      audit(config, 'primary_runtime_recovery_succeeded', { serviceTarget: service.target, rollbackOperationId: rollback.operationId, restoredRelease: after.releases.active?.revision });
      return { ok: true, attempted: true, detail: 'previous whole-Runtime release and SQLite backup restored, restarted, and verified', serviceTarget: service.target, rollback, verify: after } satisfies PrimaryRuntimeRecoveryResult;
    }

    await runCommand('launchctl', ['bootout', service.target], 15_000);
    audit(config, 'primary_runtime_recovery_unverified', { serviceTarget: service.target, rollbackOperationId: rollback.operationId, reasonCodes: after.runtime.reasonCodes });
    return { ok: false, attempted: true, detail: 'previous whole-Runtime release started but failed verification; service was stopped to prevent a restart loop', serviceTarget: service.target, rollback, verify: after } satisfies PrimaryRuntimeRecoveryResult;
  });
  if (!locked.acquired) return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: initial };
  return locked.value;
}

function validateRuntimeReleaseCandidate(
  config: RecoveryConfig,
  manifestPath: string,
): { manifest: RuntimeReleaseManifest; releaseRoot: string; manifestPath: string } {
  if (!isAbsolute(manifestPath)) throw new Error('RUNTIME_RELEASE_CANDIDATE_PATH_REQUIRED: an absolute release manifest path is required');
  if (!existsSync(manifestPath)) throw new Error(`RUNTIME_RELEASE_CANDIDATE_MANIFEST_MISSING: ${manifestPath}`);
  const resolvedManifestPath = resolve(manifestPath);
  const manifest = loadRuntimeReleaseManifest(resolvedManifestPath, config.controllerHome);
  const releaseRoot = dirname(resolvedManifestPath);
  if (basename(releaseRoot) !== manifest.releaseId) {
    throw new Error('RUNTIME_RELEASE_CANDIDATE_ID_MISMATCH: manifest releaseId must match the immutable release directory');
  }
  const executable = join(releaseRoot, manifest.entrypoint);
  if (!existsSync(executable)) throw new Error(`RUNTIME_RELEASE_CANDIDATE_ENTRYPOINT_MISSING: ${executable}`);
  const identity = `sha256:${createHash('sha256').update(readFileSync(executable)).digest('hex')}`;
  if (identity !== manifest.artifactIdentity) {
    throw new Error(`RUNTIME_RELEASE_CANDIDATE_ARTIFACT_MISMATCH: expected ${manifest.artifactIdentity} observed ${identity}`);
  }
  return { manifest, releaseRoot, manifestPath: resolvedManifestPath };
}

/**
 * Activate an already staged and validated immutable Runtime release without
 * depending on the primary Runtime execution plane. The transaction mirrors
 * recoverPrimaryRuntime: stop the complete canonical service, atomically switch
 * active/previous whole-release authority (with a local SQLite backup), start
 * the one Runtime service, require whole-Runtime verification, and on failure
 * restore the previous whole release and its SQLite backup before restarting.
 */
export async function activateRuntimeRelease(
  config: RecoveryConfig,
  candidateManifestPath: string,
  dependencies: PrimaryRuntimeRecoveryDependencies = {},
): Promise<RuntimeReleaseActivationResult> {
  let candidate: { manifest: RuntimeReleaseManifest; releaseRoot: string; manifestPath: string };
  try {
    candidate = validateRuntimeReleaseCandidate(config, candidateManifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'runtime release candidate validation failed';
    audit(config, 'runtime_release_activation_candidate_invalid', { detail });
    return { ok: false, attempted: false, noOp: true, detail };
  }
  const current = releaseAuthority(config);
  const previousActive = current?.active;
  if (current && current.active.releaseId === candidate.manifest.releaseId) {
    return {
      ok: true,
      attempted: false,
      noOp: true,
      detail: 'requested Runtime release is already the active whole-Runtime release',
      verify: await verifyStableRuntime(config),
    };
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return { ok: false, attempted: false, noOp: true, detail: 'Runtime release activation currently requires the configured macOS launchd service' };
  }
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : primaryRuntimeLaunchdService(config, uid);
  if (!service) return { ok: false, attempted: false, noOp: true, detail: 'primary Forge Runtime launchd service is not installed', verify: await verifyStableRuntime(config) };
  const runCommand = dependencies.runCommand ?? command;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.sleep ?? sleep;
  const runtimeRunning = dependencies.runtimeRunning ?? ((value: RecoveryConfig) => observeRuntimeStatus(value.controllerHome).running);
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalRuntime;
  const operationId = `recovery-activate-runtime-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const locked = await withLock(config, { action: 'activate_runtime_release', ...(operationId ? { requestId: operationId } : {}) }, async () => {
    const before = await verifyLocal(config);
    const stopped = await runCommand('launchctl', ['bootout', service.target], 15_000);
    const stoppedCleanly = stopped.ok || /not found|no such process|could not find service|service is not loaded/i.test(`${stopped.stderr}\n${stopped.stdout}`);
    if (!stoppedCleanly) {
      const detail = `primary Runtime bootout failed: ${stopped.stderr || stopped.stdout || stopped.status}`;
      audit(config, 'runtime_release_activation_stop_failed', { serviceTarget: service.target, operationId, detail });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    const runtimeStopped = await waitForPrimaryRuntimeState({ config, expectedRunning: false, timeoutMs: 20_000, now, wait, runtimeRunning });
    if (!runtimeStopped) {
      const detail = 'primary Runtime owner remained live after bounded launchd bootout';
      audit(config, 'runtime_release_activation_stop_unverified', { serviceTarget: service.target, operationId });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    let committed: RuntimeReleaseAuthority;
    try {
      committed = publishRuntimeRelease(config.controllerHome, candidate.manifestPath, operationId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'runtime release authority publish failed';
      audit(config, 'runtime_release_activation_publish_failed', { serviceTarget: service.target, operationId, detail });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    if (committed.active.releaseId !== candidate.manifest.releaseId || committed.active.artifactIdentity !== candidate.manifest.artifactIdentity) {
      const detail = 'runtime release activation commit identity mismatch';
      audit(config, 'runtime_release_activation_commit_mismatch', { serviceTarget: service.target, operationId });
      return { ok: false, attempted: true, detail, serviceTarget: service.target, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    const started = await ensureLaunchdServiceStarted(service, runCommand);
    if (!started.ok) {
      audit(config, 'runtime_release_activation_start_failed', { serviceTarget: service.target, operationId, detail: started.detail });
      return { ok: false, attempted: true, detail: started.detail, serviceTarget: service.target, operationId, verify: await verifyLocal(config) } satisfies RuntimeReleaseActivationResult;
    }
    const after = await verifyPrimaryRuntimeAfterStart({
      config,
      timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 60_000,
      now,
      wait,
      verifyLocal,
    });
    if (after.ok && after.releases.active?.revision === candidate.manifest.releaseId) {
      audit(config, 'runtime_release_activation_succeeded', { serviceTarget: service.target, operationId, activeRevision: after.releases.active?.revision });
      return { ok: true, attempted: true, detail: 'requested Runtime release activated and passed whole-Runtime verification', serviceTarget: service.target, operationId, verify: after } satisfies RuntimeReleaseActivationResult;
    }

    // Activation failed: stop, restore the previous whole release and its SQLite
    // backup, restart the one service, and require verification again.
    await runCommand('launchctl', ['bootout', service.target], 15_000);
    let rollback: RollbackResult;
    try {
      const rollbackOperationId = `recovery-activate-runtime-rollback-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const restored = rollbackRuntimeRelease(config.controllerHome, rollbackOperationId);
      const previousRevision = previousActive?.releaseId ?? '';
      const previousIdentity = previousActive?.artifactIdentity;
      if (
        restored.active.releaseId !== previousRevision
        || (previousIdentity !== undefined && restored.active.artifactIdentity !== previousIdentity)
      ) {
        throw new Error('RECOVERY_RUNTIME_RELEASE_ROLLBACK_AUTHORITY_MISMATCH');
      }
      const restarted = await ensureLaunchdServiceStarted(service, runCommand);
      if (!restarted.ok) {
        rollback = { ok: false, operationId: rollbackOperationId, detail: `previous release authority restored but service start failed: ${restarted.detail}` };
      } else {
        const rolledBack = await verifyPrimaryRuntimeAfterStart({
          config,
          timeoutMs: configuredPrimaryRuntimeService(config).postRestartVerifyTimeoutMs ?? 60_000,
          now,
          wait,
          verifyLocal,
        });
        if (rolledBack.ok) {
          rollback = { ok: true, operationId: rollbackOperationId, detail: 'previous whole-Runtime release and SQLite backup restored, restarted, and verified', verify: rolledBack };
        } else {
          await runCommand('launchctl', ['bootout', service.target], 15_000);
          rollback = { ok: false, operationId: rollbackOperationId, detail: 'previous whole-Runtime release started but failed verification; service was stopped to prevent a restart loop', verify: rolledBack };
        }
      }
    } catch (error) {
      rollback = { ok: false, detail: error instanceof Error ? error.message : 'previous whole-Runtime release rollback failed' };
    }
    audit(config, 'runtime_release_activation_failed', {
      serviceTarget: service.target,
      operationId,
      candidateRevision: candidate.manifest.releaseId,
      rollbackOperationId: rollback.operationId,
      rollbackOk: rollback.ok,
      rollbackDetail: rollback.detail,
      reasonCodes: after.runtime.reasonCodes,
    });
    return {
      ok: false,
      attempted: true,
      detail: 'requested Runtime release activated but failed whole-Runtime verification; previous release restored',
      serviceTarget: service.target,
      operationId,
      rollback,
      verify: after,
    } satisfies RuntimeReleaseActivationResult;
  });
  if (!locked.acquired) {
    return { ok: false, attempted: false, noOp: true, detail: recoveryBusyDetail(locked.owner), serviceTarget: service.target, verify: await verifyStableRuntime(config) };
  }
  return locked.value;
}

export interface ConfiguredRuntimeActivationDependencies {
  stage?: typeof stageRuntimeRelease;
  activate?: (config: RecoveryConfig, manifestPath: string) => Promise<RuntimeReleaseActivationResult>;
}

export async function stageAndActivateConfiguredRuntimeRelease(
  config: RecoveryConfig,
  dependencies: ConfiguredRuntimeActivationDependencies = {},
): Promise<ConfiguredRuntimeActivationResult> {
  const sourceRoot = config.primaryRuntimeSourceRoot?.trim();
  if (!sourceRoot) {
    return { ok: false, attempted: false, noOp: true, detail: 'primary Runtime source root is not configured in standalone Recovery' };
  }
  let staged: StagedRuntimeRelease;
  try {
    staged = (dependencies.stage ?? stageRuntimeRelease)({ controllerHome: config.controllerHome, sourceRoot });
    assertRuntimeReleaseFiles(staged);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Runtime release staging failed';
    audit(config, 'runtime_release_stage_failed', { sourceRoot, detail });
    return { ok: false, attempted: false, noOp: true, detail };
  }
  const activation = await (dependencies.activate ?? activateRuntimeRelease)(config, staged.manifestPath);
  audit(config, activation.ok ? 'runtime_release_stage_and_activate_succeeded' : 'runtime_release_stage_and_activate_failed', {
    sourceRoot,
    releaseId: staged.releaseId,
    sourceCommit: staged.sourceCommit,
    activationAttempted: activation.attempted,
    activationDetail: activation.detail,
  });
  return {
    ok: activation.ok,
    attempted: activation.attempted,
    noOp: activation.noOp,
    detail: activation.ok ? 'configured Runtime source was staged as one immutable release and activated through standalone Recovery' : activation.detail,
    staged,
    activation,
  };
}

function recoveryTunnelService(config: RecoveryConfig, uid: number): LaunchdService | undefined {
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
  const uid = await (dependencies.currentUid ?? currentUid)();
  const service = uid === undefined ? undefined : recoveryTunnelService(config, uid);
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
  const label = 'com.moretea.forge-recovery-gateway';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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
  extensions: Partial<Pick<RecoveryConfig, 'publicMcpUrl' | 'recoveryPublicUrl' | 'recoveryTunnelService' | 'primaryRuntimeService' | 'primaryRuntimeSourceRoot' | 'primaryConnectorService'>> = {},
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
    ...extensions,
  });
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function watchdogTick(config: RecoveryConfig, prior: WatchdogState): Promise<{
  state: WatchdogState;
  decision: WatchdogDecision;
  verify: VerifyResult;
  rollback?: RollbackResult;
  publicTunnelRepair?: PublicTunnelRepairResult;
  recoveryGatewayRestart?: RecoveryGatewayRestartResult;
  primaryRuntimeRestart?: PrimaryRuntimeRestartResult;
  primaryRuntimeRecovery?: PrimaryRuntimeRecoveryResult;
}> {
  const verified = await verifyStableRuntime(config);
  const localVerify = await verifyLocalRuntime(config);
  const recoveryHealthy = verified.probes.recovery_gateway?.ok !== false
    && verified.probes.recovery_external_http?.ok !== false;
  if (verified.ok && localVerify.ok && recoveryHealthy) {
    const state: WatchdogState = {
      failures: 0,
      rollbackUsed: false,
      runtimeRestartAttempts: 0,
      runtimeRestartFailures: 0,
      runtimeRestartLastAttemptAt: undefined,
      runtimeRecoveryFailures: 0,
      runtimeRecoveryLastAttemptAt: undefined,
      publicTunnelFailures: 0,
      publicTunnelRepairFailures: 0,
      recoveryGatewayRestartUsed: false,
      lastDecision: 'healthy',
    };
    return { state, decision: { action: 'healthy', reason: 'primary runtime and standalone Recovery verification passed' }, verify: verified };
  }
  const now = Date.now();
  const publicTunnelFailed = isExternalTunnelFailure(config, verified, localVerify);
  const evidenceClasses = Object.entries(localVerify.probes)
    .filter(([name, value]) => !name.startsWith('recovery_') && !value.ok)
    .map(([name]) => name.startsWith('mcp') ? 'mcp' : name.startsWith('active') ? 'gateway' : name);
  if (!localVerify.runtime.ok) evidenceClasses.push('runtime');
  const activeKnownGood = Boolean(matchingKnownGood(config, verified.releases.active));
  const previousKnownGood = Boolean(matchingKnownGood(config, verified.releases.previous));
  const state: WatchdogState = publicTunnelFailed
    ? {
      ...prior,
      failures: prior.failures + 1,
      firstFailureAt: prior.firstFailureAt ?? now,
      publicTunnelFailures: (prior.publicTunnelFailures ?? 0) + 1,
      publicTunnelFirstFailureAt: prior.publicTunnelFirstFailureAt ?? now,
    }
    : {
      ...prior,
      failures: prior.failures + 1,
      firstFailureAt: prior.firstFailureAt ?? now,
      publicTunnelFailures: 0,
      publicTunnelFirstFailureAt: undefined,
    };
  const primaryConfig = configuredPrimaryRuntimeService(config);
  const decision = decideWatchdog({
    ...state,
    nowMs: now,
    evidenceClasses,
    activeKnownGood,
    previousKnownGood,
    primaryRuntimeFailed: !localVerify.ok,
    runtimeMaximumRestartAttempts: primaryConfig.maximumRestartAttempts,
    runtimeRestartCooldownMs: primaryConfig.restartCooldownMs,
    runtimeMinimumFailures: primaryConfig.minimumFailures,
    runtimeMinimumFailureDurationMs: primaryConfig.minimumFailureDurationMs,
    runtimeRecoveryLastAttemptAt: state.runtimeRecoveryLastAttemptAt,
    runtimeRecoveryCooldownMs: primaryConfig.recoveryCooldownMs,
    recoveryGatewayFailed: verified.probes.recovery_gateway?.ok === false,
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
  if (decision.action === 'restart_primary_runtime') {
    const primaryRuntimeRestart = await restartPrimaryRuntime(config);
    const attempts = (state.runtimeRestartAttempts ?? 0) + (primaryRuntimeRestart.attempted ? 1 : 0);
    const nextState: WatchdogState = primaryRuntimeRestart.ok
      ? {
        ...state,
        failures: 0,
        firstFailureAt: undefined,
        runtimeRestartAttempts: 0,
        runtimeRestartFailures: 0,
        runtimeRestartLastAttemptAt: now,
      }
      : {
        ...state,
        runtimeRestartAttempts: attempts,
        runtimeRestartFailures: (state.runtimeRestartFailures ?? 0) + 1,
        runtimeRestartLastAttemptAt: now,
      };
    return { state: nextState, decision, verify: verified, primaryRuntimeRestart };
  }
  if (decision.action === 'rollback') {
    const primaryRuntimeRecovery = await recoverPrimaryRuntime(config, 'watchdog exhausted bounded primary Runtime restarts with sustained multi-signal failure');
    const rollbackCommitted = primaryRuntimeRecovery.rollback?.ok === true && primaryRuntimeRecovery.rollback.noOp !== true;
    return {
      state: {
        ...state,
        rollbackUsed: state.rollbackUsed || rollbackCommitted,
        runtimeRestartAttempts: rollbackCommitted ? 0 : state.runtimeRestartAttempts,
        runtimeRestartFailures: rollbackCommitted ? 0 : state.runtimeRestartFailures,
        runtimeRestartLastAttemptAt: rollbackCommitted ? undefined : state.runtimeRestartLastAttemptAt,
        runtimeRecoveryFailures: primaryRuntimeRecovery.ok ? 0 : (state.runtimeRecoveryFailures ?? 0) + 1,
        runtimeRecoveryLastAttemptAt: now,
      },
      decision,
      verify: verified,
      primaryRuntimeRecovery,
      ...(primaryRuntimeRecovery.rollback ? { rollback: primaryRuntimeRecovery.rollback } : {}),
    };
  }
  return { state, decision, verify: verified };
}
