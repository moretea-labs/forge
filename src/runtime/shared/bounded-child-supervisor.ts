import { spawn, type ChildProcess, type StdioOptions } from 'child_process';
import {
  isProcessAlive,
  listProcessTreeMembers,
  signalProcessTree,
  terminateProcessTree,
  type ProcessTreeTerminationResult,
} from './process-tree';

export const CHILD_SUPERVISOR_FAILURE_CODES = {
  CHILD_START_FAILED: 'CHILD_SUPERVISOR_START_FAILED',
  WALL_TIMEOUT: 'CHILD_SUPERVISOR_WALL_TIMEOUT',
  RESIDUAL_PROCESS: 'CHILD_SUPERVISOR_RESIDUAL_PROCESS',
  DID_NOT_CONVERGE: 'CHILD_SUPERVISOR_DID_NOT_CONVERGE',
} as const;

export type ChildSupervisorFailureCode =
  (typeof CHILD_SUPERVISOR_FAILURE_CODES)[keyof typeof CHILD_SUPERVISOR_FAILURE_CODES];

export interface BoundedChildSupervisorOperations {
  isProcessAlive(pid: number | undefined): boolean;
  listProcessTreeMembers(pid: number | undefined): number[];
  signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): boolean;
  terminateProcessTree(
    pid: number | undefined,
    options: { gracePeriodMs: number; killAfterMs: number; pollIntervalMs: number },
  ): Promise<ProcessTreeTerminationResult>;
}

const defaultOperations: BoundedChildSupervisorOperations = {
  isProcessAlive,
  listProcessTreeMembers,
  signalProcessTree,
  terminateProcessTree,
};

export interface BoundedChildRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  stdio?: 'capture' | 'inherit';
  forwardSignals?: boolean;
  onSpawn?: (pid: number) => void;
  operations?: BoundedChildSupervisorOperations;
  termination?: { gracePeriodMs?: number; killAfterMs?: number; pollIntervalMs?: number };
}

export interface BoundedChildRunResult {
  status: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid?: number;
  residualPids: number[];
  remainingPids: number[];
  pidReuseFenced: boolean;
  failureCode?: ChildSupervisorFailureCode;
  error?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TERMINATION = { gracePeriodMs: 100, killAfterMs: 2_000, pollIntervalMs: 25 } as const;

function appendBounded(current: string, chunk: Buffer | string, maxBytes: number): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, 'utf8') <= maxBytes * 2) return next;
  return Buffer.from(next, 'utf8').subarray(-maxBytes * 2).toString('utf8');
}

function capOutput(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return `${Buffer.from(value, 'utf8').subarray(-maxBytes).toString('utf8')}\n[earlier output truncated]`;
}

/**
 * Inspect a closed child's process group exactly once. The live-leader fence
 * prevents a reused PID/PGID from becoming a signal target.
 */
export async function cleanupOwnedProcessGroup(
  pid: number | undefined,
  operations: BoundedChildSupervisorOperations = defaultOperations,
  termination: BoundedChildRunOptions['termination'] = {},
): Promise<Pick<BoundedChildRunResult, 'residualPids' | 'remainingPids' | 'pidReuseFenced' | 'failureCode'>> {
  if (!pid || pid <= 0) {
    return { residualPids: [], remainingPids: [], pidReuseFenced: false };
  }
  if (operations.isProcessAlive(pid)) {
    return { residualPids: [], remainingPids: [], pidReuseFenced: true };
  }
  const residualPids = operations.listProcessTreeMembers(pid).filter((member) => member !== pid);
  if (residualPids.length === 0) {
    return { residualPids: [], remainingPids: [], pidReuseFenced: false };
  }
  if (operations.isProcessAlive(pid)) {
    return { residualPids: [], remainingPids: [], pidReuseFenced: true };
  }
  const result = await operations.terminateProcessTree(pid, {
    gracePeriodMs: termination?.gracePeriodMs ?? DEFAULT_TERMINATION.gracePeriodMs,
    killAfterMs: termination?.killAfterMs ?? DEFAULT_TERMINATION.killAfterMs,
    pollIntervalMs: termination?.pollIntervalMs ?? DEFAULT_TERMINATION.pollIntervalMs,
  });
  return {
    residualPids,
    remainingPids: result.remainingPids,
    pidReuseFenced: false,
    failureCode: result.exited
      ? CHILD_SUPERVISOR_FAILURE_CODES.RESIDUAL_PROCESS
      : CHILD_SUPERVISOR_FAILURE_CODES.DID_NOT_CONVERGE,
  };
}

export async function runBoundedChild(
  command: string,
  args: readonly string[],
  options: BoundedChildRunOptions,
): Promise<BoundedChildRunResult> {
  const operations = options.operations ?? defaultOperations;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdio: StdioOptions = options.stdio === 'inherit'
    ? ['ignore', 'inherit', 'inherit']
    : ['ignore', 'pipe', 'pipe'];
  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio,
    });
  } catch (error) {
    return {
      status: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      residualPids: [],
      remainingPids: [],
      pidReuseFenced: false,
      failureCode: CHILD_SUPERVISOR_FAILURE_CODES.CHILD_START_FAILED,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const pid = child.pid;
  if (pid) options.onSpawn?.(pid);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, maxOutputBytes); });
  child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, maxOutputBytes); });

  return await new Promise<BoundedChildRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let requestedSignal: NodeJS.Signals | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    let convergenceTimer: NodeJS.Timeout | undefined;

    const clear = (): void => {
      clearTimeout(wallTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (convergenceTimer) clearTimeout(convergenceTimer);
      if (options.forwardSignals) {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
      }
    };
    const finish = async (
      status: number,
      signal: NodeJS.Signals | null,
      error?: string,
      forcedFailureCode?: ChildSupervisorFailureCode,
      beforeClose = false,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      clear();
      let cleanup: Pick<BoundedChildRunResult, 'residualPids' | 'remainingPids' | 'pidReuseFenced' | 'failureCode'>;
      if (beforeClose) {
        const remainingPids = operations.listProcessTreeMembers(pid);
        cleanup = { residualPids: remainingPids, remainingPids, pidReuseFenced: false };
      } else {
        cleanup = await cleanupOwnedProcessGroup(pid, operations, options.termination);
      }
      const failureCode = forcedFailureCode
        ?? cleanup.failureCode
        ?? (timedOut ? CHILD_SUPERVISOR_FAILURE_CODES.WALL_TIMEOUT : undefined)
        ?? (error ? CHILD_SUPERVISOR_FAILURE_CODES.CHILD_START_FAILED : undefined);
      resolve({
        status: failureCode ? 1 : status,
        signal,
        timedOut,
        stdout: capOutput(stdout, maxOutputBytes),
        stderr: capOutput(stderr, maxOutputBytes),
        pid,
        ...cleanup,
        failureCode,
        error,
      });
    };
    const stop = (signal: NodeJS.Signals, timeout: boolean): void => {
      if (requestedSignal) return;
      requestedSignal = signal;
      timedOut = timeout;
      operations.signalProcessTree(pid, signal);
      const gracePeriodMs = options.termination?.gracePeriodMs ?? DEFAULT_TERMINATION.gracePeriodMs;
      const killAfterMs = options.termination?.killAfterMs ?? DEFAULT_TERMINATION.killAfterMs;
      escalationTimer = setTimeout(() => operations.signalProcessTree(pid, 'SIGKILL'), gracePeriodMs);
      convergenceTimer = setTimeout(() => {
        operations.signalProcessTree(pid, 'SIGKILL');
        child.unref();
        void finish(
          1,
          signal,
          `child process did not converge after ${signal}`,
          CHILD_SUPERVISOR_FAILURE_CODES.DID_NOT_CONVERGE,
          true,
        );
      }, killAfterMs);
    };
    const onSigInt = (): void => stop('SIGINT', false);
    const onSigTerm = (): void => stop('SIGTERM', false);
    if (options.forwardSignals) {
      process.once('SIGINT', onSigInt);
      process.once('SIGTERM', onSigTerm);
    }
    const wallTimer = setTimeout(() => stop('SIGTERM', true), Math.max(1, options.timeoutMs));
    wallTimer.unref?.();
    child.once('error', (error) => { void finish(1, null, error.message); });
    child.once('close', (code, signal) => { void finish(code ?? 1, signal); });
  });
}
