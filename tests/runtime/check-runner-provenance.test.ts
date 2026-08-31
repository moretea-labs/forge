import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import {
  controllerCheckExecutionIdentity,
  listControllerChecks,
  readLatestControllerCheckEvidence,
  resolveSyncSupervisorBridgeRuntime,
  runControllerCheck,
  runControllerCheckAsync,
  snapshotControllerCheck,
} from '../../src/cli/controller/check-runner';
import { resolvePersistedCheckCliInvocation } from '../../src/runtime/gateway/mcp/persisted-check-process';
import { runPersistedCheckSidecar } from '../../src/runtime/execution/process-runtime/check-runner-sidecar';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(checks: Record<string, { command: string[]; effects?: unknown; timeoutMs?: number }>) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forge-check-provenance-repo-'));
  roots.push(repoRoot);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'check-provenance-fixture' }));
  mkdirSync(join(repoRoot, '.forge'), { recursive: true });
  writeFileSync(join(repoRoot, '.forge/checks.json'), JSON.stringify({ version: 1, checks }));
  spawnSync('git', ['add', 'package.json', '.forge/checks.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  return repoRoot;
}

describe('controller check provenance and failure classification', () => {
  test('inherits tracked legacy checks into isolated worktrees and keeps .forge precedence', () => {
    const container = mkdtempSync(join(tmpdir(), 'forge-check-portable-'));
    roots.push(container);
    const repoRoot = join(container, 'repo');
    const worktreeRoot = join(container, 'worktree');
    mkdirSync(repoRoot, { recursive: true });
    spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'portable-check-fixture' }));
    mkdirSync(join(repoRoot, '.repo-harness'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness/checks.json'), JSON.stringify({
      version: 1,
      checks: {
        portable: { command: [process.execPath, '-e', 'process.exit(0)'] },
        legacy_only: { command: [process.execPath, '-e', 'process.exit(0)'] },
      },
    }));
    spawnSync('git', ['add', 'package.json', '.repo-harness/checks.json'], { cwd: repoRoot, stdio: 'ignore' });
    spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'portable checks'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    const added = spawnSync('git', ['worktree', 'add', '-b', 'isolated', worktreeRoot], { cwd: repoRoot, encoding: 'utf8' });
    expect(added.status).toBe(0);

    const inherited = listControllerChecks(worktreeRoot);
    expect(inherited.find((entry) => entry.id === 'portable')?.source).toBe('repo-config');
    expect(snapshotControllerCheck(worktreeRoot, 'portable').command).toEqual([process.execPath, '-e', 'process.exit(0)']);

    mkdirSync(join(worktreeRoot, '.forge'), { recursive: true });
    writeFileSync(join(worktreeRoot, '.forge/checks.json'), JSON.stringify({
      version: 1,
      checks: {
        portable: { command: [process.execPath, '-e', 'process.exit(7)'] },
        current_only: { command: [process.execPath, '-e', 'process.exit(0)'] },
      },
    }));
    const current = listControllerChecks(worktreeRoot);
    expect(current.find((entry) => entry.id === 'portable')?.command).toEqual([process.execPath, '-e', 'process.exit(7)']);
    expect(current.some((entry) => entry.id === 'current_only')).toBe(true);
    expect(current.some((entry) => entry.id === 'legacy_only')).toBe(false);
  });

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

  test('normalizes declared host service effects and rejects unusable keys', () => {
    const repoRoot = fixture({ host_check: {
      command: [process.execPath, '-e', 'process.exit(0)'],
      effects: { reads: ['.'], hostServices: [' iOS Simulator Test ', 'ios-simulator-test'] },
    } });
    const check = snapshotControllerCheck(repoRoot, 'host_check');
    expect(check.effects?.hostServices).toEqual(['ios-simulator-test']);

    const invalidRoot = mkdtempSync(join(tmpdir(), 'forge-check-host-invalid-'));
    roots.push(invalidRoot);
    writeFileSync(join(invalidRoot, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    mkdirSync(join(invalidRoot, '.forge'), { recursive: true });
    writeFileSync(join(invalidRoot, '.forge', 'checks.json'), JSON.stringify({ version: 1, checks: { bad: { command: [process.execPath, '-e', 'process.exit(0)'], effects: { reads: ['.'], hostServices: ['!!!'] } } } }));
    expect(() => snapshotControllerCheck(invalidRoot, 'bad')).toThrow(/invalid service key/);
  });

  test('infers read plus cache effects only for known static package checks', () => {
    const repoRoot = fixture({});
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
      name: 'check-provenance-fixture',
      scripts: {
        'check:type': 'bun x tsc --noEmit',
        'test:browser-live': 'bun tests/live/browser-native-silent.e2e.ts',
        'check:custom': 'node generate.js',
      },
    }));
    const checks = listControllerChecks(repoRoot);
    expect(checks.find((entry) => entry.id === 'package:check:type')?.effects).toEqual({ reads: ['.'], cache: 'write' });
    expect(checks.find((entry) => entry.id === 'package:test:browser-live')?.effects).toEqual({
      reads: ['.'],
      temp: 'isolated',
      hostServices: ['browser-live'],
    });
    expect(checks.find((entry) => entry.id === 'package:check:custom')?.effects).toBeUndefined();
  });

  test('prepares matching canonical dependencies before a linked-worktree package check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-check-linked-dependencies-'));
    roots.push(root);
    const repoRoot = join(root, 'repository');
    mkdirSync(repoRoot, { recursive: true });
    expect(spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot, stdio: 'ignore' }).status).toBe(0);
    expect(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' }).status).toBe(0);
    writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.ai/harness/\n');
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
      name: 'linked-dependency-check-fixture',
      private: true,
      scripts: { 'check:type': 'node verify-deps.cjs' },
    }));
    writeFileSync(join(repoRoot, 'package-lock.json'), JSON.stringify({
      name: 'linked-dependency-check-fixture',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'linked-dependency-check-fixture' } },
    }));
    writeFileSync(join(repoRoot, 'verify-deps.cjs'), [
      "const fs = require('fs');",
      "if (!fs.existsSync('node_modules/canonical-marker')) process.exit(19);",
      "console.log('canonical-dependencies-ready');",
      '',
    ].join('\n'));
    expect(spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' }).status).toBe(0);
    expect(spawnSync('git', ['commit', '-m', 'fixture'], { cwd: repoRoot, stdio: 'ignore' }).status).toBe(0);
    mkdirSync(join(repoRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(repoRoot, 'node_modules', 'canonical-marker'), 'ready\n');

    const worktreeRoot = join(root, 'worktree');
    expect(spawnSync('git', ['worktree', 'add', '-b', 'linked-dependency-check', worktreeRoot], {
      cwd: repoRoot,
      stdio: 'ignore',
    }).status).toBe(0);
    expect(existsSync(join(worktreeRoot, 'node_modules'))).toBe(false);

    const result = await runControllerCheckAsync(worktreeRoot, 'package:check:type');
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('canonical-dependencies-ready');
    expect(realpathSync(join(worktreeRoot, 'node_modules'))).toBe(realpathSync(join(repoRoot, 'node_modules')));
    const trackedStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
    });
    expect(trackedStatus.status).toBe(0);
    expect(trackedStatus.stdout.trim()).toBe('');
  });

  test('exposes cache provenance, validated revision, and original execution time', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'forge-check-marker-')), 'runs');
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
    const markerRoot = mkdtempSync(join(tmpdir(), 'forge-check-history-marker-'));
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

  test('shares semantic identity across clean worktrees and invalidates dirty/config/environment changes', () => {
    const repoRoot = fixture({
      reusable: {
        command: ['node', '--version'],
        effects: { reads: ['.'], cache: 'write', temp: 'isolated', git: 'read' },
      },
    });
    const peerRoot = mkdtempSync(join(tmpdir(), 'forge-check-provenance-peer-'));
    rmSync(peerRoot, { recursive: true, force: true });
    roots.push(peerRoot);
    expect(spawnSync('git', ['worktree', 'add', '-b', 'peer-check-reuse', peerRoot], { cwd: repoRoot, stdio: 'ignore' }).status).toBe(0);

    const first = controllerCheckExecutionIdentity(repoRoot, 'reusable');
    const peer = controllerCheckExecutionIdentity(peerRoot, 'reusable');
    expect(first.crossCheckoutReusable).toBe(true);
    expect(peer.crossCheckoutReusable).toBe(true);
    expect(peer.reuseScope).toBe('repository');
    expect(peer.cacheKey).toBe(first.cacheKey);
    expect(peer.revision).toBe(first.revision);

    writeFileSync(join(peerRoot, 'dirty.txt'), 'dirty\n');
    const dirty = controllerCheckExecutionIdentity(peerRoot, 'reusable');
    expect(dirty.crossCheckoutReusable).toBe(false);
    expect(dirty.reuseScope).toBe('checkout');
    expect(dirty.cacheKey).not.toBe(first.cacheKey);
    rmSync(join(peerRoot, 'dirty.txt'));

    const configPath = join(peerRoot, '.forge/checks.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { checks: Record<string, { description?: string }> };
    config.checks.reusable!.description = 'changed definition';
    writeFileSync(configPath, JSON.stringify(config));
    const changedDefinition = controllerCheckExecutionIdentity(peerRoot, 'reusable');
    expect(changedDefinition.definitionDigest).not.toBe(first.definitionDigest);
    expect(changedDefinition.cacheKey).not.toBe(first.cacheKey);

    writeFileSync(configPath, readFileSync(join(repoRoot, '.forge/checks.json')));
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${previousPath ?? ''}${previousPath ? ':' : ''}/tmp/forge-semantic-env-change`;
      const changedEnvironment = controllerCheckExecutionIdentity(peerRoot, 'reusable');
      expect(changedEnvironment.environmentFingerprint).not.toBe(first.environmentFingerprint);
      expect(changedEnvironment.cacheKey).not.toBe(first.cacheKey);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test('fails closed for cross-checkout reuse when effects or toolchain are not safely fingerprinted', () => {
    const repoRoot = fixture({
      unknown_effects: { command: ['node', '--version'] },
      networked: { command: ['node', '--version'], effects: { reads: ['.'], network: 'read' } },
      external_tool: { command: ['git', 'status'], effects: { reads: ['.'], git: 'read' } },
    });
    expect(controllerCheckExecutionIdentity(repoRoot, 'unknown_effects').crossCheckoutReusable).toBe(false);
    expect(controllerCheckExecutionIdentity(repoRoot, 'networked').crossCheckoutReusable).toBe(false);
    expect(controllerCheckExecutionIdentity(repoRoot, 'external_tool').crossCheckoutReusable).toBe(false);
  });

  test('injects only the explicit candidate Controller Home after generic authority sanitization', async () => {
    const probePath = join(mkdtempSync(join(tmpdir(), 'forge-check-isolated-home-probe-')), 'controller-home.txt');
    roots.push(dirname(probePath));
    const isolatedControllerHome = mkdtempSync(join(tmpdir(), 'forge-check-isolated-home-'));
    roots.push(isolatedControllerHome);
    const repoRoot = fixture({
      isolated_home: {
        command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(probePath)}, process.env.FORGE_CONTROLLER_HOME || '<missing>')`],
      },
    });
    const previousControllerHome = process.env.FORGE_CONTROLLER_HOME;
    const previousWriterSlot = process.env.FORGE_WRITER_SLOT;
    try {
      process.env.FORGE_CONTROLLER_HOME = '/host/controller/home/must-not-leak';
      process.env.FORGE_WRITER_SLOT = 'host-writer-must-not-leak';
      const result = await runControllerCheckAsync(repoRoot, 'isolated_home', { isolatedControllerHome });
      expect(result.ok).toBe(true);
      expect(readFileSync(probePath, 'utf8')).toBe(isolatedControllerHome);
    } finally {
      if (previousControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
      else process.env.FORGE_CONTROLLER_HOME = previousControllerHome;
      if (previousWriterSlot === undefined) delete process.env.FORGE_WRITER_SLOT;
      else process.env.FORGE_WRITER_SLOT = previousWriterSlot;
    }
  });

  test.each([
    ['crash', `require('fs').mkdirSync(process.env.FORGE_CONTROLLER_HOME,{recursive:true});require('fs').writeFileSync(require('path').join(process.env.FORGE_CONTROLLER_HOME,'candidate-write'),'crash');process.exit(17)`, 10_000],
    ['timeout', `require('fs').mkdirSync(process.env.FORGE_CONTROLLER_HOME,{recursive:true});require('fs').writeFileSync(require('path').join(process.env.FORGE_CONTROLLER_HOME,'candidate-write'),'timeout');setInterval(()=>{},1000)`, 5_000],
  ])('keeps Candidate Controller writes isolated when the check %s', async (_mode, script, timeoutMs) => {
    const hostControllerHome = mkdtempSync(join(tmpdir(), 'forge-check-host-controller-'));
    const isolatedControllerHome = mkdtempSync(join(tmpdir(), 'forge-check-candidate-controller-'));
    roots.push(hostControllerHome, isolatedControllerHome);
    const repoRoot = fixture({ candidate_failure: { command: [process.execPath, '-e', script], timeoutMs } });
    const previousControllerHome = process.env.FORGE_CONTROLLER_HOME;
    try {
      process.env.FORGE_CONTROLLER_HOME = hostControllerHome;
      const result = await runControllerCheckAsync(repoRoot, 'candidate_failure', { isolatedControllerHome, requestedTimeoutMs: timeoutMs });
      expect(result.ok).toBe(false);
      expect(existsSync(join(isolatedControllerHome, 'candidate-write'))).toBe(true);
      expect(existsSync(join(hostControllerHome, 'candidate-write'))).toBe(false);
    } finally {
      if (previousControllerHome === undefined) delete process.env.FORGE_CONTROLLER_HOME;
      else process.env.FORGE_CONTROLLER_HOME = previousControllerHome;
    }
  }, 15_000);

  test('strips Controller writer and Supervisor authority from sync and async check children', async () => {
    const authorityKeys = [
      'FORGE_WRITER_SLOT',
      'FORGE_WRITER_EPOCH',
      'FORGE_WRITER_FENCING_TOKEN',
      'FORGE_WRITER_GENERATION',
      'FORGE_SUPERVISOR_CHILD',
      'FORGE_SUPERVISOR_EPOCH',
      'FORGE_CONTROLLER_LIFECYCLE_OWNER',
      'FORGE_DAEMON_INSTANCE_ID',
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
    expect(basename(resolveSyncSupervisorBridgeRuntime('/opt/releases/forge.js', {}))).toBe(process.platform === 'win32' ? 'bun.exe' : 'bun');
    expect(resolveSyncSupervisorBridgeRuntime('/opt/bun/bin/bun', {})).toBe('/opt/bun/bin/bun');
    expect(basename(resolveSyncSupervisorBridgeRuntime('/opt/releases/forge.js', {
      FORGE_BUN_EXECUTABLE: '/custom/bun',
    }))).toBe(process.platform === 'win32' ? 'bun.exe' : 'bun');
  });

  test('persisted check sidecar uses bounded async supervision without the legacy TypeScript bridge', async () => {
    const command = [process.execPath, '-e', 'process.exit(0)'];
    const repoRoot = fixture({ persisted_no_bridge: { command } });
    const snapshot = snapshotControllerCheck(repoRoot, 'persisted_no_bridge');
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const fakeRuntimeRoot = mkdtempSync(join(tmpdir(), 'forge-check-sidecar-no-bridge-'));
    roots.push(fakeRuntimeRoot);
    const fakeRuntime = join(fakeRuntimeRoot, 'fake-bun');
    writeFileSync(fakeRuntime, '#!/bin/sh\necho legacy-bridge-must-not-run >&2\nexit 17\n');
    chmodSync(fakeRuntime, 0o755);
    const previousRuntime = process.env.FORGE_BUN_EXECUTABLE;
    try {
      process.env.FORGE_BUN_EXECUTABLE = fakeRuntime;
      const code = await runPersistedCheckSidecar([
        '--repo', repoRoot,
        '--check-id', 'persisted_no_bridge',
        '--expected-check-fingerprint', fingerprint,
      ]);
      expect(code).toBe(0);
    } finally {
      if (previousRuntime === undefined) delete process.env.FORGE_BUN_EXECUTABLE;
      else process.env.FORGE_BUN_EXECUTABLE = previousRuntime;
    }
  });

  test('persisted check sidecar uses bounded async supervision without the legacy TypeScript bridge', async () => {
    const command = [process.execPath, '-e', 'process.exit(0)'];
    const repoRoot = fixture({ persisted_no_bridge: { command } });
    const snapshot = snapshotControllerCheck(repoRoot, 'persisted_no_bridge');
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const fakeRuntimeRoot = mkdtempSync(join(tmpdir(), 'forge-check-sidecar-no-bridge-'));
    roots.push(fakeRuntimeRoot);
    const fakeRuntime = join(fakeRuntimeRoot, 'fake-bun');
    writeFileSync(fakeRuntime, '#!/bin/sh\necho legacy-bridge-must-not-run >&2\nexit 17\n');
    chmodSync(fakeRuntime, 0o755);
    const previousRuntime = process.env.FORGE_BUN_EXECUTABLE;
    try {
      process.env.FORGE_BUN_EXECUTABLE = fakeRuntime;
      const code = await runPersistedCheckSidecar([
        '--repo', repoRoot,
        '--check-id', 'persisted_no_bridge',
        '--expected-check-fingerprint', fingerprint,
      ]);
      expect(code).toBe(0);
    } finally {
      if (previousRuntime === undefined) delete process.env.FORGE_BUN_EXECUTABLE;
      else process.env.FORGE_BUN_EXECUTABLE = previousRuntime;
    }
  });

  test('launches persisted checks directly from standalone Bun releases', () => {
    const args = ['controller', 'run-check-process', '--check-id', 'package:check:type'];
    expect(resolvePersistedCheckCliInvocation('/$bunfs/root/forge.js', args, {
      runtimeExecutable: '/opt/releases/forge.js',
      env: {},
    })).toEqual({ executable: '/opt/releases/forge.js', args });
    expect(resolvePersistedCheckCliInvocation('/repo/bin/forge.mjs', args, {
      runtimeExecutable: '/opt/bun/bin/bun',
      env: {},
    })).toEqual({
      executable: '/opt/bun/bin/bun',
      args: ['/repo/bin/forge.mjs', ...args],
    });
  });

  test('keeps a synchronous bridge launch defect out of acceptance evidence', () => {
    const command = [process.execPath, '-e', 'process.exit(0)'];
    const repoRoot = fixture({ bridge_failure: { command } });
    const fakeRuntimeRoot = mkdtempSync(join(tmpdir(), 'forge-check-bridge-runtime-'));
    roots.push(fakeRuntimeRoot);
    const fakeRuntime = join(fakeRuntimeRoot, process.platform === 'win32' ? 'bun.exe' : 'bun');
    writeFileSync(fakeRuntime, '#!/bin/sh\necho bridge-runtime-broken >&2\nexit 17\n');
    chmodSync(fakeRuntime, 0o755);
    const previousRuntime = process.env.FORGE_BUN_EXECUTABLE;
    try {
      process.env.FORGE_BUN_EXECUTABLE = fakeRuntime;
      const result = runControllerCheck(repoRoot, 'bridge_failure');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(17);
      expect(result.command).toEqual(command);
      expect(result.failureClass).toBe('infrastructure_failure');
      expect(result.stderr).toContain('bridge-runtime-broken');
      expect(result.stderr).toContain('CHECK_SUPERVISOR_BRIDGE_FAILED');
    } finally {
      if (previousRuntime === undefined) delete process.env.FORGE_BUN_EXECUTABLE;
      else process.env.FORGE_BUN_EXECUTABLE = previousRuntime;
    }
  });

  test('classifies a named nonzero check as acceptance and a missing runtime as infrastructure', async () => {
    const repoRoot = fixture({
      assertion: { command: [process.execPath, '-e', 'console.error("expected value mismatch"); process.exit(3)'] },
      missing: { command: ['forge-runtime-that-does-not-exist', '--check'] },
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
    expect(missing.stderr).toContain('forge-runtime-that-does-not-exist');
  });

  test('classifies dependency-download transport failures as infrastructure without masking deterministic check failures', async () => {
    const networkFailure = [
      "console.error(\"Could not GET 'https://dl.google.com/android/repository/example.pom'.\");",
      "console.error('Caused by: java.net.SocketTimeoutException: Read timed out');",
      'process.exit(1);',
    ].join(' ');
    const repoRoot = fixture({
      network_sync: { command: [process.execPath, '-e', networkFailure] },
      network_async: { command: [process.execPath, '-e', networkFailure] },
      compiler_failure: {
        command: [process.execPath, '-e', "console.error('src/main.ts(1,1): error TS2322: Type string is not assignable to number'); process.exit(2)"],
      },
    });

    const syncNetwork = runControllerCheck(repoRoot, 'network_sync');
    const asyncNetwork = await runControllerCheckAsync(repoRoot, 'network_async');
    const compilerFailure = await runControllerCheckAsync(repoRoot, 'compiler_failure');

    expect(syncNetwork.ok).toBe(false);
    expect(syncNetwork.failureClass).toBe('infrastructure_failure');
    expect(asyncNetwork.ok).toBe(false);
    expect(asyncNetwork.failureClass).toBe('infrastructure_failure');
    expect(compilerFailure.ok).toBe(false);
    expect(compilerFailure.failureClass).toBe('acceptance_failure');
  });

});
