/**
 * Unified Process Runtime.
 *
 * One spawn path serves Direct (wait briefly then return result) and Managed
 * (return handle when still running). Commands are never re-executed after spawn.
 *
 * Architecture:
 *   Controller → Process Runner (independent) → Actual Command
 *
 * Exit receipts are written by the Process Runner, so Controller crash/SIGKILL
 * does not lose the true exit code. Controller only attaches / polls / reads
 * receipt after restart — never re-spawns the command.
 */

import { createHash, randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { capProcessOutput } from '../../../effects/process-runner';
import { redactSensitiveText, sanitizeSensitiveTextFileInPlace } from '../../evidence/sensitive-output';
import { isProcessAlive, terminateProcessTree } from '../../shared/process-tree';
import { repositoryChildProcessEnvironment, resolveBunExecutable } from '../../shared/process-environment';
import {
  acquireExecutionLeases,
  listActiveLeases,
  releaseExecutionLeases,
  releaseTerminalProcessLeases,
  renewExecutionLeases,
} from '../../resources/leases/store';
import { assertRuntimeMayWrite, assertRuntimeMayWriteOrThrow, getRuntimeWriteClaim } from '../../root/write-fence';
import { defaultProcessIdentityProbe, executableFingerprint } from '../../shared/process-identity';
import {
  claimProcessCheckExecution,
  claimProcessRequest,
  createProcessRecord,
  getProcessRecord,
  listProcessRecords,
  processLogDir,
  tryCompleteProcessRecord,
  updateProcessRecord,
} from './store';
import { assertExecutionIdentity } from '../../control-plane/execution/execution-identity';
import {
  DEFAULT_INTERACTIVE_WAIT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PROCESS_TIMEOUT_MS,
  PROCESS_LOG_TAIL_BYTES,
  effectiveProcessStatus,
  isManagedProcessActive,
  isManagedProcessTerminal,
  isTerminalProcessStatus,
  type ManagedProcessRecord,
  type ProcessHandle,
  type ProcessLeaseRef,
  type ProcessLogSlice,
  type ProcessResourceClaim,
  type SpawnManagedProcessInput,
  type WaitProcessOptions,
  processContractStatus,
} from './types';
import type {
  ProcessCommandDescriptor,
  ProcessRunnerExitReceipt,
} from './process-runner-entry';
import type { ResourceClaimSpec } from '../jobs/types';
import { scopeResourceClaims, toProcessClaims } from './resource-claims';

interface LiveMonitor {
  processId: string;
  repoId: string;
  controllerHome: string;
  /** Runner process (not the actual command). */
  child: ChildProcess;
  fenceToken: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutStoredBytes: number;
  stderrStoredBytes: number;
  stdoutTail: Buffer;
  stderrTail: Buffer;
  maxTailBytes: number;
  maxDiskBytes: number;
  logTruncated: boolean;
  settled: boolean;
  timeoutHandle?: NodeJS.Timeout;
  waiters: Array<(record: ManagedProcessRecord) => void>;
  stdoutPath: string;
  stderrPath: string;
  exitReceiptPath: string;
  descriptorPath: string;
  commandFingerprint: string;
}

const liveMonitors = new Map<string, LiveMonitor>();

function nowIso(): string {
  return new Date().toISOString();
}

function newProcessId(): string {
  return `proc_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function safeProcessText(value: string): string {
  return redactSensitiveText(value).text;
}

function sanitizeTerminalProcessArtifacts(record: ManagedProcessRecord): ManagedProcessRecord {
  if (!isManagedProcessTerminal(record)) return record;
  let filesExamined = 0;
  let filesChanged = 0;
  let redactionCount = 0;
  for (const path of [record.stdoutPath, record.stderrPath]) {
    if (!path || !existsSync(path)) continue;
    filesExamined += 1;
    try {
      const sanitized = sanitizeSensitiveTextFileInPlace(path);
      if (sanitized.changed) filesChanged += 1;
      redactionCount += sanitized.redactions.reduce((total, entry) => total + entry.count, 0);
    } catch {
      /* Keep the original artifact untouched; a later read/recovery may retry. */
    }
  }
  const descriptorPath = record.commandDescriptorPath
    ?? descriptorPathFor(record.controllerHome, record.repoId, record.processId);
  let descriptorRemoved = false;
  if (descriptorPath && existsSync(descriptorPath)) {
    try {
      rmSync(descriptorPath, { force: true });
      descriptorRemoved = true;
    } catch {
      /* best-effort; never expose descriptor content in an error */
    }
  }
  if (filesChanged === 0 && !descriptorRemoved && record.outputRedaction) return record;
  return updateProcessRecord(record.controllerHome, record.repoId, record.processId, {
    outputRedaction: {
      schemaVersion: 1,
      sanitizedAt: nowIso(),
      filesExamined,
      filesChanged,
      redactionCount,
      descriptorRemoved: descriptorRemoved || record.outputRedaction?.descriptorRemoved === true,
    },
  }, { allowTerminal: true }) ?? record;
}

function canonicalizeCommandCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  try {
    // Align request-id fingerprints with pre-spawn execution-identity realpath
    // so callers that claim before spawn do not conflict after cwd normalization.
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function canonicalProcessCommand(command: SpawnManagedProcessInput['command']): Record<string, unknown> {
  return {
    kind: command.kind,
    executable: command.executable ?? null,
    args: command.args ?? [],
    shellCommand: command.shellCommand ?? null,
    cwd: canonicalizeCommandCwd(command.cwd),
    env: command.env
      ? Object.fromEntries(Object.entries(command.env).sort(([left], [right]) => left.localeCompare(right)))
      : null,
  };
}

/** Stable semantic command fingerprint used by request-id idempotency. */
export function fingerprintProcessCommand(command: SpawnManagedProcessInput['command']): string {
  return createHash('sha256').update(JSON.stringify(canonicalProcessCommand(command))).digest('hex');
}

function tailText(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return safeProcessText(buffer.toString('utf8'));
  // Drop incomplete leading UTF-8 sequence after offset cut.
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return safeProcessText(buffer.subarray(start).toString('utf8'));
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (chunk.length >= maxBytes) return Buffer.from(chunk.subarray(chunk.length - maxBytes));
  const nextLen = current.length + chunk.length;
  if (nextLen <= maxBytes) return Buffer.concat([current, chunk]);
  const keep = maxBytes - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

/**
 * Read only the last maxBytes of a file without loading the whole file.
 * Tolerates incomplete leading UTF-8 sequences.
 */
export function readFileTailBytes(path: string, maxBytes: number): { text: string; fileBytes: number } {
  if (!path || !existsSync(path)) return { text: '', fileBytes: 0 };
  const size = statSync(path).size;
  if (size <= 0) return { text: '', fileBytes: 0 };
  const readSize = Math.min(size, Math.max(1, maxBytes));
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    const offset = size - readSize;
    const bytesRead = readSync(fd, buf, 0, readSize, offset);
    let start = 0;
    // Skip incomplete leading UTF-8 continuation bytes when we started mid-sequence.
    if (offset > 0) {
      while (start < bytesRead && (buf[start]! & 0xc0) === 0x80) start += 1;
    }
    const text = safeProcessText(buf.subarray(start, bytesRead).toString('utf8'));
    return { text, fileBytes: size };
  } finally {
    closeSync(fd);
  }
}

function captureIdentity(pid: number | undefined): {
  identity?: ManagedProcessRecord['identity'];
  identityUntrusted?: boolean;
} {
  if (!pid || pid <= 0) return {};
  const probe = defaultProcessIdentityProbe;
  if (!probe.isAlive(pid)) return {};
  const command = probe.command(pid);
  const startTime = probe.startTime(pid);
  if (!command || !startTime) {
    return {
      identity: {
        pid,
        processStartTime: `untrusted:${Date.now()}`,
        executableFingerprint: createHash('sha256').update(`pid:${pid}`).digest('hex').slice(0, 24),
        processGroupId: process.platform !== 'win32' ? pid : undefined,
      },
      identityUntrusted: true,
    };
  }
  return {
    identity: {
      pid,
      processStartTime: startTime,
      executableFingerprint: executableFingerprint(command),
      processGroupId: process.platform !== 'win32' ? pid : undefined,
    },
    identityUntrusted: false,
  };
}

function identityStillMatches(identity: ManagedProcessRecord['identity'] | undefined, untrusted?: boolean): boolean {
  if (!identity) return false;
  if (untrusted || identity.processStartTime.startsWith('untrusted:') || identity.processStartTime.startsWith('fallback:')) {
    return false;
  }
  if (!isProcessAlive(identity.pid)) return false;
  const probe = defaultProcessIdentityProbe;
  const startTime = probe.startTime(identity.pid);
  const command = probe.command(identity.pid);
  if (!startTime || !command) return false;
  if (startTime !== identity.processStartTime) return false;
  if (executableFingerprint(command) !== identity.executableFingerprint) return false;
  return true;
}

export interface ProcessExitReceipt {
  schemaVersion: 1;
  processId: string;
  exitCode: number | null;
  signal?: string;
  finishedAt: string;
  startedAt?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutStoredBytes?: number;
  stderrStoredBytes?: number;
  logTruncated?: boolean;
  runnerPid?: number;
  commandExecutedOnce?: boolean;
}

function receiptPathFor(controllerHome: string, repoId: string, processId: string): string {
  return join(processLogDir(controllerHome, repoId), `${processId}.exit.json`);
}

function descriptorPathFor(controllerHome: string, repoId: string, processId: string): string {
  return join(processLogDir(controllerHome, repoId), `${processId}.command.json`);
}

function writeExitReceipt(path: string, receipt: ProcessExitReceipt): void {
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch {
    /* best-effort receipt */
  }
}

function readExitReceipt(path: string | undefined): ProcessExitReceipt | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ProcessExitReceipt;
    if (value?.schemaVersion !== 1) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function statusFromReceipt(receipt: ProcessExitReceipt): ManagedProcessRecord['status'] {
  if (receipt.cancelled) return 'cancelled';
  if (receipt.timedOut) return 'timed_out';
  const code = receipt.exitCode ?? 1;
  return code === 0 ? 'succeeded' : 'failed';
}

function processOwnerJobId(processId: string): string {
  return `process:${processId}`;
}

function toResourceClaimSpecs(claims: ProcessResourceClaim[]): ResourceClaimSpec[] {
  return claims.map((claim) => ({
    resourceKey: claim.resourceKey,
    mode: claim.mode,
    ...(claim.repoId ? { repoId: claim.repoId } : {}),
    ...(claim.checkoutId ? { checkoutId: claim.checkoutId } : {}),
    ...(claim.workId ? { workId: claim.workId } : {}),
  }));
}

function processRuntimeIdentityMatches(record: ManagedProcessRecord): boolean {
  const expected = {
    runtimeInstanceId: record.runtimeInstanceId,
    releaseAuthorityRevision: record.releaseAuthorityRevision,
    releaseId: record.releaseId,
    artifactIdentity: record.artifactIdentity,
    workerProtocolVersion: record.workerProtocolVersion,
  };
  if (Object.values(expected).every((value) => value === undefined)) return true;
  const claim = getRuntimeWriteClaim();
  if (!claim) return false;
  if (expected.runtimeInstanceId && expected.runtimeInstanceId !== claim.runtimeInstanceId) return false;
  if (expected.releaseAuthorityRevision !== undefined && expected.releaseAuthorityRevision !== claim.releaseAuthorityRevision) return false;
  if (expected.releaseId && expected.releaseId !== claim.releaseId) return false;
  if (expected.artifactIdentity && expected.artifactIdentity !== claim.artifactIdentity) return false;
  if (expected.workerProtocolVersion !== undefined && expected.workerProtocolVersion !== claim.workerProtocolVersion) return false;
  return true;
}

function expectedLeaseRefsForProcess(record: ManagedProcessRecord, repoId: string): Array<{
  leaseId: string;
  fencingToken: number;
  repoId: string;
  checkoutId?: string;
  workId?: string;
  resourceKey: string;
}> {
  return (record.leaseRefs ?? []).flatMap((ref) => {
    // A malformed or cross-repository reference is never eligible for cleanup.
    if (!ref.leaseId || !ref.resourceKey || (ref.repoId && ref.repoId !== repoId)) return [];
    if (ref.checkoutId && record.checkoutId && ref.checkoutId !== record.checkoutId) return [];
    if (ref.workId && record.workId && ref.workId !== record.workId) return [];
    return [{
      leaseId: ref.leaseId,
      fencingToken: ref.fencingToken,
      repoId,
      ...(ref.checkoutId ? { checkoutId: ref.checkoutId } : {}),
      ...(ref.workId ? { workId: ref.workId } : {}),
      resourceKey: ref.resourceKey,
    }];
  });
}

/**
 * Release terminal Process leases exactly once. Safe under recovery/cancel races.
 * Authorization is the durable terminal record plus exact owner/scope/token refs,
 * not the writer generation that happened to spawn the Process.
 */
export function releaseProcessLeasesOnce(
  controllerHome: string,
  repoId: string,
  processId: string,
): ManagedProcessRecord | undefined {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) return undefined;
  if (record.leasesReleased === true || record.leaseReleaseState === 'released') return record;
  if (!isManagedProcessTerminal(record)) return record;
  const refs = record.leaseRefs ?? [];
  if (refs.length === 0) {
    return updateProcessRecord(
      controllerHome,
      repoId,
      processId,
      { leasesReleased: true, leaseReleaseState: 'released' },
      { allowTerminal: true },
    );
  }
  const expectedRefs = expectedLeaseRefsForProcess(record, repoId);
  if (expectedRefs.length !== refs.length) return record;
  try {
    releaseTerminalProcessLeases(
      controllerHome,
      repoId,
      processId,
      expectedRefs,
      { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false },
    );
  } catch {
    // Exact-set or token mismatch remains pending and retryable. Failed cleanup
    // must never become a durable released claim.
    return getProcessRecord(controllerHome, repoId, processId) ?? record;
  }
  const remaining = listActiveLeases(controllerHome, repoId)
    .some((lease) => lease.ownerJobId === processOwnerJobId(processId));
  if (remaining) return getProcessRecord(controllerHome, repoId, processId) ?? record;
  return updateProcessRecord(
    controllerHome,
    repoId,
    processId,
    { leasesReleased: true, leaseReleaseState: 'released' },
    { allowTerminal: true },
  ) ?? getProcessRecord(controllerHome, repoId, processId);
}

/**
 * Central terminal completion path used by finalizeMonitor, getProcessHandle,
 * waitForProcess, recoverManagedProcesses, and cancelProcess.
 * Durable terminal record writes require active writer fencing.
 * Receipt itself is independent evidence and is never blocked by fencing.
 * Terminal persistence records a retryable pending-release phase. Exact lease
 * cleanup then converges independently of the spawning runtime generation.
 */
export function completeProcessFromEvidence(
  controllerHome: string,
  repoId: string,
  processId: string,
  fenceToken: number,
  evidence: {
    status: ManagedProcessRecord['status'];
    exitCode?: number | null;
    timedOut?: boolean;
    cancelled?: boolean;
    finishedAt?: string;
    errorMessage?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutStoredBytes?: number;
    stderrStoredBytes?: number;
    logTruncated?: boolean;
    exitReceiptPath?: string;
    stdoutTail?: string;
    stderrTail?: string;
  },
  options: { authority?: 'runtime_writer' | 'durable_exit_receipt' | 'durable_pre_spawn_abandonment' } = {},
): ManagedProcessRecord | undefined {
  // Validated independent evidence may only perform the monotonic,
  // fence-token-bound terminal CAS below. It does not grant general writer
  // authority, queue access, process signalling, or arbitrary record updates.
  let mayWriteTerminal = options.authority === 'durable_exit_receipt'
    || options.authority === 'durable_pre_spawn_abandonment';
  if (!mayWriteTerminal) {
    mayWriteTerminal = assertRuntimeMayWrite('write_process_terminal', controllerHome).allowed;
  }

  if (!mayWriteTerminal) {
    return getProcessRecord(controllerHome, repoId, processId);
  }

  const completion = tryCompleteProcessRecord(
    controllerHome,
    repoId,
    processId,
    fenceToken,
    {
      status: evidence.status,
      exitCode: evidence.exitCode ?? undefined,
      timedOut: evidence.timedOut,
      cancelled: evidence.cancelled,
      finishedAt: evidence.finishedAt ?? nowIso(),
      exitReceiptPath: evidence.exitReceiptPath,
      stdoutBytes: evidence.stdoutBytes,
      stderrBytes: evidence.stderrBytes,
      stdoutStoredBytes: evidence.stdoutStoredBytes,
      stderrStoredBytes: evidence.stderrStoredBytes,
      logTruncated: evidence.logTruncated,
      stdoutTail: evidence.stdoutTail,
      stderrTail: evidence.stderrTail,
      ...(evidence.errorMessage
        ? { error: { code: evidence.status.toUpperCase(), message: evidence.errorMessage } }
        : {}),
    },
  );

  // Always attempt exactly-once lease release after terminal evidence, including
  // already-terminal races (second caller still needs to clear leases once).
  const afterTerminal = completion.record ?? getProcessRecord(controllerHome, repoId, processId);
  if (afterTerminal && (completion.ok || completion.reason === 'already_terminal' || afterTerminal.terminalWritten === true)) {
    return releaseProcessLeasesOnce(controllerHome, repoId, processId) ?? afterTerminal;
  }
  return afterTerminal;
}

const DEFAULT_PRE_SPAWN_ABANDONMENT_MS = 5 * 60_000;

/**
 * Reconcile a Process record that was durably created but provably never
 * crossed the OS-spawn boundary. This is intentionally narrower than generic
 * orphan recovery: a candidate must remain `starting`, have no captured
 * identity or leases, have no descriptor and no exit receipt, and exceed a
 * bounded startup grace period. Fresh or ambiguous records remain active.
 */
export function reconcileAbandonedPreSpawnProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
  options: { nowMs?: number; minAgeMs?: number } = {},
): ManagedProcessRecord | undefined {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record || isManagedProcessTerminal(record) || record.status !== 'starting') return record;
  if (record.identity || (record.leaseRefs?.length ?? 0) > 0) return record;
  const updatedAtMs = Date.parse(record.updatedAt || record.startedAt);
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = Math.max(1_000, options.minAgeMs ?? DEFAULT_PRE_SPAWN_ABANDONMENT_MS);
  if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs < minAgeMs) return record;
  const descriptorPath = record.commandDescriptorPath
    ?? descriptorPathFor(controllerHome, repoId, processId);
  const exitReceiptPath = record.exitReceiptPath
    ?? receiptPathFor(controllerHome, repoId, processId);
  if (existsSync(descriptorPath) || existsSync(exitReceiptPath)) return record;
  return completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
    status: 'failed',
    exitCode: 1,
    finishedAt: new Date(nowMs).toISOString(),
    errorMessage: 'PROCESS_PRESPAWN_ABANDONED: no lease, descriptor, receipt, or PID after startup grace period',
  }, { authority: 'durable_pre_spawn_abandonment' });
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill();
    }
  } catch {
    /* already exited */
  }
  await terminateProcessTree(pid, { gracePeriodMs: 200, killAfterMs: 1_500, pollIntervalMs: 25 });
}

export function resolveProcessRunnerEntryPath(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env.FORGE_PROCESS_RUNNER_ENTRY?.trim();
  if (configured && existsSync(configured)) return configured;

  // Compiled daemon/Gateway entrypoints and process-runner.js are siblings in
  // every immutable release. Prefer that closed release surface before looking
  // at source paths recorded only for diagnostics and development fallback.
  const releaseSibling = join(dirname(execPath), 'process-runner.js');
  if (existsSync(releaseSibling)) return releaseSibling;

  try {
    const here = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    const installed = join(here, 'process-runner.js');
    if (existsSync(installed)) return installed;
    const sourceSibling = join(here, 'process-runner-entry.ts');
    if (existsSync(sourceSibling)) return sourceSibling;
  } catch {
    /* continue to source-root fallback */
  }
  const sourceRoot = env.FORGE_CONTROLLER_RUNTIME_SOURCE_ROOT?.trim() || cwd;
  const sourceEntry = join(sourceRoot, 'src/runtime/execution/process-runtime/process-runner-entry.ts');
  if (existsSync(sourceEntry)) return sourceEntry;
  throw new Error('PROCESS_RUNNER_ENTRY_NOT_FOUND: immutable release is missing process-runner.js');
}
/**
 * A compiled Bun executable reports the bundled forge binary through
 * process.execPath. TypeScript runner entries must instead be launched by Bun.
 */
export function resolveProcessRunnerRuntime(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveBunExecutable(execPath, env);
}

function runnerInvocation(entry: string, descriptorPath: string): { command: string; args: string[] } {
  const sourceEntry = entry.endsWith('.ts') || entry.endsWith('.tsx');
  let standalone = !sourceEntry && process.env.FORGE_RUNTIME_EXECUTION === 'standalone-binary';
  if (!sourceEntry && !standalone) {
    try {
      const manifest = JSON.parse(readFileSync(join(dirname(entry), 'manifest.json'), 'utf8')) as { executionMode?: unknown };
      standalone = manifest.executionMode === 'standalone-binary';
    } catch {
      /* source and legacy script releases have no execution manifest */
    }
  }
  const args = ['--descriptor', descriptorPath];
  return standalone
    ? { command: entry, args }
    : { command: resolveProcessRunnerRuntime(), args: [entry, ...args] };
}

function commandFingerprint(command: ManagedProcessRecord['command']): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: command.kind,
      executable: command.executable,
      args: command.args,
      shellCommand: command.shellCommand,
      cwd: command.cwd,
    }))
    .digest('hex')
    .slice(0, 24);
}

/**
 * finalizeMonitor order (required):
 * 1. close log fds (runner owns disk logs; controller may only have tails)
 * 2. write/read independent exit receipt
 * 3. update in-memory waiters
 * 4. clear live monitor
 * 5. attempt durable terminal record (writer-fenced)
 */
function finalizeMonitor(
  monitor: LiveMonitor,
  status: ManagedProcessRecord['status'],
  exitCode: number,
  timedOut: boolean,
  cancelled: boolean,
  errorMessage?: string,
): ManagedProcessRecord | undefined {
  if (monitor.settled) {
    return getProcessRecord(monitor.controllerHome, monitor.repoId, monitor.processId);
  }
  monitor.settled = true;
  if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle);

  // Prefer runner-written receipt; fall back to controller-written receipt only
  // when runner died without writing one (legacy / crash of both).
  let receipt = readExitReceipt(monitor.exitReceiptPath);
  if (!receipt) {
    // Controller-side receipt only when runner did not produce one.
    writeExitReceipt(monitor.exitReceiptPath, {
      schemaVersion: 1,
      processId: monitor.processId,
      exitCode,
      finishedAt: nowIso(),
      timedOut,
      cancelled,
      stdoutBytes: monitor.stdoutBytes,
      stderrBytes: monitor.stderrBytes,
      stdoutStoredBytes: monitor.stdoutStoredBytes,
      stderrStoredBytes: monitor.stderrStoredBytes,
      logTruncated: monitor.logTruncated,
    });
    receipt = readExitReceipt(monitor.exitReceiptPath);
  }

  const finalStatus = receipt ? statusFromReceipt(receipt) : status;
  const finalExit = receipt?.exitCode ?? exitCode;
  const finalTimedOut = receipt?.timedOut ?? timedOut;
  const finalCancelled = receipt?.cancelled ?? cancelled;

  const stdoutBuf = monitor.stdoutTail;
  const stderrBuf = monitor.stderrTail;
  const stdout = capProcessOutput(safeProcessText(stdoutBuf.toString('utf8')), DEFAULT_MAX_OUTPUT_BYTES);
  const stderrParts = [
    safeProcessText(stderrBuf.toString('utf8')),
    finalTimedOut ? 'process timed out' : '',
    finalCancelled ? 'process cancelled' : '',
    errorMessage ? safeProcessText(errorMessage) : '',
  ].filter(Boolean);
  const stderr = capProcessOutput(stderrParts.join('\n'), DEFAULT_MAX_OUTPUT_BYTES);

  const enrichedPatch = {
    status: finalStatus,
    exitCode: finalExit ?? undefined,
    timedOut: finalTimedOut,
    cancelled: finalCancelled,
    finishedAt: receipt?.finishedAt ?? nowIso(),
    exitReceiptPath: monitor.exitReceiptPath,
    stdoutBytes: receipt?.stdoutBytes ?? monitor.stdoutBytes,
    stderrBytes: receipt?.stderrBytes ?? monitor.stderrBytes,
    stdoutStoredBytes: receipt?.stdoutStoredBytes ?? monitor.stdoutStoredBytes,
    stderrStoredBytes: receipt?.stderrStoredBytes ?? monitor.stderrStoredBytes,
    logTruncated: receipt?.logTruncated ?? monitor.logTruncated,
    stdoutTail: tailText(stdoutBuf, PROCESS_LOG_TAIL_BYTES),
    stderrTail: tailText(Buffer.from(stderr, 'utf8'), PROCESS_LOG_TAIL_BYTES),
    errorMessage,
  };

  // Durable terminal write is fenced; waiters still get local outcome.
  const record = completeProcessFromEvidence(
    monitor.controllerHome,
    monitor.repoId,
    monitor.processId,
    monitor.fenceToken,
    enrichedPatch,
  );

  const forWaiters: ManagedProcessRecord = {
    ...(record ?? getProcessRecord(monitor.controllerHome, monitor.repoId, monitor.processId)!),
    status: finalStatus,
    exitCode: finalExit ?? undefined,
    timedOut: finalTimedOut,
    cancelled: finalCancelled,
    stdoutTail: stdout.slice(-PROCESS_LOG_TAIL_BYTES),
    stderrTail: stderr.slice(-PROCESS_LOG_TAIL_BYTES),
    terminalWritten: record?.terminalWritten === true,
  };
  for (const waiter of monitor.waiters.splice(0)) waiter(forWaiters);
  liveMonitors.delete(monitor.processId);
  return record ?? forWaiters;
}

function attachRunnerMonitor(
  record: ManagedProcessRecord,
  runner: ChildProcess,
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    stdoutPath: string;
    stderrPath: string;
    exitReceiptPath: string;
    descriptorPath: string;
  },
): LiveMonitor {
  const maxDisk = options.maxOutputBytes;
  const monitor: LiveMonitor = {
    processId: record.processId,
    repoId: record.repoId,
    controllerHome: record.controllerHome,
    child: runner,
    fenceToken: record.terminalFenceToken,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutStoredBytes: 0,
    stderrStoredBytes: 0,
    stdoutTail: Buffer.alloc(0),
    stderrTail: Buffer.alloc(0),
    maxTailBytes: Math.min(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    maxDiskBytes: maxDisk,
    logTruncated: false,
    settled: false,
    waiters: [],
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    exitReceiptPath: options.exitReceiptPath,
    descriptorPath: options.descriptorPath,
    commandFingerprint: commandFingerprint(record.command),
  };

  const appendStreamChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const tailKey = stream === 'stdout' ? 'stdoutTail' : 'stderrTail';
    const bytesKey = stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
    const storedBytesKey = stream === 'stdout' ? 'stdoutStoredBytes' : 'stderrStoredBytes';
    const currentTail = monitor[tailKey];
    monitor[bytesKey] += chunk.length;
    monitor[storedBytesKey] = Math.min(maxDisk, monitor[bytesKey]);
    if (monitor[bytesKey] > maxDisk) monitor.logTruncated = true;
    monitor[tailKey] = Buffer.concat([currentTail, chunk]).subarray(-monitor.maxTailBytes);
  };

  // Attached monitors receive redacted chunks directly from the independent
  // Runner. After a Controller restart there is no pipe, so the receipt/file
  // fallback remains authoritative.
  const streaming = Boolean(runner.stdout || runner.stderr);
  runner.stdout?.on('data', (chunk: Buffer) => appendStreamChunk('stdout', Buffer.from(chunk)));
  runner.stderr?.on('data', (chunk: Buffer) => appendStreamChunk('stderr', Buffer.from(chunk)));

  // Legacy runners without the optional stream transport retain a coarse file
  // fallback. New runners never enter this timer while attached.
  const pollLogs = () => {
    if (monitor.settled) return;
    try {
      if (existsSync(options.stdoutPath)) {
        const st = statSync(options.stdoutPath);
        monitor.stdoutStoredBytes = st.size;
        monitor.stdoutBytes = Math.max(monitor.stdoutBytes, st.size);
        if (st.size >= maxDisk) monitor.logTruncated = true;
        const tail = readFileTailBytes(options.stdoutPath, monitor.maxTailBytes);
        monitor.stdoutTail = Buffer.from(tail.text, 'utf8');
      }
      if (existsSync(options.stderrPath)) {
        const st = statSync(options.stderrPath);
        monitor.stderrStoredBytes = st.size;
        monitor.stderrBytes = Math.max(monitor.stderrBytes, st.size);
        if (st.size >= maxDisk) monitor.logTruncated = true;
        const tail = readFileTailBytes(options.stderrPath, monitor.maxTailBytes);
        monitor.stderrTail = Buffer.from(tail.text, 'utf8');
      }
    } catch {
      /* best-effort */
    }
  };
  const pollTimer = streaming ? undefined : setInterval(pollLogs, 1_000);
  pollTimer?.unref?.();

  const onAbort = () => {
    void killTree(runner).finally(() => {
      if (pollTimer) clearInterval(pollTimer);
      finalizeMonitor(monitor, 'cancelled', 1, false, true, 'cancelled by signal');
    });
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  // Controller-side timeout is a safety net; runner also enforces timeout.
  monitor.timeoutHandle = setTimeout(() => {
    void killTree(runner).finally(() => {
      if (pollTimer) clearInterval(pollTimer);
      finalizeMonitor(monitor, 'timed_out', 1, true, false, `process timed out after ${options.timeoutMs}ms`);
    });
  }, Math.max(1, options.timeoutMs + 2_000));
  monitor.timeoutHandle.unref?.();

  runner.on('error', (error) => {
    if (pollTimer) clearInterval(pollTimer);
    finalizeMonitor(monitor, 'failed', 1, false, false, error.message);
    options.signal?.removeEventListener('abort', onAbort);
  });
  runner.on('close', () => {
    options.signal?.removeEventListener('abort', onAbort);
    if (pollTimer) clearInterval(pollTimer);
    pollLogs();
    const receipt = readExitReceipt(options.exitReceiptPath);
    if (receipt) {
      finalizeMonitor(
        monitor,
        statusFromReceipt(receipt),
        receipt.exitCode ?? 1,
        receipt.timedOut === true,
        receipt.cancelled === true,
      );
      return;
    }
    // Runner exited without receipt. The actual command may have succeeded or
    // failed, so do not fabricate a deterministic failure.
    finalizeMonitor(monitor, 'completed_unknown', 1, false, false, 'process runner exited without receipt; outcome unknown');
  });

  liveMonitors.set(record.processId, monitor);
  return monitor;
}

function recordToHandle(
  record: ManagedProcessRecord,
  extras?: { stdout?: string; stderr?: string; completed?: boolean; deduplicated?: boolean; semanticDeduplicated?: boolean },
): ProcessHandle {
  const hintedStatus = effectiveProcessStatus(record, extras?.completed === true);
  const completed = isTerminalProcessStatus(hintedStatus) || record.terminalWritten === true;
  const coherentRecord = hintedStatus === record.status ? record : { ...record, status: hintedStatus };
  const safeRecord = completed ? sanitizeTerminalProcessArtifacts(coherentRecord) : coherentRecord;
  return {
    processId: safeRecord.processId,
    workId: safeRecord.workId,
    commandId: safeRecord.commandId ?? safeRecord.processId,
    status: safeRecord.status,
    contractStatus: processContractStatus(safeRecord.status),
    route: safeRecord.route,
    pid: safeRecord.identity?.pid,
    startedAt: safeRecord.startedAt,
    interactiveWaitMs: safeRecord.interactiveWaitMs,
    timeoutMs: safeRecord.timeoutMs,
    completed,
    deduplicated: extras?.deduplicated,
    semanticDeduplicated: extras?.semanticDeduplicated,
    requestId: safeRecord.origin?.requestId,
    ok: completed ? safeRecord.status === 'succeeded' : undefined,
    exitCode: safeRecord.exitCode,
    timedOut: safeRecord.timedOut,
    cancelled: safeRecord.cancelled,
    stdout: extras?.stdout !== undefined ? safeProcessText(extras.stdout) : completed ? safeProcessText(safeRecord.stdoutTail ?? '') : undefined,
    stderr: extras?.stderr !== undefined ? safeProcessText(extras.stderr) : completed ? safeProcessText(safeRecord.stderrTail ?? '') : undefined,
    stdoutTail: safeRecord.stdoutTail ? safeProcessText(safeRecord.stdoutTail) : undefined,
    stderrTail: safeRecord.stderrTail ? safeProcessText(safeRecord.stderrTail) : undefined,
    durableSideEffects: {
      executionJobCount: 0,
      localJobCount: 0,
      workerSpawnCount: 0,
      projectionUpdateCount: 0,
    },
  };
}

export function processRunnerEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return repositoryChildProcessEnvironment(env);
}

function spawnProcessRunner(descriptor: ProcessCommandDescriptor, descriptorPath: string): ChildProcess {
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const entry = resolveProcessRunnerEntryPath();
  const useProcessGroup = process.platform !== 'win32';
  const invocation = runnerInvocation(entry, descriptorPath);
  // Detached so Controller crash does not kill the runner.
  return spawn(invocation.command, invocation.args, {
    cwd: descriptor.command.cwd,
    env: {
      ...processRunnerEnvironment(),
      FORGE_PROCESS_RUNNER: '1',
    },
    // The Runner always keeps bounded durable files. While Controller is
    // attached, also stream redacted chunks over pipes so it does not stat and
    // reread both log files every 100ms.
    stdio: ['ignore', descriptor.streamLogs ? 'pipe' : 'ignore', descriptor.streamLogs ? 'pipe' : 'ignore'],
    detached: useProcessGroup,
  });
}

/**
 * Spawn once via independent Process Runner.
 * If the process finishes within interactiveWaitMs, return a completed Direct handle.
 * Otherwise return a Managed handle for the same process (no re-exec).
 *
 * Ordering:
 *   classify claims → acquire execution leases → spawn Runner
 * Terminal:
 *   receipt / cancel / timeout / failure → release leases exactly once
 */
export async function spawnManagedProcess(input: SpawnManagedProcessInput): Promise<ProcessHandle> {
  if (!input.executionIdentity) {
    throw new Error('EXECUTION_IDENTITY_REQUIRED: spawnManagedProcess requires an immutable executionIdentity');
  }
  if (input.executionIdentity.repositoryId !== input.repoId) {
    throw new Error(
      `EXECUTION_IDENTITY_MISMATCH: process repo ${input.repoId} differs from identity ${input.executionIdentity.repositoryId}`,
    );
  }
  if (input.checkoutId && input.executionIdentity.checkoutId !== input.checkoutId) {
    throw new Error(
      `CHECKOUT_ROUTE_MISMATCH: process checkout ${input.checkoutId} differs from identity ${input.executionIdentity.checkoutId}`,
    );
  }
  const guardedIdentity = assertExecutionIdentity({
    controllerHome: input.controllerHome,
    identity: input.executionIdentity,
    cwd: input.command.cwd,
    requestedRepoId: input.repoId,
    requestedCheckoutId: input.checkoutId,
  });
  const command = { ...input.command, cwd: guardedIdentity.resolvedCwd };
  const interactiveWaitMs = Math.max(
    0,
    Math.min(input.interactiveWaitMs ?? DEFAULT_INTERACTIVE_WAIT_MS, 120_000),
  );
  const timeoutMs = Math.max(
    interactiveWaitMs + 1,
    Math.min(input.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS, 24 * 60 * 60_000),
  );
  const maxOutputBytes = Math.max(4_096, Math.min(input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 8 * 1024 * 1024));
  const candidateProcessId = newProcessId();
  const requestId = input.origin?.requestId?.trim() || undefined;
  const commandFingerprint = fingerprintProcessCommand(command);
  let processId = candidateProcessId;
  let semanticExisting = false;
  if (input.checkExecution) {
    const semantic = claimProcessCheckExecution({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      sourceCheckoutId: input.checkoutId,
      scopeKey: input.checkExecution.scopeKey,
      cacheKey: input.checkExecution.cacheKey,
      processId: candidateProcessId,
    });
    processId = semantic.binding.processId;
    semanticExisting = semantic.status === 'existing';
  }
  if (requestId) {
    const claim = claimProcessRequest({
      controllerHome: input.controllerHome,
      repoId: input.repoId,
      checkoutId: input.checkoutId,
      requestId,
      commandFingerprint,
      processId,
    });
    processId = claim.binding.processId;
    if (claim.status === 'existing') {
      const existing = getProcessHandle(input.controllerHome, input.repoId, processId);
      if (!existing) {
        throw new Error(`PROCESS_REQUEST_INCOMPLETE: request ${requestId} is bound to missing process ${processId}; refusing re-execution`);
      }
      return { ...existing, deduplicated: true, semanticDeduplicated: semanticExisting || existing.semanticDeduplicated, requestId };
    }
  }
  if (semanticExisting) {
    let existing = getProcessHandle(input.controllerHome, input.repoId, processId);
    for (let attempt = 0; !existing && attempt < 20; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      existing = getProcessHandle(input.controllerHome, input.repoId, processId);
    }
    if (!existing) {
      throw new Error(`PROCESS_CHECK_EXECUTION_INCOMPLETE: semantic Check binding points to missing process ${processId}; refusing duplicate execution`);
    }
    return { ...existing, deduplicated: true, semanticDeduplicated: true, requestId };
  }
  const fenceToken = 1;
  const startedAt = nowIso();
  const logDir = processLogDir(input.controllerHome, input.repoId);
  mkdirSync(logDir, { recursive: true });
  const stdoutPath = join(logDir, `${processId}.stdout.log`);
  const stderrPath = join(logDir, `${processId}.stderr.log`);
  const exitReceiptPath = receiptPathFor(input.controllerHome, input.repoId, processId);
  const descriptorPath = descriptorPathFor(input.controllerHome, input.repoId, processId);
  const resourceClaims = toProcessClaims(scopeResourceClaims(
    toResourceClaimSpecs(input.resourceClaims ?? []),
    input.repoId,
    input.checkoutId,
    input.workId,
  ));

  const runtimeClaim = getRuntimeWriteClaim();
  const record: ManagedProcessRecord = {
    schemaVersion: 1,
    processId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    workId: input.workId,
    commandId: input.commandId?.trim() || processId,
    requestFingerprint: requestId ? commandFingerprint : undefined,
    checkExecution: input.checkExecution,
    controllerHome: input.controllerHome,
    status: 'starting',
    route: input.returnHandleImmediately || interactiveWaitMs === 0 ? 'managed' : 'direct',
    command,
    resourceClaims,
    interactiveWaitMs,
    timeoutMs,
    maxOutputBytes,
    startedAt,
    updatedAt: startedAt,
    terminalFenceToken: fenceToken,
    runtimeInstanceId: input.runtimeInstanceId ?? runtimeClaim?.runtimeInstanceId,
    releaseAuthorityRevision: input.releaseAuthorityRevision ?? runtimeClaim?.releaseAuthorityRevision,
    releaseId: input.releaseId ?? runtimeClaim?.releaseId,
    artifactIdentity: input.artifactIdentity ?? runtimeClaim?.artifactIdentity,
    workerProtocolVersion: input.workerProtocolVersion ?? runtimeClaim?.workerProtocolVersion,
    origin: input.origin,
    exitReceiptPath,
    stdoutPath,
    stderrPath,
    commandDescriptorPath: descriptorPath,
    logPath: stdoutPath,
  };
  createProcessRecord(record);

  if (input.signal?.aborted) {
    completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
      status: 'cancelled',
      exitCode: 1,
      cancelled: true,
      errorMessage: 'cancelled before spawn',
      exitReceiptPath,
    });
    const cancelled = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle(cancelled, { completed: true, stdout: '', stderr: 'cancelled before spawn' });
  }

  // Refuse to re-exec if receipt already exists (exactly-once).
  if (existsSync(exitReceiptPath)) {
    const receipt = readExitReceipt(exitReceiptPath);
    if (receipt) {
      const completed = completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
        status: statusFromReceipt(receipt),
        exitCode: receipt.exitCode,
        timedOut: receipt.timedOut,
        cancelled: receipt.cancelled,
        finishedAt: receipt.finishedAt,
        exitReceiptPath,
        stdoutBytes: receipt.stdoutBytes,
        stderrBytes: receipt.stderrBytes,
        logTruncated: receipt.logTruncated,
      });
      return recordToHandle(completed!, { completed: true });
    }
    // Corrupt receipt present: do not re-exec; surface completed_unknown.
    const completed = completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
      status: 'completed_unknown',
      exitCode: 1,
      exitReceiptPath,
      errorMessage: 'exit receipt exists but is corrupt; refusing re-exec',
    });
    return recordToHandle(completed!, { completed: true });
  }

  // Acquire real execution leases BEFORE spawning the runner. Fail closed on conflict.
  let leaseRefs: ProcessLeaseRef[] = [];
  if (resourceClaims.length > 0) {
    let acquisition: ReturnType<typeof acquireExecutionLeases>;
    try {
      acquisition = acquireExecutionLeases(
        input.controllerHome,
        input.repoId,
        processOwnerJobId(processId),
        toResourceClaimSpecs(resourceClaims),
        {
          ttlMs: Math.max(30_000, timeoutMs + 30_000),
          visibility: 'ephemeral',
          notifyScheduler: false,
          invalidateProjection: false,
          emitRuntimeEvent: false,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
        status: 'failed',
        exitCode: 1,
        errorMessage: `PROCESS_LEASE_ACQUISITION_FAILED_BEFORE_SPAWN: ${message}`,
        exitReceiptPath,
      }, { authority: 'durable_pre_spawn_abandonment' });
      return recordToHandle(failed ?? record, { completed: true, stdout: '', stderr: message });
    }
    if (!acquisition.acquired) {
      const blockers = acquisition.blockers
        .map((b) => `${b.resourceKey}@${b.ownerJobId}`)
        .join(', ');
      completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
        status: 'failed',
        exitCode: 1,
        errorMessage: `PROCESS_LEASE_CONFLICT: ${blockers || 'resource busy'}`,
        exitReceiptPath,
      });
      const failed = getProcessRecord(input.controllerHome, input.repoId, processId)!;
      return recordToHandle(failed, {
        completed: true,
        stdout: '',
        stderr: failed.error?.message ?? `PROCESS_LEASE_CONFLICT: ${blockers}`,
      });
    }
    leaseRefs = acquisition.leases.map((lease) => ({
      leaseId: lease.leaseId,
      resourceKey: lease.resourceKey,
      fencingToken: lease.fencingToken,
      expiresAt: lease.expiresAt,
      repoId: lease.repoId,
      checkoutId: lease.checkoutId,
      workId: lease.workId,
    }));
    updateProcessRecord(input.controllerHome, input.repoId, processId, { leaseRefs });
  }

  const descriptor: ProcessCommandDescriptor = {
    schemaVersion: 1,
    processId,
    repoId: input.repoId,
    controllerHome: input.controllerHome,
    command,
    timeoutMs,
    maxStdoutBytes: maxOutputBytes,
    maxStderrBytes: maxOutputBytes,
    stdoutPath,
    stderrPath,
    exitReceiptPath,
    startedAt,
    streamLogs: true,
  };

  let runner: ChildProcess;
  try {
    runner = spawnProcessRunner(descriptor, descriptorPath);
  } catch (error) {
    // Spawn failed — release any leases acquired above.
    releaseProcessLeasesOnce(input.controllerHome, input.repoId, processId);
    const message = error instanceof Error ? error.message : String(error);
    completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
      status: 'failed',
      exitCode: 1,
      errorMessage: message,
      exitReceiptPath,
    });
    const failed = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle(failed, { completed: true, stdout: '', stderr: message });
  }

  // Unref so controller event loop can exit independently of long-lived runners
  // only after we have identity — keep ref while monitoring.
  try {
    runner.unref?.();
  } catch {
    /* ignore */
  }

  // Immediate spawn failure (no PID) → release leases.
  if (!runner.pid) {
    releaseProcessLeasesOnce(input.controllerHome, input.repoId, processId);
    completeProcessFromEvidence(input.controllerHome, input.repoId, processId, fenceToken, {
      status: 'failed',
      exitCode: 1,
      errorMessage: 'process runner failed to spawn (no pid)',
      exitReceiptPath,
    });
    const failed = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle(failed, { completed: true, stdout: '', stderr: 'process runner failed to spawn' });
  }

  const captured = captureIdentity(runner.pid);
  updateProcessRecord(input.controllerHome, input.repoId, processId, {
    status: 'running',
    identity: captured.identity,
    identityUntrusted: captured.identityUntrusted === true,
    exitReceiptPath,
    logPath: stdoutPath,
    stdoutPath,
    stderrPath,
    leaseRefs,
  });

  const monitor = attachRunnerMonitor(
    { ...record, status: 'running', identity: captured.identity, leaseRefs },
    runner,
    {
      timeoutMs,
      maxOutputBytes,
      signal: input.signal,
      stdoutPath,
      stderrPath,
      exitReceiptPath,
      descriptorPath,
    },
  );

  if (input.returnHandleImmediately || interactiveWaitMs === 0) {
    updateProcessRecord(input.controllerHome, input.repoId, processId, { route: 'managed' });
    const current = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle({ ...current, route: 'managed' }, { completed: false });
  }

  const completed = await new Promise<ManagedProcessRecord | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), interactiveWaitMs);
    timer.unref?.();
    monitor.waiters.push((done) => {
      clearTimeout(timer);
      resolve(done);
    });
    if (monitor.settled) {
      const current = getProcessRecord(input.controllerHome, input.repoId, processId);
      if (current?.terminalWritten) {
        clearTimeout(timer);
        resolve(current);
      }
    }
  });

  if (completed === 'timeout') {
    updateProcessRecord(input.controllerHome, input.repoId, processId, { route: 'managed' });
    const current = getProcessRecord(input.controllerHome, input.repoId, processId)!;
    return recordToHandle({ ...current, route: 'managed' }, { completed: false });
  }

  const stdout = monitor.stdoutTail.length
    ? capProcessOutput(safeProcessText(monitor.stdoutTail.toString('utf8')), maxOutputBytes)
    : completed.stdoutTail ?? '';
  const stderr = monitor.stderrTail.length
    ? capProcessOutput(safeProcessText(monitor.stderrTail.toString('utf8')), maxOutputBytes)
    : completed.stderrTail ?? '';
  return recordToHandle(completed, { completed: true, stdout, stderr });
}

function applyReceiptIfPresent(
  controllerHome: string,
  repoId: string,
  processId: string,
  record: ManagedProcessRecord,
): ManagedProcessRecord | undefined {
  const receipt = readExitReceipt(record.exitReceiptPath) ?? readExitReceipt(receiptPathFor(controllerHome, repoId, processId));
  if (!receipt) return undefined;
  if (receipt.processId !== processId) return undefined;
  if (!receipt.finishedAt || !Number.isFinite(Date.parse(receipt.finishedAt))) return undefined;
  if (receipt.commandExecutedOnce === false) return undefined;
  if (receipt.exitCode !== null && !Number.isInteger(receipt.exitCode)) return undefined;
  return completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
    status: statusFromReceipt(receipt),
    exitCode: receipt.exitCode,
    timedOut: receipt.timedOut,
    cancelled: receipt.cancelled,
    finishedAt: receipt.finishedAt,
    exitReceiptPath: record.exitReceiptPath ?? receiptPathFor(controllerHome, repoId, processId),
    stdoutBytes: receipt.stdoutBytes,
    stderrBytes: receipt.stderrBytes,
    stdoutStoredBytes: receipt.stdoutStoredBytes,
    stderrStoredBytes: receipt.stderrStoredBytes,
    logTruncated: receipt.logTruncated,
  }, { authority: 'durable_exit_receipt' });
}

export function getProcessHandle(
  controllerHome: string,
  repoId: string,
  processId: string,
): ProcessHandle | undefined {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) return undefined;
  if (isManagedProcessActive(record) && !liveMonitors.has(processId)) {
    const fromReceipt = applyReceiptIfPresent(controllerHome, repoId, processId, record);
    if (fromReceipt) return recordToHandle(fromReceipt, { completed: true });
    if (!identityStillMatches(record.identity, record.identityUntrusted)) {
      const completed = completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
        status: 'completed_unknown',
        errorMessage: 'process no longer matches stored identity; exit code unknown',
      });
      return completed ? recordToHandle(completed, { completed: true }) : undefined;
    }
  }
  return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!);
}

export async function waitForProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
  options: WaitProcessOptions = {},
): Promise<ProcessHandle> {
  const existing = getProcessRecord(controllerHome, repoId, processId);
  if (!existing) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
  if (existing.terminalWritten) return recordToHandle(existing, { completed: true });

  const monitor = liveMonitors.get(processId);
  if (monitor) {
    const waitMs = options.timeoutMs ?? existing.timeoutMs;
    const done = await new Promise<ManagedProcessRecord | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), Math.max(1, waitMs));
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        void cancelProcess(controllerHome, repoId, processId).then(() => {
          const current = getProcessRecord(controllerHome, repoId, processId);
          if (current) resolve(current);
          else resolve('timeout');
        });
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      monitor.waiters.push((record) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(record);
      });
      if (monitor.settled) {
        const current = getProcessRecord(controllerHome, repoId, processId);
        if (current?.terminalWritten) {
          clearTimeout(timer);
          resolve(current);
        }
      }
    });
    if (done === 'timeout') {
      return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: false });
    }
    return recordToHandle(done, { completed: true });
  }

  // No live monitor — poll receipt / identity (Controller restart attach path).
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 15_000);
  let pollIntervalMs = 100;
  while (Date.now() < deadline) {
    const current = getProcessRecord(controllerHome, repoId, processId);
    if (!current) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
    if (current.terminalWritten) return recordToHandle(current, { completed: true });
    const fromReceipt = applyReceiptIfPresent(controllerHome, repoId, processId, current);
    if (fromReceipt) return recordToHandle(fromReceipt, { completed: true });
    if (!identityStillMatches(current.identity, current.identityUntrusted)) {
      // PID gone and no receipt → completed_unknown.
      const completed = completeProcessFromEvidence(controllerHome, repoId, processId, current.terminalFenceToken, {
        status: 'completed_unknown',
        errorMessage: 'process exited while controller was offline and no exit receipt was found',
      });
      return recordToHandle(completed!, { completed: true });
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pollIntervalMs = Math.min(1_000, pollIntervalMs * 2);
  }
  return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: false });
}

export async function cancelProcess(
  controllerHome: string,
  repoId: string,
  processId: string,
): Promise<ProcessHandle> {
  const record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) throw new Error(`PROCESS_NOT_FOUND: ${processId}`);
  if (record.terminalWritten) return recordToHandle(record, { completed: true });

  // Process control is itself a writer mutation. Fence BEFORE sending any
  // signal so a passive/stale runtime cannot kill the active runtime's work.
  assertRuntimeMayWriteOrThrow('cancel_process', controllerHome);

  const monitor = liveMonitors.get(processId);
  if (monitor) {
    await killTree(monitor.child);
    await new Promise((r) => setTimeout(r, 100));
    const after = getProcessRecord(controllerHome, repoId, processId);
    if (after && !after.terminalWritten) {
      // Write controller-side cancel receipt if runner did not.
      const path = after.exitReceiptPath ?? receiptPathFor(controllerHome, repoId, processId);
      if (!existsSync(path)) {
        writeExitReceipt(path, {
          schemaVersion: 1,
          processId,
          exitCode: 1,
          finishedAt: nowIso(),
          cancelled: true,
        });
      }
      completeProcessFromEvidence(controllerHome, repoId, processId, after.terminalFenceToken, {
        status: 'cancelled',
        exitCode: 1,
        cancelled: true,
        exitReceiptPath: path,
      });
    }
    return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
  }

  if (record.identity && !record.identityUntrusted && identityStillMatches(record.identity, false)) {
    await terminateProcessTree(record.identity.pid, {
      gracePeriodMs: 200,
      killAfterMs: 1_500,
      pollIntervalMs: 25,
    });
  } else if (record.identityUntrusted || record.identity?.processStartTime?.startsWith('untrusted:')) {
    completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
      status: 'completed_unknown',
      cancelled: true,
      errorMessage: 'refusing to signal PID without verified start time',
    });
    return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
  }

  const path = record.exitReceiptPath ?? receiptPathFor(controllerHome, repoId, processId);
  if (!existsSync(path)) {
    writeExitReceipt(path, {
      schemaVersion: 1,
      processId,
      exitCode: 1,
      finishedAt: nowIso(),
      cancelled: true,
    });
  }
  completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
    status: 'cancelled',
    exitCode: 1,
    cancelled: true,
    exitReceiptPath: path,
  });
  return recordToHandle(getProcessRecord(controllerHome, repoId, processId)!, { completed: true });
}

export function readProcessLogs(
  controllerHome: string,
  repoId: string,
  processId: string,
  maxBytes = PROCESS_LOG_TAIL_BYTES,
): ProcessLogSlice | undefined {
  let record = getProcessRecord(controllerHome, repoId, processId);
  if (!record) return undefined;
  record = sanitizeTerminalProcessArtifacts(record);
  const stdout = readFileTailBytes(record.stdoutPath ?? '', maxBytes);
  const stderr = readFileTailBytes(record.stderrPath ?? '', maxBytes);
  return {
    processId,
    stdout: stdout.text || safeProcessText(record.stdoutTail ?? ''),
    stderr: stderr.text || safeProcessText(record.stderrTail ?? ''),
    stdoutBytes: stdout.fileBytes || record.stdoutBytes || 0,
    stderrBytes: stderr.fileBytes || record.stderrBytes || 0,
    truncated: stdout.fileBytes > maxBytes || stderr.fileBytes > maxBytes || record.logTruncated === true,
  };
}

/**
 * Sanitize bounded historical Process Runtime artifacts without returning any
 * command output. Active processes are left alone because their runner may
 * still be appending; new runners redact before persistence.
 */
export function sanitizeHistoricalProcessArtifacts(
  controllerHome: string,
  repoId: string,
  limit = 10_000,
): { scanned: number; eligible: number; changed: number; failed: number; processIds: string[] } {
  const records = listProcessRecords(controllerHome, repoId, Math.max(1, limit));
  let eligible = 0;
  let changed = 0;
  let failed = 0;
  const processIds: string[] = [];
  for (const record of records) {
    if (!isManagedProcessTerminal(record)) continue;
    eligible += 1;
    try {
      const before = record.outputRedaction?.sanitizedAt;
      const sanitized = sanitizeTerminalProcessArtifacts(record);
      if (sanitized.outputRedaction?.sanitizedAt && sanitized.outputRedaction.sanitizedAt !== before) {
        changed += 1;
        processIds.push(record.processId);
      }
    } catch {
      failed += 1;
    }
  }
  return { scanned: records.length, eligible, changed, failed, processIds };
}

/**
 * Re-discover running processes after Controller restart.
 * Does not re-spawn; only re-validates identity and applies runner receipts.
 * Releases leases for terminal processes (exactly once) when this runtime may write.
 */
export function recoverManagedProcesses(
  controllerHome: string,
  repoId: string,
): { recovered: string[]; orphaned: string[]; completedUnknown: string[]; completedFromReceipt: string[]; leasesReleased: string[] } {
  const recovered: string[] = [];
  const orphaned: string[] = [];
  const completedUnknown: string[] = [];
  const completedFromReceipt: string[] = [];
  const leasesReleased: string[] = [];
  // Terminal records are deliberately removed from active-index.json. Scan
  // the bounded durable record set as well, otherwise a controller crash
  // between terminal CAS and lease release leaks the process lease forever.
  for (const record of listProcessRecords(controllerHome, repoId, 5_000)) {
    const processId = record.processId;
    if (liveMonitors.has(processId)) {
      recovered.push(processId);
      continue;
    }
    if (isManagedProcessTerminal(record)) {
      sanitizeTerminalProcessArtifacts(record);
      // Cleanup leftover leases after crash between terminal write and release.
      if (record.leasesReleased !== true && (record.leaseRefs?.length ?? 0) > 0) {
        const after = releaseProcessLeasesOnce(controllerHome, repoId, processId);
        if (after?.leasesReleased) leasesReleased.push(processId);
      }
      continue;
    }

    const fromReceipt = applyReceiptIfPresent(controllerHome, repoId, processId, record);
    if (fromReceipt) {
      sanitizeTerminalProcessArtifacts(fromReceipt);
      completedFromReceipt.push(processId);
      if (fromReceipt.leasesReleased) leasesReleased.push(processId);
      continue;
    }

    if (identityStillMatches(record.identity, record.identityUntrusted) && !processRuntimeIdentityMatches(record)) {
      // The PID may still be alive, but it belongs to a different runtime
      // generation/instance. Do not renew or release its leases from here.
      continue;
    }

    if (identityStillMatches(record.identity, record.identityUntrusted)) {
      updateProcessRecord(controllerHome, repoId, processId, {
        status: 'running_recovered',
        route: 'managed',
      }, { allowTerminal: false });
      // Renew leases for recovered running processes when possible.
      if ((record.leaseRefs?.length ?? 0) > 0) {
        try {
          renewExecutionLeases(
            controllerHome,
            repoId,
            processOwnerJobId(processId),
            Math.max(30_000, record.timeoutMs),
            record.leaseRefs!.map((ref) => ({
              leaseId: ref.leaseId,
              fencingToken: ref.fencingToken,
              resourceKey: ref.resourceKey,
            })),
          );
        } catch {
          /* fenced or missing — leave for active writer */
        }
      }
      recovered.push(processId);
      continue;
    }

    if (record.identityUntrusted || record.identity?.processStartTime?.startsWith('untrusted:') || record.identity?.processStartTime?.startsWith('fallback:')) {
      const completed = completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
        status: 'completed_unknown',
        errorMessage: 'process identity was untrusted; exit code cannot be recovered after restart',
      });
      if (completed) sanitizeTerminalProcessArtifacts(completed);
      completedUnknown.push(processId);
      continue;
    }

    // PID gone, no receipt → completed_unknown (releases leases).
    const completed = completeProcessFromEvidence(controllerHome, repoId, processId, record.terminalFenceToken, {
      status: 'completed_unknown',
      errorMessage: 'process no longer running and no exit receipt after controller restart',
    });
    if (completed) sanitizeTerminalProcessArtifacts(completed);
    completedUnknown.push(processId);
  }
  return { recovered, orphaned, completedUnknown, completedFromReceipt, leasesReleased };
}

export function listLiveMonitorIds(): string[] {
  return [...liveMonitors.keys()];
}

export function processRuntimeResourceDiagnostics(): {
  monitorCount: number;
  logPollerCount: number;
  timeoutCount: number;
  waiterCount: number;
  activeProcessIds: string[];
} {
  const monitors = [...liveMonitors.values()];
  return {
    monitorCount: monitors.length,
    // Attached monitors stream redacted chunks over pipes; the disk-log poller
    // is only a legacy fallback and is never active for new runners.
    logPollerCount: 0,
    timeoutCount: monitors.filter((monitor) => Boolean(monitor.timeoutHandle)).length,
    waiterCount: monitors.reduce((total, monitor) => total + monitor.waiters.length, 0),
    activeProcessIds: monitors.map((monitor) => monitor.processId),
  };
}

/** Test helper: drop in-memory monitors without killing OS processes / runners. */
export function __resetLiveMonitorsForTests(): void {
  for (const monitor of liveMonitors.values()) {
    if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle);
  }
  liveMonitors.clear();
}

/** Test helper: simulate controller crash by dropping monitors while runners keep running. */
export function __detachMonitorsKeepRunnersForTests(): string[] {
  const ids = [...liveMonitors.keys()];
  for (const monitor of liveMonitors.values()) {
    if (monitor.timeoutHandle) clearTimeout(monitor.timeoutHandle);
    // Detach close listeners so this controller process no longer finalizes.
    try {
      monitor.child.removeAllListeners('close');
      monitor.child.removeAllListeners('error');
      monitor.child.unref?.();
    } catch {
      /* ignore */
    }
  }
  liveMonitors.clear();
  return ids;
}

// silence unused helpers retained for local tail buffering paths
void openSync;
void appendTail;
type _RunnerReceipt = ProcessRunnerExitReceipt;
