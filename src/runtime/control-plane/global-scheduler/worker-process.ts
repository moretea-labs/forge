import type { ChildProcess } from 'child_process';
import { terminateProcessTree } from '../../shared/process-tree';

export interface SchedulerWorkerCleanupDependencies {
  terminateWorker(pid: number | undefined): Promise<unknown>;
}

const DEFAULT_CLEANUP_DEPENDENCIES: SchedulerWorkerCleanupDependencies = {
  terminateWorker: terminateProcessTree,
};

export async function cleanupSchedulerWorkerProcesses(
  children: Map<string, ChildProcess>,
  dependencies: SchedulerWorkerCleanupDependencies = DEFAULT_CLEANUP_DEPENDENCIES,
): Promise<void> {
  const workers = [...children.values()];
  children.clear();
  await Promise.all(workers.map((child) => dependencies.terminateWorker(child.pid)));
}
