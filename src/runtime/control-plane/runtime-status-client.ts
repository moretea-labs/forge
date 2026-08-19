import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { readSchedulerHealthSnapshot } from './global-scheduler/scheduler';
import type { RuntimeSourceIdentity } from './runtime-generation';
import { readRuntimeOwner } from '../root/ownership';
import { observeRuntimeStatus } from '../root/status';
import { readRuntimeGeneration } from './runtime-generation';

export type ForgeRuntimeShutdownReason =
  | 'SIGINT'
  | 'SIGTERM'
  | 'max_lifetime'
  | 'scheduler_error'
  | 'lifecycle_complete'
  | 'process_missing';

/** Read-only observation over the Canonical Forge Runtime. */
export interface ForgeRuntimeStatus {
  schemaVersion: 1;
  status: 'starting' | 'ready' | 'failed' | 'stopped' | 'unavailable';
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  shutdownReason?: ForgeRuntimeShutdownReason;
  error?: string;
  gatewaySeparated?: boolean;
  workerIsolation?: boolean;
  degraded?: boolean;
  generation?: string;
  source?: RuntimeSourceIdentity;
  restartRequired?: boolean;
  restartReasons?: string[];
  instanceId?: string;
}

export const DEFAULT_SCHEDULER_HEARTBEAT_TIMEOUT_MS = 60_000;
const MIN_SCHEDULER_HEARTBEAT_TIMEOUT_MS = 5_000;

export function schedulerHeartbeatSnapshotHealthy(
  scheduler: ReturnType<typeof readSchedulerHealthSnapshot>,
  nowMs = Date.now(),
): boolean {
  if (!scheduler.loopStartedAt) return false;
  const heartbeat = scheduler.lastHeartbeatAt ?? scheduler.lastTickAt;
  if (!heartbeat) return false;
  const heartbeatAt = Date.parse(heartbeat);
  const configuredTimeout = Number(scheduler.heartbeatTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.max(MIN_SCHEDULER_HEARTBEAT_TIMEOUT_MS, configuredTimeout)
    : DEFAULT_SCHEDULER_HEARTBEAT_TIMEOUT_MS;
  return Number.isFinite(heartbeatAt) && nowMs - heartbeatAt <= timeoutMs;
}

export function resolveForgeRuntimeStatusHome(controllerHome: string): string {
  return resolveControllerHome(controllerHome);
}

export function readForgeRuntimeStatus(controllerHome: string): ForgeRuntimeStatus {
  const home = resolveForgeRuntimeStatusHome(controllerHome);
  const observation = observeRuntimeStatus(home);
  const owner = readRuntimeOwner(home);
  const snapshot = observation.snapshot;
  const generation = readRuntimeGeneration(home);
  const status: ForgeRuntimeStatus['status'] = observation.ready
    ? 'ready'
    : observation.running
      ? 'starting'
      : snapshot
        ? 'stopped'
        : 'unavailable';
  const pid = snapshot?.pid ?? owner?.pid;
  const startedAt = snapshot?.startedAt ?? owner?.acquiredAt;
  const instanceId = snapshot?.runtimeInstanceId ?? owner?.runtimeInstanceId;
  return {
    schemaVersion: 1,
    status,
    ...(pid ? { pid } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(!observation.running && snapshot ? { stoppedAt: snapshot.updatedAt, shutdownReason: 'process_missing' as const } : {}),
    ...(!observation.ready && observation.reasonCodes.length > 0 ? { error: observation.reasonCodes.join(',') } : {}),
    gatewaySeparated: false,
    workerIsolation: true,
    ...(generation ? { generation: generation.generation, source: generation.source } : {}),
    degraded: observation.running && !observation.ready,
    restartRequired: false,
    restartReasons: [],
    ...(instanceId ? { instanceId } : {}),
  };
}
