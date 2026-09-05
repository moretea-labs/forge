import { lstatSync, readdirSync } from 'fs';
import { join } from 'path';

export const RUNTIME_LIFECYCLE_RETENTION_POLICY_VERSION = 'runtime-lifecycle-retention-v1';
export const DEFAULT_RECLAIM_SIZE_SCAN_BUDGET = 10_000;

export interface ReclaimablePathMeasurement {
  bytes: number;
  entries: number;
  complete: boolean;
}

/**
 * Measure a cleanup candidate before deletion without turning accounting into
 * an unbounded filesystem walk. A truncated measurement is never presented as
 * exact reclaimed bytes; callers must increment unknownReclaimedByteCount.
 */
export function measureReclaimablePath(
  path: string,
  maxEntries = DEFAULT_RECLAIM_SIZE_SCAN_BUDGET,
): ReclaimablePathMeasurement {
  let remaining = Math.max(1, Math.floor(maxEntries));
  let bytes = 0;
  let entries = 0;
  let complete = true;

  const visit = (current: string): void => {
    if (remaining <= 0) {
      complete = false;
      return;
    }
    remaining -= 1;
    entries += 1;
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      complete = false;
      return;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      bytes += Math.max(0, stats.size);
      return;
    }
    let children: string[];
    try {
      children = readdirSync(current);
    } catch {
      complete = false;
      return;
    }
    for (const child of children) {
      visit(join(current, child));
      if (!complete && remaining <= 0) return;
    }
  };

  visit(path);
  return { bytes, entries, complete };
}
