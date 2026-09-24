import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type {
  CreateUserRequestInput,
  ResolveUserRequestInput,
  UserRequest,
} from '../domain/user-request';

interface UserRequestStoreData {
  schemaVersion: 1;
  requests: UserRequest[];
}

export function userRequestStorePath(controllerHome: string): string {
  return join(resolve(controllerHome), 'system', 'user-requests', 'requests.json');
}

function loadStore(controllerHome: string): UserRequestStoreData {
  const path = userRequestStorePath(controllerHome);
  if (!existsSync(path)) return { schemaVersion: 1, requests: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('store must be an object');
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== 1 || !Array.isArray(record.requests)) throw new Error('schemaVersion/requests are invalid');
    return { schemaVersion: 1, requests: record.requests as UserRequest[] };
  } catch {
    return { schemaVersion: 1, requests: [] };
  }
}

function saveStore(controllerHome: string, store: UserRequestStoreData): void {
  const path = userRequestStorePath(controllerHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * Creates or coalesces a UserActionRequest / UserDecisionRequest.
 * If an active (pending) request exists with the exact same rootCauseKey,
 * return the existing record to guarantee deduplication across retries.
 */
export function recordUserRequest(controllerHome: string, input: CreateUserRequestInput): UserRequest {
  const rootCauseKey = input.rootCauseKey.trim();
  if (!rootCauseKey) throw new Error('USER_REQUEST_ROOT_CAUSE_KEY_REQUIRED');

  const store = loadStore(controllerHome);
  // Coalescing: return matching pending request
  const existing = store.requests.find(
    (r) => r.status === 'pending' && r.rootCauseKey === rootCauseKey,
  );
  if (existing) return structuredClone(existing);

  const now = (input.now ?? new Date()).toISOString();
  const requestId = input.requestId?.trim() || `usrreq_${randomUUID().replaceAll('-', '')}`;
  const record: UserRequest = {
    schemaVersion: 1,
    requestId,
    kind: input.kind,
    rootCauseKey,
    title: input.title.trim(),
    summary: input.summary.trim(),
    actionRequired: input.actionRequired,
    ...(input.targetScope ? { targetScope: input.targetScope } : {}),
    ...(input.options ? { options: input.options } : {}),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  store.requests.push(record);
  saveStore(controllerHome, store);
  return record;
}

export function resolveUserRequest(controllerHome: string, input: ResolveUserRequestInput): UserRequest {
  const requestId = input.requestId.trim();
  const decision = input.decision.trim();
  const resolvedBy = input.resolvedBy.trim();
  if (!requestId || !decision || !resolvedBy) throw new Error('RESOLVE_USER_REQUEST_ARGS_REQUIRED');

  const store = loadStore(controllerHome);
  const index = store.requests.findIndex((r) => r.requestId === requestId);
  if (index < 0) throw new Error(`USER_REQUEST_NOT_FOUND: ${requestId}`);
  const current = store.requests[index]!;
  if (current.status !== 'pending') return structuredClone(current);

  const now = (input.now ?? new Date()).toISOString();
  const updated: UserRequest = {
    ...current,
    status: 'resolved',
    resolution: { decision, resolvedBy, resolvedAt: now },
    updatedAt: now,
  };
  store.requests[index] = updated;
  saveStore(controllerHome, store);
  return updated;
}

export function listUserRequests(controllerHome: string, status?: 'pending' | 'resolved' | 'cancelled' | 'all'): UserRequest[] {
  const store = loadStore(controllerHome);
  return store.requests
    .filter((r) => !status || status === 'all' || r.status === status)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((r) => structuredClone(r));
}
