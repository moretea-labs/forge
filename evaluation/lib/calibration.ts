import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGoldenCorpus } from './corpus.ts';
import {
  freezeCandidateIdentity,
  freezeEvaluationCorpus,
  freezeEvaluationProtocol,
  freezeEvaluatorIdentity,
  type EvaluationEnvironmentIdentity,
  type EvaluationMetricDefinition,
  type FrozenEvaluationProtocol,
} from './protocol.ts';
import { evaluationScenarioDigest } from './scenario.ts';

export const CROSS_VERSION_FREEZE_SCHEMA = 'forge-cross-version-freeze/v1' as const;
export const CROSS_VERSION_EVALUATOR_VERSION = 'forge-cross-version/v1' as const;
export const V172_SOURCE_REVISION = 'c873cfeb11a223ced342e7101c016261b4a93b38' as const;
export const V172_ARTIFACT_DIGEST = 'sha256:52ef73f9299d84895cd1a0692bf53023608dff6bc4ba29942a8f8d2bc3837db0' as const;
export const V172_PUBLISHED_TARBALL_SHA256 = '2073bf8a6ab377e63ebe109c197039647bcf0626fb357954156c9f83f429fb10' as const;

/** Candidate-neutral execution/verdict implementation only. Candidate-internal diagnostics are intentionally excluded. */
export const CROSS_VERSION_EVALUATOR_FILES = Object.freeze([
  'evaluation/run-paired.ts',
  'evaluation/lib/calibration.ts',
  'evaluation/lib/candidate-artifact.ts',
  'evaluation/lib/candidate-runner.ts',
  'evaluation/lib/corpus.ts',
  'evaluation/lib/execution-evidence.ts',
  'evaluation/lib/metrics.ts',
  'evaluation/lib/protocol.ts',
  'evaluation/lib/public-mcp-runner.ts',
  'evaluation/lib/report.ts',
  'evaluation/lib/runner.ts',
  'evaluation/lib/sandbox.ts',
  'evaluation/lib/scenario.ts',
  'evaluation/lib/trace.ts',
  'evaluation/lib/types.ts',
  'evaluation/lib/validators.ts',
] as const);

export const CROSS_VERSION_EVALUATOR_RUNTIME_PACKAGES = Object.freeze([
  '@modelcontextprotocol/sdk',
] as const);

export const FORMAL_CROSS_VERSION_METRICS: readonly EvaluationMetricDefinition[] = Object.freeze([
  { id: 'task_correctness', tier: 'correctness_reliability', direction: 'higher_is_better', unit: 'ratio', gate: 'p0_p1_blocking', regressionTolerance: 0 },
  { id: 'behavioral_invariant_success', tier: 'correctness_reliability', direction: 'higher_is_better', unit: 'ratio', gate: 'p0_p1_blocking', regressionTolerance: 0 },
  { id: 'regression_reintroduction_rate', tier: 'correctness_reliability', direction: 'lower_is_better', unit: 'ratio', gate: 'p0_p1_blocking', regressionTolerance: 0 },
  { id: 'impact_coverage', tier: 'execution_quality', direction: 'higher_is_better', unit: 'ratio', gate: 'non_blocking', regressionTolerance: 0 },
  { id: 'change_precision', tier: 'execution_quality', direction: 'higher_is_better', unit: 'ratio', gate: 'non_blocking', regressionTolerance: 0 },
  { id: 'tool_interaction_count', tier: 'efficiency', direction: 'lower_is_better', unit: 'count', gate: 'non_blocking', regressionTolerance: 0 },
  { id: 'latency_ms', tier: 'performance', direction: 'lower_is_better', unit: 'ms', gate: 'non_blocking', regressionTolerance: 0 },
]);

export const FORMAL_FAILURE_TAXONOMY = Object.freeze(['candidate_failure', 'candidate_timeout'] as const);

export const FORMAL_TRIAL_POLICY = Object.freeze({
  repetitions: 3,
  warmupTrials: 1,
  cacheModes: Object.freeze(['cold', 'warm'] as const),
  orderPolicy: 'seeded_randomized' as const,
  randomSeed: 'forge-v172-v2-formal-ab-v1',
  timeoutMs: 60_000,
  confidenceLevel: 0.95 as const,
});

export const FORMAL_ENVIRONMENT_POLICY = Object.freeze({
  sameEnvironmentFingerprintAcrossCandidates: true,
  freshRepositorySnapshotPerTrial: true,
  isolatedControllerStatePerTrial: true,
  isolatedRuntimeCacheLogsAndArtifactsPerTrial: true,
  freshEnvironmentIdentityPerFormalRun: true,
  requiredToolchainKeys: Object.freeze(['node', 'bun', 'git', 'mcpSdk'] as const),
});

export interface AaCalibrationEvidence {
  processId: string;
  evaluatorImplementationDigest: string;
  rawBundleDigest: string;
  scope: 'candidate_symmetry_and_harness_noise';
  formalTrialSample: false;
  baselineSourceRevision: string;
  baselineArtifactDigest: string;
  sharedCorpusDigest: string;
  publishedTarballSha256: string;
  scenarioCount: number;
  trialCount: number;
  passedScenarioCount: number;
  failedScenarioCount: number;
  failureCount: number;
  latencyDeltaMs: {
    count: number;
    mean: number;
    p50: number;
    p95: number;
    min: number;
    max: number;
    meanAbsolute: number;
    positiveCount: number;
    negativeCount: number;
    confidence95: { low: number; high: number; sampleCount: number; unit: 'scenario' };
  };
}

/** Calibration data is independently hashed evidence, not evaluator implementation. */
export const V172_AA_CALIBRATION: AaCalibrationEvidence = Object.freeze(
  JSON.parse(readFileSync(new URL('../aa-calibration.json', import.meta.url), 'utf8')) as AaCalibrationEvidence,
);

export interface FrozenCrossVersionAuthorityManifest {
  schemaVersion: typeof CROSS_VERSION_FREEZE_SCHEMA;
  evaluatorImplementationDigest: string;
  corpusDigest: string;
  protocolDigest: string;
  baselineIdentityDigest: string;
  aaCalibrationDigest: string;
  environmentPolicyDigest: string;
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function packageVersion(repoRoot: string, packageName: string): string {
  const packageJson = resolve(repoRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: unknown; version?: unknown };
  if (parsed.name !== packageName || typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error(`EVALUATION_FREEZE_RUNTIME_PACKAGE_INVALID:${packageName}`);
  }
  return parsed.version.trim();
}

export function crossVersionEvaluatorImplementationDigest(repoRoot = process.cwd()): string {
  const hash = createHash('sha256');
  hash.update('forge-cross-version-evaluator-implementation/v1\0');
  for (const path of CROSS_VERSION_EVALUATOR_FILES) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(resolve(repoRoot, path)));
    hash.update('\0');
  }
  for (const packageName of CROSS_VERSION_EVALUATOR_RUNTIME_PACKAGES) {
    hash.update(`package\0${packageName}\0${packageVersion(repoRoot, packageName)}\0`);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function currentSharedCorpusIdentity(repoRoot = process.cwd()) {
  const corpus = loadGoldenCorpus(resolve(repoRoot, 'evaluation', 'corpus.json'));
  return freezeEvaluationCorpus(Object.fromEntries(
    corpus.shared.map((scenario) => [scenario.id, evaluationScenarioDigest(scenario)]),
  ));
}

export function buildFormalCrossVersionProtocol(repoRoot = process.cwd()): FrozenEvaluationProtocol {
  return freezeEvaluationProtocol({
    evaluator: freezeEvaluatorIdentity({
      evaluatorVersion: CROSS_VERSION_EVALUATOR_VERSION,
      implementationDigest: crossVersionEvaluatorImplementationDigest(repoRoot),
    }),
    corpus: currentSharedCorpusIdentity(repoRoot),
    trialPolicy: FORMAL_TRIAL_POLICY,
    metrics: FORMAL_CROSS_VERSION_METRICS,
    failureTaxonomy: FORMAL_FAILURE_TAXONOMY,
  });
}

export function v172BaselineIdentity() {
  return freezeCandidateIdentity({
    candidateId: 'forge-v1.7.2',
    versionLabel: 'v1.7.2',
    artifactDigest: V172_ARTIFACT_DIGEST,
    sourceRevision: V172_SOURCE_REVISION,
    executionSurface: 'public_mcp',
  });
}

export function assertFormalEnvironmentIdentity(environment: EvaluationEnvironmentIdentity): void {
  if (!environment.os.trim() || !environment.arch.trim() || !environment.hardware.trim() || !environment.runtime.trim()) {
    throw new Error('EVALUATION_FREEZE_ENVIRONMENT_IDENTITY_INCOMPLETE');
  }
  for (const key of FORMAL_ENVIRONMENT_POLICY.requiredToolchainKeys) {
    if (!environment.toolchain[key]?.trim()) throw new Error(`EVALUATION_FREEZE_ENVIRONMENT_TOOLCHAIN_REQUIRED:${key}`);
  }
}

export function buildFrozenCrossVersionAuthorityManifest(repoRoot = process.cwd()): FrozenCrossVersionAuthorityManifest {
  const protocol = buildFormalCrossVersionProtocol(repoRoot);
  return Object.freeze({
    schemaVersion: CROSS_VERSION_FREEZE_SCHEMA,
    evaluatorImplementationDigest: protocol.evaluator.implementationDigest,
    corpusDigest: protocol.corpus.digest,
    protocolDigest: protocol.protocolDigest,
    baselineIdentityDigest: digestJson(v172BaselineIdentity()),
    aaCalibrationDigest: digestJson(V172_AA_CALIBRATION),
    environmentPolicyDigest: digestJson(FORMAL_ENVIRONMENT_POLICY),
  });
}

export function readFrozenCrossVersionAuthority(repoRoot = process.cwd()): FrozenCrossVersionAuthorityManifest {
  const parsed = JSON.parse(readFileSync(resolve(repoRoot, 'evaluation', 'frozen-cross-version-authority.json'), 'utf8')) as Record<string, unknown>;
  const keys = [
    'schemaVersion',
    'evaluatorImplementationDigest',
    'corpusDigest',
    'protocolDigest',
    'baselineIdentityDigest',
    'aaCalibrationDigest',
    'environmentPolicyDigest',
  ];
  if (Object.keys(parsed).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error('EVALUATION_FREEZE_MANIFEST_FIELDS_INVALID');
  if (parsed.schemaVersion !== CROSS_VERSION_FREEZE_SCHEMA) throw new Error('EVALUATION_FREEZE_SCHEMA_MISMATCH');
  for (const key of keys.slice(1)) {
    if (typeof parsed[key] !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(parsed[key] as string)) {
      throw new Error(`EVALUATION_FREEZE_${key.toUpperCase()}_INVALID`);
    }
  }
  return Object.freeze(parsed as unknown as FrozenCrossVersionAuthorityManifest);
}

export function assertProtocolMatchesFrozenAuthority(
  protocol: FrozenEvaluationProtocol,
  frozen: FrozenCrossVersionAuthorityManifest,
): void {
  if (frozen.evaluatorImplementationDigest !== protocol.evaluator.implementationDigest) throw new Error('EVALUATION_FREEZE_EVALUATOR_DRIFT');
  if (frozen.corpusDigest !== protocol.corpus.digest) throw new Error('EVALUATION_FREEZE_CORPUS_DRIFT');
  if (frozen.protocolDigest !== protocol.protocolDigest) throw new Error('EVALUATION_FREEZE_PROTOCOL_DRIFT');
}

export function assertFrozenCrossVersionAuthority(repoRoot = process.cwd()): FrozenEvaluationProtocol {
  const frozen = readFrozenCrossVersionAuthority(repoRoot);
  const protocol = buildFormalCrossVersionProtocol(repoRoot);
  assertProtocolMatchesFrozenAuthority(protocol, frozen);
  if (frozen.baselineIdentityDigest !== digestJson(v172BaselineIdentity())) throw new Error('EVALUATION_FREEZE_BASELINE_DRIFT');
  if (frozen.aaCalibrationDigest !== digestJson(V172_AA_CALIBRATION)) throw new Error('EVALUATION_FREEZE_AA_CALIBRATION_DRIFT');
  if (frozen.environmentPolicyDigest !== digestJson(FORMAL_ENVIRONMENT_POLICY)) throw new Error('EVALUATION_FREEZE_ENVIRONMENT_POLICY_DRIFT');
  const ci = V172_AA_CALIBRATION.latencyDeltaMs.confidence95;
  if (V172_AA_CALIBRATION.evaluatorImplementationDigest !== protocol.evaluator.implementationDigest
    || !/^sha256:[0-9a-f]{64}$/.test(V172_AA_CALIBRATION.rawBundleDigest ?? '')
    || V172_AA_CALIBRATION.baselineSourceRevision !== V172_SOURCE_REVISION
    || V172_AA_CALIBRATION.baselineArtifactDigest !== V172_ARTIFACT_DIGEST
    || V172_AA_CALIBRATION.publishedTarballSha256 !== V172_PUBLISHED_TARBALL_SHA256
    || V172_AA_CALIBRATION.trialCount !== protocol.corpus.scenarioIds.length * 2
    || V172_AA_CALIBRATION.sharedCorpusDigest !== protocol.corpus.digest
    || V172_AA_CALIBRATION.scenarioCount !== protocol.corpus.scenarioIds.length
    || V172_AA_CALIBRATION.passedScenarioCount !== V172_AA_CALIBRATION.scenarioCount
    || V172_AA_CALIBRATION.failedScenarioCount !== 0
    || V172_AA_CALIBRATION.failureCount !== 0
    || V172_AA_CALIBRATION.latencyDeltaMs.positiveCount === 0
    || V172_AA_CALIBRATION.latencyDeltaMs.negativeCount === 0
    || ci.sampleCount !== V172_AA_CALIBRATION.scenarioCount
    || ci.low > 0
    || ci.high < 0) {
    throw new Error('EVALUATION_FREEZE_AA_CALIBRATION_INVALID');
  }
  return protocol;
}
