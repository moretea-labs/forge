import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  relocateStoppedControllerHomeAuthority,
  rollbackStoppedControllerHomeAuthorityRelocation,
  type StoppedControllerHomeAuthorityRelocation,
} from '../../cli/repositories/controller-home';
import { inspectControlPlaneDatabaseFile } from '../control-plane/persistence/sqlite-store';
import {
  activeRuntimeEntrypoint,
  forgeRuntimeServicePaths,
  readForgeRuntimeServiceConfig,
  syncForgeRuntimeActiveEntrypoint,
  writeForgeRuntimeServiceConfig,
  type ForgeRuntimeServiceConfig,
} from '../root/service';
import {
  installPackageRuntimeService,
  packageRuntimeSystemdUserUnitInput,
} from '../root/package-runtime-service';
import { runtimeReleaseAuthorityPath } from '../root/release-store';
import {
  ensurePackageConnectorService,
  packageConnectorServicePaths,
  readPackageConnectorServiceAuthority,
  waitForPackageConnectorEndpointReady,
  type PackageConnectorServiceAuthority,
} from '../root/package-connector-service';
import {
  loadMcpServiceLocalConfig,
  writeMcpServiceLocalConfig,
  type McpLocalConfig,
} from '../../../adapters/mcp/auth';
import {
  installSystemdUserUnit,
  systemdUserAvailable,
  systemdUserServicePid,
  systemdUserUnitPath,
} from '../../cli/controller/systemd-user';
import {
  RECOVERY_GATEWAY_LABEL,
  RECOVERY_WATCHDOG_LABEL,
  recoverySystemdUserUnitInput,
  verifyRecoveryReleaseActivation,
} from './installer';
import {
  createRecoveryConfig,
  loadRecoveryConfig,
  verifyStableRuntime,
  type RecoveryConfig,
} from './core';
import { readCurrentRecoveryRelease } from './release';

export interface RecoveryControllerHomeMigrationPreflight {
  sourceHome: string;
  destinationHome: string;
  liveOwners: Array<{ label: string; pid: number }>;
  destinationExists: boolean;
  destinationAuthorityFree: boolean;
  destinationUnexpectedFiles: string[];
  destinationRecordCount?: number;
  destinationAuditEventCount?: number;
}

export interface LinuxControllerHomeMigrationRequest {
  schemaVersion: 1;
  operationId: string;
  sourceHome: string;
  destinationHome: string;
  archiveSuffix: string;
  destinationExisted: boolean;
  runtimeConfig: ForgeRuntimeServiceConfig;
  recoveryConfig: RecoveryConfig;
  mcpConfig?: McpLocalConfig;
  connectorAuthority?: PackageConnectorServiceAuthority;
  /** Interpreter captured from the active immutable Runtime launcher before cutover. */
  packageExecutable: string;
  timeoutMs: number;
  createdAt: string;
  requestPath: string;
  receiptPath: string;
  logPath: string;
  /** Stable launcher outside both Controller Homes so systemd restart survives relocation. */
  workerLauncherPath: string;
  workerUnit: string;
}

export type LinuxControllerHomeMigrationStatus = 'scheduled' | 'running' | 'committed' | 'rolled_back' | 'failed';
export type LinuxControllerHomeMigrationPhase =
  | 'scheduled'
  | 'stopping_source'
  | 'relocating'
  | 'installing_destination'
  | 'verifying_destination'
  | 'rolling_back'
  | 'restoring_source'
  | 'verifying_source'
  | 'complete';

export interface LinuxControllerHomeMigrationReceipt {
  schemaVersion: 1;
  operationId: string;
  status: LinuxControllerHomeMigrationStatus;
  phase: LinuxControllerHomeMigrationPhase;
  sourceHome: string;
  destinationHome: string;
  requestPath: string;
  receiptPath: string;
  logPath: string;
  workerUnit: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  rollbackError?: string;
  relocation?: StoppedControllerHomeAuthorityRelocation;
  destinationServices?: ControllerHomeMigrationServiceObservation;
  restoredSourceServices?: ControllerHomeMigrationServiceObservation;
}

export interface ControllerHomeMigrationServiceObservation {
  runtimePid: number;
  connectorPid: number;
  recoveryGatewayPid: number;
  recoveryWatchdogPid: number;
}

export interface LinuxControllerHomeMigrationDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  uuid?: () => string;
  packageExecutable?: (controllerHome: string) => string;
  systemdAvailable?: (env: NodeJS.ProcessEnv) => boolean;
  systemdPid?: (label: string) => number | undefined;
  inspectDatabaseFile?: typeof inspectControlPlaneDatabaseFile;
  spawnWorker?: (request: LinuxControllerHomeMigrationRequest) => void;
  stopServices?: (controllerHome: string, request: LinuxControllerHomeMigrationRequest) => Promise<void>;
  installServices?: (controllerHome: string, request: LinuxControllerHomeMigrationRequest) => Promise<void>;
  verifyServices?: (
    controllerHome: string,
    otherHome: string,
    request: LinuxControllerHomeMigrationRequest,
  ) => Promise<ControllerHomeMigrationServiceObservation>;
  relocate?: typeof relocateStoppedControllerHomeAuthority;
  rollbackRelocation?: typeof rollbackStoppedControllerHomeAuthorityRelocation;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function controllerHomeFiles(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...controllerHomeFiles(root, path));
    else files.push(relative(root, path));
  }
  return files.sort();
}

function pathStrictlyContains(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function assertControllerHomePathsDisjoint(sourceHome: string, destinationHome: string): void {
  if (resolve(sourceHome) === resolve(destinationHome)) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SAME_HOME');
  if (pathStrictlyContains(sourceHome, destinationHome) || pathStrictlyContains(destinationHome, sourceHome)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_OVERLAPPING_HOMES');
  }
}

export function recoveryControllerHomeMigrationPreflight(
  sourceHomeInput: string,
  destinationHomeInput: string,
  dependencies: {
    systemdPid?: (label: string) => number | undefined;
    inspectDatabaseFile?: typeof inspectControlPlaneDatabaseFile;
  } = {},
): RecoveryControllerHomeMigrationPreflight {
  const sourceHome = resolve(sourceHomeInput);
  const destinationHome = resolve(destinationHomeInput);
  assertControllerHomePathsDisjoint(sourceHome, destinationHome);
  if (!existsSync(sourceHome) || !statSync(sourceHome).isDirectory()) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_MISSING: ${sourceHome}`);
  }
  const pidFor = dependencies.systemdPid ?? systemdUserServicePid;
  const labels = [
    forgeRuntimeServicePaths(sourceHome).label,
    packageConnectorServicePaths(sourceHome).label,
    RECOVERY_GATEWAY_LABEL,
    RECOVERY_WATCHDOG_LABEL,
  ];
  const liveOwners = labels
    .map((label) => ({ label, pid: pidFor(label) }))
    .filter((entry): entry is { label: string; pid: number } => typeof entry.pid === 'number' && entry.pid > 0);

  const destinationExists = existsSync(destinationHome);
  let destinationRecordCount: number | undefined;
  let destinationAuditEventCount: number | undefined;
  let destinationUnexpectedFiles: string[] = [];
  if (destinationExists) {
    const databasePath = join(destinationHome, 'control-plane.sqlite');
    if (existsSync(databasePath)) {
      const inspection = (dependencies.inspectDatabaseFile ?? inspectControlPlaneDatabaseFile)(databasePath);
      destinationRecordCount = inspection.recordCount;
      destinationAuditEventCount = inspection.auditEventCount;
    }
    destinationUnexpectedFiles = controllerHomeFiles(destinationHome).filter((path) => !(
      path === 'control-plane.sqlite'
      || path === 'control-plane.sqlite-wal'
      || path === 'control-plane.sqlite-shm'
      || path.startsWith('source-baseline/')
    ));
  }
  const destinationAuthorityFree = !destinationExists || (
    (destinationRecordCount ?? 0) === 0
    && (destinationAuditEventCount ?? 0) === 0
    && destinationUnexpectedFiles.length === 0
  );
  return {
    sourceHome,
    destinationHome,
    liveOwners,
    destinationExists,
    destinationAuthorityFree,
    destinationUnexpectedFiles,
    ...(destinationRecordCount !== undefined ? { destinationRecordCount } : {}),
    ...(destinationAuditEventCount !== undefined ? { destinationAuditEventCount } : {}),
  };
}

export function assertRecoveryControllerHomeMigrationDestinationReady(preflight: RecoveryControllerHomeMigrationPreflight): void {
  if (!preflight.destinationAuthorityFree) {
    throw new Error(
      `RECOVERY_CONTROLLER_HOME_MIGRATION_DESTINATION_HAS_AUTHORITY: records=${preflight.destinationRecordCount ?? 0} `
      + `audit=${preflight.destinationAuditEventCount ?? 0} unexpected=${preflight.destinationUnexpectedFiles.join(',') || 'none'}`,
    );
  }
}

export function assertRecoveryControllerHomeMigrationStopped(preflight: RecoveryControllerHomeMigrationPreflight): void {
  if (preflight.liveOwners.length > 0) {
    throw new Error(
      `RECOVERY_CONTROLLER_HOME_MIGRATION_OWNERS_LIVE: ${preflight.liveOwners.map((entry) => `${entry.label}:${entry.pid}`).join(',')}`,
    );
  }
  assertRecoveryControllerHomeMigrationDestinationReady(preflight);
}

function evidenceRoot(destinationHome: string): string {
  return join(dirname(resolve(destinationHome)), 'controller-home-migrations');
}

function operationPaths(destinationHome: string, operationId: string): {
  requestPath: string;
  receiptPath: string;
  logPath: string;
  workerLauncherPath: string;
} {
  const root = evidenceRoot(destinationHome);
  return {
    requestPath: join(root, `${operationId}.request.json`),
    receiptPath: join(root, `${operationId}.receipt.json`),
    logPath: join(root, `${operationId}.log`),
    workerLauncherPath: join(root, `${operationId}.worker.cjs`),
  };
}

const CONTROLLER_HOME_MIGRATION_WORKER_UNIT = 'forge-controller-home-migration-worker';

function workerUnitForOperation(_operationId: string): string {
  // Recovery Gateway/Watchdog ownership is user-global, so Controller Home cutover must also have one transient writer.
  // A fixed systemd unit name makes systemd reject a concurrent migration before either worker stops services.
  return CONTROLLER_HOME_MIGRATION_WORKER_UNIT;
}

function safeOperationId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{8,120}$/.test(normalized)) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_OPERATION_ID_INVALID');
  return normalized;
}

function containedPath(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function remapHomeValue<T>(value: T, sourceHome: string, destinationHome: string): T {
  if (typeof value === 'string') {
    // Runtime/tunnel secrets remain references. Remap only an in-Home file: reference, never env: references or secret bytes.
    if (value.startsWith('file:')) {
      const referenced = value.slice('file:'.length);
      if (isAbsolute(referenced) && containedPath(referenced, sourceHome)) {
        const rel = relative(resolve(sourceHome), resolve(referenced));
        return `file:${resolve(destinationHome, rel)}` as T;
      }
      return value;
    }
    if (!isAbsolute(value) || !containedPath(value, sourceHome)) return value;
    const rel = relative(resolve(sourceHome), resolve(value));
    return resolve(destinationHome, rel) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => remapHomeValue(entry, sourceHome, destinationHome)) as T;
  if (value && typeof value === 'object') {
    const mapped = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, remapHomeValue(entry, sourceHome, destinationHome)]));
    return mapped as T;
  }
  return value;
}

function activePackageExecutable(controllerHome: string): string {
  const entrypoint = activeRuntimeEntrypoint(controllerHome);
  if (!entrypoint) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_RUNTIME_RELEASE_MISSING');
  const firstLine = readFileSync(entrypoint, 'utf8').split(/\r?\n/, 1)[0] ?? '';
  const match = firstLine.match(/^#!(.+)$/);
  if (!match?.[1]?.trim()) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_RUNTIME_LAUNCHER_EXECUTABLE_UNAVAILABLE');
  const executable = resolve(match[1].trim());
  if (!existsSync(executable)) throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_RUNTIME_LAUNCHER_EXECUTABLE_MISSING: ${executable}`);
  if (containedPath(executable, controllerHome)) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_RUNTIME_LAUNCHER_EXECUTABLE_INSIDE_HOME');
  if (/^forge-recovery(?:-(?:gateway|watchdog))?$/i.test(basename(executable))) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_RUNTIME_LAUNCHER_EXECUTABLE_INVALID');
  }
  return executable;
}

function readRequest(requestPath: string): LinuxControllerHomeMigrationRequest {
  const parsed = JSON.parse(readFileSync(resolve(requestPath), 'utf8')) as LinuxControllerHomeMigrationRequest;
  if (parsed.schemaVersion !== 1) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_REQUEST_VERSION_UNSUPPORTED');
  safeOperationId(parsed.operationId);
  assertControllerHomePathsDisjoint(parsed.sourceHome, parsed.destinationHome);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(parsed.archiveSuffix)) throw new Error('CONTROLLER_HOME_RELOCATION_ARCHIVE_SUFFIX_INVALID');
  if (!Number.isInteger(parsed.timeoutMs) || parsed.timeoutMs < 30_000 || parsed.timeoutMs > 900_000) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_TIMEOUT_INVALID');
  }
  const expectedPaths = operationPaths(parsed.destinationHome, parsed.operationId);
  if (resolve(parsed.requestPath) !== resolve(requestPath) || resolve(parsed.requestPath) !== resolve(expectedPaths.requestPath)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_REQUEST_PATH_MISMATCH');
  }
  if (
    resolve(parsed.receiptPath) !== resolve(expectedPaths.receiptPath)
    || resolve(parsed.logPath) !== resolve(expectedPaths.logPath)
    || typeof parsed.workerLauncherPath !== 'string'
    || resolve(parsed.workerLauncherPath) !== resolve(expectedPaths.workerLauncherPath)
  ) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_EVIDENCE_PATH_MISMATCH');
  }
  if (!existsSync(parsed.workerLauncherPath)) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_LAUNCHER_MISSING');
  if (containedPath(parsed.workerLauncherPath, parsed.sourceHome) || containedPath(parsed.workerLauncherPath, parsed.destinationHome)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_LAUNCHER_INSIDE_HOME');
  }
  if (parsed.workerUnit !== workerUnitForOperation(parsed.operationId)) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_UNIT_MISMATCH');
  if (!isAbsolute(parsed.packageExecutable) || !existsSync(parsed.packageExecutable)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_PACKAGE_EXECUTABLE_INVALID');
  }
  if (containedPath(parsed.packageExecutable, parsed.sourceHome) || containedPath(parsed.packageExecutable, parsed.destinationHome)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_PACKAGE_EXECUTABLE_INSIDE_HOME');
  }
  if (/^forge-recovery(?:-(?:gateway|watchdog))?$/i.test(basename(parsed.packageExecutable))) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_PACKAGE_EXECUTABLE_INVALID');
  }
  return parsed;
}

export function readLinuxControllerHomeMigrationReceipt(receiptPath: string): LinuxControllerHomeMigrationReceipt | undefined {
  if (!existsSync(receiptPath)) return undefined;
  return JSON.parse(readFileSync(receiptPath, 'utf8')) as LinuxControllerHomeMigrationReceipt;
}

function writeReceipt(
  request: LinuxControllerHomeMigrationRequest,
  prior: LinuxControllerHomeMigrationReceipt | undefined,
  patch: Partial<Omit<LinuxControllerHomeMigrationReceipt, 'schemaVersion' | 'operationId' | 'sourceHome' | 'destinationHome' | 'requestPath' | 'receiptPath' | 'logPath' | 'workerUnit' | 'createdAt'>>,
): LinuxControllerHomeMigrationReceipt {
  const receipt: LinuxControllerHomeMigrationReceipt = {
    schemaVersion: 1,
    operationId: request.operationId,
    status: prior?.status ?? 'scheduled',
    phase: prior?.phase ?? 'scheduled',
    sourceHome: request.sourceHome,
    destinationHome: request.destinationHome,
    requestPath: request.requestPath,
    receiptPath: request.receiptPath,
    logPath: request.logPath,
    workerUnit: request.workerUnit,
    createdAt: prior?.createdAt ?? request.createdAt,
    ...prior,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  atomicJson(request.receiptPath, receipt);
  return receipt;
}

function linuxControllerHomeMigrationWorkerLauncherSource(): string {
  // This tiny CommonJS bootstrap is stored beside the durable request, outside both Controller Homes.
  // On every systemd restart it resolves the package CLI from whichever Home currently owns the
  // relocated authority, so a RuntimeMaxSec kill can still enter fail-closed rollback.
  return `'use strict';\n`
    + `const { spawn } = require('node:child_process');\n`
    + `const { existsSync, readFileSync } = require('node:fs');\n`
    + `const { basename, isAbsolute, join, relative, resolve, sep } = require('node:path');\n`
    + `const requestPath = process.argv[2] ? resolve(process.argv[2]) : '';\n`
    + `if (!requestPath || !existsSync(requestPath)) { console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_REQUEST_MISSING'); process.exit(78); }\n`
    + `let request; try { request = JSON.parse(readFileSync(requestPath, 'utf8')); } catch (error) { console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_REQUEST_INVALID: '+error.message); process.exit(78); }\n`
    + `const sourceHome=resolve(request.sourceHome), destinationHome=resolve(request.destinationHome);\n`
    + `const activeHome=existsSync(sourceHome)?sourceHome:(existsSync(destinationHome)?destinationHome:undefined);\n`
    + `if(!activeHome){console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_HOME_MISSING');process.exit(78);}\n`
    + `const remap=(value)=>{const absolute=resolve(value);const rel=relative(sourceHome,absolute);const inside=rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));return inside?resolve(activeHome,rel):absolute;};\n`
    + `const repositoryRoot=request.runtimeConfig&&typeof request.runtimeConfig.repositoryRoot==='string'?request.runtimeConfig.repositoryRoot:'';\n`
    + `if(!repositoryRoot){console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_PACKAGE_ROOT_MISSING');process.exit(78);}\n`
    + `const packageRoot=remap(repositoryRoot), entry=join(packageRoot,'src','cli','index.ts'), loader=join(packageRoot,'src','runtime','shared','node-ts-loader.mjs');\n`
    + `if(!existsSync(entry)){console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_ENTRYPOINT_MISSING: '+entry);process.exit(78);}\n`
    + `const executable=resolve(request.packageExecutable||'');\n`
    + `if(!executable||!existsSync(executable)){console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_EXECUTABLE_MISSING');process.exit(78);}\n`
    + `const isBun=Boolean(process.versions&&process.versions.bun)||/(?:^|[\\/-])bun(?:$|[\\/]|\.exe$)/i.test(basename(executable));\n`
    + `if(!isBun&&!existsSync(loader)){console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_LOADER_MISSING: '+loader);process.exit(78);}\n`
    + `const command=['recovery','migrate-controller-home-worker','--request',requestPath];\n`
    + `const args=isBun?[entry,...command]:['--loader',loader,entry,...command];\n`
    + `const child=spawn(executable,args,{stdio:'inherit',env:{...process.env,FORGE_CONNECTOR_EXECUTABLE:executable}});\n`
    + `for(const signal of ['SIGINT','SIGTERM','SIGHUP']){try{process.on(signal,()=>child.kill(signal));}catch{}}\n`
    + `child.on('error',(error)=>{console.error('RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_LAUNCH_FAILED: '+error.message);process.exit(78);});\n`
    + `child.on('exit',(code)=>process.exit(code??1));\n`;
}

function writeLinuxControllerHomeMigrationWorkerLauncher(request: LinuxControllerHomeMigrationRequest): void {
  writeFileSync(request.workerLauncherPath, linuxControllerHomeMigrationWorkerLauncherSource(), { encoding: 'utf8', mode: 0o700 });
}

function cliWorkerInvocation(request: LinuxControllerHomeMigrationRequest): { executable: string; args: string[] } {
  return { executable: request.packageExecutable, args: [request.workerLauncherPath, request.requestPath] };
}

export function linuxControllerHomeMigrationSystemdRunArgs(request: LinuxControllerHomeMigrationRequest): string[] {
  const invocation = cliWorkerInvocation(request);
  return [
    '--user',
    '--collect',
    `--setenv=PATH=${process.env.PATH?.trim() || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
    `--setenv=FORGE_CONNECTOR_EXECUTABLE=${request.packageExecutable}`,
    `--unit=${request.workerUnit}`,
    '--property=Type=exec',
    '--property=Restart=on-failure',
    '--property=RestartSec=2',
    '--property=TimeoutStopSec=15',
    // If a phase wedges past the transaction budget, systemd kills this worker. Restart=on-failure
    // then launches a fresh worker, which sees status=running and enters fail-closed rollback.
    `--property=RuntimeMaxSec=${Math.ceil(request.timeoutMs / 1_000)}s`,
    `--property=StandardOutput=append:${request.logPath}`,
    `--property=StandardError=append:${request.logPath}`,
    invocation.executable,
    ...invocation.args,
  ];
}

function defaultSpawnWorker(request: LinuxControllerHomeMigrationRequest): void {
  const args = linuxControllerHomeMigrationSystemdRunArgs(request);
  const result = spawnSync('systemd-run', args, { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_WORKER_HANDOFF_FAILED: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

export function scheduleLinuxControllerHomeMigration(input: {
  sourceHome: string;
  destinationHome: string;
  archiveSuffix?: string;
  timeoutMs?: number;
}, dependencies: LinuxControllerHomeMigrationDependencies = {}): {
  request: LinuxControllerHomeMigrationRequest;
  preflight: RecoveryControllerHomeMigrationPreflight;
  receipt: LinuxControllerHomeMigrationReceipt;
} {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  const env = dependencies.env ?? process.env;
  if (!(dependencies.systemdAvailable ?? systemdUserAvailable)(env)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SYSTEMD_USER_REQUIRED');
  }
  const sourceHome = resolve(input.sourceHome);
  const destinationHome = resolve(input.destinationHome);
  const preflight = recoveryControllerHomeMigrationPreflight(sourceHome, destinationHome, {
    systemdPid: dependencies.systemdPid,
    inspectDatabaseFile: dependencies.inspectDatabaseFile,
  });
  assertRecoveryControllerHomeMigrationDestinationReady(preflight);

  const runtimeConfig = readForgeRuntimeServiceConfig(forgeRuntimeServicePaths(sourceHome).configPath);
  const recoveryConfig = loadRecoveryConfig(sourceHome);
  const mcpConfig = loadMcpServiceLocalConfig(sourceHome) ?? undefined;
  const connectorAuthority = readPackageConnectorServiceAuthority(sourceHome);
  const packageExecutable = (dependencies.packageExecutable ?? activePackageExecutable)(sourceHome);
  if (resolve(runtimeConfig.controllerHome) !== sourceHome || resolve(recoveryConfig.controllerHome) !== sourceHome) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_AUTHORITY_MISMATCH');
  }
  if (mcpConfig?.chatgpt?.localEndpoint && !connectorAuthority) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_CONNECTOR_AUTHORITY_MISSING');
  }
  const operationId = safeOperationId(`controller-home-${(dependencies.uuid ?? randomUUID)()}`);
  const paths = operationPaths(destinationHome, operationId);
  const archiveSuffix = input.archiveSuffix?.trim() || operationId;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(archiveSuffix)) throw new Error('CONTROLLER_HOME_RELOCATION_ARCHIVE_SUFFIX_INVALID');
  const request: LinuxControllerHomeMigrationRequest = {
    schemaVersion: 1,
    operationId,
    sourceHome,
    destinationHome,
    archiveSuffix,
    destinationExisted: preflight.destinationExists,
    runtimeConfig,
    recoveryConfig,
    ...(mcpConfig ? { mcpConfig } : {}),
    ...(connectorAuthority ? { connectorAuthority } : {}),
    packageExecutable,
    timeoutMs: Math.max(30_000, input.timeoutMs ?? 240_000),
    createdAt: new Date().toISOString(),
    ...paths,
    workerUnit: workerUnitForOperation(operationId),
  };
  mkdirSync(evidenceRoot(destinationHome), { recursive: true, mode: 0o700 });
  atomicJson(request.requestPath, request);
  writeLinuxControllerHomeMigrationWorkerLauncher(request);
  let receipt = writeReceipt(request, undefined, { status: 'scheduled', phase: 'scheduled' });
  try {
    (dependencies.spawnWorker ?? defaultSpawnWorker)(request);
  } catch (error) {
    receipt = writeReceipt(request, receipt, {
      status: 'failed',
      phase: 'complete',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return { request, preflight, receipt };
}

function runtimeAuthorityMigrationEvidencePaths(request: LinuxControllerHomeMigrationRequest): {
  root: string;
  source: string;
  destination: string;
} {
  const root = join(request.destinationHome, 'runtime', 'releases', 'migration-evidence', request.operationId);
  return { root, source: join(root, 'source-authority.json'), destination: join(root, 'destination-authority.json') };
}

function prepareDestinationRuntimeAuthority(request: LinuxControllerHomeMigrationRequest): void {
  const authorityPath = runtimeReleaseAuthorityPath(request.destinationHome);
  const evidence = runtimeAuthorityMigrationEvidencePaths(request);
  if (existsSync(evidence.source)) return;
  if (!existsSync(authorityPath)) return; // Legacy Runtime authority: destination install will initialize the canonical authority.
  mkdirSync(evidence.root, { recursive: true, mode: 0o700 });
  const parsed = JSON.parse(readFileSync(authorityPath, 'utf8')) as { active?: { manifestPath?: unknown } };
  const manifestPath = typeof parsed.active?.manifestPath === 'string' ? resolve(parsed.active.manifestPath) : undefined;
  if (!manifestPath || !containedPath(manifestPath, request.sourceHome)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_RUNTIME_AUTHORITY_UNEXPECTED');
  }
  renameSync(authorityPath, evidence.source);
}

function prepareRuntimeAuthorityForSourceRollback(request: LinuxControllerHomeMigrationRequest): void {
  const authorityPath = runtimeReleaseAuthorityPath(request.destinationHome);
  const evidence = runtimeAuthorityMigrationEvidencePaths(request);
  if (!existsSync(evidence.source)) return; // Original authority never needed rebasing; moving the Home back restores it directly.
  mkdirSync(evidence.root, { recursive: true, mode: 0o700 });
  if (existsSync(authorityPath)) {
    if (existsSync(evidence.destination)) {
      const activeBytes = readFileSync(authorityPath);
      const evidenceBytes = readFileSync(evidence.destination);
      if (!activeBytes.equals(evidenceBytes)) {
        throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_DESTINATION_RUNTIME_AUTHORITY_EVIDENCE_CONFLICT');
      }
      rmSync(authorityPath, { force: true });
    } else {
      renameSync(authorityPath, evidence.destination);
    }
  }
  renameSync(evidence.source, authorityPath);
}

function systemctl(env: NodeJS.ProcessEnv, args: string[], tolerateAbsent = false): void {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', env, timeout: 30_000 });
  if (result.status === 0) return;
  const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  if (tolerateAbsent && /not loaded|not found|does not exist|no such file|not enabled/i.test(detail)) return;
  throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SYSTEMCTL_FAILED: systemctl --user ${args.join(' ')}: ${detail}`);
}

function serviceLabels(controllerHome: string): string[] {
  return [
    forgeRuntimeServicePaths(controllerHome).label,
    packageConnectorServicePaths(controllerHome).label,
    RECOVERY_GATEWAY_LABEL,
    RECOVERY_WATCHDOG_LABEL,
  ];
}

async function defaultStopServices(controllerHome: string, request: LinuxControllerHomeMigrationRequest, env = process.env): Promise<void> {
  for (const label of serviceLabels(controllerHome)) {
    systemctl(env, ['stop', label], true);
    systemctl(env, ['disable', label], true);
    rmSync(systemdUserUnitPath(label, env), { force: true });
  }
  systemctl(env, ['daemon-reload']);
  const live = serviceLabels(controllerHome)
    .map((label) => ({ label, pid: systemdUserServicePid(label, env) }))
    .filter((entry) => entry.pid !== undefined);
  if (live.length > 0) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_STOP_UNVERIFIED: ${live.map((entry) => `${entry.label}:${entry.pid}`).join(',')}`);
  }
  void request;
}

async function defaultInstallServices(controllerHome: string, request: LinuxControllerHomeMigrationRequest, env = process.env): Promise<void> {
  const runtimeConfig = remapHomeValue(request.runtimeConfig, request.sourceHome, controllerHome);
  const recoveryConfig = remapHomeValue(request.recoveryConfig, request.sourceHome, controllerHome);
  const mcpConfig = request.mcpConfig ? remapHomeValue(request.mcpConfig, request.sourceHome, controllerHome) : undefined;
  if (mcpConfig) writeMcpServiceLocalConfig(controllerHome, mcpConfig);
  createRecoveryConfig(controllerHome, recoveryConfig);

  const restoringSource = resolve(controllerHome) === resolve(request.sourceHome);
  if (restoringSource) {
    // The original immutable Runtime authority was restored before the Home was renamed back.
    // Rebind its service contract directly; rematerializing here would publish a different
    // launcher identity if this worker is a compiled Recovery binary.
    writeForgeRuntimeServiceConfig(runtimeConfig);
    syncForgeRuntimeActiveEntrypoint(controllerHome);
    installSystemdUserUnit({
      unitName: forgeRuntimeServicePaths(controllerHome).label,
      unit: packageRuntimeSystemdUserUnitInput(controllerHome),
      env,
      errorPrefix: 'RECOVERY_CONTROLLER_HOME_MIGRATION_RUNTIME_REBIND_FAILED',
    });
    const endpoint = mcpConfig?.chatgpt?.localEndpoint;
    const connectorAuthority = request.connectorAuthority;
    if (!endpoint || !connectorAuthority) {
      throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_CONNECTOR_REBIND_EVIDENCE_MISSING');
    }
    const connector = await ensurePackageConnectorService({
      release: connectorAuthority,
      controllerHome,
      endpoint,
      executable: request.packageExecutable,
      platform: 'linux',
      env,
      refresh: true,
    });
    if (connector.mode !== 'systemd-user' || !connector.persistent) {
      throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_CONNECTOR_NOT_SYSTEMD: ${connector.mode}`);
    }
  } else {
    const runtime = await installPackageRuntimeService({
      controllerHome,
      packageRoot: runtimeConfig.repositoryRoot,
      host: runtimeConfig.host,
      port: runtimeConfig.port,
      authTokenFile: runtimeConfig.authTokenFile,
      ...(runtimeConfig.exclusiveWorkId ? { exclusiveWorkId: runtimeConfig.exclusiveWorkId } : {}),
      platform: 'linux',
      env,
      refreshConnector: true,
    });
    if (runtime.mode !== 'systemd-user' || !runtime.persistent) {
      throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_RUNTIME_NOT_SYSTEMD: ${runtime.mode}`);
    }
    if (!runtime.connector || runtime.connector.mode !== 'systemd-user' || !runtime.connector.persistent) {
      throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_CONNECTOR_NOT_SYSTEMD');
    }
  }

  // Recovery release bytes do not bind Controller Home. Preserve the exact immutable
  // current release and only rewrite its systemd unit/config bindings for the new Home.
  const currentRecovery = readCurrentRecoveryRelease(controllerHome);
  if (!currentRecovery) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_RECOVERY_RELEASE_MISSING');
  const recoveryEnv = { ...env, FORGE_CONNECTOR_EXECUTABLE: request.packageExecutable };
  installSystemdUserUnit({
    unitName: RECOVERY_GATEWAY_LABEL,
    unit: recoverySystemdUserUnitInput(controllerHome, 'gateway', recoveryEnv),
    env: recoveryEnv,
    errorPrefix: 'RECOVERY_CONTROLLER_HOME_MIGRATION_RECOVERY_GATEWAY_REBIND_FAILED',
  });
  installSystemdUserUnit({
    unitName: RECOVERY_WATCHDOG_LABEL,
    unit: recoverySystemdUserUnitInput(controllerHome, 'watchdog', recoveryEnv),
    env: recoveryEnv,
    errorPrefix: 'RECOVERY_CONTROLLER_HOME_MIGRATION_RECOVERY_WATCHDOG_REBIND_FAILED',
  });
  const activation = await verifyRecoveryReleaseActivation({
    controllerHome,
    config: loadRecoveryConfig(controllerHome),
    expectedRelease: currentRecovery,
    timeoutMs: 60_000,
  }, { platform: 'linux', systemdEnv: recoveryEnv });
  if (!activation.ok) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_RECOVERY_REBIND_UNVERIFIED: ${activation.failures.join('; ')}`);
  }
}

async function defaultVerifyServices(
  controllerHome: string,
  otherHome: string,
  request: LinuxControllerHomeMigrationRequest,
  env = process.env,
): Promise<ControllerHomeMigrationServiceObservation> {
  const labels = {
    runtime: forgeRuntimeServicePaths(controllerHome).label,
    connector: packageConnectorServicePaths(controllerHome).label,
    gateway: RECOVERY_GATEWAY_LABEL,
    watchdog: RECOVERY_WATCHDOG_LABEL,
  };
  const observation: ControllerHomeMigrationServiceObservation = {
    runtimePid: systemdUserServicePid(labels.runtime, env) ?? 0,
    connectorPid: systemdUserServicePid(labels.connector, env) ?? 0,
    recoveryGatewayPid: systemdUserServicePid(labels.gateway, env) ?? 0,
    recoveryWatchdogPid: systemdUserServicePid(labels.watchdog, env) ?? 0,
  };
  if (Object.values(observation).some((pid) => pid <= 0) || new Set(Object.values(observation)).size !== 4) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SERVICE_SET_INVALID: ${JSON.stringify(observation)}`);
  }
  for (const label of Object.values(labels)) {
    const unitPath = systemdUserUnitPath(label, env);
    const unit = existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : '';
    if (!unit.includes(resolve(controllerHome)) || unit.includes(resolve(otherHome))) {
      throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SERVICE_BINDING_INVALID: ${label}`);
    }
  }
  for (const label of [forgeRuntimeServicePaths(otherHome).label, packageConnectorServicePaths(otherHome).label]) {
    if (label !== labels.runtime && label !== labels.connector && systemdUserServicePid(label, env)) {
      throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_OLD_SERVICE_STILL_LIVE: ${label}`);
    }
  }
  const localEndpoint = loadMcpServiceLocalConfig(controllerHome)?.chatgpt?.localEndpoint;
  if (!localEndpoint || !(await waitForPackageConnectorEndpointReady(localEndpoint, { timeoutMs: 20_000 }))) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_CONNECTOR_UNHEALTHY: ${localEndpoint ?? 'missing endpoint'}`);
  }
  const verified = await verifyStableRuntime(loadRecoveryConfig(controllerHome));
  if (!verified.ok) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_DESTINATION_UNHEALTHY: ${JSON.stringify(verified).slice(0, 2_000)}`);
  }
  void request;
  return observation;
}

function relocationForRequest(request: LinuxControllerHomeMigrationRequest): StoppedControllerHomeAuthorityRelocation {
  const archivedDestinationHome = request.destinationExisted
    ? `${request.destinationHome}.pre-migration-${request.archiveSuffix}`
    : undefined;
  return {
    migrated: true,
    sourceHome: request.sourceHome,
    destinationHome: request.destinationHome,
    ...(archivedDestinationHome && existsSync(archivedDestinationHome) ? { archivedDestinationHome } : {}),
  };
}

function restoreArchivedDestinationShell(request: LinuxControllerHomeMigrationRequest): void {
  if (!request.destinationExisted || existsSync(request.destinationHome)) return;
  const archived = `${request.destinationHome}.pre-migration-${request.archiveSuffix}`;
  if (existsSync(archived)) renameSync(archived, request.destinationHome);
}

function deadlineGuard(deadline: number, now: () => number, phase: string): void {
  if (now() > deadline) throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_TIMEOUT: ${phase}`);
}

async function recoverInterruptedTransaction(
  request: LinuxControllerHomeMigrationRequest,
  receipt: LinuxControllerHomeMigrationReceipt,
  dependencies: LinuxControllerHomeMigrationDependencies,
): Promise<LinuxControllerHomeMigrationReceipt> {
  const env = dependencies.env ?? process.env;
  const stopServices = dependencies.stopServices ?? ((home, req) => defaultStopServices(home, req, env));
  const installServices = dependencies.installServices ?? ((home, req) => defaultInstallServices(home, req, env));
  const verifyServices = dependencies.verifyServices ?? ((home, other, req) => defaultVerifyServices(home, other, req, env));
  const rollback = dependencies.rollbackRelocation ?? rollbackStoppedControllerHomeAuthorityRelocation;
  let current = writeReceipt(request, receipt, {
    status: 'running',
    phase: 'rolling_back',
    error: receipt.error ?? 'previous migration worker exited before a terminal receipt; fail-closed recovery started',
  });
  try {
    if (!existsSync(request.sourceHome) && existsSync(request.destinationHome)) {
      await stopServices(request.destinationHome, request);
      prepareRuntimeAuthorityForSourceRollback(request);
      rollback(relocationForRequest(request));
    }
    restoreArchivedDestinationShell(request);
    current = writeReceipt(request, current, { phase: 'restoring_source' });
    await stopServices(request.sourceHome, request);
    await installServices(request.sourceHome, request);
    current = writeReceipt(request, current, { phase: 'verifying_source' });
    const restored = await verifyServices(request.sourceHome, request.destinationHome, request);
    return writeReceipt(request, current, {
      status: 'rolled_back',
      phase: 'complete',
      restoredSourceServices: restored,
    });
  } catch (error) {
    return writeReceipt(request, current, {
      status: 'failed',
      phase: 'complete',
      rollbackError: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runLinuxControllerHomeMigrationRequest(
  requestPath: string,
  dependencies: LinuxControllerHomeMigrationDependencies = {},
): Promise<LinuxControllerHomeMigrationReceipt> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  const request = readRequest(requestPath);
  const prior = readLinuxControllerHomeMigrationReceipt(request.receiptPath);
  if (prior && ['committed', 'rolled_back', 'failed'].includes(prior.status)) return prior;
  if (prior?.status === 'running') return recoverInterruptedTransaction(request, prior, dependencies);

  const env = dependencies.env ?? process.env;
  if (!(dependencies.systemdAvailable ?? systemdUserAvailable)(env)) {
    return writeReceipt(request, prior, {
      status: 'failed',
      phase: 'complete',
      error: 'RECOVERY_CONTROLLER_HOME_MIGRATION_SYSTEMD_USER_REQUIRED',
    });
  }
  const now = dependencies.now ?? Date.now;
  const deadline = now() + request.timeoutMs;
  const stopServices = dependencies.stopServices ?? ((home, req) => defaultStopServices(home, req, env));
  const installServices = dependencies.installServices ?? ((home, req) => defaultInstallServices(home, req, env));
  const verifyServices = dependencies.verifyServices ?? ((home, other, req) => defaultVerifyServices(home, other, req, env));
  const relocate = dependencies.relocate ?? relocateStoppedControllerHomeAuthority;
  const rollback = dependencies.rollbackRelocation ?? rollbackStoppedControllerHomeAuthorityRelocation;

  let receipt = writeReceipt(request, prior, { status: 'running', phase: 'stopping_source' });
  let relocation: StoppedControllerHomeAuthorityRelocation | undefined;
  try {
    await stopServices(request.sourceHome, request);
    deadlineGuard(deadline, now, 'stop source services');
    receipt = writeReceipt(request, receipt, { phase: 'relocating' });
    const stoppedPreflight = recoveryControllerHomeMigrationPreflight(request.sourceHome, request.destinationHome, {
      systemdPid: dependencies.systemdPid,
      inspectDatabaseFile: dependencies.inspectDatabaseFile,
    });
    assertRecoveryControllerHomeMigrationStopped(stoppedPreflight);
    relocation = relocate({
      sourceHome: request.sourceHome,
      destinationHome: request.destinationHome,
      archiveExistingDestination: request.destinationExisted,
      archiveSuffix: request.archiveSuffix,
    });
    receipt = writeReceipt(request, receipt, { relocation, phase: 'installing_destination' });
    deadlineGuard(deadline, now, 'relocate authority');
    prepareDestinationRuntimeAuthority(request);
    await installServices(request.destinationHome, request);
    deadlineGuard(deadline, now, 'install destination services');
    receipt = writeReceipt(request, receipt, { phase: 'verifying_destination' });
    const destinationServices = await verifyServices(request.destinationHome, request.sourceHome, request);
    deadlineGuard(deadline, now, 'verify destination services');
    return writeReceipt(request, receipt, {
      status: 'committed',
      phase: 'complete',
      destinationServices,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    receipt = writeReceipt(request, receipt, { phase: 'rolling_back', error: detail, ...(relocation ? { relocation } : {}) });
    try {
      if (!existsSync(request.sourceHome) && existsSync(request.destinationHome)) {
        await stopServices(request.destinationHome, request);
        prepareRuntimeAuthorityForSourceRollback(request);
        rollback(relocation ?? relocationForRequest(request));
      }
      restoreArchivedDestinationShell(request);
      receipt = writeReceipt(request, receipt, { phase: 'restoring_source' });
      await stopServices(request.sourceHome, request);
      await installServices(request.sourceHome, request);
      receipt = writeReceipt(request, receipt, { phase: 'verifying_source' });
      const restoredSourceServices = await verifyServices(request.sourceHome, request.destinationHome, request);
      return writeReceipt(request, receipt, {
        status: 'rolled_back',
        phase: 'complete',
        restoredSourceServices,
      });
    } catch (rollbackError) {
      return writeReceipt(request, receipt, {
        status: 'failed',
        phase: 'complete',
        rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
  }
}

// Compatibility facade for the pre-transaction Recovery API. These functions
// deliberately delegate to the transactional Linux migration engine above;
// they do not own a second cutover/rollback implementation.
export function defaultUserControllerHomeForMigration(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  return resolve(xdgStateHome ? join(xdgStateHome, 'forge', 'controller') : join(userHome, '.forge', 'controller'));
}

export function recoveryControllerHomeOwnerLabels(sourceHomeInput: string): string[] {
  return serviceLabels(resolve(sourceHomeInput));
}

export function assertRecoveryControllerHomeDestinationAuthorityFree(
  preflight: RecoveryControllerHomeMigrationPreflight,
): void {
  assertRecoveryControllerHomeMigrationDestinationReady(preflight);
}

export function assertRecoveryControllerHomeMigrationReady(
  preflight: RecoveryControllerHomeMigrationPreflight,
): void {
  assertRecoveryControllerHomeMigrationStopped(preflight);
}

export interface RecoveryControllerHomeMigrationScheduleInput {
  requestId: string;
  canonicalSourceRoot: string;
  expectedSourceRevision: string;
}

export interface RecoveryControllerHomeMigrationScheduleResult {
  status: 'scheduled' | 'already_migrated';
  requestId: string;
  sourceHome: string;
  destinationHome: string;
  unitName?: string;
  canonicalSourceRoot: string;
  expectedSourceRevision: string;
}

export interface RecoveryControllerHomeMigrationWorkerResult {
  ok: boolean;
  requestId: string;
  sourceHome: string;
  destinationHome: string;
  canonicalSourceRoot: string;
  expectedSourceRevision: string;
  relocation?: StoppedControllerHomeAuthorityRelocation;
  verification?: Awaited<ReturnType<typeof verifyStableRuntime>>;
  rollback?: { attempted: boolean; succeeded: boolean; errors: string[] };
  transaction?: LinuxControllerHomeMigrationReceipt;
}

function boundedCompatibilityRequestId(value: string): string {
  const requestId = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(requestId)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
  return requestId;
}

function compatibilityGitOutput(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024 });
  if (result.status !== 0) throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_GIT_FAILED: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout.trim();
}

export function validateRecoveryControllerHomeMigrationSource(
  canonicalSourceRootInput: string,
  expectedSourceRevisionInput: string,
): { canonicalSourceRoot: string; sourceRevision: string } {
  const canonicalSourceRoot = resolve(canonicalSourceRootInput);
  const expectedSourceRevision = expectedSourceRevisionInput.trim();
  if (!expectedSourceRevision) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REVISION_REQUIRED');
  const managedRoot = resolve(homedir(), '.forge', 'managed-worktrees');
  if (containedPath(canonicalSourceRoot, managedRoot) && canonicalSourceRoot !== managedRoot) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_MANAGED_WORKTREE_SOURCE_FORBIDDEN');
  }
  const topLevel = resolve(compatibilityGitOutput(canonicalSourceRoot, ['rev-parse', '--show-toplevel']));
  if (topLevel !== canonicalSourceRoot) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_CANONICAL_SOURCE_REQUIRED');
  const sourceRevision = compatibilityGitOutput(canonicalSourceRoot, ['rev-parse', 'HEAD']);
  if (sourceRevision !== expectedSourceRevision) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REVISION_MISMATCH: expected=${expectedSourceRevision} actual=${sourceRevision}`);
  }
  if (compatibilityGitOutput(canonicalSourceRoot, ['status', '--porcelain=v1'])) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_DIRTY');
  }
  const packagePath = join(canonicalSourceRoot, 'package.json');
  if (!existsSync(packagePath)) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_FORGE_SOURCE_REQUIRED');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown };
  if (packageJson.name !== '@moretea-labs/forge') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_FORGE_SOURCE_REQUIRED');
  return { canonicalSourceRoot, sourceRevision };
}

function compatibilityMigrationToken(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex').slice(0, 16);
}

function compatibilityOperationId(requestId: string): string {
  return `controller-home-${compatibilityMigrationToken(requestId)}`;
}

function compatibilityTransactionPaths(destinationHome: string, requestId: string) {
  return operationPaths(destinationHome, compatibilityOperationId(requestId));
}

function assertCompatibilityTransactionSource(
  request: LinuxControllerHomeMigrationRequest,
  source: { canonicalSourceRoot: string; sourceRevision: string },
): void {
  if (resolve(request.runtimeConfig.repositoryRoot) !== source.canonicalSourceRoot) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_AUTHORITY_MISMATCH');
  }
}

export function scheduleRecoveryControllerHomeMigration(
  config: RecoveryConfig,
  input: RecoveryControllerHomeMigrationScheduleInput,
  dependencies: { platform?: NodeJS.Platform; recoveryExecutable?: string } = {},
): RecoveryControllerHomeMigrationScheduleResult {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  const requestId = boundedCompatibilityRequestId(input.requestId);
  const sourceHome = resolve(config.controllerHome);
  const destinationHome = defaultUserControllerHomeForMigration();
  const source = validateRecoveryControllerHomeMigrationSource(input.canonicalSourceRoot, input.expectedSourceRevision);
  if (sourceHome === destinationHome) {
    return { status: 'already_migrated', requestId, sourceHome, destinationHome, canonicalSourceRoot: source.canonicalSourceRoot, expectedSourceRevision: source.sourceRevision };
  }
  const existingPath = compatibilityTransactionPaths(destinationHome, requestId).requestPath;
  if (existsSync(existingPath)) {
    const existing = readRequest(existingPath);
    assertCompatibilityTransactionSource(existing, source);
    return {
      status: 'scheduled', requestId, sourceHome, destinationHome,
      unitName: existing.workerUnit,
      canonicalSourceRoot: source.canonicalSourceRoot,
      expectedSourceRevision: source.sourceRevision,
    };
  }
  const token = compatibilityMigrationToken(requestId);
  const scheduled = scheduleLinuxControllerHomeMigration(
    { sourceHome, destinationHome, archiveSuffix: `recovery-${token}` },
    { platform, uuid: () => token },
  );
  assertCompatibilityTransactionSource(scheduled.request, source);
  return {
    status: 'scheduled', requestId, sourceHome, destinationHome,
    unitName: scheduled.request.workerUnit,
    canonicalSourceRoot: source.canonicalSourceRoot,
    expectedSourceRevision: source.sourceRevision,
  };
}

export async function runRecoveryControllerHomeMigrationWorker(
  config: RecoveryConfig,
  input: RecoveryControllerHomeMigrationScheduleInput,
  dependencies: { platform?: NodeJS.Platform; startupDelayMs?: number } = {},
): Promise<RecoveryControllerHomeMigrationWorkerResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  const requestId = boundedCompatibilityRequestId(input.requestId);
  const sourceHome = resolve(config.controllerHome);
  const destinationHome = defaultUserControllerHomeForMigration();
  const source = validateRecoveryControllerHomeMigrationSource(input.canonicalSourceRoot, input.expectedSourceRevision);
  if (sourceHome === destinationHome) {
    const verification = await verifyStableRuntime(config);
    return { ok: verification.ok, requestId, sourceHome, destinationHome, canonicalSourceRoot: source.canonicalSourceRoot, expectedSourceRevision: source.sourceRevision, verification };
  }
  const paths = compatibilityTransactionPaths(destinationHome, requestId);
  if (!existsSync(paths.requestPath)) {
    const token = compatibilityMigrationToken(requestId);
    const prepared = scheduleLinuxControllerHomeMigration(
      { sourceHome, destinationHome, archiveSuffix: `recovery-${token}` },
      { platform, uuid: () => token, spawnWorker: () => undefined },
    );
    assertCompatibilityTransactionSource(prepared.request, source);
  } else {
    assertCompatibilityTransactionSource(readRequest(paths.requestPath), source);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, dependencies.startupDelayMs ?? 1_500));
  const transaction = await runLinuxControllerHomeMigrationRequest(paths.requestPath, { platform });
  const ok = transaction.status === 'committed';
  const verificationHome = ok ? destinationHome : transaction.status === 'rolled_back' ? sourceHome : undefined;
  const verification = verificationHome ? await verifyStableRuntime(loadRecoveryConfig(verificationHome)) : undefined;
  return {
    ok,
    requestId,
    sourceHome,
    destinationHome,
    canonicalSourceRoot: source.canonicalSourceRoot,
    expectedSourceRevision: source.sourceRevision,
    ...(transaction.relocation ? { relocation: transaction.relocation } : {}),
    ...(verification ? { verification } : {}),
    rollback: {
      attempted: transaction.status === 'rolled_back' || Boolean(transaction.rollbackError),
      succeeded: transaction.status === 'rolled_back',
      errors: transaction.rollbackError ? [transaction.rollbackError] : [],
    },
    transaction,
  };
}
