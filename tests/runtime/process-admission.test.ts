import { describe, expect, test } from 'bun:test';
import { durationAwareInteractiveWaitMs } from '../../src/runtime/execution/process-runtime/interactive-admission';

describe('duration-aware Process admission', () => {
  test('gives synchronous remote callers a tiny completion grace for non-trivial commands', () => {
    expect(durationAwareInteractiveWaitMs(['bun', 'test'], undefined)).toBe(100);
    expect(durationAwareInteractiveWaitMs(['bash', '-lc', 'bun run check:task'], undefined)).toBe(100);
    expect(durationAwareInteractiveWaitMs('bun run check:task', undefined)).toBe(100);
  });

  test('keeps the larger primitive window and preserves explicit caller choices', () => {
    expect(durationAwareInteractiveWaitMs(['/usr/bin/true'], undefined)).toBe(250);
    expect(durationAwareInteractiveWaitMs(['echo', 'ok'], undefined)).toBe(250);
    expect(durationAwareInteractiveWaitMs(['bun', 'test'], 700)).toBe(700);
    expect(durationAwareInteractiveWaitMs(['bun', 'test'], 0)).toBe(0);
  });
});
