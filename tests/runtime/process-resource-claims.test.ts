import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setHostBuildCpuProbeForTest } from '../../src/runtime/resources/leases/host-build-admission';
import {
  claimsForCheck,
  claimsForRepositoryCommand,
  claimsRequireHostCapacity,
  scopeResourceClaims,
} from '../../src/runtime/execution/process-runtime/resource-claims';
import {
  classifyRepositoryCommand,
  shellCommandHasUnsafeConstructs,
  shellSegments,
} from '../../src/cli/repositories/command-classifier';
import { claimsConflict } from '../../src/runtime/resources/claims/conflicts';
import type { ExecutionLease } from '../../src/runtime/resources/leases/types';
import { claimsForAssistantPluginAction } from '../../src/runtime/plugins/store';
import type { AssistantPluginActionDescriptor } from '../../src/runtime/plugins/types';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireExecutionLeases,
  acquireExecutionLeasesAsync,
  assertFencingToken,
  listActiveLeases,
  releaseExecutionLeases,
  releaseExactExecutionLeases,
  releaseTerminalProcessLeases,
  withRepositoryMutationExclusion,
} from '../../src/runtime/resources/leases/store';
import { classifyRepositoryCommandRoute } from '../../src/runtime/execution/process-runtime/command-facade';
import {
  computePathFingerprintsSync,
  MAX_FINGERPRINT_FILE_BYTES,
} from '../../src/runtime/execution/thin-harness/fingerprint-worker';
import { ensureControllerHome, repositoryControllerRoot } from '../../src/effects/controller-home';
import { registerRepository } from '../../src/runtime/repositories/registry';
import { buildWorkflowWatchdogReport } from '../../src/runtime/watchdog/workflow-watchdog';
import { withControllerLockAsync } from '../../src/effects/controller-locks';
import {
  acquireCheckoutMutationGate,
  type CheckoutMutationGate,
  buildMutationClaims,
  normalizeMutationOwnerIdentity,
  releaseCheckoutMutationGateOwned,
} from '../../src/runtime/execution/thin-harness/mutation-gate';

function lease(resourceKey: string, mode: 'read' | 'write' | 'exclusive'): ExecutionLease {
  return { resourceKey, mode } as ExecutionLease;
}
beforeEach(() => setHostBuildCpuProbeForTest(() => ({ cpus: 10, load: 2.5, memoryFreePercent: 53 })));
afterEach(() => setHostBuildCpuProbeForTest(undefined));

describe('Process Runtime fine-grained resource claims', () => {
  test('oversized selected files return unknown fingerprint evidence instead of metadata-only hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-fingerprint-budget-'));
    try {
      writeFileSync(join(root, 'large.txt'), Buffer.alloc(MAX_FINGERPRINT_FILE_BYTES + 1, 0x61));
      expect(() =>
        computePathFingerprintsSync({
          root,
          paths: ['large.txt'],
          statusByPath: { 'large.txt': [' M large.txt'] },
        }),
      ).toThrow('SNAPSHOT_BUDGET');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('heavy non-Apple work uses pressure admission while focused tests remain independent', () => {
    for (const command of [['bun', 'test'], ['bun', 'run', 'check:main'], ['cargo', 'build'], ['pytest']]) {
      expect(claimsRequireHostCapacity([], command)).toBe(true);
    }
    expect(claimsRequireHostCapacity([], ['bun', 'test', 'tests/unit.test.ts'])).toBe(false);
    expect(claimsRequireHostCapacity([], ['echo', 'bun test'])).toBe(false);
    expect(claimsRequireHostCapacity([{ resourceKey: 'heavy-check:repo' }])).toBe(true);
  });
  test('raw simulator cold boots share native host admission without matching quoted payloads', () => {
    const claim = { resourceKey: 'host-service:ios-build', mode: 'write' as const };
    for (const command of [
      ['xcrun', 'simctl', 'boot', 'D'],
      ['/bin/bash', '-lc', 'xcrun simctl boot D'],
      'xcrun simctl boot D',
    ])
      expect(claimsForRepositoryCommand(command, 'repo', 'checkout')).toContainEqual(claim);
    for (const command of [
      ['xcrun', 'simctl', 'list', '--json'],
      ['echo', 'xcrun simctl boot D'],
    ]) {
      expect(claimsForRepositoryCommand(command, 'repo', 'checkout')).not.toContainEqual(claim);
    }
  });
  test('MutationGate reuses Process Runtime path, index, and repository-scoped ref claims (#725)', () => {
    const a = buildMutationClaims('repo1', 'co1', { writePaths: ['src/alpha.ts'], mutatesGitIndex: false });
    const b = buildMutationClaims('repo1', 'co1', { writePaths: ['./src/beta.ts'], mutatesGitIndex: false });
    const overlap = buildMutationClaims('repo1', 'co1', { writePaths: ['src/alpha.ts'], mutatesGitIndex: false });
    expect(a).toEqual([{ resourceKey: 'path:co1:src/alpha.ts', mode: 'write' }]);
    expect(b).toEqual([{ resourceKey: 'path:co1:src/beta.ts', mode: 'write' }]);
    expect(claimsConflict(a[0]!, lease(b[0]!.resourceKey, 'write'))).toBe(false);
    expect(claimsConflict(a[0]!, lease(overlap[0]!.resourceKey, 'write'))).toBe(true);
    expect(a.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);

    const staged = buildMutationClaims('repo1', 'co1', {
      writePaths: ['src/alpha.ts'],
      mutatesGitIndex: true,
      mutatesGitRefs: true,
    });
    expect(staged).toEqual([
      { resourceKey: 'path:co1:src/alpha.ts', mode: 'write' },
      { resourceKey: 'git-index:co1', mode: 'exclusive' },
      { resourceKey: 'git-refs:repo1', mode: 'exclusive' },
    ]);
    expect(claimsConflict(staged[2]!, lease('git-refs:repo1', 'exclusive'))).toBe(true);
    expect(claimsConflict(staged[2]!, lease('git-refs:repo2', 'exclusive'))).toBe(false);
    expect(staged.some((claim) => claim.resourceKey.startsWith('git-ref:'))).toBe(false);
    expect(staged.some((claim) => claim.resourceKey.startsWith('git-head:'))).toBe(false);

    const stageOnly = buildMutationClaims('repo1', 'co1', { mutatesGitIndex: true });
    expect(stageOnly).toEqual([{ resourceKey: 'git-index:co1', mode: 'exclusive' }]);
    expect(buildMutationClaims('repo1', 'co1', { mutatesGitIndex: true, mutatesGitRefs: true })).toEqual(
      claimsForRepositoryCommand(['git', 'commit', '-m', 'slice'], 'repo1', 'co1'),
    );
  });

  test('MutationGate unknown or invalid source scopes do not create checkout-wide or implicit Git claims (#725)', () => {
    for (const options of [
      {},
      { mutatesGitIndex: false },
      { writePaths: [] as string[], mutatesGitIndex: false },
      { writePaths: ['src/a.ts', '../outside'], mutatesGitIndex: false },
      { writePaths: ['src/a.ts', '/outside'], mutatesGitIndex: false },
      { writePaths: ['src/a.ts', '*'], mutatesGitIndex: false },
    ]) {
      const claims = buildMutationClaims('repo1', 'co1', options);
      expect(claims.some((claim) => claim.resourceKey.startsWith('workspace:'))).toBe(false);
      expect(claims.some((claim) => claim.resourceKey.startsWith('git-index:'))).toBe(false);
      expect(claims.some((claim) => claim.resourceKey.startsWith('git-refs:'))).toBe(false);
    }
    expect(buildMutationClaims('repo1', 'co1')).toEqual([]);
  });

  test('two same-checkout MutationGate owners coexist on disjoint paths but never overlap (#713)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-713-mutation-home-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'forge-713-mutation-repo-'));
    const held: CheckoutMutationGate[] = [];
    try {
      ensureControllerHome(home);
      writeFileSync(join(repoRoot, 'alpha.txt'), 'initial alpha');
      writeFileSync(join(repoRoot, 'beta.txt'), 'initial beta');
      const acquire = (owner: string, path: string) =>
        acquireCheckoutMutationGate({
          controllerHome: home,
          repoId: 'repo713',
          checkoutId: 'checkout713',
          repoRoot,
          owner,
          ownership: { writePaths: [path], mutatesGitIndex: false },
        });

      const a = await acquire('fast:alpha', 'alpha.txt');
      expect('acquired' in a && a.acquired).toBe(true);
      if (!('acquired' in a) || !a.acquired) throw new Error('TEST_ALPHA_GATE_NOT_ACQUIRED');
      held.push(a.gate);
      expect(a.gate.baseHead).toBeNull();
      expect(a.gate.baseStatusHash).toBeNull();
      const b = await acquire('fast:beta', 'beta.txt');
      expect('acquired' in b && b.acquired).toBe(true);
      if (!('acquired' in b) || !b.acquired) throw new Error('TEST_BETA_GATE_NOT_ACQUIRED');
      held.push(b.gate);
      expect(b.gate.baseHead).toBeNull();
      expect(b.gate.baseStatusHash).toBeNull();
      writeFileSync(join(repoRoot, 'alpha.txt'), 'writer A');
      writeFileSync(join(repoRoot, 'beta.txt'), 'writer B');
      const blocked = await acquire('fast:overlap', 'alpha.txt');
      expect(blocked).toMatchObject({ busy: true, reason: 'mutation_ownership_busy' });
      expect(readFileSync(join(repoRoot, 'alpha.txt'), 'utf8')).toBe('writer A');
      expect(readFileSync(join(repoRoot, 'beta.txt'), 'utf8')).toBe('writer B');
    } finally {
      for (const gate of held) releaseCheckoutMutationGateOwned(home, gate);
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('MutationGate owner identity follows the canonical Runtime fencing claim', () => {
    const keys = [
      'FORGE_RUNTIME_INSTANCE_ID',
      'FORGE_RUNTIME_INCARNATION_GENERATION',
      'FORGE_WRITER_INSTANCE_ID',
      'FORGE_WRITER_GENERATION',
      'FORGE_DAEMON_INSTANCE_ID',
      'FORGE_ACTIVE_RUNTIME_REVISION',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.FORGE_RUNTIME_INSTANCE_ID = 'runtime-canonical-instance';
      process.env.FORGE_RUNTIME_INCARNATION_GENERATION = '17';
      process.env.FORGE_WRITER_INSTANCE_ID = 'legacy-writer-instance';
      process.env.FORGE_WRITER_GENERATION = 'legacy-writer-generation';
      process.env.FORGE_DAEMON_INSTANCE_ID = 'legacy-daemon-instance';
      process.env.FORGE_ACTIVE_RUNTIME_REVISION = 'legacy-runtime-revision';
      expect(
        normalizeMutationOwnerIdentity({
          repoId: 'repo1',
          checkoutId: 'checkout1',
          owner: 'fast:identity-test',
        }),
      ).toMatchObject({
        controllerInstanceId: 'runtime-canonical-instance',
        controllerGeneration: '17',
      });
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('two scoped editor transactions overlap in time on different paths without repository lock (#713)', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-713-parallel-editors-'));
    const pathA = [{ resourceKey: 'path:co1:src/alpha.ts', mode: 'write' as const }];
    const pathB = [{ resourceKey: 'path:co1:src/beta.ts', mode: 'write' as const }];
    const samePath = [{ resourceKey: 'path:co1:src/alpha.ts', mode: 'write' as const }];
    const opts = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    try {
      ensureControllerHome(home);
      const output = withRepositoryMutationExclusion(
        home,
        'repo1',
        'writer-alpha',
        () => {
          const alphaLease = listActiveLeases(home, 'repo1').find(
            (lease) => lease.resourceKey === pathA[0]!.resourceKey,
          );
          expect(alphaLease).toMatchObject({ checkoutId: 'co1', ownerIdentity: { checkoutId: 'co1' } });
          const nested = withRepositoryMutationExclusion(
            home,
            'repo1',
            'writer-beta',
            () => {
              expect(listActiveLeases(home, 'repo1').some((lease) => lease.resourceKey === pathB[0]!.resourceKey)).toBe(
                true,
              );
              expect(() =>
                withRepositoryMutationExclusion(home, 'repo1', 'writer-overlap', () => 'no', undefined, samePath),
              ).toThrow('REPOSITORY_PROCESS_LEASE_HELD');
              return 'beta-ok';
            },
            undefined,
            pathB,
          );
          expect(nested).toBe('beta-ok');
          expect(() => withRepositoryMutationExclusion(home, 'repo1', 'legacy-unknown', () => 'no')).toThrow(
            'REPOSITORY_PROCESS_LEASE_HELD',
          );
          const process = acquireExecutionLeases(home, 'repo1', 'managed-process', pathB, opts);
          expect(process.acquired).toBe(true);
          if (process.acquired) releaseExecutionLeases(home, 'repo1', 'managed-process', process.leases, opts);
          return 'alpha-ok';
        },
        undefined,
        pathA,
      );
      expect(output).toBe('alpha-ok');
      expect(listActiveLeases(home, 'repo1')).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('exact validated path leases bypass the legacy repository ControllerLock while same-path and opaque claims stay fenced (#713)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-713-legacy-repository-lock-'));
    const pathA = [{ resourceKey: 'path:co1:src/alpha.ts', mode: 'write' as const, checkoutId: 'co1' }];
    const pathB = [{ resourceKey: 'path:co1:src/beta.ts', mode: 'write' as const, checkoutId: 'co1' }];
    const opaqueSource = [{ resourceKey: 'repo-content:*', mode: 'write' as const, checkoutId: 'co1' }];
    const opts = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    try {
      ensureControllerHome(home);
      await withControllerLockAsync(
        home,
        { scope: 'repository', repoId: 'repo1' },
        'legacy-editor',
        async () => {
          const alpha = acquireExecutionLeases(home, 'repo1', 'path-alpha', pathA, opts);
          expect(alpha.acquired).toBe(true);
          if (!alpha.acquired) return;
          try {
            const overlap = acquireExecutionLeases(home, 'repo1', 'path-alpha-overlap', pathA, opts);
            expect(overlap.acquired).toBe(false);
            expect(overlap.blockers[0]).toMatchObject({
              resourceKey: pathA[0]!.resourceKey,
              ownerJobId: 'path-alpha',
            });

            const beta = acquireExecutionLeases(home, 'repo1', 'path-beta', pathB, opts);
            expect(beta.acquired).toBe(true);
            if (beta.acquired) releaseExecutionLeases(home, 'repo1', 'path-beta', beta.leases, opts);

            const opaque = acquireExecutionLeases(home, 'repo1', 'opaque-source', opaqueSource, opts);
            expect(opaque.acquired).toBe(false);
            expect(opaque.blockers[0]).toMatchObject({
              resourceKey: 'repository-writer',
              ownerJobId: 'legacy-editor',
            });
          } finally {
            releaseExecutionLeases(home, 'repo1', 'path-alpha', alpha.leases, opts);
          }
        },
        undefined,
        0,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('scoped editor releases only its own resource lease after mutation throws (#713)', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-713-scoped-editor-throw-'));
    const opts = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    try {
      ensureControllerHome(home);
      const foreign = acquireExecutionLeases(
        home,
        'repo1',
        'foreign',
        [{ resourceKey: 'path:co1:src/foreign.ts', mode: 'write' }],
        opts,
      );
      expect(foreign.acquired).toBe(true);
      expect(() =>
        withRepositoryMutationExclusion(
          home,
          'repo1',
          'writer-throw',
          () => {
            throw new Error('test failure');
          },
          undefined,
          [{ resourceKey: 'path:co1:src/alpha.ts', mode: 'write' }],
        ),
      ).toThrow('test failure');
      const active = listActiveLeases(home, 'repo1');
      expect(active).toHaveLength(1);
      expect(active[0]?.ownerJobId).toBe('foreign');
      if (foreign.acquired) releaseExecutionLeases(home, 'repo1', 'foreign', foreign.leases, opts);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('model-declared mutation paths narrow source claims without platform inference (#478)', () => {
    const command = ['bash', 'scripts/run_module_check.sh', 'integration'];
    const inferred = claimsForRepositoryCommand(command, 'repo1', 'co1');
    expect(inferred).not.toContainEqual({ resourceKey: 'workspace:co1', mode: 'write' });

    const scoped = claimsForRepositoryCommand(command, 'repo1', 'co1', 'main', undefined, undefined, ['client-a']);
    expect(scoped).toContainEqual({ resourceKey: 'path:co1:client-a', mode: 'write' });
    expect(scoped.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
    expect(scoped.some((claim) => claim.resourceKey === 'build-cache:repo1')).toBe(false);

    const leaseA = lease('path:co1:client-a', 'write');
    expect(claimsConflict({ resourceKey: 'path:co1:client-b/File.swift', mode: 'write' }, leaseA)).toBe(false);
    expect(claimsConflict({ resourceKey: 'path:co1:client-a/src/File.kt', mode: 'write' }, leaseA)).toBe(true);
  });

  test('model-declared mutation scope makes even classifier-readonly commands lease-bearing (#478)', () => {
    expect(classifyRepositoryCommandRoute(['git', 'status'])).toEqual({
      route: 'process_direct',
      reason: 'readonly_fast_path',
    });
    expect(classifyRepositoryCommandRoute(['git', 'status'], { mutationPaths: ['client-a'] })).toEqual({
      route: 'process_managed',
      reason: 'model_declared_mutation_scope',
    });
  });

  test('repository mutation exclusion uses exact source claims when the caller knows its paths (#478)', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-path-scoped-editor-'));
    const held = acquireExecutionLeases(
      controllerHome,
      'repo1',
      'android-build',
      [{ resourceKey: 'path:co1:android', mode: 'write' }],
      { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false },
    );
    expect(held.acquired).toBe(true);
    try {
      expect(
        withRepositoryMutationExclusion(controllerHome, 'repo1', 'ios-edit', () => 'applied', undefined, [
          { resourceKey: 'path:co1:ios/App.swift', mode: 'write' },
        ]),
      ).toBe('applied');

      expect(() =>
        withRepositoryMutationExclusion(controllerHome, 'repo1', 'android-edit', () => 'unreachable', undefined, [
          { resourceKey: 'path:co1:android/app/src/Main.kt', mode: 'write' },
        ]),
      ).toThrow('REPOSITORY_PROCESS_LEASE_HELD');

      // Legacy/unknown source mutation remains fail-closed.
      expect(() =>
        withRepositoryMutationExclusion(controllerHome, 'repo1', 'unknown-edit', () => 'unreachable'),
      ).toThrow('REPOSITORY_PROCESS_LEASE_HELD');
    } finally {
      releaseExecutionLeases(controllerHome, 'repo1', 'android-build', held.leases, {
        visibility: 'ephemeral',
        notifyScheduler: false,
        invalidateProjection: false,
        emitRuntimeEvent: false,
      });
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('exact leased remote review-branch deletion does not acquire an unrelated checkout writer (#469)', () => {
    const sha = 'a'.repeat(40);
    const branch = 'ios/onboarding-welcome-review-20261026';
    const exact = [
      'git',
      'push',
      '--porcelain',
      '--force-with-lease=refs/heads/' + branch + ':' + sha,
      'origin',
      ':refs/heads/' + branch,
    ];
    // Do not downgrade Git authorization: only the physical resource lease is narrowed.
    expect(classifyRepositoryCommand(exact, 'ios/integration').risk).toBe('destructive');
    const claims = claimsForRepositoryCommand(exact, 'repo1', 'checkout-dirty', 'ios/integration');
    expect(claims).toEqual([{ resourceKey: 'remote-ref:repo1:origin:refs/heads/' + branch, mode: 'exclusive' }]);
    expect(claimsConflict(claims[0]!, lease('workspace:checkout-dirty', 'write'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('git-index:checkout-dirty', 'exclusive'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('git-refs:repo1', 'exclusive'))).toBe(true);
    expect(claimsConflict(claims[0]!, lease('remote:repo1', 'exclusive'))).toBe(true);
    expect(claimsConflict(claims[0]!, lease('remote-ref:repo1:origin:refs/heads/' + branch, 'write'))).toBe(true);
    expect(claimsConflict(claims[0]!, lease('remote-ref:repo1:origin:refs/heads/review/other', 'exclusive'))).toBe(
      false,
    );
    expect(claimsConflict(claims[0]!, lease('remote-ref:repo2:origin:refs/heads/' + branch, 'exclusive'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('remote:repo2', 'exclusive'))).toBe(false);

    const variants: Array<readonly string[] | string> = [
      ['git', 'push', 'origin', ':refs/heads/' + branch],
      [
        'git',
        'push',
        '--force-with-lease=refs/heads/' + branch + ':' + sha.slice(1),
        'origin',
        ':refs/heads/' + branch,
      ],
      ['git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha, 'origin', ':refs/heads/other-branch'],
      ['git', 'push', '--force-with-lease=refs/heads/main:' + sha, 'origin', ':refs/heads/main'],
      ['git', 'push', '--force-with-lease=refs/heads/ios/integration:' + sha, 'origin', ':refs/heads/ios/integration'],
      ['git', 'push', '--force-with-lease=refs/heads/release/1.8:' + sha, 'origin', ':refs/heads/release/1.8'],
      ['git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha, 'upstream', ':refs/heads/' + branch],
      [
        'git',
        'push',
        '--force-with-lease=refs/heads/' + branch + ':' + sha,
        'origin',
        ':refs/heads/' + branch,
        '--tags',
      ],
      'git push --force-with-lease=refs/heads/' + branch + ':' + sha + ' origin :refs/heads/' + branch,
    ];
    for (const unsafe of variants) {
      const conservative = claimsForRepositoryCommand(unsafe, 'repo1', 'checkout-dirty', 'ios/integration');
      expect(conservative.some((claim) => claim.resourceKey.startsWith('remote-ref:'))).toBe(false);
      expect(conservative).not.toContainEqual({ resourceKey: 'workspace:checkout-dirty', mode: 'write' });
    }
    expect(
      claimsForRepositoryCommand(
        ['git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha, 'origin', '--delete', branch],
        'repo1',
        'checkout-dirty',
        'ios/integration',
      ),
    ).toEqual([{ resourceKey: 'remote-ref:repo1:origin:refs/heads/' + branch, mode: 'exclusive' }]);
  });

  test('exact remote ref leases serialize one branch while allowing independent review branches (#469)', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-remote-ref-claims-'));
    const original = [{ resourceKey: 'remote-ref:repo1:origin:refs/heads/review/first', mode: 'exclusive' as const }];
    const same = [{ ...original[0]! }];
    const different = [{ resourceKey: 'remote-ref:repo1:origin:refs/heads/review/second', mode: 'exclusive' as const }];
    const broad = [{ resourceKey: 'git-refs:repo1', mode: 'exclusive' as const }];
    try {
      expect(
        acquireExecutionLeases(controllerHome, 'repo1', 'first', original, { visibility: 'ephemeral' }).acquired,
      ).toBe(true);
      expect(acquireExecutionLeases(controllerHome, 'repo1', 'same', same, { visibility: 'ephemeral' }).acquired).toBe(
        false,
      );
      expect(
        acquireExecutionLeases(controllerHome, 'repo1', 'different', different, { visibility: 'ephemeral' }).acquired,
      ).toBe(true);
      expect(
        acquireExecutionLeases(controllerHome, 'repo1', 'broad', broad, { visibility: 'ephemeral' }).acquired,
      ).toBe(false);
      releaseExecutionLeases(controllerHome, 'repo1', 'first');
      releaseExecutionLeases(controllerHome, 'repo1', 'different');
      expect(
        acquireExecutionLeases(controllerHome, 'repo1', 'broad', broad, { visibility: 'ephemeral' }).acquired,
      ).toBe(true);
    } finally {
      releaseExecutionLeases(controllerHome, 'repo1', 'first');
      releaseExecutionLeases(controllerHome, 'repo1', 'different');
      releaseExecutionLeases(controllerHome, 'repo1', 'broad');
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('plugin lease acquisition waits for transient index-lock contention but returns resource conflicts immediately', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-async-plugin-lease-'));
    const claims = [{ resourceKey: 'provider-state:browser', mode: 'write' as const }];
    let pending: ReturnType<typeof acquireExecutionLeasesAsync> | undefined;
    try {
      await withControllerLockAsync(
        controllerHome,
        { scope: 'global', resource: 'execution-leases' },
        'test-index-lock-holder',
        async () => {
          pending = acquireExecutionLeasesAsync(controllerHome, 'repo1', 'waiting-owner', claims, {
            visibility: 'ephemeral',
          });
          await new Promise((resolve) => setTimeout(resolve, 80));
        },
        10_000,
        0,
      );
      const acquiredAfterLockRelease = await pending!;
      expect(acquiredAfterLockRelease.acquired).toBe(true);
      releaseExecutionLeases(controllerHome, 'repo1', 'waiting-owner');

      const first = acquireExecutionLeases(controllerHome, 'repo1', 'first-owner', claims, { visibility: 'ephemeral' });
      expect(first.acquired).toBe(true);
      const startedAt = performance.now();
      const conflict = await acquireExecutionLeasesAsync(controllerHome, 'repo1', 'second-owner', claims, {
        visibility: 'ephemeral',
      });
      expect(conflict.acquired).toBe(false);
      expect(conflict.blockers.map((blocker) => blocker.resourceKey)).toEqual(['provider-state:browser']);
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      releaseExecutionLeases(controllerHome, 'repo1', 'waiting-owner');
      releaseExecutionLeases(controllerHome, 'repo1', 'first-owner');
      releaseExecutionLeases(controllerHome, 'repo1', 'second-owner');
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('source text mentioning xcodebuild never claims a live iOS host slot', () => {
    const unrelated: Array<string | readonly string[]> = [
      [
        'zsh',
        '-lc',
        "python3 - <<'PY'\nprint('xcodebuild test -derivedDataPath build/DerivedData')\nPY\nbun test tests/runtime/generated-cache-retention.test.ts",
      ],
      ['zsh', '-lc', "rg -n 'xcodebuild test' src && bun test tests/runtime/process-resource-claims.test.ts"],
      'echo "xcodebuild test" && bun test tests/runtime/generated-cache-retention.test.ts',
    ];
    for (const command of unrelated) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(
        claims.some(
          (claim) =>
            claim.resourceKey === 'host-service:ios-build' || claim.resourceKey === 'host-service:ios-simulator-test',
        ),
      ).toBe(false);
    }
    for (const command of [
      ['zsh', '-lc', 'cd /repo && xcodebuild test -project App.xcodeproj'],
      'xcrun xcodebuild -project App.xcodeproj build > build.log 2>&1',
      'env TEST=1 xcodebuild test -project App.xcodeproj',
      'FOO=bar xcodebuild test -project App.xcodeproj',
      'env TEST=1 xcrun xcodebuild test -project App.xcodeproj',
    ] as const) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'host-service:ios-build', mode: 'write' });
    }
  });

  test('host build capacity bounds disjoint Xcode caches while preserving cache identity fences', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-xcode-cache-'));
    try {
      mkdirSync(join(root, 'checkout-a'));
      mkdirSync(join(root, 'checkout-b'));
      const command = ['xcodebuild', '-project', 'App.xcodeproj', '-derivedDataPath', 'build/DerivedData', 'build'];
      const a = claimsForRepositoryCommand(command, 'repo1', 'co-a', 'main', join(root, 'checkout-a'));
      const b = claimsForRepositoryCommand(command, 'repo1', 'co-b', 'main', join(root, 'checkout-b'));
      const home = join(root, 'controller');
      const options = { visibility: 'ephemeral' as const };
      expect(acquireExecutionLeases(home, 'repo1', 'build-a', a, options).acquired).toBe(true);
      expect(acquireExecutionLeases(home, 'repo1', 'build-b', b, options).acquired).toBe(false);
      expect(a).toContainEqual({ resourceKey: 'host-service:ios-build', mode: 'write' });
      const cacheA = a.filter((claim) => claim.resourceKey.startsWith('build-cache:'));
      const cacheB = b.filter((claim) => claim.resourceKey.startsWith('build-cache:'));
      expect(
        cacheA.some((left) => cacheB.some((right) => claimsConflict(left, lease(right.resourceKey, right.mode)))),
      ).toBe(false);
      const shared = claimsForRepositoryCommand(
        [
          'xcodebuild',
          '-project',
          'App.xcodeproj',
          '-derivedDataPath',
          join(root, 'checkout-a/build/DerivedData'),
          'build',
        ],
        'repo2',
        'co-c',
        'main',
        root,
      );
      expect(acquireExecutionLeases(home, 'repo2', 'shared-cache', shared, options).acquired).toBe(false);
      const parent = claimsForRepositoryCommand(
        ['xcodebuild', '-project', 'App.xcodeproj', '-derivedDataPath', join(root, 'checkout-a/build'), 'clean'],
        'repo1',
        'co-d',
        'main',
        root,
      );
      expect(acquireExecutionLeases(home, 'repo1', 'parent-cache', parent, options).acquired).toBe(false);
      const unknown = claimsForRepositoryCommand(['xcodebuild', '-project', 'App.xcodeproj', 'build'], 'repo1', 'co-e');
      expect(acquireExecutionLeases(home, 'repo1', 'unknown-cache', unknown, options).acquired).toBe(false);
      releaseExecutionLeases(home, 'repo1', 'build-a');
      expect(acquireExecutionLeases(home, 'repo1', 'build-b', b, options).acquired).toBe(true);
      const otherRepo = claimsForRepositoryCommand(command, 'repo2', 'co-f', 'main', join(root, 'checkout-a'));
      expect(acquireExecutionLeases(home, 'repo2', 'other-repo', otherRepo, options).acquired).toBe(false);
      expect(claimsForRepositoryCommand(['xcodebuild', '-version'], 'repo2', 'co-f')).not.toContainEqual({
        resourceKey: 'host-service:ios-build',
        mode: 'write',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Xcode cache identity follows the execution cwd, literal shell paths and existing symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-xcode-path-'));
    try {
      const cwd = join(root, 'actual cwd');
      mkdirSync(cwd);
      symlinkSync(cwd, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      symlinkSync(
        join(root, 'missing-target'),
        join(root, 'dangling'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const absolute = claimsForRepositoryCommand(
        ['xcodebuild', '-derivedDataPath', join(cwd, 'cache'), 'build'],
        'repo1',
        'co-a',
      );
      for (const command of [
        'xcodebuild -derivedDataPath cache build',
        'xcrun xcodebuild -derivedDataPath cache build',
        ['bash', '-lc', 'xcodebuild -derivedDataPath cache build'],
        `cd '${join(root, 'alias')}' && xcodebuild -derivedDataPath cache build`,
      ]) {
        const relative = claimsForRepositoryCommand(command, 'repo1', 'co-b', 'main', root, cwd);
        expect(
          relative.some((claim) =>
            absolute.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))),
          ),
        ).toBe(true);
        expect(relative).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'read' });
      }
      for (const command of [
        'xcodebuild -derivedDataPath "$CACHE" build',
        'xcodebuild -derivedDataPath cache build && bun run build',
        `cd '${cwd}' || xcodebuild -derivedDataPath cache build`,
        `cd '${cwd}' ; xcodebuild -derivedDataPath cache build`,
        ['xcodebuild', '-derivedDataPath', 'one', '-derivedDataPath', 'two', 'build'],
        ['xcodebuild', '-derivedDataPath', 'cache', 'OBJROOT=/shared', 'build'],
        ['xcodebuild', '-derivedDataPath', 'cache', 'PROJECT_TEMP_DIR=/shared', 'build'],
        ['xcodebuild', '-derivedDataPath', 'cache', 'archive'],
        ['xcodebuild', '-derivedDataPath', join(root, 'dangling/cache'), 'build'],
      ]) {
        expect(claimsForRepositoryCommand(command, 'repo1', 'co-b', 'main', root, cwd)).toContainEqual({
          resourceKey: 'build-cache:repo1',
          mode: 'write',
        });
      }
      const testA = claimsForRepositoryCommand(
        ['xcodebuild', 'test', '-derivedDataPath', join(cwd, 'a')],
        'repo1',
        'co-a',
      );
      const testB = claimsForRepositoryCommand(
        ['xcodebuild', 'test', '-derivedDataPath', join(cwd, 'b')],
        'repo2',
        'co-b',
      );
      expect(testA).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
      expect(testB.some((claim) => claimsConflict(claim, lease('host-service:ios-simulator-test', 'write')))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readonly commands observe source without taking the legacy checkout lease', () => {
    const claims = claimsForRepositoryCommand(['git', 'status'], 'repo1', 'co1');
    expect(claims).toEqual([{ resourceKey: 'validation-input:co1', mode: 'read' }]);
    expect(claims.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);
  });

  test('Forge-specific gate names do not implicitly bypass generic repository writer claims', () => {
    const claims = claimsForRepositoryCommand(['bun', 'scripts/run-governed-gate.ts', 'main'], 'repo1', 'co1');
    expect(claims).not.toContainEqual({ resourceKey: 'workspace:co1', mode: 'write' });
    for (const packageManager of ['bun', 'npm']) {
      const wrapped = claimsForRepositoryCommand([packageManager, 'run', 'check:main'], 'repo1', 'co1');
      const ordinary = claimsForRepositoryCommand([packageManager, 'run', 'check:custom'], 'repo1', 'co1');
      expect(wrapped).toEqual(ordinary);
      expect(wrapped).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
      expect(wrapped).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      expect(wrapped.some((claim) => claim.resourceKey === 'heavy-check:repo1')).toBe(false);
    }
    // Resource declarations remain generic and explicit for any project.
    const declared = claimsForCheck('package:check:main', ['bun', 'run', 'check:main'], 'repo1', 'co1', {
      reads: ['.'],
      cache: 'write',
      temp: 'isolated',
      git: 'read',
    });
    expect(declared).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(declared).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(declared.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode === 'write')).toBe(false);
  });

  test('declared source reads observe without blocking another session source edit (#713)', () => {
    const checks = claimsForCheck('custom:report', ['node', 'report.js'], 'repo1', 'co1', {
      reads: ['src'],
      writes: ['reports'],
    });
    expect(checks).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(checks.some((claim) => claimsConflict(claim, lease('path:co1:src/index.ts', 'write')))).toBe(false);
    expect(checks.some((claim) => claimsConflict(claim, lease('path:co1:reports/output.json', 'write')))).toBe(true);
    const observer = claimsForCheck('custom:scan', ['node', 'scan.js'], 'repo1', 'co1', { reads: ['src'] });
    expect(observer.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);

    const device = claimsForRepositoryCommand(['bash', 'scripts/run_android_check.sh', 'fast-journey'], 'repo1', 'co1');
    expect(device).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(device).toContainEqual({ resourceKey: 'host-service:android-emulator-test', mode: 'write' });
    expect(device.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);
  });

  test('declared output paths never inherit missing read-scope checkout ownership (#713)', () => {
    const scoped = claimsForCheck('custom:emit', ['node', 'generator.js'], 'repo1', 'co1', {
      writes: ['reports/output.json'],
      cache: 'write',
    });
    expect(scoped).toContainEqual({ resourceKey: 'path:co1:reports/output.json', mode: 'write' });
    expect(scoped).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(scoped.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
    expect(scoped.some((claim) => claimsConflict(claim, lease('path:co1:unrelated.ts', 'write')))).toBe(false);
    expect(scoped.some((claim) => claimsConflict(claim, lease('path:co1:reports/output.json', 'write')))).toBe(true);
    const unknown = claimsForCheck('custom:opaque', ['node', 'unknown.js'], 'repo1', 'co1', {
      cache: 'write',
    });
    expect(unknown).not.toContainEqual({ resourceKey: 'workspace:co1', mode: 'write' });
  });

  test('focused snapshot refresh uses source observation instead of checkout read ownership (#713)', () => {
    const claims = claimsForRepositoryCommand(
      ['bun', 'test', 'tests/runtime/sample.test.ts', '--update-snapshots'],
      'repo1',
      'co1',
    );
    expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'path:co1:tests/runtime/sample.test.ts', mode: 'write' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
  });

  test('Cargo focused validation observes source and shares checkout with existing global writer (#713)', () => {
    for (const command of [
      ['cargo', 'test', '--manifest-path', 'apps/desktop-native/bridge/Cargo.toml', '--lib', 'agent'],
      ['cargo', 'check', '--manifest-path', 'apps/desktop-native/bridge/Cargo.toml'],
      'cargo test -p forge-agent --lib',
      ['bash', '-lc', 'cargo test -p forge-agent --lib'],
    ] as const) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
      expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      expect(claims).toHaveLength(2);
      expect(claims.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, lease('path:co1:src/other.rs', 'write')))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, lease('build-cache:repo1', 'write')))).toBe(true);
    }
    const checkClaims = claimsForCheck(
      'cargo:focused-agent-test',
      ['cargo', 'test', '-p', 'forge-agent', '--lib'],
      'repo1',
      'co1',
    );
    expect(checkClaims.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);
  });

  test('opaque build/test observes source without checkout-wide writer (#713)', () => {
    const legacyWriter = lease('workspace:co1', 'write');
    for (const command of [
      ['bun', 'run', 'build'],
      ['npm', 'test'],
      ['cargo', 'build'],
      'set -euo pipefail; bun run check:type',
      ['bash', '-lc', 'set -euo pipefail; bun run check:type && bun run check:architecture'],
      'bun run check:type && bun run check:lint',
    ] as const) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
      expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, legacyWriter))).toBe(false);
      expect(claims.some((claim) => claim.resourceKey.startsWith('path:co1:set'))).toBe(false);
    }
  });

  test('single validation command redirected to exact log path does not monopolize checkout (#713)', () => {
    const foreignSourceWriter = lease('path:co1:src/independent.ts', 'write');
    const foreignLogWriter = lease('path:co1:reports/check.log', 'write');
    for (const command of [
      'bun run check:type > reports/check.log 2>&1',
      'bun test tests/runtime/smoke.test.ts >> reports/check.log',
      ['bash', '-lc', 'bun run check:type > reports/check.log 2>&1'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
      expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      expect(claims).toContainEqual({ resourceKey: 'path:co1:reports/check.log', mode: 'write' });
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, foreignSourceWriter))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, foreignLogWriter))).toBe(true);
    }
    for (const unsafe of [
      'bun run check:type > /tmp/global.log 2>&1',
      'bun run check:type > reports/*.log',
      'bun run check:type > $OUTPUT',
      'bun run check:type > reports/check.log && touch src/other.ts',
      'bun run check:type > reports/check.log; touch src/other.ts',
      'bun run check:type < config.json > reports/check.log',
    ]) {
      expect(claimsForRepositoryCommand(unsafe, 'repo1', 'co1')).not.toContainEqual({
        resourceKey: 'workspace:co1',
        mode: 'write',
      });
    }
  });

  test('known read-only architecture scanner composes without checkout lock, unknown Node remains fenced (#713)', () => {
    const safe = claimsForRepositoryCommand(
      ['bash', '-lc', 'set -euo pipefail; bun run check:type && node scripts/check-runtime-architecture.mjs'],
      'repo1',
      'co1',
    );
    expect(safe).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(safe).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(safe.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
    expect(safe.some((claim) => claim.resourceKey === 'path:co1:scripts/check-runtime-architecture.mjs')).toBe(false);

    for (const unsafe of [
      'bun run check:type && node scripts/unknown-script.mjs',
      'bun run check:type && node scripts/check-runtime-architecture.mjs --write',
      'bun run check:type && node scripts/check-runtime-architecture.mjs > out.txt',
      'bun run check:type && node scripts/check-runtime-architecture.mjs && touch out.txt',
    ]) {
      expect(claimsForRepositoryCommand(['bash', '-lc', unsafe], 'repo1', 'co1')).not.toContainEqual({
        resourceKey: 'workspace:co1',
        mode: 'write',
      });
    }
  });

  test('composed validation plus bounded Git inspections no longer owns checkout (#713)', () => {
    const legacyWriter = lease('workspace:co1', 'write');
    for (const command of [
      'bun run check:type && git status --short',
      'bun run check:type && git diff --check',
      'set -euo pipefail; bun run check:type && git rev-parse HEAD',
      ['bash', '-lc', 'set -euo pipefail; bun run check:type && git status --porcelain=v1'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
      expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, legacyWriter))).toBe(false);
    }
    for (const unsafe of [
      'bun run check:type && git status > report.txt',
      'bun run check:type && git diff --output=report.patch',
      'bun run check:type && git status && touch src/changed.ts',
      'bun run check:type && git rev-parse HEAD && git add .',
      'bun run check:type && git status --porcelain=v2',
      'bun run check:type && git status --short && node unknown.js',
    ]) {
      expect(claimsForRepositoryCommand(unsafe, 'repo1', 'co1')).not.toContainEqual({
        resourceKey: 'workspace:co1',
        mode: 'write',
      });
    }
  });

  test('path-scoped git add and git commit do not take checkout-wide writer (#713)', () => {
    const staged = claimsForRepositoryCommand(['git', 'add', 'src/alpha.ts', 'src/beta.ts'], 'repo1', 'co1');
    expect(staged).toContainEqual({ resourceKey: 'git-index:co1', mode: 'exclusive' });
    expect(staged).not.toContainEqual({ resourceKey: 'path:co1:src/alpha.ts', mode: 'write' });
    expect(staged).not.toContainEqual({ resourceKey: 'path:co1:src/beta.ts', mode: 'write' });
    expect(staged.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);

    const commit = claimsForRepositoryCommand(['git', 'commit', '-m', 'slice'], 'repo1', 'co1');
    expect(commit).toContainEqual({ resourceKey: 'git-index:co1', mode: 'exclusive' });
    expect(commit).toContainEqual({ resourceKey: 'git-refs:repo1', mode: 'exclusive' });
    expect(commit.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);

    // Opaque scripts still fail closed on the checkout fence until the caller
    // provides exact mutation_paths.
    expect(
      claimsForRepositoryCommand(['python3', 'scripts/rewrite.py', 'src/alpha.ts'], 'repo1', 'co1'),
    ).not.toContainEqual({
      resourceKey: 'workspace:co1',
      mode: 'write',
    });
  });

  test('Git metadata operations retire source ownership even with broad pathspecs (#713)', () => {
    const sourceWriter = lease('path:co1:src/alpha.ts', 'write');
    const legacyWriter = lease('workspace:co1', 'write');
    const sharedIndex = lease('git-index:co1', 'exclusive');
    const sharedRefs = lease('git-refs:repo1', 'exclusive');
    for (const command of [
      ['git', 'add', '.'],
      ['git', 'add', '--all'],
      ['git', 'add', 'src/alpha.ts'],
      'git add --all -- src/alpha.ts',
      ['bash', '-lc', 'git add .'],
      ['git', 'rm', '--cached', 'src/alpha.ts'],
      ['git', 'restore', '--staged', '--', 'src/alpha.ts'],
      ['git', 'apply', '--cached', 'changes.patch'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toEqual([{ resourceKey: 'git-index:co1', mode: 'exclusive' }]);
      expect(claims.some((claim) => claimsConflict(claim, sourceWriter))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, legacyWriter))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, sharedIndex))).toBe(true);
    }
    for (const command of [
      ['git', 'branch', 'feature'],
      ['git', 'branch', '--delete', 'old-feature'],
      ['git', 'tag', 'release-1'],
      'git branch --show-current',
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, sourceWriter))).toBe(false);
      if (command === 'git branch --show-current') continue;
      expect(claims).toEqual([{ resourceKey: 'git-refs:repo1', mode: 'exclusive' }]);
      expect(claims.some((claim) => claimsConflict(claim, sharedRefs))).toBe(true);
    }
    // Real worktree mutations still claim the Git index (and exact source
    // paths when provable) even when Git metadata is also changed.
    for (const command of [
      ['git', 'rm', '--', 'src/alpha.ts'],
      ['git', 'restore', '--staged', '--worktree', '--', 'src/alpha.ts'],
      ['git', 'checkout', 'another-branch'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).not.toEqual([{ resourceKey: 'git-index:co1', mode: 'exclusive' }]);
      expect(
        claims.some((claim) => claim.resourceKey.startsWith('git-index:') || claim.resourceKey.startsWith('path:')),
      ).toBe(true);
    }
    // Without reading an arbitrary patch, "git apply changes.patch" cannot
    // prove the output source paths. Do not invent a checkout-wide writer;
    // preserve the existing Git index fence pending explicit path authority.
    expect(claimsForRepositoryCommand(['git', 'apply', 'changes.patch'], 'repo1', 'co1')).toEqual([
      { resourceKey: 'git-index:co1', mode: 'exclusive' },
    ]);
  });

  test('live lease store permits source and Git metadata Writers but never concurrent index owners (#713)', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-713-git-resource-split-'));
    const opts = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    const held: Array<{ owner: string; leases: ExecutionLease[] }> = [];
    try {
      ensureControllerHome(home);
      const acquire = (owner: string, claim: { resourceKey: string; mode: 'write' | 'exclusive' }) => {
        const acquired = acquireExecutionLeases(home, 'repo1', owner, [claim], opts);
        if (acquired.acquired) held.push({ owner, leases: acquired.leases });
        return acquired.acquired;
      };
      expect(acquire('source-writer', { resourceKey: 'path:co1:src/alpha.ts', mode: 'write' })).toBe(true);
      expect(acquire('index-writer', { resourceKey: 'git-index:co1', mode: 'exclusive' })).toBe(true);
      expect(acquire('ref-writer', { resourceKey: 'git-refs:repo1', mode: 'exclusive' })).toBe(true);
      expect(acquire('other-index', { resourceKey: 'git-index:co1', mode: 'exclusive' })).toBe(false);
      expect(acquire('other-ref', { resourceKey: 'git-refs:repo1', mode: 'exclusive' })).toBe(false);
      expect(acquire('overlapping-source', { resourceKey: 'path:co1:src/alpha.ts', mode: 'write' })).toBe(false);
    } finally {
      for (const item of held) releaseExecutionLeases(home, 'repo1', item.owner, item.leases, opts);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('stdout-only HTTP probes do not own checkout source while file-producing curl stays fenced (#713)', () => {
    const unrelatedWriter = lease('path:co1:src/other.ts', 'write');
    const checkoutWriter = lease('workspace:co1', 'write');
    for (const command of [
      ['curl', '-fsSL', 'https://example.com/status'],
      ['curl', '--head', '--max-time', '10', 'https://example.org/'],
      ['curl', '--silent', '--url', 'http://127.0.0.1:8080/health'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toHaveLength(1);
      expect(claims[0]?.mode).toBe('read');
      expect(claims.some((claim) => claimsConflict(claim, checkoutWriter))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, unrelatedWriter))).toBe(false);
    }
    for (const unsafe of [
      ['curl', '--output=src/other.ts', 'http://127.0.0.1:8080/health'],
      ['curl', '-o', 'src/other.ts', 'https://example.com/'],
      ['curl', '-O', 'https://example.com/file'],
      ['curl', '--trace=trace.log', 'https://example.com/'],
      ['curl', '--cookie-jar', 'cookies.txt', 'https://example.com/'],
      ['curl', '--data', 'x=1', 'https://example.com/api'],
      ['curl', '-X', 'POST', 'https://example.com/api'],
      ['curl', '-K', 'curl.conf', 'https://example.com/'],
      ['curl', 'file:///tmp/source'],
    ]) {
      expect(claimsForRepositoryCommand(unsafe, 'repo1', 'co1')).not.toContainEqual({
        resourceKey: 'workspace:co1',
        mode: 'write',
      });
    }
  });

  test('Git fetch owns remote refs, not source checkout or index (#713)', () => {
    const sourceLease = lease('workspace:co1', 'write');
    const sourcePath = lease('path:co1:src/feature.ts', 'write');
    const refsLease = lease('git-refs:repo1', 'exclusive');
    for (const command of [
      ['git', 'fetch', 'origin'],
      ['git', 'fetch', '--prune', 'origin', 'main'],
      'git fetch --tags origin',
      ['bash', '-lc', 'git fetch origin main'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toEqual([{ resourceKey: 'git-refs:repo1', mode: 'exclusive' }]);
      expect(claims.some((claim) => claimsConflict(claim, sourceLease))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, sourcePath))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, refsLease))).toBe(true);
    }
    for (const command of [
      ['git', 'fetch', '--recurse-submodules=yes', 'origin'],
      ['git', 'fetch', '--recurse-submodules', 'origin'],
      ['git', 'pull', '--ff-only'],
      ['bash', '-lc', 'git fetch origin && touch src/file.ts'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
    }
  });

  test('commands that change Git worktree still explicitly claim index/refs (#713)', () => {
    for (const command of [
      ['git', 'checkout', 'another-branch'],
      ['git', 'switch', 'another-branch'],
      ['git', 'reset', '--mixed'],
      ['git', 'stash', 'push'],
      ['git', 'update-index', '--refresh'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'git-index:co1', mode: 'exclusive' });
      expect(claims).toContainEqual({ resourceKey: 'git-refs:repo1', mode: 'exclusive' });
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
    }
  });

  test('literal Git source pathspecs narrow index operations but patch input is not an output path (#713)', () => {
    for (const command of [
      ['git', 'add', 'README'],
      ['git', 'add', '--all', '--', 'README'],
      ['git', 'rm', '--', 'docs/obsolete.md'],
      ['git', 'mv', 'old_name', 'new_name'],
      ['git', 'restore', '--', 'src/main.ts'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'git-index:co1', mode: 'exclusive' });
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
    }
    for (const command of [
      ['git', 'rm', '-r', '.'],
      ['git', 'rm', '--', ':!README'],
      ['git', 'rm', '--', 'src/*.ts'],
      ['git', 'rm', '--', '../outside.md'],
      ['git', 'apply', 'change.diff'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).not.toContainEqual({ resourceKey: 'workspace:co1', mode: 'write' });
      expect(claims).toContainEqual({ resourceKey: 'git-index:co1', mode: 'exclusive' });
    }
  });

  test('Cargo source mutation, shell composition and opaque scripts remain conservatively fenced (#713)', () => {
    for (const command of [
      'cargo test --lib && touch generated.txt',
      ['bash', '-lc', 'cargo test --lib > checked.txt'],
      ['cargo', 'fix', '--allow-dirty'],
    ] as const) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).not.toContainEqual({ resourceKey: 'workspace:co1', mode: 'write' });
    }
    // Cargo build already has a narrower source-path claim; retain that
    // existing safety rather than broadening it solely for this regression.
    const buildClaims = claimsForRepositoryCommand(
      ['cargo', 'build', '--manifest-path', 'apps/desktop-native/bridge/Cargo.toml'],
      'repo1',
      'co1',
    );
    expect(buildClaims).toContainEqual({
      resourceKey: 'path:co1:apps/desktop-native/bridge/Cargo.toml',
      mode: 'write',
    });
    expect(buildClaims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(buildClaims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);

    const shellBuildClaims = claimsForRepositoryCommand(
      'set -euo pipefail; cargo build --manifest-path apps/desktop-native/bridge/Cargo.toml && git status --short',
      'repo1',
      'co1',
    );
    expect(shellBuildClaims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(shellBuildClaims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(shellBuildClaims.some((claim) => claim.resourceKey.startsWith('path:co1:'))).toBe(false);
    expect(shellBuildClaims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);

    const wrappedBuildClaims = claimsForRepositoryCommand(
      [
        'bash',
        '-lc',
        'set -euo pipefail; cargo build --manifest-path apps/desktop-native/bridge/Cargo.toml && git status --short',
      ],
      'repo1',
      'co1',
    );
    expect(wrappedBuildClaims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(wrappedBuildClaims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(wrappedBuildClaims.some((claim) => claim.resourceKey.startsWith('path:co1:'))).toBe(false);
    expect(wrappedBuildClaims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
  });

  test('read/search and focused tests proceed while an unrelated legacy workspace writer exists (#713)', () => {
    const legacyWriter = lease('workspace:co1', 'write');
    for (const command of [
      ['git', 'status'],
      ['rg', 'TODO', 'src'],
      ['bun', 'test', 'tests/runtime/process-resource-claims.test.ts'],
      ['tsc', '--noEmit'],
    ] as const) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
      expect(claims.some((claim) => claimsConflict(claim, legacyWriter))).toBe(false);
    }
    const typecheck = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co1');
    expect(typecheck.some((claim) => claimsConflict(claim, legacyWriter))).toBe(false);
    // Unknown source writes remain protected until the caller can provide an exact mutation scope.
    expect(claimsForRepositoryCommand(['node', 'generate.js'], 'repo1', 'co1')).not.toContainEqual({
      resourceKey: 'workspace:co1',
      mode: 'write',
    });
  });

  test('ordinary xcodebuild log redirection does not acquire unrelated Git-ref ownership', () => {
    const command =
      "cd /worktrees/ocr && xcodebuild -project ios/App.xcodeproj -derivedDataPath .forge/ios/ocr -jobs 2 build > .forge/ios/build.log 2>&1; rc=$?; grep 'BUILD' .forge/ios/build.log | tail -2; exit $rc";
    expect(shellCommandHasUnsafeConstructs(command).unsafe).toBe(false);
    expect(shellSegments('xcodebuild build > result.log 2>&1 && echo done')).toEqual([
      'xcodebuild build > result.log 2>&1',
      'echo done',
    ]);
    expect(classifyRepositoryCommand(command).risk).toBe('workspace_write');
    const claims = claimsForRepositoryCommand(command, 'repo1', 'checkout-ocr');
    expect(claims.some((claim) => claim.resourceKey === 'git-refs:repo1')).toBe(false);
    expect(claims.some((claim) => claim.resourceKey === 'git-index:checkout-ocr')).toBe(false);
    expect(claims.some((claim) => claimsConflict(claim, lease('git-refs:repo1', 'exclusive')))).toBe(false);

    const actualBackground = command + ' &';
    expect(shellCommandHasUnsafeConstructs(actualBackground).unsafe).toBe(true);
    expect(classifyRepositoryCommand(actualBackground).risk).toBe('destructive');
    expect(claimsForRepositoryCommand(actualBackground, 'repo1', 'checkout-ocr')).toContainEqual({
      resourceKey: 'git-refs:repo1',
      mode: 'exclusive',
    });
    for (const redirection of ['2>&1', '1>&2', '<&0', '&>build.log', '&>>build.log']) {
      expect(shellCommandHasUnsafeConstructs('xcodebuild build ' + redirection).unsafe).toBe(false);
    }
  });

  test('Homebrew host mutations do not monopolize repository write resources', () => {
    for (const command of [
      ['brew', 'install', 'jmeter'],
      'brew install jmeter',
      ['bash', '-lc', 'brew install jmeter'],
    ] as const) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toEqual([{ resourceKey: 'host-service:package-manager:homebrew', mode: 'write' }]);
      expect(claims.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, lease('git-index:co1', 'exclusive')))).toBe(false);
      expect(claims.some((claim) => claimsConflict(claim, lease('git-refs:repo1', 'exclusive')))).toBe(false);
    }

    expect(claimsForRepositoryCommand(['brew', 'install', './Formula/local.rb'], 'repo1', 'co1')).not.toContainEqual({
      resourceKey: 'workspace:co1',
      mode: 'write',
    });
  });

  test('scoped source observation retains exact repository/checkout identity without Work', () => {
    const claims = scopeResourceClaims(claimsForRepositoryCommand(['git', 'status'], 'repo1', 'co1'), 'repo1', 'co1');
    expect(claims).toMatchObject([
      {
        resourceKey: 'validation-input:co1',
        mode: 'read',
        repoId: 'repo1',
        checkoutId: 'co1',
      },
    ]);
  });

  test('typecheck observes source plus cache and keeps the compiler-heavy serialization fence', () => {
    const claims = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co1');
    expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(claims.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);
    expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'heavy-check:repo1', mode: 'exclusive' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode !== 'read')).toBe(false);
  });

  test('live certification fences release and host Runtime/Recovery resources', () => {
    const claims = claimsForCheck(
      'package:check:stable-baseline',
      ['bun', 'run', 'check:stable-baseline'],
      'repo1',
      'co1',
      { reads: ['.'], hostServices: ['canonical-runtime', 'forge-recovery'] },
      'live_controller_home',
    );
    expect(claims).toContainEqual({ resourceKey: 'release:runtime-authority', mode: 'exclusive' });
    expect(claims).toContainEqual({ resourceKey: 'host-service:canonical-runtime', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'host-service:forge-recovery', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
  });

  test('raw typed tsc --noEmit uses validation observation plus cache instead of a workspace lease', () => {
    for (const command of [
      ['tsc', '--noEmit'],
      ['bun', 'x', 'tsc', '--noEmit'],
      ['/opt/bun/bin/bun', 'x', '/repo/node_modules/.bin/tsc', '--noEmit', '--pretty', 'false'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
      expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      expect(claims.some((claim) => claimsConflict(claim, lease('workspace:co1', 'write')))).toBe(false);
    }
  });

  test('shell-composed tsc and emitting tsc remain conservative workspace writers', () => {
    expect(claimsForRepositoryCommand('tsc --noEmit && touch generated.txt', 'repo1', 'co1')).not.toContainEqual({
      resourceKey: 'workspace:co1',
      mode: 'write',
    });
    expect(claimsForRepositoryCommand(['bun', 'x', 'tsc'], 'repo1', 'co1')).not.toContainEqual({
      resourceKey: 'workspace:co1',
      mode: 'write',
    });
  });

  test('a long static check remains compatible with an unrelated workspace reader', () => {
    const claims = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co1');
    const reader = lease('workspace:co1', 'read');
    expect(claims.some((claim) => claimsConflict(claim, reader))).toBe(false);
  });

  test('two exact Simulator UDIDs admit independent validation while same device and legacy claims conflict', () => {
    const duo = '96EDA0C4-D3A9-407C-8692-BE28234C5F43';
    const pro = '633B2CBC-B2A5-4DAD-A9AE-BC3B1E883A9A';
    const duoClaim = `host-service:ios-simulator-test:udid:${duo}`;
    const proClaim = `host-service:ios-simulator-test:udid:${pro}`;
    expect(claimsConflict({ resourceKey: duoClaim, mode: 'write' }, lease(proClaim, 'write'))).toBe(false);
    expect(claimsConflict({ resourceKey: duoClaim, mode: 'write' }, lease(duoClaim, 'write'))).toBe(true);
    expect(
      claimsConflict({ resourceKey: duoClaim, mode: 'write' }, lease('host-service:ios-simulator-test', 'write')),
    ).toBe(true);
    expect(
      claimsConflict({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' }, lease(proClaim, 'write')),
    ).toBe(true);

    const typed = claimsForRepositoryCommand(
      ['xcodebuild', 'test-without-building', '-destination', `platform=iOS Simulator,id=${duo.toLowerCase()}`],
      'avela',
      'co-a',
    );
    const wrapped = claimsForRepositoryCommand(
      ['bash', '-lc', `xcodebuild test -project App.xcodeproj -destination 'platform=iOS Simulator,id=${pro}'`],
      'other',
      'co-b',
    );
    expect(typed).toContainEqual({ resourceKey: duoClaim, mode: 'write' });
    expect(wrapped).toContainEqual({ resourceKey: proClaim, mode: 'write' });
    const typedSim = typed.filter((claim) => claim.resourceKey.includes('ios-simulator-test'));
    const wrappedSim = wrapped.filter((claim) => claim.resourceKey.includes('ios-simulator-test'));
    expect(
      typedSim.some((claim) => wrappedSim.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode)))),
    ).toBe(false);
    expect(
      claimsForRepositoryCommand(['xcodebuild', 'test', '-destination', 'name=iPhone 18 Pro'], 'r', 'c'),
    ).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(
      claimsForRepositoryCommand(
        ['xcodebuild', 'test', '-destination', `id=${duo}`, '-destination', `id=${pro}`],
        'r',
        'c',
      ),
    ).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(
      claimsForRepositoryCommand(['xcodebuild', 'test', '-destination', `platform=iOS,id=${duo}`], 'r', 'c'),
    ).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
  });

  test('iOS plugin exact UDIDs use the same host authority across repositories', () => {
    const duo = '96EDA0C4-D3A9-407C-8692-BE28234C5F43';
    const pro = '633B2CBC-B2A5-4DAD-A9AE-BC3B1E883A9A';
    const repoA = { repoId: 'avela', activeCheckoutId: 'co-a' } as Parameters<typeof claimsForAssistantPluginAction>[1];
    const repoB = { repoId: 'kidney', activeCheckoutId: 'co-b' } as Parameters<
      typeof claimsForAssistantPluginAction
    >[1];
    const action: AssistantPluginActionDescriptor = {
      actionId: 'capture_screenshot',
      title: 'Screenshot',
      description: '',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60000,
      cancellable: true,
      idempotent: false,
      scopes: ['ios.simulator'],
      resourceClaims: [],
      argumentsSchema: {},
    };
    const a = claimsForAssistantPluginAction(action, repoA, 'ios', { udid: duo });
    const b = claimsForAssistantPluginAction(action, repoB, 'ios', { udid: pro });
    expect(a).toContainEqual({ resourceKey: `host-service:ios-simulator-test:udid:${duo}`, mode: 'write' });
    expect(b).toContainEqual({ resourceKey: `host-service:ios-simulator-test:udid:${pro}`, mode: 'write' });
    expect(a.some((x) => b.some((y) => claimsConflict(x, lease(y.resourceKey, y.mode))))).toBe(false);
    expect(claimsForAssistantPluginAction(action, repoA, 'ios', { udid: 'iPhone Duo' })).toContainEqual({
      resourceKey: 'host-service:ios-simulator-test',
      mode: 'write',
    });
  });

  test('xcodebuild simulator tests serialize host-wide without taking a workspace writer', () => {
    const claims = claimsForRepositoryCommand(
      [
        '/Applications/Xcode-beta.app/Contents/Developer/usr/bin/xcodebuild',
        'test',
        '-project',
        'App.xcodeproj',
        '-destination',
        'id=SIM-1',
      ],
      'repo1',
      'co1',
    );
    expect(claims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode !== 'read')).toBe(false);
  });

  test('shell-wrapped xcodebuild simulator tests use the same host-wide lease', () => {
    const claims = claimsForRepositoryCommand(
      [
        'bash',
        '-lc',
        "xcodebuild test -project App.xcodeproj -destination 'platform=iOS Simulator,name=iPhone 17 Pro'",
      ],
      'repo2',
      'co2',
    );
    expect(claims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'validation-input:co2', mode: 'read' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co2' && claim.mode !== 'read')).toBe(false);
  });

  test('scripted iOS and Android live journeys claim one host-wide device each', () => {
    const ios = claimsForCheck(
      'ios-fast-journey',
      ['bash', 'scripts/run_ios_test_layer.sh', 'fast-journey'],
      'avela',
      'ios-checkout',
    );
    const otherIos = claimsForCheck(
      'ios-integration-consistency',
      ['bash', 'scripts/run_ios_test_layer.sh', 'integration-consistency'],
      'other-repo',
      'other-checkout',
    );
    const android = claimsForCheck(
      'android-fast-journey',
      ['bash', 'scripts/run_android_check.sh', 'fast-journey'],
      'avela',
      'android-checkout',
    );
    expect(ios).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(android).toContainEqual({ resourceKey: 'host-service:android-emulator-test', mode: 'write' });
    expect(
      ios.some((claim) => otherIos.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode)))),
    ).toBe(true);
    expect(
      ios
        .filter((claim) => claim.resourceKey.startsWith('host-service:'))
        .some((claim) =>
          android
            .filter((other) => other.resourceKey.startsWith('host-service:'))
            .some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))),
        ),
    ).toBe(false);
    expect(
      claimsForCheck('android-build', ['bash', 'scripts/run_android_check.sh', 'build'], 'avela', 'co1').some((claim) =>
        claim.resourceKey.startsWith('host-service:'),
      ),
    ).toBe(false);
    expect(
      claimsForCheck('ios-layout-static', ['python3', 'scripts/audit_swiftui_layout_risks.py'], 'avela', 'co1').some(
        (claim) => claim.resourceKey.startsWith('host-service:'),
      ),
    ).toBe(false);
    expect(
      claimsForRepositoryCommand(['bash', 'scripts/run_android_check.sh', 'integration'], 'avela', 'co1'),
    ).toContainEqual({ resourceKey: 'host-service:android-emulator-test', mode: 'write' });
  });

  test('all Avela live journey, profile, and owner runners share one iOS device key', () => {
    for (const mode of [
      'fast-journey',
      'integration-consistency',
      'medication-long-journey',
      'ui-geometry',
      'destructive-model',
      'performance-critical',
      'all',
    ]) {
      expect(
        claimsForRepositoryCommand(['bash', 'scripts/run_ios_test_layer.sh', mode], 'repo1', 'co1'),
      ).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    }
    for (const script of [
      'run_ios_owner_test.sh',
      'run_ios_test_profile.sh',
      'run_ios_performance_tests.sh',
      'run_medication_long_journeys.sh',
    ]) {
      expect(claimsForRepositoryCommand(['bash', `scripts/${script}`, 'fast'], 'repo1', 'co1')).toContainEqual({
        resourceKey: 'host-service:ios-simulator-test',
        mode: 'write',
      });
    }
    const staticLayer = claimsForRepositoryCommand(
      ['bash', 'scripts/run_ios_test_layer.sh', 'static-layout'],
      'repo1',
      'co1',
    );
    expect(staticLayer.some((claim) => claim.resourceKey === 'host-service:ios-simulator-test')).toBe(false);
    const wrapped = claimsForRepositoryCommand(
      ['bash', '-lc', 'bash scripts/run_ios_test_layer.sh ui-geometry'],
      'repo1',
      'co1',
    );
    expect(wrapped).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
  });

  test('iOS plugin simulator calls and Process checks share the exact lease authority', () => {
    const repository = { repoId: 'avela', activeCheckoutId: 'co1' } as Parameters<
      typeof claimsForAssistantPluginAction
    >[1];
    const action = (actionId: string): AssistantPluginActionDescriptor => ({
      actionId,
      title: actionId,
      description: '',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60000,
      cancellable: true,
      idempotent: false,
      scopes: ['ios.simulator'],
      resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
      argumentsSchema: {},
    });
    const testClaims = claimsForCheck(
      'ios-fast-journey',
      ['bash', 'scripts/run_ios_test_layer.sh', 'fast-journey'],
      'avela',
      'co1',
    );
    for (const id of ['xcode_test', 'smoke_review', 'launch_simulator', 'capture_screenshot', 'agent_device_prepare']) {
      const pluginClaims = claimsForAssistantPluginAction(action(id), repository, 'ios');
      expect(pluginClaims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
      expect(
        pluginClaims.some((claim) =>
          testClaims.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))),
        ),
      ).toBe(true);
    }
    // Long-lived AgentDevice sessions keep this same lease after open returns,
    // so per-command actions must not acquire a second short-lived copy.
    for (const id of ['agent_device_open', 'agent_device_batch', 'agent_device_snapshot', 'agent_device_close']) {
      expect(
        claimsForAssistantPluginAction(action(id), repository, 'ios').some(
          (claim) => claim.resourceKey === 'host-service:ios-simulator-test',
        ),
      ).toBe(false);
    }
    for (const id of ['build', 'xcode_test', 'smoke_review']) {
      const native = claimsForAssistantPluginAction(action(id), repository, 'ios');
      expect(native).toContainEqual({ resourceKey: 'host-service:ios-build', mode: 'write' });
    }
    expect(
      claimsForAssistantPluginAction(action('agent_device_status'), repository, 'ios').some(
        (claim) => claim.resourceKey === 'host-service:ios-simulator-test',
      ),
    ).toBe(false);
    expect(
      claimsForAssistantPluginAction(action('xcode_test'), repository, 'another-plugin').some(
        (claim) => claim.resourceKey === 'host-service:ios-simulator-test',
      ),
    ).toBe(false);
  });

  test('declared check effects map to bounded resources', () => {
    const claims = claimsForCheck('custom:report', ['node', 'report.js'], 'repo1', 'co1', {
      reads: ['src'],
      writes: ['reports'],
      cache: 'write',
      temp: 'isolated',
      git: 'read',
      network: 'read',
      hostServices: ['ios-simulator-test'],
    });
    expect(claims).toContainEqual({ resourceKey: 'validation-input:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'path:co1:reports', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'temp:co1:custom-report', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'git-index:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'git-refs:repo1', mode: 'read' });
    expect(claims.some((claim) => claimsConflict(claim, lease('git-refs:repo2', 'exclusive')))).toBe(false);
    expect(claims.some((claim) => claimsConflict(claim, lease('git-refs:repo1', 'exclusive')))).toBe(true);
    expect(claims.some((claim) => claimsConflict(claim, lease('git-ref:HEAD', 'exclusive')))).toBe(true);
    // Endpoint-free network flags are not a serialized resource; callers declare real hostServices.
    expect(claims.some((claim) => claim.resourceKey === 'network:repo1')).toBe(false);
    expect(claims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
  });

  test('browser-live declared effects avoid build-cache serialization while retaining host browser coordination', () => {
    const effects = { reads: ['.'], temp: 'isolated' as const, hostServices: ['browser-live'] };
    const browserA = claimsForCheck(
      'package:test:browser-live',
      ['bun', 'tests/live/browser-native-silent.e2e.ts'],
      'repo1',
      'co-browser-a',
      effects,
    );
    const browserB = claimsForCheck(
      'package:test:browser-live',
      ['bun', 'tests/live/browser-native-silent.e2e.ts'],
      'repo1',
      'co-browser-b',
      effects,
    );
    const typecheck = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co-type');

    expect(browserA).toContainEqual({ resourceKey: 'validation-input:co-browser-a', mode: 'read' });
    expect(browserA).toContainEqual({ resourceKey: 'temp:co-browser-a:package-test-browser-live', mode: 'write' });
    expect(browserA).toContainEqual({ resourceKey: 'host-service:browser-live', mode: 'write' });
    expect(browserA.some((claim) => claim.resourceKey === 'build-cache:repo1')).toBe(false);
    expect(
      browserA.some((claim) => typecheck.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode)))),
    ).toBe(false);
    expect(
      browserA.some((claim) => browserB.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode)))),
    ).toBe(true);
  });

  test('undeclared custom build checks fail closed without duplicate workspace read', () => {
    const claims = claimsForCheck('custom:generate', ['bun', 'run', 'generate'], 'repo1', 'co1');
    expect(claims).toEqual([]);
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode === 'read')).toBe(false);
  });

  test('custom checks named like static tools still fail closed without declared effects', () => {
    const claims = claimsForCheck('custom:lint', ['node', 'generate.js'], 'repo1', 'co1');
    expect(claims).toEqual([]);
  });

  test('release checks retain heavy-check exclusivity', () => {
    const claims = claimsForCheck('check:release', undefined, 'repo1', 'co1');
    expect(claims).toContainEqual({ resourceKey: 'heavy-check:repo1', mode: 'exclusive' });
  });

  test('Computer and Desktop Operator actions declare only their required provider-state claims (#638)', () => {
    const registration = createDesktopOperatorRegistrationInput({
      socketPath: '/tmp/forge-desktop-operator.sock',
      pluginVersion: '0.4.7',
    });
    const repository = { repoId: 'repo1', activeCheckoutId: 'co1' } as Parameters<
      typeof claimsForAssistantPluginAction
    >[1];
    const canonicalClaim = [{ resourceKey: 'provider-state:desktop_operator', mode: 'write' as const }];

    for (const actionId of [
      'desktop_press',
      'desktop_select_rows',
      'desktop_pointer_click',
      'desktop_pointer_drag',
      'desktop_type_text',
      'desktop_key',
      'desktop_open_url',
      'desktop_clipboard_write',
      'desktop_copy',
      'desktop_paste',
      'desktop_permissions_request',
      'desktop_session_open',
      'desktop_session_close',
      'desktop_batch',
    ]) {
      const action = registration.actions.find((candidate) => candidate.actionId === actionId);
      expect(action, `Desktop Operator action ${actionId}`).toBeDefined();
      expect(claimsForAssistantPluginAction(action!, repository, registration.pluginId)).toEqual(canonicalClaim);
    }
    for (const actionId of ['desktop_status', 'desktop_observe', 'desktop_screenshot', 'desktop_clipboard_read']) {
      const action = registration.actions.find((candidate) => candidate.actionId === actionId);
      expect(action, `Desktop Operator read ${actionId}`).toBeDefined();
      expect(claimsForAssistantPluginAction(action!, repository, registration.pluginId)).toEqual([]);
    }

    const computer = computerPluginAdapter.buildManifest(0, undefined, '/tmp').actions;
    for (const actionId of [
      'desktop_target_open',
      'desktop_target_close',
      'desktop_press',
      'desktop_select_rows',
      'desktop_type_text',
      'desktop_key',
      'desktop_open_url',
      'desktop_element_action',
    ]) {
      const action = computer.find((candidate) => candidate.actionId === actionId);
      expect(action, `Computer action ${actionId}`).toBeDefined();
      expect(claimsForAssistantPluginAction(action!, repository, 'computer')).toEqual(canonicalClaim);
    }
    for (const actionId of [
      'desktop_target_list',
      'desktop_observe',
      'desktop_screenshot',
      'desktop_element_observe',
    ]) {
      const action = computer.find((candidate) => candidate.actionId === actionId);
      expect(action, `Computer read ${actionId}`).toBeDefined();
      expect(claimsForAssistantPluginAction(action!, repository, 'computer')).toEqual([]);
    }

    const inventory = computer.find((candidate) => candidate.actionId === 'chatgpt_target_inventory');
    expect(inventory, 'Computer ChatGPT target inventory').toBeDefined();
    expect(inventory!.readOnly).toBe(true);
    expect(inventory!.risk).toBe('readonly');
    expect(inventory!.executionMode).toBeUndefined();
    expect(inventory!.defaultTimeoutMs).toBe(5_000);
    expect(claimsForAssistantPluginAction(inventory!, repository, 'computer')).toEqual([]);

    const observe = computer.find((candidate) => candidate.actionId === 'chatgpt_target_observe');
    expect(observe, 'Computer ChatGPT target observe').toBeDefined();
    expect(observe!.readOnly).toBe(false);
    expect(observe!.risk).toBe('workspace_write');
    expect(observe!.defaultTimeoutMs).toBe(15_000);
    expect(claimsForAssistantPluginAction(observe!, repository, 'computer')).toEqual([
      ...canonicalClaim,
      { resourceKey: 'provider-state:browser', mode: 'read' },
    ]);
    for (const actionId of ['chatgpt_target_prepare', 'chatgpt_target_dispatch']) {
      const action = computer.find((candidate) => candidate.actionId === actionId);
      expect(action, `Computer ChatGPT remote write ${actionId}`).toBeDefined();
      expect(action!.readOnly).toBe(false);
      expect(action!.risk).toBe('remote_write');
      expect(action!.executionMode).toBeUndefined();
      expect(action!.defaultTimeoutMs).toBe(actionId === 'chatgpt_target_prepare' ? 15_000 : 20_000);
      expect(action!.resourceClaims.length).toBeGreaterThan(0);
    }
  });

  test('Browser remote claims are exact-session scoped while provider state remains global (#619)', () => {
    const repository = { repoId: 'repo1', activeCheckoutId: 'co1' } as Parameters<
      typeof claimsForAssistantPluginAction
    >[1];
    const remoteAction = {
      actionId: 'navigate',
      title: 'Navigate',
      description: 'test',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 60_000,
      cancellable: true,
      idempotent: false,
      scopes: ['browser.interact'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {},
    } as AssistantPluginActionDescriptor;
    const providerAction = {
      ...remoteAction,
      actionId: 'configure',
      resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
    } as AssistantPluginActionDescriptor;

    const sessionA = claimsForAssistantPluginAction(
      remoteAction,
      repository,
      'browser',
      { session_id: 'session-a' },
      'request-a',
    );
    const sessionAAgain = claimsForAssistantPluginAction(
      remoteAction,
      repository,
      'browser',
      { session_id: 'session-a' },
      'request-b',
    );
    const sessionB = claimsForAssistantPluginAction(
      remoteAction,
      repository,
      'browser',
      { session_id: 'session-b' },
      'request-c',
    );
    const freshA = claimsForAssistantPluginAction(remoteAction, repository, 'browser', {}, 'fresh-a');
    const freshB = claimsForAssistantPluginAction(remoteAction, repository, 'browser', {}, 'fresh-b');
    const exactTab = claimsForAssistantPluginAction(
      remoteAction,
      repository,
      'browser',
      {
        native_browser_product: 'chrome',
        native_window_id: 'window-7',
        native_tab_id: 'tab-42',
      },
      'tab-request',
    );

    expect(sessionA[0]?.resourceKey).toBe(sessionAAgain[0]?.resourceKey);
    expect(sessionA[0]?.resourceKey).not.toBe(sessionB[0]?.resourceKey);
    expect(freshA[0]?.resourceKey).not.toBe(freshB[0]?.resourceKey);
    expect(exactTab[0]?.resourceKey).toMatch(/^provider-resource:browser:/);
    expect(claimsConflict(sessionA[0]!, lease(sessionAAgain[0]!.resourceKey, 'exclusive'))).toBe(true);
    expect(claimsConflict(sessionA[0]!, lease(sessionB[0]!.resourceKey, 'exclusive'))).toBe(false);
    expect(
      claimsForAssistantPluginAction(providerAction, repository, 'browser', { session_id: 'session-a' }, 'provider-a'),
    ).toEqual([{ resourceKey: 'provider-state:browser', mode: 'write' }]);
  });

  test('ephemeral explicit releases retain durable owner and fencing receipts on both release routes', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-ephemeral-release-'));
    const repoId = 'repo-ephemeral-release';
    const options = {
      visibility: 'ephemeral' as const,
      notifyScheduler: false,
      invalidateProjection: false,
      emitRuntimeEvent: false,
    };
    try {
      const first = acquireExecutionLeases(
        controllerHome,
        repoId,
        'fast:general-release',
        [{ resourceKey: 'workspace:checkout-a', mode: 'write', repoId, checkoutId: 'checkout-a' }],
        options,
      );
      expect(first.acquired).toBe(true);
      expect(releaseExecutionLeases(controllerHome, repoId, 'fast:general-release', first.leases, options)).toBe(1);

      const second = acquireExecutionLeases(
        controllerHome,
        repoId,
        'fast:exact-release',
        [{ resourceKey: 'workspace:checkout-a', mode: 'write', repoId, checkoutId: 'checkout-a' }],
        options,
      );
      expect(second.acquired).toBe(true);
      expect(
        releaseExactExecutionLeases(
          controllerHome,
          repoId,
          'fast:exact-release',
          second.leases.map((lease) => ({
            leaseId: lease.leaseId,
            fencingToken: lease.fencingToken,
            repoId: lease.repoId,
            checkoutId: lease.checkoutId,
            ownerIdentityDigest: lease.ownerIdentityDigest,
          })),
          options,
        ),
      ).toBe(1);
      expect(listActiveLeases(controllerHome, repoId)).toHaveLength(0);
      const ledger = join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
      const events = readFileSync(ledger, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { eventType: string; requestId: string; data?: Record<string, unknown> });
      expect(events.filter((event) => event.eventType === 'lease_released')).toMatchObject([
        { requestId: 'fast:general-release', data: { releaseReason: 'explicit_release' } },
        { requestId: 'fast:exact-release', data: { releaseReason: 'explicit_release', exactSet: true } },
      ]);
      expect(events.some((event) => event.eventType === 'lease_acquired')).toBe(false);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('workflow watchdog exposes active plugin leases and durable release/expiry history', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-watchdog-lease-visibility-'));
    const controllerHome = ensureControllerHome(join(root, 'controller'));
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.email', 'watchdog-lease@example.test'], { cwd: repoRoot });
      execFileSync('git', ['config', 'user.name', 'Watchdog Lease Test'], { cwd: repoRoot });
      writeFileSync(join(repoRoot, 'README.md'), 'watchdog lease fixture\n');
      execFileSync('git', ['add', '.'], { cwd: repoRoot });
      execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoRoot });
      const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'watchdog lease fixture' });
      const ownerJobId = 'plugin:m03-voiceover-preflight-screenshot';
      const resourceKey = 'provider-state:computer';
      const acquired = acquireExecutionLeases(
        controllerHome,
        repository.repoId,
        ownerJobId,
        [
          {
            resourceKey,
            mode: 'write',
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
          },
        ],
        {
          visibility: 'ephemeral',
          notifyScheduler: false,
          invalidateProjection: false,
          emitRuntimeEvent: false,
        },
      );
      expect(acquired.acquired).toBe(true);
      const held = acquired.leases[0]!;
      const activeReport = buildWorkflowWatchdogReport(controllerHome, repository, { includeProcesses: false });
      expect(activeReport.performance.controller.activeLeases).toBe(1);
      expect(activeReport.activeLeases).toMatchObject([
        {
          leaseId: held.leaseId,
          ownerJobId,
          checkoutId: repository.activeCheckoutId,
          resourceKey,
          mode: 'write',
          fencingToken: held.fencingToken,
          expiresAt: held.expiresAt,
          visibility: 'ephemeral',
        },
      ]);
      expect(activeReport.recentLeaseEvents).toEqual([]);
      expect(releaseExecutionLeases(controllerHome, repository.repoId, ownerJobId)).toBe(1);
      const releasedReport = buildWorkflowWatchdogReport(controllerHome, repository, { includeProcesses: false });
      expect(releasedReport.activeLeases).toEqual([]);
      expect(releasedReport.recentLeaseEvents).toContainEqual(
        expect.objectContaining({
          eventType: 'lease_released',
          entityId: held.leaseId,
          requestId: ownerJobId,
          data: expect.objectContaining({
            ownerJobId,
            resourceKey,
            releaseReason: 'explicit_release',
            fencingToken: held.fencingToken,
          }),
        }),
      );
      const expiringOwner = 'plugin:computer-expiry-probe';
      const expiring = acquireExecutionLeases(
        controllerHome,
        repository.repoId,
        expiringOwner,
        [
          {
            resourceKey: 'provider-state:computer',
            mode: 'write',
            repoId: repository.repoId,
            checkoutId: repository.activeCheckoutId,
          },
        ],
        {
          visibility: 'ephemeral',
          notifyScheduler: false,
          invalidateProjection: false,
          emitRuntimeEvent: false,
          ttlMs: 5_000,
        },
      );
      expect(expiring.acquired).toBe(true);
      const expiringLease = expiring.leases[0]!;
      const originalNow = Date.now;
      let expiredReport: ReturnType<typeof buildWorkflowWatchdogReport>;
      Date.now = () => Date.parse(expiringLease.expiresAt) + 1;
      try {
        expiredReport = buildWorkflowWatchdogReport(controllerHome, repository, { includeProcesses: false });
      } finally {
        Date.now = originalNow;
      }
      expect(expiredReport.activeLeases).toEqual([]);
      expect(expiredReport.recentLeaseEvents).toContainEqual(
        expect.objectContaining({
          eventType: 'lease_expired',
          entityId: expiringLease.leaseId,
          requestId: expiringOwner,
          data: expect.objectContaining({
            ownerJobId: expiringOwner,
            resourceKey: 'provider-state:computer',
            expiryReason: 'ttl_expired',
          }),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('terminal Process release persists owner, fencing and resource receipt for ephemeral leases', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-terminal-lease-audit-'));
    const repoId = 'repo-lease-audit';
    const processId = 'proc-audit-1';
    const ownerJobId = `process:${processId}`;
    try {
      const acquired = acquireExecutionLeases(
        controllerHome,
        repoId,
        ownerJobId,
        [
          {
            resourceKey: 'host-service:ios-simulator-test',
            mode: 'write',
            repoId,
            checkoutId: 'checkout-audit',
          },
        ],
        {
          visibility: 'ephemeral',
          notifyScheduler: false,
          invalidateProjection: false,
          emitRuntimeEvent: false,
        },
      );
      expect(acquired.acquired).toBe(true);
      const held = acquired.leases[0]!;
      const released = releaseTerminalProcessLeases(
        controllerHome,
        repoId,
        processId,
        acquired.leases.map((lease) => ({
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          repoId: lease.repoId,
          checkoutId: lease.checkoutId,
          resourceKey: lease.resourceKey,
          ownerIdentityDigest: lease.ownerIdentityDigest,
        })),
        {
          visibility: 'ephemeral',
          notifyScheduler: false,
          invalidateProjection: false,
          emitRuntimeEvent: false,
        },
      );
      expect(released).toBe(1);

      const ledger = join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
      const events = readFileSync(ledger, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              eventType: string;
              entityId: string;
              requestId: string;
              correlationId?: string;
              revision: number;
              data?: Record<string, unknown>;
            },
        );
      const receipt = events.find((event) => event.eventType === 'lease_released' && event.entityId === held.leaseId);
      expect(receipt).toMatchObject({
        eventType: 'lease_released',
        entityId: held.leaseId,
        requestId: ownerJobId,
        correlationId: ownerJobId,
        revision: held.fencingToken,
        data: {
          ownerJobId,
          ownerIdentityDigest: held.ownerIdentityDigest,
          checkoutId: 'checkout-audit',
          resourceKey: 'host-service:ios-simulator-test',
          fencingToken: held.fencingToken,
          releaseReason: 'explicit_release',
          terminalProcessId: processId,
        },
      });
      expect(listActiveLeases(controllerHome, repoId)).toEqual([]);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('listing an expired lease persists a durable owner and fencing receipt before removal', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-expired-lease-audit-'));
    const repoId = 'repo-expired-lease-audit';
    try {
      const acquired = acquireExecutionLeases(
        controllerHome,
        repoId,
        'expired-owner',
        [
          {
            resourceKey: 'workspace:checkout-expired',
            mode: 'write',
            repoId,
            checkoutId: 'checkout-expired',
          },
        ],
        {
          visibility: 'ephemeral',
          notifyScheduler: false,
          invalidateProjection: false,
          emitRuntimeEvent: false,
          ttlMs: 5_000,
        },
      );
      expect(acquired.acquired).toBe(true);
      const held = acquired.leases[0]!;
      expect(listActiveLeases(controllerHome, repoId)).toEqual([held]);

      const originalNow = Date.now;
      Date.now = () => Date.parse(held.expiresAt) + 1;
      try {
        expect(listActiveLeases(controllerHome, repoId)).toEqual([]);
      } finally {
        Date.now = originalNow;
      }

      const ledger = join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
      const events = readFileSync(ledger, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              eventType: string;
              entityId: string;
              requestId: string;
              revision: number;
              data?: Record<string, unknown>;
            },
        );
      const receipt = events.find((event) => event.eventType === 'lease_expired' && event.entityId === held.leaseId);
      expect(receipt).toMatchObject({
        eventType: 'lease_expired',
        entityId: held.leaseId,
        requestId: 'expired-owner',
        revision: held.fencingToken,
        data: {
          ownerJobId: 'expired-owner',
          ownerIdentityDigest: held.ownerIdentityDigest,
          checkoutId: 'checkout-expired',
          resourceKey: 'workspace:checkout-expired',
          fencingToken: held.fencingToken,
          expiryReason: 'ttl_expired',
        },
      });
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('fencing assertions persist expiry receipts before rejecting expired owners', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-fencing-expiry-audit-'));
    const repoId = 'repo-fencing-expiry-audit';
    try {
      const acquired = acquireExecutionLeases(
        controllerHome,
        repoId,
        'fenced-owner',
        [
          {
            resourceKey: 'workspace:checkout-fenced',
            mode: 'write',
            repoId,
            checkoutId: 'checkout-fenced',
          },
        ],
        {
          visibility: 'ephemeral',
          notifyScheduler: false,
          invalidateProjection: false,
          emitRuntimeEvent: false,
          ttlMs: 5_000,
        },
      );
      expect(acquired.acquired).toBe(true);
      const held = acquired.leases[0]!;
      const originalNow = Date.now;
      Date.now = () => Date.parse(held.expiresAt) + 1;
      try {
        expect(() => assertFencingToken(controllerHome, repoId, held.leaseId, held.fencingToken)).toThrow(
          `LEASE_EXPIRED: ${held.leaseId}`,
        );
      } finally {
        Date.now = originalNow;
      }

      const ledger = join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
      const events = readFileSync(ledger, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              eventType: string;
              entityId: string;
              requestId: string;
              revision: number;
              data?: Record<string, unknown>;
            },
        );
      expect(
        events.find((event) => event.eventType === 'lease_expired' && event.entityId === held.leaseId),
      ).toMatchObject({
        requestId: 'fenced-owner',
        revision: held.fencingToken,
        data: {
          ownerIdentityDigest: held.ownerIdentityDigest,
          resourceKey: 'workspace:checkout-fenced',
          expiryReason: 'ttl_expired',
        },
      });
      expect(listActiveLeases(controllerHome, repoId)).toEqual([]);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('provider-state lease blockers expose the existing owner and expiry without a fencing token', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-provider-state-blocker-'));
    const repoId = 'repo-provider-state-blocker';
    const claim = [{ resourceKey: 'provider-state:desktop_operator', mode: 'write' as const, repoId }];
    try {
      const held = acquireExecutionLeases(controllerHome, repoId, 'desktop-owner-a', claim, {
        visibility: 'ephemeral',
        notifyScheduler: false,
        invalidateProjection: false,
        emitRuntimeEvent: false,
        ttlMs: 60_000,
      });
      expect(held.acquired).toBe(true);
      const blocked = acquireExecutionLeases(controllerHome, repoId, 'computer-owner-b', claim, {
        visibility: 'ephemeral',
        notifyScheduler: false,
        invalidateProjection: false,
        emitRuntimeEvent: false,
        ttlMs: 60_000,
      });
      expect(blocked.acquired).toBe(false);
      expect(blocked.blockers[0]).toMatchObject({
        resourceKey: 'provider-state:desktop_operator',
        ownerJobId: 'desktop-owner-a',
        leaseId: held.leases[0]?.leaseId,
        mode: 'write',
        expiresAt: held.leases[0]?.expiresAt,
      });
      expect(blocked.blockers[0]).not.toHaveProperty('fencingToken');
      expect(releaseExecutionLeases(controllerHome, repoId, 'desktop-owner-a')).toBe(1);
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('trusted provider state serializes only the same provider, never repository workspace state', () => {
    const action = {
      actionId: 'mutate_provider',
      title: 'Mutate provider',
      description: 'test',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 1_000,
      cancellable: true,
      idempotent: false,
      scopes: [],
      resourceClaims: [{ resource: 'remote', mode: 'write' }],
      argumentsSchema: {},
    } as AssistantPluginActionDescriptor;
    const repository = { repoId: 'repo1', activeCheckoutId: 'co1' } as Parameters<
      typeof claimsForAssistantPluginAction
    >[1];
    const providerA = claimsForAssistantPluginAction(action, repository, 'provider_a');
    const providerB = claimsForAssistantPluginAction(action, repository, 'provider_b');
    expect(providerA).toEqual([{ resourceKey: 'provider-state:provider_a', mode: 'write' }]);
    expect(providerA.some((claim) => claim.resourceKey.startsWith('workspace:'))).toBe(false);
    expect(claimsConflict(providerA[0]!, lease('provider-state:provider_a', 'write'))).toBe(true);
    expect(claimsConflict(providerA[0]!, lease('provider-state:provider_b', 'write'))).toBe(false);
    expect(claimsConflict(providerA[0]!, lease('workspace:co1', 'write'))).toBe(false);
    expect(providerB).toEqual([{ resourceKey: 'provider-state:provider_b', mode: 'write' }]);
  });
});
