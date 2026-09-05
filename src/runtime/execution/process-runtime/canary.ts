import { resolve } from 'path';

/**
 * Private child mode used only by immutable Runtime execution canaries.
 *
 * The canary must not use the parent process' process.execPath: inside a
 * compiled immutable Forge release that path is the packaged Runtime executable,
 * so spawning it would start a second Supervisor and collide on its control
 * port. Reusing the candidate Process/Check Runner with an explicit no-op child
 * mode keeps the probe self-contained and portable.
 */
export const PROCESS_RUNTIME_RELEASE_CANARY_ARG = '--forge-release-canary-child';
/** Compatibility name retained for the Process Runner entrypoint and existing callers. */
export const PROCESS_RUNNER_RELEASE_CANARY_CHILD_ARG = PROCESS_RUNTIME_RELEASE_CANARY_ARG;

export interface ProcessRunnerReleaseCanaryChildCommand {
  executable: string;
  args: string[];
}

export interface ProcessRuntimeReleaseCanaryCommand extends ProcessRunnerReleaseCanaryChildCommand {
  name: 'process_runner' | 'check_runner';
}

export function processRunnerReleaseCanaryChildCommand(
  runnerPath: string,
): ProcessRunnerReleaseCanaryChildCommand {
  return {
    executable: resolve(runnerPath),
    args: [PROCESS_RUNTIME_RELEASE_CANARY_ARG],
  };
}

export function processRuntimeReleaseCanaryCommands(releaseRoot: string): ProcessRuntimeReleaseCanaryCommand[] {
  const root = resolve(releaseRoot);
  return [
    { name: 'process_runner', executable: resolve(root, 'process-runner.js'), args: [PROCESS_RUNTIME_RELEASE_CANARY_ARG] },
    { name: 'check_runner', executable: resolve(root, 'forge-check-runner'), args: [PROCESS_RUNTIME_RELEASE_CANARY_ARG] },
  ];
}
