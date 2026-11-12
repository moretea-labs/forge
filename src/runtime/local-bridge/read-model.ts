import { existsSync, readFileSync, readdirSync } from "fs";
import { join, relative, resolve, sep } from "path";
import type { LocalBridgeJob, LocalBridgeJobEvent } from "./types";

export const LOCAL_BRIDGE_JOB_ROOT = ".ai/harness/local-jobs";

export function normalizeLocalJobId(jobId: string): string {
  const normalized = String(jobId).trim();
  if (!normalized) throw new Error("LOCAL_JOB_ID_REQUIRED: job_id is required");
  if (normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("LOCAL_JOB_PATH_INVALID: local job ids must not contain path traversal or path separators");
  }
  return normalized;
}

function localJobRoot(repoRoot: string): string {
  return resolve(repoRoot, LOCAL_BRIDGE_JOB_ROOT);
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

export function jobDir(repoRoot: string, jobId: string): string {
  return resolveLocalJobDir(repoRoot, jobId);
}

export function metaPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "job.json");
}

export function eventsPath(repoRoot: string, jobId: string): string {
  return join(jobDir(repoRoot, jobId), "events.jsonl");
}
export function allStoredJobPaths(repoRoot: string): string[] {
  const root = join(repoRoot, LOCAL_BRIDGE_JOB_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "job.json")))
    .map((entry) => join(root, entry.name, "job.json"))
    .sort((a, b) => b.localeCompare(a));
}

function storedJobPaths(repoRoot: string, limit = 500): string[] {
  return allStoredJobPaths(repoRoot).slice(0, Math.max(1, Math.min(limit, 5000)));
}

export function readStoredJobs(repoRoot: string, limit = 500): LocalBridgeJob[] {
  return storedJobPaths(repoRoot, limit).flatMap((path) => {
    try {
      return [readJson<LocalBridgeJob>(path)];
    } catch (_error) {
      return [];
    }
  });
}
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}
export function readLocalBridgeJob(repoRoot: string, jobId: string): LocalBridgeJob {
  const path = metaPath(repoRoot, jobId);
  if (!existsSync(path)) throw new Error(`local bridge job not found: ${jobId}`);
  return readJson<LocalBridgeJob>(path);
}
export interface LocalBridgeJobSnapshotResult {
  status: "ok" | "not_found" | "rejected";
  jobId: string;
  job?: LocalBridgeJob;
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
