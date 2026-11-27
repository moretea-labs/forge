import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { findRegisteredRepositoryByCheckoutRoot, getRepository, listRepositories, registerRepository, repositoryCheckoutRootMatches } from "../../src/runtime/repositories/registry";

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

    const reconciliationTrace = join(sandbox, "reconciliation.trace");
    const previousGitTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = reconciliationTrace;
    try {
      expect(repositoryCheckoutRootMatches(record, linked)).toBe(true);
    } finally {
      if (previousGitTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = previousGitTrace;
    }
    const reconciliationCommands = existsSync(reconciliationTrace)
      ? readFileSync(reconciliationTrace, "utf8").split("\n").filter((line) => line.includes("built-in: git "))
      : [];
    expect(reconciliationCommands).toHaveLength(0);

    expect(registerRepository({ path: linked, controllerHome }).repoId).toBe(first.repoId);
    const unregisteredLinked = join(sandbox, "unregistered linked");
    git(primary, "worktree", "add", "--detach", unregisteredLinked, "HEAD");
    expect(findRegisteredRepositoryByCheckoutRoot(unregisteredLinked, controllerHome)?.repoId).toBe(first.repoId);
    const gitFile = join(unregisteredLinked, '.git');
    const target = readFileSync(gitFile, 'utf8').trim().slice('gitdir: '.length);
    writeFileSync(gitFile, `gitdir: ${relative(realpathSync(unregisteredLinked), resolve(realpathSync(unregisteredLinked), target))}\n`);
    expect(findRegisteredRepositoryByCheckoutRoot(unregisteredLinked, controllerHome)?.repoId).toBe(first.repoId);
    // Unfamiliar whitespace keeps the authoritative Git fallback.
    writeFileSync(gitFile, `${readFileSync(gitFile, 'utf8')}\n`);
    expect(findRegisteredRepositoryByCheckoutRoot(unregisteredLinked, controllerHome)?.repoId).toBe(first.repoId);
    expect(listRepositories(controllerHome).filter((item) => item.repoId === first.repoId)).toHaveLength(1);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});


test("independent clones sharing the same remote remain separate Repositories", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "forge-independent-clones-"));
  const controllerHome = join(sandbox, "controller");
  const cloneA = join(sandbox, "clone-a");
  const cloneB = join(sandbox, "clone-b");
  const remote = "https://github.com/moretea-labs/forge-shared-remote-fixture.git";
  try {
    mkdirSync(controllerHome, { recursive: true });
    for (const root of [cloneA, cloneB]) {
      mkdirSync(root);
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.email", "forge@example.invalid");
      git(root, "config", "user.name", "Forge Test");
      git(root, "remote", "add", "origin", remote);
      writeFileSync(join(root, "README.md"), `fixture ${root}\n`);
      git(root, "add", "README.md");
      git(root, "commit", "-qm", "initial");
    }

    const repositoryA = registerRepository({ path: cloneA, controllerHome });
    const repositoryB = registerRepository({ path: cloneB, controllerHome });

    expect(repositoryB.repoId).not.toBe(repositoryA.repoId);
    expect(getRepository(repositoryA.repoId, controllerHome).canonicalRoot).toBe(realpathSync(cloneA));
    expect(getRepository(repositoryB.repoId, controllerHome).canonicalRoot).toBe(realpathSync(cloneB));
    expect(listRepositories(controllerHome)).toHaveLength(2);

    const unrelatedLinked = join(sandbox, "linked-clone-a");
    git(cloneA, "worktree", "add", "--detach", unrelatedLinked, "HEAD");
    registerRepository({ path: unrelatedLinked, controllerHome });
    const unrelated = join(sandbox, "unregistered");
    mkdirSync(unrelated);
    git(unrelated, "init", "-q", "-b", "main");
    const trace = join(sandbox, "lookup.trace");
    const lookup = (env: NodeJS.ProcessEnv) => {
      const module = new URL('../../src/runtime/repositories/registry.ts', import.meta.url).href;
      const script = `import { findRegisteredRepositoryByCheckoutRoot } from ${JSON.stringify(module)};
        console.log(JSON.stringify(findRegisteredRepositoryByCheckoutRoot(${JSON.stringify(unrelated)}, ${JSON.stringify(controllerHome)})?.repoId ?? null));`;
      const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
      if (result.status !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout);
    };
    expect(lookup({ ...process.env, GIT_TRACE: trace })).toBeNull();
    const commands = readFileSync(trace, "utf8").split("\n").filter((line) => line.includes("built-in: git "));
    // A fresh candidate still gets authoritative Git resolution; unrelated
    // primary roots must not each require another Git subprocess.
    expect(commands).toHaveLength(1);

    // Nonstandard common-directory layouts and environment overrides must
    // still use Git, never an exclusion based on the .git directory alone.
    writeFileSync(join(unrelated, ".git", "commondir"), `${join(cloneA, '.git')}\n`);
    expect(findRegisteredRepositoryByCheckoutRoot(unrelated, controllerHome)?.repoId).toBe(repositoryA.repoId);
    rmSync(join(unrelated, ".git", "commondir"));
    expect(lookup({ ...process.env, GIT_COMMON_DIR: join(cloneA, ".git") })).toBe(repositoryA.repoId);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
