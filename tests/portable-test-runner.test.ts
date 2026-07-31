import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifyClosedChildProcessGroup,
  cleanupClosedChildProcessGroup,
  type ClosedChildProcessGroupOperations,
} from "../scripts/run-bun-test-file";

const ROOT = join(import.meta.dir, "..");
const TEST_FILE_RUNNER = join(ROOT, "scripts", "run-bun-test-file.ts");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("portable test runner", () => {
  test("runs exhaustive tests as sequential isolated per-file processes", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain("git ls-files -z");
    expect(script).toContain('test_timeout_ms="${BUN_TEST_TIMEOUT_MS:-60000}"');
    expect(script).toContain('test_max_concurrency="${BUN_TEST_MAX_CONCURRENCY:-1}"');
    expect(script).toContain('file_cooldown_seconds="${BUN_TEST_FILE_COOLDOWN_SECONDS:-0.1}"');
    expect(script).toContain("run_test_file()");
    expect(script).toContain('bun scripts/run-bun-test-file.ts --timeout "$test_timeout_ms" --max-concurrency "$test_max_concurrency" "$test_file"');
    expect(readFileSync(TEST_FILE_RUNNER, "utf8")).toContain("process.kill(-pid, 0)");
    expect(script).toContain('sleep "$file_cooldown_seconds"');
    expect(script).toContain("LC_ALL=C sort -z");
    expect(script).not.toContain("xargs -0");
    expect(script).not.toContain("bun test --parallel");
    expect(script).not.toContain("test_files=()");
    expect(script).not.toContain('exec bun test --isolate --max-concurrency');
  });

  test("keeps the CI gate on per-file process isolation by default", () => {
    const script = readFileSync(join(ROOT, "scripts", "check-ci.sh"), "utf8");

    expect(script).toContain('BUN_TEST_ISOLATE_FILES="${BUN_TEST_ISOLATE_FILES:-1}"');
    expect(script).toContain('BUN_TEST_FILE_COOLDOWN_SECONDS="${BUN_TEST_FILE_COOLDOWN_SECONDS:-0.1}"');
    expect(script).toContain('bun scripts/run-bun-test-file.ts --timeout "$BUN_TEST_TIMEOUT_MS" --max-concurrency "$BUN_TEST_MAX_CONCURRENCY" "$file"');
    expect(script).toContain('sleep "$BUN_TEST_FILE_COOLDOWN_SECONDS"');
    expect(script).not.toContain('bun test --isolate --timeout "$BUN_TEST_TIMEOUT_MS"');
  });

  test("keeps explicit file invocations focused within one bounded Bun process", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain('exec bun test --timeout "$test_timeout_ms" --max-concurrency "$test_max_concurrency" "$@"');
    expect(script).not.toContain('exec bun test --isolate "$@"');
  });

  test("classifies a closed child process group without crossing a reused PID fence", () => {
    expect(classifyClosedChildProcessGroup(undefined, true, false)).toBe("gone");
    expect(classifyClosedChildProcessGroup(42, false, false)).toBe("gone");
    expect(classifyClosedChildProcessGroup(42, true, false)).toBe("owned_residual");
    expect(classifyClosedChildProcessGroup(42, true, true)).toBe("pid_reused");
  });

  test("does not inspect or signal a process group after the closed child PID is reused", async () => {
    let listCalls = 0;
    let terminateCalls = 0;
    const operations: ClosedChildProcessGroupOperations = {
      processGroupExists: () => true,
      isProcessAlive: () => true,
      listProcessTreeMembers: () => {
        listCalls += 1;
        return [42, 43];
      },
      terminateProcessTree: async () => {
        terminateCalls += 1;
        return { pid: 42, signaled: true, escalated: false, exited: true, remainingPids: [] };
      },
    };

    const result = await cleanupClosedChildProcessGroup(42, "reused-pid.test.ts", 0, operations);

    expect(result).toEqual({ exitCode: 0, lingeringPids: [], remainingPids: [] });
    expect(listCalls).toBe(0);
    expect(terminateCalls).toBe(0);
  });

  test("keeps cleanup fail-closed when an owned residual process group survives termination", async () => {
    let groupProbeCount = 0;
    let terminateCalls = 0;
    const operations: ClosedChildProcessGroupOperations = {
      processGroupExists: () => {
        groupProbeCount += 1;
        return true;
      },
      isProcessAlive: () => false,
      listProcessTreeMembers: () => [42, 43, 44],
      terminateProcessTree: async () => {
        terminateCalls += 1;
        return { pid: 42, signaled: true, escalated: true, exited: false, remainingPids: [44] };
      },
    };

    const result = await cleanupClosedChildProcessGroup(42, "leaky.test.ts", 0, operations);

    expect(groupProbeCount).toBe(2);
    expect(terminateCalls).toBe(1);
    expect(result).toEqual({ exitCode: 1, lingeringPids: [43, 44], remainingPids: [44] });
  });

  test("reaps descendants left behind by one test file before returning", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-harness-test-file-runner-"));
    const pidFile = join(dir, "child.pid");
    const testFile = join(dir, "leaky.test.ts");
    try {
      writeFileSync(
        testFile,
        `import { expect, test } from "bun:test";\n` +
          `import { spawn } from "child_process";\n` +
          `import { writeFileSync } from "fs";\n` +
          `test("leaves a child for the wrapper to reap", () => {\n` +
          `  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n` +
          `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
          `  child.unref();\n` +
          `  expect(child.pid).toBeGreaterThan(0);\n` +
          `});\n`,
      );

      const result = spawnSync(
        process.execPath,
        [TEST_FILE_RUNNER, "--timeout", "10000", "--max-concurrency", "1", testFile],
        { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("[tests] reaped 1 lingering process(es)");
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(Number.isInteger(pid)).toBe(true);
      expect(processExists(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
