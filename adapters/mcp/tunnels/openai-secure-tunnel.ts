import { readFileSync } from 'fs';
import { credentialReference } from '../../../packages/kernel/identity/api/index';

export const OPENAI_SECURE_TUNNEL_PLATFORM = 'openai-secure-tunnel' as const;

export interface OpenAiSecureTunnelRuntimeConfig {
  alias: string;
  tunnelId: string;
  mcpServerUrl: string;
  runtimeApiKeyRef?: string;
  profile?: string;
  profileDir?: string;
  adminProfile?: string;
}

export interface OpenAiSecureTunnelRuntimeStatusPayload {
  process_running?: boolean;
  healthy?: boolean;
  ready?: boolean;
  tunnel_id?: string;
  profile_path?: string;
  runtime_state?: string;
  error?: string;
  remote_lookup_attempted?: boolean;
  remote_error?: string;
  remote?: unknown;
  control_plane_poll_health?: { state?: string; reason?: string };
  local?: {
    control_plane_poll_health?: { state?: string; reason?: string };
    log?: { tail?: string };
  };
}

export interface OpenAiSecureTunnelRuntimeObservation {
  ok: boolean;
  running: boolean;
  healthy: boolean;
  ready: boolean;
  tunnelMatches: boolean;
  endpointMatches: boolean;
  controlPlaneState: 'ready' | 'degraded' | 'unknown';
  controlPlaneDetail: string;
  alias: string;
  tunnelId: string;
  observedTunnelId?: string;
  clientInstanceId?: string;
  remoteLookupAttempted?: boolean;
  detail: string;
  profilePath?: string;
}

export function isOpenAiTunnelId(value: string): boolean {
  return /^tunnel_[0-9a-f]{32}$/.test(value);
}

export function isOpenAiTunnelAlias(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
}

export function isOpenAiRuntimeApiKeyRef(value: string): boolean {
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true;
  return /^file:\//.test(value);
}

export function tunnelRuntimeProfileTargetsEndpoint(profilePath: string | undefined, endpoint: string): boolean {
  if (!profilePath) return false;
  try { return readFileSync(profilePath, 'utf8').includes(endpoint); } catch { return false; }
}

export function openAiSecureTunnelStatusArgs(
  alias: string,
  options: Pick<OpenAiSecureTunnelRuntimeConfig, 'adminProfile'> = {},
): string[] {
  if (!isOpenAiTunnelAlias(alias)) throw new Error('OPENAI_TUNNEL_ALIAS_INVALID');
  const args = ['runtimes', 'status', alias, '--json'];
  if (options.adminProfile?.trim()) args.push('--admin-profile', options.adminProfile.trim());
  return args;
}

export function openAiSecureTunnelConnectArgs(config: OpenAiSecureTunnelRuntimeConfig): string[] {
  if (!isOpenAiTunnelAlias(config.alias)) throw new Error('OPENAI_TUNNEL_ALIAS_INVALID');
  if (!isOpenAiTunnelId(config.tunnelId)) throw new Error('OPENAI_TUNNEL_ID_INVALID');
  if (!config.runtimeApiKeyRef || !isOpenAiRuntimeApiKeyRef(config.runtimeApiKeyRef)) {
    throw new Error('OPENAI_TUNNEL_RUNTIME_API_KEY_REF_REQUIRED');
  }
  // Kernel receives only a reference shape; tunnel-client remains owner of the secret.
  credentialReference(config.runtimeApiKeyRef, OPENAI_SECURE_TUNNEL_PLATFORM);
  const endpoint = new URL(config.mcpServerUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) {
    throw new Error('OPENAI_TUNNEL_MCP_SERVER_LOOPBACK_REQUIRED');
  }
  const args = [
    'runtimes', 'connect',
    '--alias', config.alias,
    '--tunnel-id', config.tunnelId,
    '--runtime-api-key', config.runtimeApiKeyRef,
    '--mcp-server-url', config.mcpServerUrl,
  ];
  if (config.adminProfile) args.push('--admin-profile', config.adminProfile);
  if (config.profile) args.push('--profile', config.profile);
  if (config.profileDir) args.push('--profile-dir', config.profileDir);
  return args;
}

function controlPlaneEvidence(value: OpenAiSecureTunnelRuntimeStatusPayload): {
  state: OpenAiSecureTunnelRuntimeObservation['controlPlaneState'];
  detail: string;
  clientInstanceId?: string;
} {
  let clientInstanceId: string | undefined;
  let latestControlPlane: { level?: string; msg?: string; error?: string } | undefined;
  const tail = value.local?.log?.tail;
  if (typeof tail === 'string') {
    for (const line of tail.trim().split('\n').reverse()) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (!clientInstanceId && typeof event.client_instance_id === 'string') clientInstanceId = event.client_instance_id;
        if (!latestControlPlane && event.component === 'controlplane') {
          latestControlPlane = {
            level: typeof event.level === 'string' ? event.level : undefined,
            msg: typeof event.msg === 'string' ? event.msg : undefined,
            error: typeof event.error === 'string' ? event.error : undefined,
          };
        }
        if (clientInstanceId && latestControlPlane) break;
      } catch { /* bounded diagnostic tail may contain non-JSON lines */ }
    }
  }

  const remoteError = typeof value.remote_error === 'string' ? value.remote_error.trim() : '';
  if (value.remote_lookup_attempted === true) {
    if (remoteError) return { state: 'degraded', detail: `remote lookup failed: ${remoteError}`, ...(clientInstanceId ? { clientInstanceId } : {}) };
    if (value.remote && typeof value.remote === 'object') {
      return { state: 'ready', detail: 'remote tunnel lookup succeeded', ...(clientInstanceId ? { clientInstanceId } : {}) };
    }
  }

  const pollHealth = value.control_plane_poll_health ?? value.local?.control_plane_poll_health;
  const pollState = pollHealth?.state?.trim().toLowerCase();
  if (pollState === 'ready' || pollState === 'healthy') {
    return { state: 'ready', detail: pollHealth?.reason?.trim() || `control-plane poll state is ${pollState}`, ...(clientInstanceId ? { clientInstanceId } : {}) };
  }
  if (pollState === 'degraded' || pollState === 'error' || pollState === 'failed') {
    return { state: 'degraded', detail: pollHealth?.reason?.trim() || `control-plane poll state is ${pollState}`, ...(clientInstanceId ? { clientInstanceId } : {}) };
  }

  if (latestControlPlane) {
    const message = [latestControlPlane.msg, latestControlPlane.error].filter(Boolean).join(': ');
    if (/poller recovered|polling operational/i.test(message)) {
      return { state: 'ready', detail: message, ...(clientInstanceId ? { clientInstanceId } : {}) };
    }
    if (latestControlPlane.level === 'WARN' || latestControlPlane.level === 'ERROR' || /timed out|timeout|deadline|reset by peer|lookup .*i\/o timeout|context canceled/i.test(message)) {
      return { state: 'degraded', detail: message || 'latest control-plane event is degraded', ...(clientInstanceId ? { clientInstanceId } : {}) };
    }
  }

  return {
    state: 'unknown',
    detail: pollHealth?.reason?.trim() || 'remote control-plane reachability was not established',
    ...(clientInstanceId ? { clientInstanceId } : {}),
  };
}

export function parseOpenAiSecureTunnelRuntimeStatus(
  stdout: string,
  expected: Pick<OpenAiSecureTunnelRuntimeConfig, 'alias' | 'tunnelId' | 'mcpServerUrl'>,
): OpenAiSecureTunnelRuntimeObservation {
  let value: OpenAiSecureTunnelRuntimeStatusPayload;
  try {
    value = JSON.parse(stdout || '{}') as OpenAiSecureTunnelRuntimeStatusPayload;
  } catch {
    return {
      ok: false,
      running: false,
      healthy: false,
      ready: false,
      tunnelMatches: false,
      endpointMatches: false,
      controlPlaneState: 'unknown',
      controlPlaneDetail: 'status payload was not valid JSON',
      alias: expected.alias,
      tunnelId: expected.tunnelId,
      detail: 'OpenAI tunnel runtime status was not valid JSON',
    };
  }
  const running = value.process_running === true;
  const healthy = value.healthy === true;
  const ready = value.ready === true;
  const tunnelMatches = value.tunnel_id === expected.tunnelId;
  const endpointMatches = tunnelRuntimeProfileTargetsEndpoint(value.profile_path, expected.mcpServerUrl);
  const controlPlane = controlPlaneEvidence(value);
  // `process_running` only describes runtimes that tunnel-client supervises
  // itself. An externally owned service manager (launchd/systemd) reports the
  // runtime as not running while the tunnel is healthy, reachable, and bound to
  // the expected identity. Health, readiness, tunnel id, and endpoint binding are
  // the transport facts; process registry state is diagnostic only.
  const localReady = healthy && ready && tunnelMatches && endpointMatches;
  const ok = localReady && controlPlane.state === 'ready';
  const mismatches: string[] = [];
  if (!tunnelMatches && value.tunnel_id) mismatches.push(`tunnel id mismatch (${value.tunnel_id})`);
  if (!endpointMatches && value.profile_path) mismatches.push('runtime profile targets a different MCP endpoint');
  if (!healthy) mismatches.push(`runtime is ${value.runtime_state ?? 'not running'}`);
  if (healthy && !ready) mismatches.push('runtime is not ready');
  if (value.error) mismatches.push(value.error);
  if (controlPlane.state !== 'ready') mismatches.push(`control plane ${controlPlane.state}: ${controlPlane.detail}`);
  return {
    ok,
    running,
    healthy,
    ready,
    tunnelMatches,
    endpointMatches,
    controlPlaneState: controlPlane.state,
    controlPlaneDetail: controlPlane.detail,
    alias: expected.alias,
    tunnelId: expected.tunnelId,
    ...(value.tunnel_id ? { observedTunnelId: value.tunnel_id } : {}),
    ...(controlPlane.clientInstanceId ? { clientInstanceId: controlPlane.clientInstanceId } : {}),
    ...(value.remote_lookup_attempted === undefined ? {} : { remoteLookupAttempted: value.remote_lookup_attempted }),
    detail: ok ? `managed runtime ${expected.alias} is locally ready and its OpenAI control plane is reachable for ${expected.tunnelId}` : (mismatches.join('; ') || 'OpenAI tunnel runtime is not ready'),
    ...(value.profile_path ? { profilePath: value.profile_path } : {}),
  };
}
