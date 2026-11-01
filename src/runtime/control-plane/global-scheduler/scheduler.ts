import { execFile, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { cpus, freemem, loadavg } from 'os';
import { listRepositories } from '../../../cli/repositories/registry';
import { writeAgentExecutableReadinessSnapshot } from '../../../cli/agent-jobs/executable-resolver';
import {
  assertRuntimeMayWrite,
  getRuntimeWriteClaim,
  runtimeWriteClaimEnvironment,
} from '../../root/write-fence';
import { isProcessAlive } from '../../shared/process-tree';
import { readSchedulerWakeSignal, waitForSchedulerWakeSignal } from './wake-signal';
import { cleanupControllerRuntimeState } from '../runtime-cleanup';
import { reconcileTerminalWorkCleanups } from '../execution/work-terminal-cleanup';
import { gcTerminalProcesses } from '../../execution/process-runtime/gc';
import { reconcilePendingWorkValidations } from '../execution/work-validation-reconciler';
import { reconcilePendingEditValidations } from '../execution/edit-validation-coordinator';
import {
  runSchedulerPeriodicCleanup,
  runSchedulerValidationReconciliation,
} from './maintenance';
import { planSchedulerSourceSampling } from './source-scan';
import { tickSchedules } from '../../workflow/schedules/engine';
import { sampleRepositoryGitStatusForRepositories } from '../../projections/git-status-sampler';
import {
  refreshSchedulerRepositoryProjections,
  selectSchedulerDirtyProjectionRepositories,
} from './projection-refresh';
import { reconcileWorkExecutionConcurrencyWaits } from '../concurrency/work-execution-concurrency';
import { cleanupSchedulerWorkerProcesses } from './worker-process';
import {
  spawnSchedulerPeriodicCleanup,
  type SchedulerPeriodicCleanupSpawnResult,
} from './periodic-cleanup-process';
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
export { selectSchedulerSourceScanRepositories } from './source-scan';

const SCHEDULE_TICK_INTERVAL_MS = 30_000;
export const SCHEDULER_RECONCILIATION_INTERVAL_MS = 5_000;
const RUNTIME_CLEANUP_INTERVAL_MS = Math.max(30_000, Number(process.env.FORGE_RUNTIME_CLEANUP_INTERVAL_MS ?? 60_000));

function remainingRecurringDeadlineMs(nowMs: number, lastRanAt: number, intervalMs: number): number {
  if (lastRanAt <= 0) return intervalMs;
  const elapsed = Math.max(0, nowMs - lastRanAt);
  return elapsed < intervalMs ? intervalMs - elapsed : intervalMs;
}

export function schedulerIdleWaitDelayMs(input: {
  nowMs: number;
  lastScheduleTickAt: number;
}): number {
  // Idle execution is event-driven. ExecutionJob/lease/policy mutations and
  // check Process terminal persistence wake the scheduler immediately through
  // the existing notification revision. The 30-second schedule cadence is the
  // bounded idle lost-event safety deadline.
  return remainingRecurringDeadlineMs(
    input.nowMs,
    input.lastScheduleTickAt,
    SCHEDULE_TICK_INTERVAL_MS,
  );
}

export function schedulerActiveWaitDelayMs(input: {
  nowMs: number;
  lastReconcileAt: number;
}): number {
  // Active execution uses the same canonical wake notifications as idle
  // execution. A full scheduler tick is only the lost-event safety net, bounded
  // by the existing reconciliation cadence instead of the legacy 250ms poll.
  return remainingRecurringDeadlineMs(
    input.nowMs,
    input.lastReconcileAt,
    SCHEDULER_RECONCILIATION_INTERVAL_MS,
  );
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
  workerExecutable?: string;
  periodicCleanupExecutable?: string;
  /** Canonical in-process Runtime isolates periodic cleanup from the public event loop. */
  isolatePeriodicCleanup?: boolean;
  /** Canonical Runtime treats a tick failure as a whole-Runtime failure. */
  fatalOnTickError?: boolean;
}

export class GlobalScheduler {
  private readonly controllerHome: string;
  private readonly maintenanceChildren = new Map<string, ChildProcess>();
  private readonly config: SchedulerConfig;
  private readonly controllerPid: number;
  private readonly runtimeSourceRoot?: string;
  private readonly periodicCleanupExecutable?: string;
  private readonly isolatePeriodicCleanup: boolean;
  private readonly fatalOnTickError: boolean;
  private lastScheduleTick = 0;
  private lastReconcile = 0;
  private lastPersistedAt = 0;
  private readonly loopStartedAt = new Date().toISOString();
  private lastHeartbeatAt = this.loopStartedAt;
  private lastTickAt = this.loopStartedAt;
  private lastReconcileAt: string | undefined;
  private lastCleanupAt = 0;
  private lastGitStatusSampleAt = 0;
  private lastSourceScanAt = 0;
  private lastSourceScanRepoCount = 0;
  private sourceScansAvoided = 0;
  private runtimeCleanup = cleanupControllerRuntimeState;
  private terminalWorkCleanup = reconcileTerminalWorkCleanups;
  private processGc = gcTerminalProcesses;
  private periodicCleanupSpawn = spawnSchedulerPeriodicCleanup;
  private workExecutionConcurrencyReconcile = reconcileWorkExecutionConcurrencyWaits;
  private workValidationReconcile = reconcilePendingWorkValidations;
  private editValidationReconcile = reconcilePendingEditValidations;
  private repositoryList = listRepositories;

  constructor(
    controllerHome: string,
    config: Partial<SchedulerConfig> = {},
    runtime: SchedulerRuntimeBinding = {},
  ) {
    this.controllerHome = controllerHome;
    this.controllerPid = runtime.controllerPid ?? process.pid;
    this.config = normalizeSchedulerConfig(config);
    this.runtimeSourceRoot = runtime.runtimeSourceRoot ? resolve(runtime.runtimeSourceRoot) : undefined;
    this.periodicCleanupExecutable = runtime.periodicCleanupExecutable ? resolve(runtime.periodicCleanupExecutable) : undefined;
    this.isolatePeriodicCleanup = runtime.isolatePeriodicCleanup === true;
    this.fatalOnTickError = runtime.fatalOnTickError === true;
    const restoredState = restoreSchedulerState(readSchedulerHealthSnapshot(controllerHome));
    this.lastSourceScanAt = restoredState.lastSourceScanAt;
    this.lastSourceScanRepoCount = restoredState.lastSourceScanRepoCount;
    this.sourceScansAvoided = restoredState.sourceScansAvoided;
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
      lastReconcileAt: this.lastReconcileAt,
      lastSourceScanAt: this.lastSourceScanAt,
      lastSourceScanRepoCount: this.lastSourceScanRepoCount,
      sourceScansAvoided: this.sourceScansAvoided,
    }, now);
  }

  private pidAlive(pid: number | undefined): boolean {
    return isProcessAlive(pid);
  }

  private launchPeriodicCleanup(nowMs: number): boolean {
    const key = 'periodic-runtime-cleanup';
    const tracked = this.maintenanceChildren.get(key);
    if (tracked?.pid && this.pidAlive(tracked.pid)) return false;
    if (tracked) this.maintenanceChildren.delete(key);

    const fence = assertRuntimeMayWrite('cleanup', this.controllerHome);
    if (!fence.allowed) return false;
    const writeClaim = getRuntimeWriteClaim();
    const spawned: SchedulerPeriodicCleanupSpawnResult = this.periodicCleanupSpawn({
      controllerHome: this.controllerHome,
      controllerPid: this.controllerPid,
      nowMs,
      cleanupIntervalMs: RUNTIME_CLEANUP_INTERVAL_MS,
      runtimeSourceRoot: this.periodicCleanupExecutable ? undefined : this.runtimeSourceRoot,
      cleanupExecutable: this.periodicCleanupExecutable,
      writeClaimEnvironment: writeClaim ? runtimeWriteClaimEnvironment(writeClaim) : {},
    });
    if (!spawned.ok) {
      console.error('[forge cleanup] failed to launch isolated periodic cleanup:', spawned.startupError);
      return false;
    }
    const child = spawned.child;
    this.maintenanceChildren.set(key, child);
    const clear = () => {
      if (this.maintenanceChildren.get(key) === child) this.maintenanceChildren.delete(key);
    };
    child.once('error', (error) => {
      clear();
      console.error('[forge cleanup] isolated periodic cleanup process failed:', error.message);
    });
    child.once('close', (code, signal) => {
      clear();
      if (code !== 0) {
        console.error(
          '[forge cleanup] isolated periodic cleanup exited unsuccessfully:',
          `code=${code ?? 'null'} signal=${signal ?? 'none'}`,
        );
      }
    });
    return true;
  }

  async tick(): Promise<{ activeJobs: number }> {
    const now = Date.now();
    this.lastHeartbeatAt = new Date(now).toISOString();
    this.lastTickAt = this.lastHeartbeatAt;
    this.persistState();
    const repositories = this.repositoryList(this.controllerHome).filter((repo) => repo.enabled && !repo.removedAt);
    if (now - this.lastCleanupAt >= RUNTIME_CLEANUP_INTERVAL_MS) {
      // Advance the interval before cleanup so a failing pass cannot create a
      // tight retry loop on every scheduler tick. Canonical Runtime launches the
      // synchronous cleanup scanner in a release-fenced child so recursive FS,
      // process-table and legacy reconciliation work cannot block MCP traffic.
      this.lastCleanupAt = now;
      if (this.isolatePeriodicCleanup) {
        this.launchPeriodicCleanup(now);
      } else {
        await runSchedulerPeriodicCleanup({
          controllerHome: this.controllerHome,
          controllerPid: this.controllerPid,
          nowMs: now,
          cleanupIntervalMs: RUNTIME_CLEANUP_INTERVAL_MS,
          repositories,
          runtimeCleanup: this.runtimeCleanup,
          terminalWorkCleanup: this.terminalWorkCleanup,
          processGc: this.processGc,
        });
      }
    }
    if (now - this.lastReconcile >= SCHEDULER_RECONCILIATION_INTERVAL_MS) {
      for (const repository of repositories) {
        try {
          this.workExecutionConcurrencyReconcile({ controllerHome: this.controllerHome, repoId: repository.repoId });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.error(`[forge concurrency] Work wait reconciliation failed for ${repository.repoId}:`, reason);
        }
      }
      await runSchedulerValidationReconciliation({
        controllerHome: this.controllerHome,
        repositories,
        workValidationReconcile: this.workValidationReconcile,
        editValidationReconcile: this.editValidationReconcile,
      });
      this.lastReconcile = now;
      this.lastReconcileAt = new Date(now).toISOString();
    }
    const activeSourceRepoIds = new Set<string>();
    const sourceSampling = planSchedulerSourceSampling({
      repositories,
      activeRepoIds: activeSourceRepoIds,
      nowMs: now,
      lastSourceScanAt: this.lastSourceScanAt,
      lastGitStatusSampleAt: this.lastGitStatusSampleAt,
    });
    const sourceScanRepositories = sourceSampling.sourceScanRepositories;
    const dirtyProjectionRepositories = selectSchedulerDirtyProjectionRepositories(this.controllerHome, repositories);
    if (sourceSampling.shouldSample) {
      // Advance source-sampling state before the filesystem probe so a failing
      // sample cannot create a tight retry loop on every scheduler tick.
      this.lastGitStatusSampleAt = now;
      this.lastSourceScanAt = now;
      this.lastSourceScanRepoCount = sourceScanRepositories.length;
      await sampleRepositoryGitStatusForRepositories(this.controllerHome, sourceScanRepositories);
    }
    // Dirty projection markers are authoritative maintenance requests. Do not
    // make them wait behind the idle one-repository-per-minute safety scan: only
    // the dirty repositories receive this extra fresh source sample.
    const alreadySampledRepoIds = new Set(
      sourceSampling.shouldSample ? sourceScanRepositories.map((repository) => repository.repoId) : [],
    );
    const dirtyRepositoriesToSample = dirtyProjectionRepositories
      .filter((repository) => !alreadySampledRepoIds.has(repository.repoId));
    if (dirtyRepositoriesToSample.length > 0) {
      await sampleRepositoryGitStatusForRepositories(this.controllerHome, dirtyRepositoriesToSample);
    }
    const projectionMaintenanceRepositories = Array.from(new Map(
      [...sourceScanRepositories, ...dirtyProjectionRepositories]
        .map((repository) => [repository.repoId, repository] as const),
    ).values());
    this.sourceScansAvoided += sourceSampling.avoidedRepositoryCount;
    // Work-bound liveness continuation is retired: GitHub Issues are the only
    // progress ledger and the standalone Workflow Supervisor is the only
    // continuation writer. Schedules still drive explicit Supervisor wakes.
    // ExecutionJob creation is retired. Work and Process own live execution.
    if (now - this.lastScheduleTick >= SCHEDULE_TICK_INTERVAL_MS) {
      await tickSchedules(this.controllerHome, repositories.map((repo) => repo.repoId));
      this.lastScheduleTick = now;
    }
    refreshSchedulerRepositoryProjections({
      controllerHome: this.controllerHome,
      repositories,
      sourceScanRepositories: projectionMaintenanceRepositories,
      projectionRefreshRepoIds: new Set<string>(),
      controllerPid: this.controllerPid,
    });
    this.lastHeartbeatAt = new Date().toISOString();
    this.persistState();
    return { activeJobs: 0 };
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
    let activeJobs = 0;
    try {
      while (!signal?.aborted) {
        let tickFailed = false;
        try {
          activeJobs = (await this.tick()).activeJobs;
        } catch (error) {
          if (this.fatalOnTickError) throw error;
          tickFailed = true;
          this.lastHeartbeatAt = new Date().toISOString();
          this.lastTickAt = this.lastHeartbeatAt;
          this.persistState(true);
          console.error('[forge scheduler] tick failed:', error);
        }
        const now = Date.now();
        const delayMs = tickFailed
          ? this.config.pollIntervalMs
          : activeJobs > 0
            ? schedulerActiveWaitDelayMs({
              nowMs: now,
              lastReconcileAt: this.lastReconcile,
            })
            : schedulerIdleWaitDelayMs({
              nowMs: now,
              lastScheduleTickAt: this.lastScheduleTick,
            });
        const wakeRevision = readSchedulerWakeSignal(this.controllerHome).revision;
        const waitResult = await waitForSchedulerWakeSignal(this.controllerHome, wakeRevision, delayMs, signal, {
          // fs.watch is authoritative for ordinary wakeups. Polling is only a
          // lost-event safety net, so active execution must not regress to a
          // 250ms JSON-read loop after removing the full-tick poll.
          fallbackPollMs: Math.min(5_000, Math.max(1_000, delayMs)),
        });
        if (waitResult === 'aborted') break;
      }
    } finally {
      clearInterval(heartbeatTimer);
      await cleanupSchedulerWorkerProcesses(this.maintenanceChildren);
    }
  }
}
