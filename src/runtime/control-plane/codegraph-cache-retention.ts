import { existsSync, lstatSync, readdirSync, rmSync } from 'fs';
import { join, relative, resolve } from 'path';
import { codegraphCacheIdentity, codegraphCacheRoot } from '../context/codegraph-cache-boundary';
import { measureReclaimablePath } from './lifecycle-retention-metrics';

export const CODEGRAPH_CACHE_RETENTION_POLICY_VERSION = 'codegraph-cache-retention-v2';
export const DEFAULT_CODEGRAPH_CACHE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_CODEGRAPH_CACHE_MAX_REPOSITORY_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CODEGRAPH_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CODEGRAPH_CACHE_SCAN_BUDGET = 512;
const DEFAULT_CODEGRAPH_CACHE_REMOVAL_BUDGET = 16;

export interface CodegraphCacheRetentionOptions {
  nowMs?: number;
  retentionMs?: number;
  maxRepositoryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  maxRemovals?: number;
  /** Repository roots with a live process-scoped locator. */
  protectedRepositoryRoots?: readonly string[];
}

export interface CodegraphCacheRetentionReport {
  policyVersion: typeof CODEGRAPH_CACHE_RETENTION_POLICY_VERSION;
  inspected: number;
  eligible: number;
  attempted: number;
  removedPaths: string[];
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
  observedBytes: number;
  unknownObservedByteCount: number;
  retained: number;
  protected: number;
  protectedOverCapacity: number;
  skippedByReason: Record<string, number>;
  errors: string[];
  truncated: boolean;
  budgetExhausted: boolean;
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/**
 * Reclaim only Forge-owned, rebuildable CodeGraph caches. LRU recency is the
 * cache-root mtime touched when a process-scoped locator is acquired/released.
 * A live locator fences deletion. Inactive caches are eligible when old, over
 * the per-repository cap, or when the Controller Home aggregate is over cap.
 */
export function cleanupCodegraphCaches(
  controllerHome: string,
  options: CodegraphCacheRetentionOptions = {},
): CodegraphCacheRetentionReport {
  const root = codegraphCacheRoot(controllerHome);
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = Math.max(60_000, Math.floor(options.retentionMs ?? DEFAULT_CODEGRAPH_CACHE_RETENTION_MS));
  const maxRepositoryBytes = Math.max(1, Math.floor(options.maxRepositoryBytes ?? DEFAULT_CODEGRAPH_CACHE_MAX_REPOSITORY_BYTES));
  const maxTotalBytes = Math.max(1, Math.floor(options.maxTotalBytes ?? DEFAULT_CODEGRAPH_CACHE_MAX_TOTAL_BYTES));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_CODEGRAPH_CACHE_SCAN_BUDGET));
  const maxRemovals = Math.max(0, Math.floor(options.maxRemovals ?? DEFAULT_CODEGRAPH_CACHE_REMOVAL_BUDGET));
  const protectedIds = new Set((options.protectedRepositoryRoots ?? []).map(codegraphCacheIdentity));
  const report: CodegraphCacheRetentionReport = {
    policyVersion: CODEGRAPH_CACHE_RETENTION_POLICY_VERSION,
    inspected: 0,
    eligible: 0,
    attempted: 0,
    removedPaths: [],
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
    observedBytes: 0,
    unknownObservedByteCount: 0,
    retained: 0,
    protected: 0,
    protectedOverCapacity: 0,
    skippedByReason: {},
    errors: [],
    truncated: false,
    budgetExhausted: false,
  };
  if (!existsSync(root)) return report;

  let entries: Array<{ name: string; path: string; mtimeMs: number; bytes: number; sizeKnown: boolean }> = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, String(entry.name));
      try {
        const stat = lstatSync(path);
        if (!entry.isDirectory() || stat.isSymbolicLink() || !/^[a-f0-9]{24}$/.test(String(entry.name))) {
          increment(report.skippedByReason, 'ownership_unproven');
          report.retained += 1;
          continue;
        }
        const measurement = measureReclaimablePath(path);
        if (measurement.complete) report.observedBytes += measurement.bytes;
        else report.unknownObservedByteCount += 1;
        entries.push({ name: String(entry.name), path, mtimeMs: stat.mtimeMs, bytes: measurement.bytes, sizeKnown: measurement.complete });
      } catch (error) {
        report.errors.push(`${String(entry.name)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    report.errors.push(`codegraph cache root: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }

  // Oldest first is LRU because locator acquire/release touches the cache root.
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  if (entries.length > maxEntries) report.truncated = true;
  entries = entries.slice(0, maxEntries);
  let knownRetainedBytes = report.observedBytes;
  if (report.unknownObservedByteCount > 0) increment(report.skippedByReason, 'capacity_unknown_size');

  for (const entry of entries) {
    report.inspected += 1;
    const expired = nowMs - entry.mtimeMs >= retentionMs;
    const overRepositoryCap = entry.sizeKnown && entry.bytes > maxRepositoryBytes;
    const overTotalCap = knownRetainedBytes > maxTotalBytes;
    const capacityPressure = overRepositoryCap || overTotalCap;

    if (protectedIds.has(entry.name)) {
      report.protected += 1;
      report.retained += 1;
      increment(report.skippedByReason, 'active_locator');
      if (capacityPressure) {
        report.protectedOverCapacity += 1;
        increment(report.skippedByReason, 'active_cache_over_capacity');
      }
      continue;
    }
    if (!expired && !capacityPressure) {
      report.retained += 1;
      increment(report.skippedByReason, 'retention_grace');
      continue;
    }

    report.eligible += 1;
    if (report.attempted >= maxRemovals) {
      report.retained += 1;
      report.budgetExhausted = true;
      increment(report.skippedByReason, 'cleanup_budget_exhausted');
      continue;
    }
    report.attempted += 1;
    try {
      rmSync(entry.path, { recursive: true, force: true });
      report.removedPaths.push(relative(resolve(controllerHome), entry.path).replace(/\\/g, '/'));
      if (entry.sizeKnown) {
        report.reclaimedBytes += entry.bytes;
        knownRetainedBytes = Math.max(0, knownRetainedBytes - entry.bytes);
      } else {
        report.unknownReclaimedByteCount += 1;
      }
    } catch (error) {
      report.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (knownRetainedBytes > maxTotalBytes) increment(report.skippedByReason, 'total_capacity_not_yet_converged');
  report.removedPaths.sort();
  report.errors.sort();
  return report;
}
