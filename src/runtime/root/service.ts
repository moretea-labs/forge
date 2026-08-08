import { createHash, randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import {
  bootstrapLaunchAgentWithRetryV2,
  bootoutLaunchAgentWithRetryV2,
  installLaunchAgent,
} from '../../cli/controller/launch-agents';

export interface ForgeRuntimeServiceConfig {
  schemaVersion: 1;
  controllerHome: string;
  repositoryRoot: string;
  host: string;
  port: number;
  authTokenFile: string;
  exclusiveWorkId?: string;
}

export interface ForgeRuntimeServicePaths {
  controllerHome: string;
  serviceRoot: string;
  configPath: string;
  sourcePlistPath: string;
  installedPlistPath: string;
  stdoutPath: string;
  stderrPath: string;
  activeEntrypointPath: string;
  label: string;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function atomicWrite(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode });
  renameSync(temporary, path);
}

export function forgeRuntimeServicePaths(controllerHome: string): ForgeRuntimeServicePaths {
  const home = resolveControllerHome(controllerHome);
  const serviceRoot = join(home, 'runtime', 'service');
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const label = `com.moretea.forge.runtime.${suffix}`;
  const launchAgentsRoot = join(process.env.HOME ?? homedir(), 'Library', 'LaunchAgents');
  return {
    controllerHome: home,
    serviceRoot,
    configPath: join(serviceRoot, 'config.json'),
    sourcePlistPath: join(serviceRoot, `${label}.plist`),
    installedPlistPath: join(launchAgentsRoot, `${label}.plist`),
    stdoutPath: join(serviceRoot, 'logs', 'stdout.log'),
    stderrPath: join(serviceRoot, 'logs', 'stderr.log'),
    activeEntrypointPath: join(serviceRoot, 'active-forge-runtime'),
    label,
  };
}

export function validateForgeRuntimeServiceConfig(input: ForgeRuntimeServiceConfig): ForgeRuntimeServiceConfig {
  if (input.schemaVersion !== 1) throw new Error('FORGE_RUNTIME_SERVICE_CONFIG_VERSION_UNSUPPORTED');
  const controllerHome = resolve(input.controllerHome);
  const repositoryRoot = resolve(input.repositoryRoot);
  const authTokenFile = resolve(input.authTokenFile);
  if (!input.host.trim()) throw new Error('FORGE_RUNTIME_SERVICE_HOST_REQUIRED');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new Error('FORGE_RUNTIME_SERVICE_PORT_INVALID');
  if (!existsSync(repositoryRoot)) throw new Error(`FORGE_RUNTIME_SERVICE_REPOSITORY_MISSING: ${repositoryRoot}`);
  if (!existsSync(authTokenFile)) throw new Error(`FORGE_RUNTIME_SERVICE_AUTH_TOKEN_MISSING: ${authTokenFile}`);
  return {
    ...input,
    controllerHome,
    repositoryRoot,
    host: input.host.trim(),
    authTokenFile,
    ...(input.exclusiveWorkId?.trim() ? { exclusiveWorkId: input.exclusiveWorkId.trim() } : {}),
  };
}

export function readForgeRuntimeServiceConfig(path: string): ForgeRuntimeServiceConfig {
  return validateForgeRuntimeServiceConfig(JSON.parse(readFileSync(resolve(path), 'utf8')) as ForgeRuntimeServiceConfig);
}

interface RuntimeReleaseAuthorityRecord {
  schemaVersion: 1;
  status: string;
  active?: { releaseId?: string; manifestPath?: string; artifactIdentity?: string };
}

interface RuntimeReleaseManifestRecord {
  schemaVersion: 1;
  releaseId: string;
  entrypoint: string;
  controllerHome: string;
  artifactIdentity: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function activeRuntimeEntrypoint(controllerHome: string): string | undefined {
  const home = resolveControllerHome(controllerHome);
  const releasesRoot = join(home, 'runtime', 'releases');
  const authorityPath = join(releasesRoot, 'authority.json');
  if (!existsSync(authorityPath)) return undefined;
  const authority = JSON.parse(readFileSync(authorityPath, 'utf8')) as RuntimeReleaseAuthorityRecord;
  if (authority.schemaVersion !== 1 || authority.status !== 'committed' || !authority.active?.manifestPath) {
    throw new Error('FORGE_RUNTIME_RELEASE_AUTHORITY_INVALID');
  }
  const manifestPath = resolve(authority.active.manifestPath);
  if (!isInside(releasesRoot, manifestPath)) throw new Error('FORGE_RUNTIME_RELEASE_MANIFEST_OUTSIDE_RELEASES');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeReleaseManifestRecord;
  if (manifest.schemaVersion !== 1 || !manifest.releaseId || !manifest.entrypoint) throw new Error('FORGE_RUNTIME_RELEASE_MANIFEST_INVALID');
  if (resolve(manifest.controllerHome) !== home) throw new Error('FORGE_RUNTIME_RELEASE_CONTROLLER_HOME_MISMATCH');
  if (authority.active.releaseId && authority.active.releaseId !== manifest.releaseId) throw new Error('FORGE_RUNTIME_RELEASE_ID_MISMATCH');
  const releaseRoot = dirname(manifestPath);
  const entrypoint = resolve(releaseRoot, manifest.entrypoint);
  if (!isInside(releaseRoot, entrypoint)) throw new Error('FORGE_RUNTIME_RELEASE_ENTRYPOINT_OUTSIDE_RELEASE');
  if (!existsSync(entrypoint)) throw new Error(`FORGE_RUNTIME_RELEASE_ENTRYPOINT_MISSING: ${entrypoint}`);
  return entrypoint;
}

function atomicSymlink(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, path);
}

export function syncForgeRuntimeActiveEntrypoint(controllerHome: string): { path: string; target?: string; changed: boolean } {
  const paths = forgeRuntimeServicePaths(controllerHome);
  const target = activeRuntimeEntrypoint(controllerHome);
  if (!target) return { path: paths.activeEntrypointPath, changed: false };
  let current: string | undefined;
  try {
    if (lstatSync(paths.activeEntrypointPath).isSymbolicLink()) current = resolve(dirname(paths.activeEntrypointPath), readlinkSync(paths.activeEntrypointPath));
  } catch {}
  if (current === target) return { path: paths.activeEntrypointPath, target, changed: false };
  rmSync(paths.activeEntrypointPath, { force: true, recursive: true });
  atomicSymlink(paths.activeEntrypointPath, target);
  return { path: paths.activeEntrypointPath, target, changed: true };
}

export function ensureForgeRuntimeLaunchAgentContract(input: { controllerHome: string; bootstrapNodeExecutable?: string; bootstrapRunnerPath?: string }): { paths: ForgeRuntimeServicePaths; mode: 'release' | 'bootstrap'; changed: boolean } {
  const paths = forgeRuntimeServicePaths(input.controllerHome);
  const active = activeRuntimeEntrypoint(input.controllerHome);
  const useRelease = Boolean(active);
  if (useRelease) syncForgeRuntimeActiveEntrypoint(input.controllerHome);
  if (!useRelease && (!input.bootstrapNodeExecutable || !input.bootstrapRunnerPath)) {
    throw new Error('FORGE_RUNTIME_BOOTSTRAP_RUNNER_REQUIRED');
  }
  const plist = renderForgeRuntimeLaunchAgent({
    paths,
    ...(useRelease
      ? { activeEntrypointPath: paths.activeEntrypointPath }
      : { nodeExecutable: input.bootstrapNodeExecutable!, runnerPath: input.bootstrapRunnerPath! }),
  });
  const existingSource = existsSync(paths.sourcePlistPath) ? readFileSync(paths.sourcePlistPath, 'utf8') : undefined;
  const existingInstalled = existsSync(paths.installedPlistPath) ? readFileSync(paths.installedPlistPath, 'utf8') : undefined;
  const changed = existingSource !== plist || existingInstalled !== plist;
  if (existingSource !== plist) atomicWrite(paths.sourcePlistPath, plist);
  if (existingInstalled !== plist) atomicWrite(paths.installedPlistPath, plist, 0o644);
  return { paths, mode: useRelease ? 'release' : 'bootstrap', changed };
}

export function renderForgeRuntimeLaunchAgent(input: { paths: ForgeRuntimeServicePaths; activeEntrypointPath?: string; nodeExecutable?: string; runnerPath?: string }): string {
  const args = input.activeEntrypointPath
    ? [resolve(input.activeEntrypointPath), '--controller-home', input.paths.controllerHome, '--config', input.paths.configPath]
    : [resolve(input.nodeExecutable!), resolve(input.runnerPath!), '--controller-home', input.paths.controllerHome, '--config', input.paths.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(input.paths.label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>ThrottleInterval</key>\n  <integer>5</integer>\n  <key>ProcessType</key>\n  <string>Interactive</string>\n  <key>StandardOutPath</key>\n  <string>${xml(input.paths.stdoutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(input.paths.stderrPath)}</string>\n</dict>\n</plist>\n`;
}

export async function installForgeRuntimeService(input: { config: ForgeRuntimeServiceConfig; runnerPath: string; nodeExecutable?: string }): Promise<ForgeRuntimeServicePaths> {
  if (process.platform !== 'darwin') throw new Error('FORGE_RUNTIME_SERVICE_PLATFORM_UNSUPPORTED: launchd requires macOS');
  const config = validateForgeRuntimeServiceConfig(input.config);
  const paths = forgeRuntimeServicePaths(config.controllerHome);
  mkdirSync(join(paths.serviceRoot, 'logs'), { recursive: true, mode: 0o700 });
  atomicWrite(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  ensureForgeRuntimeLaunchAgentContract({
    controllerHome: config.controllerHome,
    bootstrapNodeExecutable: input.nodeExecutable ?? process.execPath,
    bootstrapRunnerPath: input.runnerPath,
  });
  installLaunchAgent(paths.sourcePlistPath, paths.label);
  const result = await bootstrapLaunchAgentWithRetryV2({ label: paths.label, plistPath: paths.installedPlistPath });
  if (!result.ok) throw new Error(`FORGE_RUNTIME_SERVICE_BOOTSTRAP_FAILED: ${result.diagnostics.join('; ')}`);
  return paths;
}

export async function uninstallForgeRuntimeService(controllerHome: string): Promise<ForgeRuntimeServicePaths> {
  if (process.platform !== 'darwin') throw new Error('FORGE_RUNTIME_SERVICE_PLATFORM_UNSUPPORTED: launchd requires macOS');
  const paths = forgeRuntimeServicePaths(controllerHome);
  const result = await bootoutLaunchAgentWithRetryV2({ label: paths.label, plistPath: paths.installedPlistPath });
  if (!result.ok) throw new Error(`FORGE_RUNTIME_SERVICE_BOOTOUT_FAILED: ${result.diagnostics.join('; ')}`);
  rmSync(paths.installedPlistPath, { force: true });
  return paths;
}
