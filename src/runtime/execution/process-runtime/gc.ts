/**
 * Process Runtime log quota helpers and terminal record GC.
 *
 * - Active processes are never GC'd.
 * - GC requires writer authority.
 * - GC failures must not throw into the controller main loop.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { ensureRepositoryControllerLayout, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { getProcessRecord, listActiveProcessIds } from './store';
import { reconcileStaleManagedProcessForMaintenance } from './runtime';
import { isManagedProcessActive, type ProcessRuntimeStatus } from './types';
import { assertRuntimeMayWrite } from '../../root/write-fence';
import { isProcessAlive } from '../../shared/process-tree';

const TERMINAL: ReadonlySet<ProcessRuntimeStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'orphaned',
  'completed_unknown',
  'unknown',
]);

export interface ProcessGcOptions {
  controllerHome: string;
  repoId: string;
  /** Keep terminal records newer than this age (default 7d). */
  maxAgeMs?: number;
  /** Max terminal records to retain per repo (default 500). */
  maxTerminalRecords?: number;
  /** Also delete associated log/receipt files. */
  deleteLogs?: boolean;
  /** Minimum age before an active record is eligible for evidence-based stale reconciliation (default 5m). */
  staleActiveMinAgeMs?: number;
  /** Max stale active records to reconcile in one selected-repository GC pass (default 100). */
  maxStaleReconciliations?: number;
}

export interface ProcessGcResult {
  ok: boolean;
  removedRecords: number;
  removedLogs: number;
  skippedActive: number;
  reconciledStaleActive: number;
  /** Legacy/corrupt records without enough terminal proof are preserved. */
  skippedInvalid?: number;
  error?: string;
}

function processesDir(controllerHome: string, repoId: string): string {
  return join(ensureRepositoryControllerLayout(controllerHome, repoId), 'processes');
}

function logDir(controllerHome: string, repoId: string): string {
  return join(processesDir(controllerHome, repoId), 'logs');
}

interface ProcessGcMetadata {
  status?: ProcessRuntimeStatus;
  finishedAt?: string;
  updatedAt?: string;
  identity?: { pid: number; processStartTime: string };
  identityUntrusted?: boolean;
  reusableCheckEvidence: boolean;
}

/**
 * GC deliberately reads only the metadata needed to prove terminality. Historical
 * Process records can predate today's required command descriptor; feeding those
 * records through the normal recovery reader would either throw during redaction
 * or, worse, require manufacturing a fake executable. A malformed/unknown record
 * is skipped rather than deleted, preserving fail-closed recovery semantics.
 */
function readProcessGcMetadata(path: string): ProcessGcMetadata | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (raw.schemaVersion !== 1) return undefined;
    const status = typeof raw.status === 'string' && TERMINAL.has(raw.status as ProcessRuntimeStatus)
      ? raw.status as ProcessRuntimeStatus
      : typeof raw.status === 'string'
        ? raw.status as ProcessRuntimeStatus
        : undefined;
    const identityRaw = raw.identity && typeof raw.identity === 'object' && !Array.isArray(raw.identity)
      ? raw.identity as Record<string, unknown>
      : undefined;
    const pid = typeof identityRaw?.pid === 'number' && Number.isInteger(identityRaw.pid) && identityRaw.pid > 0
      ? identityRaw.pid
      : undefined;
    const processStartTime = typeof identityRaw?.processStartTime === 'string' ? identityRaw.processStartTime : undefined;
    const checkExecution = raw.checkExecution && typeof raw.checkExecution === 'object' && !Array.isArray(raw.checkExecution)
      ? raw.checkExecution as Record<string, unknown>
      : undefined;
    return {
      status,
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
      ...(pid && processStartTime ? { identity: { pid, processStartTime } } : {}),
      identityUntrusted: raw.identityUntrusted === true,
      reusableCheckEvidence: status === 'succeeded' && typeof checkExecution?.cacheKey === 'string' && checkExecution.cacheKey.length > 0,
    };
  } catch {
    return undefined;
  }
}

function safeUnlink(path: string): boolean {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * GC terminal process records and logs. Never removes active processes.
 * Requires active writer fencing; on fence/error returns ok=false without throwing.
 */
export function gcTerminalProcesses(options: ProcessGcOptions): ProcessGcResult {
  try {
    const fence = assertRuntimeMayWrite('cleanup', options.controllerHome);
    if (!fence.allowed) {
      return {
        ok: false,
        removedRecords: 0,
        removedLogs: 0,
        skippedActive: 0,
        reconciledStaleActive: 0,
        error: `writer_fenced:${fence.reason ?? 'denied'}`,
      };
    }

    const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60_000;
    const maxTerminal = options.maxTerminalRecords ?? 500;
    const staleActiveMinAgeMs = Math.max(1_000, options.staleActiveMinAgeMs ?? 5 * 60_000);
    const maxStaleReconciliations = Math.max(0, options.maxStaleReconciliations ?? 100);
    const root = processesDir(options.controllerHome, options.repoId);
    if (!existsSync(root)) {
      return { ok: true, removedRecords: 0, removedLogs: 0, skippedActive: 0, reconciledStaleActive: 0 };
    }

    const active = new Set(listActiveProcessIds(options.controllerHome, options.repoId));
    const terminal: Array<{ processId: string; finishedAt: number; path: string; reusableCheckEvidence: boolean }> = [];
    let skippedActive = 0;
    let skippedInvalid = 0;
    let reconciledStaleActive = 0;
    const nowMs = Date.now();

    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json') || name === 'active-index.json') continue;
      const processId = name.slice(0, -'.json'.length);
      if (active.has(processId)) {
        let record = getProcessRecord(options.controllerHome, options.repoId, processId);
        if (!record) {
          skippedActive += 1;
          continue;
        }
        if (isManagedProcessActive(record) && reconciledStaleActive < maxStaleReconciliations) {
          const reconciled = reconcileStaleManagedProcessForMaintenance(
            options.controllerHome,
            options.repoId,
            processId,
            { nowMs, minAgeMs: staleActiveMinAgeMs },
          );
          if (reconciled) {
            if (isManagedProcessActive(record) && !isManagedProcessActive(reconciled)) reconciledStaleActive += 1;
            record = reconciled;
          }
        }
        if (isManagedProcessActive(record)) {
          skippedActive += 1;
          continue;
        }
      }
      const metadata = readProcessGcMetadata(join(root, name));
      if (!metadata?.status) {
        skippedInvalid += 1;
        continue;
      }
      // Skip still-alive identity matches even if status drifted.
      if (metadata.identity && !metadata.identityUntrusted && !metadata.identity.processStartTime.startsWith('untrusted:')) {
        try {
          if (isProcessAlive(metadata.identity.pid)) {
            skippedActive += 1;
            continue;
          }
        } catch {
          /* ignore probe failures */
        }
      }
      if (!TERMINAL.has(metadata.status)) continue;
      // Do not delete terminal evidence that has never been read when maxAge is not exceeded
      // unless we are strictly over maxTerminalRecords budget (handled by sort below).
      const finished = Date.parse(metadata.finishedAt ?? metadata.updatedAt ?? '');
      terminal.push({
        processId,
        finishedAt: Number.isFinite(finished) ? finished : 0,
        path: join(root, name),
        reusableCheckEvidence: metadata.reusableCheckEvidence,
      });
    }

    terminal.sort((a, b) => b.finishedAt - a.finishedAt);
    const cutoff = Date.now() - maxAgeMs;
    const victims = terminal.filter((entry, index) =>
      index >= maxTerminal || (!entry.reusableCheckEvidence && entry.finishedAt < cutoff),
    );

    let removedRecords = 0;
    let removedLogs = 0;
    const logs = logDir(options.controllerHome, options.repoId);
    for (const victim of victims) {
      if (safeUnlink(victim.path)) removedRecords += 1;
      if (options.deleteLogs !== false) {
        for (const suffix of ['.stdout.log', '.stderr.log', '.exit.json', '.exit.json.started.json']) {
          if (safeUnlink(join(logs, `${victim.processId}${suffix}`))) removedLogs += 1;
        }
      }
    }

    return { ok: true, removedRecords, removedLogs, skippedActive, reconciledStaleActive, skippedInvalid };
  } catch (error) {
    return {
      ok: false,
      removedRecords: 0,
      removedLogs: 0,
      skippedActive: 0,
      reconciledStaleActive: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Best-effort single-process log size check (for diagnostics). */
export function processLogBytes(controllerHome: string, repoId: string, processId: string): number {
  const logs = logDir(controllerHome, repoId);
  let total = 0;
  for (const suffix of ['.stdout.log', '.stderr.log']) {
    const path = join(logs, `${processId}${suffix}`);
    try {
      if (existsSync(path)) total += statSync(path).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

// silence unused import for type-only path helpers
void repositoryControllerRoot;
