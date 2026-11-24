import { createHash } from 'crypto';
import { existsSync, opendirSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  ensureRepositoryControllerLayout,
  repositoryControllerRoot,
  resolveControllerHome,
} from '../../../effects/controller-home';
import { releaseControllerLock, tryAcquireControllerLock, withControllerLock } from '../../../effects/controller-locks';
import { appendJobEvent } from '../../evidence/event-ledger';
import { cleanupExecutionArtifactsForJob, writeExecutionArtifact } from '../../evidence/artifact-store';
import { markRepositoryProjectionDirty } from '../../projections/invalidation';
import { touchSchedulerWakeSignal } from '../../control-plane/global-scheduler/wake-signal';
import { readJsonFile, removeFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import { terminateProcessTree } from '../../shared/process-tree';
import { releaseExecutionLeases } from '../../resources/leases/store';
import { assertRuntimeMayWriteOrThrow, isRuntimeWriteFenceError } from '../../root/write-fence';
import { ACTIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES, type ExecutionJob, type ExecutionJobStatus } from './types';
import { deadlineAfter } from './timeouts';

interface ActiveJobIndex {
  schemaVersion: 1;
  updatedAt: string;
  jobs: Array<{
    jobId: string;
    repoId: string;
    status: ExecutionJobStatus;
    priority: string;
    queuedAt: string;
    updatedAt: string;
  }>;
}

interface RecentJobIndex {
  schemaVersion: 1;
  updatedAt: string;
  jobs: Array<{ jobId: string; repoId: string; createdAt: string; updatedAt: string; status: ExecutionJobStatus }>;
}

function now(): string {
  return new Date().toISOString();
}
function safeRepoId(repoId: string): string {
  return sanitizeFileComponent(repoId);
}

/** ExecutionJobs are historical diagnostics; new execution uses direct Process Runtime or an explicit external Controller. */
function executionJobRootPath(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, safeRepoId(repoId)), 'execution-jobs');
}

export function executionJobRoot(controllerHome: string, repoId: string): string {
  ensureRepositoryControllerLayout(controllerHome, repoId);
  return executionJobRootPath(controllerHome, repoId);
}

function jobPath(controllerHome: string, repoId: string, jobId: string): string {
  return join(executionJobRootPath(controllerHome, repoId), 'records', `${sanitizeFileComponent(jobId)}.json`);
}

function legacyRequestIndexPath(controllerHome: string, requestId: string): string {
  const hash = createHash('sha256').update(requestId).digest('hex');
  return join(resolveControllerHome(controllerHome), 'indexes', 'execution-jobs', 'requests', hash + '.json');
}

function activeIndexPath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'indexes', 'execution-jobs', 'active.json');
}

function recentIndexPath(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'indexes', 'execution-jobs', 'recent.json');
}

function readActiveIndex(controllerHome: string): ActiveJobIndex {
  return readJsonFile<ActiveJobIndex>(activeIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    jobs: [],
  });
}

function readRecentIndex(controllerHome: string): RecentJobIndex {
  return readJsonFile<RecentJobIndex>(recentIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    jobs: [],
  });
}

const MAX_INLINE_JOB_RESULT_BYTES = 64 * 1024;
const MAX_INLINE_ERROR_MESSAGE_CHARS = 2_000;

function jsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function scrubErrorMessage(message: string): string {
  const scrubbed = message
    .replace(/\/Users\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?var\/folders\/[^\s"']+/g, '<abs-path>')
    .replace(/\/(?:private\/)?tmp\/[^\s"']+/g, '<abs-path>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<abs-path>');
  if (scrubbed.length <= MAX_INLINE_ERROR_MESSAGE_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_INLINE_ERROR_MESSAGE_CHARS)}...`;
}

function isArtifactPointer(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.artifactId === 'string' && typeof record.artifactKind === 'string';
}

function artifactPointerFor(
  job: ExecutionJob,
  artifact: ReturnType<typeof writeExecutionArtifact>,
  byteLength: number,
): Record<string, unknown> {
  return {
    externalized: true,
    byteLength,
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    detailPointer: {
      tool: 'get_artifact',
      artifactId: artifact.artifactId,
      maxBytes: 512 * 1024,
    },
    next: `Call get_artifact with artifact_id=${artifact.artifactId}.`,
  };
}

function externalizeJobValue(
  controllerHome: string,
  job: ExecutionJob,
  kind: 'job-result' | 'job-error',
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (isArtifactPointer(value)) return value;
  const byteLength = jsonByteLength(value) ?? 0;
  const artifact = writeExecutionArtifact(controllerHome, job, kind, value);
  return artifactPointerFor(job, artifact, byteLength);
}

const INLINE_ERROR_DETAIL_KEYS = new Set([
  'workerLostReason',
  'heartbeatAgeMs',
  'attempt',
  'maxAttempts',
  'failureClass',
  'candidateId',
  'executionJobId',
  'executable',
  'cwd',
  'exitCode',
  'signal',
  'stderr',
  'stderrPath',
  'stderrTruncated',
  'processGroupId',
  'ownerPid',
  'ownerEpoch',
  'startupError',
]);

function inlineSafeErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key, value]) =>
        INLINE_ERROR_DETAIL_KEYS.has(key) &&
        (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
    ),
  );
}

function sanitizeJobForPersistence(controllerHome: string, job: ExecutionJob): ExecutionJob {
  const next: ExecutionJob = { ...job };
  if (next.error) {
    const error = { ...next.error, message: scrubErrorMessage(next.error.message) };
    if (error.details && !isArtifactPointer(error.details)) {
      const inlineDetails = inlineSafeErrorDetails(error.details);
      const pointer = externalizeJobValue(controllerHome, next, 'job-error', error.details);
      error.details = Object.keys(inlineDetails).length > 0 ? { ...inlineDetails, ...pointer } : pointer;
    }
    next.error = error;
  }
  if (next.outcome?.infrastructureError?.message) {
    next.outcome = {
      ...next.outcome,
      infrastructureError: {
        ...next.outcome.infrastructureError,
        message: scrubErrorMessage(next.outcome.infrastructureError.message),
      },
    };
  }
  if (next.result && !isArtifactPointer(next.result)) {
    const resultBytes = jsonByteLength(next.result);
    if (resultBytes !== undefined && resultBytes > MAX_INLINE_JOB_RESULT_BYTES) {
      next.result = externalizeJobValue(controllerHome, next, 'job-result', next.result);
    }
  }
  return next;
}

function writeActiveIndex(controllerHome: string, index: ActiveJobIndex): void {
  const deduped = new Map(index.jobs.map((entry) => [entry.jobId, entry]));
  writeJsonAtomic(activeIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    // Active work is correctness state, not a presentation window. Dropping an
    // entry here makes Scheduler/recovery reads forget a durable non-terminal Job.
    jobs: [...deduped.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
  } satisfies ActiveJobIndex);
}

function writeRecentIndex(controllerHome: string, index: RecentJobIndex): void {
  const deduped = new Map(index.jobs.map((entry) => [entry.jobId, entry]));
  writeJsonAtomic(recentIndexPath(controllerHome), {
    schemaVersion: 1,
    updatedAt: now(),
    jobs: [...deduped.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5000),
  } satisfies RecentJobIndex);
}

function upsertIndexesUnlocked(controllerHome: string, job: ExecutionJob): void {
  const index = readActiveIndex(controllerHome);
  index.jobs = index.jobs.filter((entry) => entry.jobId !== job.jobId);
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    index.jobs.push({
      jobId: job.jobId,
      repoId: job.repoId,
      status: job.status,
      priority: job.priority,
      queuedAt: job.queuedAt,
      updatedAt: job.updatedAt,
    });
  }
  writeActiveIndex(controllerHome, index);
  const recent = readRecentIndex(controllerHome);
  recent.jobs = recent.jobs.filter((entry) => entry.jobId !== job.jobId);
  recent.jobs.push({
    jobId: job.jobId,
    repoId: job.repoId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
  });
  writeRecentIndex(controllerHome, recent);
}

function upsertIndexes(controllerHome: string, job: ExecutionJob): void {
  withControllerLock(
    controllerHome,
    { scope: 'global', resource: 'execution-index' },
    `execution-index:${job.jobId}`,
    () => {
      upsertIndexesUnlocked(controllerHome, job);
    },
    10_000,
  );
}

function persistJobRecord(controllerHome: string, job: ExecutionJob): ExecutionJob {
  const sanitized = sanitizeJobForPersistence(controllerHome, job);
  ensureRepositoryControllerLayout(controllerHome, sanitized.repoId);
  writeJsonAtomic(jobPath(controllerHome, sanitized.repoId, sanitized.jobId), sanitized);
  return sanitized;
}

function persistJob(controllerHome: string, job: ExecutionJob): ExecutionJob {
  const persisted = persistJobRecord(controllerHome, job);
  upsertIndexes(controllerHome, persisted);
  markRepositoryProjectionDirty(controllerHome, persisted.repoId, `job:${persisted.jobId}:${persisted.status}`);
  return persisted;
}

export function getExecutionJob(controllerHome: string, repoId: string, jobId: string): ExecutionJob {
  return readJsonFile<ExecutionJob>(jobPath(controllerHome, repoId, jobId));
}

export function findExecutionJob(controllerHome: string, jobId: string): ExecutionJob | undefined {
  const active = readActiveIndex(controllerHome).jobs.find((entry) => entry.jobId === jobId);
  if (active) {
    try {
      return getExecutionJob(controllerHome, active.repoId, jobId);
    } catch {
      /* continue */
    }
  }
  const recent = readRecentIndex(controllerHome).jobs.find((entry) => entry.jobId === jobId);
  if (recent) {
    try {
      return getExecutionJob(controllerHome, recent.repoId, jobId);
    } catch {
      /* continue to legacy fallback */
    }
  }
  const home = resolveControllerHome(controllerHome);
  const repositoriesRoot = join(home, 'repositories');
  try {
    for (const repoId of readdirSync(repositoriesRoot)) {
      const candidate = jobPath(home, repoId, jobId);
      if (existsSync(candidate)) return readJsonFile<ExecutionJob>(candidate);
    }
  } catch {
    /* no repositories */
  }
  return undefined;
}

export function updateExecutionJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  updater: (current: ExecutionJob) => ExecutionJob,
  eventType?: string,
  eventData?: Record<string, unknown>,
  notifyScheduler = false,
): ExecutionJob {
  return withControllerLock(
    controllerHome,
    { scope: 'task', repoId, taskId: `execution-job-${jobId}` },
    `update-job:${jobId}`,
    () => {
      const current = getExecutionJob(controllerHome, repoId, jobId);
      const next = updater(structuredClone(current));
      if (next.jobId !== current.jobId || next.repoId !== current.repoId) throw new Error('JOB_IDENTITY_IMMUTABLE');
      next.revision = current.revision + 1;
      next.updatedAt = now();
      const persisted = persistJob(controllerHome, next);
      if (eventType) appendJobEvent(controllerHome, persisted, eventType, eventData);
      if (notifyScheduler) touchSchedulerWakeSignal(controllerHome, `job-updated:${jobId}`);
      return persisted;
    },
    10_000,
  );
}

const WAITING_JOB_STATUSES = new Set<ExecutionJobStatus>([
  'queued',
  'waiting_for_dependency',
  'waiting_for_workspace',
  'waiting_for_heavy_check',
  'waiting_for_integration',
  'waiting_for_release_barrier',
  'waiting_for_approval',
]);

function transitionAllowed(from: ExecutionJobStatus, to: ExecutionJobStatus): boolean {
  if (from === to) return true;
  if (TERMINAL_JOB_STATUSES.has(from)) return false;
  if (WAITING_JOB_STATUSES.has(from)) {
    return (
      WAITING_JOB_STATUSES.has(to) || ['running', 'cancelled', 'timed_out', 'human_attention_required'].includes(to)
    );
  }
  if (from === 'running') {
    return [
      'queued',
      'waiting_for_approval',
      'succeeded',
      'failed',
      'timed_out',
      'cancelled',
      'orphaned',
      'stale',
      'human_attention_required',
    ].includes(to);
  }
  if (from === 'dispatched') {
    return [
      'queued',
      'running',
      'succeeded',
      'failed',
      'timed_out',
      'cancelled',
      'orphaned',
      'stale',
      'human_attention_required',
    ].includes(to);
  }
  return false;
}

export function transitionExecutionJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  status: ExecutionJobStatus,
  patch: Partial<ExecutionJob> = {},
  eventData?: Record<string, unknown>,
): ExecutionJob {
  // Terminal states require active writer fencing.
  const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'orphaned']);
  if (TERMINAL.has(status)) {
    try {
      assertRuntimeMayWriteOrThrow('write_workflow_terminal', controllerHome);
    } catch (error) {
      if (isRuntimeWriteFenceError(error)) throw error;
    }
  }
  return updateExecutionJob(
    controllerHome,
    repoId,
    jobId,
    (current) => {
      if (!transitionAllowed(current.status, status)) {
        if (TERMINAL_JOB_STATUSES.has(current.status))
          throw new Error(`JOB_ALREADY_TERMINAL: ${jobId} is ${current.status}`);
        throw new Error(`JOB_TRANSITION_INVALID: ${jobId} cannot move from ${current.status} to ${status}`);
      }
      const timestamp = now();
      const next: ExecutionJob = { ...current, ...patch, status };
      if (status === 'running') {
        if (!next.startedAt) next.startedAt = timestamp;
        if (next.timeoutPolicy) {
          next.executionDeadlineAt = deadlineAfter(timestamp, next.timeoutPolicy.executionTimeoutMs);
          next.deadlineAt = next.executionDeadlineAt;
        }
      }
      if (status === 'queued' && ['running', 'dispatched'].includes(current.status) && next.timeoutPolicy) {
        next.queueDeadlineAt = deadlineAfter(timestamp, next.timeoutPolicy.queueTimeoutMs);
        next.executionDeadlineAt = undefined;
        next.deadlineAt = next.queueDeadlineAt;
      }
      if (TERMINAL_JOB_STATUSES.has(status)) {
        next.finishedAt = timestamp;
        next.workerPid = undefined;
      }
      return next;
    },
    `job_${status}`,
    eventData,
    true,
  );
}

function sameLeaseRefs(
  current: ExecutionJob['leaseRefs'],
  expected: Array<Pick<ExecutionJob['leaseRefs'][number], 'leaseId' | 'fencingToken'>>,
): boolean {
  if (current.length !== expected.length) return false;
  const tokens = new Map(current.map((ref) => [ref.leaseId, ref.fencingToken]));
  return expected.every((ref) => tokens.get(ref.leaseId) === ref.fencingToken);
}

export function heartbeatExecutionJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  workerPid: number,
  expectedAttempt?: number,
): ExecutionJob {
  return withControllerLock(
    controllerHome,
    { scope: 'task', repoId, taskId: `execution-job-${jobId}` },
    `heartbeat-job:${jobId}`,
    () => {
      const current = getExecutionJob(controllerHome, repoId, jobId);
      if (current.status !== 'running') throw new Error(`WORKER_OWNERSHIP_LOST: ${jobId} is ${current.status}`);
      if (expectedAttempt !== undefined && current.attempt !== expectedAttempt) {
        throw new Error(
          `WORKER_OWNERSHIP_LOST: ${jobId} attempt ${expectedAttempt} was replaced by ${current.attempt}`,
        );
      }
      if (current.workerPid !== undefined && current.workerPid !== workerPid) {
        throw new Error(`WORKER_OWNERSHIP_LOST: ${jobId} belongs to PID ${current.workerPid}`);
      }
      const next: ExecutionJob = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now(),
        heartbeatAt: now(),
        workerPid,
      };
      // Heartbeats are intentionally record-only. They must not rewrite the global
      // active/recent indexes, dirty the repository projection, emit evidence, or
      // wake the scheduler every few seconds.
      return persistJobRecord(controllerHome, next);
    },
    10_000,
  );
}

export function transitionExecutionJobFromWorker(
  controllerHome: string,
  repoId: string,
  jobId: string,
  owner: {
    workerPid: number;
    attempt: number;
    leaseRefs: Array<Pick<ExecutionJob['leaseRefs'][number], 'leaseId' | 'fencingToken'>>;
  },
  status: Extract<ExecutionJobStatus, 'waiting_for_approval' | 'succeeded' | 'failed' | 'human_attention_required'>,
  patch: Partial<ExecutionJob> = {},
  eventData?: Record<string, unknown>,
): ExecutionJob {
  return updateExecutionJob(
    controllerHome,
    repoId,
    jobId,
    (current) => {
      if (
        current.status !== 'running' ||
        current.workerPid !== owner.workerPid ||
        current.attempt !== owner.attempt ||
        !sameLeaseRefs(current.leaseRefs, owner.leaseRefs)
      ) {
        throw new Error(`WORKER_OWNERSHIP_LOST: ${jobId} attempt ${owner.attempt} may not publish a terminal state`);
      }
      const timestamp = now();
      return {
        ...current,
        ...patch,
        status,
        ...(status === 'waiting_for_approval' ? { finishedAt: undefined } : { finishedAt: timestamp }),
        workerPid: undefined,
      };
    },
    `job_${status}`,
    eventData,
    true,
  );
}

export function listActiveExecutionJobs(controllerHome: string, repoId?: string): ExecutionJob[] {
  const index = readActiveIndex(controllerHome);
  const output: ExecutionJob[] = [];
  for (const entry of index.jobs) {
    if (repoId && entry.repoId !== repoId) continue;
    try {
      const job = getExecutionJob(controllerHome, entry.repoId, entry.jobId);
      if (ACTIVE_JOB_STATUSES.has(job.status)) output.push(job);
    } catch {
      /* maintenance reconciliation owns stale-index repair */
    }
  }
  return output;
}

/**
 * Maintenance-only active-index convergence. The active index itself is the
 * bounded candidate set; this never scans historical Job directories. Ordinary
 * read APIs remain side-effect free, while the Scheduler can remove terminal or
 * missing entries once and make subsequent idle reads genuinely cheap.
 */
export function reconcileActiveExecutionJobIndex(controllerHome: string, repoId?: string): ExecutionJob[] {
  const key = { scope: 'global' as const, resource: 'execution-index' };
  const owner = `execution-index-active-reconcile:${repoId ?? 'all'}`;
  const acquired = tryAcquireControllerLock(controllerHome, key, owner);
  if (!acquired.acquired) return listActiveExecutionJobs(controllerHome, repoId);
  try {
    const index = readActiveIndex(controllerHome);
    const jobs: ExecutionJob[] = [];
    const retained: ActiveJobIndex['jobs'] = [];
    let removed = 0;
    for (const entry of index.jobs) {
      if (repoId && entry.repoId !== repoId) {
        retained.push(entry);
        continue;
      }
      try {
        const job = getExecutionJob(controllerHome, entry.repoId, entry.jobId);
        if (!ACTIVE_JOB_STATUSES.has(job.status)) {
          removed += 1;
          continue;
        }
        jobs.push(job);
        retained.push({
          jobId: job.jobId,
          repoId: job.repoId,
          status: job.status,
          priority: job.priority,
          queuedAt: job.queuedAt,
          updatedAt: job.updatedAt,
        });
      } catch {
        removed += 1;
      }
    }
    if (removed > 0) writeActiveIndex(controllerHome, { ...index, jobs: retained });
    return jobs;
  } finally {
    releaseControllerLock(controllerHome, key, acquired.lock.lockId);
  }
}

function executionJobApprovalRequestId(job: ExecutionJob): string | undefined {
  if (typeof job.result?.approvalRequestId === 'string') return job.result.approvalRequestId;
  const authorization = job.result?.authorization;
  return authorization &&
    typeof authorization === 'object' &&
    typeof (authorization as Record<string, unknown>).approvalRequestId === 'string'
    ? String((authorization as Record<string, unknown>).approvalRequestId)
    : undefined;
}

export function resumeExecutionJobAfterApproval(
  controllerHome: string,
  repoId: string,
  approvalRequestId: string,
): ExecutionJob | undefined {
  const waiting = listActiveExecutionJobs(controllerHome, repoId).find(
    (job) => job.status === 'waiting_for_approval' && executionJobApprovalRequestId(job) === approvalRequestId,
  );
  if (!waiting) return undefined;
  const args = waiting.payload.arguments ?? {};
  return transitionExecutionJob(
    controllerHome,
    repoId,
    waiting.jobId,
    'queued',
    {
      payload: {
        ...waiting.payload,
        arguments: { ...args, approval_request_id: approvalRequestId },
      },
      result: undefined,
      error: undefined,
      outcome: undefined,
      workerPid: undefined,
      leaseRefs: [],
      startedAt: undefined,
      heartbeatAt: undefined,
      finishedAt: undefined,
    },
    { approvalRequestId, resumed: true },
  );
}

export function listExecutionJobs(controllerHome: string, repoId: string, limit = 100): ExecutionJob[] {
  const boundedLimit = Math.max(1, Math.min(limit, 1000));
  const output: ExecutionJob[] = [];
  for (const entry of readRecentIndex(controllerHome).jobs) {
    if (entry.repoId !== repoId) continue;
    try {
      output.push(getExecutionJob(controllerHome, repoId, entry.jobId));
    } catch {
      /* stale index entry */
    }
    if (output.length >= boundedLimit) break;
  }
  if (output.length > 0) return output;

  // Backward-compatible one-time fallback for state created before the recent index existed.
  const records = join(executionJobRootPath(controllerHome, repoId), 'records');
  try {
    const legacy = readdirSync(records)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJsonFile<ExecutionJob>(join(records, name)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, boundedLimit);
    // Keep this fallback read-only. Index migration belongs to an explicit
    // maintenance path; a status/read request must never acquire the global
    // execution-index lock or rewrite thousands of entries.
    return legacy;
  } catch {
    return [];
  }
}

export async function cancelExecutionJob(
  controllerHome: string,
  repoId: string,
  jobId: string,
  reason = 'Cancelled by user',
): Promise<ExecutionJob> {
  const current = getExecutionJob(controllerHome, repoId, jobId);
  if (TERMINAL_JOB_STATUSES.has(current.status)) return current;
  const cancelled = transitionExecutionJob(
    controllerHome,
    repoId,
    jobId,
    'cancelled',
    {
      error: { code: 'CANCELLED', message: reason, retryable: false },
      leaseRefs: [],
    },
    { reason },
  );
  releaseExecutionLeases(controllerHome, repoId, jobId, current.leaseRefs);
  await terminateProcessTree(current.workerPid);
  return cancelled;
}

export interface RetiredExecutionJobCleanupReport {
  policyVersion: 'retired-execution-job-retention-v1';
  inspected: number;
  terminal: number;
  protectedActive: number;
  eligible: number;
  removed: number;
  retained: number;
  scanTruncated: boolean;
  budgetExhausted: boolean;
  blockers: string[];
}

const DEFAULT_RETIRED_JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_RETAINED_TERMINAL_JOBS = 500;
const DEFAULT_RETIRED_JOB_SCAN = 5_000;
const DEFAULT_RETIRED_JOB_REMOVALS = 32;

/**
 * Bounded compatibility cleanup for historical ExecutionJob records. New
 * execution uses direct Process Runtime or an explicit external Controller, so
 * this only reclaims proven-terminal legacy bundles and never participates in
 * execution admission or effect recovery.
 */
export function cleanupRetiredExecutionJobs(
  controllerHome: string,
  repoId: string,
  options: {
    nowMs?: number;
    retentionMs?: number;
    maxTerminalRecords?: number;
    maxScan?: number;
    maxRemovals?: number;
  } = {},
): RetiredExecutionJobCleanupReport {
  assertRuntimeMayWriteOrThrow('cleanup', controllerHome);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const retentionMs = Math.max(60_000, Math.trunc(options.retentionMs ?? DEFAULT_RETIRED_JOB_RETENTION_MS));
  const maxTerminalRecords = Math.max(
    0,
    Math.min(Math.trunc(options.maxTerminalRecords ?? DEFAULT_MAX_RETAINED_TERMINAL_JOBS), 5_000),
  );
  const maxScan = Math.max(1, Math.min(Math.trunc(options.maxScan ?? DEFAULT_RETIRED_JOB_SCAN), 5_000));
  const maxRemovals = Math.max(1, Math.min(Math.trunc(options.maxRemovals ?? DEFAULT_RETIRED_JOB_REMOVALS), 128));
  const recordsRoot = join(executionJobRoot(controllerHome, repoId), 'records');
  const scanned: Array<{ path: string; job: ExecutionJob; finishedAt: number }> = [];
  let inspected = 0;
  let protectedActive = 0;
  let scanTruncated = false;
  const blockers: string[] = [];

  try {
    const directory = opendirSync(recordsRoot);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        if (inspected >= maxScan) {
          scanTruncated = true;
          break;
        }
        inspected += 1;
        const path = join(recordsRoot, entry.name);
        let job: ExecutionJob;
        try {
          job = readJsonFile<ExecutionJob>(path);
        } catch {
          blockers.push(`invalid_record:${entry.name}`);
          continue;
        }
        if (job.repoId !== repoId || !job.jobId || job.schemaVersion !== 1) {
          blockers.push(`identity_mismatch:${entry.name}`);
          continue;
        }
        if (!TERMINAL_JOB_STATUSES.has(job.status)) {
          protectedActive += 1;
          continue;
        }
        const finishedAt = Date.parse(job.finishedAt ?? job.updatedAt ?? job.createdAt);
        scanned.push({ path, job, finishedAt: Number.isFinite(finishedAt) ? finishedAt : 0 });
      }
    } finally {
      directory.closeSync();
    }
  } catch {
    return {
      policyVersion: 'retired-execution-job-retention-v1',
      inspected: 0,
      terminal: 0,
      protectedActive: 0,
      eligible: 0,
      removed: 0,
      retained: 0,
      scanTruncated: false,
      budgetExhausted: false,
      blockers: [],
    };
  }

  scanned.sort((a, b) => b.finishedAt - a.finishedAt);
  const cutoff = nowMs - retentionMs;
  const eligible = scanned.filter((entry, index) => index >= maxTerminalRecords || entry.finishedAt <= cutoff);
  let removed = 0;
  for (const candidate of eligible) {
    if (removed >= maxRemovals) break;
    const lockKey = { scope: 'task' as const, repoId, taskId: `execution-job-${candidate.job.jobId}` };
    const acquired = tryAcquireControllerLock(controllerHome, lockKey, `retired-job-retention:${candidate.job.jobId}`);
    if (!acquired.acquired) {
      blockers.push(`lock_contended:${candidate.job.jobId}`);
      continue;
    }
    try {
      let current: ExecutionJob;
      try {
        current = getExecutionJob(controllerHome, repoId, candidate.job.jobId);
      } catch {
        continue;
      }
      if (!TERMINAL_JOB_STATUSES.has(current.status)) {
        protectedActive += 1;
        continue;
      }
      const currentFinishedAt = Date.parse(current.finishedAt ?? current.updatedAt ?? current.createdAt);
      const expired = !Number.isFinite(currentFinishedAt) || currentFinishedAt <= cutoff;
      const overCapacity = scanned.findIndex((entry) => entry.job.jobId === current.jobId) >= maxTerminalRecords;
      if (!expired && !overCapacity) continue;

      removeFile(candidate.path);
      removeFile(
        join(executionJobRoot(controllerHome, repoId), 'receipts', `${sanitizeFileComponent(current.jobId)}.json`),
      );
      removeFile(
        join(
          repositoryControllerRoot(controllerHome, repoId),
          'events',
          'jobs',
          `${sanitizeFileComponent(current.jobId)}.jsonl`,
        ),
      );
      const artifactCleanup = cleanupExecutionArtifactsForJob(controllerHome, repoId, current.jobId);
      if (current.requestId) removeFile(legacyRequestIndexPath(controllerHome, current.requestId));
      blockers.push(...artifactCleanup.blockers.map((blocker) => `artifact:${current.jobId}:${blocker}`));
      if (artifactCleanup.scanTruncated) blockers.push(`artifact_scan_truncated:${current.jobId}`);
      withControllerLock(
        controllerHome,
        { scope: 'global', resource: 'execution-index' },
        `retired-job-index:${current.jobId}`,
        () => {
          const active = readActiveIndex(controllerHome);
          active.jobs = active.jobs.filter((entry) => entry.jobId !== current.jobId);
          writeActiveIndex(controllerHome, active);
          const recent = readRecentIndex(controllerHome);
          recent.jobs = recent.jobs.filter((entry) => entry.jobId !== current.jobId);
          writeRecentIndex(controllerHome, recent);
        },
        10_000,
      );
      removed += 1;
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    } finally {
      releaseControllerLock(controllerHome, lockKey, acquired.lock.lockId);
    }
  }

  return {
    policyVersion: 'retired-execution-job-retention-v1',
    inspected,
    terminal: scanned.length,
    protectedActive,
    eligible: eligible.length,
    removed,
    retained: Math.max(0, scanned.length - removed),
    scanTruncated,
    budgetExhausted: eligible.length > removed && removed >= maxRemovals,
    blockers: blockers.slice(0, 16),
  };
}
