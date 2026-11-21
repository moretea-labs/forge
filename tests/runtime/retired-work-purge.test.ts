import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectRetiredWorkPurge,
  purgeRetiredWork,
  RETIRED_WORK_NAMESPACES,
} from '../../src/runtime/control-plane/persistence/retired-work-purge';
import {
  readControlPlaneRecord,
  withControlPlaneReadDatabase,
  withControlPlaneTransaction,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('full retired Work data erasure', () => {
  test('deletes old records and their audit chain without touching Plan, Process or UserRequest', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-purge-'));
    tempRoots.push(home);
    for (const namespace of RETIRED_WORK_NAMESPACES) {
      writeControlPlaneRecord(home, {
        namespace,
        scope: 'repo-1',
        key: 'old-work',
        schemaVersion: 1,
        value: { legacyWorkId: 'old-work' },
        expectedRevision: null,
      });
      writeControlPlaneRecord(home, {
        namespace,
        scope: 'repo-1',
        key: 'old-work',
        schemaVersion: 1,
        value: { legacyWorkId: 'old-work', revision: 2 },
        expectedRevision: 1,
      });
    }
    for (const namespace of ['plan_contract', 'process_request_binding', 'user_request']) {
      writeControlPlaneRecord(home, {
        namespace,
        scope: 'repo-1',
        key: 'retain',
        schemaVersion: 1,
        value: { id: namespace },
        expectedRevision: null,
      });
    }
    withControlPlaneTransaction(home, (db) => {
      for (const namespace of RETIRED_WORK_NAMESPACES) {
        db.prepare(
          'INSERT INTO control_plane_audit_floor(namespace,scope,record_key,floor_revision,updated_at) VALUES(?,?,?,?,?)',
        ).run(namespace, 'repo-1', 'old-work', 2, '2026-11-21');
        db.prepare(
          'INSERT INTO control_plane_audit_record_cursor(name,namespace,scope,record_key,updated_at) VALUES(?,?,?,?,?)',
        ).run('cursor-' + namespace, namespace, 'repo-1', 'old-work', '2026-11-21');
      }
    });
    const dir = join(home, 'repositories', 'repo-1', 'work-handles');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old-work.json'), '{}');
    const oldIndex = join(home, 'indexes', 'work-contracts', 'requests');
    mkdirSync(oldIndex, { recursive: true });
    writeFileSync(join(oldIndex, 'legacy.json'), '{}');
    const preview = inspectRetiredWorkPurge(home);
    expect(preview).toMatchObject({
      applied: false,
      records: 3,
      auditEvents: 6,
      auditFloors: 3,
      auditRecordCursors: 3,
    });
    expect(preview.directories).toHaveLength(2);
    const erased = purgeRetiredWork(home);
    expect(erased).toMatchObject({ applied: true, records: 3, auditEvents: 6 });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(oldIndex)).toBe(false);
    // No retained raw Work payload in compacted SQLite pages/WAL.
    expect(readFileSync(join(home, 'control-plane.sqlite')).includes(Buffer.from('legacyWorkId'))).toBe(false);
    const wal = join(home, 'control-plane.sqlite-wal');
    if (existsSync(wal)) expect(readFileSync(wal).length).toBe(0);
    expect(inspectRetiredWorkPurge(home)).toMatchObject({
      applied: false,
      records: 0,
      auditEvents: 0,
      auditFloors: 0,
      auditRecordCursors: 0,
      directories: [],
    });
    expect(
      withControlPlaneReadDatabase(home, (db) =>
        RETIRED_WORK_NAMESPACES.map((namespace) =>
          db.prepare('SELECT COUNT(*) AS count FROM control_plane_audit WHERE namespace = ?').get(namespace),
        ),
      ),
    ).toEqual([{ count: 0 }, { count: 0 }, { count: 0 }]);
    for (const namespace of ['plan_contract', 'process_request_binding', 'user_request']) {
      expect(readControlPlaneRecord(home, namespace, 'repo-1', 'retain')?.value).toEqual({ id: namespace });
    }
    expect(purgeRetiredWork(home)).toMatchObject({ applied: true, records: 0, auditEvents: 0 });
  });

  test('CLI defaults to preview, refuses active-Runtime apply and erases only with offline flag', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-retired-work-cli-'));
    tempRoots.push(home);
    writeControlPlaneRecord(home, {
      namespace: 'work_contract',
      scope: 'repo-cli',
      key: 'legacy-id',
      schemaVersion: 1,
      value: { objective: 'retired' },
      expectedRevision: null,
    });
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['bin/forge.mjs', 'runtime', 'purge-retired-work', '--controller-home', home, ...args],
        { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 15_000 },
      );
    const preview = run();
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ applied: false, records: 1 });
    expect(readControlPlaneRecord(home, 'work_contract', 'repo-cli', 'legacy-id')).toBeDefined();
    const denied = run('--apply');
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('RETIRED_WORK_PURGE_REQUIRES_STOPPED_RUNTIME');
    const applied = run('--apply', '--runtime-stopped');
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, records: 1 });
    expect(readControlPlaneRecord(home, 'work_contract', 'repo-cli', 'legacy-id')).toBeUndefined();
  });

  test('does not create a database for an empty Controller Home', () => {
    const home = mkdtempSync(join(tmpdir(), 'forge-empty-retired-purge-'));
    tempRoots.push(home);
    expect(purgeRetiredWork(home)).toMatchObject({ records: 0, auditEvents: 0, directories: [] });
    expect(existsSync(join(home, 'control-plane.sqlite'))).toBe(false);
  });
});
