import type { RepositoryRecord } from '../../../cli/repositories/types';
import { getRuntimeWriteClaim } from '../../root/write-fence';
import { rebuildRepositoryProjection, refreshRepositoryProjectionForRepository } from '../../projections/materialized-view';
import { readRepositoryGitStatusSample } from '../../projections/git-status-sampler';

export interface SchedulerProjectionRefreshTargets {
  repositories: RepositoryRecord[];
  rebuildRepoIds: string[];
}

export function selectSchedulerProjectionRefreshTargets(
  repositories: readonly RepositoryRecord[],
  sourceScanRepositories: readonly RepositoryRecord[],
  projectionRefreshRepoIds: Iterable<string>,
): SchedulerProjectionRefreshTargets {
  const candidates = new Map(sourceScanRepositories.map((repository) => [repository.repoId, repository]));
  const repositoryById = new Map(repositories.map((repository) => [repository.repoId, repository]));
  const rebuildRepoIds: string[] = [];
  const rebuildSeen = new Set<string>();
  for (const repoId of projectionRefreshRepoIds) {
    const repository = repositoryById.get(repoId);
    if (repository) {
      candidates.set(repoId, repository);
      continue;
    }
    if (!rebuildSeen.has(repoId)) {
      rebuildSeen.add(repoId);
      rebuildRepoIds.push(repoId);
    }
  }
  return {
    repositories: [...candidates.values()],
    rebuildRepoIds,
  };
}

export function refreshSchedulerRepositoryProjections(input: {
  controllerHome: string;
  repositories: readonly RepositoryRecord[];
  sourceScanRepositories: readonly RepositoryRecord[];
  projectionRefreshRepoIds: Iterable<string>;
  controllerPid: number;
}): void {
  const targets = selectSchedulerProjectionRefreshTargets(
    input.repositories,
    input.sourceScanRepositories,
    input.projectionRefreshRepoIds,
  );
  for (const repoId of targets.rebuildRepoIds) {
    try {
      rebuildRepositoryProjection(input.controllerHome, repoId);
    } catch (error) {
      console.error('[forge scheduler] projection refresh failed:', error);
    }
  }
  for (const repository of targets.repositories) {
    try {
      const sample = readRepositoryGitStatusSample(
        input.controllerHome,
        repository.repoId,
        repository.activeCheckoutId,
      );
      const runtimeInstanceId = getRuntimeWriteClaim()?.runtimeInstanceId;
      refreshRepositoryProjectionForRepository(input.controllerHome, repository, {
        sourceRevision: sample?.head ?? undefined,
        reason: 'scheduler-source-scan',
        owner: {
          pid: input.controllerPid,
          ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
        },
      });
    } catch (error) {
      console.error('[forge scheduler] projection refresh failed:', error);
    }
  }
}
