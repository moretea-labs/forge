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
import { acquireExecutionLeases } from '../../src/runtime/resources/leases/store';

function lease(resourceKey: string, mode: 'read' | 'write' | 'exclusive'): ExecutionLease {
  return { resourceKey, mode } as ExecutionLease;
}

describe('Process Runtime fine-grained resource claims', () => {
  test('explicit disjoint Xcode DerivedData permits concurrent real leases while shared and unknown caches block', () => {
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
      expect(acquireExecutionLeases(home, 'repo1', 'build-b', b, options).acquired).toBe(true);
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
