import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { systemdUserServicePid, systemdUserUnitName, systemdUserUnitPath } from '../../cli/controller/systemd-user';
import { relocateStoppedControllerHomeAuthority, rollbackStoppedControllerHomeAuthorityRelocation, type StoppedControllerHomeAuthorityRelocation } from '../../cli/repositories/controller-home';
import { inspectControlPlaneDatabaseFile } from '../control-plane/persistence/sqlite-store';
import { packageConnectorServicePaths } from '../root/package-connector-service';
import { installPackageRuntimeService } from '../root/package-runtime-service';
import { forgeRuntimeServicePaths } from '../root/service';
import { installStandaloneRecovery } from './installer';
import { loadRecoveryConfig, verifyStableRuntime, type RecoveryConfig } from './core';
import { RECOVERY_GATEWAY_LABEL, RECOVERY_WATCHDOG_LABEL } from './service-labels';

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

export function defaultUserControllerHomeForMigration(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  return resolve(xdgStateHome ? join(xdgStateHome, 'forge', 'controller') : join(userHome, '.forge', 'controller'));
}

export function recoveryControllerHomeOwnerLabels(sourceHomeInput: string): string[] {
  const sourceHome = resolve(sourceHomeInput);
  return [
    forgeRuntimeServicePaths(sourceHome).label,
    packageConnectorServicePaths(sourceHome).label,
    RECOVERY_GATEWAY_LABEL,
    RECOVERY_WATCHDOG_LABEL,
  ];
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
  if (sourceHome === destinationHome) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SAME_HOME');
  if (!existsSync(sourceHome) || !statSync(sourceHome).isDirectory()) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_MISSING: ${sourceHome}`);
  }
  const pidFor = dependencies.systemdPid ?? systemdUserServicePid;
  const liveOwners = recoveryControllerHomeOwnerLabels(sourceHome)
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

export function assertRecoveryControllerHomeDestinationAuthorityFree(
  preflight: RecoveryControllerHomeMigrationPreflight,
): void {
  if (!preflight.destinationAuthorityFree) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_DESTINATION_HAS_AUTHORITY: records=${preflight.destinationRecordCount ?? 0} audit=${preflight.destinationAuditEventCount ?? 0} unexpected=${preflight.destinationUnexpectedFiles.join(',') || 'none'}`);
  }
}

export function assertRecoveryControllerHomeMigrationReady(
  preflight: RecoveryControllerHomeMigrationPreflight,
): void {
  if (preflight.liveOwners.length > 0) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_OWNERS_LIVE: ${preflight.liveOwners.map((entry) => `${entry.label}:${entry.pid}`).join(',')}`);
  }
  assertRecoveryControllerHomeDestinationAuthorityFree(preflight);
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
  runtimeArchivePath?: string;
  relocation?: StoppedControllerHomeAuthorityRelocation;
  verification?: Awaited<ReturnType<typeof verifyStableRuntime>>;
  rollback?: { attempted: boolean; succeeded: boolean; errors: string[] };
}

function boundedRequestId(value: string): string {
  const requestId = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(requestId)) throw new Error('RECOVERY_REQUEST_ID_REQUIRED');
  return requestId;
}

function gitOutput(root: string, args: string[]): string {
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
  if (canonicalSourceRoot.includes(`${resolve(homedir(), '.forge', 'managed-worktrees')}/`)) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_MANAGED_WORKTREE_SOURCE_FORBIDDEN');
  }
  const topLevel = resolve(gitOutput(canonicalSourceRoot, ['rev-parse', '--show-toplevel']));
  if (topLevel !== canonicalSourceRoot) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_CANONICAL_SOURCE_REQUIRED');
  const sourceRevision = gitOutput(canonicalSourceRoot, ['rev-parse', 'HEAD']);
  if (sourceRevision !== expectedSourceRevision) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_REVISION_MISMATCH: expected=${expectedSourceRevision} actual=${sourceRevision}`);
  }
  if (gitOutput(canonicalSourceRoot, ['status', '--porcelain=v1'])) {
    throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_DIRTY');
  }
  const packagePath = join(canonicalSourceRoot, 'package.json');
  if (!existsSync(packagePath)) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_FORGE_SOURCE_REQUIRED');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown };
  if (packageJson.name !== '@moretea-labs/forge') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_FORGE_SOURCE_REQUIRED');
  return { canonicalSourceRoot, sourceRevision };
}

function command(command: string, args: string[], errorPrefix: string): void {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, env: process.env, maxBuffer: 512 * 1024 });
  if (result.status !== 0) throw new Error(`${errorPrefix}: ${(result.stderr || result.stdout || `${command} exited ${result.status}`).trim()}`);
}

function stopSystemdUnit(label: string): void {
  const unit = systemdUserUnitName(label);
  const result = spawnSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: 30_000, env: process.env });
  if (result.status !== 0 && systemdUserServicePid(unit) !== undefined) {
    throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_STOP_FAILED: ${unit}: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function retireSystemdUnit(label: string): void {
  const unit = systemdUserUnitName(label);
  spawnSync('systemctl', ['--user', 'disable', '--now', unit], { encoding: 'utf8', timeout: 30_000, env: process.env });
  rmSync(systemdUserUnitPath(unit), { force: true });
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', timeout: 30_000, env: process.env });
}

function stopControllerHomeOwners(controllerHome: string): void {
  const labels = recoveryControllerHomeOwnerLabels(controllerHome);
  // Watchdog must stop first so the intentionally stopped primary services are
  // not interpreted as an outage that needs automatic recovery.
  for (const label of [RECOVERY_WATCHDOG_LABEL, RECOVERY_GATEWAY_LABEL, labels[1], labels[0]]) stopSystemdUnit(label);
}

function migrationToken(requestId: string): string {
  return createHash('sha256').update(requestId).digest('hex').slice(0, 16);
}

function migrationResultPath(controllerHome: string, requestId: string): string {
  return join(resolve(controllerHome), 'recovery', 'migrations', `${migrationToken(requestId)}.json`);
}

function writeMigrationResult(controllerHome: string, requestId: string, value: unknown): void {
  const path = migrationResultPath(controllerHome, requestId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function scheduleRecoveryControllerHomeMigration(
  config: RecoveryConfig,
  input: RecoveryControllerHomeMigrationScheduleInput,
  dependencies: { platform?: NodeJS.Platform; recoveryExecutable?: string } = {},
): RecoveryControllerHomeMigrationScheduleResult {
  if ((dependencies.platform ?? process.platform) !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  const requestId = boundedRequestId(input.requestId);
  const sourceHome = resolve(config.controllerHome);
  const destinationHome = defaultUserControllerHomeForMigration();
  const source = validateRecoveryControllerHomeMigrationSource(input.canonicalSourceRoot, input.expectedSourceRevision);
  if (sourceHome === destinationHome) {
    return { status: 'already_migrated', requestId, sourceHome, destinationHome, canonicalSourceRoot: source.canonicalSourceRoot, expectedSourceRevision: source.sourceRevision };
  }
  const preflight = recoveryControllerHomeMigrationPreflight(sourceHome, destinationHome);
  assertRecoveryControllerHomeDestinationAuthorityFree(preflight);
  const executable = resolve(dependencies.recoveryExecutable ?? join(dirname(process.execPath), 'forge-recovery'));
  if (!existsSync(executable)) throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_EXECUTABLE_MISSING: ${executable}`);
  const unitName = `forge-recovery-controller-home-migration-${migrationToken(requestId)}`;
  const args = [
    '--user', '--unit', unitName, '--collect', '--property=Type=oneshot', '--property=Restart=no',
    executable, 'migrate-controller-home-worker', '--controller-home', sourceHome,
    '--canonical-source-root', source.canonicalSourceRoot,
    '--expected-source-revision', source.sourceRevision,
    '--request-id', requestId,
  ];
  command('systemd-run', args, 'RECOVERY_CONTROLLER_HOME_MIGRATION_SCHEDULE_FAILED');
  return { status: 'scheduled', requestId, sourceHome, destinationHome, unitName, canonicalSourceRoot: source.canonicalSourceRoot, expectedSourceRevision: source.sourceRevision };
}

function recoveryInstallInputFromConfig(config: RecoveryConfig, controllerHome: string, canonicalSourceRoot: string) {
  return {
    controllerHome,
    repoRoot: canonicalSourceRoot,
    sourceRoot: canonicalSourceRoot,
    port: config.gateway?.port ?? 8787,
    ...(config.publicMcpUrl ? { publicMcpUrl: config.publicMcpUrl } : {}),
    ...(config.recoveryPublicUrl ? { recoveryPublicUrl: config.recoveryPublicUrl } : {}),
    ...(config.recoveryTunnelService ? { recoveryTunnelService: config.recoveryTunnelService } : {}),
    ...(config.primaryPublicTunnelService ? { primaryPublicTunnelService: config.primaryPublicTunnelService } : {}),
    ...(config.primaryRuntimeService ? { primaryRuntimeService: config.primaryRuntimeService } : { primaryRuntimeService: { platform: 'systemd-user' as const } }),
    ...(config.primaryConnectorService ? { primaryConnectorService: config.primaryConnectorService } : { primaryConnectorService: { platform: 'systemd-user' as const, localMcpUrl: 'http://127.0.0.1:8767/mcp' } }),
  };
}

async function reinstallControllerHomeOwners(
  config: RecoveryConfig,
  controllerHome: string,
  canonicalSourceRoot: string,
): Promise<void> {
  await installPackageRuntimeService({
    controllerHome,
    packageRoot: canonicalSourceRoot,
    authTokenFile: join(controllerHome, 'mcp', 'runtime-token'),
    platform: 'linux',
    refreshConnector: true,
  });
  await installStandaloneRecovery(recoveryInstallInputFromConfig(config, controllerHome, canonicalSourceRoot));
}

export async function runRecoveryControllerHomeMigrationWorker(
  config: RecoveryConfig,
  input: RecoveryControllerHomeMigrationScheduleInput,
  dependencies: { platform?: NodeJS.Platform; startupDelayMs?: number } = {},
): Promise<RecoveryControllerHomeMigrationWorkerResult> {
  if ((dependencies.platform ?? process.platform) !== 'linux') throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_LINUX_ONLY');
  const requestId = boundedRequestId(input.requestId);
  const sourceHome = resolve(config.controllerHome);
  const destinationHome = defaultUserControllerHomeForMigration();
  const source = validateRecoveryControllerHomeMigrationSource(input.canonicalSourceRoot, input.expectedSourceRevision);
  if (sourceHome === destinationHome) {
    const verification = await verifyStableRuntime(config);
    const result: RecoveryControllerHomeMigrationWorkerResult = { ok: verification.ok, requestId, sourceHome, destinationHome, canonicalSourceRoot: source.canonicalSourceRoot, expectedSourceRevision: source.sourceRevision, verification };
    writeMigrationResult(destinationHome, requestId, result);
    return result;
  }
  // Give the Gateway enough time to flush the scheduling response before this
  // independent transient unit intentionally stops the Gateway service.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, dependencies.startupDelayMs ?? 1_500));
  const initialPreflight = recoveryControllerHomeMigrationPreflight(sourceHome, destinationHome);
  assertRecoveryControllerHomeDestinationAuthorityFree(initialPreflight);
  let relocation: StoppedControllerHomeAuthorityRelocation | undefined;
  let runtimeArchivePath: string | undefined;
  let runtimeArchived = false;
  const rollbackErrors: string[] = [];
  try {
    stopControllerHomeOwners(sourceHome);
    const stoppedPreflight = recoveryControllerHomeMigrationPreflight(sourceHome, destinationHome);
    assertRecoveryControllerHomeMigrationReady(stoppedPreflight);
    relocation = relocateStoppedControllerHomeAuthority({
      sourceHome,
      destinationHome,
      archiveExistingDestination: stoppedPreflight.destinationExists,
      archiveSuffix: `recovery-${migrationToken(requestId)}`,
    });

    const migratedRuntimePath = join(destinationHome, 'runtime');
    runtimeArchivePath = join(destinationHome, 'migration', 'controller-home', migrationToken(requestId), 'runtime-from-old-home');
    if (existsSync(migratedRuntimePath)) {
      mkdirSync(dirname(runtimeArchivePath), { recursive: true, mode: 0o700 });
      renameSync(migratedRuntimePath, runtimeArchivePath);
      runtimeArchived = true;
    }

    await reinstallControllerHomeOwners(config, destinationHome, source.canonicalSourceRoot);
    const migratedConfig = loadRecoveryConfig(destinationHome);
    if (resolve(migratedConfig.controllerHome) !== destinationHome) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_CONFIG_HOME_MISMATCH');
    if (resolve(migratedConfig.primaryRuntimeSourceRoot ?? '') !== source.canonicalSourceRoot) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_SOURCE_AUTHORITY_MISMATCH');
    const verification = await verifyStableRuntime(migratedConfig);
    if (!verification.ok) throw new Error('RECOVERY_CONTROLLER_HOME_MIGRATION_VERIFY_FAILED');

    const oldRuntimeLabel = forgeRuntimeServicePaths(sourceHome).label;
    const newRuntimeLabel = forgeRuntimeServicePaths(destinationHome).label;
    const oldConnectorLabel = packageConnectorServicePaths(sourceHome).label;
    const newConnectorLabel = packageConnectorServicePaths(destinationHome).label;
    if (oldRuntimeLabel !== newRuntimeLabel) retireSystemdUnit(oldRuntimeLabel);
    if (oldConnectorLabel !== newConnectorLabel) retireSystemdUnit(oldConnectorLabel);

    const result: RecoveryControllerHomeMigrationWorkerResult = {
      ok: true,
      requestId,
      sourceHome,
      destinationHome,
      canonicalSourceRoot: source.canonicalSourceRoot,
      expectedSourceRevision: source.sourceRevision,
      ...(runtimeArchivePath ? { runtimeArchivePath } : {}),
      relocation,
      verification,
    };
    writeMigrationResult(destinationHome, requestId, result);
    return result;
  } catch (error) {
    try { stopControllerHomeOwners(destinationHome); } catch (rollbackError) { rollbackErrors.push(`stop-new:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    if (runtimeArchived && runtimeArchivePath) {
      try {
        rmSync(join(destinationHome, 'runtime'), { recursive: true, force: true });
        if (existsSync(runtimeArchivePath)) renameSync(runtimeArchivePath, join(destinationHome, 'runtime'));
      } catch (rollbackError) {
        rollbackErrors.push(`runtime:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (relocation) {
      try { rollbackStoppedControllerHomeAuthorityRelocation(relocation); }
      catch (rollbackError) { rollbackErrors.push(`authority:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    }
    if (existsSync(sourceHome)) {
      try { await reinstallControllerHomeOwners(config, sourceHome, source.canonicalSourceRoot); }
      catch (rollbackError) { rollbackErrors.push(`owners:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
    }
    const result: RecoveryControllerHomeMigrationWorkerResult = {
      ok: false,
      requestId,
      sourceHome,
      destinationHome,
      canonicalSourceRoot: source.canonicalSourceRoot,
      expectedSourceRevision: source.sourceRevision,
      ...(runtimeArchivePath ? { runtimeArchivePath } : {}),
      ...(relocation ? { relocation } : {}),
      rollback: { attempted: true, succeeded: rollbackErrors.length === 0, errors: rollbackErrors },
    };
    try { writeMigrationResult(existsSync(sourceHome) ? sourceHome : destinationHome, requestId, { ...result, error: error instanceof Error ? error.message : String(error) }); } catch { /* best effort diagnostic */ }
    if (rollbackErrors.length > 0) throw new Error(`RECOVERY_CONTROLLER_HOME_MIGRATION_FAILED_ROLLBACK_INCOMPLETE: ${error instanceof Error ? error.message : String(error)}; ${rollbackErrors.join('; ')}`);
    throw error;
  }
}
