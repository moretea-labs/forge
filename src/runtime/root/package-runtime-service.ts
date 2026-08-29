import { randomUUID } from 'crypto';
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { setTimeout as sleep } from 'timers/promises';
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
import {
  bootstrapLaunchAgentWithRetryV2,
  currentUserLaunchdDomain,
  installLaunchAgent,
  launchAgentPath,
} from '../../cli/controller/launch-agents';

export type PackageRuntimeServiceMode = 'launchd' | 'systemd-user' | 'portable';

export type PackageRuntimeActivationStatus = 'activation_scheduled' | 'activated' | 'failed+rollback';

export interface PackageRuntimeActivationReceipt {
  schemaVersion: 1;
  operationId: string;
  status: PackageRuntimeActivationStatus;
  controllerHome: string;
  releaseId: string;
  packageFingerprint: string;
  mode: 'launchd';
  receiptPath: string;
  createdAt: string;
  updatedAt: string;
  servicePath?: string;
  helperLabel?: string;
  error?: string;
  rollbackSucceeded?: boolean;
  rollbackErrors?: string[];
}

export interface PackageRuntimeActivationRequest {
  schemaVersion: 1;
  operationId: string;
  controllerHome: string;
  installerPid: number;
  release: PackageRuntimeRelease;
  config: ForgeRuntimeServiceConfig;
  connectorEndpoint?: string;
  refreshConnector?: boolean;
  priorAuthorityPresent: boolean;
  priorConfigBytes?: string;
  publicationChanged: boolean;
  runnerPath: string;
  nodeExecutable: string;
  requestPath: string;
  receiptPath: string;
  helperLabel: string;
  helperSourcePlistPath: string;
  helperInstalledPlistPath: string;
  createdAt: string;
}

export interface PackageRuntimeServiceInstallResult {
  status: 'activation_scheduled' | 'activated';
  mode: PackageRuntimeServiceMode;
  persistent: boolean;
  controllerHome: string;
  release: PackageRuntimeRelease;
  servicePath?: string;
  pid?: number;
  warnings: string[];
  connector?: PackageConnectorServiceResult;
  activation?: {
    operationId: string;
    status: 'activation_scheduled';
    receiptPath: string;
    helperLabel: string;
    helperServicePath: string;
  };
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
  scheduleDarwinActivation?: (request: PackageRuntimeActivationRequest) => Promise<{ label: string; servicePath: string }>;
  activationMode?: 'detached' | 'inline';
}

export interface PackageRuntimeActivationDependencies {
  installDarwinService?: typeof installForgeRuntimeService;
  ensureConnectorService?: typeof ensurePackageConnectorService;
  waitForInstallerExit?: (pid: number) => Promise<void>;
  cleanupActivationHelper?: (request: PackageRuntimeActivationRequest) => Promise<void>;
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


function activationRoot(controllerHome: string): string {
  return join(forgeRuntimeServicePaths(controllerHome).serviceRoot, 'activations');
}

function activationPaths(controllerHome: string, operationId: string): { requestPath: string; receiptPath: string; helperSourcePlistPath: string } {
  const root = activationRoot(controllerHome);
  return {
    requestPath: join(root, `${operationId}.request.json`),
    receiptPath: join(root, `${operationId}.receipt.json`),
    helperSourcePlistPath: join(root, `${operationId}.plist`),
  };
}

function writeActivationRequest(request: PackageRuntimeActivationRequest): void {
  atomicWrite(request.requestPath, `${JSON.stringify(request, null, 2)}\n`);
}

function writeActivationReceipt(
  request: PackageRuntimeActivationRequest,
  status: PackageRuntimeActivationStatus,
  extra: Partial<Pick<PackageRuntimeActivationReceipt, 'servicePath' | 'error' | 'rollbackSucceeded' | 'rollbackErrors'>> = {},
): PackageRuntimeActivationReceipt {
  const previous = readPackageRuntimeActivationReceipt(request.receiptPath);
  const now = new Date().toISOString();
  const receipt: PackageRuntimeActivationReceipt = {
    schemaVersion: 1,
    operationId: request.operationId,
    status,
    controllerHome: request.controllerHome,
    releaseId: request.release.releaseId,
    packageFingerprint: request.release.packageFingerprint,
    mode: 'launchd',
    receiptPath: request.receiptPath,
    createdAt: previous?.createdAt ?? request.createdAt,
    updatedAt: now,
    helperLabel: request.helperLabel,
    ...extra,
  };
  atomicWrite(request.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function readPackageRuntimeActivationReceipt(path: string): PackageRuntimeActivationReceipt | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<PackageRuntimeActivationReceipt>;
  if (
    value.schemaVersion !== 1
    || typeof value.operationId !== 'string'
    || !['activation_scheduled', 'activated', 'failed+rollback'].includes(String(value.status))
    || typeof value.controllerHome !== 'string'
    || typeof value.releaseId !== 'string'
    || typeof value.packageFingerprint !== 'string'
    || value.mode !== 'launchd'
    || typeof value.receiptPath !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_RECEIPT_INVALID');
  return value as PackageRuntimeActivationReceipt;
}

export function readPackageRuntimeActivationRequest(path: string): PackageRuntimeActivationRequest {
  const resolvedPath = resolve(path);
  const value = JSON.parse(readFileSync(resolvedPath, 'utf8')) as Partial<PackageRuntimeActivationRequest>;
  if (
    value.schemaVersion !== 1
    || typeof value.operationId !== 'string'
    || typeof value.controllerHome !== 'string'
    || !Number.isInteger(value.installerPid) || Number(value.installerPid) < 1
    || !value.release || typeof value.release !== 'object'
    || !value.config || typeof value.config !== 'object'
    || (value.connectorEndpoint !== undefined && typeof value.connectorEndpoint !== 'string')
    || (value.refreshConnector !== undefined && typeof value.refreshConnector !== 'boolean')
    || typeof value.priorAuthorityPresent !== 'boolean'
    || typeof value.publicationChanged !== 'boolean'
    || typeof value.runnerPath !== 'string'
    || typeof value.nodeExecutable !== 'string'
    || typeof value.requestPath !== 'string'
    || typeof value.receiptPath !== 'string'
    || typeof value.helperLabel !== 'string'
    || typeof value.helperSourcePlistPath !== 'string'
    || typeof value.helperInstalledPlistPath !== 'string'
    || typeof value.createdAt !== 'string'
  ) throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_REQUEST_INVALID');
  const request = value as PackageRuntimeActivationRequest;
  if (resolve(request.requestPath) !== resolvedPath) throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_REQUEST_PATH_MISMATCH');
  if (resolve(request.controllerHome) !== resolve(request.config.controllerHome)) throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_HOME_MISMATCH');
  return request;
}

function activationXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function renderPackageRuntimeActivationLaunchAgent(request: PackageRuntimeActivationRequest): string {
  const executable = resolve(request.nodeExecutable);
  const cliEntry = join(request.release.packageRoot, 'src', 'cli', 'index.ts');
  const args = [executable, cliEntry, 'runtime', 'service', 'activate-package', '--request', request.requestPath];
  const stdoutPath = join(activationRoot(request.controllerHome), `${request.operationId}.stdout.log`);
  const stderrPath = join(activationRoot(request.controllerHome), `${request.operationId}.stderr.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${activationXml(request.helperLabel)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((arg) => `    <string>${activationXml(arg)}</string>`).join('\n')}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>StandardOutPath</key>\n  <string>${activationXml(stdoutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${activationXml(stderrPath)}</string>\n</dict>\n</plist>\n`;
}

async function scheduleDarwinPackageRuntimeActivation(request: PackageRuntimeActivationRequest): Promise<{ label: string; servicePath: string }> {
  if (process.platform !== 'darwin') throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_HELPER_PLATFORM_UNSUPPORTED');
  atomicWrite(request.helperSourcePlistPath, renderPackageRuntimeActivationLaunchAgent(request), 0o600);
  installLaunchAgent(request.helperSourcePlistPath, request.helperLabel);
  const result = await bootstrapLaunchAgentWithRetryV2({ label: request.helperLabel, plistPath: request.helperInstalledPlistPath });
  if (!result.ok) throw new Error(`FORGE_PACKAGE_RUNTIME_ACTIVATION_HELPER_BOOTSTRAP_FAILED: ${result.diagnostics.join('; ')}`);
  return { label: request.helperLabel, servicePath: request.helperInstalledPlistPath };
}

async function waitForInstallerExit(pid: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM') throw error;
    }
    await sleep(50);
  }
  throw new Error(`FORGE_PACKAGE_RUNTIME_ACTIVATION_INSTALLER_STILL_RUNNING: pid=${pid}`);
}

async function cleanupActivationHelper(request: PackageRuntimeActivationRequest): Promise<void> {
  rmSync(request.helperSourcePlistPath, { force: true });
  rmSync(request.helperInstalledPlistPath, { force: true });
  if (process.platform !== 'darwin') return;
  const child = spawn('/bin/launchctl', ['bootout', `${currentUserLaunchdDomain()}/${request.helperLabel}`], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  child.unref();
}

async function rollbackPackageRuntimeActivation(
  request: PackageRuntimeActivationRequest,
  installDarwinService: typeof installForgeRuntimeService,
  options: {
    restoreConnector?: boolean;
    ensureConnectorService?: typeof ensurePackageConnectorService;
  } = {},
): Promise<string[]> {
  const errors: string[] = [];
  const servicePaths = forgeRuntimeServicePaths(request.controllerHome);
  try {
    if (request.publicationChanged) {
      const current = readRuntimeReleaseAuthority(request.controllerHome);
      if (!current || current.active.releaseId !== request.release.releaseId || current.operationId !== request.operationId) {
        throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_ROLLBACK_FENCE_MISMATCH');
      }
      if (request.priorAuthorityPresent) rollbackRuntimeRelease(request.controllerHome, `${request.operationId}-rollback`);
      else revertInitialRuntimeReleasePublication(request.controllerHome, request.operationId);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    if (request.priorConfigBytes === undefined) rmSync(servicePaths.configPath, { force: true });
    else atomicWrite(servicePaths.configPath, request.priorConfigBytes);
    syncForgeRuntimeActiveEntrypoint(request.controllerHome);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (request.priorAuthorityPresent && request.priorConfigBytes !== undefined) {
    try {
      const priorConfig = readForgeRuntimeServiceConfig(servicePaths.configPath);
      await installDarwinService({
        config: priorConfig,
        runnerPath: join(priorConfig.repositoryRoot, 'bin', 'forge-runtime-service.mjs'),
        nodeExecutable: request.nodeExecutable,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (options.restoreConnector && request.connectorEndpoint && request.priorAuthorityPresent) {
    try {
      const restored = readRuntimeReleaseAuthority(request.controllerHome);
      if (!restored) throw new Error('FORGE_PACKAGE_CONNECTOR_ROLLBACK_AUTHORITY_MISSING');
      const releaseRoot = dirname(resolve(restored.active.manifestPath));
      const packageRoot = join(releaseRoot, 'package');
      const ensureConnectorService = options.ensureConnectorService ?? ensurePackageConnectorService;
      await ensureConnectorService({
        release: {
          releaseId: restored.active.releaseId,
          releaseRoot,
          packageRoot,
        },
        controllerHome: request.controllerHome,
        endpoint: request.connectorEndpoint,
        executable: request.nodeExecutable,
        platform: 'darwin',
        refresh: true,
      });
    } catch (error) {
      errors.push(`primary Connector rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export async function activateScheduledPackageRuntimeService(
  request: PackageRuntimeActivationRequest,
  dependencies: PackageRuntimeActivationDependencies = {},
): Promise<PackageRuntimeActivationReceipt> {
  const installDarwinService = dependencies.installDarwinService ?? installForgeRuntimeService;
  const ensureConnectorService = dependencies.ensureConnectorService ?? ensurePackageConnectorService;
  const wait = dependencies.waitForInstallerExit ?? waitForInstallerExit;
  const cleanup = dependencies.cleanupActivationHelper ?? cleanupActivationHelper;
  try {
    await wait(request.installerPid);
    const authority = readRuntimeReleaseAuthority(request.controllerHome);
    if (!authority || authority.active.releaseId !== request.release.releaseId) {
      throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_AUTHORITY_MISMATCH');
    }
    if (request.publicationChanged && authority.operationId !== request.operationId) {
      throw new Error('FORGE_PACKAGE_RUNTIME_ACTIVATION_FENCE_MISMATCH');
    }
    const paths = await installDarwinService({
      config: request.config,
      runnerPath: request.runnerPath,
      nodeExecutable: request.nodeExecutable,
    });
    if (request.connectorEndpoint) {
      await ensureConnectorService({
        release: request.release,
        controllerHome: request.controllerHome,
        endpoint: request.connectorEndpoint,
        executable: request.nodeExecutable,
        platform: 'darwin',
        refresh: request.refreshConnector === true,
      });
    }
    return writeActivationReceipt(request, 'activated', { servicePath: paths.installedPlistPath });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const rollbackErrors = await rollbackPackageRuntimeActivation(request, installDarwinService, {
      restoreConnector: Boolean(request.connectorEndpoint),
      ensureConnectorService,
    });
    writeActivationReceipt(request, 'failed+rollback', {
      error: detail,
      rollbackSucceeded: rollbackErrors.length === 0,
      ...(rollbackErrors.length ? { rollbackErrors } : {}),
    });
    if (rollbackErrors.length > 0) {
      throw new Error(`FORGE_PACKAGE_RUNTIME_ACTIVATION_FAILED_AND_ROLLBACK_FAILED: ${detail}; rollback: ${rollbackErrors.join('; ')}`);
    }
    throw new Error(`FORGE_PACKAGE_RUNTIME_ACTIVATION_FAILED_ROLLED_BACK: ${detail}`);
  } finally {
    await cleanup(request);
  }
}

export async function activateScheduledPackageRuntimeServiceFromPath(requestPath: string): Promise<PackageRuntimeActivationReceipt> {
  return activateScheduledPackageRuntimeService(readPackageRuntimeActivationRequest(requestPath));
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
  const explicitInjectedInline = Boolean(dependencies.installDarwinService && !dependencies.scheduleDarwinActivation && !dependencies.activationMode);
  const activationMode = dependencies.activationMode ?? (explicitInjectedInline ? 'inline' : 'detached');
  const connectorEndpoint = loadMcpServiceLocalConfig(controllerHome)?.chatgpt?.localEndpoint;

  let base: PackageRuntimeServiceInstallResult;
  if (!options.forcePortable && platform === 'darwin' && activationMode === 'detached') {
    const paths = activationPaths(controllerHome, operationId);
    const helperLabel = `com.moretea.forge.runtime-activation.${operationId.replace(/[^A-Za-z0-9.-]+/g, '-').slice(-48)}`;
    const createdAt = new Date().toISOString();
    const request: PackageRuntimeActivationRequest = {
      schemaVersion: 1,
      operationId,
      controllerHome,
      installerPid: process.pid,
      release,
      config,
      ...(connectorEndpoint ? { connectorEndpoint } : {}),
      ...(options.refreshConnector !== undefined ? { refreshConnector: options.refreshConnector === true } : {}),
      priorAuthorityPresent: Boolean(priorAuthority),
      ...(priorConfigBytes !== undefined ? { priorConfigBytes } : {}),
      publicationChanged,
      runnerPath: join(release.packageRoot, 'bin', 'forge-runtime-service.mjs'),
      nodeExecutable: process.execPath,
      requestPath: paths.requestPath,
      receiptPath: paths.receiptPath,
      helperLabel,
      helperSourcePlistPath: paths.helperSourcePlistPath,
      helperInstalledPlistPath: launchAgentPath(helperLabel),
      createdAt,
    };
    writeActivationRequest(request);
    writeActivationReceipt(request, 'activation_scheduled');
    const schedule = dependencies.scheduleDarwinActivation ?? scheduleDarwinPackageRuntimeActivation;
    let helper: { label: string; servicePath: string };
    try {
      helper = await schedule(request);
    } catch (scheduleError) {
      const detail = scheduleError instanceof Error ? scheduleError.message : String(scheduleError);
      const rollbackErrors = await rollbackPackageRuntimeActivation(request, installDarwinService);
      writeActivationReceipt(request, 'failed+rollback', {
        error: detail,
        rollbackSucceeded: rollbackErrors.length === 0,
        ...(rollbackErrors.length ? { rollbackErrors } : {}),
      });
      if (rollbackErrors.length > 0) {
        throw new Error(`FORGE_PACKAGE_RUNTIME_ACTIVATION_SCHEDULE_FAILED_AND_ROLLBACK_FAILED: ${detail}; rollback: ${rollbackErrors.join('; ')}`);
      }
      throw scheduleError;
    }
    base = {
      status: 'activation_scheduled',
      mode: 'launchd',
      persistent: true,
      controllerHome,
      release,
      servicePath: servicePaths.installedPlistPath,
      warnings: [],
      activation: {
        operationId,
        status: 'activation_scheduled',
        receiptPath: request.receiptPath,
        helperLabel: helper.label,
        helperServicePath: helper.servicePath,
      },
    };
  } else {
    try {
      if (!options.forcePortable && platform === 'darwin') {
        const paths = await installDarwinService({ config, runnerPath: join(release.packageRoot, 'bin', 'forge-runtime-service.mjs'), nodeExecutable: process.execPath });
        base = { status: 'activated', mode: 'launchd', persistent: true, controllerHome, release, servicePath: paths.installedPlistPath, warnings: [] };
      } else if (!options.forcePortable && platform === 'linux' && systemdUserAvailable(env)) {
        const unitPath = installSystemdUserService(controllerHome, env);
        base = { status: 'activated', mode: 'systemd-user', persistent: true, controllerHome, release, servicePath: unitPath, warnings: [] };
      } else {
        const pid = startPortableRuntime(controllerHome, env);
        base = {
          status: 'activated', mode: 'portable', persistent: false, controllerHome, release, pid,
          warnings: [platform === 'win32'
            ? 'Native Windows is preview: Forge started detached Runtime and OAuth Gateway processes for this session; automatic login/reboot persistence is not yet claimed.'
            : 'systemd --user is unavailable: Forge started detached Runtime and OAuth Gateway processes; enable a user service manager for reboot persistence.'],
        };
      }
    } catch (installError) {
      const requestPaths = activationPaths(controllerHome, operationId);
      const rollbackRequest: PackageRuntimeActivationRequest = {
        schemaVersion: 1,
        operationId,
        controllerHome,
        installerPid: process.pid,
        release,
        config,
        priorAuthorityPresent: Boolean(priorAuthority),
        ...(priorConfigBytes !== undefined ? { priorConfigBytes } : {}),
        publicationChanged,
        runnerPath: join(release.packageRoot, 'bin', 'forge-runtime-service.mjs'),
        nodeExecutable: process.execPath,
        requestPath: requestPaths.requestPath,
        receiptPath: requestPaths.receiptPath,
        helperLabel: 'inline',
        helperSourcePlistPath: requestPaths.helperSourcePlistPath,
        helperInstalledPlistPath: requestPaths.helperSourcePlistPath,
        createdAt: new Date().toISOString(),
      };
      const recoveryErrors = await rollbackPackageRuntimeActivation(rollbackRequest, installDarwinService);
      const detail = installError instanceof Error ? installError.message : String(installError);
      if (recoveryErrors.length > 0) {
        throw new Error(`FORGE_PACKAGE_RUNTIME_INSTALL_FAILED_AND_RECOVERY_FAILED: ${detail}; recovery: ${recoveryErrors.join('; ')}`);
      }
      throw installError;
    }
  }

  if (!connectorEndpoint || base.status === 'activation_scheduled') return base;
  const ensureConnectorService = dependencies.ensureConnectorService ?? ensurePackageConnectorService;
  const connector = await ensureConnectorService({
    release, controllerHome, endpoint: connectorEndpoint, executable: process.execPath, platform, env, forcePortable: options.forcePortable === true, refresh: options.refreshConnector === true,
  });
  return { ...base, connector };
}
