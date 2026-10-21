import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  admitPreparedRepositoryWorkContract,
  updateRepositoryWorkPlacement,
} from '../../src/runtime/control-plane/facade/repository-work-admission';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';
import { updateWorkContract } from '../../packages/kernel/work/api/index';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(repoId: string) {
  const controllerHome = mkdtempSync(join(tmpdir(), 'forge-work-admission-'));
  roots.push(controllerHome);
  return { controllerHome, repoId };
}

describe('repository Work admission authority', () => {
  test('records explicit isolated work_prepare placement without a second admission fence', () => {
    const location = store('repo-prepared-isolated');
    ensureForgeInstanceIdentity({ controllerHome: location.controllerHome, preferredInstanceId: 'forge-prepared' });
    const work = admitPreparedRepositoryWorkContract(location, {
      workId: 'work-prepared-isolated',
      repoId: location.repoId,
      objective: 'Run isolated repository work.',
      acceptanceCriteria: ['Remain isolated.'],
      allowedPaths: ['src/**'],
      checks: ['package:check:type'],
      accessMode: 'request',
      isolated: true,
      requestedBy: 'chatgpt',
      requestId: 'request-prepared-isolated',
    });
    expect(work.constraints).toEqual(expect.objectContaining({ workspaceMode: 'isolated' }));
    expect(work.worktreePolicy.required).toBe(true);
    expect(work.executionPlacement).toMatchObject({ forgeInstanceId: 'forge-prepared', repositoryId: location.repoId });
  });

  test('materializes isolated placement through the canonical Work transition', () => {
    const location = store('repo-materialized-isolated');
    ensureForgeInstanceIdentity({ controllerHome: location.controllerHome, preferredInstanceId: 'forge-materialized' });
    admitPreparedRepositoryWorkContract(location, {
      workId: 'work-materialized-isolated',
      repoId: location.repoId,
      objective: 'Materialize isolated repository work.',
      acceptanceCriteria: [],
      allowedPaths: ['src/**'],
      checks: [],
      accessMode: 'request',
      isolated: true,
      requestedBy: 'chatgpt',
      requestId: 'request-materialized-isolated',
    });
    const materialized = updateRepositoryWorkPlacement(location, 'work-materialized-isolated', {
      kind: 'materialize',
      expectedCheckoutId: undefined,
      expectedWorktreeRef: undefined,
      checkoutId: 'checkout-isolated',
      worktreeRef: '/tmp/forge-isolated-worktree',
      baseRevision: 'abc123',
    });
    expect(materialized).toMatchObject({
      checkoutId: 'checkout-isolated',
      baseRevision: 'abc123',
      worktreeRef: '/tmp/forge-isolated-worktree',
      executionPlacement: { forgeInstanceId: 'forge-materialized', repositoryId: location.repoId, checkoutId: 'checkout-isolated' },
    });
  });


  test('promotes an optional legacy policy only with an explicit isolated placement CAS', () => {
    const location = store('repo-legacy-policy-promotion');
    const admitted = admitPreparedRepositoryWorkContract(location, {
      workId: 'work-legacy-policy-promotion',
      repoId: location.repoId,
      objective: 'Promote an optional legacy policy only when isolation is explicit.',
      acceptanceCriteria: [],
      checks: [],
      accessMode: 'request',
      isolated: false,
      requestedBy: 'chatgpt',
      requestId: 'request-legacy-policy-promotion',
    });
    expect(admitted.worktreePolicy.required).toBe(false);
    const constraints = { ...admitted.constraints, workspaceMode: 'isolated' as const };
    const worktreePolicy = { required: true, reason: 'Managed isolated placement was explicitly selected.' };
    const materialized = updateRepositoryWorkPlacement(location, admitted.workId, {
      kind: 'materialize',
      expectedCheckoutId: admitted.checkoutId,
      expectedWorktreeRef: admitted.worktreeRef,
      checkoutId: 'checkout-promoted',
      worktreeRef: '/tmp/forge-promoted',
      baseRevision: 'abc123',
      worktreePolicy,
      constraints,
    });
    expect(materialized).toMatchObject({ worktreePolicy: { required: true }, constraints: { workspaceMode: 'isolated' } });
    const rebound = updateRepositoryWorkPlacement(location, admitted.workId, {
      kind: 'rebind',
      expectedCheckoutId: materialized.checkoutId,
      expectedWorktreeRef: materialized.worktreeRef,
      checkoutId: 'checkout-rebound',
      worktreeRef: '/tmp/forge-rebound',
      baseRevision: 'def456',
      worktreePolicy,
      constraints,
    });
    expect(rebound).toMatchObject({ checkoutId: 'checkout-rebound', worktreePolicy: { required: true }, constraints: { workspaceMode: 'isolated' } });
  });

  test('binds an explicitly selected current checkout through the canonical placement transition', () => {
    const location = store('repo-materialized-current');
    const admitted = admitPreparedRepositoryWorkContract(location, {
      workId: 'work-materialized-current',
      repoId: location.repoId,
      objective: 'Use the explicitly selected current checkout.',
      acceptanceCriteria: [],
      checks: [],
      accessMode: 'request',
      isolated: false,
      requestedBy: 'chatgpt',
      requestId: 'request-materialized-current',
    });
    const bound = updateRepositoryWorkPlacement(location, admitted.workId, {
      kind: 'bind_current',
      expectedCheckoutId: admitted.checkoutId,
      expectedWorktreeRef: admitted.worktreeRef,
      checkoutId: 'checkout-current',
      constraints: { ...admitted.constraints, workspaceMode: 'current' },
      worktreePolicy: { required: false, reason: 'Caller explicitly selected the current registered checkout.' },
    });
    expect(bound).toMatchObject({
      checkoutId: 'checkout-current',
      worktreeRef: undefined,
      constraints: { workspaceMode: 'current' },
      worktreePolicy: { required: false },
      executionPlacement: { repositoryId: location.repoId, checkoutId: 'checkout-current' },
    });
  });

  test('uses placement CAS for rebind and rejects a stale placement writer', () => {
    const location = store('repo-placement-cas');
    const admitted = admitPreparedRepositoryWorkContract(location, {
      workId: 'work-placement-cas',
      repoId: location.repoId,
      objective: 'Rebind only from the observed placement.',
      acceptanceCriteria: [],
      checks: [],
      accessMode: 'request',
      isolated: true,
      requestedBy: 'chatgpt',
      requestId: 'request-placement-cas',
    });
    const materialized = updateRepositoryWorkPlacement(location, admitted.workId, {
      kind: 'materialize',
      expectedCheckoutId: admitted.checkoutId,
      expectedWorktreeRef: admitted.worktreeRef,
      checkoutId: 'checkout-first',
      worktreeRef: '/tmp/forge-placement-first',
      baseRevision: 'abc123',
    });
    expect(() => updateWorkContract(location, admitted.workId, { checkoutId: 'checkout-bypass' } as never))
      .toThrow('WORK_PLACEMENT_REQUIRES_CAS_API: checkoutId');
    const rebound = updateRepositoryWorkPlacement(location, admitted.workId, {
      kind: 'rebind',
      expectedCheckoutId: materialized.checkoutId,
      expectedWorktreeRef: materialized.worktreeRef,
      checkoutId: 'checkout-second',
      worktreeRef: '/tmp/forge-placement-second',
      baseRevision: 'def456',
    });
    expect(rebound).toMatchObject({ checkoutId: 'checkout-second', worktreeRef: '/tmp/forge-placement-second', baseRevision: 'def456' });
    expect(() => updateRepositoryWorkPlacement(location, admitted.workId, {
      kind: 'rebind',
      expectedCheckoutId: materialized.checkoutId,
      expectedWorktreeRef: materialized.worktreeRef,
      checkoutId: 'checkout-stale',
      worktreeRef: '/tmp/forge-placement-stale',
    })).toThrow('WORK_PLACEMENT_SOURCE_MISMATCH');
  });
});
