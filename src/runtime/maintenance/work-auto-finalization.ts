/**
 * Automatic Work finalization and cleanup orchestration.
 *
 * Addresses the core issue: Git delivery completes but Work remains semantically
 * open, preventing cleanup. This module bridges the gap by:
 *
 * 1. Detecting delivered-but-not-completed Work
 * 2. Automatically closing semantic state when safe
 * 3. Triggering terminal cleanup
 * 4. Handling abandoned dirty worktrees
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import {
  getWorkContract,
  reviseWorkSemanticContext,
  semanticWorkState,
  isRepositoryCompletionReceipt,
  type WorkContractStoreOptions,
} from '../../../packages/kernel/work/api/index';
import { listWorkHandles, readWorkHandle } from '../control-plane/execution/work-handle-store';
import { reconcileSingleTerminalWorkCleanup } from '../control-plane/execution/work-terminal-cleanup';
import { listRepositories } from '../../cli/repositories/registry';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(root: string, args: string[], timeout = 30_000): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

export interface WorkFinalizationCandidate {
  workId: string;
  repositoryId: string;
  reason: 'delivered_but_open' | 'clean_terminal' | 'abandoned_dirty';
  worktreePath?: string;
  branch?: string;
  isDirty: boolean;
  deliveredAt?: string;
  ageMs?: number;
}

export interface WorkAutoFinalizationReport {
  scanned: number;
  candidates: WorkFinalizationCandidate[];
  autoCompleted: Array<{ workId: string; action: 'semantic_close' }>;
  cleanedUp: Array<{ workId: string; status: string }>;
  retained: Array<{ workId: string; reason: string }>;
  errors: Array<{ workId: string; error: string }>;
}

interface ScanOptions {
  nowMs?: number;
  minAgeMs?: number;
  maxWork?: number;
  autoComplete?: boolean;
  autoCleanup?: boolean;
}

/**
 * Detect Work that has been delivered to target branch but remains semantically open.
 */
function isDeliveredButOpen(
  store: WorkContractStoreOptions,
  workId: string,
  worktreePath: string | undefined,
  targetBranch: string,
  repoRoot: string,
): boolean {
  const contract = getWorkContract(store, workId);
  if (!contract || semanticWorkState(contract) !== 'open') return false;

  const receipt = contract.completionReceipt;
  if (!receipt || !isRepositoryCompletionReceipt(receipt)) return false;

  // Has a delivery receipt with integrated status
  if (receipt.delivery.status !== 'integrated' || !receipt.sourceRevision) return false;

  // Verify the source revision is still reachable from target
  const targetHead = git(repoRoot, ['rev-parse', `refs/heads/${targetBranch}`]);
  if (!targetHead.ok) return false;

  const isAncestor = git(repoRoot, ['merge-base', '--is-ancestor', receipt.sourceRevision, targetHead.stdout]);
  return isAncestor.ok;
}

/**
 * Check if a worktree is dirty (has uncommitted changes or untracked files).
 */
function isWorktreeDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const status = git(worktreePath, ['status', '--porcelain', '--untracked-files=all']);
  return status.ok && Boolean(status.stdout);
}

/**
 * Scan for Work that needs finalization or cleanup.
 */
export async function scanWorkFinalizationCandidates(
  controllerHome: string,
  options: ScanOptions = {},
): Promise<WorkAutoFinalizationReport> {
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 5 * 60 * 1000; // 5 minutes default
  const maxWork = Math.max(1, Math.min(50, options.maxWork ?? 20));

  const report: WorkAutoFinalizationReport = {
    scanned: 0,
    candidates: [],
    autoCompleted: [],
    cleanedUp: [],
    retained: [],
    errors: [],
  };

  const repositories = listRepositories(controllerHome)
    .filter((repo) => repo.enabled && !repo.removedAt);

  for (const repository of repositories) {
    const handles = listWorkHandles(controllerHome, repository.repoId, 5_000)
      .filter((handle) => handle.managedWorktree);

    for (const handle of handles) {
      if (report.scanned >= maxWork) break;
      report.scanned++;

      const store = { controllerHome, repoId: repository.repoId };
      const workId = handle.workContractId ?? handle.workId;

      try {
        const contract = getWorkContract(store, workId);
        if (!contract) continue;

        const semanticState = semanticWorkState(contract);
        const updatedAt = Date.parse(handle.updatedAt) || 0;
        const ageMs = nowMs - updatedAt;

        // Skip recent work (let it settle)
        if (ageMs < minAgeMs) continue;

        const isDirty = handle.worktreePath && existsSync(handle.worktreePath)
          ? isWorktreeDirty(handle.worktreePath)
          : false;

        // Case 1: Delivered but still semantically open
        if (semanticState === 'open' && handle.state === 'merged') {
          const targetBranch = handle.deliveryTargetBranch || repository.defaultBranch || 'main';
          if (isDeliveredButOpen(store, workId, handle.worktreePath, targetBranch, repository.canonicalRoot)) {
            report.candidates.push({
              workId,
              repositoryId: repository.repoId,
              reason: 'delivered_but_open',
              worktreePath: handle.worktreePath,
              branch: handle.branch,
              isDirty,
              ageMs,
            });

            // Auto-complete if enabled and clean
            if (options.autoComplete && !isDirty) {
              try {
                reviseWorkSemanticContext(store, workId, {
                  expectedRevision: contract.semanticRevision ?? 1,
                  state: 'completed',
                });
                report.autoCompleted.push({ workId, action: 'semantic_close' });
              } catch (error) {
                report.errors.push({
                  workId,
                  error: `Auto-complete failed: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
            }
          }
        }

        // Case 2: Terminal and clean - ready for cleanup
        if ((semanticState === 'completed' || semanticState === 'cancelled') && !isDirty) {
          if (handle.state !== 'cleaned') {
            report.candidates.push({
              workId,
              repositoryId: repository.repoId,
              reason: 'clean_terminal',
              worktreePath: handle.worktreePath,
              branch: handle.branch,
              isDirty: false,
              ageMs,
            });

            // Auto-cleanup if enabled
            if (options.autoCleanup) {
              try {
                const result = await reconcileSingleTerminalWorkCleanup(
                  controllerHome,
                  repository.repoId,
                  workId,
                  { deleteBranch: true },
                );
                report.cleanedUp.push({ workId, status: result.status });
              } catch (error) {
                report.errors.push({
                  workId,
                  error: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
            }
          }
        }

        // Case 3: Abandoned dirty worktree (very old)
        if (isDirty && ageMs > 7 * 24 * 60 * 60 * 1000) { // 7 days
          report.candidates.push({
            workId,
            repositoryId: repository.repoId,
            reason: 'abandoned_dirty',
            worktreePath: handle.worktreePath,
            branch: handle.branch,
            isDirty: true,
            ageMs,
          });
          report.retained.push({
            workId,
            reason: 'Dirty worktree older than 7 days - manual review needed',
          });
        }
      } catch (error) {
        report.errors.push({
          workId: handle.workId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return report;
}

/**
 * Execute automatic finalization and cleanup cycle.
 */
export async function executeAutoFinalization(
  controllerHome: string,
  options: {
    minAgeMinutes?: number;
    maxWork?: number;
    dryRun?: boolean;
  } = {},
): Promise<WorkAutoFinalizationReport> {
  const minAgeMs = (options.minAgeMinutes ?? 5) * 60 * 1000;
  const dryRun = options.dryRun ?? false;

  return scanWorkFinalizationCandidates(controllerHome, {
    minAgeMs,
    maxWork: options.maxWork ?? 20,
    autoComplete: !dryRun,
    autoCleanup: !dryRun,
  });
}
