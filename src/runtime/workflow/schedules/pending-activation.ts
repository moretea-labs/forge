import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveControllerHome } from '../../../cli/repositories/controller-home';
import { getSchedule, saveSchedule } from '../../../../packages/kernel/scheduler/api/index';

const EXTERNAL_CONTROLLER_WAKE_OPERATION = 'external_controller_wake';

export interface PendingContinuationActivationMarker {
  schemaVersion: 1;
  repoId: string;
  scheduleId: string;
  workId: string;
  queuedAt: string;
}

export interface PendingContinuationActivationResult {
  repoId: string;
  scheduleId: string;
  workId: string;
  status: 'activated' | 'already_active' | 'cancelled' | 'failed';
  reason?: string;
}

export function pendingContinuationActivationRoot(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'runtime', 'pending-continuation-activations');
}

function markerPath(controllerHome: string, repoId: string, scheduleId: string): string {
  const digest = createHash('sha256').update(`${repoId}:${scheduleId}`).digest('hex').slice(0, 32);
  return join(pendingContinuationActivationRoot(controllerHome), `${digest}.json`);
}

function validMarker(value: unknown): value is PendingContinuationActivationMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as PendingContinuationActivationMarker;
  return marker.schemaVersion === 1
    && typeof marker.repoId === 'string' && marker.repoId.length > 0
    && typeof marker.scheduleId === 'string' && marker.scheduleId.length > 0
    && typeof marker.workId === 'string' && marker.workId.length > 0
    && typeof marker.queuedAt === 'string' && Number.isFinite(Date.parse(marker.queuedAt));
}

function readMarker(path: string): PendingContinuationActivationMarker {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!validMarker(parsed)) throw new Error('PENDING_CONTINUATION_ACTIVATION_MARKER_INVALID');
  return parsed;
}

export function queuePendingContinuationActivation(
  controllerHome: string,
  repoId: string,
  scheduleId: string,
): PendingContinuationActivationMarker {
  const schedule = getSchedule(controllerHome, repoId, scheduleId);
  if (schedule.action.operation !== EXTERNAL_CONTROLLER_WAKE_OPERATION) {
    throw new Error('PENDING_CONTINUATION_ACTIVATION_REQUIRES_EXTERNAL_CONTROLLER_WAKE');
  }
  const workId = schedule.action.arguments?.work_id;
  if (typeof workId !== 'string' || !workId.trim()) {
    throw new Error('PENDING_CONTINUATION_ACTIVATION_WORK_ID_REQUIRED');
  }
  if (!schedule.enabled) throw new Error('PENDING_CONTINUATION_ACTIVATION_REQUIRES_ENABLED_SCHEDULE');
  if (!schedule.policy.shadowMode) throw new Error('PENDING_CONTINUATION_ACTIVATION_REQUIRES_SHADOW_SCHEDULE');

  const path = markerPath(controllerHome, repoId, scheduleId);
  if (existsSync(path)) {
    const existing = readMarker(path);
    if (existing.repoId !== repoId || existing.scheduleId !== scheduleId || existing.workId !== workId) {
      throw new Error('PENDING_CONTINUATION_ACTIVATION_MARKER_CONFLICT');
    }
    return existing;
  }

  const marker: PendingContinuationActivationMarker = {
    schemaVersion: 1,
    repoId,
    scheduleId,
    workId: workId.trim(),
    queuedAt: new Date().toISOString(),
  };
  const root = pendingContinuationActivationRoot(controllerHome);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  return marker;
}

export function listPendingContinuationActivations(controllerHome: string): PendingContinuationActivationMarker[] {
  const root = pendingContinuationActivationRoot(controllerHome);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try { return [readMarker(join(root, name))]; } catch { return []; }
    })
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export function applyPendingContinuationActivations(controllerHome: string): PendingContinuationActivationResult[] {
  const root = pendingContinuationActivationRoot(controllerHome);
  if (!existsSync(root)) return [];
  const results: PendingContinuationActivationResult[] = [];
  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(root, name);
    try {
      const marker = readMarker(path);
      const schedule = getSchedule(controllerHome, marker.repoId, marker.scheduleId);
      const workId = schedule.action.arguments?.work_id;
      if (schedule.action.operation !== EXTERNAL_CONTROLLER_WAKE_OPERATION || workId !== marker.workId) {
        results.push({ ...marker, status: 'failed', reason: 'Schedule no longer targets the queued Work continuation.' });
        continue;
      }
      if (!schedule.enabled) {
        rmSync(path, { force: true });
        results.push({ ...marker, status: 'cancelled', reason: 'Schedule was disabled before Runtime activation.' });
        continue;
      }
      if (!schedule.policy.shadowMode) {
        rmSync(path, { force: true });
        results.push({ ...marker, status: 'already_active' });
        continue;
      }
      saveSchedule(controllerHome, { ...schedule, policy: { ...schedule.policy, shadowMode: false } });
      rmSync(path, { force: true });
      results.push({ ...marker, status: 'activated' });
    } catch (error) {
      results.push({
        repoId: 'unknown',
        scheduleId: name,
        workId: 'unknown',
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
