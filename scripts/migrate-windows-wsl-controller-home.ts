#!/usr/bin/env bun
/**
 * Direct bootstrap migration for the retired repo-local Controller Home.
 * It deliberately does not invoke Forge Runtime/MCP/CLI/Recovery. The source
 * Home is preserved as evidence; only the running service authority moves.
 */
import { createHash } from 'crypto';
import {
  existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';
import { spawnSync } from 'child_process';

const home = homedir();
const sourceRoot = resolve(process.cwd());
const legacyHome = resolve(join(sourceRoot, '_ops', 'controller-home'));
const canonicalHome = resolve(join(home, '.forge', 'controller'));
const rescueRoot = resolve(join(home, '.forge-recovery'));
const execute = process.argv.includes('--execute');

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function exactHome(value: string | undefined, expected: string, code: string): string {
  const resolved = resolve(value ?? expected);
  if (resolved !== expected) throw new Error(code);
  return resolved;
}

function unitFor(prefix: 'runtime' | 'connector', controllerHome: string): string {
  const suffix = createHash('sha256').update(resolve(controllerHome)).digest('hex').slice(0, 12);
  return prefix === 'runtime'
    ? `com.moretea.forge.runtime.${suffix}.service`
    : `com.moretea.forge.mcp-gateway.${suffix}.service`;
}

function command(commandName: string, args: string[], allowFailure = false): string {
  const result = spawnSync(commandName, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  if (!allowFailure && (result.status !== 0 || result.error)) {
    throw new Error(`HOST_RESCUE_MIGRATION_COMMAND_FAILED: ${commandName} ${args.join(' ')}: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').trim()}`);
  }
  return result.stdout ?? '';
}

function unitActive(unit: string): boolean {
  return command('systemctl', ['--user', 'is-active', unit], true).trim() === 'active';
}

function unitPath(unit: string): string {
  return join(home, '.config', 'systemd', 'user', unit);
}

function requiredFile(path: string, code: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(code);
}

function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

function mapPaths(value: unknown, source: string, destination: string): unknown {
  if (typeof value === 'string') return value.startsWith(source) ? `${destination}${value.slice(source.length)}` : value;
  if (Array.isArray(value)) return value.map((entry) => mapPaths(entry, source, destination));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, mapPaths(entry, source, destination)]));
  }
  return value;
}

function rewriteJsonPathPrefixes(root: string, source: string, destination: string): void {
  const relativePaths = [
    'runtime/releases/authority.json',
    'runtime/connector-service/authority.json',
    'system/runtime-generation.json',
  ];
  for (const path of relativePaths) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
    atomicWrite(absolute, `${JSON.stringify(mapPaths(parsed, source, destination), null, 2)}\n`);
  }
}

function moveStaleRuntimeProjection(root: string, timestamp: string): void {
  for (const relativePath of ['runtime/active-runtime-owner.json', 'runtime/status.json']) {
    const source = join(root, relativePath);
    if (!existsSync(source)) continue;
    const destination = join(root, 'migration', 'legacy-runtime-projections', `${basename(relativePath)}.${timestamp}`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(source, destination);
  }
}

function readActiveRelease(root: string): { releaseId: string; releasePath: string } {
  const authorityPath = join(root, 'runtime', 'releases', 'authority.json');
  requiredFile(authorityPath, 'HOST_RESCUE_MIGRATION_RUNTIME_AUTHORITY_MISSING');
  const authority = JSON.parse(readFileSync(authorityPath, 'utf8')) as { active?: { releaseId?: string; manifestPath?: string } };
  const releaseId = authority.active?.releaseId;
  const manifestPath = authority.active?.manifestPath;
  if (!releaseId || !manifestPath || !manifestPath.startsWith(`${root}/runtime/releases/`)) {
    throw new Error('HOST_RESCUE_MIGRATION_RUNTIME_AUTHORITY_INVALID');
  }
  const releasePath = dirname(manifestPath);
  for (const path of [join(releasePath, 'forge-runtime'), join(releasePath, 'manifest.json'), join(releasePath, 'package', 'src', 'cli', 'index.ts')]) {
    requiredFile(path, 'HOST_RESCUE_MIGRATION_ACTIVE_RELEASE_INCOMPLETE');
  }
  return { releaseId, releasePath };
}

function quoteSystemd(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function renderRuntimeUnit(root: string, unit: string, release: { releaseId: string; releasePath: string }): string {
  const runtime = join(release.releasePath, 'forge-runtime');
  const cli = join(release.releasePath, 'forge-cli');
  const args = [runtime, '--controller-home', root, '--repo', join(release.releasePath, 'package'), '--release-manifest', join(release.releasePath, 'manifest.json'), '--host', '127.0.0.1', '--port', '8765', '--auth-token-file', join(root, 'mcp', 'runtime-token')];
  return [
    '[Unit]', 'Description=Forge Runtime', 'After=network-online.target', '',
    '[Service]', 'Type=simple', `ExecStart=${args.map(quoteSystemd).join(' ')}`,
    `Environment=${quoteSystemd(`FORGE_CLI_EXECUTABLE=${cli}`)}`,
    `Environment=${quoteSystemd(`FORGE_CONTROLLER_HOME=${root}`)}`,
    `Environment=${quoteSystemd(`FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT=${release.releasePath}`)}`,
    `Environment=${quoteSystemd('FORGE_RELEASE_CLEAN_WORKSPACE=true')}`,
    `Environment=${quoteSystemd(`FORGE_RELEASE_ID=${release.releaseId}`)}`,
    `Environment=${quoteSystemd(`FORGE_RELEASE_PATH=${release.releasePath}`)}`,
    `Environment=${quoteSystemd(`FORGE_RELEASE_REVISION=${release.releaseId}`)}`,
    'Restart=on-failure', 'RestartSec=5', '', '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

function renderConnectorUnit(root: string, unit: string, release: { releaseId: string; releasePath: string }): string {
  const executable = process.execPath;
  const args = [executable, join(release.releasePath, 'package', 'src', 'cli', 'index.ts'), 'mcp', 'serve', '--controller-home', root, '--transport', 'http', '--host', '127.0.0.1', '--port', '8767', '--profile', 'controller', '--auth', 'oauth'];
  return [
    '[Unit]', 'Description=Forge ChatGPT OAuth Gateway', 'After=network-online.target', '',
    '[Service]', 'Type=simple', `ExecStart=${args.map(quoteSystemd).join(' ')}`,
    `Environment=${quoteSystemd(`FORGE_CONTROLLER_HOME=${root}`)}`,
    `Environment=${quoteSystemd('FORGE_CONTROLLER_LIFECYCLE_OWNER=1')}`,
    'Restart=on-failure', 'RestartSec=5', '', '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
}

function localMcpAvailable(url: string): boolean {
  const status = command('curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', '--connect-timeout', '3', '--max-time', '8', url], true).trim();
  return status === '200' || status === '401' || status === '405';
}

function waitFor(condition: () => boolean, attempts = 20): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return false;
}

const source = exactHome(option('--source-home'), legacyHome, 'HOST_RESCUE_MIGRATION_LEGACY_HOME_REQUIRED');
const destination = exactHome(option('--destination-home'), canonicalHome, 'HOST_RESCUE_MIGRATION_CANONICAL_HOME_REQUIRED');
if (!existsSync(join(sourceRoot, '.git'))) throw new Error('HOST_RESCUE_MIGRATION_SOURCE_ROOT_NOT_GIT');
requiredFile(join(source, 'control-plane.sqlite'), 'HOST_RESCUE_MIGRATION_LEGACY_DB_MISSING');
requiredFile(join(source, 'runtime', 'releases', 'authority.json'), 'HOST_RESCUE_MIGRATION_LEGACY_RUNTIME_AUTHORITY_MISSING');

const units = {
  legacyRuntime: unitFor('runtime', source),
  legacyConnector: unitFor('connector', source),
  canonicalRuntime: unitFor('runtime', destination),
  canonicalConnector: unitFor('connector', destination),
  legacyRecoveryGateway: 'com.moretea.forge-recovery-gateway.service',
  legacyRecoveryWatchdog: 'com.moretea.forge-recovery-watchdog.service',
};
const preflight = {
  executionEnvironment: 'WINDOWS_WSL',
  source,
  destination,
  sourceDatabaseBytes: statSync(join(source, 'control-plane.sqlite')).size,
  destinationExists: existsSync(destination),
  units: Object.fromEntries(Object.entries(units).map(([name, unit]) => [name, { unit, active: unitActive(unit) }])),
};

if (preflight.units.legacyRuntime.active && preflight.units.canonicalRuntime.active) {
  throw new Error('HOST_RESCUE_MIGRATION_DUAL_RUNTIME_AUTHORITY_FAIL_CLOSED');
}
if (preflight.units.legacyConnector.active && preflight.units.canonicalConnector.active) {
  throw new Error('HOST_RESCUE_MIGRATION_DUAL_CONNECTOR_AUTHORITY_FAIL_CLOSED');
}
if (!preflight.units.legacyRuntime.active || !preflight.units.legacyConnector.active) {
  throw new Error('HOST_RESCUE_MIGRATION_LEGACY_AUTHORITY_NOT_ACTIVE');
}
if (!execute) {
  process.stdout.write(`${JSON.stringify({ status: 'preflight_only', ...preflight }, null, 2)}\n`);
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const staging = `${destination}.migration-staging-${timestamp}`;
const destinationBackup = `${destination}.pre-rescue-${timestamp}`;
const legacyUnitContents = new Map<string, string>();
for (const unit of [units.legacyConnector, units.legacyRuntime, units.legacyRecoveryGateway, units.legacyRecoveryWatchdog]) {
  const path = unitPath(unit);
  if (existsSync(path)) legacyUnitContents.set(path, readFileSync(path, 'utf8'));
}
let sourceStopped = false;
let destinationActivated = false;
try {
  command('systemctl', ['--user', 'stop', units.legacyConnector]);
  command('systemctl', ['--user', 'stop', units.legacyRuntime]);
  sourceStopped = true;
  if (unitActive(units.legacyConnector) || unitActive(units.legacyRuntime)) throw new Error('HOST_RESCUE_MIGRATION_LEGACY_STOP_UNVERIFIED');
  command('rsync', ['-aH', '--numeric-ids', `${source}/`, `${staging}/`]);
  requiredFile(join(staging, 'control-plane.sqlite'), 'HOST_RESCUE_MIGRATION_STAGED_DB_MISSING');
  requiredFile(join(staging, 'runtime', 'releases', 'authority.json'), 'HOST_RESCUE_MIGRATION_STAGED_RUNTIME_AUTHORITY_MISSING');
  if (existsSync(destination)) renameSync(destination, destinationBackup);
  renameSync(staging, destination);
  rewriteJsonPathPrefixes(destination, source, destination);
  moveStaleRuntimeProjection(destination, timestamp);
  const release = readActiveRelease(destination);
  atomicWrite(unitPath(units.canonicalRuntime), renderRuntimeUnit(destination, units.canonicalRuntime, release), 0o644);
  atomicWrite(unitPath(units.canonicalConnector), renderConnectorUnit(destination, units.canonicalConnector, release), 0o644);
  command('systemctl', ['--user', 'daemon-reload']);
  command('systemctl', ['--user', 'enable', units.canonicalRuntime]);
  command('systemctl', ['--user', 'enable', units.canonicalConnector]);
  command('systemctl', ['--user', 'start', units.canonicalRuntime]);
  if (!waitFor(() => unitActive(units.canonicalRuntime) && localMcpAvailable('http://127.0.0.1:8765/mcp'))) throw new Error('HOST_RESCUE_MIGRATION_CANONICAL_RUNTIME_UNHEALTHY');
  command('systemctl', ['--user', 'start', units.canonicalConnector]);
  if (!waitFor(() => unitActive(units.canonicalConnector) && localMcpAvailable('http://127.0.0.1:8767/mcp'))) throw new Error('HOST_RESCUE_MIGRATION_CANONICAL_CONNECTOR_UNHEALTHY');
  destinationActivated = true;
  for (const unit of [units.legacyConnector, units.legacyRuntime, units.legacyRecoveryGateway, units.legacyRecoveryWatchdog]) {
    command('systemctl', ['--user', 'disable', unit], true);
    const path = unitPath(unit);
    if (existsSync(path)) unlinkSync(path);
  }
  command('systemctl', ['--user', 'daemon-reload']);
  const receipt = {
    schemaVersion: 1,
    status: 'committed',
    at: new Date().toISOString(),
    sourceHome: source,
    canonicalHome: destination,
    preservedLegacyHome: source,
    canonicalPriorHome: existsSync(destinationBackup) ? destinationBackup : undefined,
    release,
    units: { runtime: units.canonicalRuntime, connector: units.canonicalConnector },
  };
  atomicWrite(join(rescueRoot, 'audit', `controller-home-migration-${timestamp}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  command('systemctl', ['--user', 'stop', units.canonicalConnector], true);
  command('systemctl', ['--user', 'stop', units.canonicalRuntime], true);
  if (existsSync(destinationBackup)) {
    const failedDestination = `${destination}.failed-rescue-${timestamp}`;
    if (existsSync(destination)) renameSync(destination, failedDestination);
    renameSync(destinationBackup, destination);
  }
  for (const [path, content] of legacyUnitContents) atomicWrite(path, content, 0o644);
  command('systemctl', ['--user', 'daemon-reload'], true);
  if (sourceStopped) {
    command('systemctl', ['--user', 'start', units.legacyRuntime], true);
    command('systemctl', ['--user', 'start', units.legacyConnector], true);
  }
  atomicWrite(join(rescueRoot, 'audit', `controller-home-migration-${timestamp}.failed.json`), `${JSON.stringify({ schemaVersion: 1, status: 'rolled_back', at: new Date().toISOString(), error: detail, ...preflight }, null, 2)}\n`);
  throw error;
}
