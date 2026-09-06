import type { PairedCandidateRun } from './candidate-runner.ts';
import {
  CROSS_VERSION_EVALUATION_AUTHORITY,
  freezeCandidateIdentity,
  freezeEnvironmentIdentity,
  type EvaluationMetricDefinition,
  type EvaluationMetricDirection,
  type EvaluationMetricTier,
  type FrozenEvaluationProtocol,
} from './protocol.ts';
import type { EvaluationMetrics, EvaluationReport, EvaluationScenario, EvaluationTrace, ValidationResult } from './types.ts';

function rate(results: ValidationResult[]): number | null {
  if (results.length === 0) return null;
  return results.filter((result) => result.status === 'passed').length / results.length;
}

export function calculateMetrics(scenario: EvaluationScenario, trace: EvaluationTrace): EvaluationMetrics {
  const observedDomains = new Set([...trace.contextRetrieval, ...trace.inspectedEvidence].map((evidence) => evidence.domain));
  const executionCommands = trace.commands.filter((command) => command.kind === 'forge');
  const invariants = trace.validation.filter((result) => result.kind === 'invariant');
  const regressions = trace.validation.filter((result) => result.kind === 'regression');
  const precision = trace.validation.filter((result) => result.kind === 'change_precision');
  return {
    taskSuccessRate: trace.finalResult.status === 'passed' ? 1 : 0,
    impactCoverage: scenario.groundTruth.affectedDomains.length === 0 || observedDomains.size === 0
      ? null
      : scenario.groundTruth.affectedDomains.filter((domain) => observedDomains.has(domain)).length / scenario.groundTruth.affectedDomains.length,
    behavioralInvariantSuccess: rate(invariants),
    regressionReintroductionRate: regressions.length === 0
      ? null
      : 1 - (rate(regressions) ?? 0),
    changePrecision: rate(precision),
    executionLatencyMs: executionCommands.length > 0
      ? executionCommands.reduce((total, command) => total + command.durationMs, 0)
      : null,
    toolInteractionCount: trace.toolInteractions.length,
  };
}

export type CanonicalEvaluationMetricId =
  | 'task_correctness'
  | 'behavioral_invariant_success'
  | 'regression_reintroduction_rate'
  | 'impact_coverage'
  | 'change_precision'
  | 'tool_interaction_count'
  | 'latency_ms';

const CANONICAL_METRIC_READERS: Readonly<Record<CanonicalEvaluationMetricId, (report: EvaluationReport) => number | null>> = Object.freeze({
  task_correctness: (report) => report.metrics.taskSuccessRate,
  behavioral_invariant_success: (report) => report.metrics.behavioralInvariantSuccess,
  regression_reintroduction_rate: (report) => report.metrics.regressionReintroductionRate,
  impact_coverage: (report) => report.metrics.impactCoverage,
  change_precision: (report) => report.metrics.changePrecision,
  tool_interaction_count: (report) => report.metrics.toolInteractionCount,
  latency_ms: (report) => report.metrics.executionLatencyMs,
});

export interface PairedConfidenceInterval95 {
  low: number;
  high: number;
  sampleCount: number;
  unit: 'scenario';
}

export interface PairedEvaluationSample {
  pairId: string;
  scenarioId: string;
  cacheMode: string;
  repetition: number;
  baselineCandidateId: string;
  candidateId: string;
  baselineValue: number;
  candidateValue: number;
  absoluteDelta: number;
  directionalDelta: number;
  relativeDelta: number | null;
  baselineFailed: boolean;
  candidateFailed: boolean;
  baselineTimedOut: boolean;
  candidateTimedOut: boolean;
}

export interface DistributionSummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
}

export interface DeltaDistributionSummary extends DistributionSummary {
  confidence95: PairedConfidenceInterval95 | null;
}

export interface RelativeDeltaSummary {
  definedCount: number;
  undefinedCount: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  confidence95: PairedConfidenceInterval95 | null;
}

export interface CandidateReliabilitySummary {
  failureProportion: number;
  timeoutProportion: number;
}

export interface PairedMetricStatistics {
  metric: EvaluationMetricDefinition;
  samples: readonly PairedEvaluationSample[];
  baseline: DistributionSummary & CandidateReliabilitySummary;
  candidate: DistributionSummary & CandidateReliabilitySummary;
  absoluteDelta: DeltaDistributionSummary;
  directionalDelta: DeltaDistributionSummary;
  relativeDelta: RelativeDeltaSummary;
  directionalRegressionCount: number;
  newlyIntroducedFailureCount: number;
  newlyIntroducedTimeoutCount: number;
  aggregateRegression: boolean;
  blockingRegression: boolean;
}

export interface EvaluationTierStatistics {
  tier: EvaluationMetricTier;
  status: 'passed' | 'regressed' | 'informational';
  metrics: readonly PairedMetricStatistics[];
}

export interface CrossVersionPairedStatistics {
  schemaVersion: 'forge-cross-version-paired-statistics/v1';
  authority: typeof CROSS_VERSION_EVALUATION_AUTHORITY;
  protocolDigest: string;
  environmentFingerprint: string;
  baselineCandidateId: string;
  candidateId: string;
  pairCount: number;
  unmeasuredMetrics: readonly { metricId: string; missingTrialCount: number; totalTrialCount: number }[];
  tiers: Readonly<Record<EvaluationMetricTier, EvaluationTierStatistics>>;
  verdict: {
    status: 'blocked_by_correctness_reliability' | 'inconclusive_missing_metrics' | 'eligible_for_superiority_assessment';
    blockingMetricIds: readonly string[];
    newlyIntroducedFailureCount: number;
    newlyIntroducedTimeoutCount: number;
  };
}

const T95: readonly number[] = [
  Number.NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
  2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
  2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`EVALUATION_PAIRED_NON_FINITE:${field}`);
  return value;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('EVALUATION_PAIRED_SAMPLES_REQUIRED');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error('EVALUATION_PAIRED_SAMPLES_REQUIRED');
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function confidence95(values: readonly number[]): PairedConfidenceInterval95 | null {
  if (values.length < 2) return null;
  const center = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - center) ** 2), 0) / (values.length - 1);
  const standardError = Math.sqrt(variance) / Math.sqrt(values.length);
  const degreesOfFreedom = values.length - 1;
  const critical = degreesOfFreedom <= 30 ? T95[degreesOfFreedom]! : 1.96;
  const margin = critical * standardError;
  return { low: center - margin, high: center + margin, sampleCount: values.length, unit: 'scenario' };
}

function distribution(values: readonly number[]): DistributionSummary {
  return { count: values.length, mean: mean(values), p50: percentile(values, 0.50), p95: percentile(values, 0.95) };
}

function scenarioMeans(samples: readonly PairedEvaluationSample[], read: (sample: PairedEvaluationSample) => number | null): number[] {
  const grouped = new Map<string, number[]>();
  for (const sample of samples) {
    const value = read(sample);
    if (value === null) continue;
    const values = grouped.get(sample.scenarioId) ?? [];
    values.push(value);
    grouped.set(sample.scenarioId, values);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, values]) => mean(values));
}

function deltaDistribution(values: readonly number[], scenarioValues: readonly number[]): DeltaDistributionSummary {
  return { ...distribution(values), confidence95: confidence95(scenarioValues) };
}

function relativeDistribution(values: readonly (number | null)[], scenarioValues: readonly number[]): RelativeDeltaSummary {
  const defined = values.filter((value): value is number => value !== null);
  return {
    definedCount: defined.length,
    undefinedCount: values.length - defined.length,
    mean: defined.length === 0 ? null : mean(defined),
    p50: defined.length === 0 ? null : percentile(defined, 0.50),
    p95: defined.length === 0 ? null : percentile(defined, 0.95),
    confidence95: scenarioValues.length === 0 ? null : confidence95(scenarioValues),
  };
}

function directionSign(direction: EvaluationMetricDirection): number {
  if (direction === 'higher_is_better') return 1;
  if (direction === 'lower_is_better') return -1;
  return 0;
}

function metricReader(metricId: string): (report: EvaluationReport) => number | null {
  const reader = CANONICAL_METRIC_READERS[metricId as CanonicalEvaluationMetricId];
  if (!reader) throw new Error(`EVALUATION_PAIRED_METRIC_ID_UNSUPPORTED:${metricId}`);
  return reader;
}

function timedOut(report: EvaluationReport): boolean {
  return [...report.trace.commands, ...report.trace.checks].some((command) => command.timedOut);
}

function pairKey(scenarioId: string, cacheMode: string, repetition: number): string {
  return `${scenarioId}:${cacheMode}:${repetition}`;
}

function collectMetricSamples(input: {
  runs: readonly PairedCandidateRun[];
  metric: EvaluationMetricDefinition;
  baselineCandidateId: string;
  candidateId: string;
}): PairedEvaluationSample[] {
  const reader = metricReader(input.metric.id);
  const samples: PairedEvaluationSample[] = [];
  const seen = new Set<string>();
  for (const run of input.runs) {
    const grouped = new Map<string, Array<(typeof run.trials)[number]>>();
    for (const trial of run.trials) {
      const key = pairKey(run.scenarioId, trial.cacheMode, trial.repetition);
      const list = grouped.get(key) ?? [];
      list.push(trial);
      grouped.set(key, list);
    }
    for (const [key, trials] of grouped) {
      if (seen.has(key)) throw new Error(`EVALUATION_PAIRED_DUPLICATE_PAIR:${key}`);
      seen.add(key);
      if (trials.length !== 2) throw new Error(`EVALUATION_PAIRED_PAIR_INCOMPLETE:${key}`);
      const baseline = trials.find((trial) => trial.candidateIndex === 0);
      const candidate = trials.find((trial) => trial.candidateIndex === 1);
      if (!baseline || !candidate) throw new Error(`EVALUATION_PAIRED_PAIR_INCOMPLETE:${key}`);
      if (baseline.runIdentity.candidate.candidateId !== input.baselineCandidateId
        || candidate.runIdentity.candidate.candidateId !== input.candidateId) {
        throw new Error(`EVALUATION_PAIRED_CANDIDATE_IDENTITY_MISMATCH:${key}`);
      }
      const baselineValue = reader(baseline.report);
      const candidateValue = reader(candidate.report);
      if (baselineValue === null || candidateValue === null) throw new Error(`EVALUATION_PAIRED_METRIC_MISSING:${input.metric.id}:${key}`);
      finite(baselineValue, `${input.metric.id}:${key}:baseline`);
      finite(candidateValue, `${input.metric.id}:${key}:candidate`);
      const absoluteDelta = candidateValue - baselineValue;
      const directionalDelta = absoluteDelta * directionSign(input.metric.direction);
      const relativeDelta = baselineValue === 0 ? null : absoluteDelta / Math.abs(baselineValue);
      samples.push({
        pairId: key,
        scenarioId: run.scenarioId,
        cacheMode: baseline.cacheMode,
        repetition: baseline.repetition,
        baselineCandidateId: input.baselineCandidateId,
        candidateId: input.candidateId,
        baselineValue,
        candidateValue,
        absoluteDelta,
        directionalDelta,
        relativeDelta,
        baselineFailed: baseline.report.trace.finalResult.status === 'failed',
        candidateFailed: candidate.report.trace.finalResult.status === 'failed',
        baselineTimedOut: timedOut(baseline.report),
        candidateTimedOut: timedOut(candidate.report),
      });
    }
  }
  if (samples.length === 0) throw new Error(`EVALUATION_PAIRED_SAMPLES_REQUIRED:${input.metric.id}`);
  return samples.sort((left, right) => left.pairId.localeCompare(right.pairId));
}

function summarizeMetric(metric: EvaluationMetricDefinition, samples: readonly PairedEvaluationSample[]): PairedMetricStatistics {
  const baselineValues = samples.map((sample) => sample.baselineValue);
  const candidateValues = samples.map((sample) => sample.candidateValue);
  const absoluteDeltas = samples.map((sample) => sample.absoluteDelta);
  const directionalDeltas = samples.map((sample) => sample.directionalDelta);
  const scenarioAbsoluteDeltas = scenarioMeans(samples, (sample) => sample.absoluteDelta);
  const scenarioDirectionalDeltas = scenarioMeans(samples, (sample) => sample.directionalDelta);
  const scenarioRelativeDeltas = scenarioMeans(samples, (sample) => sample.relativeDelta);
  const tolerance = metric.regressionTolerance ?? 0;
  const directionalRegressionCount = metric.direction === 'informational'
    ? 0
    : samples.filter((sample) => sample.directionalDelta < -tolerance).length;
  const newlyIntroducedFailureCount = samples.filter((sample) => !sample.baselineFailed && sample.candidateFailed).length;
  const newlyIntroducedTimeoutCount = samples.filter((sample) => !sample.baselineTimedOut && sample.candidateTimedOut).length;
  const directionalConfidence = confidence95(scenarioDirectionalDeltas);
  const aggregateRegression = metric.direction !== 'informational'
    && (directionalConfidence
      ? directionalConfidence.high < -tolerance
      : scenarioDirectionalDeltas.length === 1 && scenarioDirectionalDeltas[0]! < -tolerance);
  const blockingRegression = metric.tier === 'correctness_reliability'
    && metric.gate === 'p0_p1_blocking'
    && (directionalRegressionCount > 0 || newlyIntroducedFailureCount > 0 || newlyIntroducedTimeoutCount > 0);
  return {
    metric,
    samples,
    baseline: {
      ...distribution(baselineValues),
      failureProportion: samples.filter((sample) => sample.baselineFailed).length / samples.length,
      timeoutProportion: samples.filter((sample) => sample.baselineTimedOut).length / samples.length,
    },
    candidate: {
      ...distribution(candidateValues),
      failureProportion: samples.filter((sample) => sample.candidateFailed).length / samples.length,
      timeoutProportion: samples.filter((sample) => sample.candidateTimedOut).length / samples.length,
    },
    absoluteDelta: deltaDistribution(absoluteDeltas, scenarioAbsoluteDeltas),
    directionalDelta: deltaDistribution(directionalDeltas, scenarioDirectionalDeltas),
    relativeDelta: relativeDistribution(samples.map((sample) => sample.relativeDelta), scenarioRelativeDeltas),
    directionalRegressionCount,
    newlyIntroducedFailureCount,
    newlyIntroducedTimeoutCount,
    aggregateRegression,
    blockingRegression,
  };
}

const TIERS: readonly EvaluationMetricTier[] = ['correctness_reliability', 'execution_quality', 'efficiency', 'performance'];

export function buildCrossVersionPairedStatistics(input: {
  protocol: FrozenEvaluationProtocol;
  runs: readonly PairedCandidateRun[];
}): CrossVersionPairedStatistics {
  if (input.runs.length === 0) throw new Error('EVALUATION_PAIRED_RUNS_REQUIRED');
  const [first] = input.runs;
  if (!first) throw new Error('EVALUATION_PAIRED_RUNS_REQUIRED');
  if (first.authority !== CROSS_VERSION_EVALUATION_AUTHORITY) throw new Error('EVALUATION_PAIRED_AUTHORITY_MISMATCH');
  const [baselineCandidateId, candidateId] = first.candidateIds;
  if (!baselineCandidateId || !candidateId || baselineCandidateId === candidateId) throw new Error('EVALUATION_PAIRED_CANDIDATE_IDS_INVALID');
  const seenScenarios = new Set<string>();
  const candidateIdentities = new Map<number, string>();
  for (const run of input.runs) {
    if (run.authority !== CROSS_VERSION_EVALUATION_AUTHORITY) throw new Error('EVALUATION_PAIRED_AUTHORITY_MISMATCH');
    if (run.protocolDigest !== input.protocol.protocolDigest) throw new Error(`EVALUATION_PAIRED_PROTOCOL_MISMATCH:${run.scenarioId}`);
    if (run.environmentFingerprint !== first.environmentFingerprint) throw new Error(`EVALUATION_PAIRED_ENVIRONMENT_MISMATCH:${run.scenarioId}`);
    if (run.candidateIds[0] !== baselineCandidateId || run.candidateIds[1] !== candidateId) throw new Error(`EVALUATION_PAIRED_CANDIDATE_SET_MISMATCH:${run.scenarioId}`);
    if (!input.protocol.corpus.scenarioIds.includes(run.scenarioId) || seenScenarios.has(run.scenarioId)) {
      throw new Error(`EVALUATION_PAIRED_CORPUS_MISMATCH:${run.scenarioId}`);
    }
    seenScenarios.add(run.scenarioId);
    if (run.orderPolicy !== input.protocol.trialPolicy.orderPolicy) throw new Error(`EVALUATION_PAIRED_ORDER_MISMATCH:${run.scenarioId}`);
    const expectedTrials = new Set(input.protocol.trialPolicy.cacheModes.flatMap((mode) =>
      Array.from({ length: input.protocol.trialPolicy.repetitions }, (_, repetition) =>
        [0, 1].map((arm) => `${mode}:${repetition}:${arm}`)).flat()));
    for (const trial of run.trials) {
      const key = `${trial.cacheMode}:${trial.repetition}:${trial.candidateIndex}`;
      if (!expectedTrials.delete(key)) throw new Error(`EVALUATION_PAIRED_TRIAL_MISMATCH:${run.scenarioId}:${key}`);
      const identity = trial.runIdentity;
      if (identity.protocolDigest !== input.protocol.protocolDigest) throw new Error(`EVALUATION_PAIRED_TRIAL_PROTOCOL_MISMATCH:${run.scenarioId}`);
      if (identity.environment.fingerprint !== run.environmentFingerprint
        || freezeEnvironmentIdentity(identity.environment).fingerprint !== run.environmentFingerprint) {
        throw new Error(`EVALUATION_PAIRED_TRIAL_ENVIRONMENT_MISMATCH:${run.scenarioId}`);
      }
      if (identity.candidate.candidateId !== run.candidateIds[trial.candidateIndex]) throw new Error(`EVALUATION_PAIRED_CANDIDATE_IDENTITY_MISMATCH:${run.scenarioId}`);
      const candidateIdentity = JSON.stringify(freezeCandidateIdentity(identity.candidate));
      const previousIdentity = candidateIdentities.get(trial.candidateIndex);
      if (previousIdentity !== undefined && previousIdentity !== candidateIdentity) {
        throw new Error(`EVALUATION_PAIRED_ARTIFACT_IDENTITY_MISMATCH:${run.scenarioId}`);
      }
      candidateIdentities.set(trial.candidateIndex, candidateIdentity);
      if (trial.report.trace.scenarioId !== run.scenarioId) throw new Error(`EVALUATION_PAIRED_REPORT_SCENARIO_MISMATCH:${run.scenarioId}`);
      if (trial.report.trace.validation.some((result) => result.kind === 'isolation' && result.status !== 'passed')) {
        throw new Error(`EVALUATION_PAIRED_ISOLATION_FAILED:${run.scenarioId}`);
      }
    }
    if (expectedTrials.size > 0) throw new Error(`EVALUATION_PAIRED_TRIALS_INCOMPLETE:${run.scenarioId}`);
  }
  if (seenScenarios.size !== input.protocol.corpus.scenarioIds.length) throw new Error('EVALUATION_PAIRED_CORPUS_INCOMPLETE');
  const allTrials = input.runs.flatMap((run) => [...run.trials]);
  const unmeasuredMetrics: { metricId: string; missingTrialCount: number; totalTrialCount: number }[] = [];
  const metrics = input.protocol.metrics.flatMap((metric) => {
    const reader = metricReader(metric.id);
    const missingTrialCount = allTrials.filter((trial) => reader(trial.report) === null).length;
    if (missingTrialCount > 0) {
      unmeasuredMetrics.push({ metricId: metric.id, missingTrialCount, totalTrialCount: allTrials.length });
      return [];
    }
    return [summarizeMetric(metric, collectMetricSamples({ runs: input.runs, metric, baselineCandidateId, candidateId }))];
  });
  const tierStatistics = (tier: EvaluationMetricTier): EvaluationTierStatistics => {
    const tierMetrics = metrics.filter((metric) => metric.metric.tier === tier);
    const regressed = tier === 'correctness_reliability'
      ? tierMetrics.some((metric) => metric.directionalRegressionCount > 0
        || metric.newlyIntroducedFailureCount > 0 || metric.newlyIntroducedTimeoutCount > 0)
      : tierMetrics.some((metric) => metric.aggregateRegression);
    return {
      tier,
      status: regressed ? 'regressed' : tierMetrics.length === 0
        || input.protocol.metrics.some((metric) => metric.tier === tier && unmeasuredMetrics.some((entry) => entry.metricId === metric.id))
        ? 'informational' : 'passed',
      metrics: tierMetrics,
    };
  };
  const tiers: Record<EvaluationMetricTier, EvaluationTierStatistics> = {
    correctness_reliability: tierStatistics('correctness_reliability'),
    execution_quality: tierStatistics('execution_quality'),
    efficiency: tierStatistics('efficiency'),
    performance: tierStatistics('performance'),
  };
  const blockingMetrics = metrics.filter((metric) => metric.blockingRegression).map((metric) => metric.metric.id).sort();
  const taskMetric = metrics.find((metric) => metric.metric.id === 'task_correctness');
  const introducedFailures = taskMetric?.newlyIntroducedFailureCount ?? Math.max(...metrics.map((metric) => metric.newlyIntroducedFailureCount), 0);
  const introducedTimeouts = taskMetric?.newlyIntroducedTimeoutCount ?? Math.max(...metrics.map((metric) => metric.newlyIntroducedTimeoutCount), 0);
  const verdictStatus: CrossVersionPairedStatistics['verdict']['status'] = blockingMetrics.length > 0
    ? 'blocked_by_correctness_reliability'
    : unmeasuredMetrics.length > 0 ? 'inconclusive_missing_metrics' : 'eligible_for_superiority_assessment';
  return Object.freeze({
    schemaVersion: 'forge-cross-version-paired-statistics/v1',
    authority: CROSS_VERSION_EVALUATION_AUTHORITY,
    protocolDigest: input.protocol.protocolDigest,
    environmentFingerprint: first.environmentFingerprint,
    baselineCandidateId,
    candidateId,
    pairCount: allTrials.length / 2,
    unmeasuredMetrics,
    tiers,
    verdict: {
      status: verdictStatus,
      blockingMetricIds: blockingMetrics,
      newlyIntroducedFailureCount: introducedFailures,
      newlyIntroducedTimeoutCount: introducedTimeouts,
    },
  });
}
