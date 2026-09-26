import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { controllerSystemRoot, repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import type { ExecutionJob } from '../execution/jobs/types';
import { recordOutputHandleIndexEntry, readOutputHandleIndexEntry, type OutputHandleStorage } from './output-handle-index';

export interface ExecutionEvidence {
  schemaVersion: 1;
  evidenceId: string;
  /** Repository provenance only. */
  repoId?: string;
  checkoutId?: string;
  jobId: string;
  principalId?: string;
  revision: string;
  operation: string;
  environmentFingerprint: string;
  executedAt: string;
  outcome: 'succeeded' | 'failed';
  details?: Record<string, unknown>;
}

function gitRevision(repoRoot: string): string {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0 ? result.stdout.trim() : 'unversioned';
}

function environmentFingerprint(): string {
  return createHash('sha256').update(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    bun: process.versions.bun ?? null,
  })).digest('hex').slice(0, 24);
}

function canonicalEvidencePath(controllerHome: string, evidenceId: string): string {
  return join(controllerSystemRoot(controllerHome), 'outputs', 'evidence', `${sanitizeFileComponent(evidenceId)}.json`);
}

function legacyEvidencePath(controllerHome: string, repoId: string, evidenceId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'evidence', `${sanitizeFileComponent(evidenceId)}.json`);
}

function evidencePath(controllerHome: string, storage: OutputHandleStorage, evidenceId: string): string {
  return storage.scope === 'instance'
    ? canonicalEvidencePath(controllerHome, evidenceId)
    : legacyEvidencePath(controllerHome, storage.repositoryId, evidenceId);
}

function evidenceFingerprint(evidence: ExecutionEvidence): string {
  return createHash('sha256').update(JSON.stringify({
    evidenceId: evidence.evidenceId,
    checkoutId: evidence.checkoutId ?? null,
    jobId: evidence.jobId,
    principalId: evidence.principalId ?? null,
    revision: evidence.revision,
    operation: evidence.operation,
    environmentFingerprint: evidence.environmentFingerprint,
    executedAt: evidence.executedAt,
    outcome: evidence.outcome,
    details: evidence.details ?? null,
  })).digest('hex');
}

function registerEvidence(
  controllerHome: string,
  evidence: ExecutionEvidence,
  storage: OutputHandleStorage,
): void {
  recordOutputHandleIndexEntry(controllerHome, {
    handleId: evidence.evidenceId,
    kind: 'evidence',
    storage,
    repositoryId: evidence.repoId,
    principalId: evidence.principalId,
    operationId: evidence.jobId,
    fingerprint: evidenceFingerprint(evidence),
  });
}

function loadEvidenceAt(
  controllerHome: string,
  evidenceId: string,
  storage: OutputHandleStorage,
): ExecutionEvidence {
  const stored = readJsonFile<ExecutionEvidence>(evidencePath(controllerHome, storage, evidenceId));
  if (stored.evidenceId !== evidenceId) throw new Error('EVIDENCE_IDENTITY_MISMATCH');
  if (storage.scope === 'legacy_repository' && stored.repoId && stored.repoId !== storage.repositoryId) {
    throw new Error('EVIDENCE_REPOSITORY_PROVENANCE_MISMATCH');
  }
  return {
    ...stored,
    ...(storage.scope === 'legacy_repository' && !stored.repoId ? { repoId: storage.repositoryId } : {}),
  };
}

function assertEvidenceAccess(evidence: ExecutionEvidence, principalId?: string): void {
  // Omitting principalId is reserved for trusted in-process integrity readers.
  // External adapters must always provide an explicit principal (or anonymous).
  if (principalId === undefined) return;
  const owner = evidence.principalId?.trim();
  const caller = principalId.trim();
  if (owner && owner !== caller) {
    throw new Error('EVIDENCE_ACCESS_DENIED: evidence belongs to another principal');
  }
}

export function readExecutionEvidence(
  controllerHome: string,
  evidenceId: string,
  options: { legacyRepoId?: string; principalId?: string } = {},
): ExecutionEvidence {
  if (options.legacyRepoId) {
    const storage: OutputHandleStorage = { scope: 'legacy_repository', repositoryId: options.legacyRepoId };
    const evidence = loadEvidenceAt(controllerHome, evidenceId, storage);
    registerEvidence(controllerHome, evidence, storage);
    assertEvidenceAccess(evidence, options.principalId);
    return evidence;
  }

  const indexed = readOutputHandleIndexEntry(controllerHome, evidenceId);
  if (indexed) {
    if (indexed.kind !== 'evidence') throw new Error(`OUTPUT_HANDLE_KIND_MISMATCH: ${evidenceId}`);
    const evidence = loadEvidenceAt(controllerHome, evidenceId, indexed.storage);
    if (evidenceFingerprint(evidence) !== indexed.fingerprint) {
      throw new Error(`OUTPUT_HANDLE_FINGERPRINT_MISMATCH: ${evidenceId}`);
    }
    assertEvidenceAccess(evidence, options.principalId);
    return evidence;
  }

  const storage: OutputHandleStorage = { scope: 'instance' };
  if (!existsSync(evidencePath(controllerHome, storage, evidenceId))) {
    throw new Error(`EVIDENCE_LOCATOR_NOT_FOUND: ${evidenceId}; supply repo_id only once when adopting historical repository evidence`);
  }
  const evidence = loadEvidenceAt(controllerHome, evidenceId, storage);
  registerEvidence(controllerHome, evidence, storage);
  assertEvidenceAccess(evidence, options.principalId);
  return evidence;
}

export function recordExecutionEvidence(
  controllerHome: string,
  repoRoot: string,
  job: ExecutionJob,
  outcome: 'succeeded' | 'failed',
  details?: Record<string, unknown>,
): ExecutionEvidence {
  const principalId = job.origin.actor?.trim();
  const evidence: ExecutionEvidence = {
    schemaVersion: 1,
    evidenceId: `EVD-${Date.now()}-${randomUUID().slice(0, 8)}`,
    ...(job.repoId?.trim() ? { repoId: job.repoId.trim() } : {}),
    checkoutId: job.checkoutId,
    jobId: job.jobId,
    ...(principalId ? { principalId } : {}),
    revision: gitRevision(repoRoot),
    operation: job.payload.operation,
    environmentFingerprint: environmentFingerprint(),
    executedAt: new Date().toISOString(),
    outcome,
    details,
  };
  const storage: OutputHandleStorage = { scope: 'instance' };
  writeJsonAtomic(evidencePath(controllerHome, storage, evidence.evidenceId), evidence);
  registerEvidence(controllerHome, evidence, storage);
  return evidence;
}
