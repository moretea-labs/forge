import { describe, expect, test } from 'bun:test';
import { resolveBunExecutable } from '../../src/runtime/shared/process-environment';

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
});
