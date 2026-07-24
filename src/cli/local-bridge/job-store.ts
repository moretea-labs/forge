import { randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { cancelAgentJob, getAgentJob } from "../agent-jobs/job-manager";
import { getIssue, removeEphemeralIssue } from "../controller/issue-store";
import {
  currentControllerCheckRevision,
  releaseControllerCheckSubscription,
  runControllerCheckAsync,
  snapshotControllerCheck,
} from "../controller/check-runner";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_AGENT_TIMEOUT_MS,
  normalizeAgentTimeoutMs,
} from "../controller/runtime-config";
import { verifyEditSessionAsync } from "../editing/edit-session";
import { loadMcpLocalConfig, loadMcpServiceLocalConfig } from "../mcp/auth";
import {
  executeRepositoryCommandAsync,
} from "../repositories/command-executor";
import { registerRepository, resolveRepositorySelection } from "../repositories/registry";
import type { ControllerTask } from "../controller/types";
import { taskExecutionPolicy } from "../controller/execution-policy";
import { tryAppendControllerWorklogEvent } from "../controller/worklog";
import { resolveControllerHome, resolveRepoPreferredControllerHome } from "../repositories/controller-home";
import { ensureRepositoryRuntimeStorage } from "../repositories/runtime-storage";
import { commandValue, normalizeRepositoryCommand } from "../repositories/command-normalization";
import { findExecutionJob } from "../../runtime/execution/jobs/store";
import type {
  LaunchTaskPayload,
  LocalBridgeApproval,
  LocalBridgeConfig,
  LocalBridgeJob,
  LocalBridgeJobAction,
  LocalBridgeJobEvent,
  LocalBridgeJobRequest,
  RepositoryCommandPayload,
  QuickAgentSessionPayload,
  RunCheckPayload,
  VerifyEditSessionPayload,
} from "./types";

const JOB_ROOT = ".ai/harness/local-jobs";
const ACTIVE_INDEX_PATH = `${JOB_ROOT}/active-index.json`;
const CONFIG_PATH = ".repo-harness/local-bridge.json";
const DEFAULT_LOCAL_JOB_OUTPUT_BYTES = 16 * 1024;
const MAX_LOCAL_JOB_OUTPUT_BYTES = 512 * 1024;

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

function normalizeLocalJobId(jobId: string): string {
  const normalized = String(jobId).trim();
  if (!normalized) throw new Error("LOCAL_JOB_ID_REQUIRED: job_id is required");
  if (normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("LOCAL_JOB_PATH_INVALID: local job ids must not contain path traversal or path separators");
  }
  return normalized;
}

function localJobRoot(repoRoot: string): string {
  return resolve(repoRoot, JOB_ROOT);
}

function resolveLocalJobDir(repoRoot: string, jobId: string): string {
  const normalizedJobId = normalizeLocalJobId(jobId);
  const root = localJobRoot(repoRoot);
  const resolved = resolve(root, normalizedJobId);
  const rel = relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("LOCAL_JOB_PATH_INVALID: local job paths must stay within .ai/harness/local-jobs");
  }
  return resolved;
}

function jobDir(repoRoot: string, jobId: string): string {
  return resolveLocalJobDir(repoRoot, jobId);
}

function metaPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "job.json");
}

function eventsPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "events.jsonl");
}

function stdoutPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "stdout.log");
}

function stderrPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "stderr.log");
}

function relativeOutputPath(jobId: string, stream: "stdout" | "stderr"): string {
  const normalizedJobId = normalizeLocalJobId(jobId);
  return `.ai/harness/local-jobs/${normalizedJobId}/${stream}.log`;
}

function boundedOutputBytes(value: number | undefined): number {
  return Math.max(1, Math.min(Math.trunc(value ?? DEFAULT_LOCAL_JOB_OUTPUT_BYTES), MAX_LOCAL_JOB_OUTPUT_BYTES));
}

function allStoredJobPaths(repoRoot: string): string[] {
  const root = join(repoRoot, JOB_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "job.json")))
    .map((entry) => join(root, entry.name, "job.json"))
    .sort((a, b) => b.localeCompare(a));
}

function storedJobPaths(repoRoot: string, limit = 500): string[] {
  return allStoredJobPaths(repoRoot).slice(0, Math.max(1, Math.min(limit, 5000)));
}

function readStoredJobs(repoRoot: string, limit = 500): LocalBridgeJob[] {
  return storedJobPaths(repoRoot, limit).flatMap((path) => {
    try {
      return [readJson<LocalBridgeJob>(path)];
    } catch (_error) {
      return [];
    }
  });
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

function ensureJobLogFiles(repoRoot: string, jobId: string): void {
  mkdirSync(jobDir(repoRoot, jobId), { recursive: true });
  for (const path of [stdoutPath(repoRoot, jobId), stderrPath(repoRoot, jobId)]) {
    if (!existsSync(path)) writeFileSync(path, "", "utf-8");
  }
}

function appendJobOutput(
  repoRoot: string,
  jobId: string,
  stream: "stdout" | "stderr",
  chunk: string,
): void {
  const path = stream === "stdout" ? stdoutPath(repoRoot, jobId) : stderrPath(repoRoot, jobId);
  ensureJobLogFiles(repoRoot, jobId);
  appendFileSync(path, chunk, "utf-8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
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
  const mcp = loadMcpServiceLocalConfig(controllerHome, repoRoot) ?? loadMcpLocalConfig(repoRoot);
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

function executionApproval(
  repoRoot: string,
  action: LocalBridgeJobAction,
  payload: LocalBridgeJobRequest["payload"],
): LocalBridgeApproval {
  if (action === "run-check" || action === "verify-edit-session" || action === "repository-command") return "auto";
  if (action === "launch-task") {
    const input = payload as LaunchTaskPayload;
    const issue = getIssue(repoRoot, input.issueId);
    const task = issue.tasks.find((entry) => entry.id === input.taskId);
    if (!task)
      throw new Error(`task not found: ${input.issueId}/${input.taskId}`);
    return taskApproval(task);
  }
  const input = payload as QuickAgentSessionPayload;
  const synthetic: ControllerTask = {
    id: "QUICK",
    title: input.title || "Quick Agent",
    objective: input.objective || "Execute a quick agent session.",
    status: "ready",
    dependsOn: [],
    allowedPaths: normalizeStringList(input.allowedPaths),
    forbiddenPaths: normalizeStringList(input.forbiddenPaths),
    checks: normalizeStringList(input.checks),
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
    risk: input.risk ?? "low",
    recommendedAgent: input.agent,
    notes: [],
    runIds: [],
    createdAt: now(),
    updatedAt: now(),
  };
  return taskApproval(synthetic);
}

function findExistingLaunchJob(
  repoRoot: string,
  payload: LaunchTaskPayload,
): LocalBridgeJob | undefined {
  const jobs = readStoredJobs(repoRoot, 500);
  const requestId = payload.requestId?.trim();
  if (requestId) {
    return jobs.find((entry) =>
      entry.action === "launch-task" &&
      typeof (entry.payload as LaunchTaskPayload).requestId === "string" &&
      (entry.payload as LaunchTaskPayload).requestId === requestId,
    );
  }
  return jobs.find((entry) =>
    entry.action === "launch-task" &&
    ["approved", "running", "dispatched"].includes(entry.status) &&
    entry.issueId === payload.issueId &&
    entry.taskId === payload.taskId,
  );
}

function findExistingQuickSessionJob(
  repoRoot: string,
  payload: QuickAgentSessionPayload,
): LocalBridgeJob | undefined {
  const jobs = readStoredJobs(repoRoot, 500);
  const requestId = payload.requestId?.trim();
  if (requestId) {
    return jobs.find((entry) =>
      entry.action === "quick-agent-session" &&
      typeof (entry.payload as QuickAgentSessionPayload).requestId === "string" &&
      (entry.payload as QuickAgentSessionPayload).requestId === requestId,
    );
  }
  return undefined;
}

function findExistingRunCheckJob(
  repoRoot: string,
  payload: RunCheckPayload,
  revision: string,
): LocalBridgeJob | undefined {
  const requestId = payload.requestId?.trim();
  if (requestId) {
    const duplicate = readStoredJobs(repoRoot, 500).find((entry) =>
      entry.action === "run-check" &&
      typeof (entry.payload as RunCheckPayload).requestId === "string" &&
      (entry.payload as RunCheckPayload).requestId === requestId,
    );
    if (duplicate) return duplicate;
  }
  const candidate = readActiveLocalBridgeJobs(repoRoot).find((entry) =>
    entry.action === "run-check" &&
    (entry.payload as RunCheckPayload).checkId === payload.checkId &&
    entry.revision === revision
  );
  return candidate ? refreshLocalBridgeJob(repoRoot, candidate, revision) : undefined;
}

function findExistingVerifyEditSessionJob(
  repoRoot: string,
  payload: VerifyEditSessionPayload,
): LocalBridgeJob | undefined {
  const jobs = readStoredJobs(repoRoot, 500);
  const requestId = payload.requestId?.trim();
  if (requestId) {
    return jobs.find((entry) =>
      entry.action === "verify-edit-session" &&
      typeof (entry.payload as VerifyEditSessionPayload).requestId === "string" &&
      (entry.payload as VerifyEditSessionPayload).requestId === requestId,
    );
  }
  return jobs.find((entry) =>
    entry.action === "verify-edit-session" &&
    ["approved", "running"].includes(entry.status) &&
    (entry.payload as VerifyEditSessionPayload).sessionId === payload.sessionId &&
    (entry.payload as VerifyEditSessionPayload).revision === payload.revision &&
    JSON.stringify((entry.payload as VerifyEditSessionPayload).checkIds ?? []) === JSON.stringify(payload.checkIds ?? []),
  );
}

function findExistingRepositoryCommandJob(
  repoRoot: string,
  payload: RepositoryCommandPayload,
): LocalBridgeJob | undefined {
  const jobs = readStoredJobs(repoRoot, 500);
  const requestId = payload.requestId?.trim();
  if (requestId) {
    return jobs.find((entry) =>
      entry.action === "repository-command" &&
      typeof (entry.payload as RepositoryCommandPayload).requestId === "string" &&
      (entry.payload as RepositoryCommandPayload).requestId === requestId,
    );
  }
  const candidate = jobs.find((entry) =>
    entry.action === "repository-command" &&
    ["approved", "running"].includes(entry.status) &&
    (entry.payload as RepositoryCommandPayload).repoId === payload.repoId &&
    (entry.payload as RepositoryCommandPayload).checkoutId === payload.checkoutId &&
    JSON.stringify((entry.payload as RepositoryCommandPayload).command) === JSON.stringify(payload.command) &&
    (entry.payload as RepositoryCommandPayload).cwd === payload.cwd &&
    (entry.payload as RepositoryCommandPayload).approvalToken === payload.approvalToken,
  );
  if (!candidate) return undefined;
  const refreshed = refreshLocalBridgeJob(repoRoot, candidate);
  return ["approved", "running"].includes(refreshed.status) ? refreshed : undefined;
}

export function submitLocalBridgeJob(
  _repoRoot: string,
  _request: LocalBridgeJobRequest,
): LocalBridgeJob {
  throw new Error(
    "LOCAL_BRIDGE_JOB_RETIRED: New Local Bridge Jobs are disabled. Use WorkContract with Process Runtime or an explicitly claimed external Controller.",
  );
}

function readLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  const path = metaPath(repoRoot, jobId);
  if (!existsSync(path)) throw new Error(`local bridge job not found: ${jobId}`);
  return readJson<LocalBridgeJob>(path);
}

function tryReadLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob | undefined {
  try {
    return readLocalBridgeJob(repoRoot, jobId);
  } catch (_error) {
    return undefined;
  }
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

export function failLocalBridgeJob(
  repoRoot: string,
  jobId: string,
  message: string,
  data?: Record<string, unknown>,
): LocalBridgeJob {
  const job = readLocalBridgeJob(repoRoot, jobId);
  if (["succeeded", "failed", "timed_out", "orphaned", "stale", "cancelled"].includes(job.status)) return job;
  return markJobTerminal(repoRoot, job, "failed", message, data);
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

export interface LocalBridgeJobSnapshotResult {
  status: "ok" | "not_found" | "rejected";
  jobId: string;
  job?: LocalBridgeJob;
  error?: { code: string; message: string };
}

export interface LocalBridgeJobOutputResult {
  jobId: string;
  jobStatus?: LocalBridgeJob["status"];
  stream: "stdout" | "stderr";
  path?: string;
  maxBytes: number;
  truncated: boolean;
  content: string;
  status: "ok" | "not_found" | "not_ready" | "rejected";
  error?: { code: string; message: string };
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

function localJobSnapshotError(jobId: string, error: unknown): LocalBridgeJobSnapshotResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.startsWith("LOCAL_JOB_PATH_INVALID:")
    ? "LOCAL_JOB_PATH_INVALID"
    : message.startsWith("LOCAL_JOB_ID_REQUIRED:")
      ? "LOCAL_JOB_ID_REQUIRED"
      : "LOCAL_JOB_NOT_FOUND";
  return {
    status: code === "LOCAL_JOB_NOT_FOUND" ? "not_found" : "rejected",
    jobId: String(jobId).trim(),
    error: { code, message },
  };
}

export function getLocalBridgeJobSnapshot(repoRoot: string, jobId: string): LocalBridgeJobSnapshotResult {
  try {
    return {
      status: "ok",
      jobId: normalizeLocalJobId(jobId),
      job: readLocalBridgeJob(repoRoot, jobId),
    };
  } catch (error) {
    return localJobSnapshotError(jobId, error);
  }
}

export function listLocalBridgeJobSnapshots(repoRoot: string, limit = 100): LocalBridgeJob[] {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  return readStoredJobs(repoRoot, boundedLimit).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
export function getLocalBridgeJobEventsSnapshot(
  repoRoot: string,
  jobId: string,
): LocalBridgeJobEvent[] {
  readLocalBridgeJob(repoRoot, jobId);
  const path = eventsPath(repoRoot, jobId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LocalBridgeJobEvent);
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

export function readLocalBridgeJobOutputSnapshot(
  repoRoot: string,
  jobId: string,
  input: {
    stream?: "stdout" | "stderr";
    maxBytes?: number;
  } = {},
): LocalBridgeJobOutputResult {
  const stream = input.stream === "stderr" ? "stderr" : "stdout";
  const maxBytes = boundedOutputBytes(input.maxBytes);
  const snapshot = getLocalBridgeJobSnapshot(repoRoot, jobId);
  if (snapshot.status !== "ok" || !snapshot.job) {
    return {
      jobId: snapshot.jobId,
      stream,
      maxBytes,
      truncated: false,
      content: "",
      status: snapshot.status,
      error: snapshot.error,
    };
  }
  const path = stream === "stdout" ? stdoutPath(repoRoot, snapshot.job.jobId) : stderrPath(repoRoot, snapshot.job.jobId);
  const relativePathValue = relativeOutputPath(snapshot.job.jobId, stream);
  if (!existsSync(path)) {
    const active = ["approved", "running", "dispatched"].includes(snapshot.job.status);
    return {
      jobId: snapshot.job.jobId,
      jobStatus: snapshot.job.status,
      stream,
      path: relativePathValue,
      maxBytes,
      truncated: false,
      content: "",
      status: active ? "not_ready" : "not_found",
      error: {
        code: active ? "LOCAL_JOB_OUTPUT_NOT_READY" : "LOCAL_JOB_OUTPUT_NOT_FOUND",
        message: active
          ? `Local job output is not ready yet for ${snapshot.job.jobId} ${stream}.`
          : `Local job output file was not found for ${snapshot.job.jobId} ${stream}.`,
      },
    };
  }
  const bytes = readFileSync(path);
  const truncated = bytes.byteLength > maxBytes;
  const content = (truncated ? bytes.subarray(Math.max(0, bytes.byteLength - maxBytes)) : bytes).toString("utf-8");
  return {
    jobId: snapshot.job.jobId,
    jobStatus: snapshot.job.status,
    stream,
    path: relativePathValue,
    maxBytes,
    truncated,
    content,
    status: "ok",
  };
}

export function readLocalBridgeJobOutput(
  repoRoot: string,
  jobId: string,
  input: {
    stream?: "stdout" | "stderr";
    maxBytes?: number;
  } = {},
): LocalBridgeJobOutputResult {
  return readLocalBridgeJobOutputSnapshot(repoRoot, jobId, input);
}

export function buildLocalBridgeJobHandoff(
  repoRoot: string,
  jobId: string,
  input: { maxBytes?: number } = {},
): LocalBridgeJobHandoff {
  const snapshot = getLocalBridgeJobSnapshot(repoRoot, jobId);
  if (snapshot.status !== "ok" || !snapshot.job) {
    return {
      jobId: snapshot.jobId,
      status: snapshot.status === "ok" ? "not_found" : snapshot.status,
      error: snapshot.error,
    };
  }
  const maxBytes = boundedOutputBytes(input.maxBytes);
  const stdout = readLocalBridgeJobOutputSnapshot(repoRoot, snapshot.job.jobId, { stream: "stdout", maxBytes });
  const stderr = readLocalBridgeJobOutputSnapshot(repoRoot, snapshot.job.jobId, { stream: "stderr", maxBytes });
  const result = snapshot.job.result ?? {};
  return {
    jobId: snapshot.job.jobId,
    status: snapshot.job.status,
    stdoutPath: stdout.path,
    stderrPath: stderr.path,
    stdout: typeof result.stdout === "string" ? result.stdout : undefined,
    stderr: typeof result.stderr === "string" ? result.stderr : undefined,
    outputStatus: {
      stdout: stdout.status,
      stderr: stderr.status,
    },
    changedPaths: snapshot.job.outcome?.policy?.changedPaths,
    nextLocalCommand: `tail -n 120 ${relativeOutputPath(snapshot.job.jobId, "stdout")} ${relativeOutputPath(snapshot.job.jobId, "stderr")}`,
  };
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

async function executeRunCheck(
  repoRoot: string,
  jobId: string,
  payload: RunCheckPayload,
): Promise<void> {
  let job = tryReadLocalBridgeJob(repoRoot, jobId);
  if (!job || job.status !== "running") return;
  job.ownerPid = process.pid;
  saveJob(repoRoot, job);
  try {
    const timeoutMs = resolvedJobTimeout(repoRoot, payload.timeoutMs);
    const result = await runControllerCheckAsync(repoRoot, payload.checkId, {
      snapshot: payload.checkSnapshot,
      requestedTimeoutMs: timeoutMs,
      onSpawn: (pid) => {
        const current = tryReadLocalBridgeJob(repoRoot, jobId);
        if (!current || current.status !== "running") {
          releaseControllerCheckSubscription(checkSubscriberId(jobId));
          return;
        }
        current.workerPid = pid;
        current.ownerPid = process.pid;
        current.deadlineAt = new Date(Date.now() + timeoutMs + 5_000).toISOString();
        saveJob(repoRoot, current);
      },
      subscriberId: checkSubscriberId(jobId),
    });
    job = tryReadLocalBridgeJob(repoRoot, jobId);
    if (!job || job.status !== "running") return;
    job.status = result.ok ? "succeeded" : "failed";
    job.finishedAt = now();
    job.result = result as unknown as Record<string, unknown>;
    const failureClass = result.failureClass ?? (result.ok ? undefined : "infrastructure_failure");
    const failureMessage = result.stderr || `check failed: ${payload.checkId}`;
    job.outcome = {
      process: { exitCode: result.status, timedOut: result.timedOut },
      failureClass,
      acceptanceFailure: failureClass === "acceptance_failure"
        ? { code: "CHECK_FAILED", message: failureMessage }
        : undefined,
      infrastructureError: failureClass === "infrastructure_failure"
        ? {
          code: result.timedOut ? "CHECK_TIMED_OUT" : "CHECK_EXECUTION_FAILED",
          message: failureMessage,
        }
        : undefined,
    };
    job.workerPid = undefined;
    if (!result.ok) job.error = failureMessage;
    appendEvent(repoRoot, job.jobId, {
      type: result.ok ? "job_succeeded" : "job_failed",
      message: result.ok
        ? `Check ${payload.checkId} passed.`
        : `Check ${payload.checkId} failed.`,
      data: { timedOut: result.timedOut, artifactPath: result.artifactPath },
    });
    saveJob(repoRoot, job);
  } catch (error) {
    job = tryReadLocalBridgeJob(repoRoot, jobId);
    if (!job || job.status !== "running") return;
    job.status = "failed";
    job.finishedAt = now();
    job.workerPid = undefined;
    const message = error instanceof Error ? error.message : String(error);
    job.error = message;
    job.outcome = {
      failureClass: "infrastructure_failure",
      infrastructureError: { code: "CHECK_EXECUTION_FAILED", message },
    };
    appendEvent(repoRoot, job.jobId, {
      type: "job_failed",
      message: job.error,
    });
    saveJob(repoRoot, job);
  }
}

async function executeVerifyEditSession(
  repoRoot: string,
  jobId: string,
  payload: VerifyEditSessionPayload,
): Promise<void> {
  let job = tryReadLocalBridgeJob(repoRoot, jobId);
  if (!job || job.status !== "running") return;
  const timeoutMs = resolvedJobTimeout(repoRoot, undefined);
  job.ownerPid = process.pid;
  job.deadlineAt = new Date(Date.now() + timeoutMs + 5_000).toISOString();
  saveJob(repoRoot, job);
  appendEvent(repoRoot, job.jobId, {
    type: "job_progress",
    message: `Verifying edit session ${payload.sessionId}.`,
    data: { sessionId: payload.sessionId, revision: payload.revision },
  });
  try {
    const session = await verifyEditSessionAsync(repoRoot, payload.sessionId, {
      checkIds: payload.checkIds,
      reviewer: payload.reviewer,
      note: payload.note,
    }, {
      onCheckSpawn: (checkId, pid) => {
        const current = tryReadLocalBridgeJob(repoRoot, jobId);
        if (!current || current.status !== "running") {
          releaseControllerCheckSubscription(checkSubscriberId(jobId));
          return;
        }
        current.workerPid = pid;
        current.ownerPid = process.pid;
        current.heartbeatAt = now();
        saveJob(repoRoot, current);
        appendEvent(repoRoot, current.jobId, {
          type: "job_progress",
          message: `Running check ${checkId}.`,
          data: { checkId, pid },
        });
      },
      subscriberId: checkSubscriberId(jobId),
    });
    job = tryReadLocalBridgeJob(repoRoot, jobId);
    if (!job || job.status !== "running") return;
    job.status = session.status === "checked" ? "succeeded" : "failed";
    job.finishedAt = now();
    job.workerPid = undefined;
    job.result = {
      sessionId: session.sessionId,
      status: session.status,
      verifiedAt: session.verifiedAt,
      checkResults: session.checkResults,
      diffPath: session.diffPath,
    };
    if (job.status !== "succeeded") job.error = session.checkResults.find((entry) => !entry.ok)?.summary ?? "edit session verification failed";
    appendEvent(repoRoot, job.jobId, {
      type: job.status === "succeeded" ? "job_succeeded" : "job_failed",
      message: job.status === "succeeded"
        ? `Edit session ${payload.sessionId} verified.`
        : `Edit session ${payload.sessionId} verification failed.`,
      data: { sessionId: payload.sessionId, revision: payload.revision },
    });
    saveJob(repoRoot, job);
  } catch (error) {
    job = tryReadLocalBridgeJob(repoRoot, jobId);
    if (!job || job.status !== "running") return;
    markJobTerminal(repoRoot, job, "failed", error instanceof Error ? error.message : String(error));
  }
}

async function executeRepositoryCommand(
  repoRoot: string,
  jobId: string,
  payload: RepositoryCommandPayload,
): Promise<void> {
  let job = tryReadLocalBridgeJob(repoRoot, jobId);
  if (!job || job.status !== "running") return;
  const timeoutMs = resolvedJobTimeout(repoRoot, payload.timeoutMs);
  job.ownerPid = process.pid;
  job.deadlineAt = new Date(Date.now() + timeoutMs + 5_000).toISOString();
  saveJob(repoRoot, job);
  appendEvent(repoRoot, job.jobId, {
    type: "job_progress",
    message: `Executing repository command for ${payload.repoId}.`,
    data: { repoId: payload.repoId, checkoutId: payload.checkoutId },
  });
  try {
    const repository = resolveRepositorySelection({
      repoId: payload.repoId,
      checkoutId: payload.checkoutId,
      controllerHome: payload.controllerHome,
      allowSoleRepository: true,
    });
    // Durable Execution Jobs already hold repository-scoped leases for the
    // command lifetime. Holding the controller repository lock here as well
    // blocks the owning worker from renewing those leases and turns any
    // command longer than the renewal interval into a false LOCK_HELD failure.
    const execution = await executeRepositoryCommandAsync(payload.controllerHome, repository, {
      command: payload.command,
      cwd: payload.cwd,
      authorization: "confirmed_plan",
      approvalToken: payload.approvalToken,
      approvalRequestId: payload.approvalRequestId,
      timeoutMs: payload.timeoutMs,
      maxOutputBytes: payload.maxOutputBytes,
    }, {
      onSpawn: (pid) => {
        const current = tryReadLocalBridgeJob(repoRoot, jobId);
        if (!current || current.status !== "running") {
          signalWorker(pid, "SIGTERM");
          return;
        }
        current.workerPid = pid;
        current.ownerPid = process.pid;
        current.heartbeatAt = now();
        saveJob(repoRoot, current);
      },
      onStdout: (chunk) => {
        appendJobOutput(repoRoot, jobId, "stdout", chunk);
        const current = tryReadLocalBridgeJob(repoRoot, jobId);
        if (!current || current.status !== "running") return;
        current.heartbeatAt = now();
        saveJob(repoRoot, current);
      },
      onStderr: (chunk) => {
        appendJobOutput(repoRoot, jobId, "stderr", chunk);
        const current = tryReadLocalBridgeJob(repoRoot, jobId);
        if (!current || current.status !== "running") return;
        current.heartbeatAt = now();
        saveJob(repoRoot, current);
      },
    });
    job = tryReadLocalBridgeJob(repoRoot, jobId);
    if (!job || job.status !== "running") return;
    const stdoutPath = `.ai/harness/local-jobs/${job.jobId}/stdout.log`;
    const stderrPath = `.ai/harness/local-jobs/${job.jobId}/stderr.log`;
    job.workerPid = undefined;
    job.ownerPid = undefined;
    job.result = {
      ...(execution as unknown as Record<string, unknown>),
      stdoutPath,
      stderrPath,
    };
    job.outcome = {
      process: { exitCode: execution.exitCode, timedOut: execution.timedOut, stdoutPath, stderrPath },
      policy: {
        decision: execution.status === "approval_required" ? "approval_required" : "allowed",
        repositoryChanged: execution.repositoryChanged,
        changedPaths: execution.changedPaths,
      },
      infrastructureError: execution.infrastructureError,
    };
    if (execution.status === "approval_required") {
      job.status = "pending_approval";
      job.finishedAt = undefined;
      job.error = undefined;
      appendEvent(repoRoot, job.jobId, {
        type: "job_approval_required",
        message: `Repository command is waiting for approval for ${payload.repoId}.`,
        data: {
          repoId: payload.repoId,
          approvalRequestId: execution.approvalRequestId,
          authorizationDecision: execution.authorizationDecision,
        },
      });
      saveJob(repoRoot, job);
      return;
    }
    job.status = execution.ok ? "succeeded" : execution.timedOut ? "timed_out" : "failed";
    job.finishedAt = now();
    job.error = execution.ok ? undefined : execution.infrastructureError?.message
      ?? execution.stderr
      ?? `repository command exited with ${String(execution.exitCode ?? 1)}`;
    appendEvent(repoRoot, job.jobId, {
      type: job.status === "succeeded" ? "job_succeeded" : "job_failed",
      message: job.status === "succeeded"
        ? `Repository command completed for ${payload.repoId}.`
        : `Repository command failed for ${payload.repoId}.`,
      data: { repoId: payload.repoId, exitCode: execution.exitCode, timedOut: execution.timedOut },
    });
    saveJob(repoRoot, job);
  } catch (error) {
    job = tryReadLocalBridgeJob(repoRoot, jobId);
    if (!job || job.status !== "running") return;
    markJobTerminal(repoRoot, job, "failed", error instanceof Error ? error.message : String(error));
  }
}

export function executeLocalBridgeJobInline(
  repoRoot: string,
  jobId: string,
): LocalBridgeJob {
  return dispatchLocalBridgeJob(repoRoot, jobId);
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


/** Compatibility API for repository-local callers and focused tests.
 * Production Gateway and Local UI surfaces use dispatchLocalBridgeJob instead.
 */
export function executeLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  return executeLocalBridgeJobInline(repoRoot, jobId);
}
