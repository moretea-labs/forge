import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { getRepository, listRepositories, registerRepository } from "../../src/cli/repositories/registry";

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

test("linked worktree registered before primary keeps one canonical Repository", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-linked-first-"));
  const controllerHome = join(sandbox, "controller");
  const primary = join(sandbox, "primary");
  const linked = join(sandbox, "linked");
  try {
    mkdirSync(controllerHome, { recursive: true });
    mkdirSync(primary);
    git(primary, "init", "-q", "-b", "main");
    git(primary, "config", "user.email", "forge@example.invalid");
    git(primary, "config", "user.name", "Forge Test");
    git(primary, "remote", "add", "origin", "https://github.com/moretea-labs/forge-worktree-fixture.git");
    writeFileSync(join(primary, "README.md"), "fixture\n");
    git(primary, "add", "README.md");
    git(primary, "commit", "-qm", "initial");
    git(primary, "worktree", "add", "--detach", linked, "HEAD");

    const first = registerRepository({ path: linked, controllerHome });
    const second = registerRepository({ path: primary, controllerHome });
    const record = getRepository(first.repoId, controllerHome);

    expect(second.repoId).toBe(first.repoId);
    expect(record.canonicalRoot).toBe(realpathSync(primary));
    expect(record.activeCheckoutId).toBe(second.activeCheckoutId);
    expect(record.checkouts).toHaveLength(2);
    expect(record.checkouts.some((item) => item.checkoutId === first.activeCheckoutId && item.worktree)).toBe(true);
    expect(registerRepository({ path: linked, controllerHome }).repoId).toBe(first.repoId);
    expect(listRepositories(controllerHome).filter((item) => item.repoId === first.repoId)).toHaveLength(1);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
