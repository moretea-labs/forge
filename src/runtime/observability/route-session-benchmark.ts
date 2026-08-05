export const ROUTE_SESSION_BENCHMARK_PHASES = [
  'wallClockMs',
  'queueTimeMs',
  'lockWaitMs',
  'storageTimeMs',
  'gitObservationMs',
  'workerProcessMs',
  'executionTimeMs',
  'projectionMs',
  'serializationMs',
] as const;

export type RouteSessionBenchmarkPhase = (typeof ROUTE_SESSION_BENCHMARK_PHASES)[number];
export type RouteSessionBenchmarkOutcome = 'success' | 'timeout' | 'contention' | 'failed';
export type RouteSessionBenchmarkPhases = Record<RouteSessionBenchmarkPhase, number>;

export interface RouteSessionBenchmarkSample {
  phases: RouteSessionBenchmarkPhases;
  outcome: RouteSessionBenchmarkOutcome;
}

export interface RouteSessionPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

export interface RouteSessionScenarioSummary {
  samples: number;
  phases: Record<RouteSessionBenchmarkPhase, RouteSessionPercentiles>;
  successRate: number;
  timeoutRate: number;
  contentionRate: number;
  failureRate: number;
  derivedThresholds: Record<RouteSessionBenchmarkPhase, number>;
}

export const ROUTE_SESSION_FINAL_BASELINE_MIN_SAMPLES = 20;
export const ROUTE_SESSION_THRESHOLD_POLICY = 'max(1ms, observed p99 * 1.25, observed p95 * 1.5)';

export function emptyRouteSessionBenchmarkPhases(): RouteSessionBenchmarkPhases {
  return Object.fromEntries(
    ROUTE_SESSION_BENCHMARK_PHASES.map((phase) => [phase, 0]),
  ) as RouteSessionBenchmarkPhases;
}

export function routeSessionPercentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error(`ROUTE_SESSION_PERCENTILE_INVALID: ${fraction}`);
  }
  const sorted = values.map((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`ROUTE_SESSION_SAMPLE_INVALID: ${value}`);
    }
    return value;
  }).sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]! * 100) / 100;
}

export function deriveRouteSessionThreshold(values: number[]): number {
  const p95 = routeSessionPercentile(values, 0.95);
  const p99 = routeSessionPercentile(values, 0.99);
  return Math.max(1, Math.ceil(Math.max(p99 * 1.25, p95 * 1.5)));
}

function rate(samples: RouteSessionBenchmarkSample[], outcome: RouteSessionBenchmarkOutcome): number {
  if (samples.length === 0) return 0;
  return Math.round(
    samples.filter((sample) => sample.outcome === outcome).length / samples.length * 10_000,
  ) / 10_000;
}

export function summarizeRouteSessionBenchmarkSamples(
  samples: RouteSessionBenchmarkSample[],
): RouteSessionScenarioSummary {
  if (samples.length === 0) throw new Error('ROUTE_SESSION_BENCHMARK_SAMPLES_REQUIRED');
  const phases = Object.fromEntries(ROUTE_SESSION_BENCHMARK_PHASES.map((phase) => {
    const values = samples.map((sample) => sample.phases[phase]);
    return [phase, {
      p50: routeSessionPercentile(values, 0.50),
      p95: routeSessionPercentile(values, 0.95),
      p99: routeSessionPercentile(values, 0.99),
    }];
  })) as Record<RouteSessionBenchmarkPhase, RouteSessionPercentiles>;
  const derivedThresholds = Object.fromEntries(
    ROUTE_SESSION_BENCHMARK_PHASES.map((phase) => [
      phase,
      deriveRouteSessionThreshold(samples.map((sample) => sample.phases[phase])),
    ]),
  ) as Record<RouteSessionBenchmarkPhase, number>;
  return {
    samples: samples.length,
    phases,
    successRate: rate(samples, 'success'),
    timeoutRate: rate(samples, 'timeout'),
    contentionRate: rate(samples, 'contention'),
    failureRate: rate(samples, 'failed'),
    derivedThresholds,
  };
}

export function assertFinalRouteSessionBaselineSampleCount(iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < ROUTE_SESSION_FINAL_BASELINE_MIN_SAMPLES) {
    throw new Error(
      `ROUTE_SESSION_BASELINE_SAMPLE_COUNT_TOO_LOW: ${iterations}; minimum ${ROUTE_SESSION_FINAL_BASELINE_MIN_SAMPLES}`,
    );
  }
}
