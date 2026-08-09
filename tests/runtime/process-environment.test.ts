import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveBunExecutable } from '../../src/runtime/shared/process-environment';
import { resolveSchedulerWorkerExecutable } from '../../src/runtime/control-plane/global-scheduler/scheduler';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('repository child process environment', () => {
  test('never treats a compiled Forge Runtime as Bun through FORGE_BUN_EXECUTABLE', () => {
    expect(resolveBunExecutable('/tmp/forge-runtime', {
      FORGE_BUN_EXECUTABLE: '/tmp/forge-runtime',
      HOME: '/Users/nonexistent-for-test',
    })).toBe('bun');
  });

  test('accepts an explicit Bun command name', () => {
    expect(resolveBunExecutable('/tmp/forge-runtime', {
      FORGE_BUN_EXECUTABLE: 'bun',
      HOME: '/Users/nonexistent-for-test',
    })).toBe('bun');
  });

  test('uses the hosting executable only when it is Bun itself', () => {
    expect(resolveBunExecutable('bun', { HOME: '/Users/nonexistent-for-test' })).toBe('bun');
  });

  test('compiled Runtime scheduler resolves a real Bun executable instead of recursively spawning forge-runtime', () => {
    expect(resolveSchedulerWorkerExecutable(true, '/tmp/forge-runtime', {
      FORGE_BUN_EXECUTABLE: 'bun',
      HOME: '/Users/nonexistent-for-test',
    })).toBe('bun');
    expect(resolveSchedulerWorkerExecutable(false, '/tmp/node', {})).toBe('/tmp/node');
  });

  test('resolves ~/.bun/bin/bun from the OS account home when env -i removes HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-bun-home-'));
    homes.push(home);
    const bin = join(home, '.bun', 'bin');
    mkdirSync(bin, { recursive: true });
    const bun = join(bin, 'bun');
    writeFileSync(bun, 'fixture');
    expect(resolveBunExecutable('/tmp/forge-runtime', {}, home)).toBe(bun);
  });
});
