import { describe, expect, test } from 'bun:test';
import type { ControllerCheck } from '../../src/cli/controller/check-runner';
import { buildCheckExecutionSchedule } from '../../src/runtime/execution/process-runtime/check-scheduling';

function check(input: Partial<ControllerCheck> & Pick<ControllerCheck, 'id'>): ControllerCheck {
  return {
    id: input.id,
    description: input.description ?? input.id,
    command: input.command ?? ['bun', 'test'],
    cwd: input.cwd ?? '.',
    timeoutMs: input.timeoutMs ?? 10_000,
    source: input.source ?? 'repo-config',
    effects: input.effects,
  };
}

describe('check execution scheduling', () => {
  test('serializes static checks that both write the repository build cache', () => {
    const schedule = buildCheckExecutionSchedule({
      checks: [
        check({ id: 'package:check:type', source: 'package-script', command: ['bun', 'x', 'tsc', '--noEmit'] }),
        check({ id: 'package:check:mcp-compatibility', source: 'package-script', command: ['bun', 'run', 'check:mcp-compatibility'] }),
      ],
      requestedCheckIds: ['package:check:type', 'package:check:mcp-compatibility'],
      repoId: 'repo-test',
      checkoutId: 'checkout-test',
    });

    expect(schedule.waves.map((wave) => wave.checkIds)).toEqual([
      ['package:check:type'],
      ['package:check:mcp-compatibility'],
    ]);
    expect(schedule.conflicts).toHaveLength(1);
    expect(schedule.conflicts[0]!.resources.some(({ left, right }) =>
      left.resourceKey === 'build-cache:repo-test'
      && right.resourceKey === 'build-cache:repo-test'
      && left.mode === 'write'
      && right.mode === 'write')).toBe(true);
    expect(schedule.guidance[0]).toContain('waves in order');
  });

  test('places disjoint explicitly read-only path checks in one parallel-safe wave', () => {
    const schedule = buildCheckExecutionSchedule({
      checks: [
        check({ id: 'check-a', effects: { reads: ['src/a'] }, command: ['tool-a'] }),
        check({ id: 'check-b', effects: { reads: ['src/b'] }, command: ['tool-b'] }),
      ],
      requestedCheckIds: ['check-a', 'check-b'],
      repoId: 'repo-test',
      checkoutId: 'checkout-test',
    });

    expect(schedule.waves).toEqual([{ wave: 1, checkIds: ['check-a', 'check-b'], parallelSafe: true }]);
    expect(schedule.conflicts).toEqual([]);
    expect(schedule.maxParallel).toBe(2);
  });
});
