import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertFrozenCrossVersionAuthority } from '../lib/calibration.ts';
import { evaluationScenarioDigest, loadScenario } from '../lib/scenario.ts';

export const SUPPLEMENTAL_POSTHOC_SCHEMA = 'forge-supplemental-posthoc/v1' as const;

export type SupplementalMetricId =
  | 'task_correctness'
  | 'behavioral_invariant_success'
  | 'regression_reintroduction_rate'
  | 'impact_coverage'
  | 'change_precision';

interface ScenarioMeasurementContract {
  applicableMetrics: SupplementalMetricId[] | string[];
  behavioralInvariantValidatorIds: string[];
  regressionGuardValidatorIds: string[];
  domainCoverage: Array<{ domain: string; validatorIds: string[] }>;
}

interface MeasurementContractFile {
  schemaVersion: string;
  sourceProtocolDigest: string;
  scenarios: Record<string, ScenarioMeasurementContract>;
}

interface ValidationRecord { id: string; status: string }
interface FormalTrial {
  cacheMode: string;
  repetition: number;
  candidateIndex: number;
  runIdentity: { candidate: { candidateId: string } };
  report: {
    metrics: {
      taskSuccessRate: number;
      changePrecision: number | null;
    };
    trace: { validation: ValidationRecord[] };
  };
}
interface FormalScenarioEvidence { scenarioId: string; protocolDigest: string; trials: FormalTrial[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function supplementalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function allPassed(validation: ValidationRecord[], ids: string[]): boolean {
  if (ids.length === 0) throw new Error('SUPPLEMENTAL_ORACLE_IDS_REQUIRED');
  const map = new Map(validation.map((entry) => [entry.id, entry.status]));
  for (const id of ids) {
    if (!map.has(id)) throw new Error(`SUPPLEMENTAL_ORACLE_MISSING:${id}`);
    if (map.get(id) !== 'passed') return false;
  }
  return true;
}

export function deriveSupplementalMetrics(
  trial: FormalTrial,
  contract: ScenarioMeasurementContract,
): Partial<Record<SupplementalMetricId, number>> {
  const applicable = new Set(contract.applicableMetrics);
  const result: Partial<Record<SupplementalMetricId, number>> = {};
  if (applicable.has('task_correctness')) result.task_correctness = trial.report.metrics.taskSuccessRate;
  if (applicable.has('behavioral_invariant_success')) {
    result.behavioral_invariant_success = allPassed(trial.report.trace.validation, contract.behavioralInvariantValidatorIds) ? 1 : 0;
  }
  if (applicable.has('regression_reintroduction_rate')) {
    result.regression_reintroduction_rate = allPassed(trial.report.trace.validation, contract.regressionGuardValidatorIds) ? 0 : 1;
  }
  if (applicable.has('impact_coverage')) {
    if (contract.domainCoverage.length === 0) throw new Error('SUPPLEMENTAL_DOMAIN_COVERAGE_REQUIRED');
    const passed = contract.domainCoverage.filter((domain) => allPassed(trial.report.trace.validation, domain.validatorIds)).length;
    result.impact_coverage = passed / contract.domainCoverage.length;
  }
  if (applicable.has('change_precision')) {
    if (trial.report.metrics.changePrecision === null) throw new Error('SUPPLEMENTAL_CHANGE_PRECISION_MISSING');
    result.change_precision = trial.report.metrics.changePrecision;
  }
  return result;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function analyzeFormalEvidence(input: {
  evidenceDir: string;
  repoRoot?: string;
  measurementContractPath?: string;
}) {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const protocol = assertFrozenCrossVersionAuthority(repoRoot);
  const experiment = JSON.parse(readFileSync(join(input.evidenceDir, 'experiment.json'), 'utf8')) as {
    protocol: { protocolDigest: string; corpus: { scenarioIds: string[]; scenarioDigests: Record<string, string> } };
    candidates: Array<{ identity: { candidateId: string } }>;
  };
  if (experiment.protocol.protocolDigest !== protocol.protocolDigest) throw new Error('SUPPLEMENTAL_SOURCE_PROTOCOL_DRIFT');

  const contractPath = resolve(input.measurementContractPath ?? join(repoRoot, 'evaluation/supplemental/measurement-contract.json'));
  const measurement = JSON.parse(readFileSync(contractPath, 'utf8')) as MeasurementContractFile;
  if (measurement.sourceProtocolDigest !== protocol.protocolDigest) throw new Error('SUPPLEMENTAL_MEASUREMENT_PROTOCOL_DRIFT');
  const scenarioIds = [...experiment.protocol.corpus.scenarioIds].sort();
  const contractIds = Object.keys(measurement.scenarios).sort();
  if (JSON.stringify(scenarioIds) !== JSON.stringify(contractIds)) throw new Error('SUPPLEMENTAL_MEASUREMENT_SCENARIO_SET_MISMATCH');

  const evidenceHashes: Record<string, string> = {};
  const values = new Map<SupplementalMetricId, [number[], number[]]>();
  let trialCount = 0;
  let pairCount = 0;

  for (const scenarioId of scenarioIds) {
    const scenarioPath = join(repoRoot, 'evaluation/scenarios', `${scenarioId}.json`);
    const observedDigest = evaluationScenarioDigest(loadScenario(scenarioPath));
    if (observedDigest !== experiment.protocol.corpus.scenarioDigests[scenarioId]) {
      throw new Error(`SUPPLEMENTAL_FROZEN_SCENARIO_DRIFT:${scenarioId}`);
    }
    const evidencePath = join(input.evidenceDir, `${scenarioId}.json`);
    const raw = readFileSync(evidencePath);
    evidenceHashes[scenarioId] = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const evidence = JSON.parse(raw.toString('utf8')) as FormalScenarioEvidence;
    if (evidence.protocolDigest !== protocol.protocolDigest || evidence.scenarioId !== scenarioId) throw new Error(`SUPPLEMENTAL_EVIDENCE_IDENTITY_MISMATCH:${scenarioId}`);
    const contract = measurement.scenarios[scenarioId]!;
    const pairs = new Map<string, FormalTrial[]>();
    for (const trial of evidence.trials) {
      trialCount += 1;
      const key = `${trial.cacheMode}:${trial.repetition}`;
      const list = pairs.get(key) ?? [];
      list.push(trial);
      pairs.set(key, list);
    }
    for (const [key, trials] of pairs) {
      if (trials.length !== 2) throw new Error(`SUPPLEMENTAL_PAIR_INCOMPLETE:${scenarioId}:${key}`);
      pairCount += 1;
      const byArm = trials.sort((a, b) => a.candidateIndex - b.candidateIndex);
      const metrics = byArm.map((trial) => deriveSupplementalMetrics(trial, contract));
      const supplementalApplicable: SupplementalMetricId[] = (contract.applicableMetrics as string[]).filter((metricId): metricId is SupplementalMetricId =>
        metricId === 'task_correctness' || metricId === 'behavioral_invariant_success' || metricId === 'regression_reintroduction_rate' || metricId === 'impact_coverage' || metricId === 'change_precision');
      for (const metricId of supplementalApplicable) {
        const a = metrics[0][metricId];
        const b = metrics[1][metricId];
        if ((a === undefined) !== (b === undefined)) throw new Error(`SUPPLEMENTAL_APPLICABILITY_MISMATCH:${scenarioId}:${key}:${metricId}`);
        if (a === undefined || b === undefined) throw new Error(`SUPPLEMENTAL_APPLICABLE_METRIC_MISSING:${scenarioId}:${key}:${metricId}`);
        const aggregate = values.get(metricId) ?? [[], []];
        aggregate[0].push(a); aggregate[1].push(b);
        values.set(metricId, aggregate);
      }
    }
  }

  const metrics = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([metricId, [baseline, candidate]]) => ({
    metricId,
    applicablePairCount: baseline.length,
    missingPairCount: 0,
    baselineMean: mean(baseline),
    candidateMean: mean(candidate),
    meanDeltaCandidateMinusBaseline: mean(candidate) - mean(baseline),
  }));

  return {
    schemaVersion: SUPPLEMENTAL_POSTHOC_SCHEMA,
    sourceProtocolDigest: protocol.protocolDigest,
    sourceEvidenceDigest: supplementalDigest(evidenceHashes),
    measurementContractDigest: supplementalDigest(measurement),
    scenarioCount: scenarioIds.length,
    pairCount,
    trialCount,
    baselineCandidateId: experiment.candidates[0]!.identity.candidateId,
    candidateCandidateId: experiment.candidates[1]!.identity.candidateId,
    metrics,
    verdict: metrics.every((metric) => metric.missingPairCount === 0) ? 'eligible_for_superiority_assessment' : 'inconclusive_missing_metrics',
  };
}
