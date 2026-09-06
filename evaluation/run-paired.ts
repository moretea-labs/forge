#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { assertFormalEnvironmentIdentity, assertFrozenCrossVersionAuthority, buildFormalCrossVersionProtocol, v172BaselineIdentity } from './lib/calibration.ts';
import { runPairedCandidateEvaluation, type EvaluationCandidateAdapter, type PairedCandidateRun } from './lib/candidate-runner.ts';
import { loadGoldenCorpus } from './lib/corpus.ts';
import { buildCrossVersionPairedStatistics } from './lib/metrics.ts';
import { freezeCandidateIdentity, freezeEnvironmentIdentity, freezeEvaluationProtocol } from './lib/protocol.ts';
import { assertOutsideSource } from './lib/sandbox.ts';

// Explicit external output is the experiment's evidence bundle, never Runtime authority.
// An existing output is never overwritten or resumed with potentially mixed identities.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Usage: bun evaluation/run-paired.ts <experiment.json> <new-external-output-directory>');
  const config = JSON.parse(readFileSync(resolve(args[0]!), 'utf8')) as {
    mode: 'aa' | 'ab';
    candidates: [EvaluationCandidateAdapter, EvaluationCandidateAdapter];
  };
  if (!['aa', 'ab'].includes(config.mode) || !Array.isArray(config.candidates) || config.candidates.length !== 2) throw new Error('EVALUATION_EXPERIMENT_CONFIG_INVALID');
  const baseline = v172BaselineIdentity();
  for (const [index, adapter] of config.candidates.entries()) {
    adapter.identity = freezeCandidateIdentity(adapter.identity);
    if (index === 0 || config.mode === 'aa') {
      if (adapter.identity.artifactDigest !== baseline.artifactDigest || adapter.identity.sourceRevision !== baseline.sourceRevision
        || adapter.identity.executionSurface !== baseline.executionSurface) throw new Error('EVALUATION_BASELINE_IDENTITY_MISMATCH');
    }
  }
  const formal = config.mode === 'ab' ? assertFrozenCrossVersionAuthority() : buildFormalCrossVersionProtocol();
  const protocol = config.mode === 'ab' ? formal : freezeEvaluationProtocol({
    ...formal,
    // A/A measures arm symmetry and latency noise, not unobserved engineering dimensions.
    metrics: formal.metrics.filter((metric) => ['task_correctness', 'latency_ms'].includes(metric.id)),
    trialPolicy: { ...formal.trialPolicy, repetitions: 1, warmupTrials: 0, cacheModes: ['cold'] },
  });
  const version = (command: string) => execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
  const environment = freezeEnvironmentIdentity({
    os: process.platform, arch: process.arch, hardware: `${cpus()[0]?.model ?? 'unknown'};logical-cpus=${cpus().length}`,
    runtime: process.version,
    toolchain: { node: version('node'), bun: version('bun'), git: version('git'), mcpSdk: JSON.parse(readFileSync('node_modules/@modelcontextprotocol/sdk/package.json', 'utf8')).version },
  });
  assertFormalEnvironmentIdentity(environment);
  const output = resolve(args[1]!);
  assertOutsideSource(process.cwd(), output);
  mkdirSync(output); // Fail if evidence already exists.
  const write = (name: string, value: unknown) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  write('experiment.json', { mode: config.mode, protocol, environment, candidates: config.candidates });
  const runs: PairedCandidateRun[] = [];
  for (const scenario of loadGoldenCorpus().shared) {
    const run = await runPairedCandidateEvaluation({ protocol, scenario, candidates: config.candidates, environment });
    write(`${scenario.id}.json`, run);
    runs.push(run);
    console.log(JSON.stringify({ scenario: scenario.id, trials: run.trials.length, failures: run.trials.filter((trial) => trial.report.trace.finalResult.status !== 'passed').length }));
  }
  const statistics = buildCrossVersionPairedStatistics({ protocol, runs });
  write('statistics.json', statistics);
  console.log(JSON.stringify({ output, mode: config.mode, pairs: statistics.pairCount, verdict: statistics.verdict }));
  if (statistics.verdict.status !== 'eligible_for_superiority_assessment'
    || statistics.tiers.correctness_reliability.metrics.some((metric) => metric.candidate.failureProportion > 0 || metric.baseline.failureProportion > 0)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
