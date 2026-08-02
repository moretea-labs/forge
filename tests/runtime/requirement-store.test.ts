import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { backupControlPlaneDatabase, restoreControlPlaneDatabase } from '../../src/runtime/control-plane/persistence/sqlite-store';
import { createRequirement, readRequirement, setRequirementPlan, updateRequirement } from '../../src/runtime/control-plane/persistence/requirement-store';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('keeps user Requirement lifecycle separate from its active technical plan', () => {
  const home = mkdtempSync(join('/tmp', 'repo-harness-requirement-'));
  homes.push(home);
  const options = { controllerHome: home, now: () => '2026-08-02T00:00:00.000Z' };
  const requirement = createRequirement(options, {
    requirementId: 'req-1',
    title: 'Restore service safely',
    outcomeStatement: 'The service remains available after supervisor restart.',
    acceptanceCriteria: ['health endpoint is available'],
  });
  expect(requirement.state).toBe('planned');

  const planned = setRequirementPlan(options, { requirementId: 'req-1', planId: 'plan-1' });
  expect(planned.state).toBe('planned');
  expect(planned.activePlanId).toBe('plan-1');

  const active = updateRequirement(options, {
    requirementId: 'req-1',
    action: 'requirement_activated',
    mutate: (current) => ({ ...current, state: 'active' }),
  });
  expect(active.state).toBe('active');
  expect(active.revision).toBe(3);
  expect(readRequirement(options, 'req-1')?.revision).toBe(3);
});

test('rejects reopening a completed Requirement without an explicit replacement state', () => {
  const home = mkdtempSync(join('/tmp', 'repo-harness-requirement-'));
  homes.push(home);
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-2', title: 'Outcome', outcomeStatement: 'Outcome statement' });
  updateRequirement(options, { requirementId: 'req-2', action: 'activate', mutate: (current) => ({ ...current, state: 'active' }) });
  updateRequirement(options, { requirementId: 'req-2', action: 'complete', mutate: (current) => ({ ...current, state: 'done' }) });
  expect(() => updateRequirement(options, { requirementId: 'req-2', action: 'reopen', mutate: (current) => ({ ...current, state: 'active' }) })).toThrow(/REQUIREMENT_STATE_TRANSITION_INVALID/);
});

test('restores a verified SQLite backup without losing Requirement authority', () => {
  const home = mkdtempSync(join('/tmp', 'repo-harness-requirement-'));
  homes.push(home);
  const backup = join(home, 'backup.sqlite');
  const options = { controllerHome: home };
  createRequirement(options, { requirementId: 'req-backup', title: 'Backup', outcomeStatement: 'Restore this state' });
  backupControlPlaneDatabase(home, backup);
  updateRequirement(options, { requirementId: 'req-backup', action: 'activate', mutate: (current) => ({ ...current, state: 'active' }) });
  restoreControlPlaneDatabase(home, backup);
  expect(readRequirement(options, 'req-backup')?.value.state).toBe('planned');
});
