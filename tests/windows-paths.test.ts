import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { findWindowsIncompatiblePaths, windowsPathProblems } from "../scripts/windows-paths.mjs";

describe("Windows tracked-path portability", () => {
  test("rejects illegal characters", () => {
    expect(windowsPathProblems("plans/Sprint: Review.md")).not.toEqual([]);
    expect(windowsPathProblems('docs/bad\"name.md')).not.toEqual([]);
    expect(windowsPathProblems("docs/bad?name.md")).not.toEqual([]);
  });

  test("rejects reserved device names and trailing dots or spaces", () => {
    expect(windowsPathProblems("docs/CON.md")).not.toEqual([]);
    expect(windowsPathProblems("docs/lpt9.txt")).not.toEqual([]);
    expect(windowsPathProblems("docs/trailing. ")).not.toEqual([]);
  });

  test("accepts portable Unicode paths", () => {
    expect(windowsPathProblems("plans/sprints/20260617-harness—review.md")).toEqual([]);
  });

  test("all currently tracked paths are portable", () => {
    const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
    const paths = output.split("\0").filter(Boolean);
    expect(findWindowsIncompatiblePaths(paths)).toEqual([]);
  });
});
