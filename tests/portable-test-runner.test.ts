import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

describe("portable test runner", () => {
  test("runs exhaustive tests as sequential isolated per-file processes", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain("git ls-files -z");
    expect(script).toContain('test_timeout_ms="${BUN_TEST_TIMEOUT_MS:-60000}"');
    expect(script).toContain('test_max_concurrency="${BUN_TEST_MAX_CONCURRENCY:-1}"');
    expect(script).toContain('file_cooldown_seconds="${BUN_TEST_FILE_COOLDOWN_SECONDS:-0.1}"');
    expect(script).toContain("run_test_file()");
    expect(script).toContain('bun test --timeout "$test_timeout_ms" --max-concurrency "$test_max_concurrency" "$test_file"');
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
    expect(script).toContain('bun test --timeout "$BUN_TEST_TIMEOUT_MS" --max-concurrency "$BUN_TEST_MAX_CONCURRENCY" "$file"');
    expect(script).toContain('sleep "$BUN_TEST_FILE_COOLDOWN_SECONDS"');
    expect(script).not.toContain('bun test --isolate --timeout "$BUN_TEST_TIMEOUT_MS"');
  });

  test("keeps explicit file invocations focused within one bounded Bun process", () => {
    const script = readFileSync(join(ROOT, "scripts", "run-tests-portable.sh"), "utf8");

    expect(script).toContain('exec bun test --timeout "$test_timeout_ms" --max-concurrency "$test_max_concurrency" "$@"');
    expect(script).not.toContain('exec bun test --isolate "$@"');
  });
});
