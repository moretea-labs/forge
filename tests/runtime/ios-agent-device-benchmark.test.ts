import { describe, expect, it } from 'bun:test';
import {
  compareProfileReports,
  percentile,
  summarize,
  summarizeProfileSamples,
  type IosBenchmarkProfileReport,
  type IosBenchmarkSample,
} from '../../scripts/benchmark-ios-agent-device';

describe('iOS agent-device benchmark statistics', () => {
  it('interpolates percentiles deterministically without mutating input', () => {
    const values = [40, 10, 30, 20];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(25);
    expect(percentile(values, 0.95)).toBeCloseTo(38.5, 8);
    expect(percentile(values, 1)).toBe(40);
    expect(values).toEqual([40, 10, 30, 20]);
  });

  it('reports bounded p50 and p95 summaries and handles empty samples', () => {
    expect(summarize([])).toEqual({ count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 });
    expect(summarize([100, 200, 300, 400])).toEqual({
      count: 4,
      min: 100,
      p50: 250,
      p95: 385,
      max: 400,
      mean: 250,
    });
  });
});


describe('iOS benchmark phase telemetry', () => {
  it('summarizes sparse phase timing samples without fabricating missing values', () => {
    const values = [12.5, 7.5, 10];
    const summary = summarize(values);
    expect(summary.count).toBe(3);
    expect(summary.min).toBe(7.5);
    expect(summary.p50).toBe(10);
    expect(summary.max).toBe(12.5);
  });

  it('reports warm-path invariants and excludes warmup from measured summaries', () => {
    const sample = (index: number, warmup: boolean, totalMs: number): IosBenchmarkSample => ({
      index,
      warmup,
      profile: 'reused_session',
      totalMs,
      harnessOverheadMs: 2,
      tier: 'exact_wait',
      sessionReused: true,
      sessionKept: true,
      screenshotCaptured: false,
      deviceInventoryRequests: 0,
      accessibilitySnapshotRequests: 0,
      nativeBatchRequests: 1,
      nativeBatchSteps: 3,
      staleRefRecovery: false,
      exactWaitFallback: false,
      runnerRoundTrips: 1,
      providerWallClockMs: totalMs - 2,
      phaseTimingsMs: { interactionAndEvidence: totalMs - 3, total: totalMs - 2 },
    });
    const measured = summarizeProfileSamples([
      sample(0, true, 999),
      sample(1, false, 100),
      sample(2, false, 120),
      sample(3, false, 110),
    ]);

    expect(measured.totalMs).toEqual({ count: 3, min: 100, p50: 110, p95: 119, max: 120, mean: 110 });
    expect(measured.invariants).toEqual({
      allSessionsReused: true,
      allScreenshotsSkipped: true,
      allInventorySkipped: true,
      maxNativeBatchRequests: 1,
    });
  });

  it('compares fresh and reused p50/p95 without mixing one-time warm setup costs', () => {
    const report = (
      profile: 'fresh_session' | 'reused_session',
      p50: number,
      p95: number,
    ): IosBenchmarkProfileReport => ({
      profile,
      warmupCount: 1,
      measuredRunCount: 3,
      measured: { totalMs: { count: 3, min: p50, p50, p95, max: p95, mean: p50 } },
      samples: [],
    });
    expect(compareProfileReports(
      report('fresh_session', 800, 1000),
      report('reused_session', 200, 250),
    )).toMatchObject({
      p50SavedMs: 600,
      p95SavedMs: 750,
      p50Speedup: 4,
      p95Speedup: 4,
    });
  });
});
