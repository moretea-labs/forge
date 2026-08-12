import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { RUNTIME_WRITE_CLAIM_ENV } from './write-fence';
import {
  activeRuntimeEntrypoint,
  activeRuntimeLaunchSpec,
  forgeRuntimeServicePaths,
  installForgeRuntimeService,
  syncForgeRuntimeActiveEntrypoint,
  writeForgeRuntimeServiceConfig,
  type ForgeRuntimeServiceConfig,
} from './service';
import { materializePackageRuntimeRelease, type PackageRuntimeRelease } from './package-runtime-release';

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

export async function installPackageRuntimeService(options: PackageRuntimeServiceOptions): Promise<PackageRuntimeServiceInstallResult> {
  const controllerHome = resolveControllerHome(options.controllerHome);
  const release = materializePackageRuntimeRelease({ controllerHome, packageRoot: options.packageRoot });
  const config: ForgeRuntimeServiceConfig = {
    schemaVersion: 1,
    controllerHome,
    repositoryRoot: release.packageRoot,
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 8765,
    authTokenFile: resolve(options.authTokenFile),
    ...(options.exclusiveWorkId?.trim() ? { exclusiveWorkId: options.exclusiveWorkId.trim() } : {}),
  };
  writeForgeRuntimeServiceConfig(config);
  syncForgeRuntimeActiveEntrypoint(controllerHome);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!options.forcePortable && platform === 'darwin') {
    const paths = await installForgeRuntimeService({ config, runnerPath: join(release.packageRoot, 'bin', 'forge-runtime-service.mjs'), nodeExecutable: process.execPath });
    return { status: 'installed', mode: 'launchd', persistent: true, controllerHome, release, servicePath: paths.installedPlistPath, warnings: [] };
  }
  if (!options.forcePortable && platform === 'linux' && systemdUserAvailable(env)) {
    const unitPath = installSystemdUserService(controllerHome, env);
    return { status: 'installed', mode: 'systemd-user', persistent: true, controllerHome, release, servicePath: unitPath, warnings: [] };
  }
  const pid = startPortableRuntime(controllerHome, env);
  return {
    status: 'installed', mode: 'portable', persistent: false, controllerHome, release, pid,
    warnings: [platform === 'win32'
      ? 'Native Windows is preview: Forge started a detached user process for this session; automatic login/reboot persistence is not yet claimed.'
      : 'systemd --user is unavailable: Forge started a detached user process; enable a user service manager for reboot persistence.'],
  };
}
