import { createHash } from 'node:crypto';

export const OPERATIONAL_MEMORY_ACTIVATION_EVALUATOR_VERSION = 'forge-operational-memory-activation/v1' as const;
export const OPERATIONAL_MEMORY_ACTIVATION_THRESHOLD_SET_ID = 'forge-operational-memory-activation-thresholds/v1' as const;
export const OPERATIONAL_MEMORY_ACTIVATION_SCENARIOS = Object.freeze([
  'check-grace-eligible-150ms',
  'check-grace-eligible-180ms',
  'check-grace-guard-400ms',
] as const);

export const OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS = Object.freeze({
  maxEligibleTerminalLatencyRatio: 1.05,
  maxGuardTerminalLatencyRatio: 1.15,
  maxMemoryLookupMs: 40,
  maxMemoryRecordBytes: 8 * 1024,
  maxControllerMemoryPayloadBytes: 0,
  requireEligibleRoundTripReduction: true,
  requiredLearnedWaitMs: 250,
  canonicalWaitMs: 100,
});

export interface OperationalMemoryActivationMeasurement {
  toolRoundTrips: number;
  firstReturnMs: number;
  terminalLatencyMs: number;
  completedInOrigin: boolean;
  controllerVisibleBytes: number;
  controllerMemoryPayloadBytes: number;
  memoryLookupMs: number;
  memoryRecordBytes: number;
  appliedWaitMs: number;
  learnedWaitMs?: number;
  correctnessPassed: boolean;
}

export interface OperationalMemoryActivationPair {
  scenarioId: string;
  kind: 'eligible' | 'guard';
  candidateIdentity: string;
  cold: OperationalMemoryActivationMeasurement;
  active: OperationalMemoryActivationMeasurement;
}

export interface FrozenOperationalMemoryActivationProtocol {
  evaluatorVersion: typeof OPERATIONAL_MEMORY_ACTIVATION_EVALUATOR_VERSION;
  thresholdSetId: typeof OPERATIONAL_MEMORY_ACTIVATION_THRESHOLD_SET_ID;
  candidateIdentity: string;
  heldOutScenarioIds: readonly string[];
  protocolDigest: string;
}

export interface OperationalMemoryActivationReport {
  schemaVersion: 1;
  protocolDigest: string;
  candidateIdentity: string;
  scenarioCount: number;
  eligibleCount: number;
  guardCount: number;
  correctnessRegressionCount: number;
  eligibleMeans: {
    coldToolRoundTrips: number;
    activeToolRoundTrips: number;
    coldTerminalLatencyMs: number;
    activeTerminalLatencyMs: number;
    activeMemoryLookupMs: number;
    activeMemoryRecordBytes: number;
    activeControllerMemoryPayloadBytes: number;
  };
  ratios: {
    eligibleToolRoundTrips: number;
    eligibleTerminalLatency: number;
    eligibleControllerVisibleBytes: number;
    guardTerminalLatency: number;
  };
  eligibleOriginCompletionPassed: boolean;
  eligibleLearnedWaitPassed: boolean;
  guardCanonicalFallbackPassed: boolean;
  memoryBudgetPassed: boolean;
  strictRoundTripImprovement: boolean;
  passed: boolean;
}

function identity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`OPERATIONAL_MEMORY_ACTIVATION_INVALID_${field.toUpperCase()}`);
  return normalized;
}

function metric(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`OPERATIONAL_MEMORY_ACTIVATION_METRIC_REQUIRED:${field}`);
  }
  return value;
}

function measurement(value: OperationalMemoryActivationMeasurement, prefix: string): OperationalMemoryActivationMeasurement {
  return {
    toolRoundTrips: metric(value.toolRoundTrips, `${prefix}.toolRoundTrips`),
    firstReturnMs: metric(value.firstReturnMs, `${prefix}.firstReturnMs`),
    terminalLatencyMs: metric(value.terminalLatencyMs, `${prefix}.terminalLatencyMs`),
    completedInOrigin: typeof value.completedInOrigin === 'boolean' ? value.completedInOrigin : (() => { throw new Error(`OPERATIONAL_MEMORY_ACTIVATION_METRIC_REQUIRED:${prefix}.completedInOrigin`); })(),
    controllerVisibleBytes: metric(value.controllerVisibleBytes, `${prefix}.controllerVisibleBytes`),
    controllerMemoryPayloadBytes: metric(value.controllerMemoryPayloadBytes, `${prefix}.controllerMemoryPayloadBytes`),
    memoryLookupMs: metric(value.memoryLookupMs, `${prefix}.memoryLookupMs`),
    memoryRecordBytes: metric(value.memoryRecordBytes, `${prefix}.memoryRecordBytes`),
    appliedWaitMs: metric(value.appliedWaitMs, `${prefix}.appliedWaitMs`),
    ...(value.learnedWaitMs === undefined ? {} : { learnedWaitMs: metric(value.learnedWaitMs, `${prefix}.learnedWaitMs`) }),
    correctnessPassed: typeof value.correctnessPassed === 'boolean' ? value.correctnessPassed : (() => { throw new Error(`OPERATIONAL_MEMORY_ACTIVATION_METRIC_REQUIRED:${prefix}.correctnessPassed`); })(),
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(active: number, cold: number): number {
  return cold === 0 ? (active === 0 ? 1 : Number.POSITIVE_INFINITY) : active / cold;
}

export function freezeOperationalMemoryActivationProtocol(input: {
  candidateIdentity: string;
  heldOutScenarioIds?: readonly string[];
}): FrozenOperationalMemoryActivationProtocol {
  const candidateIdentity = identity(input.candidateIdentity, 'candidate_identity');
  const ids = [...new Set((input.heldOutScenarioIds ?? OPERATIONAL_MEMORY_ACTIVATION_SCENARIOS).map((value) => identity(value, 'scenario_id')))].sort();
  const required = [...OPERATIONAL_MEMORY_ACTIVATION_SCENARIOS].sort();
  if (JSON.stringify(ids) !== JSON.stringify(required)) throw new Error('OPERATIONAL_MEMORY_ACTIVATION_HELDOUT_SET_MISMATCH');
  const core = {
    evaluatorVersion: OPERATIONAL_MEMORY_ACTIVATION_EVALUATOR_VERSION,
    thresholdSetId: OPERATIONAL_MEMORY_ACTIVATION_THRESHOLD_SET_ID,
    candidateIdentity,
    heldOutScenarioIds: ids,
  } as const;
  return Object.freeze({
    ...core,
    heldOutScenarioIds: Object.freeze(ids),
    protocolDigest: createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 24),
  });
}

export function evaluateOperationalMemoryActivation(
  protocol: FrozenOperationalMemoryActivationProtocol,
  pairs: readonly OperationalMemoryActivationPair[],
): OperationalMemoryActivationReport {
  if (protocol.evaluatorVersion !== OPERATIONAL_MEMORY_ACTIVATION_EVALUATOR_VERSION
    || protocol.thresholdSetId !== OPERATIONAL_MEMORY_ACTIVATION_THRESHOLD_SET_ID) {
    throw new Error('OPERATIONAL_MEMORY_ACTIVATION_PROTOCOL_VERSION_MISMATCH');
  }
  const expected = [...protocol.heldOutScenarioIds].sort();
  const actual = [...new Set(pairs.map((pair) => identity(pair.scenarioId, 'scenario_id')))].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || pairs.length !== expected.length) {
    throw new Error('OPERATIONAL_MEMORY_ACTIVATION_PAIR_SET_MISMATCH');
  }
  const validated = pairs.map((pair) => {
    if (pair.candidateIdentity !== protocol.candidateIdentity) throw new Error('OPERATIONAL_MEMORY_ACTIVATION_CANDIDATE_MISMATCH');
    return {
      ...pair,
      cold: measurement(pair.cold, `${pair.scenarioId}.cold`),
      active: measurement(pair.active, `${pair.scenarioId}.active`),
    };
  });
  const eligible = validated.filter((pair) => pair.kind === 'eligible');
  const guard = validated.filter((pair) => pair.kind === 'guard');
  if (eligible.length !== 2 || guard.length !== 1) throw new Error('OPERATIONAL_MEMORY_ACTIVATION_COVERAGE_MISMATCH');

  const eligibleMeans = {
    coldToolRoundTrips: mean(eligible.map((pair) => pair.cold.toolRoundTrips)),
    activeToolRoundTrips: mean(eligible.map((pair) => pair.active.toolRoundTrips)),
    coldTerminalLatencyMs: mean(eligible.map((pair) => pair.cold.terminalLatencyMs)),
    activeTerminalLatencyMs: mean(eligible.map((pair) => pair.active.terminalLatencyMs)),
    activeMemoryLookupMs: mean(eligible.map((pair) => pair.active.memoryLookupMs)),
    activeMemoryRecordBytes: mean(eligible.map((pair) => pair.active.memoryRecordBytes)),
    activeControllerMemoryPayloadBytes: mean(eligible.map((pair) => pair.active.controllerMemoryPayloadBytes)),
  };
  const guardColdLatency = mean(guard.map((pair) => pair.cold.terminalLatencyMs));
  const guardActiveLatency = mean(guard.map((pair) => pair.active.terminalLatencyMs));
  const ratios = {
    eligibleToolRoundTrips: ratio(eligibleMeans.activeToolRoundTrips, eligibleMeans.coldToolRoundTrips),
    eligibleTerminalLatency: ratio(eligibleMeans.activeTerminalLatencyMs, eligibleMeans.coldTerminalLatencyMs),
    eligibleControllerVisibleBytes: ratio(
      mean(eligible.map((pair) => pair.active.controllerVisibleBytes)),
      mean(eligible.map((pair) => pair.cold.controllerVisibleBytes)),
    ),
    guardTerminalLatency: ratio(guardActiveLatency, guardColdLatency),
  };
  const correctnessRegressionCount = validated.filter((pair) => pair.cold.correctnessPassed && !pair.active.correctnessPassed).length;
  const eligibleOriginCompletionPassed = eligible.every((pair) => !pair.cold.completedInOrigin && pair.active.completedInOrigin);
  const eligibleLearnedWaitPassed = eligible.every((pair) =>
    pair.active.learnedWaitMs === OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.requiredLearnedWaitMs
    && pair.active.appliedWaitMs === OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.requiredLearnedWaitMs);
  const guardCanonicalFallbackPassed = guard.every((pair) =>
    pair.active.learnedWaitMs === undefined
    && pair.active.appliedWaitMs === OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.canonicalWaitMs
    && pair.active.toolRoundTrips === pair.cold.toolRoundTrips);
  const memoryBudgetPassed = validated.every((pair) =>
    pair.active.memoryLookupMs <= OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.maxMemoryLookupMs
    && pair.active.memoryRecordBytes <= OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.maxMemoryRecordBytes
    && pair.active.controllerMemoryPayloadBytes <= OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.maxControllerMemoryPayloadBytes);
  const strictRoundTripImprovement = eligibleMeans.activeToolRoundTrips < eligibleMeans.coldToolRoundTrips;
  const passed = correctnessRegressionCount === 0
    && eligibleOriginCompletionPassed
    && eligibleLearnedWaitPassed
    && guardCanonicalFallbackPassed
    && memoryBudgetPassed
    && ratios.eligibleToolRoundTrips < 1
    && ratios.eligibleTerminalLatency <= OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.maxEligibleTerminalLatencyRatio
    && ratios.eligibleControllerVisibleBytes <= 1
    && ratios.guardTerminalLatency <= OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.maxGuardTerminalLatencyRatio
    && (!OPERATIONAL_MEMORY_ACTIVATION_THRESHOLDS.requireEligibleRoundTripReduction || strictRoundTripImprovement);
  return {
    schemaVersion: 1,
    protocolDigest: protocol.protocolDigest,
    candidateIdentity: protocol.candidateIdentity,
    scenarioCount: validated.length,
    eligibleCount: eligible.length,
    guardCount: guard.length,
    correctnessRegressionCount,
    eligibleMeans,
    ratios,
    eligibleOriginCompletionPassed,
    eligibleLearnedWaitPassed,
    guardCanonicalFallbackPassed,
    memoryBudgetPassed,
    strictRoundTripImprovement,
    passed,
  };
}
