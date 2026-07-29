#!/usr/bin/env bun
import { spawn } from 'child_process';
import {
  listProcessTreeMembers,
  signalProcessTree,
  terminateProcessTree,
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

  if (!processGroupExists(child.pid)) {
    return { exitCode, lingeringPids: [], remainingPids: [] };
  }

  const lingeringPids = listProcessTreeMembers(child.pid).filter((pid) => pid !== child.pid);
  if (lingeringPids.length === 0) {
    return { exitCode, lingeringPids: [], remainingPids: [] };
  }

  const terminated = await terminateProcessTree(child.pid, {
    gracePeriodMs: 100,
    killAfterMs: 2_000,
    pollIntervalMs: 25,
  });
  const label = args.at(-1) ?? 'Bun test file';
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

if (import.meta.main) {
  try {
    const result = await runBunTestFile(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
