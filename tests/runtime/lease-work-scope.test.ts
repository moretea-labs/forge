import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  acquireExecutionLeases,
  listActiveLeases,
  releaseExecutionLeases,
  renewExecutionLeases,
} from '../../src/runtime/resources/leases/store';
import type { ResourceClaimSpec } from '../../src/runtime/execution/jobs/types';

const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'lease-work-scope-'));
  homes.push(value);
  return value;
}

function claim(checkoutId: string, workId: string, mode: 'read' | 'write' = 'write'): ResourceClaimSpec {
  return {
    resourceKey: `workspace:${checkoutId}`,
    mode,
    repoId: 'repo-a',
    checkoutId,
    workId,
  };
}

describe('checkout and Work-scoped execution leases', () => {
  test('persists scope and refuses mismatched renew or release evidence', () => {
    const controllerHome = home();
    const acquired = acquireExecutionLeases(controllerHome, 'repo-a', 'process:one', [claim('co-a', 'work-a')], 30_000);
    expect(acquired.acquired).toBe(true);
    expect(acquired.leases[0]).toMatchObject({ repoId: 'repo-a', checkoutId: 'co-a', workId: 'work-a' });

    const wrong = acquired.leases.map((lease) => ({ ...lease, workId: 'work-b' }));
    expect(() => renewExecutionLeases(controllerHome, 'repo-a', 'process:one', 30_000, wrong)).toThrow(/FENCING_TOKEN_STALE/);
    releaseExecutionLeases(controllerHome, 'repo-a', 'process:one', wrong);
    expect(listActiveLeases(controllerHome, 'repo-a')).toHaveLength(1);

    releaseExecutionLeases(controllerHome, 'repo-a', 'process:one', acquired.leases);
    expect(listActiveLeases(controllerHome, 'repo-a')).toHaveLength(0);
  });

  test('checkout-distinct workspaces do not block each other but the same checkout does', () => {
    const controllerHome = home();
    const first = acquireExecutionLeases(controllerHome, 'repo-a', 'process:a', [claim('co-a', 'work-a')], 30_000);
    expect(first.acquired).toBe(true);
    const otherCheckout = acquireExecutionLeases(controllerHome, 'repo-a', 'process:b', [claim('co-b', 'work-b')], 30_000);
    expect(otherCheckout.acquired).toBe(true);
    const sameCheckout = acquireExecutionLeases(controllerHome, 'repo-a', 'process:c', [claim('co-a', 'work-c')], 30_000);
    expect(sameCheckout.acquired).toBe(false);
    releaseExecutionLeases(controllerHome, 'repo-a', 'process:a', first.leases);
    releaseExecutionLeases(controllerHome, 'repo-a', 'process:b', otherCheckout.leases);
  });

  test('rejects contradictory repository or incomplete Work scope before persistence', () => {
    const controllerHome = home();
    expect(() => acquireExecutionLeases(controllerHome, 'repo-a', 'process:bad', [{
      ...claim('co-a', 'work-a'),
      repoId: 'repo-b',
    }], 30_000)).toThrow(/LEASE_REPOSITORY_SCOPE_MISMATCH/);
    expect(() => acquireExecutionLeases(controllerHome, 'repo-a', 'process:bad-2', [{
      resourceKey: 'workspace:co-a',
      mode: 'write',
      workId: 'work-a',
    }], 30_000)).toThrow(/LEASE_WORK_SCOPE_INCOMPLETE/);
    expect(listActiveLeases(controllerHome, 'repo-a')).toHaveLength(0);
  });
});
