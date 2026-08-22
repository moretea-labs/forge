import { randomUUID } from 'crypto';
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { RUNTIME_WRITE_CLAIM_ENV } from './write-fence';
import {
  activeRuntimeEntrypoint,
  activeRuntimeLaunchSpec,
  forgeRuntimeServicePaths,
  installForgeRuntimeService,
  readForgeRuntimeServiceConfig,
  syncForgeRuntimeActiveEntrypoint,
  writeForgeRuntimeServiceConfig,
  type ForgeRuntimeServiceConfig,
} from './service';
import { materializePackageRuntimeRelease, type PackageRuntimeRelease } from './package-runtime-release';
import { readRuntimeReleaseAuthority, revertInitialRuntimeReleasePublication, rollbackRuntimeRelease } from './release-store';
import { loadMcpServiceLocalConfig } from '../../cli/mcp/auth';
import { ensurePackageConnectorService, type PackageConnectorServiceResult } from './package-connector-service';

export type PackageRuntimeServiceMode = 'launchd' | 'systemd-user' | 'portable';

export interface PackageRuntimeServiceInstallResult {
  status: 'installed';
  mode: PackageRuntimeServiceMode;
  persistent: boolean;
  controllerHome: string;
  release: PackageRuntimeRelease;
  servicePath?: string;
  pid?: number;
  warnings: string[];
  connector?: PackageConnectorServiceResult;
}

export interface PackageRuntimeServiceOptions {
  controllerHome?: string;
  packageRoot?: string;
  host?: string;
  port?: number;
  authTokenFile: string;
  exclusiveWorkId?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  forcePortable?: boolean;
  refreshConnector?: boolean;
}

export interface PackageRuntimeServiceDependencies {
  installDarwinService?: typeof installForgeRuntimeService;
  ensureConnectorService?: typeof ensurePackageConnectorService;
}

function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

function systemdEscape(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderForgeRuntimeSystemdUserUnit(input: {
  description?: string;
  executable: string;
  args: string[];
  environment: Record<string, string>;
}): string {
  const environment = Object.entries(input.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${systemdEscape(`${key}=${value}`)}`)
    .join('\n');
  return [
    '[Unit]',
    `Description=${input.description ?? 'Forge Runtime'}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[input.executable, ...input.args].map(systemdEscape).join(' ')}`,
    ...(environment ? [environment] : []),
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function commandSucceeded(command: string, args: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: 'utf8', env, timeout: 30_000 });
}

export function systemdUserAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const result = commandSucceeded('systemctl', ['--user', 'show-environment'], env);
  return result.status === 0;
}

function cleanRuntimeInstallerEnvironment(env: NodeJS.ProcessEnv, releaseEnvironment: Record<string, string>): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.values(RUNTIME_WRITE_CLAIM_ENV)) delete next[key];
  delete next.FORGE_CONTROLLER_LIFECYCLE_OWNER;
  delete next.FORGE_RELEASE_PATH;
  delete next.FORGE_RELEASE_REVISION;
  delete next.FORGE_RELEASE_SOURCE_COMMIT;
  delete next.FORGE_RELEASE_CLEAN_WORKSPACE;
  return { ...next, ...releaseEnvironment };
}

function installSystemdUserService(controllerHome: string, env: NodeJS.ProcessEnv): string {
  const entrypoint = activeRuntimeEntrypoint(controllerHome);
  const launch = activeRuntimeLaunchSpec(controllerHome);
  if (!entrypoint || !launch) throw new Error('FORGE_PACKAGE_RUNTIME_LAUNCH_SPEC_MISSING');
  const label = forgeRuntimeServicePaths(controllerHome).label;
  const unitName = `${label}.service`;
  const unitPath = join(env.HOME ?? homedir(), '.config', 'systemd', 'user', unitName);
  atomicWrite(unitPath, renderForgeRuntimeSystemdUserUnit({ executable: entrypoint, args: launch.args, environment: launch.environment }), 0o644);
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', unitName]]) {
    const result = commandSucceeded('systemctl', args, env);
    if (result.status !== 0) throw new Error(`FORGE_RUNTIME_SYSTEMD_INSTALL_FAILED: systemctl ${args.join(' ')}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return unitPath;
}

function startPortableRuntime(controllerHome: string, env: NodeJS.ProcessEnv): number {
  const entrypoint = activeRuntimeEntrypoint(controllerHome);
  const launch = activeRuntimeLaunchSpec(controllerHome);
  if (!entrypoint || !launch) throw new Error('FORGE_PACKAGE_RUNTIME_LAUNCH_SPEC_MISSING');
  const paths = forgeRuntimeServicePaths(controllerHome);
  mkdirSync(join(paths.serviceRoot, 'logs'), { recursive: true, mode: 0o700 });
  const stdout = openSync(paths.stdoutPath, 'a', 0o600);
  const stderr = openSync(paths.stderrPath, 'a', 0o600);
  try {
    const child = spawn(entrypoint, launch.args, {
      detached: true,
      stdio: ['ignore', stdout, stderr],
      env: cleanRuntimeInstallerEnvironment(env, launch.environment),
    });
    if (!child.pid) throw new Error('FORGE_PORTABLE_RUNTIME_START_FAILED: child pid unavailable');
    child.unref();
    atomicWrite(join(paths.serviceRoot, 'portable.json'), `${JSON.stringify({ schemaVersion: 1, pid: child.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
    return child.pid;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

export async function installPackageRuntimeService(
  options: PackageRuntimeServiceOptions,
  dependencies: PackageRuntimeServiceDependencies = {},
): Promise<PackageRuntimeServiceInstallResult> {
  const controllerHome = resolveControllerHome(options.controllerHome);
  const servicePaths = forgeRuntimeServicePaths(controllerHome);
  const priorAuthority = readRuntimeReleaseAuthority(controllerHome);
  const priorConfigBytes = existsSync(servicePaths.configPath) ? readFileSync(servicePaths.configPath, 'utf8') : undefined;
  const operationId = `package-runtime-install-${randomUUID()}`;
  const release = materializePackageRuntimeRelease({ controllerHome, packageRoot: options.packageRoot, operationId });
  const publicationChanged = release.authority.operationId === operationId;
  const config: ForgeRuntimeServiceConfig = {
    schemaVersion: 1,
    controllerHome,
    repositoryRoot: release.packageRoot,
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 8765,
    authTokenFile: options.authTokenFile,
    ...(options.exclusiveWorkId?.trim() ? { exclusiveWorkId: options.exclusiveWorkId.trim() } : {}),
  };
  writeForgeRuntimeServiceConfig(config);
  syncForgeRuntimeActiveEntrypoint(controllerHome);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const installDarwinService = dependencies.installDarwinService ?? installForgeRuntimeService;

  let base: PackageRuntimeServiceInstallResult;
  try {
    if (!options.forcePortable && platform === 'darwin') {
      const paths = await installDarwinService({ config, runnerPath: join(release.packageRoot, 'bin', 'forge-runtime-service.mjs'), nodeExecutable: process.execPath });
      base = { status: 'installed', mode: 'launchd', persistent: true, controllerHome, release, servicePath: paths.installedPlistPath, warnings: [] };
    } else if (!options.forcePortable && platform === 'linux' && systemdUserAvailable(env)) {
      const unitPath = installSystemdUserService(controllerHome, env);
      base = { status: 'installed', mode: 'systemd-user', persistent: true, controllerHome, release, servicePath: unitPath, warnings: [] };
    } else {
      const pid = startPortableRuntime(controllerHome, env);
      base = {
        status: 'installed', mode: 'portable', persistent: false, controllerHome, release, pid,
        warnings: [platform === 'win32'
          ? 'Native Windows is preview: Forge started detached Runtime and OAuth Gateway processes for this session; automatic login/reboot persistence is not yet claimed.'
          : 'systemd --user is unavailable: Forge started detached Runtime and OAuth Gateway processes; enable a user service manager for reboot persistence.'],
      };
    }
  } catch (installError) {
    const recoveryErrors: string[] = [];
    try {
      if (publicationChanged) {
        if (priorAuthority) rollbackRuntimeRelease(controllerHome, `${operationId}-rollback`);
        else revertInitialRuntimeReleasePublication(controllerHome, operationId);
      }
      if (priorConfigBytes === undefined) rmSync(servicePaths.configPath, { force: true });
      else atomicWrite(servicePaths.configPath, priorConfigBytes);
      syncForgeRuntimeActiveEntrypoint(controllerHome);

      if (priorAuthority && !options.forcePortable && platform === 'darwin' && priorConfigBytes !== undefined) {
        const priorConfig = readForgeRuntimeServiceConfig(servicePaths.configPath);
        await installDarwinService({ config: priorConfig, runnerPath: join(priorConfig.repositoryRoot, 'bin', 'forge-runtime-service.mjs'), nodeExecutable: process.execPath });
      } else if (priorAuthority && !options.forcePortable && platform === 'linux' && priorConfigBytes !== undefined && systemdUserAvailable(env)) {
        installSystemdUserService(controllerHome, env);
      }
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
    }
    const detail = installError instanceof Error ? installError.message : String(installError);
    if (recoveryErrors.length > 0) {
      throw new Error(`FORGE_PACKAGE_RUNTIME_INSTALL_FAILED_AND_RECOVERY_FAILED: ${detail}; recovery: ${recoveryErrors.join('; ')}`);
    }
    throw installError;
  }

  const localConfig = loadMcpServiceLocalConfig(controllerHome);
  const connectorEndpoint = localConfig?.chatgpt?.localEndpoint;
  if (!connectorEndpoint) return base;
  const ensureConnectorService = dependencies.ensureConnectorService ?? ensurePackageConnectorService;
  const connector = await ensureConnectorService({
    release, controllerHome, endpoint: connectorEndpoint, platform, env, forcePortable: options.forcePortable === true, refresh: options.refreshConnector === true,
  });
  return { ...base, connector };
}
