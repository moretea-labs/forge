import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandKind, CommandRecord } from './types.ts';

const OUTPUT_LIMIT = 16 * 1024;
const SUPERVISED_COMMAND_SCRIPT = resolve(import.meta.dir, '../../scripts/run-supervised-command.ts');

interface SupervisedCommandResult {
  status: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid?: number;
  residualPids: number[];
  remainingPids: number[];
  pidReuseFenced: boolean;
  failureCode?: string;
  error?: string;
}

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
  parse(stderr: string): { stderr: string; durationMs?: number; resourceUsage?: ResourceUsage };
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
          durationMs: cpu ? Number(cpu[1]) * 1_000 : undefined,
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
      arguments: ['-f', `${marker}\t%e\t%U\t%S\t%M`, '--', input.command, ...input.arguments],
      parse(stderr) {
        const match = stderr.match(new RegExp(`^${marker}\\t([0-9.]+)\\t([0-9.]+)\\t([0-9.]+)\\t(\\d+)\\s*$`, 'm'));
        return {
          stderr: stderr.replace(new RegExp(`^${marker}\\t[0-9.]+\\t[0-9.]+\\t[0-9.]+\\t\\d+\\s*\\n?`, 'm'), ''),
          durationMs: match ? Number(match[1]) * 1_000 : undefined,
          resourceUsage: finiteResourceUsage(match ? {
            userCpuMs: Number(match[2]) * 1000,
            systemCpuMs: Number(match[3]) * 1000,
            peakRssBytes: Number(match[4]) * 1024,
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
  let exitCode: number | null;
  let stdout: string;
  let stderr: string;
  let timedOut: boolean;
  let supervision: CommandRecord['supervision'];
  let error = '';
  if (input.timeoutMs !== undefined) {
    const request = Buffer.from(JSON.stringify({
      command: timed.command,
      args: timed.arguments,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: OUTPUT_LIMIT * 2,
    })).toString('base64url');
    const supervised = spawnSync(process.execPath, [SUPERVISED_COMMAND_SCRIPT], {
      cwd: input.cwd,
      encoding: 'utf8',
      env: { ...process.env, ...input.env, FORGE_SUPERVISED_REQUEST: request },
      timeout: input.timeoutMs + 5_000,
      shell: false,
      maxBuffer: OUTPUT_LIMIT * 8,
    });
    try {
      const result = JSON.parse(supervised.stdout ?? '') as SupervisedCommandResult;
      exitCode = result.status;
      stdout = result.stdout;
      stderr = result.stderr;
      timedOut = result.timedOut;
      supervision = {
        ...(result.pid ? { pid: result.pid } : {}),
        residualPids: [...result.residualPids],
        remainingPids: [...result.remainingPids],
        pidReuseFenced: result.pidReuseFenced,
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      };
      error = [result.failureCode, result.error].filter(Boolean).join(':');
    } catch {
      exitCode = typeof supervised.status === 'number' ? supervised.status : null;
      stdout = supervised.stdout ?? '';
      stderr = supervised.stderr ?? '';
      const errorCode = (supervised.error as NodeJS.ErrnoException | undefined)?.code;
      timedOut = errorCode === 'ETIMEDOUT' || /(?:timed?\s*out|ETIMEDOUT)/i.test(supervised.error?.message ?? '');
      error = supervised.error ? `${supervised.error.name}: ${supervised.error.message}` : 'EVALUATION_COMMAND_SUPERVISOR_INVALID_RESULT';
    }
  } else {
    const result = spawnSync(timed.command, timed.arguments, {
      cwd: input.cwd,
      encoding: 'utf8',
      env: input.env,
      shell: false,
    });
    exitCode = typeof result.status === 'number' ? result.status : null;
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    timedOut = errorCode === 'ETIMEDOUT' || /(?:timed?\s*out|ETIMEDOUT)/i.test(result.error?.message ?? '');
    error = result.error ? `${result.error.name}: ${result.error.message}` : '';
  }
  const parsed = timed.parse(stderr);
  return {
    kind: input.kind,
    command: input.command,
    arguments: [...input.arguments],
    cwd: input.cwd,
    exitCode,
    startedAt,
    durationMs: parsed.durationMs ?? Date.now() - startedMs,
    stdout: bounded(stdout),
    stderr: bounded([parsed.stderr, error].filter(Boolean).join('\n')),
    timedOut,
    ...(supervision ? { supervision } : {}),
    ...(parsed.resourceUsage ? { resourceUsage: parsed.resourceUsage } : {}),
  };
}

export function commandSucceeded(record: CommandRecord, expectedExitCode = 0): boolean {
  return record.exitCode === expectedExitCode && !record.timedOut;
}
