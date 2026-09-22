import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  admitDirectEditWorkContract,
  admitPreparedRepositoryWorkContract,
  materializeRepositoryWorkPlacement,
} from '../../src/runtime/control-plane/facade/repository-work-admission';
import { decideRoute } from '../../src/runtime/control-plane/routing/route-policy';
import { ensureForgeInstanceIdentity } from '../../packages/kernel/identity/api/index';

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
  test('canonicalizes isolated work_prepare semantics with a direct-main fence', () => {
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
    expect(work.mode).toBe('goal_workloop');
    expect(work.constraints).toMatchObject({ workspaceMode: 'isolated', requireWorktree: true, directMainProhibited: true });
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
    const materialized = materializeRepositoryWorkPlacement(location, 'work-materialized-isolated', () => ({
      managed: true,
      checkoutId: 'checkout-isolated',
      root: '/tmp/forge-isolated-worktree',
      baseRevision: 'abc123',
    }));
    expect(materialized).toMatchObject({
      checkoutId: 'checkout-isolated',
      baseRevision: 'abc123',
      worktreeRef: '/tmp/forge-isolated-worktree',
      driver: { preferred: 'isolated_worktree', allowDirectEdit: false },
      executionPlacement: { forgeInstanceId: 'forge-materialized', repositoryId: location.repoId, checkoutId: 'checkout-isolated' },
    });
  });


  test('preserves bounded Direct Edit compatibility only for a canonical direct Route Policy decision', () => {
    const location = store('repo-direct-admission');
    ensureForgeInstanceIdentity({ controllerHome: location.controllerHome, preferredInstanceId: 'forge-direct' });
    const routeDecision = decideRoute({
      intent: { objective: 'Edit one bounded file.', scopeClear: true, mutation: true, explicitMode: 'direct' },
      workspace: { knownPaths: ['src/a.ts'], placement: 'current' },
      policy: { risk: 'local_repo_write', approvalConfirmed: true },
      capabilities: {},
      recovery: {},
    });
    expect(routeDecision).toMatchObject({ executionMode: 'direct_control', requiresIsolation: false });
    const work = admitDirectEditWorkContract(location, {
      workId: 'work-direct-admission',
      repoId: location.repoId,
      checkoutId: 'checkout-current',
      principalId: 'principal-a',
      controllerInstanceId: 'controller-a',
      baseRevision: 'abc123',
      workspaceFingerprint: 'workspace-fingerprint',
      routeDecision,
      objective: 'Edit one bounded file.',
      allowedPaths: ['src/a.ts'],
      checks: ['package:check:type'],
      requestedBy: 'chatgpt',
    });
    expect(work).toMatchObject({
      mode: 'direct_control',
      checkoutId: 'checkout-current',
      constraints: { workspaceMode: 'current', requireWorktree: false },
      routeDecisionFingerprint: routeDecision.inputFingerprint,
      executionPlacement: { forgeInstanceId: 'forge-direct', repositoryId: location.repoId, checkoutId: 'checkout-current' },
    });
  });

  test('direct Edit compatibility admission rejects a Route Policy decision that requires isolation', () => {
    const location = store('repo-direct-route-conflict');
    const routeDecision = decideRoute({
      intent: { objective: 'Edit one file but require isolation.', scopeClear: true, mutation: true, explicitMode: 'direct' },
      workspace: { knownPaths: ['src/a.ts'], placement: 'isolated', directMainProhibited: true },
      policy: { risk: 'local_repo_write', approvalConfirmed: true },
      capabilities: {},
      recovery: {},
    });
    expect(routeDecision.executionMode).not.toBe('direct_control');
    expect(() => admitDirectEditWorkContract(location, {
      workId: 'work-direct-route-conflict',
      repoId: location.repoId,
      workspaceFingerprint: 'workspace-fingerprint',
      routeDecision,
      objective: 'Edit one file but require isolation.',
      allowedPaths: ['src/a.ts'],
      checks: [],
      requestedBy: 'chatgpt',
    })).toThrow(/DIRECT_EDIT_WORK_ROUTE_CONFLICT/);
  });
});
