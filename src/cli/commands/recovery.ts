import { createHash, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { hostname } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { Command } from 'commander';
import { readMcpServiceOAuthPassphrase } from '../mcp/auth';
import {
  openAiSecureTunnelConnectArgs,
  openAiSecureTunnelStatusArgs,
  parseOpenAiSecureTunnelRuntimeStatus,
  type OpenAiSecureTunnelRuntimeObservation,
} from '../mcp/openai-secure-tunnel';
import {
  resolveControllerHome,
  rollbackStoppedControllerHomeAuthorityRelocation,
  type StoppedControllerHomeAuthorityRelocation,
} from '../repositories/controller-home';
import { FORGE_VERSION } from '../../version';
import {
  RECOVERY_GATEWAY_LABEL,
  RECOVERY_WATCHDOG_LABEL,
  inspectRecoveryTunnelLaunchdContract,
  installStandaloneRecovery,
  recoveryLaunchdPid,
  recoveryLaunchdServicePid,
  recoveryReleaseAuthoritySnapshot,
} from '../../runtime/standalone-recovery/installer';
import {
  RECOVERY_TOOLS,
} from '../../runtime/standalone-recovery/entry';
import {
  activateRuntimeRelease,
  defaultPrimaryRuntimeServiceConfig,
  loadRecoveryConfig,
  recoverPrimaryRuntime,
  recoveryMachineIdentity,
  restartPrimaryConnector,
  restartPrimaryRuntime,
  restartRecoveryGateway,
  stageAndActivateConfiguredRuntimeRelease,
  rollbackPrevious,
  runtimeStatus,
  verifyStableRuntime,
  type OpenAiSecureTunnelServiceConfig,
  type PrimaryConnectorServiceConfig,
  type RecoveryMachineIdentity,
  type PublicTunnelServiceConfig,
  type RecoveryTunnelServiceConfig,
  type SystemdUserRecoveryTunnelServiceConfig,
} from '../../runtime/standalone-recovery/core';
import { readRecoveryRuntimeIdentity } from '../../runtime/standalone-recovery/release';
import {
  assertRecoveryControllerHomeMigrationReady,
  recoveryControllerHomeMigrationPreflight,
  runLinuxControllerHomeMigrationRequest,
  scheduleLinuxControllerHomeMigration,
  type RecoveryControllerHomeMigrationPreflight,
} from '../../runtime/standalone-recovery/controller-home-migration';
import { configureCodegraph, ensureCodegraph } from '../tools/codegraph';
import { isProcessAlive } from '../../runtime/shared/process-tree';
import { systemdUserServicePid, systemdUserUnitName, systemdUserUnitPath } from '../controller/systemd-user';

function output(value: unknown, json = true): void {
  console.log(json ? JSON.stringify(value, null, 2) : String(value));
}

function endpoint(value: string | undefined, optionName: string): string | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${optionName}_INVALID`);
  parsed.hash = '';
  return parsed.toString();
}

function launchdService(label?: string, plistPath?: string, role = 'RECOVERY_TUNNEL'): PublicTunnelServiceConfig | PrimaryConnectorServiceConfig | undefined {
  if (plistPath && !label) throw new Error(`${role}_SERVICE_LABEL_REQUIRED`);
  if (!label) return undefined;
  if (!/^com\.[A-Za-z0-9._-]{1,180}$/.test(label)) throw new Error(`${role}_SERVICE_LABEL_INVALID`);
  if (plistPath && !isAbsolute(plistPath)) throw new Error(`${role}_SERVICE_PLIST_ABSOLUTE_REQUIRED`);
  return { platform: 'launchd', label, ...(plistPath ? { plistPath } : {}) };
}

function systemdRecoveryTunnelService(unitName?: string): SystemdUserRecoveryTunnelServiceConfig | undefined {
  if (!unitName) return undefined;
  const normalized = systemdUserUnitName(unitName);
  if (!/^[A-Za-z0-9_.@-]{1,180}\.service$/.test(normalized)) throw new Error('RECOVERY_TUNNEL_SYSTEMD_UNIT_INVALID');
  return { platform: 'systemd-user', unitName: normalized };
}

export function recoveryOpenAiTunnelDefaultAlias(
  controllerHome: string,
  platform: NodeJS.Platform = process.platform,
  host = hostname(),
): string {
  const suffix = createHash('sha256').update(`${host}\0${platform}\0${resolve(controllerHome)}`).digest('hex').slice(0, 12);
  return `forge-recovery-${suffix}`;
}

export function assertDistinctRecoveryOpenAiTunnelIdentity(
  recovery: RecoveryTunnelServiceConfig | undefined,
  primary: PublicTunnelServiceConfig | undefined,
): void {
  if (recovery?.platform !== 'openai-secure-tunnel' || primary?.platform !== 'openai-secure-tunnel') return;
  if (recovery.alias === primary.alias) throw new Error('RECOVERY_OPENAI_TUNNEL_ALIAS_CONFLICT');
  if (recovery.tunnelId === primary.tunnelId) throw new Error('RECOVERY_OPENAI_TUNNEL_ID_CONFLICT');
}

function openAiTunnelService(input: {
  tunnelId?: string;
  alias?: string;
  runtimeApiKeyRef?: string;
  profile?: string;
  profileDir?: string;
  adminProfile?: string;
  mcpServerUrl: string;
  defaultAlias: string;
  role: string;
}): OpenAiSecureTunnelServiceConfig | undefined {
  const supplied = Boolean(input.tunnelId || input.alias || input.runtimeApiKeyRef || input.profile || input.profileDir || input.adminProfile);
  if (!supplied) return undefined;
  if (!input.tunnelId) throw new Error(`${input.role}_OPENAI_TUNNEL_ID_REQUIRED`);
  if (input.profileDir && !isAbsolute(input.profileDir)) throw new Error(`${input.role}_OPENAI_PROFILE_DIR_ABSOLUTE_REQUIRED`);
  const service: OpenAiSecureTunnelServiceConfig = {
    platform: 'openai-secure-tunnel',
    alias: input.alias?.trim() || input.defaultAlias,
    tunnelId: input.tunnelId.trim(),
    mcpServerUrl: input.mcpServerUrl,
    runtimeApiKeyRef: input.runtimeApiKeyRef?.trim(),
    profile: input.profile?.trim(),
    profileDir: input.profileDir ? resolve(input.profileDir) : undefined,
    adminProfile: input.adminProfile?.trim(),
  };
  try { openAiSecureTunnelConnectArgs(service); } catch (error) {
    throw new Error(`${input.role}_${error instanceof Error ? error.message : 'OPENAI_TUNNEL_CONFIG_INVALID'}`);
  }
  return service;
}


export { recoveryControllerHomeMigrationPreflight };
export type { RecoveryControllerHomeMigrationPreflight };

export interface RecoveryConnectorDependencies {
  platform?: NodeJS.Platform;
  pathExists?: (path: string) => boolean;
  launchdPid?: (role: 'gateway' | 'watchdog') => number | undefined;
  systemdPid?: (role: 'gateway' | 'watchdog') => number | undefined;
  tunnelLaunchdPid?: (label: string) => number | undefined;
  tunnelSystemdPid?: (unitName: string) => number | undefined;
  openAiTunnelStatus?: (service: OpenAiSecureTunnelServiceConfig) => OpenAiSecureTunnelRuntimeObservation;
  processAlive?: (pid: number) => boolean;
}

export interface RecoveryConnectorDescriptor {
  name: 'Forge Recovery';
  identity: RecoveryMachineIdentity;
  transport: 'streamable_http';
  url: string;
  public: boolean;
  readyForChatGPT: boolean;
  installed: boolean;
  currentRelease?: string;
  previousRelease?: string;
  oauth: {
    passphraseConfigured: boolean;
    authorizationServerMetadataUrl: string;
    protectedResourceMetadataUrl: string;
  };
  healthUrl: string;
  services: {
    gateway: { label: string; platform: 'launchd' | 'systemd-user'; serviceInstalled: boolean; plistInstalled: boolean; running: boolean; pid?: number };
    watchdog: { label: string; platform: 'launchd' | 'systemd-user'; serviceInstalled: boolean; plistInstalled: boolean; running: boolean; pid?: number };
    tunnel: {
      configured: boolean;
      platform?: 'launchd' | 'systemd-user' | 'openai-secure-tunnel';
      label?: string;
      unitName?: string;
      alias?: string;
      tunnelId?: string;
      serviceInstalled?: boolean;
      plistInstalled: boolean;
      restartSafe: boolean;
      running: boolean;
      healthy?: boolean;
      ready?: boolean;
      pid?: number;
    };
  };
  tools: string[];
  warnings: string[];
}

export function recoveryConnectorDescriptor(
  controllerHome: string,
  dependencies: RecoveryConnectorDependencies = {},
): RecoveryConnectorDescriptor {
  const home = resolveControllerHome(controllerHome);
  const config = loadRecoveryConfig(home);
  const authority = recoveryReleaseAuthoritySnapshot(home);
  const localOrigin = `http://${config.gateway?.host ?? '127.0.0.1'}:${config.gateway?.port ?? 8787}`;
  const configuredUrl = config.recoveryPublicUrl;
  const url = configuredUrl ?? `${localOrigin}/recovery/mcp`;
  const origin = new URL(url).origin;
  const passphraseConfigured = Boolean(readMcpServiceOAuthPassphrase(home));
  const gatewayIdentity = readRecoveryRuntimeIdentity(home, 'gateway');
  const watchdogIdentity = readRecoveryRuntimeIdentity(home, 'watchdog');
  const platform = dependencies.platform ?? process.platform;
  const servicePlatform: 'launchd' | 'systemd-user' = platform === 'linux' ? 'systemd-user' : 'launchd';
  const pathExists = dependencies.pathExists ?? existsSync;
  const launchdPid = dependencies.launchdPid ?? recoveryLaunchdPid;
  const systemdPid = dependencies.systemdPid ?? ((role: 'gateway' | 'watchdog') => systemdUserServicePid(role === 'gateway' ? RECOVERY_GATEWAY_LABEL : RECOVERY_WATCHDOG_LABEL));
  const managedPid = (role: 'gateway' | 'watchdog') => servicePlatform === 'systemd-user' ? systemdPid(role) : launchdPid(role);
  const processAlive = dependencies.processAlive ?? isProcessAlive;
  const configuredTunnel = config.recoveryTunnelService;
  const tunnelService = configuredTunnel?.platform === 'launchd' ? configuredTunnel : undefined;
  const systemdTunnelService = configuredTunnel?.platform === 'systemd-user' ? configuredTunnel : undefined;
  const openAiTunnelService = configuredTunnel?.platform === 'openai-secure-tunnel' ? configuredTunnel : undefined;
  const tunnelContract = tunnelService ? inspectRecoveryTunnelLaunchdContract(tunnelService) : undefined;
  const tunnelLaunchdPid = tunnelService
    ? (dependencies.tunnelLaunchdPid ?? recoveryLaunchdServicePid)(tunnelService.label)
    : undefined;
  const tunnelPlistInstalled = Boolean(tunnelContract?.plistPath && pathExists(tunnelContract.plistPath));
  const systemdTunnelUnitName = systemdTunnelService?.unitName.trim();
  const systemdTunnelIdentityValid = Boolean(systemdTunnelUnitName && /^[A-Za-z0-9_.@-]{1,180}\.service$/.test(systemdTunnelUnitName));
  const systemdTunnelInstalled = Boolean(systemdTunnelIdentityValid && pathExists(systemdUserUnitPath(systemdTunnelUnitName!)));
  const systemdTunnelPid = systemdTunnelIdentityValid
    ? (dependencies.tunnelSystemdPid ?? ((unitName: string) => systemdUserServicePid(unitName)))(systemdTunnelUnitName!)
    : undefined;
  const openAiTunnelStatus = openAiTunnelService
    ? (dependencies.openAiTunnelStatus ?? ((service: OpenAiSecureTunnelServiceConfig) => {
        const status = spawnSync('tunnel-client', openAiSecureTunnelStatusArgs(service.alias), {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
        });
        return parseOpenAiSecureTunnelRuntimeStatus(status.stdout || '{}', { alias: service.alias, tunnelId: service.tunnelId, mcpServerUrl: service.mcpServerUrl });
      }))(openAiTunnelService)
    : undefined;
  let openAiRestartSafe = false;
  if (openAiTunnelService) {
    try { openAiSecureTunnelConnectArgs(openAiTunnelService); openAiRestartSafe = true; } catch { openAiRestartSafe = false; }
  }
  const tunnelRestartSafe = openAiTunnelService
    ? openAiRestartSafe
    : systemdTunnelService
      ? systemdTunnelIdentityValid && systemdTunnelInstalled
      : Boolean(tunnelContract?.restartSafe);
  const tunnelRunning = openAiTunnelService
    ? openAiTunnelStatus?.running === true
    : systemdTunnelService
      ? Boolean(systemdTunnelPid && processAlive(systemdTunnelPid))
      : Boolean(tunnelLaunchdPid && processAlive(tunnelLaunchdPid));
  const tunnelHealthy = openAiTunnelService ? openAiTunnelStatus?.healthy === true : tunnelRunning;
  const tunnelReady = openAiTunnelService ? openAiTunnelStatus?.ok === true : tunnelRestartSafe && tunnelRunning;
  const gatewayPlistInstalled = pathExists(authority.gatewayLaunchAgent);
  const watchdogPlistInstalled = pathExists(authority.watchdogLaunchAgent);
  const gatewayServiceInstalled = servicePlatform === 'systemd-user'
    ? pathExists(systemdUserUnitPath(RECOVERY_GATEWAY_LABEL))
    : gatewayPlistInstalled;
  const watchdogServiceInstalled = servicePlatform === 'systemd-user'
    ? pathExists(systemdUserUnitPath(RECOVERY_WATCHDOG_LABEL))
    : watchdogPlistInstalled;
  const gatewayManagedPid = managedPid('gateway');
  const watchdogManagedPid = managedPid('watchdog');
  const gatewayRunning = Boolean(
    gatewayIdentity
    && gatewayManagedPid
    && gatewayIdentity.pid === gatewayManagedPid
    && processAlive(gatewayIdentity.pid)
    && authority.current
    && gatewayIdentity.releaseRevision === authority.current.releaseRevision
    && gatewayIdentity.manifestSha256 === authority.current.manifestSha256,
  );
  const watchdogRunning = Boolean(
    watchdogIdentity
    && watchdogManagedPid
    && watchdogIdentity.pid === watchdogManagedPid
    && processAlive(watchdogIdentity.pid)
    && authority.current
    && watchdogIdentity.releaseRevision === authority.current.releaseRevision
    && watchdogIdentity.manifestSha256 === authority.current.manifestSha256,
  );
  const installed = Boolean(authority.current && gatewayServiceInstalled && watchdogServiceInstalled);
  const publicEndpoint = Boolean(configuredUrl?.startsWith('https://'));
  const warnings: string[] = [];
  if (!authority.current) warnings.push('No current immutable Forge Recovery release is installed. Run forge recovery install.');
  if (!gatewayServiceInstalled || !watchdogServiceInstalled) warnings.push(`Forge Recovery ${servicePlatform} services are not fully installed. Run forge recovery install.`);
  if (!gatewayRunning || !watchdogRunning) warnings.push('Forge Recovery Gateway or Watchdog is not running on the current Recovery release.');
  if (!configuredTunnel) warnings.push('Recovery is loopback-only. Configure a dedicated OpenAI Secure MCP Tunnel or an HTTPS tunnel service before adding it to ChatGPT.');
  else if (openAiTunnelService) {
    if (!tunnelRestartSafe) warnings.push('The dedicated OpenAI Recovery tunnel must use a valid alias, tunnel id, loopback MCP endpoint, and env:/file: runtime API key reference.');
    else if (!tunnelRunning) warnings.push(`The dedicated OpenAI Recovery tunnel runtime ${openAiTunnelService.alias} is not running.`);
    else if (!tunnelHealthy || !tunnelReady) warnings.push(`The dedicated OpenAI Recovery tunnel runtime ${openAiTunnelService.alias} is not healthy and ready.`);
  } else if (!configuredUrl) warnings.push('The configured Recovery tunnel requires --recovery-public-url.');
  else if (!publicEndpoint) warnings.push('ChatGPT Recovery Connector requires an HTTPS public endpoint for managed public tunnels.');
  else if (systemdTunnelService && !systemdTunnelInstalled) warnings.push(`The dedicated Forge Recovery systemd-user tunnel unit ${systemdTunnelUnitName ?? systemdTunnelService.unitName} is not installed.`);
  else if (systemdTunnelService && !tunnelRunning) warnings.push(`The dedicated Forge Recovery systemd-user tunnel unit ${systemdTunnelUnitName} is not running.`);
  else if (!systemdTunnelService && !tunnelPlistInstalled) warnings.push('The dedicated Forge Recovery tunnel plist is not installed.');
  else if (!systemdTunnelService && !tunnelRestartSafe) warnings.push('The dedicated Forge Recovery tunnel plist must use RunAtLoad=true and unconditional KeepAlive=true.');
  else if (!systemdTunnelService && !tunnelRunning) warnings.push('The dedicated Forge Recovery tunnel service is not running.');
  if (!passphraseConfigured) warnings.push('MCP OAuth passphrase is not configured. Run forge mcp setup chatgpt first.');

  return {
    name: 'Forge Recovery',
    identity: recoveryMachineIdentity(config, { platform }),
    transport: 'streamable_http',
    url,
    public: publicEndpoint,
    readyForChatGPT: installed && gatewayRunning && watchdogRunning && tunnelReady && (openAiTunnelService ? true : publicEndpoint) && passphraseConfigured,
    installed,
    currentRelease: authority.current?.releaseRevision,
    previousRelease: authority.previous?.releaseRevision,
    oauth: {
      passphraseConfigured,
      authorizationServerMetadataUrl: `${origin}/.well-known/oauth-authorization-server`,
      protectedResourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/recovery/mcp`,
    },
    healthUrl: `${origin}/recovery/health`,
    services: {
      gateway: {
        label: RECOVERY_GATEWAY_LABEL,
        platform: servicePlatform,
        serviceInstalled: gatewayServiceInstalled,
        plistInstalled: gatewayPlistInstalled,
        running: gatewayRunning,
        ...(gatewayIdentity ? { pid: gatewayIdentity.pid } : {}),
      },
      watchdog: {
        label: RECOVERY_WATCHDOG_LABEL,
        platform: servicePlatform,
        serviceInstalled: watchdogServiceInstalled,
        plistInstalled: watchdogPlistInstalled,
        running: watchdogRunning,
        ...(watchdogIdentity ? { pid: watchdogIdentity.pid } : {}),
      },
      tunnel: {
        configured: Boolean(configuredTunnel),
        ...(configuredTunnel ? { platform: configuredTunnel.platform } : {}),
        ...(tunnelService ? { label: tunnelService.label } : {}),
        ...(systemdTunnelService ? { unitName: systemdTunnelUnitName ?? systemdTunnelService.unitName } : {}),
        ...(openAiTunnelService ? { alias: openAiTunnelService.alias, tunnelId: openAiTunnelService.tunnelId } : {}),
        serviceInstalled: openAiTunnelService ? openAiRestartSafe : systemdTunnelService ? systemdTunnelInstalled : tunnelPlistInstalled,
        plistInstalled: tunnelPlistInstalled,
        restartSafe: tunnelRestartSafe,
        running: tunnelRunning,
        ...(openAiTunnelService ? { healthy: tunnelHealthy, ready: tunnelReady } : {}),
        ...(systemdTunnelPid ? { pid: systemdTunnelPid } : tunnelLaunchdPid ? { pid: tunnelLaunchdPid } : {}),
      },
    },
    tools: RECOVERY_TOOLS.map((tool) => tool.name),
    warnings,
  };
}

export function recoveryConnectorHasExternalTransport(
  connector: Pick<RecoveryConnectorDescriptor, 'public' | 'services'>,
): boolean {
  return connector.public || connector.services.tunnel.platform === 'openai-secure-tunnel';
}

export interface RecoveryConnectorVerificationDependencies {
  fetcher?: typeof fetch;
  random?: (size: number) => Buffer;
}

export interface RecoveryConnectorVerificationResult {
  ok: boolean;
  forgeVersion: string;
  connector: RecoveryConnectorDescriptor;
  probes: {
    publicHealth: { ok: boolean; status?: number; version?: string; releaseRevision?: string };
    authorizationMetadata: { ok: boolean; status?: number };
    protectedResourceMetadata: { ok: boolean; status?: number };
    unauthenticatedChallenge: { ok: boolean; status?: number };
    oauthPkce: { ok: boolean; registrationStatus?: number; authorizationStatus?: number; tokenStatus?: number };
    mcp: {
      ok: boolean;
      initializeStatus?: number;
      initializedNotificationStatus?: number;
      protocolVersion?: string;
      serverName?: string;
      serverVersion?: string;
      tools?: string[];
      runtimeStatusCall?: boolean;
      listReleasesCall?: boolean;
    };
  };
  failures: string[];
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try { return jsonObject(await response.json()); } catch { return {}; }
}

export async function verifyRecoveryConnector(
  controllerHome: string,
  dependencies: RecoveryConnectorVerificationDependencies = {},
): Promise<RecoveryConnectorVerificationResult> {
  const home = resolveControllerHome(controllerHome);
  const connector = recoveryConnectorDescriptor(home);
  const fetcher = dependencies.fetcher ?? fetch;
  const random = dependencies.random ?? randomBytes;
  const failures: string[] = [];
  const probes: RecoveryConnectorVerificationResult['probes'] = {
    publicHealth: { ok: false },
    authorizationMetadata: { ok: false },
    protectedResourceMetadata: { ok: false },
    unauthenticatedChallenge: { ok: false },
    oauthPkce: { ok: false },
    mcp: { ok: false },
  };
  const request = (url: string, init: RequestInit = {}) => fetcher(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });

  if (!connector.readyForChatGPT) failures.push(...connector.warnings.map((warning) => `readiness: ${warning}`));
  if (!recoveryConnectorHasExternalTransport(connector)) {
    failures.push('readiness: Recovery Connector has neither an HTTPS public endpoint nor a dedicated OpenAI Secure MCP Tunnel.');
  }

  const origin = new URL(connector.url).origin;
  try {
    const response = await request(connector.healthUrl, { headers: { accept: 'application/json' } });
    const body = await responseJson(response);
    const version = typeof body.version === 'string' ? body.version : undefined;
    const releaseRevision = typeof body.releaseRevision === 'string' ? body.releaseRevision : undefined;
    const ok = response.status === 200
      && body.status === 'ok'
      && version === FORGE_VERSION
      && (!connector.currentRelease || releaseRevision === connector.currentRelease);
    probes.publicHealth = { ok, status: response.status, ...(version ? { version } : {}), ...(releaseRevision ? { releaseRevision } : {}) };
    if (!ok) failures.push(`publicHealth: expected HTTP 200, Forge ${FORGE_VERSION}, and current Recovery release identity.`);
  } catch (error) {
    failures.push(`publicHealth: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const response = await request(connector.oauth.authorizationServerMetadataUrl, { headers: { accept: 'application/json' } });
    const body = await responseJson(response);
    const ok = response.status === 200
      && body.issuer === origin
      && body.authorization_endpoint === `${origin}/recovery/oauth/authorize`
      && body.token_endpoint === `${origin}/recovery/oauth/token`
      && body.registration_endpoint === `${origin}/recovery/oauth/register`;
    probes.authorizationMetadata = { ok, status: response.status };
    if (!ok) failures.push('authorizationMetadata: OAuth authorization-server metadata is incomplete or inconsistent.');
  } catch (error) {
    failures.push(`authorizationMetadata: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const response = await request(connector.oauth.protectedResourceMetadataUrl, { headers: { accept: 'application/json' } });
    const body = await responseJson(response);
    const authorizationServers = Array.isArray(body.authorization_servers) ? body.authorization_servers : [];
    const ok = response.status === 200 && body.resource === connector.url && authorizationServers.includes(origin);
    probes.protectedResourceMetadata = { ok, status: response.status };
    if (!ok) failures.push('protectedResourceMetadata: OAuth protected-resource metadata is incomplete or inconsistent.');
  } catch (error) {
    failures.push(`protectedResourceMetadata: ${error instanceof Error ? error.message : String(error)}`);
  }

  const initializeBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'forge-recovery-verifier', version: FORGE_VERSION },
    },
  });
  try {
    const response = await request(connector.url, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: initializeBody,
    });
    const challenge = response.headers.get('www-authenticate') ?? '';
    const ok = response.status === 401
      && /\bBearer\b/i.test(challenge)
      && challenge.includes('error="invalid_token"')
      && challenge.includes('oauth-protected-resource');
    probes.unauthenticatedChallenge = { ok, status: response.status };
    if (!ok) failures.push('unauthenticatedChallenge: Recovery MCP did not return the expected OAuth Bearer challenge.');
  } catch (error) {
    failures.push(`unauthenticatedChallenge: ${error instanceof Error ? error.message : String(error)}`);
  }

  const passphrase = readMcpServiceOAuthPassphrase(home);
  if (!passphrase) {
    failures.push('oauthPkce: MCP OAuth passphrase is not configured.');
  } else {
    try {
      const redirectUri = 'http://127.0.0.1/forge-recovery-oauth-callback';
      const registration = await request(`${origin}/recovery/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Forge Recovery Verification',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      const registrationBody = await responseJson(registration);
      const clientId = typeof registrationBody.client_id === 'string' ? registrationBody.client_id : '';
      if (registration.status !== 201 || !clientId) throw new Error(`dynamic registration HTTP ${registration.status}`);

      const verifier = random(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = random(16).toString('hex');
      const authorization = await request(`${origin}/recovery/oauth/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'forge',
          resource: connector.url,
          state,
          passphrase,
        }),
      });
      const location = authorization.headers.get('location');
      const callback = location ? new URL(location) : undefined;
      const code = callback?.searchParams.get('code') ?? '';
      if (authorization.status !== 302 || !callback || callback.searchParams.get('state') !== state || !code) {
        throw new Error(`authorization HTTP ${authorization.status}`);
      }

      const tokenResponse = await request(`${origin}/recovery/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      const tokenBody = await responseJson(tokenResponse);
      const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
      if (tokenResponse.status !== 200 || tokenBody.token_type !== 'Bearer' || !accessToken) {
        throw new Error(`token HTTP ${tokenResponse.status}`);
      }
      probes.oauthPkce = {
        ok: true,
        registrationStatus: registration.status,
        authorizationStatus: authorization.status,
        tokenStatus: tokenResponse.status,
      };

      const rpc = async (id: number | undefined, method: string, params?: Record<string, unknown>) => {
        const response = await request(connector.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-06-18',
          },
          body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
        });
        if (method === 'notifications/initialized') return { response, result: {} as Record<string, unknown> };
        const body = await responseJson(response);
        const rpcError = jsonObject(body.error);
        if (response.status !== 200 || Object.keys(rpcError).length > 0) {
          throw new Error(`${method} HTTP ${response.status}${typeof rpcError.message === 'string' ? `: ${rpcError.message}` : ''}`);
        }
        return { response, result: jsonObject(body.result) };
      };

      const initialized = await rpc(11, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'forge-recovery-verifier', version: FORGE_VERSION },
      });
      const initializedNotification = await rpc(undefined, 'notifications/initialized');
      const listed = await rpc(12, 'tools/list');
      const tools = Array.isArray(listed.result.tools)
        ? listed.result.tools.map((tool) => jsonObject(tool).name).filter((name): name is string => typeof name === 'string')
        : [];
      const expectedTools = RECOVERY_TOOLS.map((tool) => tool.name);
      const runtimeStatusCall = await rpc(13, 'tools/call', { name: 'runtime_status', arguments: {} });
      const listReleasesCall = await rpc(14, 'tools/call', { name: 'list_releases', arguments: {} });
      const initializedResult = initialized.result;
      const serverInfo = jsonObject(initializedResult.serverInfo);
      const mcpOk = initialized.response.status === 200
        && initializedNotification.response.status === 202
        && initializedResult.protocolVersion === '2025-06-18'
        && serverInfo.name === 'forge-standalone-recovery'
        && serverInfo.version === FORGE_VERSION
        && JSON.stringify(tools) === JSON.stringify(expectedTools)
        && runtimeStatusCall.response.status === 200
        && listReleasesCall.response.status === 200;
      probes.mcp = {
        ok: mcpOk,
        initializeStatus: initialized.response.status,
        initializedNotificationStatus: initializedNotification.response.status,
        protocolVersion: typeof initializedResult.protocolVersion === 'string' ? initializedResult.protocolVersion : undefined,
        serverName: typeof serverInfo.name === 'string' ? serverInfo.name : undefined,
        serverVersion: typeof serverInfo.version === 'string' ? serverInfo.version : undefined,
        tools,
        runtimeStatusCall: runtimeStatusCall.response.status === 200,
        listReleasesCall: listReleasesCall.response.status === 200,
      };
      if (!mcpOk) failures.push('mcp: initialize, Forge version, tool surface, or read-only calls did not match the Recovery contract.');
    } catch (error) {
      failures.push(`oauthPkce/mcp: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: failures.length === 0, forgeVersion: FORGE_VERSION, connector, probes, failures };
}

export function buildRecoveryCommand(): Command {
  const command = new Command('recovery').description('Install, inspect, and configure the independent Forge Recovery Connector');

  command.command('connector')
    .description('Print the exact ChatGPT Recovery Connector URL, OAuth metadata, services, and readiness')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action((opts: { controllerHome: string }) => {
      output(recoveryConnectorDescriptor(opts.controllerHome));
    });

  command.command('verify-connector')
    .description('Verify the public Recovery tunnel, OAuth PKCE flow, MCP handshake, tools, and read-only calls')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const result = await verifyRecoveryConnector(opts.controllerHome);
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('status')
    .description('Read independent Recovery and canonical Runtime status')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      output({ connector: recoveryConnectorDescriptor(home), runtime: await runtimeStatus(loadRecoveryConfig(home)) });
    });

  command.command('verify')
    .description('Run independent whole-Runtime, release, MCP, and Recovery verification')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await verifyStableRuntime(loadRecoveryConfig(home));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('restart-runtime')
    .description('Restart the canonical Forge Runtime service and require whole-Runtime verification')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await restartPrimaryRuntime(loadRecoveryConfig(home));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('bootstrap-cutover')
    .description('One-time external lifecycle bootstrap: upgrade standalone Recovery, activate current Runtime source transactionally, then restart the explicit primary Connector')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .requiredOption('--repo <path>', 'Forge source repository root used for Recovery and Runtime immutable releases')
    .requiredOption('--primary-connector-service-label <label>', 'Primary OAuth/Connector launchd label')
    .option('--primary-connector-service-plist <path>', 'Absolute primary OAuth/Connector launchd plist path')
    .option('--configure-codegraph', 'Initialize/sync CodeGraph and configure repository-scoped MCP for Codex and Claude during the bootstrap')
    .action(async (opts: {
      controllerHome: string;
      repo: string;
      primaryConnectorServiceLabel: string;
      primaryConnectorServicePlist?: string;
      configureCodegraph?: boolean;
    }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const repoRoot = resolve(opts.repo);
      const current = loadRecoveryConfig(home);
      const primaryConnectorBase = launchdService(
        opts.primaryConnectorServiceLabel,
        opts.primaryConnectorServicePlist,
        'RECOVERY_PRIMARY_CONNECTOR',
      ) as PrimaryConnectorServiceConfig;
      const primaryConnectorService: PrimaryConnectorServiceConfig = {
        ...primaryConnectorBase,
        ...(current.primaryConnectorService?.localMcpUrl ? { localMcpUrl: current.primaryConnectorService.localMcpUrl } : {}),
      };
      const installed = await installStandaloneRecovery({
        controllerHome: home,
        repoRoot,
        port: current.gateway?.port ?? 8787,
        publicMcpUrl: current.publicMcpUrl,
        recoveryPublicUrl: current.recoveryPublicUrl,
        recoveryTunnelService: current.recoveryTunnelService,
        primaryPublicTunnelService: current.primaryPublicTunnelService,
        primaryRuntimeService: current.primaryRuntimeService ?? defaultPrimaryRuntimeServiceConfig(),
        primaryConnectorService,
      });
      const refreshed = loadRecoveryConfig(home);
      const runtime = await stageAndActivateConfiguredRuntimeRelease(refreshed);
      if (!runtime.ok) {
        output({ ok: false, phase: 'runtime_activation', recovery: installed, runtime });
        process.exitCode = 1;
        return;
      }
      let codegraph: Record<string, unknown> | undefined;
      let codegraphOk = true;
      if (opts.configureCodegraph === true) {
        const ensured = ensureCodegraph({ repoRoot, init: true, sync: true, host: 'both' });
        const configured = configureCodegraph({ repoRoot, target: 'both', location: 'global' });
        codegraphOk = !ensured.actions.some((entry) => entry.status === 'failed')
          && !configured.actions.some((entry) => entry.status === 'failed');
        codegraph = { ensured, configured };
      }
      const connector = await restartPrimaryConnector(refreshed);
      const ok = connector.ok && codegraphOk;
      output({ ok, phase: !connector.ok ? 'connector_restart' : !codegraphOk ? 'codegraph_configuration' : 'complete', recovery: installed, runtime, ...(codegraph ? { codegraph } : {}), connector });
      if (!ok) process.exitCode = 1;
    });

  command.command('restart-connector')
    .description('Restart the explicitly configured primary OAuth/Connector launchd service through standalone Recovery')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await restartPrimaryConnector(loadRecoveryConfig(home));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('stage-and-activate-runtime')
    .description('Stage current configured Runtime source as an immutable release and activate it transactionally through standalone Recovery')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await stageAndActivateConfiguredRuntimeRelease(loadRecoveryConfig(home));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('recover')
    .description('Stop the canonical Runtime, restore the attested previous whole release and SQLite backup, restart it, and require verification')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await recoverPrimaryRuntime(loadRecoveryConfig(home));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('rollback')
    .description('While the Canonical Runtime is stopped, atomically restore its attested previous whole-Runtime release and SQLite backup')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await rollbackPrevious(loadRecoveryConfig(home));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('restart')
    .description('Restart the independent Forge Recovery Gateway and require its local health endpoint')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action(async (opts: { controllerHome: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await restartRecoveryGateway(loadRecoveryConfig(home));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('activate-runtime')
    .description('Activate an already staged immutable Runtime release: stop, atomically switch whole-release authority, start, verify, and restore the previous whole release on failure')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .requiredOption('--release-manifest <path>', 'Absolute manifest.json of the staged immutable Runtime release')
    .action(async (opts: { controllerHome: string; releaseManifest: string }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const result = await activateRuntimeRelease(loadRecoveryConfig(home), resolve(opts.releaseManifest));
      output(result);
      if (!result.ok) process.exitCode = 1;
    });

  command.command('migrate-controller-home')
    .description('Transactionally relocate Forge Controller Home on Linux/WSL through an independent transient systemd worker')
    .requiredOption('--from <path>', 'Current Controller Home authority')
    .requiredOption('--controller-home <path>', 'Destination user-level Controller Home')
    .option('--archive-suffix <suffix>', 'Stable suffix for an authority-free destination shell archive')
    .option('--timeout-ms <ms>', 'Overall migration transaction timeout in milliseconds', '240000')
    .action(async (opts: { from: string; controllerHome: string; archiveSuffix?: string; timeoutMs: string }) => {
      if (process.platform !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
      const timeoutMs = Number(opts.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 900_000) {
        throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_TIMEOUT_INVALID');
      }
      const scheduled = scheduleLinuxControllerHomeMigration({
        sourceHome: resolve(opts.from),
        destinationHome: resolveControllerHome(opts.controllerHome),
        ...(opts.archiveSuffix ? { archiveSuffix: opts.archiveSuffix } : {}),
        timeoutMs,
      });
      output({
        status: 'migration_scheduled',
        operationId: scheduled.request.operationId,
        sourceHome: scheduled.request.sourceHome,
        destinationHome: scheduled.request.destinationHome,
        workerUnit: scheduled.request.workerUnit,
        receiptPath: scheduled.request.receiptPath,
        logPath: scheduled.request.logPath,
        preflight: scheduled.preflight,
      });
    });

  command.command('migrate-controller-home-worker')
    .description('Internal Linux/WSL transient worker for a durable Controller Home migration request')
    .requiredOption('--request <path>', 'Durable migration request written before service cutover')
    .action(async (opts: { request: string }) => {
      if (process.platform !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
      const receipt = await runLinuxControllerHomeMigrationRequest(resolve(opts.request));
      // A durable terminal receipt, including failed-after-rollback, is a completed worker transaction.
      // Only an unhandled process failure before a terminal receipt should trigger systemd Restart=on-failure.
      output(receipt);
    });

  command.command('rollback-controller-home-migration')
    .description('Rollback a stopped Controller Home relocation before any writer is restarted')
    .requiredOption('--from <path>', 'Original Controller Home path')
    .requiredOption('--controller-home <path>', 'Relocated user-level Controller Home path')
    .option('--archived-destination-home <path>', 'Archived authority-free destination shell returned by migration')
    .action(async (opts: { from: string; controllerHome: string; archivedDestinationHome?: string }) => {
      if (process.platform !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
      const sourceHome = resolve(opts.from);
      const destinationHome = resolveControllerHome(opts.controllerHome);
      const preflight = recoveryControllerHomeMigrationPreflight(destinationHome, sourceHome);
      if (preflight.liveOwners.length > 0) {
        throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_OWNERS_LIVE: ${preflight.liveOwners.map((entry) => `${entry.label}:${entry.pid}`).join(',')}`);
      }
      const relocation: StoppedControllerHomeAuthorityRelocation = {
        migrated: true,
        sourceHome,
        destinationHome,
        ...(opts.archivedDestinationHome ? { archivedDestinationHome: resolve(opts.archivedDestinationHome) } : {}),
      };
      rollbackStoppedControllerHomeAuthorityRelocation(relocation);
      output({ status: 'rolled_back', relocation });
    });

  command.command('install')
    .description('Build and activate the independent Forge Recovery Gateway and Watchdog release')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .option('--port <port>', 'Loopback Recovery Gateway port', '8787')
    .option('--public-mcp-url <url>', 'Primary Forge MCP public URL')
    .option('--recovery-public-url <url>', 'Dedicated Forge Recovery MCP public URL')
    .option('--recovery-tunnel-service-label <label>', 'Dedicated Recovery tunnel launchd label')
    .option('--recovery-tunnel-service-plist <path>', 'Absolute Recovery tunnel launchd plist path')
    .option('--recovery-tunnel-systemd-unit <unit>', 'Dedicated Recovery systemd --user tunnel unit (Linux only)')
    .option('--recovery-openai-tunnel-id <id>', 'Dedicated Recovery OpenAI Secure MCP Tunnel id')
    .option('--recovery-openai-tunnel-alias <alias>', 'Dedicated Recovery tunnel-client runtime alias (default: machine-specific forge-recovery-<id>)')
    .option('--recovery-openai-runtime-api-key-ref <ref>', 'Recovery tunnel runtime API key reference (env:NAME or file:/absolute/path)')
    .option('--recovery-openai-profile <profile>', 'Optional tunnel-client runtime profile name for Recovery')
    .option('--recovery-openai-profile-dir <path>', 'Optional absolute tunnel-client profile directory for Recovery')
    .option('--recovery-openai-admin-profile <profile>', 'Optional tunnel-client admin profile used for Recovery runtime connect')
    .option('--primary-connector-service-label <label>', 'Primary OAuth/Connector launchd label managed by standalone Recovery')
    .option('--primary-connector-service-plist <path>', 'Absolute primary OAuth/Connector launchd plist path')
    .option('--primary-connector-local-url <url>', 'Local primary OAuth/Connector MCP endpoint used to distinguish Connector from tunnel failures')
    .option('--primary-tunnel-service-label <label>', 'Primary public MCP tunnel launchd label managed by standalone Recovery')
    .option('--primary-tunnel-service-plist <path>', 'Absolute primary public MCP tunnel launchd plist path')
    .option('--primary-openai-tunnel-id <id>', 'Primary OpenAI Secure MCP Tunnel id managed by Recovery')
    .option('--primary-openai-tunnel-alias <alias>', 'Primary tunnel-client runtime alias (default: forge)')
    .option('--primary-openai-runtime-api-key-ref <ref>', 'Primary tunnel runtime API key reference (env:NAME or file:/absolute/path)')
    .option('--primary-openai-profile <profile>', 'Optional tunnel-client runtime profile name for primary Forge')
    .option('--primary-openai-profile-dir <path>', 'Optional absolute tunnel-client profile directory for primary Forge')
    .option('--primary-openai-admin-profile <profile>', 'Optional tunnel-client admin profile used for primary runtime connect')
    .option('--primary-runtime-source-root <path>', 'Stable canonical/package source used by Recovery for future Runtime staging')
    .option('--stage-only', 'Build and canary the Recovery release without activating services')
    .action(async (opts: {
      controllerHome: string;
      port: string;
      publicMcpUrl?: string;
      recoveryPublicUrl?: string;
      recoveryTunnelServiceLabel?: string;
      recoveryTunnelServicePlist?: string;
      recoveryTunnelSystemdUnit?: string;
      recoveryOpenaiTunnelId?: string;
      recoveryOpenaiTunnelAlias?: string;
      recoveryOpenaiRuntimeApiKeyRef?: string;
      recoveryOpenaiProfile?: string;
      recoveryOpenaiProfileDir?: string;
      recoveryOpenaiAdminProfile?: string;
      primaryConnectorServiceLabel?: string;
      primaryConnectorServicePlist?: string;
      primaryConnectorLocalUrl?: string;
      primaryTunnelServiceLabel?: string;
      primaryTunnelServicePlist?: string;
      primaryOpenaiTunnelId?: string;
      primaryOpenaiTunnelAlias?: string;
      primaryOpenaiRuntimeApiKeyRef?: string;
      primaryOpenaiProfile?: string;
      primaryOpenaiProfileDir?: string;
      primaryOpenaiAdminProfile?: string;
      primaryRuntimeSourceRoot?: string;
      stageOnly?: boolean;
    }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RECOVERY_PORT_INVALID');
      const recoveryLaunchdTunnel = launchdService(opts.recoveryTunnelServiceLabel, opts.recoveryTunnelServicePlist, 'RECOVERY_TUNNEL') as PublicTunnelServiceConfig | undefined;
      const recoverySystemdTunnel = systemdRecoveryTunnelService(opts.recoveryTunnelSystemdUnit);
      if (recoveryLaunchdTunnel && process.platform === 'linux') throw new Error('RECOVERY_TUNNEL_LAUNCHD_UNSUPPORTED_ON_LINUX');
      if (recoverySystemdTunnel && process.platform !== 'linux') throw new Error('RECOVERY_TUNNEL_SYSTEMD_UNSUPPORTED_ON_THIS_PLATFORM');
      const recoveryLocalMcpUrl = `http://127.0.0.1:${port}/recovery/mcp`;
      const recoveryOpenAiTunnel = openAiTunnelService({
        tunnelId: opts.recoveryOpenaiTunnelId,
        alias: opts.recoveryOpenaiTunnelAlias,
        runtimeApiKeyRef: opts.recoveryOpenaiRuntimeApiKeyRef,
        profile: opts.recoveryOpenaiProfile,
        profileDir: opts.recoveryOpenaiProfileDir,
        adminProfile: opts.recoveryOpenaiAdminProfile,
        mcpServerUrl: recoveryLocalMcpUrl,
        defaultAlias: recoveryOpenAiTunnelDefaultAlias(home),
        role: 'RECOVERY',
      });
      const recoveryTunnelOwners = [recoveryLaunchdTunnel, recoverySystemdTunnel, recoveryOpenAiTunnel].filter(Boolean);
      if (recoveryTunnelOwners.length > 1) throw new Error('RECOVERY_TUNNEL_OWNER_CONFLICT');
      const recoveryTunnelService: RecoveryTunnelServiceConfig | undefined = recoveryOpenAiTunnel ?? recoverySystemdTunnel ?? recoveryLaunchdTunnel;

      const primaryConnectorLaunchd = launchdService(opts.primaryConnectorServiceLabel, opts.primaryConnectorServicePlist, 'RECOVERY_PRIMARY_CONNECTOR') as PrimaryConnectorServiceConfig | undefined;
      const primaryConnectorLocalUrl = endpoint(opts.primaryConnectorLocalUrl, 'RECOVERY_PRIMARY_CONNECTOR_LOCAL_URL');
      let primaryConnectorService: PrimaryConnectorServiceConfig | undefined;
      if (process.platform === 'linux') {
        if (primaryConnectorLaunchd) throw new Error('RECOVERY_PRIMARY_CONNECTOR_LAUNCHD_UNSUPPORTED_ON_LINUX');
        primaryConnectorService = primaryConnectorLocalUrl ? { platform: 'systemd-user', localMcpUrl: primaryConnectorLocalUrl } : undefined;
      } else {
        if (primaryConnectorLocalUrl && !primaryConnectorLaunchd) throw new Error('RECOVERY_PRIMARY_CONNECTOR_LABEL_REQUIRED_FOR_LOCAL_URL');
        primaryConnectorService = primaryConnectorLaunchd
          ? { ...primaryConnectorLaunchd, ...(primaryConnectorLocalUrl ? { localMcpUrl: primaryConnectorLocalUrl } : {}) }
          : undefined;
      }

      const primaryLaunchdTunnel = launchdService(opts.primaryTunnelServiceLabel, opts.primaryTunnelServicePlist, 'RECOVERY_PRIMARY_TUNNEL') as PublicTunnelServiceConfig | undefined;
      const primaryOpenAiTunnel = primaryConnectorLocalUrl ? openAiTunnelService({
        tunnelId: opts.primaryOpenaiTunnelId,
        alias: opts.primaryOpenaiTunnelAlias,
        runtimeApiKeyRef: opts.primaryOpenaiRuntimeApiKeyRef,
        profile: opts.primaryOpenaiProfile,
        profileDir: opts.primaryOpenaiProfileDir,
        adminProfile: opts.primaryOpenaiAdminProfile,
        mcpServerUrl: primaryConnectorLocalUrl,
        defaultAlias: 'forge',
        role: 'RECOVERY_PRIMARY',
      }) : undefined;
      const primaryOpenAiOptionsSupplied = Boolean(opts.primaryOpenaiTunnelId || opts.primaryOpenaiTunnelAlias || opts.primaryOpenaiRuntimeApiKeyRef || opts.primaryOpenaiProfile || opts.primaryOpenaiProfileDir || opts.primaryOpenaiAdminProfile);
      if (primaryOpenAiOptionsSupplied && !primaryConnectorLocalUrl) throw new Error('RECOVERY_PRIMARY_CONNECTOR_LOCAL_URL_REQUIRED_FOR_OPENAI_TUNNEL');
      if (primaryLaunchdTunnel && primaryOpenAiTunnel) throw new Error('RECOVERY_PRIMARY_TUNNEL_OWNER_CONFLICT');
      const primaryPublicTunnelService = primaryOpenAiTunnel ?? primaryLaunchdTunnel;
      if (primaryPublicTunnelService && !primaryConnectorService) throw new Error('RECOVERY_PRIMARY_CONNECTOR_REQUIRED_FOR_PRIMARY_TUNNEL');
      assertDistinctRecoveryOpenAiTunnelIdentity(recoveryTunnelService, primaryPublicTunnelService);

      const recoveryPublicUrl = endpoint(opts.recoveryPublicUrl, 'RECOVERY_PUBLIC_URL');
      if (recoveryOpenAiTunnel && recoveryPublicUrl) throw new Error('RECOVERY_OPENAI_TUNNEL_PUBLIC_URL_CONFLICT');
      if ((recoveryLaunchdTunnel || recoverySystemdTunnel) && !recoveryPublicUrl) throw new Error('RECOVERY_PUBLIC_URL_AND_TUNNEL_SERVICE_MUST_BE_CONFIGURED_TOGETHER');
      if (!recoveryTunnelService && recoveryPublicUrl) throw new Error('RECOVERY_PUBLIC_URL_AND_TUNNEL_SERVICE_MUST_BE_CONFIGURED_TOGETHER');

      const packageRoot = resolve(import.meta.dir, '..', '..', '..');
      const primaryRuntimeSourceRoot = opts.primaryRuntimeSourceRoot ? resolve(opts.primaryRuntimeSourceRoot) : packageRoot;
      if (!opts.stageOnly && /[\\/]\.forge[\\/]managed-worktrees[\\/]/.test(primaryRuntimeSourceRoot)) {
        throw new Error('RECOVERY_PRIMARY_RUNTIME_SOURCE_ROOT_DURABLE_REQUIRED');
      }
      const result = await installStandaloneRecovery({
        controllerHome: home,
        repoRoot: primaryRuntimeSourceRoot,
        sourceRoot: packageRoot,
        port,
        stageOnly: opts.stageOnly === true,
        primaryRuntimeService: defaultPrimaryRuntimeServiceConfig(),
        publicMcpUrl: endpoint(opts.publicMcpUrl, 'PUBLIC_MCP_URL'),
        recoveryPublicUrl,
        recoveryTunnelService,
        primaryPublicTunnelService,
        primaryConnectorService,
      });
      output({
        status: opts.stageOnly ? 'staged' : 'installed',
        staged: result.staged.release,
        activation: result.activated,
        connector: recoveryConnectorDescriptor(home),
      });
    });

  return command;
}
