import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHmac } from "crypto";
import { spawn, spawnSync } from "child_process";
import { cancelAgentJob, getAgentJob, getAgentJobEvents, getAgentJobLog, listAgentJobs } from "../../src/cli/agent-jobs/job-manager";
import {
  controllerCheckConcurrencyClass,
  releaseControllerCheckSubscription,
  runControllerCheckAsync,
} from "../../src/cli/controller/check-runner";
import { FORGE_TOOL_SURFACE } from "../../src/cli/controller/runtime-config";
import { createIssue, getIssue, updateTask } from "../../src/cli/controller/issue-store";
import { beginEditSession, applyEditOperations } from "../../src/cli/editing/edit-session";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import {
  executeLocalBridgeJob,
  getLocalBridgeJob,
  cancelLocalBridgeJob,
  listLocalBridgeJobs,
  reconcileLocalBridgeJobs,
  submitLocalBridgeJob,
} from "../../src/cli/local-bridge/job-store";
import {
  startLocalBridgeServer,
  type LocalBridgeServerHandle,
} from "../../src/cli/local-bridge/server";
import { isProcessAlive } from "../../src/runtime/shared/process-tree";
import { loadRepositoryRegistry } from "../../src/cli/repositories/registry";
import { createSchedule, saveOccurrence, saveSchedule } from "../../src/runtime/workflow/schedules/store";
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from "../runtime/process-hygiene";

const roots: string[] = [];
const repoRoots: string[] = [];
const servers: LocalBridgeServerHandle[] = [];
const originalControllerHome = process.env.FORGE_CONTROLLER_HOME;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  const cleanupRoots = repoRoots.splice(0);
  for (const repoRoot of cleanupRoots) {
    for (const job of listLocalBridgeJobs(repoRoot, 5000)) {
      if (["approved", "dispatched", "running"].includes(job.status)) {
        cancelLocalBridgeJob(repoRoot, job.jobId);
      }
    }
    for (const run of listAgentJobs(repoRoot, 5000)) {
      if (run.provider === "local" && ["queued", "starting", "running", "unknown"].includes(run.status)) {
        cancelAgentJob(repoRoot, run.runId);
      }
    }
  }
  const cleanupPaths = [...new Set([...cleanupRoots, ...roots])];
  await terminateProcessesByCommand(cleanupPaths);
  await waitForNoProcessesByCommand(cleanupPaths);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
  else process.env.FORGE_CONTROLLER_HOME = originalControllerHome;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-local-bridge-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "forge-local-bridge-controller-"));
  roots.push(root);
  roots.push(controllerHome);
  repoRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, ".ai/harness"), { recursive: true });
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/mcp.local.json"), `${JSON.stringify({
    version: 1,
    devMode: {
      agentRunner: true,
      allowedAgents: ["codex"],
      timeoutMs: 10_000,
    },
  }, null, 2)}\n`);
  writeFileSync(join(root, "src/example.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "tasks/current.md"), "# Current\n");
  expect(spawnSync("git", ["init", "-b", "main"], { cwd: root }).status).toBe(0);
  process.env.FORGE_CONTROLLER_HOME = controllerHome;
  return root;
}

function fakeCodex(): { binRoot: string; restore(): void } {
  const binRoot = mkdtempSync(join(tmpdir(), "forge-local-bridge-bin-"));
  roots.push(binRoot);
  const originalPath = process.env.PATH;
  const executable = join(binRoot, "codex");
  writeFakeCodexExecutable(executable, 'echo "local-bridge-codex-ok"\n');
  process.env.PATH = `${binRoot}:${originalPath ?? ""}`;
  return {
    binRoot,
    restore: () => {
      process.env.PATH = originalPath;
    },
  };
}

function writeFakeCodexExecutable(executable: string, body: string): void {
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "codex-cli 0.0.0-test"
  exit 0
fi
if [[ "$1" == "login" && "$2" == "status" ]]; then
  echo "Logged in as test@example.com"
  exit 0
fi
${body}
`,
  );
  chmodSync(executable, 0o755);
}

async function waitForRun(
  root: string,
  runId: string,
  predicate: (run: ReturnType<typeof getAgentJob>) => boolean,
  attempts = 120,
  delayMs = 25,
) {
  let run = getAgentJob(root, runId);
  for (let attempt = 0; attempt < attempts && !predicate(run); attempt += 1) {
    await Bun.sleep(delayMs);
    run = getAgentJob(root, runId);
  }
  return run;
}

describe("Local Execution Bridge", () => {
  test('fails closed at the Local Bridge Job write boundary', () => {
    const root = repo();
    expect(() => submitLocalBridgeJob(root, {
      action: 'run-check',
      requestedBy: 'test',
      payload: { checkId: 'package:test' },
    })).toThrow(/LOCAL_BRIDGE_JOB_RETIRED/);
    expect(listLocalBridgeJobs(root)).toHaveLength(0);
  });

  test('returns stable 410 handoffs for retired Local Bridge creation routes', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);

    for (const path of ['/api/jobs', '/api/tasks/launch-ready', '/api/issues/ISS-test/launch', '/api/issues/ISS-test/tasks/T1/launch']) {
      const response = await fetch(new URL(path, handle.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-local-token': handle.token },
        body: '{}',
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: 'LOCAL_BRIDGE_JOB_RETIRED' });
    }
  });

  test("starts successfully when Local Job runtime storage is already linked", async () => {
    const root = repo();
    const first = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    await first.close();
    expect(lstatSync(join(root, ".ai/harness/local-jobs")).isSymbolicLink()).toBe(true);

    const second = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(second);
    expect((await fetch(new URL("/health", second.url))).status).toBe(200);
  });

  test("repairs a dangling local-job storage link before startup reconciliation", async () => {
    const root = repo();
    const localJobsPath = join(root, ".ai/harness/local-jobs");
    symlinkSync(join(root, ".missing-runtime-storage"), localJobsPath, "dir");

    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);

    const repository = JSON.parse(readFileSync(join(root, ".ai/harness/repository.json"), "utf-8")) as { repoId: string };
    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const controllerLocalJobs = join(controllerHome, "repositories", repository.repoId, "local-jobs");
    expect(realpathSync(localJobsPath)).toBe(realpathSync(controllerLocalJobs));
    expect((await fetch(new URL("/health", handle.url))).status).toBe(200);
  });

  test("classifies full repository gates as heavy while leaving focused checks concurrent", () => {
    expect(controllerCheckConcurrencyClass("package:test")).toBe("heavy");
    // The unified Forge Runtime suite is an ordinary heavy repository gate.
    expect(controllerCheckConcurrencyClass("package:check:forge-runtime")).toBe("heavy");
    expect(controllerCheckConcurrencyClass("package:check:release-surface")).toBe("heavy");
    expect(controllerCheckConcurrencyClass("focused")).toBe("light");
    expect(controllerCheckConcurrencyClass("package:check:type")).toBe("light");
  });

  test("waits for a repository heavy-check lock held by another Controller", async () => {
    const root = repo();
    mkdirSync(join(root, ".forge"), { recursive: true });
    mkdirSync(join(root, ".ai/harness/controller"), { recursive: true });
    writeFileSync(join(root, ".forge/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        "check:release": {
          command: [process.execPath, "-e", "process.exit(0)"],
          timeoutMs: 5_000,
        },
      },
    }));
    const lockPath = join(root, ".ai/harness/controller/heavy-check.lock");
    writeFileSync(lockPath, `${JSON.stringify({
      lockId: "external-controller",
      controllerPid: process.pid,
      checkId: "package:test",
      createdAt: new Date().toISOString(),
    })}\n`);
    const pids: number[] = [];
    const pending = runControllerCheckAsync(root, "check:release", {
      onSpawn: (pid) => pids.push(pid),
    });
    await Bun.sleep(150);
    expect(pids).toHaveLength(0);
    rmSync(lockPath, { force: true });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(pids).toHaveLength(1);
  });

  test("notifies every subscriber when a deduplicated check spawns", async () => {
    const root = repo();
    mkdirSync(join(root, ".forge"), { recursive: true });
    writeFileSync(join(root, ".forge/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        shared: {
          command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 500)"],
          timeoutMs: 5_000,
        },
      },
    }));
    const firstPids: number[] = [];
    const secondPids: number[] = [];
    const first = runControllerCheckAsync(root, "shared", {
      onSpawn: (pid) => firstPids.push(pid),
    });
    await Bun.sleep(25);
    const second = runControllerCheckAsync(root, "shared", {
      onSpawn: (pid) => secondPids.push(pid),
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.executedAt).toBe(firstResult.executedAt);
    expect(firstPids).toHaveLength(1);
    expect(secondPids).toEqual(firstPids);
  });

  test("fails a check when the command exits but leaves a child process tree behind", async () => {
    const root = repo();
    mkdirSync(join(root, ".forge"), { recursive: true });
    const childPidPath = join(root, "leaky-check-child.pid");
    writeFileSync(join(root, ".forge/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        leaky: {
          command: [process.execPath, "-e", `
            const { spawn } = require("child_process");
            const { writeFileSync } = require("fs");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), "utf8");
            process.exit(0);
          `],
          timeoutMs: 5_000,
        },
      },
    }));

    const result = await runControllerCheckAsync(root, "leaky");
    let childPid: number | undefined;
    for (let attempt = 0; attempt < 80 && childPid === undefined; attempt += 1) {
      if (existsSync(childPidPath)) {
        const value = Number.parseInt(readFileSync(childPidPath, "utf8").trim(), 10);
        if (Number.isInteger(value) && value > 0) childPid = value;
      }
      if (childPid === undefined) await Bun.sleep(25);
    }

    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    // The supervised bridge reports the residual process as a failure code.
    expect(result.stderr).toMatch(/CHILD_SUPERVISOR_RESIDUAL_PROCESS|check process tree remained alive/);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  test("releasing one shared-check subscriber does not terminate the remaining subscriber", async () => {
    const root = repo();
    mkdirSync(join(root, ".forge"), { recursive: true });
    writeFileSync(join(root, ".forge/checks.json"), JSON.stringify({
      version: 1,
      checks: {
        shared: {
          command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 350)"],
          timeoutMs: 5_000,
        },
      },
    }));
    const first = runControllerCheckAsync(root, "shared", { subscriberId: "subscriber:first" });
    await Bun.sleep(20);
    const second = runControllerCheckAsync(root, "shared", { subscriberId: "subscriber:second" });
    const released = releaseControllerCheckSubscription("subscriber:first");
    expect(released.released).toBe(true);
    expect(released.remainingSubscribers).toBe(1);
    expect(released.terminationRequested).toBe(false);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(secondResult.executedAt).toBe(firstResult.executedAt);
  });

  test("startup reconciliation detects Worker PID reuse without killing the unrelated process", async () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Orphaned worker",
      tasks: [{
        title: "Recover",
        objective: "Mark stale ownership without killing a PID-reused process.",
        allowedPaths: ["src/example.ts"],
        risk: "low",
      }],
    });
    const runId = "RUN-orphaned-detached-worker";
    const runDir = join(root, ".ai/harness/jobs", runId);
    mkdirSync(runDir, { recursive: true });
    for (const name of ["stdout.log", "stderr.log", "events.jsonl"]) {
      writeFileSync(join(runDir, name), "");
    }
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const now = new Date().toISOString();
    writeFileSync(join(runDir, "meta.json"), `${JSON.stringify({
      schemaVersion: 3,
      repoId: "repo-test",
      checkoutId: "checkout-test",
      runId,
      issueId: issue.id,
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "workspace",
      status: "running",
      repoRoot: root,
      executionRoot: root,
      worktree: root,
      worktreePath: root,
      branch: null,
      baseRevision: null,
      promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
      stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
      stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
      resultPath: `.ai/harness/jobs/${runId}/result.json`,
      eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
      controllerPid: 999_999,
      controllerEpoch: "stale-epoch",
      controllerEpochPath: ".ai/harness/controller/runtime-owner.json",
      workerPid: worker.pid,
      createdAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      progress: {
        phase: "editing",
        currentActivity: "stale worker",
        lastActivityAt: now,
        activityCount: 1,
      },
    }, null, 2)}\n`);
    updateTask(root, issue.id, "T1", { status: "running", runId });

    try {
      const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
      servers.push(handle);
      let alive = true;
      for (let attempt = 0; attempt < 80 && alive; attempt += 1) {
        await Bun.sleep(25);
        try {
          process.kill(worker.pid!, 0);
        } catch {
          alive = false;
        }
      }
      const run = getAgentJob(root, runId);
      expect(run.status).toBe("unknown");
      expect(run.error).toContain("Worker PID was reused by an unrelated process");
      expect(alive).toBe(true);
    } finally {
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
  });

  test("startup reconciliation fail-closes a running Run that lost ownership metadata", async () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "Missing run ownership",
      tasks: [{
        title: "Recover",
        objective: "Stop a local worker whose ownership metadata disappeared.",
        allowedPaths: ["src/example.ts"],
        risk: "low",
      }],
    });
    const runId = "RUN-missing-ownership";
    const runDir = join(root, ".ai/harness/jobs", runId);
    mkdirSync(runDir, { recursive: true });
    for (const name of ["stdout.log", "stderr.log", "events.jsonl"]) {
      writeFileSync(join(runDir, name), "");
    }
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const now = new Date().toISOString();
    writeFileSync(join(runDir, "meta.json"), `${JSON.stringify({
      schemaVersion: 3,
      repoId: "repo-test",
      checkoutId: "checkout-test",
      runId,
      issueId: issue.id,
      taskId: "T1",
      agent: "codex",
      provider: "local",
      executionMode: "workspace",
      status: "running",
      repoRoot: root,
      executionRoot: root,
      worktree: root,
      worktreePath: root,
      branch: null,
      baseRevision: null,
      promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
      stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
      stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
      resultPath: `.ai/harness/jobs/${runId}/result.json`,
      eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
      workerPid: worker.pid,
      createdAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
      progress: {
        phase: "editing",
        currentActivity: "ownership disappeared",
        lastActivityAt: now,
        activityCount: 1,
      },
    }, null, 2)}\n`);
    updateTask(root, issue.id, "T1", { status: "running", runId });

    try {
      const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
      servers.push(handle);
      let alive = true;
      for (let attempt = 0; attempt < 80 && alive; attempt += 1) {
        await Bun.sleep(25);
        try {
          process.kill(worker.pid!, 0);
        } catch {
          alive = false;
        }
      }
      const run = getAgentJob(root, runId);
      expect(run.status).toBe("unknown");
      expect(run.error).toContain("ownership metadata is missing");
      expect(alive).toBe(false);
    } finally {
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
  });

  test("serves V5 focus, governance, direct action, worklog, and GitHub plugin APIs", async () => {
    const root = repo();
    const issue = createIssue(root, {
      title: "V5 API surface",
      summary: "Expose progress and evidence.",
      goals: ["Inspect one Task."],
      acceptanceCriteria: ["The V5 endpoints respond."],
      tasks: [{
        title: "Inspect",
        objective: "Return Task detail and timeline.",
        allowedPaths: ["src/**"],
        checks: ["focused"],
        acceptanceCriteria: ["Visible"],
        risk: "low",
      }],
    });
    mkdirSync(join(root, ".forge"), { recursive: true });
    writeFileSync(join(root, ".forge/checks.json"), JSON.stringify({
      version: 1,
      checks: { focused: { command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 10_000 } },
    }));
    const runId = "RUN-v5-api-succeeded";
    const runDir = join(root, ".ai/harness/jobs", runId);
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    for (const name of ["stdout.log", "stderr.log", "events.jsonl"]) writeFileSync(join(runDir, name), "");
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({
      schemaVersion: 2, runId, issueId: issue.id, taskId: "T1", agent: "codex", provider: "local", executionMode: "workspace", status: "succeeded", repoRoot: realpathSync(root), worktree: realpathSync(root), branch: null, baseRevision: null, promptPath: `.ai/harness/jobs/${runId}/prompt.md`, stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`, stderrPath: `.ai/harness/jobs/${runId}/stderr.log`, resultPath: `.ai/harness/jobs/${runId}/result.json`, eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`, timeoutMs: 10_000, createdAt: now, startedAt: now, finishedAt: now, integratedSessionId: "EDIT-v5-api-fixture", progress: { phase: "completed", currentActivity: "complete", lastActivityAt: now, activityCount: 1 },
    }, null, 2));
    updateTask(root, issue.id, "T1", { status: "review", runId, note: "Ready for verification." });
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const headers = { "x-forge-local-token": handle.token };

    const progress = await fetch(new URL("/api/progress", handle.url), { headers }).then((response) => response.json());
    expect(progress.issueCount).toBe(1);
    expect(progress.issues[0].id).toBe(issue.id);
    const focused = await fetch(new URL(`/api/issues/${issue.id}/focus`, handle.url), { method: "POST", headers }).then((response) => response.json());
    expect(focused.currentIssueId).toBe(issue.id);
    const governance = await fetch(new URL("/api/governance", handle.url), { headers }).then((response) => response.json());
    expect(governance.currentIssueId).toBe(issue.id);
    expect(governance.executionQueue[0].taskId).toBe("T1");

    const detail = await fetch(new URL(`/api/issues/${issue.id}/tasks/T1`, handle.url), { headers }).then((response) => response.json());
    expect(detail.task.id).toBe("T1");
    expect(detail.timeline.some((event: { action: string }) => event.action === "issue_created")).toBe(true);

    const verified = await fetch(new URL(`/api/issues/${issue.id}/tasks/T1/verify`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ confirmAcceptance: true, reviewer: "test-human" }),
    }).then((response) => response.json());
    expect(verified.error).toBeUndefined();
    const verifiedTask = getIssue(root, issue.id).tasks[0];
    expect(verifiedTask?.status).toBe("verified");
    expect(verifiedTask?.verification?.acceptanceResults[0]).toMatchObject({
      criterion: "Visible",
      ok: true,
      outcome: "passed",
      source: "human_review",
    });
    expect(verifiedTask?.verification?.checkResults?.some((entry: { id?: string; ok?: boolean }) => entry.id === 'focused' && entry.ok)).toBe(true);
    expect(existsSync(join(root, '.ai', 'harness', 'checks'))).toBe(false);
    const accepted = await fetch(new URL(`/api/issues/${issue.id}/tasks/T1/accept`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json());
    expect(accepted.error).toBeTruthy();
    expect(accepted.error).toContain("complete delivery receipt");
    expect(getIssue(root, issue.id).tasks[0]?.status).toBe("verified");

    const configured = await fetch(new URL("/api/github/plugin", handle.url), {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, repository: "owner/repo", syncMode: "checkpoint" }),
    }).then((response) => response.json());
    expect(configured.enabled).toBe(true);
    expect(configured.syncMode).toBe("checkpoint");

    const exported = await fetch(new URL("/api/worklog/export", handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ outputPath: "tasks/reports/controller-v5.md" }),
    }).then((response) => response.json());
    expect(exported.eventCount).toBeGreaterThan(0);
    expect(existsSync(join(root, exported.path))).toBe(true);
  });

  test("serves generic plugin discovery and durable plugin action submission APIs", async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const headers = { "x-forge-local-token": handle.token };

    const listed = await fetch(new URL("/api/plugins", handle.url), { headers }).then((response) => response.json());
    expect(listed.plugins.map((plugin: { pluginId: string }) => plugin.pluginId)).toContain("github");

    const accepted = await fetch(new URL("/api/plugins/github/actions/configure", handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "plugin-config-local-1",
        arguments: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" },
      }),
    }).then((response) => response.json());
    expect(accepted.accepted).toBe(true);
    expect(accepted.action.confirmation).toBe("authorization");
    expect(accepted.job.type).toBe("plugin-action");
    const snapshot = await fetch(new URL("/api/snapshot", handle.url), { headers }).then((response) => response.json());
    expect(snapshot.assistantPlugins.map((plugin: { pluginId: string }) => plugin.pluginId)).toContain("github");
    expect(Array.isArray(snapshot.mobileIntents.devices)).toBe(true);

    const plugin = await fetch(new URL("/api/plugins/github", handle.url), { headers }).then((response) => response.json());
    expect(plugin.plugin.actions.some((action: { actionId: string; confirmation: string }) => action.actionId === "close_issue" && action.confirmation === "strong_confirmation")).toBe(true);
  });


  test("projects repository schedules without personal-assistant routines", async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const headers = { "x-forge-local-token": handle.token, "content-type": "application/json" };

    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const registeredRepository = loadRepositoryRegistry(controllerHome).repositories.find((repository) => realpathSync(repository.canonicalRoot) === realpathSync(root));
    expect(registeredRepository).toBeTruthy();
    const browserSchedule = createSchedule(controllerHome, {
      requestId: "console-browser-watch",
      repoId: registeredRepository!.repoId,
      name: "Apple ICP · QQ Mail Watcher",
      enabled: true,
      trigger: { type: "cron", cronExpression: "0 20 * * *", timezone: "Asia/Shanghai" },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 60, dailyBudgetMinutes: 30, shadowMode: false },
      action: { operation: "browser_probe", target: "runtime", arguments: { work_id: "WORK-ICP", controller_type: "chatgpt", probe_session_id: "browser-test", wake_on_change: true, keepalive_only: false } },
      stopConditions: ["work_terminal", "external_blocker"],
    });
    saveSchedule(controllerHome, { ...browserSchedule, lastObservationStatus: "baseline", lastObservationAt: "2026-08-14T09:33:59.782Z" });
    saveOccurrence(controllerHome, {
      schemaVersion: 1,
      revision: 0,
      occurrenceId: "OCC-CONSOLE-BROWSER-WATCH",
      scheduleId: browserSchedule.scheduleId,
      repoId: registeredRepository!.repoId,
      windowKey: "console-browser-watch",
      status: "skipped",
      decision: "nothing_to_do",
      triggerContext: { source: "manual" },
      createdAt: "2026-08-14T09:33:59.782Z",
      updatedAt: "2026-08-14T09:33:59.782Z",
      reason: "Browser watcher baseline recorded; no Controller wake was emitted.",
    });
    const consoleWithWatcher = await fetch(new URL("/api/console/automations", handle.url), { headers }).then((response) => response.json());
    const projectedWatcher = consoleWithWatcher.automations.find((automation: { name: string }) => automation.name === "Apple ICP · QQ Mail Watcher");
    expect(projectedWatcher).toMatchObject({ mode: "browser_watch", modeLabel: "网页变更监听", status: "enabled", schedule: "每天 20:00", delivery: "变化时唤醒 ChatGPT", live: true, targetLabel: "已绑定浏览器会话", boundWorkId: "WORK-ICP", observationStatus: "baseline", lastResult: "已建立基线" });
    expect(projectedWatcher.history).toHaveLength(1);
    expect(projectedWatcher.history[0]).toMatchObject({ result: "无变化", trigger: "手动", tone: "gray", reason: "已建立观察基线；没有唤醒 ChatGPT。" });

    const failedWorkflow = createSchedule(controllerHome, {
      requestId: "console-hourly-workflow-failed",
      repoId: registeredRepository!.repoId,
      name: "Forge 新问题自动修复 Workflow",
      enabled: true,
      trigger: { type: "cron", cronExpression: "0 * * * *", timezone: "Asia/Shanghai" },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 5, dailyBudgetMinutes: 240, shadowMode: false },
      action: { operation: "external_controller_wake", target: "runtime", arguments: { work_id: "WORK-ISSUE-REPAIR", controller_type: "chatgpt" } },
      stopConditions: [],
    });
    saveSchedule(controllerHome, { ...failedWorkflow, enabled: false, consecutiveFailures: 3, pausedReason: "Maximum consecutive failures reached." });
    const completedWorkflow = createSchedule(controllerHome, {
      requestId: "console-completed-workflow",
      repoId: registeredRepository!.repoId,
      name: "有限任务",
      enabled: false,
      trigger: { type: "interval", everyMinutes: 180 },
      policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 10, dailyBudgetMinutes: 240, shadowMode: false },
      action: { operation: "external_controller_wake", target: "runtime", arguments: { work_id: "WORK-DONE", controller_type: "chatgpt" } },
      stopConditions: ["work_terminal"],
    });
    saveSchedule(controllerHome, { ...completedWorkflow, pausedReason: "Work WORK-DONE is terminal (completed)." });
    const consoleStateSemantics = await fetch(new URL("/api/console/automations", handle.url), { headers }).then((response) => response.json());
    const projectedFailedWorkflow = consoleStateSemantics.automations.find((automation: { name: string }) => automation.name === "Forge 新问题自动修复 Workflow");
    expect(projectedFailedWorkflow).toMatchObject({ status: "attention", schedule: "每小时整点", attentionMessage: "连续执行失败达到上限，任务已自动暂停。", pausedReason: "连续执行失败达到上限，已自动暂停。修复问题后可以恢复任务。", actions: ["resume"] });
    const projectedCompletedWorkflow = consoleStateSemantics.automations.find((automation: { name: string }) => automation.name === "有限任务");
    expect(projectedCompletedWorkflow).toMatchObject({ status: "completed", pausedReason: "关联工作已经完成，这个自动任务不会再触发。", actions: [] });
    expect(consoleStateSemantics.summary.completed).toBeGreaterThanOrEqual(1);

    for (const path of ["/api/assistant/intent", "/api/assistant/routines", "/api/assistant/readiness", "/api/assistant/maintenance/cleanup-preview"]) {
      const response = await fetch(new URL(path, handle.url), { headers });
      expect(response.status).toBe(404);
    }
    const snapshot = await fetch(new URL("/api/snapshot", handle.url), { headers }).then((response) => response.json());
    expect(snapshot.assistant).toBeUndefined();
  });


  test("serves signed mobile Shortcut intents with device scopes, replay protection, and approval polling", async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const localHeaders = { "x-forge-local-token": handle.token, "content-type": "application/json" };

    const created = await fetch(new URL("/api/mobile/devices", handle.url), {
      method: "POST",
      headers: localHeaders,
      body: JSON.stringify({
        name: "Greyson iPhone",
        scopes: ["plugins:read", "jobs:read", "plugin:gmail:configure", "plugin:gmail:send_message"],
        rateLimitPerMinute: 10,
      }),
    }).then((response) => response.json());
    expect(created.device.deviceId).toBe("greyson-iphone");
    expect(created.token).toStartWith("rhmi_");
    expect(readFileSync(join(root, ".forge/mobile-intents.json"), "utf-8")).not.toContain(created.token);

    function signedHeaders(body: string, nonce: string) {
      const timestamp = new Date().toISOString();
      const signature = createHmac("sha256", created.token).update(`${timestamp}.${nonce}.${body}`).digest("hex");
      return {
        "content-type": "application/json",
        authorization: `Bearer ${created.token}`,
        "x-forge-device-id": created.device.deviceId,
        "x-forge-timestamp": timestamp,
        "x-forge-nonce": nonce,
        "x-forge-signature": signature,
      };
    }

    const listBody = JSON.stringify({ intent: "list_plugins" });
    const listed = await fetch(new URL("/mobile/intent", handle.url), {
      method: "POST",
      headers: signedHeaders(listBody, "nonce-list-0001"),
      body: listBody,
    }).then((response) => response.json());
    expect(listed.accepted).toBe(true);
    expect(listed.signatureVerified).toBe(true);
    expect(listed.plugins.map((plugin: { pluginId: string }) => plugin.pluginId)).toContain("gmail");

    const invalidSignatureHeaders = signedHeaders(listBody, "nonce-bad-signature-0001");
    invalidSignatureHeaders["x-forge-signature"] = "bad-signature";
    const invalidSignature = await fetch(new URL("/mobile/intent", handle.url), {
      method: "POST",
      headers: invalidSignatureHeaders,
      body: listBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(invalidSignature.status).toBe(401);
    expect(invalidSignature.body.error).toContain("MOBILE_INTENT_SIGNATURE_INVALID");

    const replay = await fetch(new URL("/mobile/intent", handle.url), {
      method: "POST",
      headers: signedHeaders(listBody, "nonce-list-0001"),
      body: listBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(replay.status).toBe(401);
    expect(replay.body.error).toContain("MOBILE_INTENT_REPLAY_DETECTED");

    const configureBody = JSON.stringify({
      intent: "plugin_action",
      pluginId: "gmail",
      actionId: "configure",
      requestId: "mobile-gmail-config",
      confirmAuthorization: true,
      arguments: { enabled: true, provider: "mock", account_email: "assistant@example.com" },
    });
    const configured = await fetch(new URL("/mobile/intent", handle.url), {
      method: "POST",
      headers: signedHeaders(configureBody, "nonce-config-0001"),
      body: configureBody,
    }).then((response) => response.json());
    expect(configured.accepted).toBe(true);
    expect(configured.job.type).toBe("plugin-action");
    expect(configured.job.origin.surface).toBe("mobile-intent");

    const missingApprovalBody = JSON.stringify({
      intent: "plugin_action",
      pluginId: "gmail",
      actionId: "send_message",
      requestId: "mobile-send-needs-approval",
      arguments: { to: ["recipient@example.com"], subject: "Hi", body_text: "Hello" },
    });
    const needsApproval = await fetch(new URL("/mobile/intent", handle.url), {
      method: "POST",
      headers: signedHeaders(missingApprovalBody, "nonce-send-0001"),
      body: missingApprovalBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(needsApproval.status).toBe(409);
    expect(needsApproval.body.approvalRequired).toBe(true);
    expect(needsApproval.body.action.requiredConfirmationText).toBe("send-gmail-message");

    const pollBody = JSON.stringify({ intent: "poll_job", jobId: configured.job.jobId });
    const polled = await fetch(new URL("/mobile/intent", handle.url), {
      method: "POST",
      headers: signedHeaders(pollBody, "nonce-poll-0001"),
      body: pollBody,
    }).then((response) => response.json());
    expect(polled.job.jobId).toBe(configured.job.jobId);

    const revoked = await fetch(new URL(`/api/mobile/devices/${created.device.deviceId}/revoke`, handle.url), {
      method: "POST",
      headers: localHeaders,
      body: "{}",
    }).then((response) => response.json());
    expect(revoked.device.revokedAt).toBeTruthy();

    const afterRevoke = await fetch(new URL("/mobile/intent", handle.url), {
      method: "POST",
      headers: signedHeaders(listBody, "nonce-after-revoke-0001"),
      body: listBody,
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.error).toContain("MOBILE_INTENT_DEVICE_REVOKED");
  });


  test("shows direct edits as first-class file changes and completes them through the local API", async () => {
    const root = repo();
    const session = beginEditSession(root, {
      purpose: "Update local example",
      allowedPaths: ["src/**"],
      maxFiles: 1,
      maxChangedLines: 5,
    });
    const current = readFileSync(join(root, "src/example.ts"), "utf-8");
    const hash = new Bun.CryptoHasher("sha256").update(current).digest("hex");
    applyEditOperations(root, getMcpPolicy("controller", { repoRoot: root }), session.sessionId, [{
      type: "replace",
      path: "src/example.ts",
      expectedSha256: hash,
      replacements: [{ oldText: "value = 1", newText: "value = 4" }],
    }]);
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const headers = { "x-forge-local-token": handle.token };
    const snapshot = await fetch(new URL("/api/snapshot", handle.url), { headers }).then((response) => response.json());
    expect(snapshot.editSessions[0]).toMatchObject({ sessionId: session.sessionId, status: "dirty", changedFiles: 1 });
    const diff = await fetch(new URL(`/api/edit-sessions/${session.sessionId}/diff`, handle.url), { headers }).then((response) => response.json());
    expect(diff.patch).toContain("+export const value = 4;");
    const verified = await fetch(new URL(`/api/edit-sessions/${session.sessionId}/verify`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "local-test" }),
    }).then((response) => response.json());
    expect(verified.accepted).toBe(true);
    expect(verified.status).toBe("succeeded");
    expect(verified.sessionId).toBe(session.sessionId);
    // Direct verification no longer creates a Local Bridge Job.
    const finalized = await fetch(new URL(`/api/edit-sessions/${session.sessionId}/finalize`, handle.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ reviewer: "local-test" }),
    }).then((response) => response.json());
    expect(finalized.status).toBe("finalized");
    const dashboard = await fetch(handle.url).then((response) => response.text());
    for (const text of ["Forge · Utility Console", "/console-assets/app.css", "/console-assets/app.js"]) expect(dashboard).toContain(text); expect(dashboard).not.toContain("你想让它完成什么");
    const uiScript = await fetch(new URL("/console-assets/app.js", handle.url)).then((response) => response.text());
    for (const text of ["Automations", "Capabilities", "/api/console/requirements", "/api/console/automations", "/api/repositories/register"]) expect(uiScript).toContain(text);
  });
  test("preserves executable mode when an Edit Session replaces a shebang file", () => {
    const root = repo();
    const executablePath = join(root, "src/executable.ts");
    writeFileSync(executablePath, "#!/usr/bin/env bun\nexport const value = 1;\n");
    chmodSync(executablePath, 0o755);
    const session = beginEditSession(root, {
      purpose: "Update executable source",
      allowedPaths: ["src/**"],
      maxFiles: 1,
      maxChangedLines: 5,
    });
    const current = readFileSync(executablePath, "utf8");
    const hash = new Bun.CryptoHasher("sha256").update(current).digest("hex");
    applyEditOperations(root, getMcpPolicy("controller", { repoRoot: root }), session.sessionId, [{
      type: "replace",
      path: "src/executable.ts",
      expectedSha256: hash,
      replacements: [{ oldText: "value = 1", newText: "value = 2" }],
    }]);
    expect(lstatSync(executablePath).mode & 0o111).toBe(0o111);
    expect(readFileSync(executablePath, "utf8")).toContain("value = 2");
    const patch = readFileSync(join(root, ".ai/harness/edit-sessions", session.sessionId, "changes.patch"), "utf8");
    expect(patch).not.toContain("old mode 100755");
    expect(patch).not.toContain("new mode 100644");
  });

  test("registers and soft-removes repositories through the local-bridge API", async () => {
    const root = repo();
    const otherRoot = mkdtempSync(join(tmpdir(), "forge-local-bridge-other-"));
    roots.push(otherRoot);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: otherRoot }).status).toBe(0);
    writeFileSync(join(otherRoot, "README.md"), "# other\n");

    const handle = await startLocalBridgeServer({
      repoRoot: root,
      port: 0,
      openBrowser: false,
    });
    servers.push(handle);
    const headers = { "x-forge-local-token": handle.token, "content-type": "application/json" };

    const registered = await fetch(new URL("/api/repositories/register", handle.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ path: otherRoot, displayName: "Other Fixture" }),
    }).then(async (response) => {
      expect(response.status).toBe(201);
      return response.json();
    });
    expect(registered.repository.displayName).toBe("Other Fixture");
    expect(typeof registered.repository.repoId).toBe("string");
    expect(registered.repository.removedAt).toBeUndefined();

    const listedBefore = await fetch(new URL("/api/repositories", handle.url), { headers }).then((response) => response.json());
    expect(listedBefore.repositories.some((entry: { id: string }) => entry.id === registered.repository.repoId)).toBe(true);

    const removed = await fetch(new URL(`/api/repositories/${encodeURIComponent(registered.repository.repoId)}/remove`, handle.url), {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    }).then(async (response) => {
      expect(response.status).toBe(200);
      return response.json();
    });
    expect(removed.repository.repoId).toBe(registered.repository.repoId);
    expect(typeof removed.repository.removedAt).toBe("string");
    expect(removed.repository.enabled).toBe(false);
    expect(removed.summary).toContain("已删除仓库注册");
    expect(Array.isArray(removed.repositories)).toBe(true);
    expect(removed.repositories.some((entry: { id: string }) => entry.id === registered.repository.repoId)).toBe(false);

    const listedAfter = await fetch(new URL("/api/repositories", handle.url), { headers }).then((response) => response.json());
    expect(listedAfter.repositories.some((entry: { id: string }) => entry.id === registered.repository.repoId)).toBe(false);

    const missing = await fetch(new URL("/api/repositories/does-not-exist/remove", handle.url), {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const missingBody = await missing.json();
    expect(String(missingBody.error)).toContain("repository not found");
  });

  test("serves a hardened localhost visual control surface", async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({
      repoRoot: root,
      port: 0,
      openBrowser: false,
    });
    servers.push(handle);

    const health = await fetch(new URL("/health", handle.url)).then(
      (response) => response.json(),
    );
    expect(health.status).toBe("ok");
    expect(health.localOnly).toBe(true);
    expect(health.repoRoot).toBeUndefined();
    expect(health.timeoutPolicy).toBeUndefined();
    expect(health.features).toBeUndefined();

    const denied = await fetch(new URL("/api/snapshot", handle.url));
    expect(denied.status).toBe(403);
    const deniedQueryToken = await fetch(
      new URL(`/api/snapshot?token=${encodeURIComponent(handle.token)}`, handle.url),
    );
    expect(deniedQueryToken.status).toBe(403);

    const rejectedOrigin = await fetch(new URL("/api/snapshot", handle.url), {
      headers: {
        origin: "https://malicious.example",
        "x-forge-local-token": handle.token,
      },
    });
    expect(rejectedOrigin.status).toBe(403);

    const snapshot = await fetch(new URL("/api/snapshot", handle.url), {
      headers: { "x-forge-local-token": handle.token },
    }).then((response) => response.json());
    expect(snapshot.repoRoot).toBe(realpathSync(root));
    expect(snapshot.board).toBeDefined();
    expect(snapshot.toolSurface).toBe(FORGE_TOOL_SURFACE);
    expect(snapshot.timeoutPolicy).toEqual({
      defaultTimeoutMs: 10_000,
      maxTimeoutMs: 43_200_000,
    });

    const dashboardResponse = await fetch(handle.url);
    expect(dashboardResponse.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(dashboardResponse.headers.get("pragma")).toBe("no-cache");
    expect(dashboardResponse.headers.get("expires")).toBe("0");
    expect(dashboardResponse.headers.get("referrer-policy")).toBe("no-referrer");
    const setCookie = dashboardResponse.headers.get("set-cookie");
    expect(setCookie).toContain("Path=/api");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const cookieSnapshot = await fetch(new URL("/api/snapshot", handle.url), {
      headers: { cookie: cookie as string },
    }).then((response) => response.json());
    expect(cookieSnapshot.repoRoot).toBe(realpathSync(root));

    const dashboard = await dashboardResponse.text();
    expect(dashboard).not.toContain(handle.token);
    expect(dashboard).not.toContain("?token=");
    for (const text of ["Forge · Utility Console", "正在读取 Forge 配置", "/console-assets/app.js"]) expect(dashboard).toContain(text); expect(dashboard).not.toContain("你想让它完成什么");
    const uiScriptResponse = await fetch(new URL("/console-assets/app.js", handle.url)); expect(uiScriptResponse.status).toBe(200); expect(uiScriptResponse.headers.get("content-type")).toContain("javascript"); const uiScript = await uiScriptResponse.text();
    for (const text of ["Overview", "Needs attention", "Workspace", "Work", "Automations", "Capabilities", "Repositories", "System", "/api/console/command-center", "/api/console/requirements", "/api/console/work-portfolio", "/api/console/automations"]) expect(uiScript).toContain(text);
    for (const retiredSurface of ["Settings", "/api/console/automation-settings", "/api/console/provider-config", "/api/console/local-tools", "/api/console/executor-routing"]) expect(uiScript).not.toContain(retiredSurface);
    const auth = { "x-forge-local-token": handle.token };
    for (const path of ["/api/console/automation-settings", "/api/console/provider-config", "/api/console/local-tools", "/api/console/executor-routing"]) {
      expect((await fetch(new URL(path, handle.url), { headers: auth })).status).toBe(404);
    }
    const trackedWork = await fetch(new URL("/api/console/requirements", handle.url), { headers: auth }).then((response) => response.json()); expect(Array.isArray(trackedWork.requirements)).toBe(true); expect(typeof trackedWork.requirementCount).toBe("number");
    const executionWork = await fetch(new URL("/api/console/work", handle.url), { headers: auth }).then((response) => response.json()); expect(Array.isArray(executionWork.items)).toBe(true);
    const workPortfolio = await fetch(new URL("/api/console/work-portfolio", handle.url), { headers: auth }).then((response) => response.json()); expect(Array.isArray(workPortfolio.items)).toBe(true); expect(Array.isArray(workPortfolio.repositories)).toBe(true); expect(typeof workPortfolio.summary.total).toBe("number");
    const automations = await fetch(new URL("/api/console/automations", handle.url), { headers: auth }).then((response) => response.json()); expect(Array.isArray(automations.automations)).toBe(true); expect(typeof automations.summary.total).toBe("number");

    const plugins = await fetch(new URL("/api/console/plugins", handle.url), {
      headers: { "x-forge-local-token": handle.token },
    }).then((response) => response.json());
    expect(Array.isArray(plugins.plugins)).toBe(true);
    expect(plugins.summary).toBeTruthy();
    expect(typeof plugins.summary.total).toBe("number");
    expect(plugins.plugins.some((entry: { id?: string }) => entry.id === "browser")).toBe(true);
    expect(plugins.plugins.some((entry: { id?: string }) => entry.id === "desktop")).toBe(false);
  });
});
