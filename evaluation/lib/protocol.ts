import { createHash } from 'node:crypto';
import type { EvaluationAuthorityClass } from './types.ts';

export const EVALUATION_PROTOCOL_SCHEMA = 'forge-evaluation-protocol/v1' as const;
export const EVALUATION_EVALUATOR_SCHEMA = 'forge-evaluator-identity/v1' as const;
export const EVALUATION_CANDIDATE_SCHEMA = 'forge-candidate-identity/v1' as const;
export const EVALUATION_ENVIRONMENT_SCHEMA = 'forge-environment-identity/v1' as const;
export const EVALUATION_CORPUS_SCHEMA = 'forge-corpus-identity/v1' as const;
export const CROSS_VERSION_EVALUATION_AUTHORITY = 'cross_version_evaluation' as const;
export const CANDIDATE_INTERNAL_DIAGNOSTIC_AUTHORITY = 'candidate_internal_diagnostic' as const;

export type EvaluationMetricTier = 'correctness_reliability' | 'execution_quality' | 'efficiency' | 'performance';
export type EvaluationMetricDirection = 'higher_is_better' | 'lower_is_better' | 'informational';
export type EvaluationTrialOrderPolicy = 'balanced_alternating' | 'seeded_randomized';
export type EvaluationCacheMode = 'cold' | 'warm';

const METRIC_TIERS: readonly EvaluationMetricTier[] = ['correctness_reliability', 'execution_quality', 'efficiency', 'performance'];
const METRIC_DIRECTIONS: readonly EvaluationMetricDirection[] = ['higher_is_better', 'lower_is_better', 'informational'];
const METRIC_GATES = ['p0_p1_blocking', 'non_blocking'] as const;
const TRIAL_ORDER_POLICIES: readonly EvaluationTrialOrderPolicy[] = ['balanced_alternating', 'seeded_randomized'];
const CACHE_MODES: readonly EvaluationCacheMode[] = ['cold', 'warm'];
const EXECUTION_SURFACES: readonly EvaluationCandidateIdentity['executionSurface'][] = ['public_cli', 'public_mcp'];

export interface EvaluationEvaluatorIdentity {
  schemaVersion: typeof EVALUATION_EVALUATOR_SCHEMA;
  evaluatorVersion: string;
  implementationDigest: string;
}

export interface EvaluationCandidateIdentity {
  schemaVersion: typeof EVALUATION_CANDIDATE_SCHEMA;
  candidateId: string;
  versionLabel: string;
  artifactDigest: string;
  sourceRevision?: string;
  executionSurface: 'public_cli' | 'public_mcp';
}

export interface EvaluationEnvironmentIdentity {
  schemaVersion: typeof EVALUATION_ENVIRONMENT_SCHEMA;
  os: string;
  arch: string;
  hardware: string;
  runtime: string;
  toolchain: Readonly<Record<string, string>>;
  fingerprint: string;
}

export interface EvaluationCorpusIdentity {
  schemaVersion: typeof EVALUATION_CORPUS_SCHEMA;
  scenarioDigests: Readonly<Record<string, string>>;
  scenarioIds: readonly string[];
  digest: string;
}

export interface EvaluationMetricDefinition {
  id: string;
  tier: EvaluationMetricTier;
  direction: EvaluationMetricDirection;
  unit: string;
  gate: 'p0_p1_blocking' | 'non_blocking';
  /** Absolute metric-unit regression tolerance, frozen into the protocol before formal trials. */
  regressionTolerance?: number;
}

export interface EvaluationTrialPolicy {
  repetitions: number;
  warmupTrials: number;
  cacheModes: readonly EvaluationCacheMode[];
  orderPolicy: EvaluationTrialOrderPolicy;
  randomSeed?: string;
  timeoutMs: number;
  confidenceLevel: 0.95;
}

export interface FrozenEvaluationProtocol {
  schemaVersion: typeof EVALUATION_PROTOCOL_SCHEMA;
  authority: typeof CROSS_VERSION_EVALUATION_AUTHORITY;
  evaluator: EvaluationEvaluatorIdentity;
  corpus: EvaluationCorpusIdentity;
  trialPolicy: EvaluationTrialPolicy;
  metrics: readonly EvaluationMetricDefinition[];
  failureTaxonomy: readonly string[];
  protocolDigest: string;
}

export interface EvaluationRunIdentity {
  protocolDigest: string;
  candidate: EvaluationCandidateIdentity;
  environment: EvaluationEnvironmentIdentity;
}

function text(value: string, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`EVALUATION_PROTOCOL_${field.toUpperCase()}_REQUIRED`);
  return normalized;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sortedRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input)
    .map(([key, value]) => [text(key, 'scenario_id'), text(value, 'scenario_digest')] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedMetrics(metrics: readonly EvaluationMetricDefinition[]): EvaluationMetricDefinition[] {
  const result = metrics.map((metric) => {
    if (!METRIC_TIERS.includes(metric.tier)) throw new Error('EVALUATION_PROTOCOL_METRIC_TIER_INVALID');
    if (!METRIC_DIRECTIONS.includes(metric.direction)) throw new Error('EVALUATION_PROTOCOL_METRIC_DIRECTION_INVALID');
    if (!METRIC_GATES.includes(metric.gate)) throw new Error('EVALUATION_PROTOCOL_METRIC_GATE_INVALID');
    const regressionTolerance = metric.regressionTolerance ?? 0;
    if (!Number.isFinite(regressionTolerance) || regressionTolerance < 0) throw new Error('EVALUATION_PROTOCOL_METRIC_REGRESSION_TOLERANCE_INVALID');
    return {
      id: text(metric.id, 'metric_id'),
      tier: metric.tier,
      direction: metric.direction,
      unit: text(metric.unit, 'metric_unit'),
      gate: metric.gate,
      regressionTolerance,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (result.length === 0) throw new Error('EVALUATION_PROTOCOL_METRICS_REQUIRED');
  if (new Set(result.map((metric) => metric.id)).size !== result.length) throw new Error('EVALUATION_PROTOCOL_METRIC_IDS_UNIQUE');
  if (!result.some((metric) => metric.tier === 'correctness_reliability' && metric.gate === 'p0_p1_blocking')) {
    throw new Error('EVALUATION_PROTOCOL_TIER1_BLOCKING_METRIC_REQUIRED');
  }
  return result;
}

export function freezeEvaluationCorpus(scenarioDigests: Record<string, string>): EvaluationCorpusIdentity {
  const normalized = sortedRecord(scenarioDigests);
  const scenarioIds = Object.keys(normalized);
  if (scenarioIds.length === 0) throw new Error('EVALUATION_PROTOCOL_CORPUS_REQUIRED');
  const core = {
    schemaVersion: EVALUATION_CORPUS_SCHEMA,
    scenarioDigests: normalized,
    scenarioIds,
  } as const;
  return deepFreeze({ ...core, digest: digest(core) });
}

export function freezeEvaluatorIdentity(input: Omit<EvaluationEvaluatorIdentity, 'schemaVersion'>): EvaluationEvaluatorIdentity {
  return Object.freeze({
    schemaVersion: EVALUATION_EVALUATOR_SCHEMA,
    evaluatorVersion: text(input.evaluatorVersion, 'evaluator_version'),
    implementationDigest: text(input.implementationDigest, 'implementation_digest'),
  });
}

export function freezeCandidateIdentity(input: Omit<EvaluationCandidateIdentity, 'schemaVersion'>): EvaluationCandidateIdentity {
  if (!EXECUTION_SURFACES.includes(input.executionSurface)) throw new Error('EVALUATION_PROTOCOL_EXECUTION_SURFACE_INVALID');
  return Object.freeze({
    schemaVersion: EVALUATION_CANDIDATE_SCHEMA,
    candidateId: text(input.candidateId, 'candidate_id'),
    versionLabel: text(input.versionLabel, 'version_label'),
    artifactDigest: text(input.artifactDigest, 'artifact_digest'),
    ...(input.sourceRevision?.trim() ? { sourceRevision: input.sourceRevision.trim() } : {}),
    executionSurface: input.executionSurface,
  });
}

export function freezeEnvironmentIdentity(input: Omit<EvaluationEnvironmentIdentity, 'schemaVersion' | 'fingerprint'>): EvaluationEnvironmentIdentity {
  const toolchain = Object.fromEntries(Object.entries(input.toolchain)
    .map(([key, value]) => [text(key, 'toolchain_key'), text(value, 'toolchain_value')] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  const core = {
    schemaVersion: EVALUATION_ENVIRONMENT_SCHEMA,
    os: text(input.os, 'environment_os'),
    arch: text(input.arch, 'environment_arch'),
    hardware: text(input.hardware, 'environment_hardware'),
    runtime: text(input.runtime, 'environment_runtime'),
    toolchain,
  } as const;
  return deepFreeze({ ...core, fingerprint: digest(core) });
}

export function freezeEvaluationProtocol(input: {
  evaluator: EvaluationEvaluatorIdentity;
  corpus: EvaluationCorpusIdentity;
  trialPolicy: Omit<EvaluationTrialPolicy, 'confidenceLevel'> & { confidenceLevel?: 0.95 };
  metrics: readonly EvaluationMetricDefinition[];
  failureTaxonomy: readonly string[];
}): FrozenEvaluationProtocol {
  const repetitions = Math.floor(input.trialPolicy.repetitions);
  const warmupTrials = Math.floor(input.trialPolicy.warmupTrials);
  const timeoutMs = Math.floor(input.trialPolicy.timeoutMs);
  if (repetitions < 1 || warmupTrials < 0 || timeoutMs < 1) throw new Error('EVALUATION_PROTOCOL_TRIAL_POLICY_INVALID');
  if (input.trialPolicy.confidenceLevel !== undefined && input.trialPolicy.confidenceLevel !== 0.95) {
    throw new Error('EVALUATION_PROTOCOL_CONFIDENCE_LEVEL_INVALID');
  }
  if (!TRIAL_ORDER_POLICIES.includes(input.trialPolicy.orderPolicy)) throw new Error('EVALUATION_PROTOCOL_ORDER_POLICY_INVALID');
  if (input.trialPolicy.cacheModes.some((mode) => !CACHE_MODES.includes(mode))) throw new Error('EVALUATION_PROTOCOL_CACHE_MODE_INVALID');
  const cacheModes = [...new Set(input.trialPolicy.cacheModes)].sort() as EvaluationCacheMode[];
  if (cacheModes.length === 0) throw new Error('EVALUATION_PROTOCOL_CACHE_MODES_REQUIRED');
  if (input.trialPolicy.orderPolicy === 'seeded_randomized' && !input.trialPolicy.randomSeed?.trim()) {
    throw new Error('EVALUATION_PROTOCOL_RANDOM_SEED_REQUIRED');
  }
  const trialPolicy: EvaluationTrialPolicy = {
    repetitions,
    warmupTrials,
    cacheModes,
    orderPolicy: input.trialPolicy.orderPolicy,
    ...(input.trialPolicy.randomSeed?.trim() ? { randomSeed: input.trialPolicy.randomSeed.trim() } : {}),
    timeoutMs,
    confidenceLevel: 0.95,
  };
  const failureTaxonomy = [...new Set(input.failureTaxonomy.map((entry) => text(entry, 'failure_taxonomy')))].sort();
  if (failureTaxonomy.length === 0) throw new Error('EVALUATION_PROTOCOL_FAILURE_TAXONOMY_REQUIRED');
  const evaluator = freezeEvaluatorIdentity({
    evaluatorVersion: input.evaluator.evaluatorVersion,
    implementationDigest: input.evaluator.implementationDigest,
  });
  const corpus = freezeEvaluationCorpus({ ...input.corpus.scenarioDigests });
  const core = {
    schemaVersion: EVALUATION_PROTOCOL_SCHEMA,
    authority: CROSS_VERSION_EVALUATION_AUTHORITY,
    evaluator,
    corpus,
    trialPolicy,
    metrics: normalizedMetrics(input.metrics),
    failureTaxonomy,
  } as const;
  return deepFreeze({ ...core, protocolDigest: digest(core) });
}

export function evaluationRunIdentity(input: {
  protocol: FrozenEvaluationProtocol;
  candidate: EvaluationCandidateIdentity;
  environment: EvaluationEnvironmentIdentity;
}): EvaluationRunIdentity {
  return deepFreeze({
    protocolDigest: input.protocol.protocolDigest,
    candidate: freezeCandidateIdentity({
      candidateId: input.candidate.candidateId,
      versionLabel: input.candidate.versionLabel,
      artifactDigest: input.candidate.artifactDigest,
      sourceRevision: input.candidate.sourceRevision,
      executionSurface: input.candidate.executionSurface,
    }),
    environment: freezeEnvironmentIdentity({
      os: input.environment.os,
      arch: input.environment.arch,
      hardware: input.environment.hardware,
      runtime: input.environment.runtime,
      toolchain: { ...input.environment.toolchain },
    }),
  });
}

export function assertCrossVersionVerdictAuthority(authority: EvaluationAuthorityClass): void {
  if (authority !== CROSS_VERSION_EVALUATION_AUTHORITY) {
    throw new Error('EVALUATION_CANDIDATE_INTERNAL_DIAGNOSTIC_CANNOT_PRODUCE_VERSION_VERDICT');
  }
}
