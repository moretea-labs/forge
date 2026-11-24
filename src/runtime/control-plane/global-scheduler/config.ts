export interface SchedulerConfig {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export function normalizeSchedulerConfig(
  config: Partial<SchedulerConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const pollIntervalMs = Math.max(50, config.pollIntervalMs ?? 250);
  const heartbeatIntervalMs = Math.max(25, config.heartbeatIntervalMs ?? Number(env.FORGE_SCHEDULER_HEARTBEAT_INTERVAL_MS ?? 1_000));
  const heartbeatTimeoutMs = Math.max(
    heartbeatIntervalMs * 4,
    1_000,
    config.heartbeatTimeoutMs ?? Number(env.FORGE_SCHEDULER_HEARTBEAT_TIMEOUT_MS ?? 60_000),
  );
  return {
    pollIntervalMs,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
  };
}
