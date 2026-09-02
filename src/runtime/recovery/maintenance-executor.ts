import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { assertStorageHeadroom } from '../shared/storage-capacity';
import { runProcess } from '../../effects/process-runner';
import { cleanupEditSession, getEditSession, listEditSessions, reconcileEditSession } from '../../cli/editing/edit-session';
import { ensureRepositoryRuntimeStorage, type RepositoryRuntimeStorageReport } from '../../cli/repositories/runtime-storage';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { rebuildRepositoryProjection } from '../projections/materialized-view';
import { getWorkContract, readWorkContractStore, transitionWorkContractPhase } from '../../../packages/kernel/work/api/index';
import { getControllerSession, withControllerSessionTerminalizationFence } from '../../../packages/kernel/controller/api/index';
import { listPlanContracts } from '../control-plane/facade/plan-contract-store';
import { readRequirement } from '../control-plane/persistence/requirement-store';
import { listControlPlaneRecords, type ControlPlaneRecord } from '../control-plane/persistence/sqlite-store';
import { isTerminalWorkContractStatus, type WorkContract } from '../control-plane/facade/types';
import { listSchedules } from '../../../packages/kernel/scheduler/api/index';
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
  | 'stale_work_contract'
  | 'stale_edit_session'
  | 'retained_migrated_work'
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
  staleWorkContracts: number;
  staleEditSessions: number;
  retainedMigratedWork: number;
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
    staleWorkContracts: candidates.filter((candidate) => candidate.kind === 'stale_work_contract').length,
    staleEditSessions: candidates.filter((candidate) => candidate.kind === 'stale_edit_session').length,
    retainedMigratedWork: candidates.filter((candidate) => candidate.kind === 'retained_migrated_work').length,
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
  const ownershipStatus = explicitRoots ? 'explicit' as const : 'unknown' as const;
  return scan.entries
    .filter((entry) => entry.cleanupCandidate)
    .slice(0, maxCandidates)
    .map((entry) => ({
      kind: 'stale_runtime_temp_entry',
      id: `runtime-temp-${safeId(entry.path)}`,
      path: entry.path,
      safe: entry.cleanupCandidate && ownershipStatus === 'explicit',
      reason: ownershipStatus === 'unknown'
        ? 'Temp entry has unknown durable ownership; it is protected until an owning lifecycle record or safe reconciliation proves eligibility.'
        : entry.symbolicLink
          ? 'Symbolic links are never eligible for automatic cleanup.'
          : entry.occupiedByPid
            ? `Temp entry is referenced by live process ${entry.occupiedByPid}.`
            : `Forge temp entry is unoccupied, not a symbolic link, and ${entry.ageMinutes} minute(s) old.`,
      ageMinutes: entry.ageMinutes,
      suggestedAction: 'full_maintenance_pass',
      ownershipStatus,
    }));
}

interface RetainedMigratedWork {
  migrationId: string;
  sourceHome: string;
  work: WorkContract;
}

interface AppliedControllerHomeMigrationRecord {
  migrationId: string;
  status: 'applied' | 'rolled_back';
  sourceHome: string;
}

function listRetainedMigratedWork(destinationHomeInput: string, repoId: string): RetainedMigratedWork[] {
  const destinationHome = resolve(destinationHomeInput);
  const destinationWorkIds = new Set(
    listControlPlaneRecords<WorkContract>(destinationHome, { namespace: 'work_contract', scope: repoId, limit: 5_000 })
      .map((record) => record.key),
  );
  const migrations = listControlPlaneRecords<AppliedControllerHomeMigrationRecord>(destinationHome, {
    namespace: 'controller_home_migration',
    scope: 'controller',
    limit: 100,
  });
  const retained: RetainedMigratedWork[] = [];
  for (const record of migrations) {
    const migration = record.value;
    if (migration.status !== 'applied') continue;
    const sourceHome = resolve(migration.sourceHome);
    if (!existsSync(join(sourceHome, 'control-plane.sqlite'))) continue;
    let sourceWork: ControlPlaneRecord<WorkContract>[];
    try {
      sourceWork = listControlPlaneRecords<WorkContract>(sourceHome, { namespace: 'work_contract', limit: 5_000 });
    } catch {
      continue;
    }
    for (const source of sourceWork) {
      const work = source.value;
      if (work.repoId !== repoId || !isTerminalWorkContractStatus(work.status)) continue;
      if (!work.worktreeRef?.trim() || !existsSync(work.worktreeRef)) continue;
      if (destinationWorkIds.has(work.workId)) continue;
      retained.push({ migrationId: migration.migrationId, sourceHome, work });
    }
  }
  return retained.sort((left, right) => left.work.updatedAt.localeCompare(right.work.updatedAt));
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

interface StaleWorkSourceInspection {
  safeToCancel: boolean;
  state: StaleWorkSourceState;
  path?: string;
  detail: string;
}

function inspectStaleWorkRepositorySource(
  repository: RuntimeMaintenanceRepository,
  contract: WorkContract,
): StaleWorkSourceInspection {
  const recordedPath = contract.worktreeRef?.trim();
  if (!recordedPath) {
    return {
      safeToCancel: true,
      state: 'no_managed_source',
      detail: 'Work has no recorded managed worktree source.',
    };
  }
  const path = resolve(recordedPath);
  if (!looksLikeForgeManagedWorktree(path)) {
    return {
      safeToCancel: true,
      state: 'no_managed_source',
      path,
      detail: 'Recorded Work path is not a Forge-managed worktree and is not disposable maintenance source.',
    };
  }
  if (!existsSync(path)) {
    return {
      safeToCancel: false,
      state: 'source_state_unknown',
      path,
      detail: 'Recorded managed worktree path is absent, so maintenance cannot prove that no unique branch/source remains recoverable through Git or checkout metadata; destructive stale-Work cancellation is fenced.',
    };
  }

  const status = runProcess('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: path,
    timeoutMs: 10_000,
    maxOutputBytes: 500_000,
  });
  if (!status.ok) {
    return {
      safeToCancel: false,
      state: 'source_state_unknown',
      path,
      detail: `Managed worktree source state could not be read (${status.stderr || 'git status failed'}); destructive stale-Work cancellation is fenced.`,
    };
  }
  if (status.stdout.trim()) {
    return {
      safeToCancel: false,
      state: 'dirty_worktree',
      path,
      detail: 'Managed worktree contains uncommitted or untracked repository source; durable metadata/process evidence is not a substitute for preserving the live source checkout.',
    };
  }

  const head = runProcess('git', ['rev-parse', 'HEAD'], {
    cwd: path,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  const targetBranch = repository.defaultBranch?.trim() || 'main';
  const target = runProcess('git', ['rev-parse', '--verify', `refs/heads/${targetBranch}`], {
    cwd: repository.canonicalRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  if (!head.ok || !head.stdout.trim() || !target.ok || !target.stdout.trim()) {
    return {
      safeToCancel: false,
      state: 'source_state_unknown',
      path,
      detail: `Managed worktree HEAD or target branch ${targetBranch} could not be resolved; destructive stale-Work cancellation is fenced.`,
    };
  }
  const unique = runProcess('git', ['rev-list', '--count', `${target.stdout.trim()}..${head.stdout.trim()}`], {
    cwd: repository.canonicalRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  if (!unique.ok || !/^\d+$/.test(unique.stdout.trim())) {
    return {
      safeToCancel: false,
      state: 'source_state_unknown',
      path,
      detail: 'Managed worktree unique-commit state could not be proven; destructive stale-Work cancellation is fenced.',
    };
  }
  if (Number(unique.stdout.trim()) > 0) {
    return {
      safeToCancel: false,
      state: 'unintegrated_commits',
      path,
      detail: `Managed worktree HEAD has ${unique.stdout.trim()} commit(s) not reachable from ${targetBranch}; explicit semantic adoption or cleanup authority is required.`,
    };
  }
  return {
    safeToCancel: true,
    state: 'clean_integrated',
    path,
    detail: `Managed worktree is clean and its HEAD is already reachable from ${targetBranch}.`,
  };
}

function staleWorkSemanticTerminalizationReady(contract: WorkContract): boolean {
  if (contract.phase !== 'cleanup') return false;
  return (['implementation', 'verification', 'delivery'] as const).every((phase) =>
    ['satisfied', 'skipped'].includes(contract.phaseEvidence[phase].state));
}

function staleWorkCandidateReason(source: StaleWorkSourceInspection, semanticReady: boolean): string {
  if (!source.safeToCancel) {
    return `Protected stale Work: no active lifecycle authority remains, but repository source preservation is required. ${source.detail} The Work must remain nonterminal until source is explicitly adopted, delivered, or cleanup is semantically authorized.`;
  }
  if (!semanticReady) {
    return `Protected stale Work: repository source has no unique live changes, but the Work semantic lifecycle has not reached cleanup with implementation, verification, and delivery explicitly satisfied or skipped. ${source.detail} Maintenance may clean source debt, but it cannot infer that the objective or acceptance criteria are complete.`;
  }
  return `Cleanup-ready WorkContract exceeded the explicit maintenance age threshold and has no active Plan, Requirement, Schedule, or Controller authority. ${source.detail} Explicit full maintenance may finish cleanup while retaining durable evidence.`;
}

function scanRetainedWorktreeCandidates(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  maxCandidates: number,
): RuntimeMaintenanceCandidate[] {
  const worktreePaths = gitWorktreePaths(repository.canonicalRoot);
  if (worktreePaths.length === 0) return [];
  const normalizedInventory = new Set(worktreePaths.map((path) => resolve(path)));
  const currentContracts = readWorkContractStore({ controllerHome, repoId: repository.repoId }).contracts;
  const currentOwnedPaths = new Set(
    currentContracts
      .map((contract) => contract.worktreeRef?.trim())
      .filter((path): path is string => Boolean(path))
      .map((path) => resolve(path)),
  );
  const candidates: RuntimeMaintenanceCandidate[] = [];
  const retained = listRetainedMigratedWork(controllerHome, repository.repoId);
  const retainedByPath = new Map(retained.map((entry) => [resolve(entry.work.worktreeRef!), entry]));

  for (const path of worktreePaths) {
    const normalized = resolve(path);
    if (normalized === resolve(repository.canonicalRoot) || currentOwnedPaths.has(normalized)) continue;
    const migrated = retainedByPath.get(normalized);
    if (migrated) {
      const completed = migrated.work.status === 'completed';
      candidates.push({
        kind: 'retained_migrated_work',
        id: migrated.work.workId,
        path: normalized,
        status: migrated.work.status,
        safe: false,
        reason: completed
          ? 'A terminal Work from a retired Controller Home still owns a Git worktree and requires completion/cleanup reconciliation under the current Controller before lifecycle health can be reported.'
          : 'A terminal Work from a retired Controller Home still owns preserved implementation state in a Git worktree. Review and explicitly resume or supersede it under current authority; automatic maintenance must not delete it.',
        suggestedAction: 'full_maintenance_pass',
        ownershipStatus: 'explicit',
        sourceControllerHome: migrated.sourceHome,
        objective: migrated.work.objective,
        continuationPrompt: migrated.work.continuationPrompt,
        disposition: completed ? 'completion_reconciliation' : 'resume_or_supersede_review',
      });
      continue;
    }
    if (!looksLikeForgeManagedWorktree(normalized)) continue;
    candidates.push({
      kind: 'unowned_managed_worktree',
      id: `managed-worktree:${basename(normalized)}`,
      path: normalized,
      safe: false,
      reason: 'Git reports a Forge-managed worktree for this repository, but the current Controller has no WorkContract ownership and no retained migration identity for it. Ownership must be reconciled before lifecycle health can be reported.',
      suggestedAction: 'full_maintenance_pass',
      ownershipStatus: 'unknown',
      disposition: 'ownership_reconciliation',
    });
  }

  // A retained migrated Work whose referenced path still exists but is no longer
  // in Git inventory remains preservation debt rather than disappearing silently.
  for (const migrated of retained) {
    const normalized = resolve(migrated.work.worktreeRef!);
    if (normalizedInventory.has(normalized) || currentOwnedPaths.has(normalized)) continue;
    // Legacy WorkContract records sometimes stored the repository checkout/root
    // in worktreeRef even though it was not a Controller-managed worktree. Such
    // historical references remain audit evidence, but must not turn every old
    // repository root into current lifecycle debt. Only known Forge/RepoHarness
    // managed-worktree storage can represent preserved implementation here.
    if (!looksLikeForgeManagedWorktree(normalized)) continue;
    // A removed legacy campaign may leave an empty managed-storage directory
    // behind after its Git metadata and contents are already gone. That is not
    // preserved implementation and must not block lifecycle health. A retained
    // path outside current Git inventory only remains lifecycle debt when its
    // worktree .git marker still exists for manual reconciliation.
    if (!existsSync(join(normalized, '.git'))) continue;
    const completed = migrated.work.status === 'completed';
    candidates.push({
      kind: 'retained_migrated_work',
      id: migrated.work.workId,
      path: normalized,
      status: migrated.work.status,
      safe: false,
      reason: 'A terminal Work retained by a migrated Controller Home still has preserved filesystem state, but Git no longer reports it as a registered worktree. Manual lifecycle reconciliation is required; automatic cleanup is forbidden.',
      suggestedAction: 'full_maintenance_pass',
      ownershipStatus: 'explicit',
      sourceControllerHome: migrated.sourceHome,
      objective: migrated.work.objective,
      continuationPrompt: migrated.work.continuationPrompt,
      disposition: completed ? 'completion_reconciliation' : 'resume_or_supersede_review',
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

function activeWorkAuthorityRefs(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  contract: WorkContract,
): string[] {
  const refs: string[] = [];
  if (getControllerSession({ controllerHome, repoId: repository.repoId }, contract.workId)) refs.push('controller_session');
  const activePlans = listPlanContracts({ controllerHome, repoId: repository.repoId, status: 'active', limit: 100 });
  const plan = activePlans.find((candidate) => candidate.planId === contract.planId || candidate.steps.some((step) => step.workId === contract.workId));
  if (plan) refs.push(`plan:${plan.planId}`);
  if (contract.requirementId) {
    const requirement = readRequirement({ controllerHome }, contract.requirementId)?.value;
    if (requirement && !['done', 'cancelled'].includes(requirement.state)) refs.push(`requirement:${requirement.requirementId}:${requirement.state}`);
  }
  const boundSchedule = listSchedules(controllerHome, repository.repoId).find((schedule) => {
    if (!schedule.enabled) return false;
    const args = schedule.action.arguments as Record<string, unknown> | undefined;
    return args?.work_id === contract.workId;
  });
  if (boundSchedule) refs.push(`schedule:${boundSchedule.scheduleId}`);
  return refs;
}

function scanStaleWorkContractCandidates(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  options: Required<RuntimeMaintenanceOptions>,
): RuntimeMaintenanceCandidate[] {
  const nowMs = Date.now();
  return readWorkContractStore({ controllerHome, repoId: repository.repoId }).contracts
    .filter((contract) => !isTerminalWorkContractStatus(contract.status))
    .map((contract) => {
      const updatedMs = Date.parse(contract.updatedAt);
      const ageMinutes = Number.isFinite(updatedMs) ? Math.max(0, Math.floor((nowMs - updatedMs) / 60_000)) : 0;
      return { contract, ageMinutes };
    })
    .filter(({ ageMinutes }) => ageMinutes >= options.minAgeMinutes)
    .flatMap(({ contract, ageMinutes }) => {
      const authorityRefs = activeWorkAuthorityRefs(repository, controllerHome, contract);
      // A live Plan/Requirement/Schedule/Controller reference is lifecycle authority,
      // not maintenance debt. Keep the Work fenced until that authority disappears;
      // if it later becomes unowned, the next scan will surface it as stale.
      if (authorityRefs.length > 0) return [];
      return [{ contract, ageMinutes, source: inspectStaleWorkRepositorySource(repository, contract) }];
    })
    .sort((left, right) => right.ageMinutes - left.ageMinutes)
    .slice(0, options.maxCandidates)
    .map(({ contract, ageMinutes, source }) => {
      const semanticReady = staleWorkSemanticTerminalizationReady(contract);
      return {
        kind: 'stale_work_contract' as const,
        id: contract.workId,
        path: source.path,
        status: contract.status,
        safe: source.safeToCancel && semanticReady,
        reason: staleWorkCandidateReason(source, semanticReady),
        ageMinutes,
        suggestedAction: 'full_maintenance_pass' as const,
        ownershipStatus: 'explicit' as const,
        sourceState: source.state,
        disposition: !source.safeToCancel
          ? ('source_preservation_required' as const)
          : !semanticReady
            ? ('semantic_completion_required' as const)
            : undefined,
      };
    });
}

export function applyStaleWorkContractMaintenanceCandidate(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  candidate: RuntimeMaintenanceCandidate,
): RuntimeMaintenanceCandidate & { applied: boolean; result: string } {
  const work = getWorkContract({ controllerHome, repoId: repository.repoId }, candidate.id);
  if (!work || isTerminalWorkContractStatus(work.status)) {
    return { ...candidate, applied: false, result: 'already_terminal' };
  }

  // The stale scan is discovery only. Re-evaluate every non-Controller authority
  // while holding the canonical ControllerSession lock, then perform the Work
  // transition before releasing it. A newer controller_claim therefore either
  // wins the lock first and fences this mutation, or starts only after an already
  // completed maintenance terminalization; there is no check-then-cancel gap.
  const fenced = withControllerSessionTerminalizationFence(
    { controllerHome, repoId: repository.repoId },
    { workId: work.workId, actor: `runtime-maintenance-terminalize:${work.workId}` },
    () => {
      const current = getWorkContract({ controllerHome, repoId: repository.repoId }, work.workId);
      if (!current || isTerminalWorkContractStatus(current.status)) {
        return { ...candidate, applied: false, result: 'already_terminal' };
      }
      const authorityRefs = activeWorkAuthorityRefs(repository, controllerHome, current);
      if (authorityRefs.length > 0) {
        return {
          ...candidate,
          applied: false,
          result: `work_authority_became_active:${authorityRefs.join(',')}`,
        };
      }
      // Discovery and mutation are separated by an arbitrary Controller/MCP delay.
      // Re-probe the live worktree while the canonical ControllerSession fence is
      // held so neither a newer Controller claim nor a late source write can be
      // raced by stale maintenance terminalization.
      const source = inspectStaleWorkRepositorySource(repository, current);
      if (!source.safeToCancel) {
        return {
          ...candidate,
          path: source.path ?? candidate.path,
          safe: false,
          reason: staleWorkCandidateReason(source, staleWorkSemanticTerminalizationReady(current)),
          sourceState: source.state,
          disposition: 'source_preservation_required' as const,
          applied: false,
          result: `work_source_preserved:${source.state}`,
        };
      }
      const semanticReady = staleWorkSemanticTerminalizationReady(current);
      if (!semanticReady) {
        return {
          ...candidate,
          path: source.path ?? candidate.path,
          safe: false,
          reason: staleWorkCandidateReason(source, false),
          sourceState: source.state,
          disposition: 'semantic_completion_required' as const,
          applied: false,
          result: 'work_semantic_completion_required',
        };
      }
      transitionWorkContractPhase({ controllerHome, repoId: repository.repoId }, current.workId, {
        phase: 'cleanup',
        status: 'cancelled',
        state: 'skipped',
        summary: 'Cancelled by explicit full maintenance after the Work had already reached cleanup with prior semantic phases satisfied and no unique live repository source remained; durable evidence retained.',
        evidenceRefs: current.evidenceRefs,
      });
      return {
        ...candidate,
        path: source.path ?? candidate.path,
        safe: true,
        reason: staleWorkCandidateReason(source, true),
        sourceState: source.state,
        disposition: undefined,
        applied: true,
        result: 'work_contract_cancelled_evidence_retained',
      };
    },
  );
  if (!fenced.allowed) {
    const generation = fenced.owner?.claimGeneration;
    return {
      ...candidate,
      applied: false,
      result: `work_terminalization_fenced:${fenced.reason}${typeof generation === 'number' ? `:claim_generation=${generation}` : ''}`,
    };
  }
  return fenced.value;
}

function scanStaleEditSessionCandidates(
  repository: RuntimeMaintenanceRepository,
  controllerHome: string,
  options: Required<RuntimeMaintenanceOptions>,
): RuntimeMaintenanceCandidate[] {
  const nowMs = Date.now();
  return listEditSessions(repository.canonicalRoot, Math.min(options.maxCandidates * 3, 500))
    .filter((summary) => ['open', 'dirty', 'checked', 'check_failed'].includes(summary.status))
    .flatMap((summary) => {
      try {
        const session = reconcileEditSession(repository.canonicalRoot, summary.sessionId, {
          reviewer: 'runtime-maintenance',
          note: 'Reconciled during maintenance discovery; source files were not modified.',
        });
        if (['finalized', 'superseded', 'rolled_back'].includes(session.status)) return [];
        const updatedMs = Date.parse(session.updatedAt);
        const ageMinutes = Number.isFinite(updatedMs) ? Math.max(0, Math.floor((nowMs - updatedMs) / 60_000)) : 0;
        return [{ session, ageMinutes }];
      } catch {
        return [];
      }
    })
    .filter(({ ageMinutes }) => ageMinutes >= options.minAgeMinutes)
    .sort((left, right) => right.ageMinutes - left.ageMinutes)
    .slice(0, options.maxCandidates)
    .flatMap(({ session, ageMinutes }) => {
      const work = session.workId
        ? getWorkContract({ controllerHome, repoId: repository.repoId }, session.workId)
        : undefined;
      const terminalWork = Boolean(work && isTerminalWorkContractStatus(work.status));
      if (work && !terminalWork && activeWorkAuthorityRefs(repository, controllerHome, work).length > 0) {
        // The Edit Session inherits the live Work lifecycle authority. Reporting it
        // as stale maintenance debt while that authority is active would duplicate
        // ownership and can permanently block release readiness for valid long work.
        return [];
      }
      const contractFreeDirect = !session.workId;
      const safeToReconcile = terminalWork || contractFreeDirect;
      return [{
        kind: 'stale_edit_session' as const,
        id: session.sessionId,
        status: session.status,
        safe: safeToReconcile,
        reason: terminalWork
          ? 'Edit Session belongs to a terminal WorkContract; cleanup may reconcile metadata only and must refuse unique uncommitted source changes.'
          : contractFreeDirect
            ? 'Contract-free Direct Edit Session has no WorkContract by design; cleanup may reconcile metadata only and must refuse unique uncommitted source changes.'
            : 'Edit Session WorkContract is missing or still nonterminal without live lifecycle authority; active-session ownership must remain fenced.',
        ageMinutes,
        suggestedAction: 'full_maintenance_pass' as const,
        ownershipStatus: safeToReconcile ? 'explicit' as const : 'unknown' as const,
      }];
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
  const storage = safeRuntimeStorage(repository, controllerHome);
  const runtimeStorageRepair = previewRuntimeStorageRepair(coerceRepository(repository), controllerHome, {
    minAgeMinutes: normalized.minAgeMinutes,
    maxCandidates: normalized.maxCandidates,
  });
  const localJobCandidates = scanLocalJobCandidates(repository.canonicalRoot, normalized);
  const storageCandidates = runtimeStorageCandidates(storage.report);
  const tempCandidates = scanRuntimeTempCandidates(repository, normalized.maxCandidates);
  const staleWorkCandidates = scanStaleWorkContractCandidates(repository, controllerHome, normalized);
  const staleEditCandidates = scanStaleEditSessionCandidates(repository, controllerHome, normalized);
  const retainedWorktreeCandidates = scanRetainedWorktreeCandidates(repository, controllerHome, normalized.maxCandidates);
  const candidates = [...localJobCandidates, ...storageCandidates, ...staleWorkCandidates, ...staleEditCandidates, ...retainedWorktreeCandidates, ...tempCandidates].slice(0, normalized.maxCandidates);
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
      'Retained or unowned managed worktrees are review-only lifecycle blockers. Runtime maintenance never deletes or modifies their preserved implementation state.',
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

function quarantinePath(repoRoot: string, id: string): string {
  const stamp = now().replace(/[:.]/g, '-');
  return join(repoRoot, '.ai', 'harness', 'local-jobs-quarantine', `${stamp}-${safeId(id)}`);
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

function quarantineLocalJob(repoRoot: string, candidate: RuntimeMaintenanceCandidate): string {
  if (!candidate.path) throw new Error('LOCAL_JOB_PATH_MISSING');
  const root = localJobsRoot(repoRoot);
  if (!isWithin(root, candidate.path)) throw new Error('LOCAL_JOB_PATH_OUTSIDE_ROOT');
  const destination = quarantinePath(repoRoot, candidate.id);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(candidate.path, destination);
  return destination;
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
        return { ...candidate, applied: true, result: quarantineLocalJob(repository.canonicalRoot, candidate) };
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
      if (candidate.kind === 'stale_work_contract') {
        return applyStaleWorkContractMaintenanceCandidate(repository, controllerHome, candidate);
      }
      if (candidate.kind === 'stale_edit_session') {
        const cleaned = cleanupEditSession(repository.canonicalRoot, candidate.id, {
          reviewer: 'runtime-maintenance',
          note: 'Reconciled by explicit full maintenance after durable ownership became inactive; source files were not rolled back.',
        });
        const closed = ['finalized', 'superseded', 'rolled_back'].includes(cleaned.status);
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
    projection,
  };
}
