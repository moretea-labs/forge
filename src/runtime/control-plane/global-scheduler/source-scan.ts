const GIT_STATUS_SAMPLE_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.FORGE_GIT_STATUS_SAMPLE_INTERVAL_MS ?? 5_000),
);
const IDLE_REPOSITORY_SCAN_INTERVAL_MS = Math.max(
  GIT_STATUS_SAMPLE_INTERVAL_MS,
  Number(process.env.FORGE_IDLE_REPOSITORY_SCAN_INTERVAL_MS ?? 60_000),
);

export { GIT_STATUS_SAMPLE_INTERVAL_MS, IDLE_REPOSITORY_SCAN_INTERVAL_MS };

export function selectSchedulerSourceScanRepositories<T extends { repoId: string }>(
  repositories: readonly T[],
  activeRepoIds: ReadonlySet<string>,
  nowMs: number,
  lastSourceScanAt: number,
): T[] {
  const active = repositories.filter((repository) => activeRepoIds.has(repository.repoId));
  if (active.length > 0) return active;
  if (repositories.length === 0 || nowMs - lastSourceScanAt < IDLE_REPOSITORY_SCAN_INTERVAL_MS) return [];
  // fs.watch/dirty markers drive prompt refresh for active mutations. The idle
  // scan is only a safety net, so spread it across minutes instead of blocking
  // the Runtime event loop on every registered repository at once.
  const slot = Math.floor(nowMs / IDLE_REPOSITORY_SCAN_INTERVAL_MS) % repositories.length;
  return [repositories[slot]!];
}

export interface SchedulerSourceSamplingPlan<T extends { repoId: string }> {
  sourceScanRepositories: T[];
  shouldSample: boolean;
  avoidedRepositoryCount: number;
}

export function planSchedulerSourceSampling<T extends { repoId: string }>(input: {
  repositories: readonly T[];
  activeRepoIds: ReadonlySet<string>;
  nowMs: number;
  lastSourceScanAt: number;
  lastGitStatusSampleAt: number;
}): SchedulerSourceSamplingPlan<T> {
  const sourceScanRepositories = selectSchedulerSourceScanRepositories(
    input.repositories,
    input.activeRepoIds,
    input.nowMs,
    input.lastSourceScanAt,
  );
  const sourceScanDue = sourceScanRepositories.length > 0;
  const shouldSample = sourceScanDue
    && input.nowMs - input.lastGitStatusSampleAt >= GIT_STATUS_SAMPLE_INTERVAL_MS;
  return {
    sourceScanRepositories,
    shouldSample,
    avoidedRepositoryCount: shouldSample
      ? Math.max(0, input.repositories.length - sourceScanRepositories.length)
      : sourceScanDue
        ? 0
        : input.repositories.length,
  };
}
