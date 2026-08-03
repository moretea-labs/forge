import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { SupervisorProcessManager } from '../../src/runtime/supervisor/process-manager';
import {
  collectRuntimeSourceIdentity,
  clearRuntimeSourceIdentityCacheForTest,
} from '../../src/runtime/control-plane/runtime-generation';
import {
  readReleaseIdentityBindingFromEnv,
  readReleaseIdentityBindingFromManifest,
  releaseIdentityBindingEnvironment,
  resolveManagedRuntimeSourceIdentity,
  resolveSupervisorReleaseIdentityBinding,
  runtimeSourceIdentityFromBinding,
} from '../../src/runtime/supervisor/release-identity';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initGit(repoRoot: string): string {
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'controller-runtime-fixture' }));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Repo Harness Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
  return git(repoRoot, 'rev-parse', 'HEAD');
}

describe('release identity binding', () => {
  test('manifest binding ignores ambient parent HEAD advance', () => {
    clearRuntimeSourceIdentityCacheForTest();
    const parent = tempRoot('rel-id-parent-');
    const sourceCommit = initGit(parent);
    const releaseRoot = join(parent, '_ops', 'controller-home', 'supervisor', 'releases', `r-${sourceCommit.slice(0, 12)}`);
    mkdirSync(releaseRoot, { recursive: true });
    writeFileSync(join(releaseRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 3,
      releaseRevision: sourceCommit,
      sourceCommit,
      cleanWorkspace: true,
      artifactHash: 'abc123',
    }));

    writeFileSync(join(parent, 'src', 'newer.ts'), 'export const n = 1;\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'advance ambient main');
    const ambientHead = git(parent, 'rev-parse', 'HEAD');
    expect(ambientHead).not.toBe(sourceCommit);

    const binding = readReleaseIdentityBindingFromManifest(releaseRoot);
    expect(binding?.sourceCommit).toBe(sourceCommit);
    expect(binding?.releaseRevision).toBe(sourceCommit);

    const identity = collectRuntimeSourceIdentity(releaseRoot);
    expect(identity.commit).toBe(sourceCommit);
    expect(identity.releaseRevision).toBe(sourceCommit);
    expect(identity.commit).not.toBe(ambientHead);
  });

  test('injected env binding wins over ambient Git at a live checkout root', () => {
    clearRuntimeSourceIdentityCacheForTest();
    const checkout = tempRoot('rel-id-checkout-');
    const head = initGit(checkout);
    const frozen = 'ffffffffffffffffffffffffffffffffffffffff';
    const releasePath = join(checkout, 'does-not-need-to-exist-for-env');
    const env = releaseIdentityBindingEnvironment({
      releasePath,
      releaseRevision: frozen,
      sourceCommit: frozen,
      manifestHash: 'deadbeef',
    });
    const previous = { ...process.env };
    try {
      Object.assign(process.env, env);
      process.env.REPO_HARNESS_SUPERVISOR_CHILD = '1';
      const bound = resolveManagedRuntimeSourceIdentity({ runtimeRoot: checkout, env: process.env });
      expect(bound?.commit).toBe(frozen);
      expect(bound?.releaseRevision).toBe(frozen);
      expect(bound?.repoRoot).toBe(releasePath);
      expect(bound?.canonicalRoot).toBe(releasePath);
      const identity = collectRuntimeSourceIdentity(checkout);
      expect(identity.commit).toBe(frozen);
      expect(identity.commit).not.toBe(head);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  test('partial env binding is ignored (fail closed to next authority)', () => {
    expect(readReleaseIdentityBindingFromEnv({
      REPO_HARNESS_RELEASE_REVISION: 'only-revision',
    })).toBeUndefined();
  });

  test('Supervisor binding accepts matching hints but refuses manifest overrides', () => {
    const root = tempRoot('rel-id-resolve-');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      releaseRevision: 'rev-from-manifest',
      sourceCommit: 'commit-from-manifest',
      cleanWorkspace: true,
      artifactHash: 'hash1',
    }));
    const binding = resolveSupervisorReleaseIdentityBinding({
      releasePath: root,
      releaseRevision: 'rev-from-manifest',
    });
    expect(binding?.releaseRevision).toBe('rev-from-manifest');
    expect(binding?.sourceCommit).toBe('commit-from-manifest');
    expect(binding?.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => resolveSupervisorReleaseIdentityBinding({
      releasePath: root,
      releaseRevision: 'rev-from-options',
    })).toThrow('SUPERVISOR_RELEASE_IDENTITY_MISMATCH');
    expect(() => resolveSupervisorReleaseIdentityBinding({
      releasePath: root,
      releaseRevision: 'rev-from-manifest',
      sourceCommit: 'rev-from-manifest',
    })).toThrow('SUPERVISOR_RELEASE_IDENTITY_MISMATCH');
  });

  test('injected binding must agree with an immutable manifest', () => {
    const root = tempRoot('rel-id-env-manifest-');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      releaseRevision: 'release-dirty',
      sourceCommit: 'source-commit',
      cleanWorkspace: false,
    }));
    expect(() => readReleaseIdentityBindingFromEnv({
      REPO_HARNESS_RELEASE_PATH: root,
      REPO_HARNESS_RELEASE_REVISION: 'release-dirty',
      REPO_HARNESS_RELEASE_SOURCE_COMMIT: 'release-dirty',
    })).toThrow('RELEASE_IDENTITY_ENV_MANIFEST_MISMATCH');
    expect(readReleaseIdentityBindingFromEnv({
      REPO_HARNESS_RELEASE_PATH: root,
      REPO_HARNESS_RELEASE_REVISION: 'release-dirty',
      REPO_HARNESS_RELEASE_SOURCE_COMMIT: 'source-commit',
    })?.sourceCommit).toBe('source-commit');
  });

  test('incomplete manifest never promotes revision into sourceCommit', () => {
    const root = tempRoot('rel-id-incomplete-');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      releaseRevision: 'revision-only',
      cleanWorkspace: true,
    }));
    expect(resolveSupervisorReleaseIdentityBinding({
      releasePath: root,
      releaseRevision: 'revision-only',
    })).toBeUndefined();
    expect(resolveSupervisorReleaseIdentityBinding({
      releasePath: root,
      releaseRevision: 'revision-only',
      sourceCommit: 'explicit-commit',
    })).toMatchObject({
      releaseRevision: 'revision-only',
      sourceCommit: 'explicit-commit',
    });
  });

  test('Process Manager preserves manifest sourceCommit when revision is not the commit', () => {
    const root = tempRoot('rel-id-manager-');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      releaseRevision: 'source-commit-dirty',
      sourceCommit: 'source-commit',
      cleanWorkspace: false,
    }));
    const manager = new SupervisorProcessManager({
      repoRoot: process.cwd(),
      controllerHome: root,
      ownerEpoch: 1,
      runtimeSourceRoot: root,
      releasePath: root,
      releaseRevision: 'source-commit-dirty',
      logPath: join(root, 'supervisor.log'),
    });
    const binding = (manager as unknown as {
      releaseIdentityBinding: () => { releaseRevision: string; sourceCommit: string } | undefined;
    }).releaseIdentityBinding();
    expect(binding).toMatchObject({
      releaseRevision: 'source-commit-dirty',
      sourceCommit: 'source-commit',
    });
  });

  test('runtimeSourceIdentityFromBinding never marks dirty from ambient tree', () => {
    const identity = runtimeSourceIdentityFromBinding({
      releasePath: '/tmp/release-x',
      releaseRevision: 'rev-a',
      sourceCommit: 'commit-a',
    });
    expect(identity.dirty).toBe(false);
    expect(identity.branch).toBeNull();
    expect(identity.releaseRevision).toBe('rev-a');
  });
});

// cleanup
import { afterAll } from 'bun:test';
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
