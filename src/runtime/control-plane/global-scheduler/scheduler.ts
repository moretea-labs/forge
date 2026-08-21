import { execFile, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { cpus, freemem, loadavg } from 'os';
import { listRepositories } from '../../../cli/repositories/registry';
import { writeAgentExecutableReadinessSnapshot } from '../../../cli/agent-jobs/executable-resolver';
import { withControllerLock } from '../../../cli/repositories/locks';
import {
  assertRuntimeMayWrite,
  getRuntimeWriteClaim,
  runtimeWriteClaimEnvironment,
} from '../../root/write-fence';
import {
  getExecutionJob,
  listActiveExecutionJobs,
  markExecutionJobSchedulerObserved,
} from '../../execution/jobs/store';
import { type ExecutionWorkerLifecycle } from '../../execution/jobs/types';
import { RepoActorRegistry } from '../repo-actor/registry';
import { reconcileExecutionJobsAsync } from './reconciliation';
import { tickSchedules } from '../../workflow/schedules/engine';
import { isProcessAlive } from '../../shared/process-tree';
import { readSchedulerWakeSignal, waitForSchedulerWakeSignal } from './wake-signal';
import { cleanupControllerRuntimeState } from '../runtime-cleanup';
import { reconcileTerminalWorkCleanups } from '../execution/work-terminal-cleanup';
import { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import { reconcilePendingWorkValidations } from '../execution/work-validation-reconciler';
import { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';
import { schedulerDispatchAllowed } from '../facade/work-admission-policy';
import { sampleRepositoryGitStatusForRepositories } from '../../projections/git-status-sampler';
import { selectExecutionJobDispatchRepositories } from '../dispatch-priority';
import {
  buildSchedulerWorkerLaunchDescriptor,
  resolveSchedulerWorkerCommand,
  selectSchedulerWorkerEnvironment,
} from './worker-launch';
import {
  consumeSchedulerDispatchCapacity,
  createSchedulerDispatchCapacity,
  schedulerDispatchCapacityAllows,
} from './dispatch-capacity';
import { refreshSchedulerRepositoryProjections } from './projection-refresh';
import { createSchedulerWorkerStderrCapture } from './worker-stderr';
import { persistSchedulerWorkerAttachment } from './worker-attachment';
import {
  cleanupSchedulerWorkerProcesses,
  registerSchedulerWorkerProcess,
  spawnSchedulerWorkerProcess,
  wireSchedulerWorkerProcess,
} from './worker-process';
import { reconcileSchedulerWorkerExit } from './worker-exit-reconciler';
import { persistSchedulerSpawnedWorkerLifecycle } from './worker-lifecycle-store';
import {
  buildSchedulerWorkerExitedLifecycle,
  buildSchedulerWorkerSpawnFailureLifecycle,
  buildSchedulerWorkerSpawnedLifecycle,
} from './worker-lifecycle';
import { normalizeSchedulerConfig, type SchedulerConfig } from './config';
import {
  readSchedulerHealthSnapshot,
  restoreSchedulerState,
  writeSchedulerHealthSnapshot,
} from './state';
export { normalizeSchedulerConfig } from './config';
export type { SchedulerConfig } from './config';
export {
  buildSchedulerHealthSnapshot,
  readSchedulerHealthSnapshot,
  restoreSchedulerState,
} from './state';
export type {
  SchedulerHealthSnapshot,
  SchedulerRestoredState,
  SchedulerStateSnapshotInput,
} from './state';
export {
  buildSchedulerWorkerLaunchDescriptor,
  resolveSchedulerWorkerCommand,
  resolveSchedulerWorkerExecutable,
  selectSchedulerWorkerEnvironment,
} from './worker-launch';
export type { SchedulerWorkerCommand, SchedulerWorkerLaunchDescriptor } from './worker-launch';

const DARWIN_MEMORY_SAMPLE_TTL_MS = 5_000;
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

export interface SchedulerRuntimeBinding {
  controllerPid?: number;
  runtimeSourceRoot?: string;
  workerEntrypoint?: string;
  /** Canonical Runtime treats a tick failure as a whole-Runtime failure. */
  fatalOnTickError?: boolean;
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
    this.config = normalizeSchedulerConfig(config);
    this.runtimeSourceRoot = runtime.runtimeSourceRoot ? resolve(runtime.runtimeSourceRoot) : undefined;
    this.workerEntrypoint = runtime.workerEntrypoint ? resolve(runtime.workerEntrypoint) : undefined;
    this.fatalOnTickError = runtime.fatalOnTickError === true;
    const restoredState = restoreSchedulerState(readSchedulerHealthSnapshot(controllerHome));
    this.lastSourceScanAt = restoredState.lastSourceScanAt;
    this.lastSourceScanRepoCount = restoredState.lastSourceScanRepoCount;
    this.sourceScansAvoided = restoredState.sourceScansAvoided;
    for (const [repoId, timestamp] of restoredState.lastRepoDispatch) this.lastRepoDispatch.set(repoId, timestamp);
  }

  private persistState(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPersistedAt < 1_000) return;
    this.lastPersistedAt = now;
    writeSchedulerHealthSnapshot(this.controllerHome, {
      loopStartedAt: this.loopStartedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
      lastTickAt: this.lastTickAt,
      lastDispatchAt: this.lastDispatchAt,
      lastReconcileAt: this.lastReconcileAt,
      lastSourceScanAt: this.lastSourceScanAt,
      lastSourceScanRepoCount: this.lastSourceScanRepoCount,
      sourceScansAvoided: this.sourceScansAvoided,
      lastRepoDispatch: this.lastRepoDispatch,
    }, now);
  }

  private pidAlive(pid: number | undefined): boolean {
    return isProcessAlive(pid);
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
    const diagnosticLifecycle = buildSchedulerWorkerExitedLifecycle({
      lifecycle,
      childPid: child?.pid,
      exitCode,
      signal,
      stderr,
      stderrTruncated,
      startupError,
    });
    reconcileSchedulerWorkerExit({
      controllerHome: this.controllerHome,
      repoId,
      jobId,
      attempt,
      childPid: child?.pid,
      lifecycle,
      diagnosticLifecycle,
      exitCode,
      signal,
      stderr,
      stderrTruncated,
      startupError,
    });
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
      try {
        return resolveSchedulerWorkerCommand({
          runtimeSourceRoot: this.runtimeSourceRoot,
          workerEntrypoint: this.workerEntrypoint,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lifecycle = buildSchedulerWorkerSpawnFailureLifecycle({
          executable: process.execPath,
          cwd: this.runtimeSourceRoot ?? process.cwd(),
          environment: selectSchedulerWorkerEnvironment(process.env),
          ownerPid: this.controllerPid,
          attempt: current.attempt,
          maxAttempts: current.maxAttempts,
        });
        persistSchedulerSpawnedWorkerLifecycle({
          controllerHome: this.controllerHome,
          repoId,
          jobId,
          lifecycle,
        });
        void this.recordWorkerExit(repoId, jobId, current.attempt, undefined, lifecycle, null, null, '', false, message);
        return undefined;
      }
    })();
    if (!command) return false;
    // Pass the parent's captured Runtime owner and whole-release claim. A Worker
    // never re-adopts current authority after spawn; owner/release rotation fences it.
    const writeClaim = getRuntimeWriteClaim();
    const launch = buildSchedulerWorkerLaunchDescriptor({
      command,
      controllerHome: this.controllerHome,
      repoId,
      jobId,
      controllerPid: this.controllerPid,
      runtimeSourceRoot: this.runtimeSourceRoot,
      writeClaimEnvironment: writeClaim ? runtimeWriteClaimEnvironment(writeClaim) : {},
    });
    const stderrCapture = createSchedulerWorkerStderrCapture({
      controllerHome: this.controllerHome,
      repoId,
      jobId,
      attempt: current.attempt,
    });
    const lifecycle = buildSchedulerWorkerSpawnedLifecycle({
      launch,
      ownerPid: this.controllerPid,
      releaseIdentity: writeClaim ? {
        runtimeInstanceId: writeClaim.runtimeInstanceId,
        releaseAuthorityRevision: writeClaim.releaseAuthorityRevision,
        releaseId: writeClaim.releaseId,
        artifactIdentity: writeClaim.artifactIdentity,
        workerProtocolVersion: writeClaim.workerProtocolVersion,
      } : undefined,
      attempt: current.attempt,
      maxAttempts: current.maxAttempts,
      stderrPath: stderrCapture.path,
    });
    persistSchedulerSpawnedWorkerLifecycle({
      controllerHome: this.controllerHome,
      repoId,
      jobId,
      lifecycle,
    });
    const spawned = spawnSchedulerWorkerProcess(launch);
    if (!spawned.ok) {
      void this.recordWorkerExit(
        repoId,
        jobId,
        current.attempt,
        undefined,
        lifecycle,
        null,
        null,
        '',
        false,
        spawned.startupError,
      );
      return false;
    }
    const child = spawned.child;
    wireSchedulerWorkerProcess({
      jobId,
      child,
      children: this.children,
      stderrCapture,
      onExit: ({ exitCode, signal, stderr, stderrTruncated, startupError }) => {
        void this.recordWorkerExit(
          repoId,
          jobId,
          current.attempt,
          child,
          lifecycle,
          exitCode,
          signal,
          stderr,
          stderrTruncated,
          startupError,
        );
      },
    });
    return registerSchedulerWorkerProcess({
      jobId,
      child,
      children: this.children,
      attach: (workerPid) => persistSchedulerWorkerAttachment({
        controllerHome: this.controllerHome,
        repoId,
        jobId,
        workerPid,
        lifecycle,
      }),
    });
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
          const capacity = createSchedulerDispatchCapacity(active, this.config, pressure.pressured);
          if (capacity.workers <= 0) return active.length;

          const scheduleNow = Date.now();
          const repoIds = selectExecutionJobDispatchRepositories(active, scheduleNow, this.lastRepoDispatch);
          const reservedRepos = new Set(capacity.reservedJobs.map((job) => job.repoId));
          let dispatchStateChanged = false;
          const canDispatch = (job: (typeof active)[number]): boolean => schedulerDispatchCapacityAllows(capacity, job);
          for (const repoId of repoIds) {
            if (capacity.workers <= 0) break;
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
            consumeSchedulerDispatchCapacity(capacity, dispatch.job);
            reservedRepos.add(repoId);
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
    refreshSchedulerRepositoryProjections({
      controllerHome: this.controllerHome,
      repositories,
      sourceScanRepositories,
      projectionRefreshRepoIds: projectionRefreshRepos,
      controllerPid: this.controllerPid,
    });
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
      await cleanupSchedulerWorkerProcesses(this.children);
    }
  }
}
