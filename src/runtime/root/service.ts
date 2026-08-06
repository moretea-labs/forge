import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
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
  authTokenFile:[REDACTED]
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
  const launchAgentsRoot = join(process.env.HOME ?? home, 'Library', 'LaunchAgents');
  return {
    controllerHome: home,
    serviceRoot,
    configPath: join(serviceRoot, 'config.json'),
    sourcePlistPath: join(serviceRoot, `${label}.plist`),
    installedPlistPath: join(launchAgentsRoot, `${label}.plist`),
    stdoutPath: join(serviceRoot, 'logs', 'stdout.log'),
    stderrPath: join(serviceRoot, 'logs', 'stderr.log'),
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

export function renderForgeRuntimeLaunchAgent(input: { paths: ForgeRuntimeServicePaths; nodeExecutable: string; runnerPath: string }): string {
  const args = [resolve(input.nodeExecutable), resolve(input.runnerPath), '--controller-home', input.paths.controllerHome, '--config', input.paths.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(input.paths.label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>ThrottleInterval</key>\n  <integer>5</integer>\n  <key>ProcessType</key>\n  <string>Interactive</string>\n  <key>StandardOutPath</key>\n  <string>${xml(input.paths.stdoutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(input.paths.stderrPath)}</string>\n</dict>\n</plist>\n`;
}

export async function installForgeRuntimeService(input: { config: ForgeRuntimeServiceConfig; runnerPath: string; nodeExecutable?: string }): Promise<ForgeRuntimeServicePaths> {
  if (process.platform !== 'darwin') throw new Error('FORGE_RUNTIME_SERVICE_PLATFORM_UNSUPPORTED: launchd requires macOS');
  const config = validateForgeRuntimeServiceConfig(input.config);
  const paths = forgeRuntimeServicePaths(config.controllerHome);
  mkdirSync(join(paths.serviceRoot, 'logs'), { recursive: true, mode: 0o700 });
  atomicWrite(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  atomicWrite(paths.sourcePlistPath, renderForgeRuntimeLaunchAgent({ paths, nodeExecutable: input.nodeExecutable ?? process.execPath, runnerPath: input.runnerPath }));
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
