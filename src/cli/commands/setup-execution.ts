/** Shared synchronous setup/adoption command execution; no Runtime or Work authority. */
import { runProcess as runBoundedProcess } from '../../effects/process-runner';

export interface SetupExecutionStep {
  step: string;
  status: "ok" | "skipped" | "failed";
  command?: string[];
  detail?: string;
  stdout?: string;
  stderr?: string;
}

export function runSetupProcess(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): SetupExecutionStep {
  const result = runBoundedProcess(command, args, { cwd, env });

  return {
    step: "",
    status: result.ok ? "ok" : "failed",
    command: [...result.command],
    stdout: result.stdout,
    stderr: result.stderr || result.error,
  };
}

export function withProcessEnv<T>(env: NodeJS.ProcessEnv | undefined, fn: () => T): T {
  if (!env) return fn();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
