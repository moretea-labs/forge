import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import { redactSensitiveValue, type SensitiveRedactionCount } from './sensitive-output';

export interface ControllerResultRecord {
  schemaVersion: 1;
  resultId: string;
  resultRef: string;
  repoId: string;
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

function resultRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'results');
  mkdirSync(join(root, 'records'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
  return root;
}

function recordPath(controllerHome: string, repoId: string, resultId: string): string {
  return join(resultRoot(controllerHome, repoId), 'records', `${sanitizeFileComponent(resultId)}.json`);
}

function dataPath(controllerHome: string, repoId: string, resultId: string): string {
  return join(resultRoot(controllerHome, repoId), 'data', `${sanitizeFileComponent(resultId)}.json`);
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

function sanitizeStoredResult(
  controllerHome: string,
  record: ControllerResultRecord,
): { record: ControllerResultRecord; value: unknown; changed: boolean } {
  const path = dataPath(controllerHome, record.repoId, record.resultId);
  const raw = readJsonFile<unknown>(path);
  const sanitized = redactSensitiveValue(raw);
  if (!sanitized.changed) return { record, value: raw, changed: false };
  writePrivateJson(path, sanitized.value);
  const next: ControllerResultRecord = {
    ...record,
    byteLength: statSync(path).size,
    redaction: redactionMetadata(sanitized.redactions),
  };
  writePrivateJson(recordPath(controllerHome, record.repoId, record.resultId), next);
  return { record: next, value: sanitized.value, changed: true };
}

function parseRef(resultRef: string): { repoId: string; resultId: string } {
  const match = /^result:\/\/([^/]+)\/([^/]+)$/.exec(resultRef.trim());
  if (!match) throw new Error('RESULT_REF_INVALID: expected result://<repoId>/<resultId>');
  return { repoId: match[1]!, resultId: match[2]! };
}

export function writeControllerResult(input: {
  controllerHome: string;
  repoId: string;
  sessionId: string;
  principalId: string;
  workId?: string;
  kind: ControllerResultRecord['kind'];
  value: unknown;
}): ControllerResultRecord {
  const resultId = `res_${randomUUID().replace(/-/g, '')}`;
  const resultRef = `result://${input.repoId}/${resultId}`;
  const path = dataPath(input.controllerHome, input.repoId, resultId);
  const sanitized = redactSensitiveValue(input.value);
  writePrivateJson(path, sanitized.value);
  const record: ControllerResultRecord = {
    schemaVersion: 1,
    resultId,
    resultRef,
    repoId: input.repoId,
    sessionId: input.sessionId,
    principalId: input.principalId,
    ...(input.workId ? { workId: input.workId } : {}),
    kind: input.kind,
    byteLength: statSync(path).size,
    createdAt: new Date().toISOString(),
    ...(sanitized.changed ? { redaction: redactionMetadata(sanitized.redactions) } : {}),
  };
  writePrivateJson(recordPath(input.controllerHome, input.repoId, resultId), record);
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
  const record = readJsonFile<ControllerResultRecord>(recordPath(input.controllerHome, parsed.repoId, parsed.resultId));
  if (record.resultRef !== input.resultRef || record.repoId !== parsed.repoId) throw new Error('RESULT_IDENTITY_MISMATCH');
  authorizeRecord(record, input.sessionId, input.principalId, input.workId);
  const sanitized = sanitizeStoredResult(input.controllerHome, record);
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
  const record = readJsonFile<ControllerResultRecord>(recordPath(input.controllerHome, parsed.repoId, parsed.resultId));
  if (record.resultRef !== input.resultRef || record.repoId !== parsed.repoId) throw new Error('RESULT_IDENTITY_MISMATCH');
  authorizeRecord(record, input.sessionId, input.principalId, input.workId);
  const sanitized = sanitizeStoredResult(input.controllerHome, record);
  const value = sanitized.value;
  const query = input.query.trim().toLowerCase();
  if (!query) throw new Error('RESULT_QUERY_REQUIRED');
  const lines = JSON.stringify(value, null, 2).split(/\r?\n/);
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const matches = lines.flatMap((text, index) => text.toLowerCase().includes(query) ? [{ line: index + 1, text: text.slice(0, 2_000) }] : []).slice(0, limit);
  return { record: sanitized.record, matches, truncated: lines.filter((text) => text.toLowerCase().includes(query)).length > matches.length };
}

/**
 * Bounded maintenance entry point for historical result artifacts. It returns
 * only counts and ids; sensitive contents are never included in the report.
 */
export function sanitizeControllerResultStore(controllerHome: string, repoId: string, limit = 10_000): {
  scanned: number;
  changed: number;
  failed: number;
  resultIds: string[];
} {
  const root = resultRoot(controllerHome, repoId);
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
      if (!record?.resultId || record.repoId !== repoId || !existsSync(dataPath(controllerHome, repoId, record.resultId))) {
        failed += 1;
        continue;
      }
      const sanitized = sanitizeStoredResult(controllerHome, record);
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
