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

  test('root and controller command surfaces expose no legacy lifecycle or component rollout owner', () => {
    const root = spawnSync('bun', [CLI, '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(root.status).toBe(0);
    expect(root.stdout).toContain('controller');
    expect(root.stdout).toContain('runtime');
    expect(root.stdout).not.toMatch(/^\s+supervisor\b/m);

    const controller = spawnSync('bun', [CLI, 'controller', '--help'], { cwd: ROOT, encoding: 'utf-8' });
    expect(controller.status).toBe(0);
    expect(controller.stdout).toContain('board');
    expect(controller.stdout).toContain('runs');
    expect(controller.stdout).toContain('change-verify');
    for (const legacy of ['start', 'stop', 'status', 'restart', 'logs', 'rollout', 'rollback', 'restart-verify', 'feature-verify']) {
      expect(controller.stdout).not.toMatch(new RegExp(`^\\s+${legacy}\\b`, 'm'));
    }
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
