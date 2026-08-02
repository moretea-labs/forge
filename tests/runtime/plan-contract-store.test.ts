import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import {
  approvePlanContract,
  createPlanContract,
  getPlanContract,
  listPlanContracts,
} from '../../src/runtime/control-plane/facade/plan-contract-store';
import {
  ControlPlaneConflictError,
  listControlPlaneRecords,
  readControlPlaneRecord,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('persists facade Plan contracts as independently revisioned SQLite records', () => {
  const home = mkdtempSync(join('/tmp', 'repo-harness-plan-store-'));
  homes.push(home);
  const options = { controllerHome: home, repoId: 'repo-1', now: () => '2026-08-02T00:00:00.000Z' };
  const plan = createPlanContract(options, {
    planId: 'plan-1',
    repoId: 'repo-1',
    scopeKey: 'runtime',
    sourceRevision: 'abc123',
    goal: 'freeze authority',
    steps: [{ id: 'step-1', objective: 'define schema', dependencies: [], authoritativeFiles: [], allowedPaths: [], forbiddenPaths: [], checks: ['typecheck'], acceptanceCriteria: ['schema is explicit'] }],
  });

  expect(getPlanContract(options, 'plan-1')).toEqual(plan);
  expect(listPlanContracts({ ...options, status: 'all' })).toHaveLength(1);
  expect(listControlPlaneRecords(options.controllerHome, { namespace: 'plan_contract', scope: 'repo-1' })).toHaveLength(1);

  const approved = approvePlanContract(options, 'plan-1');
  expect(approved.status).toBe('approved');
  expect(readControlPlaneRecord(options.controllerHome, 'plan_contract', 'repo-1', 'plan-1')?.revision).toBe(2);
});

test('rejects a second create and stale writer without changing the authoritative row', () => {
  const home = mkdtempSync(join('/tmp', 'repo-harness-plan-store-'));
  homes.push(home);
  const options = { controllerHome: home };
  const value = { planId: 'plan-1', repoId: 'repo-1', scopeKey: 'runtime', sourceRevision: 'abc', goal: 'goal', nonGoals: [], assumptions: [], resolvedDecisions: [], stopConditions: [], replanConditions: [], status: 'draft' as const, steps: [], evidenceRefs: [], createdAt: 'now', updatedAt: 'now', schemaVersion: 1 as const };
  writeControlPlaneRecord(home, { namespace: 'plan_contract', scope: 'repo-1', key: 'plan-1', schemaVersion: 1, value, expectedRevision: null, action: 'seed' });

  expect(() => writeControlPlaneRecord(home, { namespace: 'plan_contract', scope: 'repo-1', key: 'plan-1', schemaVersion: 1, value, expectedRevision: null, action: 'duplicate' })).toThrow(ControlPlaneConflictError);
  expect(() => writeControlPlaneRecord(home, { namespace: 'plan_contract', scope: 'repo-1', key: 'plan-1', schemaVersion: 1, value, expectedRevision: 99, action: 'stale' })).toThrow(ControlPlaneConflictError);
  expect(readControlPlaneRecord(home, 'plan_contract', 'repo-1', 'plan-1')?.revision).toBe(1);
});
