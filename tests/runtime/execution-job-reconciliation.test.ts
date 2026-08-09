import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  reconcileExecutionJobs,
  reconcileExecutionJobsAsync,
} from '../../src/runtime/control-plane/global-scheduler/reconciliation';
import {
  executionJobRoot,
  getExecutionJob,
  listActiveExecutionJobs,
  rebuildExecutionJobIndexes,
} from '../../src/runtime/execution/jobs/store';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';
import {
  acquireExecutionLeases,
  listActiveLeases,
} from '../../src/runtime/resources/leases/store';

const roots: string[] = [];

function tempControllerHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-execution-reconciliation-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function executionJob(
  jobId: string,
  status: ExecutionJob['status'],
  patch: Partial<ExecutionJob> = {},
): ExecutionJob {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    jobId,
    repoId: 'repo-test',
    type: 'check',
    status,
    priority: 'P2',
    requestId: `request-${jobId}`,
    semanticKey: `test:${jobId}`,
    payload: { operation: 'run_check', target: 'mcp-tool' },
    origin: { surface: 'system', actor: 'test' },
    resourceClaims: [],
    dependencies: [],
    leaseRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    queuedAt: timestamp,
    attempt: status === 'running' ? 1 : 0,
    maxAttempts: 1,
    evidenceIds: [],
    ...patch,
  };
}

function persistFixtureJobs(controllerHome: string, jobs: ExecutionJob[]): void {
  const records = join(executionJobRoot(controllerHome, 'repo-test'), 'records');
  mkdirSync(records, { recursive: true });
  for (const job of jobs) {
    writeFileSync(join(records, `${job.jobId}.json`), `${JSON.stringify(job)}\n`, 'utf8');
  }
  rebuildExecutionJobIndexes(controllerHome, ['repo-test']);
}

async function exerciseIsolation(mode: 'startup' | 'scheduler') {
  const controllerHome = tempControllerHome();
  const leaseAcquisition = acquireExecutionLeases(
    controllerHome,
    'repo-test',
    'job-timeout',
    [{ resourceKey: 'repo-state', mode: 'exclusive' }],
  );
  expect(leaseAcquisition.acquired).toBe(true);

  const corrupt = executionJob('job-corrupt', 'running', {
    workerPid: undefined,
    heartbeatAt: undefined,
    // Historical records may predate required payload fields. The reconciler must
    // isolate this record instead of losing the whole startup/Scheduler pass.
    payload: undefined as unknown as ExecutionJob['payload'],
  });
  const timedOut = executionJob('job-timeout', 'queued', {
    deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    leaseRefs: leaseAcquisition.leases,
  });
  persistFixtureJobs(controllerHome, [corrupt, timedOut]);

  const stderr: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const summary = mode === 'startup'
      ? reconcileExecutionJobs(controllerHome, 'repo-test')
      : await reconcileExecutionJobsAsync(controllerHome, 'repo-test');
    expect(summary).toEqual({ inspected: 2, requeued: 0, terminal: 1, recovered: 0, isolated: 1 });
  } finally {
    process.stderr.write = originalWrite;
  }

  expect(stderr.join('')).toContain('forge_scheduler_execution_job_reconciliation_isolated');
  expect(stderr.join('')).toContain('job-corrupt');
  expect(getExecutionJob(controllerHome, 'repo-test', 'job-timeout').status).toBe('timed_out');
  expect(listActiveExecutionJobs(controllerHome, 'repo-test').map((job) => job.jobId)).toEqual(['job-corrupt']);
  expect(listActiveLeases(controllerHome, 'repo-test')).toHaveLength(0);
}

describe('ExecutionJob reconciliation isolation', () => {
  test('startup reconciliation continues past one malformed historical Job', async () => {
    await exerciseIsolation('startup');
  });

  test('Scheduler reconciliation continues past one malformed historical Job', async () => {
    await exerciseIsolation('scheduler');
  });

  test('startup index rebuild removes terminal historical Jobs idempotently', () => {
    const controllerHome = tempControllerHome();
    const terminal = executionJob('race-test-terminal', 'timed_out', {
      finishedAt: new Date().toISOString(),
    });
    persistFixtureJobs(controllerHome, [terminal]);

    expect(listActiveExecutionJobs(controllerHome, 'repo-test')).toHaveLength(0);
    rebuildExecutionJobIndexes(controllerHome, ['repo-test']);
    expect(listActiveExecutionJobs(controllerHome, 'repo-test')).toHaveLength(0);
  });
});
