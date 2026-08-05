/**
 * Durable Managed Process records under controller-home repositories.
 * Layout: repositories/<repoId>/processes/<processId>.json
 * Index: repositories/<repoId>/processes/active-index.json
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
  type ManagedProcessRecord,
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

function indexPath(controllerHome: string, repoId: string): string {
  return join(processesRoot(controllerHome, repoId), 'active-index.json');
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
    origin: record.origin ? {
      ...record.origin,
      toolName: safeText(record.origin.toolName),
      requestId: safeText(record.origin.requestId),
      checkId: safeText(record.origin.checkId),
      correlationId: safeText(record.origin.correlationId),
    } : undefined,
  };
  return { record: next, changed: JSON.stringify(next) !== JSON.stringify(record) };
}

function readProcessRecord(path: string): ManagedProcessRecord | undefined {
  const record = readJson<ManagedProcessRecord>(path);
  if (!record || record.schemaVersion !== 1) return undefined;
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

function rebuildActiveIndex(controllerHome: string, repoId: string): string[] {
  const root = processesRoot(controllerHome, repoId);
  const active: string[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json') || entry === 'active-index.json') continue;
    const record = readProcessRecord(join(root, entry));
    if (record && isManagedProcessActive(record)) active.push(record.processId);
  }
  active.sort();
  atomicWrite(indexPath(controllerHome, repoId), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    processIds: active,
  });
  return active;
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
  rebuildActiveIndex(record.controllerHome, record.repoId);
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
  rebuildActiveIndex(controllerHome, repoId);
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
  if (isManagedProcessActive(current) !== isManagedProcessActive(sanitized)) {
    rebuildActiveIndex(controllerHome, repoId);
  }
  return sanitized;
}

export function listActiveProcessIds(controllerHome: string, repoId: string): string[] {
  const index = readJson<{ processIds?: string[] }>(indexPath(controllerHome, repoId));
  if (!Array.isArray(index?.processIds)) return rebuildActiveIndex(controllerHome, repoId);
  const indexed = [...new Set(index.processIds.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort();
  const verified = indexed.filter((processId) => {
    const record = getProcessRecord(controllerHome, repoId, processId);
    return record !== undefined && isManagedProcessActive(record);
  });
  if (verified.length !== indexed.length || verified.some((value, indexValue) => value !== indexed[indexValue])) {
    return rebuildActiveIndex(controllerHome, repoId);
  }
  return verified;
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
  rebuildActiveIndex(controllerHome, repoId);
  return true;
}

export function repositoryProcessesRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'processes');
}
