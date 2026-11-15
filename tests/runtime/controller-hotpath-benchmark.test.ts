import { describe, expect, test } from 'bun:test';
import { duration } from '../../scripts/benchmark-controller-hotpath';

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
