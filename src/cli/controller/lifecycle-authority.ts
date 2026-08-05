export const CONTROLLER_LIFECYCLE_OWNER_ENV = 'REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER';

export function isControllerLifecycleOwnerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[CONTROLLER_LIFECYCLE_OWNER_ENV] === '1';
}

export function assertControllerLifecycleOwner(component: string): void {
  if (isControllerLifecycleOwnerEnvironment()) return;
  throw new Error(
    `${component} is an internal Runtime module. `
    + 'Start the complete application through `repo-harness-runtime`; '
    + 'Gateway, Controller Services, Scheduler and MCP Transport share one Runtime lifecycle owner.',
  );
}
