import { readFileSync } from 'fs';
import { forgeRuntimeServicePaths, readForgeRuntimeServiceConfig } from '../../root/service';
import { observeRuntimeStatus, readRuntimeStatusSnapshot } from '../../root/status';

export const FORGE_RUNTIME_MCP_TOKEN_ENV = 'FORGE_RUNTIME_MCP_TOKEN';

export interface ProviderMcpBootstrap {
  url: string;
  bearerTokenEnvVar: typeof FORGE_RUNTIME_MCP_TOKEN_ENV;
  principalId: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
}

export interface ProviderMcpReservationIdentity {
  principalId: string;
  sessionId: string;
}

export function providerMcpReservationIdentity(
  provider: 'codex',
  reservationId: string,
): ProviderMcpReservationIdentity {
  const suffix = reservationId.trim();
  if (!suffix) throw new Error('LAUNCHER_RESERVATION_ID_REQUIRED');
  return {
    principalId: `external:${provider}:${suffix}`,
    sessionId: `external-session:${provider}:${suffix}`,
  };
}

function runtimeMcpUrl(controllerHome: string): string {
  const observed = observeRuntimeStatus(controllerHome);
  if (!observed.running || !observed.ready) {
    throw new Error(`LAUNCHER_RUNTIME_MCP_NOT_READY: ${observed.reasonCodes.join(',') || 'runtime_not_ready'}`);
  }
  const snapshot = readRuntimeStatusSnapshot(controllerHome);
  if (snapshot?.endpoint?.trim()) return snapshot.endpoint.trim();
  const config = readForgeRuntimeServiceConfig(forgeRuntimeServicePaths(controllerHome).configPath);
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const renderedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${renderedHost}:${config.port}/mcp`;
}

export function resolveProviderMcpBootstrap(
  controllerHome: string,
  provider: 'codex',
  reservationId: string,
): ProviderMcpBootstrap {
  const config = readForgeRuntimeServiceConfig(forgeRuntimeServicePaths(controllerHome).configPath);
  const token = readFileSync(config.authTokenFile, 'utf8').trim();
  if (!token) throw new Error('LAUNCHER_RUNTIME_MCP_TOKEN_EMPTY');
  const identity = providerMcpReservationIdentity(provider, reservationId);
  return {
    url: runtimeMcpUrl(controllerHome),
    bearerTokenEnvVar: FORGE_RUNTIME_MCP_TOKEN_ENV,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
    env: {
      ...process.env,
      [FORGE_RUNTIME_MCP_TOKEN_ENV]: token,
    },
  };
}

export function codexMcpConfigArgs(bootstrap: ProviderMcpBootstrap): string[] {
  const headers = {
    'X-Forge-Forwarded-Principal-Id': bootstrap.principalId,
    'X-Forge-Forwarded-Session-Id': bootstrap.sessionId,
    'X-Forge-Forwarded-Controller-Type': 'codex',
  };
  const headerTable = `{${Object.entries(headers)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(',')}}`;
  return [
    // The persistent Codex config may register Forge as a stdio server. This
    // invocation is deliberately an HTTP bearer-bound transport; clear the
    // mutually-exclusive stdio fields before applying the exact runtime URL.
    '-c', 'mcp_servers.forge.command=null',
    '-c', 'mcp_servers.forge.args=[]',
    '-c', `mcp_servers.forge.url=${JSON.stringify(bootstrap.url)}`,
    '-c', `mcp_servers.forge.bearer_token_env_var=${JSON.stringify(bootstrap.bearerTokenEnvVar)}`,
    '-c', `mcp_servers.forge.http_headers=${headerTable}`,
  ];
}
