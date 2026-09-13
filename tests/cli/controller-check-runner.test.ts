import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { runControllerCheck, runControllerCheckAsync } from '../../src/cli/controller/check-runner';
import { registerRepository } from '../../src/cli/repositories/registry';

const roots: string[] = [];

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function repo(checks: Record<string, unknown>): {
  root: string;
  storageAuthority: { controllerHome: string; repoId: string };
} {
  const root = mkdtempSync(join(tmpdir(), 'forge-controller-check-runner-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-controller-check-home-'));
  roots.push(root, controllerHome);
  mkdirSync(join(root, '.forge'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/input.txt'), 'before\n');
  writeFileSync(join(root, '.forge/checks.json'), `${JSON.stringify({ version: 1, checks }, null, 2)}\n`);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Forge Check Regression']);
  git(root, ['config', 'user.email', 'forge-check@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  const repository = registerRepository({ path: root, controllerHome, defaultBranch: 'main' });
  return { root, storageAuthority: { controllerHome, repoId: repository.repoId } };
}

function command(script: string): string[] {
  return [process.execPath, '-e', script];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Controller Check post-run input integrity', () => {
  test('keeps successful evidence when the check only creates a new generated output', () => {
    const { root, storageAuthority } = repo({
      generated: {
        command: command("const fs=require('fs');fs.mkdirSync('generated',{recursive:true});fs.writeFileSync('generated/report.json','ok\\n')"),
        timeoutMs: 10_000,
        effects: { reads: ['.'], writes: ['generated'] },
      },
    });

    const result = runControllerCheck(root, 'generated', undefined, undefined, storageAuthority);
    expect(result.ok).toBe(true);
    expect(result.cacheHit).toBe(false);
    expect(existsSync(join(root, 'generated/report.json'))).toBe(true);

    rmSync(join(root, 'generated'), { recursive: true, force: true });
    const reused = runControllerCheck(root, 'generated', undefined, undefined, storageAuthority);
    expect(reused.ok).toBe(true);
    expect(reused.cacheHit).toBe(true);
  });

  test('fails stale when a check mutates a pre-existing input without declaring the write', () => {
    const { root, storageAuthority } = repo({
      mutatesInput: {
        command: command("require('fs').writeFileSync('src/input.txt','after\\n')"),
        timeoutMs: 10_000,
        effects: { reads: ['.'] },
      },
    });

    const result = runControllerCheck(root, 'mutatesInput', undefined, undefined, storageAuthority);
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('infrastructure_failure');
    expect(result.stderr).toContain('evidence is stale');
  });

  test('allows a declared write scope to mutate a pre-existing input without staling the check', () => {
    const { root, storageAuthority } = repo({
      declaredWrite: {
        command: command("require('fs').writeFileSync('src/input.txt','after\\n')"),
        timeoutMs: 10_000,
        effects: { reads: ['.'], writes: ['src'] },
      },
    });

    const result = runControllerCheck(root, 'declaredWrite', undefined, undefined, storageAuthority);
    expect(result.ok).toBe(true);
    expect(result.failureClass).toBeUndefined();
  });

  test('uses the same input-integrity rule for async checks that create generated output', async () => {
    const { root, storageAuthority } = repo({
      asyncGenerated: {
        command: command("const fs=require('fs');fs.mkdirSync('generated',{recursive:true});fs.writeFileSync('generated/report.json','ok\\n')"),
        timeoutMs: 10_000,
        effects: { reads: ['.'], writes: ['generated'] },
      },
    });

    const result = await runControllerCheckAsync(root, 'asyncGenerated', { storageAuthority });
    expect(result.ok).toBe(true);
    expect(result.cacheHit).toBe(false);
    expect(existsSync(join(root, 'generated/report.json'))).toBe(true);
  });
});
