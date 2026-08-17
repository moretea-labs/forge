/**
 * Durable Managed Process records under controller-home repositories.
 * Layout: repositories/<repoId>/processes/<processId>.json
 * Recovery membership authority: SQLite process_recovery_index/v2.
 */

import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { ensureRepositoryControllerLayout, repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { mutateControlPlaneRecord, readOrImportControlPlaneRecord } from '../../control-plane/persistence/sqlite-store';
import { isSensitiveOutputKey, redactSensitiveText } from '../../evidence/sensitive-output';
import {
  isManagedProcessActive,
  isManagedProcessTerminal,
  type ManagedProcessRecord,
  type ProcessCheckExecutionBinding,
  type ProcessInvocationBinding,
  type ProcessRequestBinding,
  type ProcessRuntimeStatus,
} from './types';

function processesRoot(controllerHome: string, repoId: string): string {
  const root = ensureRepositoryControllerLayout(controllerHome, repoId);
  const dir = join(root, 'processes');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function processPath(controllerHome: string, repoId: string, processId: string): string {
  return join(processesRoot(controllerHome, repoId), `${processId}.json`);
}

function requestBindingsRoot(controllerHome: string, repoId: string): string {
  const dir = join(processesRoot(controllerHome, repoId), 'request-bindings');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function requestBindingPath(controllerHome: string, repoId: string, checkoutId: string | undefined, requestId: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify({ repoId, checkoutId: checkoutId?.trim() || null, requestId }))
    .digest('hex');
  return join(requestBindingsRoot(controllerHome, repoId), `${key}.json`);
}

function bindingKey(repoId: string, checkoutId: string | undefined, requestId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ repoId, checkoutId: checkoutId?.trim() || null, requestId }))
    .digest('hex');
}

function invocationBindingsRoot(controllerHome: string, repoId: string): string {
  const dir = join(processesRoot(controllerHome, repoId), 'invocation-bindings');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function invocationBindingPath(controllerHome: string, repoId: string, checkoutId: string | undefined, requestId: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify({ repoId, checkoutId: checkoutId?.trim() || null, requestId }))
    .digest('hex');
  return join(invocationBindingsRoot(controllerHome, repoId), `${key}.json`);
}

function checkExecutionBindingsRoot(controllerHome: string, repoId: string): string {
  const dir = join(processesRoot(controllerHome, repoId), 'check-execution-bindings');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function checkExecutionBindingKey(repoId: string, scopeKey: string, cacheKey: string): string {
  return createHash('sha256').update(JSON.stringify({ repoId, scopeKey, cacheKey })).digest('hex');
}

function checkExecutionBindingPath(controllerHome: string, repoId: string, scopeKey: string, cacheKey: string): string {
  return join(checkExecutionBindingsRoot(controllerHome, repoId), `${checkExecutionBindingKey(repoId, scopeKey, cacheKey)}.json`);
}

interface ProcessRecoveryIndex {
  schemaVersion: 2;
  updatedAt: string;
  activeProcessIds: string[];
  pendingLeaseReleaseIds: string[];
}

const PROCESS_RECOVERY_INDEX_NAMESPACE = 'process_recovery_index';
const PROCESS_RECOVERY_INDEX_KEY = 'v2';

function normalizedProcessIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))].sort();
}

function needsPendingLeaseRelease(record: ManagedProcessRecord): boolean {
  return isManagedProcessTerminal(record)
    && record.leasesReleased !== true
    && (record.leaseRefs?.length ?? 0) > 0;
}

function processRecoveryMembership(record: ManagedProcessRecord): { active: boolean; pendingLeaseRelease: boolean } {
  return {
    active: isManagedProcessActive(record),
    pendingLeaseRelease: needsPendingLeaseRelease(record),
  };
}

function readRecoveryIndex(controllerHome: string, repoId: string): ProcessRecoveryIndex | undefined {
  return readOrImportControlPlaneRecord<ProcessRecoveryIndex>(controllerHome, {
    namespace: PROCESS_RECOVERY_INDEX_NAMESPACE,
    scope: repoId,
    key: PROCESS_RECOVERY_INDEX_KEY,
    schemaVersion: 2,
    // Deliberately do not import active-index.json. Historical v1 projections
    // can be stale after concurrent rebuilds; the first v2 read performs one
    // authoritative full reconciliation instead.
    readLegacy: () => undefined,
  })?.value;
}

function replaceRecoveryIndex(
  controllerHome: string,
  repoId: string,
  activeProcessIds: readonly string[],
  pendingLeaseReleaseIds: readonly string[],
  action: string,
): ProcessRecoveryIndex {
  const value = mutateControlPlaneRecord<ProcessRecoveryIndex>(controllerHome, {
    namespace: PROCESS_RECOVERY_INDEX_NAMESPACE,
    scope: repoId,
    key: PROCESS_RECOVERY_INDEX_KEY,
    schemaVersion: 2,
    action,
    mutate: () => ({
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      activeProcessIds: normalizedProcessIds(activeProcessIds),
      pendingLeaseReleaseIds: normalizedProcessIds(pendingLeaseReleaseIds),
    }),
  }).value;
  return value;
}

function rebuildRecoveryIndex(controllerHome: string, repoId: string): ProcessRecoveryIndex {
  const root = processesRoot(controllerHome, repoId);
  const active: string[] = [];
  const pendingLeaseRelease: string[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json') || entry === 'active-index.json') continue;
    const record = readProcessRecord(join(root, entry));
    if (!record) continue;
    const membership = processRecoveryMembership(record);
    if (membership.active) active.push(record.processId);
    if (membership.pendingLeaseRelease) pendingLeaseRelease.push(record.processId);
  }
  return replaceRecoveryIndex(
    controllerHome,
    repoId,
    active,
    pendingLeaseRelease,
    'process_recovery_index_rebuild',
  );
}

function ensureRecoveryIndex(controllerHome: string, repoId: string): ProcessRecoveryIndex {
  return readRecoveryIndex(controllerHome, repoId) ?? rebuildRecoveryIndex(controllerHome, repoId);
}

function updateRecoveryIndexMembership(
  controllerHome: string,
  repoId: string,
  processId: string,
  membership: { active: boolean; pendingLeaseRelease: boolean },
): ProcessRecoveryIndex {
  const existing = readRecoveryIndex(controllerHome, repoId);
  if (!existing) {
    // The record mutation has already been persisted, so the one-time rebuild
    // includes its current state and establishes an exact v2 baseline.
    return rebuildRecoveryIndex(controllerHome, repoId);
  }
  const value = mutateControlPlaneRecord<ProcessRecoveryIndex>(controllerHome, {
    namespace: PROCESS_RECOVERY_INDEX_NAMESPACE,
    scope: repoId,
    key: PROCESS_RECOVERY_INDEX_KEY,
    schemaVersion: 2,
    action: 'process_recovery_index_update',
    mutate: (current) => {
      const base = current?.value ?? existing;
      const active = new Set(base.activeProcessIds);
      const pending = new Set(base.pendingLeaseReleaseIds);
      if (membership.active) active.add(processId); else active.delete(processId);
      if (membership.pendingLeaseRelease) pending.add(processId); else pending.delete(processId);
      return {
        schemaVersion: 2,
        updatedAt: new Date().toISOString(),
        activeProcessIds: [...active].sort(),
        pendingLeaseReleaseIds: [...pending].sort(),
      };
    },
  }).value;
  return value;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* Windows or restricted filesystem. */ }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const SECRET_OPTION = /^--?(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|credentials?|authorization|auth[_-]?token|token|cookie)(?:=|$)/i;
const INLINE_SCRIPT_FLAGS = new Set(['-e', '--eval', '-c', '--command']);
const INLINE_SCRIPT_EXECUTABLES = new Set(['node', 'node.exe', 'bun', 'bun.exe', 'python', 'python3', 'python.exe', 'python3.exe', 'sh', 'bash', 'zsh', 'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']);

function safeText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactSensitiveText(value).text;
}

function sanitizeCommandArgs(args: string[] | undefined, executable: string | undefined): string[] | undefined {
  if (!args) return undefined;
  const interpreter = executable ? INLINE_SCRIPT_EXECUTABLES.has(basename(executable).toLowerCase()) : false;
  let redactNextSecret = false;
  let redactNextScript = false;
  return args.map((argument) => {
    if (redactNextScript) {
      redactNextScript = false;
      return '[INLINE SCRIPT REDACTED]';
    }
    if (redactNextSecret) {
      redactNextSecret = false;
      return '[REDACTED]';
    }
    if (interpreter && INLINE_SCRIPT_FLAGS.has(argument.toLowerCase())) {
      redactNextScript = true;
      return argument;
    }
    if (SECRET_OPTION.test(argument)) {
      const equals = argument.indexOf('=');
      if (equals >= 0) return `${argument.slice(0, equals + 1)}[REDACTED]`;
      redactNextSecret = true;
    }
    return redactSensitiveText(argument).text;
  });
}

function sanitizeProcessCommand(command: ManagedProcessRecord['command']): ManagedProcessRecord['command'] {
  const env = command.env
    ? Object.fromEntries(Object.entries(command.env).map(([key, value]) => [
      key,
      value === undefined
        ? undefined
        : isSensitiveOutputKey(key)
          ? '[REDACTED]'
          : redactSensitiveText(value).text,
    ]))
    : undefined;
  return {
    ...command,
    executable: safeText(command.executable),
    args: sanitizeCommandArgs(command.args, command.executable),
    shellCommand: safeText(command.shellCommand),
    env,
  };
}

function sanitizeProcessRecord(record: ManagedProcessRecord): { record: ManagedProcessRecord; changed: boolean } {
  const next: ManagedProcessRecord = {
    ...record,
    command: sanitizeProcessCommand(record.command),
    stdoutTail: safeText(record.stdoutTail),
    stderrTail: safeText(record.stderrTail),
    error: record.error ? { code: safeText(record.error.code) ?? record.error.code, message: safeText(record.error.message) ?? '' } : undefined,
    leaseReleaseFailure: record.leaseReleaseFailure ? {
      ...record.leaseReleaseFailure,
      code: safeText(record.leaseReleaseFailure.code) ?? record.leaseReleaseFailure.code,
      message: safeText(record.leaseReleaseFailure.message) ?? '',
    } : undefined,
    origin: record.origin ? {
      ...record.origin,
      toolName: safeText(record.origin.toolName),
      requestId: safeText(record.origin.requestId),
      checkId: safeText(record.origin.checkId),
      requestSemanticFingerprint: safeText(record.origin.requestSemanticFingerprint),
      correlationId: safeText(record.origin.correlationId),
    } : undefined,
  };
  return { record: next, changed: JSON.stringify(next) !== JSON.stringify(record) };
}

function readProcessRecord(path: string): ManagedProcessRecord | undefined {
  const record = readJson<ManagedProcessRecord>(path);
  if (!record || record.schemaVersion !== 1) return undefined;
  // Legacy/partial Process files can predate the required command descriptor.
  // They are not executable recovery authority and must never be repaired by
  // inventing a command. Treat them as unavailable to normal Runtime readers;
  // bounded GC has its own metadata-only parser so one such file cannot block
  // cleanup of unrelated proven terminal records.
  if (!record.command || typeof record.command !== 'object' || Array.isArray(record.command)) return undefined;
  const sanitized = sanitizeProcessRecord(record);
  if (sanitized.changed) atomicWrite(path, sanitized.record);
  return sanitized.record;
}

/**
 * Atomically claim one request id before creating a process record or spawning.
 * Existing matching bindings are reusable; conflicting or unreadable bindings
 * fail closed so a transport retry can never create a second process.
 */
export function claimProcessRequest(input: {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  requestId: string;
  commandFingerprint: string;
  processId: string;
}): { status: 'claimed' | 'existing'; binding: ProcessRequestBinding } {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error('PROCESS_REQUEST_ID_REQUIRED: requestId must not be empty');
  const path = requestBindingPath(input.controllerHome, input.repoId, input.checkoutId, requestId);
  const binding: ProcessRequestBinding = {
    schemaVersion: 1,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    requestId,
    commandFingerprint: input.commandFingerprint,
    processId: input.processId,
    createdAt: new Date().toISOString(),
  };
  let existed = false;
  const existing = mutateControlPlaneRecord<ProcessRequestBinding>(input.controllerHome, {
    namespace: 'process_request_binding', scope: input.repoId, key: bindingKey(input.repoId, input.checkoutId, requestId), schemaVersion: 1,
    action: 'process_request_binding_claim', readLegacy: () => readJson<ProcessRequestBinding>(path),
    mutate: (current) => { if (current) { existed = true; return current.value; } return binding; },
  }).value;
  if (!existing || existing.schemaVersion !== 1 || !existing.processId || !existing.commandFingerprint) {
    throw new Error(`PROCESS_REQUEST_BINDING_CORRUPT: ${requestId}`);
  }
  if (
    existing.repoId !== input.repoId
    || (existing.checkoutId?.trim() || undefined) !== (input.checkoutId?.trim() || undefined)
    || existing.requestId !== requestId
    || existing.commandFingerprint !== input.commandFingerprint
  ) {
    throw new Error(`PROCESS_REQUEST_ID_CONFLICT: ${requestId}`);
  }
  return { status: existed ? 'existing' : 'claimed', binding: existing };
}

export function getProcessRequestBinding(
  controllerHome: string,
  repoId: string,
  checkoutId: string | undefined,
  requestId: string,
): ProcessRequestBinding | undefined {
  const normalized = requestId.trim();
  if (!normalized) return undefined;
  return readOrImportControlPlaneRecord<ProcessRequestBinding>(controllerHome, {
    namespace: 'process_request_binding', scope: repoId, key: bindingKey(repoId, checkoutId, normalized), schemaVersion: 1,
    readLegacy: () => readJson<ProcessRequestBinding>(requestBindingPath(controllerHome, repoId, checkoutId, normalized)),
  })?.value;
}

/**
 * Atomically bind one semantic Check identity to a physical Process. Active and
 * successful terminal Processes remain reusable; failed/timeout/cancelled or
 * missing Processes are replaced by a fresh candidate on the next request.
 */
export function claimProcessCheckExecution(input: {
  controllerHome: string;
  repoId: string;
  sourceCheckoutId?: string;
  scopeKey: string;
  cacheKey: string;
  processId: string;
}): { status: 'claimed' | 'existing' | 'reclaimed'; binding: ProcessCheckExecutionBinding } {
  const scopeKey = input.scopeKey.trim();
  const cacheKey = input.cacheKey.trim();
  if (!scopeKey || !cacheKey) throw new Error('PROCESS_CHECK_EXECUTION_IDENTITY_REQUIRED: scopeKey/cacheKey are required');
  const path = checkExecutionBindingPath(input.controllerHome, input.repoId, scopeKey, cacheKey);
  const candidate: ProcessCheckExecutionBinding = {
    schemaVersion: 1,
    repoId: input.repoId,
    scopeKey,
    cacheKey,
    processId: input.processId,
    sourceCheckoutId: input.sourceCheckoutId,
    createdAt: new Date().toISOString(),
  };
  let disposition: 'claimed' | 'existing' | 'reclaimed' = 'claimed';
  const binding = mutateControlPlaneRecord<ProcessCheckExecutionBinding>(input.controllerHome, {
    namespace: 'process_check_execution_binding',
    scope: input.repoId,
    key: checkExecutionBindingKey(input.repoId, scopeKey, cacheKey),
    schemaVersion: 1,
    action: 'process_check_execution_binding_claim',
    readLegacy: () => readJson<ProcessCheckExecutionBinding>(path),
    mutate: (current) => {
      if (!current) return candidate;
      const existing = current.value;
      if (existing.repoId !== input.repoId || existing.scopeKey !== scopeKey || existing.cacheKey !== cacheKey || !existing.processId) {
        throw new Error(`PROCESS_CHECK_EXECUTION_BINDING_CORRUPT: ${cacheKey}`);
      }
      const record = readProcessRecord(processPath(input.controllerHome, input.repoId, existing.processId));
      if (!record) {
        const claimAgeMs = Date.now() - Date.parse(existing.createdAt);
        if (Number.isFinite(claimAgeMs) && claimAgeMs >= 0 && claimAgeMs < 5_000) {
          disposition = 'existing';
          return existing;
        }
        disposition = 'reclaimed';
        return candidate;
      }
      if (!isManagedProcessActive(record) && record.status !== 'succeeded') {
        disposition = 'reclaimed';
        return candidate;
      }
      disposition = 'existing';
      return existing;
    },
  }).value;
  if (!binding) throw new Error(`PROCESS_CHECK_EXECUTION_BINDING_CORRUPT: ${cacheKey}`);
  return { status: disposition, binding };
}

export function getProcessCheckExecutionBinding(
  controllerHome: string,
  repoId: string,
  scopeKey: string,
  cacheKey: string,
): ProcessCheckExecutionBinding | undefined {
  const key = checkExecutionBindingKey(repoId, scopeKey, cacheKey);
  return readOrImportControlPlaneRecord<ProcessCheckExecutionBinding>(controllerHome, {
    namespace: 'process_check_execution_binding', scope: repoId, key, schemaVersion: 1,
    readLegacy: () => readJson<ProcessCheckExecutionBinding>(checkExecutionBindingPath(controllerHome, repoId, scopeKey, cacheKey)),
  })?.value;
}

/**
 * Atomically bind one logical facade invocation before any child Process is
 * created. Matching retries may continue attaching/spawning missing children;
 * a changed invocation fails closed before partial execution can begin.
 */
export function claimProcessInvocation(input: {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  requestId: string;
  invocationFingerprint: string;
}): { status: 'claimed' | 'existing'; binding: ProcessInvocationBinding } {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error('PROCESS_REQUEST_ID_REQUIRED: requestId must not be empty');
  const path = invocationBindingPath(input.controllerHome, input.repoId, input.checkoutId, requestId);
  const binding: ProcessInvocationBinding = {
    schemaVersion: 1,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    requestId,
    invocationFingerprint: input.invocationFingerprint,
    createdAt: new Date().toISOString(),
  };
  let existed = false;
  const existing = mutateControlPlaneRecord<ProcessInvocationBinding>(input.controllerHome, {
    namespace: 'process_invocation_binding', scope: input.repoId, key: bindingKey(input.repoId, input.checkoutId, requestId), schemaVersion: 1,
    action: 'process_invocation_binding_claim', readLegacy: () => readJson<ProcessInvocationBinding>(path),
    mutate: (current) => { if (current) { existed = true; return current.value; } return binding; },
  }).value;
  if (!existing || existing.schemaVersion !== 1 || !existing.invocationFingerprint) {
    throw new Error(`PROCESS_INVOCATION_BINDING_CORRUPT: ${requestId}`);
  }
  if (
    existing.repoId !== input.repoId
    || (existing.checkoutId?.trim() || undefined) !== (input.checkoutId?.trim() || undefined)
    || existing.requestId !== requestId
    || existing.invocationFingerprint !== input.invocationFingerprint
  ) {
    throw new Error(`PROCESS_REQUEST_ID_CONFLICT: ${requestId}`);
  }
  return { status: existed ? 'existing' : 'claimed', binding: existing };
}

export function processLogDir(controllerHome: string, repoId: string): string {
  return join(processesRoot(controllerHome, repoId), 'logs');
}

export function createProcessRecord(record: ManagedProcessRecord): ManagedProcessRecord {
  const path = processPath(record.controllerHome, record.repoId, record.processId);
  if (existsSync(path)) {
    throw new Error(`PROCESS_ALREADY_EXISTS: ${record.processId}`);
  }
  const sanitized = sanitizeProcessRecord(record).record;
  atomicWrite(path, sanitized);
  updateRecoveryIndexMembership(
    record.controllerHome,
    record.repoId,
    record.processId,
    processRecoveryMembership(sanitized),
  );
  return sanitized;
}

export function getProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
): ManagedProcessRecord | undefined {
  return readProcessRecord(processPath(controllerHome, repoId, processId));
}

/**
 * CAS-style terminal write: only succeeds when terminalFenceToken matches and
 * terminalWritten is not already true. Prevents dual-monitor completion races.
 */
export function tryCompleteProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
  fenceToken: number,
  patch: Partial<ManagedProcessRecord> & {
    status: ProcessRuntimeStatus;
  },
): { ok: boolean; record?: ManagedProcessRecord; reason?: string } {
  const path = processPath(controllerHome, repoId, processId);
  const current = readProcessRecord(path);
  if (!current) return { ok: false, reason: 'missing' };
  if (current.terminalWritten) return { ok: false, reason: 'already_terminal', record: current };
  if (current.terminalFenceToken !== fenceToken) {
    return { ok: false, reason: 'fence_mismatch', record: current };
  }
  const hasLeases = (current.leaseRefs?.length ?? 0) > 0;
  const leasesReleased = current.leasesReleased === true || !hasLeases;
  const next: ManagedProcessRecord = {
    ...current,
    ...patch,
    terminalWritten: true,
    leaseReleaseState: leasesReleased ? 'released' : 'pending',
    leasesReleased,
    finishedAt: patch.finishedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const sanitized = sanitizeProcessRecord(next).record;
  atomicWrite(path, sanitized);
  updateRecoveryIndexMembership(controllerHome, repoId, processId, processRecoveryMembership(sanitized));
  return { ok: true, record: sanitized };
}

export function updateProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
  patch: Partial<ManagedProcessRecord>,
  options: { requireFence?: number; allowTerminal?: boolean } = {},
): ManagedProcessRecord | undefined {
  const path = processPath(controllerHome, repoId, processId);
  const current = readProcessRecord(path);
  if (!current) return undefined;
  if (current.terminalWritten && !options.allowTerminal) return current;
  if (options.requireFence !== undefined && current.terminalFenceToken !== options.requireFence) {
    return current;
  }
  const next: ManagedProcessRecord = {
    ...current,
    ...patch,
    // Never allow patch to clear terminal fencing once set.
    terminalFenceToken: current.terminalFenceToken,
    terminalWritten: current.terminalWritten || patch.terminalWritten === true,
    updatedAt: new Date().toISOString(),
  };
  const sanitized = sanitizeProcessRecord(next).record;
  atomicWrite(path, sanitized);
  const previousMembership = processRecoveryMembership(current);
  const nextMembership = processRecoveryMembership(sanitized);
  if (
    previousMembership.active !== nextMembership.active
    || previousMembership.pendingLeaseRelease !== nextMembership.pendingLeaseRelease
  ) {
    updateRecoveryIndexMembership(controllerHome, repoId, processId, nextMembership);
  }
  return sanitized;
}

export function listRecoverableProcessRecords(controllerHome: string, repoId: string): ManagedProcessRecord[] {
  const index = ensureRecoveryIndex(controllerHome, repoId);
  const indexedIds = normalizedProcessIds([
    ...index.activeProcessIds,
    ...index.pendingLeaseReleaseIds,
  ]);
  const records: ManagedProcessRecord[] = [];
  const active: string[] = [];
  const pendingLeaseRelease: string[] = [];
  for (const processId of indexedIds) {
    const record = getProcessRecord(controllerHome, repoId, processId);
    if (!record) continue;
    const membership = processRecoveryMembership(record);
    if (!membership.active && !membership.pendingLeaseRelease) continue;
    records.push(record);
    if (membership.active) active.push(processId);
    if (membership.pendingLeaseRelease) pendingLeaseRelease.push(processId);
  }
  const normalizedActive = normalizedProcessIds(active);
  const normalizedPending = normalizedProcessIds(pendingLeaseRelease);
  if (
    normalizedActive.join('\0') !== normalizedProcessIds(index.activeProcessIds).join('\0')
    || normalizedPending.join('\0') !== normalizedProcessIds(index.pendingLeaseReleaseIds).join('\0')
  ) {
    replaceRecoveryIndex(
      controllerHome,
      repoId,
      normalizedActive,
      normalizedPending,
      'process_recovery_index_reconcile',
    );
  }
  return records;
}

export function listActiveProcessIds(controllerHome: string, repoId: string): string[] {
  return listRecoverableProcessRecords(controllerHome, repoId)
    .filter((record) => isManagedProcessActive(record))
    .map((record) => record.processId)
    .sort();
}

export function listProcessRecords(
  controllerHome: string,
  repoId: string,
  limit = 100,
): ManagedProcessRecord[] {
  const root = processesRoot(controllerHome, repoId);
  if (!existsSync(root)) return [];
  const records: ManagedProcessRecord[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json') || entry === 'active-index.json') continue;
    const record = readProcessRecord(join(root, entry));
    if (record) records.push(record);
  }
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return records.slice(0, Math.max(1, limit));
}

export function deleteProcessRecord(
  controllerHome: string,
  repoId: string,
  processId: string,
): boolean {
  const path = processPath(controllerHome, repoId, processId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  updateRecoveryIndexMembership(controllerHome, repoId, processId, {
    active: false,
    pendingLeaseRelease: false,
  });
  return true;
}

export function repositoryProcessesRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'processes');
}
