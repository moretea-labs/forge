import type { LocalBridgeJob, LocalBridgeJobEvent, LocalBridgeJobStatus, RepositoryCommandPayload, RunCheckPayload, VerifyEditSessionPayload } from "./types";

export type AgentRunLifecycleStatus =
  | "queued" | "starting" | "running" | "waiting_for_user"
  | "succeeded" | "failed" | "cancelled" | "unknown";

export interface AgentRunLifecycleSnapshot {
  runId: string;
  status: AgentRunLifecycleStatus;
  finishedAt?: string;
  error?: string;
  exitCode?: number | null;
  integratedSessionId?: string;
  changeOutcome?: "changed" | "no_change" | "already_integrated";
  changedFiles?: string[];
}

export interface LocalBridgeExecutionPort {
  getJob(repoRoot: string, jobId: string): LocalBridgeJob;
  dispatchJob(repoRoot: string, jobId: string): LocalBridgeJob;
}

export function projectedExecutionJobId(job: LocalBridgeJob): string | undefined {
  const result = job.result;
  return result && typeof result.executionJobId === "string" ? result.executionJobId : undefined;
}

export interface LocalBridgeAgentRunProjection {
  job: LocalBridgeJob;
  previousStatus: LocalBridgeJobStatus;
  statusChanged: boolean;
  terminal: boolean;
  event?: Omit<LocalBridgeJobEvent, "at">;
}

/** Pure projection from Agent Run states into the legacy LocalBridge vocabulary. */
export function projectAgentRunToLocalBridgeStatus(status: AgentRunLifecycleStatus): LocalBridgeJobStatus {
  if (status === "queued") return "dispatched";
  if (["starting", "running", "waiting_for_user"].includes(status)) return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/** Apply an observed Agent Run snapshot without persistence or external side effects. */
export function projectAgentRunToLocalBridgeJob(
  current: LocalBridgeJob, run: AgentRunLifecycleSnapshot, observedAt: string,
): LocalBridgeAgentRunProjection {
  const previousStatus = current.status;
  const status = projectAgentRunToLocalBridgeStatus(run.status);
  const terminal = !["queued", "starting", "running", "waiting_for_user"].includes(run.status);
  const job: LocalBridgeJob = { ...current, status };
  if (!terminal) {
    delete job.finishedAt;
  } else {
    job.finishedAt = run.finishedAt ?? observedAt;
    job.error = run.status === "succeeded" ? undefined : run.error ?? `Run ended as ${run.status}`;
    job.result = {
      ...(current.result ?? {}), runId: run.runId, runStatus: run.status, exitCode: run.exitCode,
      integratedSessionId: run.integratedSessionId, changeOutcome: run.changeOutcome, changedFiles: run.changedFiles,
    };
    job.outcome = {
      process: { exitCode: run.exitCode },
      infrastructureError: run.status === "succeeded" ? undefined : {
        code: `AGENT_RUN_${run.status.toUpperCase()}`, message: run.error ?? `Run ended as ${run.status}`,
      },
    };
  }
  const statusChanged = previousStatus !== status;
  const event: Omit<LocalBridgeJobEvent, "at"> | undefined = statusChanged ? {
    type: status === "succeeded" ? "job_succeeded" : status === "cancelled" ? "job_cancelled" : status === "failed" ? "job_failed" : "job_started",
    message: `Linked Run ${run.runId} moved Local Job to ${status}.`,
    data: { runStatus: run.status },
  } : undefined;
  return { job, previousStatus, statusChanged, terminal, event };
}


export interface LocalBridgeReconciliationPort {
  listActiveJobs(repoRoot: string): LocalBridgeJob[];
  currentCheckRevision(repoRoot: string): string;
  refreshJob(repoRoot: string, job: LocalBridgeJob, checkRevision?: string): LocalBridgeJob;
}

/** Coordinate reconciliation while keeping repository reads and lifecycle effects at the CLI edge. */
export function reconcileLocalBridgeJobs(
  repoRoot: string,
  port: LocalBridgeReconciliationPort,
): { scanned: number; active: number; terminalized: number } {
  const jobs = port.listActiveJobs(repoRoot);
  const hasActiveCheck = jobs.some((entry) => entry.action === "run-check" && entry.status === "running");
  const checkRevision = hasActiveCheck ? port.currentCheckRevision(repoRoot) : undefined;
  let active = 0;
  let terminalized = 0;
  for (const job of jobs) {
    if (!["approved", "running", "dispatched"].includes(job.status)) continue;
    active += 1;
    const previous = job.status;
    const refreshed = port.refreshJob(repoRoot, job, checkRevision);
    if (previous !== refreshed.status && ["succeeded", "failed", "timed_out", "orphaned", "stale", "cancelled"].includes(refreshed.status)) {
      terminalized += 1;
    }
  }
  return { scanned: jobs.length, active, terminalized };
}


export interface LocalBridgeRefreshPort {
  currentPid: number;
  now(): string;
  resolveJobTimeout(repoRoot: string, value: unknown): number;
  currentCheckRevision(repoRoot: string): string;
  isPidAlive(pid: number | undefined): boolean;
  signalWorker(pid: number | undefined, signal: "SIGTERM"): void;
  releaseCheckSubscription(subscriberId: string): void;
  syncProjectedExecutionJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob;
  getAgentRun(repoRoot: string, runId: string): AgentRunLifecycleSnapshot;
  cleanupEphemeralJob(repoRoot: string, job: LocalBridgeJob): void;
  appendEvent(repoRoot: string, jobId: string, event: Omit<LocalBridgeJobEvent, "at">): void;
  saveJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob;
}

function runningJobTimedOut(job: LocalBridgeJob, configuredTimeoutMs: number, nowMs: number): boolean {
  const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : Number.NaN;
  const startedAt = Date.parse(job.startedAt ?? job.updatedAt);
  const explicitDeadlineReached = job.deadlineAt !== undefined && Number.isFinite(deadlineAt) && deadlineAt <= nowMs;
  const legacyDeadlineReached = job.deadlineAt === undefined && Number.isFinite(startedAt) && startedAt + configuredTimeoutMs + 30_000 <= nowMs;
  return explicitDeadlineReached || legacyDeadlineReached;
}

function runningJobOrphaned(job: LocalBridgeJob, port: LocalBridgeRefreshPort): boolean {
  if (job.ownerPid === undefined || job.ownerPid === port.currentPid) return false;
  if (port.isPidAlive(job.ownerPid)) return false;
  return !port.isPidAlive(job.workerPid);
}

function reattachLiveDetachedWorker(
  repoRoot: string,
  job: LocalBridgeJob,
  port: LocalBridgeRefreshPort,
): LocalBridgeJob | undefined {
  if (job.ownerPid === undefined || job.ownerPid === port.currentPid) return undefined;
  if (port.isPidAlive(job.ownerPid) || !port.isPidAlive(job.workerPid)) return undefined;
  job.ownerPid = port.currentPid;
  job.heartbeatAt = port.now();
  port.appendEvent(repoRoot, job.jobId, {
    type: "job_progress",
    message: "Reattached still-live detached worker " + String(job.workerPid) + " after Controller restart.",
    data: { workerPid: job.workerPid, reattachedOwnerPid: port.currentPid },
  });
  return port.saveJob(repoRoot, job);
}

function markRefreshTerminal(
  repoRoot: string,
  job: LocalBridgeJob,
  status: "timed_out" | "orphaned" | "stale",
  message: string,
  data: Record<string, unknown>,
  port: LocalBridgeRefreshPort,
): LocalBridgeJob {
  job.status = status;
  job.finishedAt = port.now();
  job.error = message;
  job.workerPid = undefined;
  port.appendEvent(repoRoot, job.jobId, { type: "job_failed", message, data });
  return port.saveJob(repoRoot, job);
}

/** Runtime-owned refresh policy; the CLI adapter supplies persistence and process/Agent effects. */
export function refreshLocalBridgeJob(
  repoRoot: string,
  initialJob: LocalBridgeJob,
  checkRevision: string | undefined,
  port: LocalBridgeRefreshPort,
): LocalBridgeJob {
  let job = initialJob;
  const nowMs = Date.parse(port.now());
  const executionJobId = job.result && typeof job.result.executionJobId === "string"
    ? job.result.executionJobId
    : undefined;
  if (executionJobId && ["dispatched", "running"].includes(job.status)) {
    job = port.syncProjectedExecutionJob(repoRoot, job);
    if (!["dispatched", "running"].includes(job.status)) return job;
  }

  if (job.action === "run-check" && job.status === "running") {
    const startedAt = Date.parse(job.startedAt ?? job.updatedAt);
    const configuredTimeout = port.resolveJobTimeout(repoRoot, (job.payload as RunCheckPayload).timeoutMs);
    const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : Number.NaN;
    const timedOut = job.deadlineAt !== undefined && Number.isFinite(deadlineAt) && deadlineAt <= nowMs;
    const ownerOrphaned = job.ownerPid !== undefined && job.ownerPid !== port.currentPid && !port.isPidAlive(job.ownerPid);
    const legacyOrphaned = job.ownerPid === undefined && Number.isFinite(startedAt) && startedAt + configuredTimeout + 30_000 <= nowMs;
    const revisionChanged = job.revision !== undefined
      && job.revision !== (checkRevision ?? port.currentCheckRevision(repoRoot));
    if (timedOut || ownerOrphaned || legacyOrphaned || revisionChanged) {
      job.status = timedOut || legacyOrphaned ? "timed_out" : revisionChanged ? "stale" : "orphaned";
      job.finishedAt = port.now();
      job.error = timedOut || legacyOrphaned
        ? "Check " + (job.payload as RunCheckPayload).checkId + " exceeded its persisted execution deadline."
        : revisionChanged
          ? "Check " + (job.payload as RunCheckPayload).checkId + " became stale after the repository revision changed."
          : "Check " + (job.payload as RunCheckPayload).checkId + " was orphaned when Controller process " + String(job.ownerPid) + " exited.";
      port.releaseCheckSubscription("local-job:" + job.jobId);
      port.appendEvent(repoRoot, job.jobId, {
        type: "job_failed",
        message: job.error,
        data: { timedOut: timedOut || legacyOrphaned, orphaned: ownerOrphaned, stale: revisionChanged },
      });
      return port.saveJob(repoRoot, job);
    }
    return job;
  }

  if ((job.action === "verify-edit-session" || job.action === "repository-command") && job.status === "running") {
    const payload = job.payload as VerifyEditSessionPayload | RepositoryCommandPayload;
    const configuredTimeout = port.resolveJobTimeout(repoRoot, "timeoutMs" in payload ? payload.timeoutMs : undefined);
    if (runningJobTimedOut(job, configuredTimeout, nowMs)) {
      if (job.action === "verify-edit-session") port.releaseCheckSubscription("local-job:" + job.jobId);
      else port.signalWorker(job.workerPid, "SIGTERM");
      return markRefreshTerminal(repoRoot, job, "timed_out", job.action + " exceeded its persisted execution deadline.", { timedOut: true }, port);
    }
    const reattached = reattachLiveDetachedWorker(repoRoot, job, port);
    if (reattached) return reattached;
    if (runningJobOrphaned(job, port)) {
      return markRefreshTerminal(
        repoRoot, job, "orphaned",
        job.action + " was orphaned when Controller process " + String(job.ownerPid) + " exited.",
        { orphaned: true }, port,
      );
    }
    return job;
  }

  if (!job.runId || !["dispatched", "running"].includes(job.status)) return job;
  try {
    const run = port.getAgentRun(repoRoot, job.runId);
    const projection = projectAgentRunToLocalBridgeJob(job, run, port.now());
    job = projection.job;
    if (projection.terminal) port.cleanupEphemeralJob(repoRoot, job);
    if (projection.event) port.appendEvent(repoRoot, job.jobId, projection.event);
    return port.saveJob(repoRoot, job);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = port.now();
    port.cleanupEphemeralJob(repoRoot, job);
    return port.saveJob(repoRoot, job);
  }
}
