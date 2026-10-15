#!/usr/bin/env bun

import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { buildControllerContextPackAsync } from '../src/cli/controller/context-pack';
import { getMcpPolicy } from '../adapters/mcp/policy';
import { clearAllSessionCachesForTest } from '../src/cli/repository/session-cache';
import { startLightweightRepositoryCommand } from '../src/runtime/execution/process-runtime/lightweight-managed';
import { registerRepository } from '../src/cli/repositories/registry';
import { getProcessRecord } from '../src/runtime/execution/process-runtime/store';
import { readProcessHandleIndexEntry } from '../src/runtime/execution/process-runtime/handle-index';

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) throw new Error('BENCHMARK_MISSING_SAMPLES');
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0) * 100) / 100;
}
function optionalPercentile(values: number[], ratio: number): number | null {
  return values.length === 0 ? null : percentile(values, ratio);
}
async function rawGitStatus(root: string): Promise<number> {
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['status', '--short'], { cwd: root, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`RAW_GIT_STATUS_FAILED: exit=${code}`)));
  });
  return performance.now() - started;
}

const iterationsIndex = process.argv.indexOf('--iterations');
const iterations = Math.max(2, Number(iterationsIndex >= 0 ? process.argv[iterationsIndex + 1] : 7) || 7);
const structuralIndex = process.argv.indexOf('--structural');
const structuralContext = process.argv[structuralIndex + 1] === 'off' ? 'off' as const : 'auto' as const;
const sandboxRoot = mkdtempSync(join(tmpdir(), 'forge-quality-harness-benchmark-'));
const root = join(sandboxRoot, 'repo');
const controllerHome = join(sandboxRoot, 'controller');
try {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'benchmark@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Forge Benchmark'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 120; index += 1) {
    writeFileSync(join(root, 'src', `module-${index}.ts`), `export function symbol${index}(value: number) {\n  return value + ${index};\n}\n`);
  }
  writeFileSync(join(root, 'src', 'target.ts'), 'export function benchmarkTarget(value: number) {\n  const next = value + 1;\n  return next;\n}\n');
  writeFileSync(join(root, 'src', 'consumer.ts'), "import { benchmarkTarget } from './target';\nexport function consumeBenchmarkTarget(value: number) {\n  return benchmarkTarget(value) * 2;\n}\n");
  execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const repository = registerRepository({ path: root, controllerHome, displayName: 'quality-harness-benchmark' });

  const contextCold: number[] = [];
  const contextHot: number[] = [];
  const structuralProcess: number[] = [];
  const structuralOpen: number[] = [];
  const structuralQuery: number[] = [];
  let hotCacheEvidence: unknown;
  let contextAccuracyEvidence: { selected: string[]; required: string[]; recall: number; precision: number } | undefined;
  const requiredContextPaths = ['src/target.ts', 'src/consumer.ts'];
  for (let index = 0; index < iterations; index += 1) {
    clearAllSessionCachesForTest();
    const session = { sessionId: `benchmark-${index}`, repoId: repository.repoId, checkoutId: repository.activeCheckoutId };
    let started = performance.now();
    const cold = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), { description: 'benchmarkTarget implementation and impact', searchTerms: ['benchmarkTarget'], knownPaths: ['src/target.ts'], structuralContext, session });
    contextCold.push(performance.now() - started);
    const structuralTimings = cold.structuralContext?.timingsMs;
    if (typeof structuralTimings?.process === 'number') structuralProcess.push(structuralTimings.process);
    if (typeof structuralTimings?.open === 'number') structuralOpen.push(structuralTimings.open);
    if (typeof structuralTimings?.query === 'number') structuralQuery.push(structuralTimings.query);
    started = performance.now();
    const hot = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), { description: 'benchmarkTarget implementation and impact', searchTerms: ['benchmarkTarget'], knownPaths: ['src/target.ts'], structuralContext, session });
    contextHot.push(performance.now() - started);
    hotCacheEvidence = hot.cache;
    const selected = [...new Set(hot.files.map((file) => file.path))].sort();
    const requiredHits = requiredContextPaths.filter((path) => selected.includes(path)).length;
    contextAccuracyEvidence = {
      selected,
      required: requiredContextPaths,
      recall: requiredHits / requiredContextPaths.length,
      precision: selected.length === 0 ? 0 : requiredHits / selected.length,
    };
  }

  const rawChild: number[] = [];
  const harnessTotal: number[] = [];
  const preSpawnHarness: number[] = [];
  const reportedDurableWrites: number[] = [];
  const reportedLeaseOperations: number[] = [];
  let durableProcessRecordsObserved = 0;
  let persistedHandleIndexEntriesObserved = 0;
  for (let index = 0; index < iterations; index += 1) {
    rawChild.push(await rawGitStatus(root));
    const started = performance.now();
    const run = await startLightweightRepositoryCommand({
      controllerHome, repository, interactiveWaitMs: 5_000, timeoutMs: 30_000,
      execution: {
        command: ['git', 'status', '--short'],
        authorizationDecision: { decision: 'allow', source: 'full_access', reason: 'benchmark fixture' },
      },
    });
    if (!run.handle.completed || run.handle.ok !== true) {
      throw new Error(`LIGHTWEIGHT_COMMAND_NOT_SUCCESSFUL: ${run.handle.processId} status=${run.handle.status}`);
    }
    if (run.metrics.lane !== 'lightweight_managed') throw new Error(`BENCHMARK_UNEXPECTED_LANE: ${run.metrics.lane}`);
    harnessTotal.push(performance.now() - started);
    if (run.metrics.preSpawnHarnessMs !== undefined) preSpawnHarness.push(run.metrics.preSpawnHarnessMs);
    reportedDurableWrites.push(run.metrics.durableWrites);
    reportedLeaseOperations.push(run.metrics.leaseOperations);
    if (getProcessRecord(controllerHome, repository.repoId, run.handle.processId) !== undefined) durableProcessRecordsObserved += 1;
    const indexEntry = readProcessHandleIndexEntry(controllerHome, run.handle.processId);
    if (indexEntry?.lane === 'lightweight' && indexEntry.target.scope === 'repository'
      && indexEntry.target.repositoryId === repository.repoId) persistedHandleIndexEntriesObserved += 1;
  }

  const steadyContextCold = contextCold.slice(1);
  const output = {
    schemaVersion: 1,
    iterations,
    context: {
      structuralContext,
      coldP50Ms: percentile(contextCold, 0.5), coldP95Ms: percentile(contextCold, 0.95),
      startupColdMs: Math.round((contextCold[0] ?? 0) * 100) / 100,
      steadyColdP50Ms: percentile(steadyContextCold, 0.5),
      steadyColdP95Ms: percentile(steadyContextCold, 0.95),
      coldSamplesMs: contextCold.map((value) => Math.round(value * 100) / 100),
      structuralProcessP50Ms: optionalPercentile(structuralProcess, 0.5),
      structuralProcessP95Ms: optionalPercentile(structuralProcess, 0.95),
      structuralOpenP50Ms: optionalPercentile(structuralOpen, 0.5),
      structuralQueryP50Ms: optionalPercentile(structuralQuery, 0.5),
      hotP50Ms: percentile(contextHot, 0.5), hotP95Ms: percentile(contextHot, 0.95),
      hotToColdRatio: Math.round((percentile(contextHot, 0.5) / Math.max(0.01, percentile(contextCold, 0.5))) * 1_000) / 1_000,
      cacheEvidence: hotCacheEvidence,
      accuracy: contextAccuracyEvidence,
    },
    command: {
      rawChildP50Ms: percentile(rawChild, 0.5), lightweightTotalP50Ms: percentile(harnessTotal, 0.5),
      preSpawnHarnessP50Ms: optionalPercentile(preSpawnHarness, 0.5),
      preSpawnHarnessP95Ms: optionalPercentile(preSpawnHarness, 0.95),
      preSpawnSampleCount: preSpawnHarness.length,
      durableProcessWrites: reportedDurableWrites.reduce((total, value) => total + value, 0),
      leaseOperations: reportedLeaseOperations.reduce((total, value) => total + value, 0),
      durableProcessRecordsObserved,
      persistedHandleIndexEntriesObserved,
    },
    thresholds: {
      hotContextToColdP50MaxRatio: 0.9,
      contextRecallMin: 1,
      contextPrecisionMin: 1,
      lightweightPreSpawnHarnessP95MaxMs: 750,
      durableProcessWritesMax: 0,
      leaseOperationsMax: 0,
    },
  };
  const assertions = {
    hotContextReuse: output.context.hotToColdRatio <= output.thresholds.hotContextToColdP50MaxRatio,
    completeRequiredContext: (output.context.accuracy?.recall ?? 0) >= output.thresholds.contextRecallMin,
    boundedContextNoise: (output.context.accuracy?.precision ?? 0) >= output.thresholds.contextPrecisionMin,
    completePreSpawnSamples: output.command.preSpawnSampleCount === iterations,
    boundedPreSpawnHarness: output.command.preSpawnHarnessP95Ms !== null
      && output.command.preSpawnHarnessP95Ms <= output.thresholds.lightweightPreSpawnHarnessP95MaxMs,
    zeroReportedDurableWrites: reportedDurableWrites.length === iterations
      && output.command.durableProcessWrites <= output.thresholds.durableProcessWritesMax,
    zeroReportedLeaseOperations: reportedLeaseOperations.length === iterations
      && output.command.leaseOperations <= output.thresholds.leaseOperationsMax,
    zeroObservedDurableProcessRecords: output.command.durableProcessRecordsObserved === 0,
    completePersistedHandleIndex: output.command.persistedHandleIndexEntriesObserved === iterations,
  };
  process.stdout.write(`${JSON.stringify({ ...output, assertions, passed: Object.values(assertions).every(Boolean) }, null, 2)}\n`);
  if (!Object.values(assertions).every(Boolean)) process.exitCode = 1;
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
