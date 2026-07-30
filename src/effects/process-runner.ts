import { existsSync, statSync } from "fs";
import { delimiter, extname, isAbsolute, join } from "path";
import { spawnSync } from "child_process";

export interface ProcessOutputRedaction {
  readonly pattern: RegExp;
  readonly replacement: string;
}

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Use opts.env as the complete child environment instead of overlaying process.env. */
  readonly replaceEnv?: boolean;
  readonly stdio?: "pipe" | "inherit" | "ignore";
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly redactions?: readonly ProcessOutputRedaction[];
  readonly input?: string | Buffer;
  /** Test seam for platform-specific command preparation. */
  readonly platform?: NodeJS.Platform;
}

export interface PreparedProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly resolvedCommand: string;
  readonly windowsVerbatimArguments?: boolean;
}

export interface ProcessRunResult {
  readonly ok: boolean;
  readonly status: number;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string;
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;

const DEFAULT_REDACTIONS: readonly ProcessOutputRedaction[] = [
  {
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: "$1[redacted]",
  },
  {
    pattern: /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(?:"[^"\s]+"|'[^'\s]+'|[^\s]+)/gi,
    replacement: "$1[redacted]",
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function redactProcessOutput(
  value: string,
  redactions: readonly ProcessOutputRedaction[] = DEFAULT_REDACTIONS,
): string {
  return redactions.reduce((current, redaction) => current.replace(redaction.pattern, redaction.replacement), value);
}

export function capProcessOutput(value: string, maxBytes = DEFAULT_PROCESS_MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const clipped = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
  return `${clipped}\n[output truncated after ${maxBytes} bytes]`;
}

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[key];
  const target = key.toLowerCase();
  const entry = Object.entries(env).find(([name]) => name.toLowerCase() === target);
  return entry?.[1];
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveProcessCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const pathValue = envValue(env, "PATH", platform) ?? "";
  const pathExtValue = envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = extname(command)
    ? [""]
    : pathExtValue
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value.startsWith(".") ? value : `.${value}`));

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return command;
}

export function escapeWindowsCommandArgument(value: string): string {
  const escaped = value
    .replace(/%/g, "%%")
    .replace(/"/g, '""');
  return `"${escaped}"`;
}

export function prepareProcessInvocation(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PreparedProcessInvocation {
  const resolvedCommand = resolveProcessCommand(command, env, platform);
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(resolvedCommand)) {
    return { command: resolvedCommand, args: [...args], resolvedCommand };
  }

  const comspec = envValue(env, "ComSpec", platform) ?? envValue(env, "COMSPEC", platform) ?? "cmd.exe";
  const commandLine = [resolvedCommand, ...args].map(escapeWindowsCommandArgument).join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    resolvedCommand,
    windowsVerbatimArguments: true,
  };
}

export function runProcess(command: string, args: readonly string[], opts: RunProcessOptions = {}): ProcessRunResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_PROCESS_MAX_OUTPUT_BYTES;
  const redactions = opts.redactions ?? DEFAULT_REDACTIONS;
  const childEnv = opts.replaceEnv ? { ...(opts.env ?? {}) } : { ...process.env, ...(opts.env ?? {}) };
  const invocation = prepareProcessInvocation(command, args, childEnv, opts.platform ?? process.platform);
  const redactedCommand = [invocation.resolvedCommand, ...args].map((part) => redactProcessOutput(part, redactions));
  const result = spawnSync(invocation.command, [...invocation.args], {
    cwd: opts.cwd,
    encoding: opts.stdio === "inherit" || opts.stdio === "ignore" ? undefined : "utf8",
    env: childEnv,
    stdio: opts.stdio ?? "pipe",
    timeout: timeoutMs,
    maxBuffer: Math.max(maxOutputBytes, DEFAULT_PROCESS_MAX_BUFFER_BYTES),
    input: opts.input,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = error?.code === "ETIMEDOUT";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const rawError = error ? errorMessage(error) : "";
  const timeoutMessage = timedOut ? `process timed out after ${timeoutMs}ms: ${redactedCommand.join(" ")}` : "";
  const stderrOrError = [stderr, timeoutMessage || (!stderr && rawError ? rawError : "")].filter(Boolean).join("\n");

  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? 1,
    signal: result.signal,
    timedOut,
    command: redactedCommand,
    stdout: capProcessOutput(redactProcessOutput(stdout, redactions), maxOutputBytes),
    stderr: capProcessOutput(redactProcessOutput(stderrOrError, redactions), maxOutputBytes),
    error: redactProcessOutput(timeoutMessage || rawError, redactions),
  };
}
