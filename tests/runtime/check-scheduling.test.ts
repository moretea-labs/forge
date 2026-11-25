import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listControllerChecks, type ControllerCheck } from '../../src/runtime/execution/process-runtime/check-runner';
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
        check({
          id: 'package:check:mcp-compatibility',
          source: 'package-script',
          command: ['bun', 'run', 'check:mcp-compatibility'],
        }),
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
    expect(
      schedule.conflicts[0]!.resources.some(
        ({ left, right }) =>
          left.resourceKey === 'build-cache:repo-test' &&
          right.resourceKey === 'build-cache:repo-test' &&
          left.mode === 'write' &&
          right.mode === 'write',
      ),
    ).toBe(true);
    expect(schedule.guidance[0]).toContain('waves in order');
  });

  test('serializes competing checks on the build cache without the retired checkout-wide read lease (#713)', () => {
    const schedule = buildCheckExecutionSchedule({
      checks: [
        check({ id: 'package:test', source: 'package-script', command: ['bun', 'run', 'test'] }),
        check({ id: 'package:check:type', source: 'package-script', command: ['bun', 'x', 'tsc', '--noEmit'] }),
      ],
      requestedCheckIds: ['package:test', 'package:check:type'],
      repoId: 'repo-test',
      checkoutId: 'checkout-test',
    });

    expect(schedule.waves.map((wave) => wave.checkIds)).toEqual([['package:test'], ['package:check:type']]);
    expect(schedule.conflicts).toHaveLength(1);
    expect(
      schedule.conflicts[0]!.resources.some(
        ({ left, right }) =>
          left.resourceKey === 'workspace:checkout-test' || right.resourceKey === 'workspace:checkout-test',
      ),
    ).toBe(false);
    expect(
      schedule.conflicts[0]!.resources.some(
        ({ left, right }) =>
          left.resourceKey === 'build-cache:repo-test' && right.resourceKey === 'build-cache:repo-test',
      ),
    ).toBe(true);
  });

  test('serializes compiler-intensive TypeScript latency gates even when both are source-read-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-check-effects-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          scripts: {
            'check:type': 'bun x tsc --noEmit',
            'check:typescript-navigation': 'bun scripts/benchmark-typescript-navigation.ts',
          },
        }),
      );
      const checks = listControllerChecks(root);
      const schedule = buildCheckExecutionSchedule({
        checks,
        requestedCheckIds: ['package:check:type', 'package:check:typescript-navigation'],
        repoId: 'repo-test',
        checkoutId: 'checkout-test',
      });

      expect(schedule.waves).toEqual([
        { wave: 1, checkIds: ['package:check:type'], parallelSafe: false },
        { wave: 2, checkIds: ['package:check:typescript-navigation'], parallelSafe: false },
      ]);
      expect(schedule.conflicts).toHaveLength(1);
      expect(schedule.conflicts[0]!.resources).toContainEqual({
        left: { resourceKey: 'heavy-check:repo-test', mode: 'exclusive' },
        right: { resourceKey: 'heavy-check:repo-test', mode: 'exclusive' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('schedules the canonical s3 verification gates in one wave from concrete effects', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-s3-check-effects-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          scripts: {
            'check:type': 'bun x tsc --noEmit',
            'check:runtime-architecture': 'node scripts/check-runtime-architecture.mjs',
            'check:check-scheduling': 'bun test tests/runtime/check-scheduling.test.ts',
          },
        }),
      );
      // Source-repository architecture policy belongs in repository config,
      // not in a global Runtime list of privileged check names.
      mkdirSync(join(root, '.forge'));
      writeFileSync(
        join(root, '.forge/checks.json'),
        JSON.stringify({
          version: 1,
          checks: {
            'package:check:runtime-architecture': {
              command: ['node', 'scripts/check-runtime-architecture.mjs'],
              effects: { reads: ['.'] },
            },
            'package:check:check-scheduling': {
              command: ['bun', 'test', 'tests/runtime/check-scheduling.test.ts'],
              effects: { reads: ['.'], temp: 'isolated', git: 'read' },
            },
          },
        }),
      );
      const checks = listControllerChecks(root);
      const requestedCheckIds = [
        'package:check:type',
        'package:check:runtime-architecture',
        'package:check:check-scheduling',
      ];
      const schedule = buildCheckExecutionSchedule({
        checks,
        requestedCheckIds,
        repoId: 'repo-test',
        checkoutId: 'checkout-test',
      });

      expect(schedule.waves).toEqual([{ wave: 1, checkIds: requestedCheckIds, parallelSafe: true }]);
      expect(schedule.conflicts).toEqual([]);
      expect(schedule.maxParallel).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not infer Forge repository gate effects in generic package scripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-governed-gate-effects-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          scripts: {
            'check:task': 'bun scripts/run-governed-gate.ts task',
            'check:main': 'bun scripts/run-governed-gate.ts main',
            'check:release': 'bun scripts/run-governed-gate.ts release',
          },
        }),
      );
      const checks = listControllerChecks(root);
      const byId = new Map(checks.map((entry) => [entry.id, entry]));
      expect(byId.get('package:check:task')?.effects).toBeUndefined();
      expect(byId.get('package:check:main')?.effects).toBeUndefined();
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
