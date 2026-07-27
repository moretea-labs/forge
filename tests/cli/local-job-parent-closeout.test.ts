import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createIssue, getIssue, listIssues } from "../../src/cli/controller/issue-store";
import {
  closeoutParentLocalJobFromAgentRun,
  getLocalBridgeJob,
  submitLocalBridgeJob,
} from "../../src/cli/local-bridge/job-store";
import type { AgentJobMeta } from "../../src/cli/agent-jobs/types";
import { normalizeSuccessfulAgentRunMeta } from "../../src/cli/agent-jobs/job-manager";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-harness-parent-closeout-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "repo-harness-parent-closeout-home-"));
  roots.push(root, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness/jobs"), { recursive: true });
  spawnSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  return root;
}

function readJob(root: string, jobId: string) {
  return JSON.parse(readFileSync(join(root, ".ai/harness/local-jobs", jobId, "job.json"), "utf-8"));
}

describe("Local Job active parent closeout", () => {
  test("terminal Agent Run actively closes parent Local Job without get/list, and is idempotent", () => {
    const root = repo();
    const job = submitLocalBridgeJob(root, {
      action: "quick-agent-session",
      requestedBy: "test",
      payload: {
        title: "Closeout diagnosis",
        objective: "Prove active parent closeout.",
        risk: "readonly",
      },
    });
    expect(job.ephemeral).toBe(true);

    const issue = createIssue(root, {
      title: "Closeout diagnosis",
      kind: "investigation",
      ephemeral: true,
      ephemeralOwnerJobId: job.jobId,
      tasks: [{ title: "Inspect", objective: "Inspect only.", risk: "readonly" }],
    });
    const runId = "RUN-parent-closeout-ok";
    const finishedAt = new Date().toISOString();
    const jobPath = join(root, ".ai/harness/local-jobs", job.jobId, "job.json");
    const stored = JSON.parse(readFileSync(jobPath, "utf-8"));
    stored.status = "dispatched";
    stored.runId = runId;
    stored.issueId = issue.id;
    stored.taskId = "T1";
    stored.ephemeral = true;
    delete stored.finishedAt;
    writeFileSync(jobPath, `${JSON.stringify(stored, null, 2)}\n`);

    const run: Pick<AgentJobMeta, "runId" | "status" | "finishedAt" | "error" | "exitCode" | "parentLocalJobId"> = {
      runId,
      status: "succeeded",
      finishedAt,
      exitCode: 0,
      parentLocalJobId: job.jobId,
    };

    // Active closeout — no getLocalBridgeJob / list / reconcile call.
    const closed = closeoutParentLocalJobFromAgentRun(root, run);
    expect(closed?.status).toBe("succeeded");
    expect(closed?.finishedAt).toBeTruthy();
    expect(closed?.result?.runStatus).toBe("succeeded");
    expect(closed?.cleanupAt).toBeTruthy();

    const raw = readJob(root, job.jobId);
    expect(raw.status).toBe("succeeded");
    expect(raw.cleanupAt).toBeTruthy();
    expect(listIssues(root)).toEqual([]);
    expect(() => getIssue(root, issue.id)).toThrow();

    // Idempotent second closeout.
    const again = closeoutParentLocalJobFromAgentRun(root, run);
    expect(again?.status).toBe("succeeded");
    expect(again?.cleanupAt).toBe(raw.cleanupAt);
    expect(readJob(root, job.jobId).status).toBe("succeeded");
  });

  test("successful Run clears stale executorHealth and terminationReason", () => {
    const meta = {
      schemaVersion: 3 as const,
      runId: "RUN-health-clear",
      issueId: "ISS-1",
      taskId: "T1",
      agent: "codex" as const,
      provider: "local" as const,
      executionMode: "workspace" as const,
      status: "succeeded" as const,
      repoRoot: "/tmp",
      worktree: "/tmp",
      branch: null,
      baseRevision: null,
      promptPath: "p",
      stdoutPath: "o",
      stderrPath: "e",
      resultPath: "r",
      eventsPath: "v",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: "previous spawn failure",
      terminationReason: "spawn_error" as const,
      executorHealth: {
        status: "auth_required" as const,
        reason: "codex_auth_required" as const,
        message: "stale failure classification",
        agent: "codex" as const,
        remediation: "Re-authenticate Codex and retry.",
        fallback: "authenticate_codex" as const,
      },
    };
    const normalized = normalizeSuccessfulAgentRunMeta({ ...meta });
    expect(normalized.executorHealth).toBeUndefined();
    expect(normalized.error).toBeUndefined();
    expect(normalized.terminationReason).toBeUndefined();
    expect(normalized.status).toBe("succeeded");
  });
});
