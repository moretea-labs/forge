#!/usr/bin/env bun
/**
 * Thin Harness V1 — repository MCP facade and execution-kernel benchmark.
 *
 * Measures the public repository facade where available and the bounded Fast
 * execution kernel for primitive reads / mutation ownership, with:
 * - 1 warmup + 3 timed runs (median)
 * - event-loop lag sampling during each case
 * - real lease instrumentation deltas (not hard-coded zeros)
 *
 * Historical baseline reference: e1582c573b738c29ff41eda6884685488654e5b9
 * This script reports current-feature evidence only; it does not fabricate a
 * historical A/B result from a revision without the same benchmark contract.
 *
 * Usage:
 *   bun scripts/benchmark-thin-harness-gateway-ab.ts
 *   bun scripts/benchmark-thin-harness-gateway-ab.ts --json
 *   bun scripts/benchmark-thin-harness-gateway-ab.ts --label feature
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureControllerHome, repositoryControllerRoot } from '../src/cli/repositories/controller-home';
import { registerRepository } from '../src/cli/repositories/registry';
import {
  executeFast,
  executeLightweightLanes,
  executeRepositoryBatch,
  withCheckoutMutationGate,
  type LatencyBreakdown,
} from '../src/runtime/execution/thin-harness';
import {
  getLeaseSideEffectMetrics,
  resetLeaseSideEffectMetrics,
} from '../src/runtime/resources/leases/store';
import { listExecutionJobs } from '../src/runtime/execution/jobs/store';
import { listLocalBridgeJobSnapshots } from '../src/cli/local-bridge/job-store';
import { listFastReceipts } from '../src/runtime/execution/thin-harness/fast-receipt';
import { callRepositoryTool } from '../src/cli/mcp/repository-tools';

const BASELINE_REV = 'e1582c573b738c29ff41eda6884685488654e5b9';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'thin-harness-gw-bench-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Bench']);
  git(repoRoot, ['config', 'user.email', 'bench@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'benchmark fixture\n');
  writeFileSync(join(repoRoot, 'src', 'lib.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'gw-bench' });
  return { root, controllerHome, repoRoot, repository };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function countLeaseFiles(controllerHome: string, repoId: string): number {
  try {
    const active = join(repositoryControllerRoot(controllerHome, repoId), 'leases', 'active');
    if (!existsSync(active)) return 0;
    return readdirSync(active).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function countExecutionJobs(controllerHome: string, repoId: string): number {
  try {
    return listExecutionJobs(controllerHome, repoId).length;
  } catch {
    return 0;
  }
}

function countLocalJobs(repoRoot: string): number {
  try {
    return listLocalBridgeJobSnapshots(repoRoot).length;
  } catch {
    return 0;
  }
}

interface MetricsSample {
  wallClockMs: number;
  totalMs: number;
  unattributedMs: number;
  phaseUnattributedMs: number;
  routingMs: number;
  policyMs: number;
  snapshotMs: number;
  executionMs: number;
  receiptMs: number;
  operationMs: number;
  overheadMs: number;
  responseBytes: number;
  eventLoopLagMs: number;
  executionJobCount: number;
  localJobCount: number;
  workerSpawnCount: number;
  runtimeEventDelta: number;
  projectionInvalidationDelta: number;
  schedulerWakeDelta: number;
  receiptCount: number;
  leaseFilesTouched: number;
  ephemeralLeaseAcquires: number;
  ok: boolean;
}

interface CaseReport {
  name: string;
  median: MetricsSample;
  runs: MetricsSample[];
}

function emptyLatency(): LatencyBreakdown {
  return {
    routingMs: 0,
    policyMs: 0,
    snapshotMs: 0,
    executionMs: 0,
    receiptMs: 0,
    totalMs: 0,
    path: 'fast',
  };
}

async function callRepositoryFacade(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  ok: boolean;
  latency: LatencyBreakdown;
  receipt?: { executionId: string } | null;
  responseBytes: number;
}> {
  const response = await callRepositoryTool(fixture.controllerHome, name, {
    repo_id: fixture.repository.repoId,
    checkout_id: fixture.repository.activeCheckoutId,
    ...args,
  });
  const payload = (response?.structuredContent ?? {}) as Record<string, unknown>;
  return {
    ok: response?.isError !== true && payload.ok !== false,
    latency: (payload.latency as LatencyBreakdown | undefined) ?? emptyLatency(),
    receipt: (payload.receipt as { executionId: string } | null | undefined) ?? null,
    responseBytes: serializedBytes(response),
  };
}

async function measureEventLoopLag(during: () => Promise<void>): Promise<number> {
  let maxLag = 0;
  const handle = setInterval(() => {
    const start = performance.now();
    setImmediate(() => {
      maxLag = Math.max(maxLag, performance.now() - start);
    });
  }, 10);
  handle.unref?.();
  try {
    await during();
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    clearInterval(handle);
  }
  return Math.round(maxLag * 100) / 100;
}

async function sampleOnce(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  fn: () => Promise<{
    ok: boolean;
    latency: LatencyBreakdown;
    receipt?: { executionId: string } | null;
    responseBytes?: number;
    durableSideEffects?: {
      executionJobCount?: number;
      localJobCount?: number;
      workerSpawnCount?: number;
      projectionUpdateCount?: number;
      schedulerWakeCount?: number;
      runtimeEventCount?: number;
      ephemeralLeaseAcquireCount?: number;
    };
  }>,
): Promise<MetricsSample> {
  resetLeaseSideEffectMetrics();
  const sideBefore = getLeaseSideEffectMetrics();
  const jobsBefore = countExecutionJobs(fixture.controllerHome, fixture.repository.repoId);
  const localBefore = countLocalJobs(fixture.repoRoot);
  const receiptsBefore = listFastReceipts(fixture.controllerHome, fixture.repository.repoId, 200).length;
  const leasesBefore = countLeaseFiles(fixture.controllerHome, fixture.repository.repoId);

  let result: Awaited<ReturnType<typeof fn>> | undefined;
  let wallClockMs = 0;
  const lag = await measureEventLoopLag(async () => {
    const started = performance.now();
    try {
      result = await fn();
    } finally {
      wallClockMs = roundMs(performance.now() - started);
    }
  });

  const sideAfter = getLeaseSideEffectMetrics();
  const side = result?.durableSideEffects ?? {};
  const latency = result?.latency ?? {
    routingMs: 0, policyMs: 0, snapshotMs: 0, executionMs: 0, receiptMs: 0, totalMs: 0,
  };
  const routingMs = roundMs(Math.max(latency.routingMs ?? 0, latency.gatewayValidationMs ?? 0));
  const policyMs = roundMs(Math.max(
    latency.policyMs ?? 0,
    latency.authorizationMs ?? 0,
    latency.resourceClaimMs ?? 0,
  ));
  const snapshotMs = roundMs(Math.max(latency.snapshotMs ?? 0, latency.repositorySnapshotMs ?? 0));
  const executionMs = roundMs(Math.max(latency.executionMs ?? 0, latency.operationExecutionMs ?? 0));
  const receiptMs = roundMs(Math.max(latency.receiptMs ?? 0, latency.evidencePersistenceMs ?? 0));
  const reportedTotalMs = roundMs(latency.totalMs ?? 0);
  const phaseAccountedMs = roundMs(routingMs + policyMs + snapshotMs + executionMs + receiptMs);
  const operationMs = Math.max(executionMs, snapshotMs);
  const observedReceiptDelta = Math.max(
    0,
    listFastReceipts(fixture.controllerHome, fixture.repository.repoId, 200).length - receiptsBefore,
  );

  return {
    wallClockMs,
    totalMs: reportedTotalMs,
    unattributedMs: roundMs(wallClockMs - reportedTotalMs),
    phaseUnattributedMs: roundMs(reportedTotalMs - phaseAccountedMs),
    routingMs,
    policyMs,
    snapshotMs,
    executionMs,
    receiptMs,
    operationMs,
    overheadMs: roundMs(Math.max(0, reportedTotalMs - operationMs)),
    responseBytes: result?.responseBytes ?? serializedBytes(result),
    eventLoopLagMs: lag,
    executionJobCount: Math.max(
      0,
      (side.executionJobCount ?? 0)
        + (countExecutionJobs(fixture.controllerHome, fixture.repository.repoId) - jobsBefore),
    ),
    localJobCount: Math.max(
      0,
      (side.localJobCount ?? 0) + (countLocalJobs(fixture.repoRoot) - localBefore),
    ),
    workerSpawnCount: side.workerSpawnCount ?? 0,
    runtimeEventDelta: Math.max(
      0,
      (side.runtimeEventCount ?? 0)
        + (sideAfter.durableAcquireEvents + sideAfter.durableReleaseEvents)
        - (sideBefore.durableAcquireEvents + sideBefore.durableReleaseEvents),
    ),
    projectionInvalidationDelta: Math.max(
      0,
      (side.projectionUpdateCount ?? 0)
        + sideAfter.projectionDirtyMarks
        - sideBefore.projectionDirtyMarks,
    ),
    schedulerWakeDelta: Math.max(
      0,
      (side.schedulerWakeCount ?? 0) + sideAfter.schedulerWakes - sideBefore.schedulerWakes,
    ),
    receiptCount: Math.max(result?.receipt ? 1 : 0, observedReceiptDelta),
    leaseFilesTouched: Math.max(
      0,
      Math.abs(countLeaseFiles(fixture.controllerHome, fixture.repository.repoId) - leasesBefore)
        + (sideAfter.ephemeralAcquires - sideBefore.ephemeralAcquires)
        + (sideAfter.ephemeralReleases - sideBefore.ephemeralReleases),
    ),
    ephemeralLeaseAcquires: Math.max(0, sideAfter.ephemeralAcquires - sideBefore.ephemeralAcquires),
    ok: result?.ok === true,
  };
}

function medianSample(runs: MetricsSample[]): MetricsSample {
  const pick = (key: keyof MetricsSample) => {
    if (key === 'ok') return runs.every((run) => run.ok);
    return median(runs.map((run) => Number(run[key])));
  };
  return {
    wallClockMs: pick('wallClockMs') as number,
    totalMs: pick('totalMs') as number,
    unattributedMs: pick('unattributedMs') as number,
    phaseUnattributedMs: pick('phaseUnattributedMs') as number,
    routingMs: pick('routingMs') as number,
    policyMs: pick('policyMs') as number,
    snapshotMs: pick('snapshotMs') as number,
    executionMs: pick('executionMs') as number,
    receiptMs: pick('receiptMs') as number,
    operationMs: pick('operationMs') as number,
    overheadMs: pick('overheadMs') as number,
    responseBytes: pick('responseBytes') as number,
    eventLoopLagMs: pick('eventLoopLagMs') as number,
    executionJobCount: pick('executionJobCount') as number,
    localJobCount: pick('localJobCount') as number,
    workerSpawnCount: pick('workerSpawnCount') as number,
    runtimeEventDelta: pick('runtimeEventDelta') as number,
    projectionInvalidationDelta: pick('projectionInvalidationDelta') as number,
    schedulerWakeDelta: pick('schedulerWakeDelta') as number,
    receiptCount: pick('receiptCount') as number,
    leaseFilesTouched: pick('leaseFilesTouched') as number,
    ephemeralLeaseAcquires: pick('ephemeralLeaseAcquires') as number,
    ok: pick('ok') as boolean,
  };
}

async function runCase(
  fixture: ReturnType<typeof createFixture>,
  name: string,
  fn: () => Promise<{
    ok: boolean;
    latency: LatencyBreakdown;
    receipt?: { executionId: string } | null;
    responseBytes?: number;
    durableSideEffects?: MetricsSample extends never ? never : {
      executionJobCount?: number;
      localJobCount?: number;
      workerSpawnCount?: number;
      projectionUpdateCount?: number;
      schedulerWakeCount?: number;
      runtimeEventCount?: number;
      ephemeralLeaseAcquireCount?: number;
    };
  }>,
): Promise<CaseReport> {
  // warmup
  await sampleOnce(fixture, name, fn);
  const runs: MetricsSample[] = [];
  for (let i = 0; i < 3; i += 1) {
    runs.push(await sampleOnce(fixture, name, fn));
  }
  return { name, median: medianSample(runs), runs };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const label = process.argv.includes('--label')
    ? process.argv[process.argv.indexOf('--label') + 1] ?? 'feature'
    : 'feature';
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout?.trim() ?? 'unknown';
  const fixture = createFixture();
  const ctx = {
    controllerHome: fixture.controllerHome,
    repository: fixture.repository,
    includeLatencyBreakdown: true,
  };

  try {
    const cases: CaseReport[] = [];

    cases.push(await runCase(fixture, 'small_file_read', () => executeFast(ctx, {
      operation: 'read_file',
      input: { path: 'README.md' },
    })));

    cases.push(await runCase(fixture, 'symbol_search', () => executeFast(ctx, {
      operation: 'search',
      input: { query: 'add', max_results: 10 },
    })));

    cases.push(await runCase(fixture, 'git_status', () => executeFast(ctx, {
      operation: 'git_status',
      input: {},
    })));

    cases.push(await runCase(fixture, 'git_diff', () => executeFast(ctx, {
      operation: 'git_diff',
      input: { max_bytes: 8192 },
    })));

    cases.push(await runCase(fixture, 'bounded_patch', async () => {
      // Restore canonical content so each timed run applies a real bounded replace.
      writeFileSync(join(fixture.repoRoot, 'src', 'lib.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
      return executeFast(ctx, {
        operation: 'apply_patch',
        requestId: `bench-patch-${Date.now()}-${Math.random()}`,
        input: {
          operations: [{
            type: 'replace',
            path: 'src/lib.ts',
            old_text: 'return a + b;',
            new_text: 'return a + b; // bench',
          }],
          allowed_paths: ['src/**'],
          purpose: 'bench-patch',
        },
        allowedPaths: ['src/**'],
      });
    }));

    cases.push(await runCase(fixture, 'focused_command_facade', () => callRepositoryFacade(
      fixture,
      'repository_command_execute',
      {
        command: ['git', 'status', '--short'],
        timeout_ms: 10_000,
        include_latency_breakdown: true,
      },
    )));

    cases.push(await runCase(fixture, '7_step_batch_facade', () => callRepositoryFacade(
      fixture,
      'repository_workbench',
      {
        operation: 'batch_execute',
        payload: {
          include_latency_breakdown: true,
          steps: [
            { kind: 'read_file', input: { path: 'README.md' } },
            { kind: 'search', input: { query: 'add' } },
            { kind: 'read_file', input: { path: 'src/lib.ts' } },
            { kind: 'git_diff', input: {} },
            { kind: 'git_status', input: {} },
            { kind: 'run_short_command', input: { command: ['git', 'rev-parse', 'HEAD'] } },
            { kind: 'search', input: { query: 'benchmark' } },
          ],
        },
      },
    )));

    cases.push(await runCase(fixture, '4_lane_read_facade', () => callRepositoryFacade(
      fixture,
      'repository_workbench',
      {
        operation: 'lanes_execute',
        payload: {
          include_latency_breakdown: true,
          max_concurrency: 4,
          read_lanes: [
            { kind: 'search', input: { query: 'add' } },
            { kind: 'read_file', input: { path: 'README.md' } },
            { kind: 'git_status', input: {} },
            { kind: 'git_diff', input: {} },
          ],
        },
      },
    )));

    cases.push(await runCase(fixture, 'fast_mutation_ownership', async () => {
      const started = performance.now();
      const gated = await withCheckoutMutationGate(
        {
          controllerHome: fixture.controllerHome,
          repoId: fixture.repository.repoId,
          checkoutId: fixture.repository.activeCheckoutId,
          repoRoot: fixture.repoRoot,
          owner: `fast:bench-own-${Date.now()}`,
          ttlMs: 10_000,
        },
        async (_gate, helpers) => {
          helpers.assert();
          await new Promise((resolve) => setTimeout(resolve, 5));
          helpers.renew();
          return true;
        },
      );
      const totalMs = Math.round((performance.now() - started) * 100) / 100;
      return {
        ok: gated.ok,
        latency: {
          routingMs: 0,
          policyMs: 0,
          snapshotMs: 0,
          executionMs: totalMs,
          receiptMs: 0,
          totalMs,
          operationExecutionMs: totalMs,
          path: 'fast' as const,
        },
        receipt: null,
        durableSideEffects: {
          executionJobCount: 0,
          localJobCount: 0,
          workerSpawnCount: 0,
          projectionUpdateCount: 0,
          runtimeEventCount: 0,
          schedulerWakeCount: 0,
        },
      };
    }));

    const report = {
      schemaVersion: 4,
      kind: 'repository_facade_feature_benchmark',
      comparisonMode: 'feature_only',
      label,
      featureRevision: head,
      baselineRevision: BASELINE_REV,
      at: new Date().toISOString(),
      note: [
        'Measures repository MCP facade operations plus bounded execution-kernel primitives.',
        '1 warmup + 3 runs median. Wall time surrounds only the operation; event-loop lag settling is excluded.',
        'Reported time and phases come from LatencyBreakdown; outer gap is wall minus reported total and phase gap is reported total minus named phases.',
        'Response bytes measure the in-process result/envelope serialized by this benchmark.',
        'Counters come from lease instrumentation and job stores.',
        `Baseline ${BASELINE_REV} is a historical reference only; no synthetic A/B claim is made.`,
      ].join(' '),
      cases: cases.map((entry) => ({
        name: entry.name,
        median: entry.median,
        runs: entry.runs,
      })),
      acceptance: {
        zeroExecutionJobs: cases.every((entry) => entry.median.executionJobCount === 0),
        zeroLocalJobs: cases.every((entry) => entry.median.localJobCount === 0),
        zeroWorkers: cases.every((entry) => entry.median.workerSpawnCount === 0),
        zeroRuntimeEvents: cases.every((entry) => entry.median.runtimeEventDelta === 0),
        zeroProjectionInvalidations: cases.every((entry) => entry.median.projectionInvalidationDelta === 0),
        zeroSchedulerWakes: cases.every((entry) => entry.median.schedulerWakeDelta === 0),
        allOk: cases.every((entry) => entry.median.ok),
      },
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Thin Harness repository facade benchmark [${label}]`);
      console.log(`feature=${head}`);
      console.log(`baseline-reference=${BASELINE_REV} (feature-only evidence; no synthetic A/B)\n`);
      console.log('Latency phases (median ms; bytes are serialized in-process result/envelope):');
      console.log(
        'case'.padEnd(26),
        'wall'.padStart(8),
        'report'.padStart(8),
        'outer'.padStart(8),
        'phase'.padStart(8),
        'route'.padStart(8),
        'policy'.padStart(8),
        'snap'.padStart(8),
        'exec'.padStart(8),
        'rcpt'.padStart(8),
        'bytes'.padStart(8),
        'lag'.padStart(8),
        'ok'.padStart(4),
      );
      for (const entry of cases) {
        const m = entry.median;
        console.log(
          entry.name.padEnd(26),
          m.wallClockMs.toFixed(1).padStart(8),
          m.totalMs.toFixed(1).padStart(8),
          m.unattributedMs.toFixed(1).padStart(8),
          m.phaseUnattributedMs.toFixed(1).padStart(8),
          m.routingMs.toFixed(1).padStart(8),
          m.policyMs.toFixed(1).padStart(8),
          m.snapshotMs.toFixed(1).padStart(8),
          m.executionMs.toFixed(1).padStart(8),
          m.receiptMs.toFixed(1).padStart(8),
          String(m.responseBytes).padStart(8),
          m.eventLoopLagMs.toFixed(1).padStart(8),
          String(m.ok).padStart(4),
        );
      }

      console.log('\nSide effects (median counts):');
      console.log(
        'case'.padEnd(26),
        'jobs'.padStart(5),
        'loc'.padStart(5),
        'wrk'.padStart(5),
        'evt'.padStart(5),
        'proj'.padStart(5),
        'sch'.padStart(5),
        'rcpt'.padStart(5),
        'lease'.padStart(6),
      );
      for (const entry of cases) {
        const m = entry.median;
        console.log(
          entry.name.padEnd(26),
          String(m.executionJobCount).padStart(5),
          String(m.localJobCount).padStart(5),
          String(m.workerSpawnCount).padStart(5),
          String(m.runtimeEventDelta).padStart(5),
          String(m.projectionInvalidationDelta).padStart(5),
          String(m.schedulerWakeDelta).padStart(5),
          String(m.receiptCount).padStart(5),
          String(m.leaseFilesTouched).padStart(6),
        );
      }
      console.log('\nAcceptance:', report.acceptance);
    }

    const failed = !report.acceptance.allOk
      || !report.acceptance.zeroExecutionJobs
      || !report.acceptance.zeroWorkers;
    process.exitCode = failed ? 1 : 0;
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
