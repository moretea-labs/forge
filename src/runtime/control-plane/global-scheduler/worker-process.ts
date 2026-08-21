import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { terminateProcessTree } from '../../shared/process-tree';
import type { SchedulerWorkerLaunchDescriptor } from './worker-launch';
import type { SchedulerWorkerStderrCapture } from './worker-stderr';

export interface SchedulerWorkerSpawnDependencies {
  spawnProcess: typeof spawn;
  platform: NodeJS.Platform;
}

const DEFAULT_SPAWN_DEPENDENCIES: SchedulerWorkerSpawnDependencies = {
  spawnProcess: spawn,
  platform: process.platform,
};

export type SchedulerWorkerSpawnResult =
  | { ok: true; child: ChildProcess }
  | { ok: false; startupError: string };

export function spawnSchedulerWorkerProcess(
  launch: SchedulerWorkerLaunchDescriptor,
  dependencies: SchedulerWorkerSpawnDependencies = DEFAULT_SPAWN_DEPENDENCIES,
): SchedulerWorkerSpawnResult {
  const options: SpawnOptions = {
    cwd: launch.cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: dependencies.platform !== 'win32',
    env: launch.environment,
  };
  try {
    return {
      ok: true,
      child: dependencies.spawnProcess(launch.executable, launch.args, options),
    };
  } catch (error) {
    return {
      ok: false,
      startupError: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SchedulerWorkerRegistrationDependencies {
  terminateWorker(pid: number): Promise<unknown>;
}

const DEFAULT_REGISTRATION_DEPENDENCIES: SchedulerWorkerRegistrationDependencies = {
  terminateWorker: terminateProcessTree,
};

export function registerSchedulerWorkerProcess(input: {
  jobId: string;
  child: ChildProcess;
  children: Map<string, ChildProcess>;
  attach(workerPid: number): boolean;
}, dependencies: SchedulerWorkerRegistrationDependencies = DEFAULT_REGISTRATION_DEPENDENCIES): boolean {
  const { child } = input;
  if (!child.pid) {
    child.unref();
    return false;
  }

  input.children.set(input.jobId, child);
  if (!input.attach(child.pid)) {
    input.children.delete(input.jobId);
    void dependencies.terminateWorker(child.pid);
    child.unref();
    return false;
  }

  child.unref();
  return true;
}

export interface SchedulerWorkerProcessExit {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stderrTruncated: boolean;
  startupError?: string;
}

export function wireSchedulerWorkerProcess(input: {
  jobId: string;
  child: ChildProcess;
  children: Map<string, ChildProcess>;
  stderrCapture: SchedulerWorkerStderrCapture;
  onExit(exit: SchedulerWorkerProcessExit): void;
}): void {
  const { child } = input;
  child.stderr?.on('data', (chunk: Buffer | string) => input.stderrCapture.append(chunk));

  let finalized = false;
  const finalize = (exitCode: number | null, signal: string | null, startupError?: string) => {
    if (finalized) return;
    finalized = true;
    if (input.children.get(input.jobId) === child) input.children.delete(input.jobId);
    const snapshot = input.stderrCapture.snapshot();
    input.onExit({
      exitCode,
      signal,
      stderr: snapshot.stderr,
      stderrTruncated: snapshot.stderrTruncated,
      startupError,
    });
  };

  child.once('error', (error) => finalize(null, null, error.message));
  child.once('close', (code, signal) => finalize(code, signal));
}
