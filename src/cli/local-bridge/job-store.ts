import { randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { cancelAgentJob, getAgentJob } from "../agent-jobs/job-manager";
import { removeEphemeralIssue } from "../controller/issue-store";
import {
  currentControllerCheckRevision,
  releaseControllerCheckSubscription,
} from "../../runtime/execution/process-runtime/check-runner";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  normalizeAgentTimeoutMs,
} from "../../runtime/shared/runtime-config";
import { loadMcpServiceLocalConfig } from "../../../adapters/mcp/auth";
import type { ControllerTask } from "../controller/types";
import { taskExecutionPolicy } from "../controller/execution-policy";
import { tryAppendControllerWorklogEvent } from "../../runtime/evidence/controller-worklog";
import { resolveControllerHome, resolveRepoPreferredControllerHome } from "../../effects/controller-home";
import { findExecutionJob } from "../../runtime/execution/jobs/store";
import {
  LOCAL_BRIDGE_JOB_ROOT,
  allStoredJobPaths,
  eventsPath,
  getLocalBridgeJobSnapshot,
  jobDir,
  metaPath,
  normalizeLocalJobId,
  readJson,
  readLocalBridgeJob,
  readStoredJobs,
} from "../../runtime/local-bridge/read-model";
import type { LocalBridgeJobOutputResult } from "../../runtime/local-bridge/read-model";
import type {
  LocalBridgeApproval,
  LocalBridgeConfig,
  LocalBridgeJob,
  LocalBridgeJobEvent,
  RepositoryCommandPayload,
  RunCheckPayload,
  VerifyEditSessionPayload,
} from "../../runtime/local-bridge/types";

const ACTIVE_INDEX_PATH = `${LOCAL_BRIDGE_JOB_ROOT}/active-index.json`;
const CONFIG_PATH = ".forge/local-bridge.json";

interface LocalBridgeActiveIndex {
  schemaVersion: 1;
  ownerPid: number;
  updatedAt: string;
  jobIds: string[];
}

function now(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function checkSubscriberId(jobId: string): string {
  return `local-job:${jobId}`;
}




function activeIndexPath(repoRoot: string): string {
  return join(repoRoot, ACTIVE_INDEX_PATH);
}

function isActiveLocalBridgeJob(job: LocalBridgeJob): boolean {
  return ["pending_approval", "approved", "running", "dispatched"].includes(job.status);
}


function writeActiveJobIndex(
  repoRoot: string,
  jobIds: Iterable<string>,
): LocalBridgeActiveIndex {
  const index: LocalBridgeActiveIndex = {
    schemaVersion: 1,
    ownerPid: process.pid,
    updatedAt: now(),
    jobIds: Array.from(new Set(jobIds)).sort((a, b) => b.localeCompare(a)),
  };
  writeJson(activeIndexPath(repoRoot), index);
  return index;
}

function rebuildActiveJobIndex(repoRoot: string): LocalBridgeActiveIndex {
  const jobIds = allStoredJobPaths(repoRoot).flatMap((path) => {
    try {
      const job = readJson<LocalBridgeJob>(path);
      return isActiveLocalBridgeJob(job) ? [job.jobId] : [];
    } catch (_error) {
      return [];
    }
  });
  return writeActiveJobIndex(repoRoot, jobIds);
}

function loadActiveJobIndex(repoRoot: string): LocalBridgeActiveIndex {
  const path = activeIndexPath(repoRoot);
  if (!existsSync(path)) return rebuildActiveJobIndex(repoRoot);
  try {
    const index = readJson<LocalBridgeActiveIndex>(path);
    if (
      index.schemaVersion !== 1 ||
      index.ownerPid !== process.pid ||
      !Array.isArray(index.jobIds) ||
      index.jobIds.some((jobId) => typeof jobId !== "string" || !jobId)
    ) {
      return rebuildActiveJobIndex(repoRoot);
    }
    return index;
  } catch (_error) {
    return rebuildActiveJobIndex(repoRoot);
  }
}

function readActiveLocalBridgeJobs(repoRoot: string): LocalBridgeJob[] {
  const index = loadActiveJobIndex(repoRoot);
  const jobs: LocalBridgeJob[] = [];
  const retainedJobIds: string[] = [];
  for (const jobId of index.jobIds) {
    try {
      const job = readJson<LocalBridgeJob>(metaPath(repoRoot, jobId));
      if (!isActiveLocalBridgeJob(job)) continue;
      retainedJobIds.push(jobId);
      jobs.push(job);
    } catch (_error) {
      // Missing or malformed state is pruned from the active index.
    }
  }
  if (retainedJobIds.length !== index.jobIds.length) {
    writeActiveJobIndex(repoRoot, retainedJobIds);
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function updateActiveJobIndex(repoRoot: string, job: LocalBridgeJob): void {
  const index = loadActiveJobIndex(repoRoot);
  const jobIds = new Set(index.jobIds);
  const contained = jobIds.has(job.jobId);
  if (isActiveLocalBridgeJob(job)) jobIds.add(job.jobId);
  else jobIds.delete(job.jobId);
  if (contained !== jobIds.has(job.jobId)) writeActiveJobIndex(repoRoot, jobIds);
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function signalWorker(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (_error) {
      // Fall through to direct child signaling.
    }
  }
  try {
    process.kill(pid, signal);
  } catch (_error) {
    // The process may already be gone.
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${shortId()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}


function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((entry) => String(entry).trim()).filter(Boolean)),
  );
}

function appendEvent(
  repoRoot: string,
  jobId: string,
  event: Omit<LocalBridgeJobEvent, "at">,
): void {
  const path = eventsPath(repoRoot, jobId);
  mkdirSync(dirname(path), { recursive: true });
  const at = now();
  appendFileSync(path, `${JSON.stringify({ ...event, at })}\n`, "utf-8");
  let job: LocalBridgeJob | undefined;
  try {
    const stored = metaPath(repoRoot, jobId);
    if (existsSync(stored)) job = readJson<LocalBridgeJob>(stored);
  } catch (_error) {
    job = undefined;
  }
  tryAppendControllerWorklogEvent(repoRoot, {
    at,
    category: "local_job",
    action: event.type,
    summary: event.message || event.type,
    actor: job?.requestedBy || "local-controller",
    issueId: job?.issueId,
    taskId: job?.taskId,
    runId: job?.runId,
    jobId,
    details: event.data,
  });
}

export function loadLocalBridgeConfig(repoRoot: string): LocalBridgeConfig {
  const path = join(repoRoot, CONFIG_PATH);
  if (!existsSync(path)) return { version: 1 };
  try {
    const parsed = readJson<LocalBridgeConfig>(path);
    return { ...parsed, version: 1 };
  } catch (_error) {
    return { version: 1 };
  }
}

export function localBridgeTimeoutPolicy(repoRoot: string): {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
} {
  const local = loadLocalBridgeConfig(repoRoot);
  const controllerHome = resolveRepoPreferredControllerHome(repoRoot);
  const mcp = loadMcpServiceLocalConfig(controllerHome);
  const maxTimeoutMs = normalizeAgentTimeoutMs(
    local.maxTimeoutMs ?? mcp?.devMode?.maxTimeoutMs,
    {
      defaultMs: MAX_AGENT_TIMEOUT_MS,
      maxMs: MAX_AGENT_TIMEOUT_MS,
      label: "local bridge max timeout",
    },
  );
  const defaultTimeoutMs = normalizeAgentTimeoutMs(
    local.defaultTimeoutMs ?? mcp?.devMode?.timeoutMs,
    {
      defaultMs: DEFAULT_AGENT_TIMEOUT_MS,
      maxMs: maxTimeoutMs,
      label: "local bridge default timeout",
    },
  );
  return { defaultTimeoutMs, maxTimeoutMs };
}

function resolvedJobTimeout(repoRoot: string, value: unknown): number {
  const policy = localBridgeTimeoutPolicy(repoRoot);
  return normalizeAgentTimeoutMs(value, {
    defaultMs: policy.defaultTimeoutMs,
    maxMs: policy.maxTimeoutMs,
  });
}

function taskApproval(task: ControllerTask): LocalBridgeApproval {
  return taskExecutionPolicy(task).approval;
}


function cleanupEphemeralJob(repoRoot: string, job: LocalBridgeJob): void {
  if (!job.ephemeral || !job.issueId || job.cleanupAt || job.status !== "succeeded") return;
  const runStatus = job.result && typeof job.result === "object"
    ? (job.result as { runStatus?: unknown }).runStatus
    : undefined;
  const removeIssue = runStatus === "succeeded";
  if (removeIssue) {
    try {
      removeEphemeralIssue(repoRoot, job.issueId);
    } catch (_error) {
      // Cleanup is best-effort and idempotent; Run evidence remains durable.
    }
  }
  job.cleanupAt = now();
  appendEvent(repoRoot, job.jobId, {
    type: "job_cleaned",
    message: removeIssue
      ? `Ephemeral Quick Agent metadata for ${job.issueId} was cleaned.`
      : `Ephemeral Quick Agent Local Job settled; hidden metadata for ${job.issueId} was retained for retry.`,
  });
}

function runningJobTimedOut(job: LocalBridgeJob, configuredTimeoutMs: number): boolean {
  const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : Number.NaN;
  const startedAt = Date.parse(job.startedAt ?? job.updatedAt);
  const explicitDeadlineReached = job.deadlineAt !== undefined && Number.isFinite(deadlineAt) && deadlineAt <= Date.now();
  const legacyDeadlineReached = job.deadlineAt === undefined && Number.isFinite(startedAt) && startedAt + configuredTimeoutMs + 30_000 <= Date.now();
  return explicitDeadlineReached || legacyDeadlineReached;
}

function runningJobOrphaned(job: LocalBridgeJob): boolean {
  if (job.ownerPid === undefined || job.ownerPid === process.pid) return false;
  if (isPidAlive(job.ownerPid)) return false;
  // Owner died, but a still-live detached worker means the job is not lost —
  // controller restart must reattach rather than incorrectly orphan it.
  if (isPidAlive(job.workerPid)) return false;
  return true;
}

function reattachLiveDetachedWorker(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob | undefined {
  if (job.ownerPid === undefined || job.ownerPid === process.pid) return undefined;
  if (isPidAlive(job.ownerPid)) return undefined;
  if (!isPidAlive(job.workerPid)) return undefined;
  job.ownerPid = process.pid;
  job.heartbeatAt = now();
  appendEvent(repoRoot, job.jobId, {
    type: "job_progress",
    message: `Reattached still-live detached worker ${String(job.workerPid)} after Controller restart.`,
    data: { workerPid: job.workerPid, reattachedOwnerPid: process.pid },
  });
  return saveJob(repoRoot, job);
}

function markJobTerminal(
  repoRoot: string,
  job: LocalBridgeJob,
  status: Extract<LocalBridgeJob["status"], "failed" | "timed_out" | "orphaned" | "stale">,
  message: string,
  data?: Record<string, unknown>,
): LocalBridgeJob {
  job.status = status;
  job.finishedAt = now();
  job.error = message;
  job.workerPid = undefined;
  appendEvent(repoRoot, job.jobId, {
    type: "job_failed",
    message,
    data,
  });
  return saveJob(repoRoot, job);
}

function projectedExecutionJobId(job: LocalBridgeJob): string | undefined {
  const result = job.result;
  return result && typeof result.executionJobId === "string" ? result.executionJobId : undefined;
}

function projectedExecutionControllerHome(
  job: LocalBridgeJob,
): string {
  const result = job.result;
  if (result && typeof result.controllerHome === "string" && result.controllerHome.trim()) {
    return resolveControllerHome(result.controllerHome);
  }
  if (
    job.action === "repository-command" &&
    job.payload &&
    typeof job.payload === "object" &&
    "controllerHome" in job.payload &&
    typeof (job.payload as RepositoryCommandPayload).controllerHome === "string"
  ) {
    return resolveControllerHome((job.payload as RepositoryCommandPayload).controllerHome);
  }
  return resolveControllerHome();
}

function projectedExecutionMissingGraceExpired(job: LocalBridgeJob): boolean {
  const updatedAt = Date.parse(job.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt >= 15_000;
}

function failMissingProjectedExecutionJob(
  repoRoot: string,
  job: LocalBridgeJob,
  executionJobId: string,
): LocalBridgeJob {
  const controllerHome = projectedExecutionControllerHome(job);
  return markJobTerminal(
    repoRoot,
    job,
    "failed",
    `Durable Execution Job ${executionJobId} was not found after local projection; terminalizing the Local Job to prevent runtime storage deadlock.`,
    { executionJobId, controllerHome, projectedExecutionMissing: true },
  );
}

function syncProjectedExecutionJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob {
  const executionJobId = projectedExecutionJobId(job);
  if (!executionJobId || !["dispatched", "running"].includes(job.status)) return job;
  const execution = findExecutionJob(projectedExecutionControllerHome(job), executionJobId);
  if (!execution) {
    if (projectedExecutionMissingGraceExpired(job)) {
      return failMissingProjectedExecutionJob(repoRoot, job, executionJobId);
    }
    return job;
  }
  const previous = job.status;
  job.deadlineAt = execution.deadlineAt ?? job.deadlineAt;
  job.workerPid = execution.workerPid;
  job.result = {
    ...(job.result ?? {}),
    executionJobId: execution.jobId,
    executionStatus: execution.status,
    ...(execution.result ? { executionResult: execution.result } : {}),
  };
  job.outcome = execution.outcome ?? job.outcome;
  if (execution.status === "running") {
    job.status = "running";
    job.startedAt = execution.startedAt ?? job.startedAt;
    if (previous !== job.status) {
      appendEvent(repoRoot, job.jobId, {
        type: "job_started",
        message: `Durable Execution Job ${execution.jobId} started running.`,
        data: { executionJobId: execution.jobId, workerPid: execution.workerPid },
      });
      return saveJob(repoRoot, job);
    }
    return saveJob(repoRoot, job);
  }
  if (execution.status === "waiting_for_approval") {
    job.status = "pending_approval";
    job.finishedAt = undefined;
    job.workerPid = undefined;
    job.error = undefined;
    if (previous !== job.status) {
      appendEvent(repoRoot, job.jobId, {
        type: "job_approval_required",
        message: `Durable Execution Job ${execution.jobId} is waiting for approval.`,
        data: { executionJobId: execution.jobId, approvalRequestId: execution.result?.approvalRequestId },
      });
    }
    return saveJob(repoRoot, job);
  }
  if (["queued", "waiting_for_dependency", "waiting_for_workspace", "waiting_for_heavy_check", "waiting_for_integration", "waiting_for_release_barrier", "dispatched"].includes(execution.status)) {
    return saveJob(repoRoot, job);
  }
  job.status = execution.status === "succeeded"
    ? "succeeded"
    : execution.status === "cancelled"
      ? "cancelled"
      : execution.status === "timed_out"
        ? "timed_out"
        : execution.status === "stale"
          ? "stale"
          : execution.status === "orphaned"
            ? "orphaned"
            : "failed";
  job.finishedAt = execution.finishedAt ?? now();
  job.workerPid = undefined;
  job.error = execution.error?.message
    ?? execution.outcome?.acceptanceFailure?.message
    ?? execution.outcome?.infrastructureError?.message;
  if (previous !== job.status) {
    appendEvent(repoRoot, job.jobId, {
      type: job.status === "succeeded"
        ? "job_succeeded"
        : job.status === "cancelled"
          ? "job_cancelled"
          : "job_failed",
      message: `Durable Execution Job ${execution.jobId} ended as ${execution.status}.`,
      data: { executionJobId: execution.jobId, executionStatus: execution.status, error: execution.error?.code },
    });
  }
  return saveJob(repoRoot, job);
}

function refreshLongRunningJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob {
  const payload = job.payload as VerifyEditSessionPayload | RepositoryCommandPayload;
  const configuredTimeout = resolvedJobTimeout(
    repoRoot,
    "timeoutMs" in payload ? payload.timeoutMs : undefined,
  );
  if (runningJobTimedOut(job, configuredTimeout)) {
    if (job.action === "verify-edit-session") releaseControllerCheckSubscription(checkSubscriberId(job.jobId));
    else signalWorker(job.workerPid, "SIGTERM");
    return markJobTerminal(
      repoRoot,
      job,
      "timed_out",
      `${job.action} exceeded its persisted execution deadline.`,
      { timedOut: true },
    );
  }
  const reattached = reattachLiveDetachedWorker(repoRoot, job);
  if (reattached) return reattached;
  if (runningJobOrphaned(job)) {
    return markJobTerminal(
      repoRoot,
      job,
      "orphaned",
      `${job.action} was orphaned when Controller process ${String(job.ownerPid)} exited.`,
      { orphaned: true },
    );
  }
  return job;
}

export function projectAgentRunToLocalBridgeStatus(
  status: import("../agent-jobs/types").AgentJobStatus,
): LocalBridgeJob["status"] {
  if (status === "queued") return "dispatched";
  if (["starting", "running", "waiting_for_user"].includes(status)) return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function refreshLocalBridgeJob(
  repoRoot: string,
  job: LocalBridgeJob,
  checkRevision?: string,
): LocalBridgeJob {
  if (projectedExecutionJobId(job) && ["dispatched", "running"].includes(job.status)) {
    const synced = syncProjectedExecutionJob(repoRoot, job);
    if (!["dispatched", "running"].includes(synced.status)) return synced;
    job = synced;
  }
  if (job.action === "run-check" && job.status === "running") {
    const startedAt = Date.parse(job.startedAt ?? job.updatedAt);
    const configuredTimeout = resolvedJobTimeout(repoRoot, (job.payload as RunCheckPayload).timeoutMs);
    const deadlineAt = job.deadlineAt ? Date.parse(job.deadlineAt) : Number.NaN;
    const timedOut = job.deadlineAt !== undefined && Number.isFinite(deadlineAt) && deadlineAt <= Date.now();
    const ownerOrphaned = job.ownerPid !== undefined && job.ownerPid !== process.pid && !isPidAlive(job.ownerPid);
    const legacyOrphaned = job.ownerPid === undefined && Number.isFinite(startedAt) && startedAt + configuredTimeout + 30_000 <= Date.now();
    const revisionChanged = job.revision !== undefined &&
      job.revision !== (checkRevision ?? currentControllerCheckRevision(repoRoot));
    if (timedOut || ownerOrphaned || legacyOrphaned || revisionChanged) {
      job.status = timedOut || legacyOrphaned
        ? "timed_out"
        : revisionChanged
          ? "stale"
          : "orphaned";
      job.finishedAt = now();
      job.error = timedOut || legacyOrphaned
        ? `Check ${(job.payload as RunCheckPayload).checkId} exceeded its persisted execution deadline.`
        : revisionChanged
          ? `Check ${(job.payload as RunCheckPayload).checkId} became stale after the repository revision changed.`
        : `Check ${(job.payload as RunCheckPayload).checkId} was orphaned when Controller process ${String(job.ownerPid)} exited.`;
      releaseControllerCheckSubscription(checkSubscriberId(job.jobId));
      appendEvent(repoRoot, job.jobId, {
        type: "job_failed",
        message: job.error,
        data: {
          timedOut: timedOut || legacyOrphaned,
          orphaned: ownerOrphaned,
          stale: revisionChanged,
        },
      });
      return saveJob(repoRoot, job);
    }
    return job;
  }
  if ((job.action === "verify-edit-session" || job.action === "repository-command") && job.status === "running") {
    return refreshLongRunningJob(repoRoot, job);
  }
  if (!job.runId || !["dispatched", "running"].includes(job.status)) return job;
  try {
    const run = getAgentJob(repoRoot, job.runId);
    const previous = job.status;
    if (["queued", "starting", "running", "waiting_for_user"].includes(run.status)) {
      job.status = projectAgentRunToLocalBridgeStatus(run.status);
      delete job.finishedAt;
    } else {
      job.status = projectAgentRunToLocalBridgeStatus(run.status);
      job.finishedAt = run.finishedAt ?? now();
      job.error = run.status === "succeeded" ? undefined : run.error ?? `Run ended as ${run.status}`;
      job.result = {
        ...(job.result ?? {}),
        runId: run.runId,
        runStatus: run.status,
        exitCode: run.exitCode,
        integratedSessionId: run.integratedSessionId,
        changeOutcome: run.changeOutcome,
        changedFiles: run.changedFiles,
      };
      job.outcome = {
        process: { exitCode: run.exitCode },
        infrastructureError: run.status === "succeeded" ? undefined : {
          code: `AGENT_RUN_${run.status.toUpperCase()}`,
          message: run.error ?? `Run ended as ${run.status}`,
        },
      };
      cleanupEphemeralJob(repoRoot, job);
    }
    if (previous !== job.status) {
      appendEvent(repoRoot, job.jobId, {
        type: job.status === "succeeded" ? "job_succeeded" : job.status === "cancelled" ? "job_cancelled" : job.status === "failed" ? "job_failed" : "job_started",
        message: `Linked Run ${run.runId} moved Local Job to ${job.status}.`,
        data: { runStatus: run.status },
      });
    }
    return saveJob(repoRoot, job);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = now();
    cleanupEphemeralJob(repoRoot, job);
    return saveJob(repoRoot, job);
  }
}

export function getLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  return refreshLocalBridgeJob(repoRoot, readLocalBridgeJob(repoRoot, jobId));
}


export interface LocalBridgeJobHandoff {
  jobId: string;
  status: LocalBridgeJob["status"] | "not_found" | "rejected";
  stdoutPath?: string;
  stderrPath?: string;
  stdout?: string;
  stderr?: string;
  outputStatus?: {
    stdout: LocalBridgeJobOutputResult["status"];
    stderr: LocalBridgeJobOutputResult["status"];
  };
  changedPaths?: string[];
  nextLocalCommand?: string;
  error?: { code: string; message: string };
}


export function listLocalBridgeJobs(repoRoot: string, limit = 100): LocalBridgeJob[] {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const jobs = readStoredJobs(repoRoot, boundedLimit);
  const hasActiveCheck = jobs.some((entry) =>
    entry.action === "run-check" && entry.status === "running"
  );
  const checkRevision = hasActiveCheck ? currentControllerCheckRevision(repoRoot) : undefined;
  return jobs
    .map((entry) => refreshLocalBridgeJob(repoRoot, entry, checkRevision))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function reconcileLocalBridgeJobs(repoRoot: string): {
  scanned: number;
  active: number;
  terminalized: number;
} {
  const jobs = readActiveLocalBridgeJobs(repoRoot);
  const hasActiveCheck = jobs.some((entry) =>
    entry.action === "run-check" && entry.status === "running"
  );
  const checkRevision = hasActiveCheck ? currentControllerCheckRevision(repoRoot) : undefined;
  let active = 0;
  let terminalized = 0;
  for (const job of jobs) {
    if (!["approved", "running", "dispatched"].includes(job.status)) continue;
    active += 1;
    const previous = job.status;
    const refreshed = refreshLocalBridgeJob(repoRoot, job, checkRevision);
    if (previous !== refreshed.status && ["succeeded", "failed", "timed_out", "orphaned", "stale", "cancelled"].includes(refreshed.status)) terminalized += 1;
  }
  return { scanned: jobs.length, active, terminalized };
}

export function getLocalBridgeJobEvents(
  repoRoot: string,
  jobId: string,
): LocalBridgeJobEvent[] {
  getLocalBridgeJob(repoRoot, jobId);
  const path = eventsPath(repoRoot, jobId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LocalBridgeJobEvent);
}



function saveJob(repoRoot: string, job: LocalBridgeJob): LocalBridgeJob {
  job.updatedAt = now();
  writeJson(metaPath(repoRoot, job.jobId), job);
  updateActiveJobIndex(repoRoot, job);
  return job;
}

export function cancelLocalBridgeJob(
  repoRoot: string,
  jobId: string,
): LocalBridgeJob {
  const job = readLocalBridgeJob(repoRoot, jobId);
  if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
  if (job.runId) {
    try { cancelAgentJob(repoRoot, job.runId); } catch (_error) { /* remote sessions may require provider UI */ }
  }
  if (job.action === "run-check" || job.action === "verify-edit-session") {
    releaseControllerCheckSubscription(checkSubscriberId(job.jobId));
  } else if (job.workerPid) {
    signalWorker(job.workerPid, "SIGTERM");
  }
  job.status = "cancelled";
  job.finishedAt = now();
  cleanupEphemeralJob(repoRoot, job);
  appendEvent(repoRoot, job.jobId, {
    type: "job_cancelled",
    message: job.runId ? `Cancelled linked Run ${job.runId}.` : "Cancelled before execution.",
  });
  return saveJob(repoRoot, job);
}

/**
 * Historical Local Bridge Jobs remain readable, but dispatch ownership has moved
 * to WorkContract + Process Runtime or an explicitly claimed external Controller.
 */
export function dispatchLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  const job = getLocalBridgeJob(repoRoot, jobId);
  if (job.status !== "approved") return job;
  return markJobTerminal(
    repoRoot,
    job,
    "failed",
    "LOCAL_BRIDGE_JOB_RETIRED: Historical Local Bridge Jobs are read-only and cannot be dispatched. Resume through WorkContract + Process Runtime or an explicitly claimed external Controller.",
    { legacyDispatchRetired: true },
  );
}
