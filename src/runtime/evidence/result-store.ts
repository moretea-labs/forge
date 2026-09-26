import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { controllerSystemRoot, repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import { recordOutputHandleIndexEntry, readOutputHandleIndexEntry, refreshOutputHandleFingerprint, type OutputHandleStorage } from './output-handle-index';
import { redactSensitiveValue, type SensitiveRedactionCount } from './sensitive-output';

export interface ControllerResultRecord {
  schemaVersion: 1;
  resultId: string;
  resultRef: string;
  /** Repository provenance only. It is not part of the canonical result locator. */
  repoId?: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  kind: 'inspection' | 'command' | 'validation' | 'finalization' | 'generic';
  byteLength: number;
  createdAt: string;
  redaction?: {
    schemaVersion: 1;
    sanitizedAt: string;
    redactionCount: number;
    types: string[];
  };
}

function canonicalResultRoot(controllerHome: string): string {
  const root = join(controllerSystemRoot(controllerHome), 'outputs', 'results');
  mkdirSync(join(root, 'records'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
  return root;
}

function legacyResultRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'results');
}

function resultRoot(controllerHome: string, storage: OutputHandleStorage): string {
  return storage.scope === 'instance'
    ? canonicalResultRoot(controllerHome)
    : legacyResultRoot(controllerHome, storage.repositoryId);
}

function recordPath(controllerHome: string, storage: OutputHandleStorage, resultId: string): string {
  return join(resultRoot(controllerHome, storage), 'records', `${sanitizeFileComponent(resultId)}.json`);
}

function dataPath(controllerHome: string, storage: OutputHandleStorage, resultId: string): string {
  return join(resultRoot(controllerHome, storage), 'data', `${sanitizeFileComponent(resultId)}.json`);
}

function writePrivateJson(path: string, value: unknown): void {
  writeJsonAtomic(path, value);
  try { chmodSync(path, 0o600); } catch { /* Windows or restricted filesystem. */ }
}

function redactionMetadata(redactions: SensitiveRedactionCount[]): NonNullable<ControllerResultRecord['redaction']> {
  return {
    schemaVersion: 1,
    sanitizedAt: new Date().toISOString(),
    redactionCount: redactions.reduce((total, entry) => total + entry.count, 0),
    types: redactions.map((entry) => entry.type).sort(),
  };
}

function canonicalResultRef(resultId: string): string {
  return `result://${resultId}`;
}

function resultFingerprint(record: ControllerResultRecord, value: unknown): string {
  return createHash('sha256').update(JSON.stringify({
    resultId: record.resultId,
    sessionId: record.sessionId,
    principalId: record.principalId,
    workId: record.workId ?? null,
    kind: record.kind,
    createdAt: record.createdAt,
    value,
  })).digest('hex');
}

function registerResult(
  controllerHome: string,
  record: ControllerResultRecord,
  value: unknown,
  storage: OutputHandleStorage,
): void {
  recordOutputHandleIndexEntry(controllerHome, {
    handleId: record.resultId,
    kind: 'result',
    storage,
    repositoryId: record.repoId,
    principalId: record.principalId,
    sessionId: record.sessionId,
    workId: record.workId,
    fingerprint: resultFingerprint(record, value),
  });
}

function parseRef(resultRef: string): { resultId: string; legacyRepoId?: string } {
  const normalized = resultRef.trim();
  const canonical = /^result:\/\/([^/]+)$/.exec(normalized);
  if (canonical) return { resultId: canonical[1]! };
  const legacy = /^result:\/\/([^/]+)\/([^/]+)$/.exec(normalized);
  if (legacy) return { legacyRepoId: legacy[1]!, resultId: legacy[2]! };
  throw new Error('RESULT_REF_INVALID: expected result://<resultId>');
}

function loadResultAt(
  controllerHome: string,
  resultId: string,
  storage: OutputHandleStorage,
): { record: ControllerResultRecord; value: unknown } {
  const stored = readJsonFile<ControllerResultRecord>(recordPath(controllerHome, storage, resultId));
  if (stored.resultId !== resultId) throw new Error('RESULT_IDENTITY_MISMATCH');
  const value = readJsonFile<unknown>(dataPath(controllerHome, storage, resultId));
  const record: ControllerResultRecord = {
    ...stored,
    resultRef: canonicalResultRef(resultId),
    ...(storage.scope === 'legacy_repository' && !stored.repoId ? { repoId: storage.repositoryId } : {}),
  };
  return { record, value };
}

function resolveStoredResult(
  controllerHome: string,
  resultId: string,
  legacyRepoId?: string,
): { record: ControllerResultRecord; value: unknown; storage: OutputHandleStorage } {
  if (legacyRepoId) {
    const storage: OutputHandleStorage = { scope: 'legacy_repository', repositoryId: legacyRepoId };
    const loaded = loadResultAt(controllerHome, resultId, storage);
    registerResult(controllerHome, loaded.record, loaded.value, storage);
    return { ...loaded, storage };
  }

  const indexed = readOutputHandleIndexEntry(controllerHome, resultId);
  if (indexed) {
    if (indexed.kind !== 'result') throw new Error(`OUTPUT_HANDLE_KIND_MISMATCH: ${resultId}`);
    const loaded = loadResultAt(controllerHome, resultId, indexed.storage);
    if (resultFingerprint(loaded.record, loaded.value) !== indexed.fingerprint) {
      throw new Error(`OUTPUT_HANDLE_FINGERPRINT_MISMATCH: ${resultId}`);
    }
    return { ...loaded, storage: indexed.storage };
  }

  const storage: OutputHandleStorage = { scope: 'instance' };
  const canonicalRecord = recordPath(controllerHome, storage, resultId);
  if (!existsSync(canonicalRecord)) {
    throw new Error(`RESULT_LOCATOR_NOT_FOUND: ${resultId}; legacy results require their historical result://<repoId>/<resultId> reference once`);
  }
  const loaded = loadResultAt(controllerHome, resultId, storage);
  registerResult(controllerHome, loaded.record, loaded.value, storage);
  return { ...loaded, storage };
}

function sanitizeResolvedResult(
  controllerHome: string,
  record: ControllerResultRecord,
  value: unknown,
  storage: OutputHandleStorage,
): { record: ControllerResultRecord; value: unknown; changed: boolean } {
  const sanitized = redactSensitiveValue(value);
  if (!sanitized.changed) return { record, value, changed: false };
  const next: ControllerResultRecord = {
    ...record,
    redaction: redactionMetadata(sanitized.redactions),
  };
  if (storage.scope === 'instance') {
    const previousFingerprint = resultFingerprint(record, value);
    const nextFingerprint = resultFingerprint(next, sanitized.value);
    const path = dataPath(controllerHome, storage, record.resultId);
    writePrivateJson(path, sanitized.value);
    next.byteLength = statSync(path).size;
    writePrivateJson(recordPath(controllerHome, storage, record.resultId), next);
    refreshOutputHandleFingerprint(controllerHome, {
      handleId: record.resultId,
      kind: 'result',
      expectedFingerprint: previousFingerprint,
      nextFingerprint,
    });
  }
  // Historical repository partitions are immutable after the cutover. Apply
  // current redaction in-memory without rewriting legacy bytes.
  return { record: next, value: sanitized.value, changed: true };
}

export function writeControllerResult(input: {
  controllerHome: string;
  repoId?: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  kind: ControllerResultRecord['kind'];
  value: unknown;
}): ControllerResultRecord {
  const resultId = `res_${randomUUID().replace(/-/g, '')}`;
  const resultRef = canonicalResultRef(resultId);
  const storage: OutputHandleStorage = { scope: 'instance' };
  const path = dataPath(input.controllerHome, storage, resultId);
  const sanitized = redactSensitiveValue(input.value);
  writePrivateJson(path, sanitized.value);
  const record: ControllerResultRecord = {
    schemaVersion: 1,
    resultId,
    resultRef,
    ...(input.repoId?.trim() ? { repoId: input.repoId.trim() } : {}),
    sessionId: input.sessionId,
    principalId: input.principalId,
    ...(input.workId ? { workId: input.workId } : {}),
    kind: input.kind,
    byteLength: statSync(path).size,
    createdAt: new Date().toISOString(),
    ...(sanitized.changed ? { redaction: redactionMetadata(sanitized.redactions) } : {}),
  };
  writePrivateJson(recordPath(input.controllerHome, storage, resultId), record);
  registerResult(input.controllerHome, record, sanitized.value, storage);
  return record;
}

function authorizeRecord(record: ControllerResultRecord, sessionId: string, principalId: string, workId?: string): void {
  if (record.sessionId !== sessionId || record.principalId !== principalId) throw new Error('RESULT_ACCESS_DENIED: result belongs to another session or principal');
  if (workId && record.workId && record.workId !== workId) throw new Error('RESULT_ACCESS_DENIED: result belongs to another work handle');
}

export function readControllerResult(input: {
  controllerHome: string;
  resultRef: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  cursor?: number;
  limit?: number;
}): { record: ControllerResultRecord; items: unknown; cursor: number; nextCursor?: number; truncated: boolean } {
  const parsed = parseRef(input.resultRef);
  const resolved = resolveStoredResult(input.controllerHome, parsed.resultId, parsed.legacyRepoId);
  authorizeRecord(resolved.record, input.sessionId, input.principalId, input.workId);
  const sanitized = sanitizeResolvedResult(input.controllerHome, resolved.record, resolved.value, resolved.storage);
  const value = sanitized.value;
  const cursor = Math.max(0, Math.trunc(input.cursor ?? 0));
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  if (Array.isArray(value)) {
    const items = value.slice(cursor, cursor + limit);
    return { record: sanitized.record, items, cursor, ...(cursor + items.length < value.length ? { nextCursor: cursor + items.length } : {}), truncated: cursor + items.length < value.length };
  }
  if (typeof value === 'string') {
    const items = value.slice(cursor, cursor + limit * 4_096);
    return { record: sanitized.record, items, cursor, ...(cursor + items.length < value.length ? { nextCursor: cursor + items.length } : {}), truncated: cursor + items.length < value.length };
  }
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)) {
    const source = (value as Record<string, unknown>).items as unknown[];
    const items = source.slice(cursor, cursor + limit);
    return { record: sanitized.record, items, cursor, ...(cursor + items.length < source.length ? { nextCursor: cursor + items.length } : {}), truncated: cursor + items.length < source.length };
  }
  return { record: sanitized.record, items: value, cursor, truncated: false };
}

export function searchControllerResult(input: {
  controllerHome: string;
  resultRef: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  query: string;
  limit?: number;
}): { record: ControllerResultRecord; matches: Array<{ line: number; text: string }>; truncated: boolean } {
  const parsed = parseRef(input.resultRef);
  const resolved = resolveStoredResult(input.controllerHome, parsed.resultId, parsed.legacyRepoId);
  authorizeRecord(resolved.record, input.sessionId, input.principalId, input.workId);
  const sanitized = sanitizeResolvedResult(input.controllerHome, resolved.record, resolved.value, resolved.storage);
  const value = sanitized.value;
  const query = input.query.trim().toLowerCase();
  if (!query) throw new Error('RESULT_QUERY_REQUIRED');
  const lines = JSON.stringify(value, null, 2).split(/\r?\n/);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const matches = lines.flatMap((text, index) => text.toLowerCase().includes(query) ? [{ line: index + 1, text: text.slice(0, 2_000) }] : []).slice(0, limit);
  return { record: sanitized.record, matches, truncated: lines.filter((text) => text.toLowerCase().includes(query)).length > matches.length };
}

/** Bounded maintenance of the canonical instance Result store only. */
export function sanitizeControllerResultStore(controllerHome: string, _repoId: string, limit = 10_000): {
  scanned: number;
  changed: number;
  failed: number;
  resultIds: string[];
} {
  const storage: OutputHandleStorage = { scope: 'instance' };
  const root = canonicalResultRoot(controllerHome);
  const recordsDir = join(root, 'records');
  let scanned = 0;
  let changed = 0;
  let failed = 0;
  const resultIds: string[] = [];
  const maximum = Math.max(1, Math.min(100_000, Math.trunc(limit)));
  for (const entry of readdirSync(recordsDir).sort()) {
    if (!entry.endsWith('.json')) continue;
    if (scanned >= maximum) break;
    scanned += 1;
    try {
      const record = readJsonFile<ControllerResultRecord>(join(recordsDir, entry));
      if (!record?.resultId || !existsSync(dataPath(controllerHome, storage, record.resultId))) {
        failed += 1;
        continue;
      }
      const raw = readJsonFile<unknown>(dataPath(controllerHome, storage, record.resultId));
      const sanitized = sanitizeResolvedResult(controllerHome, record, raw, storage);
      if (sanitized.changed) {
        changed += 1;
        resultIds.push(record.resultId);
      }
    } catch {
      failed += 1;
    }
  }
  return { scanned, changed, failed, resultIds };
}
