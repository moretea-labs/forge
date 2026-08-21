import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { executionJobRoot } from '../../execution/jobs/store';

export const MAX_SCHEDULER_WORKER_STDERR_BYTES = 16 * 1024;

export interface SchedulerWorkerStderrSnapshot {
  stderr: string;
  stderrTruncated: boolean;
}

export interface SchedulerWorkerStderrCapture {
  path: string;
  append(chunk: Buffer | string): void;
  snapshot(): SchedulerWorkerStderrSnapshot;
}

export function createSchedulerWorkerStderrCapture(input: {
  controllerHome: string;
  repoId: string;
  jobId: string;
  attempt: number;
  maxBytes?: number;
}): SchedulerWorkerStderrCapture {
  const path = join(
    executionJobRoot(input.controllerHome, input.repoId),
    'worker-stderr',
    `${input.jobId}-attempt-${input.attempt}.log`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', 'utf8');

  const maxBytes = input.maxBytes ?? MAX_SCHEDULER_WORKER_STDERR_BYTES;
  let stderr = '';
  let stderrBytes = 0;
  let stderrTruncated = false;

  return {
    path,
    append(chunk) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const bytes = Buffer.byteLength(text);
      const remaining = maxBytes - stderrBytes;
      const accepted = remaining > 0 ? Buffer.from(text).subarray(0, remaining).toString('utf8') : '';
      if (accepted) {
        stderr += accepted;
        stderrBytes += Buffer.byteLength(accepted);
        try {
          appendFileSync(path, accepted, 'utf8');
        } catch {
          stderrTruncated = true;
        }
      }
      if (bytes > Math.max(0, remaining)) stderrTruncated = true;
    },
    snapshot() {
      return { stderr, stderrTruncated };
    },
  };
}
