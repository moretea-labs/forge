import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');

describe('runtime command surface', () => {
  test('is read-only and exposes no parallel lifecycle owner', () => {
    const result = spawnSync('bun', [CLI, 'runtime', '--help'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('job');
    expect(result.stdout).toContain('jobs');
    expect(result.stdout).toContain('schedules');
    expect(result.stdout).not.toMatch(/^\s+start\b/m);
    expect(result.stdout).not.toMatch(/^\s+stop\b/m);
    expect(result.stdout).not.toMatch(/^\s+restart\b/m);
    expect(result.stdout).not.toMatch(/^\s+doctor\b/m);
  });

  test('requires an explicit Controller Home for Runtime status', () => {
    const result = spawnSync('bun', [CLI, 'runtime', 'status', '--json'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required option '--controller-home <path>' not specified");
  });
});
