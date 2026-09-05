import { randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, opendirSync, openSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import type { ExecutionJob } from '../execution/jobs/types';
import { readJsonFile, removeFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export interface ExecutionArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  repoId: string;
  jobId: string;
  kind: 'job-result' | 'job-error' | 'command-output' | 'evidence';
  mediaType: 'application/json' | 'text/plain';
  path: string;
  byteLength: number;
  createdAt: string;
}

function artifactRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'artifacts');
  mkdirSync(root, { recursive: true });
  return root;
}

function artifactDataPath(controllerHome: string, repoId: string, artifactId: string): string {
  return join(artifactRoot(controllerHome, repoId), 'data', `${sanitizeFileComponent(artifactId)}.json`);
}

function metadataPath(controllerHome: string, repoId: string, artifactId: string): string {
  return join(artifactRoot(controllerHome, repoId), 'records', `${sanitizeFileComponent(artifactId)}.json`);
}

export function writeExecutionArtifact(
  controllerHome: string,
  job: ExecutionJob,
  kind: ExecutionArtifactRecord['kind'],
  value: unknown,
): ExecutionArtifactRecord {
  const artifactId = `ART-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dataPath = artifactDataPath(controllerHome, job.repoId, artifactId);
  writeJsonAtomic(dataPath, value);
  const record: ExecutionArtifactRecord = {
    schemaVersion: 1,
    artifactId,
    repoId: job.repoId,
    jobId: job.jobId,
    kind,
    mediaType: 'application/json',
    path: dataPath,
    byteLength: statSync(dataPath).size,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(metadataPath(controllerHome, job.repoId, artifactId), record);
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
 * Reclaim only artifacts whose immutable metadata names the exact retired Job.
 * Stored path strings are never followed; metadata/data paths are re-derived
 * from the validated artifact id under this repository's Controller Home.
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
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'artifacts');
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
      if (record.schemaVersion !== 1 || record.repoId !== repoId || !record.artifactId || !record.jobId) {
        report.blockers.push(`identity_mismatch:${entry.name}`);
        continue;
      }
      const expectedName = `${sanitizeFileComponent(record.artifactId)}.json`;
      if (entry.name !== expectedName) {
        report.blockers.push(`artifact_key_mismatch:${entry.name}`);
        continue;
      }
      if (record.jobId !== jobId) continue;
      report.matched += 1;
      removeFile(join(root, 'data', expectedName));
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
  repoId: string,
  artifactId: string,
  maxBytes = 512 * 1024,
): { artifact: ExecutionArtifactRecord; content: unknown; truncated: boolean } {
  const artifact = readJsonFile<ExecutionArtifactRecord>(metadataPath(controllerHome, repoId, artifactId));
  if (artifact.repoId !== repoId || artifact.artifactId !== artifactId) throw new Error('ARTIFACT_IDENTITY_MISMATCH');
  const bounded = Math.max(1_024, Math.min(maxBytes, 2 * 1024 * 1024));
  // Derive the path from trusted identifiers. Never follow a path stored in mutable metadata.
  const dataPath = artifactDataPath(controllerHome, repoId, artifactId);
  const byteLength = statSync(dataPath).size;
  const length = Math.min(byteLength, bounded);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(dataPath, 'r');
  try { readSync(descriptor, buffer, 0, length, 0); } finally { closeSync(descriptor); }
  if (byteLength <= bounded) {
    return { artifact: { ...artifact, path: dataPath, byteLength }, content: JSON.parse(buffer.toString('utf8')), truncated: false };
  }
  return {
    artifact: { ...artifact, path: dataPath, byteLength },
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
  // Default success budget stays compact (~16KB). Callers still fetch full
  // content via get_artifact when externalized.
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
        // Keep a short human message, never the full JSON dump.
        message: typeof result.message === 'string'
          ? String(result.message).slice(0, 800)
          : (typeof result.error === 'string' ? String(result.error).slice(0, 800) : 'Job failed; full details externalized.'),
        detailPointer: {
          tool: 'get_artifact',
          repoId: job.repoId,
          artifactId: artifact.artifactId,
          maxBytes,
        },
        next: `Call get_artifact with repo_id=${job.repoId} and artifact_id=${artifact.artifactId} (ART-..., not EVD-...).`,
      },
    };
  }

  if (bytes <= maxBytes) {
    // Prefer inlining compact stdout/stderr when present.
    return { result };
  }
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
        repoId: job.repoId,
        artifactId: artifact.artifactId,
        maxBytes,
      },
      next: `Call get_artifact with repo_id=${job.repoId} and artifact_id=${artifact.artifactId} (ART-..., not EVD-...).`,
    },
  };
}
