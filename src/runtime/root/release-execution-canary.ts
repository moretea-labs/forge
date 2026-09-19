import { join } from 'path';
import { runProcess } from '../../effects/process-runner';
import { PROCESS_RUNTIME_RELEASE_CANARY_ARG } from '../execution/process-runtime/canary';
import { resolveBunExecutable } from '../shared/process-environment';
import {
  assertRuntimeReleaseExecutionSurface,
  type RuntimeReleaseExecutionSurface,
} from './release-manifest';

export interface RuntimeReleaseExecutionCanaryCommand {
  name: RuntimeReleaseExecutionSurface['entries'][number]['name'] | 'connector_cli';
  executable: string;
  args: string[];
}

export interface RuntimeReleaseExecutionCanaryDependencies {
  runExecutionEntryCanary?: (input: RuntimeReleaseExecutionCanaryCommand) => {
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

/**
 * Execute the minimum immutable Runtime execution surface plus the package
 * Connector CLI import graph. The latter is intentionally a help-only command:
 * it loads the exact CLI dependency closure used by the persistent Connector
 * without opening a listener or mutating Runtime authority.
 */
export function assertRuntimeReleaseExecutionCanaries(
  manifestPath: string,
  controllerHome: string,
  dependencies: RuntimeReleaseExecutionCanaryDependencies = {},
): RuntimeReleaseExecutionSurface {
  const surface = assertRuntimeReleaseExecutionSurface(manifestPath, controllerHome);
  const runExecutionEntryCanary = dependencies.runExecutionEntryCanary ?? ((request: RuntimeReleaseExecutionCanaryCommand) => runProcess(
    request.executable,
    request.args,
    {
      cwd: surface.releaseRoot,
      env: runtimeReleaseCanaryEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    },
  ));
  const assertCanary = (canary: RuntimeReleaseExecutionCanaryCommand): void => {
    const result = runExecutionEntryCanary(canary);
    if (!result.ok) {
      throw new Error(`RUNTIME_RELEASE_EXECUTION_CANARY_FAILED: ${canary.name}: ${result.stderr || result.stdout || result.error || 'unknown failure'}`.slice(0, 2_000));
    }
  };

  for (const entry of surface.entries) {
    assertCanary({
      name: entry.name,
      executable: entry.path,
      args: [PROCESS_RUNTIME_RELEASE_CANARY_ARG],
    });
  }

  // Package launcher releases execute source-backed CLI code from their own
  // immutable snapshot. Compiled standalone releases have a different closed
  // artifact surface and therefore do not use this source CLI probe.
  if (surface.manifest.executionMode !== 'standalone-binary' && surface.manifest.packageRoot) {
    assertCanary({
      name: 'connector_cli',
      executable: resolveBunExecutable(process.execPath, process.env),
      args: [join(surface.releaseRoot, 'package', 'src', 'cli', 'index.ts'), 'mcp', 'serve', '--help'],
    });
  }

  return surface;
}
