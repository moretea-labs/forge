#!/usr/bin/env bun
import { spawn } from 'child_process';
import {
  isProcessAlive,
  listProcessTreeMembers,
  signalProcessTree,
  terminateProcessTree,
  type ProcessTreeTerminationResult,
} from '../src/runtime/shared/process-tree';

export interface BunTestFileRunResult {
  exitCode: number;
  lingeringPids: number[];
  remainingPids: number[];
}

export function processGroupExists(pid: number | undefined): boolean {
  if (!pid || pid <= 0 || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ClosedChildProcessGroupState = 'gone' | 'owned_residual' | 'pid_reused';

export function classifyClosedChildProcessGroup(
  pid: number | undefined,
  groupExists: boolean,
  leaderAliveAfterClose: boolean,
): ClosedChildProcessGroupState {
  if (!pid || pid <= 0 || !groupExists) return 'gone';
  // The child `close` event means the original process was reaped. If the
  // direct PID is alive now, the operating system reused it for a different
  // process. Acting on -PID would target that unrelated process group.
  if (leaderAliveAfterClose) return 'pid_reused';
  return 'owned_residual';
}

function reportReusedPid(pid: number | undefined, label: string): void {
  console.error(
    `[tests] skipped residual process-group cleanup after ${label}: closed child PID ${pid ?? 'unknown'} was reused`,
  );
}

export interface ClosedChildProcessGroupOperations {
  processGroupExists(pid: number | undefined): boolean;
  isProcessAlive(pid: number | undefined): boolean;
  listProcessTreeMembers(pid: number | undefined): number[];
  terminateProcessTree(
    pid: number | undefined,
    options: { gracePeriodMs: number; killAfterMs: number; pollIntervalMs: number },
  ): Promise<ProcessTreeTerminationResult>;
}

const defaultClosedChildProcessGroupOperations: ClosedChildProcessGroupOperations = {
  processGroupExists,
  isProcessAlive,
  listProcessTreeMembers,
  terminateProcessTree,
};

export async function cleanupClosedChildProcessGroup(
  pid: number | undefined,
  label: string,
  exitCode: number,
  operations: ClosedChildProcessGroupOperations = defaultClosedChildProcessGroupOperations,
): Promise<BunTestFileRunResult> {
  const initialGroupState = classifyClosedChildProcessGroup(
    pid,
    operations.processGroupExists(pid),
    operations.isProcessAlive(pid),
  );
  if (initialGroupState === 'gone') {
    return { exitCode, lingeringPids: [], remainingPids: [] };
  }
  if (initialGroupState === 'pid_reused') {
    reportReusedPid(pid, label);
    return { exitCode, lingeringPids: [], remainingPids: [] };
  }

  const lingeringPids = operations.listProcessTreeMembers(pid).filter((memberPid) => memberPid !== pid);
  if (lingeringPids.length === 0) {
    return { exitCode, lingeringPids: [], remainingPids: [] };
  }

  // Fence again immediately before signaling. Full-suite process churn can
  // reuse a PID between the first group probe and cleanup.
  const preTerminationState = classifyClosedChildProcessGroup(
    pid,
    operations.processGroupExists(pid),
    operations.isProcessAlive(pid),
  );
  if (preTerminationState === 'gone') {
    return { exitCode, lingeringPids: [], remainingPids: [] };
  }
  if (preTerminationState === 'pid_reused') {
    reportReusedPid(pid, label);
    return { exitCode, lingeringPids: [], remainingPids: [] };
  }

  const terminated = await operations.terminateProcessTree(pid, {
    gracePeriodMs: 100,
    killAfterMs: 2_000,
    pollIntervalMs: 25,
  });
  const preview = lingeringPids.slice(0, 12).join(', ');
  const omitted = Math.max(0, lingeringPids.length - 12);
  console.error(
    `[tests] reaped ${lingeringPids.length} lingering process(es) after ${label}: ${preview}${omitted > 0 ? `, ... (+${omitted})` : ''}`,
  );

  if (!terminated.exited) {
    console.error(
      `[tests] failed to terminate residual process group after ${label}: ${terminated.remainingPids.join(', ')}`,
    );
    return {
      exitCode: exitCode === 0 ? 1 : exitCode,
      lingeringPids,
      remainingPids: terminated.remainingPids,
    };
  }

  return { exitCode, lingeringPids, remainingPids: [] };
}

export async function runBunTestFile(args: string[]): Promise<BunTestFileRunResult> {
  if (args.length === 0) {
    throw new Error('run-bun-test-file requires Bun test arguments');
  }

  const child = spawn(process.execPath, ['test', ...args], {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
    windowsHide: true,
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    signalProcessTree(child.pid, signal);
  };
  const onSigInt = () => forwardSignal('SIGINT');
  const onSigTerm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigTerm);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  }).finally(() => {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
  });

  const label = args.at(-1) ?? 'Bun test file';
  return cleanupClosedChildProcessGroup(child.pid, label, exitCode);
}

if (import.meta.main) {
  try {
    const result = await runBunTestFile(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
