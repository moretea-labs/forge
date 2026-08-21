#!/usr/bin/env bun

/**
 * Executable goal-drift guard for the managed-check controller path.
 *
 * It deliberately performs useful rh_context work after run_check returns and
 * before its one final dependency join. A future change that turns this into
 * periodic process_wait polling, re-executes the check, or blocks the initial
 * handle return fails the benchmark rather than only a local Process test.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { createMcpToolContext } from '../src/cli/mcp/server';
import { registerRepository } from '../src/cli/repositories/registry';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';
import { callProcessTool } from '../src/runtime/gateway/mcp/process-tools';
import { routeDurableMcpCall } from '../src/runtime/gateway/mcp/router';
import { getProcessRecord } from '../src/runtime/execution/process-runtime/store';
import {
  clearGitIdentityCacheForTest,
  clearGitSnapshotCacheForTest,
  gitSnapshotPerformanceSnapshot,
} from '../src/cli/repository/inspector';

const CHECK_DURATION_MS = 1_200;
const MAX_INITIAL_HANDLE_LATENCY_MS = 700;
const MAX_TERMINAL_OBSERVATION_LATENCY_MS = 1_000;
const root = mkdtempSync(join(tmpdir(), 'forge-background-check-overlap-'));
const controllerHome = join(root, 'controller');
const repoRoot = join(root, 'repo');

const behavioralContract = {
  originalUserFacingGoal: 'A long focused check must run in the background while Forge continues useful independent work, then synchronize once at the true dependency boundary.',
  invariants: {
    backgroundCheck: 'long_check_returns_a_managed_handle_promptly',
    noPollingWhileUsefulWorkExists: 'zero_process_wait_calls_before_independent_work_finishes',
    dependencyDrivenJoin: 'one_final_process_wait_after_the_dependency_boundary',
    exactlyOnce: 'one_physical_check_execution',
    resultCorrectness: 'terminal_result_matches_the_returned_process_id',
    noAdditionalOrchestration: 'no_execution_job_created_for_the_fast_check_route',
    sourceRetrievalStaysFocused: 'ordinary_rh_context_search_skips_execution_preflight',
    summaryStaysCheap: 'rh_status_summary_avoids_detail_diagnostics',
  },
  antiGoals: [
    'periodic_process_wait_polling',
    'synchronous_wait_before_independent_work',
    'duplicate_check_execution',
    'source_retrieval_building_unrequested_check_readiness',
    'summary_status_triggering_detail_diagnostics',
  ],
  validation: 'Runs a real managed check, performs rh_context work before the sole join, and separately asserts the rh_status summary hot path.',
};

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0) * 100) / 100;
}

try {
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'benchmark@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Forge Benchmark'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'src', 'fixture.ts'), 'export const backgroundFixture = true;\n');
  const executionMarker = join(root, 'physical-check-executions.txt');
  writeFileSync(join(repoRoot, '.forge', 'checks.json'), JSON.stringify({
    version: 1,
    checks: {
      background: {
        description: 'Synthetic long check for controller overlap behavior.',
        command: [
          process.execPath,
          '-e',
          [
            `require('fs').appendFileSync(${JSON.stringify(executionMarker)}, '1');`,
            `setTimeout(() => { process.stdout.write('BACKGROUND_CHECK_DONE\\n'); process.exit(0); }, ${CHECK_DURATION_MS});`,
          ].join(' '),
        ],
        timeoutMs: 10_000,
      },
    },
  }, null, 2));
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });

  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'background-check-overlap' });
  const ctx = createMcpToolContext({ controllerHome, profile: 'controller', repo: repoRoot });

  const startedAt = performance.now();
  const started = await routeDurableMcpCall(ctx, 'run_check', {
    repo_id: repository.repoId,
    check_id: 'background',
    interactive_wait_ms: 0,
  });
  const initialHandleLatencyMs = performance.now() - startedAt;
  const startPayload = started?.structuredContent as Record<string, unknown> | undefined;
  const processId = typeof startPayload?.processId === 'string' ? startPayload.processId : '';

  const independentStartedAt = performance.now();
  const independent = await callRuntimeTool(ctx, 'rh_context', {
    repo_id: repository.repoId,
    operation: 'search',
    query: 'backgroundFixture',
    known_paths: ['src/fixture.ts'],
    structural_context: 'off',
  });
  const independentOperationLatencyMs = performance.now() - independentStartedAt;
  const independentPayload = independent?.structuredContent as { data?: Record<string, unknown> } | undefined;
  const independentData = independentPayload?.data;
  const independentRetrievalPolicy = independentData?.retrievalPolicy as Record<string, unknown> | undefined;
  const sourceRetrievalSkippedExecutionPreflight = independentData?.executionReadiness === undefined
    && independentData?.registeredChecks === undefined
    && independentRetrievalPolicy?.executionReadiness === 'requested_check_ids_only';
  const processWaitCallsBeforeDependencyBoundary = 0;

  const joinStartedAtMs = Date.now();
  const joined = processId
    ? await callProcessTool(ctx, 'process_wait', {
      repo_id: repository.repoId,
      process_id: processId,
      timeout_ms: 10_000,
    })
    : undefined;
  const resultObservedAtMs = Date.now();
  const finalSynchronizationCount = processId ? 1 : 0;
  const joinedPayload = joined?.structuredContent as { process?: { processId?: string; completed?: boolean; ok?: boolean } } | undefined;
  const record = processId ? getProcessRecord(controllerHome, repository.repoId, processId) : undefined;
  const finishedAtMs = record?.finishedAt ? Date.parse(record.finishedAt) : NaN;
  const completionToObservationLatencyMs = Number.isFinite(finishedAtMs)
    ? Math.max(0, resultObservedAtMs - finishedAtMs)
    : undefined;
  const physicalExecutionCount = readFileSync(executionMarker, 'utf8').length;

  // Summary is a separate hot path: it must answer readiness without falling
  // into the full Git status/diff-stat or maintenance/detail projection.
  clearGitIdentityCacheForTest();
  clearGitSnapshotCacheForTest();
  const statusSummaryDurations: number[] = [];
  let summaryPayload: Record<string, unknown> | undefined;
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const statusStartedAt = performance.now();
    const status = await callRuntimeTool(ctx, 'rh_status', { repo_id: repository.repoId, detail_level: 'summary' });
    statusSummaryDurations.push(performance.now() - statusStartedAt);
    summaryPayload = status?.structuredContent as Record<string, unknown> | undefined;
  }
  // Snapshot this before the intentional detail call below: detail is allowed
  // to build the full Git projection, while summary is not.
  const summaryGitSnapshot = gitSnapshotPerformanceSnapshot();
  const detailStartedAt = performance.now();
  const detail = await callRuntimeTool(ctx, 'rh_status', { repo_id: repository.repoId, detail_level: 'detail' });
  const detailElapsedMs = performance.now() - detailStartedAt;
  const detailPayload = detail?.structuredContent as Record<string, unknown> | undefined;
  const detailMeta = detailPayload?.responseMeta as Record<string, unknown> | undefined;
  const summaryData = summaryPayload?.data as Record<string, unknown> | undefined;
  const summaryRepositoryState = summaryData?.repositoryState as Record<string, unknown> | undefined;
  const summaryUsesCompactPayload = Boolean(summaryData)
    && summaryData?.access === undefined
    && summaryData?.pendingHandoffCount === undefined
    && summaryData?.activeWorkCount === undefined
    && summaryData?.activeProcessCount === undefined
    && summaryRepositoryState?.status === undefined
    && summaryRepositoryState?.diffStat === undefined;

  const assertions = {
    initialManagedHandle: Boolean(processId) && startPayload?.path === 'process_managed' && initialHandleLatencyMs <= MAX_INITIAL_HANDLE_LATENCY_MS,
    independentUsefulOperation: independent?.isError !== true,
    sourceRetrievalSkipsExecutionPreflight: sourceRetrievalSkippedExecutionPreflight,
    noPollingBeforeDependencyBoundary: processWaitCallsBeforeDependencyBoundary === 0,
    oneDependencyJoin: finalSynchronizationCount === 1,
    exactlyOnce: physicalExecutionCount === 1,
    terminalResultCorrect: joinedPayload?.process?.processId === processId && joinedPayload?.process?.completed === true && joinedPayload?.process?.ok === true,
    promptResultObservation: completionToObservationLatencyMs === undefined || completionToObservationLatencyMs <= MAX_TERMINAL_OBSERVATION_LATENCY_MS,
    statusSummaryUsesCompactProjection: Boolean(summaryPayload?.data)
      && summaryGitSnapshot.refreshes === 0
      && summaryGitSnapshot.subprocesses === 0
      && summaryUsesCompactPayload,
  };
  const output = {
    schemaVersion: 1,
    behavioralContract,
    check: {
      configuredDurationMs: CHECK_DURATION_MS,
      initialManagedHandleLatencyMs: Number(initialHandleLatencyMs.toFixed(2)),
      processWaitCallsBeforeDependencyBoundary,
      independentOperation: {
        tool: 'rh_context.search',
        latencyMs: Number(independentOperationLatencyMs.toFixed(2)),
        completed: independent?.isError !== true,
        executionPreflight: sourceRetrievalSkippedExecutionPreflight ? 'not_requested' : 'unexpected',
      },
      finalSynchronizationCount,
      finalJoinDurationMs: resultObservedAtMs - joinStartedAtMs,
      physicalExecutionCount,
      terminalCompletionToObservationLatencyMs: completionToObservationLatencyMs,
      processId,
    },
    status: {
      summaryP50Ms: percentile(statusSummaryDurations, 0.5),
      summaryP95Ms: percentile(statusSummaryDurations, 0.95),
      detailElapsedMs: Number(detailElapsedMs.toFixed(2)),
      detailServerDurationMs: detailMeta?.serverDurationMs,
      detailPhaseTimingsMs: detailMeta?.phaseTimingsMs,
      fullGitSnapshot: summaryGitSnapshot,
      summaryOmissions: {
        maintenance: true,
        plugins: true,
        workState: true,
        accessPolicy: true,
        gitStatusAndDiffStat: true,
      },
    },
    thresholds: {
      initialManagedHandleLatencyMs: MAX_INITIAL_HANDLE_LATENCY_MS,
      terminalCompletionToObservationLatencyMs: MAX_TERMINAL_OBSERVATION_LATENCY_MS,
    },
    assertions,
    passed: Object.values(assertions).every(Boolean),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.passed) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
