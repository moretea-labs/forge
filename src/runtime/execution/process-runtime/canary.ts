import { resolve } from 'path';

/**
 * Private child mode used only by the immutable release execution canary.
 *
 * The canary must not use the parent process' process.execPath: inside a
 * compiled Stable Supervisor that path is the Supervisor executable itself,
 * so spawning it would start a second Supervisor and collide on its control
 * port. Reusing the candidate Process Runner with an explicit no-op child mode
 * keeps the probe self-contained and portable.
 */
export const PROCESS_RUNNER_RELEASE_CANARY_CHILD_ARG = '--repo-harness-release-canary-child';

export interface ProcessRunnerReleaseCanaryChildCommand {
  executable: string;
  args: string[];
}

export function processRunnerReleaseCanaryChildCommand(
  runnerPath: string,
): ProcessRunnerReleaseCanaryChildCommand {
  return {
    executable: resolve(runnerPath),
    args: [PROCESS_RUNNER_RELEASE_CANARY_CHILD_ARG],
  };
}
