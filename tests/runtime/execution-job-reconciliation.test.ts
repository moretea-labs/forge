import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
} from '../../src/runtime/execution/jobs/store';
import { ACTIVE_JOB_STATUSES, type ExecutionJob } from '../../src/runtime/execution/jobs/types';
import type { AgentJobMetaReadShape } from '../../src/runtime/agent-jobs/read-model';
import type { LocalBridgeJob } from '../../src/runtime/local-bridge/types';
import { summarizeExecutionJobForMcp } from '../../src/runtime/safe-tooling/job-summary';
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
  const indexRoot = join(controllerHome, 'indexes', 'execution-jobs');
  mkdirSync(indexRoot, { recursive: true });
  writeFileSync(
    join(indexRoot, 'active.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      jobs: jobs
        .filter((job) => ACTIVE_JOB_STATUSES.has(job.status))
        .map((job) => ({
          jobId: job.jobId,
          repoId: job.repoId,
          status: job.status,
          priority: job.priority,
          queuedAt: job.queuedAt,
          updatedAt: job.updatedAt,
        })),
    })}\n`,
    'utf8',
  );
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

  test('scheduler reconciliation prunes terminal records left behind in the active index', async () => {
    const controllerHome = tempControllerHome();
    const queued = executionJob('stale-active-entry', 'queued');
    persistFixtureJobs(controllerHome, [queued]);

    const terminal = { ...queued, status: 'timed_out' as const, finishedAt: new Date().toISOString() };
    const records = join(executionJobRoot(controllerHome, 'repo-test'), 'records');
    writeFileSync(join(records, `${terminal.jobId}.json`), `${JSON.stringify(terminal)}\n`, 'utf8');

    expect(listActiveExecutionJobs(controllerHome, 'repo-test')).toHaveLength(0);
    const before = JSON.parse(readFileSync(join(controllerHome, 'indexes', 'execution-jobs', 'active.json'), 'utf8'));
    expect(before.jobs.map((entry: { jobId: string }) => entry.jobId)).toEqual(['stale-active-entry']);

    const summary = await reconcileExecutionJobsAsync(controllerHome, 'repo-test');
    expect(summary.inspected).toBe(0);

    const after = JSON.parse(readFileSync(join(controllerHome, 'indexes', 'execution-jobs', 'active.json'), 'utf8'));
    expect(after.jobs).toEqual([]);
  });
});

describe('ExecutionJob delegated summary snapshots', () => {
  test('reads child snapshots without reconciling or mutating lifecycle state', () => {
    const repoRoot = tempControllerHome();
    const timestamp = new Date().toISOString();
    const localJob: LocalBridgeJob = {
      schemaVersion: 1,
      jobId: 'local-child',
      action: 'quick-agent-session',
      payload: { title: 'Child run', objective: 'Exercise read-only summary' },
      requestedBy: 'test',
      approval: 'auto',
      status: 'running',
      createdAt: timestamp,
      updatedAt: timestamp,
      runId: 'run-child',
      issueId: 'ISSUE-7',
      taskId: 'task-7',
      ephemeral: false,
    };
    const localJobPath = join(repoRoot, '.ai/harness/local-jobs/local-child/job.json');
    mkdirSync(join(repoRoot, '.ai/harness/local-jobs/local-child'), { recursive: true });
    const localJobContents = `${JSON.stringify(localJob)}\n`;
    writeFileSync(localJobPath, localJobContents, 'utf8');

    // A dead worker with no result would be terminalized by getAgentJob; summaries must not trigger that reconciliation.
    const agentMeta: AgentJobMetaReadShape & { resultPath: string; workerPid: number } = {
      schemaVersion: 3,
      runId: 'run-child',
      issueId: 'ISSUE-7',
      taskId: 'task-7',
      agent: 'codex',
      provider: 'local',
      status: 'running',
      repoRoot,
      worktree: repoRoot,
      createdAt: timestamp,
      resultPath: 'missing-result.json',
      workerPid: 2_147_483_647,
    };
    const agentMetaPath = join(repoRoot, '.ai/harness/jobs/run-child/meta.json');
    mkdirSync(join(repoRoot, '.ai/harness/jobs/run-child'), { recursive: true });
    const agentMetaContents = `${JSON.stringify(agentMeta)}\n`;
    writeFileSync(agentMetaPath, agentMetaContents, 'utf8');

    const job = executionJob('delegated-summary', 'succeeded', {
      type: 'agent-run',
      payload: { operation: 'dispatch_task', target: 'mcp-tool' },
      result: { childReference: { localJobId: 'local-child' } },
    });
    const summary = summarizeExecutionJobForMcp(job, repoRoot);

    expect(summary.childLocalJobStatus).toBe('running');
    expect(summary.childRunStatus).toBe('running');
    expect(summary.childReference).toMatchObject({ localJobId: 'local-child', runId: 'run-child', issueId: 'ISSUE-7', taskId: 'task-7' });
    expect(readFileSync(localJobPath, 'utf8')).toBe(localJobContents);
    expect(readFileSync(agentMetaPath, 'utf8')).toBe(agentMetaContents);
  });
});
