import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  controlPlaneDatabasePath,
  mutateControlPlaneRecord,
  readControlPlaneRecord,
  readOrImportControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import { readWorkHandle } from '../../src/runtime/control-plane/execution/work-handle-store';
import { createWorkContract, getWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';

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
});
