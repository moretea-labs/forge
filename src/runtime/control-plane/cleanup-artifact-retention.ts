import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, relative, resolve } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { measureReclaimablePath } from './lifecycle-retention-metrics';
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
  scanSequence?: number;
  repositoryIds?: readonly string[];
}

export interface CleanupArtifactRetentionReport {
  inspected: number;
  eligible: number;
  attempted: number;
  removedPaths: string[];
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
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

function bundleProtectedRevision(repositoryRoot: string, bundlePath: string): string | undefined {
  if (!git(repositoryRoot, ['bundle', 'verify', bundlePath]).ok) return undefined;
  const heads = git(repositoryRoot, ['bundle', 'list-heads', bundlePath]);
  if (!heads.ok) return undefined;
  const revisions = [...new Set(heads.stdout.split('\n').map((line) => line.trim().split(/\s+/, 1)[0]).filter((value) => /^[a-f0-9]{40,64}$/i.test(value ?? '')))];
  return revisions.length === 1 ? revisions[0] : undefined;
}

function proveOrphanBundleContained(
  repositoryRoot: string,
  bundlePath: string,
  targetBranch: string,
): { contained: boolean; reason: string } {
  const protectedRevision = bundleProtectedRevision(repositoryRoot, bundlePath);
  if (!protectedRevision) return { contained: false, reason: 'orphan_bundle_invalid_or_ambiguous' };
  if (!revision(repositoryRoot, protectedRevision)) {
    return { contained: false, reason: 'orphan_protected_revision_unavailable' };
  }
  const targetRevision = revision(repositoryRoot, `refs/heads/${targetBranch}`);
  if (!targetRevision) return { contained: false, reason: 'orphan_target_revision_unavailable' };
  const remoteRevision = revision(repositoryRoot, `refs/remotes/origin/${targetBranch}`);
  if (!remoteRevision) return { contained: false, reason: 'orphan_remote_revision_unavailable' };
  // Anchor the inferred delta against the durable remote target. Using the
  // local target here could collapse the delta to empty when only the local
  // branch contains the preserved tip, falsely treating an undelivered bundle
  // as redundant.
  const base = git(repositoryRoot, ['merge-base', protectedRevision, remoteRevision]);
  if (!base.ok || !base.stdout) return { contained: false, reason: 'orphan_merge_base_unavailable' };
  const paths = changedPaths(repositoryRoot, base.stdout, protectedRevision);
  if (!paths) return { contained: false, reason: 'orphan_diff_unavailable' };
  for (const path of paths) {
    const protectedEntry = treeEntry(repositoryRoot, protectedRevision, path);
    const targetEntry = treeEntry(repositoryRoot, targetRevision, path);
    const remoteEntry = treeEntry(repositoryRoot, remoteRevision, path);
    if (protectedEntry === undefined || targetEntry === undefined || remoteEntry === undefined
      || protectedEntry !== targetEntry || protectedEntry !== remoteEntry) {
      return { contained: false, reason: 'orphan_content_mismatch' };
    }
  }
  return { contained: true, reason: paths.length === 0 ? 'orphan_no_source_delta' : 'orphan_target_and_remote_content_contained' };
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
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
    retained: 0,
    skipped: 0,
    budgetExhausted: false,
    skippedByReason: {},
    errors: [],
  };
  const repositoriesRoot = join(controllerHome, 'repositories');
  let repositoryIds: string[] = [];
  try {
    const repositoryFilter = options.repositoryIds ? new Set(options.repositoryIds.map((id) => id.trim()).filter(Boolean)) : undefined;
    repositoryIds = readdirSync(repositoriesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (!repositoryFilter || repositoryFilter.has(entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return report;
  }
  const scanSequence = Math.trunc(options.scanSequence ?? Math.floor(nowMs / 60_000));
  if (repositoryIds.length > 1) {
    const offset = ((scanSequence % repositoryIds.length) + repositoryIds.length) % repositoryIds.length;
    repositoryIds.push(...repositoryIds.splice(0, offset));
  }
  let handleInspected = 0;
  let physicalInspected = 0;

  for (const repositoryId of repositoryIds) {
    let repository;
    try {
      repository = getRepository(repositoryId, controllerHome, { includeRemoved: true });
    } catch {
      continue;
    }
    const repositoryHandles = listWorkHandles(controllerHome, repositoryId)
      .sort((left, right) => left.workId.localeCompare(right.workId));
    if (repositoryHandles.length > 1) {
      const offset = ((scanSequence % repositoryHandles.length) + repositoryHandles.length) % repositoryHandles.length;
      repositoryHandles.push(...repositoryHandles.splice(0, offset));
    }
    for (let handle of repositoryHandles) {
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
      if (handleInspected >= maxEntries) {
        report.budgetExhausted = true;
        break;
      }
      handleInspected += 1;
      report.inspected += 1;
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
        const measurement = existsSync(bundlePath) ? measureReclaimablePath(bundlePath) : { bytes: 0, entries: 0, complete: true };
        if (existsSync(bundlePath)) rmSync(bundlePath, { force: true });
        try { rmdirSync(join(bundlePath, '..')); } catch { /* Preserve non-empty or concurrently changed directories. */ }
        if (measurement.complete) report.reclaimedBytes += measurement.bytes;
        else report.unknownReclaimedByteCount += 1;
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

    // WorkHandle metadata is not physical-retention authority. Discover direct
    // preservation directories as well so a missing or drifted handle cannot
    // make an owned bundle immortal. This pass remains fail-closed: only the
    // canonical direct child containing exactly branch.bundle is considered;
    // symlinks and extra content are retained, and source containment still
    // requires proof.
    const artifactRoot = join(repositoryControllerRoot(controllerHome, repositoryId), 'cleanup-artifacts');
    let artifactEntries;
    try {
      if (!lstatSync(artifactRoot).isDirectory()) continue;
      artifactEntries = readdirSync(artifactRoot, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      if (artifactEntries.length > 1) {
        const offset = ((scanSequence % artifactEntries.length) + artifactEntries.length) % artifactEntries.length;
        artifactEntries.push(...artifactEntries.splice(0, offset));
      }
    } catch {
      continue;
    }
    const physicalHandles = repositoryHandles;
    const handles = new Map(physicalHandles.map((handle) => [handle.workId, handle]));
    const referencedBundlePaths = new Set(physicalHandles.flatMap((handle) => {
      const path = handle.cleanupReceipt?.preservation.bundlePath;
      return path ? [resolve(path)] : [];
    }));
    for (const entry of artifactEntries) {
      if (!entry.isDirectory()) continue;
      const directoryPath = join(artifactRoot, entry.name);
      const handle = handles.get(entry.name);
      const canonicalBundlePath = resolve(join(directoryPath, 'branch.bundle'));
      if (referencedBundlePaths.has(canonicalBundlePath)) continue;
      if (physicalInspected >= maxEntries) {
        report.budgetExhausted = true;
        break;
      }
      physicalInspected += 1;
      report.inspected += 1;
      let contents: string[];
      let bundlePath: string;
      try {
        contents = readdirSync(directoryPath).sort();
        if (contents.length !== 1 || contents[0] !== 'branch.bundle') {
          report.retained += 1;
          skip(report, 'physical_bundle_unrecognized_content');
          continue;
        }
        bundlePath = join(directoryPath, 'branch.bundle');
        const bundleStat = lstatSync(bundlePath);
        if (!bundleStat.isFile() || bundleStat.isSymbolicLink()) {
          report.retained += 1;
          skip(report, 'physical_bundle_unrecognized_content');
          continue;
        }
      } catch (error) {
        report.retained += 1;
        skip(report, 'physical_bundle_unreadable');
        report.errors.push(`${repositoryId}:${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (handle?.cleanupReceipt?.preservation.bundlePath
        && resolve(handle.cleanupReceipt.preservation.bundlePath) !== resolve(bundlePath)) {
        report.retained += 1;
        skip(report, 'bundle_metadata_conflict');
        continue;
      }
      let timestamp: number | undefined;
      try {
        timestamp = handle?.cleanupReceipt
          ? retentionTimestamp(handle.cleanupReceipt, bundlePath)
          : statSync(bundlePath).mtimeMs;
      } catch (error) {
        report.retained += 1;
        skip(report, 'physical_bundle_unreadable');
        report.errors.push(`${repositoryId}:${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (timestamp === undefined || nowMs - timestamp < graceMs) {
        report.retained += 1;
        skip(report, 'retention_grace');
        continue;
      }

      const receipt = handle?.cleanupReceipt;
      const handleProof = handle && receipt?.complete
        ? proveWorkPreservationContained(repository.canonicalRoot, handle, receipt.targetBranch)
        : undefined;
      const orphanProof = !handle && repository.defaultBranch
        ? proveOrphanBundleContained(repository.canonicalRoot, bundlePath, repository.defaultBranch)
        : undefined;
      if (handle && (!receipt?.complete || !handleProof?.contained)) {
        report.retained += 1;
        skip(report, !receipt?.complete ? 'physical_bundle_incomplete_handle' : `containment_${handleProof!.reason}`);
        continue;
      }
      if (!handle && !orphanProof?.contained) {
        report.retained += 1;
        skip(report, orphanProof?.reason ?? (repository.defaultBranch
          ? 'orphan_source_containment_unproven'
          : 'orphan_target_branch_unavailable'));
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
        const measurement = measureReclaimablePath(bundlePath);
        if (handle && receipt && handleProof) {
          const eligibleReceipt: WorkCleanupReceipt = {
            ...receipt,
            preservation: { ...receipt.preservation, bundlePath, bundleRetirement: retirementFromProof(handleProof, 'eligible', nowIso) },
            updatedAt: nowIso,
          };
          const updated = writeWorkHandle(controllerHome, { ...handle, cleanupReceipt: eligibleReceipt, updatedAt: nowIso });
          rmSync(bundlePath, { force: true });
          const removedReceipt: WorkCleanupReceipt = {
            ...updated.cleanupReceipt!,
            preservation: {
              ...updated.cleanupReceipt!.preservation,
              bundlePath: undefined,
              bundleSha256: undefined,
              bundleRetirement: retirementFromProof(handleProof, 'removed', nowIso),
              recoveryInstructions: `Preservation bundle retired after ${handleProof.reason}; exact proof is stored in cleanupReceipt.preservation.bundleRetirement.`,
            },
            updatedAt: nowIso,
          };
          writeWorkHandle(controllerHome, { ...updated, cleanupReceipt: removedReceipt, updatedAt: nowIso });
        } else {
          rmSync(bundlePath, { force: true });
        }
        try { rmdirSync(directoryPath); } catch { /* Preserve concurrently populated directories. */ }
        if (measurement.complete) report.reclaimedBytes += measurement.bytes;
        else report.unknownReclaimedByteCount += 1;
        report.removedPaths.push(relative(controllerHome, bundlePath).replace(/\\/g, '/'));
      } catch (error) {
        report.errors.push(`${repositoryId}:${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return report;
}
