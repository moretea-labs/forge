export interface SchedulerConfig {
  maxWorkers: number;
  maxConcurrentRepositories: number;
  pollIntervalMs: number;
  idleBackoffMaxMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxHeavyChecks: number;
  maxAgentProcesses: number;
  maxCodexProcesses: number;
  maxClaudeProcesses: number;
  maxGitHubProcesses: number;
  minFreeMemoryMb: number;
  maxLoadPerCpu: number;
}

export function normalizeSchedulerConfig(
  config: Partial<SchedulerConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const pollIntervalMs = Math.max(50, config.pollIntervalMs ?? 250);
  const idleBackoffMaxMs = Math.max(250, config.idleBackoffMaxMs ?? Number(env.FORGE_IDLE_BACKOFF_MAX_MS ?? 2_000));
  const heartbeatIntervalMs = Math.max(25, config.heartbeatIntervalMs ?? Number(env.FORGE_SCHEDULER_HEARTBEAT_INTERVAL_MS ?? 1_000));
  const heartbeatTimeoutMs = Math.max(
    heartbeatIntervalMs * 4,
    idleBackoffMaxMs * 4,
    config.heartbeatTimeoutMs ?? Number(env.FORGE_SCHEDULER_HEARTBEAT_TIMEOUT_MS ?? 60_000),
  );
  return {
    maxWorkers: Math.max(1, config.maxWorkers ?? Number(env.FORGE_MAX_WORKERS ?? 4)),
    maxConcurrentRepositories: Math.max(1, config.maxConcurrentRepositories ?? Number(env.FORGE_MAX_ACTIVE_REPOS ?? 4)),
    pollIntervalMs,
    idleBackoffMaxMs,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    maxHeavyChecks: Math.max(1, config.maxHeavyChecks ?? Number(env.FORGE_MAX_HEAVY_CHECKS ?? 2)),
    maxAgentProcesses: Math.max(1, config.maxAgentProcesses ?? Number(env.FORGE_MAX_AGENT_PROCESSES ?? 4)),
    maxCodexProcesses: Math.max(1, config.maxCodexProcesses ?? Number(env.FORGE_MAX_CODEX_PROCESSES ?? 3)),
    maxClaudeProcesses: Math.max(1, config.maxClaudeProcesses ?? Number(env.FORGE_MAX_CLAUDE_PROCESSES ?? 2)),
    maxGitHubProcesses: Math.max(1, config.maxGitHubProcesses ?? Number(env.FORGE_MAX_GITHUB_PROCESSES ?? 2)),
    minFreeMemoryMb: Math.max(64, config.minFreeMemoryMb ?? Number(env.FORGE_MIN_FREE_MEMORY_MB ?? 512)),
    maxLoadPerCpu: Math.max(0.25, config.maxLoadPerCpu ?? Number(env.FORGE_MAX_LOAD_PER_CPU ?? 1.5)),
  };
}
