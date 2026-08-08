import { existsSync } from 'fs';
import { basename, delimiter, isAbsolute, join } from 'path';

/**
 * Environment boundary for repository-owned child processes.
 *
 * Controller/Supervisor authority, topology, and process identity belong to
 * the hosting runtime and must never be inherited by repository commands,
 * checks, or their children.
 */

const RUNTIME_PRIVATE_ENV_PREFIXES = [
  'FORGE_CONTROLLER_',
  'FORGE_DAEMON_',
  'FORGE_PROCESS_RUNNER',
  'FORGE_RUNTIME_',
  'FORGE_SUPERVISOR_',
  'FORGE_WRITER_',
] as const;

const RUNTIME_PRIVATE_ENV_KEYS = new Set([
  'FORGE_MCP_INSTANCE_ID',
  'FORGE_MCP_PUBLIC_ORIGIN',
  'FORGE_STABLE_SUPERVISOR',
]);

function appendExecutableDirectory(pathEntries: string[], candidate: string | undefined): void {
  if (!candidate || !isAbsolute(candidate) || pathEntries.includes(candidate)) return;
  pathEntries.push(candidate);
}

function validBunExecutable(candidate: string | undefined): string | undefined {
  const value = candidate?.trim();
  if (!value) return undefined;
  const executable = basename(value).toLowerCase();
  if (executable !== 'bun' && executable !== 'bun.exe') return undefined;
  if (isAbsolute(value) && !existsSync(value)) return undefined;
  return value;
}

export function resolveBunExecutable(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = validBunExecutable(env.FORGE_BUN_EXECUTABLE);
  if (configured) return configured;
  const executable = basename(execPath).toLowerCase();
  if (executable === 'bun' || executable === 'bun.exe') return execPath;

  const binary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunInstall = env.BUN_INSTALL?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  const candidates = [
    bunInstall ? join(bunInstall, 'bin', binary) : undefined,
    home ? join(home, '.bun', 'bin', binary) : undefined,
    process.platform === 'darwin' ? join('/opt/homebrew/bin', binary) : undefined,
    process.platform !== 'win32' ? join('/usr/local/bin', binary) : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return binary;
}

export function repositoryChildProcessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (
      RUNTIME_PRIVATE_ENV_KEYS.has(key)
      || RUNTIME_PRIVATE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      delete sanitized[key];
    }
  }

  const pathEntries = (sanitized.PATH ?? '').split(delimiter).filter(Boolean);
  const bunInstall = sanitized.BUN_INSTALL?.trim();
  const home = sanitized.HOME?.trim() || sanitized.USERPROFILE?.trim();
  const voltaHome = sanitized.VOLTA_HOME?.trim();
  const nvmBin = sanitized.NVM_BIN?.trim();
  const pnpmHome = sanitized.PNPM_HOME?.trim();
  appendExecutableDirectory(pathEntries, bunInstall ? join(bunInstall, 'bin') : undefined);
  appendExecutableDirectory(pathEntries, home ? join(home, '.bun', 'bin') : undefined);
  appendExecutableDirectory(pathEntries, nvmBin);
  appendExecutableDirectory(pathEntries, voltaHome ? join(voltaHome, 'bin') : undefined);
  appendExecutableDirectory(pathEntries, pnpmHome);
  appendExecutableDirectory(pathEntries, home ? join(home, '.local', 'bin') : undefined);
  if (process.platform === 'darwin') appendExecutableDirectory(pathEntries, '/opt/homebrew/bin');
  if (process.platform !== 'win32') appendExecutableDirectory(pathEntries, '/usr/local/bin');
  sanitized.PATH = pathEntries.join(delimiter);

  return sanitized;
}
