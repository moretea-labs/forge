import { describe, expect, test } from 'bun:test';
import { controllerHotpathAcceptance, duration, percentile } from '../../scripts/benchmark-controller-hotpath';

describe('controller hotpath percentile ranks', () => {
  test('uses nearest-rank p50 and p95 for 20 and 50 samples', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => 20 - index);
    const fifty = Array.from({ length: 50 }, (_, index) => 50 - index);
    expect(percentile(twenty, 0.5)).toBe(10);
    expect(percentile(twenty, 0.95)).toBe(19);
    expect(percentile(fifty, 0.5)).toBe(25);
    expect(percentile(fifty, 0.95)).toBe(48);
  });

  test('rejects empty, non-finite and invalid quantile inputs', () => {
    expect(() => percentile([], 0.95)).toThrow('CONTROLLER_HOTPATH_PERCENTILE_EMPTY_SAMPLE');
    expect(() => percentile([1, Number.NaN], 0.95)).toThrow('CONTROLLER_HOTPATH_PERCENTILE_INVALID_SAMPLE');
    expect(() => percentile([1, 2], Number.NaN)).toThrow('CONTROLLER_HOTPATH_PERCENTILE_INVALID_QUANTILE');
    expect(() => percentile([1, 2], 1.1)).toThrow('CONTROLLER_HOTPATH_PERCENTILE_INVALID_QUANTILE');
  });
});

describe('controller hotpath timing integrity', () => {
  test('retains an actual server-reported duration, including zero', () => {
    expect(duration({ structuredContent: { responseMeta: { serverDurationMs: 13.5 } } }).ms).toBe(13.5);
    expect(duration({ structuredContent: { responseMeta: { serverDurationMs: 0 } } }).ms).toBe(0);
  });

  test('rejects missing and invalid time receipts rather than misreporting zero latency', () => {
    for (const result of [
      undefined,
      { structuredContent: {} },
      { structuredContent: { responseMeta: { serverDurationMs: Number.NaN } } },
      { structuredContent: { responseMeta: { serverDurationMs: -1 } } },
      { structuredContent: { responseMeta: { serverDurationMs: '3' } } },
    ]) {
      expect(() => duration(result)).toThrow('CONTROLLER_HOTPATH_SERVER_DURATION_MISSING');
    }
  });

  test('rejects failed tool responses even when they contain timing metadata', () => {
    expect(() => duration({ isError: true, structuredContent: { responseMeta: { serverDurationMs: 1 } } })).toThrow('CONTROLLER_HOTPATH_TOOL_ERROR');
    expect(() => duration({ structuredContent: { status: 'error', responseMeta: { serverDurationMs: 1 } } })).toThrow('CONTROLLER_HOTPATH_TOOL_ERROR');
  });
});

describe('controller hotpath acceptance', () => {
  const git = { identityCounters: { subprocesses: 1 }, snapshotCounters: { subprocesses: 1 }, snapshotIdentityCounters: { subprocesses: 1 } };

  test('passes valid samples within actual thresholds', () => {
    expect(controllerHotpathAcceptance([{ scale: 0, hotP95Ms: 20, maxSummaryBytes: 6400 }], git)).toMatchObject({ passed: true, failures: [] });
  });

  test('rejects a slow sample, oversized response, excessive subprocesses and missing scale data', () => {
    const failed = controllerHotpathAcceptance([{ scale: 25, hotP95Ms: 101, maxSummaryBytes: 32769 }], { ...git, identityCounters: { subprocesses: 2 } });
    expect(failed.passed).toBe(false);
    expect(failed.failures).toHaveLength(3);
    expect(controllerHotpathAcceptance([], git).passed).toBe(false);
    expect(controllerHotpathAcceptance([{ scale: 0, hotP95Ms: Number.NaN, maxSummaryBytes: 2 }], git).passed).toBe(false);
  });
});
