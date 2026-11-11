import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { assertStorageHeadroom } from '../shared/storage-capacity';
import { runProcess } from '../../effects/process-runner';
import { cleanupEditSession, getEditSession, inspectIntegratedEditSession, listEditSessions } from '../../cli/editing/edit-session';
import { withRepositoryMutationExclusion } from '../resources/leases/store';
import { ensureRepositoryRuntimeStorage, type RepositoryRuntimeStorageReport } from '../../cli/repositories/runtime-storage';
import { getRepository, selectRepositoryCheckout, setRepositoryCheckoutLifecycle } from '../../cli/repositories/registry';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { rebuildRepositoryProjection } from '../projections/materialized-view';
import { assertOwnedResourceCleanupTarget, listOwnedResources, markOwnedResourceCleaned, type OwnedResource } from '../../../packages/kernel/identity/api/index';
import {
  collectRuntimeProcesses,
  removeRuntimeTempEntry,
  RUNTIME_TEMP_RETENTION_MINUTES,
  scanRuntimeTempEntries,
} from '../diagnostics/performance';
import {
  applyRuntimeStorageRepair,
  previewRuntimeStorageRepair,
  type RuntimeStorageRepairApplyResult,
  type RuntimeStorageRepairPreview,
} from './local-jobs-repair';
import { gcTerminalProcesses, type ProcessGcResult } from '../execution/process-runtime/gc';
import { cleanupGeneratedRepositoryCheckoutCaches, cleanupReleasableIosTestEvidence, inspectRepositoryIosTestEvidence, type IosTestEvidenceInventoryReport, type IosTestEvidenceRetentionReport, type RepositoryGeneratedCacheRetentionReport } from '../control-plane/generated-cache-retention';
import {
  cleanupRuntimeQuarantine,
  quarantineRuntimePath,
  runtimeLegacyCheckQuarantineRoot,
  type RuntimeQuarantineRetentionReport,
} from './quarantine-retention';
import { managedBranchOwnedResourceId, managedBranchOwnedResourceLocator, managedWorkspaceOwnedResourceId } from '../execution/managed-workspace';

export type RuntimeMaintenanceActionId =
  | 'local_jobs_reconcile'
  | 'quarantine_unreadable_local_jobs'
  | 'runtime_storage_finalize_relocation'
  | 'rebuild_projection'
  | 'full_maintenance_pass';

export type RuntimeMaintenanceCandidateKind =
  | 'stale_active_local_job'
  | 'pending_approval_local_job'
  | 'unreadable_local_job'
  | 'missing_job_metadata'
  | 'runtime_storage_warning'
  | 'stale_runtime_temp_entry'
  | 'stale_edit_session'
  | 'unowned_managed_worktree';

export interface RuntimeMaintenanceRepository {
  repoId: string;
  canonicalRoot: string;
  defaultBranch?: string;
  /** Test-only or embedded-runtime override. Production defaults to system temp roots. */
  runtimeTempRoots?: string[];
}

export interface RuntimeMaintenanceOptions {
  minAgeMinutes?: number;
  maxCandidates?: number;
  cancelPendingApprovals?: boolean;
}

export interface RuntimeMaintenanceApplyOptions extends RuntimeMaintenanceOptions {
  actionId: RuntimeMaintenanceActionId;
  confirmMaintenance?: boolean;
}

export interface AutomaticRuntimeMaintenancePreview {
  actionId?: RuntimeMaintenanceActionId;
  allowed: boolean;
  noOp: boolean;
  blockedReason?: string;
  blockedPermanently: boolean;
  selectedCandidateIds: string[];
  selectedTypedCandidateIds: string[];
  status: RuntimeMaintenanceStatus;
}

export interface RuntimeMaintenanceCandidate {
  kind: RuntimeMaintenanceCandidateKind;
  id: string;
  path?: string;
  status?: string;
  safe: boolean;
  reason: string;
  ageMinutes?: number;
  workerPid?: number;
  deadlineAt?: string;
  suggestedAction: RuntimeMaintenanceActionId;
  ownershipStatus?: 'explicit' | 'unknown';
  sourceControllerHome?: string;
  objective?: string;
  continuationPrompt?: string;
  disposition?: 'resume_or_supersede_review' | 'completion_reconciliation' | 'ownership_reconciliation' | 'source_preservation_required' | 'semantic_completion_required';
  sourceState?: 'no_managed_source' | 'clean_integrated' | 'dirty_worktree' | 'unintegrated_commits' | 'source_state_unknown';
}

export interface RuntimeMaintenanceSummary {
  totalCandidates: number;
  safeCandidates: number;
  unsafeCandidates: number;
  staleActiveLocalJobs: number;
  pendingApprovalLocalJobs: number;
  unreadableLocalJobs: number;
  missingJobMetadata: number;
  runtimeStorageWarnings: number;
  staleRuntimeTempEntries: number;
  staleEditSessions: number;
  unownedManagedWorktrees: number;
}

export interface RuntimeMaintenanceStatus {
  schemaVersion: 1;
  generatedAt: string;
  repoId: string;
  mode: 'status';
  readyForExecution: boolean;
  runtimeStorage?: RepositoryRuntimeStorageReport;
  runtimeStorageError?: string;
  candidates: RuntimeMaintenanceCandidate[];
  summary: RuntimeMaintenanceSummary;
  runtimeStorageRepair: RuntimeStorageRepairPreview;
  recommendedActions: RuntimeMaintenanceActionId[];
  continuation: {
    retryOriginalOperation: boolean;
    afterSuccess: string[];
  };
  warnings: string[];
}

export interface RuntimeMaintenanceApplyResult extends Omit<RuntimeMaintenanceStatus, 'mode'> {
  mode: 'apply';
  actionId: RuntimeMaintenanceActionId;
  applied: Array<RuntimeMaintenanceCandidate & { applied: boolean; result?: string; error?: string }>;
  runtimeStorageRepairApply?: RuntimeStorageRepairApplyResult;
  /** Existing bounded terminal-process retention, run only during explicit full maintenance. */
  processGc?: ProcessGcResult;
  quarantineGc?: RuntimeQuarantineRetentionReport;
  generatedCacheGc?: RepositoryGeneratedCacheRetentionReport;
  iosTestEvidenceGc?: IosTestEvidenceRetentionReport;
  iosTestEvidenceInventory?: IosTestEvidenceInventoryReport;
  projection?: unknown;
}

interface LocalJobState {
  schemaVersion?: number;
  jobId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  heartbeatAt?: string;
  workerPid?: number;
  ownerPid?: number;
  error?: string;
  outcome?: unknown;
}

const VALID_MAINTENANCE_ACTIONS = new Set<RuntimeMaintenanceActionId>(['local_jobs_reconcile', 'quarantine_unreadable_local_jobs', 'runtime_storage_finalize_relocation', 'rebuild_projection', 'full_maintenance_pass']);
// Automatic maintenance is intentionally limited to the narrowly-scoped local
// job reconciliation action. Broader passes remain explicit/manual operations.
export const AUTOMATIC_RUNTIME_MAINTENANCE_ACTION_ALLOWLIST = new Set<RuntimeMaintenanceActionId>(['local_jobs_reconcile']);
const ACTIVE_LOCAL_JOB_STATUSES = new Set(['pending_approval', 'approved', 'dispatched', 'running']);
const TERMINAL_LOCAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'orphaned', 'stale', 'rejected']);
const DEFAULT_MIN_AGE_MINUTES = 10;
const MAX_CANDIDATES = 200;

function now(): string { return new Date().toISOString(); }

function clampNumber(value: number | undefined, fallback: number, min = 0, max = 24 * 60): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function localJobsRoot(repoRoot: string): string {
  return join(repoRoot, '.ai', 'harness', 'local-jobs');
}

function activeIndexPath(repoRoot: string): string {
  return join(localJobsRoot(repoRoot), 'active-index.json');
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  assertStorageHeadroom(path, {
    operation: 'runtime_maintenance_state_write',
    requiredBytes: Buffer.byteLength(content),
    reserveBytes: 16 * 1024 * 1024,
  });
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ageMinutesFrom(value: string | undefined, fallbackPath?: string): number | undefined {
  const parsed = parseTime(value);
  const timestamp = parsed ?? (fallbackPath && existsSync(fallbackPath) ? lstatSync(fallbackPath).mtimeMs : undefined);
  return timestamp === undefined ? undefined : Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.includes('../');
}

function summarize(candidates: RuntimeMaintenanceCandidate[]): RuntimeMaintenanceSummary {
  return {
    totalCandidates: candidates.length,
    safeCandidates: candidates.filter((candidate) => candidate.safe).length,
    unsafeCandidates: candidates.filter((candidate) => !candidate.safe).length,
    staleActiveLocalJobs: candidates.filter((candidate) => candidate.kind === 'stale_active_local_job').length,
    pendingApprovalLocalJobs: candidates.filter((candidate) => candidate.kind === 'pending_approval_local_job').length,
    unreadableLocalJobs: candidates.filter((candidate) => candidate.kind === 'unreadable_local_job').length,
    missingJobMetadata: candidates.filter((candidate) => candidate.kind === 'missing_job_metadata').length,
    runtimeStorageWarnings: candidates.filter((candidate) => candidate.kind === 'runtime_storage_warning').length,
    staleRuntimeTempEntries: candidates.filter((candidate) => candidate.kind === 'stale_runtime_temp_entry').length,
    staleEditSessions: candidates.filter((candidate) => candidate.kind === 'stale_edit_session').length,
    unownedManagedWorktrees: candidates.filter((candidate) => candidate.kind === 'unowned_managed_worktree').length,
  };
}

function uniqueActions(candidates: RuntimeMaintenanceCandidate[], storageReady: boolean): RuntimeMaintenanceActionId[] {
  const actions = candidates
    .filter((candidate) => candidate.safe || candidate.kind === 'pending_approval_local_job' || candidate.kind === 'runtime_storage_warning')
    .map((candidate) => candidate.suggestedAction);
  if (!storageReady) actions.push('runtime_storage_finalize_relocation');
  actions.push('full_maintenance_pass');
  return Array.from(new Set(actions));
}

function typedRepairActions(preview: RuntimeStorageRepairPreview): RuntimeMaintenanceActionId[] {
  const actions: RuntimeMaintenanceActionId[] = [];
  if (preview.candidates.some((candidate) => candidate.safe && candidate.action === 'terminalize')) actions.push('local_jobs_reconcile');
  if (preview.candidates.some((candidate) => candidate.safe && candidate.action === 'quarantine')) actions.push('quarantine_unreadable_local_jobs');
  if (preview.safeCandidateCount > 0) actions.push('full_maintenance_pass');
  return actions;
}

function selectedTypedRepairCandidateIds(actionId: RuntimeMaintenanceActionId, preview: RuntimeStorageRepairPreview): string[] {
  return preview.candidates
    .filter((candidate) => {
      if (!candidate.safe) return false;
      if (actionId === 'full_maintenance_pass') return true;
      if (actionId === 'local_jobs_reconcile') return candidate.action === 'terminalize';
      if (actionId === 'quarantine_unreadable_local_jobs') return candidate.action === 'quarantine';
      return false;
    })
    .map((candidate) => candidate.candidateId);
}

function runtimeStorageCandidates(report: RepositoryRuntimeStorageReport | undefined): RuntimeMaintenanceCandidate[] {
  if (!report) return [];
  return report.warnings.map((warning, index) => {
    const lower = warning.toLowerCase();
    let suggestedAction: RuntimeMaintenanceActionId = 'runtime_storage_finalize_relocation';
    if (lower.includes('local-jobs') || lower.includes('local jobs')) suggestedAction = 'local_jobs_reconcile';
    return {
      kind: 'runtime_storage_warning',
      id: `runtime-storage-${index + 1}`,
      safe: true,
      reason: warning,
      suggestedAction,
    } satisfies RuntimeMaintenanceCandidate;
  });
}

function scanLocalJobCandidates(repoRoot: string, options: Required<RuntimeMaintenanceOptions>): RuntimeMaintenanceCandidate[] {
  const root = localJobsRoot(repoRoot);
  if (!existsSync(root)) return [];
  const candidates: RuntimeMaintenanceCandidate[] = [];
  const entries = readdirSync(root, { withFileTypes: true }).slice(0, options.maxCandidates * 3);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (!isWithin(root, path)) continue;
    const jobPath = join(path, 'job.json');
    if (!existsSync(jobPath)) {
      candidates.push({
        kind: 'missing_job_metadata',
        id: entry.name,
        path,
        safe: true,
        reason: 'Local Job directory has no job.json and cannot be reconciled by the normal Local Bridge index.',
        suggestedAction: 'quarantine_unreadable_local_jobs',
      });
      continue;
    }
    let job: LocalJobState;
    try {
      job = readJson(jobPath) as LocalJobState;
    } catch (error) {
      candidates.push({
        kind: 'unreadable_local_job',
        id: entry.name,
        path,
        safe: true,
        reason: `Local Job metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        suggestedAction: 'quarantine_unreadable_local_jobs',
      });
      continue;
    }
    const status = String(job.status ?? 'unknown');
    if (TERMINAL_LOCAL_JOB_STATUSES.has(status)) continue;
    if (!ACTIVE_LOCAL_JOB_STATUSES.has(status)) continue;
    const ageSource = job.heartbeatAt ?? job.updatedAt ?? job.startedAt ?? job.createdAt;
    const ageMinutes = ageMinutesFrom(ageSource, path) ?? 0;
    const deadlineMs = parseTime(job.deadlineAt);
    const deadlineExpired = deadlineMs !== undefined && deadlineMs < Date.now();
    const workerAlive = isPidAlive(job.workerPid ?? job.ownerPid);
    if (status === 'pending_approval') {
      candidates.push({
        kind: 'pending_approval_local_job',
        id: typeof job.jobId === 'string' ? job.jobId : entry.name,
        path,
        status,
        safe: options.cancelPendingApprovals && ageMinutes >= options.minAgeMinutes,
        reason: options.cancelPendingApprovals
          ? `Pending approval is ${ageMinutes} minute(s) old; authorized maintenance may cancel it to unblock runtime storage.`
          : 'Pending approval may still represent a user decision. Maintenance will not cancel it unless cancel_pending_approvals is explicitly enabled.',
        ageMinutes,
        workerPid: job.workerPid ?? job.ownerPid,
        deadlineAt: job.deadlineAt,
        suggestedAction: 'local_jobs_reconcile',
      });
      continue;
    }
    const safe = (deadlineExpired || !workerAlive) && ageMinutes >= options.minAgeMinutes;
    candidates.push({
      kind: 'stale_active_local_job',
      id: typeof job.jobId === 'string' ? job.jobId : entry.name,
      path,
      status,
      safe,
      reason: safe
        ? `Active Local Job has no live worker or has expired deadline and is ${ageMinutes} minute(s) old.`
        : 'Active Local Job may still be owned by a live worker or is too recent for automatic terminalization.',
      ageMinutes,
      workerPid: job.workerPid ?? job.ownerPid,
      deadlineAt: job.deadlineAt,
      suggestedAction: 'local_jobs_reconcile',
    });
  }
  return candidates.slice(0, options.maxCandidates);
}

function pathAtOrWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.includes('../'));
}

function scanRuntimeTempCandidates(
  repository: RuntimeMaintenanceRepository,
  maxCandidates: number,
): RuntimeMaintenanceCandidate[] {
  const explicitRoots = repository.runtimeTempRoots;
  const defaultRoots = [tmpdir(), '/private/tmp'].filter((root) => existsSync(root));
  if (!explicitRoots && defaultRoots.some((root) => pathAtOrWithin(root, repository.canonicalRoot))) return [];
  const scan = scanRuntimeTempEntries(collectRuntimeProcesses(), {
    roots: explicitRoots,
    minAgeMinutes: RUNTIME_TEMP_RETENTION_MINUTES,
    maxEntries: Math.max(maxCandidates * 3, 500),
  });
  // scanRuntimeTempEntries is the mechanical temp-ownership fence: it only
  // returns direct Forge-prefixed children of the approved temp roots, and
  // removeRuntimeTempEntry revalidates root/name/symlink/age/process occupancy
  // immediately before mutation. Explicit roots narrow scope; they do not create
  // a second ownership authority.
  return scan.entries
    .filter((entry) => entry.cleanupCandidate || entry.protectionReason !== undefined)
    .slice(0, maxCandidates)
    .map((entry) => ({
      kind: 'stale_runtime_temp_entry',
      id: `runtime-temp-${safeId(entry.path)}`,
      path: entry.path,
      safe: entry.cleanupCandidate,
      reason: entry.symbolicLink
        ? 'Symbolic links are never eligible for automatic cleanup.'
        : entry.occupiedByPid
          ? `Temp entry is referenced by live process ${entry.occupiedByPid}.`
          : entry.protectionReason === 'git_source_or_uninspectable'
            ? 'Contains Git source or an uninspectable subtree; retained by RUNTIME_TEMP_GIT_SOURCE_PROTECTED.'
            : `Forge temp entry is unoccupied, not a symbolic link, and ${entry.ageMinutes} minute(s) old.`,
      ageMinutes: entry.ageMinutes,
      suggestedAction: 'full_maintenance_pass',
      ownershipStatus: 'explicit' as const,
    }));
}

function gitWorktreePaths(repoRoot: string): string[] {
  const result = runProcess('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 500_000,
  });
  if (!result.ok) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length).trim()))
    .filter(Boolean);
}

function looksLikeForgeManagedWorktree(path: string): boolean {
  const normalized = resolve(path).replace(/\\/g, '/');
  return normalized.includes('/.forge/managed-worktrees/')
    || normalized.includes('/.forge/controller/managed-worktrees/')
    || normalized.includes('/.repo-harness/managed-worktrees/')
    || normalized.includes('/managed-worktrees/repo_');
}

type StaleWorkSourceState = NonNullable<RuntimeMaintenanceCandidate['sourceState']>;

interface OwnedManagedWorktreeInspection {
  safe: boolean;
  path: string;
  sourceState: StaleWorkSourceState;
  detail: string;
  workspaceResourceId?: string;
  checkoutId?: string;
  branch?: string;
  canonicalBranch?: string;
}

function activeOwnedWorktreeResource(
  controllerHome: string,
  repoId: string,
  path: string,
): OwnedResource | undefined {
  const target = resolve(path);
  return listOwnedResources(controllerHome, { kind: 'worktree', status: 'active', repoId })
    .find((resource) => resource.cleanupCapable === true && resolve(resource.targetRef) === target);
}

function inspectOwnedManagedWorktree(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  pathInput: string,
): OwnedManagedWorktreeInspection {
  const path = resolve(pathInput);
  if (!looksLikeForgeManagedWorktree(path)) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Managed worktree is outside Forge-managed storage; automatic cleanup is forbidden.' };
  }
  if (!existsSync(path)) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Owned managed worktree path is absent; registry/resource reconciliation is required before cleanup.' };
  }
  const workspaceResource = activeOwnedWorktreeResource(controllerHome, repository.repoId, path);
  if (!workspaceResource) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'No active cleanup-capable OwnedResource matches this managed worktree path.' };
  }
  try {
    assertOwnedResourceCleanupTarget(controllerHome, {
      resourceId: workspaceResource.resourceId,
      kind: 'worktree',
      targetRef: path,
    });
  } catch (error) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: `Managed worktree OwnedResource failed exact identity validation: ${error instanceof Error ? error.message : String(error)}` };
  }
  let registered;
  try { registered = getRepository(repository.repoId, controllerHome, { includeRemoved: true }); } catch (error) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: `Repository registry could not be read for owned managed worktree: ${error instanceof Error ? error.message : String(error)}` };
  }
  const checkout = registered.checkouts.find((candidate) =>
    candidate.worktree === true
    && (candidate.lifecycle ?? 'active') === 'active'
    && (resolve(candidate.canonicalRoot) === path || resolve(candidate.localRoot) === path));
  if (!checkout) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Owned managed worktree has no active matching Repository Registry checkout.' };
  }
  if (registered.activeCheckoutId === checkout.checkoutId) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Owned managed worktree is unexpectedly the canonical active checkout; automatic cleanup is forbidden.' };
  }
  const status = runProcess('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: path, timeoutMs: 10_000, maxOutputBytes: 500_000 });
  if (!status.ok) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Owned managed worktree status could not be read.' };
  }
  if (status.stdout.trim()) {
    return { safe: false, path, sourceState: 'dirty_worktree', detail: 'Owned managed worktree is dirty; unique source must be preserved.' };
  }
  const head = runProcess('git', ['rev-parse', 'HEAD'], { cwd: path, timeoutMs: 10_000, maxOutputBytes: 100_000 });
  const branch = runProcess('git', ['branch', '--show-current'], { cwd: path, timeoutMs: 10_000, maxOutputBytes: 100_000 });
  if (!head.ok || !head.stdout.trim() || !branch.ok || !branch.stdout.trim()) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Owned managed worktree HEAD/branch identity could not be resolved.' };
  }
  const branchName = branch.stdout.trim();
  if (checkout.branch?.trim() && checkout.branch.trim() !== branchName) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Owned managed worktree branch no longer matches its Repository Registry checkout identity.' };
  }
  let canonical;
  try { canonical = selectRepositoryCheckout(registered, registered.activeCheckoutId); } catch (error) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: `Canonical repository checkout could not be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
  const canonicalBranch = runProcess('git', ['branch', '--show-current'], { cwd: canonical.canonicalRoot, timeoutMs: 10_000, maxOutputBytes: 100_000 });
  if (!canonicalBranch.ok || !canonicalBranch.stdout.trim()) {
    return { safe: false, path, sourceState: 'source_state_unknown', detail: 'Canonical integration branch could not be resolved for owned managed-worktree cleanup.' };
  }
  const canonicalBranchName = canonicalBranch.stdout.trim();
  const contained = runProcess('git', ['merge-base', '--is-ancestor', head.stdout.trim(), `refs/heads/${canonicalBranchName}`], {
    cwd: canonical.canonicalRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  if (!contained.ok) {
    return {
      safe: false,
      path,
      sourceState: 'unintegrated_commits',
      detail: `Owned managed worktree HEAD ${head.stdout.trim()} is not contained in canonical branch ${canonicalBranchName}; source preservation remains required.`,
    };
  }
  return {
    safe: true,
    path,
    sourceState: 'clean_integrated',
    workspaceResourceId: workspaceResource.resourceId,
    checkoutId: checkout.checkoutId,
    branch: branchName,
    canonicalBranch: canonicalBranchName,
    detail: `Canonical OwnedResource proves cleanup authority for a clean managed worktree whose HEAD ${head.stdout.trim()} is already contained in canonical branch ${canonicalBranchName}.`,
  };
}

function scanRetainedWorktreeCandidates(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  maxCandidates: number,
): RuntimeMaintenanceCandidate[] {
  const candidates: RuntimeMaintenanceCandidate[] = [];
  for (const path of gitWorktreePaths(repository.canonicalRoot)) {
    const normalized = resolve(path);
    if (normalized === resolve(repository.canonicalRoot) || !looksLikeForgeManagedWorktree(normalized)) continue;
    const ownedResource = activeOwnedWorktreeResource(controllerHome, repository.repoId, normalized);
    if (ownedResource) {
      const inspection = inspectOwnedManagedWorktree(repository, controllerHome, normalized);
      candidates.push({
        kind: 'unowned_managed_worktree',
        id: 'managed-worktree:' + basename(normalized),
        path: normalized,
        safe: inspection.safe,
        reason: inspection.detail,
        suggestedAction: 'full_maintenance_pass',
        ownershipStatus: 'explicit',
        sourceState: inspection.sourceState,
        disposition: inspection.safe ? undefined : 'source_preservation_required',
      });
      continue;
    }
    candidates.push({
      kind: 'unowned_managed_worktree',
      id: 'managed-worktree:' + basename(normalized),
      path: normalized,
      safe: false,
      reason: 'Git reports a Forge-managed worktree without canonical cleanup-capable OwnedResource authority. Historical Work metadata cannot grant or veto cleanup; reconcile the physical owner first.',
      suggestedAction: 'full_maintenance_pass',
      ownershipStatus: 'unknown',
      disposition: 'ownership_reconciliation',
    });
  }
  return candidates.slice(0, maxCandidates);
}

function normalizedOptions(options: RuntimeMaintenanceOptions = {}): Required<RuntimeMaintenanceOptions> {
  return {
    minAgeMinutes: clampNumber(options.minAgeMinutes, DEFAULT_MIN_AGE_MINUTES, 0, 7 * 24 * 60),
    maxCandidates: clampNumber(options.maxCandidates, MAX_CANDIDATES, 1, 500),
    cancelPendingApprovals: options.cancelPendingApprovals === true,
  };
}

function detachOwnedManagedWorktree(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  candidate: RuntimeMaintenanceCandidate,
): RuntimeMaintenanceCandidate & { applied: boolean; result: string } {
  if (!candidate.path) return { ...candidate, applied: false, result: 'owned_managed_worktree_path_missing' };
  const inspection = inspectOwnedManagedWorktree(repository, controllerHome, candidate.path);
  if (!inspection.safe || !inspection.workspaceResourceId || !inspection.checkoutId || !inspection.branch || !inspection.canonicalBranch) {
    return {
      ...candidate,
      safe: false,
      reason: inspection.detail,
      sourceState: inspection.sourceState,
      disposition: 'source_preservation_required',
      applied: false,
      result: 'owned_managed_worktree_preserved',
    };
  }
  try {
    setRepositoryCheckoutLifecycle({
      controllerHome,
      repoId: repository.repoId,
      checkoutId: inspection.checkoutId,
      lifecycle: 'removed',
      reason: 'Canonical OwnedResource cleanup reconciled a WorkContract-less managed worktree whose source is already integrated.',
    });
    const removed = runProcess('git', ['worktree', 'remove', '--force', inspection.path], {
      cwd: repository.canonicalRoot,
      timeoutMs: 60_000,
      maxOutputBytes: 500_000,
    });
    if (!removed.ok && existsSync(inspection.path)) {
      throw new Error(`OWNED_MANAGED_WORKTREE_REMOVE_FAILED: ${removed.stderr || removed.stdout}`);
    }
    markOwnedResourceCleaned(controllerHome, inspection.workspaceResourceId, 'forge:runtime-maintenance-owned-worktree');
    if (inspection.branch !== inspection.canonicalBranch) {
      try {
        assertOwnedResourceCleanupTarget(controllerHome, {
          resourceId: managedBranchOwnedResourceId(repository.repoId, inspection.checkoutId),
          kind: 'git_branch',
          targetRef: inspection.branch,
          locator: managedBranchOwnedResourceLocator(repository.canonicalRoot, inspection.checkoutId, inspection.branch),
        });
      } catch {
        return {
          ...candidate,
          safe: true,
          reason: inspection.detail,
          sourceState: 'clean_integrated',
          disposition: undefined,
          applied: true,
          result: `owned_managed_worktree_detached_branch_retained:${inspection.branch}`,
        };
      }
      const deleted = runProcess('git', ['branch', '--delete', inspection.branch], {
        cwd: repository.canonicalRoot,
        timeoutMs: 10_000,
        maxOutputBytes: 100_000,
      });
      if (!deleted.ok) {
        const forced = runProcess('git', ['branch', '--delete', '--force', inspection.branch], {
          cwd: repository.canonicalRoot,
          timeoutMs: 10_000,
          maxOutputBytes: 100_000,
        });
        if (!forced.ok) {
          return {
            ...candidate,
            safe: true,
            reason: inspection.detail,
            sourceState: 'clean_integrated',
            disposition: undefined,
            applied: true,
            result: `owned_managed_worktree_detached_branch_retained:${inspection.branch}`,
          };
        }
      }
      markOwnedResourceCleaned(
        controllerHome,
        managedBranchOwnedResourceId(repository.repoId, inspection.checkoutId),
        'forge:runtime-maintenance-owned-worktree',
      );
    }
    return {
      ...candidate,
      safe: true,
      reason: inspection.detail,
      sourceState: 'clean_integrated',
      disposition: undefined,
      applied: true,
      result: 'owned_managed_worktree_detached',
    };
  } catch (error) {
    if (existsSync(inspection.path)) {
      try {
        setRepositoryCheckoutLifecycle({
          controllerHome,
          repoId: repository.repoId,
          checkoutId: inspection.checkoutId,
          lifecycle: 'active',
          reason: 'Rollback failed OwnedResource managed-worktree cleanup.',
        });
      } catch { /* preserve primary failure */ }
    }
    throw error;
  }
}

function scanStaleEditSessionCandidates(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  options: Required<RuntimeMaintenanceOptions>,
): RuntimeMaintenanceCandidate[] {
  const nowMs = Date.now();
  return listEditSessions(repository.canonicalRoot, Math.min(options.maxCandidates * 3, 500))
    .filter((summary) => ['open', 'dirty', 'checked', 'check_failed'].includes(summary.status))
    .map((session) => {
      const updatedMs = Date.parse(session.updatedAt);
      const ageMinutes = Number.isFinite(updatedMs) ? Math.max(0, Math.floor((nowMs - updatedMs) / 60_000)) : 0;
      return { session, ageMinutes };
    })
    .filter(({ ageMinutes }) => ageMinutes >= options.minAgeMinutes)
    .sort((left, right) => right.ageMinutes - left.ageMinutes)
    .slice(0, options.maxCandidates)
    .map(({ session, ageMinutes }) => {
      let safety: { safe: boolean; reason: string };
      try {
        safety = inspectIntegratedEditSession(repository.canonicalRoot, session.sessionId, {
          controllerHome, repoId: repository.repoId,
        });
      } catch (error) {
        safety = { safe: false, reason: error instanceof Error ? error.message : String(error) };
      }
      return {
        kind: 'stale_edit_session' as const,
        id: session.sessionId,
        status: session.status,
        safe: safety.safe,
        reason: safety.reason,
        ageMinutes,
        suggestedAction: 'full_maintenance_pass' as const,
        ownershipStatus: 'explicit' as const,
      };
    });
}

function readBoolean(input: Record<string, unknown>, snake: string, camel: string): boolean | undefined {
  if (typeof input[snake] === 'boolean') return input[snake] as boolean;
  if (typeof input[camel] === 'boolean') return input[camel] as boolean;
  return undefined;
}

function readNumber(input: Record<string, unknown>, snake: string, camel: string): number | undefined {
  if (typeof input[snake] === 'number' && Number.isFinite(input[snake])) return input[snake] as number;
  if (typeof input[camel] === 'number' && Number.isFinite(input[camel])) return input[camel] as number;
  return undefined;
}

function readString(input: Record<string, unknown>, snake: string, camel: string): string | undefined {
  if (typeof input[snake] === 'string' && input[snake].trim()) return String(input[snake]).trim();
  if (typeof input[camel] === 'string' && input[camel].trim()) return String(input[camel]).trim();
  return undefined;
}

function coerceRepository(repository: RuntimeMaintenanceRepository): RepositoryRecord {
  return repository as RepositoryRecord;
}

function safeRuntimeStorage(repository: RuntimeMaintenanceRepository, controllerHome: string): { report?: RepositoryRuntimeStorageReport; error?: string } {
  try {
    return { report: ensureRepositoryRuntimeStorage(coerceRepository(repository), controllerHome) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function buildRuntimeMaintenanceStatus(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  options: RuntimeMaintenanceOptions = {},
): RuntimeMaintenanceStatus {
  const normalized = normalizedOptions(options);
  // Runtime-storage binding is the compatibility cutover authority for legacy test/
  // migrated repositories. Read lifecycle owners only after that binding is resolved.
  const storage = safeRuntimeStorage(repository, controllerHome);
  const runtimeStorageRepair = previewRuntimeStorageRepair(coerceRepository(repository), controllerHome, {
    minAgeMinutes: normalized.minAgeMinutes,
    maxCandidates: normalized.maxCandidates,
  });
  const localJobCandidates = scanLocalJobCandidates(repository.canonicalRoot, normalized);
  const storageCandidates = runtimeStorageCandidates(storage.report);
  const tempCandidates = scanRuntimeTempCandidates(repository, normalized.maxCandidates);
  const staleEditCandidates = scanStaleEditSessionCandidates(repository, controllerHome, normalized);
  const retainedWorktreeCandidates = scanRetainedWorktreeCandidates(repository, controllerHome, normalized.maxCandidates);
  const candidates = [...localJobCandidates, ...storageCandidates, ...staleEditCandidates, ...retainedWorktreeCandidates, ...tempCandidates].slice(0, normalized.maxCandidates);
  const summary = summarize(candidates);
  const blockingCandidates = candidates.filter((candidate) => candidate.kind !== 'stale_runtime_temp_entry');
  const readyForExecution = storage.report?.readyForExecution === true
    && blockingCandidates.filter((candidate) => candidate.safe).length === 0
    && blockingCandidates.filter((candidate) => !candidate.safe).length === 0
    && runtimeStorageRepair.safeCandidateCount === 0
    && runtimeStorageRepair.unsafeCandidateCount === 0;
  return {
    schemaVersion: 1,
    generatedAt: now(),
    repoId: repository.repoId,
    mode: 'status',
    readyForExecution,
    runtimeStorage: storage.report,
    runtimeStorageError: storage.error,
    candidates,
    summary,
    runtimeStorageRepair,
    recommendedActions: Array.from(new Set([
      ...uniqueActions(candidates, storage.report?.readyForExecution === true),
      ...typedRepairActions(runtimeStorageRepair),
    ])),
    continuation: {
      retryOriginalOperation: true,
      afterSuccess: [
        'run capability_recovery_probe',
        'retry the originally blocked operation with the same request intent',
        'if no safe metadata candidate exists, create a bounded handoff instead of inventing a Runtime restart or source-repair fallback',
      ],
    },
    warnings: [
      'Runtime maintenance only edits forge metadata under .ai/harness and controller-home for the selected repository.',
      'Pending approvals are not cancelled unless cancel_pending_approvals is explicitly enabled.',
      'System temp cleanup only removes direct forge-prefixed children of approved temp roots after a 24-hour retention period and a fresh process-occupancy check.',
      'Runtime lifecycle changes and source repair are outside the runtime maintenance executor.',
      'Unknown-ownership managed worktrees remain lifecycle blockers. Cleanup is eligible only when canonical OwnedResource identity is exact, the worktree is clean, and its HEAD is already contained in the canonical branch.',
    ],
  };
}

export function previewAutomaticRuntimeMaintenance(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  rawArguments: Record<string, unknown> = {},
): AutomaticRuntimeMaintenancePreview {
  const actionId = readString(rawArguments, 'action_id', 'actionId') as RuntimeMaintenanceActionId | undefined;
  const confirmMaintenance = readBoolean(rawArguments, 'confirm_maintenance', 'confirmMaintenance') === true;
  const authorization = readString(rawArguments, 'authorization', 'authorization');
  const cancelPendingApprovals = readBoolean(rawArguments, 'cancel_pending_approvals', 'cancelPendingApprovals') === true;
  const status = buildRuntimeMaintenanceStatus(repository, controllerHome, {
    minAgeMinutes: readNumber(rawArguments, 'min_age_minutes', 'minAgeMinutes'),
    maxCandidates: readNumber(rawArguments, 'max_candidates', 'maxCandidates'),
    cancelPendingApprovals,
  });

  if (!actionId) {
    return {
      allowed: false,
      noOp: false,
      blockedReason: 'Automatic maintenance Schedule is missing action_id.',
      blockedPermanently: true,
      selectedCandidateIds: [],
      selectedTypedCandidateIds: [],
      status,
    };
  }
  if (!AUTOMATIC_RUNTIME_MAINTENANCE_ACTION_ALLOWLIST.has(actionId)) {
    return {
      actionId,
      allowed: false,
      noOp: false,
      blockedReason: `Automatic maintenance Schedule may only run allowlisted actions. Received ${actionId}.`,
      blockedPermanently: true,
      selectedCandidateIds: [],
      selectedTypedCandidateIds: [],
      status,
    };
  }
  if (!confirmMaintenance || authorization !== actionId) {
    return {
      actionId,
      allowed: false,
      noOp: false,
      blockedReason: 'Automatic maintenance Schedule is missing confirm_maintenance=true and matching authorization.',
      blockedPermanently: true,
      selectedCandidateIds: [],
      selectedTypedCandidateIds: [],
      status,
    };
  }
  if (cancelPendingApprovals) {
    return {
      actionId,
      allowed: false,
      noOp: false,
      blockedReason: 'Automatic maintenance Schedule may not cancel pending approvals.',
      blockedPermanently: true,
      selectedCandidateIds: [],
      selectedTypedCandidateIds: [],
      status,
    };
  }

  const selectedCandidateIds = status.candidates
    .filter((candidate) => shouldApply(actionId, candidate))
    .map((candidate) => candidate.id);
  const selectedTypedCandidateIds = selectedTypedRepairCandidateIds(actionId, status.runtimeStorageRepair);
  const totalSelected = selectedCandidateIds.length + selectedTypedCandidateIds.length;
  if (totalSelected > 0) {
    return {
      actionId,
      allowed: true,
      noOp: false,
      blockedPermanently: false,
      selectedCandidateIds,
      selectedTypedCandidateIds,
      status,
    };
  }

  if (status.readyForExecution) {
    return {
      actionId,
      allowed: true,
      noOp: true,
      blockedPermanently: false,
      selectedCandidateIds,
      selectedTypedCandidateIds,
      status,
    };
  }

  return {
    actionId,
    allowed: false,
    noOp: false,
    blockedReason: status.runtimeStorageError
      ? `Automatic maintenance preview could not inspect runtime storage safely: ${status.runtimeStorageError}`
      : 'Automatic maintenance preview found no safe allowlisted candidates and requires human review.',
    blockedPermanently: false,
    selectedCandidateIds,
    selectedTypedCandidateIds,
    status,
  };
}

function terminalizeLocalJob(candidate: RuntimeMaintenanceCandidate, status: 'orphaned' | 'cancelled' = 'orphaned'): string {
  if (!candidate.path) throw new Error('LOCAL_JOB_PATH_MISSING');
  const jobPath = join(candidate.path, 'job.json');
  const job = readJson(jobPath) as LocalJobState;
  if (job.status && TERMINAL_LOCAL_JOB_STATUSES.has(job.status)) return job.status;
  const updated = {
    ...job,
    status,
    updatedAt: now(),
    finishedAt: now(),
    error: job.error ?? `Terminalized by forge runtime maintenance: ${candidate.reason}`,
    outcome: job.outcome ?? { infrastructureError: { code: 'MAINTENANCE_TERMINALIZED', message: candidate.reason } },
  };
  writeJsonAtomic(jobPath, updated);
  return status;
}

function quarantineLocalJob(controllerHome: string, repoId: string, repoRoot: string, candidate: RuntimeMaintenanceCandidate): string {
  if (!candidate.path) throw new Error('LOCAL_JOB_PATH_MISSING');
  const root = localJobsRoot(repoRoot);
  if (!isWithin(root, candidate.path)) throw new Error('LOCAL_JOB_PATH_OUTSIDE_ROOT');
  return quarantineRuntimePath(controllerHome, repoId, candidate.path, candidate.id);
}

function rebuildActiveIndex(repoRoot: string): void {
  const root = localJobsRoot(repoRoot);
  if (!existsSync(root)) return;
  const activeIds: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const job = readJson(join(root, entry.name, 'job.json')) as LocalJobState;
      if (job.jobId && job.status && ACTIVE_LOCAL_JOB_STATUSES.has(job.status)) activeIds.push(job.jobId);
    } catch {
      // Unreadable entries are handled by quarantine actions; do not keep them in the active index.
    }
  }
  writeJsonAtomic(activeIndexPath(repoRoot), {
    schemaVersion: 1,
    ownerPid: process.pid,
    updatedAt: now(),
    jobIds: Array.from(new Set(activeIds)).sort((a, b) => b.localeCompare(a)),
  });
}

function shouldApply(actionId: RuntimeMaintenanceActionId, candidate: RuntimeMaintenanceCandidate): boolean {
  if (!candidate.safe) return false;
  if (actionId === 'full_maintenance_pass') return candidate.kind !== 'runtime_storage_warning';
  if (actionId === 'local_jobs_reconcile') return candidate.kind === 'stale_active_local_job' || candidate.kind === 'pending_approval_local_job';
  if (actionId === 'quarantine_unreadable_local_jobs') return candidate.kind === 'unreadable_local_job' || candidate.kind === 'missing_job_metadata';
  return false;
}

export function applyRuntimeMaintenance(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  options: RuntimeMaintenanceApplyOptions,
): RuntimeMaintenanceApplyResult {
  if (options.confirmMaintenance !== true) throw new Error('RUNTIME_MAINTENANCE_CONFIRMATION_REQUIRED: confirmMaintenance=true is required.');
  if (!VALID_MAINTENANCE_ACTIONS.has(options.actionId)) throw new Error(`RUNTIME_MAINTENANCE_ACTION_UNKNOWN: ${options.actionId}`);
  const before = buildRuntimeMaintenanceStatus(repository, controllerHome, options);
  const typedCandidateIds = selectedTypedRepairCandidateIds(options.actionId, before.runtimeStorageRepair);
  const runtimeStorageRepairApply = typedCandidateIds.length > 0
    ? applyRuntimeStorageRepair(coerceRepository(repository), controllerHome, {
      confirmRepair: true,
      candidateIds: typedCandidateIds,
      minAgeMinutes: options.minAgeMinutes,
      maxCandidates: options.maxCandidates,
    })
    : undefined;
  const typedAppliedPaths = new Set((runtimeStorageRepairApply?.applied ?? [])
    .filter((entry) => entry.status === 'applied')
    .map((entry) => resolve(entry.path)));
  const applied = before.candidates.map((candidate) => {
    if (candidate.path && typedAppliedPaths.has(resolve(candidate.path))) {
      return { ...candidate, applied: true, result: 'handled_by_runtime_storage_repair' };
    }
    if (!shouldApply(options.actionId, candidate)) return { ...candidate, applied: false, result: 'not_selected' };
    try {
      if (candidate.kind === 'stale_active_local_job') {
        return { ...candidate, applied: true, result: terminalizeLocalJob(candidate, 'orphaned') };
      }
      if (candidate.kind === 'pending_approval_local_job') {
        return { ...candidate, applied: true, result: terminalizeLocalJob(candidate, 'cancelled') };
      }
      if (candidate.kind === 'unreadable_local_job' || candidate.kind === 'missing_job_metadata') {
        return { ...candidate, applied: true, result: quarantineLocalJob(controllerHome, repository.repoId, repository.canonicalRoot, candidate) };
      }
      if (candidate.kind === 'stale_runtime_temp_entry') {
        if (!candidate.path) throw new Error('RUNTIME_TEMP_PATH_MISSING');
        return {
          ...candidate,
          applied: true,
          result: removeRuntimeTempEntry(candidate.path, {
            roots: repository.runtimeTempRoots,
            minAgeMinutes: RUNTIME_TEMP_RETENTION_MINUTES,
          }),
        };
      }
      if (candidate.kind === 'unowned_managed_worktree') {
        return detachOwnedManagedWorktree(repository, controllerHome, candidate);
      }
      if (candidate.kind === 'stale_edit_session') {
        const cleaned = withRepositoryMutationExclusion(
          controllerHome, repository.repoId, 'maintenance-edit-session:' + candidate.id,
          () => cleanupEditSession(repository.canonicalRoot, candidate.id, {
            controllerHome, repoId: repository.repoId,
            reviewer: 'runtime-maintenance',
            note: 'Exact integrated bytes retained; missing checks remain unverified.',
          }),
        );
        const closed = ['finalized', 'reconciled_unverified', 'superseded', 'rolled_back'].includes(cleaned.status);
        return {
          ...candidate,
          applied: closed,
          result: closed ? `edit_session_${cleaned.status}` : 'edit_session_retained_nonterminal',
        };
      }
      return { ...candidate, applied: false, result: 'unsupported_candidate' };
    } catch (error) {
      return { ...candidate, applied: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Reuse the existing Process GC within the explicit full-maintenance cadence.
  // No scheduler, per-tool-call cleanup, or database compaction is introduced.
  const processGc = options.actionId === 'full_maintenance_pass'
    ? gcTerminalProcesses({ controllerHome, repoId: repository.repoId })
    : undefined;
  const quarantineGc = options.actionId === 'full_maintenance_pass'
    ? cleanupRuntimeQuarantine(controllerHome, repository.repoId, repository.canonicalRoot, {
      maxEntries: Math.max(100, (options.maxCandidates ?? 50) * 3),
      maxRemovals: Math.max(1, options.maxCandidates ?? 50),
      additionalRoots: [runtimeLegacyCheckQuarantineRoot(controllerHome, repository.repoId)],
    })
    : undefined;
  let generatedCacheGc: RepositoryGeneratedCacheRetentionReport | undefined;
  let iosTestEvidenceGc: IosTestEvidenceRetentionReport | undefined;
  let iosTestEvidenceInventory: IosTestEvidenceInventoryReport | undefined;
  if (options.actionId === 'full_maintenance_pass') {
    let cacheRepository: Parameters<typeof cleanupGeneratedRepositoryCheckoutCaches>[0] = {
      repoId: repository.repoId,
      canonicalRoot: repository.canonicalRoot,
      checkouts: [],
    };
    try {
      cacheRepository = getRepository(repository.repoId, controllerHome, { includeRemoved: true });
    } catch {
      // Embedded/test repositories may not be present in the Controller registry.
      // The explicit maintenance action still safely covers their canonical root.
    }
    // Explicit maintenance reuses the scheduled retention rotator. Without a
    // changing ordinal, each manual pass repeatedly exhausts the same first
    // root and cannot reach later managed checkouts or high-cardinality caches.
    const cacheScanNowMs = Date.now();
    generatedCacheGc = cleanupGeneratedRepositoryCheckoutCaches(cacheRepository, {
      controllerHome,
      nowMs: cacheScanNowMs,
      rootStartIndex: Math.floor(cacheScanNowMs / 60_000),
      graceMs: 60_000,
      maxEntries: Math.max(1_000, (options.maxCandidates ?? 50) * 20),
      maxRemovals: Math.max(1, options.maxCandidates ?? 50),
    });
    iosTestEvidenceGc = cleanupReleasableIosTestEvidence(cacheRepository, {
      nowMs: cacheScanNowMs,
      rootStartIndex: Math.floor(cacheScanNowMs / 60_000),
      maxEntries: Math.max(256, (options.maxCandidates ?? 50) * 20),
      maxRemovals: Math.max(1, Math.min(8, options.maxCandidates ?? 50)),
      owner: { controllerHome, repoId: repository.repoId },
    });
    iosTestEvidenceInventory = inspectRepositoryIosTestEvidence(cacheRepository, {
      nowMs: cacheScanNowMs,
      rootStartIndex: Math.floor(cacheScanNowMs / 60_000),
      maxEntries: Math.max(256, (options.maxCandidates ?? 50) * 20),
      owner: { controllerHome, repoId: repository.repoId },
    });
    // Legacy Work preservation artifacts are read-only after Work retirement.
  }

  if (options.actionId === 'runtime_storage_finalize_relocation' || options.actionId === 'full_maintenance_pass' || applied.some((candidate) => candidate.applied) || runtimeStorageRepairApply) {
    rebuildActiveIndex(repository.canonicalRoot);
  }
  const storage = safeRuntimeStorage(repository, controllerHome);
  let projection: unknown;
  try { projection = rebuildRepositoryProjection(controllerHome, repository.repoId); } catch (error) { projection = { error: error instanceof Error ? error.message : String(error) }; }
  const after = buildRuntimeMaintenanceStatus(repository, controllerHome, options);
  return {
    ...after,
    mode: 'apply',
    actionId: options.actionId,
    runtimeStorage: after.runtimeStorage ?? storage.report,
    runtimeStorageError: after.runtimeStorageError ?? storage.error,
    applied,
    runtimeStorageRepairApply,
    processGc,
    quarantineGc,
    generatedCacheGc,
    iosTestEvidenceGc,
    iosTestEvidenceInventory,
    projection,
  };
}
