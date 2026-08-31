import { createHash } from 'crypto';
import { isAbsolute, resolve } from 'path';

export const INDEPENDENT_HOST_RESCUE_ACTIONS = [
  'host_status',
  'wsl_status', 'wsl_start',
  'forge_source_status', 'controller_status',
  'runtime_status', 'runtime_start', 'runtime_restart',
  'connector_status', 'connector_start', 'connector_restart',
  'recovery_status', 'recovery_start', 'recovery_restart',
  'tunnel_status', 'tunnel_start', 'tunnel_restart',
  'forge_cloud_verify', 'full_recover',
] as const;

export interface IndependentHostRescueConfig {
  schemaVersion: 1;
  wslDistro: string;
  controllerHome: string;
  sourceRoot: string;
  rescueRoot: string;
  runtimeUnit: string;
  connectorUnit: string;
  recoveryUnit: string;
  tunnelClient: string;
  tunnelAlias: string;
  tunnelId: string;
  tunnelProfile: string;
  tunnelProfileDir: string;
  tunnelAdminProfile: string;
  localMcpUrl: string;
}

function required(value: string | undefined, code: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function safeToken(value: string, code: string): string {
  if (/[\r\n'"`$;&|<>\\]/.test(value)) throw new Error(code);
  return value;
}

function safeAbsolutePath(value: string | undefined, code: string): string {
  const path = required(value, code);
  if (!isAbsolute(path) || /[\r\n'"`$;&|<>]/.test(path)) throw new Error(code);
  return resolve(path);
}

export function controllerServiceUnit(prefix: 'runtime' | 'connector', controllerHome: string): string {
  const suffix = createHash('sha256').update(resolve(controllerHome)).digest('hex').slice(0, 12);
  return prefix === 'runtime'
    ? `com.moretea.forge.runtime.${suffix}.service`
    : `com.moretea.forge.mcp-gateway.${suffix}.service`;
}

export function createIndependentHostRescueConfig(input: {
  wslDistro: string;
  controllerHome: string;
  sourceRoot: string;
  rescueRoot: string;
  tunnelClient: string;
  tunnelAlias: string;
  tunnelId: string;
  tunnelProfile?: string;
  tunnelProfileDir: string;
  tunnelAdminProfile?: string;
  localMcpUrl?: string;
}): IndependentHostRescueConfig {
  const wslDistro = safeToken(required(input.wslDistro, 'HOST_RESCUE_WSL_DISTRO_REQUIRED'), 'HOST_RESCUE_WSL_DISTRO_INVALID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(wslDistro)) throw new Error('HOST_RESCUE_WSL_DISTRO_INVALID');
  const controllerHome = safeAbsolutePath(input.controllerHome, 'HOST_RESCUE_CONTROLLER_HOME_INVALID');
  if (!/\/\.forge\/controller$/.test(controllerHome)) throw new Error('HOST_RESCUE_CONTROLLER_HOME_CANONICAL_REQUIRED');
  const sourceRoot = safeAbsolutePath(input.sourceRoot, 'HOST_RESCUE_SOURCE_ROOT_INVALID');
  const rescueRoot = safeAbsolutePath(input.rescueRoot, 'HOST_RESCUE_ROOT_INVALID');
  if (!/\/\.forge-recovery$/.test(rescueRoot)) throw new Error('HOST_RESCUE_ROOT_CANONICAL_REQUIRED');
  const tunnelClient = safeAbsolutePath(input.tunnelClient, 'HOST_RESCUE_TUNNEL_CLIENT_INVALID');
  const tunnelAlias = safeToken(required(input.tunnelAlias, 'HOST_RESCUE_TUNNEL_ALIAS_REQUIRED'), 'HOST_RESCUE_TUNNEL_ALIAS_INVALID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(tunnelAlias)) throw new Error('HOST_RESCUE_TUNNEL_ALIAS_INVALID');
  const tunnelId = safeToken(required(input.tunnelId, 'HOST_RESCUE_TUNNEL_ID_REQUIRED'), 'HOST_RESCUE_TUNNEL_ID_INVALID');
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) throw new Error('HOST_RESCUE_TUNNEL_ID_INVALID');
  const tunnelProfile = safeToken(input.tunnelProfile?.trim() || tunnelAlias, 'HOST_RESCUE_TUNNEL_PROFILE_INVALID');
  const tunnelProfileDir = safeAbsolutePath(input.tunnelProfileDir, 'HOST_RESCUE_TUNNEL_PROFILE_DIR_INVALID');
  const tunnelAdminProfile = safeToken(input.tunnelAdminProfile?.trim() || 'default', 'HOST_RESCUE_TUNNEL_ADMIN_PROFILE_INVALID');
  const localMcpUrl = input.localMcpUrl?.trim() || 'http://127.0.0.1:8767/mcp';
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(localMcpUrl)) throw new Error('HOST_RESCUE_LOCAL_MCP_URL_INVALID');

  return {
    schemaVersion: 1,
    wslDistro,
    controllerHome,
    sourceRoot,
    rescueRoot,
    runtimeUnit: controllerServiceUnit('runtime', controllerHome),
    connectorUnit: controllerServiceUnit('connector', controllerHome),
    recoveryUnit: 'com.moretea.forge.independent-recovery.service',
    tunnelClient,
    tunnelAlias,
    tunnelId,
    tunnelProfile,
    tunnelProfileDir,
    tunnelAdminProfile,
    localMcpUrl,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** This config contains identities and paths only; tunnel credentials remain in tunnel-client's own profile store. */
export function renderIndependentHostRescueEnv(config: IndependentHostRescueConfig): string {
  const values: Record<string, string> = {
    WSL_DISTRO: config.wslDistro,
    CONTROLLER_HOME: config.controllerHome,
    SOURCE_ROOT: config.sourceRoot,
    RUNTIME_UNIT: config.runtimeUnit,
    CONNECTOR_UNIT: config.connectorUnit,
    RECOVERY_UNIT: config.recoveryUnit,
    TUNNEL_CLIENT: config.tunnelClient,
    TUNNEL_ALIAS: config.tunnelAlias,
    TUNNEL_ID: config.tunnelId,
    TUNNEL_PROFILE: config.tunnelProfile,
    TUNNEL_PROFILE_DIR: config.tunnelProfileDir,
    TUNNEL_ADMIN_PROFILE: config.tunnelAdminProfile,
    MCP_LOCAL_URL: config.localMcpUrl,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n')}\n`;
}

export function renderIndependentHostRescueSystemdUnit(config: IndependentHostRescueConfig): string {
  const executable = `${config.rescueRoot}/bin/forge-wsl-rescue`;
  return [
    '[Unit]',
    'Description=Forge independent Windows/WSL host rescue',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment="FORGE_RESCUE_ROOT=${config.rescueRoot}"`,
    `ExecStart=${executable} watch`,
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderWindowsHostRescueConfig(config: IndependentHostRescueConfig): string {
  return `${JSON.stringify({
    schemaVersion: config.schemaVersion,
    distro: config.wslDistro,
    wslRescuePath: `${config.rescueRoot}/bin/forge-wsl-rescue`,
    controllerHome: config.controllerHome,
    runtimeUnit: config.runtimeUnit,
    connectorUnit: config.connectorUnit,
    recoveryUnit: config.recoveryUnit,
    tunnel: { alias: config.tunnelAlias, id: config.tunnelId, localMcpUrl: config.localMcpUrl },
  }, null, 2)}\n`;
}
