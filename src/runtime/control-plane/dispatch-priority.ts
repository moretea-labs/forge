import type {
  ExecutionJob,
  ExecutionJobPriority,
  ExecutionJobStatus,
} from '../execution/jobs/types';

const PRIORITY_WEIGHT: Record<ExecutionJobPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

const DISPATCHABLE_JOB_STATUSES = new Set<ExecutionJobStatus>([
  'queued',
  'waiting_for_dependency',
  'waiting_for_workspace',
  'waiting_for_heavy_check',
  'waiting_for_integration',
  'waiting_for_release_barrier',
]);

export const PRIORITY_AGING_WINDOW_MS = 30 * 60_000;

export type DispatchPriorityCandidate = Pick<ExecutionJob, 'priority' | 'queuedAt' | 'createdAt' | 'jobId'>;

export interface ExecutionJobDispatchRank {
  effectivePriority: number;
  queuedAtMs: number;
  jobId: string;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isExecutionJobDispatchCandidate(job: Pick<ExecutionJob, 'status'>): boolean {
  return DISPATCHABLE_JOB_STATUSES.has(job.status);
}

export function rankExecutionJobForDispatch(
  job: DispatchPriorityCandidate,
  scheduleNow: number,
): ExecutionJobDispatchRank {
  const queuedAtMs = parseTimestamp(job.queuedAt)
    ?? parseTimestamp(job.createdAt)
    ?? scheduleNow;
  const age = Math.max(0, scheduleNow - queuedAtMs);
  const promotions = Math.floor(age / PRIORITY_AGING_WINDOW_MS);
  return {
    effectivePriority: Math.max(0, PRIORITY_WEIGHT[job.priority] - promotions),
    queuedAtMs,
    jobId: job.jobId,
  };
}

export function compareExecutionJobDispatchRanks(
  left: ExecutionJobDispatchRank,
  right: ExecutionJobDispatchRank,
): number {
  return left.effectivePriority - right.effectivePriority
    || left.queuedAtMs - right.queuedAtMs
    || left.jobId.localeCompare(right.jobId);
}
