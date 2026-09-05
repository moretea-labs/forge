import { existsSync, lstatSync, rmSync } from 'fs';
import { join, relative } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { listRepositories } from '../../cli/repositories/registry';
import { listActiveExecutionJobs } from '../execution/jobs/store';
import { listActiveProcessIds } from '../execution/process-runtime/store';
import { listActiveLeases } from '../resources/leases/store';
import { isTerminalWorkContractStatus, readWorkContractStore } from '../../../packages/kernel/work/api/index';
import { listControlPlaneRecords } from './persistence/sqlite-store';
import { measureReclaimablePath } from './lifecycle-retention-metrics';

const DEFAULT_RETIRED_REPOSITORY_GRACE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_SCAN_BUDGET = 512;
const DEFAULT_REMOVAL_BUDGET = 16;
const BROWSER_SESSION_SCAN_LIMIT = 5_000;

/**
 * Only Forge-owned, rebuildable/disposable repository namespace children belong
 * here. Semantic/audit/migration authorities are deliberately absent.
 */
export const RETIRED_REPOSITORY_DISPOSABLE_CHILDREN = Object.freeze([
  'artifacts',
  'browser',
  'edit-sessions',
  'ephemeral-issues',
  'hook-state',
  'indexes',
  'leases',
  'local-bridge',
  'processes',
  'projections',
  'results',
  'verification-snapshots',
  'worktrees',
] as const);

interface BrowserSessionRetentionEntry {
  status?: string;
  repositoryIds?: unknown;
}

export interface RetiredRepositoryNamespaceRetentionOptions {
  nowMs?: number;
  graceMs?: number;
  maxEntries?: number;
  maxRemovals?: number;
}

export interface RetiredRepositoryNamespaceRetentionReport {
  policyVersion: 'repository-namespace-retention-v1';
  inspected: number;
  eligible: number;
  attempted: number;
  removedPaths: string[];
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
  retained: number;
  skippedByReason: Record<string, number>;
  errors: string[];
  budgetExhausted: boolean;
}

function increment(target: Record<string, number>, reason: string, count = 1): void {
  target[reason] = (target[reason] ?? 0) + count;
}

function browserSessionBlocksRetirement(controllerHome: string, repoId: string): { blocked: boolean; uncertain: boolean } {
  const records = listControlPlaneRecords<BrowserSessionRetentionEntry>(controllerHome, {
    namespace: 'browser_session',
    scope: 'controller',
    limit: BROWSER_SESSION_SCAN_LIMIT,
  });
  if (records.length >= BROWSER_SESSION_SCAN_LIMIT) return { blocked: false, uncertain: true };
  return {
    blocked: records.some((record) => {
      if (record.value?.status !== 'active' || !Array.isArray(record.value?.repositoryIds)) return false;
      return record.value.repositoryIds.some((value) => String(value) === repoId);
    }),
    uncertain: false,
  };
}

function activeAuthorityBlockers(controllerHome: string, repoId: string): string[] {
  const blockers: string[] = [];
  if (listActiveExecutionJobs(controllerHome, repoId).length > 0) blockers.push('active_execution_job');
  if (listActiveProcessIds(controllerHome, repoId).length > 0) blockers.push('active_process');
  if (listActiveLeases(controllerHome, repoId).length > 0) blockers.push('active_lease');

  const workStore = readWorkContractStore({ controllerHome, repoId });
  for (const work of workStore.contracts) {
    if (!isTerminalWorkContractStatus(work.status)) {
      blockers.push('active_work');
      break;
    }
    if (work.phaseEvidence?.cleanup?.state !== 'satisfied') {
      blockers.push('work_cleanup_incomplete');
      break;
    }
  }

  const browser = browserSessionBlocksRetirement(controllerHome, repoId);
  if (browser.blocked) blockers.push('active_browser_session');
  if (browser.uncertain) blockers.push('browser_session_scan_truncated');
  return blockers;
}

export function cleanupRetiredRepositoryNamespaces(
  controllerHome: string,
  options: RetiredRepositoryNamespaceRetentionOptions = {},
): RetiredRepositoryNamespaceRetentionReport {
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = Math.max(60_000, Math.floor(options.graceMs ?? DEFAULT_RETIRED_REPOSITORY_GRACE_MS));
  let scanRemaining = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_SCAN_BUDGET));
  let removalRemaining = Math.max(0, Math.floor(options.maxRemovals ?? DEFAULT_REMOVAL_BUDGET));
  const report: RetiredRepositoryNamespaceRetentionReport = {
    policyVersion: 'repository-namespace-retention-v1',
    inspected: 0,
    eligible: 0,
    attempted: 0,
    removedPaths: [],
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
    retained: 0,
    skippedByReason: {},
    errors: [],
    budgetExhausted: false,
  };

  const removed = listRepositories(controllerHome, { includeRemoved: true })
    .filter((repository) => Boolean(repository.removedAt))
    .sort((left, right) => String(left.removedAt).localeCompare(String(right.removedAt)) || left.repoId.localeCompare(right.repoId));

  for (const repository of removed) {
    if (scanRemaining <= 0) {
      report.budgetExhausted = true;
      increment(report.skippedByReason, 'scan_budget_exhausted');
      break;
    }
    scanRemaining -= 1;
    report.inspected += 1;
    const removedAtMs = Date.parse(String(repository.removedAt));
    if (!Number.isFinite(removedAtMs) || nowMs - removedAtMs < graceMs) {
      report.retained += 1;
      increment(report.skippedByReason, 'retention_grace');
      continue;
    }

    let blockers: string[];
    try {
      blockers = activeAuthorityBlockers(controllerHome, repository.repoId);
    } catch (error) {
      report.retained += 1;
      increment(report.skippedByReason, 'authority_state_unavailable');
      report.errors.push(`${repository.repoId}:authority_state_unavailable:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (blockers.length > 0) {
      report.retained += 1;
      for (const blocker of blockers) increment(report.skippedByReason, blocker);
      continue;
    }

    const root = repositoryControllerRoot(controllerHome, repository.repoId);
    for (const child of RETIRED_REPOSITORY_DISPOSABLE_CHILDREN) {
      if (scanRemaining <= 0) {
        report.budgetExhausted = true;
        increment(report.skippedByReason, 'scan_budget_exhausted');
        break;
      }
      scanRemaining -= 1;
      report.inspected += 1;
      const path = join(root, child);
      if (!existsSync(path)) continue;
      let stat;
      try { stat = lstatSync(path); } catch (error) {
        report.retained += 1;
        increment(report.skippedByReason, 'ownership_unproven');
        report.errors.push(`${repository.repoId}:${child}:${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        report.retained += 1;
        increment(report.skippedByReason, 'ownership_unproven');
        continue;
      }
      report.eligible += 1;
      if (removalRemaining <= 0) {
        report.retained += 1;
        report.budgetExhausted = true;
        increment(report.skippedByReason, 'cleanup_budget_exhausted');
        continue;
      }
      report.attempted += 1;
      const measurement = measureReclaimablePath(path);
      try {
        rmSync(path, { recursive: true, force: true });
        removalRemaining -= 1;
        report.removedPaths.push(relative(controllerHome, path).replace(/\\/g, '/'));
        if (measurement.complete) report.reclaimedBytes += measurement.bytes;
        else report.unknownReclaimedByteCount += 1;
      } catch (error) {
        report.retained += 1;
        report.errors.push(`${repository.repoId}:${child}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return report;
}
