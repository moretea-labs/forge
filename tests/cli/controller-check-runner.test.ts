import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, spawnSync } from 'child_process';
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


function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out after ' + timeoutMs + 'ms waiting for condition');
}

describe('Controller Check sidecar cancellation', () => {
  test('forwards SIGTERM to the detached check process tree', async () => {
    const markerPath = join(tmpdir(), ['forge-check-child', process.pid, Date.now(), 'pid'].join('-'));
    const { root, storageAuthority } = repo({
      longRunning: {
        command: command("const fs=require('fs');fs.writeFileSync(" + JSON.stringify(markerPath) + ",String(process.pid));setInterval(()=>{},1000)"),
        timeoutMs: 30_000,
        effects: { reads: ['.'] },
      },
    });
    const checkRunnerPath = join(process.cwd(), 'src/cli/controller/check-runner.ts');
    const sidecarScript = "const { runControllerCheckAsync } = await import("
      + JSON.stringify(checkRunnerPath) + ");" + String.fromCharCode(10)
      + "await runControllerCheckAsync(" + JSON.stringify(root)
      + ", 'longRunning', { storageAuthority: " + JSON.stringify(storageAuthority) + " });";
    const sidecar = spawn(process.execPath, ['-e', sidecarScript], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    let childPid: number | undefined;
    try {
      await waitForCondition(() => existsSync(markerPath), 8_000);
      childPid = Number(readFileSync(markerPath, 'utf8'));
      expect(childPid).toBeGreaterThan(0);

      sidecar.kill('SIGTERM');
      await waitForCondition(() => sidecar.exitCode !== null || sidecar.signalCode !== null, 8_000);

      expect(processIsAlive(childPid!)).toBe(false);
      expect(sidecar.signalCode).toBeNull();
      expect(sidecar.exitCode).toBe(0);
    } finally {
      if (sidecar.exitCode === null && sidecar.signalCode === null) sidecar.kill('SIGKILL');
      if (childPid && processIsAlive(childPid)) process.kill(childPid, 'SIGKILL');
      rmSync(markerPath, { force: true });
    }
  });
});
