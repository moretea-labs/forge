import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listControllerChecks,
  readLatestControllerCheckEvidence,
  resolveSyncSupervisorBridgeRuntime,
  runControllerCheck,
  runControllerCheckAsync,
  snapshotControllerCheck,
} from '../../src/cli/controller/check-runner';
import { resolvePersistedCheckCliInvocation } from '../../src/runtime/gateway/mcp/persisted-check-process';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(checks: Record<string, { command: string[]; effects?: unknown }>) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-check-provenance-repo-'));
  roots.push(repoRoot);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'check-provenance-fixture' }));
  mkdirSync(join(repoRoot, '.repo-harness'), { recursive: true });
  writeFileSync(join(repoRoot, '.repo-harness/checks.json'), JSON.stringify({ version: 1, checks }));
  spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  return repoRoot;
}

describe('controller check provenance and failure classification', () => {
  test('normalizes declared effects and binds them into check snapshots', () => {
    const repoRoot = fixture({
      effects: {
        command: [process.execPath, '-e', 'process.exit(0)'],
        effects: {
          reads: ['./src', 'src'],
          writes: ['reports'],
          cache: 'write',
          temp: 'isolated',
          git: 'read',
          network: 'read',
        },
      },
    });
    const check = listControllerChecks(repoRoot).find((entry) => entry.id === 'effects');
    expect(check?.effects).toEqual({
      reads: ['src'],
      writes: ['reports'],
      cache: 'write',
      temp: 'isolated',
      git: 'read',
      network: 'read',
    });
    const snapshot = snapshotControllerCheck(repoRoot, 'effects');
    expect(snapshot.effects).toEqual(check?.effects);
    const tampered = { ...snapshot, effects: { ...snapshot.effects, cache: 'read' as const } };
    expect(() => runControllerCheck(repoRoot, 'effects', undefined, tampered)).toThrow(/CHECK_SNAPSHOT_INVALID/);
  });

  test('infers read plus cache effects only for known static package checks', () => {
    const repoRoot = fixture({});
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
      name: 'check-provenance-fixture',
      scripts: {
        'check:type': 'bun x tsc --noEmit',
        'check:custom': 'node generate.js',
      },
    }));
    const checks = listControllerChecks(repoRoot);
    expect(checks.find((entry) => entry.id === 'package:check:type')?.effects).toEqual({ reads: ['.'], cache: 'write' });
    expect(checks.find((entry) => entry.id === 'package:check:custom')?.effects).toBeUndefined();
  });

  test('exposes cache provenance, validated revision, and original execution time', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'repo-harness-check-marker-')), 'runs');
    roots.push(marker.replace(/\/runs$/, ''));
    const command = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`];
    const repoRoot = fixture({ cached: { command } });

    const first = runControllerCheck(repoRoot, 'cached');
    const second = await runControllerCheckAsync(repoRoot, 'cached');
    expect(first.ok).toBe(true);
    expect(first.cacheHit).toBe(false);
    expect(first.validatedRevision).toBeTruthy();
    expect(first.originalExecutedAt).toBe(first.executedAt);
    expect(second.cacheHit).toBe(true);
    expect(second.validatedRevision).toBe(first.validatedRevision);
    expect(second.originalExecutedAt).toBe(first.executedAt);
    expect(readFileSync(marker, 'utf8')).toBe('x');

    const evidence = readLatestControllerCheckEvidence(repoRoot, 'cached');
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      cacheHit: false,
      validatedRevision: first.validatedRevision,
      originalExecutedAt: first.executedAt,
    });
    expect(readdirSync(join(repoRoot, '.ai/harness/checks/controller/cached'))).toHaveLength(1);
  });

  test('reuses same-content history across commit identity and unrelated task documents', async () => {
    const markerRoot = mkdtempSync(join(tmpdir(), 'repo-harness-check-history-marker-'));
    roots.push(markerRoot);
    const marker = join(markerRoot, 'runs');
    const command = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`];
    const repoRoot = fixture({ history: { command } });
    const packagePath = join(repoRoot, 'package.json');
    const originalPackage = readFileSync(packagePath, 'utf8');

    const first = await runControllerCheckAsync(repoRoot, 'history');
    expect(first.cacheHit).toBe(false);
    spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'same tree identity'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    mkdirSync(join(repoRoot, 'tasks/issues'), { recursive: true });
    writeFileSync(join(repoRoot, 'tasks/issues/unrelated.md'), '# unrelated task metadata\n');
    expect((await runControllerCheckAsync(repoRoot, 'history')).cacheHit).toBe(true);

    writeFileSync(packagePath, JSON.stringify({ name: 'check-provenance-fixture', changed: true }));
    expect((await runControllerCheckAsync(repoRoot, 'history')).cacheHit).toBe(false);
    writeFileSync(packagePath, originalPackage);
    expect((await runControllerCheckAsync(repoRoot, 'history')).cacheHit).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('xx');
    expect(existsSync(join(repoRoot, '.ai/harness/checks/controller/history'))).toBe(true);
  });

  test('strips Controller writer and Supervisor authority from sync and async check children', async () => {
    const authorityKeys = [
      'REPO_HARNESS_WRITER_SLOT',
      'REPO_HARNESS_WRITER_EPOCH',
      'REPO_HARNESS_WRITER_FENCING_TOKEN',
      'REPO_HARNESS_WRITER_GENERATION',
      'REPO_HARNESS_SUPERVISOR_CHILD',
      'REPO_HARNESS_SUPERVISOR_EPOCH',
      'REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER',
      'REPO_HARNESS_DAEMON_INSTANCE_ID',
    ];
    const probe = `const keys=${JSON.stringify(authorityKeys)}; const leaked=keys.filter((key)=>process.env[key]); if (leaked.length) { console.error(leaked.join(',')); process.exit(9); }`;
    const repoRoot = fixture({
      sync_env: { command: [process.execPath, '-e', probe] },
      async_env: { command: [process.execPath, '-e', probe] },
    });
    const previous = new Map(authorityKeys.map((key) => [key, process.env[key]]));
    try {
      for (const key of authorityKeys) process.env[key] = 'inherited-controller-authority';
      expect(runControllerCheck(repoRoot, 'sync_env').ok).toBe(true);
      expect((await runControllerCheckAsync(repoRoot, 'async_env')).ok).toBe(true);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('uses Bun rather than a compiled CLI executable for the synchronous bridge', () => {
    expect(resolveSyncSupervisorBridgeRuntime('/opt/releases/repo-harness.js', {})).toBe('bun');
    expect(resolveSyncSupervisorBridgeRuntime('/opt/bun/bin/bun', {})).toBe('/opt/bun/bin/bun');
    expect(resolveSyncSupervisorBridgeRuntime('/opt/releases/repo-harness.js', {
      REPO_HARNESS_BUN_EXECUTABLE: '/custom/bun',
    })).toBe('/custom/bun');
  });

  test('launches persisted checks directly from standalone Bun releases', () => {
    const args = ['controller', 'run-check-process', '--check-id', 'package:check:type'];
    expect(resolvePersistedCheckCliInvocation('/$bunfs/root/repo-harness.js', args, {
      runtimeExecutable: '/opt/releases/repo-harness.js',
      env: {},
    })).toEqual({ executable: '/opt/releases/repo-harness.js', args });
    expect(resolvePersistedCheckCliInvocation('/repo/bin/repo-harness.mjs', args, {
      runtimeExecutable: '/opt/bun/bin/bun',
      env: {},
    })).toEqual({
      executable: '/opt/bun/bin/bun',
      args: ['/repo/bin/repo-harness.mjs', ...args],
    });
  });

  test('keeps a synchronous bridge launch defect out of acceptance evidence', () => {
    const command = [process.execPath, '-e', 'process.exit(0)'];
    const repoRoot = fixture({ bridge_failure: { command } });
    const fakeRuntimeRoot = mkdtempSync(join(tmpdir(), 'repo-harness-check-bridge-runtime-'));
    roots.push(fakeRuntimeRoot);
    const fakeRuntime = join(fakeRuntimeRoot, 'fake-bun');
    writeFileSync(fakeRuntime, '#!/bin/sh\necho bridge-runtime-broken >&2\nexit 17\n');
    chmodSync(fakeRuntime, 0o755);
    const previousRuntime = process.env.REPO_HARNESS_BUN_EXECUTABLE;
    try {
      process.env.REPO_HARNESS_BUN_EXECUTABLE = fakeRuntime;
      const result = runControllerCheck(repoRoot, 'bridge_failure');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(17);
      expect(result.command).toEqual(command);
      expect(result.failureClass).toBe('infrastructure_failure');
      expect(result.stderr).toContain('bridge-runtime-broken');
      expect(result.stderr).toContain('CHECK_SUPERVISOR_BRIDGE_FAILED');
    } finally {
      if (previousRuntime === undefined) delete process.env.REPO_HARNESS_BUN_EXECUTABLE;
      else process.env.REPO_HARNESS_BUN_EXECUTABLE = previousRuntime;
    }
  });

  test('classifies a named nonzero check as acceptance and a missing runtime as infrastructure', async () => {
    const repoRoot = fixture({
      assertion: { command: [process.execPath, '-e', 'console.error("expected value mismatch"); process.exit(3)'] },
      missing: { command: ['repo-harness-runtime-that-does-not-exist', '--check'] },
    });

    const assertion = await runControllerCheckAsync(repoRoot, 'assertion');
    const missing = await runControllerCheckAsync(repoRoot, 'missing');
    expect(assertion.ok).toBe(false);
    expect(assertion.status).toBe(3);
    expect(assertion.failureClass).toBe('acceptance_failure');
    expect(assertion.timedOut).toBe(false);
    expect(missing.ok).toBe(false);
    expect(missing.failureClass).toBe('infrastructure_failure');
    expect(missing.timedOut).toBe(false);
    expect(missing.stderr).toContain('repo-harness-runtime-that-does-not-exist');
  });
});
