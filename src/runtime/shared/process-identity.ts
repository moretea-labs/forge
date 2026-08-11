import { createHash } from 'crypto';
import { runProcess } from '../../effects/process-runner';
import { isProcessAlive } from './process-tree';

export interface ProcessIdentityProbe {
  isAlive(pid: number): boolean;
  command(pid: number): string | undefined;
  startTime(pid: number): string | undefined;
  inspect?(pid: number): { command?: string; startTime?: string };
  listProcesses?(): Array<{ pid: number; command: string }>;
}

export interface ExpectedProcessIdentity {
  pid: number;
  processStartTime: string;
  executableFingerprint: string;
}

function inspectProcess(pid: number): { command?: string; startTime?: string } {
  const result = runProcess('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { timeoutMs: 1_000, maxOutputBytes: 32 * 1024 });
  if (!result.ok) return {};
  const match = /^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+?)\s*$/.exec(result.stdout);
  return match ? { startTime: match[1], command: match[2] } : {};
}

const defaultProbe: ProcessIdentityProbe = {
  isAlive: (pid) => isProcessAlive(pid),
  inspect: inspectProcess,
  command: (pid) => {
    const result = runProcess('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 1_000, maxOutputBytes: 32 * 1024 });
    return result.ok ? result.stdout.trim() || undefined : undefined;
  },
  startTime: (pid) => {
    const result = runProcess('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 1_000, maxOutputBytes: 4 * 1024 });
    return result.ok ? result.stdout.trim() || undefined : undefined;
  },
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
  const inspected = probe.inspect?.(actualPid);
  const command = inspected?.command ?? probe.command(actualPid);
  const startTime = inspected?.startTime ?? probe.startTime(actualPid);
  if (!command || !startTime) return { matches: false, reason: 'identity_probe_unavailable' };
  if (startTime !== expected.processStartTime) return { matches: false, reason: 'process_start_time_changed' };
  if (executableFingerprint(command) !== expected.executableFingerprint) {
    return { matches: false, reason: 'executable_fingerprint_changed' };
  }
  return { matches: true };
}

export { defaultProbe as defaultProcessIdentityProbe };
