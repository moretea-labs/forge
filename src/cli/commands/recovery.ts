import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { Command } from 'commander';
import { readMcpServiceOAuthPassphrase } from '../mcp/auth';
import { resolveControllerHome } from '../repositories/controller-home';
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
  loadRecoveryConfig,
  recoverPrimaryRuntime,
  restartPrimaryRuntime,
  restartRecoveryGateway,
  rollbackPrevious,
  runtimeStatus,
  verifyStableRuntime,
  type PublicTunnelServiceConfig,
} from '../../runtime/standalone-recovery/core';
import { readRecoveryRuntimeIdentity } from '../../runtime/standalone-recovery/release';
import { isProcessAlive } from '../../runtime/shared/process-tree';

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

function launchdService(label?: string, plistPath?: string): PublicTunnelServiceConfig | undefined {
  if (plistPath && !label) throw new Error('RECOVERY_TUNNEL_SERVICE_LABEL_REQUIRED');
  if (!label) return undefined;
  if (!/^com\.[A-Za-z0-9._-]{1,180}$/.test(label)) throw new Error('RECOVERY_TUNNEL_SERVICE_LABEL_INVALID');
  if (plistPath && !isAbsolute(plistPath)) throw new Error('RECOVERY_TUNNEL_SERVICE_PLIST_ABSOLUTE_REQUIRED');
  return { platform: 'launchd', label, ...(plistPath ? { plistPath } : {}) };
}

export interface RecoveryConnectorDependencies {
  pathExists?: (path: string) => boolean;
  launchdPid?: (role: 'gateway' | 'watchdog') => number | undefined;
  tunnelLaunchdPid?: (label: string) => number | undefined;
  processAlive?: (pid: number) => boolean;
}

export interface RecoveryConnectorDescriptor {
  name: 'Forge Recovery';
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
    gateway: { label: string; plistInstalled: boolean; running: boolean; pid?: number };
    watchdog: { label: string; plistInstalled: boolean; running: boolean; pid?: number };
    tunnel: { configured: boolean; label?: string; plistInstalled: boolean; restartSafe: boolean; running: boolean; pid?: number };
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
  const pathExists = dependencies.pathExists ?? existsSync;
  const launchdPid = dependencies.launchdPid ?? recoveryLaunchdPid;
  const processAlive = dependencies.processAlive ?? isProcessAlive;
  const tunnelService = config.recoveryTunnelService?.platform === 'launchd' ? config.recoveryTunnelService : undefined;
  const tunnelContract = tunnelService ? inspectRecoveryTunnelLaunchdContract(tunnelService) : undefined;
  const tunnelLaunchdPid = tunnelService
    ? (dependencies.tunnelLaunchdPid ?? recoveryLaunchdServicePid)(tunnelService.label)
    : undefined;
  const tunnelPlistInstalled = Boolean(tunnelContract?.plistPath && pathExists(tunnelContract.plistPath));
  const tunnelRestartSafe = Boolean(tunnelContract?.restartSafe);
  const tunnelRunning = Boolean(tunnelLaunchdPid && processAlive(tunnelLaunchdPid));
  const gatewayPlistInstalled = pathExists(authority.gatewayLaunchAgent);
  const watchdogPlistInstalled = pathExists(authority.watchdogLaunchAgent);
  const gatewayLaunchdPid = launchdPid('gateway');
  const watchdogLaunchdPid = launchdPid('watchdog');
  const gatewayRunning = Boolean(
    gatewayIdentity
    && gatewayLaunchdPid
    && gatewayIdentity.pid === gatewayLaunchdPid
    && processAlive(gatewayIdentity.pid)
    && authority.current
    && gatewayIdentity.releaseRevision === authority.current.releaseRevision
    && gatewayIdentity.manifestSha256 === authority.current.manifestSha256,
  );
  const watchdogRunning = Boolean(
    watchdogIdentity
    && watchdogLaunchdPid
    && watchdogIdentity.pid === watchdogLaunchdPid
    && processAlive(watchdogIdentity.pid)
    && authority.current
    && watchdogIdentity.releaseRevision === authority.current.releaseRevision
    && watchdogIdentity.manifestSha256 === authority.current.manifestSha256,
  );
  const installed = Boolean(authority.current && gatewayPlistInstalled && watchdogPlistInstalled);
  const publicEndpoint = Boolean(configuredUrl?.startsWith('https://'));
  const warnings: string[] = [];
  if (!authority.current) warnings.push('No current immutable Forge Recovery release is installed. Run forge recovery install.');
  if (!gatewayPlistInstalled || !watchdogPlistInstalled) warnings.push('Forge Recovery launchd services are not fully installed. Run forge recovery install.');
  if (!gatewayRunning || !watchdogRunning) warnings.push('Forge Recovery Gateway or Watchdog is not running on the current Recovery release.');
  if (!configuredUrl) warnings.push('Recovery is loopback-only. Configure --recovery-public-url and a dedicated tunnel service before adding it to ChatGPT.');
  else if (!publicEndpoint) warnings.push('ChatGPT Recovery Connector requires an HTTPS public endpoint.');
  else if (!tunnelService) warnings.push('A dedicated Forge Recovery tunnel service is not configured.');
  else if (!tunnelPlistInstalled) warnings.push('The dedicated Forge Recovery tunnel plist is not installed.');
  else if (!tunnelRestartSafe) warnings.push('The dedicated Forge Recovery tunnel plist must use RunAtLoad=true and unconditional KeepAlive=true.');
  else if (!tunnelRunning) warnings.push('The dedicated Forge Recovery tunnel service is not running.');
  if (!passphraseConfigured) warnings.push('MCP OAuth passphrase is not configured. Run forge mcp setup chatgpt first.');

  return {
    name: 'Forge Recovery',
    transport: 'streamable_http',
    url,
    public: publicEndpoint,
    readyForChatGPT: installed && gatewayRunning && watchdogRunning && tunnelRestartSafe && tunnelRunning && publicEndpoint && passphraseConfigured,
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
        plistInstalled: gatewayPlistInstalled,
        running: gatewayRunning,
        ...(gatewayIdentity ? { pid: gatewayIdentity.pid } : {}),
      },
      watchdog: {
        label: RECOVERY_WATCHDOG_LABEL,
        plistInstalled: watchdogPlistInstalled,
        running: watchdogRunning,
        ...(watchdogIdentity ? { pid: watchdogIdentity.pid } : {}),
      },
      tunnel: {
        configured: Boolean(tunnelService),
        ...(tunnelService ? { label: tunnelService.label } : {}),
        plistInstalled: tunnelPlistInstalled,
        restartSafe: tunnelRestartSafe,
        running: tunnelRunning,
        ...(tunnelLaunchdPid ? { pid: tunnelLaunchdPid } : {}),
      },
    },
    tools: RECOVERY_TOOLS.map((tool) => tool.name),
    warnings,
  };
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
  if (!connector.public) failures.push('readiness: Recovery Connector does not have an HTTPS public endpoint.');

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
    const ok = response.status === 401 && /\bBearer\b/i.test(challenge) && challenge.includes('oauth-protected-resource');
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

  command.command('install')
    .description('Build and activate the independent Forge Recovery Gateway and Watchdog release')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .option('--port <port>', 'Loopback Recovery Gateway port', '8787')
    .option('--public-mcp-url <url>', 'Primary Forge MCP public URL')
    .option('--recovery-public-url <url>', 'Dedicated Forge Recovery MCP public URL')
    .option('--recovery-tunnel-service-label <label>', 'Dedicated Recovery tunnel launchd label')
    .option('--recovery-tunnel-service-plist <path>', 'Absolute Recovery tunnel launchd plist path')
    .option('--stage-only', 'Build and canary the Recovery release without activating services')
    .action(async (opts: {
      controllerHome: string;
      port: string;
      publicMcpUrl?: string;
      recoveryPublicUrl?: string;
      recoveryTunnelServiceLabel?: string;
      recoveryTunnelServicePlist?: string;
      stageOnly?: boolean;
    }) => {
      const home = resolveControllerHome(opts.controllerHome);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RECOVERY_PORT_INVALID');
      const recoveryTunnelService = launchdService(opts.recoveryTunnelServiceLabel, opts.recoveryTunnelServicePlist);
      const recoveryPublicUrl = endpoint(opts.recoveryPublicUrl, 'RECOVERY_PUBLIC_URL');
      if (Boolean(recoveryTunnelService) !== Boolean(recoveryPublicUrl)) {
        throw new Error('RECOVERY_PUBLIC_URL_AND_TUNNEL_SERVICE_MUST_BE_CONFIGURED_TOGETHER');
      }
      const packageRoot = resolve(import.meta.dir, '..', '..', '..');
      const result = await installStandaloneRecovery({
        controllerHome: home,
        repoRoot: packageRoot,
        sourceRoot: packageRoot,
        port,
        stageOnly: opts.stageOnly === true,
        publicMcpUrl: endpoint(opts.publicMcpUrl, 'PUBLIC_MCP_URL'),
        recoveryPublicUrl,
        recoveryTunnelService,
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
