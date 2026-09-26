import { createHash, randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, opendirSync, openSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { controllerSystemRoot, repositoryControllerRoot } from '../../cli/repositories/controller-home';
import type { ExecutionJob } from '../execution/jobs/types';
import { readJsonFile, removeFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import { deleteOutputHandleIndexEntry, recordOutputHandleIndexEntry, readOutputHandleIndexEntry, type OutputHandleStorage } from './output-handle-index';

export interface ExecutionArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  /** Repository provenance only. */
  repoId?: string;
  jobId: string;
  principalId?: string;
  kind: 'job-result' | 'job-error' | 'command-output' | 'evidence';
  mediaType: 'application/json' | 'text/plain';
  path: string;
  byteLength: number;
  createdAt: string;
}

function canonicalArtifactRoot(controllerHome: string): string {
  const root = join(controllerSystemRoot(controllerHome), 'outputs', 'artifacts');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'records'), { recursive: true });
  return root;
}

function legacyArtifactRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'artifacts');
}

function artifactRoot(controllerHome: string, storage: OutputHandleStorage): string {
  return storage.scope === 'instance'
    ? canonicalArtifactRoot(controllerHome)
    : legacyArtifactRoot(controllerHome, storage.repositoryId);
}

function artifactDataPath(controllerHome: string, storage: OutputHandleStorage, artifactId: string): string {
  return join(artifactRoot(controllerHome, storage), 'data', `${sanitizeFileComponent(artifactId)}.json`);
}

function metadataPath(controllerHome: string, storage: OutputHandleStorage, artifactId: string): string {
  return join(artifactRoot(controllerHome, storage), 'records', `${sanitizeFileComponent(artifactId)}.json`);
}

function artifactFingerprint(record: ExecutionArtifactRecord, value: unknown): string {
  return createHash('sha256').update(JSON.stringify({
    artifactId: record.artifactId,
    jobId: record.jobId,
    principalId: record.principalId ?? null,
    kind: record.kind,
    mediaType: record.mediaType,
    createdAt: record.createdAt,
    value,
  })).digest('hex');
}

function registerArtifact(
  controllerHome: string,
  record: ExecutionArtifactRecord,
  value: unknown,
  storage: OutputHandleStorage,
): void {
  recordOutputHandleIndexEntry(controllerHome, {
    handleId: record.artifactId,
    kind: 'artifact',
    storage,
    repositoryId: record.repoId,
    principalId: record.principalId,
    operationId: record.jobId,
    fingerprint: artifactFingerprint(record, value),
  });
}

function loadArtifactAt(
  controllerHome: string,
  artifactId: string,
  storage: OutputHandleStorage,
): { artifact: ExecutionArtifactRecord; content: unknown; dataPath: string } {
  const stored = readJsonFile<ExecutionArtifactRecord>(metadataPath(controllerHome, storage, artifactId));
  if (stored.artifactId !== artifactId) throw new Error('ARTIFACT_IDENTITY_MISMATCH');
  if (storage.scope === 'legacy_repository' && stored.repoId && stored.repoId !== storage.repositoryId) {
    throw new Error('ARTIFACT_REPOSITORY_PROVENANCE_MISMATCH');
  }
  const path = artifactDataPath(controllerHome, storage, artifactId);
  const content = readJsonFile<unknown>(path);
  return {
    artifact: {
      ...stored,
      ...(storage.scope === 'legacy_repository' && !stored.repoId ? { repoId: storage.repositoryId } : {}),
      path,
    },
    content,
    dataPath: path,
  };
}

function resolveArtifact(
  controllerHome: string,
  artifactId: string,
  legacyRepoId?: string,
): { artifact: ExecutionArtifactRecord; content: unknown; dataPath: string; storage: OutputHandleStorage } {
  if (legacyRepoId) {
    const storage: OutputHandleStorage = { scope: 'legacy_repository', repositoryId: legacyRepoId };
    const loaded = loadArtifactAt(controllerHome, artifactId, storage);
    registerArtifact(controllerHome, loaded.artifact, loaded.content, storage);
    return { ...loaded, storage };
  }

  const indexed = readOutputHandleIndexEntry(controllerHome, artifactId);
  if (indexed) {
    if (indexed.kind !== 'artifact') throw new Error(`OUTPUT_HANDLE_KIND_MISMATCH: ${artifactId}`);
    const loaded = loadArtifactAt(controllerHome, artifactId, indexed.storage);
    if (artifactFingerprint(loaded.artifact, loaded.content) !== indexed.fingerprint) {
      throw new Error(`OUTPUT_HANDLE_FINGERPRINT_MISMATCH: ${artifactId}`);
    }
    return { ...loaded, storage: indexed.storage };
  }

  const storage: OutputHandleStorage = { scope: 'instance' };
  if (!existsSync(metadataPath(controllerHome, storage, artifactId))) {
    throw new Error(`ARTIFACT_LOCATOR_NOT_FOUND: ${artifactId}; supply repo_id only once when adopting a historical repository artifact`);
  }
  const loaded = loadArtifactAt(controllerHome, artifactId, storage);
  registerArtifact(controllerHome, loaded.artifact, loaded.content, storage);
  return { ...loaded, storage };
}

function assertArtifactAccess(record: ExecutionArtifactRecord, principalId?: string): void {
  // Omitting principalId is reserved for trusted in-process integrity readers.
  // External adapters must always provide an explicit principal (or anonymous).
  if (principalId === undefined) return;
  const owner = record.principalId?.trim();
  const caller = principalId.trim();
  if (owner && caller !== owner) {
    throw new Error('ARTIFACT_ACCESS_DENIED: artifact belongs to another principal');
  }
}

export function writeExecutionArtifact(
  controllerHome: string,
  job: ExecutionJob,
  kind: ExecutionArtifactRecord['kind'],
  value: unknown,
): ExecutionArtifactRecord {
  const artifactId = `ART-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const storage: OutputHandleStorage = { scope: 'instance' };
  const dataPath = artifactDataPath(controllerHome, storage, artifactId);
  writeJsonAtomic(dataPath, value);
  const principalId = job.origin.actor?.trim();
  const record: ExecutionArtifactRecord = {
    schemaVersion: 1,
    artifactId,
    ...(job.repoId?.trim() ? { repoId: job.repoId.trim() } : {}),
    jobId: job.jobId,
    ...(principalId ? { principalId } : {}),
    kind,
    mediaType: 'application/json',
    path: dataPath,
    byteLength: statSync(dataPath).size,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(metadataPath(controllerHome, storage, artifactId), record);
  registerArtifact(controllerHome, record, value, storage);
  return record;
}

export interface ExecutionArtifactJobCleanupReport {
  policyVersion: 'execution-artifact-job-cleanup-v1';
  inspected: number;
  matched: number;
  removed: number;
  scanTruncated: boolean;
  blockers: string[];
}

/**
 * Reclaim only canonical instance artifacts whose immutable metadata names the
 * exact retired Job. Historical repository partitions are intentionally
 * read-only after the output-handle cutover.
 */
export function cleanupExecutionArtifactsForJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  options: { maxScan?: number } = {},
): ExecutionArtifactJobCleanupReport {
  const report: ExecutionArtifactJobCleanupReport = {
    policyVersion: 'execution-artifact-job-cleanup-v1', inspected: 0, matched: 0, removed: 0, scanTruncated: false, blockers: [],
  };
  const storage: OutputHandleStorage = { scope: 'instance' };
  const root = canonicalArtifactRoot(controllerHome);
  const recordsRoot = join(root, 'records');
  if (!existsSync(recordsRoot)) return report;
  const maxScan = Math.max(1, Math.min(Math.trunc(options.maxScan ?? 5_000), 5_000));
  const directory = opendirSync(recordsRoot);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (report.inspected >= maxScan) { report.scanTruncated = true; break; }
      report.inspected += 1;
      const recordPath = join(recordsRoot, entry.name);
      let record: ExecutionArtifactRecord;
      try { record = readJsonFile<ExecutionArtifactRecord>(recordPath); } catch {
        report.blockers.push(`invalid_metadata:${entry.name}`);
        continue;
      }
      if (record.schemaVersion !== 1 || !record.artifactId || !record.jobId) {
        report.blockers.push(`identity_mismatch:${entry.name}`);
        continue;
      }
      const expectedName = `${sanitizeFileComponent(record.artifactId)}.json`;
      if (entry.name !== expectedName) {
        report.blockers.push(`artifact_key_mismatch:${entry.name}`);
        continue;
      }
      if (record.jobId !== jobId || (record.repoId && record.repoId !== repoId)) continue;
      report.matched += 1;
      const dataPath = artifactDataPath(controllerHome, storage, record.artifactId);
      let value: unknown;
      try {
        value = readJsonFile<unknown>(dataPath);
      } catch {
        report.blockers.push(`artifact_data_missing:${record.artifactId}`);
        continue;
      }
      const fingerprint = artifactFingerprint(record, value);
      deleteOutputHandleIndexEntry(controllerHome, {
        handleId: record.artifactId,
        kind: 'artifact',
        expectedFingerprint: fingerprint,
      });
      removeFile(dataPath);
      removeFile(recordPath);
      report.removed += 1;
    }
  } finally {
    directory.closeSync();
  }
  report.blockers = report.blockers.slice(0, 16);
  return report;
}

export function readExecutionArtifact(
  controllerHome: string,
  artifactId: string,
  maxBytes = 512 * 1024,
  options: { legacyRepoId?: string; principalId?: string } = {},
): { artifact: ExecutionArtifactRecord; content: unknown; truncated: boolean } {
  const resolved = resolveArtifact(controllerHome, artifactId, options.legacyRepoId);
  assertArtifactAccess(resolved.artifact, options.principalId);
  const bounded = Math.max(1_024, Math.min(maxBytes, 2 * 1024 * 1024));
  const byteLength = statSync(resolved.dataPath).size;
  const length = Math.min(byteLength, bounded);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(resolved.dataPath, 'r');
  try { readSync(descriptor, buffer, 0, length, 0); } finally { closeSync(descriptor); }
  if (byteLength <= bounded) {
    return { artifact: { ...resolved.artifact, byteLength }, content: JSON.parse(buffer.toString('utf8')), truncated: false };
  }
  return {
    artifact: { ...resolved.artifact, byteLength },
    content: {
      preview: buffer.toString('utf8'),
      byteLength,
      message: 'Artifact content is larger than the requested bound. Request a larger bounded window if needed.',
    },
    truncated: true,
  };
}

export function boundExecutionResult(
  controllerHome: string,
  job: ExecutionJob,
  result: Record<string, unknown>,
  kind: ExecutionArtifactRecord['kind'] = 'job-result',
): { result: Record<string, unknown>; artifact?: ExecutionArtifactRecord } {
  const DEFAULT_INLINE_SUCCESS = 16 * 1024;
  const DEFAULT_INLINE_ERROR = 32 * 1024;
  const configured = typeof job.payload.maxOutputBytes === 'number' ? job.payload.maxOutputBytes : DEFAULT_INLINE_SUCCESS;
  const maxBytes = kind === 'job-error'
    ? Math.max(DEFAULT_INLINE_ERROR, Math.min(configured, 512 * 1024))
    : Math.max(DEFAULT_INLINE_SUCCESS, Math.min(configured, 512 * 1024));
  const serialized = JSON.stringify(result);
  const bytes = Buffer.byteLength(serialized);

  if (kind === 'job-error') {
    const artifact = writeExecutionArtifact(controllerHome, job, kind, result);
    return {
      artifact,
      result: {
        externalized: true,
        byteLength: bytes,
        referenceType: 'artifact',
        artifactId: artifact.artifactId,
        artifactKind: artifact.kind,
        message: typeof result.message === 'string'
          ? String(result.message).slice(0, 800)
          : (typeof result.error === 'string' ? String(result.error).slice(0, 800) : 'Job failed; full details externalized.'),
        detailPointer: {
          tool: 'get_artifact',
          artifactId: artifact.artifactId,
          maxBytes,
        },
        next: `Call get_artifact with artifact_id=${artifact.artifactId} (ART-..., not EVD-...).`,
      },
    };
  }

  if (bytes <= maxBytes) return { result };

  const artifact = writeExecutionArtifact(controllerHome, job, kind, result);
  return {
    artifact,
    result: {
      truncated: true,
      externalized: true,
      byteLength: bytes,
      referenceType: 'artifact',
      artifactId: artifact.artifactId,
      artifactKind: artifact.kind,
      preview: serialized.slice(0, Math.min(2 * 1024, serialized.length)),
      detailPointer: {
        tool: 'get_artifact',
        artifactId: artifact.artifactId,
        maxBytes,
      },
      next: `Call get_artifact with artifact_id=${artifact.artifactId} (ART-..., not EVD-...).`,
    },
  };
}
