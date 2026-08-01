import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  controlPlaneDatabasePath,
  mutateControlPlaneRecord,
  readControlPlaneRecord,
  readOrImportControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import { readWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { createWorkContract, getWorkContract, updateWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controllerHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'repo-harness-sqlite-store-'));
  roots.push(home);
  return home;
}

describe('control-plane SQLite persistence', () => {
  test('imports legacy data exactly once, then makes SQLite authoritative', () => {
    const home = controllerHome();
    const first = readOrImportControlPlaneRecord(home, {
      namespace: 'test',
      scope: 'repo-a',
      key: 'record-a',
      schemaVersion: 1,
      readLegacy: () => ({ value: 'legacy' }),
    });
    expect(first?.value).toEqual({ value: 'legacy' });

    const second = readOrImportControlPlaneRecord(home, {
      namespace: 'test',
      scope: 'repo-a',
      key: 'record-a',
      schemaVersion: 1,
      readLegacy: () => ({ value: 'stale legacy rewrite must not win' }),
    });
    expect(second?.value).toEqual({ value: 'legacy' });
    expect(second?.revision).toBe(1);

    expect(existsSync(controlPlaneDatabasePath(home))).toBe(true);
    const database = new Database(controlPlaneDatabasePath(home), { readonly: true });
    const row = database.query('SELECT action, revision FROM control_plane_audit').get() as { action: string; revision: number };
    database.close();
    expect(row).toEqual({ action: 'legacy_import', revision: 1 });
  });

  test('rolls back a failed mutation without replacing known-good state', () => {
    const home = controllerHome();
    mutateControlPlaneRecord(home, {
      namespace: 'test', scope: 'repo-a', key: 'record-a', schemaVersion: 1, action: 'seed',
      mutate: () => ({ status: 'known-good' }),
    });
    expect(() => mutateControlPlaneRecord(home, {
      namespace: 'test', scope: 'repo-a', key: 'record-a', schemaVersion: 1, action: 'broken-migration',
      mutate: () => { throw new Error('simulated migration failure'); },
    })).toThrow('simulated migration failure');
    expect(readControlPlaneRecord<{ status: string }>(home, 'test', 'repo-a', 'record-a')?.value).toEqual({ status: 'known-good' });
  });

  test('imports a legacy Work handle but ignores later changes to its JSON projection', () => {
    const home = controllerHome();
    const repoId = 'repo-sqlite-migration';
    const workId = 'work-legacy-import';
    const path = join(home, 'repositories', repoId, 'work-handles', `${workId}.json`);
    mkdirSync(join(home, 'repositories', repoId, 'work-handles'), { recursive: true });
    const legacy = {
      schemaVersion: 1,
      workId,
      sessionId: 'session-legacy',
      principalId: 'principal-legacy',
      repositoryId: repoId,
      checkoutId: 'checkout-legacy',
      worktreePath: '/tmp/legacy-worktree',
      branch: 'legacy-branch',
      managedWorktree: false,
      permissionSnapshotVersion: 1,
      state: 'prepared',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      finalization: { validation: 'pending', commit: 'pending', merge: 'pending', branchCleanup: 'pending', worktreeCleanup: 'pending' },
    };
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);
    expect(readWorkHandle(home, repoId, workId)?.branch).toBe('legacy-branch');

    writeFileSync(path, `${JSON.stringify({ ...legacy, branch: 'tampered-json-projection' })}\n`);
    expect(readWorkHandle(home, repoId, workId)?.branch).toBe('legacy-branch');
  });

  test('keeps a WorkContract in SQLite after a stale legacy index appears', () => {
    const home = controllerHome();
    const repoId = 'repo-work-contract-sqlite';
    const work = createWorkContract({ controllerHome: home, repoId }, {
      workId: 'work-sqlite-authority',
      repoId,
      mode: 'direct_control',
      objective: 'Keep Work authority out of a JSON index',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
    });
    const legacyIndex = join(home, 'repositories', repoId, 'work-contracts', 'index.json');
    mkdirSync(join(home, 'repositories', repoId, 'work-contracts'), { recursive: true });
    writeFileSync(legacyIndex, `${JSON.stringify({ schemaVersion: 1, updatedAt: '2020-01-01T00:00:00.000Z', contracts: [] })}\n`);
    expect(getWorkContract({ controllerHome: home, repoId }, work.workId)?.objective).toBe(work.objective);
  });

  test('normalizes schema-v1 Work semantics in memory and persists v2 only on mutation', () => {
    const root = controllerHome();
    const repoId = 'repo-work-contract-v1';
    const work = createWorkContract({ root }, {
      workId: 'work-v1-normalization', repoId, mode: 'direct_control', objective: 'Migrate without destructive read',
      acceptanceCriteria: [], constraints: { requireHandoffOnAmbiguity: true }, allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'chatgpt',
    });
    const path = join(root, 'index.json');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { contracts: Array<Record<string, unknown>> };
    stored.contracts[0]!.schemaVersion = 1;
    delete stored.contracts[0]!.workKind;
    delete stored.contracts[0]!.dispatchState;
    delete stored.contracts[0]!.evidenceState;
    writeFileSync(path, `${JSON.stringify(stored)}\n`);

    const normalized = getWorkContract({ root }, work.workId)!;
    expect(normalized).toMatchObject({ schemaVersion: 1, workKind: 'repository_change', dispatchState: 'not_dispatched', evidenceState: 'none' });
    expect(JSON.parse(readFileSync(path, 'utf8')).contracts[0].schemaVersion).toBe(1);

    const migrated = updateWorkContract({ root }, work.workId, { status: 'running' });
    expect(migrated).toMatchObject({ schemaVersion: 2, dispatchState: 'running' });
    expect(JSON.parse(readFileSync(path, 'utf8')).contracts[0].schemaVersion).toBe(2);
  });

  test('rejects impossible explicit completion combinations', () => {
    const root = controllerHome();
    expect(() => createWorkContract({ root }, {
      workId: 'work-invalid-outcome', repoId: 'repo-invalid-outcome', mode: 'direct_control', objective: 'Reject invalid outcome',
      acceptanceCriteria: [], constraints: { requireHandoffOnAmbiguity: true }, allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'chatgpt',
      status: 'completed', workKind: 'completed_no_change', dispatchState: 'terminal', evidenceState: 'valid', completionOutcome: 'completed_changed',
    })).toThrow('WORK_SEMANTICS_INVALID');
  });

  test('rejects semantic state regressions after a terminal dispatch', () => {
    const root = controllerHome();
    const work = createWorkContract({ root }, {
      workId: 'work-terminal-state', repoId: 'repo-terminal-state', mode: 'direct_control', objective: 'Reject lifecycle regression',
      acceptanceCriteria: [], constraints: { requireHandoffOnAmbiguity: true }, allowedPaths: [], forbiddenPaths: [], checks: [], requestedBy: 'chatgpt',
    });
    updateWorkContract({ root }, work.workId, { status: 'completed' });
    expect(() => updateWorkContract({ root }, work.workId, { status: 'running' })).toThrow('WORK_SEMANTICS_TRANSITION_INVALID');
  });
});
