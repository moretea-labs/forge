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
    { cwd: surface.releaseRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
  ));
  for (const canary of processRuntimeReleaseCanaryCommands(surface.releaseRoot)) {
    const result = runExecutionEntryCanary(canary);
    if (!result.ok) {
      throw new Error(`RUNTIME_RELEASE_EXECUTION_CANARY_FAILED: ${canary.name}: ${result.stderr || result.stdout || result.error || 'unknown failure'}`.slice(0, 2_000));
    }
  }
  return surface;
}
