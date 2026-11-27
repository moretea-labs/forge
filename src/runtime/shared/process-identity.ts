import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { runProcess } from '../../effects/process-runner';
import { isProcessAlive } from './process-tree';

export const LINUX_PROCESS_START_TIME_PREFIX = 'linux-proc-start:';

export interface ProcessIdentityProbe {
  isAlive(pid: number): boolean;
  command(pid: number): string | undefined;
  startTime(pid: number): string | undefined;
  inspect?(pid: number): { command?: string; startTime?: string };
  /** Legacy wall-clock identity reader for records written before Linux proc-ticks were used. */
  legacyInspect?(pid: number): { command?: string; startTime?: string };
  listProcesses?(): Array<{ pid: number; command: string }>;
}

export interface ExpectedProcessIdentity {
  pid: number;
  processStartTime: string;
  executableFingerprint: string;
}

function inspectProcess(pid: number): { command?: string; startTime?: string } {
  const result = runProcess('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
    timeoutMs: 1_000,
    maxOutputBytes: 32 * 1024,
  });
  if (!result.ok) return {};
  const match = /^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+?)\s*$/.exec(result.stdout);
  return match ? { startTime: match[1], command: match[2] } : {};
}

/** Linux /proc stat field 22 is monotonic process start time in clock ticks since boot. */
export function parseLinuxProcessStartTime(stat: string, bootId: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(bootId)) return undefined;
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return undefined;
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTimeTicks = fields[19]; // Field 22; field 3 (state) is the first token after comm.
  if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) return undefined;
  return LINUX_PROCESS_START_TIME_PREFIX + bootId + ':' + startTimeTicks;
}

function inspectLinuxProcess(pid: number): { command?: string; startTime?: string } {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const startTime = parseLinuxProcessStartTime(readFileSync('/proc/' + pid + '/stat', 'utf8'), bootId);
    if (!startTime) return {};
    const command = readFileSync('/proc/' + pid + '/cmdline')
      .toString('utf8')
      .replace(/\0/g, ' ')
      .trim();
    return { command: command || undefined, startTime };
  } catch {
    return {};
  }
}

function inspectDefaultProcess(pid: number): { command?: string; startTime?: string } {
  return process.platform === 'linux' ? inspectLinuxProcess(pid) : inspectProcess(pid);
}

const defaultProbe: ProcessIdentityProbe = {
  isAlive: (pid) => isProcessAlive(pid),
  inspect: inspectDefaultProcess,
  legacyInspect: process.platform === 'linux' ? inspectProcess : undefined,
  command: (pid) => inspectDefaultProcess(pid).command ?? inspectProcess(pid).command,
  startTime: (pid) => inspectDefaultProcess(pid).startTime ?? inspectProcess(pid).startTime,
  listProcesses: () => {
    const result = runProcess('ps', ['-axo', 'pid=,command='], { timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 });
    if (!result.ok) return [];
    return result.stdout
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.+?)\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => ({ pid: Number.parseInt(match[1], 10), command: match[2] }))
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0 && entry.command.length > 0);
  },
};

export function executableFingerprint(command: string): string {
  return createHash('sha256').update(command).digest('hex').slice(0, 24);
}

export function processIdentityMatches(
  expected: ExpectedProcessIdentity | undefined,
  actualPid: number | undefined,
  probe: ProcessIdentityProbe = defaultProbe,
): { matches: boolean; reason?: string } {
  if (!expected || !actualPid) return { matches: false, reason: 'identity_missing' };
  if (expected.pid !== actualPid) return { matches: false, reason: 'pid_changed' };
  if (!probe.isAlive(actualPid)) return { matches: false, reason: 'process_dead' };
  const isLegacyLinuxIdentity =
    process.platform === 'linux' && !expected.processStartTime.startsWith(LINUX_PROCESS_START_TIME_PREFIX);
  const inspected =
    (isLegacyLinuxIdentity ? probe.legacyInspect?.(actualPid) : undefined) ?? probe.inspect?.(actualPid);
  const command = inspected?.command ?? probe.command(actualPid);
  const startTime = inspected?.startTime ?? probe.startTime(actualPid);
  if (!command || !startTime) return { matches: false, reason: 'identity_probe_unavailable' };
  if (executableFingerprint(command) !== expected.executableFingerprint) {
    return { matches: false, reason: 'executable_fingerprint_changed' };
  }
  if (startTime !== expected.processStartTime) return { matches: false, reason: 'process_start_time_changed' };
  return { matches: true };
}

/**
 * Non-blocking macOS identity verification for high-frequency MCP status reads.
 * One ps invocation fetches stat + lstart + command. Existing sync identity
 * semantics remain authoritative on Linux and Windows.
 */
export async function processIdentityMatchesAsync(
  expected: ExpectedProcessIdentity | undefined,
  actualPid: number | undefined,
): Promise<{ matches: boolean; reason?: string }> {
  if (process.platform !== 'darwin') return processIdentityMatches(expected, actualPid);
  if (!expected || !actualPid) return { matches: false, reason: 'identity_missing' };
  if (expected.pid !== actualPid) return { matches: false, reason: 'pid_changed' };
  try {
    process.kill(actualPid, 0);
  } catch {
    return { matches: false, reason: 'process_dead' };
  }

  const inspected = await new Promise<{ stat?: string; startTime?: string; command?: string }>((resolve) => {
    execFile(
      'ps',
      ['-o', 'stat=', '-o', 'lstart=', '-o', 'command=', '-p', String(actualPid)],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 32 * 1024 },
      (error, stdout) => {
        if (error) return resolve({});
        const match = /^\s*(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+?)\s*$/.exec(stdout);
        resolve(match ? { stat: match[1], startTime: match[2], command: match[3] } : {});
      },
    );
  });
  if (inspected.stat?.toUpperCase().startsWith('Z')) return { matches: false, reason: 'process_dead' };
  if (!inspected.command || !inspected.startTime) return { matches: false, reason: 'identity_probe_unavailable' };
  if (executableFingerprint(inspected.command) !== expected.executableFingerprint) {
    return { matches: false, reason: 'executable_fingerprint_changed' };
  }
  if (inspected.startTime !== expected.processStartTime)
    return { matches: false, reason: 'process_start_time_changed' };
  return { matches: true };
}

export { defaultProbe as defaultProcessIdentityProbe };
