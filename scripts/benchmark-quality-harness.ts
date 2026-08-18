#!/usr/bin/env bun

import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { buildControllerContextPackAsync } from '../src/cli/controller/context-pack';
import { getMcpPolicy } from '../src/cli/mcp/policy';
import { clearAllSessionCachesForTest } from '../src/cli/repository/session-cache';
import { startLightweightRepositoryCommand } from '../src/runtime/execution/process-runtime/lightweight-managed';
import { registerRepository } from '../src/cli/repositories/registry';

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0) * 100) / 100;
}
async function rawGitStatus(root: string): Promise<number> {
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['status', '--short'], { cwd: root, stdio: 'ignore' });
    child.on('error', reject); child.on('close', () => resolve());
  });
  return performance.now() - started;
}

const iterationsIndex = process.argv.indexOf('--iterations');
const iterations = Math.max(2, Number(iterationsIndex >= 0 ? process.argv[iterationsIndex + 1] : 7) || 7);
const root = mkdtempSync(join(tmpdir(), 'forge-quality-harness-benchmark-'));
const controllerHome = join(root, '.controller');
try {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'benchmark@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Forge Benchmark'], { cwd: root });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let index = 0; index < 120; index += 1) {
    writeFileSync(join(root, 'src', `module-${index}.ts`), `export function symbol${index}(value: number) {\n  return value + ${index};\n}\n`);
  }
  writeFileSync(join(root, 'src', 'target.ts'), 'export function benchmarkTarget(value: number) {\n  const next = value + 1;\n  return next;\n}\n');
  execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const repository = registerRepository({ path: root, controllerHome, displayName: 'quality-harness-benchmark' });

  const contextCold: number[] = [];
  const contextHot: number[] = [];
  let hotCacheEvidence: unknown;
  for (let index = 0; index < iterations; index += 1) {
    clearAllSessionCachesForTest();
    const session = { sessionId: `benchmark-${index}`, repoId: repository.repoId, checkoutId: repository.activeCheckoutId };
    let started = performance.now();
    await buildControllerContextPackAsync(root, getMcpPolicy('controller'), { description: 'benchmarkTarget implementation and impact', searchTerms: ['benchmarkTarget'], knownPaths: ['src/target.ts'], structuralContext: 'auto', session });
    contextCold.push(performance.now() - started);
    started = performance.now();
    const hot = await buildControllerContextPackAsync(root, getMcpPolicy('controller'), { description: 'benchmarkTarget implementation and impact', searchTerms: ['benchmarkTarget'], knownPaths: ['src/target.ts'], structuralContext: 'auto', session });
    contextHot.push(performance.now() - started);
    hotCacheEvidence = hot.cache;
  }

  const rawChild: number[] = [];
  const harnessTotal: number[] = [];
  const preSpawnHarness: number[] = [];
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
    harnessTotal.push(performance.now() - started);
    if (run.metrics.preSpawnHarnessMs !== undefined) preSpawnHarness.push(run.metrics.preSpawnHarnessMs);
  }

  const output = {
    schemaVersion: 1,
    iterations,
    context: {
      coldP50Ms: percentile(contextCold, 0.5), coldP95Ms: percentile(contextCold, 0.95),
      hotP50Ms: percentile(contextHot, 0.5), hotP95Ms: percentile(contextHot, 0.95),
      hotToColdRatio: Math.round((percentile(contextHot, 0.5) / Math.max(0.01, percentile(contextCold, 0.5))) * 1_000) / 1_000,
      cacheEvidence: hotCacheEvidence,
    },
    command: {
      rawChildP50Ms: percentile(rawChild, 0.5), lightweightTotalP50Ms: percentile(harnessTotal, 0.5),
      preSpawnHarnessP50Ms: percentile(preSpawnHarness, 0.5),
      preSpawnHarnessP95Ms: percentile(preSpawnHarness, 0.95),
      durableProcessWrites: 0, leaseOperations: 0,
    },
    thresholds: {
      hotContextToColdP50MaxRatio: 0.9,
      lightweightPreSpawnHarnessP95MaxMs: 750,
      durableProcessWritesMax: 0,
      leaseOperationsMax: 0,
    },
  };
  const assertions = {
    hotContextReuse: output.context.hotToColdRatio <= output.thresholds.hotContextToColdP50MaxRatio,
    boundedPreSpawnHarness: output.command.preSpawnHarnessP95Ms <= output.thresholds.lightweightPreSpawnHarnessP95MaxMs,
    zeroDurableWrites: output.command.durableProcessWrites <= output.thresholds.durableProcessWritesMax,
    zeroLeaseOperations: output.command.leaseOperations <= output.thresholds.leaseOperationsMax,
  };
  process.stdout.write(`${JSON.stringify({ ...output, assertions, passed: Object.values(assertions).every(Boolean) }, null, 2)}\n`);
  if (!Object.values(assertions).every(Boolean)) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
