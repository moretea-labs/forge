import { describe, expect, test } from 'bun:test';
import {
  CROSS_VERSION_EVALUATOR_FILES,
  FORMAL_ENVIRONMENT_POLICY,
  V172_AA_CALIBRATION,
  V172_ARTIFACT_DIGEST,
  V172_PUBLISHED_TARBALL_SHA256,
  V172_SOURCE_REVISION,
  assertFormalEnvironmentIdentity,
  assertFrozenCrossVersionAuthority,
  assertProtocolMatchesFrozenAuthority,
  buildFormalCrossVersionProtocol,
  readFrozenCrossVersionAuthority,
  v172BaselineIdentity,
} from './lib/calibration.ts';
import { freezeEnvironmentIdentity, freezeEvaluationCorpus, freezeEvaluationProtocol, freezeEvaluatorIdentity } from './lib/protocol.ts';

describe('frozen cross-version evaluation authority', () => {
  test('pins v1.7.2 immutable source and published artifact identity', () => {
    const baseline = v172BaselineIdentity();
    expect(baseline.sourceRevision).toBe(V172_SOURCE_REVISION);
    expect(baseline.artifactDigest).toBe(V172_ARTIFACT_DIGEST);
    expect(baseline.executionSurface).toBe('public_mcp');
    expect(V172_PUBLISHED_TARBALL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('binds the durable A/A calibration evidence and records noise without turning it into a formal threshold', () => {
    expect(V172_AA_CALIBRATION).toMatchObject({
      scope: 'candidate_symmetry_and_harness_noise',
      formalTrialSample: false,
      scenarioCount: 24,
      trialCount: 48,
      sharedCorpusDigest: 'sha256:cd45a4ff9b3a5a7b84aed736f72fd7d920115225c2b35fcb74fd0e80337233ee',
      passedScenarioCount: 24,
      failedScenarioCount: 0,
      failureCount: 0,
    });
    expect(V172_AA_CALIBRATION.processId).toBeTruthy();
    expect(V172_AA_CALIBRATION.rawBundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(V172_AA_CALIBRATION.evaluatorImplementationDigest).toBe(readFrozenCrossVersionAuthority().evaluatorImplementationDigest);
    expect(V172_AA_CALIBRATION.latencyDeltaMs.positiveCount).toBeGreaterThan(0);
    expect(V172_AA_CALIBRATION.latencyDeltaMs.negativeCount).toBeGreaterThan(0);
    expect(V172_AA_CALIBRATION.latencyDeltaMs.confidence95.low).toBeLessThan(0);
    expect(V172_AA_CALIBRATION.latencyDeltaMs.confidence95.high).toBeGreaterThan(0);
  });

  test('freezes evaluator, shared corpus, metric thresholds and formal trial policy before V2 observation', () => {
    const frozen = readFrozenCrossVersionAuthority();
    const protocol = assertFrozenCrossVersionAuthority();
    expect(protocol.protocolDigest).toBe(frozen.protocolDigest);
    expect(protocol.evaluator.implementationDigest).toBe(frozen.evaluatorImplementationDigest);
    expect(protocol.corpus.digest).toBe(frozen.corpusDigest);
    expect(protocol.corpus.scenarioIds).toHaveLength(24);
    expect(protocol.trialPolicy).toEqual({
      repetitions: 3,
      warmupTrials: 1,
      cacheModes: ['cold', 'warm'],
      orderPolicy: 'seeded_randomized',
      randomSeed: 'forge-v172-v2-formal-ab-v1',
      timeoutMs: 60_000,
      confidenceLevel: 0.95,
    });
    expect(protocol.failureTaxonomy).toEqual(['candidate_failure', 'candidate_timeout']);
    expect(protocol.metrics.filter((metric) => metric.gate === 'p0_p1_blocking').map((metric) => metric.id)).toEqual([
      'behavioral_invariant_success',
      'regression_reintroduction_rate',
      'task_correctness',
    ]);
  });

  test('candidate-internal diagnostics do not invalidate the cross-version evaluator identity', () => {
    expect(CROSS_VERSION_EVALUATOR_FILES).not.toContain('evaluation/lib/operational-memory-activation.ts');
    expect(CROSS_VERSION_EVALUATOR_FILES).not.toContain('evaluation/lib/shadow-operational-prior.ts');
  });

  test('fails closed when evaluator or shared corpus identity drifts behind the frozen manifest', () => {
    const frozen = readFrozenCrossVersionAuthority();
    const protocol = buildFormalCrossVersionProtocol();
    const evaluatorDrift = freezeEvaluationProtocol({
      evaluator: freezeEvaluatorIdentity({ evaluatorVersion: protocol.evaluator.evaluatorVersion, implementationDigest: 'sha256:drift' }),
      corpus: protocol.corpus,
      trialPolicy: protocol.trialPolicy,
      metrics: protocol.metrics,
      failureTaxonomy: protocol.failureTaxonomy,
    });
    expect(() => assertProtocolMatchesFrozenAuthority(evaluatorDrift, frozen)).toThrow('EVALUATION_FREEZE_EVALUATOR_DRIFT');

    const [firstScenario] = protocol.corpus.scenarioIds;
    const corpusDrift = freezeEvaluationCorpus({ ...protocol.corpus.scenarioDigests, [firstScenario!]: 'sha256:drift' });
    const corpusProtocol = freezeEvaluationProtocol({
      evaluator: protocol.evaluator,
      corpus: corpusDrift,
      trialPolicy: protocol.trialPolicy,
      metrics: protocol.metrics,
      failureTaxonomy: protocol.failureTaxonomy,
    });
    expect(() => assertProtocolMatchesFrozenAuthority(corpusProtocol, frozen)).toThrow('EVALUATION_FREEZE_CORPUS_DRIFT');
  });

  test('formal environment policy requires auditable toolchain identity', () => {
    expect(FORMAL_ENVIRONMENT_POLICY.sameEnvironmentFingerprintAcrossCandidates).toBe(true);
    const complete = freezeEnvironmentIdentity({
      os: 'fixture-os', arch: 'fixture-arch', hardware: 'fixture-hardware', runtime: 'fixture-runtime',
      toolchain: { node: 'v1', bun: 'v1', git: 'v1', mcpSdk: 'v1' },
    });
    expect(() => assertFormalEnvironmentIdentity(complete)).not.toThrow();
    const missing = freezeEnvironmentIdentity({
      os: 'fixture-os', arch: 'fixture-arch', hardware: 'fixture-hardware', runtime: 'fixture-runtime', toolchain: { node: 'v1' },
    });
    expect(() => assertFormalEnvironmentIdentity(missing)).toThrow('EVALUATION_FREEZE_ENVIRONMENT_TOOLCHAIN_REQUIRED:bun');
  });
});
