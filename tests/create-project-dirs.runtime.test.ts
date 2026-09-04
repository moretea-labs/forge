import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const REFERENCE_STUB_MARKER = "<!-- forge: reference-config-stub v1 -->";
const RUNTIME_SMOKE_TIMEOUT_MS = 15000;

function expectReferenceConfigStub(cwd: string, docId: string): void {
  const content = readFileSync(join(cwd, "docs/reference-configs", `${docId}.md`), "utf-8");
  expect(content).toContain(REFERENCE_STUB_MARKER);
  expect(content).toContain(`> **Doc ID**: ${docId}`);
  expect(content).toContain(`forge docs path ${docId}`);
}

describe("create-project-dirs v1.5 runtime boundary", () => {
  test("scaffolds authored/declarative project state without repository Runtime state", () => {
    const cwd = mkdtempSync(join(tmpdir(), "create-project-dirs-v15-"));
    try {
      const res = spawnSync("bash", [join(ROOT, "scripts/create-project-dirs.sh")], {
        cwd,
        encoding: "utf-8",
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Project directory structure created successfully.");

      for (const path of [
        "forge.config.json",
        "docs/spec.md",
        "docs/researches/README.md",
        "tasks/todos.md",
        "tasks/lessons.md",
        "deploy/README.md",
        "AGENTS.md",
        "CLAUDE.md",
      ]) expect(existsSync(join(cwd, path))).toBe(true);

      const config = JSON.parse(readFileSync(join(cwd, "forge.config.json"), "utf-8"));
      expect(config).toEqual({ schemaVersion: 1, forge: { enabled: true }, runtimeState: "controller-home" });
      expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toBe(readFileSync(join(cwd, "CLAUDE.md"), "utf-8"));
      expect(readFileSync(join(cwd, "AGENTS.md"), "utf-8")).toContain("Controller Home");
      expectReferenceConfigStub(cwd, "agentic-development-flow");

      for (const retired of [
        "tasks/current.md",
        "tasks/contracts",
        "tasks/reviews",
        "tasks/notes",
        "tasks/workstreams",
        "plans/prds",
        "plans/sprints",
        ".ai/harness",
        ".ai/hooks",
        ".forge",
        ".codegraph",
        "_ops",
        ".repo-harness",
        "scripts/check-task-workflow.sh",
        "scripts/refresh-current-status.sh",
      ]) expect(existsSync(join(cwd, retired))).toBe(false);

      const gitignore = readFileSync(join(cwd, ".gitignore"), "utf-8");
      expect(gitignore).toContain("_ops/");
      expect(gitignore).toContain(".repo-harness/");
      expect(gitignore).toContain(".codegraph");
      expect(gitignore).toContain(".forge/browser");
      expect(gitignore).toContain(".forge/plugins");
      expect(gitignore).not.toContain("# forge generated helper wrappers");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, RUNTIME_SMOKE_TIMEOUT_MS);

  test("keeps functional-block AGENTS and CLAUDE context authored and explicit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "authored-context-"));
    const libPath = join(ROOT, "scripts/lib/project-init-lib.sh");
    try {
      mkdirSync(join(cwd, "apps/web"), { recursive: true });
      mkdirSync(join(cwd, "packages/ui"), { recursive: true });
      mkdirSync(join(cwd, ".ai/context"), { recursive: true });
      writeFileSync(join(cwd, ".ai/context/agent-context-blocks.txt"), "apps/web\n");
      const res = spawnSync("bash", ["-lc", [
        `source '${libPath}'`,
        'pi_install_root_context_files "$PWD" apply',
        'pi_install_directory_context_files "$PWD" apply',
      ].join("\n")], { cwd, encoding: "utf-8" });
      expect(res.status).toBe(0);
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(cwd, "apps/web/AGENTS.md"))).toBe(true);
      expect(existsSync(join(cwd, "apps/web/CLAUDE.md"))).toBe(true);
      expect(existsSync(join(cwd, "packages/ui/AGENTS.md"))).toBe(false);
      expect(existsSync(join(cwd, ".ai/harness"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, RUNTIME_SMOKE_TIMEOUT_MS);

  test("legacy harness-state helper now creates only authored knowledge surfaces", () => {
    const cwd = mkdtempSync(join(tmpdir(), "legacy-harness-helper-v15-"));
    const libPath = join(ROOT, "scripts/lib/project-init-lib.sh");
    try {
      const res = spawnSync("bash", ["-lc", [
        `source '${libPath}'`,
        'pi_ensure_harness_state_surface "$PWD" apply',
      ].join("\n")], { cwd, encoding: "utf-8" });
      expect(res.status).toBe(0);
      expect(existsSync(join(cwd, "tasks"))).toBe(true);
      expect(existsSync(join(cwd, "docs/researches/README.md"))).toBe(true);
      expect(existsSync(join(cwd, ".ai/harness"))).toBe(false);
      expect(existsSync(join(cwd, "tasks/current.md"))).toBe(false);
      expect(existsSync(join(cwd, "tasks/contracts"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, RUNTIME_SMOKE_TIMEOUT_MS);

  test("does not recreate repo-local hooks even when a legacy hook pin is present", () => {
    const cwd = mkdtempSync(join(tmpdir(), "legacy-hook-pin-v15-"));
    try {
      mkdirSync(join(cwd, ".ai/harness"), { recursive: true });
      writeFileSync(join(cwd, ".ai/harness/policy.json"), '{ "hook_source": "repo" }\n');
      const res = spawnSync("bash", [join(ROOT, "scripts/create-project-dirs.sh")], { cwd, encoding: "utf-8" });
      expect(res.status).toBe(0);
      expect(existsSync(join(cwd, ".ai/hooks/run-hook.sh"))).toBe(false);
      expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(false);
      expect(existsSync(join(cwd, ".codex/hooks.json"))).toBe(false);
      expect(existsSync(join(cwd, "forge.config.json"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, RUNTIME_SMOKE_TIMEOUT_MS);

  test("full documentation profile remains authored source without a runtime policy file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "full-doc-profile-v15-"));
    try {
      const res = spawnSync("bash", [join(ROOT, "scripts/create-project-dirs.sh")], {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, FORGE_DOCUMENTATION_PROFILE: "full" },
      });
      expect(res.status).toBe(0);
      for (const path of ["docs/brief.md", "docs/tech-stack.md", "docs/decisions.md", "docs/api"]) {
        expect(existsSync(join(cwd, path))).toBe(true);
      }
      expectReferenceConfigStub(cwd, "spa-day-protocol");
      expect(existsSync(join(cwd, ".ai/harness/policy.json"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, RUNTIME_SMOKE_TIMEOUT_MS);
});
