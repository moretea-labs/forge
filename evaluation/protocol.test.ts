import { describe, expect, test } from 'bun:test';
import { buildReport } from './lib/report.ts';
import { SCENARIO_SCHEMA, TRACE_SCHEMA, type EvaluationScenario, type EvaluationTrace } from './lib/types.ts';
import {
  CANDIDATE_INTERNAL_DIAGNOSTIC_AUTHORITY,
  CROSS_VERSION_EVALUATION_AUTHORITY,
  assertCrossVersionVerdictAuthority,
  evaluationRunIdentity,
  freezeCandidateIdentity,
  freezeEnvironmentIdentity,
  freezeEvaluationCorpus,
  freezeEvaluationProtocol,
  freezeEvaluatorIdentity,
} from './lib/protocol.ts';

function protocol(corpus: ReturnType<typeof freezeEvaluationCorpus>) {
  return freezeEvaluationProtocol({
    evaluator: freezeEvaluatorIdentity({ evaluatorVersion: 'forge-cross-version/v1', implementationDigest: 'sha256:evaluator' }),
    corpus,
    trialPolicy: {
      repetitions: 30,
      warmupTrials: 3,
      cacheModes: ['warm', 'cold'],
      orderPolicy: 'seeded_randomized',
      randomSeed: 'frozen-seed-v1',
      timeoutMs: 120_000,
    },
    metrics: [
      { id: 'latency_ms', tier: 'performance', direction: 'lower_is_better', unit: 'ms', gate: 'non_blocking' },
      { id: 'task_correctness', tier: 'correctness_reliability', direction: 'higher_is_better', unit: 'ratio', gate: 'p0_p1_blocking' },
    ],
    failureTaxonomy: ['timeout', 'behavior_regression', 'authority_violation'],
  });
}

describe('cross-version evaluation protocol', () => {
  test('freezes evaluator, corpus, trial policy and metrics into one deterministic digest', () => {
    const left = protocol(freezeEvaluationCorpus({ scenario_b: 'sha256:b', scenario_a: 'sha256:a' }));
    const right = protocol(freezeEvaluationCorpus({ scenario_a: 'sha256:a', scenario_b: 'sha256:b' }));
    expect(left.authority).toBe(CROSS_VERSION_EVALUATION_AUTHORITY);
    expect(left.corpus.scenarioIds).toEqual(['scenario_a', 'scenario_b']);
    expect(left.metrics.map((metric) => metric.id)).toEqual(['latency_ms', 'task_correctness']);
    expect(left.protocolDigest).toBe(right.protocolDigest);
  });

  test('changes the protocol digest when corpus content changes under the same scenario id', () => {
    const first = protocol(freezeEvaluationCorpus({ shared_scenario: 'sha256:one' }));
    const changed = protocol(freezeEvaluationCorpus({ shared_scenario: 'sha256:two' }));
    expect(first.protocolDigest).not.toBe(changed.protocolDigest);
  });

  test('deep-freezes digest-bearing protocol inputs so content cannot drift behind a stable digest', () => {
    const frozen = protocol(freezeEvaluationCorpus({ shared_scenario: 'sha256:one' }));
    expect(() => {
      (frozen.corpus.scenarioDigests as Record<string, string>).shared_scenario = 'sha256:mutated';
    }).toThrow();
    expect(() => {
      (frozen.failureTaxonomy as string[]).push('late_failure_class');
    }).toThrow();
    expect(frozen.corpus.scenarioDigests.shared_scenario).toBe('sha256:one');
  });

  test('binds candidate artifact and environment identities without making them protocol inputs', () => {
    const frozen = protocol(freezeEvaluationCorpus({ shared_scenario: 'sha256:one' }));
    const candidate = freezeCandidateIdentity({
      candidateId: 'forge-v1.7.2',
      versionLabel: 'v1.7.2',
      artifactDigest: 'git:c873cfeb11a223ced342e7101c016261b4a93b38',
      sourceRevision: 'c873cfeb11a223ced342e7101c016261b4a93b38',
      executionSurface: 'public_cli',
    });
    const environment = freezeEnvironmentIdentity({
      os: 'darwin',
      arch: 'arm64',
      hardware: 'fixture-machine',
      runtime: 'bun-1.x',
      toolchain: { git: '2.x', bun: '1.x' },
    });
    const run = evaluationRunIdentity({ protocol: frozen, candidate, environment });
    expect(run.protocolDigest).toBe(frozen.protocolDigest);
    expect(run.candidate.artifactDigest).toContain('c873cfeb');
    expect(run.environment.fingerprint).toMatch(/^sha256:/);
  });

  test('rejects unknown protocol enum values instead of silently normalizing external data', () => {
    expect(() => freezeCandidateIdentity({
      candidateId: 'bad-candidate',
      versionLabel: 'bad',
      artifactDigest: 'sha256:bad',
      executionSurface: 'private_runtime' as never,
    })).toThrow('EVALUATION_PROTOCOL_EXECUTION_SURFACE_INVALID');
    expect(() => freezeEvaluationProtocol({
      evaluator: freezeEvaluatorIdentity({ evaluatorVersion: 'v1', implementationDigest: 'sha256:evaluator' }),
      corpus: freezeEvaluationCorpus({ scenario: 'sha256:scenario' }),
      trialPolicy: {
        repetitions: 1,
        warmupTrials: 0,
        cacheModes: ['cold'],
        orderPolicy: 'unknown_order' as never,
        timeoutMs: 1_000,
      },
      metrics: [{ id: 'quality', tier: 'unknown_tier' as never, direction: 'higher_is_better', unit: 'ratio', gate: 'non_blocking' }],
      failureTaxonomy: ['failure'],
    })).toThrow();
  });

  test('keeps the legacy single-scenario report path diagnostic-only until a frozen run identity is bound', () => {
    const scenario: EvaluationScenario = {
      schemaVersion: SCENARIO_SCHEMA,
      id: 'diagnostic-only',
      title: 'Diagnostic only',
      userIntent: 'Exercise the legacy per-scenario report path.',
      snapshot: { source: '.', commit: 'fixture-commit' },
      groundTruth: { intendedBehavior: [], affectedDomains: [], behavioralInvariants: [], regressionRisks: [] },
      execution: { interface: 'forge_cli', arguments: ['status'] },
      validators: [],
    };
    const sourceState = { clean: true, statusDigest: 'sha256:clean' };
    const trace: EvaluationTrace = {
      schemaVersion: TRACE_SCHEMA,
      scenarioId: scenario.id,
      taskInput: scenario.userIntent,
      snapshot: { commit: scenario.snapshot.commit, sourceStateBefore: sourceState, sourceStateAfter: sourceState },
      sandbox: { strategy: 'git-clone-no-local', retained: false },
      contextRetrieval: [],
      inspectedEvidence: [],
      changedFiles: [],
      commands: [],
      checks: [],
      toolInteractions: [],
      finalResult: { status: 'passed', summary: 'fixture' },
      validation: [],
    };
    const report = buildReport(scenario, trace);
    expect(report.authority).toBe(CANDIDATE_INTERNAL_DIAGNOSTIC_AUTHORITY);
    expect(() => assertCrossVersionVerdictAuthority(report.authority)).toThrow(
      'EVALUATION_CANDIDATE_INTERNAL_DIAGNOSTIC_CANNOT_PRODUCE_VERSION_VERDICT',
    );
  });

  test('requires at least one correctness/reliability P0/P1 blocking metric in a frozen cross-version protocol', () => {
    const corpus = freezeEvaluationCorpus({ scenario: 'sha256:scenario' });
    expect(() => freezeEvaluationProtocol({
      evaluator: freezeEvaluatorIdentity({ evaluatorVersion: 'missing-tier1/v1', implementationDigest: 'sha256:evaluator' }),
      corpus,
      trialPolicy: { repetitions: 1, warmupTrials: 0, cacheModes: ['cold'], orderPolicy: 'balanced_alternating', timeoutMs: 1_000 },
      metrics: [{ id: 'latency_ms', tier: 'performance', direction: 'lower_is_better', unit: 'ms', gate: 'non_blocking' }],
      failureTaxonomy: ['candidate_failure'],
    })).toThrow('EVALUATION_PROTOCOL_TIER1_BLOCKING_METRIC_REQUIRED');
  });

  test('forbids candidate-internal diagnostics from issuing a cross-version verdict', () => {
    expect(() => assertCrossVersionVerdictAuthority(CANDIDATE_INTERNAL_DIAGNOSTIC_AUTHORITY)).toThrow(
      'EVALUATION_CANDIDATE_INTERNAL_DIAGNOSTIC_CANNOT_PRODUCE_VERSION_VERDICT',
    );
    expect(() => assertCrossVersionVerdictAuthority(CROSS_VERSION_EVALUATION_AUTHORITY)).not.toThrow();
  });
});
