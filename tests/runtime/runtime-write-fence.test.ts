import { runProcessRunnerFromDescriptor } from '../../src/runtime/execution/process-runtime/process-runner-entry';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureControllerHome } from '../../src/effects/controller-home';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import { readRuntimeIncarnation } from '../../src/runtime/root/ownership';
import {
  ensureActiveRuntimeRelease,
  publishRuntimeRelease,
} from '../../src/runtime/root/release-store';
import {
  assertRuntimeMayWrite,
  assertRuntimeMayWriteOrThrow,
  bindInheritedRuntimeWriteClaimFromEnvironment,
  RUNTIME_WRITE_CLAIM_ENV,
  bindRuntimeWriteClaim,
  clearRuntimeWriteClaimForTests,
  isRuntimeWriteFenceError,
  runtimeWriteClaimEnvironment,
} from '../../src/runtime/root/write-fence';

const roots: string[] = [];

afterEach(() => {
  clearRuntimeWriteClaimForTests();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function manifest(home: string, releaseId: string, artifactIdentity: string, workerProtocolVersion = 1): string {
  const path = join(home, `${releaseId}.manifest.json`);
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    releaseId,
    artifactIdentity,
    entrypoint: 'forge-runtime',
    arguments: [],
    configurationSchemaVersion: 1,
    controllerHome: home,
    databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
    workerProtocolVersion,
    createdAt: new Date().toISOString(),
  }));
  return path;
}

function fixture() {
  const home = ensureControllerHome(mkdtempSync(join(tmpdir(), 'runtime-write-fence-')));
  roots.push(home);
  inspectControlPlaneDatabase(home);
  const owner = acquireRuntimeOwnership(home, 'runtime-a');
  const authority = ensureActiveRuntimeRelease(home, manifest(home, 'release-a', 'artifact-a'));
  return { home, owner, authority };
}

test('ignores metadata-only inherited environment without creating a write claim', () => {
  const env: NodeJS.ProcessEnv = {
    [RUNTIME_WRITE_CLAIM_ENV.artifactIdentity]: 'artifact-a',
    [RUNTIME_WRITE_CLAIM_ENV.workerProtocolVersion]: '1',
  };
  expect(bindInheritedRuntimeWriteClaimFromEnvironment(env)).toBeUndefined();
});

test('rejects a partial inherited owner claim even when release metadata is present', () => {
  const fx = fixture();
  const env: NodeJS.ProcessEnv = {
    [RUNTIME_WRITE_CLAIM_ENV.controllerHome]: fx.home,
    [RUNTIME_WRITE_CLAIM_ENV.runtimeInstanceId]: 'runtime-a',
    [RUNTIME_WRITE_CLAIM_ENV.artifactIdentity]: 'artifact-a',
    [RUNTIME_WRITE_CLAIM_ENV.workerProtocolVersion]: '1',
  };
  try {
    expect(() => bindInheritedRuntimeWriteClaimFromEnvironment(env))
      .toThrow('RUNTIME_WRITE_CLAIM_BIND_FAILED: inherited claim is incomplete');
  } finally {
    fx.owner.release();
  }
});

describe('Canonical Runtime write fence', () => {
  test('accepts the current Runtime owner and whole-release claim', () => {
    const fx = fixture();
    bindRuntimeWriteClaim({ controllerHome: fx.home, owner: fx.owner.record, authority: fx.authority });
    expect(assertRuntimeMayWrite('scheduler_write', fx.home)).toMatchObject({ allowed: true });
    fx.owner.release();
  });

  test('an inherited Worker claim is fenced when Runtime ownership changes', () => {
    const fx = fixture();
    const parent = bindRuntimeWriteClaim({ controllerHome: fx.home, owner: fx.owner.record, authority: fx.authority });
    const env = runtimeWriteClaimEnvironment(parent);
    clearRuntimeWriteClaimForTests();
    bindInheritedRuntimeWriteClaimFromEnvironment(env, fx.home);
    expect(assertRuntimeMayWrite('renew_lease', fx.home).allowed).toBe(true);
    fx.owner.release();
    const replacement = acquireRuntimeOwnership(fx.home, 'runtime-b');
    expect(assertRuntimeMayWrite('renew_lease', fx.home)).toMatchObject({
      allowed: false,
      reason: 'runtime_instance_fenced',
    });
    replacement.release();
  });

  test('throws one typed WRITER_FENCED error while preserving the legacy diagnostic message', () => {
    const fx = fixture();
    const parent = bindRuntimeWriteClaim({ controllerHome: fx.home, owner: fx.owner.record, authority: fx.authority });
    const env = runtimeWriteClaimEnvironment(parent);
    clearRuntimeWriteClaimForTests();
    bindInheritedRuntimeWriteClaimFromEnvironment(env, fx.home);
    fx.owner.release();
    const replacement = acquireRuntimeOwnership(fx.home, 'runtime-b');
    try {
      assertRuntimeMayWriteOrThrow('renew_lease', fx.home);
      throw new Error('expected Runtime write fence');
    } catch (error) {
      expect(isRuntimeWriteFenceError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'WRITER_FENCED',
        action: 'renew_lease',
        reason: 'runtime_instance_fenced',
        message: 'WRITER_FENCED:renew_lease:runtime_instance_fenced',
      });
    }
    replacement.release();
  });

  test('a replacement Runtime advances the durable incarnation generation even when the old owner released cleanly', () => {
    const fx = fixture();
    const parent = bindRuntimeWriteClaim({ controllerHome: fx.home, owner: fx.owner.record, authority: fx.authority });
    const firstGeneration = parent.fencingGeneration;
    fx.owner.release();
    const replacement = acquireRuntimeOwnership(fx.home, 'runtime-b');
    expect(replacement.record.fencingGeneration).toBeGreaterThan(firstGeneration);
    expect(readRuntimeIncarnation(fx.home)).toMatchObject({
      runtimeInstanceId: 'runtime-b',
      fencingGeneration: replacement.record.fencingGeneration,
    });
    expect(assertRuntimeMayWrite('renew_lease', fx.home)).toMatchObject({
      allowed: false,
      reason: 'runtime_instance_fenced',
    });
    replacement.release();
  });

  test('an inherited Worker claim is fenced when the whole release rotates', () => {
    const fx = fixture();
    const parent = bindRuntimeWriteClaim({ controllerHome: fx.home, owner: fx.owner.record, authority: fx.authority });
    const env = runtimeWriteClaimEnvironment(parent);
    clearRuntimeWriteClaimForTests();
    bindInheritedRuntimeWriteClaimFromEnvironment(env, fx.home);
    publishRuntimeRelease(fx.home, manifest(fx.home, 'release-b', 'artifact-b', 2), 'test-publish');
    expect(assertRuntimeMayWrite('write_workflow_terminal', fx.home)).toMatchObject({
      allowed: false,
      reason: 'release_authority_revision_fenced',
    });
    fx.owner.release();
  });

  test('allows an isolated authority-free Controller Home under a claim for another canonical home', () => {
    const fx = fixture();
    bindRuntimeWriteClaim({ controllerHome: fx.home, owner: fx.owner.record, authority: fx.authority });
    const isolated = ensureControllerHome(mkdtempSync(join(tmpdir(), 'runtime-write-isolated-')));
    roots.push(isolated);
    expect(assertRuntimeMayWrite('renew_lease', isolated)).toMatchObject({
      allowed: true,
      reason: 'isolated_controller_home_without_runtime_authority',
    });
    const isolatedOwner = acquireRuntimeOwnership(isolated, 'runtime-isolated');
    expect(assertRuntimeMayWrite('renew_lease', isolated)).toMatchObject({
      allowed: false,
      reason: 'controller_home_mismatch',
    });
    isolatedOwner.release();
    fx.owner.release();
  });

  test('unmanaged tests remain writable only while no Runtime authority exists', () => {
    const home = ensureControllerHome(mkdtempSync(join(tmpdir(), 'runtime-write-unmanaged-')));
    roots.push(home);
    bindRuntimeWriteClaim({ controllerHome: home, allowUnmanagedMissing: true });
    expect(assertRuntimeMayWrite('scheduler_write', home)).toMatchObject({ allowed: true });
    const owner = acquireRuntimeOwnership(home, 'runtime-real');
    expect(assertRuntimeMayWrite('scheduler_write', home)).toMatchObject({
      allowed: false,
      reason: 'runtime_authority_appeared_after_unmanaged_bind',
    });
    owner.release();
  });

  test('clearing a canonical claim restores caller-owned environment values', () => {
    const fx = fixture();
    const key = 'FORGE_CONTROLLER_HOME';
    const previous = process.env[key];
    process.env[key] = 'caller-owned-controller-home';
    try {
      bindRuntimeWriteClaim({ controllerHome: fx.home, owner: fx.owner.record, authority: fx.authority });
      expect(process.env[key]).toBe(fx.home);
      clearRuntimeWriteClaimForTests();
      expect(process.env[key]).toBe('caller-owned-controller-home');
    } finally {
      fx.owner.release();
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

test.skipIf(process.platform === 'win32')('cleanup authority reaches only the active immutable CLI and exact maintenance argv', async () => {
  const fx = fixture();
  try {
    const executable = join(fx.home, 'forge-cli');
    writeFileSync(executable, '#!/bin/sh\nif [ -n "$FORGE_RUNTIME_INSTANCE_ID" ]; then printf trusted; else printf untrusted; fi\n', { mode: 0o700 });
    const run = async (id: string, tool: string, target = executable) => {
      const stdoutPath = join(fx.home, `${id}.stdout`);
      const stderrPath = join(fx.home, `${id}.stderr`);
      const receipt = await runProcessRunnerFromDescriptor({
        schemaVersion: 1, processId: id, repoId: 'repo-test', controllerHome: fx.home,
        trustedRuntimeChild: 'runtime_cleanup',
        command: { kind: 'argv', executable: target, cwd: fx.home, args: [
          'runtime', 'maintenance-apply', '--controller-home', fx.home,
          '--repo-id', 'repo-test', '--tool', tool, '--args-base64', 'e30',
        ] },
        timeoutMs: 5_000, maxStdoutBytes: 1024, maxStderrBytes: 1024,
        stdoutPath, stderrPath, exitReceiptPath: join(fx.home, `${id}.exit.json`), startedAt: new Date().toISOString(),
      });
      return { receipt, stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') };
    };
    const accepted = await run('cleanup-fixed', 'runtime_cleanup_apply');
    expect(accepted.receipt.exitCode).toBe(0);
    expect(accepted.stdout).toBe('trusted');
    const wrongTool = await run('cleanup-wrong-tool', 'runtime_maintenance_apply');
    expect(wrongTool.receipt.exitCode).not.toBe(0);
    expect(wrongTool.stdout).toBe('');
    expect(wrongTool.stderr).toContain('PROCESS_RUNNER_TRUSTED_RUNTIME_CHILD_INVALID');
    const wrongExecutable = await run('cleanup-wrong-executable', 'runtime_cleanup_apply', process.execPath);
    expect(wrongExecutable.receipt.exitCode).not.toBe(0);
    expect(wrongExecutable.stdout).toBe('');
  } finally { fx.owner.release(); }
});
