import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync} from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { createServer as createHttpServer } from "http";
import { join } from "path";
import { writeJsonAtomic } from "../../src/runtime/shared/json-files";
import { appendControllerWorklogEvent } from "../../src/cli/controller/worklog";
import { readForgeRuntimeStatus } from "../../src/runtime/control-plane/runtime-status-client";
import { readWorkHandle, writeWorkHandle } from "../../src/runtime/control-plane/execution/work-handle-store";
import { claimControllerSession, getControllerSession, releaseControllerSession } from "../../src/runtime/control-plane/facade/controller-session-store";
import { getWorkContract, updateWorkContract } from "../../src/runtime/control-plane/facade/work-contract-store";
import { createRequirement, updateRequirement } from "../../src/runtime/control-plane/persistence/requirement-store";
import { terminateProcessTree } from "../../src/runtime/shared/process-tree";
import { waitForProcess } from "../../src/runtime/execution/process-runtime/runtime";
import { callExecutionTool } from "../../src/runtime/gateway/mcp/execution-tools";
import { boundedPluginArtifactImageContent, callRuntimeTool, controllerReadiness, controllerReadinessEvidence, repositoryExecutionReadiness } from "../../src/runtime/gateway/mcp/runtime-tools";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import { createMcpToolContext as createMultiRepositoryContext, parseMcpToolset } from "../../src/cli/mcp/multi-repository";
import { callRepositoryTool } from "../../src/cli/mcp/repository-tools";
import { repositoryControllerRoot } from "../../src/cli/repositories/controller-home";
import { addRepositoryCheckout, registerRepository } from "../../src/cli/repositories/registry";
import {
  buildMcpToolDefinitions,
  callMcpTool,
  controllerExpectedToolNames,
  type McpToolContext} from "../../src/cli/mcp/tools";
import {
  FORGE_MCP_SCHEMA_VERSION,
  FORGE_TOOL_SURFACE,
  FORGE_VERSION,
  forgeToolSurfaceFingerprint} from "../../src/cli/controller/runtime-config";
import { writeMcpServiceLocalConfig, writeMcpServiceRuntimeState } from "../../src/cli/mcp/auth";
import { persistControllerAccessMode } from "../../src/cli/mcp/access-mode";
import {
  clearControllerContextPerformanceSnapshotForTest,
  queueControllerContextProjectionRefresh,
  readControllerContextProjection,
  writeControllerContextProjection} from "../../src/runtime/projections/controller-context";
import {
  controllerToolNamesForToolset,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  exposedControllerToolDefinitions,
  STABLE_CONTROLLER_TOOL_NAMES,
} from "../../src/cli/mcp/toolset";

test("keeps source-stable facade schema aligned with the controller workflow contract", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "forge-schema-coherence-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "forge-schema-coherence-home-"));
  try {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
    const repository = registerRepository({ path: repoRoot, controllerHome });
    const ctx = createMultiRepositoryContext({ repo: repoRoot, controllerHome, profile: "controller", toolset: "advanced" });
    const tools = exposedControllerToolDefinitions(ctx);
    expect(tools).toHaveLength(STABLE_CONTROLLER_TOOL_NAMES.length);
    const rhWork = tools.find((tool) => tool.name === "rh_work");
    const rhWorkProperties = rhWork?.inputSchema.properties as Record<string, any>;
    expect(rhWorkProperties.operation.enum).toContain("plan_accept_step");
    const safePatch = tools.find((tool) => tool.name === "repository_safe_patch_apply");
    const safePatchProperties = safePatch?.inputSchema.properties as Record<string, any>;
    expect(safePatchProperties.work_id).toBeDefined();
    expect(repository.repoId).toBeTruthy();
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(controllerHome, { recursive: true, force: true });
  }
});

test("reports checkout dependency readiness before tests and provides a lockfile-safe bootstrap", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "forge-execution-readiness-"));
  try {
    spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { "check:type": "tsc --noEmit" } }));
    writeFileSync(join(repoRoot, "bun.lock"), "");
    const missing = repositoryExecutionReadiness(repoRoot, [], ["package:check:missing"]) as any;
    expect(missing.readyForFocusedExecution).toBe(false);
    expect(missing.dependencies.node).toMatchObject({ applicable: true, ready: false, packageManager: "bun" });
    expect(missing.dependencies.node.bootstrapCommand).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(missing.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NODE_DEPENDENCIES_MISSING" }),
      expect.objectContaining({ code: "CHECK_NOT_REGISTERED", checkId: "package:check:missing" }),
    ]));
    mkdirSync(join(repoRoot, "node_modules"));
    const ready = repositoryExecutionReadiness(repoRoot, [], []) as any;
    expect(ready.readyForFocusedExecution).toBe(true);
    expect(ready.dependencies.node.ready).toBe(true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("returns execution readiness and registered checks in one rh_context search", async () => {
  await withController(async (repoRoot) => {
    const controllerHome = String(process.env.FORGE_CONTROLLER_HOME);
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { "check:type": "echo ok" } }));
    writeFileSync(join(repoRoot, "bun.lock"), "");
    writeFileSync(join(repoRoot, "source.ts"), "export const marker = 1;\n");
    spawnSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    spawnSync("git", ["config", "user.name", "Forge Test"], { cwd: repoRoot, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "forge@example.test"], { cwd: repoRoot, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "fixture"], { cwd: repoRoot, stdio: "ignore" });
    const repository = registerRepository({ path: repoRoot, controllerHome });
    const ctx = createMultiRepositoryContext({ repo: repoRoot, controllerHome, profile: "controller", toolset: "advanced" });
    const response = await callRuntimeTool(ctx, "rh_context", {
      repo_id: repository.repoId,
      operation: "search",
      query: "marker execution readiness",
      structural_context: "off",
      requested_check_ids: ["package:check:type", "package:check:not-registered"],
    });
    const value = JSON.parse(response!.content[0]!.text);
    expect(value.status).toBe("ok");
    expect(value.data.executionReadiness).toMatchObject({
      readyForFocusedExecution: false,
      dependencies: { node: { applicable: true, ready: false, packageManager: "bun" } },
    });
    expect(value.data.executionReadiness.checks.normalized.invalidCheckIds).toContain("package:check:not-registered");
    expect(value.data.executionReadiness.dependencies.node.bootstrapCommand).toEqual(["bun", "install", "--frozen-lockfile"]);
    expect(value.data.registeredChecks.some((check: any) => check.id === "package:check:type")).toBe(true);
  });
});

test("rejects unregistered Plan checks before persistence", async () => {
  await withController(async (repoRoot) => {
    const controllerHome = String(process.env.FORGE_CONTROLLER_HOME);
    const repository = registerRepository({ path: repoRoot, controllerHome });
    const ctx = createMultiRepositoryContext({ repo: repoRoot, controllerHome, profile: "controller", toolset: "advanced" });
    const created = await callRuntimeTool(ctx, "rh_work", {
      repo_id: repository.repoId,
      operation: "plan_create",
      plan_id: "PLAN-invalid-check-preflight",
      scope_key: "invalid-check-preflight",
      source_revision: "fixture-revision",
      objective: "Reject invalid checks before persistence",
      plan_steps: [{
        id: "S1",
        objective: "Should never persist",
        check_ids: ["package:check:not-registered"],
        acceptance_criteria: ["Not persisted"],
      }],
    });
    const createdValue = JSON.parse(created!.content[0]!.text);
    expect(createdValue.status).toBe("failed");
    expect(createdValue.summary).toContain("PLAN_CHECKS_INVALID");
    expect(createdValue.data.planContractCreated).toBe(false);
    const readBack = await callRuntimeTool(ctx, "rh_work", {
      repo_id: repository.repoId,
      operation: "plan_get",
      plan_id: "PLAN-invalid-check-preflight",
    });
    const readValue = JSON.parse(readBack!.content[0]!.text);
    expect(readValue.status).toBe("not_found");
  });
});

test("keeps Core and Advanced on the same bounded default ChatGPT surface", () => {
  expect(parseMcpToolset(undefined, "controller")).toBe("advanced");
  expect(controllerToolNamesForToolset("core")).toEqual(DEFAULT_CONTROLLER_TOOL_NAMES);
  expect(controllerToolNamesForToolset("advanced")).toEqual(DEFAULT_CONTROLLER_TOOL_NAMES);
  expect(DEFAULT_CONTROLLER_TOOL_NAMES.length).toBeLessThan(25);
  expect(DEFAULT_CONTROLLER_TOOL_NAMES.length).toBe(19);

  for (const required of [
    "repository_command_execute",
    "run_check",
    "plugin_action_execute",
    "rh_context",
    "read_repository_file",
    "repository_safe_patch_apply",
    "process_get",
    "process_wait",
    "process_logs",
    "process_cancel",
    "result_read",
    "result_search",
  ]) {
    expect(DEFAULT_CONTROLLER_TOOL_NAMES).toContain(required as never);
  }
  for (const hiddenFromDefault of [
    "repository_git_status",
    "repository_git_diff",
    "repository_git_create_branch",
    "repository_git_switch_branch",
    "repository_git_merge_branch",
    "repository_git_delete_branch",
    "repository_git_commit",
    "repository_git_finish_workflow",
    "git_diff_paths",
    "git_stage_paths",
    "git_commit_paths",
    "begin_edit_session",
    "verify_edit_session",
    "quick_agent_session",
    "runtime_maintenance_status",
    "get_plugin",
    "list_plugins",
    "approval_resolve",
  ]) {
    expect(DEFAULT_CONTROLLER_TOOL_NAMES).not.toContain(hiddenFromDefault as never);
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain(hiddenFromDefault as never);
  }
  for (const compatibilityOnly of [
    "toolchain_plugin_summary",
    "workspace_auth_login_prepare",
    "assistant_readiness",
  ]) {
    expect(STABLE_CONTROLLER_TOOL_NAMES).not.toContain(compatibilityOnly as never);
  }
});

async function jsonTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await callMcpTool(ctx, name, args);
  return { raw: result, value: JSON.parse(result.content[0].text) };
}

async function executionJson(
  ctx: ReturnType<typeof createMultiRepositoryContext>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await callExecutionTool(ctx, name, args);
  if (!result) throw new Error(`execution tool not found: ${name}`);
  return JSON.parse(result.content[0].text);
}

async function verifyTaskUntilSettled(
  ctx: McpToolContext,
  args: Record<string, unknown>,
  options: { attempts?: number; followDeferred?: boolean } = {},
) {
  const attempts = options.attempts ?? 120;
  let currentArgs = args;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await jsonTool(ctx, "verify_task", currentArgs);
    if (result.value.status === "verification_running") {
      await Bun.sleep(25);
      continue;
    }
    if (options.followDeferred
      && result.value.status === "verification_deferred"
      && typeof result.value.retryRequestId === "string") {
      currentArgs = { ...currentArgs, request_id: result.value.retryRequestId };
      await Bun.sleep(50);
      continue;
    }
    return result;
  }
  throw new Error(`verify_task did not settle after ${attempts} attempts`);
}

function responseSize(result: { raw: { content: Array<{ text: string }> } }): number {
  return result.raw.content[0]?.text.length ?? 0;
}

async function waitForRun(
  ctx: McpToolContext,
  runId: string,
  predicate: (run: any) => boolean,
  attempts = 120,
  delayMs = 25,
) {
  let run = (await jsonTool(ctx, "get_task_run", { run_id: runId })).value;
  for (let attempt = 0; attempt < attempts && !predicate(run); attempt += 1) {
    await Bun.sleep(delayMs);
    run = (await jsonTool(ctx, "get_task_run", { run_id: runId })).value;
  }
  return run;
}

function writeFakeCodexExecutable(path: string, body: string): void {
  writeFileSync(
    path,
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
  chmodSync(path, 0o755);
}

async function withController<T>(
  fn: (repoRoot: string, ctx: McpToolContext) => Promise<T>,
): Promise<T> {
  const repoRoot = mkdtempSync(join(tmpdir(), "forge-controller-"));
  const controllerHome = mkdtempSync(join(tmpdir(), "forge-controller-home-"));
  const previousControllerHome = process.env.FORGE_CONTROLLER_HOME;
  try {
    process.env.FORGE_CONTROLLER_HOME = controllerHome;
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(join(repoRoot, "tasks"), { recursive: true });
    mkdirSync(join(repoRoot, ".ai/harness"), { recursive: true });
    mkdirSync(join(repoRoot, ".forge"), { recursive: true });
    writeFileSync(join(repoRoot, ".forge/checks.json"), JSON.stringify({
      version: 1,
      checks: Object.fromEntries(["focused", "manual-review", "typecheck"].map((id) => [id, {
        description: `Test check ${id}`,
        command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 300)"],
        timeoutMs: 10_000}]))}));
    writeFileSync(
      join(repoRoot, "src/example.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(join(repoRoot, "tasks/current.md"), "# Current\n");
    spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
    return await fn(repoRoot, {
      repoRoot,
      policy: getMcpPolicy("controller", { repoRoot })});
  } finally {
    if (previousControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
    else process.env.FORGE_CONTROLLER_HOME = previousControllerHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(controllerHome, { recursive: true, force: true });
  }
}

function writeStoredPluginManifest(
  controllerHome: string,
  repoId: string,
  pluginId: string,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  writeJsonAtomic(join(repositoryControllerRoot(controllerHome, repoId), "plugins", "manifests", `${pluginId}.json`), {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: 42,
    pluginId,
    provider: `stored-${pluginId}`,
    displayName: `Stored ${pluginId}`,
    pluginVersion: "1.0.0-test",
    authority: {
      strategy: "derived",
      duplicateStateAllowed: false,
      sourceOfTruth: ["test"]},
    enabled: true,
    lifecycle: {
      state: "enabled"},
    health: {
      state: "ready",
      checkedAt: new Date().toISOString(),
      ready: true,
      probed: true,
      errors: [],
      warnings: []},
    permissions: [],
    capabilities: [],
    actions: [],
    updatedAt: new Date().toISOString(),
    ...overrides});
}

test("uses the configured Forge service runtime for aggregate Local Bridge health", async () => {
  await withController(async (repoRoot, ctx) => {
    const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
    const repository = registerRepository({ path: repoRoot, controllerHome });
    const generation = "runtime-forge-service";
    const server = createHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        status: "ok",
        localOnly: true,
        mode: "embedded",
        toolSurface: FORGE_TOOL_SURFACE,
        schemaVersion: FORGE_MCP_SCHEMA_VERSION,
        version: FORGE_VERSION,
        repoRoot: repository.canonicalRoot,
        generation}));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("local bridge test server did not bind");
      const now = new Date().toISOString();
      writeMcpServiceRuntimeState(controllerHome, {
        version: 1,
        repo: repoRoot,
        startedAt: now,
        updatedAt: now,
        status: "running",
        tunnelMode: "none",
        generation,
        server: {
          endpoint: "http://127.0.0.1:8795/mcp",
          generation,
          running: true,
          healthy: true,
          restartCount: 0,
          profile: "controller",
          toolSurface: FORGE_TOOL_SURFACE,
          schemaVersion: FORGE_MCP_SCHEMA_VERSION,
          forgeVersion: FORGE_VERSION,
          toolset: "advanced"},
        localController: {
          endpoint: `http://127.0.0.1:${address.port}/`,
          running: true,
          mode: "embedded",
          pid: process.pid,
          generation},
        tunnel: { running: false, healthy: true, restartCount: 0 }});

      const multi = createMultiRepositoryContext({
        repo: repoRoot,
        profile: "controller",
        toolset: "advanced",
        controllerHome});
      const evidence = await controllerReadinessEvidence(multi, repository);
      expect(evidence.health.components.localBridge).toMatchObject({
        state: "healthy",
        ready: true});
      expect(evidence.health.components.localBridge.activeBlockers).toEqual([]);

      const readiness = await controllerReadiness(multi, repository);
      expect(Object.keys(readiness).sort()).toEqual(["diagnostics", "observedAt", "ready", "reasonCodes"]);
      expect(readiness).not.toHaveProperty("state");
      expect(readiness).not.toHaveProperty("daemon");
      expect(readiness).not.toHaveProperty("durableScheduler");
      expect(readiness).not.toHaveProperty("workerLoop");
      expect(readiness).not.toHaveProperty("localBridge");

      const toolResult = await callRuntimeTool(multi, "controller_ready", {});
      expect(toolResult).toBeDefined();
      expect(toolResult?.isError).not.toBe(true);
      const toolPayload = JSON.parse(toolResult!.content[0].text);
      expect(Object.keys(toolPayload).sort()).toEqual(["diagnostics", "observedAt", "ready", "reasonCodes"]);
      expect(toolPayload).not.toHaveProperty("state");
      expect(toolPayload).not.toHaveProperty("stableSupervisor");
      expect(toolPayload).not.toHaveProperty("stableIngress");
      expect(toolPayload).not.toHaveProperty("activeSlot");
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  });
});

test("returns a structured retirement response for Kernel Agent dispatch", async () => {
  await withController(async (repoRoot, baseCtx) => {
    const ctx = {
      ...baseCtx,
      policy: getMcpPolicy("controller", {
        repoRoot,
        devAgentRunner: true,
        allowedAgents: ["codex"],
        runnerTimeoutMs: 10_000})};
    const created = await jsonTool(ctx, "create_issue", {
      title: "Compact MCP payloads",
      summary: "Keep default controller responses small.",
      tasks: [{
        title: "Execute",
        objective: "Run and verify one compact Task.",
        allowed_paths: ["src/**"],
        checks: ["focused"],
        acceptance_criteria: ["The compact flow succeeds."],
        risk: "high",
        agent: "codex"}]});
    const dispatched = await jsonTool(ctx, "dispatch_task", {
      issue_id: created.value.id,
      task_id: "T1",
      isolate: false,
      timeout_ms: 10_000});
    expect(Boolean((dispatched as { raw?: { isError?: boolean } }).raw?.isError) || Boolean(dispatched.value?.error)).toBe(true);
    const code = dispatched.value?.error?.code ?? dispatched.value?.code;
    expect(String(code)).toMatch(/AGENT_RUN_(DEPRECATED|RETIRED)/);
    expect(JSON.stringify(dispatched.value)).toMatch(/WorkContract|Thin Launcher|external SuperController/i);
    expect(responseSize(dispatched)).toBeLessThan(4_000);
  });
});

function issueFilePath(
  repoRoot: string,
  issue: { id: string; slug: string },
) {
  return join(repoRoot, "tasks/issues", `${issue.id}-${issue.slug}.issue.json`);
}

function seedLargeControllerIssue(
  repoRoot: string,
  issue: { id: string; slug: string; tasks: Array<{ id: string }> },
) {
  const path = issueFilePath(repoRoot, issue);
  const stored = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
  const task = stored.tasks[0];
  task.notes = Array.from({ length: 24 }, (_, index) =>
    `note-${index}: ${"controller-summary-payload ".repeat(24)}`,
  );
  task.runIds = Array.from({ length: 18 }, (_, index) => `RUN-SUMMARY-${index + 1}`);
  task.verification = {
    runId: task.runIds.at(-1),
    checkResults: Array.from({ length: 4 }, (_, index) => ({
      checkId: `check-${index + 1}`,
      ok: true,
      summary: `summary-${index + 1}`})),
    commandEvidence: Array.from({ length: 6 }, (_, index) => ({
      command: ["bun", "test", `suite-${index + 1}`],
      ok: true,
      stdout: "stdout ".repeat(200),
      stderr: "stderr ".repeat(120)})),
    acceptanceResults: Array.from({ length: 5 }, (_, index) => ({
      criterion: `criterion-${index + 1}`,
      ok: true,
      evidence: "evidence ".repeat(80)})),
    reviewer: "summary-fixture",
    verifiedAt: "2026-06-26T12:00:00.000Z"};
  writeJsonAtomic(path, stored);

  for (let index = 0; index < task.runIds.length; index += 1) {
    const runId = task.runIds[index];
    writeJsonAtomic(join(repoRoot, ".ai/harness/jobs", runId, "meta.json"), {
      schemaVersion: 3,
      runId,
      issueId: stored.id,
      taskId: task.id,
      agent: "codex",
      provider: "local",
      executionMode: "worktree",
      status: index === task.runIds.length - 1 ? "succeeded" : "failed",
      repoRoot,
      worktree: join(repoRoot, ".ai/harness/worktrees", runId),
      branch: `codex/${runId.toLowerCase()}`,
      baseRevision: "abc1234",
      promptPath: join(repoRoot, ".ai/harness/jobs", runId, "prompt.md"),
      stdoutPath: join(repoRoot, ".ai/harness/jobs", runId, "stdout.log"),
      stderrPath: join(repoRoot, ".ai/harness/jobs", runId, "stderr.log"),
      resultPath: join(repoRoot, ".ai/harness/jobs", runId, "result.json"),
      eventsPath: join(repoRoot, ".ai/harness/jobs", runId, "events.jsonl"),
      error: index === task.runIds.length - 1 ? undefined : "failure ".repeat(80),
      progress: {
        phase: index === task.runIds.length - 1 ? "completed" : "failed",
        currentActivity: `run-${index + 1}`,
        lastActivityAt: `2026-06-26T12:${String(index).padStart(2, "0")}:00.000Z`,
        activityCount: 12 + index},
      createdAt: `2026-06-26T11:${String(index).padStart(2, "0")}:00.000Z`,
      startedAt: `2026-06-26T11:${String(index).padStart(2, "0")}:10.000Z`,
      finishedAt: `2026-06-26T11:${String(index).padStart(2, "0")}:50.000Z`});
  }

  for (let index = 0; index < 140; index += 1) {
    appendControllerWorklogEvent(repoRoot, {
      at: `2026-06-26T13:${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}.000Z`,
      category: "run",
      action: "run_activity",
      summary: `timeline-${index + 1}: ${"history ".repeat(20)}`,
      issueId: stored.id,
      taskId: task.id,
      runId: task.runIds[index % task.runIds.length],
      details: { message: "detail ".repeat(120) }});
  }
}

describe("MCP controller profile", () => {
  test("exposes controller tools and preserves immutable secret denies", async () => {
    await withController(async (repoRoot, ctx) => {
      mkdirSync(join(repoRoot, ".forge"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".forge/mcp.policy.json"),
        JSON.stringify({ profiles: { controller: { denyGlobs: [] } } }),
      );
      const overridden = getMcpPolicy("controller", { repoRoot });
      const names = buildMcpToolDefinitions(overridden).map(
        (tool) => tool.name,
      );
      expect(names).toContain("controller_capabilities");
      expect(names).toContain("local_bridge_status");
      expect(names).toContain("controller_context");
      expect(names).toContain("submit_local_job");
      expect(names).not.toContain("approve_local_job");
      expect(names).toContain("create_edit_savepoint");
      expect(names).toContain("project_snapshot");
      expect(names).toContain("assess_work_request");
      expect(names).toContain("create_issue");
      expect(names).toContain("dispatch_task");
      expect(names).toContain("apply_patch");
      expect(names).toContain("list_edit_sessions");
      expect(names).toContain("get_edit_session_diff");
      expect(names).toContain("verify_edit_session");
      expect(names).toContain("finalize_edit_session");
      expect(names).toContain("finish_edit_session");
      expect(names).toContain("run_check");
      expect(names).toContain("publish_issue_to_github");
      expect(names).toContain("launch_issue");
      expect(names).toContain("verify_task");
      expect(names).toContain("get_project_progress");
      expect(names).toContain("get_project_governance");
      expect(names).toContain("reconcile_project_governance");
      expect(names).toContain("get_project_state");
      expect(names).toContain("set_current_issue");
      expect(names).toContain("archive_issue");
      expect(names).toContain("restore_issue");
      expect(names).toContain("get_task_progress_detail");
      expect(names).toContain("get_worklog_timeline");
      expect(names).toContain("export_worklog");
      expect(names).toContain("get_github_plugin_status");
      expect(names).toContain("configure_github_plugin");
      expect(controllerExpectedToolNames(ctx.policy)).toContain("repository_command_execute");
      const capabilities = await jsonTool(
        { ...ctx, policy: overridden },
        "controller_capabilities",
      );
      expect(capabilities.value.toolSurface).toBe(
        "forge",
      );
      expect(capabilities.value.expectedTools).toContain("repository_command_execute");
      expect(capabilities.value.expectedTools).toContain("rh_context");
      expect(capabilities.value.expectedTools).not.toContain("search_repository");
      expect(capabilities.value.expectedTools).toContain("read_repository_file");
      expect(capabilities.value.expectedTools).toContain("result_read");
      expect(capabilities.value.expectedTools).not.toContain("approval_resolve");
      for (const hiddenFromDefault of [
        "launch_issue",
        "work_submit",
        "quick_agent_session",
        "controller_context",
        "controller_context_pack",
        "repository_command_preview",
        "verify_edit_session",
        "finish_edit_session",
      ]) {
        expect(capabilities.value.expectedTools).not.toContain(hiddenFromDefault);
      }
      expect(capabilities.value.expectedTools).toEqual(
        controllerExpectedToolNames(overridden),
      );
      expect(capabilities.value.toolSurfaceFingerprint).toBe(
        forgeToolSurfaceFingerprint(controllerExpectedToolNames(overridden)),
      );
      expect(capabilities.value.capabilities.directEditFirstRouting).toBe(true);
      expect(capabilities.value.capabilities.controllerContextAggregation).toBe(true);
      expect(capabilities.value.capabilities.persistedCheckReuse).toBe(true);
      const source = await jsonTool(
        { ...ctx, policy: overridden },
        "read_repository_file",
        { path: "src/example.ts" },
      );
      expect(source.value.content).toContain("value = 1");
      const denied = await jsonTool(
        { ...ctx, policy: overridden },
        "read_repository_file",
        { path: ".env" },
      );
      expect(denied.value.error.code).toBe("TOOL_FAILED");
      expect(denied.raw.isError).toBe(true);
    });
  });

  test("exposes V5 governance, focus, evidence, timeline, export, and optional GitHub plugin tools", async () => {
    await withController(async (repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "V5 execution tools",
        kind: "feature",
        summary: "Exercise the progress and worklog surface.",
        acceptance_criteria: ["The Task is visible."],
        tasks: [{
          title: "Inspect progress",
          objective: "Read derived Task progress.",
          allowed_paths: ["src/**"],
          checks: ["manual-review"],
          acceptance_criteria: ["Visible"]}]});
      const progress = await jsonTool(ctx, "get_project_progress");
      expect(progress.value.issueCount).toBe(1);
      expect(progress.value.issues[0].id).toBe(created.value.id);
      const focus = await jsonTool(ctx, "set_current_issue", { issue_id: created.value.id });
      expect(focus.value.currentIssueId).toBe(created.value.id);
      const governance = await jsonTool(ctx, "get_project_governance");
      expect(governance.value.currentIssueId).toBe(created.value.id);
      expect(governance.value.executionQueue[0].taskId).toBe("T1");

      const detail = await jsonTool(ctx, "get_task_progress_detail", {
        issue_id: created.value.id,
        task_id: "T1"});
      expect(detail.value.progress.taskId).toBe("T1");
      expect(detail.value.timeline.some((event: { action: string }) => event.action === "task_created")).toBe(true);

      const timeline = await jsonTool(ctx, "get_worklog_timeline", { issue_id: created.value.id });
      expect(timeline.value.events.length).toBeGreaterThan(0);
      const exported = await jsonTool(ctx, "export_worklog", {
        output_path: "tasks/reports/mcp-v5-worklog.md",
        issue_id: created.value.id});
      expect(existsSync(join(repoRoot, exported.value.path))).toBe(true);

      const config = await jsonTool(ctx, "configure_github_plugin", {
        enabled: false,
        repository: "owner/repository",
        sync_mode: "checkpoint"});
      expect(config.value.syncMode).toBe("checkpoint");
      const status = await jsonTool(ctx, "get_github_plugin_status");
      expect(status.value.ready).toBe(false);
      expect(status.value.config.repository).toBe("owner/repository");
    });
  });

  test("lists plugin manifests and routes typed plugin actions through durable execution", async () => {
    await withController(async (repoRoot) => {
      const controllerHome = String(process.env.FORGE_CONTROLLER_HOME);
      const runtimeCtx = createMultiRepositoryContext({
        repo: repoRoot,
        controllerHome,
        profile: "controller",
        toolset: "full"});
      const listed = await callRuntimeTool(runtimeCtx, "list_plugins", {});
      const listValue = JSON.parse(listed!.content[0].text);
      const pluginIds = listValue.plugins.map((plugin: { pluginId: string }) => plugin.pluginId);
      expect(pluginIds).toEqual(expect.arrayContaining([
        "browser",
        "github",
        "gmail",
        "google_calendar",
        "google_tasks",
        "local_system",
      ]));
      expect(pluginIds).not.toContain("desktop");

      const accepted = await callRuntimeTool(runtimeCtx, "plugin_action_execute", {
        plugin_id: "github",
        action_id: "configure",
        request_id: "plugin-config-runtime-1",
        arguments: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" }});
      const acceptedValue = JSON.parse(accepted!.content[0].text);
      expect(acceptedValue.accepted).toBe(true);
      expect(acceptedValue.direct).toBe(true);
      expect(acceptedValue.durable).toBe(false);
      expect(acceptedValue.action.confirmation).toBe("authorization");
      expect(acceptedValue.receiptId || acceptedValue.result).toBeTruthy();
      expect(acceptedValue.plugin.actions).toBeUndefined();
      expect(acceptedValue.plugin.permissions).toBeUndefined();
      expect(acceptedValue.plugin.capabilities).toBeUndefined();
      expect(acceptedValue.plugin.health.ready).toBeBoolean();
      expect(acceptedValue.detail).toEqual({
        tool: "rh_context",
        arguments: { repo_id: expect.any(String), capability_id: "plugin.github.configure", detail_level: "detail" }});
      expect(Buffer.byteLength(JSON.stringify(acceptedValue))).toBeLessThan(16_000);

      registerRepository({ path: repoRoot, controllerHome });
      // Authorization-only configure may not enable until confirmed; confirm explicitly.
      const confirmed = await callRuntimeTool(runtimeCtx, "plugin_action_execute", {
        plugin_id: "github",
        action_id: "configure",
        request_id: "plugin-config-runtime-1-confirm",
        arguments: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" },
        confirm_authorization: true});
      const confirmedValue = JSON.parse(confirmed!.content[0].text);
      expect(confirmedValue.accepted).toBe(true);
      expect(confirmedValue.direct).toBe(true);

      const plugin = await callRuntimeTool(runtimeCtx, "get_plugin", { plugin_id: "github" });
      const pluginValue = JSON.parse(plugin!.content[0].text);
      expect(pluginValue.plugin.enabled).toBe(true);
      expect(pluginValue.plugin.actions.some((action: { actionId: string; confirmation: string }) => action.actionId === "close_issue" && action.confirmation === "strong_confirmation")).toBe(true);

      const gmailConfigured = await callRuntimeTool(runtimeCtx, "plugin_action_execute", {
        plugin_id: "gmail",
        action_id: "configure",
        request_id: "gmail-config-runtime-1",
        arguments: {
          enabled: true,
          provider: "mock",
          account_email: "assistant@example.com"},
        confirm_authorization: true});
      const gmailConfiguredValue = JSON.parse(gmailConfigured!.content[0].text);
      expect(gmailConfiguredValue.accepted).toBe(true);
      expect(gmailConfiguredValue.direct).toBe(true);
      expect(gmailConfiguredValue.receiptId || gmailConfiguredValue.result).toBeTruthy();

      const gmailDenied = await callRuntimeTool(runtimeCtx, "plugin_action_execute", {
        plugin_id: "gmail",
        action_id: "send_message",
        request_id: "gmail-send-runtime-denied",
        arguments: {
          to: ["recipient@example.com"],
          subject: "Status update",
          body_text: "Hello from MCP"},
        confirm_authorization: true});
      const gmailDeniedValue = JSON.parse(gmailDenied!.content[0].text);
      expect(gmailDeniedValue.error.code).toBe("PLUGIN_CONFIRMATION_TEXT_REQUIRED");
      expect(gmailDenied!.isError).toBe(true);

      const deduped = await callRuntimeTool(runtimeCtx, "plugin_action_execute", {
        plugin_id: "github",
        action_id: "configure",
        request_id: "plugin-config-runtime-1",
        arguments: { enabled: true, repository: "owner/repo", sync_mode: "checkpoint" },
        confirm_authorization: true});
      const dedupedValue = JSON.parse(deduped!.content[0].text);
      expect(dedupedValue.deduplicated).toBe(true);
      expect(dedupedValue.direct).toBe(true);
      expect(dedupedValue.receiptId || dedupedValue.result).toBeTruthy();
    });
  });

  test("inlines only bounded plugin image artifacts from repository controller storage", async () => {
    await withController(async (repoRoot) => {
      const controllerHome = String(process.env.FORGE_CONTROLLER_HOME);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      );
      const artifactDir = join(repositoryControllerRoot(controllerHome, repository.repoId), "artifacts", "ios");
      mkdirSync(artifactDir, { recursive: true });
      const screenshotPath = join(artifactDir, "screenshot.png");
      writeFileSync(screenshotPath, png);

      const imageContent = boundedPluginArtifactImageContent(controllerHome, repository.repoId, {
        result: {
          artifactCandidates: [{ kind: "ios_simulator_screenshot", mediaType: "image/png", path: screenshotPath }],
        },
      });
      expect(imageContent).toEqual([{
        type: "image",
        mimeType: "image/png",
        data: png.toString("base64"),
      }]);
      expect(boundedPluginArtifactImageContent(controllerHome, repository.repoId, {
        artifactCandidates: [{ kind: "legacy_top_level_image", mediaType: "image/png", path: screenshotPath }],
      })).toEqual(imageContent);
      expect(boundedPluginArtifactImageContent(controllerHome, repository.repoId, {
        artifactCandidates: [{ kind: "legacy_top_level_image", mediaType: "image/png", path: screenshotPath }],
        result: { artifactCandidates: [{ kind: "nested_duplicate", mediaType: "image/png", path: screenshotPath }] },
      })).toEqual(imageContent);

      const outsidePath = join(repoRoot, "outside.png");
      writeFileSync(outsidePath, png);
      expect(boundedPluginArtifactImageContent(controllerHome, repository.repoId, {
        artifactCandidates: [{ kind: "ios_simulator_screenshot", mediaType: "image/png", path: outsidePath }],
      })).toEqual([]);
    });
  });

  test("returns bounded issue summaries by default and keeps full detail opt-in", async () => {
    await withController(async (repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "Bounded issue summary",
        summary: "Exercise summary and full issue reads.",
        tasks: [{
          title: "Large task",
          objective: "Seed large controller metadata.",
          allowed_paths: ["src/**"],
          checks: ["focused"]}]});
      seedLargeControllerIssue(repoRoot, created.value);

      const summary = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id});
      const full = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id,
        detail_level: "full"});

      expect(summary.value.detailLevel).toBe("summary");
      expect(summary.value.tasks[0].noteCount).toBe(24);
      expect(summary.value.tasks[0].notes).toHaveLength(2);
      expect(summary.value.tasks[0].runIdCount).toBe(18);
      expect(summary.value.tasks[0].runIds).toHaveLength(10);
      expect(summary.value.tasks[0].verification.commandEvidenceCount).toBe(6);
      expect(summary.value.tasks[0].verification.commandEvidence).toBeUndefined();
      expect(summary.value.tasks[0].historicalRunOutcomes).toBeUndefined();
      expect(full.value.detailLevel).toBe("full");
      expect(full.value.tasks[0].notes).toHaveLength(24);
      expect(full.value.tasks[0].runIds).toHaveLength(18);
      expect(full.value.tasks[0].verification.commandEvidence).toHaveLength(6);
      expect(Buffer.byteLength(summary.raw.content[0].text)).toBeLessThan(12_000);
      expect(Buffer.byteLength(full.raw.content[0].text)).toBeGreaterThan(30_000);
    });
  });

  test("returns bounded task progress detail by default and keeps full detail opt-in", async () => {
    await withController(async (repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "Bounded task detail",
        summary: "Exercise summary and full task detail reads.",
        tasks: [{
          title: "Large task detail",
          objective: "Seed large run history and timeline.",
          allowed_paths: ["src/**"],
          checks: ["focused"]}]});
      seedLargeControllerIssue(repoRoot, created.value);

      const summary = await jsonTool(ctx, "get_task_progress_detail", {
        issue_id: created.value.id,
        task_id: "T1"});
      const full = await jsonTool(ctx, "get_task_progress_detail", {
        issue_id: created.value.id,
        task_id: "T1",
        detail_level: "full"});

      expect(summary.value.detailLevel).toBe("summary");
      expect(summary.value.runCount).toBe(18);
      expect(summary.value.runs.length).toBeGreaterThan(0);
      expect(summary.value.runs.length).toBeLessThanOrEqual(6);
      expect(summary.value.runs[0].repoRoot).toBeUndefined();
      expect(summary.value.runs[0].promptPath).toBeUndefined();
      expect(summary.value.task.noteCount).toBe(24);
      expect(summary.value.task.runIdCount).toBe(18);
      expect(summary.value.task.effectiveState.historicalRunOutcomeCount).toBeGreaterThan(0);
      expect(summary.value.task.effectiveState.historicalRunOutcomes).toHaveLength(0);
      expect(summary.value.timelineCount).toBeGreaterThan(summary.value.timeline.length);
      expect(summary.value.timeline.length).toBeLessThanOrEqual(20);
      expect(full.value.detailLevel).toBe("full");
      expect(full.value.runs).toHaveLength(18);
      expect(full.value.timeline.length).toBeGreaterThan(60);
      expect(full.value.runs[0].repoRoot).toBe(repoRoot);
      expect(Buffer.byteLength(summary.raw.content[0].text)).toBeLessThan(20_000);
      expect(Buffer.byteLength(full.raw.content[0].text)).toBeGreaterThan(50_000);
    });
  });

  test("returns one compact controller context with execution guidance", async () => {
    await withController(async (_repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "Compact context",
        kind: "feature",
        summary: "Exercise controller_context",
        tasks: [{
          title: "Bounded change",
          objective: "Update one known file",
          allowed_paths: ["src/**"],
          checks: ["focused"]}]});
      expect(created.value.id).toBeTruthy();
      const context = await jsonTool(ctx, "controller_context", {
        description: "Update the example constant in one known file.",
        known_paths: ["src/example.ts"],
        expected_files: 1,
        expected_changed_lines: 2,
        risk: "low"});
      expect(context.value.git.branch).toBe("main");
      expect(context.value.currentIssueId).toBeUndefined();
      expect(context.value.readyTasks).toBeUndefined();
      expect(context.value.requirementBoard).toBeDefined();
      expect(context.value.executionDiagnostics).toBeDefined();
      expect(context.value.legacyCompatibility).toEqual({
        currentIssue: "deprecated_frozen",
        issueTaskBoard: "deprecated_frozen",
        authority: "controller-home-sqlite",
      });
      expect(context.value.checks.some((check: { id: string }) => check.id === "focused")).toBe(true);
      expect(context.value.recommendedExecution.recommendedMode).toBe("direct_edit");

      const defaultContext = await jsonTool(ctx, "controller_context", {});
      expect(defaultContext.value.recommendedExecution).toMatchObject({
        recommendedMode: "direct_edit",
        taskMode: "direct",
      });

      const largeContext = await jsonTool(ctx, "controller_context", {
        description: "Refactor a large cross-module runtime surface",
        expected_files: 12,
        expected_changed_lines: 1_000,
      });
      expect(largeContext.value.recommendedExecution).toMatchObject({
        recommendedMode: "bounded_work",
        taskMode: "bounded",
      });

      const planContext = await jsonTool(ctx, "controller_context", {
        description: "Plan a cross-module routing change",
        mode: "-plan",
        known_paths: ["src/example.ts"],
        expected_files: 8,
      });
      expect(planContext.value.recommendedExecution).toMatchObject({
        recommendedMode: "bounded_work",
        taskMode: "plan",
        explicitMode: "plan",
        modeBehavior: { structuralContext: "required", mutationPhase: "plan_only" },
      });
      expect(planContext.value.modeContextPack.structuralContext).toMatchObject({
        provider: "codegraph",
        requestedMode: "required",
      });

      const pack = await jsonTool(ctx, "controller_context_pack", {
        issue_id: created.value.id,
        task_id: "T1",
        known_paths: ["src/example.ts"],
        search_terms: ["value"],
        max_files: 2,
        max_snippets: 4});
      expect(pack.value.source).toBe("controller-context-pack");
      expect(pack.value.contextContract).toMatchObject({
        retrievalMode: "implementation",
        semanticSufficiencyAuthority: "chatgpt",
        rawCodeRequiredForImplementation: false,
      });
      expect(pack.value.files[0].path).toBe("src/example.ts");
      expect(pack.value.files[0].snippets[0].content).toContain("value = 1");
    });
  });

  test("exposes the supervised advanced surface and resumes idempotent Work by request id", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = join(repoRoot, ".controller-home");
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const defaultContext = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      const core = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "core", controllerHome });
      const advanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "advanced", controllerHome });
      const full = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "full", controllerHome });
      const defaultNames = exposedControllerToolDefinitions(defaultContext).map((tool) => tool.name);
      const coreNames = exposedControllerToolDefinitions(core).map((tool) => tool.name);
      expect(parseMcpToolset(undefined, 'controller')).toBe('advanced');
      expect(defaultContext.toolset).toBe('advanced');
      expect(defaultNames).toEqual(coreNames);
      expect(coreNames).toEqual([...DEFAULT_CONTROLLER_TOOL_NAMES]);
      expect(coreNames).toEqual(expect.arrayContaining(["rh_access", "rh_status", "rh_inbox", "rh_context", "rh_work", "repository_list", "repository_command_execute", "read_repository_file"]));
      expect(coreNames).not.toContain("search_repository");
      // Core is a compatibility label for the bounded default surface; heavy
      // atomic tools stay registered but are not exposed to ChatGPT by default.
      expect(coreNames).not.toContain("verify_edit_session");
      expect(coreNames).toContain("process_get");
      expect(coreNames).toContain("repository_command_execute");
      const advancedNames = exposedControllerToolDefinitions(advanced).map((tool) => tool.name);
      const fullNames = exposedControllerToolDefinitions(full).map((tool) => tool.name);
      // Core and Advanced share the bounded default schema.
      expect(advancedNames).toEqual([...DEFAULT_CONTROLLER_TOOL_NAMES]);
      expect(advancedNames).toEqual(expect.arrayContaining([
        'process_get',
        'process_wait',
        'process_logs',
        'process_cancel',
      ]));
      expect(advancedNames).not.toContain("finish_task_run");
      expect(advancedNames).not.toContain("list_plugins");
      expect(fullNames).toContain("repository_git_status");
      expect(fullNames).toContain("git_commit_paths");
      expect(fullNames).toContain("verify_edit_session");
      expect(fullNames.length).toBeGreaterThan(coreNames.length);

      let runtimePid: number | undefined;
      try {
        const first = await callRuntimeTool(advanced, "work_submit", {
          repo_id: repository.repoId,
          request_id: "work-resume-idempotent",
          operation: "create_issue",
          arguments: { title: "Work resume fixture", kind: "feature" }});
        const second = await callRuntimeTool(advanced, "work_submit", {
          repo_id: repository.repoId,
          request_id: "work-resume-idempotent",
          operation: "create_issue",
          arguments: { title: "Work resume fixture", kind: "feature" }});
        const firstValue = JSON.parse(first!.content[0].text);
        const secondValue = JSON.parse(second!.content[0].text);
        expect(secondValue.deduplicated).toBe(true);
        expect(secondValue.work.workId).toBe(firstValue.work.workId);

        const processCancelWork = await callRuntimeTool(advanced, "work_submit", {
          repo_id: repository.repoId,
          request_id: "work-submit-process-cancel-schema-aware",
          operation: "process_cancel",
          arguments: { process_id: "proc-schema-aware-fixture" },
          timeout_ms: 5_000});
        const processCancelValue = JSON.parse(processCancelWork!.content[0].text);
        expect(processCancelWork!.isError).not.toBe(true);
        expect(processCancelValue.work.operation).toBe("process_cancel");
        expect(processCancelValue.work.status).toBe("open");

        const resumed = await callRuntimeTool(advanced, "work_get", {
          repo_id: repository.repoId,
          request_id: "work-resume-idempotent"});
        const resumedValue = JSON.parse(resumed!.content[0].text);
        expect(resumedValue.work.workId).toBe(firstValue.work.workId);
        expect(resumedValue.work.requestId).toBe("work-resume-idempotent");

        const now = new Date().toISOString();
        writeWorkHandle(controllerHome, {
          schemaVersion: 1,
          workId: "work-handle-authority",
          sessionId: "session-work-handle-authority",
          principalId: "principal-work-handle-authority",
          repositoryId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          worktreePath: repository.canonicalRoot,
          branch: "main",
          managedWorktree: false,
          permissionSnapshotVersion: 1,
          state: "editing",
          createdAt: now,
          updatedAt: now,
          finalization: {
            validation: "pending",
            commit: "pending",
            merge: "pending",
            branchCleanup: "pending",
            worktreeCleanup: "pending"}});
        const handleGet = await callRuntimeTool(advanced, "work_get", {
          repo_id: repository.repoId,
          work_id: "work-handle-authority"});
        const handleGetValue = JSON.parse(handleGet!.content[0].text);
        expect(handleGetValue.work.kind).toBe("work_handle");
        expect(handleGetValue.work.state).toBe("editing");
        expect(handleGetValue.workHandle.checkoutId).toBe(repository.activeCheckoutId);

        const handleWait = await callRuntimeTool(advanced, "work_wait", {
          repo_id: repository.repoId,
          work_id: "work-handle-authority",
          wait_ms: 1});
        const handleWaitValue = JSON.parse(handleWait!.content[0].text);
        expect(handleWaitValue.work.kind).toBe("work_handle");
        expect(handleWaitValue.timedOut).toBe(true);
        runtimePid = readForgeRuntimeStatus(controllerHome).pid;
      } finally {
        if (runtimePid && runtimePid !== process.pid) {
          await terminateProcessTree(runtimePid, { gracePeriodMs: 200, killAfterMs: 1_500 });
        }
      }
    });
  });

  test("adopts only an exact clean in-scope successor HEAD and preserves historical evidence", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
      spawnSync("git", ["config", "user.name", "Forge Test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["config", "user.email", "forge@example.test"], { cwd: repoRoot, stdio: "ignore" });
      writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
      spawnSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
      expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: repoRoot, stdio: "ignore" }).status).toBe(0);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      persistControllerAccessMode(controllerHome, "full_access", repoRoot);
      const advanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "advanced", controllerHome });
      const started = await executionJson(advanced, "session_start", {});
      const sessionId = String(started.session.sessionId);
      await executionJson(advanced, "session_bind_repository", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
      });
      const prepared = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
        request_id: "head-adoption-success",
        objective: "Adopt a controlled successor commit",
        allowed_paths: ["allowed.txt"],
        isolation: "new_worktree",
      });
      expect(prepared.error).toBeUndefined();
      const workId = String(prepared.work.workId);
      const handle = readWorkHandle(controllerHome, repository.repoId, workId)!;
      const previousHead = String(handle.expectedHead);
      writeFileSync(join(handle.worktreePath, "allowed.txt"), "allowed\n");
      expect(spawnSync("git", ["add", "--", "allowed.txt"], { cwd: handle.worktreePath, stdio: "ignore" }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "controlled successor"], { cwd: handle.worktreePath, stdio: "ignore" }).status).toBe(0);
      const candidateHead = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: handle.worktreePath, encoding: "utf-8" }).stdout).trim();
      const historicalCheck = {
        checkId: "historical-check",
        outcome: "valid_pass" as const,
        summary: "Historical evidence must remain immutable.",
        recordedAt: new Date().toISOString(),
        sourceRevision: previousHead,
        workspaceFingerprint: "historical-workspace",
        verificationInputFingerprint: "historical-input",
        commandFingerprint: "historical-command",
      };
      updateWorkContract({ controllerHome, repoId: repository.repoId }, handle.workContractId!, { checkRefs: [historicalCheck] });

      const strictReuse = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: handle.checkoutId,
        work_id: workId,
      });
      expect(strictReuse.error.code).toBe("WORK_HANDLE_HEAD_CHANGED");

      const wrongCheckout = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
        work_id: workId,
        expected_previous_head: previousHead,
        adopt_candidate_head: candidateHead,
      });
      expect(wrongCheckout.error.code).toBe("WORK_HEAD_ADOPTION_CHECKOUT_MISMATCH");

      writeFileSync(join(handle.worktreePath, "dirty.tmp"), "dirty\n");
      const dirty = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: handle.checkoutId,
        work_id: workId,
        expected_previous_head: previousHead,
        adopt_candidate_head: candidateHead,
      });
      expect(dirty.error.code).toBe("EXECUTION_TOOL_FAILED");
      expect(String(dirty.error.message)).toContain("WORK_HEAD_ADOPTION_WORKTREE_DIRTY");
      rmSync(join(handle.worktreePath, "dirty.tmp"));

      const stalePrevious = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: handle.checkoutId,
        work_id: workId,
        expected_previous_head: candidateHead,
        adopt_candidate_head: candidateHead,
      });
      expect(stalePrevious.error.code).toBe("WORK_HEAD_ADOPTION_PREVIOUS_HEAD_MISMATCH");

      const owner = getControllerSession({ controllerHome, repoId: repository.repoId }, handle.workContractId!)!;
      releaseControllerSession({ controllerHome, repoId: repository.repoId }, handle.workContractId!, owner.controllerId);
      claimControllerSession({ controllerHome, repoId: repository.repoId }, {
        workId: handle.workContractId!,
        controllerId: "foreign-controller",
        controllerType: "chatgpt",
        sessionId: "foreign-session",
        principalId: "foreign-principal",
        controllerInstanceId: "foreign-instance",
        expectedClaimGeneration: 0,
        leaseMs: 60_000,
      });
      const foreignOwner = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: handle.checkoutId,
        work_id: workId,
        expected_previous_head: previousHead,
        adopt_candidate_head: candidateHead,
      });
      expect(foreignOwner.error.code).toBe("WORK_CONTROLLER_PRINCIPAL_MISMATCH");
      releaseControllerSession({ controllerHome, repoId: repository.repoId }, handle.workContractId!, "foreign-controller");

      const adopted = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: handle.checkoutId,
        work_id: workId,
        expected_previous_head: previousHead,
        adopt_candidate_head: candidateHead,
      });
      expect(adopted).toMatchObject({
        adopted: true,
        reused: true,
        work: { expectedHead: candidateHead, state: "editing" },
        adoption: { previousHead, candidateHead, changedPaths: ["allowed.txt"] },
      });
      const persisted = readWorkHandle(controllerHome, repository.repoId, workId)!;
      expect(persisted.expectedHead).toBe(candidateHead);
      expect(persisted.finalization.validation).toBe("pending");
      const contract = getWorkContract({ controllerHome, repoId: repository.repoId }, handle.workContractId!)!;
      expect(contract.checkRefs).toEqual([historicalCheck]);
      expect(contract.completionReceipt).toBeUndefined();
      expect(contract.evidenceState).toBe("partial");
      expect(contract.reconciliations[0]).toMatchObject({
        originalExpectedRevision: previousHead,
        observedTargetRevision: candidateHead,
        comparedPaths: ["allowed.txt"],
        outcome: "accepted_equivalence",
      });
    });
  });

  test("rejects non-descendant and out-of-scope successor HEAD adoption", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
      spawnSync("git", ["config", "user.name", "Forge Test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["config", "user.email", "forge@example.test"], { cwd: repoRoot, stdio: "ignore" });
      writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
      spawnSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
      expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: repoRoot, stdio: "ignore" }).status).toBe(0);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      persistControllerAccessMode(controllerHome, "full_access", repoRoot);
      const advanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "advanced", controllerHome });
      const started = await executionJson(advanced, "session_start", {});
      const sessionId = String(started.session.sessionId);
      await executionJson(advanced, "session_bind_repository", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
      });
      const prepare = async (requestId: string) => {
        const prepared = await executionJson(advanced, "work_prepare", {
          session_id: sessionId,
          repo_id: repository.repoId,
          checkout_id: repository.activeCheckoutId,
          request_id: requestId,
          objective: requestId,
          allowed_paths: ["allowed.txt"],
          isolation: "new_worktree",
        });
        expect(prepared.error).toBeUndefined();
        return readWorkHandle(controllerHome, repository.repoId, String(prepared.work.workId))!;
      };

      const unrelated = await prepare("head-adoption-non-descendant");
      const unrelatedPrevious = String(unrelated.expectedHead);
      const tree = String(spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: unrelated.worktreePath, encoding: "utf-8" }).stdout).trim();
      const unrelatedHead = String(spawnSync("git", ["commit-tree", tree, "-m", "unrelated root"], { cwd: unrelated.worktreePath, encoding: "utf-8" }).stdout).trim();
      expect(spawnSync("git", ["reset", "--hard", unrelatedHead], { cwd: unrelated.worktreePath, stdio: "ignore" }).status).toBe(0);
      const nonDescendant = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: unrelated.checkoutId,
        work_id: unrelated.workId,
        expected_previous_head: unrelatedPrevious,
        adopt_candidate_head: unrelatedHead,
      });
      expect(nonDescendant.error.code).toBe("EXECUTION_TOOL_FAILED");
      expect(String(nonDescendant.error.message)).toContain("WORK_HEAD_ADOPTION_NOT_DESCENDANT");

      const outOfScope = await prepare("head-adoption-out-of-scope");
      const outOfScopePrevious = String(outOfScope.expectedHead);
      writeFileSync(join(outOfScope.worktreePath, "forbidden.txt"), "forbidden\n");
      expect(spawnSync("git", ["add", "--", "forbidden.txt"], { cwd: outOfScope.worktreePath, stdio: "ignore" }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "out of scope"], { cwd: outOfScope.worktreePath, stdio: "ignore" }).status).toBe(0);
      const outOfScopeHead = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: outOfScope.worktreePath, encoding: "utf-8" }).stdout).trim();
      const rejectedPath = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: outOfScope.checkoutId,
        work_id: outOfScope.workId,
        expected_previous_head: outOfScopePrevious,
        adopt_candidate_head: outOfScopeHead,
      });
      expect(rejectedPath.error.code).toBe("WORK_HEAD_ADOPTION_PATH_OUT_OF_SCOPE");
    });
  });

  test("work_validate polling preserves the Process binding until an exact check receipt is recorded", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
      writeFileSync(join(repoRoot, ".forge/checks.json"), JSON.stringify({
        version: 1,
        checks: {
          "validation-pass": {
            description: "Intentional validation success",
            command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 300)"],
            timeoutMs: 10_000,
          },
        },
      }));
      spawnSync("git", ["config", "user.name", "Forge Test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["config", "user.email", "forge@example.test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
      expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: repoRoot, stdio: "ignore" }).status).toBe(0);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      persistControllerAccessMode(controllerHome, "full_access", repoRoot);
      const advanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "advanced", controllerHome });
      const started = await executionJson(advanced, "session_start", {});
      const sessionId = String(started.session.sessionId);
      await executionJson(advanced, "session_bind_repository", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
      });
      const prepared = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
        request_id: "validation-pass-exact-receipt",
        objective: "Record the exact successful validation receipt",
        checks: ["validation-pass"],
        isolation: "new_worktree",
      });
      expect(prepared.error).toBeUndefined();
      const workId = String(prepared.work.workId);
      const initial = readWorkHandle(controllerHome, repository.repoId, workId)!;
      const validationRequestId = "validation-pass-same-request-id";
      let validated = await executionJson(advanced, "work_validate", {
        session_id: sessionId,
        repo_id: repository.repoId,
        work_id: workId,
        check_ids: ["validation-pass"],
        request_id: validationRequestId,
      });
      for (let attempt = 0; attempt < 120 && validated.validation?.completed !== true; attempt += 1) {
        await Bun.sleep(25);
        validated = await executionJson(advanced, "work_validate", {
          session_id: sessionId,
          repo_id: repository.repoId,
          work_id: workId,
          check_ids: ["validation-pass"],
          request_id: validationRequestId,
        });
      }
      expect(validated.error).toBeUndefined();
      expect(validated.validation).toMatchObject({ passed: true, completed: true, targeted: true });
      const persisted = readWorkHandle(controllerHome, repository.repoId, workId)!;
      expect(persisted.state).toBe("editing");
      expect(persisted.finalization.validation).toBe("done");
      const contract = getWorkContract({ controllerHome, repoId: repository.repoId }, initial.workContractId!)!;
      expect(contract.evidenceState).toBe("valid");
      expect(contract.checkRefs).toHaveLength(1);
      expect(contract.checkRefs[0]).toMatchObject({
        checkId: "validation-pass",
        outcome: "valid_pass",
        sourceRevision: initial.expectedHead,
      });
      expect(contract.checkRefs[0]?.workspaceFingerprint).toBeTruthy();
      expect(contract.checkRefs[0]?.verificationInputFingerprint).toBeTruthy();
      expect(contract.checkRefs[0]?.commandFingerprint).toBeTruthy();
      expect(contract.checkRefs[0]?.receipt?.processId).toBeTruthy();
    });
  });

  test("automatically cleans validation-failed managed Work while preserving failure and releasing ownership", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
      writeFileSync(join(repoRoot, ".forge/checks.json"), JSON.stringify({
        version: 1,
        checks: {
          "validation-fail": {
            description: "Intentional validation failure",
            command: [process.execPath, "-e", "process.exit(7)"],
            timeoutMs: 10_000,
          },
        },
      }));
      spawnSync("git", ["config", "user.name", "Forge Test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["config", "user.email", "forge@example.test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
      expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: repoRoot, stdio: "ignore" }).status).toBe(0);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      persistControllerAccessMode(controllerHome, "full_access", repoRoot);
      const advanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "advanced", controllerHome });
      const started = await executionJson(advanced, "session_start", {});
      const sessionId = String(started.session.sessionId);
      await executionJson(advanced, "session_bind_repository", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
      });
      const prepared = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
        request_id: "validation-failed-auto-cleanup",
        objective: "Prove validation failure automatically enters cleanup",
        checks: ["validation-fail"],
        isolation: "new_worktree",
      });
      expect(prepared.error).toBeUndefined();
      const workId = String(prepared.work.workId);
      const handle = readWorkHandle(controllerHome, repository.repoId, workId)!;
      expect(getControllerSession({ controllerHome, repoId: repository.repoId }, handle.workContractId!)).toBeDefined();

      let cleaned = await executionJson(advanced, "work_validate", {
        session_id: sessionId,
        repo_id: repository.repoId,
        work_id: workId,
        check_ids: ["validation-fail"],
        cleanup: true,
        delete_branch: true,
        target_branch: "main",
      });
      for (let attempt = 0; attempt < 120 && cleaned.cleanupCompleted !== true; attempt += 1) {
        await Bun.sleep(25);
        cleaned = await executionJson(advanced, "work_validate", {
          session_id: sessionId,
          repo_id: repository.repoId,
          work_id: workId,
          check_ids: ["validation-fail"],
          cleanup: true,
          delete_branch: true,
          target_branch: "main",
        });
      }
      expect(cleaned.error).toBeUndefined();
      expect(cleaned).toMatchObject({
        completed: false,
        cleanupCompleted: true,
        failurePreserved: true,
        work: { state: "cleaned" },
        stages: { validation: "failed", commit: "skipped", merge: "skipped", branchCleanup: "done", worktreeCleanup: "done" },
        cleanupReceipt: {
          terminalOutcome: "validation_failed",
          complete: true,
          processes: { allTerminal: true },
          ownership: { controllerLease: "released", processLeases: "released" },
          verification: { mode: "cleanup_only", checksRun: [] },
        },
      });
      expect(String(cleaned.work.failureReason)).toContain("targeted validation failed");
      expect(existsSync(handle.worktreePath)).toBe(false);
      const failedContract = getWorkContract({ controllerHome, repoId: repository.repoId }, handle.workContractId!);
      expect(failedContract).toMatchObject({ status: "failed", phase: "cleanup" });
      expect(failedContract?.completionReceipt).toBeUndefined();
      expect(getControllerSession({ controllerHome, repoId: repository.repoId }, handle.workContractId!)).toBeUndefined();

      const retried = await executionJson(advanced, "work_finalize", {
        session_id: sessionId,
        repo_id: repository.repoId,
        work_id: workId,
        cleanup: true,
        delete_branch: true,
        target_branch: "main",
      });
      expect(retried).toMatchObject({
        idempotent: true,
        completed: false,
        cleanupCompleted: true,
        failurePreserved: true,
        work: { state: "cleaned" },
      });
    });
  });

  test("failed Work cleanup checkpoints dirty content despite unrelated check failure", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
      spawnSync("git", ["config", "user.name", "Forge Test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["config", "user.email", "forge@example.test"], { cwd: repoRoot, stdio: "ignore" });
      spawnSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
      expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: repoRoot, stdio: "ignore" }).status).toBe(0);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      persistControllerAccessMode(controllerHome, "full_access", repoRoot);
      const advanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "advanced", controllerHome });
      const started = await executionJson(advanced, "session_start", {});
      const sessionId = String(started.session.sessionId);
      await executionJson(advanced, "session_bind_repository", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
      });
      const prepared = await executionJson(advanced, "work_prepare", {
        session_id: sessionId,
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
        request_id: "failed-cleanup-dirty-work",
        objective: "Create a dirty failed cleanup fixture",
        isolation: "new_worktree",
      });
      expect(prepared.error).toBeUndefined();
      const workId = String(prepared.work.workId);
      const handle = readWorkHandle(controllerHome, repository.repoId, workId)!;
      writeFileSync(join(handle.worktreePath, "dirty.txt"), "retain me\n");
      const failure = "verification failed";
      writeWorkHandle(controllerHome, {
        ...handle,
        state: "failed",
        failureReason: failure,
        finalization: { ...handle.finalization, validation: "failed", lastError: failure },
      });
      updateWorkContract({ controllerHome, repoId: repository.repoId }, handle.workContractId!, {
        status: "failed",
        evidenceState: "failed",
      });

      const cleaned = await executionJson(advanced, "work_finalize", {
        session_id: sessionId,
        repo_id: repository.repoId,
        work_id: workId,
        cleanup: true,
        delete_branch: true,
        target_branch: "main",
      });
      expect(cleaned.error).toBeUndefined();
      expect(cleaned).toMatchObject({
        cleanupCompleted: true,
        failurePreserved: true,
        work: { state: "cleaned", failureReason: failure },
        cleanupReceipt: {
          complete: true,
          preservation: { status: "checkpointed" },
          branchCleanup: { status: "archived" },
          verification: { mode: "cleanup_only", checksRun: [] },
        },
      });
      expect(cleaned.cleanupReceipt.preservation.checkpointCommit).toBeTruthy();
      expect(cleaned.cleanupReceipt.preservation.bundlePath).toBeTruthy();
      expect(existsSync(cleaned.cleanupReceipt.preservation.bundlePath)).toBe(true);
      expect(existsSync(handle.worktreePath)).toBe(false);
      expect(readWorkHandle(controllerHome, repository.repoId, workId)).toMatchObject({ state: "cleaned", failureReason: failure });
      expect(getWorkContract({ controllerHome, repoId: repository.repoId }, handle.workContractId!)).toMatchObject({ status: "failed" });
    });
  });

  test("preserves the unmarked legacy Advanced default while retaining explicit compatibility and access-schema stability", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = join(repoRoot, ".controller-home");
      writeMcpServiceLocalConfig(controllerHome, {
        version: 1,
        repo: repoRoot,
        profile: "controller",
        toolset: "advanced",
        accessMode: "full_access"});

      const legacy = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      const legacyNames = exposedControllerToolDefinitions(legacy).map((tool) => tool.name);
      expect(legacy.toolset).toBe("advanced");
      expect(legacyNames).toEqual([...DEFAULT_CONTROLLER_TOOL_NAMES]);

      persistControllerAccessMode(controllerHome, "request", repoRoot);
      const requestMode = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      persistControllerAccessMode(controllerHome, "full_access", repoRoot);
      const fullAccessMode = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      expect(exposedControllerToolDefinitions(requestMode).map((tool) => tool.name))
        .toEqual(exposedControllerToolDefinitions(fullAccessMode).map((tool) => tool.name));

      writeMcpServiceLocalConfig(controllerHome, {
        version: 2,
        repo: repoRoot,
        profile: "controller",
        toolset: "advanced",
        toolsetExplicit: true,
        accessMode: "full_access"});
      const explicitAdvanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      expect(explicitAdvanced.toolset).toBe("advanced");
      expect(exposedControllerToolDefinitions(explicitAdvanced).map((tool) => tool.name))
        .toContain("repository_command_execute");
    });
  });

  test("rejects cross-repository Work reuse for the same request id", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = join(repoRoot, ".controller-home");
      const firstRepository = registerRepository({ path: repoRoot, controllerHome });
      const secondRoot = mkdtempSync(join(tmpdir(), "forge-controller-second-"));
      let runtimePid: number | undefined;
      try {
        mkdirSync(join(secondRoot, "src"), { recursive: true });
        writeFileSync(join(secondRoot, "src/example.ts"), "export const second = true;\n");
        spawnSync("git", ["init", "-b", "main"], { cwd: secondRoot, stdio: "ignore" });
        const secondRepository = registerRepository({ path: secondRoot, controllerHome });
        const advanced = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "advanced", controllerHome });
        const first = await callRuntimeTool(advanced, "work_submit", {
          repo_id: firstRepository.repoId,
          request_id: "work-cross-repo-conflict",
          operation: "create_issue",
          arguments: { title: "First repository Work", kind: "feature" }});
        expect(first?.isError).not.toBe(true);
        const conflict = await callRuntimeTool(advanced, "work_submit", {
          repo_id: secondRepository.repoId,
          request_id: "work-cross-repo-conflict",
          operation: "create_issue",
          arguments: { title: "Second repository Work", kind: "feature" }});
        const conflictValue = JSON.parse(conflict!.content[0].text);
        expect(conflict?.isError).toBe(true);
        expect(conflictValue.error.code).toBe("REQUEST_ID_REPO_CONFLICT");
        runtimePid = readForgeRuntimeStatus(controllerHome).pid;
      } finally {
        if (runtimePid && runtimePid !== process.pid) {
          await terminateProcessTree(runtimePid, { gracePeriodMs: 200, killAfterMs: 1_500 });
        }
        rmSync(secondRoot, { recursive: true, force: true });
      }
    });
  });

  test("runs structured selected-path Git and fallback handoff actions on the full controller surface", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = join(repoRoot, ".controller-home");
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const full = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", toolset: "full", controllerHome });
      const toolNames = exposedControllerToolDefinitions(full).map((tool) => tool.name);
      expect(toolNames).toContain("git_diff_paths");
      expect(toolNames).toContain("git_stage_paths");
      expect(toolNames).toContain("git_commit_paths");
      expect(toolNames).toContain("prepare_transfer_artifacts");

      expect(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.name", "Test"], { cwd: repoRoot }).status).toBe(0);
      writeFileSync(join(repoRoot, "src", "other.ts"), "export const other = 1;\n");
      expect(spawnSync("git", ["add", "."], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "initial"], { cwd: repoRoot }).status).toBe(0);

      writeFileSync(join(repoRoot, "src", "example.ts"), "export const value = 2;\n");
      writeFileSync(join(repoRoot, "src", "other.ts"), "export const other = 2;\n");
      expect(spawnSync("git", ["add", "src/other.ts"], { cwd: repoRoot }).status).toBe(0);

      const diff = await callRuntimeTool(full, "git_diff_paths", {
        repo_id: repository.repoId,
        paths: ["src/example.ts"]});
      const diffValue = JSON.parse(diff!.content[0].text);
      expect(diffValue.paths).toEqual(["src/example.ts"]);
      expect(diffValue.diff).toContain("value = 2");
      expect(diffValue.diff).not.toContain("other = 2");

      const staged = await callRuntimeTool(full, "git_stage_paths", {
        repo_id: repository.repoId,
        paths: ["src/example.ts"]});
      const stagedValue = JSON.parse(staged!.content[0].text);
      expect(stagedValue.execution.ok).toBe(true);
      const cachedAfterStage = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: repoRoot, encoding: "utf-8" });
      expect(cachedAfterStage.stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual(["src/example.ts", "src/other.ts"]);

      const commit = await callRuntimeTool(full, "git_commit_paths", {
        repo_id: repository.repoId,
        paths: ["src/example.ts"],
        message: "Commit selected example"});
      const commitValue = JSON.parse(commit!.content[0].text);
      expect(commitValue.error).toBeUndefined();
      expect(commitValue.commit.ok).toBe(true);
      const headFiles = spawnSync("git", ["show", "--name-only", "--format=%s", "HEAD"], { cwd: repoRoot, encoding: "utf-8" });
      expect(headFiles.stdout).toContain("Commit selected example");
      expect(headFiles.stdout).toContain("src/example.ts");
      expect(headFiles.stdout).not.toContain("src/other.ts");
      const cachedAfterCommit = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: repoRoot, encoding: "utf-8" });
      expect(cachedAfterCommit.stdout.trim()).toBe("src/other.ts");

      const transfer = await callRuntimeTool(full, "prepare_transfer_artifacts", {
        repo_id: repository.repoId,
        reason: "controller-test"});
      const transferValue = JSON.parse(transfer!.content[0].text);
      expect(transferValue.usedScript).toBe(false);
      expect(transferValue.fallbackUsed).toBe(true);
      expect(transferValue.artifacts[0].path).toBe(".ai/harness/session/continuation.md");
      expect(transferValue.artifacts[0].preview).toContain("controller-test");
      expect(transferValue.artifacts[1].path).toBe(".ai/harness/session/resume.md");
      expect(existsSync(join(repoRoot, ".ai", "harness", "session", "continuation.md"))).toBe(true);
      expect(existsSync(join(repoRoot, ".ai", "harness", "session", "resume.md"))).toBe(true);
      expect(existsSync(join(repoRoot, ".ai", "harness", "handoff", "current.md"))).toBe(false);
      expect(existsSync(join(repoRoot, ".ai", "harness", "handoff", "resume.md"))).toBe(false);
    });
  });

  test("controller context projections reject legacy and mixed identities", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = join(repoRoot, ".controller-home");
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const head = null;
      const branch = spawnSync("git", ["branch", "--show-current"], { cwd: repoRoot, encoding: "utf-8" }).stdout.trim();
      const sourceIdentity = {
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        canonicalRoot: repository.canonicalRoot,
        head,
        branch,
        workingTreeFingerprint: "current-tree",
        sourceRevision: "projection-1",
        variant: "summary" as const,
        toolset: "advanced",
        profile: "controller",
      };
      const payload = {
        repoId: repository.repoId,
        repository: {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          root: repository.canonicalRoot,
        },
        git: { head, branch },
        runtimeProjectionState: {},
        operationalView: {},
        controllerReady: {},
      };
      const projectionsRoot = join(repositoryControllerRoot(controllerHome, repository.repoId), "projections");
      mkdirSync(projectionsRoot, { recursive: true });
      writeJsonAtomic(join(projectionsRoot, "controller-context.json"), {
        schemaVersion: 1,
        repoId: repository.repoId,
        generatedAt: new Date().toISOString(),
        payload: {
          ...payload,
          repository: { ...payload.repository, checkoutId: "stale-checkout", root: join(repoRoot, "stale") },
          git: { head: "stale-head", branch: "stale-branch" },
        },
      });

      expect(readControllerContextProjection(controllerHome, repository.repoId, { sourceIdentity })).toBeUndefined();

      const multi = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      const response = JSON.parse((await callRuntimeTool(multi, "controller_context", {
        repo_id: repository.repoId,
        checkout_id: repository.activeCheckoutId,
      }))!.content[0].text);
      expect(response.error).toBeUndefined();
      expect(response.repository).toMatchObject({
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        root: repository.canonicalRoot,
        branch,
        head,
      });
      expect(response.contextProjection.sourceIdentity).toMatchObject({
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        canonicalRoot: repository.canonicalRoot,
        branch,
        head,
      });

      expect(() => writeControllerContextProjection(controllerHome, repository.repoId, {
        ...payload,
        repository: { ...payload.repository, checkoutId: "wrong-checkout" },
      }, { sourceIdentity })).toThrow("CONTEXT_PROJECTION_SOURCE_MISMATCH");

      writeControllerContextProjection(controllerHome, repository.repoId, payload, { sourceIdentity });
      expect(readControllerContextProjection(controllerHome, repository.repoId, { sourceIdentity })?.payload).toEqual(payload);
    });
  });

  test("controller context refresh fencing rejects late stale generations", async () => {
    await withController(async (repoRoot, _ctx) => {
      clearControllerContextPerformanceSnapshotForTest();
      const controllerHome = join(repoRoot, ".controller-home");
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const branch = spawnSync("git", ["branch", "--show-current"], { cwd: repoRoot, encoding: "utf-8" }).stdout.trim();
      const baseIdentity = {
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        canonicalRoot: repository.canonicalRoot,
        branch,
        variant: "summary" as const,
        toolset: "advanced",
        profile: "controller",
      };
      const oldIdentity = { ...baseIdentity, head: "old-head", workingTreeFingerprint: "old-tree", sourceRevision: "old-source" };
      const newIdentity = { ...baseIdentity, head: "new-head", workingTreeFingerprint: "new-tree", sourceRevision: "new-source" };
      const payloadFor = (head: string) => ({
        repoId: repository.repoId,
        repository: {
          repoId: repository.repoId,
          checkoutId: repository.activeCheckoutId,
          root: repository.canonicalRoot,
        },
        git: { head, branch },
        runtimeProjectionState: {},
        operationalView: {},
        controllerReady: {},
      });
      let releaseOld!: () => void;
      let releaseNew!: () => void;
      const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
      const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });

      queueControllerContextProjectionRefresh(controllerHome, repository.repoId, {
        variant: "summary",
        sourceIdentity: oldIdentity,
        build: async () => { await oldGate; return payloadFor("old-head"); },
      });
      queueControllerContextProjectionRefresh(controllerHome, repository.repoId, {
        variant: "summary",
        sourceIdentity: newIdentity,
        build: async () => { await newGate; return payloadFor("new-head"); },
      });
      releaseNew();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (readControllerContextProjection(controllerHome, repository.repoId, { sourceIdentity: newIdentity })) break;
        await Bun.sleep(5);
      }
      releaseOld();
      await Bun.sleep(20);

      expect(readControllerContextProjection(controllerHome, repository.repoId, { sourceIdentity: newIdentity })?.payload).toEqual(payloadFor("new-head"));
      expect(readControllerContextProjection(controllerHome, repository.repoId, { sourceIdentity: oldIdentity })).toBeUndefined();
      clearControllerContextPerformanceSnapshotForTest();
    });
  });

  test("controller_context hot reads reuse stored plugin manifests", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = join(repoRoot, ".controller-home");
      const multi = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      const repository = registerRepository({ path: repoRoot, controllerHome });
      writeStoredPluginManifest(controllerHome, repository.repoId, "github", {
        revision: 77,
        provider: "stored-provider"});

      const summary = JSON.parse((await callRuntimeTool(multi, "controller_context", { repo_id: repository.repoId }))!.content[0].text);
      // Default summary carries compact plugin counts only; manifests are detail.
      expect(summary.plugins).toHaveProperty("enabledCount");
      expect(summary.plugins).not.toHaveProperty("provider");
      expect(summary.execution.recommendedMode).toBe("direct_edit");
      const planned = JSON.parse((await callRuntimeTool(multi, "controller_context", {
        repo_id: repository.repoId,
        description: "Plan a cross-module change",
        mode: "-plan",
        known_paths: ["src/example.ts"],
      }))!.content[0].text);
      expect(planned.execution.recommendedMode).toBe("bounded_work");
      expect(planned.recommendedExecution).toMatchObject({ taskMode: "plan", explicitMode: "plan" });
      expect(planned.modeContextPack.structuralContext.requestedMode).toBe("required");
      const directAgain = JSON.parse((await callRuntimeTool(multi, "controller_context", {
        repo_id: repository.repoId,
        description: "Read one known file",
        mode: "direct",
        known_paths: ["src/example.ts"],
      }))!.content[0].text);
      expect(directAgain.execution.recommendedMode).toBe("direct_edit");
      expect(directAgain.modeContextPack).toBeUndefined();
      const detail = JSON.parse((await callRuntimeTool(multi, "controller_context", { repo_id: repository.repoId, detail_level: "detail" }))!.content[0].text);
      const plugin = detail.plugins.find((entry: { pluginId: string }) => entry.pluginId === "github");

      expect(plugin).toBeTruthy();
      expect(plugin.provider).toBe("stored-provider");
      expect(plugin.revision).toBe(77);
    });
  });

  test("keeps rh_context detail capability payload bounded", async () => {
    await withController(async (repoRoot, _ctx) => {
      const multi = createMultiRepositoryContext({ repo: repoRoot, profile: "controller" });
      const raw = await callRuntimeTool(multi, "rh_context", { detail_level: "detail" });
      expect(raw).toBeTruthy();
      const payload = JSON.parse(raw!.content[0].text);
      expect(payload.data.bounded).toBe(true);
      expect(payload.data.capabilities.length).toBeLessThanOrEqual(24);
      expect(payload.data.omittedCapabilityCount).toBe(
        Math.max(0, payload.data.capabilityCount - payload.data.capabilities.length),
      );
      expect(payload.data.checks.length).toBeLessThanOrEqual(24);
      expect(payload.data.omittedCheckCount).toBe(
        Math.max(0, payload.data.counts.availableChecks - payload.data.checks.length),
      );
    });
  });

  test("loads one live plugin action schema through rh_context even when the stored manifest is stale", async () => {
    await withController(async (repoRoot, _ctx) => {
      const controllerHome = join(repoRoot, ".controller-home-capability-live");
      const multi = createMultiRepositoryContext({ repo: repoRoot, profile: "controller", controllerHome });
      const repository = registerRepository({ path: repoRoot, controllerHome });
      writeStoredPluginManifest(controllerHome, repository.repoId, "browser", {
        revision: 91,
        provider: "stored-browser-stale",
        capabilities: [],
        actions: [],
      });
      const toolNames = exposedControllerToolDefinitions(multi).map((tool) => tool.name);
      expect(toolNames).toContain("plugin_action_execute");
      expect(toolNames).not.toContain("get_plugin");
      expect(toolNames).not.toContain("list_plugins");
      expect(toolNames).toHaveLength(19);

      const raw = await callRuntimeTool(multi, "rh_context", {
        repo_id: repository.repoId,
        capability_id: "plugin.browser.get_text",
      });
      expect(raw).toBeTruthy();
      const payload = JSON.parse(raw!.content[0].text);
      expect(payload.data.capabilityLookup).toMatchObject({
        requestedCapabilityId: "plugin.browser.get_text",
        found: true,
        descriptor: { capabilityId: "plugin.browser.get_text", group: "browser" },
        pluginAction: {
          pluginId: "browser",
          actionId: "get_text",
          executeWith: "plugin_action_execute",
          readOnly: true,
          confirmation: "none",
        },
      });
      expect(payload.data.capabilityLookup.pluginAction.argumentsSchema).toHaveProperty("type", "object");
      expect(payload.data.capabilityLookup.pluginAction.provider).not.toBe("stored-browser-stale");

      const controllerRaw = await callRuntimeTool(multi, "rh_context", {
        repo_id: repository.repoId,
        capability_id: "plugin.local_system.system_snapshot",
      });
      expect(controllerRaw).toBeTruthy();
      const controllerPayload = JSON.parse(controllerRaw!.content[0].text);
      expect(controllerPayload.data.capabilityLookup).toMatchObject({
        requestedCapabilityId: "plugin.local_system.system_snapshot",
        found: true,
        pluginAction: {
          pluginId: "local_system",
          actionId: "system_snapshot",
          executeWith: "plugin_action_execute",
        },
      });
    });
  });

  test("routes default code retrieval through rh_context.search without exposing a second search tool", async () => {
    await withController(async (repoRoot, _ctx) => {
      const multi = createMultiRepositoryContext({ repo: repoRoot, profile: "controller" });
      const toolNames = exposedControllerToolDefinitions(multi).map((tool) => tool.name);
      expect(toolNames).not.toContain("search_repository");
      const raw = await callRuntimeTool(multi, "rh_context", {
        operation: "search",
        query: "value = 1",
        include_globs: ["src/**"],
        max_files: 2,
      });
      expect(raw).toBeTruthy();
      const retrieved = JSON.parse(raw!.content[0].text);
      expect(retrieved.data.files[0]).toMatchObject({ path: "src/example.ts" });
      expect(retrieved.data.files[0].snippets[0].content).toContain("value = 1");
      expect(retrieved.data.search.terms[0]).toBe("value = 1");
      expect(retrieved.data.retrievalPolicy).toMatchObject({
        defaultBackend: "bounded_lexical",
        structuralBackend: "codegraph",
        rawReadTool: "read_repository_file",
        shellSearchFallbackOnly: true,
      });
      expect(retrieved.data.contextContract).toMatchObject({
        retrievalMode: "implementation",
        semanticSufficiencyAuthority: "chatgpt",
        rawCodeRequiredForImplementation: false,
      });
      expect(retrieved.data.structuralContext.requestedMode).toBe("auto");

      const planRaw = await callRuntimeTool(multi, "rh_context", {
        operation: "search",
        query: "value = 1",
        retrieval_mode: "plan",
        include_globs: ["src/**"],
        max_files: 2,
      });
      expect(planRaw).toBeTruthy();
      const planned = JSON.parse(planRaw!.content[0].text);
      expect(planned.data.contextContract).toMatchObject({
        retrievalMode: "plan",
        semanticSufficiencyAuthority: "chatgpt",
        rawCodeRequiredForImplementation: true,
      });
      expect(planned.data.structuralContext.requestedMode).toBe("required");
    });
  });

  test("searches code and refuses to unlock dependencies without completion evidence", async () => {
    await withController(async (repoRoot, ctx) => {
      // Regression: max_files is a budget over matching candidates, not the
      // alphabetically first files in the whole repository.
      writeFileSync(join(repoRoot, "aaa-decoy.txt"), "not source\n");
      const searched = await jsonTool(ctx, "search_repository", {
        query: "value = 1",
        include_globs: ["src/**"],
        max_files: 1});
      expect(searched.value.results[0]).toMatchObject({
        path: "src/example.ts",
        line: 1});

      const created = await jsonTool(ctx, "create_issue", {
        title: "Controller workflow",
        kind: "feature",
        summary: "Exercise dependency-aware task state.",
        tasks: [
          {
            title: "First",
            objective: "First task",
            allowed_paths: ["src/**"],
            checks: ["manual-review"]},
          {
            title: "Second",
            objective: "Second task",
            depends_on: ["T1"],
            allowed_paths: ["src/**"]},
        ]});
      expect(
        created.value.tasks.map((task: { status: string }) => task.status),
      ).toEqual(["ready", "planned"]);

      await jsonTool(ctx, "update_task", {
        issue_id: created.value.id,
        task_id: "T1",
        status: "review"});
      const verified = await verifyTaskUntilSettled(ctx, {
        issue_id: created.value.id,
        task_id: "T1",
        reviewer: "test-controller",
        request_id: "verify-task-process-receipt",
        check_results: [{ check_id: "manual-review", ok: true }],
        acceptance_results: []}, { followDeferred: true });
      expect(verified.value.task.status).toBe("verified");
      const verifiedIssue = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id,
        detail_level: "full"});
      const receiptResult = verifiedIssue.value.tasks.find((entry: { id: string }) => entry.id === "T1")?.verification?.checkResults?.[0];
      expect(receiptResult).toMatchObject({
        checkId: "manual-review",
        ok: true,
        receipt: {
          issueId: created.value.id,
          taskId: "T1",
          checkId: "manual-review",
          status: "passed",
          ok: true,
          receiptId: expect.stringMatching(/^check_receipt_/),
          artifactPath: ".ai/harness/checks/controller/latest-manual-review.json",
        },
      });
      const accepted = await jsonTool(ctx, "accept_task", {
        issue_id: created.value.id,
        task_id: "T1"});
      expect(accepted.raw.isError).toBe(true);
      expect(accepted.value.error.message).toContain("complete delivery receipt");
      const unchanged = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id});
      expect(
        unchanged.value.tasks.map((task: { status: string }) => task.status),
      ).toEqual(["verified", "planned"]);
      const board = await jsonTool(ctx, "get_project_board", { detail_level: "detail" });
      expect(board.value.legacyTaskProjection).toBeUndefined();
    });
  });

  test("get_project_board defaults to a bounded Requirement Board with explicit execution diagnostics", async () => {
    await withController(async (_repoRoot, ctx) => {
      const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
      for (let index = 0; index < 10; index += 1) {
        createRequirement({ controllerHome }, {
          requirementId: `REQ-FILLER-${index}`,
          title: `User-visible result ${index}`,
          outcomeStatement: `Deliver a bounded user outcome ${index} without exposing the internal Task ledger. ${"x".repeat(500)}`,
        });
      }
      createRequirement({ controllerHome }, {
        requirementId: "REQ-DONE-MAINTENANCE",
        title: "Keep a completed result completed",
        outcomeStatement: "The user outcome remains done even when internal cleanup needs attention.",
      });
      updateRequirement({ controllerHome }, {
        requirementId: "REQ-DONE-MAINTENANCE",
        action: "test_activate",
        mutate: (current) => ({ ...current, state: "active" }),
      });
      updateRequirement({ controllerHome }, {
        requirementId: "REQ-DONE-MAINTENANCE",
        action: "test_complete_with_maintenance",
        mutate: (current) => ({ ...current, state: "done", needsAttention: true, attentionSummary: "Remove one historical projection later." }),
      });
      createRequirement({ controllerHome }, {
        requirementId: "REQ-USER-DECISION",
        title: "Ask only for a real decision",
        outcomeStatement: "Pause only when the user must choose a concrete option.",
      });
      updateRequirement({ controllerHome }, {
        requirementId: "REQ-USER-DECISION",
        action: "test_wait_for_decision",
        mutate: (current) => ({ ...current, state: "waiting_for_user", needsAttention: true, attentionSummary: "Choose whether to keep compatibility mode." }),
      });
      createRequirement({ controllerHome }, {
        requirementId: "REQ-INVALID-WAIT",
        title: "Do not invent a user decision",
        outcomeStatement: "An internal wait without a decision must not appear as waiting_for_user.",
      });
      updateRequirement({ controllerHome }, {
        requirementId: "REQ-INVALID-WAIT",
        action: "test_invalid_wait",
        mutate: (current) => ({ ...current, state: "waiting_for_user" }),
      });
      const legacyIssue = await jsonTool(ctx, "create_issue", {
        title: "Legacy execution diagnostics fixture",
        kind: "feature",
        tasks: [{ title: "Internal implementation task", objective: "Remain available only through explicit diagnostics." }],
      });
      expect(legacyIssue.raw.isError).not.toBe(true);

      const summary = await jsonTool(ctx, "get_project_board");
      expect(summary.raw.isError).not.toBe(true);
      expect(summary.value).toMatchObject({ detailLevel: "summary", view: "requirement_board", requirementCount: 13 });
      expect(summary.value.issues).toBeUndefined();
      expect(summary.value.readyTasks).toBeUndefined();
      expect(summary.value.runs).toBeUndefined();
      expect(summary.value.processes).toBeUndefined();
      expect(summary.value.requirements.length).toBeLessThanOrEqual(12);
      const done = summary.value.requirements.find((requirement: { requirementId: string }) => requirement.requirementId === "REQ-DONE-MAINTENANCE");
      expect(done).toMatchObject({ state: "done", needsAttention: true, blocker: "Remove one historical projection later." });
      const decision = summary.value.requirements.find((requirement: { requirementId: string }) => requirement.requirementId === "REQ-USER-DECISION");
      expect(decision).toMatchObject({ state: "waiting_for_user", requiredUserDecision: "Choose whether to keep compatibility mode." });
      const invalidWait = summary.value.requirements.find((requirement: { requirementId: string }) => requirement.requirementId === "REQ-INVALID-WAIT");
      expect(invalidWait.state).not.toBe("waiting_for_user");
      expect(summary.value.detailPointer).toEqual({ tool: "get_project_board", arguments: { detail_level: "detail" } });
      expect(Buffer.byteLength(JSON.stringify(summary.value), "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(summary.value.responseMeta.structuredPayloadBytes).toBeLessThanOrEqual(16 * 1024);

      const detail = await jsonTool(ctx, "get_project_board", { detail_level: "detail" });
      expect(detail.raw.isError).not.toBe(true);
      expect(detail.value).toMatchObject({ detailLevel: "detail", view: "execution_diagnostics" });
      expect(detail.value.legacyTaskProjection).toBeUndefined();
      expect(JSON.stringify(detail.value)).not.toContain("Internal implementation task");
      expect(detail.value.maintenanceFindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ requirementId: "REQ-DONE-MAINTENANCE", requirementState: "done", lifecycleUnaffected: true }),
      ]));
      expect(detail.value.projectionWarnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ requirementId: "REQ-INVALID-WAIT", code: "USER_DECISION_REQUIRED_TEXT_MISSING" }),
      ]));
      expect(detail.value.technicalDetailPointers).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: "work_list" }),
        expect.objectContaining({ tool: "workflow_watchdog_report" }),
      ]));
    });
  });

  test("update_task is bounded by default and preserves full detail opt-in", async () => {
    await withController(async (_repoRoot, ctx) => {
      const longObjective = "Update one status without returning every full Task definition. ".repeat(24);
      const created = await jsonTool(ctx, "create_issue", {
        title: "Bound update task response",
        kind: "feature",
        tasks: Array.from({ length: 20 }, (_unused, index) => ({
          title: `Task ${index} ${"y".repeat(400)}`,
          objective: `${longObjective}${index}`,
          allowed_paths: ["src/**", "tests/**", "docs/**"],
          checks: ["typecheck"],
        })),
      });
      expect(created.raw.isError).not.toBe(true);

      const summary = await jsonTool(ctx, "update_task", {
        issue_id: created.value.id,
        task_id: "T17",
        status: "running",
        note: "bounded summary",
      });
      expect(summary.raw.isError).not.toBe(true);
      expect(summary.value.detailLevel).toBe("summary");
      expect(summary.value.id).toBe(created.value.id);
      expect(summary.value.taskCount).toBe(20);
      expect(summary.value.tasks.length).toBeLessThanOrEqual(12);
      expect(summary.value.taskTruncatedCount).toBe(8);
      expect(summary.value.updatedTask).toMatchObject({ id: "T17", status: "running", effectiveStatus: "running" });
      expect(JSON.stringify(summary.value)).not.toContain(longObjective.slice(0, 120));
      expect(Buffer.byteLength(JSON.stringify(summary.value), "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect(summary.value.responseMeta.structuredPayloadBytes).toBeLessThanOrEqual(16 * 1024);

      const detail = await jsonTool(ctx, "update_task", {
        issue_id: created.value.id,
        task_id: "T17",
        note: "full detail",
        detail_level: "detail",
      });
      expect(detail.raw.isError).not.toBe(true);
      expect(detail.value.tasks.length).toBe(20);
      expect(detail.value.tasks[0].objective).toBeString();
      expect(detail.value.tasks[0].allowedPaths).toBeArray();
      expect(detail.value.tasks.find((task: { id: string }) => task.id === "T17")?.notes).toContain("full detail");
    });
  });

  test("verify_task safely backfills a declared done Task missing completion evidence", async () => {
    await withController(async (repoRoot, ctx) => {
      expect(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.name", "Test"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "initial"], { cwd: repoRoot }).status).toBe(0);
      const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).stdout.trim();
      const created = await jsonTool(ctx, "create_issue", {
        title: "Backfill legacy done evidence",
        kind: "feature",
        tasks: [
          { title: "First", objective: "Audit status", risk: "readonly" },
          { title: "Second", objective: "Continue after first", depends_on: ["T1"], risk: "readonly" },
        ],
      });
      await jsonTool(ctx, "update_task", {
        issue_id: created.value.id,
        task_id: "T1",
        status: "done",
      });

      const verified = await jsonTool(ctx, "verify_task", {
        issue_id: created.value.id,
        task_id: "T1",
        integrated_revision: revision,
        reviewer: "test-controller",
        check_results: [],
        acceptance_results: [],
      });
      expect(verified.value.error).toBeUndefined();
      expect(verified.raw.isError).not.toBe(true);
      expect(verified.value.task).toMatchObject({ status: "done", effectiveStatus: "done" });
      const stored = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id,
        detail_level: "full",
      });
      const receipt = stored.value.tasks.find((task: { id: string }) => task.id === "T1")?.verification?.completionReceipt;
      expect(receipt).toMatchObject({ targetBranch: "main", targetRevision: revision });

      expect(stored.value.tasks.find((task: { id: string }) => task.id === "T2")).toMatchObject({
        id: "T2",
        effectiveStatus: "ready",
      });
    });
  });

  test("verify_task defers repository lease conflicts without recording failed verification and retries with a fresh request", async () => {
    await withController(async (repoRoot, ctx) => {
      writeFileSync(
        join(repoRoot, ".forge/checks.json"),
        JSON.stringify({
          version: 1,
          checks: {
            blocker: {
              description: "Hold the repository build cache",
              command: [process.execPath, "-e", 'setTimeout(() => console.log("blocker-done"), 2500)'],
              timeoutMs: 10_000,
            },
            focused: {
              description: "Fast passing verification check",
              command: [process.execPath, "-e", 'console.log("focused-ok")'],
              timeoutMs: 10_000,
            },
            failing: {
              description: "Real failing verification check",
              command: [process.execPath, "-e", "process.exit(7)"],
              timeoutMs: 10_000,
            },
          },
        }),
      );
      const created = await jsonTool(ctx, "create_issue", {
        title: "Deferred verification lease conflict",
        kind: "feature",
        tasks: [{
          title: "Verify after contention",
          objective: "Do not confuse repository contention with source failure.",
          allowed_paths: ["src/**"],
          checks: ["focused"],
          acceptance_criteria: ["Verification remains truthful."],
        }],
      });
      await jsonTool(ctx, "update_task", {
        issue_id: created.value.id,
        task_id: "T1",
        status: "review",
      });
      const blocker = await jsonTool(ctx, "run_check", {
        check_id: "blocker",
        request_id: "verification-blocker",
      });
      expect(typeof blocker.value.processId === "string" || blocker.value.completed === true).toBe(true);

      const verificationArgs = {
        issue_id: created.value.id,
        task_id: "T1",
        reviewer: "test-controller",
        request_id: "verify-during-contention",
        check_results: [{ check_id: "focused" }],
        acceptance_results: [{ criterion: "Verification remains truthful.", ok: true }],
      };
      const deferred = await verifyTaskUntilSettled(ctx, verificationArgs);
      expect(deferred.raw.isError).not.toBe(true);
      const retryRequestId = String(deferred.value.retryRequestId);
      const blockingProcessId = String(deferred.value.conflict?.blockingProcessId);
      expect(deferred.value).toMatchObject({
        status: "verification_deferred",
        reason: "repository_resource_busy",
        issueId: created.value.id,
        taskId: "T1",
        checkId: "focused",
        conflict: {
          code: "PROCESS_LEASE_CONFLICT",
          blockingProcessId: expect.any(String),
        },
      });
      expect(retryRequestId).toMatch(/^verify-during-contention:retry:[a-f0-9]{16}$/);
      expect(retryRequestId).not.toBe(verificationArgs.request_id);

      const unchanged = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id,
        detail_level: "full",
      });
      const unchangedTask = unchanged.value.tasks.find((task: { id: string }) => task.id === "T1");
      expect(unchangedTask.status).toBe("review");
      expect(unchangedTask.verification).toBeUndefined();

      const controllerHome = process.env.FORGE_CONTROLLER_HOME!;
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const blockerSettled = await waitForProcess(
        controllerHome,
        repository.repoId,
        blockingProcessId,
        { timeoutMs: 5_000 },
      );
      expect(blockerSettled.completed).toBe(true);

      const verified = await verifyTaskUntilSettled(ctx, {
        ...verificationArgs,
        request_id: retryRequestId,
      }, { followDeferred: true });
      expect(verified.value.task.status).toBe("verified");
      const stored = await jsonTool(ctx, "get_issue", {
        issue_id: created.value.id,
        detail_level: "full",
      });
      const successfulProcessId = stored.value.tasks.find((task: { id: string }) => task.id === "T1")
        ?.verification?.checkResults?.[0]?.receipt?.processId;
      expect(successfulProcessId).toBeString();
      expect(successfulProcessId).not.toBe(deferred.value.processId);

      const failedIssue = await jsonTool(ctx, "create_issue", {
        title: "Real verification failure",
        kind: "feature",
        allow_while_focused: true,
        tasks: [{
          title: "Fail honestly",
          objective: "Keep real check failures authoritative.",
          allowed_paths: ["src/**"],
          checks: ["failing"],
        }],
      });
      await jsonTool(ctx, "update_task", {
        issue_id: failedIssue.value.id,
        task_id: "T1",
        status: "review",
      });
      const failed = await verifyTaskUntilSettled(ctx, {
        issue_id: failedIssue.value.id,
        task_id: "T1",
        reviewer: "test-controller",
        request_id: "verify-real-failure",
        check_results: [{ check_id: "failing" }],
        acceptance_results: [],
      }, { followDeferred: true });
      expect(failed.value.status).not.toBe("verification_deferred");
      expect(failed.value.task.status).toBe("changes_requested");
      const failedStored = await jsonTool(ctx, "get_issue", {
        issue_id: failedIssue.value.id,
        detail_level: "full",
      });
      expect(failedStored.value.tasks[0].verification.checkResults[0]).toMatchObject({
        checkId: "failing",
        ok: false,
        receipt: { exitCode: 7, status: "failed" },
      });
    });
  }, 15_000);

  test("rejects invalid and cyclic Task dependency graphs", async () => {
    await withController(async (_repoRoot, ctx) => {
      const missing = await jsonTool(ctx, "create_issue", {
        title: "Invalid dependency",
        tasks: [
          { title: "Broken", objective: "bad graph", depends_on: ["T9"] },
        ]});
      expect(missing.raw.isError).toBe(true);
      expect(missing.value.error.message).toContain("unknown task dependency");

      const cyclic = await jsonTool(ctx, "create_issue", {
        title: "Cycle",
        tasks: [
          { title: "One", objective: "one", depends_on: ["T2"] },
          { title: "Two", objective: "two", depends_on: ["T1"] },
        ]});
      expect(cyclic.raw.isError).toBe(true);
      expect(cyclic.value.error.message).toContain("cycle");
    });
  });

  test("runs only named focused checks from repository configuration", async () => {
    await withController(async (repoRoot, ctx) => {
      mkdirSync(join(repoRoot, ".forge"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".forge/checks.json"),
        JSON.stringify({
          version: 1,
          checks: {
            focused: {
              description: "Focused controller smoke check",
              command: [
                process.execPath,
                "-e",
                'setTimeout(() => console.log("focused-ok"), 2500)',
              ],
              timeoutMs: 10_000}}}),
      );
      const listed = await jsonTool(ctx, "list_checks");
      expect(
        listed.value.checks.map((check: { id: string }) => check.id),
      ).toContain("focused");
      const runStartedAt = Date.now();
      const submitted = (await Promise.race([
        jsonTool(ctx, "run_check", { check_id: "focused" }),
        Bun.sleep(5_000).then(() => {
          throw new Error("run_check remained synchronously blocked for 5 seconds");
        }),
      ])) as Awaited<ReturnType<typeof jsonTool>>;
      // Process Runtime returns within interactiveWait (≤800ms) as managed handle;
      // legacy Local Job path also returns immediately after enqueue. Allow headroom
      // for CI load without accepting a multi-second synchronous block.
      expect(Date.now() - runStartedAt).toBeLessThan(3_000);
      // Process Runtime path returns process handle; legacy path returns Local Job.
      if (submitted.value.job) {
        expect(["approved", "running"]).toContain(submitted.value.job.status);
        let finished = (
          await jsonTool(ctx, "get_local_job", {
            job_id: submitted.value.job.jobId})
        ).value.job;
        const runDeadline = Date.now() + 10_000;
        for (let attempt = 0; Date.now() < runDeadline && finished.status === "running"; attempt += 1) {
          await Bun.sleep(20);
          finished = (
            await jsonTool(ctx, "get_local_job", {
              job_id: submitted.value.job.jobId})
          ).value.job;
        }
        expect(finished.status).not.toBe("running");
        expect(finished.status).toBe("succeeded");
        expect(finished.result.stdout).toContain("focused-ok");
      } else {
        expect(["direct", "managed", "process_direct", "process_managed"]).toContain(
          String(submitted.value.mode ?? submitted.value.path),
        );
        expect(typeof submitted.value.processId === "string" || submitted.value.completed === true).toBe(true);
        // Managed handle returns quickly; direct may already be completed if interactive wait covers the 2.5s check.
        if (submitted.value.completed === true) {
          expect(String(submitted.value.stdout ?? "")).toContain("focused-ok");
        }
      }
    });
  });

  test("keeps short controller reads responsive while a long check is running", async () => {
    await withController(async (repoRoot, ctx) => {
      writeFileSync(
        join(repoRoot, ".forge/checks.json"),
        JSON.stringify({
          version: 1,
          checks: {
            focused: {
              description: "Delayed controller smoke check",
              command: [process.execPath, "-e", 'setTimeout(() => console.log("done"), 2500)'],
              timeoutMs: 10_000}}}),
      );
      expect(spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.name", "Test"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "initial"], { cwd: repoRoot }).status).toBe(0);
      const controllerHome = join(repoRoot, ".forge-controller-home");
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const started = await jsonTool(ctx, "run_check", { check_id: "focused" });
      // Accept Process Runtime handle or legacy Local Job — both must not block short reads.
      const hasJob = typeof started.value.job?.jobId === "string";
      const hasProcess = typeof started.value.processId === "string" || started.value.completed === true;
      expect(hasJob || hasProcess).toBe(true);
      const readsStartedAt = Date.now();
      const [controllerContext, repositoryGet, localStatus] = await Promise.all([
        jsonTool(ctx, "controller_context"),
        callRepositoryTool(controllerHome, "repository_get", { repo_id: repository.repoId }).then((result) => JSON.parse(result?.content[0]?.text ?? "{}")),
        jsonTool(ctx, "local_bridge_status"),
      ]);
      expect(Date.now() - readsStartedAt).toBeLessThan(2_500);
      expect(controllerContext.value.localBridge).toBeTruthy();
      expect(repositoryGet.detailLevel).toBe("summary");
      expect(repositoryGet.repository.repoId).toBe(repository.repoId);
      expect(repositoryGet.repository.activeCheckout.checkoutId).toBe(repository.activeCheckoutId);
      expect(repositoryGet.repository.checkoutCount).toBe(repository.checkouts.length);
      expect(repositoryGet.repository.checkouts).toBeUndefined();
      const repositoryDetail = await callRepositoryTool(controllerHome, "repository_get", {
        repo_id: repository.repoId,
        detail_level: "detail",
      }).then((result) => JSON.parse(result?.content[0]?.text ?? "{}"));
      expect(repositoryDetail.detailLevel).toBe("detail");
      expect(repositoryDetail.repository.checkouts.length).toBe(repository.checkouts.length);
      // Summary may leave endpoint null when no Local Bridge surface is configured.
      if (localStatus.value.endpoint != null) {
        expect(String(localStatus.value.endpoint)).toContain("127.0.0.1");
      }
      expect(localStatus.value.mode === undefined || typeof localStatus.value.mode === "string").toBe(true);
    });
  });

  test("repository_get archives a worktree removed outside Forge before exposing checkout lifecycle", async () => {
    await withController(async (repoRoot) => {
      expect(spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["config", "user.name", "Test"], { cwd: repoRoot }).status).toBe(0);
      writeFileSync(join(repoRoot, "README.md"), "fixture\n");
      expect(spawnSync("git", ["add", "."], { cwd: repoRoot }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "initial"], { cwd: repoRoot }).status).toBe(0);

      const controllerHome = join(repoRoot, ".forge-controller-home");
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const worktreeRoot = join(repoRoot, "stale-worktree");
      expect(spawnSync("git", ["worktree", "add", "-b", "stale-worktree", worktreeRoot], { cwd: repoRoot }).status).toBe(0);
      const withWorktree = addRepositoryCheckout({ repoId: repository.repoId, path: worktreeRoot, controllerHome });
      const checkout = withWorktree.checkouts.find((candidate) => candidate.worktree && candidate.branch === "stale-worktree");
      expect(checkout?.lifecycle).toBe("active");

      rmSync(worktreeRoot, { recursive: true, force: true });
      const inspected = await callRepositoryTool(controllerHome, "repository_get", {
        repo_id: repository.repoId,
        detail_level: "detail",
      }).then((result) => JSON.parse(result?.content[0]?.text ?? "{}"));
      const reconciled = inspected.repository.checkouts.find((candidate: { checkoutId?: string }) => candidate.checkoutId === checkout?.checkoutId);
      expect(reconciled?.lifecycle).toBe("archived");
      expect(reconciled?.lifecycleReason).toBe("Managed worktree root no longer exists.");
    });
  });

  test("returns structured local job output results through the controller tool layer", async () => {
    await withController(async (repoRoot, ctx) => {
      const jobDir = join(repoRoot, ".ai/harness/local-jobs", "JOB-output");
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, "job.json"), `${JSON.stringify({
        schemaVersion: 1,
        jobId: "JOB-output",
        action: "repository-command",
        payload: {
          controllerHome: join(repoRoot, ".forge-controller-home"),
          repoId: "repo-test",
          command: "printf 'hello\\n'"},
        requestedBy: "test",
        approval: "auto",
        status: "succeeded",
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
        finishedAt: "2026-07-05T00:00:01.000Z"}, null, 2)}\n`);

      const missing = await jsonTool(ctx, "get_local_job_output", {
        job_id: "JOB-output",
        stream: "stdout"});
      expect(missing.value.status).toBe("not_found");
      expect(missing.value.error.code).toBe("LOCAL_JOB_OUTPUT_NOT_FOUND");

      const traversal = await jsonTool(ctx, "get_local_job_output", {
        job_id: "../escape",
        stream: "stdout"});
      expect(traversal.value.status).toBe("rejected");
      expect(traversal.value.error.code).toBe("LOCAL_JOB_PATH_INVALID");
    });
  });

  test("applies SHA-guarded bounded edits and rolls them back", async () => {
    await withController(async (repoRoot, ctx) => {
      const read = await jsonTool(ctx, "read_workflow_file", {
        path: "src/example.ts"});
      const session = await jsonTool(ctx, "begin_edit_session", {
        purpose: "Change constant",
        allowed_paths: ["src/**"],
        max_files: 1,
        max_changed_lines: 5});
      const applied = await jsonTool(ctx, "apply_patch", {
        session_id: session.value.sessionId,
        operations: [
          {
            type: "replace",
            path: "src/example.ts",
            expected_sha256: read.value.sha256,
            replacements: [{ old_text: "value = 1", new_text: "value = 2" }]},
        ]});
      expect(applied.value.status).toBe("dirty");
      expect(readFileSync(join(repoRoot, "src/example.ts"), "utf-8")).toContain(
        "value = 2",
      );
      const rolledBack = await jsonTool(ctx, "rollback_edit_session", {
        session_id: session.value.sessionId});
      expect(rolledBack.value.status).toBe("rolled_back");
      expect(readFileSync(join(repoRoot, "src/example.ts"), "utf-8")).toContain(
        "value = 1",
      );
    });
  });

  test("rejects stale edit-session revisions and returns refreshed fingerprints", async () => {
    await withController(async (repoRoot, ctx) => {
      const read = await jsonTool(ctx, "read_workflow_file", {
        path: "src/example.ts"});
      const session = await jsonTool(ctx, "begin_edit_session", {
        purpose: "Change constant with revision guard",
        allowed_paths: ["src/**"]});
      const first = await jsonTool(ctx, "apply_patch", {
        session_id: session.value.sessionId,
        expected_revision: 0,
        operations: [
          {
            type: "replace",
            path: "src/example.ts",
            expected_sha256: read.value.sha256,
            replacements: [{ old_text: "value = 1", new_text: "value = 2" }]},
        ]});
      expect(first.value.currentRevision).toBe(1);
      const refreshed = await jsonTool(ctx, "read_workflow_file", {
        path: "src/example.ts"});

      const stale = await jsonTool(ctx, "apply_patch", {
        session_id: session.value.sessionId,
        expected_revision: 0,
        operations: [
          {
            type: "append",
            path: "src/example.ts",
            expected_sha256: refreshed.value.sha256,
            content: "export const stale = true;\n"},
        ]});
      expect(stale.raw.isError).toBe(true);
      expect(stale.value.error.code).toBe("EDIT_SESSION_REVISION_MISMATCH");
      expect(stale.value.error.details.currentRevision).toBe(1);
      expect(stale.value.error.details.expectedRevision).toBe(0);
      expect(stale.value.error.details.fingerprintRefresh[0].path).toBe("src/example.ts");
      expect(typeof stale.value.error.details.fingerprintRefresh[0].sha256).toBe("string");
      expect(readFileSync(join(repoRoot, "src/example.ts"), "utf-8")).not.toContain("stale = true");
    });
  });

  test("fails mixed stale batches safely without creating a partial revision", async () => {
    await withController(async (repoRoot, ctx) => {
      const read = await jsonTool(ctx, "read_workflow_file", {
        path: "src/example.ts"});
      const session = await jsonTool(ctx, "begin_edit_session", {
        purpose: "Safe partial failure",
        allowed_paths: ["src/**"]});
      writeFileSync(join(repoRoot, "src/example.ts"), "export const value = 9;\n");

      const failed = await jsonTool(ctx, "apply_patch", {
        session_id: session.value.sessionId,
        expected_revision: 0,
        operations: [
          {
            type: "replace",
            path: "src/example.ts",
            expected_sha256: read.value.sha256,
            replacements: [{ old_text: "value = 1", new_text: "value = 2" }]},
          {
            type: "create",
            path: "src/extra.ts",
            content: "export const extra = true;\n"},
        ]});

      expect(failed.raw.isError).toBe(true);
      expect(failed.value.error.code).toBe("EDIT_PATCH_PRECONDITION_FAILED");
      expect(failed.value.error.details.failures[0].code).toBe("STALE_FILE_SHA");
      expect(failed.value.error.details.appliedOperationCount).toBe(0);
      expect(failed.value.error.details.rolledBack).toBe(false);
      expect(existsSync(join(repoRoot, "src/extra.ts"))).toBe(false);

      const current = await jsonTool(ctx, "get_edit_session", {
        session_id: session.value.sessionId});
      expect(current.value.currentRevision).toBe(0);
      expect(current.value.status).toBe("open");
    });
  });

  test("rejects oversized patch batches before touching the workspace", async () => {
    await withController(async (repoRoot, ctx) => {
      const session = await jsonTool(ctx, "begin_edit_session", {
        purpose: "Large batch guard",
        allowed_paths: ["src/**"]});
      const operations = Array.from({ length: 101 }, (_, index) => ({
        type: "create",
        path: `src/generated-${index + 1}.ts`,
        content: `export const value${index + 1} = ${index + 1};\n`}));

      const failed = await jsonTool(ctx, "apply_patch", {
        session_id: session.value.sessionId,
        operations});

      expect(failed.raw.isError).toBe(true);
      expect(failed.value.error.code).toBe("EDIT_PATCH_BATCH_TOO_LARGE");
      expect(failed.value.error.details.requestedOperationCount).toBe(101);
      expect(failed.value.error.details.suggestedMaxOperationsPerBatch).toBe(100);
      expect(existsSync(join(repoRoot, "src/generated-1.ts"))).toBe(false);
    });
  });


  test("previews launch readiness and supports dynamic Task graph changes", async () => {
    await withController(async (_repoRoot, ctx) => {
      const created = await jsonTool(ctx, "create_issue", {
        title: "Dynamic launcher",
        summary: "Exercise readiness and task evolution.",
        goals: ["Launch only well-scoped work."],
        acceptance_criteria: ["All planned work is verified."],
        tasks: [
          {
            title: "Foundation",
            objective: "Prepare foundation.",
            allowed_paths: ["src/foundation/**"],
            checks: ["typecheck"],
            acceptance_criteria: ["Foundation is ready."]},
          {
            title: "Consumer",
            objective: "Use the foundation.",
            depends_on: ["T1"],
            allowed_paths: ["src/consumer/**"],
            checks: ["typecheck"],
            acceptance_criteria: ["Consumer uses the foundation."]},
        ]});
      const preview = await jsonTool(ctx, "prepare_issue_launch", {
        issue_id: created.value.id});
      expect(preview.value.readiness.ready).toBe(true);
      expect(
        preview.value.tasks.map((task: { id: string }) => task.id),
      ).toEqual(["T1"]);

      const appended = await jsonTool(ctx, "append_task", {
        issue_id: created.value.id,
        task: {
          title: "Verification",
          objective: "Verify integrated behaviour.",
          depends_on: ["T2"],
          allowed_paths: ["tests/**"],
          checks: ["test"],
          acceptance_criteria: ["Regression coverage exists."]}});
      expect(appended.value.tasks.at(-1).id).toBe("T3");

      const split = await jsonTool(ctx, "split_task", {
        issue_id: created.value.id,
        task_id: "T1",
        tasks: [
          {
            title: "Foundation model",
            objective: "Prepare model.",
            acceptance_criteria: ["Model is ready."]},
          {
            title: "Foundation service",
            objective: "Prepare service.",
            acceptance_criteria: ["Service is ready."]},
        ]});
      expect(
        split.value.tasks.find((task: { id: string }) => task.id === "T1")
          .status,
      ).toBe("superseded");
      expect(
        split.value.tasks.find((task: { id: string }) => task.id === "T2")
          .dependsOn,
      ).toEqual(["T4", "T5"]);
    });
  });

});
