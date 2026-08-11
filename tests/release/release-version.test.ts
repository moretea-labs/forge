import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/check-release-version.mjs");
const CLEAN_ENV = {
  ...process.env,
  GITHUB_REF_TYPE: "",
  GITHUB_REF_NAME: "",
  RELEASE_TAG: "",
};

function runCurrent(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...CLEAN_ENV, ...env },
  });
}

function runFixture(
  version: string,
  args: string[] = [],
  publishConfig: Record<string, unknown> = { access: "public", provenance: true },
  env: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "forge-release-version-"));
  const packagePath = join(dir, "package.json");
  writeFileSync(packagePath, JSON.stringify({ name: "fixture", version, publishConfig }));
  try {
    return spawnSync("node", [SCRIPT, "--package-json", packagePath, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...CLEAN_ENV, ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release version contract", () => {
  test("infers the current package channel from package.json", () => {
    const pkg = JSON.parse(require("node:fs").readFileSync(join(ROOT, "package.json"), "utf8"));
    const expectedChannel = String(pkg.version).includes("-rc.") ? "next" : "latest";
    const result = runCurrent();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${pkg.version} -> ${expectedChannel}`);
  });

  test("rejects RC publication to latest", () => {
    const result = runFixture("2.0.0-rc.3", ["--channel", "latest"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must publish to next");
  });

  test("rejects stable publication to next", () => {
    const result = runFixture("2.0.0", ["--channel", "next"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must publish to latest");
  });

  test("requires an exact v-prefixed package tag", () => {
    const missing = runFixture("2.0.0-rc.3", ["--channel", "next", "--require-tag"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("set RELEASE_TAG=v2.0.0-rc.3");

    const mismatch = runFixture("2.0.0-rc.3", ["--tag", "v2.0.0-rc.2"]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("does not match package version v2.0.0-rc.3");
  });

  test("fails closed when publishConfig.tag exists", () => {
    const result = runFixture("2.0.0-rc.3", [], {
      access: "public",
      provenance: true,
      tag: "next",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("publishConfig.tag must be omitted");
  });

  test("accepts the correct RC tag on next", () => {
    const result = runFixture(
      "2.0.0-rc.3",
      ["--channel", "next", "--require-tag"],
      { access: "public", provenance: true },
      { RELEASE_TAG: "v2.0.0-rc.3" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("v2.0.0-rc.3");
  });

  test("accepts the correct stable tag on latest", () => {
    const result = runFixture("2.0.0", ["--channel", "latest", "--tag", "v2.0.0", "--require-tag"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2.0.0 -> latest (v2.0.0)");
  });
});
