import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { assertStorageHeadroom } from '../shared/storage-capacity';
import { measureReclaimablePath } from '../control-plane/lifecycle-retention-metrics';

export const RUNTIME_QUARANTINE_RETENTION_POLICY_VERSION = 'runtime-quarantine-retention-v1';
export const DEFAULT_RUNTIME_QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_RUNTIME_QUARANTINE_MAX_ENTRIES = 200;
export const DEFAULT_RUNTIME_QUARANTINE_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_RUNTIME_QUARANTINE_SCAN_BUDGET = 1_000;
const DEFAULT_RUNTIME_QUARANTINE_REMOVAL_BUDGET = 50;

export interface RuntimeQuarantineRetentionOptions {
  nowMs?: number;
  retentionMs?: number;
  maxRetainedEntries?: number;
  maxRetainedBytes?: number;
  maxEntries?: number;
  maxRemovals?: number;
}

export interface RuntimeQuarantineRetentionReport {
  schemaVersion: 1;
  policyVersion: typeof RUNTIME_QUARANTINE_RETENTION_POLICY_VERSION;
  root: string;
  inspected: number;
  migratedLegacyCount: number;
  eligible: number;
  removedCount: number;
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
  retained: number;
  protectedActiveCount: 0;
  blockerReasons: Record<string, number>;
  errors: string[];
  budgetExhausted: boolean;
}

export function runtimeQuarantineRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'quarantine', 'local-jobs');
}

export function runtimeQuarantinePath(controllerHome: string, repoId: string, id: string, at = new Date()): string {
  const safeId = id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return join(runtimeQuarantineRoot(controllerHome, repoId), `${stamp}-${safeId}`);
}

function legacyQuarantineRoots(repoRoot: string): string[] {
  return [
    join(repoRoot, '.ai', 'harness', 'local-jobs-quarantine'),
    join(repoRoot, '.ai', 'harness', 'quarantine', 'local-jobs'),
  ];
}

function nextAvailablePath(root: string, name: string): string {
  const base = join(root, name);
  if (!existsSync(base)) return base;
  for (let index = 1; index <= 1_000; index += 1) {
    const candidate = join(root, `${name}-${index}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`RUNTIME_QUARANTINE_DESTINATION_EXHAUSTED: ${name}`);
}

function movePreservingEvidence(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    renameSync(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const measurement = measureReclaimablePath(source);
  assertStorageHeadroom(destination, {
    operation: 'runtime_quarantine_cross_device_relocation',
    requiredBytes: measurement.complete ? measurement.bytes : undefined,
    reserveBytes: 16 * 1024 * 1024,
  });
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
  });
  rmSync(source, { recursive: true, force: true });
}


export function quarantineRuntimePath(controllerHome: string, repoId: string, source: string, id: string): string {
  const root = runtimeQuarantineRoot(controllerHome, repoId);
  const proposed = runtimeQuarantinePath(controllerHome, repoId, id);
  const destination = nextAvailablePath(root, basename(proposed));
  movePreservingEvidence(source, destination);
  return destination;
}

function removeEmptyLegacyRoot(root: string): void {
  if (!existsSync(root)) return;
  try {
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
  } catch {
    // A concurrent writer or unreadable legacy directory is preserved fail-closed.
  }
}

export function cleanupRuntimeQuarantine(
  controllerHome: string,
  repoId: string,
  repoRoot: string,
  options: RuntimeQuarantineRetentionOptions = {},
): RuntimeQuarantineRetentionReport {
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = Math.max(60_000, Math.floor(options.retentionMs ?? DEFAULT_RUNTIME_QUARANTINE_RETENTION_MS));
  const maxRetainedEntries = Math.max(1, Math.floor(options.maxRetainedEntries ?? DEFAULT_RUNTIME_QUARANTINE_MAX_ENTRIES));
  const maxRetainedBytes = Math.max(1, Math.floor(options.maxRetainedBytes ?? DEFAULT_RUNTIME_QUARANTINE_MAX_BYTES));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_RUNTIME_QUARANTINE_SCAN_BUDGET));
  let remainingRemovals = Math.max(1, Math.floor(options.maxRemovals ?? DEFAULT_RUNTIME_QUARANTINE_REMOVAL_BUDGET));
  const root = runtimeQuarantineRoot(controllerHome, repoId);
  const report: RuntimeQuarantineRetentionReport = {
    schemaVersion: 1,
    policyVersion: RUNTIME_QUARANTINE_RETENTION_POLICY_VERSION,
    root,
    inspected: 0,
    migratedLegacyCount: 0,
    eligible: 0,
    removedCount: 0,
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
    retained: 0,
    protectedActiveCount: 0,
    blockerReasons: {},
    errors: [],
    budgetExhausted: false,
  };
  const block = (reason: string): void => { report.blockerReasons[reason] = (report.blockerReasons[reason] ?? 0) + 1; };
  mkdirSync(root, { recursive: true, mode: 0o700 });

  let migrationBudget = maxEntries;
  for (const legacyRoot of legacyQuarantineRoots(repoRoot)) {
    if (!existsSync(legacyRoot)) continue;
    try {
      const legacyStat = lstatSync(legacyRoot);
      if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) {
        if (migrationBudget <= 0) {
          report.budgetExhausted = true;
          block('legacy_migration_scan_budget_exhausted');
          continue;
        }
        migrationBudget -= 1;
        movePreservingEvidence(legacyRoot, nextAvailablePath(root, `legacy-root-${basename(legacyRoot)}`));
        report.migratedLegacyCount += 1;
        continue;
      }
    } catch (error) {
      report.errors.push(`legacy quarantine inspect ${legacyRoot}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let entries;
    try {
      entries = readdirSync(legacyRoot, { withFileTypes: true });
    } catch (error) {
      report.errors.push(`legacy quarantine read ${legacyRoot}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (migrationBudget <= 0) {
        report.budgetExhausted = true;
        block('legacy_migration_scan_budget_exhausted');
        break;
      }
      migrationBudget -= 1;
      const source = join(legacyRoot, entry.name);
      try {
        movePreservingEvidence(source, nextAvailablePath(root, `legacy-${entry.name}`));
        report.migratedLegacyCount += 1;
      } catch (error) {
        report.errors.push(`legacy quarantine migrate ${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    removeEmptyLegacyRoot(legacyRoot);
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .map((entry) => {
        const path = join(root, entry.name);
        try {
          return { name: entry.name, path, mtimeMs: lstatSync(path).mtimeMs };
        } catch {
          return { name: entry.name, path, mtimeMs: nowMs };
        }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  } catch (error) {
    report.errors.push(`quarantine root read: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }

  let retainedBytes = 0;
  const scanned = entries.slice(0, maxEntries);
  if (entries.length > scanned.length) {
    report.budgetExhausted = true;
    block('scan_budget_exhausted');
  }
  for (let index = 0; index < scanned.length; index += 1) {
    const entry = scanned[index];
    report.inspected += 1;
    let stat;
    try {
      stat = lstatSync(entry.path);
    } catch {
      block('entry_disappeared');
      continue;
    }
    const measurement = measureReclaimablePath(entry.path);
    const expired = nowMs - stat.mtimeMs > retentionMs;
    const overCount = index >= maxRetainedEntries;
    const overBytes = measurement.complete && retainedBytes + measurement.bytes > maxRetainedBytes;
    const eligible = expired || overCount || overBytes;
    if (!eligible) {
      report.retained += 1;
      if (measurement.complete) retainedBytes += measurement.bytes;
      else block('retained_size_unknown');
      continue;
    }
    report.eligible += 1;
    if (remainingRemovals <= 0) {
      report.budgetExhausted = true;
      block('removal_budget_exhausted');
      report.retained += 1;
      continue;
    }
    try {
      remainingRemovals -= 1;
      rmSync(entry.path, { recursive: true, force: true });
      report.removedCount += 1;
      if (measurement.complete) report.reclaimedBytes += measurement.bytes;
      else report.unknownReclaimedByteCount += 1;
    } catch (error) {
      report.errors.push(`quarantine remove ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
