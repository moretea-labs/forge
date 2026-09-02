import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, relative, resolve } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { getRepository } from '../../cli/repositories/registry';
import {
  listWorkHandles,
  workDeliveryBaseRevision,
  writeWorkHandle,
  type WorkCleanupReceipt,
  type WorkHandleState,
} from './execution/work-handle-store';

const DEFAULT_CLEANUP_ARTIFACT_RETENTION_GRACE_MS = 6 * 60 * 60_000;
const DEFAULT_CLEANUP_ARTIFACT_SCAN_BUDGET = 512;

export interface WorkPreservationContainmentProof {
  contained: boolean;
  reason:
    | 'no_source_delta'
    | 'target_and_remote_content_contained'
    | 'base_revision_unavailable'
    | 'protected_revision_unavailable'
    | 'diff_unavailable'
    | 'target_revision_unavailable'
    | 'remote_revision_unavailable'
    | 'content_mismatch';
  protectedRevision?: string;
  targetRevision?: string;
  remoteRevision?: string;
  comparedPaths: string[];
}

export interface CleanupArtifactRetentionOptions {
  nowMs?: number;
  graceMs?: number;
  maxEntries?: number;
  maxRemovals?: number;
}

export interface CleanupArtifactRetentionReport {
  inspected: number;
  eligible: number;
  attempted: number;
  removedPaths: string[];
  retained: number;
  skipped: number;
  budgetExhausted: boolean;
  skippedByReason: Record<string, number>;
  errors: string[];
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(root: string, args: string[]): GitResult {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout.trim() : '',
    stderr: typeof result.stderr === 'string' ? result.stderr.trim() : (result.error?.message ?? ''),
  };
}

function revision(root: string, ref: string): string | undefined {
  const result = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return result.ok && result.stdout ? result.stdout : undefined;
}

function changedPaths(root: string, baseRevision: string, protectedRevision: string): string[] | undefined {
  const result = spawnSync('git', ['-C', root, 'diff', '--name-only', '-z', baseRevision, protectedRevision], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') return undefined;
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function treeEntry(root: string, ref: string, path: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'ls-tree', '-z', ref, '--', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 512 * 1024,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') return undefined;
  if (!result.stdout) return 'missing';
  const entry = result.stdout.split('\0', 1)[0] ?? '';
  const tab = entry.indexOf('\t');
  return tab >= 0 ? entry.slice(0, tab) : undefined;
}

export function proveWorkPreservationContained(
  repositoryRoot: string,
  handle: Pick<WorkHandleState, 'baseCommit' | 'deliveryBaseCommit' | 'expectedHead' | 'cleanupReceipt'>,
  targetBranch: string,
): WorkPreservationContainmentProof {
  const base = workDeliveryBaseRevision(handle);
  if (!base || !revision(repositoryRoot, base)) {
    return { contained: false, reason: 'base_revision_unavailable', comparedPaths: [] };
  }
  const protectedCandidate = handle.cleanupReceipt?.preservation.checkpointCommit?.trim() || handle.expectedHead?.trim();
  if (!protectedCandidate) {
    return { contained: false, reason: 'protected_revision_unavailable', comparedPaths: [] };
  }
  const protectedRevision = revision(repositoryRoot, protectedCandidate);
  if (!protectedRevision) {
    return { contained: false, reason: 'protected_revision_unavailable', comparedPaths: [] };
  }
  const paths = changedPaths(repositoryRoot, base, protectedRevision);
  if (!paths) {
    return { contained: false, reason: 'diff_unavailable', protectedRevision, comparedPaths: [] };
  }
  if (paths.length === 0) {
    return { contained: true, reason: 'no_source_delta', protectedRevision, comparedPaths: [] };
  }

  const targetRevision = revision(repositoryRoot, `refs/heads/${targetBranch}`);
  if (!targetRevision) {
    return { contained: false, reason: 'target_revision_unavailable', protectedRevision, comparedPaths: paths };
  }
  const remoteRevision = revision(repositoryRoot, `refs/remotes/origin/${targetBranch}`);
  if (!remoteRevision) {
    return {
      contained: false,
      reason: 'remote_revision_unavailable',
      protectedRevision,
      targetRevision,
      comparedPaths: paths,
    };
  }

  for (const path of paths) {
    const protectedEntry = treeEntry(repositoryRoot, protectedRevision, path);
    const targetEntry = treeEntry(repositoryRoot, targetRevision, path);
    const remoteEntry = treeEntry(repositoryRoot, remoteRevision, path);
    if (protectedEntry === undefined || targetEntry === undefined || remoteEntry === undefined
      || protectedEntry !== targetEntry || protectedEntry !== remoteEntry) {
      return {
        contained: false,
        reason: 'content_mismatch',
        protectedRevision,
        targetRevision,
        remoteRevision,
        comparedPaths: paths,
      };
    }
  }
  return {
    contained: true,
    reason: 'target_and_remote_content_contained',
    protectedRevision,
    targetRevision,
    remoteRevision,
    comparedPaths: paths,
  };
}

function skip(report: CleanupArtifactRetentionReport, reason: string): void {
  report.skipped += 1;
  report.skippedByReason[reason] = (report.skippedByReason[reason] ?? 0) + 1;
}

function expectedBundlePath(controllerHome: string, handle: WorkHandleState): string {
  return join(repositoryControllerRoot(controllerHome, handle.repositoryId), 'cleanup-artifacts', handle.workId, 'branch.bundle');
}

function retentionTimestamp(receipt: WorkCleanupReceipt, bundlePath: string): number | undefined {
  if (receipt.completedAt) {
    const parsed = Date.parse(receipt.completedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  try {
    return statSync(bundlePath).mtimeMs;
  } catch {
    return undefined;
  }
}

function retirementFromProof(
  proof: WorkPreservationContainmentProof,
  status: 'eligible' | 'removed' | 'not_needed',
  at: string,
): NonNullable<WorkCleanupReceipt['preservation']['bundleRetirement']> {
  return {
    status,
    reason: proof.reason === 'no_source_delta' ? 'no_source_delta' : 'target_and_remote_content_contained',
    protectedRevision: proof.protectedRevision!,
    targetRevision: proof.targetRevision,
    remoteRevision: proof.remoteRevision,
    comparedPaths: proof.comparedPaths,
    provedAt: at,
    ...(status === 'removed' ? { removedAt: at } : {}),
  };
}

export function cleanupWorkPreservationArtifacts(
  controllerHome: string,
  options: CleanupArtifactRetentionOptions = {},
): CleanupArtifactRetentionReport {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_CLEANUP_ARTIFACT_RETENTION_GRACE_MS);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CLEANUP_ARTIFACT_SCAN_BUDGET);
  let remaining = Math.max(0, options.maxRemovals ?? 50);
  const report: CleanupArtifactRetentionReport = {
    inspected: 0,
    eligible: 0,
    attempted: 0,
    removedPaths: [],
    retained: 0,
    skipped: 0,
    budgetExhausted: false,
    skippedByReason: {},
    errors: [],
  };
  const repositoriesRoot = join(controllerHome, 'repositories');
  let repositoryIds: string[] = [];
  try {
    repositoryIds = readdirSync(repositoriesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return report;
  }

  outer: for (const repositoryId of repositoryIds) {
    let repository;
    try {
      repository = getRepository(repositoryId, controllerHome, { includeRemoved: true });
    } catch {
      continue;
    }
    for (let handle of listWorkHandles(controllerHome, repositoryId)) {
      if (report.inspected >= maxEntries) {
        report.budgetExhausted = true;
        break outer;
      }
      report.inspected += 1;
      const receipt = handle.cleanupReceipt;
      const bundlePath = receipt?.preservation.bundlePath;
      const retirement = receipt?.preservation.bundleRetirement;
      if (!receipt?.complete || !bundlePath) {
        if (retirement?.status === 'eligible' && receipt?.preservation.bundlePath && !existsSync(receipt.preservation.bundlePath)) {
          // fall through below on a persisted two-phase retirement whose file disappeared
        } else {
          skip(report, 'no_complete_bundle');
          continue;
        }
      }
      if (!receipt || !bundlePath) continue;
      const expectedPath = resolve(expectedBundlePath(controllerHome, handle));
      if (resolve(bundlePath) !== expectedPath) {
        report.retained += 1;
        skip(report, 'bundle_path_outside_authority');
        continue;
      }
      const timestamp = retentionTimestamp(receipt, bundlePath);
      if (timestamp === undefined || nowMs - timestamp < graceMs) {
        report.retained += 1;
        skip(report, 'retention_grace');
        continue;
      }
      const proof = proveWorkPreservationContained(repository.canonicalRoot, handle, receipt.targetBranch);
      if (!proof.contained) {
        report.retained += 1;
        skip(report, `containment_${proof.reason}`);
        continue;
      }
      report.eligible += 1;
      if (remaining <= 0) {
        report.budgetExhausted = true;
        skip(report, 'cleanup_budget_exhausted');
        continue;
      }
      report.attempted += 1;
      remaining -= 1;
      try {
        const eligibleReceipt: WorkCleanupReceipt = {
          ...receipt,
          preservation: {
            ...receipt.preservation,
            bundleRetirement: retirementFromProof(proof, 'eligible', nowIso),
          },
          updatedAt: nowIso,
        };
        handle = writeWorkHandle(controllerHome, { ...handle, cleanupReceipt: eligibleReceipt, updatedAt: nowIso });
        if (existsSync(bundlePath)) rmSync(bundlePath, { force: true });
        const currentReceipt = handle.cleanupReceipt!;
        const removedReceipt: WorkCleanupReceipt = {
          ...currentReceipt,
          preservation: {
            ...currentReceipt.preservation,
            bundlePath: undefined,
            bundleSha256: undefined,
            bundleRetirement: retirementFromProof(proof, 'removed', nowIso),
            recoveryInstructions: `Preservation bundle retired after ${proof.reason}; exact proof is stored in cleanupReceipt.preservation.bundleRetirement.`,
          },
          updatedAt: nowIso,
        };
        writeWorkHandle(controllerHome, { ...handle, cleanupReceipt: removedReceipt, updatedAt: nowIso });
        report.removedPaths.push(relative(controllerHome, bundlePath).replace(/\\/g, '/'));
      } catch (error) {
        report.errors.push(`${handle.workId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return report;
}
