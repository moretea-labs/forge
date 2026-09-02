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
}

export interface OpenAiSecureTunnelRuntimeObservation {
  ok: boolean;
  running: boolean;
  healthy: boolean;
  ready: boolean;
  tunnelMatches: boolean;
  endpointMatches: boolean;
  alias: string;
  tunnelId: string;
  observedTunnelId?: string;
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

export function openAiSecureTunnelStatusArgs(alias: string): string[] {
  if (!isOpenAiTunnelAlias(alias)) throw new Error('OPENAI_TUNNEL_ALIAS_INVALID');
  return ['runtimes', 'status', alias, '--json'];
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
  const ok = running && healthy && ready && tunnelMatches && endpointMatches;
  const mismatches: string[] = [];
  if (!tunnelMatches && value.tunnel_id) mismatches.push(`tunnel id mismatch (${value.tunnel_id})`);
  if (!endpointMatches && value.profile_path) mismatches.push('runtime profile targets a different MCP endpoint');
  if (!running) mismatches.push(`runtime is ${value.runtime_state ?? 'not running'}`);
  if (running && !healthy) mismatches.push('runtime is not healthy');
  if (running && !ready) mismatches.push('runtime is not ready');
  if (value.error) mismatches.push(value.error);
  return {
    ok,
    running,
    healthy,
    ready,
    tunnelMatches,
    endpointMatches,
    alias: expected.alias,
    tunnelId: expected.tunnelId,
    ...(value.tunnel_id ? { observedTunnelId: value.tunnel_id } : {}),
    detail: ok ? `managed runtime ${expected.alias} is ready for ${expected.tunnelId}` : (mismatches.join('; ') || 'OpenAI tunnel runtime is not ready'),
    ...(value.profile_path ? { profilePath: value.profile_path } : {}),
  };
}
