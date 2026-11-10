import { describe, expect, test } from 'bun:test';
import {
  claimsForCheck,
  claimsForRepositoryCommand,
  scopeResourceClaims,
} from '../../src/runtime/execution/process-runtime/resource-claims';
import { classifyRepositoryCommand, shellCommandHasUnsafeConstructs, shellSegments } from '../../src/cli/repositories/command-classifier';
import { claimsConflict } from '../../src/runtime/resources/claims/conflicts';
import type { ExecutionLease } from '../../src/runtime/resources/leases/types';
import { claimsForAssistantPluginAction } from '../../src/runtime/plugins/store';
import type { AssistantPluginActionDescriptor } from '../../src/runtime/plugins/types';
import { createDesktopOperatorRegistrationInput } from '../../src/runtime/plugins/desktop-operator-registration';
import { computerPluginAdapter } from '../../src/runtime/plugins/computer-registration';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireExecutionLeases, assertFencingToken, listActiveLeases, releaseExecutionLeases, releaseTerminalProcessLeases, withRepositoryMutationExclusion } from '../../src/runtime/resources/leases/store';
import { classifyRepositoryCommandRoute } from '../../src/runtime/execution/process-runtime/command-facade';
import { repositoryControllerRoot } from '../../src/effects/controller-home';
import { normalizeMutationOwnerIdentity } from '../../src/runtime/execution/thin-harness/mutation-gate';

function lease(resourceKey: string, mode: 'read' | 'write' | 'exclusive'): ExecutionLease {
  return { resourceKey, mode } as ExecutionLease;
}

describe('Process Runtime fine-grained resource claims', () => {
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
      expect(normalizeMutationOwnerIdentity({
        repoId: 'repo1',
        checkoutId: 'checkout1',
        owner: 'fast:identity-test',
      })).toMatchObject({
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

  test('model-declared mutation paths narrow source claims without platform inference (#478)', () => {
    const command = ['bash', 'scripts/run_module_check.sh', 'integration'];
    const inferred = claimsForRepositoryCommand(command, 'repo1', 'co1');
    expect(inferred).toContainEqual({ resourceKey: 'workspace:co1', mode: 'write' });

    const scoped = claimsForRepositoryCommand(
      command,
      'repo1',
      'co1',
      'main',
      undefined,
      undefined,
      ['client-a'],
    );
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
    const held = acquireExecutionLeases(controllerHome, 'repo1', 'android-build', [
      { resourceKey: 'path:co1:android', mode: 'write' },
    ], { visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false });
    expect(held.acquired).toBe(true);
    try {
      expect(withRepositoryMutationExclusion(
        controllerHome,
        'repo1',
        'ios-edit',
        () => 'applied',
        undefined,
        [{ resourceKey: 'path:co1:ios/App.swift', mode: 'write' }],
      )).toBe('applied');

      expect(() => withRepositoryMutationExclusion(
        controllerHome,
        'repo1',
        'android-edit',
        () => 'unreachable',
        undefined,
        [{ resourceKey: 'path:co1:android/app/src/Main.kt', mode: 'write' }],
      )).toThrow('REPOSITORY_PROCESS_LEASE_HELD');

      // Legacy/unknown source mutation remains fail-closed.
      expect(() => withRepositoryMutationExclusion(
        controllerHome,
        'repo1',
        'unknown-edit',
        () => 'unreachable',
      )).toThrow('REPOSITORY_PROCESS_LEASE_HELD');
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
    const exact = ['git', 'push', '--porcelain',
      '--force-with-lease=refs/heads/' + branch + ':' + sha,
      'origin', ':refs/heads/' + branch];
    // Do not downgrade Git authorization: only the physical resource lease is narrowed.
    expect(classifyRepositoryCommand(exact, 'ios/integration').risk).toBe('destructive');
    const claims = claimsForRepositoryCommand(exact, 'repo1', 'checkout-dirty', 'ios/integration');
    expect(claims).toEqual([{ resourceKey: 'remote-ref:repo1:origin:refs/heads/' + branch, mode: 'exclusive' }]);
    expect(claimsConflict(claims[0]!, lease('workspace:checkout-dirty', 'write'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('git-index:checkout-dirty', 'exclusive'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('git-refs:repo1', 'exclusive'))).toBe(true);
    expect(claimsConflict(claims[0]!, lease('remote:repo1', 'exclusive'))).toBe(true);
    expect(claimsConflict(claims[0]!, lease('remote-ref:repo1:origin:refs/heads/' + branch, 'write'))).toBe(true);
    expect(claimsConflict(claims[0]!, lease('remote-ref:repo1:origin:refs/heads/review/other', 'exclusive'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('remote-ref:repo2:origin:refs/heads/' + branch, 'exclusive'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('remote:repo2', 'exclusive'))).toBe(false);

    const variants: Array<readonly string[] | string> = [
      ['git', 'push', 'origin', ':refs/heads/' + branch],
      ['git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha.slice(1),
        'origin', ':refs/heads/' + branch],
      ['git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha,
        'origin', ':refs/heads/other-branch'],
      ['git', 'push', '--force-with-lease=refs/heads/main:' + sha, 'origin', ':refs/heads/main'],
      ['git', 'push', '--force-with-lease=refs/heads/ios/integration:' + sha, 'origin', ':refs/heads/ios/integration'],
      ['git', 'push', '--force-with-lease=refs/heads/release/1.8:' + sha, 'origin', ':refs/heads/release/1.8'],
      ['git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha, 'upstream', ':refs/heads/' + branch],
      ['git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha, 'origin', ':refs/heads/' + branch, '--tags'],
      'git push --force-with-lease=refs/heads/' + branch + ':' + sha + ' origin :refs/heads/' + branch,
    ];
    for (const unsafe of variants) {
      const conservative = claimsForRepositoryCommand(unsafe, 'repo1', 'checkout-dirty', 'ios/integration');
      expect(conservative.some((claim) => claim.resourceKey.startsWith('remote-ref:'))).toBe(false);
      expect(conservative).toContainEqual({ resourceKey: 'workspace:checkout-dirty', mode: 'write' });
    }
    expect(claimsForRepositoryCommand([
      'git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha,
      'origin', '--delete', branch,
    ], 'repo1', 'checkout-dirty', 'ios/integration')).toEqual([
      { resourceKey: 'remote-ref:repo1:origin:refs/heads/' + branch, mode: 'exclusive' },
    ]);
  });


  test('exact remote ref leases serialize one branch while allowing independent review branches (#469)', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-remote-ref-claims-'));
    const original = [{ resourceKey: 'remote-ref:repo1:origin:refs/heads/review/first', mode: 'exclusive' as const }];
    const same = [{ ...original[0]! }];
    const different = [{ resourceKey: 'remote-ref:repo1:origin:refs/heads/review/second', mode: 'exclusive' as const }];
    const broad = [{ resourceKey: 'git-refs:repo1', mode: 'exclusive' as const }];
    try {
      expect(acquireExecutionLeases(controllerHome, 'repo1', 'first', original, { visibility: 'ephemeral' }).acquired).toBe(true);
      expect(acquireExecutionLeases(controllerHome, 'repo1', 'same', same, { visibility: 'ephemeral' }).acquired).toBe(false);
      expect(acquireExecutionLeases(controllerHome, 'repo1', 'different', different, { visibility: 'ephemeral' }).acquired).toBe(true);
      expect(acquireExecutionLeases(controllerHome, 'repo1', 'broad', broad, { visibility: 'ephemeral' }).acquired).toBe(false);
      releaseExecutionLeases(controllerHome, 'repo1', 'first');
      releaseExecutionLeases(controllerHome, 'repo1', 'different');
      expect(acquireExecutionLeases(controllerHome, 'repo1', 'broad', broad, { visibility: 'ephemeral' }).acquired).toBe(true);
    } finally {
      releaseExecutionLeases(controllerHome, 'repo1', 'first');
      releaseExecutionLeases(controllerHome, 'repo1', 'different');
      releaseExecutionLeases(controllerHome, 'repo1', 'broad');
      rmSync(controllerHome, { recursive: true, force: true });
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
      expect(cacheA.some((left) => cacheB.some((right) => claimsConflict(left, lease(right.resourceKey, right.mode))))).toBe(false);
      const shared = claimsForRepositoryCommand([
        'xcodebuild', '-project', 'App.xcodeproj', '-derivedDataPath', join(root, 'checkout-a/build/DerivedData'), 'build',
      ], 'repo2', 'co-c', 'main', root);
      expect(acquireExecutionLeases(home, 'repo2', 'shared-cache', shared, options).acquired).toBe(false);
      const parent = claimsForRepositoryCommand([
        'xcodebuild', '-project', 'App.xcodeproj', '-derivedDataPath', join(root, 'checkout-a/build'), 'clean',
      ], 'repo1', 'co-d', 'main', root);
      expect(acquireExecutionLeases(home, 'repo1', 'parent-cache', parent, options).acquired).toBe(false);
      const unknown = claimsForRepositoryCommand(['xcodebuild', '-project', 'App.xcodeproj', 'build'], 'repo1', 'co-e');
      expect(acquireExecutionLeases(home, 'repo1', 'unknown-cache', unknown, options).acquired).toBe(false);
      releaseExecutionLeases(home, 'repo1', 'build-a');
      expect(acquireExecutionLeases(home, 'repo1', 'build-b', b, options).acquired).toBe(true);
      const otherRepo = claimsForRepositoryCommand(command, 'repo2', 'co-f', 'main', join(root, 'checkout-a'));
      expect(acquireExecutionLeases(home, 'repo2', 'other-repo', otherRepo, options).acquired).toBe(false);
      expect(claimsForRepositoryCommand(['xcodebuild', '-version'], 'repo2', 'co-f')).not.toContainEqual({ resourceKey: 'host-service:ios-build', mode: 'write' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Xcode cache identity follows the execution cwd, literal shell paths and existing symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-xcode-path-'));
    try {
      const cwd = join(root, 'actual cwd');
      mkdirSync(cwd);
      symlinkSync(cwd, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      symlinkSync(join(root, 'missing-target'), join(root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
      const absolute = claimsForRepositoryCommand(['xcodebuild', '-derivedDataPath', join(cwd, 'cache'), 'build'], 'repo1', 'co-a');
      for (const command of [
        'xcodebuild -derivedDataPath cache build',
        'xcrun xcodebuild -derivedDataPath cache build',
        ['bash', '-lc', 'xcodebuild -derivedDataPath cache build'],
        `cd '${join(root, 'alias')}' && xcodebuild -derivedDataPath cache build`,
      ]) {
        const relative = claimsForRepositoryCommand(command, 'repo1', 'co-b', 'main', root, cwd);
        expect(relative.some((claim) => absolute.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))))).toBe(true);
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
        expect(claimsForRepositoryCommand(command, 'repo1', 'co-b', 'main', root, cwd))
          .toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      }
      const testA = claimsForRepositoryCommand(['xcodebuild', 'test', '-derivedDataPath', join(cwd, 'a')], 'repo1', 'co-a');
      const testB = claimsForRepositoryCommand(['xcodebuild', 'test', '-derivedDataPath', join(cwd, 'b')], 'repo2', 'co-b');
      expect(testA).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
      expect(testB.some((claim) => claimsConflict(claim, lease('host-service:ios-simulator-test', 'write')))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('readonly commands claim workspace read only', () => {
    const claims = claimsForRepositoryCommand(['git', 'status'], 'repo1', 'co1');
    expect(claims).toEqual([{ resourceKey: 'workspace:co1', mode: 'read' }]);
  });

  test('ordinary xcodebuild log redirection does not acquire unrelated Git-ref ownership', () => {
    const command = "cd /worktrees/ocr && xcodebuild -project ios/App.xcodeproj -derivedDataPath .forge/ios/ocr -jobs 2 build > .forge/ios/build.log 2>&1; rc=$?; grep 'BUILD' .forge/ios/build.log | tail -2; exit $rc";
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
    expect(claimsForRepositoryCommand(actualBackground, 'repo1', 'checkout-ocr'))
      .toContainEqual({ resourceKey: 'git-refs:repo1', mode: 'exclusive' });
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

    expect(claimsForRepositoryCommand(['brew', 'install', './Formula/local.rb'], 'repo1', 'co1')).toContainEqual({
      resourceKey: 'workspace:co1', mode: 'write',
    });
  });

  test('scoped claims retain conflict keys and exact repository/checkout ownership without Work', () => {
    const claims = scopeResourceClaims(
      claimsForRepositoryCommand(['git', 'status'], 'repo1', 'co1'),
      'repo1',
      'co1',
    );
    expect(claims).toEqual([{
      resourceKey: 'workspace:co1',
      mode: 'read',
      repoId: 'repo1',
      checkoutId: 'co1',
    }]);
  });

  test('typecheck uses workspace read plus cache and the compiler-heavy serialization fence', () => {
    const claims = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co1');
    expect(claims).toContainEqual({ resourceKey: 'workspace:co1', mode: 'read' });
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
    expect(claims).toContainEqual({ resourceKey: 'workspace:co1', mode: 'read' });
  });

  test('raw typed tsc --noEmit uses workspace read plus cache instead of a workspace writer', () => {
    for (const command of [
      ['tsc', '--noEmit'],
      ['bun', 'x', 'tsc', '--noEmit'],
      ['/opt/bun/bin/bun', 'x', '/repo/node_modules/.bin/tsc', '--noEmit', '--pretty', 'false'],
    ]) {
      const claims = claimsForRepositoryCommand(command, 'repo1', 'co1');
      expect(claims).toContainEqual({ resourceKey: 'workspace:co1', mode: 'read' });
      expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
      expect(claims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode !== 'read')).toBe(false);
    }
  });

  test('shell-composed tsc and emitting tsc remain conservative workspace writers', () => {
    expect(claimsForRepositoryCommand('tsc --noEmit && touch generated.txt', 'repo1', 'co1')).toContainEqual({
      resourceKey: 'workspace:co1', mode: 'write',
    });
    expect(claimsForRepositoryCommand(['bun', 'x', 'tsc'], 'repo1', 'co1')).toContainEqual({
      resourceKey: 'workspace:co1', mode: 'write',
    });
  });

  test('a long static check remains compatible with an unrelated workspace reader', () => {
    const claims = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co1');
    const reader = lease('workspace:co1', 'read');
    expect(claims.some((claim) => claimsConflict(claim, reader))).toBe(false);
  });

  test('xcodebuild simulator tests serialize host-wide without taking a workspace writer', () => {
    const claims = claimsForRepositoryCommand([
      '/Applications/Xcode-beta.app/Contents/Developer/usr/bin/xcodebuild',
      'test', '-project', 'App.xcodeproj', '-destination', 'id=SIM-1',
    ], 'repo1', 'co1');
    expect(claims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'workspace:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode !== 'read')).toBe(false);
  });

  test('shell-wrapped xcodebuild simulator tests use the same host-wide lease', () => {
    const claims = claimsForRepositoryCommand(
      ['bash', '-lc', "xcodebuild test -project App.xcodeproj -destination 'platform=iOS Simulator,name=iPhone 17 Pro'"],
      'repo2', 'co2',
    );
    expect(claims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'workspace:co2', mode: 'read' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co2' && claim.mode !== 'read')).toBe(false);
  });

  test('scripted iOS and Android live journeys claim one host-wide device each', () => {
    const ios = claimsForCheck(
      'ios-fast-journey',
      ['bash', 'scripts/run_ios_test_layer.sh', 'fast-journey'],
      'avela', 'ios-checkout',
    );
    const otherIos = claimsForCheck(
      'ios-integration-consistency',
      ['bash', 'scripts/run_ios_test_layer.sh', 'integration-consistency'],
      'other-repo', 'other-checkout',
    );
    const android = claimsForCheck(
      'android-fast-journey',
      ['bash', 'scripts/run_android_check.sh', 'fast-journey'],
      'avela', 'android-checkout',
    );
    expect(ios).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    expect(android).toContainEqual({ resourceKey: 'host-service:android-emulator-test', mode: 'write' });
    expect(ios.some((claim) => otherIos.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))))).toBe(true);
    expect(ios.filter((claim) => claim.resourceKey.startsWith('host-service:'))
      .some((claim) => android.filter((other) => other.resourceKey.startsWith('host-service:'))
        .some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))))).toBe(false);
    expect(claimsForCheck('android-build', ['bash', 'scripts/run_android_check.sh', 'build'], 'avela', 'co1')
      .some((claim) => claim.resourceKey.startsWith('host-service:'))).toBe(false);
    expect(claimsForCheck('ios-layout-static', ['python3', 'scripts/audit_swiftui_layout_risks.py'], 'avela', 'co1')
      .some((claim) => claim.resourceKey.startsWith('host-service:'))).toBe(false);
    expect(claimsForRepositoryCommand(['bash', 'scripts/run_android_check.sh', 'integration'], 'avela', 'co1'))
      .toContainEqual({ resourceKey: 'host-service:android-emulator-test', mode: 'write' });
  });

  test('all Avela live journey, profile, and owner runners share one iOS device key', () => {
    for (const mode of ['fast-journey', 'integration-consistency', 'medication-long-journey', 'ui-geometry', 'destructive-model', 'performance-critical', 'all']) {
      expect(claimsForRepositoryCommand(['bash', 'scripts/run_ios_test_layer.sh', mode], 'repo1', 'co1'))
        .toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    }
    for (const script of ['run_ios_owner_test.sh', 'run_ios_test_profile.sh', 'run_ios_performance_tests.sh', 'run_medication_long_journeys.sh']) {
      expect(claimsForRepositoryCommand(['bash', `scripts/${script}`, 'fast'], 'repo1', 'co1'))
        .toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
    }
    const staticLayer = claimsForRepositoryCommand(['bash', 'scripts/run_ios_test_layer.sh', 'static-layout'], 'repo1', 'co1');
    expect(staticLayer.some((claim) => claim.resourceKey === 'host-service:ios-simulator-test')).toBe(false);
    const wrapped = claimsForRepositoryCommand(['bash', '-lc', 'bash scripts/run_ios_test_layer.sh ui-geometry'], 'repo1', 'co1');
    expect(wrapped).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
  });

  test('iOS plugin simulator calls and Process checks share the exact lease authority', () => {
    const repository = { repoId: 'avela', activeCheckoutId: 'co1' } as Parameters<typeof claimsForAssistantPluginAction>[1];
    const action = (actionId: string): AssistantPluginActionDescriptor => ({
      actionId, title: actionId, description: '', readOnly: false, risk: 'workspace_write',
      confirmation: 'authorization', defaultTimeoutMs: 60000,
      cancellable: true, idempotent: false, scopes: ['ios.simulator'],
      resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
      argumentsSchema: {},
    });
    const testClaims = claimsForCheck('ios-fast-journey', ['bash', 'scripts/run_ios_test_layer.sh', 'fast-journey'], 'avela', 'co1');
    for (const id of ['xcode_test', 'smoke_review', 'launch_simulator', 'capture_screenshot', 'agent_device_prepare']) {
      const pluginClaims = claimsForAssistantPluginAction(action(id), repository, 'ios');
      expect(pluginClaims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
      expect(pluginClaims.some((claim) => testClaims.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))))).toBe(true);
    }
    // Long-lived AgentDevice sessions keep this same lease after open returns,
    // so per-command actions must not acquire a second short-lived copy.
    for (const id of ['agent_device_open', 'agent_device_batch', 'agent_device_snapshot', 'agent_device_close']) {
      expect(claimsForAssistantPluginAction(action(id), repository, 'ios')
        .some((claim) => claim.resourceKey === 'host-service:ios-simulator-test')).toBe(false);
    }
    for (const id of ['build', 'xcode_test', 'smoke_review']) {
      const native = claimsForAssistantPluginAction(action(id), repository, 'ios');
      expect(native).toContainEqual({ resourceKey: 'host-service:ios-build', mode: 'write' });
    }
    expect(claimsForAssistantPluginAction(action('agent_device_status'), repository, 'ios')
      .some((claim) => claim.resourceKey === 'host-service:ios-simulator-test')).toBe(false);
    expect(claimsForAssistantPluginAction(action('xcode_test'), repository, 'another-plugin')
      .some((claim) => claim.resourceKey === 'host-service:ios-simulator-test')).toBe(false);
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
    expect(claims).toContainEqual({ resourceKey: 'path:co1:src', mode: 'read' });
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
    const browserA = claimsForCheck('package:test:browser-live', ['bun', 'tests/live/browser-native-silent.e2e.ts'], 'repo1', 'co-browser-a', effects);
    const browserB = claimsForCheck('package:test:browser-live', ['bun', 'tests/live/browser-native-silent.e2e.ts'], 'repo1', 'co-browser-b', effects);
    const typecheck = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co-type');

    expect(browserA).toContainEqual({ resourceKey: 'workspace:co-browser-a', mode: 'read' });
    expect(browserA).toContainEqual({ resourceKey: 'temp:co-browser-a:package-test-browser-live', mode: 'write' });
    expect(browserA).toContainEqual({ resourceKey: 'host-service:browser-live', mode: 'write' });
    expect(browserA.some((claim) => claim.resourceKey === 'build-cache:repo1')).toBe(false);
    expect(browserA.some((claim) => typecheck.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))))).toBe(false);
    expect(browserA.some((claim) => browserB.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))))).toBe(true);
  });

  test('undeclared custom build checks fail closed without duplicate workspace read', () => {
    const claims = claimsForCheck('custom:generate', ['bun', 'run', 'generate'], 'repo1', 'co1');
    expect(claims).toEqual([{ resourceKey: 'workspace:co1', mode: 'write' }]);
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode === 'read')).toBe(false);
  });

  test('custom checks named like static tools still fail closed without declared effects', () => {
    const claims = claimsForCheck('custom:lint', ['node', 'generate.js'], 'repo1', 'co1');
    expect(claims).toEqual([{ resourceKey: 'workspace:co1', mode: 'write' }]);
  });

  test('release checks retain heavy-check exclusivity', () => {
    const claims = claimsForCheck('check:release', undefined, 'repo1', 'co1');
    expect(claims).toContainEqual({ resourceKey: 'heavy-check:repo1', mode: 'exclusive' });
  });

  test('Computer and Desktop Operator mutations share one provider-state lease while reads remain unclaimed (#638)', () => {
    const registration = createDesktopOperatorRegistrationInput({
      socketPath: '/tmp/forge-desktop-operator.sock',
      pluginVersion: '0.4.7',
    });
    const repository = { repoId: 'repo1', activeCheckoutId: 'co1' } as Parameters<typeof claimsForAssistantPluginAction>[1];
    const canonicalClaim = [{ resourceKey: 'provider-state:desktop_operator', mode: 'write' as const }];

    for (const actionId of ['desktop_press', 'desktop_select_rows', 'desktop_pointer_click', 'desktop_pointer_drag', 'desktop_type_text', 'desktop_key', 'desktop_open_url', 'desktop_clipboard_write', 'desktop_copy', 'desktop_paste', 'desktop_permissions_request', 'desktop_session_open', 'desktop_session_close', 'desktop_batch']) {
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
    for (const actionId of ['desktop_target_open', 'desktop_target_close', 'desktop_press', 'desktop_select_rows', 'desktop_type_text', 'desktop_key', 'desktop_open_url', 'desktop_element_action']) {
      const action = computer.find((candidate) => candidate.actionId === actionId);
      expect(action, `Computer action ${actionId}`).toBeDefined();
      expect(claimsForAssistantPluginAction(action!, repository, 'computer')).toEqual(canonicalClaim);
    }
    for (const actionId of ['desktop_target_list', 'desktop_observe', 'desktop_screenshot', 'desktop_element_observe']) {
      const action = computer.find((candidate) => candidate.actionId === actionId);
      expect(action, `Computer read ${actionId}`).toBeDefined();
      expect(claimsForAssistantPluginAction(action!, repository, 'computer')).toEqual([]);
    }
  });

  test('Browser remote claims are exact-session scoped while provider state remains global (#619)', () => {
    const repository = { repoId: 'repo1', activeCheckoutId: 'co1' } as Parameters<typeof claimsForAssistantPluginAction>[1];
    const remoteAction = {
      actionId: 'navigate', title: 'Navigate', description: 'test', readOnly: false,
      risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 60_000,
      cancellable: true, idempotent: false, scopes: ['browser.interact'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {},
    } as AssistantPluginActionDescriptor;
    const providerAction = {
      ...remoteAction,
      actionId: 'configure',
      resourceClaims: [{ resource: 'provider-state', mode: 'write' }],
    } as AssistantPluginActionDescriptor;

    const sessionA = claimsForAssistantPluginAction(remoteAction, repository, 'browser', { session_id: 'session-a' }, 'request-a');
    const sessionAAgain = claimsForAssistantPluginAction(remoteAction, repository, 'browser', { session_id: 'session-a' }, 'request-b');
    const sessionB = claimsForAssistantPluginAction(remoteAction, repository, 'browser', { session_id: 'session-b' }, 'request-c');
    const freshA = claimsForAssistantPluginAction(remoteAction, repository, 'browser', {}, 'fresh-a');
    const freshB = claimsForAssistantPluginAction(remoteAction, repository, 'browser', {}, 'fresh-b');
    const exactTab = claimsForAssistantPluginAction(remoteAction, repository, 'browser', {
      native_browser_product: 'chrome', native_window_id: 'window-7', native_tab_id: 'tab-42',
    }, 'tab-request');

    expect(sessionA[0]?.resourceKey).toBe(sessionAAgain[0]?.resourceKey);
    expect(sessionA[0]?.resourceKey).not.toBe(sessionB[0]?.resourceKey);
    expect(freshA[0]?.resourceKey).not.toBe(freshB[0]?.resourceKey);
    expect(exactTab[0]?.resourceKey).toMatch(/^provider-resource:browser:/);
    expect(claimsConflict(sessionA[0]!, lease(sessionAAgain[0]!.resourceKey, 'exclusive'))).toBe(true);
    expect(claimsConflict(sessionA[0]!, lease(sessionB[0]!.resourceKey, 'exclusive'))).toBe(false);
    expect(claimsForAssistantPluginAction(providerAction, repository, 'browser', { session_id: 'session-a' }, 'provider-a')).toEqual([
      { resourceKey: 'provider-state:browser', mode: 'write' },
    ]);
  });

  test('terminal Process release persists owner, fencing and resource receipt for ephemeral leases', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'forge-terminal-lease-audit-'));
    const repoId = 'repo-lease-audit';
    const processId = 'proc-audit-1';
    const ownerJobId = `process:${processId}`;
    try {
      const acquired = acquireExecutionLeases(controllerHome, repoId, ownerJobId, [{
        resourceKey: 'host-service:ios-simulator-test',
        mode: 'write',
        repoId,
        checkoutId: 'checkout-audit',
      }], {
        visibility: 'ephemeral',
        notifyScheduler: false,
        invalidateProjection: false,
        emitRuntimeEvent: false,
      });
      expect(acquired.acquired).toBe(true);
      const held = acquired.leases[0]!;
      const released = releaseTerminalProcessLeases(controllerHome, repoId, processId, acquired.leases.map((lease) => ({
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        repoId: lease.repoId,
        checkoutId: lease.checkoutId,
        resourceKey: lease.resourceKey,
        ownerIdentityDigest: lease.ownerIdentityDigest,
      })), {
        visibility: 'ephemeral',
        notifyScheduler: false,
        invalidateProjection: false,
        emitRuntimeEvent: false,
      });
      expect(released).toBe(1);

      const ledger = join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
      const events = readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as {
          eventType: string; entityId: string; requestId: string; correlationId?: string;
          revision: number; data?: Record<string, unknown>;
        });
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
      const acquired = acquireExecutionLeases(controllerHome, repoId, 'expired-owner', [{
        resourceKey: 'workspace:checkout-expired',
        mode: 'write',
        repoId,
        checkoutId: 'checkout-expired',
      }], {
        visibility: 'ephemeral',
        notifyScheduler: false,
        invalidateProjection: false,
        emitRuntimeEvent: false,
        ttlMs: 5_000,
      });
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
      const events = readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as {
          eventType: string; entityId: string; requestId: string; revision: number; data?: Record<string, unknown>;
        });
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
      const acquired = acquireExecutionLeases(controllerHome, repoId, 'fenced-owner', [{
        resourceKey: 'workspace:checkout-fenced',
        mode: 'write',
        repoId,
        checkoutId: 'checkout-fenced',
      }], {
        visibility: 'ephemeral',
        notifyScheduler: false,
        invalidateProjection: false,
        emitRuntimeEvent: false,
        ttlMs: 5_000,
      });
      expect(acquired.acquired).toBe(true);
      const held = acquired.leases[0]!;
      const originalNow = Date.now;
      Date.now = () => Date.parse(held.expiresAt) + 1;
      try {
        expect(() => assertFencingToken(controllerHome, repoId, held.leaseId, held.fencingToken))
          .toThrow(`LEASE_EXPIRED: ${held.leaseId}`);
      } finally {
        Date.now = originalNow;
      }

      const ledger = join(repositoryControllerRoot(controllerHome, repoId), 'events', 'ledger.jsonl');
      const events = readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as {
          eventType: string; entityId: string; requestId: string; revision: number; data?: Record<string, unknown>;
        });
      expect(events.find((event) => event.eventType === 'lease_expired' && event.entityId === held.leaseId))
        .toMatchObject({
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
        visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false, ttlMs: 60_000,
      });
      expect(held.acquired).toBe(true);
      const blocked = acquireExecutionLeases(controllerHome, repoId, 'computer-owner-b', claim, {
        visibility: 'ephemeral', notifyScheduler: false, invalidateProjection: false, emitRuntimeEvent: false, ttlMs: 60_000,
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
      actionId: 'mutate_provider', title: 'Mutate provider', description: 'test', readOnly: false,
      risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 1_000,
      cancellable: true, idempotent: false, scopes: [], resourceClaims: [{ resource: 'remote', mode: 'write' }], argumentsSchema: {},
    } as AssistantPluginActionDescriptor;
    const repository = { repoId: 'repo1', activeCheckoutId: 'co1' } as Parameters<typeof claimsForAssistantPluginAction>[1];
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
