import { execFile, spawn, type ChildProcess } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { cpus, freemem, loadavg } from 'os';
import { listRepositories } from '../../../cli/repositories/registry';
import { resolveControllerHome } from '../../../cli/repositories/controller-home';
import { writeAgentExecutableReadinessSnapshot } from '../../../cli/agent-jobs/executable-resolver';
import { withControllerLock } from '../../../cli/repositories/locks';
import {
  assertRuntimeMayWrite,
  getRuntimeWriteClaim,
  runtimeWriteClaimEnvironment,
} from '../../root/write-fence';
import {
  attachExecutionWorker,
  executionJobRoot,
  getExecutionJob,
  listActiveExecutionJobs,
  markExecutionJobSchedulerObserved,
  transitionExecutionJob,
  updateExecutionJob,
} from '../../execution/jobs/store';
import type { ExecutionWorkerLifecycle } from '../../execution/jobs/types';
import { tryRecoverJobFromWorkerReceipt } from '../../execution/jobs/receipt-recovery';
import { releaseExecutionLeases } from '../../resources/leases/store';
import { RepoActorRegistry } from '../repo-actor/registry';
import { reconcileExecutionJobsAsync } from './reconciliation';
import { tickSchedules } from '../../workflow/schedules/engine';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import { resolveBunExecutable } from '../../shared/process-environment';
import { isProcessAlive, terminateProcessTree } from '../../shared/process-tree';
import { readSchedulerWakeSignal, waitForSchedulerWakeSignal } from './wake-signal';
import { cleanupControllerRuntimeState } from '../runtime-cleanup';
import { reconcileTerminalWorkCleanups } from '../execution/work-terminal-cleanup';
import { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import { reconcilePendingWorkValidations } from '../execution/work-validation-reconciler';
import { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';
import { schedulerDispatchAllowed } from '../facade/work-admission-policy';
import { rebuildRepositoryProjection, refreshRepositoryProjectionForRepository } from '../../projections/materialized-view';
import { readRepositoryGitStatusSample, sampleRepositoryGitStatusForRepositories } from '../../projections/git-status-sampler';
import {
  compareExecutionJobDispatchRanks,
  isExecutionJobDispatchCandidate,
  rankExecutionJobForDispatch,
} from '../dispatch-priority';

const DARWIN_MEMORY_SAMPLE_TTL_MS = 5_000;
const MAX_WORKER_STDERR_BYTES = 16 * 1024;
const WORKER_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'BUN_INSTALL',
  'NODE_OPTIONS',
  'FORGE_CONTROLLER_HOME',
  'FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT',
  'FORGE_EXECUTION_WORKER',
  'FORGE_RUNTIME_INSTANCE_ID',
  'FORGE_RUNTIME_OWNER_PID',
  'FORGE_RELEASE_AUTHORITY_REVISION',
  // The release fencing token is passed to the actual child environment below,
  // but deliberately excluded from the persisted lifecycle diagnostic.
  'FORGE_RELEASE_ID',
  'FORGE_ARTIFACT_IDENTITY',
  'FORGE_WORKER_PROTOCOL_VERSION',
] as const;
const RUNTIME_CLEANUP_INTERVAL_MS = Math.max(30_000, Number(process.env.FORGE_RUNTIME_CLEANUP_INTERVAL_MS ?? 60_000));
const GIT_STATUS_SAMPLE_INTERVAL_MS = Math.max(1_000, Number(process.env.FORGE_GIT_STATUS_SAMPLE_INTERVAL_MS ?? 5_000));
const IDLE_REPOSITORY_SCAN_INTERVAL_MS = Math.max(
  GIT_STATUS_SAMPLE_INTERVAL_MS,
  Number(process.env.FORGE_IDLE_REPOSITORY_SCAN_INTERVAL_MS ?? 60_000),
);

export function selectSchedulerSourceScanRepositories<T extends { repoId: string }>(
  repositories: readonly T[],
  activeRepoIds: ReadonlySet<string>,
  nowMs: number,
  lastSourceScanAt: number,
): T[] {
  const active = repositories.filter((repository) => activeRepoIds.has(repository.repoId));
  if (active.length > 0) return active;
  if (repositories.length === 0 || nowMs - lastSourceScanAt < IDLE_REPOSITORY_SCAN_INTERVAL_MS) return [];
  // fs.watch/dirty markers drive prompt refresh for active mutations. The idle
  // scan is only a safety net, so spread it across minutes instead of blocking
  // the Runtime event loop on every registered repository at once.
  const slot = Math.floor(nowMs / IDLE_REPOSITORY_SCAN_INTERVAL_MS) % repositories.length;
  return [repositories[slot]!];
}
const DARWIN_RECLAIMABLE_PAGE_LABELS = new Set([
  'Pages free',
  'Pages inactive',
  'Pages speculative',
  'Pages purgeable',
]);

export function parseDarwinAvailableMemoryMb(output: string): number | undefined {
  const pageSizeMatch = /page size of\s+(\d+)\s+bytes/i.exec(output);
  const pageSize = Number(pageSizeMatch?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined;

  let reclaimablePages = 0;
  let matched = false;
  for (const rawLine of output.split('\n')) {
    const match = /^([^:]+):\s+(\d+)\.?$/.exec(rawLine.trim());
    if (!match || !DARWIN_RECLAIMABLE_PAGE_LABELS.has(match[1])) continue;
    reclaimablePages += Number(match[2]);
    matched = true;
  }
  if (!matched) return undefined;
  return reclaimablePages * pageSize / (1024 * 1024);
}

export function isSchedulerResourcePressured(
  snapshot: { freeMemoryMb: number; loadPerCpu: number },
  limits: { minFreeMemoryMb: number; maxLoadPerCpu: number },
): boolean {
  return snapshot.freeMemoryMb < limits.minFreeMemoryMb || snapshot.loadPerCpu > limits.maxLoadPerCpu;
}

type DarwinMemorySampler = (
  callback: (error: Error | null, stdout: string) => void,
) => void;

export function sampleDarwinAvailableMemoryMb(
  fallback: number,
  sampler: DarwinMemorySampler = (callback) => {
    execFile('vm_stat', [], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => callback(error, stdout));
  },
): Promise<number> {
  return new Promise((resolve) => {
    try {
      sampler((error, stdout) => {
        if (error) {
          resolve(fallback);
          return;
        }
        resolve(parseDarwinAvailableMemoryMb(stdout) ?? fallback);
      });
    } catch {
      resolve(fallback);
    }
  });
}

interface SchedulerState {
  schemaVersion: 1;
  updatedAt: string;
  loopStartedAt?: string;
  lastHeartbeatAt?: string;
  heartbeatTimeoutMs?: number;
  lastTickAt?: string;
  lastDispatchAt?: string;
  lastReconcileAt?: string;
  lastSourceScanAt?: string;
  lastSourceScanRepoCount?: number;
  sourceScansAvoided?: number;
  lastRepoDispatch: Record<string, number>;
}

function schedulerStatePath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'scheduler', 'state.json');
}

export interface SchedulerHealthSnapshot {
  schemaVersion: 1;
  updatedAt: string;
  loopStartedAt?: string;
  lastHeartbeatAt?: string;
  heartbeatTimeoutMs?: number;
  lastTickAt?: string;
  lastDispatchAt?: string;
  lastReconcileAt?: string;
  lastSourceScanAt?: string;
  lastSourceScanRepoCount?: number;
  sourceScansAvoided?: number;
  lastRepoDispatch: Record<string, number>;
}

export function readSchedulerHealthSnapshot(controllerHome: string): SchedulerHealthSnapshot {
  return readJsonFile<SchedulerHealthSnapshot>(schedulerStatePath(controllerHome), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    lastRepoDispatch: {},
  });
}

export interface SchedulerConfig {
  maxWorkers: number;
  maxConcurrentRepositories: number;
  pollIntervalMs: number;
  idleBackoffMaxMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxHeavyChecks: number;
  maxAgentProcesses: number;
  maxCodexProcesses: number;
  maxClaudeProcesses: number;
  maxGitHubProcesses: number;
  minFreeMemoryMb: number;
  maxLoadPerCpu: number;
}

export interface SchedulerRuntimeBinding {
  controllerPid?: number;
  runtimeSourceRoot?: string;
  workerEntrypoint?: string;
  /** Canonical Runtime treats a tick failure as a whole-Runtime failure. */
  fatalOnTickError?: boolean;
}

export function resolveSchedulerWorkerExecutable(
  isBun: boolean = Boolean(process.versions.bun),
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isBun ? resolveBunExecutable(execPath, env) : execPath;
}

export class GlobalScheduler {
  private readonly controllerHome: string;
  private readonly actors: RepoActorRegistry;
  private readonly children = new Map<string, ChildProcess>();
  private readonly config: SchedulerConfig;
  private readonly controllerPid: number;
  private readonly runtimeSourceRoot?: string;
  private readonly workerEntrypoint?: string;
  private readonly fatalOnTickError: boolean;
  private lastScheduleTick = 0;
  private lastReconcile = 0;
  private lastPersistedAt = 0;
  private readonly lastRepoDispatch = new Map<string, number>();
  private readonly loopStartedAt = new Date().toISOString();
  private lastHeartbeatAt = this.loopStartedAt;
  private lastTickAt = this.loopStartedAt;
  private lastDispatchAt: string | undefined;
  private lastReconcileAt: string | undefined;
  private lastCleanupAt = 0;
  private lastGitStatusSampleAt = 0;
  private lastSourceScanAt = 0;
  private lastSourceScanRepoCount = 0;
  private sourceScansAvoided = 0;
  private runtimeCleanup = cleanupControllerRuntimeState;
  private terminalWorkCleanup = reconcileTerminalWorkCleanups;
  private processGc = gcTerminalProcesses;
  private workValidationReconcile = reconcilePendingWorkValidations;
  private editValidationReconcile = reconcilePendingEditValidations;
  private repositoryList = listRepositories;
  private lastDarwinMemorySampleAt = 0;
  private cachedDarwinAvailableMemoryMb: number | undefined;
  private darwinMemorySampleInFlight: Promise<void> | undefined;

  constructor(
    controllerHome: string,
    config: Partial<SchedulerConfig> = {},
    runtime: SchedulerRuntimeBinding = {},
  ) {
    this.controllerHome = controllerHome;
    this.controllerPid = runtime.controllerPid ?? process.pid;
    this.actors = new RepoActorRegistry(controllerHome);
    const pollIntervalMs = Math.max(50, config.pollIntervalMs ?? 250);
    const idleBackoffMaxMs = Math.max(250, config.idleBackoffMaxMs ?? Number(process.env.FORGE_IDLE_BACKOFF_MAX_MS ?? 2_000));
    const heartbeatIntervalMs = Math.max(25, config.heartbeatIntervalMs ?? Number(process.env.FORGE_SCHEDULER_HEARTBEAT_INTERVAL_MS ?? 1_000));
    const heartbeatTimeoutMs = Math.max(
      heartbeatIntervalMs * 4,
      idleBackoffMaxMs * 4,
      config.heartbeatTimeoutMs ?? Number(process.env.FORGE_SCHEDULER_HEARTBEAT_TIMEOUT_MS ?? 60_000),
    );
    this.config = {
      maxWorkers: Math.max(1, config.maxWorkers ?? Number(process.env.FORGE_MAX_WORKERS ?? 4)),
      maxConcurrentRepositories: Math.max(1, config.maxConcurrentRepositories ?? Number(process.env.FORGE_MAX_ACTIVE_REPOS ?? 4)),
      pollIntervalMs,
      idleBackoffMaxMs,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      maxHeavyChecks: Math.max(1, config.maxHeavyChecks ?? Number(process.env.FORGE_MAX_HEAVY_CHECKS ?? 2)),
      maxAgentProcesses: Math.max(1, config.maxAgentProcesses ?? Number(process.env.FORGE_MAX_AGENT_PROCESSES ?? 4)),
      maxCodexProcesses: Math.max(1, config.maxCodexProcesses ?? Number(process.env.FORGE_MAX_CODEX_PROCESSES ?? 3)),
      maxClaudeProcesses: Math.max(1, config.maxClaudeProcesses ?? Number(process.env.FORGE_MAX_CLAUDE_PROCESSES ?? 2)),
      maxGitHubProcesses: Math.max(1, config.maxGitHubProcesses ?? Number(process.env.FORGE_MAX_GITHUB_PROCESSES ?? 2)),
      minFreeMemoryMb: Math.max(64, config.minFreeMemoryMb ?? Number(process.env.FORGE_MIN_FREE_MEMORY_MB ?? 512)),
      maxLoadPerCpu: Math.max(0.25, config.maxLoadPerCpu ?? Number(process.env.FORGE_MAX_LOAD_PER_CPU ?? 1.5)),
    };
    this.runtimeSourceRoot = runtime.runtimeSourceRoot ? resolve(runtime.runtimeSourceRoot) : undefined;
    this.workerEntrypoint = runtime.workerEntrypoint ? resolve(runtime.workerEntrypoint) : undefined;
    this.fatalOnTickError = runtime.fatalOnTickError === true;
    const state = readJsonFile<SchedulerState>(schedulerStatePath(controllerHome), { schemaVersion: 1, updatedAt: new Date().toISOString(), lastRepoDispatch: {} });
    this.lastSourceScanAt = state.lastSourceScanAt ? Date.parse(state.lastSourceScanAt) || 0 : 0;
    this.lastSourceScanRepoCount = state.lastSourceScanRepoCount ?? 0;
    this.sourceScansAvoided = state.sourceScansAvoided ?? 0;
    for (const [repoId, timestamp] of Object.entries(state.lastRepoDispatch)) {
      if (Number.isFinite(timestamp)) this.lastRepoDispatch.set(repoId, timestamp);
    }
  }

  private persistState(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPersistedAt < 1_000) return;
    this.lastPersistedAt = now;
    writeJsonAtomic(schedulerStatePath(this.controllerHome), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: this.loopStartedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
      lastTickAt: this.lastTickAt,
      lastDispatchAt: this.lastDispatchAt,
      lastReconcileAt: this.lastReconcileAt,
      lastSourceScanAt: this.lastSourceScanAt ? new Date(this.lastSourceScanAt).toISOString() : undefined,
      lastSourceScanRepoCount: this.lastSourceScanRepoCount,
      sourceScansAvoided: this.sourceScansAvoided,
      lastRepoDispatch: Object.fromEntries(this.lastRepoDispatch),
    } satisfies SchedulerState);
  }

  private pidAlive(pid: number | undefined): boolean {
    return isProcessAlive(pid);
  }

  private async cleanupSpawnedWorkers(): Promise<void> {
    const workers = [...this.children.values()];
    this.children.clear();
    await Promise.all(workers.map((child) => terminateProcessTree(child.pid)));
  }

  private workerCommand(): { entry: string; loader: string; cwd: string } {
    const sourceEntry = this.runtimeSourceRoot
      ? join(this.runtimeSourceRoot, 'src', 'runtime', 'execution', 'workers', 'worker-entry.ts')
      : fileURLToPath(new URL('../../execution/workers/worker-entry.ts', import.meta.url));
    const loader = this.runtimeSourceRoot
      ? join(this.runtimeSourceRoot, 'src', 'runtime', 'shared', 'node-ts-loader.mjs')
      : fileURLToPath(new URL('../../shared/node-ts-loader.mjs', import.meta.url));
    const entry = this.workerEntrypoint ?? sourceEntry;
    const cwd = this.runtimeSourceRoot ?? process.cwd();
    if (!existsSync(entry)) throw new Error(`WORKER_ENTRYPOINT_MISSING: ${entry}`);
    if (!process.versions.bun && !existsSync(loader)) throw new Error(`WORKER_LOADER_MISSING: ${loader}`);
    return { entry, loader, cwd };
  }

  private workerEnvironment(): Record<string, string | undefined> {
    return Object.fromEntries(WORKER_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  }

  private persistSpawnedWorker(repoId: string, jobId: string, lifecycle: ExecutionWorkerLifecycle): void {
    try {
      updateExecutionJob(this.controllerHome, repoId, jobId, (current) => {
        if (!['dispatched', 'running'].includes(current.status) || current.workerPid !== undefined) return current;
        return { ...current, workerLifecycle: lifecycle };
      });
    } catch { /* the Job may have been superseded or made terminal */ }
  }

  private async recordWorkerExit(
    repoId: string,
    jobId: string,
    attempt: number,
    child: ChildProcess | undefined,
    lifecycle: ExecutionWorkerLifecycle,
    exitCode: number | null,
    signal: string | null,
    stderr: string,
    stderrTruncated: boolean,
    startupError?: string,
  ): Promise<void> {
    const diagnosticLifecycle: ExecutionWorkerLifecycle = {
      ...lifecycle,
      exitedAt: new Date().toISOString(),
      exitCode,
      signal,
      workerPid: child?.pid ?? lifecycle.workerPid,
      processGroupId: lifecycle.processGroupId ?? (process.platform !== 'win32' ? child?.pid : undefined),
      stderr,
      stderrTruncated,
      startupState: startupError ? 'spawn_failed' : 'exited',
    };
    try {
      const current = getExecutionJob(this.controllerHome, repoId, jobId);
      if (current.attempt !== attempt) return;
      if (child?.pid && current.workerPid !== undefined && current.workerPid !== child.pid) return;
      const currentLifecycle = current.workerLifecycle ?? lifecycle;
      const mergedLifecycle = { ...currentLifecycle, ...diagnosticLifecycle };
      if (['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(current.status)) {
        updateExecutionJob(this.controllerHome, repoId, jobId, (latest) => ({ ...latest, workerLifecycle: mergedLifecycle }));
        try { rebuildRepositoryProjection(this.controllerHome, repoId); } catch { /* the next scheduler/status read can retry */ }
        return;
      }

      // Prefer durable receipt recovery over sleep-based grace. When the Worker
      // already wrote a completed/delegated receipt for this attempt/PID/epoch/
      // lease ownership, finalize from that receipt and never emit WORKER_EXITED.
      const recovered = tryRecoverJobFromWorkerReceipt(this.controllerHome, current);
      if (recovered) {
        updateExecutionJob(this.controllerHome, repoId, jobId, (latest) => ({ ...latest, workerLifecycle: mergedLifecycle }));
        try { rebuildRepositoryProjection(this.controllerHome, repoId); } catch { /* the next scheduler/status read can retry */ }
        return;
      }
      const rechecked = getExecutionJob(this.controllerHome, repoId, jobId);
      if (rechecked.attempt !== attempt) return;
      const recheckedLifecycle = rechecked.workerLifecycle ?? lifecycle;
      const recheckedMerged = { ...recheckedLifecycle, ...diagnosticLifecycle };
      if (['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(rechecked.status)) {
        updateExecutionJob(this.controllerHome, repoId, jobId, (latest) => ({ ...latest, workerLifecycle: recheckedMerged }));
        try { rebuildRepositoryProjection(this.controllerHome, repoId); } catch { /* the next scheduler/status read can retry */ }
        return;
      }

      const details: Record<string, unknown> = {
        workerLostReason: startupError ? 'spawn_failed' : 'process_exit',
        executable: recheckedMerged.executable,
        cwd: recheckedMerged.cwd,
        exitCode,
        signal,
        stderr,
        stderrTruncated,
        stderrPath: recheckedMerged.stderrPath,
        processGroupId: recheckedMerged.processGroupId,
        ownerPid: recheckedMerged.ownerPid,
        runtimeInstanceId: recheckedMerged.runtimeInstanceId,
        releaseAuthorityRevision: recheckedMerged.releaseAuthorityRevision,
        releaseId: recheckedMerged.releaseId,
        artifactIdentity: recheckedMerged.artifactIdentity,
        workerProtocolVersion: recheckedMerged.workerProtocolVersion,
        attempt: rechecked.attempt,
        maxAttempts: rechecked.maxAttempts,
        ...(startupError ? { startupError } : {}),
      };
      const stderrSummary = stderr.trim() ? ` Worker stderr: ${stderr.trim()}` : '';
      const startupSummary = startupError ? ` Startup error: ${startupError}.` : '';
      const message = `Execution Worker ${recheckedMerged.executable} exited before completion (cwd ${recheckedMerged.cwd}, exit code ${exitCode ?? 'unknown'}${signal ? `, signal ${signal}` : ''}).${startupSummary}${stderrSummary}`;
      releaseExecutionLeases(this.controllerHome, repoId, jobId, rechecked.leaseRefs);
      const retryable = rechecked.attempt < rechecked.maxAttempts;
      transitionExecutionJob(this.controllerHome, repoId, jobId, retryable ? 'queued' : 'failed', {
        workerPid: undefined,
        heartbeatAt: undefined,
        leaseRefs: [],
        workerLifecycle: recheckedMerged,
        error: { code: startupError ? 'WORKER_START_FAILED' : 'WORKER_EXITED', message, retryable, details },
      });
      try { rebuildRepositoryProjection(this.controllerHome, repoId); } catch { /* the next scheduler/status read can retry */ }
    } catch { /* the Job may have been finalized by the Worker or reconciliation */ }
  }

  private spawnWorker(repoId: string, jobId: string): boolean {
    // A fenced Runtime must not consume the queue or dispatch Workers.
    const fence = assertRuntimeMayWrite('consume_queue', this.controllerHome);
    if (!fence.allowed) return false;
    const tracked = this.children.get(jobId);
    if (tracked?.pid && this.pidAlive(tracked.pid)) return false;
    const current = getExecutionJob(this.controllerHome, repoId, jobId);
    if (!['dispatched', 'running'].includes(current.status)) return false;
    if (current.workerPid && this.pidAlive(current.workerPid)) return false;
    const command = (() => {
      try { return this.workerCommand(); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lifecycle: ExecutionWorkerLifecycle = {
          executable: process.execPath,
          args: [],
          cwd: this.runtimeSourceRoot ?? process.cwd(),
          environment: this.workerEnvironment(),
          ownerPid: this.controllerPid,
          attempt: current.attempt,
          maxAttempts: current.maxAttempts,
          spawnedAt: new Date().toISOString(),
          startupState: 'spawn_failed',
        };
        this.persistSpawnedWorker(repoId, jobId, lifecycle);
        void this.recordWorkerExit(repoId, jobId, current.attempt, undefined, lifecycle, null, null, '', false, message);
        return undefined;
      }
    })();
    if (!command) return false;
    const bun = Boolean(process.versions.bun);
    const workerExecutable = resolveSchedulerWorkerExecutable(bun);
    // Pass the parent's captured Runtime owner and whole-release claim. A Worker
    // never re-adopts current authority after spawn; owner/release rotation fences it.
    const writeClaim = getRuntimeWriteClaim();
    const writeClaimEnvironment = writeClaim ? runtimeWriteClaimEnvironment(writeClaim) : {};
    const workerArgs = [
      '--controller-home', this.controllerHome,
      '--repo-id', repoId,
      '--job-id', jobId,
      '--controller-pid', String(this.controllerPid),
    ];
    const args = bun
      ? [command.entry, ...workerArgs]
      : ['--loader', command.loader, command.entry, ...workerArgs];
    const environment: Record<string, string | undefined> = {
      ...process.env,
      FORGE_EXECUTION_WORKER: '1',
      FORGE_CONTROLLER_HOME: this.controllerHome,
      ...(this.runtimeSourceRoot ? { FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT: this.runtimeSourceRoot } : {}),
      ...writeClaimEnvironment,
    };
    const stderrPath = join(executionJobRoot(this.controllerHome, repoId), 'worker-stderr', `${jobId}-attempt-${current.attempt}.log`);
    mkdirSync(dirname(stderrPath), { recursive: true });
    writeFileSync(stderrPath, '', 'utf8');
    const lifecycle: ExecutionWorkerLifecycle = {
      executable: workerExecutable,
      args,
      cwd: command.cwd,
      environment: Object.fromEntries(WORKER_ENVIRONMENT_KEYS.map((key) => [key, environment[key]])),
      ownerPid: this.controllerPid,
      ...(writeClaim ? {
        runtimeInstanceId: writeClaim.runtimeInstanceId,
        releaseAuthorityRevision: writeClaim.releaseAuthorityRevision,
        releaseId: writeClaim.releaseId,
        artifactIdentity: writeClaim.artifactIdentity,
        workerProtocolVersion: writeClaim.workerProtocolVersion,
      } : {}),
      attempt: current.attempt,
      maxAttempts: current.maxAttempts,
      spawnedAt: new Date().toISOString(),
      stderrPath,
      startupState: 'spawned',
    };
    this.persistSpawnedWorker(repoId, jobId, lifecycle);
    let child: ChildProcess;
    try {
      child = spawn(workerExecutable, args, {
        cwd: command.cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: process.platform !== 'win32',
        env: environment,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void this.recordWorkerExit(repoId, jobId, current.attempt, undefined, lifecycle, null, null, '', false, message);
      return false;
    }
    let stderr = '';
    let stderrBytes = 0;
    let stderrTruncated = false;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const bytes = Buffer.byteLength(text);
      const remaining = MAX_WORKER_STDERR_BYTES - stderrBytes;
      const accepted = remaining > 0 ? Buffer.from(text).subarray(0, remaining).toString('utf8') : '';
      if (accepted) {
        stderr += accepted;
        stderrBytes += Buffer.byteLength(accepted);
        try { appendFileSync(stderrPath, accepted, 'utf8'); } catch { stderrTruncated = true; }
      }
      if (bytes > Math.max(0, remaining)) stderrTruncated = true;
    });
    let finalized = false;
    const finalize = (exitCode: number | null, signal: string | null, startupError?: string) => {
      if (finalized) return;
      finalized = true;
      if (this.children.get(jobId) === child) this.children.delete(jobId);
      void this.recordWorkerExit(repoId, jobId, current.attempt, child, lifecycle, exitCode, signal, stderr, stderrTruncated, startupError);
    };
    child.once('error', (error) => finalize(null, null, error.message));
    child.once('close', (code, signal) => finalize(code, signal));
    if (!child.pid) {
      child.unref();
      return false;
    }
    this.children.set(jobId, child);
    const attached = attachExecutionWorker(this.controllerHome, repoId, jobId, child.pid);
    if (!attached) {
      this.children.delete(jobId);
      void terminateProcessTree(child.pid);
      child.unref();
      return false;
    }
    try {
      updateExecutionJob(this.controllerHome, repoId, jobId, (latest) => ({
        ...latest,
        workerLifecycle: latest.workerLifecycle
          ? { ...latest.workerLifecycle, attachedAt: new Date().toISOString(), processGroupId: process.platform !== 'win32' ? child.pid : undefined, workerPid: child.pid, startupState: 'registered' }
          : { ...lifecycle, attachedAt: new Date().toISOString(), processGroupId: process.platform !== 'win32' ? child.pid : undefined, workerPid: child.pid, startupState: 'registered' },
      }));
    } catch { /* close/reconciliation may have finalized the Job */ }
    child.unref();
    return true;
  }

  private refreshDarwinAvailableMemoryMb(fallback: number): void {
    if (this.darwinMemorySampleInFlight) return;
    this.lastDarwinMemorySampleAt = Date.now();
    this.darwinMemorySampleInFlight = sampleDarwinAvailableMemoryMb(fallback)
      .then((availableMemoryMb) => {
        this.cachedDarwinAvailableMemoryMb = availableMemoryMb;
      })
      .catch(() => {
        this.cachedDarwinAvailableMemoryMb = fallback;
      })
      .finally(() => {
        this.darwinMemorySampleInFlight = undefined;
      });
  }

  private availableMemoryMb(now = Date.now()): number {
    const fallback = freemem() / (1024 * 1024);
    if (process.platform !== 'darwin') return fallback;
    const cached = this.cachedDarwinAvailableMemoryMb;
    if (cached !== undefined && now - this.lastDarwinMemorySampleAt < DARWIN_MEMORY_SAMPLE_TTL_MS) {
      return cached;
    }

    this.refreshDarwinAvailableMemoryMb(fallback);
    return cached ?? fallback;
  }

  private resourcePressure(): { pressured: boolean; freeMemoryMb: number; loadPerCpu: number } {
    const freeMemoryMb = this.availableMemoryMb();
    const loadPerCpu = loadavg()[0] / Math.max(1, cpus().length);
    return {
      pressured: isSchedulerResourcePressured(
        { freeMemoryMb, loadPerCpu },
        { minFreeMemoryMb: this.config.minFreeMemoryMb, maxLoadPerCpu: this.config.maxLoadPerCpu },
      ),
      freeMemoryMb,
      loadPerCpu,
    };
  }

  private agentProvider(job: { payload: { arguments?: Record<string, unknown> } }): 'codex' | 'claude' | 'github-copilot' {
    const agent = job.payload.arguments?.agent;
    if (agent === 'claude' || agent === 'github-copilot') return agent;
    return 'codex';
  }

  async tick(): Promise<{ activeJobs: number }> {
    const now = Date.now();
    this.lastHeartbeatAt = new Date(now).toISOString();
    this.lastTickAt = this.lastHeartbeatAt;
    this.persistState();
    const repositories = this.repositoryList(this.controllerHome).filter((repo) => repo.enabled && !repo.removedAt);
    if (now - this.lastCleanupAt >= RUNTIME_CLEANUP_INTERVAL_MS) {
      // Advance the interval before cleanup so a failing pass cannot create a
      // tight retry loop on every scheduler tick.
      this.lastCleanupAt = now;
      try {
        this.runtimeCleanup(this.controllerHome, {
          reason: 'periodic',
          nowMs: now,
          protectedControllerPid: this.controllerPid,
        });
      } catch (error) {
        console.error('[forge cleanup] periodic cleanup failed:', error);
      }
      try {
        await this.terminalWorkCleanup(this.controllerHome, { nowMs: now });
      } catch (error) {
        console.error('[forge cleanup] terminal Work cleanup failed:', error);
      }
      if (repositories.length > 0) {
        const slot = Math.floor(now / RUNTIME_CLEANUP_INTERVAL_MS) % repositories.length;
        const repo = repositories[slot]!;
        const result = this.processGc({ controllerHome: this.controllerHome, repoId: repo.repoId });
        if (!result.ok) console.error('[forge cleanup] Process GC failed:', result.error ?? 'unknown error');
      }
    }
    if (now - this.lastReconcile >= 5_000) {
      await reconcileExecutionJobsAsync(this.controllerHome);
      for (const repository of repositories) {
        const validation = this.workValidationReconcile(this.controllerHome, repository.repoId, 500);
        if (validation.errors.length > 0) {
          console.error(
            `[forge validation] background Work reconciliation reported ${validation.errors.length} error(s) for ${repository.repoId}`,
          );
        }
        const editValidation = await this.editValidationReconcile(this.controllerHome, repository, 200);
        if (editValidation.errors.length > 0) {
          console.error(
            `[forge validation] background EditSession reconciliation reported ${editValidation.errors.length} error(s) for ${repository.repoId}`,
          );
        }
      }
      this.lastReconcile = now;
      this.lastReconcileAt = new Date(now).toISOString();
    }
    const activeJobSnapshot = listActiveExecutionJobs(this.controllerHome);
    const activeSourceRepoIds = new Set(activeJobSnapshot.map((job) => job.repoId));
    const sourceScanRepositories = selectSchedulerSourceScanRepositories(
      repositories,
      activeSourceRepoIds,
      now,
      this.lastSourceScanAt,
    );
    const sourceScanDue = sourceScanRepositories.length > 0;
    if (sourceScanDue && now - this.lastGitStatusSampleAt >= GIT_STATUS_SAMPLE_INTERVAL_MS) {
      this.lastGitStatusSampleAt = now;
      this.lastSourceScanAt = now;
      this.lastSourceScanRepoCount = sourceScanRepositories.length;
      sampleRepositoryGitStatusForRepositories(this.controllerHome, sourceScanRepositories);
      this.sourceScansAvoided += Math.max(0, repositories.length - sourceScanRepositories.length);
    } else if (!sourceScanDue) {
      // fs.watch wakeups cover active mutations; a bounded safety rescan keeps
      // idle repositories fresh without re-running a full source scan per tick.
      this.sourceScansAvoided += repositories.length;
    }
    // Phase 0 reuses one durable Work admission policy. Cleanup, stale-state
    // reconciliation, and read-only source sampling above remain available, but
    // ordinary schedule/workflow advancement and Worker dispatch stop here.
    if (!schedulerDispatchAllowed(this.controllerHome)) {
      this.lastHeartbeatAt = new Date().toISOString();
      this.persistState(true);
      return { activeJobs: activeJobSnapshot.length };
    }
    // Scheduler observation ends admission and starts the independent queue
    // budget. This runs outside the global dispatch lock because each Job owns
    // its own atomic state transition.
    for (const job of listActiveExecutionJobs(this.controllerHome)) {
      if (job.status === 'running' || job.timings?.schedulerObservedAt) continue;
      try {
        markExecutionJobSchedulerObserved(this.controllerHome, job.repoId, job.jobId);
      } catch {
        // Another scheduler or a terminal transition won the Job-local race.
      }
    }
    if (now - this.lastScheduleTick >= 30_000) {
      await tickSchedules(this.controllerHome, repositories.map((repo) => repo.repoId));
      this.lastScheduleTick = now;
    }
    let activeJobs = 0;
    const pendingSpawns: Array<{ repoId: string; jobId: string }> = [];
    const projectionRefreshRepos = new Set<string>();
    const pressure = this.resourcePressure();
    try {
      activeJobs = withControllerLock(
        this.controllerHome,
        {
          scope: 'task',
          repoId: '__controller__',
          taskId: 'global-scheduler-dispatch',
        },
        `global-scheduler:${this.controllerPid}`,
        () => {
          const active = listActiveExecutionJobs(this.controllerHome);
          const reserved = active.filter((job) => job.status === 'running' || job.status === 'dispatched');
          let capacity = this.config.maxWorkers - reserved.length;
          if (capacity <= 0) return active.length;

          let heavyCapacity = this.config.maxHeavyChecks
            - reserved.filter((job) => job.type === 'check' || job.type === 'verify-edit').length;
          const reservedAgents = reserved.filter((job) => job.type === 'agent-run' || job.type === 'dispatch-task');
          let agentCapacity = this.config.maxAgentProcesses - reservedAgents.length;
          const providerCapacity = new Map([
            ['codex', this.config.maxCodexProcesses - reservedAgents.filter((job) => this.agentProvider(job) === 'codex').length],
            ['claude', this.config.maxClaudeProcesses - reservedAgents.filter((job) => this.agentProvider(job) === 'claude').length],
            ['github-copilot', this.config.maxGitHubProcesses - reservedAgents.filter((job) => this.agentProvider(job) === 'github-copilot').length],
          ] as const);
          if (pressure.pressured) {
            // Under host pressure, keep one recovery slot available so queued read-only
            // or bounded repository work does not stall forever behind a global stop.
            capacity = Math.min(capacity, 1);
            heavyCapacity = Math.min(heavyCapacity, 1);
            agentCapacity = 0;
            providerCapacity.set('codex', 0);
            providerCapacity.set('claude', 0);
            providerCapacity.set('github-copilot', 0);
          }
          if (capacity <= 0) return active.length;

          const scheduleNow = Date.now();
          const waiting = active.filter(isExecutionJobDispatchCandidate);
          const rankByJobId = new Map(
            waiting.map((job) => [job.jobId, rankExecutionJobForDispatch(job, scheduleNow)] as const),
          );
          const compareWaiting = (left: (typeof active)[number], right: (typeof active)[number]): number =>
            compareExecutionJobDispatchRanks(rankByJobId.get(left.jobId)!, rankByJobId.get(right.jobId)!);
          const topByRepo = new Map<string, (typeof active)[number]>();
          for (const job of waiting.slice().sort(compareWaiting)) {
            if (!topByRepo.has(job.repoId)) topByRepo.set(job.repoId, job);
          }
          const repoIds = [...topByRepo.keys()].sort((left, right) => {
            const leftTop = topByRepo.get(left)!;
            const rightTop = topByRepo.get(right)!;
            const leftRank = rankByJobId.get(leftTop.jobId)!;
            const rightRank = rankByJobId.get(rightTop.jobId)!;
            const priority = leftRank.effectivePriority - rightRank.effectivePriority;
            if (priority !== 0) return priority;
            const fairness = (this.lastRepoDispatch.get(left) ?? 0) - (this.lastRepoDispatch.get(right) ?? 0);
            return fairness
              || leftRank.queuedAtMs - rightRank.queuedAtMs
              || leftRank.jobId.localeCompare(rightRank.jobId)
              || left.localeCompare(right);
          });
          const reservedRepos = new Set(reserved.map((job) => job.repoId));
          let dispatchStateChanged = false;
          const canDispatch = (job: (typeof active)[number]): boolean => {
            if ((job.type === 'check' || job.type === 'verify-edit') && heavyCapacity <= 0) return false;
            if (job.type === 'agent-run' || job.type === 'dispatch-task') {
              if (agentCapacity <= 0) return false;
              if ((providerCapacity.get(this.agentProvider(job)) ?? 0) <= 0) return false;
            }
            return true;
          };
          for (const repoId of repoIds) {
            if (capacity <= 0) break;
            if (!reservedRepos.has(repoId) && reservedRepos.size >= this.config.maxConcurrentRepositories) continue;
            const actor = this.actors.get(repoId);
            let dispatch: ReturnType<typeof actor.tryClaimNext>;
            try {
              dispatch = actor.tryClaimNext({
                scheduleNow,
                canDispatch,
                refreshProjection: false,
                lockWaitMs: 0,
              });
              projectionRefreshRepos.add(repoId);
            } catch (error) {
              if (error instanceof Error && error.message.startsWith('LOCK_HELD:')) continue;
              throw error;
            }
            if (!dispatch) continue;

            // A successful claim is the capacity reservation. Count it immediately,
            // before the worker PID is spawned or attached, so concurrent schedulers
            // cannot over-dispatch through the dispatched -> running window.
            capacity -= 1;
            reservedRepos.add(repoId);
            if (dispatch.job.type === 'check' || dispatch.job.type === 'verify-edit') heavyCapacity -= 1;
            if (dispatch.job.type === 'agent-run' || dispatch.job.type === 'dispatch-task') {
              agentCapacity -= 1;
              const provider = this.agentProvider(dispatch.job);
              providerCapacity.set(provider, (providerCapacity.get(provider) ?? 0) - 1);
            }
            const dispatchedAt = Date.now();
            this.lastRepoDispatch.set(repoId, dispatchedAt);
            this.lastDispatchAt = new Date(dispatchedAt).toISOString();
            dispatchStateChanged = true;
            pendingSpawns.push({ repoId, jobId: dispatch.job.jobId });
          }
          if (dispatchStateChanged) this.persistState(true);
          return active.length;
        },
        5_000,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('LOCK_HELD:')) throw error;
      // Another scheduler owns the global dispatch reservation. Fail closed and
      // leave all jobs queued for the next wake/tick rather than risking overrun.
      activeJobs = listActiveExecutionJobs(this.controllerHome).length;
    }
    // Repo Actor mutations leave projection dirty markers. Refresh those repos
    // immediately; the independent source safety scan contributes only its bounded
    // active/round-robin candidates after the dispatch reservation lock is free.
    const projectionRefreshCandidates = new Map(
      sourceScanRepositories.map((repository) => [repository.repoId, repository]),
    );
    for (const repoId of projectionRefreshRepos) {
      const repository = repositories.find((entry) => entry.repoId === repoId);
      if (repository) projectionRefreshCandidates.set(repoId, repository);
    }
    for (const repoId of projectionRefreshRepos) {
      if (projectionRefreshCandidates.has(repoId)) continue;
      try {
        rebuildRepositoryProjection(this.controllerHome, repoId);
      } catch (error) {
        console.error('[forge scheduler] projection refresh failed:', error);
      }
    }
    for (const repository of projectionRefreshCandidates.values()) {
      try {
        const sample = readRepositoryGitStatusSample(
          this.controllerHome,
          repository.repoId,
          repository.activeCheckoutId,
        );
        const runtimeInstanceId = getRuntimeWriteClaim()?.runtimeInstanceId;
        refreshRepositoryProjectionForRepository(this.controllerHome, repository, {
          sourceRevision: sample?.head ?? undefined,
          reason: 'scheduler-source-scan',
          owner: {
            pid: this.controllerPid,
            ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
          },
        });
      } catch (error) {
        console.error('[forge scheduler] projection refresh failed:', error);
      }
    }
    // Process creation, lifecycle file writes, and Worker attachment are all
    // deliberately outside the global dispatch reservation lock. The durable
    // dispatched state is the capacity reservation while spawn proceeds.
    for (const pending of pendingSpawns) {
      this.spawnWorker(pending.repoId, pending.jobId);
    }
    this.lastHeartbeatAt = new Date().toISOString();
    this.persistState();
    return { activeJobs };
  }

  async run(signal?: AbortSignal): Promise<void> {
    try {
      writeAgentExecutableReadinessSnapshot(this.controllerHome);
    } catch (error) {
      console.error(
        '[forge scheduler] Agent executable readiness probe failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    this.lastHeartbeatAt = new Date().toISOString();
    this.persistState(true);
    const heartbeatTimer = setInterval(() => {
      this.lastHeartbeatAt = new Date().toISOString();
      // Upgrade bridge: Supervisors released before lastHeartbeatAt existed
      // still evaluate lastTickAt with a five-second timeout. Mirror the
      // process heartbeat until those readers have been replaced.
      this.lastTickAt = this.lastHeartbeatAt;
      this.persistState(true);
    }, this.config.heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    let idleStreak = 0;
    let activeJobs = 0;
    try {
      while (!signal?.aborted) {
        try {
          activeJobs = (await this.tick()).activeJobs;
          idleStreak = activeJobs === 0 ? idleStreak + 1 : 0;
        } catch (error) {
          if (this.fatalOnTickError) throw error;
          idleStreak = 0;
          this.lastHeartbeatAt = new Date().toISOString();
          this.lastTickAt = this.lastHeartbeatAt;
          this.persistState(true);
          console.error('[forge scheduler] tick failed:', error);
        }
        const delayMs = idleStreak > 0
          ? Math.min(
            this.config.idleBackoffMaxMs,
            this.config.pollIntervalMs * (2 ** Math.min(idleStreak, 6)),
          )
          : this.config.pollIntervalMs;
        const wakeRevision = readSchedulerWakeSignal(this.controllerHome).revision;
        const waitResult = await waitForSchedulerWakeSignal(this.controllerHome, wakeRevision, delayMs, signal, {
          fallbackPollMs: activeJobs > 0 ? 250 : Math.min(1_000, Math.max(500, delayMs)),
        });
        if (waitResult === 'aborted') break;
      }
    } finally {
      clearInterval(heartbeatTimer);
      await this.cleanupSpawnedWorkers();
    }
  }
}
