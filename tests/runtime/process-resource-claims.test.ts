import { describe, expect, test } from 'bun:test';
import {
  claimsForCheck,
  claimsForRepositoryCommand,
} from '../../src/runtime/execution/process-runtime/resource-claims';
import { claimsForMcpOperation } from '../../src/runtime/gateway/mcp/resource-policy';
import { claimsConflict } from '../../src/runtime/resources/claims/conflicts';
import type { ExecutionLease } from '../../src/runtime/resources/leases/types';

function lease(resourceKey: string, mode: 'read' | 'write' | 'exclusive'): ExecutionLease {
  return { resourceKey, mode } as ExecutionLease;
}

describe('Process Runtime fine-grained resource claims', () => {
  test('readonly commands claim workspace read only', () => {
    const claims = claimsForRepositoryCommand(['git', 'status'], 'repo1', 'co1');
    expect(claims).toEqual([{ resourceKey: 'workspace:co1', mode: 'read' }]);
  });

  test('typecheck uses workspace read plus cache without a same-workspace write', () => {
    const claims = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co1');
    expect(claims).toContainEqual({ resourceKey: 'workspace:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode !== 'read')).toBe(false);
    expect(claims.some((claim) => claim.resourceKey.startsWith('heavy-check:'))).toBe(false);
  });

  test('a long static check remains compatible with an unrelated workspace reader', () => {
    const claims = claimsForCheck('package:check:type', ['bun', 'run', 'check:type'], 'repo1', 'co1');
    const reader = lease('workspace:co1', 'read');
    expect(claims.some((claim) => claimsConflict(claim, reader))).toBe(false);
  });

  test('declared check effects map to bounded resources', () => {
    const claims = claimsForCheck('custom:report', ['node', 'report.js'], 'repo1', 'co1', {
      reads: ['src'],
      writes: ['reports'],
      cache: 'write',
      temp: 'isolated',
      git: 'read',
      network: 'read',
    });
    expect(claims).toContainEqual({ resourceKey: 'path:co1:src', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'path:co1:reports', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'temp:repo1:custom-report', mode: 'write' });
    expect(claims).toContainEqual({ resourceKey: 'git-index:co1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'git-refs:repo1', mode: 'read' });
    expect(claims).toContainEqual({ resourceKey: 'network:repo1', mode: 'read' });
    expect(claims.some((claim) => claim.resourceKey === 'workspace:co1')).toBe(false);
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

  test('Gateway run_check preclassification matches static and heavy check boundaries', () => {
    const typeClaims = claimsForMcpOperation('run_check', { check_id: 'package:check:type' }, 'repo1', 'co1');
    expect(typeClaims).toContainEqual({ resourceKey: 'workspace:co1', mode: 'read' });
    expect(typeClaims).toContainEqual({ resourceKey: 'build-cache:repo1', mode: 'write' });
    expect(typeClaims.some((claim) => claim.resourceKey === 'workspace:co1' && claim.mode !== 'read')).toBe(false);

    const releaseClaims = claimsForMcpOperation('run_check', { check_id: 'check:release' }, 'repo1', 'co1');
    expect(releaseClaims).toContainEqual({ resourceKey: 'heavy-check:repo1', mode: 'exclusive' });
  });
});
