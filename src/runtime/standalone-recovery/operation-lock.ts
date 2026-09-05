import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { isProcessAlive } from '../shared/process-tree';

export interface RecoveryOperationLockRecord {
  schemaVersion?: 1;
  pid: number;
  instanceId: string;
  processStartTime?: string;
  acquiredAt: string;
  action?: string;
  requestId?: string;
}

export interface RecoveryOperationLockHandle {
  path: string;
  record: RecoveryOperationLockRecord;
  close: () => void;
}

export type RecoveryOperationLockAttempt =
  | { acquired: true; handle: RecoveryOperationLockHandle }
  | { acquired: false; owner: RecoveryOperationLockRecord };

function processStartTime(pid: number): string | undefined {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 4_096,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
  return result.stdout.trim() || undefined;
}

function readRecoveryOperationLockPath(path: string): RecoveryOperationLockRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as RecoveryOperationLockRecord;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    if (typeof parsed.instanceId !== 'string' || !parsed.instanceId.trim()) return undefined;
    if (typeof parsed.acquiredAt !== 'string' || !parsed.acquiredAt.trim()) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function recoveryOperationLockPath(controllerHome: string): string {
  const resolved = resolve(controllerHome);
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return join(canonical, 'recovery', 'locks', 'operation.lock');
}

export function readRecoveryOperationLock(controllerHome: string): RecoveryOperationLockRecord | undefined {
  return readRecoveryOperationLockPath(recoveryOperationLockPath(controllerHome));
}

export function recoveryOperationLockOwnerAlive(lock: RecoveryOperationLockRecord): boolean {
  if (!isProcessAlive(lock.pid)) return false;
  if (!lock.processStartTime) return true;
  const observed = processStartTime(lock.pid);
  return observed === undefined || observed === lock.processStartTime;
}

export function acquireRecoveryOperationLock(input: {
  controllerHome: string;
  action: string;
  requestId?: string;
  instanceIdPrefix?: string;
}, dependencies: {
  writeRecord?: (fd: number, content: string) => void;
} = {}): RecoveryOperationLockAttempt {
  const path = recoveryOperationLockPath(input.controllerHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const instanceId = `${input.instanceIdPrefix ?? 'recovery-operation-'}${randomUUID()}`;
  const requestId = input.requestId?.trim() || `internal:${input.action}:${instanceId}`;
  const record: RecoveryOperationLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    instanceId,
    processStartTime: processStartTime(process.pid),
    acquiredAt: new Date().toISOString(),
    action: input.action,
    requestId,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    try {
      try {
        fd = openSync(path, 'wx', 0o600);
        try {
          (dependencies.writeRecord ?? ((targetFd: number, content: string) => writeFileSync(targetFd, content)))(fd, JSON.stringify(record));
        } catch (error) {
          // O_EXCL proved this process created this exact path. A partial or failed
          // owner-record write must never leave an unreadable lock that poisons
          // every later Recovery/certification attempt.
          try { rmSync(path, { force: true }); } finally {
            try { closeSync(fd); } catch { /* best effort */ }
            fd = undefined;
          }
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = readRecoveryOperationLockPath(path);
        if (!existing) throw new Error('RECOVERY_OPERATION_LOCK_UNCERTAIN');
        if (recoveryOperationLockOwnerAlive(existing)) return { acquired: false, owner: existing };
        const latest = readRecoveryOperationLockPath(path);
        if (!latest || latest.instanceId !== existing.instanceId) {
          if (attempt === 1) {
            if (latest && recoveryOperationLockOwnerAlive(latest)) return { acquired: false, owner: latest };
            throw new Error('RECOVERY_OPERATION_LOCK_RACE');
          }
          continue;
        }
        if (recoveryOperationLockOwnerAlive(latest)) return { acquired: false, owner: latest };
        try { writeFileSync(`${path}.stale-${Date.now()}-${existing.instanceId}`, readFileSync(path)); } catch { /* evidence best effort */ }
        rmSync(path, { force: true });
        continue;
      }

      if (fd === undefined) throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
      let closed = false;
      return {
        acquired: true,
        handle: {
          path,
          record,
          close: () => {
            if (closed) return;
            closed = true;
            closeSync(fd!);
            const current = readRecoveryOperationLockPath(path);
            if (current?.instanceId === instanceId) rmSync(path, { force: true });
          },
        },
      };
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      throw error;
    }
  }
  throw new Error('RECOVERY_OPERATION_LOCK_BUSY');
}
