import { runProcess } from '../../effects/process-runner';
import {
  processRuntimeReleaseCanaryCommands,
  type ProcessRuntimeReleaseCanaryCommand,
} from '../execution/process-runtime/canary';
import {
  assertRuntimeReleaseExecutionSurface,
  type RuntimeReleaseExecutionSurface,
} from './release-manifest';

export interface RuntimeReleaseExecutionCanaryDependencies {
  runExecutionEntryCanary?: (input: ProcessRuntimeReleaseCanaryCommand) => {
    ok: boolean;
    stderr?: string;
    stdout?: string;
    error?: string;
  };
}

/**
 * Release execution canaries deliberately do not inherit developer-tool PATH
 * entries. A manifest-owned executable that only works because Homebrew, Bun,
 * nvm, etc. happens to be present is not an immutable Runtime artifact.
 */
export function runtimeReleaseCanaryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    const systemPath = systemRoot
      ? `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\Wbem`
      : '';
    return { ...env, PATH: systemPath };
  }
  return { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
}

/** Execute the exact manifest-owned Process/Check Runner artifacts in bounded no-op mode. */
export function assertRuntimeReleaseExecutionCanaries(
  manifestPath: string,
  controllerHome: string,
  dependencies: RuntimeReleaseExecutionCanaryDependencies = {},
): RuntimeReleaseExecutionSurface {
  const surface = assertRuntimeReleaseExecutionSurface(manifestPath, controllerHome);
  const runExecutionEntryCanary = dependencies.runExecutionEntryCanary ?? ((request: ProcessRuntimeReleaseCanaryCommand) => runProcess(
    request.executable,
    request.args,
    {
      cwd: surface.releaseRoot,
      env: runtimeReleaseCanaryEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    },
  ));
  for (const canary of processRuntimeReleaseCanaryCommands(surface.releaseRoot)) {
    const result = runExecutionEntryCanary(canary);
    if (!result.ok) {
      throw new Error(`RUNTIME_RELEASE_EXECUTION_CANARY_FAILED: ${canary.name}: ${result.stderr || result.stdout || result.error || 'unknown failure'}`.slice(0, 2_000));
    }
  }
  return surface;
}
