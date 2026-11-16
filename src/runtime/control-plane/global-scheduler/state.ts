import { join } from 'path';
import { resolveControllerHome } from '../../../effects/controller-home';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';

function schedulerStatePath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'scheduler', 'state.json');
}

export interface SchedulerHealthSnapshot {
  schemaVersion: 1;
  updatedAt: string;
  loopStartedAt?: string;
  lastHeartbeatAt?: string;
  heartbeatTimeoutMs?: number;
  lastTickAt?: string;
  lastDispatchAt?: string;
  lastReconcileAt?: string;
  lastRepoDispatch?: Record<string, number>;
}

export function readSchedulerHealthSnapshot(controllerHome: string): SchedulerHealthSnapshot {
  return readJsonFile<SchedulerHealthSnapshot>(schedulerStatePath(controllerHome), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
  });
}

export interface SchedulerStateSnapshotInput {
  loopStartedAt: string;
  lastHeartbeatAt: string;
  heartbeatTimeoutMs: number;
  lastTickAt: string;
  lastDispatchAt?: string;
  lastReconcileAt?: string;
}

export function buildSchedulerHealthSnapshot(
  input: SchedulerStateSnapshotInput,
  nowMs = Date.now(),
): SchedulerHealthSnapshot {
  return {
    schemaVersion: 1,
    updatedAt: new Date(nowMs).toISOString(),
    loopStartedAt: input.loopStartedAt,
    lastHeartbeatAt: input.lastHeartbeatAt,
    heartbeatTimeoutMs: input.heartbeatTimeoutMs,
    lastTickAt: input.lastTickAt,
    lastDispatchAt: input.lastDispatchAt,
    lastReconcileAt: input.lastReconcileAt,
  };
}

export function writeSchedulerHealthSnapshot(
  controllerHome: string,
  input: SchedulerStateSnapshotInput,
  nowMs = Date.now(),
): void {
  writeJsonAtomic(schedulerStatePath(controllerHome), buildSchedulerHealthSnapshot(input, nowMs));
}
