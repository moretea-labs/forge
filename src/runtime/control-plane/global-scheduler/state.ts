import { join } from 'path';
import { resolveControllerHome } from '../../../cli/repositories/controller-home';
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
  lastSourceScanAt?: string;
  lastSourceScanRepoCount?: number;
  sourceScansAvoided?: number;
  lastRepoDispatch: Record<string, number>;
}

export function readSchedulerHealthSnapshot(controllerHome: string): SchedulerHealthSnapshot {
  return readJsonFile<SchedulerHealthSnapshot>(schedulerStatePath(controllerHome), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    lastRepoDispatch: {},
  });
}

export interface SchedulerRestoredState {
  lastSourceScanAt: number;
  lastSourceScanRepoCount: number;
  sourceScansAvoided: number;
  lastRepoDispatch: Array<[string, number]>;
}

export function restoreSchedulerState(state: SchedulerHealthSnapshot): SchedulerRestoredState {
  return {
    lastSourceScanAt: state.lastSourceScanAt ? Date.parse(state.lastSourceScanAt) || 0 : 0,
    lastSourceScanRepoCount: state.lastSourceScanRepoCount ?? 0,
    sourceScansAvoided: state.sourceScansAvoided ?? 0,
    lastRepoDispatch: Object.entries(state.lastRepoDispatch)
      .filter(([, timestamp]) => Number.isFinite(timestamp)),
  };
}

export interface SchedulerStateSnapshotInput {
  loopStartedAt: string;
  lastHeartbeatAt: string;
  heartbeatTimeoutMs: number;
  lastTickAt: string;
  lastDispatchAt?: string;
  lastReconcileAt?: string;
  lastSourceScanAt: number;
  lastSourceScanRepoCount: number;
  sourceScansAvoided: number;
  lastRepoDispatch: ReadonlyMap<string, number>;
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
    lastSourceScanAt: input.lastSourceScanAt ? new Date(input.lastSourceScanAt).toISOString() : undefined,
    lastSourceScanRepoCount: input.lastSourceScanRepoCount,
    sourceScansAvoided: input.sourceScansAvoided,
    lastRepoDispatch: Object.fromEntries(input.lastRepoDispatch),
  };
}

export function writeSchedulerHealthSnapshot(
  controllerHome: string,
  input: SchedulerStateSnapshotInput,
  nowMs = Date.now(),
): void {
  writeJsonAtomic(schedulerStatePath(controllerHome), buildSchedulerHealthSnapshot(input, nowMs));
}
