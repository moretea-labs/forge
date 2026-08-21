import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';
import { resolveBunExecutable } from '../../shared/process-environment';

const WORKER_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'BUN_INSTALL',
  'NODE_OPTIONS',
  'FORGE_CONTROLLER_HOME',
  'FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT',
  'FORGE_EXECUTION_WORKER',
  'FORGE_RUNTIME_INSTANCE_ID',
  'FORGE_RUNTIME_OWNER_PID',
  'FORGE_RELEASE_AUTHORITY_REVISION',
  'FORGE_RELEASE_ID',
  'FORGE_ARTIFACT_IDENTITY',
  'FORGE_WORKER_PROTOCOL_VERSION',
] as const;

export function resolveSchedulerWorkerExecutable(
  isBun: boolean = Boolean(process.versions.bun),
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isBun ? resolveBunExecutable(execPath, env) : execPath;
}

export interface SchedulerWorkerCommand {
  entry: string;
  loader: string;
  cwd: string;
}

export function resolveSchedulerWorkerCommand(input: {
  runtimeSourceRoot?: string;
  workerEntrypoint?: string;
  isBun?: boolean;
  cwd?: string;
  pathExists?: (path: string) => boolean;
} = {}): SchedulerWorkerCommand {
  const runtimeSourceRoot = input.runtimeSourceRoot ? resolve(input.runtimeSourceRoot) : undefined;
  const sourceEntry = runtimeSourceRoot
    ? join(runtimeSourceRoot, 'src', 'runtime', 'execution', 'workers', 'worker-entry.ts')
    : fileURLToPath(new URL('../../execution/workers/worker-entry.ts', import.meta.url));
  const loader = runtimeSourceRoot
    ? join(runtimeSourceRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs')
    : fileURLToPath(new URL('../../shared/node-ts-loader.mjs', import.meta.url));
  const entry = input.workerEntrypoint ? resolve(input.workerEntrypoint) : sourceEntry;
  const cwd = runtimeSourceRoot ?? input.cwd ?? process.cwd();
  const pathExists = input.pathExists ?? existsSync;
  const isBun = input.isBun ?? Boolean(process.versions.bun);
  if (!pathExists(entry)) throw new Error(`WORKER_ENTRYPOINT_MISSING: ${entry}`);
  if (!isBun && !pathExists(loader)) throw new Error(`WORKER_LOADER_MISSING: ${loader}`);
  return { entry, loader, cwd };
}

export function selectSchedulerWorkerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return Object.fromEntries(WORKER_ENVIRONMENT_KEYS.map((key) => [key, env[key]]));
}

export interface SchedulerWorkerLaunchDescriptor {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  lifecycleEnvironment: Record<string, string | undefined>;
}

export function buildSchedulerWorkerLaunchDescriptor(input: {
  command: SchedulerWorkerCommand;
  controllerHome: string;
  repoId: string;
  jobId: string;
  controllerPid: number;
  runtimeSourceRoot?: string;
  isBun?: boolean;
  execPath?: string;
  environment?: NodeJS.ProcessEnv;
  writeClaimEnvironment?: NodeJS.ProcessEnv;
}): SchedulerWorkerLaunchDescriptor {
  const isBun = input.isBun ?? Boolean(process.versions.bun);
  const environmentSource = input.environment ?? process.env;
  const executable = resolveSchedulerWorkerExecutable(isBun, input.execPath ?? process.execPath, environmentSource);
  const workerArgs = [
    '--controller-home', input.controllerHome,
    '--repo-id', input.repoId,
    '--job-id', input.jobId,
    '--controller-pid', String(input.controllerPid),
  ];
  const args = isBun
    ? [input.command.entry, ...workerArgs]
    : ['--loader', input.command.loader, input.command.entry, ...workerArgs];
  const environment: NodeJS.ProcessEnv = {
    ...environmentSource,
    FORGE_EXECUTION_WORKER: '1',
    FORGE_CONTROLLER_HOME: input.controllerHome,
    ...(input.runtimeSourceRoot ? { FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT: input.runtimeSourceRoot } : {}),
    ...(input.writeClaimEnvironment ?? {}),
  };
  return {
    executable,
    args,
    cwd: input.command.cwd,
    environment,
    lifecycleEnvironment: selectSchedulerWorkerEnvironment(environment),
  };
}
