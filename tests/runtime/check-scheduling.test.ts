import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listControllerChecks, type ControllerCheck } from '../../src/cli/controller/check-runner';
import { executeRepositoryReadOnlyCommandDirect } from '../../src/cli/repositories/command-executor';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
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
          'check:quality-harness': 'bun scripts/benchmark-quality-harness.ts',
          'check:background-check-overlap': 'bun scripts/benchmark-background-check-overlap.ts',
        },
      }));
      const checks = listControllerChecks(root);
      const schedule = buildCheckExecutionSchedule({
        checks,
        requestedCheckIds: ['package:check:type', 'package:check:quality-harness', 'package:check:background-check-overlap'],
        repoId: 'repo-test',
        checkoutId: 'checkout-test',
      });

      expect(schedule.waves).toEqual([{
        wave: 1,
        checkIds: ['package:check:type', 'package:check:quality-harness', 'package:check:background-check-overlap'],
        parallelSafe: true,
      }]);
      expect(schedule.conflicts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps readonly repository commands available above the write-path dirty fingerprint cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-readonly-command-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'readonly@example.test'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Readonly Test'], { cwd: root });
      writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
      for (let index = 0; index < 205; index += 1) writeFileSync(join(root, `dirty-${index}.txt`), `${index}\n`);

      const now = new Date().toISOString();
      const repository: RepositoryRecord = {
        schemaVersion: 1,
        repoId: 'repo-readonly-test',
        displayName: 'readonly-test',
        localRoot: root,
        canonicalRoot: root,
        activeCheckoutId: 'checkout-readonly-test',
        checkouts: [{ checkoutId: 'checkout-readonly-test', localRoot: root, canonicalRoot: root, worktree: false, branch: 'main', createdAt: now, updatedAt: now, lastSeenAt: now }],
        defaultBranch: 'main',
        repositoryType: 'git',
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        configurationPath: join(root, '.forge', 'repository.json'),
        stateStorageStrategy: 'controller-home',
      };

      const result = await executeRepositoryReadOnlyCommandDirect(repository, {
        command: ['git', 'status', '--short'],
        timeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);
      expect(result.classification.risk).toBe('readonly');
      expect(result.before.paths.length).toBe(205);
      expect(Object.keys(result.before.pathFingerprints)).toHaveLength(0);
      expect(result.repositoryChanged).toBe(false);
      expect(result.changedPaths).toEqual([]);
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
