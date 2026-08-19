import { isAbsolute, join, resolve } from 'path';
import { installStandaloneRecovery } from '../src/runtime/standalone-recovery/installer';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerOption(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name.slice(2).replace(/-/g, '_').toUpperCase()}_INVALID`);
  return value;
}

function endpointOption(name: string): string | undefined {
  const value = option(name);
  if (!value) return undefined;
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${name.slice(2).replace(/-/g, '_').toUpperCase()}_INVALID`);
  parsed.hash = '';
  return parsed.toString();
}

function launchdService(label: string | undefined, plistPath: string | undefined, prefix: string) {
  if (plistPath && !label) throw new Error(`${prefix}_LABEL_REQUIRED`);
  if (!label) return undefined;
  if (!/^com\.[A-Za-z0-9._-]{1,180}$/.test(label)) throw new Error(`${prefix}_LABEL_INVALID`);
  if (plistPath && !isAbsolute(plistPath)) throw new Error(`${prefix}_PLIST_ABSOLUTE_REQUIRED`);
  return { platform: 'launchd' as const, label, ...(plistPath ? { plistPath } : {}) };
}

const controllerHomeRaw = option('--controller-home') ?? process.env.FORGE_CONTROLLER_HOME ?? '';
const controllerHome = resolve(controllerHomeRaw);
if (!controllerHomeRaw || controllerHome === resolve('.')) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
const port = integerOption('--port', 8787, 1024, 65535);
const stageOnly = process.argv.includes('--stage-only');
const publicMcpUrl = endpointOption('--public-mcp-url');
const recoveryPublicUrl = endpointOption('--recovery-public-url');

const recoveryTunnelService = launchdService(
  option('--recovery-tunnel-service-label'),
  option('--recovery-tunnel-service-plist'),
  'RECOVERY_TUNNEL_SERVICE',
);
if (Boolean(recoveryTunnelService) !== Boolean(recoveryPublicUrl)) throw new Error('RECOVERY_PUBLIC_URL_AND_TUNNEL_SERVICE_MUST_BE_CONFIGURED_TOGETHER');
const primaryConnectorLocalUrl = endpointOption('--primary-connector-local-url');
const primaryConnectorBase = launchdService(
  option('--primary-connector-service-label'),
  option('--primary-connector-service-plist'),
  'RECOVERY_PRIMARY_CONNECTOR',
);
if (primaryConnectorLocalUrl && !primaryConnectorBase) throw new Error('RECOVERY_PRIMARY_CONNECTOR_LABEL_REQUIRED_FOR_LOCAL_URL');
const primaryConnectorService = primaryConnectorBase
  ? { ...primaryConnectorBase, ...(primaryConnectorLocalUrl ? { localMcpUrl: primaryConnectorLocalUrl } : {}) }
  : undefined;
const primaryPublicTunnelService = launchdService(
  option('--primary-tunnel-service-label'),
  option('--primary-tunnel-service-plist'),
  'RECOVERY_PRIMARY_TUNNEL',
);
if (primaryPublicTunnelService && !primaryConnectorService) throw new Error('RECOVERY_PRIMARY_CONNECTOR_REQUIRED_FOR_PRIMARY_TUNNEL');

const result = await installStandaloneRecovery({
  controllerHome,
  repoRoot: process.cwd(),
  sourceRoot: process.cwd(),
  port,
  stageOnly,
  publicMcpUrl,
  recoveryPublicUrl,
  recoveryTunnelService,
  primaryPublicTunnelService,
  primaryConnectorService,
});
const config = result.config;
console.log(JSON.stringify({
  status: stageOnly ? 'staged' : 'installed',
  controllerHome,
  stagedRelease: result.staged.release,
  activation: result.activated,
  binary: join(controllerHome, 'recovery', 'bin', 'forge-recovery'),
  config: {
    controllerHome: config.controllerHome,
    gateway: { host: config.gateway?.host, port: config.gateway?.port },
    publicMcpUrl: config.publicMcpUrl,
    recoveryPublicUrl: config.recoveryPublicUrl,
    recoveryTunnelService: config.recoveryTunnelService
      ? { platform: config.recoveryTunnelService.platform, label: config.recoveryTunnelService.label, plistPath: config.recoveryTunnelService.plistPath }
      : undefined,
    primaryConnectorService: config.primaryConnectorService
      ? { platform: config.primaryConnectorService.platform, label: config.primaryConnectorService.label, plistPath: config.primaryConnectorService.plistPath, localMcpUrl: config.primaryConnectorService.localMcpUrl }
      : undefined,
    primaryPublicTunnelService: config.primaryPublicTunnelService
      ? { platform: config.primaryPublicTunnelService.platform, label: config.primaryPublicTunnelService.label, plistPath: config.primaryPublicTunnelService.plistPath }
      : undefined,
  },
}, null, 2));
