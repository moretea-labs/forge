import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("Bootstrap Script Contracts", () => {
  test("SKILL.md should stay within 500-line budget", () => {
    const skill = read("SKILL.md");
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });

  test("router should advertise scaffold plus existing-repo maintenance paths", () => {
    const skill = read("SKILL.md");
    expect(skill).toContain("1. **Scaffold**");
    expect(skill).toContain("2. **Initialize**");
    expect(skill).toContain("3. **Migrate**");
    expect(skill).toContain("4. **Audit**");
    expect(skill).toContain("5. **Repair**");
    expect(skill).not.toContain("5. **Skill Factory**");
    expect(skill).not.toContain("references/skill-factory-guide.md");
    expect(existsSync(join(ROOT, "references/skill-factory-guide.md"))).toBe(false);
  });

  test("router keeps automatic Direct default while exposing explicit opt-in modes", () => {
    const skill = read("SKILL.md");
    expect(skill).toContain("understood bounded work still defaults to Direct Edit");
    expect(skill).toContain("`-plan` or `/plan`");
    expect(skill).toContain("`-debug` or `/debug`");
    expect(skill).toContain("Planning is read-only");
    expect(skill).toContain("`structural_context=required`");
    expect(skill).toContain("`structural_context=auto`");
    expect(skill).toContain("existing PlanContract");
    expect(skill).toContain("does not force an Agent or durable Work");
    expect(skill).toContain("never bypasses permissions");
    expect(skill).toContain("Mode directives are not sticky across turns");
  });

  test("Codex agent metadata should exist for user-level installation", () => {
    const metadata = read("agents/openai.yaml");
    expect(metadata).toContain("interface:");
    expect(metadata).toContain('display_name: "forge"');
    expect(metadata).toContain("short_description:");
    expect(metadata).toContain("default_prompt:");
  });

  test("repo root should describe Controller Home authority and keep hook implementation central", () => {
    expect(existsSync(join(ROOT, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(ROOT, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".claude/settings.json"))).toBe(false);
    expect(existsSync(join(ROOT, ".codex/hooks.json"))).toBe(false);
    expect(existsSync(join(ROOT, ".ai/hooks/run-hook.sh"))).toBe(false);
    expect(existsSync(join(ROOT, "assets/hooks/run-hook.sh"))).toBe(true);

    const claude = read("CLAUDE.md");
    const agents = read("AGENTS.md");

    for (const content of [claude, agents]) {
      expect(content).toContain("Controller Home");
      expect(content).toContain("tasks/todos.md");
      expect(content).toContain("legacy migration inputs");
      expect(content).not.toContain("Durable progress lives under");
      expect(content).not.toContain("tracked derived status snapshot");
    }
    expect(agents).toContain("bun run check:bootstrap-files");
    expect(agents).toContain("bun run check:repository-hygiene");
  });

  test("portable test runner keeps the ordinary lane bounded", () => {
    const runner = read("scripts/run-tests-portable.sh");
    const governance = read("scripts/test-governance.ts");
    expect(runner).toContain("exec bun scripts/test-governance.ts affected");
    expect(runner).toContain('exec bun scripts/test-governance.ts "$@"');
    expect(governance).toContain("gate: TestGate = 'affected'");
    expect(governance).toContain("validateTestManifest");
    expect(runner).not.toContain("BUN_TEST_FILE_COOLDOWN_SECONDS");
    expect(runner).not.toContain("git ls-files");
  });

  test("Forge package should expose workflow verification scripts", () => {
    const pkg = JSON.parse(read("package.json"));
    const cliEntry = read("src/cli/index.ts");
    expect(pkg.name).toBe("@moretea-labs/forge");
    expect(pkg.version).toMatch(/^1\.\d+\.\d+(?:-rc\.\d+)?$/);
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({
      forge: "bin/forge.mjs",
      "forge-hook": "bin/forge-hook.mjs",
      "forge-runtime": "bin/forge-runtime.mjs",
    });
    expect(pkg.files).toContain("assets/");
    expect(pkg.files).not.toContain("docs/reference-configs/");
    expect(cliEntry).toContain("CLI_VERSION");
    expect(cliEntry).toContain("buildDocsCommand");
    expect(cliEntry).not.toMatch(/\\.version\\(['\"][0-9]+\\.[0-9]+\\.[0-9]+['\"]\\)/);
    expect(pkg.scripts["check:ci"]).toBe("bun run check:main");
    expect(pkg.scripts["check:task"]).toBe("bun scripts/run-governed-gate.ts task");
    expect(pkg.scripts["check:main"]).toBe("bun scripts/run-governed-gate.ts main");
    for (const script of [
      "check:brain-manifest",
      "check:context-files",
      "check:deploy-sql",
      "check:architecture-sync",
      "check:task-sync",
      "check:task-workflow",
      "sync:brain-docs",
    ]) {
      expect(pkg.scripts[script]).toStartWith("bun src/cli/index.ts run ");
      expect(pkg.scripts[script]).not.toStartWith("forge run ");
    }
    expect(pkg.scripts["check:brain-manifest"]).toBe("bun src/cli/index.ts run check-brain-manifest");
    expect(pkg.scripts["check:task-sync"]).toBe("bun src/cli/index.ts run check-task-sync");
    expect(pkg.scripts["check:deploy-sql"]).toBe("bun src/cli/index.ts run check-deploy-sql-order");
    expect(pkg.scripts["check:architecture-sync"]).toBe("bun src/cli/index.ts run check-architecture-sync");
    expect(pkg.scripts["check:task-workflow"]).toBe("bun src/cli/index.ts run check-task-workflow --strict");
    expect(pkg.scripts["check:context-files"]).toBe("bun src/cli/index.ts run check-context-files");
    expect(pkg.scripts["sync:brain-docs"]).toBe("bun src/cli/index.ts run sync-brain-docs --all");
  });

  test("ci gate should delegate to the content-addressed main gate", () => {
    const ciGate = read("scripts/check-ci.sh");
    const bunfig = read("bunfig.toml");

    expect(bunfig).toContain("maxConcurrency = 4");
    expect(ciGate).toContain("exec bun run check:main");
    expect(ciGate).not.toContain("bun install");
    expect(ciGate).not.toContain("npm pack");
  });

  test("release gate should delegate owned checks to the release-readiness gate", () => {
    const releaseGate = read("scripts/check-npm-release.sh");
    const readinessGate = read("scripts/check-release-readiness.sh");
    const pkg = JSON.parse(read("package.json"));
    expect(releaseGate).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}"');
    expect(releaseGate).toContain("bun run check:release");
    expect(releaseGate.indexOf("bun run check:release")).toBeGreaterThan(
      releaseGate.indexOf('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}"')
    );
    expect(readinessGate).toContain('node scripts/run-bounded-command.mjs --timeout-ms 180000 -- bash scripts/check-tarball-install-smoke.sh "$TARBALL_PATH"');
    expect((readinessGate.match(/npm pack/g) ?? []).length).toBe(2);
    expect(pkg.scripts["check:release-published"]).toBe("bash scripts/check-release-published.sh");
    expect(pkg.scripts["smoke:tarball-install"]).toBe("node scripts/run-bounded-command.mjs --timeout-ms 180000 -- bash scripts/check-tarball-install-smoke.sh");
  });

  test("create-project-dirs should scaffold only the v1.5 repository-authored workflow surface", () => {
    const content = read("scripts/create-project-dirs.sh");
    const sharedLib = read("scripts/lib/project-init-lib.sh");
    const contract = JSON.parse(read("assets/workflow-contract.v1.json"));

    expect(content).toContain("create_contract_directories");
    expect(content).toContain("cat > tasks/todos.md");
    expect(content).toContain("cat > tasks/lessons.md");
    expect(content).toContain("cat > docs/researches/README.md");
    expect(content).toContain("cat > docs/spec.md");
    expect(content).toContain("install_workflow_contract");
    expect(content).toContain("pi_install_reference_configs");
    expect(content).not.toContain("install_workflow_helpers");
    expect(content).not.toContain("pi_install_templates");
    expect(content).not.toContain("docs/TODO.md");

    expect(contract.version).toBe("1.5.0");
    expect(contract.artifacts.runtimeManifest).toBe("forge.config.json");
    expect(contract.artifacts.requiredDirectories).toEqual([
      "docs",
      "docs/reference-configs",
      "docs/researches",
      "tasks",
    ]);
    expect(contract.artifacts.requiredFiles).toEqual([
      "forge.config.json",
      "docs/spec.md",
      "tasks/todos.md",
      "tasks/lessons.md",
    ]);
    for (const retired of [
      "tasks/current.md",
      ".ai/harness/workflow-contract.json",
      "scripts/capture-plan.sh",
      "scripts/contract-run.ts",
    ]) {
      expect(contract.artifacts.requiredFiles).not.toContain(retired);
    }
    for (const retired of ["tasks/contracts", "tasks/reviews", "tasks/notes", "tasks/workstreams", ".ai/harness"]) {
      expect(contract.artifacts.requiredDirectories).not.toContain(retired);
    }
    for (const legacyRuntimePath of [".ai/harness/", ".forge/plugins/", ".forge/browser/", ".codegraph/"]) {
      expect(contract.artifacts.legacyRuntimePaths).toContain(legacyRuntimePath);
    }
    expect(contract.documents.currentStatus).toBeUndefined();
    expect(contract.documents.implementationNotesDirectory).toBeUndefined();

    expect(sharedLib).toContain("Controller Home");
    expect(sharedLib).toContain('"check:task": "forge run check-task-workflow --strict"');
    expect(sharedLib).toContain('rm -rf "$hooks_dir/lib"');
    expect(sharedLib).not.toContain('cp "$hook_lib" "$hooks_dir/lib/$lib_name"');
    expect(sharedLib).not.toContain('"path": "tasks/workstreams/**/*.md"');
    expect(sharedLib).toContain(".codegraph\n.codegraph/");
    expect(sharedLib).toContain(".forge/browser");
    expect(sharedLib).toContain(".forge/plugins");
  });

  test("init-project should use the package runtime without recreating repo-local lifecycle machinery", () => {
    const content = read("scripts/init-project.sh");
    const sharedLib = read("scripts/lib/project-init-lib.sh");
    const contract = JSON.parse(read("assets/workflow-contract.v1.json"));

    expect(content).toContain("create_contract_directories");
    expect(content).toContain("cat > tasks/todos.md");
    expect(content).toContain("cat > tasks/lessons.md");
    expect(content).toContain("docs/researches/README.md");
    expect(content).toContain("install_workflow_contract");
    expect(content).toContain("pi_install_reference_configs");
    expect(content).toContain("ensure_runtime_gitignore_block");
    expect(content).toContain("install_hook_settings_template");
    expect(content).toContain("Controller Home");
    expect(content).toContain("Use Forge /plan only when real decomposition is needed");
    expect(content).not.toContain("pi_install_helpers");
    expect(content).not.toContain("pi_install_templates");
    expect(content).not.toContain("mkdir -p .claude/templates");
    expect(content).not.toContain("capture-plan.sh --slug");
    expect(content).not.toContain("plan-to-todo.sh --plan");
    expect(content).not.toContain("docs/TODO.md");

    for (const exactIgnore of ['".codegraph"', '".forge/browser"', '".forge/plugins"']) {
      expect(content).toContain(exactIgnore);
    }
    expect(sharedLib).toContain('"check:task": "forge run check-task-workflow --strict"');
    expect(sharedLib).toContain('pkg.scripts["check:task"] = "forge run check-task-workflow --strict";');
    expect(sharedLib).toContain("Controller Home");
    expect(sharedLib).not.toContain('"path": "tasks/workstreams/**/*.md"');

    expect(contract.artifacts.runtimeManifest).toBe("forge.config.json");
    expect(contract.artifacts.requiredFiles).toEqual([
      "forge.config.json",
      "docs/spec.md",
      "tasks/todos.md",
      "tasks/lessons.md",
    ]);
    expect(contract.artifacts.requiredDirectories).toEqual([
      "docs",
      "docs/reference-configs",
      "docs/researches",
      "tasks",
    ]);
  });

  test("prompt-guard should monitor tasks-first files", () => {
    const content = read("assets/hooks/prompt-guard.sh");
    const workflowState = read("assets/hooks/lib/workflow-state.sh");

    expect(content).toContain("tasks/todos.md");
    expect(content).toContain("tasks/lessons.md");
    expect(content).toContain("docs/researches/");
    expect(workflowState).toContain("git status --porcelain=v1");
    expect(content).toContain("has_changes_glob");
    expect(content).toContain("PlanStatusGuard");
    expect(content).toContain("ensure-task-workflow.sh");
    // Block-path guards must use exit 2 so Claude Code's hook protocol treats
    // them as blocking and surfaces stderr to the model (exit 1 is reported as
    // "non-blocking status code: No stderr output").
    expect(content).toContain("exit 2");
  });

  test("cross-review skills should include dirty working tree scope", () => {
    const claudeReview = read("assets/skills/claude-review/SKILL.md");
    const codexReview = read("assets/skills/codex-review/SKILL.md");

    expect(claudeReview).toContain("BRANCH_DIFF=$(git diff");
    expect(claudeReview).toContain("STAGED_DIFF=$(git diff --cached");
    expect(claudeReview).toContain("UNSTAGED_DIFF=$(git diff");
    expect(claudeReview).toContain("git ls-files --others --exclude-standard -z");
    expect(claudeReview).toContain("git diff --no-index -- /dev/null");
    expect(claudeReview).toContain("BASE=origin/main");
    expect(claudeReview).toContain("else BASE=HEAD");
    expect(claudeReview).toContain("Review the combined branch, staged, unstaged, and untracked changes");
    expect(claudeReview).toContain("run_with_optional_timeout claude -p");
    expect(claudeReview).toContain("recover_claude_review_from_transcript");
    expect(claudeReview).toContain("~/.claude/projects/<project>/<session-id>.jsonl");
    expect(claudeReview).toContain("CLAUDE_CONFIG_DIR");
    expect(claudeReview).toContain("stdout was empty; output above was recovered from the session transcript");
    expect(claudeReview).toContain("intentionally does not pass `--no-session-persistence`");
    expect(claudeReview).not.toContain("${TO:+$TO 330}");

    expect(codexReview).toContain("committed branch diff");
    expect(codexReview).toContain("git diff --cached");
    expect(codexReview).toContain("unstaged tracked changes");
    expect(codexReview).toContain("git ls-files --others --exclude-standard");
    expect(codexReview).toContain("git diff --no-index -- /dev/null <file>");
    expect(codexReview).toContain("BASE=origin/main");
    expect(codexReview).toContain("else BASE=HEAD");
    expect(codexReview).toContain("run_with_optional_timeout codex exec");
    expect(codexReview).not.toContain("${TO:+$TO 330}");
  });

  test("hook template should reference existing local hook scripts", () => {
    const settings = read("assets/hooks/settings.template.json");
    const codexHooks = read("assets/hooks/codex.hooks.template.json");
    const hookCommands = [...`${settings}\n${codexHooks}`.matchAll(/\.ai\/hooks\/([A-Za-z0-9.-]+\.sh)/g)].map((m) => m[1]);

    expect(hookCommands.length).toBeGreaterThan(0);
    for (const fileName of hookCommands) {
      expect(existsSync(join(ROOT, "assets/hooks", fileName))).toBe(true);
    }

    expect(hookCommands).toContain("run-hook.sh");
    expect(settings).toContain(".ai/hooks/run-hook.sh");
    expect(codexHooks).toContain(".ai/hooks/run-hook.sh");
    expect(settings).toContain("worktree-guard.sh");
    expect(settings).toContain("pre-edit-guard.sh");
    expect(settings).toContain("subagent-return-channel-guard.sh");
    expect(settings).toContain("post-edit-guard.sh");
    expect(settings).toContain("prompt-guard.sh");
    expect(settings).not.toContain("autoresearch-advisory.sh");
    expect(codexHooks).not.toContain("autoresearch-advisory.sh");
    expect(settings).toContain("stop-orchestrator.sh");
    expect(settings).toContain("post-bash.sh");
    expect(settings).toContain("post-tool-observer.sh");
    expect(settings).not.toContain("trace-event.sh");
    expect(settings).not.toContain("context-pressure-hook.sh");
    expect(settings).toContain("session-start-context.sh");
    expect(settings).not.toContain("memory-intake.sh");
    expect(settings).not.toContain("skill-factory-session-end.sh");
    expect(settings).not.toContain("bash -lc");
    expect(settings).not.toContain("atomic-pending.sh");
    expect(settings).not.toContain("atomic-commit.sh");
    expect(settings).not.toContain("\"$TOOL_INPUT\"");
    expect(settings).not.toContain("\"$PROMPT\"");
  });

  test("setup script should delegate to the canonical install path", () => {
    const setup = read("scripts/setup-plugins.sh");
    expect(setup).toContain("forge install");
    expect(setup).toContain('bun "$ROOT_DIR/src/cli/index.ts" install');
    expect(setup).not.toContain("ESSENTIAL_PLUGINS");
    expect(setup).not.toContain("feature-dev");
  });

  test("hook docs and scripts should use ToolUse event names", () => {
    const skill = read("SKILL.md");
    const setup = read("scripts/setup-plugins.sh");
    const legacyPre = `PreTool${"Call"}`;
    const legacyPost = `PostTool${"Call"}`;

    expect(skill).not.toContain(legacyPre);
    expect(skill).not.toContain(legacyPost);
    expect(setup).not.toContain(legacyPre);
    expect(setup).not.toContain(legacyPost);
  });
});
