/**
 * Process Runtime latency benchmark.
 * Separates child execution, Runner finalization and caller observation.
 * Uses an isolated temporary repository and Controller Home.
 *
 * Usage: bun scripts/benchmark-process-observation.ts [--samples 10] [--delay-ms 300]
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerRepository } from '../src/cli/repositories/registry';
import { ensureControllerHome } from '../src/effects/controller-home';
import { executionIdentityForRepository } from '../src/runtime/control-plane/execution/execution-identity';
import { getProcessRecord, spawnManagedProcess, waitForProcess } from '../src/runtime/execution/process-runtime';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(arg(name) ?? fallback);
  if (!Number.isInteger(value)) throw new Error(name + ' must be an integer');
  return Math.max(min, Math.min(max, value));
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function summarize(values: number[]) {
  return {
    p50Ms: roundMs(percentile(values, 0.5)),
    p90Ms: roundMs(percentile(values, 0.9)),
    minMs: roundMs(Math.min(...values)),
    maxMs: roundMs(Math.max(...values)),
  };
}

async function main(): Promise<void> {
  const samples = boundedInteger('--samples', 5, 1, 30);
  const delayMs = boundedInteger('--delay-ms', 300, 50, 5_000);
  const root = mkdtempSync(join(tmpdir(), 'forge-process-observation-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');

  try {
    mkdirSync(repoRoot, { recursive: true });
    ensureControllerHome(controllerHome);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.name=Forge Benchmark',
      '-c', 'user.email=forge-benchmark@example.test',
      '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-m', 'process observation benchmark fixture',
    ], { cwd: repoRoot, stdio: 'ignore' });
    const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'process-observation-benchmark' });
    const results: Array<{
      sample: number;
      submissionLatencyMs: number;
      childExecutionMs: number;
      runnerFinalizationLagMs: number;
      callerObservationLagMs: number;
      observerWaitMs: number;
      processLifecycleMs: number;
    }> = [];

    for (let sample = 0; sample < samples; sample += 1) {
      const startedPath = join(controllerHome, 'sample-' + sample + '.started');
      const finishedPath = join(controllerHome, 'sample-' + sample + '.finished');
      const scriptPath = join(controllerHome, 'sample-' + sample + '.cjs');
      const childSource = "const { writeFileSync } = require('node:fs');\n"
        + 'writeFileSync(' + JSON.stringify(startedPath) + ', String(Date.now()));\n'
        + 'setTimeout(() => {\n'
        + '  writeFileSync(' + JSON.stringify(finishedPath) + ', String(Date.now()));\n'
        + "  process.stdout.write('done\\n');\n"
        + '}, ' + delayMs + ');\n';
      writeFileSync(scriptPath, childSource);

      const submitStartedAt = performance.now();
      const handle = await spawnManagedProcess({
        controllerHome,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        executionIdentity: executionIdentityForRepository(repository),
        command: { kind: 'argv', executable: process.execPath, args: [scriptPath], cwd: repoRoot },
        interactiveWaitMs: 0,
        timeoutMs: 15_000,
        returnHandleImmediately: true,
        origin: {
          surface: 'command',
          toolName: 'benchmark_process_observation',
          requestId: 'process-observation-benchmark-' + sample,
        },
      });
      const acceptedAt = performance.now();
      const terminal = await waitForProcess(controllerHome, repository.repoId, handle.processId, { timeoutMs: 15_000 });
      const observedAt = performance.now();
      const observedWallAt = Date.now();
      if (!terminal.completed || terminal.status !== 'succeeded') {
        throw new Error('sample ' + sample + ' failed: ' + terminal.status + ' exit=' + terminal.exitCode);
      }

      const childStartedAt = Number(readFileSync(startedPath, 'utf8'));
      const childFinishedAt = Number(readFileSync(finishedPath, 'utf8'));
      const record = getProcessRecord(controllerHome, repository.repoId, handle.processId);
      if (!record?.finishedAt) throw new Error('sample ' + sample + ' has no durable Process finishedAt');
      const runnerFinishedAt = Date.parse(record.finishedAt);
      results.push({
        sample,
        submissionLatencyMs: roundMs(acceptedAt - submitStartedAt),
        childExecutionMs: childFinishedAt - childStartedAt,
        runnerFinalizationLagMs: runnerFinishedAt - childFinishedAt,
        callerObservationLagMs: observedWallAt - childFinishedAt,
        observerWaitMs: roundMs(observedAt - acceptedAt),
        processLifecycleMs: roundMs(runnerFinishedAt - Date.parse(record.startedAt)),
      });
    }

    console.log(JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
      mode: { samples, childDelayMs: delayMs, interactiveWaitMs: 0, returnHandleImmediately: true },
      metrics: {
        submissionLatency: summarize(results.map((row) => row.submissionLatencyMs)),
        childExecution: summarize(results.map((row) => row.childExecutionMs)),
        runnerFinalizationLag: summarize(results.map((row) => row.runnerFinalizationLagMs)),
        callerObservationLag: summarize(results.map((row) => row.callerObservationLagMs)),
        observerWait: summarize(results.map((row) => row.observerWaitMs)),
        processLifecycle: summarize(results.map((row) => row.processLifecycleMs)),
      },
      samples: results,
    }, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
