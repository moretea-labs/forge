/**
 * Environment boundary for repository-owned child processes.
 *
 * Controller/Supervisor authority belongs to the hosting runtime process and
 * must never be inherited by repository commands, checks, or their children.
 */

const CONTROLLER_AUTHORITY_ENV_KEYS = [
  'REPO_HARNESS_WRITER_SLOT',
  'REPO_HARNESS_WRITER_EPOCH',
  'REPO_HARNESS_WRITER_FENCING_TOKEN',
  'REPO_HARNESS_WRITER_GENERATION',
  'REPO_HARNESS_SUPERVISOR_CHILD',
  'REPO_HARNESS_SUPERVISOR_EPOCH',
  'REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER',
  'REPO_HARNESS_DAEMON_INSTANCE_ID',
] as const;

export function repositoryChildProcessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of CONTROLLER_AUTHORITY_ENV_KEYS) delete sanitized[key];
  return sanitized;
}
