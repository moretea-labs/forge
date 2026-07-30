import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import {
  capProcessOutput,
  escapeWindowsCommandArgument,
  prepareProcessInvocation,
  resolveProcessCommand,
  runProcess,
} from "../src/effects/process-runner";

describe("process runner", () => {
  test("captures status and redacts common secrets from output and command args", () => {
    const result = runProcess(
      process.execPath,
      ["-e", "console.log('api_key=super-secret'); console.error('Bearer abc123')", "token=hidden"],
      { maxOutputBytes: 1024 },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("api_key=[redacted]");
    expect(result.stdout).not.toContain("super-secret");
    expect(result.stderr).toContain("Bearer [redacted]");
    expect(result.stderr).not.toContain("abc123");
    expect(result.command.join(" ")).toContain("token=[redacted]");
    expect(result.command.join(" ")).not.toContain("hidden");
  });

  test("caps output with an explicit truncation marker", () => {
    expect(capProcessOutput("0123456789", 5)).toBe("01234\n[output truncated after 5 bytes]");
  });

  test("reports timed out processes without throwing", () => {
    const result = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 20 });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("process timed out after 20ms");
    expect(result.stderr).toContain("process timed out after 20ms");
  });

  test("resolves Windows commands using case-insensitive PATH and PATHEXT", () => {
    const tmp = mkdtempSync(join(tmpdir(), "matea-process-runner-"));
    try {
      const commandPath = join(tmp, "npx.CMD");
      writeFileSync(commandPath, "@echo off\r\n");
      expect(resolveProcessCommand(
        "npx",
        {
          Path: join(tmp, "inherited-path-must-not-win"),
          PATH: tmp,
          PathExt: ".EXE",
          PATHEXT: ".CMD",
        },
        "win32",
      )).toBe(commandPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("routes Windows batch commands through ComSpec with escaped arguments", () => {
    const invocation = prepareProcessInvocation(
      "C:\\tools\\npx.cmd",
      ["hello & goodbye", "100%", "%PATH%", 'a"b'],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );

    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(invocation.args[4]).toBe(
      '"set "MATEA_PROCESS_RUNNER_COMMAND=" & set "MATEA_PROCESS_RUNNER_ARG_0=" & set "MATEA_PROCESS_RUNNER_ARG_1=" & set "MATEA_PROCESS_RUNNER_ARG_2=" & set "MATEA_PROCESS_RUNNER_ARG_3=" & %MATEA_PROCESS_RUNNER_COMMAND% %MATEA_PROCESS_RUNNER_ARG_0% %MATEA_PROCESS_RUNNER_ARG_1% %MATEA_PROCESS_RUNNER_ARG_2% %MATEA_PROCESS_RUNNER_ARG_3%"',
    );
    expect(invocation.env?.MATEA_PROCESS_RUNNER_COMMAND).toBe('"C:\\tools\\npx.cmd"');
    expect(invocation.env?.MATEA_PROCESS_RUNNER_ARG_0).toBe('"hello & goodbye"');
    expect(invocation.env?.MATEA_PROCESS_RUNNER_ARG_1).toBe('"100%"');
    expect(invocation.env?.MATEA_PROCESS_RUNNER_ARG_2).toBe('"%PATH%"');
    expect(invocation.env?.MATEA_PROCESS_RUNNER_ARG_3).toBe('"a""b"');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(escapeWindowsCommandArgument('a"b')).toBe('"a""b"');
  });

  test("executes a real Windows command shim through ComSpec", () => {
    if (process.platform !== "win32") return;
    const tmp = mkdtempSync(join(tmpdir(), "matea-process-runner-cmd-"));
    try {
      const scriptPath = join(tmp, "fixture.mjs");
      const commandPath = join(tmp, "fixture.CMD");
      writeFileSync(scriptPath, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
      const expected = ["hello & goodbye", "100%", "%PATH%", 'a"b'];
      const result = runProcess("fixture", expected, {
        env: { ...process.env, PATH: `${tmp};${process.env.PATH ?? ""}`, PATHEXT: ".CMD" },
      });
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.stdout.trim())).toEqual(expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("keeps native Windows executables as direct invocations", () => {
    const invocation = prepareProcessInvocation("C:\\tools\\node.exe", ["--version"], {}, "win32");
    expect(invocation).toEqual({
      command: "C:\\tools\\node.exe",
      args: ["--version"],
      resolvedCommand: "C:\\tools\\node.exe",
    });
  });
});
