import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listControllerChecks, type ControllerCheck } from '../../src/cli/controller/check-runner';
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

  test('keeps heavy-check exclusivity additive to real workspace and build-cache claims', () => {
    const schedule = buildCheckExecutionSchedule({
      checks: [
        check({ id: 'package:test', source: 'package-script', command: ['bun', 'run', 'test'] }),
        check({ id: 'package:check:type', source: 'package-script', command: ['bun', 'x', 'tsc', '--noEmit'] }),
      ],
      requestedCheckIds: ['package:test', 'package:check:type'],
      repoId: 'repo-test',
      checkoutId: 'checkout-test',
    });

    expect(schedule.waves.map((wave) => wave.checkIds)).toEqual([
      ['package:test'],
      ['package:check:type'],
    ]);
    expect(schedule.conflicts).toHaveLength(1);
    expect(schedule.conflicts[0]!.resources.some(({ left, right }) =>
      left.resourceKey === 'workspace:checkout-test'
      && right.resourceKey === 'workspace:checkout-test')).toBe(true);
    expect(schedule.conflicts[0]!.resources.some(({ left, right }) =>
      left.resourceKey === 'build-cache:repo-test'
      && right.resourceKey === 'build-cache:repo-test')).toBe(true);
  });

  test('allows proven isolated read-only benchmarks to overlap static analysis', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-check-effects-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: {
          'check:type': 'bun x tsc --noEmit',
          'check:typescript-navigation': 'bun scripts/benchmark-typescript-navigation.ts',
        },
      }));
      const checks = listControllerChecks(root);
      const schedule = buildCheckExecutionSchedule({
        checks,
        requestedCheckIds: ['package:check:type', 'package:check:typescript-navigation'],
        repoId: 'repo-test',
        checkoutId: 'checkout-test',
      });

      expect(schedule.waves).toEqual([{
        wave: 1,
        checkIds: ['package:check:type', 'package:check:typescript-navigation'],
        parallelSafe: true,
      }]);
      expect(schedule.conflicts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('declares governed task/main gates as source-read-only while release remains conservative', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-governed-gate-effects-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: {
          'check:task': 'bun scripts/run-governed-gate.ts task',
          'check:main': 'bun scripts/run-governed-gate.ts main',
          'check:release': 'bun scripts/run-governed-gate.ts release',
        },
      }));
      const checks = listControllerChecks(root);
      const byId = new Map(checks.map((entry) => [entry.id, entry]));
      const governedEffects = { reads: ['.'], cache: 'write' as const, temp: 'isolated' as const, git: 'read' as const };
      expect(byId.get('package:check:task')?.effects).toEqual(governedEffects);
      expect(byId.get('package:check:main')?.effects).toEqual(governedEffects);
      expect(byId.get('package:check:release')?.effects).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
