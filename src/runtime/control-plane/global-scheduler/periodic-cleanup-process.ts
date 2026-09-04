import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';
import {
  resolveSchedulerWorkerCommand,
  resolveSchedulerWorkerExecutable,
} from './worker-launch';

export interface SchedulerPeriodicCleanupLaunchInput {
  controllerHome: string;
  controllerPid: number;
  nowMs: number;
  cleanupIntervalMs: number;
  runtimeSourceRoot?: string;
  environment?: NodeJS.ProcessEnv;
  writeClaimEnvironment?: NodeJS.ProcessEnv;
}

export interface SchedulerPeriodicCleanupLaunchDescriptor {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

export type SchedulerPeriodicCleanupSpawnResult =
  | { ok: true; child: ChildProcess }
  | { ok: false; startupError: string };

function cleanupEntrypoint(runtimeSourceRoot?: string): string {
  return runtimeSourceRoot
    ? join(runtimeSourceRoot, 'src', 'runtime', 'control-plane', 'global-scheduler', 'periodic-cleanup-entry.ts')
    : fileURLToPath(new URL('./periodic-cleanup-entry.ts', import.meta.url));
}

export function buildSchedulerPeriodicCleanupLaunchDescriptor(
  input: SchedulerPeriodicCleanupLaunchInput,
): SchedulerPeriodicCleanupLaunchDescriptor {
  const environmentSource = input.environment ?? process.env;
  const isBun = Boolean(process.versions.bun);
  const command = resolveSchedulerWorkerCommand({
    runtimeSourceRoot: input.runtimeSourceRoot,
    workerEntrypoint: cleanupEntrypoint(input.runtimeSourceRoot),
    isBun,
  });
  const executable = resolveSchedulerWorkerExecutable(isBun, process.execPath, environmentSource);
  const cleanupArgs = [
    '--controller-home', input.controllerHome,
    '--controller-pid', String(input.controllerPid),
    '--now-ms', String(input.nowMs),
    '--cleanup-interval-ms', String(input.cleanupIntervalMs),
  ];
  const args = isBun
    ? [command.entry, ...cleanupArgs]
    : ['--loader', command.loader, command.entry, ...cleanupArgs];
  return {
    executable,
    args,
    cwd: command.cwd,
    environment: {
      ...environmentSource,
      FORGE_CONTROLLER_HOME: input.controllerHome,
      FORGE_RUNTIME_MAINTENANCE_WORKER: '1',
      ...(input.writeClaimEnvironment ?? {}),
    },
  };
}

export function spawnSchedulerPeriodicCleanup(
  input: SchedulerPeriodicCleanupLaunchInput,
  spawnProcess: typeof spawn = spawn,
): SchedulerPeriodicCleanupSpawnResult {
  let launch: SchedulerPeriodicCleanupLaunchDescriptor;
  try {
    launch = buildSchedulerPeriodicCleanupLaunchDescriptor(input);
  } catch (error) {
    return { ok: false, startupError: error instanceof Error ? error.message : String(error) };
  }
  const options: SpawnOptions = {
    cwd: launch.cwd,
    env: launch.environment,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  };
  try {
    const child = spawnProcess(launch.executable, launch.args, options);
    child.unref();
    return { ok: true, child };
  } catch (error) {
    return { ok: false, startupError: error instanceof Error ? error.message : String(error) };
  }
}
