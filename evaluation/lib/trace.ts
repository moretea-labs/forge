import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

type ResourceUsage = NonNullable<CommandRecord['resourceUsage']>;

function finiteResourceUsage(value: ResourceUsage | undefined): ResourceUsage | undefined {
  if (!value || !Object.values(value).every((entry) => Number.isFinite(entry) && entry >= 0)) return undefined;
  return value;
}

function timedCommand(input: { command: string; arguments: string[] }): {
  command: string;
  arguments: string[];
  parse(stderr: string): { stderr: string; resourceUsage?: ResourceUsage };
} {
  if (process.platform === 'darwin' && existsSync('/usr/bin/time')) {
    return {
      command: '/usr/bin/time',
      arguments: ['-l', input.command, ...input.arguments],
      parse(stderr) {
        const cpu = stderr.match(/^\s*([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys\s*$/m);
        const rss = stderr.match(/^\s*(\d+)\s+maximum resident set size\s*$/m);
        return {
          stderr: stderr
            .replace(/^\s*[0-9.]+ real\s+[0-9.]+ user\s+[0-9.]+ sys\s*\n?/m, '')
            .replace(/^\s*\d+\s+maximum resident set size\s*\n?/m, ''),
          resourceUsage: finiteResourceUsage(cpu && rss ? {
            userCpuMs: Number(cpu[2]) * 1000,
            systemCpuMs: Number(cpu[3]) * 1000,
            peakRssBytes: Number(rss[1]),
          } : undefined),
        };
      },
    };
  }
  if (process.platform === 'linux' && existsSync('/usr/bin/time')) {
    const marker = 'FORGE_EVAL_RESOURCE';
    return {
      command: '/usr/bin/time',
      arguments: ['-f', `${marker}\t%U\t%S\t%M`, '--', input.command, ...input.arguments],
      parse(stderr) {
        const match = stderr.match(new RegExp(`^${marker}\\t([0-9.]+)\\t([0-9.]+)\\t(\\d+)\\s*$`, 'm'));
        return {
          stderr: stderr.replace(new RegExp(`^${marker}\\t[0-9.]+\\t[0-9.]+\\t\\d+\\s*\\n?`, 'm'), ''),
          resourceUsage: finiteResourceUsage(match ? {
            userCpuMs: Number(match[1]) * 1000,
            systemCpuMs: Number(match[2]) * 1000,
            peakRssBytes: Number(match[3]) * 1024,
          } : undefined),
        };
      },
    };
  }
  return {
    command: input.command,
    arguments: input.arguments,
    parse: (stderr) => ({ stderr }),
  };
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
  const timed = timedCommand({ command: input.command, arguments: input.arguments });
  const result = spawnSync(timed.command, timed.arguments, {
    cwd: input.cwd,
    encoding: 'utf8',
    env: input.env,
    timeout: input.timeoutMs,
    shell: false,
  });
  const error = result.error ? `${result.error.name}: ${result.error.message}` : '';
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errorCode === 'ETIMEDOUT' || /(?:timed?\s*out|ETIMEDOUT)/i.test(result.error?.message ?? '');
  const parsed = timed.parse(result.stderr ?? '');
  return {
    kind: input.kind,
    command: input.command,
    arguments: [...input.arguments],
    cwd: input.cwd,
    exitCode: typeof result.status === 'number' ? result.status : null,
    startedAt,
    durationMs: Date.now() - startedMs,
    stdout: bounded(result.stdout),
    stderr: bounded([parsed.stderr, error].filter(Boolean).join('\n')),
    timedOut,
    ...(parsed.resourceUsage ? { resourceUsage: parsed.resourceUsage } : {}),
  };
}

export function commandSucceeded(record: CommandRecord, expectedExitCode = 0): boolean {
  return record.exitCode === expectedExitCode && !record.timedOut;
}
