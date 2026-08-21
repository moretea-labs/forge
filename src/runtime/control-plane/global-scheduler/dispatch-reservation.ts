import type { ExecutionJob } from '../../execution/jobs/types';
import type { RepoActorClaimOptions, RepoActorDispatch } from '../repo-actor/actor';
import { selectExecutionJobDispatchRepositories } from '../dispatch-priority';
import type { SchedulerConfig } from './config';
import {
  consumeSchedulerDispatchCapacity,
  createSchedulerDispatchCapacity,
  schedulerDispatchCapacityAllows,
} from './dispatch-capacity';

export interface SchedulerDispatchActor {
  tryClaimNext(options?: RepoActorClaimOptions): RepoActorDispatch | undefined;
}

export interface SchedulerPendingSpawn {
  repoId: string;
  jobId: string;
}

export function reserveSchedulerDispatches(input: {
  activeJobs: readonly ExecutionJob[];
  config: SchedulerConfig;
  resourcePressured: boolean;
  lastRepoDispatch: Map<string, number>;
  getActor(repoId: string): SchedulerDispatchActor;
  now(): number;
  pendingSpawns: SchedulerPendingSpawn[];
  projectionRefreshRepoIds: Set<string>;
}): {
  activeJobCount: number;
  dispatchStateChanged: boolean;
  lastDispatchAt?: string;
} {
  const capacity = createSchedulerDispatchCapacity(input.activeJobs, input.config, input.resourcePressured);
  if (capacity.workers <= 0) {
    return { activeJobCount: input.activeJobs.length, dispatchStateChanged: false };
  }

  const scheduleNow = input.now();
  const repoIds = selectExecutionJobDispatchRepositories(input.activeJobs, scheduleNow, input.lastRepoDispatch);
  const reservedRepos = new Set(capacity.reservedJobs.map((job) => job.repoId));
  let dispatchStateChanged = false;
  let lastDispatchAt: string | undefined;
  const canDispatch = (job: ExecutionJob): boolean => schedulerDispatchCapacityAllows(capacity, job);

  for (const repoId of repoIds) {
    if (capacity.workers <= 0) break;
    if (!reservedRepos.has(repoId) && reservedRepos.size >= input.config.maxConcurrentRepositories) continue;
    const actor = input.getActor(repoId);
    let dispatch: RepoActorDispatch | undefined;
    try {
      dispatch = actor.tryClaimNext({
        scheduleNow,
        canDispatch,
        refreshProjection: false,
        lockWaitMs: 0,
      });
      input.projectionRefreshRepoIds.add(repoId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('LOCK_HELD:')) continue;
      throw error;
    }
    if (!dispatch) continue;

    // A successful claim is the durable capacity reservation. Count it before
    // Worker spawn/attachment so the dispatched -> running window cannot overrun.
    consumeSchedulerDispatchCapacity(capacity, dispatch.job);
    reservedRepos.add(repoId);
    const dispatchedAt = input.now();
    input.lastRepoDispatch.set(repoId, dispatchedAt);
    lastDispatchAt = new Date(dispatchedAt).toISOString();
    dispatchStateChanged = true;
    input.pendingSpawns.push({ repoId, jobId: dispatch.job.jobId });
  }

  return {
    activeJobCount: input.activeJobs.length,
    dispatchStateChanged,
    ...(lastDispatchAt ? { lastDispatchAt } : {}),
  };
}
