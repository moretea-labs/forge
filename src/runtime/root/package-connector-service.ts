import { createHash } from 'crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { bootstrapLaunchAgentWithRetryV2, installLaunchAgent, launchAgentPath, retireConflictingForgeLaunchAgents } from '../../cli/controller/launch-agents';
import { loadMcpServiceLocalConfig, normalizeForgeMcpInstanceId } from '../../cli/mcp/auth';
import type { PackageRuntimeRelease } from './package-runtime-release';

export interface PackageConnectorServicePaths {
  label: string;
  serviceRoot: string;
  sourcePlistPath: string;
  installedPlistPath: string;
  stdoutPath: string;
  stderrPath: string;
  authorityPath: string;
}

export type PackageConnectorReleaseBinding = Pick<PackageRuntimeRelease, 'releaseId' | 'releaseRoot' | 'packageRoot'>;

export interface PackageConnectorServiceAuthority {
  schemaVersion: 1;
  endpoint: string;
  releaseId: string;
  releaseRoot: string;
  packageRoot: string;
  mode: 'launchd' | 'systemd-user' | 'portable';
  persistent: boolean;
  servicePath?: string;
  installedAt: string;
}

export interface PackageConnectorServiceResult {
  endpoint: string;
  mode: 'launchd' | 'systemd-user' | 'portable';
  persistent: boolean;
  servicePath?: string;
  pid?: number;
  reused?: boolean;
  releaseId?: string;
  releaseRoot?: string;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

export function packageConnectorServicePaths(controllerHome: string, accountHome = process.env.HOME ?? homedir()): PackageConnectorServicePaths {
  const home = resolve(controllerHome);
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const label = `com.moretea.forge.mcp-gateway.${suffix}`;
  const serviceRoot = join(home, 'runtime', 'connector-service');
  return {
    label,
    serviceRoot,
    sourcePlistPath: join(serviceRoot, `${label}.plist`),
    installedPlistPath: launchAgentPath(label, accountHome),
    stdoutPath: join(serviceRoot, 'logs', 'stdout.log'),
    stderrPath: join(serviceRoot, 'logs', 'stderr.log'),
    authorityPath: join(serviceRoot, 'authority.json'),
  };
}

export function readPackageConnectorServiceAuthority(controllerHome: string): PackageConnectorServiceAuthority | undefined {
  const path = packageConnectorServicePaths(controllerHome).authorityPath;
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PackageConnectorServiceAuthority>;
  if (
    parsed.schemaVersion !== 1
    || typeof parsed.endpoint !== 'string'
    || typeof parsed.releaseId !== 'string'
    || typeof parsed.releaseRoot !== 'string'
    || typeof parsed.packageRoot !== 'string'
    || !['launchd', 'systemd-user', 'portable'].includes(String(parsed.mode))
    || typeof parsed.persistent !== 'boolean'
    || typeof parsed.installedAt !== 'string'
  ) throw new Error('FORGE_PACKAGE_CONNECTOR_AUTHORITY_INVALID');
  return parsed as PackageConnectorServiceAuthority;
}

function writePackageConnectorServiceAuthority(input: { release: PackageConnectorReleaseBinding; controllerHome: string; result: PackageConnectorServiceResult }): void {
  const paths = packageConnectorServicePaths(input.controllerHome);
  const authority: PackageConnectorServiceAuthority = {
    schemaVersion: 1,
    endpoint: input.result.endpoint,
    releaseId: input.release.releaseId,
    releaseRoot: resolve(input.release.releaseRoot),
    packageRoot: resolve(input.release.packageRoot),
    mode: input.result.mode,
    persistent: input.result.persistent,
    ...(input.result.servicePath ? { servicePath: input.result.servicePath } : {}),
    installedAt: new Date().toISOString(),
  };
  atomicWrite(paths.authorityPath, `${JSON.stringify(authority, null, 2)}\n`);
}

export function packageConnectorEndpointStatusHealthy(status: number): boolean {
  // The OAuth-protected MCP endpoint is healthy when it either answers directly
  // or returns the expected unauthenticated Bearer challenge. Treating every
  // received HTTP status as healthy masks upstream 5xx failures that are often
  // surfaced remotely as 502 and prevents the persistent service from healing.
  return status === 200 || status === 401;
}

async function defaultConnectorEndpointProbe(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(endpoint, { method: 'GET', redirect: 'manual', signal: controller.signal });
    return packageConnectorEndpointStatusHealthy(response.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForPackageConnectorEndpointReady(
  endpoint: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    probeEndpoint?: (endpoint: string) => Promise<boolean>;
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 100);
  const probeEndpoint = options.probeEndpoint ?? defaultConnectorEndpointProbe;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  do {
    if (await probeEndpoint(endpoint)) return true;
    if (now() >= deadline) return false;
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  } while (now() <= deadline);
  return false;
}

export function packageConnectorLaunchSpec(input: { release: PackageConnectorReleaseBinding; controllerHome: string; endpoint: string; executable?: string }): { executable: string; args: string[]; environment: Record<string, string>; port: number } {
  const parsed = new URL(input.endpoint);
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/mcp' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('FORGE_PACKAGE_CONNECTOR_ENDPOINT_INVALID');
  }
  const executable = resolve(input.executable ?? process.env.FORGE_CONNECTOR_EXECUTABLE ?? process.execPath);
  if (/^forge-recovery-(?:gateway|watchdog)$/i.test(basename(executable))) {
    throw new Error('FORGE_PACKAGE_CONNECTOR_EXECUTABLE_INVALID');
  }
  const packageRoot = resolve(input.release.packageRoot);
  const cliEntry = join(packageRoot, 'src', 'cli', 'index.ts');
  const nodeLoader = join(packageRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs');
  const isBun = Boolean(process.versions.bun) || /(?:^|[/\\-])bun(?:$|[/\\]|\.exe$)/i.test(basename(executable));
  const instanceId = normalizeForgeMcpInstanceId(loadMcpServiceLocalConfig(input.controllerHome)?.chatgpt?.instanceId);
  const cliArgs = [
    // The package snapshot is executable code, never an adopted repository.
    // Supplying it as --repo makes the Gateway try to register a non-Git
    // directory and fail before it can proxy the Canonical Runtime.
    'mcp', 'serve', '--controller-home', resolve(input.controllerHome),
    '--transport', 'http', '--host', '127.0.0.1', '--port', String(port), '--profile', 'controller', '--auth', 'oauth',
  ];
  return {
    executable,
    args: isBun ? [cliEntry, ...cliArgs] : ['--loader', nodeLoader, cliEntry, ...cliArgs],
    environment: {
      FORGE_CONTROLLER_HOME: resolve(input.controllerHome),
      FORGE_CONTROLLER_LIFECYCLE_OWNER: '1',
      ...(instanceId ? { FORGE_MCP_INSTANCE_ID: instanceId } : {}),
    },
    port,
  };
}

export function renderPackageConnectorLaunchAgent(input: { paths: PackageConnectorServicePaths; launch: ReturnType<typeof packageConnectorLaunchSpec> }): string {
  const environmentXml = Object.entries(input.launch.environment).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n');
  const args = [input.launch.executable, ...input.launch.args];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(input.paths.label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n${environmentXml}\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>5</integer>\n  <key>StandardOutPath</key><string>${xml(input.paths.stdoutPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(input.paths.stderrPath)}</string>\n</dict>\n</plist>\n`;
}

export function renderPackageConnectorSystemdUserUnit(input: { launch: ReturnType<typeof packageConnectorLaunchSpec> }): string {
  const quote = (value: string) => `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const env = Object.entries(input.launch.environment).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`);
  return ['[Unit]', 'Description=Forge ChatGPT OAuth Gateway', 'After=network-online.target', '', '[Service]', 'Type=simple', `ExecStart=${[input.launch.executable, ...input.launch.args].map(quote).join(' ')}`, ...env, 'Restart=on-failure', 'RestartSec=5', '', '[Install]', 'WantedBy=default.target', ''].join('\n');
}

export function packageConnectorServiceMatchesRelease(input: {
  authority: PackageConnectorServiceAuthority;
  release: PackageConnectorReleaseBinding;
  controllerHome: string;
  endpoint: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: string;
}): boolean {
  try {
    if (
      input.authority.endpoint !== input.endpoint
      || input.authority.releaseId !== input.release.releaseId
      || resolve(input.authority.releaseRoot) !== resolve(input.release.releaseRoot)
      || resolve(input.authority.packageRoot) !== resolve(input.release.packageRoot)
    ) return false;
    const launch = packageConnectorLaunchSpec({
      release: input.release,
      controllerHome: input.controllerHome,
      endpoint: input.endpoint,
      executable: input.executable,
    });
    if (input.platform === 'darwin') {
      const paths = packageConnectorServicePaths(input.controllerHome, input.env?.HOME);
      if (input.authority.mode !== 'launchd' || !input.authority.servicePath) return false;
      const servicePath = resolve(input.authority.servicePath);
      if (servicePath !== resolve(paths.installedPlistPath) || !existsSync(servicePath)) return false;
      return readFileSync(servicePath, 'utf8') === renderPackageConnectorLaunchAgent({ paths, launch });
    }
    if (input.platform === 'linux') {
      if (input.authority.mode !== 'systemd-user' || !input.authority.servicePath) return false;
      const servicePath = resolve(input.authority.servicePath);
      return existsSync(servicePath) && readFileSync(servicePath, 'utf8') === renderPackageConnectorSystemdUserUnit({ launch });
    }
    return false;
  } catch {
    return false;
  }
}

function installSystemd(paths: PackageConnectorServicePaths, launch: ReturnType<typeof packageConnectorLaunchSpec>, env: NodeJS.ProcessEnv): string {
  const unitName = `${paths.label}.service`;
  const unitPath = join(env.HOME ?? homedir(), '.config', 'systemd', 'user', unitName);
  atomicWrite(unitPath, renderPackageConnectorSystemdUserUnit({ launch }), 0o644);
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', unitName]]) {
    const result = spawnSync('systemctl', args, { encoding: 'utf8', env, timeout: 30_000 });
    if (result.status !== 0) throw new Error(`FORGE_PACKAGE_CONNECTOR_SYSTEMD_INSTALL_FAILED: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return unitPath;
}

function startPortable(paths: PackageConnectorServicePaths, launch: ReturnType<typeof packageConnectorLaunchSpec>, env: NodeJS.ProcessEnv): number {
  mkdirSync(join(paths.serviceRoot, 'logs'), { recursive: true, mode: 0o700 });
  const stdout = openSync(paths.stdoutPath, 'a', 0o600), stderr = openSync(paths.stderrPath, 'a', 0o600);
  // A connector is not the Canonical Runtime writer. Never let a transient
  // installer/worker write claim escape into this long-lived process; the claim
  // would become stale as soon as its parent exits. Keep only the explicit
  // Controller Home and lifecycle-role marker from launch.environment.
  const childEnv = { ...env };
  for (const key of [
    'FORGE_RUNTIME_INSTANCE_ID', 'FORGE_RUNTIME_OWNER_PID', 'FORGE_RELEASE_AUTHORITY_REVISION',
    'FORGE_RELEASE_FENCING_TOKEN', 'FORGE_RELEASE_ID', 'FORGE_ARTIFACT_IDENTITY', 'FORGE_WORKER_PROTOCOL_VERSION',
  ]) delete childEnv[key];
  try {
    const child = spawn(launch.executable, launch.args, { detached: true, stdio: ['ignore', stdout, stderr], env: { ...childEnv, ...launch.environment } });
    if (!child.pid) throw new Error('FORGE_PACKAGE_CONNECTOR_START_FAILED');
    child.unref();
    return child.pid;
  } finally { closeSync(stdout); closeSync(stderr); }
}

export async function installPackageConnectorService(input: { release: PackageConnectorReleaseBinding; controllerHome: string; endpoint: string; executable?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; forcePortable?: boolean; probeEndpoint?: (endpoint: string) => Promise<boolean> }): Promise<PackageConnectorServiceResult> {
  const paths = packageConnectorServicePaths(input.controllerHome, input.env?.HOME);
  mkdirSync(join(paths.serviceRoot, 'logs'), { recursive: true, mode: 0o700 });
  const launch = packageConnectorLaunchSpec({
    release: input.release,
    controllerHome: input.controllerHome,
    endpoint: input.endpoint,
    executable: input.executable,
  });
  const platform = input.platform ?? process.platform, env = input.env ?? process.env;
  if (!input.forcePortable && platform === 'darwin') {
    await retireConflictingForgeLaunchAgents({
      accountHome: env.HOME,
      desiredLabel: paths.label,
      labelPrefix: 'com.moretea.forge.mcp-gateway',
      port: launch.port,
      requiredArguments: ['mcp', 'serve', '--auth', 'oauth'],
    });
    atomicWrite(paths.sourcePlistPath, renderPackageConnectorLaunchAgent({ paths, launch }), 0o600);
    installLaunchAgent(paths.sourcePlistPath, paths.label);
    const result = await bootstrapLaunchAgentWithRetryV2({ label: paths.label, plistPath: paths.installedPlistPath });
    if (!result.ok) throw new Error(`FORGE_PACKAGE_CONNECTOR_LAUNCHD_INSTALL_FAILED: ${result.diagnostics.join('; ')}`);
    const endpointReady = await waitForPackageConnectorEndpointReady(input.endpoint, { probeEndpoint: input.probeEndpoint });
    if (!endpointReady) throw new Error(`FORGE_PACKAGE_CONNECTOR_ENDPOINT_NOT_READY: ${input.endpoint}`);
    const installed = { endpoint: input.endpoint, mode: 'launchd' as const, persistent: true, servicePath: paths.installedPlistPath, releaseId: input.release.releaseId, releaseRoot: input.release.releaseRoot };
    writePackageConnectorServiceAuthority({ release: input.release, controllerHome: input.controllerHome, result: installed });
    return installed;
  }
  if (!input.forcePortable && platform === 'linux') {
    const probe = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', env, timeout: 30_000 });
    if (probe.status === 0) {
      const installed = { endpoint: input.endpoint, mode: 'systemd-user' as const, persistent: true, servicePath: installSystemd(paths, launch, env), releaseId: input.release.releaseId, releaseRoot: input.release.releaseRoot };
      writePackageConnectorServiceAuthority({ release: input.release, controllerHome: input.controllerHome, result: installed });
      return installed;
    }
  }
  const portable = { endpoint: input.endpoint, mode: 'portable' as const, persistent: false, pid: startPortable(paths, launch, env), releaseId: input.release.releaseId, releaseRoot: input.release.releaseRoot };
  writePackageConnectorServiceAuthority({ release: input.release, controllerHome: input.controllerHome, result: portable });
  return portable;
}

export async function ensurePackageConnectorService(input: {
  release: PackageConnectorReleaseBinding;
  controllerHome: string;
  endpoint: string;
  executable?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  forcePortable?: boolean;
  refresh?: boolean;
  probeEndpoint?: (endpoint: string) => Promise<boolean>;
}): Promise<PackageConnectorServiceResult> {
  const platform = input.platform ?? process.platform;
  if (!input.refresh && !input.forcePortable && platform === 'darwin') {
    const paths = packageConnectorServicePaths(input.controllerHome, input.env?.HOME);
    const port = Number(new URL(input.endpoint).port);
    await retireConflictingForgeLaunchAgents({
      accountHome: input.env?.HOME,
      desiredLabel: paths.label,
      labelPrefix: 'com.moretea.forge.mcp-gateway',
      port,
      requiredArguments: ['mcp', 'serve', '--auth', 'oauth'],
    });
  }
  if (!input.refresh && !input.forcePortable) {
    let authority: PackageConnectorServiceAuthority | undefined;
    try { authority = readPackageConnectorServiceAuthority(input.controllerHome); } catch { authority = undefined; }
    if (
      authority?.persistent
      && existsSync(authority.releaseRoot)
      && existsSync(authority.packageRoot)
      && packageConnectorServiceMatchesRelease({
        authority,
        release: input.release,
        controllerHome: input.controllerHome,
        endpoint: input.endpoint,
        platform,
        env: input.env,
        executable: input.executable,
      })
      && await (input.probeEndpoint ?? defaultConnectorEndpointProbe)(input.endpoint)
    ) {
      return {
        endpoint: authority.endpoint,
        mode: authority.mode,
        persistent: true,
        ...(authority.servicePath ? { servicePath: authority.servicePath } : {}),
        reused: true,
        releaseId: authority.releaseId,
        releaseRoot: authority.releaseRoot,
      };
    }
  }
  return installPackageConnectorService(input);
}
