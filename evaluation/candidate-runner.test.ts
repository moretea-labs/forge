import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { evaluationCandidateArtifactDigest } from './lib/candidate-artifact.ts';
import { planCandidateTrials, runPairedCandidateEvaluation, type EvaluationCandidateAdapter } from './lib/candidate-runner.ts';
import { freezeCandidateIdentity, freezeEnvironmentIdentity, freezeEvaluationCorpus, freezeEvaluationProtocol } from './lib/protocol.ts';
import { evaluationScenarioDigest, parseScenario } from './lib/scenario.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function digest(path: string): string {
  return evaluationCandidateArtifactDigest(path);
}

function fixtureCandidate(root: string, id: string): EvaluationCandidateAdapter {
  const artifactPath = join(root, id);
  mkdirSync(artifactPath, { recursive: true });
  writeFileSync(join(artifactPath, 'dependency.cjs'), `module.exports = ${JSON.stringify(id)};\n`);
  const entryPath = join(artifactPath, 'entry.cjs');
  writeFileSync(entryPath, `
const fs = require('fs');
const path = require('path');
require('./dependency.cjs');
if (process.argv.includes('--warmup')) {
  fs.appendFileSync(path.join(process.env.FORGE_EVALUATION_RUNTIME_ROOT, 'warmup.log'), 'warm\\n');
  process.exit(0);
}
const isolation = {
  controllerHome: process.env.FORGE_CONTROLLER_HOME,
  stateHome: process.env.XDG_STATE_HOME,
  cacheHome: process.env.XDG_CACHE_HOME,
  configHome: process.env.XDG_CONFIG_HOME,
  tempRoot: process.env.TMPDIR,
  runtimeRoot: process.env.FORGE_EVALUATION_RUNTIME_ROOT,
  logRoot: process.env.FORGE_EVALUATION_LOG_ROOT,
  traceRoot: process.env.FORGE_EVALUATION_TRACE_ROOT,
  artifactRoot: process.env.FORGE_EVALUATION_ARTIFACT_ROOT,
};
fs.writeFileSync('execution-evidence.txt', process.env.FORGE_EVALUATION_CANDIDATE_ID);
fs.writeFileSync('execution-trace.json', JSON.stringify({
  contextRetrieval: [{ domain: 'fixture-domain', source: 'candidate', summary: 'fixture context' }],
  inspectedEvidence: [{ domain: 'fixture-domain', source: 'isolation', summary: JSON.stringify(isolation) }],
  toolInteractions: [{ name: 'public_cli', outcome: 'success' }],
  finalResult: 'candidate completed',
}));
fs.writeFileSync(path.join(process.env.FORGE_EVALUATION_ARTIFACT_ROOT, 'candidate.txt'), process.env.FORGE_EVALUATION_CANDIDATE_ID);
`);
  return {
    identity: freezeCandidateIdentity({
      candidateId: id,
      versionLabel: id,
      artifactDigest: digest(artifactPath),
      executionSurface: 'public_cli',
    }),
    artifactPath,
    artifactBinding: { kind: 'prefix_argument', index: 0, entryPath: 'entry.cjs' },
    command: { executable: process.execPath, prefixArguments: [entryPath] },
    warmup: { arguments: ['--warmup'] },
  };
}

function fixtureScenario(source: string, commit: string) {
  return parseScenario({
    schemaVersion: 'forge-evaluation-scenario/v1',
    id: 'paired-runner-fixture',
    title: 'Paired runner fixture',
    userIntent: 'Execute the same public CLI task under isolated candidate state.',
    snapshot: { source, commit },
    groundTruth: {
      intendedBehavior: ['Each candidate executes the same task.'],
      affectedDomains: ['fixture-domain'],
      behavioralInvariants: ['The source repository remains unchanged.'],
      regressionRisks: ['Candidate state leaks across trials.'],
    },
    execution: { interface: 'forge_cli', arguments: ['fixture'], traceFile: 'execution-trace.json' },
    validators: [{
      id: 'candidate-wrote-evidence',
      kind: 'change_precision',
      type: 'changed_paths',
      requiredGlobs: ['execution-evidence.txt'],
    }],
  });
}

function protocol(scenarioDigest = 'sha256:scenario', orderPolicy: 'balanced_alternating' | 'seeded_randomized' = 'balanced_alternating', randomSeed?: string) {
  return freezeEvaluationProtocol({
    evaluator: { schemaVersion: 'forge-evaluator-identity/v1', evaluatorVersion: 'paired-runner-test/v1', implementationDigest: 'sha256:evaluator' },
    corpus: freezeEvaluationCorpus({ 'paired-runner-fixture': scenarioDigest }),
    trialPolicy: {
      repetitions: 2,
      warmupTrials: 1,
      cacheModes: ['cold', 'warm'],
      orderPolicy,
      ...(randomSeed ? { randomSeed } : {}),
      timeoutMs: 30_000,
    },
    metrics: [{ id: 'correctness', tier: 'correctness_reliability', direction: 'higher_is_better', unit: 'ratio', gate: 'p0_p1_blocking' }],
    failureTaxonomy: ['candidate_failure'],
  });
}

describe('candidate-neutral paired evaluation runner', () => {
  test('isolates repository, Controller Home, state, cache, runtime, logs, traces and artifacts for every cold/warm trial', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paired-runner-test-'));
    try {
      const source = join(root, 'source');
      execFileSync('git', ['init', '--initial-branch=main', source]);
      writeFileSync(join(source, 'README.md'), 'fixture\n');
      git(source, ['add', 'README.md']);
      git(source, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const commit = git(source, ['rev-parse', 'HEAD']);
      const candidates = [fixtureCandidate(root, 'candidate-a'), fixtureCandidate(root, 'candidate-b')] as const;
      const environment = freezeEnvironmentIdentity({
        os: process.platform,
        arch: process.arch,
        hardware: 'fixture-machine',
        runtime: process.version,
        toolchain: { node: process.version },
      });
      const result = runPairedCandidateEvaluation({
        protocol: protocol(evaluationScenarioDigest(fixtureScenario(source, commit))),
        scenario: fixtureScenario(source, commit),
        candidates,
        environment,
      });

      expect(result.authority).toBe('cross_version_evaluation');
      expect(result.trials).toHaveLength(8);
      expect(result.environmentFingerprint).toBe(environment.fingerprint);
      expect(new Set(result.trials.map((trial) => trial.isolation.root)).size).toBe(8);
      for (const key of ['repository', 'controllerHome', 'stateHome', 'cacheHome', 'runtimeRoot', 'logRoot', 'traceRoot', 'tempRoot', 'artifactRoot'] as const) {
        expect(new Set(result.trials.map((trial) => trial.isolation[key])).size).toBe(8);
      }
      for (const trial of result.trials) {
        expect(trial.report.authority).toBe('candidate_internal_diagnostic');
        expect(trial.runIdentity.protocolDigest).toBe(result.protocolDigest);
        expect(trial.runIdentity.environment.fingerprint).toBe(environment.fingerprint);
        expect(trial.warmupCommands).toHaveLength(trial.cacheMode === 'warm' ? 1 : 0);
        const observed = JSON.parse(trial.report.trace.inspectedEvidence.find((entry) => entry.source === 'isolation')!.summary);
        expect(observed.controllerHome).toBe(trial.isolation.controllerHome);
        expect(observed.stateHome).toBe(trial.isolation.stateHome);
        expect(observed.cacheHome).toBe(trial.isolation.cacheHome);
        expect(observed.runtimeRoot).toBe(trial.isolation.runtimeRoot);
        expect(observed.logRoot).toBe(trial.isolation.logRoot);
        expect(observed.traceRoot).toBe(trial.isolation.traceRoot);
        expect(observed.artifactRoot).toBe(trial.isolation.artifactRoot);
      }
      expect(git(source, ['status', '--porcelain'])).toBe('');
      expect(result.trials.slice(0, 2).map((trial) => trial.candidateIndex)).toEqual([0, 1]);
      expect(result.trials.slice(2, 4).map((trial) => trial.candidateIndex)).toEqual([1, 0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses deterministic seeded candidate ordering without changing pair membership', () => {
    const first = planCandidateTrials(protocol('sha256:scenario', 'seeded_randomized', 'frozen-seed'), 'paired-runner-fixture');
    const second = planCandidateTrials(protocol('sha256:scenario', 'seeded_randomized', 'frozen-seed'), 'paired-runner-fixture');
    expect(first).toEqual(second);
    for (let index = 0; index < first.length; index += 2) {
      expect(new Set(first.slice(index, index + 2).map((trial) => trial.candidateIndex))).toEqual(new Set([0, 1]));
    }
  });

  test('fails closed when scenario content drifts behind a frozen corpus digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paired-runner-scenario-'));
    try {
      const source = join(root, 'source');
      execFileSync('git', ['init', '--initial-branch=main', source]);
      writeFileSync(join(source, 'README.md'), 'fixture\n');
      git(source, ['add', 'README.md']);
      git(source, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const commit = git(source, ['rev-parse', 'HEAD']);
      const scenario = fixtureScenario(source, commit);
      const frozen = protocol(evaluationScenarioDigest(scenario));
      const changed = structuredClone(scenario);
      changed.userIntent = 'Drifted task hidden behind the same scenario id.';
      const candidates = [fixtureCandidate(root, 'candidate-a'), fixtureCandidate(root, 'candidate-b')] as const;
      const environment = freezeEnvironmentIdentity({ os: process.platform, arch: process.arch, hardware: 'fixture', runtime: process.version, toolchain: { node: process.version } });
      expect(() => runPairedCandidateEvaluation({ protocol: frozen, scenario: changed, candidates, environment }))
        .toThrow('EVALUATION_SCENARIO_DIGEST_MISMATCH:paired-runner-fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when the hashed artifact is not the artifact executed by the public command', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paired-runner-command-binding-'));
    try {
      const source = join(root, 'source');
      execFileSync('git', ['init', '--initial-branch=main', source]);
      writeFileSync(join(source, 'README.md'), 'fixture\n');
      git(source, ['add', 'README.md']);
      git(source, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const commit = git(source, ['rev-parse', 'HEAD']);
      const first = fixtureCandidate(root, 'candidate-a');
      const second = fixtureCandidate(root, 'candidate-b');
      second.command = { executable: process.execPath, prefixArguments: [join(first.artifactPath, 'entry.cjs'), join(second.artifactPath, 'entry.cjs')] };
      second.artifactBinding = { kind: 'prefix_argument', index: 0, entryPath: 'entry.cjs' };
      const scenario = fixtureScenario(source, commit);
      const environment = freezeEnvironmentIdentity({ os: process.platform, arch: process.arch, hardware: 'fixture', runtime: process.version, toolchain: { node: process.version } });
      expect(() => runPairedCandidateEvaluation({ protocol: protocol(evaluationScenarioDigest(scenario)), scenario, candidates: [first, second], environment }))
        .toThrow('EVALUATION_CANDIDATE_ARTIFACT_NOT_BOUND_TO_COMMAND:candidate-b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('binds the whole candidate package, not only its public CLI entry file', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paired-runner-package-digest-'));
    try {
      const candidate = fixtureCandidate(root, 'candidate-package');
      const original = candidate.identity.artifactDigest;
      writeFileSync(join(candidate.artifactPath, 'dependency.cjs'), "module.exports = 'changed-transitive-code';\n");
      expect(digest(candidate.artifactPath)).not.toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when declared candidate artifact identity does not match the executable artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paired-runner-artifact-'));
    try {
      const source = join(root, 'source');
      execFileSync('git', ['init', '--initial-branch=main', source]);
      writeFileSync(join(source, 'README.md'), 'fixture\n');
      git(source, ['add', 'README.md']);
      git(source, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const commit = git(source, ['rev-parse', 'HEAD']);
      const good = fixtureCandidate(root, 'candidate-good');
      const bad = fixtureCandidate(root, 'candidate-bad');
      bad.identity = freezeCandidateIdentity({
        candidateId: 'candidate-bad', versionLabel: 'candidate-bad', artifactDigest: 'sha256:not-the-artifact', executionSurface: 'public_cli',
      });
      const environment = freezeEnvironmentIdentity({ os: process.platform, arch: process.arch, hardware: 'fixture', runtime: process.version, toolchain: { node: process.version } });
      expect(() => runPairedCandidateEvaluation({
        protocol: protocol(evaluationScenarioDigest(fixtureScenario(source, commit))), scenario: fixtureScenario(source, commit), candidates: [good, bad], environment,
      })).toThrow('EVALUATION_CANDIDATE_ARTIFACT_DIGEST_MISMATCH:candidate-bad');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('fails closed when a declared warmup command mutates the trial repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paired-runner-warmup-mutation-'));
    try {
      const source = join(root, 'source');
      execFileSync('git', ['init', '--initial-branch=main', source]);
      writeFileSync(join(source, 'README.md'), 'fixture\n');
      git(source, ['add', 'README.md']);
      git(source, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const commit = git(source, ['rev-parse', 'HEAD']);
      const first = fixtureCandidate(root, 'candidate-a');
      const second = fixtureCandidate(root, 'candidate-b');
      const mutatingWarmup = join(root, 'mutating-warmup');
      mkdirSync(mutatingWarmup, { recursive: true });
      writeFileSync(join(mutatingWarmup, 'entry.cjs'), "require('fs').writeFileSync('warmup-mutation.txt','bad');\n");
      first.command = { executable: process.execPath, prefixArguments: [join(mutatingWarmup, 'entry.cjs')] };
      first.artifactPath = mutatingWarmup;
      first.artifactBinding = { kind: 'prefix_argument', index: 0, entryPath: 'entry.cjs' };
      first.identity = freezeCandidateIdentity({ candidateId: 'candidate-a', versionLabel: 'candidate-a', artifactDigest: digest(mutatingWarmup), executionSurface: 'public_cli' });
      first.warmup = { arguments: ['--warmup'] };
      const scenario = fixtureScenario(source, commit);
      const environment = freezeEnvironmentIdentity({ os: process.platform, arch: process.arch, hardware: 'fixture', runtime: process.version, toolchain: { node: process.version } });
      expect(() => runPairedCandidateEvaluation({ protocol: protocol(evaluationScenarioDigest(scenario)), scenario, candidates: [first, second], environment }))
        .toThrow('EVALUATION_WARMUP_MUTATED_REPOSITORY:candidate-a:warmup-mutation.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
