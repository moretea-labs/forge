import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("public package release contract", () => {
  test("uses one scoped package identity and explicit release channels", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("@moretea-labs/matea");
    expect(pkg.version).toBe("1.4.0-rc.6");
    expect(pkg.author).toBe("Moretea Labs contributors");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(pkg.publishConfig.tag).toBeUndefined();
    expect(pkg.bin).toEqual({
      "matea": "bin/repo-harness.mjs",
      "matea-hook": "bin/repo-harness-hook.mjs",
      "repo-harness": "bin/repo-harness.mjs",
      "repo-harness-hook": "bin/repo-harness-hook.mjs",
    });
    expect(pkg.scripts.prepublishOnly).toBe("bash scripts/check-npm-release.sh");
    expect(pkg.scripts["release:rc"]).toStartWith("node scripts/check-release-version.mjs --channel next --require-tag && ");
    expect(pkg.scripts["release:stable"]).toStartWith("node scripts/check-release-version.mjs --channel latest --require-tag && ");
  });

  test("ships maintained public docs and excludes internal reports", () => {
    const pkg = JSON.parse(read("package.json"));
    for (const path of [
      "LICENSE",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "SUPPORT.md",
      "CODE_OF_CONDUCT.md",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "README.md",
      "README.en.md",
      "README.zh-CN.md",
      "docs/README.md",
      "docs/tutorials/",
      "docs/operations/",
      "docs/wiki/",
    ]) {
      expect(pkg.files).toContain(path);
    }
    expect(pkg.files).not.toContain("ARCHITECTURE_MIGRATION_REPORT.md");
    expect(pkg.files).not.toContain("OPTIMIZATION_REPORT.md");
    expect(read("THIRD_PARTY_NOTICES.md")).toContain("@modelcontextprotocol/sdk");
  });

  test("uses one tag-only OIDC workflow with a protected publish environment", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain('- "v*"');
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("environment: npm-publish");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('node-version: "22"');
    expect(workflow).toContain("npm install --global npm@latest");
    expect(workflow).toContain('RELEASE_TAG="${GITHUB_REF_NAME}" node scripts/check-release-version.mjs --require-tag');
    expect(workflow).toContain("npm run check:release-readiness");
    expect(workflow).toContain('npm publish --tag "${RELEASE_CHANNEL}" --access public');
    expect(workflow).toContain("gh release create");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(existsSync(join(ROOT, ".github/workflows/release-rc.yml"))).toBe(false);
  });

  test("documents current source install and future npm/Bun/Homebrew channels honestly", () => {
    for (const path of [
      "README.md",
      "README.zh-CN.md",
      "docs/tutorials/01-install-and-start.md",
      "docs/tutorials/01-install-and-start.zh-CN.md",
    ]) {
      const content = read(path);
      expect(content).toContain("npm install -g .");
      expect(content).toContain("@moretea-labs/matea@next");
    }
    expect(read("docs/operations/releasing.md")).toContain("not public yet");
    expect(read("docs/operations/releasing.md")).toContain("Bun");
    expect(read("docs/operations/homebrew.md")).toContain("after the first stable release");
  });
});
