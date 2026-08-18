/**
 * In-memory process handles for ordinary local repository commands.
 *
 * This deliberately has no SQLite record, lease, recovery membership, runner
 * indirection, or replay binding. Repository state and the command audit remain
 * the post-crash reconciliation evidence. A controller restart may lose the
 * handle; it must never re-execute the command to reconstruct it.
 */

import { randomUUID } from 'crypto';
import { capProcessOutput, redactProcessOutput } from '../../../effects/process-runner';
import {
  executeRepositoryCommandAsync,
  type ExecuteRepositoryCommandInput,
} from '../../../cli/repositories/command-executor';
import {
  releaseControllerCheckSubscription,
  runControllerCheckAsync,
} from '../../../cli/controller/check-runner';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import type { ProcessHandle, ProcessLogSlice, WaitProcessOptions } from './types';

const EMPTY_EFFECTS = {
  executionJobCount: 0,
  localJobCount: 0,
  workerSpawnCount: 0,
  projectionUpdateCount: 0,
};
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const TERMINAL_RETENTION_MS = 15 * 60_000;
const MAX_RETAINED_HANDLES = 128;

interface LightweightExecutionResult {
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
}

interface LightweightEntry {
  processId: string;
  repoId: string;
  workId?: string;
  commandId: string;
  requestFingerprint: string;
  startedAt: string;
  startedAtMs: number;
  interactiveWaitMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
  pid?: number;
  spawnedAtMs?: number;
  stdout: string;
  stderr: string;
  abort: AbortController;
  promise: Promise<LightweightExecutionResult>;
  result?: LightweightExecutionResult;
  finishedAtMs?: number;
  cancelRequested?: boolean;
}

const entries = new Map<string, LightweightEntry>();

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  return capProcessOutput(redactProcessOutput(`${current}${chunk}`), maxBytes);
}

function sweep(): void {
  const now = Date.now();
  for (const [processId, entry] of entries) {
    if (entry.finishedAtMs && now - entry.finishedAtMs > TERMINAL_RETENTION_MS) entries.delete(processId);
  }
  if (entries.size <= MAX_RETAINED_HANDLES) return;
  const terminal = [...entries.values()]
    .filter((entry) => entry.finishedAtMs !== undefined)
    .sort((left, right) => (left.finishedAtMs ?? 0) - (right.finishedAtMs ?? 0));
  for (const entry of terminal.slice(0, entries.size - MAX_RETAINED_HANDLES)) entries.delete(entry.processId);
}

function entryHandle(entry: LightweightEntry): ProcessHandle {
  const execution = entry.result;
  const completed = execution !== undefined;
  const status = !completed
    ? 'running'
    : execution.cancelled
      ? 'cancelled'
      : execution.timedOut
        ? 'timed_out'
        : execution.ok
          ? 'succeeded'
          : 'failed';
  const stdout = completed ? execution.stdout ?? '' : entry.stdout;
  const stderr = completed ? execution.stderr ?? '' : entry.stderr;
  return {
    processId: entry.processId,
    workId: entry.workId,
    commandId: entry.commandId,
    status,
    contractStatus: status === 'running'
      ? 'running'
      : status === 'succeeded'
        ? 'succeeded'
        : status === 'cancelled'
          ? 'cancelled'
          : 'failed',
    route: completed ? 'direct' : 'managed',
    pid: entry.pid,
    startedAt: entry.startedAt,
    interactiveWaitMs: entry.interactiveWaitMs,
    timeoutMs: entry.timeoutMs,
    completed,
    ok: execution?.ok,
    exitCode: execution?.exitCode,
    timedOut: execution?.timedOut,
    cancelled: execution?.cancelled,
    stdout: completed ? stdout : undefined,
    stderr: completed ? stderr : undefined,
    stdoutTail: stdout,
    stderrTail: stderr,
    durableSideEffects: EMPTY_EFFECTS,
  };
}

export interface StartLightweightCommandInput {
  controllerHome: string;
  repository: RepositoryRecord;
  execution: ExecuteRepositoryCommandInput;
  interactiveWaitMs: number;
  timeoutMs: number;
  maxOutputBytes?: number;
  workId?: string;
  commandId?: string;
}

export interface LightweightCommandMetrics {
  lane: 'lightweight_managed';
  preSpawnHarnessMs?: number;
  childDurationMs?: number;
  interactiveReturnMs: number;
  durableWrites: 0;
  leaseOperations: 0;
}

export interface StartLightweightCheckInput {
  repoId: string;
  repoRoot: string;
  checkId: string;
  interactiveWaitMs: number;
  timeoutMs: number;
  workId?: string;
  commandId?: string;
}

export async function startLightweightRepositoryCommand(
  input: StartLightweightCommandInput,
): Promise<{ handle: ProcessHandle; metrics: LightweightCommandMetrics }> {
  sweep();
  const stableCommandId = input.commandId?.trim();
  const requestFingerprint = JSON.stringify({
    repoId: input.repository.repoId,
    command: input.execution.command,
    cwd: input.execution.cwd ?? '.',
    timeoutMs: input.timeoutMs,
  });
  if (stableCommandId) {
    const existing = [...entries.values()].find((entry) => (
      entry.repoId === input.repository.repoId && entry.commandId === stableCommandId
    ));
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error(`PROCESS_REQUEST_CONFLICT: command id ${stableCommandId} already identifies a different lightweight command`);
      }
      return {
        handle: entryHandle(existing),
        metrics: {
          lane: 'lightweight_managed',
          preSpawnHarnessMs: existing.spawnedAtMs === undefined ? undefined : Math.max(0, existing.spawnedAtMs - existing.startedAtMs),
          childDurationMs: existing.finishedAtMs === undefined || existing.spawnedAtMs === undefined
            ? undefined
            : Math.max(0, existing.finishedAtMs - existing.spawnedAtMs),
          interactiveReturnMs: 0,
          durableWrites: 0,
          leaseOperations: 0,
        },
      };
    }
  }
  const processId = `lightweight:${randomUUID()}`;
  const abort = new AbortController();
  const maxOutputBytes = Math.max(1_024, input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const entry: LightweightEntry = {
    processId,
    repoId: input.repository.repoId,
    workId: input.workId,
    commandId: stableCommandId || processId,
    requestFingerprint,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    interactiveWaitMs: Math.max(0, input.interactiveWaitMs),
    timeoutMs: input.timeoutMs,
    maxOutputBytes,
    stdout: '',
    stderr: '',
    abort,
    promise: undefined as never,
  };
  const onCallerAbort = () => abort.abort();
  input.execution.signal?.addEventListener('abort', onCallerAbort, { once: true });
  entry.promise = executeRepositoryCommandAsync(
    input.controllerHome,
    input.repository,
    { ...input.execution, timeoutMs: input.timeoutMs, maxOutputBytes, signal: abort.signal },
    {
      signal: abort.signal,
      onSpawn: (pid) => { entry.pid = pid; entry.spawnedAtMs = Date.now(); },
      onStdout: (chunk) => { entry.stdout = boundedAppend(entry.stdout, chunk, maxOutputBytes); },
      onStderr: (chunk) => { entry.stderr = boundedAppend(entry.stderr, chunk, maxOutputBytes); },
    },
  ).then((result) => {
    entry.result = result;
    entry.finishedAtMs = Date.now();
    input.execution.signal?.removeEventListener('abort', onCallerAbort);
    return result;
  });
  entries.set(processId, entry);

  if (entry.interactiveWaitMs > 0) {
    await Promise.race([
      entry.promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, entry.interactiveWaitMs);
        timer.unref?.();
      }),
    ]);
  }
  const returnedAtMs = Date.now();
  return {
    handle: entryHandle(entry),
    metrics: {
      lane: 'lightweight_managed',
      preSpawnHarnessMs: entry.spawnedAtMs === undefined ? undefined : Math.max(0, entry.spawnedAtMs - entry.startedAtMs),
      childDurationMs: entry.finishedAtMs === undefined || entry.spawnedAtMs === undefined
        ? undefined
        : Math.max(0, entry.finishedAtMs - entry.spawnedAtMs),
      interactiveReturnMs: Math.max(0, returnedAtMs - entry.startedAtMs),
      durableWrites: 0,
      leaseOperations: 0,
    },
  };
}

export async function startLightweightControllerCheck(
  input: StartLightweightCheckInput,
): Promise<{ handle: ProcessHandle; metrics: LightweightCommandMetrics }> {
  sweep();
  const stableCommandId = input.commandId?.trim();
  const requestFingerprint = JSON.stringify({
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    checkId: input.checkId,
    timeoutMs: input.timeoutMs,
  });
  if (stableCommandId) {
    const existing = [...entries.values()].find((entry) => (
      entry.repoId === input.repoId && entry.commandId === stableCommandId
    ));
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error(`PROCESS_REQUEST_CONFLICT: command id ${stableCommandId} already identifies a different lightweight check`);
      }
      return {
        handle: entryHandle(existing),
        metrics: {
          lane: 'lightweight_managed',
          preSpawnHarnessMs: existing.spawnedAtMs === undefined ? undefined : Math.max(0, existing.spawnedAtMs - existing.startedAtMs),
          childDurationMs: existing.finishedAtMs === undefined || existing.spawnedAtMs === undefined
            ? undefined
            : Math.max(0, existing.finishedAtMs - existing.spawnedAtMs),
          interactiveReturnMs: 0,
          durableWrites: 0,
          leaseOperations: 0,
        },
      };
    }
  }

  const processId = `lightweight:${randomUUID()}`;
  const abort = new AbortController();
  const entry: LightweightEntry = {
    processId,
    repoId: input.repoId,
    workId: input.workId,
    commandId: stableCommandId || processId,
    requestFingerprint,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    interactiveWaitMs: Math.max(0, input.interactiveWaitMs),
    timeoutMs: input.timeoutMs,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    stdout: '',
    stderr: '',
    abort,
    promise: undefined as never,
  };
  abort.signal.addEventListener('abort', () => {
    entry.cancelRequested = true;
    releaseControllerCheckSubscription(processId);
  }, { once: true });
  entry.promise = runControllerCheckAsync(input.repoRoot, input.checkId, {
    requestedTimeoutMs: input.timeoutMs,
    subscriberId: processId,
    onSpawn: (pid) => { entry.pid = pid; entry.spawnedAtMs = Date.now(); },
  }).then((result): LightweightExecutionResult => ({
    ok: result.ok && !entry.cancelRequested,
    exitCode: result.status,
    timedOut: result.timedOut,
    cancelled: entry.cancelRequested,
    stdout: result.stdout,
    stderr: result.stderr,
  })).catch((error): LightweightExecutionResult => ({
    ok: false,
    exitCode: 1,
    cancelled: entry.cancelRequested,
    stderr: redactProcessOutput(error instanceof Error ? error.message : String(error)),
  })).then((result) => {
    entry.result = result;
    entry.finishedAtMs = Date.now();
    return result;
  });
  entries.set(processId, entry);

  if (entry.interactiveWaitMs > 0) {
    await Promise.race([
      entry.promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, entry.interactiveWaitMs);
        timer.unref?.();
      }),
    ]);
  }
  const returnedAtMs = Date.now();
  return {
    handle: entryHandle(entry),
    metrics: {
      lane: 'lightweight_managed',
      preSpawnHarnessMs: entry.spawnedAtMs === undefined ? undefined : Math.max(0, entry.spawnedAtMs - entry.startedAtMs),
      childDurationMs: entry.finishedAtMs === undefined || entry.spawnedAtMs === undefined
        ? undefined
        : Math.max(0, entry.finishedAtMs - entry.spawnedAtMs),
      interactiveReturnMs: Math.max(0, returnedAtMs - entry.startedAtMs),
      durableWrites: 0,
      leaseOperations: 0,
    },
  };
}

function requireEntry(repoId: string, processId: string): LightweightEntry {
  const entry = entries.get(processId);
  if (!entry) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
  if (entry.repoId !== repoId) throw new Error(`PROCESS_REPO_MISMATCH: process ${processId} belongs to ${entry.repoId}, not ${repoId}`);
  return entry;
}

export function isLightweightProcessId(processId: string): boolean {
  return processId.startsWith('lightweight:');
}

export function getLightweightProcessHandle(repoId: string, processId: string): ProcessHandle | undefined {
  const entry = entries.get(processId);
  if (!entry || entry.repoId !== repoId) return undefined;
  return entryHandle(entry);
}

export async function waitForLightweightProcess(
  repoId: string,
  processId: string,
  options: WaitProcessOptions = {},
): Promise<ProcessHandle> {
  const entry = requireEntry(repoId, processId);
  if (entry.result) return entryHandle(entry);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
  await Promise.race([
    entry.promise,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener('abort', () => resolve(), { once: true });
    }),
  ]);
  return entryHandle(entry);
}

export async function cancelLightweightProcess(repoId: string, processId: string): Promise<ProcessHandle> {
  const entry = requireEntry(repoId, processId);
  if (!entry.result) {
    entry.abort.abort();
    await entry.promise;
  }
  return entryHandle(entry);
}

export function readLightweightProcessLogs(
  repoId: string,
  processId: string,
  maxBytes = 32 * 1024,
): ProcessLogSlice | undefined {
  const entry = entries.get(processId);
  if (!entry || entry.repoId !== repoId) return undefined;
  const stdout = capProcessOutput(entry.result?.stdout ?? entry.stdout, maxBytes);
  const stderr = capProcessOutput(entry.result?.stderr ?? entry.stderr, maxBytes);
  return {
    processId,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(entry.result?.stdout ?? entry.stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(entry.result?.stderr ?? entry.stderr, 'utf8'),
    truncated: Buffer.byteLength(entry.result?.stdout ?? entry.stdout, 'utf8') > maxBytes
      || Buffer.byteLength(entry.result?.stderr ?? entry.stderr, 'utf8') > maxBytes,
  };
}
