import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { getRepository, listRepositories, registerRepository } from "../../src/cli/repositories/registry";
import { callMcpTool } from "../../src/cli/mcp/tools";
import { callRepositoryTool, repositoryToolDefinitions } from "../../src/cli/mcp/repository-tools";
import { repositoryGitMergeBranch } from "../../src/cli/repositories/structured-git";
import { completionReceiptChangedPaths, inspectDirectTargetDelivery, inspectWorkTargetAdvance } from "../../src/runtime/gateway/mcp/execution-tools";
import { runtimeToolDefinitions } from "../../src/runtime/gateway/mcp/runtime-tools";
import { createMcpToolContext } from "../../src/cli/mcp/multi-repository";
import { getLocalBridgeJob, readLocalBridgeJobOutput, readLocalBridgeJobOutputSnapshot } from "../../src/cli/local-bridge/job-store";
import { routeDurableMcpCall } from "../../src/runtime/gateway/mcp/router";
import { getExecutionJob, listExecutionJobs } from "../../src/runtime/execution/jobs/store";
import { createWorkContract } from "../../src/runtime/control-plane/facade/work-contract-store";
import { claimControllerSession } from "../../src/runtime/control-plane/facade/controller-session-store";
import { applyExternalFilesystemGrant, previewExternalFilesystemGrant } from "../../src/runtime/safe-tooling/external-filesystem";
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from "../runtime/process-hygiene";
import { clearGitIdentityCacheForTest, clearGitSnapshotCacheForTest, gitSnapshot, gitSnapshotPerformanceSnapshot } from "../../src/cli/repository/inspector";

function git(root: string, args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

async function json(result: ReturnType<typeof callRepositoryTool>) {
  return JSON.parse((await result)?.content[0]?.text ?? "{}");
}

async function cleanupWorkspace(paths: string[]): Promise<void> {
  await terminateProcessesByCommand(paths); await waitForNoProcessesByCommand(paths);
}

function writeLocalJobFixture(
  repoRoot: string,
  jobId: string,
  status: "approved" | "running" | "succeeded" | "failed" = "succeeded",
  output: Partial<Record<"stdout" | "stderr", string>> = {},
): void {
  const dir = join(repoRoot, ".ai/harness/local-jobs", jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job.json"), `${JSON.stringify({
    schemaVersion: 1, jobId, action: "repository-command",
    payload: { controllerHome: join(repoRoot, ".controller-home"), repoId: "repo-test", command: "printf 'hello\\n'" },
    requestedBy: "test", approval: "auto", status,
    createdAt: "2026-07-05T00:00:00.000Z", updatedAt: "2026-07-05T00:00:00.000Z",
    ...(status === "succeeded" || status === "failed" ? { finishedAt: "2026-07-05T00:00:01.000Z" } : {}),
  }, null, 2)}\n`);
  if (output.stdout !== undefined) writeFileSync(join(dir, "stdout.log"), output.stdout);
  if (output.stderr !== undefined) writeFileSync(join(dir, "stderr.log"), output.stderr);
}

describe("repository MCP command tools", () => {
  test("documents the facade-first shortest path without widening the tool surface", () => {
    const rhContext = runtimeToolDefinitions.find((tool) => tool.name === "rh_context");
    const rhWork = runtimeToolDefinitions.find((tool) => tool.name === "rh_work");
    const command = repositoryToolDefinitions.find((tool) => tool.name === "repository_command_execute");
    expect(rhContext?.description).toContain("default repository code-discovery/read path");
    expect(rhContext?.description).toContain("fallback-only");
    expect(rhWork?.description).toContain("Requirement and Plan are not universal prerequisites");
    expect(command?.description).toContain("Use rh_context for routine code discovery/reading");
    for (const retired of ["repository_goal_list", "repository_goal_upsert", "repository_stuck_diagnose", "repository_goal_run", "repository_goal_runs"]) {
      expect(repositoryToolDefinitions.some((tool) => tool.name === retired)).toBe(false);
    }
  });

  test("guides chained shell code browsing back to one rh_context search", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-fragmented-read-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      writeFileSync(join(repoRoot, "tracked.txt"), "marker\n");
      git(repoRoot, ["add", "tracked.txt"]);
      git(repoRoot, ["commit", "-m", "init"]);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      const response = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "grep marker tracked.txt; cat tracked.txt",
        request_id: "fragmented-read-guidance",
      }));
      expect(response.ok).toBe(true);
      expect(response.guidance).toMatchObject({
        code: "FRAGMENTED_REPOSITORY_EXPLORATION",
        recommendedTool: "rh_context",
        recommendedOperation: "search",
      });
      expect(response.suggestedOperation).toBe("rh_context");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("does not let an unrelated active Work monopolize default-branch delivery", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-unrelated-work-delivery-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "base\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: "main" });

      git(repoRoot, ["switch", "-c", "feature/completed"]);
      writeFileSync(join(repoRoot, "completed.txt"), "done\n");
      git(repoRoot, ["add", "completed.txt"]);
      git(repoRoot, ["commit", "-m", "completed isolated work"]);
      git(repoRoot, ["switch", "main"]);

      const unrelatedWorkId = "WORK-UNRELATED-STABILIZATION";
      createWorkContract({ controllerHome, repoId: repository.repoId }, {
        workId: unrelatedWorkId,
        repoId: repository.repoId,
        mode: "goal_workloop",
        objective: "Keep verifying an unrelated stabilization goal.",
        acceptanceCriteria: ["verification continues independently"],
        allowedPaths: [],
        forbiddenPaths: [],
        checks: [],
        constraints: { requireHandoffOnAmbiguity: true },
        requestedBy: "chatgpt",
        status: "running",
      });
      claimControllerSession({ controllerHome, repoId: repository.repoId }, {
        workId: unrelatedWorkId,
        controllerId: "controller-chatgpt",
        controllerType: "chatgpt",
        sessionId: "session-chatgpt",
        principalId: "principal-chatgpt",
        controllerInstanceId: "runtime-chatgpt",
        leaseMs: 60_000,
      });
      const caller = { sessionId: "session-chatgpt", principalId: "principal-chatgpt", controllerInstanceId: "runtime-chatgpt" };

      const unboundPatch = await json(callRepositoryTool(controllerHome, "repository_safe_patch_apply", {
        repo_id: repository.repoId,
        purpose: "independent direct edit",
        operations: [{ type: "create", path: "direct-edit.txt", content: "independent\n" }],
      }, caller));
      expect(unboundPatch.status).toBe("applied");
      expect(unboundPatch.session.workId).toBeUndefined();

      const explicitlyBoundPatch = await json(callRepositoryTool(controllerHome, "repository_safe_patch_apply", {
        repo_id: repository.repoId,
        work_id: unrelatedWorkId,
        purpose: "explicit Work edit",
        operations: [{ type: "create", path: "work-edit.txt", content: "owned\n" }],
      }, caller));
      expect(explicitlyBoundPatch.status).toBe("applied");
      expect(explicitlyBoundPatch.session.workId).toBe(unrelatedWorkId);

      const merged = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: ["git", "merge", "feature/completed"],
        request_id: "merge-completed-unrelated-work",
      }, caller));
      expect(merged.error?.code).not.toBe("WORK_DELIVERY_REQUIRES_FINALIZE");
      expect(merged.exitCode).toBe(0);
      expect(readFileSync(join(repoRoot, "completed.txt"), "utf8")).toBe("done\n");

      git(repoRoot, ["switch", "-c", "feature/explicit-work"]);
      writeFileSync(join(repoRoot, "explicit.txt"), "pending\n");
      git(repoRoot, ["add", "explicit.txt"]);
      git(repoRoot, ["commit", "-m", "explicit work branch"]);
      git(repoRoot, ["switch", "main"]);
      const explicitlyAttributed = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        work_id: unrelatedWorkId,
        command: ["git", "merge", "feature/explicit-work"],
        request_id: "merge-explicit-active-work",
      }, caller));
      expect(explicitlyAttributed.error).toMatchObject({ code: "WORK_DELIVERY_REQUIRES_FINALIZE" });
      expect(existsSync(join(repoRoot, "explicit.txt"))).toBe(false);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("git snapshot skips diff-stat subprocess when status cannot produce an unstaged diff", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "forge-git-snapshot-fast-"));
    try {
      git(repoRoot, ["init", "-b", "main"]); git(repoRoot, ["config", "user.name", "Test"]); git(repoRoot, ["config", "user.email", "test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "clean\n"); git(repoRoot, ["add", "README.md"]); git(repoRoot, ["commit", "-m", "init"]); clearGitIdentityCacheForTest(); clearGitSnapshotCacheForTest();
      const clean = gitSnapshot(repoRoot); expect([clean.dirty, clean.diffStat, gitSnapshotPerformanceSnapshot().subprocesses]).toEqual([false, "", 1]);
      writeFileSync(join(repoRoot, "README.md"), "dirty\n"); clearGitSnapshotCacheForTest(); const dirty = gitSnapshot(repoRoot);
      expect(dirty.dirty).toBe(true); expect(dirty.diffStat).toContain("README.md"); expect(gitSnapshotPerformanceSnapshot().subprocesses).toBe(2);
    } finally { rmSync(repoRoot, { recursive: true, force: true }); clearGitIdentityCacheForTest(); clearGitSnapshotCacheForTest(); }
  });

  test("registering an existing repository worktree preserves canonical repository authority", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-register-worktree-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "source");
    const worktreeRoot = join(workspace, "release-source");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-q"]);
      git(repoRoot, ["config", "user.email", "forge@example.invalid"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["remote", "add", "origin", "https://github.com/moretea-labs/forge.git"]);
      writeFileSync(join(repoRoot, "README.md"), "# source\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-qm", "initial"]);
      const canonical = registerRepository({
        path: repoRoot,
        controllerHome,
        displayName: "canonical-name",
        // Regression: historical/controller-issued ids need not equal the
        // remote-derived hash used by newer registrations.
        repoIdOverride: "repo_fixture_legacy_controller_id",
      });
      git(repoRoot, ["worktree", "add", "--detach", worktreeRoot, "HEAD"]);

      const selectedWorktree = registerRepository({ path: worktreeRoot, controllerHome, displayName: "must-not-replace" });
      const persisted = getRepository(canonical.repoId, controllerHome);
      const worktreeCheckout = persisted.checkouts.find((checkout) => checkout.checkoutId === selectedWorktree.activeCheckoutId);

      expect(selectedWorktree.repoId).toBe(canonical.repoId);
      expect(selectedWorktree.canonicalRoot).toBe(realpathSync(worktreeRoot));
      expect(worktreeCheckout?.worktree).toBe(true);
      expect(persisted.canonicalRoot).toBe(realpathSync(repoRoot));
      expect(persisted.localRoot).toBe(realpathSync(repoRoot));
      expect(persisted.activeCheckoutId).toBe(canonical.activeCheckoutId);
      expect(persisted.displayName).toBe("canonical-name");
      expect(persisted.configurationPath).toBe(join(realpathSync(repoRoot), ".ai/harness/repository.json"));
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot, worktreeRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("worktree identity prefers the primary repository over an older linked-worktree alias", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-register-worktree-alias-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "source");
    const aliasRoot = join(workspace, "legacy-release-source");
    const nextWorktreeRoot = join(workspace, "next-worktree");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-q"]);
      git(repoRoot, ["config", "user.email", "forge@example.invalid"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      writeFileSync(join(repoRoot, "README.md"), "# source\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-qm", "initial"]);
      git(repoRoot, ["worktree", "add", "--detach", aliasRoot, "HEAD"]);

      const alias = registerRepository({
        path: aliasRoot,
        controllerHome,
        displayName: "legacy-alias",
        repoIdOverride: "repo_legacy_alias",
      });
      const primary = registerRepository({
        path: repoRoot,
        controllerHome,
        displayName: "primary",
        repoIdOverride: "repo_primary_authority",
      });
      expect(alias.repoId).not.toBe(primary.repoId);

      git(repoRoot, ["worktree", "add", "--detach", nextWorktreeRoot, "HEAD"]);
      const selected = registerRepository({ path: nextWorktreeRoot, controllerHome });
      expect(selected.repoId).toBe(primary.repoId);
      expect(selected.repoId).not.toBe(alias.repoId);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot, aliasRoot, nextWorktreeRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("diagnoses the latest sibling source tree through MCP without mutating the project directories", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-diagnose-"));
    const controllerHome = join(workspace, "controller-home");
    const staleRoot = join(workspace, "TinyMoments");
    const richRoot = join(workspace, "TinyMoments 1.7");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(staleRoot, { recursive: true });
      git(staleRoot, ["init", "-q"]);
      const registered = registerRepository({ path: staleRoot, controllerHome, displayName: "TinyMoments" });

      mkdirSync(richRoot, { recursive: true });
      mkdirSync(join(richRoot, "TinyMoments.xcodeproj"), { recursive: true });
      mkdirSync(join(richRoot, "App"), { recursive: true });
      writeFileSync(join(richRoot, "Package.swift"), "// swift package\n");
      writeFileSync(join(richRoot, "README.md"), "# TinyMoments\n");
      const canonicalRichRoot = realpathSync(richRoot);

      const response = await json(callRepositoryTool(controllerHome, "repository_latest_source_diagnose", {
        repo_id: registered.repoId,
      }));
      const ctx = createMcpToolContext({ repo: staleRoot, controllerHome, profile: "controller" });
      const capabilities = JSON.parse((await callMcpTool(ctx, "controller_capabilities")).content[0]?.text ?? "{}");

      expect(response.diagnosis.recommendedPath).toBe(canonicalRichRoot);
      expect(response.diagnosis.noMutation).toBe(true);
      // The tool still works when invoked directly, but the default ChatGPT
      // surface keeps source diagnostics / bootstrap behind explicit profiles.
      expect(capabilities.expectedTools).not.toContain("repository_latest_source_diagnose");
      expect(capabilities.expectedTools).not.toContain("repository_bootstrap_local_project");
      expect(capabilities.expectedTools).toContain("repository_command_execute");
      expect(existsSync(join(richRoot, ".git"))).toBe(false);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, staleRoot, richRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("bootstraps a non-Git local project through MCP", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-bootstrap-"));
    const controllerHome = join(workspace, "controller-home");
    const projectRoot = join(workspace, "PulseMetronomeApp");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, "PulseMetronome.xcodeproj"), { recursive: true });
      mkdirSync(join(projectRoot, "PulseMetronome"), { recursive: true });
      writeFileSync(join(projectRoot, "README.md"), "# PulseMetronome\n");
      writeFileSync(join(projectRoot, "build.sh"), "#!/usr/bin/env bash\nxcodebuild\n");

      const response = await json(callRepositoryTool(controllerHome, "repository_bootstrap_local_project", {
        path: projectRoot,
        display_name: "PulseMetronomeApp",
        confirm_authorization: true,
      }));
      expect(response.bootstrap.repository.repoId).toBeTruthy();
      expect(response.bootstrap.createdGit).toBe(true);
      expect(existsSync(join(projectRoot, ".git"))).toBe(true);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, projectRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("previews and executes repository-scoped git commands through MCP", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-command-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      writeFileSync(join(repoRoot, "tracked.txt"), "v1\n");

      const preview = callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "git add tracked.txt",
      });
      const previewValue = await json(preview);
      expect(previewValue.status).toBe("preview");
      expect(previewValue.classification.risk).toBe("workspace_write");
      expect(typeof previewValue.approvalToken).toBe("string");

      const executed = callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "git add tracked.txt",
        approval_token: previewValue.approvalToken,
        request_id: "repo-command-1",
      });
      const executedValue = await json(executed);
      expect(executedValue.accepted).toBe(true);
      expect(typeof executedValue.processId).toBe("string");
      expect(["succeeded", "running"]).toContain(executedValue.status);
      expect(executedValue.authorization).toMatchObject({ decision: "allow" });
      expect(executedValue.ok === true || executedValue.status === "running").toBe(true);

      const status = spawnSync("git", ["-C", repoRoot, "status", "--short"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Process Runtime applies the mutation directly; short git commands complete inline.
      if (executedValue.status === "succeeded" || executedValue.ok === true) {
        expect(status.stdout).toContain("A  tracked.txt");
      }
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("executes against an unregistered non-Git ephemeral workspace without mutating the Repository Registry", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ephemeral-workspace-"));
    const controllerHome = join(workspace, "controller-home");
    const localRoot = join(workspace, "plain-project");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(localRoot, { recursive: true });
      writeFileSync(join(localRoot, "note.txt"), "ephemeral hello\n");
      expect(listRepositories(controllerHome)).toHaveLength(0);
      expect(existsSync(join(localRoot, ".git"))).toBe(false);

      const preview = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        workspace_root: localRoot,
        command: ["cat", "note.txt"],
      }));
      expect(preview.status).toBe("preview");
      expect(preview.workspace).toMatchObject({ registered: false, root: realpathSync(localRoot) });
      expect(preview.workspace.workspaceId).toMatch(/^workspace_[a-f0-9]{24}$/);

      const read = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        workspace_root: localRoot,
        command: ["cat", "note.txt"],
        request_id: "ephemeral-read-1",
      }));
      expect(read.accepted).toBe(true);
      expect(read.ok).toBe(true);
      expect(read.stdout).toContain("ephemeral hello");
      expect(read.workspace).toEqual(preview.workspace);

      const writePreview = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        workspace_root: localRoot,
        command: ["touch", "created-by-ephemeral.txt"],
      }));
      expect(writePreview.status).toBe("preview");
      expect(writePreview.approvalToken).toBeTruthy();
      const write = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        workspace_root: localRoot,
        command: ["touch", "created-by-ephemeral.txt"],
        approval_token: writePreview.approvalToken,
        request_id: "ephemeral-write-1",
      }));
      expect(write.accepted).toBe(true);
      expect(write.ok).toBe(true);
      expect(existsSync(join(localRoot, "created-by-ephemeral.txt"))).toBe(true);
      expect(write.workspace).toEqual(preview.workspace);
      expect(write.authorization?.source).not.toBe("bounded_read_direct");

      const deleteAttempt = await json(callRepositoryTool(controllerHome, "repository_command_execute", { workspace_root: localRoot, command: ["rm", "-f", "created-by-ephemeral.txt"], request_id: "ephemeral-delete-through-harness" }));
      expect([deleteAttempt.accepted, deleteAttempt.status, deleteAttempt.authorization?.decision]).toEqual([true, "succeeded", "allow"]);
      expect(existsSync(join(localRoot, "created-by-ephemeral.txt"))).toBe(false);

      expect(listRepositories(controllerHome)).toHaveLength(0);
      expect(existsSync(join(localRoot, ".git"))).toBe(false);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, localRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("ephemeral workspace refuses target ambiguity, root escape, and durable execution without promotion", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ephemeral-scope-"));
    const controllerHome = join(workspace, "controller-home");
    const localRoot = join(workspace, "plain-project");
    const outside = join(workspace, "outside");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(localRoot, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "outside\n");

      const conflict = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        workspace_root: localRoot,
        repo_id: "repo_should_not_mix",
        command: ["pwd"],
      }));
      expect(conflict.error.code).toBe("EPHEMERAL_WORKSPACE_TARGET_CONFLICT");

      const escape = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        workspace_root: localRoot,
        cwd: "../outside",
        command: ["pwd"],
      }));
      expect(escape.error.code).toMatch(/WORKSPACE_SCOPE_MISMATCH|COMMAND_SCOPE_DENIED/);

      const durable = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        workspace_root: localRoot,
        command: ["cat", "missing.txt"],
        apply_mode: "async",
      }));
      expect(durable.accepted).toBe(false);
      expect(durable.path).toBe("ephemeral_workspace_promotion_required");
      expect(durable.suggestedOperation).toBe("repository_register");
      expect(listRepositories(controllerHome)).toHaveLength(0);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, localRoot, outside]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("Full Access does not require a preview token for ordinary repository execution", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-command-token-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      writeFileSync(join(repoRoot, "tracked.txt"), "v1\n");

      const executed = callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "git add tracked.txt",
        approval_token: "wrong-token",
      });
      const value = await json(executed);
      expect(value.accepted).toBe(true);
      expect(typeof value.processId).toBe("string");
      expect(["succeeded", "running"]).toContain(value.status);
      expect(value.authorization).toMatchObject({ decision: "allow" });
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });



  test("repository command preview requires external filesystem grants and supports authorized external read/copy", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-external-command-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    const externalRoot = join(workspace, "external-data");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(externalRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);
      writeFileSync(join(externalRoot, "note.txt"), "external note\n");
      const repository = registerRepository({ path: repoRoot, controllerHome });

      const deniedRead = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(externalRoot, "note.txt")}`,
      }));
      expect(deniedRead.error.code).toBe("EXTERNAL_FILESYSTEM_GRANT_REQUIRED");

      const readPreview = previewExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_read",
        root_path: externalRoot,
        mode: "read",
        reason: "Read fixture notes for repository review",
      });
      applyExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_read",
        root_path: externalRoot,
        mode: "read",
        reason: "Read fixture notes for repository review",
        preview_ticket_id: readPreview.previewTicketId,
        confirm_authorization: true,
      });
      const acceptedRead = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(externalRoot, "note.txt")}`,
      }));
      expect(acceptedRead.status).toBe("preview");
      expect(acceptedRead.externalPathUsages[0].operation).toBe("external_read");

      const deniedCopy = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cp ${join(externalRoot, "note.txt")} copied.txt`,
      }));
      expect(deniedCopy.error.code).toBe("EXTERNAL_FILESYSTEM_GRANT_REQUIRED");

      const copyPreview = previewExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_copy",
        root_path: externalRoot,
        mode: "copy_into_repo",
        reason: "Copy fixture notes into the selected repository",
      });
      applyExternalFilesystemGrant(repoRoot, {
        grant_key: "external_notes_copy",
        root_path: externalRoot,
        mode: "copy_into_repo",
        reason: "Copy fixture notes into the selected repository",
        preview_ticket_id: copyPreview.previewTicketId,
        confirm_authorization: true,
      });
      const acceptedCopy = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cp ${join(externalRoot, "note.txt")} copied.txt`,
      }));
      expect(acceptedCopy.status).toBe("preview");
      expect(acceptedCopy.externalPathUsages[0].operation).toBe("external_copy_into_workspace");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot, externalRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("repository command scope blocks expired grants, symlink escape, sensitive paths, and external writes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-external-command-deny-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    const externalRoot = join(workspace, "external-data");
    const fakeHome = join(workspace, "home");
    const fakeSsh = join(fakeHome, ".ssh");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(externalRoot, { recursive: true });
      mkdirSync(fakeSsh, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);
      writeFileSync(join(externalRoot, "note.txt"), "external note\n");
      writeFileSync(join(fakeSsh, "id_ed25519"), "secret\n");
      symlinkSync(join(externalRoot, "note.txt"), join(repoRoot, "escape-link.txt"));
      const repository = registerRepository({ path: repoRoot, controllerHome });

      const expiredPreview = previewExternalFilesystemGrant(repoRoot, {
        grant_key: "expired_notes",
        root_path: externalRoot,
        mode: "read",
        reason: "Expired grant fixture",
      });
      applyExternalFilesystemGrant(repoRoot, {
        grant_key: "expired_notes",
        root_path: externalRoot,
        mode: "read",
        reason: "Expired grant fixture",
        preview_ticket_id: expiredPreview.previewTicketId,
        confirm_authorization: true,
      });
      writeFileSync(join(repoRoot, ".forge/external-filesystem-grants.json"), `${JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        grants: [{
          schemaVersion: 1,
          key: "expired_notes",
          root: externalRoot,
          canonicalRoot: realpathSync(externalRoot),
          mode: "read",
          reason: "Expired grant fixture",
          createdAt: new Date().toISOString(),
          createdBy: "test",
          expiresAt: "2000-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`);
      const expired = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(externalRoot, "note.txt")}`,
      }));
      expect(expired.error.code).toBe("EXTERNAL_FILESYSTEM_GRANT_REQUIRED");

      const symlinkEscape = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "cat escape-link.txt",
      }));
      expect(symlinkEscape.error.code).toBe("COMMAND_SCOPE_DENIED");

      const sensitive = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `cat ${join(fakeSsh, "id_ed25519")}`,
      }));
      expect(sensitive.error.code).toBe("COMMAND_SCOPE_DENIED");

      const externalWrite = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: `printf 'x' > ${join(externalRoot, "out.txt")}`,
      }));
      expect(externalWrite.error.code).toBe("COMMAND_SCOPE_DENIED");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot, externalRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("repository command execute returns a compact handoff with inline output for short commands", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-command-handoff-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      const preview = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "printf 'alpha\\n'",
      }));
      const executed = await json(callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: "printf 'alpha\\n'",
        approval_token: preview.approvalToken,
        request_id: "repo-command-handoff-1",
      }));

      expect(executed.accepted).toBe(true);
      // Short readonly commands complete on Process Runtime Direct (no Durable Job).
      // Durable handoff remains for mutations / forced durable paths.
      if (executed.path === "process_direct" || executed.mode === "process_direct") {
        expect(executed.ok).toBe(true);
        expect(String(executed.stdout ?? "")).toContain("alpha");
        expect(executed.jobId).toBeUndefined();
        expect(executed.durableSideEffects?.executionJobCount ?? 0).toBe(0);
        expect(Buffer.byteLength(JSON.stringify(executed), "utf8")).toBeLessThan(16 * 1024);
      } else if (executed.path === "process_managed" || executed.mode === "process_managed") {
        // Shell strings remain conservatively managed. A busy host may return
        // the same bounded Process handle before its inline probation ends.
        expect(executed.status).toBe("running");
        expect(executed.processId).toBeTruthy();
        expect(executed.durableSideEffects?.executionJobCount ?? 0).toBe(0);
      } else {
        expect(executed.status).toBe("succeeded");
        expect(executed.localJob.stdout).toContain("alpha");
        expect(executed.localJob.stderr ?? "").toBe("");
        expect(executed.localJob.stdoutPath).toBe(`.ai/harness/local-jobs/${executed.jobId}/stdout.log`);
        expect(executed.localJob.nextLocalCommand).toContain(executed.jobId);
      }
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("repository command preview stays read-only and does not create a durable Job", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-command-preview-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      const ctx = createMcpToolContext({ repo: repoRoot, controllerHome, profile: "controller" });
      const durable = await routeDurableMcpCall(ctx, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "git status --short",
      });
      expect(durable).toBeUndefined();

      const preview = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: "git status --short",
      }));
      expect(preview.status).toBe("preview");
      expect(preview.approvalToken).toBeTruthy();
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("long-running command execution returns a non-terminal receipt without a false failure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-command-async-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    const longCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "console.log('start'); setTimeout(() => console.log('ready'), 3000);",
    )} ${JSON.stringify(repoRoot)}`;
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);

      const repository = registerRepository({ path: repoRoot, controllerHome });
      const preview = await json(callRepositoryTool(controllerHome, "repository_command_preview", {
        repo_id: repository.repoId,
        command: longCommand,
      }));
      expect(preview.status).toBe("preview");
      const executionPromise = callRepositoryTool(controllerHome, "repository_command_execute", {
        repo_id: repository.repoId,
        command: longCommand,
        approval_token: preview.approvalToken,
        request_id: "repo-command-async-1",
      });
      const executedValue = await json(executionPromise);
      expect(executedValue.accepted).toBe(true);
      expect(typeof executedValue.processId).toBe("string");
      expect(executedValue.status).toBe("running");
      expect(executedValue.authorization).toMatchObject({ decision: "allow" });
      expect(executedValue.ok).toBeUndefined();
      expect(executedValue.exitCode).toBeUndefined();
      expect(executedValue.error).toBeUndefined();
      expect(executedValue.jobId).toBeUndefined();
      expect(executedValue.localJob).toBeUndefined();
      expect(executedValue.next).toContain("Continue independent work");
      expect(executedValue.next).toContain("Do not re-run or periodically poll");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("local job output snapshots read stdout and stderr with structured bounded responses", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-local-job-output-"));
    const repoRoot = join(workspace, "repo");
    try {
      mkdirSync(repoRoot, { recursive: true });
      writeLocalJobFixture(repoRoot, "JOB-output", "succeeded", {
        stdout: "line-1\nline-2\n",
        stderr: "warn-1\n",
      });

      const stdout = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-output", { stream: "stdout" });
      expect(stdout.status).toBe("ok");
      expect(stdout.content).toContain("line-2");
      expect(stdout.path).toBe(".ai/harness/local-jobs/JOB-output/stdout.log");

      const stderr = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-output", { stream: "stderr" });
      expect(stderr.status).toBe("ok");
      expect(stderr.content).toContain("warn-1");
      expect(stderr.path).toBe(".ai/harness/local-jobs/JOB-output/stderr.log");
    } finally {
      await cleanupWorkspace([workspace, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("local job output snapshots return structured not-found, reject traversal, and respect max_bytes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-local-job-output-missing-"));
    const repoRoot = join(workspace, "repo");
    try {
      mkdirSync(repoRoot, { recursive: true });
      writeLocalJobFixture(repoRoot, "JOB-missing", "succeeded");
      writeLocalJobFixture(repoRoot, "JOB-running", "running");
      writeLocalJobFixture(repoRoot, "JOB-bounded", "succeeded", {
        stdout: "0123456789abcdef",
      });

      const missing = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-missing", { stream: "stdout" });
      expect(missing.status).toBe("not_found");
      expect(missing.error?.code).toBe("LOCAL_JOB_OUTPUT_NOT_FOUND");

      const notReady = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-running", { stream: "stdout" });
      expect(notReady.status).toBe("not_ready");
      expect(notReady.error?.code).toBe("LOCAL_JOB_OUTPUT_NOT_READY");

      const traversal = readLocalBridgeJobOutputSnapshot(repoRoot, "../escape", { stream: "stdout" });
      expect(traversal.status).toBe("rejected");
      expect(traversal.error?.code).toBe("LOCAL_JOB_PATH_INVALID");

      const bounded = readLocalBridgeJobOutputSnapshot(repoRoot, "JOB-bounded", { stream: "stdout", maxBytes: 4 });
      expect(bounded.status).toBe("ok");
      expect(bounded.truncated).toBe(true);
      expect(bounded.content).toBe("cdef");
    } finally {
      await cleanupWorkspace([workspace, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("durable repository_update can restore a disabled repository", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-mcp-repo-restore-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      const repository = registerRepository({ path: repoRoot, controllerHome });
      await json(callRepositoryTool(controllerHome, "repository_update", {
        repo_id: repository.repoId,
        enabled: false,
      }));

      const ctx = createMcpToolContext({ repo: repoRoot, controllerHome, profile: "controller" });
      // repository_update is a deterministic Kernel metadata operation; ExecutionJobs are retired.
      const restored = await json(callRepositoryTool(controllerHome, "repository_update", {
        repo_id: repository.repoId,
        enabled: true,
        request_id: "restore-disabled-repository",
      }));
      expect(restored.repository?.repoId).toBe(repository.repoId);
      expect(restored.repository?.enabled).toBe(true);
      // No ExecutionJob may be created for this restore path.
      expect(listExecutionJobs(controllerHome, repository.repoId, 20)).toHaveLength(0);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("safe patch apply splits repeated paths, refreshes fingerprints, and returns actionable failures", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-safe-patch-complete-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "app.txt"), "alpha\nbeta\n");
      git(repoRoot, ["add", "app.txt"]);
      git(repoRoot, ["commit", "-m", "init"]);
      const repository = registerRepository({ path: repoRoot, controllerHome });

      const applied = await json(callRepositoryTool(controllerHome, "repository_safe_patch_apply", {
        repo_id: repository.repoId,
        purpose: "safe patch complete test",
        operations: [
          { type: "replace", path: "app.txt", replacements: [{ old_text: "alpha", new_text: "alpha-1" }] },
          { type: "replace", path: "app.txt", replacements: [{ old_text: "beta", new_text: "beta-1" }] },
        ],
        chunk_size: 10,
      }));
      expect(applied.status).toBe("applied");
      expect(applied.appliedChunks.length).toBe(2);
      expect(applied.session.currentRevision).toBe(2);
      expect(applied.reviewEvidence).toMatchObject({
        source: "edit_session",
        revision: 2,
        truncated: false,
        semanticReviewAuthority: "chatgpt",
      });
      expect(applied.reviewEvidence.patchPreview).toContain("-alpha");
      expect(applied.reviewEvidence.patchPreview).toContain("+alpha-1");
      expect(applied.reviewEvidence.patchPreview).toContain("-beta");
      expect(applied.reviewEvidence.patchPreview).toContain("+beta-1");
      expect(readFileSync(join(repoRoot, "app.txt"), "utf-8")).toBe("alpha-1\nbeta-1\n");

      const failed = await json(callRepositoryTool(controllerHome, "repository_safe_patch_apply", {
        repo_id: repository.repoId,
        purpose: "safe patch failure context",
        operations: [
          { type: "replace", path: "app.txt", replacements: [{ old_text: "does-not-exist", new_text: "x" }] },
        ],
      }));
      expect(failed.status).toBe("failed");
      expect(failed.failures[0].code).toBe("REPLACEMENT_TEXT_NOT_FOUND");
      expect(failed.failures[0].context.focus).toContain("alpha-1");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("proves direct-target Work delivery without self-merging and preserves the original delivery revision after target advance", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-direct-target-delivery-"));
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Direct Target Test"]);
      git(repoRoot, ["config", "user.email", "direct-target@example.test"]);
      writeFileSync(join(repoRoot, "owned.txt"), "owned-v1\n");
      git(repoRoot, ["add", "owned.txt"]);
      git(repoRoot, ["commit", "-m", "owned delivery"]);
      const delivered = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

      expect(inspectDirectTargetDelivery(repoRoot, repoRoot, false, "main", "main", delivered)).toMatchObject({
        integrated: true,
        reason: "integrated",
        expectedHead: delivered,
        targetHead: delivered,
      });
      expect(inspectDirectTargetDelivery(repoRoot, repoRoot, true, "main", "main", delivered).reason).toBe("not_direct_target");
      expect(inspectDirectTargetDelivery(repoRoot, repoRoot, false, "feature/work", "main", delivered).reason).toBe("not_direct_target");

      writeFileSync(join(repoRoot, "advance.txt"), "independent target advance\n");
      git(repoRoot, ["add", "advance.txt"]);
      git(repoRoot, ["commit", "-m", "advance target"]);
      const advanced = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(advanced).not.toBe(delivered);
      expect(inspectDirectTargetDelivery(repoRoot, repoRoot, false, "main", "main", delivered)).toMatchObject({
        integrated: true,
        reason: "integrated",
        expectedHead: delivered,
        targetHead: advanced,
      });

      writeFileSync(join(repoRoot, "dirty.txt"), "uncommitted\n");
      expect(inspectDirectTargetDelivery(repoRoot, repoRoot, false, "main", "main", delivered).reason).toBe("dirty");
      rmSync(join(repoRoot, "dirty.txt"));

      git(repoRoot, ["switch", "-c", "unreachable"]);
      writeFileSync(join(repoRoot, "unreachable.txt"), "unique\n");
      git(repoRoot, ["add", "unreachable.txt"]);
      git(repoRoot, ["commit", "-m", "unreachable"]);
      const unreachable = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      git(repoRoot, ["switch", "main"]);
      expect(inspectDirectTargetDelivery(repoRoot, repoRoot, false, "main", "main", unreachable)).toMatchObject({
        integrated: false,
        reason: "not_reachable",
        expectedHead: unreachable,
        targetHead: advanced,
      });
    } finally {
      await cleanupWorkspace([workspace, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("structured git diff, commit, and finish workflow complete a feature branch", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-structured-git-complete-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "init"]);
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: "main" });

      const branch = await json(callRepositoryTool(controllerHome, "repository_git_create_branch", {
        repo_id: repository.repoId,
        branch: "feature/structured-flow",
      }));
      expect(branch.execution.ok).toBe(true);
      writeFileSync(join(repoRoot, "README.md"), "hello\nstructured\n");

      const diff = await json(callRepositoryTool(controllerHome, "repository_git_diff", {
        repo_id: repository.repoId,
        paths: ["README.md"],
      }));
      expect(diff.diff.patch).toContain("structured");

      const commit = await json(callRepositoryTool(controllerHome, "repository_git_commit", {
        repo_id: repository.repoId,
        paths: ["README.md"],
        message: "Update README through structured git",
      }));
      expect(commit.commit.committed).toBe(true);
      expect(commit.commit.after.clean).toBe(true);

      const finish = await json(callRepositoryTool(controllerHome, "repository_git_finish_workflow", {
        repo_id: repository.repoId,
        feature_branch: "feature/structured-flow",
        target_branch: "main",
      }));
      expect(finish.finish.completed).toBe(true);
      const branches = spawnSync("git", ["-C", repoRoot, "branch", "--list", "feature/structured-flow"], { encoding: "utf-8" });
      expect(branches.stdout.trim()).toBe("");
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("managed target-advance preflight distinguishes clean divergence and conflict while merge abort restores the isolated checkout", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-managed-target-advance-"));
    const controllerHome = join(workspace, "controller-home");
    const repoRoot = join(workspace, "sample-repo");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["config", "user.email", "forge-test@example.com"]);
      writeFileSync(join(repoRoot, "README.md"), "base\n");
      writeFileSync(join(repoRoot, "feature.txt"), "base\n");
      writeFileSync(join(repoRoot, "target.txt"), "base\n");
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-m", "base"]);
      const base = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: "main" });

      git(repoRoot, ["switch", "-c", "feature/clean"]);
      writeFileSync(join(repoRoot, "feature.txt"), "feature\n");
      git(repoRoot, ["add", "feature.txt"]);
      git(repoRoot, ["commit", "-m", "feature clean"]);
      const cleanCandidate = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      git(repoRoot, ["switch", "main"]);
      writeFileSync(join(repoRoot, "target.txt"), "target\n");
      git(repoRoot, ["add", "target.txt"]);
      git(repoRoot, ["commit", "-m", "target clean"]);
      const cleanTarget = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(inspectWorkTargetAdvance(repoRoot, cleanCandidate, cleanTarget).relation).toBe("diverged_clean");
      git(repoRoot, ["switch", "feature/clean"]);
      git(repoRoot, ["merge", "--no-ff", "main", "-m", "integrate target advance"]);
      const integratedCandidate = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(completionReceiptChangedPaths(repoRoot, cleanTarget, integratedCandidate)).toEqual(["feature.txt"]);

      git(repoRoot, ["switch", "-c", "feature/conflict", base]);
      writeFileSync(join(repoRoot, "README.md"), "feature-conflict\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "feature conflict"]);
      const conflictCandidate = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      git(repoRoot, ["switch", "main"]);
      writeFileSync(join(repoRoot, "README.md"), "target-conflict\n");
      git(repoRoot, ["add", "README.md"]);
      git(repoRoot, ["commit", "-m", "target conflict"]);
      const conflictTarget = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      expect(inspectWorkTargetAdvance(repoRoot, conflictCandidate, conflictTarget).relation).toBe("diverged_conflict");

      git(repoRoot, ["switch", "feature/conflict"]);
      const before = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const merge = repositoryGitMergeBranch(controllerHome, repository, { branch: "main", noFf: true, abortOnFailure: true });
      expect(merge.execution.ok).toBe(false);
      expect(merge.abort?.ok).toBe(true);
      expect(merge.after.clean).toBe(true);
      expect(spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe(before);
      expect(spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "MERGE_HEAD"], { encoding: "utf8" }).status).not.toBe(0);
    } finally {
      await cleanupWorkspace([workspace, controllerHome, repoRoot]);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("finish workflow transactionally rebases tracked target edits and rolls back on overlap", async () => { const workspace = mkdtempSync(join(tmpdir(), "forge-structured-git-dirty-target-")); const controllerHome = join(workspace, "controller-home"); const repoRoot = join(workspace, "sample-repo"); try { mkdirSync(controllerHome, { recursive: true }); mkdirSync(repoRoot, { recursive: true }); git(repoRoot, ["init", "-b", "main"]); git(repoRoot, ["config", "user.name", "Forge Test"]); git(repoRoot, ["config", "user.email", "forge-test@example.com"]); writeFileSync(join(repoRoot, "README.md"), "one\ntwo\nthree\n"); writeFileSync(join(repoRoot, "local.txt"), "base\n"); git(repoRoot, ["add", "."]); git(repoRoot, ["commit", "-m", "init"]); const repository = registerRepository({ path: repoRoot, controllerHome, defaultBranch: "main" }); git(repoRoot, ["switch", "-c", "feature/dirty-switch"]); writeFileSync(join(repoRoot, "local.txt"), "dirty-before-switch\n"); const switchBlocked = await json(callRepositoryTool(controllerHome, "repository_git_finish_workflow", { repo_id: repository.repoId, feature_branch: "feature/dirty-switch", target_branch: "main" })); expect(switchBlocked.finish.error.code).toBe("GIT_WORKTREE_NOT_CLEAN"); expect(spawnSync("git", ["-C", repoRoot, "branch", "--show-current"], { encoding: "utf8" }).stdout.trim()).toBe("feature/dirty-switch"); git(repoRoot, ["restore", "local.txt"]); git(repoRoot, ["switch", "main"]); git(repoRoot, ["branch", "-D", "feature/dirty-switch"]); git(repoRoot, ["switch", "-c", "feature/dirty-target"]); writeFileSync(join(repoRoot, "README.md"), "ONE\ntwo\nthree\n"); git(repoRoot, ["add", "README.md"]); git(repoRoot, ["commit", "-m", "feature"]); git(repoRoot, ["switch", "main"]); writeFileSync(join(repoRoot, "README.md"), "one\ntwo\nTHREE\n"); writeFileSync(join(repoRoot, "local.txt"), "local-dirty\n"); writeFileSync(join(repoRoot, "untracked.txt"), "keep\n"); git(repoRoot, ["add", "local.txt"]); const finish = await json(callRepositoryTool(controllerHome, "repository_git_finish_workflow", { repo_id: repository.repoId, feature_branch: "feature/dirty-target", target_branch: "main" })); expect(finish.finish.completed).toBe(true); expect(readFileSync(join(repoRoot, "README.md"), "utf8")).toBe("ONE\ntwo\nTHREE\n"); expect(readFileSync(join(repoRoot, "local.txt"), "utf8")).toBe("local-dirty\n"); expect(readFileSync(join(repoRoot, "untracked.txt"), "utf8")).toBe("keep\n"); expect(spawnSync("git", ["-C", repoRoot, "diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout.trim()).toBe("local.txt"); git(repoRoot, ["commit", "-m", "preserve local change for overlap setup"]); git(repoRoot, ["switch", "-c", "feature/overlap"]); writeFileSync(join(repoRoot, "README.md"), "feature-overlap\n"); git(repoRoot, ["add", "README.md"]); git(repoRoot, ["commit", "-m", "overlap feature"]); git(repoRoot, ["switch", "main"]); const oldHead = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(); writeFileSync(join(repoRoot, "README.md"), "local-overlap\n"); const blocked = await json(callRepositoryTool(controllerHome, "repository_git_finish_workflow", { repo_id: repository.repoId, feature_branch: "feature/overlap", target_branch: "main" })); expect(blocked.finish.completed).toBe(false); expect(blocked.finish.error.code).toBe("GIT_LOCAL_CHANGES_REAPPLY_CONFLICT"); expect(spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe(oldHead); expect(readFileSync(join(repoRoot, "README.md"), "utf8")).toBe("local-overlap\n"); expect(spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", "refs/heads/feature/overlap"]).status).toBe(0); expect(readFileSync(join(repoRoot, "untracked.txt"), "utf8")).toBe("keep\n"); } finally { await cleanupWorkspace([workspace, controllerHome, repoRoot]); rmSync(workspace, { recursive: true, force: true }); } });
});

describe("repository_register repeat fast path", () => {
  test("first MCP registration of an existing legacy-id worktree attaches without historical migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-register-worktree-fastpath-"));
    const controllerHome = join(root, "controller-home");
    const repoRoot = join(root, "repo");
    const worktreeRoot = join(root, "worktree");
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(join(repoRoot, "tasks", "issues"), { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.email", "forge@example.invalid"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["remote", "add", "origin", "https://github.com/moretea-labs/forge.git"]);
      writeFileSync(join(repoRoot, "README.md"), "# fixture\n");
      for (let index = 0; index < 25; index += 1) {
        writeFileSync(join(repoRoot, "tasks", "issues", `ISS-WT-${index}.issue.json`),
          `${JSON.stringify({ id: `ISS-WT-${index}`, status: "open", tasks: [] })}\n`);
      }
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-qm", "initial"]);
      const canonical = registerRepository({
        path: repoRoot,
        controllerHome,
        repoIdOverride: "repo_fixture_legacy_controller_id",
      });
      git(repoRoot, ["worktree", "add", "--detach", worktreeRoot, "HEAD"]);

      const response = await callRepositoryTool(controllerHome, "repository_register", {
        path: worktreeRoot,
        detail_level: "detail",
      });
      const value = JSON.parse(response?.content[0]?.text ?? "{}") as {
        repository?: { repoId?: string };
        migration?: { scanned?: number; unresolved?: number };
      };
      expect(value.repository?.repoId).toBe(canonical.repoId);
      expect(value.migration?.scanned).toBe(0);
      expect(value.migration?.unresolved).toBe(0);
    } finally {
      await cleanupWorkspace([root, controllerHome, repoRoot, worktreeRoot]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("metadata-only refresh preserves authority without rescanning historical entities", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-register-metadata-fastpath-"));
    try {
      const controllerHome = join(root, "controller-home");
      const repoRoot = join(root, "repo");
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(join(repoRoot, "tasks", "issues"), { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.email", "forge@example.invalid"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      git(repoRoot, ["remote", "add", "origin", "https://github.com/moretea-labs/matea.git"]);
      writeFileSync(join(repoRoot, "README.md"), "# fixture\n");
      for (let index = 0; index < 150; index += 1) {
        writeFileSync(join(repoRoot, "tasks", "issues", `ISS-META-${index}.issue.json`),
          `${JSON.stringify({ id: `ISS-META-${index}`, status: "open", tasks: [] })}\n`);
      }
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-qm", "initial"]);

      const firstResult = await callRepositoryTool(controllerHome, "repository_register", { path: repoRoot, detail_level: "detail" });
      const first = JSON.parse(firstResult?.content[0]?.text ?? "{}") as {
        repository?: { repoId?: string; activeCheckoutId?: string };
        migration?: { scanned?: number };
        responseMeta?: { serverDurationMs?: number };
      };
      expect(first.migration?.scanned).toBeGreaterThanOrEqual(150);

      const refreshedResult = await callRepositoryTool(controllerHome, "repository_register", {
        path: repoRoot,
        display_name: "Forge",
        remote_url: "https://github.com/moretea-labs/forge.git",
        default_branch: "main",
        detail_level: "detail",
      });
      const refreshed = JSON.parse(refreshedResult?.content[0]?.text ?? "{}") as {
        fastPath?: boolean;
        repository?: { repoId?: string; activeCheckoutId?: string; displayName?: string; canonicalRemote?: string };
        migration?: { scanned?: number; updated?: number; unresolved?: number };
        responseMeta?: { serverDurationMs?: number };
      };
      expect(refreshed.fastPath).toBe(true);
      expect(refreshed.repository?.repoId).toBe(first.repository?.repoId);
      expect(refreshed.repository?.activeCheckoutId).toBe(first.repository?.activeCheckoutId);
      expect(refreshed.repository?.displayName).toBe("Forge");
      expect(refreshed.repository?.canonicalRemote).toBe("github.com/moretea-labs/forge");
      expect(refreshed.migration).toMatchObject({ scanned: 0, updated: 0, unresolved: 0 });
      expect(refreshed.responseMeta?.serverDurationMs ?? Infinity).toBeLessThan(first.responseMeta?.serverDurationMs ?? 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repeat returns the same identity without a historical migration scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-register-fastpath-"));
    try {
      const controllerHome = join(root, "controller-home");
      const repoRoot = join(root, "repo");
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(join(repoRoot, "tasks", "issues"), { recursive: true });
      git(repoRoot, ["init", "-b", "main"]);
      git(repoRoot, ["config", "user.email", "forge@example.invalid"]);
      git(repoRoot, ["config", "user.name", "Forge Test"]);
      writeFileSync(join(repoRoot, "README.md"), "# fixture\n");
      for (let index = 0; index < 150; index += 1) {
        writeFileSync(join(repoRoot, "tasks", "issues", `ISS-${index}.issue.json`),
          `${JSON.stringify({ id: `ISS-${index}`, status: "open", tasks: [] })}\n`);
      }
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-qm", "initial"]);

      const register = async () => {
        const result = await callRepositoryTool(controllerHome, "repository_register", { path: repoRoot, detail_level: "detail" });
        return JSON.parse(result?.content[0]?.text ?? "{}") as {
          fastPath?: boolean;
          repository?: { repoId?: string; activeCheckoutId?: string };
          migration?: { scanned?: number; updated?: number; unresolved?: number };
          responseMeta?: { serverDurationMs?: number };
        };
      };
      const first = await register();
      expect(first.fastPath).toBe(false);
      expect(first.migration?.scanned).toBeGreaterThanOrEqual(150);
      const second = await register();
      expect(second.fastPath).toBe(true);
      expect(second.repository?.repoId).toBe(first.repository?.repoId);
      expect(second.repository?.activeCheckoutId).toBe(first.repository?.activeCheckoutId);
      expect(second.migration?.scanned).toBe(0);
      expect(second.migration?.updated).toBe(0);
      expect(second.migration?.unresolved).toBe(0);
      expect(second.responseMeta?.serverDurationMs ?? 0).toBeLessThan(
        (first.responseMeta?.serverDurationMs ?? 0) + 0.001,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
