import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { assembleTemplate, loadForgeVersion } from "../scripts/assemble-template";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string };

describe("Single Forge version authority", () => {
  test("project template release identity reads package.json only", () => {
    expect(loadForgeVersion()).toBe(pkg.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(existsSync(join(ROOT, "assets/skill-version.json"))).toBe(false);
    expect(existsSync(join(ROOT, ".claude/.skill-version"))).toBe(false);
  });

  test("project AGENT templates render both labels from package.json", () => {
    const footer = readFileSync(join(ROOT, "assets/partials/07-footer.partial.md"), "utf-8");
    expect(footer).toContain("{{FORGE_VERSION}}");
    expect(footer).toContain("{{TEMPLATE_VERSION}}");
    expect(footer).not.toContain("SKILL_VERSION");
    const rendered = assembleTemplate({
      planType: "A",
      variables: { PROJECT_NAME: "VersionTest" },
    });
    expect(rendered).toContain("forge@" + pkg.version);
    expect(rendered).toContain("Template Version: " + pkg.version);
    expect(rendered).not.toContain("{{FORGE_VERSION}}");
    expect(rendered).not.toContain("{{TEMPLATE_VERSION}}");
  });
});
