/**
 * Lightweight process handles for ordinary local repository commands.
 *
 * Running state deliberately has no SQLite record, lease, recovery membership,
 * runner indirection, or replay binding. Only a bounded terminal receipt is
 * persisted so a controller restart can recover completed evidence; it must
 * never re-execute a command to reconstruct a missing running handle.
 */

import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { capProcessOutput, redactProcessOutput } from '../../../effects/process-runner';
import {
  executeRepositoryCommandAsync,
  type ExecuteRepositoryCommandInput,
} from '../../../cli/repositories/command-executor';
import {
  releaseControllerCheckSubscription,
  runControllerCheckAsync,
} from '../../../cli/controller/check-runner';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  defaultProcessIdentityProbe,
  executableFingerprint,
  processIdentityMatches,
  type ExpectedProcessIdentity,
} from '../../shared/process-identity';
import { terminateProcessTree } from '../../shared/process-tree';
import { runBoundedProcess } from '../thin-harness/async-process';
import { PROCESS_LOG_TAIL_BYTES, type ProcessHandle, type ProcessLogSlice, type WaitProcessOptions } from './types';

const EMPTY_EFFECTS = {
  executionJobCount: 0,
  localJobCount: 0,
  workerSpawnCount: 0,
  projectionUpdateCount: 0,
};
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const TERMINAL_RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_HANDLES = 256;
const TERMINAL_RECEIPT_RETENTION_MS = 6 * 60 * 60_000;
const MAX_TERMINAL_RECEIPTS = 256;
const RUNNING_RECEIPT_PERSIST_INTERVAL_MS = 250;

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
  controllerHome: string;
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
  identity?: ExpectedProcessIdentity;
  runningReceiptUpdatedAtMs?: number;
  stdout: string;
  stderr: string;
  stdoutTail: string;
  stderrTail: string;
  abort: AbortController;
  promise: Promise<LightweightExecutionResult>;
  result?: LightweightExecutionResult;
  finishedAtMs?: number;
  cancelRequested?: boolean;
}

const entries = new Map<string, LightweightEntry>();

interface LightweightRunningReceipt {
  schemaVersion: 1;
  repoId: string;
  processId: string;
  updatedAt: string;
  handle: ProcessHandle;
  identity?: ExpectedProcessIdentity;
}

interface LightweightTerminalReceipt {
  schemaVersion: 1;
  repoId: string;
  processId: string;
  finishedAt: string;
  handle: ProcessHandle;
}

function runningReceiptRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'process-runtime', 'lightweight-running');
}

function runningReceiptPath(controllerHome: string, repoId: string, processId: string): string {
  return join(runningReceiptRoot(controllerHome, repoId), `${sanitizeFileComponent(processId)}.json`);
}

function terminalReceiptRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'process-runtime', 'lightweight-terminal');
}

function terminalReceiptPath(controllerHome: string, repoId: string, processId: string): string {
  return join(terminalReceiptRoot(controllerHome, repoId), `${sanitizeFileComponent(processId)}.json`);
}

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  if (current.endsWith(`[output truncated after ${maxBytes} bytes]`)) return current;
  return capProcessOutput(`${current}${chunk}`, maxBytes);
}

function boundedTailAppend(current: string, chunk: string): string {
  const combined = Buffer.from(`${current}${chunk}`, 'utf8');
  return combined.length <= PROCESS_LOG_TAIL_BYTES
    ? combined.toString('utf8')
    : combined.subarray(combined.length - PROCESS_LOG_TAIL_BYTES).toString('utf8');
}

function visibleOutput(value: string, maxBytes: number): string {
  return capProcessOutput(redactProcessOutput(value), maxBytes);
}

function visibleOutputTail(value: string): string {
  const safe = redactProcessOutput(value);
  const buffer = Buffer.from(safe, 'utf8');
  return buffer.length <= PROCESS_LOG_TAIL_BYTES
    ? safe
    : buffer.subarray(buffer.length - PROCESS_LOG_TAIL_BYTES).toString('utf8');
}

function captureProcessIdentity(pid: number): ExpectedProcessIdentity | undefined {
  const inspected = defaultProcessIdentityProbe.inspect?.(pid);
  const command = inspected?.command ?? defaultProcessIdentityProbe.command(pid);
  const processStartTime = inspected?.startTime ?? defaultProcessIdentityProbe.startTime(pid);
  if (!command || !processStartTime) return undefined;
  return { pid, processStartTime, executableFingerprint: executableFingerprint(command) };
}

function removeRunningReceipt(controllerHome: string, repoId: string, processId: string): void {
  try { rmSync(runningReceiptPath(controllerHome, repoId, processId), { force: true }); } catch { /* best effort */ }
}

function persistRunningReceipt(entry: LightweightEntry, force = false): void {
  if (entry.result) return;
  const now = Date.now();
  if (!force && entry.runningReceiptUpdatedAtMs !== undefined
    && now - entry.runningReceiptUpdatedAtMs < RUNNING_RECEIPT_PERSIST_INTERVAL_MS) return;
  try {
    const root = runningReceiptRoot(entry.controllerHome, entry.repoId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = runningReceiptPath(entry.controllerHome, entry.repoId, entry.processId);
    const receipt: LightweightRunningReceipt = {
      schemaVersion: 1,
      repoId: entry.repoId,
      processId: entry.processId,
      updatedAt: new Date(now).toISOString(),
      handle: entryHandle(entry),
      ...(entry.identity ? { identity: entry.identity } : {}),
    };
    writeJsonAtomic(path, receipt);
    try { chmodSync(path, 0o600); } catch { /* Windows or restricted filesystem. */ }
    entry.runningReceiptUpdatedAtMs = now;
  } catch {
    // Running receipts are recovery hints only; the in-memory handle remains authoritative while this Runtime is alive.
  }
}

function readRunningReceipt(controllerHome: string, repoId: string, processId: string): LightweightRunningReceipt | undefined {
  const path = runningReceiptPath(controllerHome, repoId, processId);
  if (!existsSync(path)) return undefined;
  try {
    const receipt = readJsonFile<LightweightRunningReceipt>(path);
    if (receipt.schemaVersion !== 1 || receipt.repoId !== repoId || receipt.processId !== processId) return undefined;
    if (receipt.handle?.processId !== processId || receipt.handle.completed) return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function terminalHandle(entry: LightweightEntry): ProcessHandle {
  const handle = entryHandle(entry);
  const stdout = capProcessOutput(redactProcessOutput(handle.stdout ?? ''), entry.maxOutputBytes);
  const stderr = capProcessOutput(redactProcessOutput(handle.stderr ?? ''), entry.maxOutputBytes);
  return {
    ...handle,
    stdout,
    stderr,
    stdoutTail: visibleOutputTail(handle.stdoutTail ?? stdout),
    stderrTail: visibleOutputTail(handle.stderrTail ?? stderr),
  };
}

function pruneTerminalReceipts(root: string, keepPath: string): void {
  try {
    const now = Date.now();
    const retained: Array<{ path: string; mtimeMs: number }> = [];
    for (const file of readdirSync(root)) {
      if (!file.endsWith('.json')) continue;
      const path = join(root, file);
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (path !== keepPath && now - mtimeMs > TERMINAL_RECEIPT_RETENTION_MS) {
          rmSync(path, { force: true });
          continue;
        }
        retained.push({ path, mtimeMs });
      } catch {
        // A concurrently removed receipt is already pruned.
      }
    }
    const excess = retained.length - MAX_TERMINAL_RECEIPTS;
    if (excess <= 0) return;
    const candidates = retained
      .filter((entry) => entry.path !== keepPath)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of candidates.slice(0, excess)) rmSync(entry.path, { force: true });
  } catch {
    // Terminal receipts are recovery evidence only; cleanup must not fail execution.
  }
}

function persistTerminalReceipt(controllerHome: string, entry: LightweightEntry): void {
  if (!entry.result || !entry.finishedAtMs) return;
  const existing = readTerminalReceipt(controllerHome, entry.repoId, entry.processId);
  if (existing) {
    removeRunningReceipt(controllerHome, entry.repoId, entry.processId);
    return;
  }
  try {
    const root = terminalReceiptRoot(controllerHome, entry.repoId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = terminalReceiptPath(controllerHome, entry.repoId, entry.processId);
    const receipt: LightweightTerminalReceipt = {
      schemaVersion: 1,
      repoId: entry.repoId,
      processId: entry.processId,
      finishedAt: new Date(entry.finishedAtMs).toISOString(),
      handle: terminalHandle(entry),
    };
    writeJsonAtomic(path, receipt);
    try { chmodSync(path, 0o600); } catch { /* Windows or restricted filesystem. */ }
    removeRunningReceipt(controllerHome, entry.repoId, entry.processId);
    pruneTerminalReceipts(root, path);
  } catch {
    // A receipt failure must never turn a completed local command into a failure.
  }
}

function readTerminalReceipt(controllerHome: string, repoId: string, processId: string): LightweightTerminalReceipt | undefined {
  const path = terminalReceiptPath(controllerHome, repoId, processId);
  if (!existsSync(path)) return undefined;
  try {
    const receipt = readJsonFile<LightweightTerminalReceipt>(path);
    if (receipt.schemaVersion !== 1 || receipt.repoId !== repoId || receipt.processId !== processId) return undefined;
    if (!receipt.handle?.completed || receipt.handle.processId !== processId) return undefined;
    const finishedAtMs = Date.parse(receipt.finishedAt);
    if (!Number.isFinite(finishedAtMs) || Date.now() - finishedAtMs > TERMINAL_RECEIPT_RETENTION_MS) {
      rmSync(path, { force: true });
      return undefined;
    }
    return receipt;
  } catch {
    return undefined;
  }
}

function recoveredRunningHandle(receipt: LightweightRunningReceipt, note?: string): ProcessHandle {
  const stderrTail = note
    ? visibleOutputTail([receipt.handle.stderrTail, note].filter(Boolean).join('\n'))
    : receipt.handle.stderrTail;
  return {
    ...receipt.handle,
    status: 'running_recovered',
    contractStatus: 'running',
    route: 'managed',
    completed: false,
    ok: undefined,
    exitCode: undefined,
    timedOut: undefined,
    cancelled: undefined,
    stdout: undefined,
    stderr: undefined,
    stderrTail,
  };
}

function inspectRecoveredRunningReceipt(receipt: LightweightRunningReceipt): { state: 'running' | 'dead' | 'unsafe'; reason?: string } {
  const pid = receipt.handle.pid ?? receipt.identity?.pid;
  if (!pid) return { state: 'unsafe', reason: 'identity_missing' };
  if (!receipt.identity) {
    return defaultProcessIdentityProbe.isAlive(pid)
      ? { state: 'unsafe', reason: 'identity_missing' }
      : { state: 'dead', reason: 'process_dead' };
  }
  const result = processIdentityMatches(receipt.identity, pid);
  if (result.matches) return { state: 'running' };
  if (result.reason === 'identity_probe_unavailable') return { state: 'unsafe', reason: result.reason };
  return { state: 'dead', reason: result.reason ?? 'identity_mismatch' };
}

function persistRecoveredTerminalReceipt(
  controllerHome: string,
  receipt: LightweightRunningReceipt,
  handle: ProcessHandle,
): ProcessHandle {
  const existing = readTerminalReceipt(controllerHome, receipt.repoId, receipt.processId);
  if (existing) {
    removeRunningReceipt(controllerHome, receipt.repoId, receipt.processId);
    return existing.handle;
  }
  try {
    const root = terminalReceiptRoot(controllerHome, receipt.repoId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = terminalReceiptPath(controllerHome, receipt.repoId, receipt.processId);
    const terminal: LightweightTerminalReceipt = {
      schemaVersion: 1,
      repoId: receipt.repoId,
      processId: receipt.processId,
      finishedAt: new Date().toISOString(),
      handle,
    };
    writeJsonAtomic(path, terminal);
    try { chmodSync(path, 0o600); } catch { /* Windows or restricted filesystem. */ }
    removeRunningReceipt(controllerHome, receipt.repoId, receipt.processId);
    pruneTerminalReceipts(root, path);
  } catch {
    // Recovery evidence persistence must not trigger command re-execution or unsafe signalling.
  }
  return handle;
}

function completedUnknownRecoveredHandle(receipt: LightweightRunningReceipt, reason: string): ProcessHandle {
  const message = `PROCESS_RESULT_UNAVAILABLE_AFTER_RUNTIME_RESTART: ${reason}`;
  const stderr = visibleOutput([receipt.handle.stderrTail, message].filter(Boolean).join('\n'), DEFAULT_MAX_OUTPUT_BYTES);
  return {
    ...receipt.handle,
    status: 'completed_unknown',
    contractStatus: 'unknown',
    route: 'direct',
    completed: true,
    ok: false,
    exitCode: undefined,
    timedOut: false,
    cancelled: false,
    stdout: receipt.handle.stdoutTail ?? '',
    stderr,
    stdoutTail: visibleOutputTail(receipt.handle.stdoutTail ?? ''),
    stderrTail: visibleOutputTail(stderr),
  };
}

function cancelledRecoveredHandle(receipt: LightweightRunningReceipt): ProcessHandle {
  const message = 'process cancelled after recovering a lightweight handle from persisted PID identity';
  const stderr = visibleOutput([receipt.handle.stderrTail, message].filter(Boolean).join('\n'), DEFAULT_MAX_OUTPUT_BYTES);
  return {
    ...receipt.handle,
    status: 'cancelled',
    contractStatus: 'cancelled',
    route: 'direct',
    completed: true,
    ok: false,
    exitCode: 1,
    timedOut: false,
    cancelled: true,
    stdout: receipt.handle.stdoutTail ?? '',
    stderr,
    stdoutTail: visibleOutputTail(receipt.handle.stdoutTail ?? ''),
    stderrTail: visibleOutputTail(stderr),
  };
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
  const stdout = completed ? execution.stdout ?? '' : visibleOutput(entry.stdout, entry.maxOutputBytes);
  const stderr = completed ? execution.stderr ?? '' : visibleOutput(entry.stderr, entry.maxOutputBytes);
  const stdoutTail = entry.stdoutTail || visibleOutputTail(stdout);
  const stderrTail = entry.stderrTail || visibleOutputTail(stderr);
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
    stdoutTail: visibleOutputTail(stdoutTail),
    stderrTail: visibleOutputTail(stderrTail),
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
  /** Start repository preparation on the next event-loop turn so the caller can receive a handle first. */
  deferStart?: boolean;
  /** Reuse an equivalent active local build/test even when a later caller has a different request id. */
  reuseActiveEquivalent?: boolean;
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
  controllerHome: string;
  repoId: string;
  repoRoot: string;
  checkId: string;
  interactiveWaitMs: number;
  timeoutMs: number;
  workId?: string;
  commandId?: string;
}

export interface StartLightweightInternalProcessInput {
  repoId: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  interactiveWaitMs: number;
  controllerHome: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  workId?: string;
  commandId?: string;
  signal?: AbortSignal;
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
    maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
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
  if (input.reuseActiveEquivalent) {
    const existing = [...entries.values()].find((entry) => (
      entry.repoId === input.repository.repoId
      && entry.requestFingerprint === requestFingerprint
      && entry.result === undefined
    ));
    if (existing) {
      return {
        handle: entryHandle(existing),
        metrics: {
          lane: 'lightweight_managed',
          preSpawnHarnessMs: existing.spawnedAtMs === undefined ? undefined : Math.max(0, existing.spawnedAtMs - existing.startedAtMs),
          childDurationMs: undefined,
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
    controllerHome: input.controllerHome,
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
    stdoutTail: '',
    stderrTail: '',
    abort,
    promise: undefined as never,
  };
  const onCallerAbort = () => abort.abort();
  input.execution.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const startExecution = () => executeRepositoryCommandAsync(
    input.controllerHome,
    input.repository,
    { ...input.execution, timeoutMs: input.timeoutMs, maxOutputBytes, signal: abort.signal },
    {
      signal: abort.signal,
      onSpawn: (pid) => {
        entry.pid = pid;
        entry.spawnedAtMs = Date.now();
        entry.identity = captureProcessIdentity(pid);
        persistRunningReceipt(entry, true);
      },
      onStdout: (chunk) => {
        entry.stdout = boundedAppend(entry.stdout, chunk, maxOutputBytes);
        entry.stdoutTail = boundedTailAppend(entry.stdoutTail, chunk);
        persistRunningReceipt(entry);
      },
      onStderr: (chunk) => {
        entry.stderr = boundedAppend(entry.stderr, chunk, maxOutputBytes);
        entry.stderrTail = boundedTailAppend(entry.stderrTail, chunk);
        persistRunningReceipt(entry);
      },
    },
  ).then((result) => {
    entry.result = result;
    entry.finishedAtMs = Date.now();
    input.execution.signal?.removeEventListener('abort', onCallerAbort);
    persistTerminalReceipt(input.controllerHome, entry);
    return result;
  });
  entry.promise = input.deferStart
    ? new Promise<LightweightExecutionResult>((resolve, reject) => {
        setTimeout(() => {
          startExecution().then(resolve, reject);
        }, 0);
      })
    : startExecution();
  entries.set(processId, entry);
  persistRunningReceipt(entry, true);

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

export async function startLightweightInternalProcess(
  input: StartLightweightInternalProcessInput,
): Promise<{ handle: ProcessHandle; metrics: LightweightCommandMetrics }> {
  sweep();
  const stableCommandId = input.commandId?.trim();
  const requestFingerprint = JSON.stringify({
    repoId: input.repoId,
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
  });
  if (stableCommandId) {
    const existing = [...entries.values()].find((entry) => (
      entry.repoId === input.repoId && entry.commandId === stableCommandId
    ));
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error(`PROCESS_REQUEST_CONFLICT: command id ${stableCommandId} already identifies a different lightweight process`);
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
    controllerHome: input.controllerHome,
    repoId: input.repoId,
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
    stdoutTail: '',
    stderrTail: '',
    abort,
    promise: undefined as never,
  };
  const onCallerAbort = () => abort.abort();
  input.signal?.addEventListener('abort', onCallerAbort, { once: true });
  entry.promise = runBoundedProcess(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
    maxOutputBytes,
    signal: abort.signal,
    onSpawn: (pid) => {
      entry.pid = pid;
      entry.spawnedAtMs = Date.now();
      entry.identity = captureProcessIdentity(pid);
      persistRunningReceipt(entry, true);
    },
    onStdout: (chunk) => {
      entry.stdout = boundedAppend(entry.stdout, chunk, maxOutputBytes);
      entry.stdoutTail = boundedTailAppend(entry.stdoutTail, chunk);
      persistRunningReceipt(entry);
    },
    onStderr: (chunk) => {
      entry.stderr = boundedAppend(entry.stderr, chunk, maxOutputBytes);
      entry.stderrTail = boundedTailAppend(entry.stderrTail, chunk);
      persistRunningReceipt(entry);
    },
  }).then((result) => {
    entry.result = result;
    entry.finishedAtMs = Date.now();
    input.signal?.removeEventListener('abort', onCallerAbort);
    persistTerminalReceipt(input.controllerHome, entry);
    return result;
  });
  entries.set(processId, entry);
  persistRunningReceipt(entry, true);

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
    controllerHome: input.controllerHome,
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
    stdoutTail: '',
    stderrTail: '',
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
    onSpawn: (pid) => {
      entry.pid = pid;
      entry.spawnedAtMs = Date.now();
      entry.identity = captureProcessIdentity(pid);
      persistRunningReceipt(entry, true);
    },
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
    persistTerminalReceipt(input.controllerHome, entry);
    return result;
  });
  entries.set(processId, entry);
  persistRunningReceipt(entry, true);

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

/** Test seam for proving terminal receipt recovery across Runtime-memory loss. */
export function clearLightweightProcessMemoryForTest(): void {
  entries.clear();
}

export function getLightweightProcessHandle(controllerHome: string, repoId: string, processId: string): ProcessHandle | undefined {
  const entry = entries.get(processId);
  if (entry?.repoId === repoId) return entryHandle(entry);
  const terminal = readTerminalReceipt(controllerHome, repoId, processId);
  if (terminal) return terminal.handle;
  const running = readRunningReceipt(controllerHome, repoId, processId);
  if (!running) return undefined;
  const inspection = inspectRecoveredRunningReceipt(running);
  if (inspection.state === 'dead') {
    return persistRecoveredTerminalReceipt(controllerHome, running, completedUnknownRecoveredHandle(running, inspection.reason ?? 'process_dead'));
  }
  return recoveredRunningHandle(
    running,
    inspection.state === 'unsafe' ? `PROCESS_IDENTITY_UNTRUSTED: ${inspection.reason ?? 'unknown'}` : undefined,
  );
}

export async function waitForLightweightProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
  options: WaitProcessOptions = {},
): Promise<ProcessHandle> {
  const entry = entries.get(processId);
  if (!entry) {
    const terminal = readTerminalReceipt(controllerHome, repoId, processId);
    if (terminal) return terminal.handle;
    let running = readRunningReceipt(controllerHome, repoId, processId);
    if (!running) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const recoveredTerminal = readTerminalReceipt(controllerHome, repoId, processId);
      if (recoveredTerminal) return recoveredTerminal.handle;
      const inspection = inspectRecoveredRunningReceipt(running);
      if (inspection.state === 'dead') {
        return persistRecoveredTerminalReceipt(controllerHome, running, completedUnknownRecoveredHandle(running, inspection.reason ?? 'process_dead'));
      }
      if (options.signal?.aborted || Date.now() >= deadline) {
        return recoveredRunningHandle(
          running,
          inspection.state === 'unsafe' ? `PROCESS_IDENTITY_UNTRUSTED: ${inspection.reason ?? 'unknown'}` : undefined,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())));
        timer.unref?.();
      });
      running = readRunningReceipt(controllerHome, repoId, processId) ?? running;
    }
  }
  if (entry.repoId !== repoId) throw new Error(`PROCESS_REPO_MISMATCH: process ${processId} belongs to ${entry.repoId}, not ${repoId}`);
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

export async function cancelAllLightweightProcesses(controllerHome: string): Promise<number> {
  const active = [...entries.values()].filter((entry) => entry.controllerHome === controllerHome && entry.result === undefined);
  await Promise.allSettled(active.map(async (entry) => {
    entry.cancelRequested = true;
    entry.abort.abort();
    await entry.promise;
  }));
  return active.length;
}

export async function cancelLightweightProcess(controllerHome: string, repoId: string, processId: string): Promise<ProcessHandle> {
  const entry = entries.get(processId);
  if (!entry) {
    const terminal = readTerminalReceipt(controllerHome, repoId, processId);
    if (terminal) return terminal.handle;
    const running = readRunningReceipt(controllerHome, repoId, processId);
    if (!running) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
    const inspection = inspectRecoveredRunningReceipt(running);
    if (inspection.state === 'dead') {
      return persistRecoveredTerminalReceipt(controllerHome, running, completedUnknownRecoveredHandle(running, inspection.reason ?? 'process_dead'));
    }
    if (inspection.state === 'unsafe') {
      throw new Error(`PROCESS_IDENTITY_UNTRUSTED: refusing to signal ${processId}: ${inspection.reason ?? 'unknown'}`);
    }
    const pid = running.handle.pid ?? running.identity?.pid;
    if (!pid) throw new Error(`PROCESS_IDENTITY_UNTRUSTED: refusing to signal ${processId}: pid missing`);
    await terminateProcessTree(pid, { gracePeriodMs: 200, killAfterMs: 1_000, pollIntervalMs: 25 });
    return persistRecoveredTerminalReceipt(controllerHome, running, cancelledRecoveredHandle(running));
  }
  if (entry.repoId !== repoId) throw new Error(`PROCESS_REPO_MISMATCH: process ${processId} belongs to ${entry.repoId}, not ${repoId}`);
  if (!entry.result) {
    entry.abort.abort();
    await entry.promise;
  }
  return entryHandle(entry);
}

export function readLightweightProcessLogs(
  controllerHome: string,
  repoId: string,
  processId: string,
  maxBytes = 32 * 1024,
): ProcessLogSlice | undefined {
  const entry = entries.get(processId);
  if (!entry) {
    const terminal = readTerminalReceipt(controllerHome, repoId, processId);
    if (terminal) {
      const stdout = capProcessOutput(terminal.handle.stdout ?? '', maxBytes);
      const stderr = capProcessOutput(terminal.handle.stderr ?? '', maxBytes);
      return {
        processId,
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(terminal.handle.stdout ?? '', 'utf8'),
        stderrBytes: Buffer.byteLength(terminal.handle.stderr ?? '', 'utf8'),
        truncated: Buffer.byteLength(terminal.handle.stdout ?? '', 'utf8') > maxBytes
          || Buffer.byteLength(terminal.handle.stderr ?? '', 'utf8') > maxBytes,
      };
    }
    const running = readRunningReceipt(controllerHome, repoId, processId);
    if (!running) return undefined;
    const stdout = capProcessOutput(running.handle.stdoutTail ?? '', maxBytes);
    const stderr = capProcessOutput(running.handle.stderrTail ?? '', maxBytes);
    return {
      processId,
      stdout,
      stderr,
      stdoutBytes: Buffer.byteLength(running.handle.stdoutTail ?? '', 'utf8'),
      stderrBytes: Buffer.byteLength(running.handle.stderrTail ?? '', 'utf8'),
      truncated: Buffer.byteLength(running.handle.stdoutTail ?? '', 'utf8') > maxBytes
        || Buffer.byteLength(running.handle.stderrTail ?? '', 'utf8') > maxBytes,
    };
  }
  if (entry.repoId !== repoId) return undefined;
  const rawStdout = entry.result?.stdout ?? entry.stdout;
  const rawStderr = entry.result?.stderr ?? entry.stderr;
  const visibleStdout = visibleOutput(rawStdout, maxBytes);
  const visibleStderr = visibleOutput(rawStderr, maxBytes);
  return {
    processId,
    stdout: visibleStdout,
    stderr: visibleStderr,
    stdoutBytes: Buffer.byteLength(visibleStdout, 'utf8'),
    stderrBytes: Buffer.byteLength(visibleStderr, 'utf8'),
    truncated: Buffer.byteLength(visibleStdout, 'utf8') > maxBytes
      || Buffer.byteLength(visibleStderr, 'utf8') > maxBytes,
  };
}
