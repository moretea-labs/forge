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
import { join, relative, resolve } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { listRepositories } from '../../cli/repositories/registry';
import { managedPathInside, managedWorktreeStorageRoot } from '../../cli/repositories/worktree-storage';
import { migrateManagedWorkspacePhysicalDependenciesToCanonical } from '../execution/managed-workspace';
import { listActiveLeases } from '../resources/leases/store';
import { appendJsonLine, readJsonFile, writeJsonAtomic } from '../shared/json-files';
import { cleanupControllerReleaseHistory } from './release-retention';
import { cleanupWorkPreservationArtifacts } from './cleanup-artifact-retention';
import { retireTerminalPlanBoundWorkAuthorities } from './facade/plan-contract-store';
import { reconcileOwnerlessWorkAuthorities } from './execution/work-authority-reconciler';

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
  /** Grace period before a non-Plan Work with no exact durable owner loses execution authority. */
  ownerlessWorkAuthorityGraceMs?: number;
  inspectProcess?: (pid: number) => RuntimeProcessSnapshot;
}

export interface RuntimeCleanupReport {
  at: string;
  reason: 'startup' | 'periodic' | 'manual';
  removedPidFiles: string[];
  skippedPidFiles: string[];
  removedWorktrees: string[];
  migratedDependencyPaths: string[];
  removedTemporaryPaths: string[];
  removedCleanupArtifactPaths: string[];
  removedReleasePaths: string[];
  /** Historical non-terminal Work whose owning Plan was already terminal. Records remain for retention/audit. */
  retiredPlanBoundWorkAuthorities: string[];
  /** Work retired only after exact per-Work liveness proved no durable continuation owner remains. */
  retiredOwnerlessWorkAuthorities: string[];
  skippedActiveWorktrees: string[];
  inspectedPaths: number;
  budgetExhausted: boolean;
  errors: string[];
  logPath: string;
  cycle: CleanupCycleSummary;
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

type RemovalPhase = 'worktrees' | 'temporary' | 'artifacts' | 'releases';
const REMOVAL_PHASES: readonly RemovalPhase[] = ['worktrees', 'temporary', 'artifacts', 'releases'];

export function cleanupRemovalPhaseOrder(reason: RuntimeCleanupReport['reason'], sequence = 0): RemovalPhase[] {
  if (reason !== 'periodic') return [...REMOVAL_PHASES];
  const offset = ((Math.trunc(sequence) % REMOVAL_PHASES.length) + REMOVAL_PHASES.length) % REMOVAL_PHASES.length;
  return [...REMOVAL_PHASES.slice(offset), ...REMOVAL_PHASES.slice(0, offset)];
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
): { removed: string[]; skipped: string[] } {
  const pidPath = join(controllerHome, 'daemon', 'controller.pid');
  if (!existsSync(pidPath)) return { removed: [], skipped: [] };
  let parsedPid: number | undefined;
  try {
    const candidate = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    parsedPid = Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
  } catch (error) {
    errors.push(errorText('daemon/controller.pid read failed', error));
  }

  if (removalBudget.remaining <= 0) {
    removalBudget.exhausted = true;
    return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)] };
  }

  if (parsedPid) {
    const snapshot = (options.inspectProcess ?? inspectProcessDefault)(parsedPid);
    if (snapshot.alive) {
      if (parsedPid === options.protectedControllerPid || expectedDaemonCommand(controllerHome, snapshot.commandLine)) {
        return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)] };
      }
      if (!snapshot.commandLine) {
        errors.push(`daemon/controller.pid: live PID ${parsedPid} command identity is unavailable`);
        return { removed: [], skipped: [relativeHomePath(controllerHome, pidPath)] };
      }
      // PID reuse or an unrelated live process: remove only the stale reference.
      // Never signal a process whose daemon identity is not proven.
    }
  }

  try {
    removalBudget.remaining -= 1;
    rmSync(pidPath, { force: true });
    updateDaemonStateForStalePid(controllerHome, parsedPid, nowIso);
    return { removed: [relativeHomePath(controllerHome, pidPath)], skipped: [] };
  } catch (error) {
    errors.push(errorText('daemon/controller.pid removal failed', error));
    return { removed: [], skipped: [] };
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
): { removed: string[]; skippedActive: string[]; skippedByReason: Record<string, number> } {
  const removed: string[] = [];
  const skippedActive: string[] = [];
  const skippedByReason: Record<string, number> = {};
  const skip = (reason: string): void => { skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1; };
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
      try {
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
        if (removeOrphanWorktreeDirectory(path, errors, relativePath)) {
          removed.push(relativePath);
        }
      } catch (error) {
        errors.push(errorText(`worktree cleanup ${relativePath}`, error));
      }
    });
  });
  return { removed, skippedActive, skippedByReason };
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
  try {
    removalBudget.remaining -= 1;
    rmSync(path, { recursive: isDirectory, force: true });
    removed.push(relativePath);
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
): string[] {
  const removed: string[] = [];
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
        removeStaleTempEntry(path, relativePath, entry.isDirectory(), stats.mtimeMs, nowMs, removed, errors, removalBudget, skippedByReason);
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
  return removed;
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
    || report.retiredPlanBoundWorkAuthorities.length
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
  const errors: string[] = [];
  const skippedByReason: Record<string, number> = {};
  const retiredPlanBoundWorkAuthorities: string[] = [];
  const retiredOwnerlessWorkAuthorities: string[] = [];
  try {
    for (const repository of listRepositories(home, { includeRemoved: true })) {
      const retired = retireTerminalPlanBoundWorkAuthorities({ controllerHome: home, repoId: repository.repoId });
      retiredPlanBoundWorkAuthorities.push(...retired.map((workId) => `${repository.repoId}:${workId}`));
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
  const references = collectReferencedWorktrees(home, referenceBudget, errors, nowMs);
  let worktrees: ReturnType<typeof cleanupOrphanWorktrees> | undefined;
  let dependencyCleanup: ReturnType<typeof cleanupManagedWorktreeDependencyCopies> | undefined;
  let removedTemporaryPaths: string[] | undefined;
  let artifactRetention: ReturnType<typeof cleanupWorkPreservationArtifacts> | undefined;
  let releaseRetention: ReturnType<typeof cleanupControllerReleaseHistory> | undefined;
  const sequence = options.periodicSequence ?? Math.floor(nowMs / 60_000);

  for (const phase of cleanupRemovalPhaseOrder(options.reason ?? 'manual', sequence)) {
    if (phase === 'worktrees') {
      dependencyCleanup = cleanupManagedWorktreeDependencyCopies(home, dependencyBudget, errors, removalBudget);
      Object.entries(dependencyCleanup.skippedByReason).forEach(([key, value]) => { skippedByReason[key] = (skippedByReason[key] ?? 0) + value; });
      worktrees = cleanupOrphanWorktrees(home, references, worktreeBudget, nowMs, errors, removalBudget);
      Object.entries(worktrees.skippedByReason).forEach(([key, value]) => { skippedByReason[key] = (skippedByReason[key] ?? 0) + value; });
      continue;
    }
    if (phase === 'temporary') {
      removedTemporaryPaths = cleanupTemporaryStatePaths(home, tempBudget, nowMs, errors, removalBudget, skippedByReason).sort();
      continue;
    }
    if (phase === 'artifacts') {
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
  if (!worktrees || !dependencyCleanup || !removedTemporaryPaths || !artifactRetention || !releaseRetention) {
    throw new Error('RUNTIME_CLEANUP_PHASE_INCOMPLETE');
  }
  const removedCleanupArtifactPaths = artifactRetention.removedPaths.sort();
  const removedReleasePaths = releaseRetention.removedPaths.sort();
  const inspectedPaths = referenceBudget.inspected + worktreeBudget.inspected + dependencyBudget.inspected + tempBudget.inspected + artifactRetention.inspected + releaseRetention.inspected;
  const budgetExhausted = referenceBudget.exhausted || worktreeBudget.exhausted || dependencyBudget.exhausted || tempBudget.exhausted || removalBudget.exhausted;
  if (pidFiles.skipped.length > 0 && removalBudget.exhausted) skippedByReason.cleanup_budget_exhausted = (skippedByReason.cleanup_budget_exhausted ?? 0) + pidFiles.skipped.length;
  if (pidFiles.skipped.length > 0 && !removalBudget.exhausted) skippedByReason.active_owner = (skippedByReason.active_owner ?? 0) + pidFiles.skipped.length;
  const report: RuntimeCleanupReport = {
    at: nowIso,
    reason: options.reason ?? 'manual',
    removedPidFiles: pidFiles.removed.sort(),
    skippedPidFiles: pidFiles.skipped.sort(),
    removedWorktrees: worktrees.removed.sort(),
    migratedDependencyPaths: dependencyCleanup.migrated.sort(),
    removedTemporaryPaths,
    removedCleanupArtifactPaths,
    removedReleasePaths,
    retiredPlanBoundWorkAuthorities: retiredPlanBoundWorkAuthorities.sort(),
    retiredOwnerlessWorkAuthorities: retiredOwnerlessWorkAuthorities.sort(),
    skippedActiveWorktrees: worktrees.skippedActive.sort(),
    inspectedPaths,
    budgetExhausted,
    errors: errors.sort(),
    logPath: runtimeCleanupLogPath(home),
    cycle: {
      scanned: inspectedPaths,
      eligible: retiredPlanBoundWorkAuthorities.length + retiredOwnerlessWorkAuthorities.length + pidFiles.removed.length + worktrees.removed.length + dependencyCleanup.migrated.length + removedTemporaryPaths.length + artifactRetention.eligible + releaseRetention.eligible,
      attempted: retiredPlanBoundWorkAuthorities.length + retiredOwnerlessWorkAuthorities.length + pidFiles.removed.length + worktrees.removed.length + dependencyCleanup.migrated.length + removedTemporaryPaths.length + artifactRetention.attempted + releaseRetention.attempted + errors.length,
      removed: retiredPlanBoundWorkAuthorities.length + retiredOwnerlessWorkAuthorities.length + pidFiles.removed.length + worktrees.removed.length + dependencyCleanup.migrated.length + removedTemporaryPaths.length + removedCleanupArtifactPaths.length + removedReleasePaths.length,
      retained: pidFiles.skipped.length + worktrees.skippedActive.length + artifactRetention.retained + releaseRetention.retained,
      skipped: Math.max(0, inspectedPaths - pidFiles.removed.length - worktrees.removed.length - dependencyCleanup.migrated.length - removedTemporaryPaths.length - removedCleanupArtifactPaths.length - removedReleasePaths.length - errors.length),
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
