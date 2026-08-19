import { readFileSync } from 'fs';
import { join } from 'path';
import { writeJsonAtomic } from '../shared/json-files';
import {
  readCurrentRecoveryRelease,
  readRecoveryRuntimeIdentity,
  recoveryRoot,
  type RecoveryReleaseDescriptor,
  type RecoveryRuntimeIdentity,
} from './release';

export const RECOVERY_WATCHDOG_MAX_PULSE_AGE_MS = 20_000;
export const RECOVERY_WATCHDOG_MAX_TICK_AGE_MS = 180_000;

export interface RecoveryWatchdogHeartbeat {
  schemaVersion: 1;
  pid: number;
  startedAt: string;
  releasePath: string;
  releaseRevision: string;
  sourceCommit: string;
  manifestSha256: string;
  lastPulseAt: string;
  lastTickStartedAt?: string;
  lastTickCompletedAt?: string;
  lastTickFailedAt?: string;
  lastError?: string;
}

export interface RecoveryWatchdogHealth {
  ok: boolean;
  detail: string;
  pulseAgeMs?: number;
  tickAgeMs?: number;
  heartbeat?: RecoveryWatchdogHeartbeat;
  runtimeIdentity?: RecoveryRuntimeIdentity;
  currentReleaseRevision?: string;
}

export function recoveryWatchdogHeartbeatPath(controllerHome: string): string {
  return join(recoveryRoot(controllerHome), 'state', 'watchdog-heartbeat.json');
}

export function createRecoveryWatchdogHeartbeat(
  identity: RecoveryRuntimeIdentity | undefined,
  nowMs = Date.now(),
): RecoveryWatchdogHeartbeat {
  const now = new Date(nowMs).toISOString();
  return {
    schemaVersion: 1,
    pid: identity?.pid ?? process.pid,
    startedAt: identity?.startedAt ?? now,
    releasePath: identity?.releasePath ?? 'unmanaged-source',
    releaseRevision: identity?.releaseRevision ?? 'unmanaged-source',
    sourceCommit: identity?.sourceCommit ?? 'unmanaged-source',
    manifestSha256: identity?.manifestSha256 ?? 'unmanaged-source',
    lastPulseAt: now,
  };
}

export function writeRecoveryWatchdogHeartbeat(
  controllerHome: string,
  heartbeat: RecoveryWatchdogHeartbeat,
): RecoveryWatchdogHeartbeat {
  writeJsonAtomic(recoveryWatchdogHeartbeatPath(controllerHome), heartbeat);
  return heartbeat;
}

export function readRecoveryWatchdogHeartbeat(controllerHome: string): RecoveryWatchdogHeartbeat | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recoveryWatchdogHeartbeatPath(controllerHome), 'utf8')) as RecoveryWatchdogHeartbeat;
    if (
      parsed.schemaVersion !== 1
      || !Number.isInteger(parsed.pid)
      || typeof parsed.lastPulseAt !== 'string'
      || typeof parsed.releaseRevision !== 'string'
      || typeof parsed.manifestSha256 !== 'string'
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function latestTerminalTickAt(heartbeat: RecoveryWatchdogHeartbeat): number {
  return Math.max(
    heartbeat.lastTickCompletedAt ? Date.parse(heartbeat.lastTickCompletedAt) : 0,
    heartbeat.lastTickFailedAt ? Date.parse(heartbeat.lastTickFailedAt) : 0,
  );
}

export function evaluateRecoveryWatchdogHealth(input: {
  heartbeat?: RecoveryWatchdogHeartbeat;
  runtimeIdentity?: RecoveryRuntimeIdentity;
  currentRelease?: Pick<RecoveryReleaseDescriptor, 'releasePath' | 'releaseRevision' | 'sourceCommit' | 'manifestSha256'>;
  nowMs?: number;
  maxPulseAgeMs?: number;
  maxTickAgeMs?: number;
  pidAlive?: (pid: number) => boolean;
}): RecoveryWatchdogHealth {
  const heartbeat = input.heartbeat;
  const runtimeIdentity = input.runtimeIdentity;
  const current = input.currentRelease;
  if (!current) return { ok: false, detail: 'current immutable Recovery release is unavailable' };
  if (!runtimeIdentity) return { ok: false, detail: 'Recovery Watchdog runtime identity is unavailable', currentReleaseRevision: current.releaseRevision };
  if (!heartbeat) return { ok: false, detail: 'Recovery Watchdog heartbeat is unavailable', runtimeIdentity, currentReleaseRevision: current.releaseRevision };
  if (heartbeat.pid !== runtimeIdentity.pid) {
    return { ok: false, detail: 'Recovery Watchdog heartbeat PID does not match runtime identity', heartbeat, runtimeIdentity, currentReleaseRevision: current.releaseRevision };
  }
  if (
    runtimeIdentity.releasePath !== current.releasePath
    || runtimeIdentity.releaseRevision !== current.releaseRevision
    || runtimeIdentity.sourceCommit !== current.sourceCommit
    || runtimeIdentity.manifestSha256 !== current.manifestSha256
    || heartbeat.releasePath !== current.releasePath
    || heartbeat.releaseRevision !== current.releaseRevision
    || heartbeat.sourceCommit !== current.sourceCommit
    || heartbeat.manifestSha256 !== current.manifestSha256
  ) {
    return { ok: false, detail: 'Recovery Watchdog is not running the current immutable Recovery release', heartbeat, runtimeIdentity, currentReleaseRevision: current.releaseRevision };
  }
  if (!(input.pidAlive ?? pidExists)(runtimeIdentity.pid)) {
    return { ok: false, detail: 'Recovery Watchdog process is not alive', heartbeat, runtimeIdentity, currentReleaseRevision: current.releaseRevision };
  }
  const now = input.nowMs ?? Date.now();
  const pulseAt = Date.parse(heartbeat.lastPulseAt);
  const pulseAgeMs = Number.isFinite(pulseAt) ? Math.max(0, now - pulseAt) : Number.POSITIVE_INFINITY;
  const maxPulseAgeMs = Math.max(1_000, input.maxPulseAgeMs ?? RECOVERY_WATCHDOG_MAX_PULSE_AGE_MS);
  if (pulseAgeMs > maxPulseAgeMs) {
    return { ok: false, detail: 'Recovery Watchdog heartbeat is stale', pulseAgeMs, heartbeat, runtimeIdentity, currentReleaseRevision: current.releaseRevision };
  }
  const tickStartedAt = heartbeat.lastTickStartedAt ? Date.parse(heartbeat.lastTickStartedAt) : 0;
  const tickTerminalAt = latestTerminalTickAt(heartbeat);
  if (tickStartedAt > tickTerminalAt) {
    const tickAgeMs = Math.max(0, now - tickStartedAt);
    const maxTickAgeMs = Math.max(maxPulseAgeMs, input.maxTickAgeMs ?? RECOVERY_WATCHDOG_MAX_TICK_AGE_MS);
    if (tickAgeMs > maxTickAgeMs) {
      return { ok: false, detail: 'Recovery Watchdog tick is stuck beyond its bounded recovery window', pulseAgeMs, tickAgeMs, heartbeat, runtimeIdentity, currentReleaseRevision: current.releaseRevision };
    }
  }
  return { ok: true, detail: 'Recovery Watchdog heartbeat, PID, and immutable release identity are current', pulseAgeMs, heartbeat, runtimeIdentity, currentReleaseRevision: current.releaseRevision };
}

export function observeRecoveryWatchdogHealth(controllerHome: string): RecoveryWatchdogHealth {
  return evaluateRecoveryWatchdogHealth({
    heartbeat: readRecoveryWatchdogHeartbeat(controllerHome),
    runtimeIdentity: readRecoveryRuntimeIdentity(controllerHome, 'watchdog'),
    currentRelease: readCurrentRecoveryRelease(controllerHome),
  });
}
