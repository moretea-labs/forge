import { createHash } from 'crypto';
import { mkdirSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { join, resolve } from 'path';
import { observeRuntimeStatus } from '../root/status';
import type { RecoveryHttpTransport } from './http-transport';
import {
  openAiSecureTunnelConnectArgs,
  openAiSecureTunnelStatusArgs,
  parseOpenAiSecureTunnelRuntimeStatus,
  type OpenAiSecureTunnelRuntimeObservation,
} from '../../../adapters/mcp/tunnels/openai-secure-tunnel';
import type { OpenAiSecureTunnelServiceConfig, RecoveryConfig, ReleaseEvidence, VerifyResult } from './recovery-shared';
import {
  audit,
  command,
  configuredPrimaryPublicTunnel,
  configuredRecoveryTunnel,
  type CommandRunner,
  json,
  loadWatchdogState,
  normalizeRecoveryReadOnlyTool,
  persistWatchdogDiagnosticEvidence,
  recoveryMachineIdentity,
} from './recovery-shared';

/**
 * Runtime/tunnel/MCP probe and observation functions extracted from core.ts
 * (audit round 5, pure move). Read-only observation surface; core.ts remains
 * the facade and re-exports the public entry points.
 */
export async function runtimeStatus(config: RecoveryConfig) {
  const identity = recoveryMachineIdentity(config);
  const observation = observeRuntimeStatus(config.controllerHome);
  const watchdog = loadWatchdogState(config);
  return {
    identity,
    ...observation,
    recoveryWatchdog: {
      lastDecision: watchdog.lastDecision,
      lastReason: watchdog.lastReason,
      updatedAt: watchdog.updatedAt,
      failures: watchdog.failures,
      rollbackUsed: watchdog.rollbackUsed,
      runtimeRestartAttempts: watchdog.runtimeRestartAttempts ?? 0,
      runtimeRestartFailures: watchdog.runtimeRestartFailures ?? 0,
      primaryConnectorFailures: watchdog.primaryConnectorFailures ?? 0,
      primaryConnectorRestartAttempts: watchdog.primaryConnectorRestartAttempts ?? 0,
      primaryConnectorRestartFailures: watchdog.primaryConnectorRestartFailures ?? 0,
    },
  };
}

export async function probe(transport: RecoveryHttpTransport, url: string, timeoutMs = 4_000): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), timeoutMs);
  try {
    const response = await transport.request({ url, headers: { accept: 'application/json' }, timeoutMs, signal: controller.signal });
    return { ok: response.ok, detail: `HTTP ${response.status}`, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'request failed' };
  } finally { clearTimeout(timer); }
}

export async function probeExternalMcp(
  transport: RecoveryHttpTransport,
  url: string,
  options: { acceptOAuthChallenge?: boolean } = {},
): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 4_000);
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
    const oauthChallenge = response.status === 401 && /\bBearer\b/i.test(challenge);
    const acceptsOAuthChallenge = options.acceptOAuthChallenge ?? true;
    const ok = response.ok || (acceptsOAuthChallenge && oauthChallenge);
    const detail = oauthChallenge
      ? acceptsOAuthChallenge ? 'HTTP 401 OAuth challenge' : 'HTTP 401 unexpected OAuth challenge for unauthenticated Connector'
      : `HTTP ${response.status}`;
    return { ok, detail, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 180) : 'request failed' };
  } finally { clearTimeout(timer); }
}

export function publicGatewayReadinessEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = '/transport-ready';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function probePublicGatewayReadiness(
  transport: RecoveryHttpTransport,
  endpoint: string,
  options: { acceptOAuthChallenge?: boolean } = {},
): Promise<{ ok: boolean; detail: string; status?: number; value?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 4_000);
  const surface = 'transport-ready';
  try {
    const response = await transport.request({
      url: publicGatewayReadinessEndpoint(endpoint),
      headers: { accept: 'application/json' },
      timeoutMs: 4_000,
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 405) {
      // Older Connectors predate the transport-scoped capacity surface. Their
      // whole-control-plane /ready route is intentionally not a transport
      // liveness contract and can depend on the Runtime that Recovery is in the
      // middle of restarting. Falling back to it creates a circular cutover
      // dependency. Verify the actual MCP transport instead: a successful
      // initialize response or the expected OAuth Bearer challenge proves the
      // legacy Connector transport is reachable without weakening 5xx/timeout
      // failure handling.
      const legacy = await probeExternalMcp(transport, endpoint, options);
      return { ...legacy, detail: `legacy-mcp ${legacy.detail}` };
    }
    let sessionCapacity: unknown;
    try {
      const payload = JSON.parse(response.body) as { sessionCapacity?: unknown };
      sessionCapacity = payload.sessionCapacity;
    } catch { /* malformed readiness payload remains a failed/opaque probe */ }
    const recoveryRecommended = Boolean(
      sessionCapacity
      && typeof sessionCapacity === 'object'
      && (sessionCapacity as { recoveryRecommended?: unknown }).recoveryRecommended === true,
    );
    return {
      ok: response.ok && !recoveryRecommended,
      detail: `${surface} HTTP ${response.status}${recoveryRecommended ? '; session capacity recommends Connector recovery' : ''}`,
      status: response.status,
      ...(sessionCapacity === undefined ? {} : { value: sessionCapacity }),
    };
  } catch (error) {
    return { ok: false, detail: `${surface} ${error instanceof Error ? error.message.slice(0, 180) : 'request failed'}` };
  } finally {
    clearTimeout(timer);
  }
}

export function connectorCapacityRecoveryRecommended(verified: VerifyResult): boolean {
  const value = verified.probes.primary_connector_ready?.value;
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { recoveryRecommended?: unknown }).recoveryRecommended === true,
  );
}

export function canonicalRuntimeSafeForTargetedConnectorRecovery(verified: VerifyResult): boolean {
  // Targeted Connector/public-transport recovery mutates no Runtime release or
  // Work authority. Use durable Runtime ownership + release/execution evidence
  // as the safety fence; a single failed HTTP gateway/MCP observation is the
  // symptom this action may need to repair and must not deadlock the recovery path.
  return verified.runtime.ok
    && verified.runtime.running
    && verified.runtime.ready
    && !verified.runtime.stale
    && verified.releases.coherent !== false
    && verified.probes.runtime_execution_surface?.ok !== false;
}

export function mainToken(config: RecoveryConfig): string | undefined {
  const explicit = config.mainMcpTokenFile?.trim();
  const candidate = explicit || join(config.controllerHome, 'mcp', 'mcp.tokens.json');
  if (explicit) {
    try {
      const raw = readFileSync(candidate, 'utf8').trim();
      if (raw.length >= 24 && !raw.startsWith('{')) return raw;
    } catch {
      return undefined;
    }
  }
  const parsed = json<{ bearerToken?: unknown }>(candidate);
  return typeof parsed?.bearerToken === 'string' && parsed.bearerToken.length >= 24 ? parsed.bearerToken : undefined;
}

export interface RecoveryMcpCallResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  detail: string;
  sessionId?: string;
}

export function parseRecoveryMcpPayload(text: string, contentType: string): Record<string, unknown> | undefined {
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

export async function mcpCall(
  transport: RecoveryHttpTransport,
  url: string,
  token: string,
  id: number | undefined,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<RecoveryMcpCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 8_000);
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

export async function closeRecoveryMcpSession(transport: RecoveryHttpTransport, url: string, token: string, sessionId: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_HTTP_TIMEOUT'), 5_000);
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

export function runtimeEndpoint(config: RecoveryConfig): string | undefined {
  return observeRuntimeStatus(config.controllerHome).snapshot?.endpoint;
}

export function runtimeHealthEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  // The canonical Runtime serves the whole-Runtime readiness probe at /ready.
  url.pathname = '/ready';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * tunnel-client materialises its own state directory relative to the process
 * working directory. Persistent Forge services run under launchd/systemd with a
 * read-only working directory, so a Forge-owned tunnel reconnect must run from a
 * writable Forge-managed directory. Otherwise the reconnect fails with
 * `mkdir .tunnel-client: read-only file system`, the dedicated Recovery
 * transport can never be repaired, and the Recovery connector stays dark.
 */
export function tunnelClientWorkingDirectory(controllerHome: string): string {
  const directory = join(resolve(controllerHome), 'tmp', 'tunnel-client');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export async function observeOpenAiTunnelRuntime(
  configured: OpenAiSecureTunnelServiceConfig,
  runCommand: CommandRunner = command,
): Promise<OpenAiSecureTunnelRuntimeObservation> {
  let args: string[];
  try {
    args = openAiSecureTunnelStatusArgs(configured.alias, configured);
  } catch (error) {
    return {
      ok: false, running: false, healthy: false, ready: false, tunnelMatches: false, endpointMatches: false,
      controlPlaneState: 'unknown',
      controlPlaneDetail: 'tunnel runtime configuration could not be observed',
      alias: configured.alias, tunnelId: configured.tunnelId,
      detail: error instanceof Error ? error.message : 'OpenAI tunnel runtime configuration is invalid',
    };
  }
  const status = await runCommand('tunnel-client', args, 15_000);
  if (!status.stdout.trim()) {
    const local = await observeOpenAiTunnelLocalHealthFallback(configured);
    if (local) return local;
    return {
      ok: false, running: false, healthy: false, ready: false, tunnelMatches: false, endpointMatches: false,
      controlPlaneState: 'unknown',
      controlPlaneDetail: 'tunnel-client status produced no remote control-plane evidence',
      alias: configured.alias, tunnelId: configured.tunnelId,
      detail: status.stderr.trim() || 'OpenAI tunnel runtime status is unavailable',
    };
  }
  return parseOpenAiSecureTunnelRuntimeStatus(status.stdout, {
    alias: configured.alias, tunnelId: configured.tunnelId, mcpServerUrl: configured.mcpServerUrl,
  });
}

/**
 * tunnel-client's structured status command can itself be delayed by a
 * control-plane query. When that happens, retain a bounded observation of the
 * locally supervised runtime instead of treating a live, identity-matched
 * alias as failed. This reads only the client-owned profile and loopback
 * health URL; it never creates, repoints, or restarts a tunnel.
 */
export async function observeOpenAiTunnelLocalHealthFallback(
  configured: OpenAiSecureTunnelServiceConfig,
  options: {
    request?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  } = {},
): Promise<OpenAiSecureTunnelRuntimeObservation | undefined> {
  if (!configured.profile?.trim() || !configured.profileDir?.trim()) return undefined;
  const profilePath = join(configured.profileDir, `${configured.profile}.yaml`);
  let profile: string;
  try { profile = readFileSync(profilePath, 'utf8'); } catch { return undefined; }
  const identityMatches = profile.includes(configured.tunnelId);
  const endpointMatches = profile.includes(configured.mcpServerUrl);
  const urlFileMatch = profile.match(/["']?url_file["']?\s*:\s*["']([^"']+)["']/i);
  if (!urlFileMatch) return undefined;
  let base: URL;
  try {
    base = new URL(readFileSync(urlFileMatch[1].trim(), 'utf8').trim());
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) return undefined;
  } catch { return undefined; }
  const request = options.request ?? ((url: string, init: { signal: AbortSignal }) => fetch(url, init));
  const probe = async (pathname: '/healthz' | '/readyz'): Promise<boolean> => {
    const url = new URL(base);
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('RECOVERY_TUNNEL_HEALTH_TIMEOUT'), 4_000);
    try { return (await request(url.toString(), { signal: controller.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
  };
  const [healthy, ready] = await Promise.all([probe('/healthz'), probe('/readyz')]);
  const localReady = healthy && ready && identityMatches && endpointMatches;
  // Loopback health proves only that the local tunnel process and MCP binding are
  // alive. It must never stand in for the remote OpenAI control plane when the
  // status command itself could not establish that path.
  const ok = false;
  const failures: string[] = [];
  if (!identityMatches) failures.push('profile tunnel id does not match');
  if (!endpointMatches) failures.push('profile MCP endpoint does not match');
  if (!healthy) failures.push('local healthz failed');
  if (!ready) failures.push('local readyz failed');
  return {
    ok,
    running: healthy,
    healthy,
    ready,
    tunnelMatches: identityMatches,
    endpointMatches,
    controlPlaneState: 'unknown',
    controlPlaneDetail: 'tunnel-client status was unavailable; only loopback health was observed',
    alias: configured.alias,
    tunnelId: configured.tunnelId,
    ...(identityMatches ? { observedTunnelId: configured.tunnelId } : {}),
    detail: localReady
      ? `managed runtime ${configured.alias} is locally healthy and ready for ${configured.tunnelId}, but the OpenAI control plane is unverified because status is unavailable`
      : failures.join('; ') || 'OpenAI tunnel local health fallback failed',
    profilePath,
  };
}

export async function observeOpenAiRecoveryTunnel(
  config: RecoveryConfig,
  runCommand: CommandRunner = command,
): Promise<OpenAiSecureTunnelRuntimeObservation | undefined> {
  const configured = configuredRecoveryTunnel(config);
  if (!configured || configured.platform !== 'openai-secure-tunnel') return undefined;
  return observeOpenAiTunnelRuntime(configured, runCommand);
}

export async function ensureOpenAiTunnelRuntimeStarted(
  configured: OpenAiSecureTunnelServiceConfig,
  runCommand: CommandRunner = command,
  workingDirectory?: string,
): Promise<{ ok: boolean; attempted: boolean; noOp?: boolean; detail: string; serviceLabel: string; serviceTarget: string }> {
  const serviceLabel = configured.alias;
  const serviceTarget = `tunnel-client:${configured.alias}`;
  const observed = await observeOpenAiTunnelRuntime(configured, runCommand);
  if (observed.ok) return { ok: true, attempted: false, noOp: true, detail: observed.detail, serviceLabel, serviceTarget };
  if (observed.healthy && observed.ready && observed.tunnelMatches && observed.endpointMatches && observed.controlPlaneState !== 'ready') {
    return {
      ok: false,
      attempted: false,
      noOp: true,
      detail: `OpenAI Secure MCP Tunnel runtime ${configured.alias} is locally ready but its remote control plane is ${observed.controlPlaneState}; refusing a local reconnect for an upstream transport failure: ${observed.controlPlaneDetail}`,
      serviceLabel,
      serviceTarget,
    };
  }
  if (observed.observedTunnelId && !observed.tunnelMatches) {
    return { ok: false, attempted: false, noOp: true, detail: `OpenAI tunnel alias ${configured.alias} is already bound to a different tunnel id`, serviceLabel, serviceTarget };
  }
  if (observed.profilePath && !observed.endpointMatches) {
    return { ok: false, attempted: false, noOp: true, detail: `OpenAI tunnel alias ${configured.alias} is already bound to a different MCP endpoint`, serviceLabel, serviceTarget };
  }
  let args: string[];
  try {
    args = openAiSecureTunnelConnectArgs({
      alias: configured.alias,
      tunnelId: configured.tunnelId,
      mcpServerUrl: configured.mcpServerUrl,
      runtimeApiKeyRef: configured.runtimeApiKeyRef,
      profile: configured.profile,
      profileDir: configured.profileDir,
      adminProfile: configured.adminProfile,
    });
  } catch (error) {
    return { ok: false, attempted: false, noOp: true, detail: error instanceof Error ? error.message : 'OpenAI tunnel runtime configuration is invalid', serviceLabel, serviceTarget };
  }
  const connected = await runCommand('tunnel-client', args, Math.max(30_000, configured.postRestartVerifyTimeoutMs ?? 20_000), workingDirectory ? { cwd: workingDirectory } : {});
  return connected.ok
    ? { ok: true, attempted: true, detail: `OpenAI Secure MCP Tunnel runtime ${configured.alias} connect dispatched`, serviceLabel, serviceTarget }
    : { ok: false, attempted: true, detail: `OpenAI Secure MCP Tunnel runtime connect failed: ${connected.stderr || connected.stdout || connected.status}`, serviceLabel, serviceTarget };
}

export async function probeOpenAiRecoveryTunnel(
  config: RecoveryConfig,
  runCommand: CommandRunner = command,
): Promise<{ ok: boolean; detail: string; value?: unknown } | undefined> {
  const observed = await observeOpenAiRecoveryTunnel(config, runCommand);
  return observed ? { ok: observed.ok, detail: observed.detail, value: observed } : undefined;
}

export function openAiTunnelObservationFromProbe(
  probe: { value?: unknown } | undefined,
): OpenAiSecureTunnelRuntimeObservation | undefined {
  const value = probe?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const observed = value as Partial<OpenAiSecureTunnelRuntimeObservation>;
  if (
    typeof observed.alias !== 'string'
    || typeof observed.tunnelId !== 'string'
    || typeof observed.healthy !== 'boolean'
    || typeof observed.ready !== 'boolean'
    || typeof observed.tunnelMatches !== 'boolean'
    || typeof observed.endpointMatches !== 'boolean'
    || !['ready', 'degraded', 'unknown'].includes(String(observed.controlPlaneState))
  ) return undefined;
  return observed as OpenAiSecureTunnelRuntimeObservation;
}

export function isUpstreamOpenAiControlPlaneIncident(observed: OpenAiSecureTunnelRuntimeObservation | undefined): boolean {
  return Boolean(
    observed
    && observed.healthy
    && observed.ready
    && observed.tunnelMatches
    && observed.endpointMatches
    && observed.controlPlaneState !== 'ready'
  );
}

export async function probeOpenAiApiReachability(): Promise<{ ok: boolean; detail: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('RECOVERY_OPENAI_API_REACHABILITY_TIMEOUT'), 4_000);
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    return {
      ok: true,
      status: response.status,
      detail: `api.openai.com returned HTTP ${response.status}; DNS/TCP/TLS/HTTP path is reachable`,
    };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `; cause=${error.cause.message}` : '';
    return { ok: false, detail: `${error instanceof Error ? error.message : String(error)}${cause}`.slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

export async function observeRecentMacNetworkExtensionChanges(
  runCommand: CommandRunner = command,
): Promise<{ ok: boolean; detail: string } | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const result = await runCommand('/usr/bin/log', [
    'show', '--last', '90s', '--style', 'compact', '--predicate',
    'process == "nesessionmanager" AND (eventMessage CONTAINS[c] "configuration changed" OR eventMessage CONTAINS[c] "neconfigurationchanged")',
  ], 3_000, { maxOutputBytes: 12_000 });
  const output = (result.stdout || result.stderr).trim();
  return {
    ok: result.ok,
    detail: output ? output.slice(-4_000) : (result.ok ? 'no recent Network Extension configuration changes observed' : 'Network Extension event query failed'),
  };
}
