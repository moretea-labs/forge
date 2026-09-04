import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");

const REQUIRED_ARCHITECTURE_DOCS: Record<string, string> = {
  "README.md": "architecture/CURRENT.md",
  "ROADMAP.md": "Forge Roadmap",
  "architecture/CURRENT.md": "Work is a continuity/orchestration mechanism\nstable **19-tool** surface",
  "architecture/EVOLUTION.md": "Historical Design — Not Runtime Authority",
  "architecture/versions/1.6.md": "Version Snapshot — Not Runtime Authority",
  "../CHANGELOG.md": "Changelog",
  "architecture/current/README.md": "Not Runtime Authority",
  "architecture/history.md": "Not Runtime Authority",
};

function installRuntimeArchitectureBaseline(cwd: string): void {
  mkdirSync(join(cwd, "docs/architecture/current"), { recursive: true });
  mkdirSync(join(cwd, "docs/architecture/versions"), { recursive: true });
  for (const [file, marker] of Object.entries(REQUIRED_ARCHITECTURE_DOCS)) {
    const path = file.startsWith("../") ? join(cwd, file.slice(3)) : join(cwd, "docs", file);
    mkdirSync(dirname(path), { recursive: true });
    const runtimeAuthority = file === "architecture/CURRENT.md" ? "\nStatus: **Runtime Authority**\n" : "";
    writeFileSync(path, `# ${file}\n${runtimeAuthority}\n${marker}\n`);
  }
  writeFileSync(
    join(cwd, "docs/architecture/index.md"),
    [
      "# Architecture Index",
      "",
      "Runtime Authority: CURRENT.md",
      "",
      "## Pending Architecture Requests",
      "",
      "<!-- BEGIN ARCHITECTURE PENDING REQUESTS -->",
      "- (none)",
      "<!-- END ARCHITECTURE PENDING REQUESTS -->",
      "",
    ].join("\n"),
  );
}

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: "utf-8" });
}

function tmpRepo(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "architecture-sync-"));
  try {
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    mkdirSync(join(cwd, ".ai/context"), { recursive: true });
    mkdirSync(join(cwd, ".ai/harness"), { recursive: true });
    mkdirSync(join(cwd, "docs/architecture/requests"), { recursive: true });
    for (const file of [
      "check-architecture-sync.sh",
      "architecture-queue.sh",
      "architecture-event.ts",
      "capability-resolver.ts",
    ]) {
      copyFileSync(join(ROOT, "assets/templates/helpers", file), join(cwd, "scripts", file));
    }
    chmodSync(join(cwd, "scripts/check-architecture-sync.sh"), 0o755);
    chmodSync(join(cwd, "scripts/architecture-queue.sh"), 0o755);
    writeFileSync(
      join(cwd, ".ai/context/capabilities.json"),
      JSON.stringify(
        {
          version: 1,
          capabilities: [
            {
              id: "apps-web",
              domain: "apps-web",
              name: "web",
              prefixes: ["apps/web"],
              contract_files: {
                agents: "apps/web/AGENTS.md",
                claude: "apps/web/CLAUDE.md",
              },
              architecture_module: "docs/architecture/modules/apps-web/web.md",
              lsp_profile: "typescript-lsp",
              verification_hints: ["web checks"],
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(cwd, "docs/architecture/index.md"),
      ["# Architecture Index", "", "## Pending Requests", "", "- (none)", ""].join("\n"),
    );
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writePolicy(cwd: string, mode: "off" | "advisory" | "strict") {
  writeFileSync(
    join(cwd, ".ai/harness/policy.json"),
    JSON.stringify({ architecture: { freshness_gate: mode, gate_min_severity: "medium" } }, null, 2) + "\n",
  );
}

function writePendingCard(cwd: string, capabilityId = "apps-web", severity = "high") {
  writeFileSync(
    join(cwd, "docs/architecture/requests", `${capabilityId}.md`),
    [
      `# Architecture Drift Request: ${capabilityId}`,
      "",
      "> **Status**: Pending",
      "> **Detected**: 2026-06-01T12:00:00+0800",
      `> **Severity**: ${severity}`,
      "> **Change Type**: workflow-surface",
      "> **File**: `apps/web/src/routes/account.tsx`",
      "> **Functional Block**: `apps/web`",
      `> **Capability ID**: \`${capabilityId}\``,
      "> **Matched Prefix**: `apps/web`",
      "> **Architecture Domain**: `apps-web`",
      "> **Architecture Capability**: `web`",
      "> **Architecture Module**: `docs/architecture/modules/apps-web/web.md`",
      "",
    ].join("\n"),
  );
  expect(run("bash", ["scripts/architecture-queue.sh", "reindex"], cwd).status).toBe(0);
}

function writeChangedFiles(cwd: string, paths: string[]) {
  writeFileSync(join(cwd, "changed.txt"), paths.join("\n") + "\n");
}

describe("architecture sync gate", () => {
  test("capability resolver batches match results from stdin", () => {
    tmpRepo((cwd) => {
      const res = spawnSync(
        process.execPath,
        ["scripts/capability-resolver.ts", "match", "--paths-from", "-", "--format", "json"],
        {
          cwd,
          encoding: "utf-8",
          input: "apps/web/src/routes/account.tsx\npackage.json\n",
        },
      );
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].capability_id).toBe("apps-web");
      expect(parsed[0].workstream_dir).toBeUndefined();
      expect(parsed[1].capability_id).toBe("root");
      expect(parsed[1].workstream_dir).toBeUndefined();
    });
  });

  test("capability config rejects retired repo-local Workstream creation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "capability-config-retired-workstream-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      const res = spawnSync(
        process.execPath,
        [join(ROOT, "assets/templates/helpers/capability-config.ts"), "add", "--prefix", "src", "--create-workstream"],
        { cwd, encoding: "utf-8" },
      );
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("LEGACY_WORKSTREAM_WRITES_RETIRED");
      expect(existsSync(join(cwd, "tasks/workstreams"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("capability resolver emits compact unique ids for bulk gate consumers", () => {
    tmpRepo((cwd) => {
      const res = spawnSync(
        process.execPath,
        ["scripts/capability-resolver.ts", "match", "--paths-from", "-", "--format", "ids"],
        {
          cwd,
          encoding: "utf-8",
          input: "apps/web/src/routes/account.tsx\napps/web/src/routes/settings.tsx\npackage.json\n",
        },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("apps-web\nroot\n");
    });
  });

  test("resolve deletes a handled request, clears context pointers, and does not create an archive", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      writePendingCard(cwd);
      writeFileSync(
        join(cwd, "AGENTS.md"),
        ["# Root contract", "", "- Pending architecture request: `docs/architecture/requests/apps-web.md`", ""].join("\n"),
      );
      mkdirSync(join(cwd, "apps/web"), { recursive: true });
      writeFileSync(
        join(cwd, "apps/web/CLAUDE.md"),
        ["# Web contract", "", "- Pending architecture request: `requests/apps-web.md`", ""].join("\n"),
      );

      const res = run(
        "bash",
        ["scripts/architecture-queue.sh", "resolve", "--file", "docs/architecture/requests/apps-web.md"],
        cwd,
      );

      expect(res.status).toBe(0);
      expect(existsSync(join(cwd, "docs/architecture/requests/apps-web.md"))).toBe(false);
      expect(existsSync(join(cwd, "docs/architecture/requests/archive"))).toBe(false);
      expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("- Pending architecture request: `(none)`");
      expect(readFileSync(join(cwd, "apps/web/CLAUDE.md"), "utf8")).toContain("- Pending architecture request: `(none)`");
      expect(readFileSync(join(cwd, "docs/architecture/index.md"), "utf8")).toContain("- (none)");
      expect(res.stdout).toContain("Git history is the archive");
    });
  });

  test("strict blocks when a changed capability has a pending request at the threshold", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "strict");
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("blocking=1");
      expect(res.stderr).toContain("strict gate failed");
    });
  });

  test("advisory warns but exits zero for matching pending requests", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "advisory");
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("blocking=1");
      expect(res.stderr).toContain("WARN");
    });
  });

  test("off mode still checks index integrity but ignores freshness blocking", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "off");
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("mode=off");
    });
  });

  test("stale architecture index fails in every mode", () => {
    tmpRepo((cwd) => {
      writePolicy(cwd, "off");
      writePendingCard(cwd);
      writeFileSync(
        join(cwd, "docs/architecture/index.md"),
        `${readFileSync(join(cwd, "docs/architecture/index.md"), "utf-8")}\n- [ ] stale -> [duplicate](requests/duplicate.md)\n`,
      );
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);

      const res = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("architecture request index is stale");
    });
  });

  test("missing resolver is advisory in advisory mode and fail-closed in strict mode", () => {
    tmpRepo((cwd) => {
      writePendingCard(cwd);
      writeChangedFiles(cwd, ["apps/web/src/routes/account.tsx"]);
      rmSync(join(cwd, "scripts/capability-resolver.ts"), { force: true });

      writePolicy(cwd, "advisory");
      const advisory = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(advisory.status).toBe(0);
      expect(advisory.stderr).toContain("WARN");

      writePolicy(cwd, "strict");
      const strict = run("bash", ["scripts/check-architecture-sync.sh", "--changed-files", "changed.txt"], cwd);
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain("strict gate failed");
    });
  });

  test("current Controller Runtime architecture baseline passes when complete", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      writePolicy(cwd, "off");
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("architecture baseline failed");
    });
  });

  test("missing canonical current architecture document fails in every mode", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      rmSync(join(cwd, "docs/architecture/CURRENT.md"));
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("missing required file docs/architecture/CURRENT.md");
    });
  });

  test("missing Runtime Authority declaration fails before freshness evaluation", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      const path = join(cwd, "docs/architecture/CURRENT.md");
      writeFileSync(path, readFileSync(path, "utf-8").replaceAll("Runtime Authority", "Current Architecture"));
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("docs/architecture/CURRENT.md must contain: Runtime Authority");
    });
  });

  test("historical runtime document without authority marker fails", () => {
    tmpRepo((cwd) => {
      installRuntimeArchitectureBaseline(cwd);
      const path = join(cwd, "docs/architecture/current/README.md");
      writeFileSync(path, readFileSync(path, "utf-8").replace("Not Runtime Authority", "Runtime Authority"));
      const res = run("bash", ["scripts/check-architecture-sync.sh", "--mode", "off"], cwd);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Not Runtime Authority");
    });
  });
});
