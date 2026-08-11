import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("public package release contract", () => {
  test("uses one scoped package identity and explicit release channels", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("@moretea-labs/forge");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
    expect(pkg.author).toBe("Moretea Labs contributors");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(pkg.publishConfig.tag).toBeUndefined();
    expect(pkg.bin).toEqual({
      forge: "bin/forge.mjs",
      "forge-hook": "bin/forge-hook.mjs",
      "forge-runtime": "bin/forge-runtime.mjs",
    });
    expect(pkg.scripts.prepublishOnly).toBeUndefined();
    expect(pkg.scripts["release:rc"]).toBe("bash scripts/publish-release-tarball.sh next");
    expect(pkg.scripts["release:stable"]).toBe("bash scripts/publish-release-tarball.sh latest");
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

  test("uses the content-addressed main gate for main and pull requests", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("name: CI");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("main-gate:");
    expect(workflow).toContain("name: Main gate");
    expect(workflow).toContain('node-version: "22"');
    expect(workflow).toContain('bun-version: "1.3.14"');
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run check:main");
    expect(workflow).not.toContain("npm pack");
    expect(workflow).not.toContain("npm ci");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
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
    expect(workflow).toContain("bun run check:release");
    expect(workflow).toContain('TARBALL_PATH="$(cat .ai/harness/artifacts/release/latest-tarball.txt)"');
    expect(workflow).toContain('npm view "@moretea-labs/forge@${RELEASE_VERSION}" version');
    expect(workflow).toContain("if: steps.registry.outputs.exists != 'true'");
    expect(workflow).toContain('npm publish "$TARBALL_PATH" --tag "${RELEASE_CHANNEL}" --access public');
    expect(workflow).not.toContain("npm pack");
    expect(workflow).toContain("gh release create");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(existsSync(join(ROOT, ".github/workflows/release-rc.yml"))).toBe(false);
  });

  test("documents source fallback and npm/Bun/Homebrew channels honestly", () => {
    for (const path of [
      "README.md",
      "README.zh-CN.md",
      "docs/tutorials/01-install-and-start.md",
      "docs/tutorials/01-install-and-start.zh-CN.md",
    ]) {
      const content = read(path);
      expect(content).toContain("npm install -g .");
      expect(content).toContain("@moretea-labs/forge@next");
    }
    expect(read("docs/operations/releasing.md")).toContain("`next`");
    expect(read("docs/operations/releasing.md")).toContain("`latest`");
    expect(read("docs/operations/releasing.md")).toContain("Bun");
    expect(read("docs/operations/homebrew.md")).toContain("after the first stable release");
  });
});
