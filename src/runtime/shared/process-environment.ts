/**
 * Environment boundary for repository-owned child processes.
 *
 * Controller/Supervisor authority, topology, and process identity belong to
 * the hosting runtime and must never be inherited by repository commands,
 * checks, or their children.
 */

const RUNTIME_PRIVATE_ENV_PREFIXES = [
  'REPO_HARNESS_CONTROLLER_',
  'REPO_HARNESS_DAEMON_',
  'REPO_HARNESS_PROCESS_RUNNER',
  'REPO_HARNESS_RUNTIME_',
  'REPO_HARNESS_SUPERVISOR_',
  'REPO_HARNESS_WRITER_',
] as const;

const RUNTIME_PRIVATE_ENV_KEYS = new Set([
  'REPO_HARNESS_MCP_INSTANCE_ID',
  'REPO_HARNESS_MCP_PUBLIC_ORIGIN',
  'REPO_HARNESS_STABLE_SUPERVISOR',
]);

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
  return sanitized;
}
