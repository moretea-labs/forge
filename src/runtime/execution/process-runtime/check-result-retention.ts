import { existsSync, lstatSync, opendirSync, statSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
import { isTerminalWorkContractStatus, type WorkContract } from '../../../../packages/kernel/work/api/index';
import { listControlPlaneRecords } from '../../control-plane/persistence/sqlite-store';
import { processLogDir } from './store';
import { readPersistedCheckResultReceipt } from './check-result';

const DEFAULT_CHECK_RESULT_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_RETAINED_CHECK_RESULTS = 500;
const DEFAULT_MAX_REMOVALS = 50;

export interface CheckResultRetentionReport {
  policyVersion: 'check-result-retention-v1';
  inspected: number;
  eligible: number;
  attempted: number;
  removed: number;
  retained: number;
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
  removedPaths: string[];
  blockers: string[];
  budgetExhausted: boolean;
  scanTruncated: boolean;
}

export function cleanupPersistedCheckResults(
  controllerHome: string,
  repoId: string,
  options: { nowMs?: number; ttlMs?: number; maxRetained?: number; maxRemovals?: number; maxScan?: number } = {},
): CheckResultRetentionReport {
  const report: CheckResultRetentionReport = {
    policyVersion: 'check-result-retention-v1', inspected: 0, eligible: 0, attempted: 0, removed: 0, retained: 0,
    reclaimedBytes: 0, unknownReclaimedByteCount: 0, removedPaths: [], blockers: [], budgetExhausted: false, scanTruncated: false,
  };
  const root = join(processLogDir(controllerHome, repoId), 'check-results');
  if (!existsSync(root)) return report;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = Math.max(60_000, Math.floor(options.ttlMs ?? DEFAULT_CHECK_RESULT_TTL_MS));
  const maxRetained = Math.max(1, Math.floor(options.maxRetained ?? DEFAULT_MAX_RETAINED_CHECK_RESULTS));
  let remaining = Math.max(0, Math.floor(options.maxRemovals ?? DEFAULT_MAX_REMOVALS));
  const maxScan = Math.max(1, Math.min(Math.floor(options.maxScan ?? 5_000), 5_000));

  const protectedCacheKeys = new Set<string>();
  const workRecords = listControlPlaneRecords<WorkContract>(controllerHome, { namespace: 'work_contract', scope: repoId, limit: 5_000 });
  if (workRecords.length >= 5_000) {
    report.scanTruncated = true;
    report.blockers.push('work_scan_truncated');
    return report;
  }
  for (const record of workRecords) {
    const work = record.value;
    if (isTerminalWorkContractStatus(work.status)) continue;
    for (const verification of work.checkRefs ?? []) {
      const key = verification.receipt?.checkCacheKey?.trim();
      if (key) protectedCacheKeys.add(key);
    }
  }

  const candidates: Array<{ path: string; name: string; cacheKey: string; executedAtMs: number; bytes?: number }> = [];
  let directory: ReturnType<typeof opendirSync>;
  try { directory = opendirSync(root); } catch { return report; }
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (report.inspected >= maxScan) { report.scanTruncated = true; break; }
      const name = entry.name;
      report.inspected += 1;
      const path = join(root, name);
    try {
      if (lstatSync(path).isSymbolicLink()) {
        report.blockers.push(`symlink:${name}`);
        continue;
      }
      const receipt = readPersistedCheckResultReceipt(path);
      if (!receipt) {
        report.blockers.push(`invalid_receipt:${name}`);
        continue;
      }
      const executedAtMs = Date.parse(receipt.originalExecutedAt ?? receipt.executedAt);
      if (!Number.isFinite(executedAtMs)) {
        report.blockers.push(`invalid_time:${name}`);
        continue;
      }
      let bytes: number | undefined;
      try { bytes = statSync(path).size; } catch { /* retained if removal succeeds but size is unknown */ }
      candidates.push({ path, name, cacheKey: receipt.cacheKey, executedAtMs, bytes });
      } catch {
        report.blockers.push(`inspect_failed:${name}`);
      }
    }
  } finally {
    directory.closeSync();
  }

  candidates.sort((left, right) => right.executedAtMs - left.executedAtMs || left.name.localeCompare(right.name));
  let unprotectedRank = 0;
  for (const candidate of candidates) {
    if (protectedCacheKeys.has(candidate.cacheKey)) {
      report.retained += 1;
      continue;
    }
    const overCount = !report.scanTruncated && unprotectedRank >= maxRetained;
    unprotectedRank += 1;
    const ageExpired = nowMs - candidate.executedAtMs >= ttlMs;
    if (!overCount && !ageExpired) {
      report.retained += 1;
      continue;
    }
    report.eligible += 1;
    if (remaining <= 0) {
      report.budgetExhausted = true;
      report.retained += 1;
      continue;
    }
    report.attempted += 1;
    try {
      unlinkSync(candidate.path);
      remaining -= 1;
      report.removed += 1;
      report.removedPaths.push(relative(controllerHome, candidate.path));
      if (candidate.bytes === undefined) report.unknownReclaimedByteCount += 1;
      else report.reclaimedBytes += candidate.bytes;
    } catch {
      report.blockers.push(`remove_failed:${candidate.name}`);
      report.retained += 1;
    }
  }
  return report;
}
