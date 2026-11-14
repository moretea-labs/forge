import { describe, expect, test } from 'bun:test';
import { percentile } from '../../scripts/benchmark-computer-hotpath';

describe('Computer hot-path benchmark percentile', () => {
  test('uses nearest-rank p50 and p95 for an even sample count', () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(samples, 0.5)).toBe(10);
    expect(percentile(samples, 0.95)).toBe(19);
  });

  test('uses nearest-rank p50 and p95 for the default 50 samples', () => {
    const samples = Array.from({ length: 50 }, (_, index) => index + 1);
    expect(percentile(samples, 0.5)).toBe(25);
    expect(percentile(samples, 0.95)).toBe(48);
  });

  test('sorts samples before selecting the nearest rank', () => {
    expect(percentile([9, 1, 5, 3, 7], 0.5)).toBe(5);
  });

  test('returns zero for an empty sample set', () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});
