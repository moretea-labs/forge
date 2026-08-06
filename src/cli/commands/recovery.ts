import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { Command } from 'commander';
import { readMcpServiceOAuthPassphrase } from '../mcp/auth';
import { resolveControllerHome } from '../repositories/controller-home';
import {
  RECOVERY_GATEWAY_LABEL,
  RECOVERY_WATCHDOG_LABEL,
  installStandaloneRecovery,
  recoveryLaunchdPid,
  recoveryReleaseAuthoritySnapshot,
} from '../../runtime/standalone-recovery/installer';
import {
  RECOVERY_TOOLS,
} from '../../runtime/standalone-recovery/entry';
import {
  loadRecoveryConfig,
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
  if (!passphraseConfigured) warnings.push('MCP OAuth passphrase is not configured. Run forge mcp setup chatgpt first.');

  return {
    name: 'Forge Recovery',
    transport: 'streamable_http',
    url,
    public: publicEndpoint,
    readyForChatGPT: installed && gatewayRunning && watchdogRunning && publicEndpoint && passphraseConfigured,
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
    },
    tools: RECOVERY_TOOLS.map((tool) => tool.name),
    warnings,
  };
}

export function buildRecoveryCommand(): Command {
  const command = new Command('recovery').description('Install, inspect, and configure the independent Forge Recovery Connector');

  command.command('connector')
    .description('Print the exact ChatGPT Recovery Connector URL, OAuth metadata, services, and readiness')
    .requiredOption('--controller-home <path>', 'Explicit Controller Home')
    .action((opts: { controllerHome: string }) => {
      output(recoveryConnectorDescriptor(opts.controllerHome));
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
