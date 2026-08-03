import { accessSync, constants, existsSync, realpathSync, statSync } from 'fs';
import { delimiter, isAbsolute, join, resolve } from 'path';
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

function resolveExecutable(value: string): string {
  const candidates = isAbsolute(value)
    ? [value]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, value));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      // Preserve the invoked path. Version-manager shims (Volta, asdf, mise) may
      // intentionally dispatch based on argv[0] and fail when their target is
      // realpathed and executed directly.
      if (statSync(candidate).isFile()) return resolve(candidate);
    } catch { /* keep searching */ }
  }
  throw new Error('RECOVERY_PI_COMMAND_NOT_EXECUTABLE');
}

const controllerHomeRaw = option('--controller-home') ?? process.env.REPO_HARNESS_CONTROLLER_HOME ?? '';
const controllerHome = resolve(controllerHomeRaw);
if (!controllerHomeRaw || controllerHome === resolve('.')) throw new Error('RECOVERY_CONTROLLER_HOME_REQUIRED');
const port = integerOption('--port', 8787, 1024, 65535);
const stageOnly = process.argv.includes('--stage-only');
const publicMcpUrl = endpointOption('--public-mcp-url');
const recoveryPublicUrl = endpointOption('--recovery-public-url');

const legacyTunnelLabel = option('--public-tunnel-service-label');
const legacyTunnelPlist = option('--public-tunnel-service-plist');
const recoveryTunnelLabel = option('--recovery-tunnel-service-label') ?? legacyTunnelLabel;
const recoveryTunnelPlist = option('--recovery-tunnel-service-plist') ?? legacyTunnelPlist;
if (option('--recovery-tunnel-service-label') && legacyTunnelLabel && option('--recovery-tunnel-service-label') !== legacyTunnelLabel) {
  throw new Error('RECOVERY_TUNNEL_SERVICE_LABEL_CONFLICT');
}
const recoveryTunnelService = launchdService(recoveryTunnelLabel, recoveryTunnelPlist, 'RECOVERY_TUNNEL_SERVICE');
if (Boolean(recoveryTunnelService) !== Boolean(recoveryPublicUrl)) throw new Error('RECOVERY_PUBLIC_URL_AND_TUNNEL_SERVICE_MUST_BE_CONFIGURED_TOGETHER');

const enablePiAgent = process.argv.includes('--enable-pi-agent');
const piRepoRootRaw = option('--pi-repo-root');
if (enablePiAgent && !piRepoRootRaw) throw new Error('RECOVERY_PI_REPO_ROOT_REQUIRED');
const piRepoRootResolved = piRepoRootRaw ? resolve(piRepoRootRaw) : undefined;
if (piRepoRootResolved && !existsSync(piRepoRootResolved)) throw new Error('RECOVERY_PI_REPO_ROOT_MISSING');
const piRepoRoot = piRepoRootResolved ? realpathSync(piRepoRootResolved) : undefined;
const piCommand = enablePiAgent ? resolveExecutable(option('--pi-command') ?? 'pi') : undefined;

const result = await installStandaloneRecovery({
  controllerHome,
  repoRoot: process.cwd(),
  sourceRoot: process.cwd(),
  port,
  stageOnly,
  publicMcpUrl,
  recoveryPublicUrl,
  recoveryTunnelService,
  agentRepair: enablePiAgent && piCommand && piRepoRoot
    ? {
      enabled: true,
      command: piCommand,
      repoRoot: piRepoRoot,
      timeoutMs: integerOption('--pi-timeout-ms', 15 * 60_000, 30_000, 60 * 60_000),
      cooldownMs: integerOption('--pi-cooldown-ms', 60 * 60_000, 60_000, 24 * 60 * 60_000),
      minimumFailures: integerOption('--pi-minimum-failures', 12, 6, 10_000),
      minimumFailureDurationMs: integerOption('--pi-minimum-failure-duration-ms', 120_000, 30_000, 24 * 60 * 60_000),
    }
    : undefined,
});
const config = result.config;
console.log(JSON.stringify({
  status: stageOnly ? 'staged' : 'installed',
  controllerHome,
  stagedRelease: result.staged.release,
  activation: result.activated,
  binary: join(controllerHome, 'recovery', 'bin', 'repo-harness-recovery'),
  config: {
    controllerHome: config.controllerHome,
    gateway: { host: config.gateway?.host, port: config.gateway?.port },
    publicMcpUrl: config.publicMcpUrl,
    recoveryPublicUrl: config.recoveryPublicUrl,
    recoveryTunnelService: config.recoveryTunnelService
      ? { platform: config.recoveryTunnelService.platform, label: config.recoveryTunnelService.label, plistPath: config.recoveryTunnelService.plistPath }
      : undefined,
    agentRepair: config.agentRepair
      ? { enabled: config.agentRepair.enabled, command: config.agentRepair.command, repoRoot: config.agentRepair.repoRoot, promptFile: config.agentRepair.promptFile }
      : { enabled: false },
  },
}, null, 2));
