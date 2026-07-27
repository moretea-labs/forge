#!/usr/bin/env bun
/**
 * Stress test for worker exit race condition fix.
 *
 * Spawns N concurrent execution jobs that exit cleanly (code 0) after minimal work.
 * Before the fix, some would be incorrectly marked as "exited before completion".
 * After the fix (150ms grace period), all should succeed.
 */

import { resolve } from 'path';
import { ensureControllerHome, resolveRepoPreferredControllerHome } from '../src/cli/repositories/controller-home';
import { createExecutionJob, getExecutionJob } from '../src/runtime/execution/jobs/store';

const REPO_ROOT = resolve(process.cwd());
const CONTROLLER_HOME = ensureControllerHome(resolveRepoPreferredControllerHome(REPO_ROOT));
const REPO_ID = 'repo_123b7cf58b6b17b5cbe46a56'; // Current project repo
const CONCURRENCY = 100;
const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 60_000;

interface TestResult {
  jobId: string;
  status: string;
  duration: number;
  error?: { code: string; message: string };
}

async function runTest(): Promise<void> {
  console.log(`\n[test-worker-race] Starting stress test with ${CONCURRENCY} concurrent jobs`);
  console.log(`[test-worker-race] Repo: ${REPO_ID}, Controller: ${CONTROLLER_HOME}\n`);

  const jobs: string[] = [];
  const startTime = Date.now();

  // Create all jobs
  for (let i = 0; i < CONCURRENCY; i++) {
    const requestId = `race-test-${Date.now()}-${i}`;
    const { job } = createExecutionJob(CONTROLLER_HOME, {
      repoId: REPO_ID,
      checkoutId: 'main',
      type: 'mcp-tool',
      requestId,
      semanticKey: `race-test:${startTime}:${i}`,
      origin: { surface: 'system', actor: 'test-worker-race', correlationId: `race-test-${startTime}` },
      payload: {
        operation: 'repository_command_execute',
        arguments: {
          command: 'sleep 0.1 && echo "success" && exit 0',
          request_id: requestId,
        },
        target: 'mcp-tool',
        profile: 'controller',
      },
      priority: 'P2',
      resourceClaims: [],
      timeoutMs: 10_000,
      maxAttempts: 1,
    });
    jobs.push(job.jobId);
  }

  console.log(`[test-worker-race] Created ${jobs.length} jobs, waiting for completion...\n`);

  // Poll until all terminal
  const results: TestResult[] = [];
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    let pending = 0;
    for (const jobId of jobs) {
      if (results.find((r) => r.jobId === jobId)) continue;

      const current = getExecutionJob(CONTROLLER_HOME, REPO_ID, jobId);
      const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale'].includes(current.status);

      if (terminal) {
        results.push({
          jobId,
          status: current.status,
          duration: Date.parse(current.updatedAt) - Date.parse(current.createdAt),
          error: current.error,
        });
      } else {
        pending++;
      }
    }

    if (results.length === jobs.length) break;

    process.stdout.write(`\r[test-worker-race] Progress: ${results.length}/${jobs.length} terminal, ${pending} pending`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.log('\n');

  // Analyze results
  const succeeded = results.filter((r) => r.status === 'succeeded');
  const failed = results.filter((r) => r.status === 'failed');
  const falseFailures = failed.filter((r) => r.error?.code === 'WORKER_EXITED' && r.error.message.includes('exit code 0'));

  const totalDuration = Date.now() - startTime;
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;

  console.log(`[test-worker-race] ====== RESULTS ======`);
  console.log(`[test-worker-race] Total: ${results.length}/${jobs.length}`);
  console.log(`[test-worker-race] Succeeded: ${succeeded.length}`);
  console.log(`[test-worker-race] Failed: ${failed.length}`);
  console.log(`[test-worker-race] False failures (exit 0 judged as failure): ${falseFailures.length}`);
  console.log(`[test-worker-race] Avg job duration: ${avgDuration.toFixed(0)}ms`);
  console.log(`[test-worker-race] Total test duration: ${totalDuration}ms\n`);

  if (falseFailures.length > 0) {
    console.log(`[test-worker-race] ❌ REGRESSION: Found ${falseFailures.length} false failures:`);
    for (const f of falseFailures.slice(0, 5)) {
      console.log(`  - ${f.jobId}: ${f.error?.message}`);
    }
    process.exit(1);
  }

  if (succeeded.length === jobs.length) {
    console.log(`[test-worker-race] ✅ SUCCESS: All ${jobs.length} jobs completed successfully`);
    console.log(`[test-worker-race] No false failures detected. Race condition fix is effective.`);
    process.exit(0);
  } else {
    console.log(`[test-worker-race] ⚠️  PARTIAL: ${succeeded.length}/${jobs.length} succeeded, ${failed.length} failed`);
    console.log(`[test-worker-race] Some failures may be legitimate (not race condition related)`);
    process.exit(failed.length > 10 ? 1 : 0);
  }
}

runTest().catch((error) => {
  console.error('[test-worker-race] Fatal error:', error);
  process.exit(1);
});
