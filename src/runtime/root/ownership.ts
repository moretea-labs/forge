import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { resolveControllerHome } from '../../cli/repositories/controller-home';
import { isProcessAlive } from '../shared/process-tree';

export interface RuntimeOwnerRecord {
  schemaVersion: 1;
  runtimeInstanceId: string;
  pid: number;
  acquiredAt: string;
}

export interface RuntimeOwnershipHandle {
  record: RuntimeOwnerRecord;
  release(): void;
}

export function runtimeOwnerPath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'runtime', 'active-runtime-owner.json');
}

function readOwnerPath(path: string): RuntimeOwnerRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RuntimeOwnerRecord;
    if (value.schemaVersion !== 1 || !value.runtimeInstanceId || !Number.isInteger(value.pid)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function readRuntimeOwner(controllerHome: string): RuntimeOwnerRecord | undefined {
  return readOwnerPath(runtimeOwnerPath(controllerHome));
}

export function acquireRuntimeOwnership(
  controllerHome: string,
  runtimeInstanceId: string,
  now: () => string = () => new Date().toISOString(),
): RuntimeOwnershipHandle {
  if (!runtimeInstanceId.trim()) throw new Error('RUNTIME_INSTANCE_ID_REQUIRED');
  const path = runtimeOwnerPath(controllerHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: RuntimeOwnerRecord = {
    schemaVersion: 1,
    runtimeInstanceId,
    pid: process.pid,
    acquiredAt: now(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return {
        record,
        release: () => {
          const current = readOwnerPath(path);
          if (current?.runtimeInstanceId === runtimeInstanceId && current.pid === process.pid) {
            try { unlinkSync(path); } catch { /* already released */ }
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const current = readOwnerPath(path);
      if (current && isProcessAlive(current.pid)) {
        throw new Error(
          `RUNTIME_OWNERSHIP_CONFLICT: controller home is owned by ${current.runtimeInstanceId} pid=${current.pid}`,
        );
      }
      const stalePath = `${path}.stale-${Date.now()}-${attempt}`;
      try { renameSync(path, stalePath); } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
      }
    }
  }
  throw new Error('RUNTIME_OWNERSHIP_CONFLICT: unable to claim controller home');
}
