import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { resolveBunExecutable } from '../../shared/process-environment';

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
  /** Manifest-owned compiled artifact. Spawn directly without Bun/Node/source loaders. */
  directExecutable?: true;
}

export function resolveSchedulerWorkerCommand(
  input: {
    runtimeSourceRoot?: string;
    workerEntrypoint?: string;
    standaloneExecutable?: string;
    isBun?: boolean;
    cwd?: string;
    pathExists?: (path: string) => boolean;
  } = {},
): SchedulerWorkerCommand {
  const pathExists = input.pathExists ?? existsSync;
  if (input.standaloneExecutable) {
    const entry = resolve(input.standaloneExecutable);
    if (!pathExists(entry)) throw new Error(`WORKER_ENTRYPOINT_MISSING: ${entry}`);
    return { entry, loader: '', cwd: input.cwd ?? dirname(entry), directExecutable: true };
  }
  const runtimeSourceRoot = input.runtimeSourceRoot ? resolve(input.runtimeSourceRoot) : undefined;
  const sourceEntry = runtimeSourceRoot
    ? join(runtimeSourceRoot, 'src', 'cli', 'execution', 'worker-entry.ts')
    : fileURLToPath(new URL('../../../cli/execution/worker-entry.ts', import.meta.url));
  const loader = runtimeSourceRoot
    ? join(runtimeSourceRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs')
    : fileURLToPath(new URL('../../shared/node-ts-loader.mjs', import.meta.url));
  const entry = input.workerEntrypoint ? resolve(input.workerEntrypoint) : sourceEntry;
  const cwd = runtimeSourceRoot ?? input.cwd ?? process.cwd();
  const isBun = input.isBun ?? Boolean(process.versions.bun);
  if (!pathExists(entry)) throw new Error(`WORKER_ENTRYPOINT_MISSING: ${entry}`);
  if (!isBun && !pathExists(loader)) throw new Error(`WORKER_LOADER_MISSING: ${loader}`);
  return { entry, loader, cwd };
}
