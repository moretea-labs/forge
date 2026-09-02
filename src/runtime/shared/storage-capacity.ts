import { existsSync, statfsSync } from 'fs';
import { dirname, resolve } from 'path';

const GIB = 1024 ** 3;
export const STORAGE_WARNING_BYTES = 50 * GIB;
export const STORAGE_CRITICAL_BYTES = 30 * GIB;

export interface StorageCapacitySnapshot {
  probePath: string;
  availableBytes?: number;
  availableGiB?: number;
  pressure: 'normal' | 'warning' | 'critical' | 'unknown';
}

export interface StorageHeadroomRequirement {
  operation: string;
  requiredBytes?: number;
  reserveBytes?: number;
}

function nearestExistingPath(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function readStorageCapacity(path: string): StorageCapacitySnapshot {
  const probePath = nearestExistingPath(path);
  let availableBytes: number | undefined;
  try {
    const fs = statfsSync(probePath);
    availableBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return { probePath, pressure: 'unknown' };
  }
  const availableGiB = Math.round((availableBytes / GIB) * 10) / 10;
  const pressure: StorageCapacitySnapshot['pressure'] = availableBytes < STORAGE_CRITICAL_BYTES
    ? 'critical'
    : availableBytes < STORAGE_WARNING_BYTES
      ? 'warning'
      : 'normal';
  return { probePath, availableBytes, availableGiB, pressure };
}

/**
 * Fail before a multi-step storage mutation when the filesystem can already
 * prove that required bytes plus rollback/emergency reserve do not fit. An
 * unavailable statfs observation does not create a second liveness authority;
 * the underlying atomic write remains authoritative and may still report
 * ENOSPC normally.
 */
export function assertStorageHeadroom(path: string, requirement: StorageHeadroomRequirement): StorageCapacitySnapshot {
  const snapshot = readStorageCapacity(path);
  if (snapshot.availableBytes === undefined) return snapshot;
  const requiredBytes = Math.max(0, Math.ceil(requirement.requiredBytes ?? 0));
  const reserveBytes = Math.max(0, Math.ceil(requirement.reserveBytes ?? 0));
  const minimumBytes = requiredBytes + reserveBytes;
  if (snapshot.availableBytes < minimumBytes) {
    throw new Error(
      `FORGE_STORAGE_HEADROOM_LOW: operation=${requirement.operation}; availableBytes=${snapshot.availableBytes}; requiredBytes=${requiredBytes}; reserveBytes=${reserveBytes}; probePath=${snapshot.probePath}`,
    );
  }
  return snapshot;
}
