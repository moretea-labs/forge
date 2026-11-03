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
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireExecutionLeases, releaseExecutionLeases } from '../../src/runtime/resources/leases/store';

function lease(resourceKey: string, mode: 'read' | 'write' | 'exclusive'): ExecutionLease {
  return { resourceKey, mode } as ExecutionLease;
}

describe('Process Runtime fine-grained resource claims', () => {
  test('exact leased remote review-branch deletion does not acquire an unrelated checkout writer (#469)', () => {
    const sha = 'a'.repeat(40);
    const branch = 'ios/onboarding-welcome-review-20261026';
    const exact = ['git', 'push', '--porcelain',
      '--force-with-lease=refs/heads/' + branch + ':' + sha,
      'origin', ':refs/heads/' + branch];
    // Do not downgrade Git authorization: only the physical resource lease is narrowed.
    expect(classifyRepositoryCommand(exact, 'ios/integration').risk).toBe('destructive');
    const claims = claimsForRepositoryCommand(exact, 'repo1', 'checkout-dirty', 'ios/integration');
    expect(claims).toEqual([{ resourceKey: 'remote:repo1', mode: 'exclusive' }]);
    expect(claimsConflict(claims[0]!, lease('workspace:checkout-dirty', 'write'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('git-index:checkout-dirty', 'exclusive'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('git-refs:repo1', 'exclusive'))).toBe(false);
    expect(claimsConflict(claims[0]!, lease('remote:repo1', 'exclusive'))).toBe(true);
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
      expect(conservative.some((claim) => claim.resourceKey === 'remote:repo1')).toBe(false);
      expect(conservative).toContainEqual({ resourceKey: 'workspace:checkout-dirty', mode: 'write' });
    }
    expect(claimsForRepositoryCommand([
      'git', 'push', '--force-with-lease=refs/heads/' + branch + ':' + sha,
      'origin', '--delete', branch,
    ], 'repo1', 'checkout-dirty', 'ios/integration')).toEqual([
      { resourceKey: 'remote:repo1', mode: 'exclusive' },
    ]);
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

  test('Work-bound claims retain conflict keys and carry exact repository, checkout and Work scope', () => {
    const claims = scopeResourceClaims(
      claimsForRepositoryCommand(['git', 'status'], 'repo1', 'co1'),
      'repo1',
      'co1',
      'work1',
    );
    expect(claims).toEqual([{
      resourceKey: 'workspace:co1',
      mode: 'read',
      repoId: 'repo1',
      checkoutId: 'co1',
      workId: 'work1',
    }]);
    expect(() => scopeResourceClaims(claims, 'repo1', 'co1', 'work2')).toThrow(/RESOURCE_CLAIM_WORK_MISMATCH/);
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
    for (const id of ['xcode_test', 'smoke_review', 'agent_device_open', 'agent_device_batch', 'capture_screenshot']) {
      const pluginClaims = claimsForAssistantPluginAction(action(id), repository, 'ios');
      expect(pluginClaims).toContainEqual({ resourceKey: 'host-service:ios-simulator-test', mode: 'write' });
      expect(pluginClaims.some((claim) => testClaims.some((other) => claimsConflict(claim, lease(other.resourceKey, other.mode))))).toBe(true);
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
