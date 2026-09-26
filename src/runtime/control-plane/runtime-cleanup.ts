import { execFileSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Dirent,
} from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { cleanupTerminalEditSessionRecords } from '../../cli/editing/edit-session';
import { listRepositories } from '../../cli/repositories/registry';
import { managedPathInside, managedWorktreeStorageRoot } from '../../cli/repositories/worktree-storage';
import { migrateManagedWorkspacePhysicalDependenciesToCanonical } from '../execution/managed-workspace';
import { cleanupStaleCodegraphLocators } from '../context/codegraph-cache-boundary';
import { listActiveLeases } from '../resources/leases/store';
import { cleanupScheduleOccurrenceHistory } from '../../../packages/kernel/scheduler/api/index';
import { isTerminalWorkContractStatus, readWorkContractStore } from '../../../packages/kernel/work/api/index';
import { assertOwnedResourceCleanupTarget, listOwnedResources, markOwnedResourceCleaned, type OwnedResource } from '../../../packages/kernel/identity/api/index';
import { appendJsonLine, readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { cleanupControllerReleaseHistory } from './release-retention';
import { cleanupWorkPreservationArtifacts } from './cleanup-artifact-retention';
import { cleanupCodegraphCaches, CODEGRAPH_CACHE_RETENTION_POLICY_VERSION } from './codegraph-cache-retention';
import { cleanupRetiredRepositoryNamespaces } from './repository-namespace-retention';
import { maintainControlPlaneDatabase, type ControlPlaneDatabaseMaintenanceReport } from './persistence/sqlite-store';
import { cleanupExpiredExperiences } from './persistence/experience-store';
import { reconcileOwnerlessWorkAuthorities } from './execution/work-authority-reconciler';
import {
  measureReclaimablePath,
  RUNTIME_LIFECYCLE_RETENTION_POLICY_VERSION,
} from './lifecycle-retention-metrics';
import {
  listReleaseSessions,
  releaseSessionCandidateIsRetired,
} from '../release/release-session';
import { removeRetiredCandidateExecutionLane } from '../root/runtime-lane';
import { observeRuntimeStatus } from '../root/status';

function numericSetting(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

const ORPHAN_WORKTREE_TTL_MS = numericSetting(
  process.env.FORGE_ORPHAN_WORKTREE_TTL_MS,
  6 * 60 * 60_000,
  60_000,
);
const TEMP_STATE_TTL_MS = numericSetting(
  process.env.FORGE_TEMP_STATE_TTL_MS,
  15 * 60_000,
  60_000,
);
const DEFAULT_SCAN_BUDGET = numericSetting(
  process.env.FORGE_RUNTIME_CLEANUP_SCAN_BUDGET,
  2_000,
  1,
);
const TEMP_SCAN_MAX_DEPTH = numericSetting(
  process.env.FORGE_RUNTIME_CLEANUP_MAX_DEPTH,
  10,
  1,
);

/** Terminal / abandoned runs that no longer need their worktree for integration/review. */
const WORKTREE_RELEASE_STATUSES = new Set([
  'failed',
  'cancelled',
  'timed_out',
  'orphaned',
  'stale',
  'succeeded',
  'completed',
]);

/** Runs whose cleanup was pending for longer than this threshold may have their
 *  worktrees released by the orphan reconciler. This matches the cleanup_pending
 *  / cleaning closure states that did not complete before the Daemon restarted. */
const CLEANUP_PENDING_RELEASE_MS = 3_600_000; // 1 hour

/** Closure states that indicate cleanup is complete or permanently unnecessary. */
const CLEANUP_TERMINAL_CLOSURE_STATES = new Set([
  'completed',
  'preserved',
  'cleanup_blocked',
]);

/**
 * High-cardinality permanent state directories. Cleanup only scans them one
 * level deep for stale `*.tmp` siblings and does not recurse further.
 */
const TEMP_SCAN_LEAF_DIR_NAMES = new Set([
  'records',
  'receipts',
  'events',
  'evidence',
  'edit-sessions',
  'indexes',
  'audit',
  'local-jobs',
  'runs',
  'schedules',
  'leases',
  'projections',
]);

const TEMP_SCAN_SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'worktrees',
]);

interface DaemonStateSnapshot {
  schemaVersion?: number;
  status?: string;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
  gatewaySeparated?: boolean;
  workerIsolation?: boolean;
}

interface AgentRunSnapshot {
  executionMode?: unknown;
  worktree?: unknown;
  worktreePath?: unknown;
  worktreeCleanedAt?: unknown;
  status?: unknown;
  workerPid?: unknown;
  agentPid?: unknown;
  launchPid?: unknown;
  lastHeartbeatAt?: unknown;
  integratedSessionId?: unknown;
  integratedAt?: unknown;
  closureState?: unknown;
  cleanupStartedAt?: unknown;
  cleanupFinishedAt?: unknown;
  changeOutcome?: unknown;
  branch?: unknown;
}

export interface RuntimeProcessSnapshot {
  alive: boolean;
  commandLine?: string;
}

export interface RuntimeCleanupOptions {
  reason?: RuntimeCleanupReport['reason'];
  nowMs?: number;
  protectedControllerPid?: number;
  maxEntries?: number;
  /** Global removal budget for one cycle; automatic cleanup defaults to 50. */
  maxRemovals?: number;
  /** Scheduler cleanup generation used to rotate removal priority without adding durable state. */
  periodicSequence?: number;
  /** Minimum age before an unreferenced finalized release/backup can be reclaimed. */
  releaseRetentionGraceMs?: number;
  /** Minimum age before an abandoned runtime .staging-* directory can be reclaimed. */
  stagingReleaseRetentionGraceMs?: number;
  /** Minimum age before a proven-redundant terminal Work preservation bundle can be reclaimed. */
  cleanupArtifactRetentionGraceMs?: number;
  /** Maximum age for terminal EditSession artifacts once no active Work owns them. */
  editSessionRetentionMs?: number;
  /** Count cap for newest terminal EditSession artifacts retained for local review/debugging. */
  editSessionMaxRetained?: number;
  /** Grace period before a non-Plan Work with no exact durable owner loses execution authority. */
  ownerlessWorkAuthorityGraceMs?: number;
  /** Minimum age before an unprotected Forge-owned CodeGraph cache can be rebuilt on demand and reclaimed. */
  codegraphCacheRetentionMs?: number;
  /** Grace before a removed repository may shed only explicit disposable Controller Home children. */
  repositoryNamespaceRetentionMs?: number;
  /** Minimum reclaimable SQLite free-page bytes before physical VACUUM is eligible. */
  sqliteVacuumMinReclaimableBytes?: number;
  /** Minimum reclaimable SQLite free-page ratio before physical VACUUM is eligible. */
  sqliteVacuumMinReclaimableRatio?: number;
  inspectProcess?: (pid: number) => RuntimeProcessSnapshot;
}

export interface RuntimeCleanupLifecycleClassMetrics {
  count: number;
  bytes: number;
  unknownByteCount: number;
}

export interface RuntimeCleanupLifecycleMetrics {
  /** Physical disposable resources actually reclaimed by this cleanup authority. */
  reclaimedCount: number;
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
  reclaimedByClass: Record<string, RuntimeCleanupLifecycleClassMetrics>;
  /** Semantic/execution authority records retired in place rather than physically deleted. */
  logicalRetiredCount: number;
  logicalRetiredByClass: Record<string, number>;
  protectedActiveCount: number;
  protectedByReason: Record<string, number>;
  blockerReasons: Record<string, number>;
}

export interface ReleaseSessionCandidatePhaseMetrics {
  observedCount: number;
  observedBytes: number;
  unknownObservedByteCount: number;
  retainedCount: number;
  reclaimableCount: number;
  removedCount: number;
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
}

export interface ReleaseSessionCandidateRetentionReport {
  inspected: number;
  observedCount: number;
  observedBytes: number;
  unknownObservedByteCount: number;
  retainedCount: number;
  eligible: number;
  attempted: number;
  removedPaths: string[];
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
  orphanDirectoryCount: number;
  invalidSessionFiles: string[];
  byPhase: Record<string, ReleaseSessionCandidatePhaseMetrics>;
  errors: string[];
  truncated: boolean;
}

export interface RuntimeCleanupReport {
  policyVersion: typeof RUNTIME_LIFECYCLE_RETENTION_POLICY_VERSION;
  at: string;
  reason: 'startup' | 'periodic' | 'manual';
  removedPidFiles: string[];
  skippedPidFiles: string[];
  removedWorktrees: string[];
  migratedDependencyPaths: string[];
  removedTemporaryPaths: string[];
  removedCleanupArtifactPaths: string[];
  removedReleasePaths: string[];
  releaseSessionCandidates: ReleaseSessionCandidateRetentionReport;
  removedScheduleOccurrencePaths: string[];
  removedScheduleDecisionPaths: string[];
  removedEditSessionPaths: string[];
  removedCodegraphLocatorPaths: string[];
  removedCodegraphCachePaths: string[];
  removedRepositoryNamespacePaths: string[];
  /** Physical SQLite checkpoint/compaction receipt; row lifecycle remains domain-owned. */
  sqliteMaintenance?: ControlPlaneDatabaseMaintenanceReport;
  /** Work retired only after exact per-Work liveness proved no durable continuation owner remains. */
  retiredOwnerlessWorkAuthorities: string[];
  skippedActiveWorktrees: string[];
  inspectedPaths: number;
  budgetExhausted: boolean;
  errors: string[];
  logPath: string;
  cycle: CleanupCycleSummary;
  lifecycleMetrics: RuntimeCleanupLifecycleMetrics;
}

export interface CleanupCycleSummary {
  scanned: number;
  eligible: number;
  attempted: number;
  removed: number;
  retained: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  budgetExhausted: boolean;
  skippedByReason: Record<string, number>;
  failedByType: Record<string, number>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface ScanBudget {
  remaining: number;
  inspected: number;
  exhausted: boolean;
}

interface RemovalBudget {
  remaining: number;
  exhausted: boolean;
}

interface MutableReclaimMetrics {
  reclaimedBytes: number;
  unknownReclaimedByteCount: number;
}

function emptyReclaimMetrics(): MutableReclaimMetrics {
  return { reclaimedBytes: 0, unknownReclaimedByteCount: 0 };
}

function addReclaimMeasurement(metrics: MutableReclaimMetrics, path: string): void {
  const measurement = measureReclaimablePath(path);
  if (measurement.complete) metrics.reclaimedBytes += measurement.bytes;
  else metrics.unknownReclaimedByteCount += 1;
}

type RemovalPhase = 'worktrees' | 'temporary' | 'artifacts' | 'scheduler' | 'edit_sessions' | 'caches' | 'repository_namespaces' | 'releases';
const REMOVAL_PHASES: readonly RemovalPhase[] = ['worktrees', 'temporary', 'artifacts', 'scheduler', 'edit_sessions', 'caches', 'repository_namespaces', 'releases'];

export function cleanupRemovalPhaseOrder(reason: RuntimeCleanupReport['reason'], sequence = 0): RemovalPhase[] {
  if (reason !== 'periodic') return [...REMOVAL_PHASES];
  const offset = ((Math.trunc(sequence) % REMOVAL_PHASES.length) + REMOVAL_PHASES.length) % REMOVAL_PHASES.length;
  // Periodic maintenance is a bounded shard, not a reordered full sweep.
  // Eight one-minute generations cover every removal class once while startup/manual
  // cleanup retains the complete all-phase contract.
  return [REMOVAL_PHASES[offset]!];
}

interface WorktreeReferences {
  referenced: Set<string>;
  unsafeRepositories: Set<string>;
  complete: boolean;
}

export function runtimeCleanupLogPath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'audit', 'runtime-cleanup.jsonl');
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function relativeHomePath(controllerHome: string, path: string): string {
  return relative(controllerHome, path).replace(/\\/g, '/');
}

function errorText(scope: string, error: unknown): string {
  return `${scope}: ${error instanceof Error ? error.message : String(error)}`;
}

function inspectProcessDefault(pid: number): RuntimeProcessSnapshot {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false };
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return { alive: false };
  }
  if (process.platform === 'win32') return { alive: true };
  try {
    const commandLine = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    }).trim();
    return { alive: true, commandLine: commandLine || undefined };
  } catch {
    return { alive: true };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`);
}

function commandReferencesControllerHome(commandLine: string, controllerHome: string): boolean {
  const homes = new Set([resolve(controllerHome), canonicalPath(controllerHome)]);
  return Array.from(homes).some((home) => {
    const quotedHome = escapeRegExp(home);
    return new RegExp(`--controller-home(?:=|\\s+)["']?${quotedHome}["']?(?=\\s|$)`).test(commandLine);
  });
}

export function expectedDaemonCommand(controllerHome: string, commandLine: string | undefined): boolean {
  if (!commandLine || !commandReferencesControllerHome(commandLine, controllerHome)) return false;
  // Legacy source/dev Controller processes used daemon-entry.ts/js. Immutable legacy releases
  // execute the bundled daemon.js artifact. Both identities are valid only when
  // the command carries the exact slot/root Controller Home above.
  return /(?:^|[\\/])(?:daemon-entry\.(?:ts|js)|daemon\.js)(?:\s|$)/.test(commandLine);
}

function updateDaemonStateForStalePid(controllerHome: string, stalePid: number | undefined, nowIso: string): void {
  const statePath = join(controllerHome, 'daemon', 'state.json');
  if (!existsSync(statePath)) return;
  try {
    const current = readJsonFile<DaemonStateSnapshot>(statePath);
    if (!['ready', 'starting'].includes(String(current.status ?? ''))) return;
    if (!stalePid && current.pid) return;
    if (stalePid && current.pid && current.pid !== stalePid) return;
    writeJsonAtomic(statePath, {
      ...current,
      schemaVersion: typeof current.schemaVersion === 'number' ? current.schemaVersion : 1,
      status: 'stopped',
      stoppedAt: nowIso,
    } satisfies DaemonStateSnapshot);
  } catch {
    // A malformed daemon state must not make cleanup destructive.
  }
}

function cleanupDaemonPidFile(
  controllerHome: string,
  nowIso: string,
  options: RuntimeCleanupOptions,
  errors: string[],
  removalBudget: RemovalBudget,
): { removed: string[]; skipped: string[]; reclaim: MutableReclaimMetrics } {
  const reclaim = emptyReclaimMetrics();
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  if (!existsSync(pidPath)) return { removed: [], skipped: [], reclaim };
  let parsedPid: number | undefined;
  try {
    const candidate = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    parsedPid = Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
  } catch (error) {
    errors.push(errorText('daemon/controller.pid read failed', error));
  }

  if (removalBudget.remaining <= 0) {
    removalBudget.exhausted = true;
    return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)], reclaim };
  }

  if (parsedPid) {
    const snapshot = (options.inspectProcess ?? inspectProcessDefault)(parsedPid);
    if (snapshot.alive) {
      if (parsedPid === options.protectedControllerPid || expectedDaemonCommand(controllerHome, snapshot.commandLine)) {
        return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)], reclaim };
      }
      if (!snapshot.commandLine) {
        errors.push(`daemon/controller.pid: live PID ${parsedPid} command identity is unavailable`);
        return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)], reclaim };
      }
      // PID reuse or an unrelated live process: remove only the stale reference.
      // Never signal a process whose daemon identity is not proven.
    }
  }

  addReclaimMeasurement(reclaim, pidPath);
  try {
    removalBudget.remaining -= 1;
    rmSync(pidPath, { force: true });
    updateDaemonStateForStalePid(controllerHome, parsedPid, nowIso);
    return { removed: [relativeHomePath(controllerHome, pidPath)], skipped: [], reclaim };
  } catch (error) {
    errors.push(errorText('daemon/controller.pid removal failed', error));
    return { removed: [], skipped: [], reclaim: emptyReclaimMetrics() };
  }
}

function visitDirectoryEntries(
  directory: string,
  budget: ScanBudget,
  errors: string[],
  visitor: (entry: Dirent) => void,
): void {
  if (budget.exhausted || !existsSync(directory)) return;
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(directory);
    while (true) {
      if (budget.remaining <= 0) {
        budget.exhausted = true;
        break;
      }
      const entry = handle.readSync();
      if (!entry) break;
      budget.remaining -= 1;
      budget.inspected += 1;
      visitor(entry);
      if (budget.exhausted) break;
    }
  } catch (error) {
    errors.push(errorText(`scan ${directory}`, error));
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // The directory may already be closed after reaching EOF.
    }
  }
}

function createScanBudget(maxEntries: number): ScanBudget {
  return {
    remaining: numericSetting(String(maxEntries), DEFAULT_SCAN_BUDGET, 1),
    inspected: 0,
    exhausted: false,
  };
}

function emptyReleaseSessionCandidatePhaseMetrics(): ReleaseSessionCandidatePhaseMetrics {
  return {
    observedCount: 0,
    observedBytes: 0,
    unknownObservedByteCount: 0,
    retainedCount: 0,
    reclaimableCount: 0,
    removedCount: 0,
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
  };
}

function emptyReleaseSessionCandidateRetentionReport(): ReleaseSessionCandidateRetentionReport {
  return {
    inspected: 0,
    observedCount: 0,
    observedBytes: 0,
    unknownObservedByteCount: 0,
    retainedCount: 0,
    eligible: 0,
    attempted: 0,
    removedPaths: [],
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
    orphanDirectoryCount: 0,
    invalidSessionFiles: [],
    byPhase: {},
    errors: [],
    truncated: false,
  };
}

function candidatePhaseMetrics(
  report: ReleaseSessionCandidateRetentionReport,
  phase: string,
): ReleaseSessionCandidatePhaseMetrics {
  return report.byPhase[phase] ??= emptyReleaseSessionCandidatePhaseMetrics();
}

/**
 * Physical retention only. ReleaseSession phase transitions and Candidate
 * service retirement remain owned by standalone Recovery under its operation
 * lock. Maintenance consumes durable phase evidence and the live Runtime owner
 * projection, then applies the existing path-fenced Candidate removal.
 */
function cleanupReleaseSessionCandidateLanes(
  controllerHome: string,
  input: {
    maxEntries: number;
    sequence: number;
    removalBudget: RemovalBudget;
    skippedByReason: Record<string, number>;
  },
): ReleaseSessionCandidateRetentionReport {
  const report = emptyReleaseSessionCandidateRetentionReport();
  const candidateRoot = resolve(dirname(controllerHome), 'candidate-runtime-lanes');
  const inventory = listReleaseSessions(controllerHome, { maxEntries: input.maxEntries });
  report.invalidSessionFiles = [...inventory.invalidSessionFiles].sort();
  report.inspected += inventory.inspected;
  report.truncated = inventory.truncated;
  if (inventory.truncated) {
    input.skippedByReason.release_session_candidate_inventory_truncated =
      (input.skippedByReason.release_session_candidate_inventory_truncated ?? 0) + 1;
  }
  if (inventory.invalidSessionFiles.length > 0) {
    input.skippedByReason.release_session_candidate_authority_invalid =
      (input.skippedByReason.release_session_candidate_authority_invalid ?? 0) + inventory.invalidSessionFiles.length;
    report.errors.push(...inventory.invalidSessionFiles.map((name) => `invalid ReleaseSession authority: ${name}`));
  }

  const measurementBudget = createScanBudget(input.maxEntries);
  const knownCandidateHomes = new Set<string>();
  const sessions = [...inventory.sessions].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  if (sessions.length > 1) {
    const offset = ((Math.trunc(input.sequence) % sessions.length) + sessions.length) % sessions.length;
    sessions.push(...sessions.splice(0, offset));
  }

  for (const session of sessions) {
    const candidateHome = resolve(session.candidate.controllerHome);
    if (resolve(dirname(candidateHome)) !== candidateRoot || basename(candidateHome) !== session.sessionId) {
      input.skippedByReason.release_session_candidate_path_invalid =
        (input.skippedByReason.release_session_candidate_path_invalid ?? 0) + 1;
      report.errors.push(`${session.sessionId}: RUNTIME_CANDIDATE_CLEANUP_PATH_INVALID`);
      continue;
    }
    knownCandidateHomes.add(candidateHome);
    if (!existsSync(candidateHome)) continue;

    const phase = candidatePhaseMetrics(report, session.phase);
    report.observedCount += 1;
    phase.observedCount += 1;

    let measuredBytes: number | undefined;
    let measurementComplete = false;
    if (measurementBudget.remaining > 0) {
      const measurement = measureReclaimablePath(candidateHome, Math.min(256, measurementBudget.remaining));
      measurementBudget.remaining = Math.max(0, measurementBudget.remaining - measurement.entries);
      measurementBudget.inspected += measurement.entries;
      measuredBytes = measurement.bytes;
      measurementComplete = measurement.complete;
    }
    if (measurementComplete && measuredBytes !== undefined) {
      report.observedBytes += measuredBytes;
      phase.observedBytes += measuredBytes;
    } else {
      report.unknownObservedByteCount += 1;
      phase.unknownObservedByteCount += 1;
    }

    if (!releaseSessionCandidateIsRetired(session)) {
      report.retainedCount += 1;
      phase.retainedCount += 1;
      input.skippedByReason.release_session_candidate_resumable =
        (input.skippedByReason.release_session_candidate_resumable ?? 0) + 1;
      continue;
    }

    report.eligible += 1;
    phase.reclaimableCount += 1;
    try {
      if (observeRuntimeStatus(candidateHome).running) {
        report.retainedCount += 1;
        phase.retainedCount += 1;
        input.skippedByReason.release_session_candidate_active_owner =
          (input.skippedByReason.release_session_candidate_active_owner ?? 0) + 1;
        continue;
      }
    } catch (error) {
      report.retainedCount += 1;
      phase.retainedCount += 1;
      report.errors.push(errorText(`${session.sessionId} Candidate Runtime observation`, error));
      input.skippedByReason.release_session_candidate_owner_unknown =
        (input.skippedByReason.release_session_candidate_owner_unknown ?? 0) + 1;
      continue;
    }

    if (input.removalBudget.remaining <= 0) {
      input.removalBudget.exhausted = true;
      report.retainedCount += 1;
      phase.retainedCount += 1;
      input.skippedByReason.release_session_candidate_cleanup_budget_exhausted =
        (input.skippedByReason.release_session_candidate_cleanup_budget_exhausted ?? 0) + 1;
      continue;
    }

    report.attempted += 1;
    input.removalBudget.remaining -= 1;
    try {
      removeRetiredCandidateExecutionLane(session.stable, session.candidate);
      const relativePath = `candidate-runtime-lanes/${session.sessionId}`;
      report.removedPaths.push(relativePath);
      phase.removedCount += 1;
      if (measurementComplete && measuredBytes !== undefined) {
        report.reclaimedBytes += measuredBytes;
        phase.reclaimedBytes += measuredBytes;
      } else {
        report.unknownReclaimedByteCount += 1;
        phase.unknownReclaimedByteCount += 1;
      }
    } catch (error) {
      report.retainedCount += 1;
      phase.retainedCount += 1;
      report.errors.push(errorText(`${session.sessionId} Candidate lane removal`, error));
    }
  }

  // A directory without readable ReleaseSession authority is visible debt, not
  // deletion authority. Keep it and report it so Recovery can reconcile it.
  if (!inventory.truncated && existsSync(candidateRoot)) {
    const rootBudget = createScanBudget(input.maxEntries);
    visitDirectoryEntries(candidateRoot, rootBudget, report.errors, (entry) => {
      if (!entry.isDirectory()) return;
      const path = resolve(candidateRoot, entry.name);
      if (knownCandidateHomes.has(path)) return;
      report.observedCount += 1;
      report.retainedCount += 1;
      report.orphanDirectoryCount += 1;
      report.unknownObservedByteCount += 1;
      const phase = candidatePhaseMetrics(report, 'authority_missing');
      phase.observedCount += 1;
      phase.retainedCount += 1;
      phase.unknownObservedByteCount += 1;
      input.skippedByReason.release_session_candidate_authority_missing =
        (input.skippedByReason.release_session_candidate_authority_missing ?? 0) + 1;
    });
    report.inspected += rootBudget.inspected;
    if (rootBudget.exhausted) report.truncated = true;
  }

  report.inspected += measurementBudget.inspected;
  report.removedPaths.sort();
  report.errors.sort();
  return report;
}

function shouldProtectWorktreeReference(meta: AgentRunSnapshot, nowMs: number): boolean {
  if (meta.executionMode !== 'worktree' || meta.worktreeCleanedAt) return false;
  const status = typeof meta.status === 'string' ? meta.status.trim().toLowerCase() : '';
  // Explicit terminal failure/cancel statuses no longer need the worktree.
  if (status && WORKTREE_RELEASE_STATUSES.has(status)) {
    // For succeeded/completed: also verify closure state is terminal before releasing.
    if (status === 'succeeded' || status === 'completed') {
      const closureState = typeof meta.closureState === 'string'
        ? meta.closureState.trim().toLowerCase()
        : '';
      // Terminal closure: cleanup is done or blocked permanently — release.
      if (CLEANUP_TERMINAL_CLOSURE_STATES.has(closureState)) return false;
      // No closure recorded and run is old enough: treat as abandoned cleanup.
      if (!closureState) {
        const finishedAt = typeof meta.integratedAt === 'string'
          ? new Date(meta.integratedAt).getTime()
          : 0;
        if (finishedAt > 0 && nowMs - finishedAt > CLEANUP_PENDING_RELEASE_MS) return false;
        return true;
      }
      // cleanup_pending or cleaning — treat as abandoned after threshold.
      if (closureState === 'cleanup_pending' || closureState === 'cleaning') {
        const cleanupStartedAt = typeof meta.cleanupStartedAt === 'string'
          ? new Date(meta.cleanupStartedAt).getTime()
          : 0;
        const startedAt = cleanupStartedAt > 0 ? cleanupStartedAt
          : typeof meta.integratedAt === 'string' ? new Date(meta.integratedAt).getTime() : 0;
        if (startedAt > 0 && nowMs - startedAt > CLEANUP_PENDING_RELEASE_MS) return false;
        return true;
      }
      // Other non-terminal closure states (integration_pending, etc.) — still protect.
      return true;
    }
    // Non-succeeded terminal statuses: release immediately.
    return false;
  }
  // Missing or unknown lifecycle state fails closed because it may represent an
  // interrupted integration with unique uncommitted work still in the worktree.
  return true;
}

function collectReferencedWorktrees(
  controllerHome: string,
  budget: ScanBudget,
  errors: string[],
  nowMs: number,
): WorktreeReferences {
  const referenced = new Set<string>();
  const unsafeRepositories = new Set<string>();
  const repositoriesRoot = join(controllerHome, 'repositories');
  visitDirectoryEntries(repositoriesRoot, budget, errors, (repoEntry) => {
    if (!repoEntry.isDirectory()) return;
    const repoId = repoEntry.name;
    const runsRoot = join(repositoriesRoot, repoId, 'runs');
    visitDirectoryEntries(runsRoot, budget, errors, (runEntry) => {
      if (!runEntry.isDirectory()) return;
      const metaPath = join(runsRoot, runEntry.name, 'meta.json');
      if (!existsSync(metaPath)) {
        unsafeRepositories.add(repoId);
        return;
      }
      try {
        const meta = readJsonFile<AgentRunSnapshot>(metaPath);
        if (!shouldProtectWorktreeReference(meta, nowMs)) return;
        const worktree = typeof meta.worktree === 'string' && meta.worktree.trim()
          ? meta.worktree.trim()
          : typeof meta.worktreePath === 'string' && meta.worktreePath.trim()
            ? meta.worktreePath.trim()
            : undefined;
        if (!worktree) {
          // Missing path on a still-protected Run is unsafe only when the Run
          // still expects a worktree (active / succeeded / waiting).
          unsafeRepositories.add(repoId);
          return;
        }
        // Protect active Runs and succeeded Runs awaiting integration/cleanup.
        referenced.add(canonicalPath(worktree));
      } catch (error) {
        unsafeRepositories.add(repoId);
        errors.push(errorText(`unreadable Run metadata ${relativeHomePath(controllerHome, metaPath)}`, error));
      }
    });
    if (budget.exhausted) unsafeRepositories.add(repoId);
  });
  return { referenced, unsafeRepositories, complete: !budget.exhausted };
}

function resolveWorktreeSourceRoot(worktreePath: string): string | undefined {
  const gitMarker = join(worktreePath, '.git');
  if (!existsSync(gitMarker)) return undefined;
  try {
    const stats = lstatSync(gitMarker);
    if (stats.isDirectory()) return undefined;
    const content = readFileSync(gitMarker, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (!match) return undefined;
    const gitDir = resolve(worktreePath, match[1].trim()).replace(/\\/g, '/');
    const marker = '/.git/worktrees/';
    const index = gitDir.lastIndexOf(marker);
    if (index <= 0) return undefined;
    return gitDir.slice(0, index);
  } catch {
    return undefined;
  }
}

function removeOrphanWorktreeDirectory(path: string, errors: string[], relativePath: string): boolean {
  const sourceRoot = resolveWorktreeSourceRoot(path);
  if (sourceRoot) {
    try {
      execFileSync('git', ['-C', sourceRoot, 'worktree', 'remove', '--force', path], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
      if (!existsSync(path)) return true;
    } catch {
      // Fall through to filesystem removal + prune.
    }
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    errors.push(errorText(`worktree cleanup ${relativePath}`, error));
    return false;
  }
  if (sourceRoot) {
    try {
      execFileSync('git', ['-C', sourceRoot, 'worktree', 'prune', '--expire', 'now'], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      // Prune is best-effort; directory removal is the primary goal.
    }
  }
  return !existsSync(path);
}

function cleanupOrphanWorktrees(
  controllerHome: string,
  references: WorktreeReferences,
  budget: ScanBudget,
  nowMs: number,
  errors: string[],
  removalBudget: RemovalBudget,
): { removed: string[]; skippedActive: string[]; skippedByReason: Record<string, number>; reclaim: MutableReclaimMetrics } {
  const removed: string[] = [];
  const skippedActive: string[] = [];
  const reclaim = emptyReclaimMetrics();
  const skippedByReason: Record<string, number> = {};
  const skip = (reason: string): void => { skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1; };
  const ownedWorktreesByPath = new Map<string, OwnedResource>();
  for (const resource of listOwnedResources(controllerHome, { kind: 'worktree', status: 'active' })) {
    if (resource.cleanupCapable !== true || !resource.targetRef?.trim()) continue;
    ownedWorktreesByPath.set(canonicalPath(resource.targetRef), resource);
  }
  const repositoriesRoot = join(controllerHome, 'repositories');
  visitDirectoryEntries(repositoriesRoot, budget, errors, (repoEntry) => {
    if (!repoEntry.isDirectory()) return;
    const repoId = repoEntry.name;
    const worktreesRoot = join(repositoriesRoot, repoId, 'worktrees');
    visitDirectoryEntries(worktreesRoot, budget, errors, (entry) => {
      if (!entry.isDirectory()) return;
      const path = join(worktreesRoot, entry.name);
      const relativePath = relativeHomePath(controllerHome, path);
      const canonical = canonicalPath(path);
      if (!references.complete || references.unsafeRepositories.has(repoId) || references.referenced.has(canonical)) {
        skippedActive.push(relativePath);
        skip(references.referenced.has(canonical) ? 'active_owner' : 'unknown_ownership');
        return;
      }
      const ownedResource = ownedWorktreesByPath.get(canonical);
      if (!ownedResource) {
        skippedActive.push(relativePath);
        skip('owned_resource_missing');
        return;
      }
      try {
        try {
          assertOwnedResourceCleanupTarget(controllerHome, {
            resourceId: ownedResource.resourceId,
            kind: 'worktree',
            targetRef: path,
          });
        } catch (error) {
          skippedActive.push(relativePath);
          skip('owned_resource_identity_mismatch');
          errors.push(errorText(`owned worktree cleanup fence ${relativePath}`, error));
          return;
        }
        if (nowMs - lstatSync(path).mtimeMs < ORPHAN_WORKTREE_TTL_MS) {
          skip('ttl_not_expired');
          return;
        }
        if (removalBudget.remaining <= 0) {
          removalBudget.exhausted = true;
          skip('cleanup_budget_exhausted');
          return;
        }
        removalBudget.remaining -= 1;
        const measurement = measureReclaimablePath(path);
        if (removeOrphanWorktreeDirectory(path, errors, relativePath)) {
          removed.push(relativePath);
          markOwnedResourceCleaned(controllerHome, ownedResource.resourceId, 'forge:runtime-orphan-worktree-cleanup');
          if (measurement.complete) reclaim.reclaimedBytes += measurement.bytes;
          else reclaim.unknownReclaimedByteCount += 1;
        }
      } catch (error) {
        errors.push(errorText(`worktree cleanup ${relativePath}`, error));
      }
    });
  });
  return { removed, skippedActive, skippedByReason, reclaim };
}

function cleanupManagedWorktreeDependencyCopies(
  controllerHome: string,
  budget: ScanBudget,
  errors: string[],
  removalBudget: RemovalBudget,
): { migrated: string[]; skippedByReason: Record<string, number> } {
  const migrated: string[] = [];
  const skippedByReason: Record<string, number> = {};
  const skip = (reason: string): void => { skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1; };
  let repositories;
  try {
    repositories = listRepositories(controllerHome, { includeRemoved: true });
  } catch (error) {
    errors.push(errorText('managed dependency repository inventory', error));
    return { migrated, skippedByReason };
  }
  let storageRoot: string;
  try {
    storageRoot = managedWorktreeStorageRoot(controllerHome, repositories);
  } catch (error) {
    errors.push(errorText('managed dependency storage authority', error));
    return { migrated, skippedByReason };
  }
  for (const repository of repositories) {
    const activeLeases = listActiveLeases(controllerHome, repository.repoId);
    for (const checkout of repository.checkouts) {
      if (budget.remaining <= 0) { budget.exhausted = true; return { migrated, skippedByReason }; }
      budget.remaining -= 1;
      budget.inspected += 1;
      if (!checkout.worktree || checkout.lifecycle === 'removed' || checkout.lifecycle === 'archived') continue;
      const root = checkout.canonicalRoot;
      if (!existsSync(root) || !managedPathInside(storageRoot, root)) { skip('dependency_outside_managed_authority'); continue; }
      const dependencyPath = join(root, 'node_modules');
      if (!existsSync(dependencyPath)) continue;
      let dependencyStats;
      try { dependencyStats = lstatSync(dependencyPath); } catch (error) { errors.push(errorText(`managed dependency stat ${root}`, error)); continue; }
      if (dependencyStats.isSymbolicLink()) continue;
      if (!dependencyStats.isDirectory()) { skip('dependency_path_not_directory'); continue; }
      if (activeLeases.some((lease) => lease.checkoutId === checkout.checkoutId || lease.resourceKey === `workspace:${checkout.checkoutId}`)) {
        skip('dependency_active_owner');
        continue;
      }
      if (removalBudget.remaining <= 0) { removalBudget.exhausted = true; skip('cleanup_budget_exhausted'); continue; }
      try {
        const result = migrateManagedWorkspacePhysicalDependenciesToCanonical(root);
        if (!result) { skip('dependency_not_reusable'); continue; }
        removalBudget.remaining -= 1;
        migrated.push(relativeHomePath(controllerHome, dependencyPath));
      } catch (error) {
        errors.push(errorText(`managed dependency migration ${root}`, error));
      }
    }
  }
  return { migrated, skippedByReason };
}

function worktreeContentPath(relativePath: string): boolean {
  return /^repositories\/[^/]+\/worktrees(?:\/|$)/.test(relativePath);
}

function removeStaleTempEntry(
  path: string,
  relativePath: string,
  isDirectory: boolean,
  mtimeMs: number,
  nowMs: number,
  removed: string[],
  errors: string[],
  removalBudget: RemovalBudget,
  skippedByReason: Record<string, number>,
  reclaim: MutableReclaimMetrics,
): void {
  if (nowMs - mtimeMs < TEMP_STATE_TTL_MS) {
    skippedByReason.ttl_not_expired = (skippedByReason.ttl_not_expired ?? 0) + 1;
    return;
  }
  if (removalBudget.remaining <= 0) {
    removalBudget.exhausted = true;
    skippedByReason.cleanup_budget_exhausted = (skippedByReason.cleanup_budget_exhausted ?? 0) + 1;
    return;
  }
  const measurement = measureReclaimablePath(path);
  try {
    removalBudget.remaining -= 1;
    rmSync(path, { recursive: isDirectory, force: true });
    removed.push(relativePath);
    if (measurement.complete) reclaim.reclaimedBytes += measurement.bytes;
    else reclaim.unknownReclaimedByteCount += 1;
  } catch (error) {
    errors.push(errorText(`temp-state cleanup ${relativePath}`, error));
  }
}

function cleanupTemporaryStatePaths(
  controllerHome: string,
  budget: ScanBudget,
  nowMs: number,
  errors: string[],
  removalBudget: RemovalBudget,
  skippedByReason: Record<string, number>,
): { removed: string[]; reclaim: MutableReclaimMetrics } {
  const removed: string[] = [];
  const reclaim = emptyReclaimMetrics();
  const visit = (directory: string, depth: number, leafOnly = false): void => {
    if (budget.exhausted || depth > TEMP_SCAN_MAX_DEPTH) return;
    visitDirectoryEntries(directory, budget, errors, (entry) => {
      const path = join(directory, entry.name);
      const relativePath = relativeHomePath(controllerHome, path);
      if (worktreeContentPath(relativePath)) return;
      if (entry.isDirectory() && TEMP_SCAN_SKIP_DIR_NAMES.has(entry.name)) return;

      let stats;
      try {
        stats = lstatSync(path);
      } catch (error) {
        errors.push(errorText(`temp-state stat ${relativePath}`, error));
        return;
      }

      if (entry.name.endsWith('.tmp')) {
        removeStaleTempEntry(path, relativePath, entry.isDirectory(), stats.mtimeMs, nowMs, removed, errors, removalBudget, skippedByReason, reclaim);
        return;
      }

      if (!entry.isDirectory() || leafOnly) return;

      // High-cardinality permanent state: only look for sibling *.tmp files.
      if (TEMP_SCAN_LEAF_DIR_NAMES.has(entry.name)) {
        visit(path, depth + 1, true);
        return;
      }
      visit(path, depth + 1, false);
    });
  };

  // Only known runtime-state roots are scanned. Worktree contents and other
  // high-volume permanent trees are bounded above so periodic cleanup cannot
  // burn its entire budget walking historical job records.
  visit(join(controllerHome, 'daemon'), 0);
  visit(join(controllerHome, 'repositories'), 0);
  return { removed, reclaim };
}

function shouldPersistCleanupAudit(report: RuntimeCleanupReport): boolean {
  // Avoid unbounded audit growth from no-op periodic passes that only report
  // budgetExhausted, skippedActiveWorktrees, or a live protected PID skip.
  const hadMutations = Boolean(
    report.removedPidFiles.length
    || report.removedWorktrees.length
    || report.migratedDependencyPaths.length
    || report.removedTemporaryPaths.length
    || report.removedCleanupArtifactPaths.length
    || report.removedReleasePaths.length
    || report.releaseSessionCandidates.removedPaths.length
    || report.removedCodegraphLocatorPaths.length
    || report.removedCodegraphCachePaths.length
    || report.removedRepositoryNamespacePaths.length
    || report.sqliteMaintenance?.vacuumed
    || report.sqliteMaintenance?.skippedReason === 'database_busy'
    || report.retiredOwnerlessWorkAuthorities.length,
  );
  if (hadMutations || report.errors.length) return true;
  // Startup/manual may record defensive skips (live PID protected, budget).
  if (report.reason === 'periodic') return false;
  return Boolean(report.skippedPidFiles.length || report.budgetExhausted);
}

export function cleanupControllerRuntimeState(
  controllerHome: string,
  options: RuntimeCleanupOptions = {},
): RuntimeCleanupReport {
  const home = ensureControllerHome(controllerHome);
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const maxEntries = numericSetting(String(options.maxEntries ?? DEFAULT_SCAN_BUDGET), DEFAULT_SCAN_BUDGET, 1);
  const removalBudget: RemovalBudget = {
    remaining: numericSetting(String(options.maxRemovals ?? 50), 50, 1),
    exhausted: false,
  };
  // Separate phase budgets so a huge permanent-state tree cannot starve
  // worktree reference collection or orphan worktree removal.
  const referenceBudget = createScanBudget(maxEntries);
  const worktreeBudget = createScanBudget(maxEntries);
  const dependencyBudget = createScanBudget(maxEntries);
  const tempBudget = createScanBudget(maxEntries);
  const schedulerBudget = createScanBudget(maxEntries);
  const editSessionBudget = createScanBudget(maxEntries);
  const errors: string[] = [];
  const skippedByReason: Record<string, number> = {};
  const sequence = options.periodicSequence ?? Math.floor(nowMs / 60_000);
  const removalPhases = cleanupRemovalPhaseOrder(options.reason ?? 'manual', sequence);
  const periodic = (options.reason ?? 'manual') === 'periodic';
  const retiredOwnerlessWorkAuthorities: string[] = [];
  if (!periodic || removalPhases.includes('repository_namespaces')) try {
    for (const repository of listRepositories(home, { includeRemoved: true })) {
      const ownerless = reconcileOwnerlessWorkAuthorities({
        controllerHome: home,
        repoId: repository.repoId,
        nowMs,
        graceMs: options.ownerlessWorkAuthorityGraceMs,
      });
      retiredOwnerlessWorkAuthorities.push(...ownerless.workIds.map((workId) => `${repository.repoId}:${workId}`));
      Object.entries(ownerless.skippedByReason).forEach(([key, value]) => {
        skippedByReason[`ownerless_work_${key}`] = (skippedByReason[`ownerless_work_${key}`] ?? 0) + value;
      });
    }
  } catch (error) {
    errors.push(errorText('Work authority reconciliation', error));
  }
  const pidFiles = cleanupDaemonPidFile(home, nowIso, options, errors, removalBudget);
  const references: WorktreeReferences = (!periodic || removalPhases.includes('worktrees'))
    ? collectReferencedWorktrees(home, referenceBudget, errors, nowMs)
    : { referenced: new Set<string>(), unsafeRepositories: new Set<string>(), complete: true };
  let worktrees: ReturnType<typeof cleanupOrphanWorktrees> | undefined;
  let dependencyCleanup: ReturnType<typeof cleanupManagedWorktreeDependencyCopies> | undefined;
  let temporaryCleanup: ReturnType<typeof cleanupTemporaryStatePaths> | undefined;
  let artifactRetention: ReturnType<typeof cleanupWorkPreservationArtifacts> | undefined;
  let releaseRetention: ReturnType<typeof cleanupControllerReleaseHistory> | undefined;
  let releaseSessionCandidates: ReleaseSessionCandidateRetentionReport | undefined;
  let codegraphRetention: ReturnType<typeof cleanupCodegraphCaches> | undefined;
  let repositoryNamespaceRetention: ReturnType<typeof cleanupRetiredRepositoryNamespaces> | undefined;
  const removedCodegraphLocatorPaths: string[] = [];
  let codegraphLocatorInspected = 0;
  let codegraphLocatorRetained = 0;
  const schedulerHistory = {
    removedOccurrencePaths: [] as string[],
    removedDecisionPaths: [] as string[],
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
    inspected: 0,
    eligible: 0,
    attempted: 0,
    retained: 0,
    errors: [] as string[],
  };
  const editSessionHistory = {
    removedPaths: [] as string[],
    reclaimedBytes: 0,
    unknownReclaimedByteCount: 0,
    inspected: 0,
    eligible: 0,
    attempted: 0,
    retained: 0,
    errors: [] as string[],
  };
  for (const phase of removalPhases) {
    if (phase === 'worktrees') {
      dependencyCleanup = cleanupManagedWorktreeDependencyCopies(home, dependencyBudget, errors, removalBudget);
      Object.entries(dependencyCleanup.skippedByReason).forEach(([key, value]) => { skippedByReason[key] = (skippedByReason[key] ?? 0) + value; });
      worktrees = cleanupOrphanWorktrees(home, references, worktreeBudget, nowMs, errors, removalBudget);
      Object.entries(worktrees.skippedByReason).forEach(([key, value]) => { skippedByReason[key] = (skippedByReason[key] ?? 0) + value; });
      continue;
    }
    if (phase === 'temporary') {
      temporaryCleanup = cleanupTemporaryStatePaths(home, tempBudget, nowMs, errors, removalBudget, skippedByReason);
      continue;
    }
    if (phase === 'artifacts') {
      if (removalBudget.remaining > 0) {
        try {
          const removed = cleanupExpiredExperiences(home, new Date(nowMs).toISOString(), Math.min(100, removalBudget.remaining));
          removalBudget.remaining -= removed;
        } catch (error) { errors.push(`experience-retention: ${error instanceof Error ? error.message : 'failed'}`); }
      }
      artifactRetention = cleanupWorkPreservationArtifacts(home, {
        nowMs,
        graceMs: options.cleanupArtifactRetentionGraceMs,
        maxEntries,
        maxRemovals: removalBudget.remaining,
      });
      removalBudget.remaining = Math.max(0, removalBudget.remaining - artifactRetention.attempted);
      if (artifactRetention.budgetExhausted) removalBudget.exhausted = true;
      Object.entries(artifactRetention.skippedByReason).forEach(([key, value]) => {
        skippedByReason[`cleanup_artifact_${key}`] = (skippedByReason[`cleanup_artifact_${key}`] ?? 0) + value;
      });
      errors.push(...artifactRetention.errors.map((error) => `cleanup-artifact ${error}`));
      continue;
    }
    if (phase === 'scheduler') {
      for (const repository of listRepositories(home, { includeRemoved: true })) {
        if (schedulerBudget.remaining <= 0 || removalBudget.remaining <= 0) {
          if (schedulerBudget.remaining <= 0) schedulerBudget.exhausted = true;
          if (removalBudget.remaining <= 0) removalBudget.exhausted = true;
          break;
        }
        const retained = cleanupScheduleOccurrenceHistory(home, repository.repoId, {
          maxEntries: schedulerBudget.remaining,
          maxRemovals: removalBudget.remaining,
        });
        schedulerBudget.remaining = Math.max(0, schedulerBudget.remaining - retained.inspected);
        schedulerBudget.inspected += retained.inspected;
        if (retained.budgetExhausted && schedulerBudget.remaining <= 0) schedulerBudget.exhausted = true;
        removalBudget.remaining = Math.max(0, removalBudget.remaining - retained.attempted);
        if (retained.budgetExhausted && removalBudget.remaining <= 0) removalBudget.exhausted = true;
        schedulerHistory.inspected += retained.inspected;
        schedulerHistory.eligible += retained.eligible;
        schedulerHistory.attempted += retained.attempted;
        schedulerHistory.retained += retained.retained;
        schedulerHistory.reclaimedBytes += retained.reclaimedBytes;
        schedulerHistory.unknownReclaimedByteCount += retained.unknownReclaimedByteCount;
        schedulerHistory.removedOccurrencePaths.push(...retained.removedOccurrencePaths.map((path) => `repositories/${repository.repoId}/schedules/${path}`));
        schedulerHistory.removedDecisionPaths.push(...retained.removedDecisionPaths.map((path) => `repositories/${repository.repoId}/schedules/${path}`));
        Object.entries(retained.skippedByReason).forEach(([key, value]) => {
          skippedByReason[`scheduler_${key}`] = (skippedByReason[`scheduler_${key}`] ?? 0) + value;
        });
        schedulerHistory.errors.push(...retained.errors.map((error) => `${repository.repoId}:${error}`));
      }
      errors.push(...schedulerHistory.errors.map((error) => `scheduler-history ${error}`));
      continue;
    }
    if (phase === 'edit_sessions') {
      for (const repository of listRepositories(home, { includeRemoved: true })) {
        if (editSessionBudget.remaining <= 0 || removalBudget.remaining <= 0) {
          if (editSessionBudget.remaining <= 0) editSessionBudget.exhausted = true;
          if (removalBudget.remaining <= 0) removalBudget.exhausted = true;
          break;
        }
        let protectedWorkIds: string[];
        try {
          protectedWorkIds = readWorkContractStore({ controllerHome: home, repoId: repository.repoId }).contracts
            .filter((contract) => !isTerminalWorkContractStatus(contract.status))
            .map((contract) => contract.workId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skippedByReason.edit_session_work_authority_unavailable = (skippedByReason.edit_session_work_authority_unavailable ?? 0) + 1;
          editSessionHistory.errors.push(`${repository.repoId}:work_authority_unavailable:${message}`);
          continue;
        }
        const retained = cleanupTerminalEditSessionRecords(repository.canonicalRoot, {
          nowMs,
          retentionMs: options.editSessionRetentionMs,
          maxRetained: options.editSessionMaxRetained,
          maxEntries: editSessionBudget.remaining,
          maxRemovals: removalBudget.remaining,
          sequence,
          protectedWorkIds,
        });
        editSessionBudget.remaining = Math.max(0, editSessionBudget.remaining - retained.inspected);
        editSessionBudget.inspected += retained.inspected;
        if (retained.budgetExhausted && editSessionBudget.remaining <= 0) editSessionBudget.exhausted = true;
        removalBudget.remaining = Math.max(0, removalBudget.remaining - retained.attempted);
        if (retained.budgetExhausted && removalBudget.remaining <= 0) removalBudget.exhausted = true;
        editSessionHistory.inspected += retained.inspected;
        editSessionHistory.eligible += retained.eligible;
        editSessionHistory.attempted += retained.attempted;
        editSessionHistory.retained += retained.retained;
        editSessionHistory.reclaimedBytes += retained.reclaimedBytes;
        editSessionHistory.unknownReclaimedByteCount += retained.unknownReclaimedByteCount;
        editSessionHistory.removedPaths.push(...retained.removedSessionIds.map((sessionId) => `repositories/${repository.repoId}/edit-sessions/${sessionId}`));
        Object.entries(retained.skippedByReason).forEach(([key, value]) => {
          skippedByReason[`edit_session_${key}`] = (skippedByReason[`edit_session_${key}`] ?? 0) + value;
        });
        editSessionHistory.errors.push(...retained.errors.map((error) => `${repository.repoId}:${error}`));
      }
      errors.push(...editSessionHistory.errors.map((error) => `edit-session-history ${error}`));
      continue;
    }
    if (phase === 'caches') {
      const registered = listRepositories(home, { includeRemoved: true });
      const repositoryRoots = new Set<string>();
      for (const repository of registered) {
        repositoryRoots.add(resolve(repository.canonicalRoot));
        repositoryRoots.add(resolve(repository.localRoot));
        for (const checkout of repository.checkouts) {
          repositoryRoots.add(resolve(checkout.canonicalRoot));
          repositoryRoots.add(resolve(checkout.localRoot));
        }
      }
      const protectedRepositoryRoots = new Set<string>();
      let locatorScanRemaining = maxEntries;
      for (const repositoryRoot of [...repositoryRoots].sort()) {
        if (!existsSync(repositoryRoot)) continue;
        if (locatorScanRemaining <= 0) {
          protectedRepositoryRoots.add(repositoryRoot);
          skippedByReason.codegraph_locator_scan_budget_exhausted = (skippedByReason.codegraph_locator_scan_budget_exhausted ?? 0) + 1;
          continue;
        }
        const locatorReport = cleanupStaleCodegraphLocators(
          repositoryRoot,
          home,
          locatorScanRemaining,
          removalBudget.remaining,
        );
        locatorScanRemaining = Math.max(0, locatorScanRemaining - locatorReport.inspected);
        removalBudget.remaining = Math.max(0, removalBudget.remaining - locatorReport.attempted);
        if (locatorReport.budgetExhausted && removalBudget.remaining <= 0) removalBudget.exhausted = true;
        codegraphLocatorInspected += locatorReport.inspected;
        codegraphLocatorRetained += Math.max(0, locatorReport.inspected - locatorReport.removed.length);
        removedCodegraphLocatorPaths.push(...locatorReport.removed.map((name) => join(repositoryRoot, name)));
        Object.entries(locatorReport.skippedByReason).forEach(([key, value]) => {
          skippedByReason[`codegraph_locator_${key}`] = (skippedByReason[`codegraph_locator_${key}`] ?? 0) + value;
        });
        const protectionUncertain = locatorReport.budgetExhausted
          || locatorReport.errors.length > 0
          || (locatorReport.skippedByReason.locator_identity_unproven ?? 0) > 0;
        if (locatorReport.active.length > 0 || protectionUncertain) protectedRepositoryRoots.add(repositoryRoot);
        if (locatorReport.budgetExhausted) {
          skippedByReason.codegraph_locator_scan_budget_exhausted = (skippedByReason.codegraph_locator_scan_budget_exhausted ?? 0) + 1;
        }
        errors.push(...locatorReport.errors.map((error) => `codegraph-locator ${repositoryRoot}: ${error}`));
      }
      codegraphRetention = cleanupCodegraphCaches(home, {
        nowMs,
        retentionMs: options.codegraphCacheRetentionMs,
        maxEntries,
        maxRemovals: removalBudget.remaining,
        protectedRepositoryRoots: [...protectedRepositoryRoots],
      });
      removalBudget.remaining = Math.max(0, removalBudget.remaining - codegraphRetention.attempted);
      if (codegraphRetention.budgetExhausted) removalBudget.exhausted = true;
      Object.entries(codegraphRetention.skippedByReason).forEach(([key, value]) => {
        skippedByReason[`codegraph_cache_${key}`] = (skippedByReason[`codegraph_cache_${key}`] ?? 0) + value;
      });
      errors.push(...codegraphRetention.errors.map((error) => `codegraph-cache ${error}`));
      continue;
    }
    if (phase === 'repository_namespaces') {
      repositoryNamespaceRetention = cleanupRetiredRepositoryNamespaces(home, {
        nowMs,
        graceMs: options.repositoryNamespaceRetentionMs,
        maxEntries,
        maxRemovals: removalBudget.remaining,
      });
      removalBudget.remaining = Math.max(0, removalBudget.remaining - repositoryNamespaceRetention.attempted);
      if (repositoryNamespaceRetention.budgetExhausted && removalBudget.remaining <= 0) removalBudget.exhausted = true;
      Object.entries(repositoryNamespaceRetention.skippedByReason).forEach(([key, value]) => {
        skippedByReason[`repository_namespace_${key}`] = (skippedByReason[`repository_namespace_${key}`] ?? 0) + value;
      });
      errors.push(...repositoryNamespaceRetention.errors.map((error) => `repository-namespace ${error}`));
      continue;
    }
    releaseSessionCandidates = cleanupReleaseSessionCandidateLanes(home, {
      maxEntries,
      sequence,
      removalBudget,
      skippedByReason,
    });
    errors.push(...releaseSessionCandidates.errors.map((error) => `release-session-candidate ${error}`));

    releaseRetention = cleanupControllerReleaseHistory(home, {
      nowMs,
      graceMs: options.releaseRetentionGraceMs,
      stagingGraceMs: options.stagingReleaseRetentionGraceMs,
      maxRemovals: removalBudget.remaining,
    });
    removalBudget.remaining = Math.max(0, removalBudget.remaining - releaseRetention.attempted);
    if (releaseRetention.budgetExhausted) removalBudget.exhausted = true;
    Object.entries(releaseRetention.skippedByReason).forEach(([key, value]) => {
      skippedByReason[key] = (skippedByReason[key] ?? 0) + value;
    });
    errors.push(...releaseRetention.errors);
  }
  if (periodic) {
    worktrees ??= { removed: [], skippedActive: [], skippedByReason: {}, reclaim: emptyReclaimMetrics() } as ReturnType<typeof cleanupOrphanWorktrees>;
    dependencyCleanup ??= { migrated: [], skippedByReason: {} } as ReturnType<typeof cleanupManagedWorktreeDependencyCopies>;
    temporaryCleanup ??= { removed: [], reclaim: emptyReclaimMetrics() } as ReturnType<typeof cleanupTemporaryStatePaths>;
    artifactRetention ??= { removedPaths: [], attempted: 0, budgetExhausted: false, skippedByReason: {}, errors: [], inspected: 0, eligible: 0, retained: 0, skipped: 0, reclaimedBytes: 0, unknownReclaimedByteCount: 0 } as ReturnType<typeof cleanupWorkPreservationArtifacts>;
    codegraphRetention ??= { policyVersion: CODEGRAPH_CACHE_RETENTION_POLICY_VERSION, removedPaths: [], attempted: 0, budgetExhausted: false, skippedByReason: {}, errors: [], inspected: 0, eligible: 0, retained: 0, reclaimedBytes: 0, unknownReclaimedByteCount: 0, observedBytes: 0, unknownObservedByteCount: 0, protected: 0, protectedOverCapacity: 0, truncated: false } as ReturnType<typeof cleanupCodegraphCaches>;
    repositoryNamespaceRetention ??= { policyVersion: 'repository-namespace-retention-v1', removedPaths: [], attempted: 0, budgetExhausted: false, skippedByReason: {}, errors: [], inspected: 0, eligible: 0, retained: 0, reclaimedBytes: 0, unknownReclaimedByteCount: 0 } as ReturnType<typeof cleanupRetiredRepositoryNamespaces>;
    releaseRetention ??= { removedPaths: [], removedBackupPaths: [], attempted: 0, budgetExhausted: false, skippedByReason: {}, errors: [], inspected: 0, eligible: 0, retained: 0, skipped: 0, reclaimedBytes: 0, unknownReclaimedByteCount: 0, reclaimedBackupBytes: 0, unknownReclaimedBackupByteCount: 0 } as ReturnType<typeof cleanupControllerReleaseHistory>;
    releaseSessionCandidates ??= emptyReleaseSessionCandidateRetentionReport();
  }
  if (!worktrees || !dependencyCleanup || !temporaryCleanup || !artifactRetention || !codegraphRetention || !repositoryNamespaceRetention || !releaseRetention || !releaseSessionCandidates) {
    throw new Error('RUNTIME_CLEANUP_PHASE_INCOMPLETE');
  }
  const removedTemporaryPaths = temporaryCleanup.removed.sort();
  const removedCleanupArtifactPaths = artifactRetention.removedPaths.sort();
  const removedReleasePaths = releaseRetention.removedPaths.sort();
  const removedScheduleOccurrencePaths = schedulerHistory.removedOccurrencePaths.sort();
  const removedScheduleDecisionPaths = schedulerHistory.removedDecisionPaths.sort();
  const removedEditSessionPaths = editSessionHistory.removedPaths.sort();
  removedCodegraphLocatorPaths.sort();
  const removedCodegraphCachePaths = codegraphRetention.removedPaths.sort();
  const removedRepositoryNamespacePaths = repositoryNamespaceRetention.removedPaths.sort();
  let sqliteMaintenance: ControlPlaneDatabaseMaintenanceReport | undefined;
  if (!periodic || removalPhases.includes('releases')) try {
    sqliteMaintenance = maintainControlPlaneDatabase(home, {
      minimumReclaimableBytes: options.sqliteVacuumMinReclaimableBytes,
      minimumReclaimableRatio: options.sqliteVacuumMinReclaimableRatio,
    });
    if (sqliteMaintenance.skippedReason === 'database_busy') {
      skippedByReason.sqlite_maintenance_busy = (skippedByReason.sqlite_maintenance_busy ?? 0) + 1;
    }
  } catch (error) {
    errors.push(errorText('SQLite maintenance', error));
  }
  const inspectedPaths = referenceBudget.inspected + worktreeBudget.inspected + dependencyBudget.inspected + tempBudget.inspected + schedulerBudget.inspected + editSessionBudget.inspected + artifactRetention.inspected + codegraphLocatorInspected + codegraphRetention.inspected + repositoryNamespaceRetention.inspected + releaseRetention.inspected + releaseSessionCandidates.inspected;
  const budgetExhausted = referenceBudget.exhausted || worktreeBudget.exhausted || dependencyBudget.exhausted || tempBudget.exhausted || schedulerBudget.exhausted || editSessionBudget.exhausted || removalBudget.exhausted || releaseSessionCandidates.truncated;
  if (pidFiles.skipped.length > 0 && removalBudget.exhausted) skippedByReason.cleanup_budget_exhausted = (skippedByReason.cleanup_budget_exhausted ?? 0) + pidFiles.skipped.length;
  if (pidFiles.skipped.length > 0 && !removalBudget.exhausted) skippedByReason.active_owner = (skippedByReason.active_owner ?? 0) + pidFiles.skipped.length;
  const physicalReclaimedByClass: Record<string, RuntimeCleanupLifecycleClassMetrics> = {
    managed_workspace_checkout: {
      count: worktrees.removed.length,
      bytes: worktrees.reclaim.reclaimedBytes,
      unknownByteCount: worktrees.reclaim.unknownReclaimedByteCount,
    },
    runtime_temp: {
      count: pidFiles.removed.length + removedTemporaryPaths.length + removedCodegraphLocatorPaths.length,
      bytes: pidFiles.reclaim.reclaimedBytes + temporaryCleanup.reclaim.reclaimedBytes,
      unknownByteCount: pidFiles.reclaim.unknownReclaimedByteCount + temporaryCleanup.reclaim.unknownReclaimedByteCount + removedCodegraphLocatorPaths.length,
    },
    work: {
      count: removedCleanupArtifactPaths.length,
      bytes: artifactRetention.reclaimedBytes,
      unknownByteCount: artifactRetention.unknownReclaimedByteCount,
    },
    release_artifact: {
      count: Math.max(0, removedReleasePaths.length - releaseRetention.removedBackupPaths.length),
      bytes: Math.max(0, releaseRetention.reclaimedBytes - releaseRetention.reclaimedBackupBytes),
      unknownByteCount: Math.max(0, releaseRetention.unknownReclaimedByteCount - releaseRetention.unknownReclaimedBackupByteCount),
    },
    recovery_backup: {
      count: releaseRetention.removedBackupPaths.length,
      bytes: releaseRetention.reclaimedBackupBytes,
      unknownByteCount: releaseRetention.unknownReclaimedBackupByteCount,
    },
    release_session_candidate: {
      count: releaseSessionCandidates.removedPaths.length,
      bytes: releaseSessionCandidates.reclaimedBytes,
      unknownByteCount: releaseSessionCandidates.unknownReclaimedByteCount,
    },
    scheduler_occurrence_history: {
      count: removedScheduleOccurrencePaths.length + removedScheduleDecisionPaths.length,
      bytes: schedulerHistory.reclaimedBytes,
      unknownByteCount: schedulerHistory.unknownReclaimedByteCount,
    },
    edit_session: {
      count: removedEditSessionPaths.length,
      bytes: editSessionHistory.reclaimedBytes,
      unknownByteCount: editSessionHistory.unknownReclaimedByteCount,
    },
    codegraph_cache: {
      count: removedCodegraphCachePaths.length,
      bytes: codegraphRetention.reclaimedBytes,
      unknownByteCount: codegraphRetention.unknownReclaimedByteCount,
    },
    repository_controller_home_namespace: {
      count: removedRepositoryNamespacePaths.length,
      bytes: repositoryNamespaceRetention.reclaimedBytes,
      unknownByteCount: repositoryNamespaceRetention.unknownReclaimedByteCount,
    },
    sqlite_control_plane: {
      count: sqliteMaintenance?.vacuumed ? 1 : 0,
      bytes: sqliteMaintenance?.reclaimedBytes ?? 0,
      unknownByteCount: 0,
    },
  };
  const protectedByReason = Object.fromEntries(
    Object.entries(skippedByReason)
      .filter(([reason, count]) => count > 0 && (reason.includes('active') || reason.includes('authority') || reason.includes('protected')))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const blockerReasons = Object.fromEntries(
    Object.entries(skippedByReason)
      .filter(([reason, count]) => count > 0 && (reason.includes('unknown') || reason.includes('budget') || reason.includes('unsafe') || reason.includes('unavailable') || reason.includes('busy')))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const lifecycleMetrics: RuntimeCleanupLifecycleMetrics = {
    reclaimedCount: Object.values(physicalReclaimedByClass).reduce((total, entry) => total + entry.count, 0),
    reclaimedBytes: Object.values(physicalReclaimedByClass).reduce((total, entry) => total + entry.bytes, 0),
    unknownReclaimedByteCount: Object.values(physicalReclaimedByClass).reduce((total, entry) => total + entry.unknownByteCount, 0),
    reclaimedByClass: physicalReclaimedByClass,
    logicalRetiredCount: retiredOwnerlessWorkAuthorities.length,
    logicalRetiredByClass: { work: retiredOwnerlessWorkAuthorities.length },
    protectedActiveCount: Object.values(protectedByReason).reduce((total, count) => total + count, 0),
    protectedByReason,
    blockerReasons,
  };
  const report: RuntimeCleanupReport = {
    policyVersion: RUNTIME_LIFECYCLE_RETENTION_POLICY_VERSION,
    at: nowIso,
    reason: options.reason ?? 'manual',
    removedPidFiles: pidFiles.removed.sort(),
    skippedPidFiles: pidFiles.skipped.sort(),
    removedWorktrees: worktrees.removed.sort(),
    migratedDependencyPaths: dependencyCleanup.migrated.sort(),
    removedTemporaryPaths,
    removedCleanupArtifactPaths,
    removedReleasePaths,
    releaseSessionCandidates,
    removedScheduleOccurrencePaths,
    removedScheduleDecisionPaths,
    removedEditSessionPaths,
    removedCodegraphLocatorPaths,
    removedCodegraphCachePaths,
    removedRepositoryNamespacePaths,
    sqliteMaintenance,
    retiredOwnerlessWorkAuthorities: retiredOwnerlessWorkAuthorities.sort(),
    skippedActiveWorktrees: worktrees.skippedActive.sort(),
    inspectedPaths,
    budgetExhausted,
    errors: errors.sort(),
    logPath: runtimeCleanupLogPath(home),
    lifecycleMetrics,
    cycle: {
      scanned: inspectedPaths,
      eligible: retiredOwnerlessWorkAuthorities.length + pidFiles.removed.length + worktrees.removed.length + dependencyCleanup.migrated.length + removedTemporaryPaths.length + artifactRetention.eligible + schedulerHistory.eligible + editSessionHistory.eligible + removedCodegraphLocatorPaths.length + codegraphRetention.eligible + repositoryNamespaceRetention.eligible + releaseRetention.eligible + releaseSessionCandidates.eligible,
      attempted: retiredOwnerlessWorkAuthorities.length + pidFiles.removed.length + worktrees.removed.length + dependencyCleanup.migrated.length + removedTemporaryPaths.length + artifactRetention.attempted + schedulerHistory.attempted + editSessionHistory.attempted + removedCodegraphLocatorPaths.length + codegraphRetention.attempted + repositoryNamespaceRetention.attempted + releaseRetention.attempted + releaseSessionCandidates.attempted + errors.length,
      removed: retiredOwnerlessWorkAuthorities.length + pidFiles.removed.length + worktrees.removed.length + dependencyCleanup.migrated.length + removedTemporaryPaths.length + removedCleanupArtifactPaths.length + removedScheduleOccurrencePaths.length + removedScheduleDecisionPaths.length + removedEditSessionPaths.length + removedCodegraphLocatorPaths.length + removedCodegraphCachePaths.length + removedRepositoryNamespacePaths.length + removedReleasePaths.length + releaseSessionCandidates.removedPaths.length,
      retained: pidFiles.skipped.length + worktrees.skippedActive.length + artifactRetention.retained + schedulerHistory.retained + editSessionHistory.retained + codegraphLocatorRetained + codegraphRetention.retained + repositoryNamespaceRetention.retained + releaseRetention.retained + releaseSessionCandidates.retainedCount,
      skipped: Math.max(0, inspectedPaths - pidFiles.removed.length - worktrees.removed.length - dependencyCleanup.migrated.length - removedTemporaryPaths.length - removedCleanupArtifactPaths.length - removedScheduleOccurrencePaths.length - removedScheduleDecisionPaths.length - removedEditSessionPaths.length - removedCodegraphLocatorPaths.length - removedCodegraphCachePaths.length - removedRepositoryNamespacePaths.length - removedReleasePaths.length - releaseSessionCandidates.removedPaths.length - errors.length),
      failed: errors.length,
      truncated: budgetExhausted,
      budgetExhausted,
      skippedByReason,
      failedByType: errors.reduce<Record<string, number>>((counts, error) => {
        const type = error.split(/[: ]/, 1)[0] || 'unknown';
        counts[type] = (counts[type] ?? 0) + 1;
        return counts;
      }, {}),
      startedAt: nowIso,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - nowMs),
    },
  };
  if (shouldPersistCleanupAudit(report)) {
    try {
      appendJsonLine(report.logPath, { schemaVersion: 1, ...report });
    } catch (error) {
      report.errors.push(errorText('runtime cleanup audit write failed', error));
    }
  }
  return report;
}
