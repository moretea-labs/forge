import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";

export const AGENT_JOB_ROOT = ".ai/harness/jobs";
export const AGENT_RUN_INDEX_ROOT = ".ai/harness/controller/run-indexes";

export interface AgentRunIndexEntry<
  Status extends string = string,
  ExecutionMode extends string = string,
> {
  runId: string;
  issueId: string;
  taskId: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
  executionMode: ExecutionMode;
  integratedSessionId?: string;
}

export interface AgentRunIndex<
  Status extends string = string,
  ExecutionMode extends string = string,
> {
  schemaVersion: 1;
  updatedAt: string;
  runs: AgentRunIndexEntry<Status, ExecutionMode>[];
}

export interface AgentJobMetaReadShape {
  schemaVersion?: 1 | 2 | 3;
  runId: string;
  issueId: string;
  taskId: string;
  agent: string;
  provider?: string;
  executionMode?: string;
  status: string;
  repoRoot: string;
  worktree: string;
  eventsPath?: string;
  worktreeCleanedAt?: string;
  integratedSessionId?: string;
  autoIntegrate?: boolean;
  closureState?: string;
  createdAt: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  error?: string;
  progress?: {
    currentActivity?: string;
    lastActivityAt?: string;
  };
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function jobDir(repoRoot: string, runId: string): string {
  return join(repoRoot, AGENT_JOB_ROOT, runId);
}

export function metaPath(repoRoot: string, runId: string): string {
  return join(jobDir(repoRoot, runId), "meta.json");
}

export function eventPath(repoRoot: string, runId: string): string {
  return join(jobDir(repoRoot, runId), "events.jsonl");
}

export function runIndexPath(
  repoRoot: string,
  name: "active" | "recent" | "pending-integration",
): string {
  return join(repoRoot, AGENT_RUN_INDEX_ROOT, `${name}.json`);
}

export function taskRunIndexPath(repoRoot: string, issueId: string, taskId: string): string {
  const digest = createHash("sha256").update(`${issueId}\0${taskId}`).digest("hex");
  return join(repoRoot, AGENT_RUN_INDEX_ROOT, "tasks", `${digest}.json`);
}

export function normalizeAgentMeta<T extends AgentJobMetaReadShape>(
  repoRoot: string,
  runId: string,
  meta: T,
): T {
  meta.schemaVersion = meta.schemaVersion ?? 1;
  meta.provider = meta.provider ?? "local";
  meta.executionMode =
    meta.executionMode ??
    (meta.provider === "github"
      ? "github"
      : meta.worktree === repoRoot
        ? "workspace"
        : "worktree");
  // Integration is an explicit model decision. Historical worktree Runs may
  // retain this field for read compatibility, but a missing value must never
  // turn a completed execution into a workflow transition.
  meta.autoIntegrate = meta.autoIntegrate ?? false;
  meta.closureState = meta.closureState ?? (
    meta.provider === "local" && meta.executionMode === "worktree"
      ? meta.worktreeCleanedAt
        ? "completed"
        : meta.status === "waiting_for_user"
          ? "preserved"
          : meta.integratedSessionId
            ? "cleanup_pending"
            : ["queued", "starting", "running", "succeeded"].includes(meta.status)
              ? "integration_pending"
              : "none"
      : meta.status === "succeeded"
        ? "completed"
        : "none"
  );
  meta.eventsPath =
    meta.eventsPath ??
    relative(repoRoot, eventPath(repoRoot, runId)).replace(/\\/g, "/");
  return meta;
}

export function readRawAgentMeta<T extends AgentJobMetaReadShape = AgentJobMetaReadShape>(
  repoRoot: string,
  runId: string,
): T | undefined {
  const path = metaPath(repoRoot, runId);
  if (!existsSync(path)) return undefined;
  try {
    return normalizeAgentMeta(repoRoot, runId, readJson<T>(path));
  } catch (_error) {
    return undefined;
  }
}

export function readRunIndex<
  Status extends string = string,
  ExecutionMode extends string = string,
>(
  repoRoot: string,
  name: "active" | "recent" | "pending-integration",
): AgentRunIndex<Status, ExecutionMode> {
  const path = runIndexPath(repoRoot, name);
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: new Date().toISOString(), runs: [] };
  try {
    return readJson<AgentRunIndex<Status, ExecutionMode>>(path);
  } catch {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), runs: [] };
  }
}

export function listActiveAgentJobSnapshots(
  repoRoot: string,
  limit = 50,
): AgentJobMetaReadShape[] {
  const boundedLimit = Math.min(Math.max(limit, 1), 500);
  return readRunIndex(repoRoot, "active").runs.slice(0, boundedLimit).flatMap((entry) => {
    const meta = readRawAgentMeta(repoRoot, entry.runId);
    return meta ? [meta] : [];
  });
}
