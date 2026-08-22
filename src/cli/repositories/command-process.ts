import { spawn, type ChildProcess } from 'child_process';
import { capProcessOutput, redactProcessOutput } from '../../effects/process-runner';
import { repositoryChildProcessEnvironment } from '../../runtime/shared/process-environment';
import { terminateProcessTree } from '../../runtime/shared/process-tree';
import type { CanonicalRepositoryCommand } from './command-normalization';

export interface SpawnCommandResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}
export interface RepositoryCommandAsyncHooks {
  onSpawn?: (pid: number) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Observe the exact child exit result before repository post-processing begins. */
  onExit?: (result: SpawnCommandResult) => void;
  signal?: AbortSignal;
}

export function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'SSH_AUTH_SOCK', 'GPG_TTY', 'XDG_CONFIG_HOME'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.CI = '1';
  return repositoryChildProcessEnvironment(env);
}

export function collectOutput(maxOutputBytes: number): { write(chunk: string | Buffer): void; complete(): string } {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  return {
    write(chunk) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (buffer.length === 0) return;
      if (totalBytes >= maxOutputBytes) { truncated = true; return; }
      const remaining = maxOutputBytes - totalBytes;
      chunks.push(buffer.length <= remaining ? buffer : buffer.subarray(0, remaining));
      totalBytes += Math.min(buffer.length, remaining);
      if (buffer.length > remaining) truncated = true;
    },
    complete() {
      const redacted = redactProcessOutput(Buffer.concat(chunks).toString('utf8'));
      return truncated ? capProcessOutput(redacted, maxOutputBytes) : redacted;
    },
  };
}

async function killCommandTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    } else child.kill();
  } catch { /* already exited */ }
  await terminateProcessTree(pid, { gracePeriodMs: 200, killAfterMs: 1_000, pollIntervalMs: 25 });
}

export async function runCanonicalCommand(
  command: CanonicalRepositoryCommand,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  hooks: RepositoryCommandAsyncHooks = {},
): Promise<SpawnCommandResult> {
  if (hooks.signal?.aborted) return { ok: false, exitCode: 1, timedOut: false, cancelled: true, stdout: '', stderr: 'cancelled before spawn' };
  const executable = command.kind === 'argv' ? command.executable! : process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = command.kind === 'argv' ? [...(command.args ?? [])] : process.platform === 'win32' ? ['/d', '/s', '/c', command.shellCommand!] : ['-c', command.shellCommand!];
  const display = typeof command.value === 'string' ? command.value : JSON.stringify(command.value);
  const stdout = collectOutput(maxOutputBytes);
  const stderr = collectOutput(maxOutputBytes);
  return await new Promise<SpawnCommandResult>((resolve) => {
    const child = spawn(executable, args, { cwd, env: commandEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    if (child.pid) hooks.onSpawn?.(child.pid);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError = '';
    let timeoutHandle: NodeJS.Timeout | undefined;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      hooks.signal?.removeEventListener('abort', onAbort);
      const errors = [stderr.complete()];
      if (timedOut) errors.push(`process timed out after ${timeoutMs}ms: ${redactProcessOutput(display)}`);
      if (cancelled) errors.push('process cancelled');
      if (spawnError) errors.push(redactProcessOutput(spawnError));
      const result = { ok: exitCode === 0 && !timedOut && !cancelled && !spawnError, exitCode, timedOut, cancelled, stdout: stdout.complete(), stderr: capProcessOutput(errors.filter(Boolean).join('\n'), maxOutputBytes) };
      try { hooks.onExit?.(result); } catch { /* observation hooks must never change the command outcome */ }
      resolve(result);
    };
    const onAbort = () => { cancelled = true; void killCommandTree(child).finally(() => finish(1)); };
    timeoutHandle = setTimeout(() => { timedOut = true; void killCommandTree(child).finally(() => finish(1)); }, timeoutMs);
    timeoutHandle.unref();
    hooks.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout.write(chunk); hooks.onStdout?.(chunk.toString()); });
    child.stderr?.on('data', (chunk) => { stderr.write(chunk); hooks.onStderr?.(chunk.toString()); });
    child.on('error', (error) => { spawnError = error.message; });
    child.on('close', (code) => finish(code ?? 1));
  });
}
