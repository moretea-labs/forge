import { listActiveExecutionJobs } from './jobs/store';
import type { ExecutionJob } from './jobs/types';
import { listRecoverableProcessRecords } from './process-runtime/store';
import { isManagedProcessActive } from './process-runtime/types';

export function executionJobBelongsToWork(job: ExecutionJob, workId: string): boolean {
  if (job.resourceClaims.some((claim) => claim.workId === workId)) return true;
  const payload = job.payload as Record<string, unknown>;
  const args = payload.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)
    ? payload.arguments as Record<string, unknown>
    : undefined;
  return [payload.workId, payload.work_id, args?.workId, args?.work_id].some((value) => value === workId);
}

export function workHasActiveExecution(controllerHome: string, repoId: string, workId: string): boolean {
  const activeProcess = listRecoverableProcessRecords(controllerHome, repoId)
    .some((record) => record.workId === workId && isManagedProcessActive(record));
  if (activeProcess) return true;
  return listActiveExecutionJobs(controllerHome, repoId)
    .some((job) => executionJobBelongsToWork(job, workId));
}
