import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { evaluationCandidateArtifactDigest } from './lib/candidate-artifact.ts';
import { planCandidateTrials, runPairedCandidateEvaluation, type EvaluationCandidateAdapter } from './lib/candidate-runner.ts';
import { loadGoldenCorpus, REQUIRED_SHARED_BEHAVIOR_CLASSES } from './lib/corpus.ts';
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

function fixtureMcpCandidate(root: string, id: string): EvaluationCandidateAdapter {
  const artifactPath = join(root, id);
  mkdirSync(artifactPath, { recursive: true });
  const entryPath = join(artifactPath, 'entry.mjs');
  writeFileSync(entryPath, `
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.FORGE_CONTROLLER_HOME;
mkdirSync(home, { recursive: true });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const error = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
const tools = [
  { name: 'state_set', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
  { name: 'state_get', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo', inputSchema: { type: 'object', additionalProperties: true } },
  { name: 'file_write', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'parallel_probe', inputSchema: { type: 'object', properties: { id: { type: 'string' }, other: { type: 'string' } }, required: ['id', 'other'] } },
];
async function callTool(name, args) {
  if (name === 'state_set') {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ value: args.value }));
    return { value: args.value, pid: process.pid };
  }
  if (name === 'state_get') {
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    return { ...state, pid: process.pid };
  }
  if (name === 'echo') return { ...args, pid: process.pid };
  if (name === 'file_write') {
    writeFileSync(args.path, args.content);
    return { path: args.path, written: true, pid: process.pid };
  }
  if (name === 'parallel_probe') {
    const mine = join(home, 'barrier-' + args.id);
    const other = join(home, 'barrier-' + args.other);
    writeFileSync(mine, 'ready');
    const deadline = Date.now() + 1500;
    while (!existsSync(other) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!existsSync(other)) throw new Error('parallel barrier timed out');
    return { id: args.id, paired: true, pid: process.pid };
  }
  throw new Error('unknown tool: ' + name);
}
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'initialize') {
    result(message.id, { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(id)}, version: '1.0.0' } });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') { result(message.id, { tools }); return; }
  if (message.method === 'tools/call') {
    try {
      const payload = await callTool(message.params?.name, message.params?.arguments ?? {});
      result(message.id, { content: [{ type: 'text', text: JSON.stringify(payload) }] });
    } catch (caught) {
      result(message.id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: caught instanceof Error ? caught.message : String(caught) }) }] });
    }
    return;
  }
  if (message.id !== undefined) error(message.id, 'unsupported method: ' + message.method);
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  try { void handle(JSON.parse(line)); } catch (caught) { process.stderr.write(String(caught) + '\\n'); }
});
`);
  return {
    identity: freezeCandidateIdentity({
      candidateId: id,
      versionLabel: id,
      artifactDigest: digest(artifactPath),
      executionSurface: 'public_mcp',
    }),
    artifactPath,
    artifactBinding: { kind: 'prefix_argument', index: 0, entryPath: 'entry.mjs' },
    command: { executable: process.execPath, prefixArguments: [entryPath] },
  };
}

function mcpProtocol(scenarioDigest: string) {
  return freezeEvaluationProtocol({
    evaluator: { schemaVersion: 'forge-evaluator-identity/v1', evaluatorVersion: 'paired-mcp-runner-test/v1', implementationDigest: 'sha256:evaluator-mcp' },
    corpus: freezeEvaluationCorpus({ 'paired-mcp-runner-fixture': scenarioDigest }),
    trialPolicy: { repetitions: 1, warmupTrials: 0, cacheModes: ['cold'], orderPolicy: 'balanced_alternating', timeoutMs: 30_000 },
    metrics: [{ id: 'correctness', tier: 'correctness_reliability', direction: 'higher_is_better', unit: 'ratio', gate: 'p0_p1_blocking' }],
    failureTaxonomy: ['candidate_failure'],
  });
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
  test('loads the shared Golden Corpus only when provenance, behavior coverage, and independent oracles are complete', () => {
    const corpus = loadGoldenCorpus();
    expect(corpus.shared).toHaveLength(24);
    expect(corpus.v2Only).toHaveLength(0);
    const counts = new Map<string, number>();
    for (const scenario of corpus.shared) {
      const behaviorClass = scenario.corpus?.behaviorClass;
      expect(behaviorClass).toBeDefined();
      counts.set(behaviorClass!, (counts.get(behaviorClass!) ?? 0) + 1);
      expect(scenario.snapshot.commit).toBe('c873cfeb11a223ced342e7101c016261b4a93b38');
      expect(scenario.provenance?.sourceCommit).toBe(scenario.snapshot.commit);
    }
    expect(Object.fromEntries(REQUIRED_SHARED_BEHAVIOR_CLASSES.map((behaviorClass) => [behaviorClass, counts.get(behaviorClass) ?? 0]))).toEqual({
      discovery_context: 4,
      bounded_mutation: 4,
      work_lifecycle: 4,
      failure_classification: 4,
      restart_recovery: 4,
      multi_repo_concurrency: 4,
    });
  });

  test('isolates repository, Controller Home, state, cache, runtime, logs, traces and artifacts for every cold/warm trial', async () => {
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
      const result = await runPairedCandidateEvaluation({
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

  test('fails closed when scenario content drifts behind a frozen corpus digest', async () => {
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
      await expect(runPairedCandidateEvaluation({ protocol: frozen, scenario: changed, candidates, environment }))
        .rejects.toThrow('EVALUATION_SCENARIO_DIGEST_MISMATCH:paired-runner-fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when the hashed artifact is not the artifact executed by the public command', async () => {
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
      await expect(runPairedCandidateEvaluation({ protocol: protocol(evaluationScenarioDigest(scenario)), scenario, candidates: [first, second], environment }))
        .rejects.toThrow('EVALUATION_CANDIDATE_ARTIFACT_NOT_BOUND_TO_COMMAND:candidate-b');
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

  test('fails closed when declared candidate artifact identity does not match the executable artifact', async () => {
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
      await expect(runPairedCandidateEvaluation({
        protocol: protocol(evaluationScenarioDigest(fixtureScenario(source, commit))), scenario: fixtureScenario(source, commit), candidates: [good, bad], environment,
      })).rejects.toThrow('EVALUATION_CANDIDATE_ARTIFACT_DIGEST_MISMATCH:candidate-bad');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('runs paired public MCP candidates with durable restart state, evaluator-owned repo fixtures, and real parallel groups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-paired-mcp-runner-'));
    try {
      const source = join(root, 'source');
      execFileSync('git', ['init', '--initial-branch=main', source]);
      writeFileSync(join(source, 'README.md'), 'fixture\n');
      git(source, ['add', 'README.md']);
      git(source, ['-c', 'user.email=evaluation@example.test', '-c', 'user.name=Evaluation', 'commit', '-m', 'fixture']);
      const commit = git(source, ['rev-parse', 'HEAD']);
      const scenario = parseScenario({
        schemaVersion: 'forge-evaluation-scenario/v1',
        id: 'paired-mcp-runner-fixture',
        title: 'Paired MCP runner fixture',
        userIntent: 'Exercise restart persistence, a secondary repository fixture, and concurrent public MCP calls.',
        snapshot: { source, commit },
        groundTruth: {
          intendedBehavior: ['State persists across candidate restart and parallel calls execute concurrently.'],
          affectedDomains: ['evaluation'],
          behavioralInvariants: ['The source repository remains unchanged.'],
          regressionRisks: ['Restart loses controller state.', 'Parallel groups execute sequentially.', 'Fixture paths leak from the source repository.'],
        },
        fixtures: { repositories: [{ id: 'secondary' }] },
        execution: {
          interface: 'forge_mcp', profile: 'controller', toolset: 'advanced',
          calls: [
            { id: 'state-set', tool: 'state_set', arguments: { value: 'persisted' }, capture: { firstPid: 'pid' } },
            { id: 'state-get', tool: 'state_get', arguments: {}, restartBefore: true, capture: { secondPid: 'pid' } },
            { id: 'fixture-path', tool: 'echo', arguments: { path: '{{fixture.secondary.repository}}' } },
            { id: 'fixture-write', tool: 'file_write', arguments: { path: '{{fixture.secondary.repository}}/fixture-change.txt', content: 'changed' } },
            { id: 'parallel-a', tool: 'parallel_probe', arguments: { id: 'a', other: 'b' }, parallelGroup: 'barrier' },
            { id: 'parallel-b', tool: 'parallel_probe', arguments: { id: 'b', other: 'a' }, parallelGroup: 'barrier' },
          ],
        },
        validators: [
          { id: 'restart-state', kind: 'behavior', type: 'execution_output', stepId: 'state-get', expectedExitCode: 0, includes: ['persisted'] },
          { id: 'fixture-visible', kind: 'behavior', type: 'execution_output', stepId: 'fixture-path', expectedExitCode: 0, includes: ['fixtures', 'secondary'] },
          { id: 'fixture-change-observed', kind: 'change_precision', type: 'changed_paths', requiredGlobs: ['fixtures/secondary/fixture-change.txt'] },
          { id: 'parallel-a-paired', kind: 'behavior', type: 'execution_output', stepId: 'parallel-a', expectedExitCode: 0, includes: ['paired'] },
          { id: 'parallel-b-paired', kind: 'behavior', type: 'execution_output', stepId: 'parallel-b', expectedExitCode: 0, includes: ['paired'] },
        ],
      });
      const candidates = [fixtureMcpCandidate(root, 'mcp-candidate-a'), fixtureMcpCandidate(root, 'mcp-candidate-b')] as const;
      const environment = freezeEnvironmentIdentity({ os: process.platform, arch: process.arch, hardware: 'fixture', runtime: process.version, toolchain: { node: process.version } });
      const paired = await runPairedCandidateEvaluation({
        protocol: mcpProtocol(evaluationScenarioDigest(scenario)),
        scenario,
        candidates,
        environment,
      });

      expect(paired.trials).toHaveLength(2);
      for (const trial of paired.trials) {
        expect(trial.report.trace.finalResult.status).toBe('passed');
        const restart = trial.report.trace.commands.find((command) => command.command === 'mcp:restart');
        expect(restart?.exitCode).toBe(0);
        const stateSet = trial.report.trace.commands.find((command) => command.stepId === 'state-set')!;
        const stateGet = trial.report.trace.commands.find((command) => command.stepId === 'state-get')!;
        const first = JSON.parse(stateSet.stdout);
        const second = JSON.parse(stateGet.stdout);
        expect(second.value).toBe('persisted');
        expect(second.pid).not.toBe(first.pid);
        const fixture = trial.report.trace.commands.find((command) => command.stepId === 'fixture-path')!;
        expect(fixture.stdout).toContain('/fixtures/secondary');
        expect(trial.report.trace.commands.find((command) => command.stepId === 'parallel-a')?.exitCode).toBe(0);
        expect(trial.report.trace.commands.find((command) => command.stepId === 'parallel-b')?.exitCode).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects ambiguous restart or duplicate capture semantics inside a parallel group', () => {
    const base = {
      schemaVersion: 'forge-evaluation-scenario/v1',
      id: 'parallel-parser-guard',
      title: 'Parallel parser guard',
      userIntent: 'Reject ambiguous parallel execution semantics.',
      snapshot: { source: '.', commit: 'abcdef1' },
      groundTruth: {
        intendedBehavior: ['Reject ambiguous parallel execution.'],
        affectedDomains: ['evaluation'],
        behavioralInvariants: ['Parallel groups remain deterministic.'],
        regressionRisks: ['Hidden sequencing or capture overwrite.'],
      },
      validators: [{ id: 'oracle', kind: 'behavior', type: 'execution_output', stepId: 'a', expectedExitCode: 0 }],
    };
    expect(() => parseScenario({
      ...base,
      execution: { interface: 'forge_mcp', calls: [
        { id: 'a', tool: 'x', arguments: {}, parallelGroup: 'g', restartBefore: true },
        { id: 'b', tool: 'x', arguments: {}, parallelGroup: 'g' },
      ] },
    })).toThrow('restartBefore is not allowed inside a parallelGroup');
    expect(() => parseScenario({
      ...base,
      execution: { interface: 'forge_mcp', calls: [
        { id: 'a', tool: 'x', arguments: {}, parallelGroup: 'g', capture: { shared: 'value' } },
        { id: 'b', tool: 'x', arguments: {}, parallelGroup: 'g', capture: { shared: 'value' } },
      ] },
    })).toThrow('parallelGroup g capture keys must be unique: shared');
  });

  test('fails closed when a declared warmup command mutates the trial repository', async () => {
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
      await expect(runPairedCandidateEvaluation({ protocol: protocol(evaluationScenarioDigest(scenario)), scenario, candidates: [first, second], environment }))
        .rejects.toThrow('EVALUATION_WARMUP_MUTATED_REPOSITORY:candidate-a:warmup-mutation.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
