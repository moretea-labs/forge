import { delimiter, isAbsolute, join } from 'path';

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
  appendExecutableDirectory(pathEntries, bunInstall ? join(bunInstall, 'bin') : undefined);
  appendExecutableDirectory(pathEntries, home ? join(home, '.bun', 'bin') : undefined);
  sanitized.PATH = pathEntries.join(delimiter);

  return sanitized;
}
