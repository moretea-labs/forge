import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { inspectControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { acquireRuntimeOwnership } from '../../src/runtime/root/ownership';
import {
  ensureActiveRuntimeRelease,
  publishRuntimeRelease,
} from '../../src/runtime/root/release-store';
import {
  assertRuntimeMayWrite,
  bindInheritedRuntimeWriteClaimFromEnvironment,
  bindRuntimeWriteClaim,
  clearRuntimeWriteClaimForTests,
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
    entrypoint: 'repo-harness-runtime',
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
    const key = 'REPO_HARNESS_CONTROLLER_HOME';
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
