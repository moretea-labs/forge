import { describe, expect, test } from 'bun:test';
import { durationAwareInteractiveWaitMs } from '../../src/runtime/execution/process-runtime/interactive-admission';

describe('duration-aware Process admission', () => {
  test('returns handles immediately for unknown and known-long commands', () => {
    expect(durationAwareInteractiveWaitMs(['bun', 'test'], undefined)).toBe(0);
    expect(durationAwareInteractiveWaitMs(['bash', '-lc', 'bun run check:task'], undefined)).toBe(0);
  });

  test('keeps a small synchronous window only for predictable primitives or an explicit caller choice', () => {
    expect(durationAwareInteractiveWaitMs(['/usr/bin/true'], undefined)).toBe(250);
    expect(durationAwareInteractiveWaitMs(['echo', 'ok'], undefined)).toBe(250);
    expect(durationAwareInteractiveWaitMs(['bun', 'test'], 700)).toBe(700);
  });
});
