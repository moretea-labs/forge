import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PUBLIC_GUIDES = ["docs/public-usage-guide.md", "docs/public-usage-guide.zh-CN.md"];
const RUNTIME_SCAN_FILES = [
  "SKILL.md",
  "README.md",
  "README.zh-CN.md",
  ...PUBLIC_GUIDES,
  "docs/reference-configs/external-tooling.md",
];
const RUNTIME_RED_FLAGS = [
  /在 Claude Code/,
  /Claude Code skill/,
  /Claude Code 用户/,
  /Cursor only/,
  /Codex 中/,
  /^\[!\[Claude Code/,
  /~\/\.claude\/skills\/[a-z]/,
  /\/plugin install\b/,
];

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

function isAllowedRuntimeReference(file: string, line: string): boolean {
  return /Claude skill alias/.test(line)
    || (file === "docs/reference-configs/external-tooling.md" && /~\/\.claude\/skills\/gstack/.test(line));
}

describe("public README and documentation contract", () => {
  test("keeps concise maintained English and Chinese landing pages", () => {
    const en = read("README.md");
    const zh = read("README.zh-CN.md");
    const compatibility = read("README.en.md");

    for (const document of [en, zh]) {
      expect(document).toContain("# repo-harness Controller Runtime");
      expect(document).toContain("docs/images/repo-harness-banner.svg");
      expect(document).toContain("1.4.0-rc.6");
      expect(document).toContain("npm install -g .");
      expect(document).toContain("@moretea-labs/repo-harness-controller@next");
      expect(document).toContain("docs/wiki/Home.md");
      expect(document).toContain("SUPPORT.md");
      expect(document).toContain("SECURITY.md");
      expect(document).toContain("CONTRIBUTING.md");
      expect(document).toContain("CHANGELOG.md");
      expect(document.split("\n").length).toBeLessThanOrEqual(151);
      expect(document).not.toContain("```mermaid");
      expect(document).not.toMatch(/Repo Actor|Global Scheduler|Evidence Plane|Controller Home|controller-chatgpt-bridge-v8/);
    }
    expect(en).toContain("## Quick start");
    expect(en).toContain("not public yet");
    expect(zh).toContain("## 快速开始");
    expect(zh).toContain("尚未公开");
    expect(compatibility).toContain("maintained English README is [README.md]");
  });

  test("marks non-authoritative translations as unmaintained", () => {
    expect(read("README.es.md")).toContain("no se mantiene");
    expect(read("README.fr.md")).toContain("n’est pas maintenue");
    expect(read("README.ja.md")).toContain("保守されていません");
  });

  test("keeps connector and repository-routing detail in dedicated guides", () => {
    const connector = read("docs/repo-harness-chatgpt-mcp-setup.md");
    const guides = PUBLIC_GUIDES.map(read).join("\n");
    const combined = `${connector}\n${guides}`;
    expect(combined).toContain("*.ts.net");
    expect(combined).toContain("Cloudflare");
    expect(combined).toContain("/mcp");
    expect(combined).toContain("127.0.0.1:8766");
    expect(guides).toContain("repoId");
    expect(combined).not.toContain("repo_123b7cf58b6b17b5cbe46a56");
    expect(combined).not.toContain("checkout_79d467b771d6c6f0e6c103a7");
  });

  test("packages maintained guides and community trust files", () => {
    const pkg = JSON.parse(read("package.json")) as {
      version: string;
      license: string;
      files: string[];
      repository?: { url?: string };
    };
    expect(pkg.version).toBe("1.4.0-rc.6");
    expect(pkg.license).toBe("MIT");
    for (const file of [
      "README.md",
      "README.en.md",
      "README.zh-CN.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "SUPPORT.md",
      "CODE_OF_CONDUCT.md",
      "docs/images/",
      "docs/wiki/",
      "docs/public-usage-guide.md",
      "docs/public-usage-guide.zh-CN.md",
    ]) {
      expect(pkg.files).toContain(file);
    }
    expect(pkg.files).not.toContain("ARCHITECTURE_MIGRATION_REPORT.md");
    expect(pkg.files).not.toContain("OPTIMIZATION_REPORT.md");
    expect(pkg.repository?.url).toContain("moretea-labs/repo-harness-controller-runtime");
  });

  test("keeps attribution and release safety guidance visible without bloating the README", () => {
    for (const document of [read("README.md"), read("README.zh-CN.md")]) {
      expect(document).toContain("AncientTwo/repo-harness");
      expect(document).toContain("LICENSE");
      expect(document).toContain("NOTICE");
    }
    const contributorDocs = `${read("CONTRIBUTING.md")}\n${read("docs/operations/releasing.md")}`;
    expect(contributorDocs).toContain("check:release-surface");
    expect(contributorDocs).toContain("check:type");
    expect(read("NOTICE")).toContain("derived from AncientTwo/repo-harness");
  });

  test("release and verification references retain evidence authority terminology", () => {
    const releaseDoc = read("docs/reference-configs/release-deploy.md");
    const releaseAsset = read("assets/reference-configs/release-deploy.md");
    const verificationArchitecture = read("docs/architecture/current/verification-and-release-gates.md");
    expect(releaseAsset).toBe(releaseDoc);
    expect(releaseDoc).toContain("effectiveness_authority");
    expect(verificationArchitecture).toContain("Worker or Agent prose is supplementary evidence");
    expect(verificationArchitecture).toContain("bound to an exact Revision");
  });

  test("dry-run keeps the migration report onboarding signals", () => {
    const result = spawnSync("bash", ["scripts/migrate-project-template.sh", "--repo", ".", "--dry-run"], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("=== Migration Report ===");
    expect(result.stdout).toContain("Project hooks synced from:");
    expect(result.stdout).toContain("Workflow migration:");
    expect(result.stdout).toContain("Helper runtime:");
  }, 30000);

  test("runtime red-flag scan keeps public onboarding host-neutral", () => {
    const hits: string[] = [];
    for (const file of RUNTIME_SCAN_FILES) {
      read(file).split("\n").forEach((line, index) => {
        if (RUNTIME_RED_FLAGS.some((pattern) => pattern.test(line)) && !isAllowedRuntimeReference(file, line)) {
          hits.push(`${file}:${index + 1}:${line}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
