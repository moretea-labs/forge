import { spawnSync } from 'node:child_process';
import type { CommandKind, CommandRecord } from './types.ts';

const OUTPUT_LIMIT = 16 * 1024;

/** One monotonic execution budget shared by every call in a candidate trial. */
export function candidateTimeRemaining(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error('EVALUATION_CANDIDATE_TIMEOUT:execution_budget_exhausted');
  return Math.ceil(remaining);
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function bounded(value: string | undefined): string {
  const redacted = redact(value ?? '');
  return redacted.length <= OUTPUT_LIMIT ? redacted : `${redacted.slice(0, OUTPUT_LIMIT)}\n…[truncated]`;
}

export function captureCommand(input: {
  kind: CommandKind;
  command: string;
  arguments: string[];
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): CommandRecord {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const result = spawnSync(input.command, input.arguments, {
    cwd: input.cwd,
    encoding: 'utf8',
    env: input.env,
    timeout: input.timeoutMs,
    shell: false,
  });
  const error = result.error ? `${result.error.name}: ${result.error.message}` : '';
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errorCode === 'ETIMEDOUT' || /(?:timed?\s*out|ETIMEDOUT)/i.test(result.error?.message ?? '');
  return {
    kind: input.kind,
    command: input.command,
    arguments: [...input.arguments],
    cwd: input.cwd,
    exitCode: typeof result.status === 'number' ? result.status : null,
    startedAt,
    durationMs: Date.now() - startedMs,
    stdout: bounded(result.stdout),
    stderr: bounded([result.stderr, error].filter(Boolean).join('\n')),
    timedOut,
  };
}

export function commandSucceeded(record: CommandRecord, expectedExitCode = 0): boolean {
  return record.exitCode === expectedExitCode && !record.timedOut;
}
