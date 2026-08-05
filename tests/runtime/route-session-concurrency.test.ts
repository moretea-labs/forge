import { describe, expect, test } from 'bun:test';
import {
  ROUTE_SESSION_BENCHMARK_PHASES,
  ROUTE_SESSION_FINAL_BASELINE_MIN_SAMPLES,
  assertFinalRouteSessionBaselineSampleCount,
  deriveRouteSessionThreshold,
  emptyRouteSessionBenchmarkPhases,
  summarizeRouteSessionBenchmarkSamples,
  type RouteSessionBenchmarkSample,
} from '../../src/runtime/observability/route-session-benchmark';

describe('route/session concurrency benchmark governance', () => {
  test('defines every required independently reported phase', () => {
    expect(ROUTE_SESSION_BENCHMARK_PHASES).toEqual([
      'wallClockMs',
      'queueTimeMs',
      'lockWaitMs',
      'storageTimeMs',
      'gitObservationMs',
      'workerProcessMs',
      'executionTimeMs',
      'projectionMs',
      'serializationMs',
    ]);
    expect(Object.keys(emptyRouteSessionBenchmarkPhases())).toEqual([...ROUTE_SESSION_BENCHMARK_PHASES]);
  });

  test('summarizes measured percentiles and outcome rates without invented constants', () => {
    const samples: RouteSessionBenchmarkSample[] = [
      { phases: { ...emptyRouteSessionBenchmarkPhases(), wallClockMs: 10, executionTimeMs: 4 }, outcome: 'success' },
      { phases: { ...emptyRouteSessionBenchmarkPhases(), wallClockMs: 20, executionTimeMs: 8 }, outcome: 'success' },
      { phases: { ...emptyRouteSessionBenchmarkPhases(), wallClockMs: 40, executionTimeMs: 16 }, outcome: 'contention' },
      { phases: { ...emptyRouteSessionBenchmarkPhases(), wallClockMs: 80, executionTimeMs: 32 }, outcome: 'timeout' },
    ];
    const summary = summarizeRouteSessionBenchmarkSamples(samples);
    expect(summary.phases.wallClockMs).toEqual({ p50: 20, p95: 80, p99: 80 });
    expect(summary.phases.executionTimeMs).toEqual({ p50: 8, p95: 32, p99: 32 });
    expect(summary.successRate).toBe(0.5);
    expect(summary.contentionRate).toBe(0.25);
    expect(summary.timeoutRate).toBe(0.25);
    expect(summary.failureRate).toBe(0);
    expect(summary.derivedThresholds.wallClockMs).toBe(120);
    expect(summary.derivedThresholds.executionTimeMs).toBe(48);
  });

  test('derives thresholds from observed p95 and p99 and rejects invalid samples', () => {
    expect(deriveRouteSessionThreshold([1, 2, 3, 4])).toBe(6);
    expect(() => deriveRouteSessionThreshold([1, -1])).toThrow('ROUTE_SESSION_SAMPLE_INVALID');
    expect(() => summarizeRouteSessionBenchmarkSamples([])).toThrow('ROUTE_SESSION_BENCHMARK_SAMPLES_REQUIRED');
  });

  test('requires enough observations before writing a final governance baseline', () => {
    expect(() => assertFinalRouteSessionBaselineSampleCount(ROUTE_SESSION_FINAL_BASELINE_MIN_SAMPLES - 1))
      .toThrow('ROUTE_SESSION_BASELINE_SAMPLE_COUNT_TOO_LOW');
    expect(() => assertFinalRouteSessionBaselineSampleCount(ROUTE_SESSION_FINAL_BASELINE_MIN_SAMPLES)).not.toThrow();
  });
});
