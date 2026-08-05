import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ensureControllerHome, repositoryControllerRoot } from './controller-home';
import { recordGatewayLatency } from '../../runtime/observability/gateway-contention-metrics';

export type ControllerLockScope = 'global' | 'repository' | 'task' | 'run' | 'worktree';

export interface ControllerLockKey {
  scope: ControllerLockScope;
  repoId?: string;
  taskId?: string;
  runId?: string;
  worktreeId?: string;
  resource?: string;
}

export interface ControllerLockRecord extends ControllerLockKey {
  lockId: string;
  owner: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt?: string;
  path: string;
}

export interface ControllerLockContention {
  acquired: false;
  existing?: ControllerLockRecord;
  requestedBy: string;
  waitedMs: number;
  retryable: true;
}

export type ControllerLockTryResult =
  | { acquired: true; lock: ControllerLockRecord; waitedMs: number }
  | ControllerLockContention;

const DEFAULT_ASYNC_LOCK_WAIT_MS = 500;
const MAX_ASYNC_LOCK_WAIT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 10;
const CORRUPT_LOCK_GRACE_MS = 1_000;

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`LOCK_KEY_INVALID: ${name} is required`);
  return value.trim();
}

export class ControllerLockContentionError extends Error {
  readonly code = 'LOCK_HELD';
  readonly contention: ControllerLockContention;

  constructor(contention: ControllerLockContention, path: string) {
    const existing = contention.existing;
    const detail = existing
      ? `${existing.lockId} by ${existing.owner} pid=${existing.pid} acquiredAt=${existing.acquiredAt}`
      : path;
    super(`LOCK_HELD: ${detail}; requestedBy=${contention.requestedBy}; waitedMs=${Math.round(contention.waitedMs)}`);
    this.name = 'ControllerLockContentionError';
    this.contention = contention;
  }
}

export function controllerLockPath(controllerHome: string, key: ControllerLockKey): string {
  const home = ensureControllerHome(controllerHome);
  if (key.scope === 'global') {
    const resource = key.resource?.trim();
    return resource
      ? join(home, 'locks', 'global', `${safe(resource)}.lock.json`)
      : join(home, 'locks', 'controller.lock.json');
  }
  const repoId = safe(requireValue(key.repoId, 'repoId'));
  const base = join(repositoryControllerRoot(home, repoId), 'locks');
  if (key.scope === 'repository') return join(base, 'repository.lock.json');
  if (key.scope === 'task') return join(base, 'tasks', `${safe(requireValue(key.taskId, 'taskId'))}.lock.json`);
  if (key.scope === 'run') return join(base, 'runs', `${safe(requireValue(key.runId, 'runId'))}.lock.json`);
  return join(base, 'worktrees', `${safe(requireValue(key.worktreeId, 'worktreeId'))}.lock.json`);
}

function isExpired(record: ControllerLockRecord): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= Date.now());
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readControllerLock(controllerHome: string, key: ControllerLockKey): ControllerLockRecord | undefined {
  const path = controllerLockPath(controllerHome, key);
  try {
    const record = JSON.parse(readFileSync(path, 'utf-8')) as ControllerLockRecord;
    if (isExpired(record) || !isPidAlive(record.pid)) {
      rmSync(path, { force: true });
      return undefined;
    }
    return record;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs >= CORRUPT_LOCK_GRACE_MS) rmSync(path, { force: true });
    } catch {
      /* a concurrent owner may still be creating or releasing the lock */
    }
    return undefined;
  }
}

function metric(key: ControllerLockKey, waitedMs: number, outcome: 'success' | 'contention' | 'timeout'): void {
  recordGatewayLatency({
    repoId: key.repoId,
    checkoutId: key.worktreeId,
    operationClass: 'controller_lock',
    phase: 'lock_wait',
    durationMs: waitedMs,
    outcome,
  });
}

/** One authoritative, non-blocking acquisition attempt. */
export function tryAcquireControllerLock(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  ttlMs?: number,
  recordMetrics = true,
): ControllerLockTryResult {
  const started = performance.now();
  const path = controllerLockPath(controllerHome, key);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readControllerLock(controllerHome, key);
  if (existing) {
    const waitedMs = performance.now() - started;
    if (recordMetrics) metric(key, waitedMs, 'contention');
    return { acquired: false, existing, requestedBy: owner, waitedMs, retryable: true };
  }

  const acquiredAt = new Date().toISOString();
  const record: ControllerLockRecord = {
    ...key,
    lockId: `${key.scope}:${key.repoId ?? key.resource ?? 'controller'}:${Date.now()}:${process.pid}`,
    owner,
    pid: process.pid,
    acquiredAt,
    heartbeatAt: acquiredAt,
    expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
    path,
  };
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx');
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}
`, 'utf-8');
    const waitedMs = performance.now() - started;
    if (recordMetrics) metric(key, waitedMs, 'success');
    return { acquired: true, lock: record, waitedMs };
  } catch {
    const waitedMs = performance.now() - started;
    const current = readControllerLock(controllerHome, key);
    if (recordMetrics) metric(key, waitedMs, 'contention');
    return { acquired: false, existing: current, requestedBy: owner, waitedMs, retryable: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Compatibility API. The waitMs argument is intentionally ignored: synchronous
 * Gateway-reachable code performs exactly one try-acquire and never sleeps.
 */
export function acquireControllerLock(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  ttlMs?: number,
  _waitMs = 0,
): ControllerLockRecord {
  const result = tryAcquireControllerLock(controllerHome, key, owner, ttlMs);
  if (result.acquired) return result.lock;
  throw new ControllerLockContentionError(result, controllerLockPath(controllerHome, key));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function acquireControllerLockAsync(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  ttlMs?: number,
  waitMs = DEFAULT_ASYNC_LOCK_WAIT_MS,
): Promise<ControllerLockRecord> {
  const started = performance.now();
  const budgetMs = Math.max(0, Math.min(Math.trunc(waitMs), MAX_ASYNC_LOCK_WAIT_MS));
  const deadline = performance.now() + budgetMs;
  let last: ControllerLockContention | undefined;
  do {
    const result = tryAcquireControllerLock(controllerHome, key, owner, ttlMs, false);
    if (result.acquired) {
      metric(key, performance.now() - started, 'success');
      return result.lock;
    }
    last = result;
    if (performance.now() >= deadline) break;
    await delay(Math.min(LOCK_POLL_INTERVAL_MS, Math.max(1, deadline - performance.now())));
  } while (performance.now() <= deadline);
  const contention: ControllerLockContention = {
    ...(last ?? { acquired: false, requestedBy: owner, waitedMs: 0, retryable: true }),
    waitedMs: performance.now() - started,
  };
  metric(key, contention.waitedMs, budgetMs > 0 ? 'timeout' : 'contention');
  throw new ControllerLockContentionError(contention, controllerLockPath(controllerHome, key));
}

export function releaseControllerLock(controllerHome: string, key: ControllerLockKey, lockId?: string): void {
  const current = readControllerLock(controllerHome, key);
  if (!current) return;
  if (lockId && current.lockId !== lockId) throw new Error(`LOCK_OWNERSHIP_MISMATCH: ${current.lockId}`);
  rmSync(controllerLockPath(controllerHome, key), { force: true });
}

export function withControllerLock<T>(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  operation: () => T,
  ttlMs?: number,
  waitMs = 0,
): T {
  const lock = acquireControllerLock(controllerHome, key, owner, ttlMs, waitMs);
  try {
    return operation();
  } finally {
    releaseControllerLock(controllerHome, key, lock.lockId);
  }
}

export async function withControllerLockAsync<T>(
  controllerHome: string,
  key: ControllerLockKey,
  owner: string,
  operation: () => Promise<T>,
  ttlMs?: number,
  waitMs = DEFAULT_ASYNC_LOCK_WAIT_MS,
): Promise<T> {
  const lock = await acquireControllerLockAsync(controllerHome, key, owner, ttlMs, waitMs);
  try {
    return await operation();
  } finally {
    releaseControllerLock(controllerHome, key, lock.lockId);
  }
}
