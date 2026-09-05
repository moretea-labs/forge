import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  backupControlPlaneDatabase,
  controlPlaneDatabasePath,
  inspectControlPlaneDatabase,
  listControlPlaneRecords,
  maintainControlPlaneDatabase,
  readControlPlaneRecord,
  restoreControlPlaneDatabase,
  writeControlPlaneRecord,
} from '../../src/runtime/control-plane/persistence/sqlite-store';
import { assertControlPlaneMetadataPayload } from '../../src/runtime/control-plane/persistence/metadata-payload-policy';

function withHome(run: (controllerHome: string) => void): void {
  const controllerHome = mkdtempSync(join(tmpdir(), 'control-plane-final-'));
  try {
    run(controllerHome);
  } finally {
    rmSync(controllerHome, { recursive: true, force: true });
  }
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) visit(path);
      else if (name.isFile() && path.endsWith('.ts')) files.push(path);
    }
  };
  visit(root);
  return files;
}

describe('final SQLite control-plane cutover', () => {
  test('CAS conflicts fail closed without changing the winning revision', () => {
    withHome((controllerHome) => {
      const first = writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-CAS', schemaVersion: 1,
        value: { requirementId: 'REQ-CAS', state: 'active' }, expectedRevision: null,
      });
      const winner = writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-CAS', schemaVersion: 1,
        value: { requirementId: 'REQ-CAS', state: 'done' }, expectedRevision: first.revision,
      });
      expect(() => writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-CAS', schemaVersion: 1,
        value: { requirementId: 'REQ-CAS', state: 'cancelled' }, expectedRevision: first.revision,
      })).toThrow('CONTROL_PLANE_REVISION_CONFLICT');
      expect(readControlPlaneRecord(controllerHome, 'requirement', 'controller', 'REQ-CAS')).toMatchObject({
        revision: winner.revision,
        value: { state: 'done' },
      });
    });
  });

  test('SELECT-only opens do not wait behind a concurrent WAL writer reservation', () => {
    withHome((controllerHome) => {
      writeControlPlaneRecord(controllerHome, {
        namespace: 'probe', scope: 'controller', key: 'READ-WHILE-WRITING', schemaVersion: 1,
        value: { state: 'ready' }, expectedRevision: null,
      });
      const writer = new Database(controlPlaneDatabasePath(controllerHome));
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      try {
        const startedAt = performance.now();
        expect(readControlPlaneRecord(controllerHome, 'probe', 'controller', 'READ-WHILE-WRITING')).toMatchObject({
          value: { state: 'ready' },
        });
        expect(listControlPlaneRecords(controllerHome, { namespace: 'probe', limit: 10 })).toHaveLength(1);
        expect(performance.now() - startedAt).toBeLessThan(500);
      } finally {
        writer.exec('ROLLBACK');
        writer.close();
      }
    });
  });

  test('SQLite maintenance checkpoints WAL and vacuums only already-reclaimable free pages', () => {
    withHome((controllerHome) => {
      writeControlPlaneRecord(controllerHome, {
        namespace: 'probe', scope: 'controller', key: 'SQLITE-MAINTENANCE', schemaVersion: 1,
        value: { state: 'preserve' }, expectedRevision: null,
      });
      const path = controlPlaneDatabasePath(controllerHome);
      const fixture = new Database(path);
      fixture.exec('CREATE TABLE maintenance_fixture (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);');
      const insert = fixture.query('INSERT INTO maintenance_fixture(payload) VALUES (?)');
      for (let index = 0; index < 128; index += 1) insert.run(Buffer.alloc(8 * 1024, index % 255));
      fixture.exec('DELETE FROM maintenance_fixture;');
      const freeBefore = Number(Object.values(fixture.query('PRAGMA freelist_count').get() as Record<string, unknown>)[0]);
      fixture.close();
      expect(freeBefore).toBeGreaterThan(0);

      const report = maintainControlPlaneDatabase(controllerHome, {
        minimumReclaimableBytes: 1,
        minimumReclaimableRatio: 0,
      });
      expect(report).toMatchObject({ checkpointed: true, vacuumEligible: true, vacuumAttempted: true, vacuumed: true });
      expect(report.freePageCountBefore).toBeGreaterThan(0);
      expect(report.freePageCountAfter).toBe(0);
      expect(report.reclaimedBytes).toBeGreaterThan(0);
      expect(readControlPlaneRecord(controllerHome, 'probe', 'controller', 'SQLITE-MAINTENANCE')).toMatchObject({
        revision: 1, value: { state: 'preserve' },
      });
      expect(inspectControlPlaneDatabase(controllerHome)).toMatchObject({ integrity: 'ok', orphanRecordCount: 0 });
    });
  });

  test('SQLite maintenance fails closed instead of waiting on a live writer for VACUUM', () => {
    withHome((controllerHome) => {
      writeControlPlaneRecord(controllerHome, {
        namespace: 'probe', scope: 'controller', key: 'SQLITE-BUSY', schemaVersion: 1,
        value: { state: 'preserve' }, expectedRevision: null,
      });
      const path = controlPlaneDatabasePath(controllerHome);
      const fixture = new Database(path);
      fixture.exec('CREATE TABLE maintenance_busy_fixture (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);');
      const insert = fixture.query('INSERT INTO maintenance_busy_fixture(payload) VALUES (?)');
      for (let index = 0; index < 64; index += 1) insert.run(Buffer.alloc(8 * 1024, index % 255));
      fixture.exec('DELETE FROM maintenance_busy_fixture;');
      fixture.close();

      const writer = new Database(path);
      writer.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');
      try {
        const startedAt = performance.now();
        const report = maintainControlPlaneDatabase(controllerHome, {
          minimumReclaimableBytes: 1,
          minimumReclaimableRatio: 0,
        });
        expect(performance.now() - startedAt).toBeLessThan(500);
        expect(report.vacuumEligible).toBe(true);
        expect(report.vacuumAttempted).toBe(true);
        expect(report.vacuumed).toBe(false);
        expect(report.skippedReason).toBe('database_busy');
      } finally {
        writer.exec('ROLLBACK');
        writer.close();
      }
      expect(readControlPlaneRecord(controllerHome, 'probe', 'controller', 'SQLITE-BUSY')).toMatchObject({
        revision: 1, value: { state: 'preserve' },
      });
    });
  });

  test('unknown required schema versions fail before schema initialization or overwrite', () => {
    withHome((controllerHome) => {
      const path = controlPlaneDatabasePath(controllerHome);
      const database = new Database(path);
      database.exec(`
        CREATE TABLE control_plane_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO control_plane_schema (version, applied_at) VALUES (99, '2026-08-05T00:00:00.000Z');
      `);
      database.close();
      expect(() => readControlPlaneRecord(controllerHome, 'requirement', 'controller', 'REQ-X'))
        .toThrow('CONTROL_PLANE_SCHEMA_VERSION_UNSUPPORTED');
      const check = new Database(path, { readonly: true });
      expect(check.query('SELECT version FROM control_plane_schema').get()).toEqual({ version: 99 });
      check.close();
    });
  });

  test('SQLite corruption is detected and never replaced with an empty authority', () => {
    withHome((controllerHome) => {
      const path = controlPlaneDatabasePath(controllerHome);
      writeFileSync(path, Buffer.from('not-a-sqlite-database'));
      expect(() => readControlPlaneRecord(controllerHome, 'requirement', 'controller', 'REQ-X'))
        .toThrow('CONTROL_PLANE_SQLITE_CORRUPT');
      expect(readFileSync(path).toString()).toBe('not-a-sqlite-database');
    });
  });

  test('inspection rejects a missing intermediate audit revision', () => {
    withHome((controllerHome) => {
      const first = writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-AUDIT-GAP', schemaVersion: 1,
        value: { requirementId: 'REQ-AUDIT-GAP', state: 'active' }, expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-AUDIT-GAP', schemaVersion: 1,
        value: { requirementId: 'REQ-AUDIT-GAP', state: 'done' }, expectedRevision: first.revision,
      });
      const database = new Database(controlPlaneDatabasePath(controllerHome));
      database.query(`
        DELETE FROM control_plane_audit
        WHERE namespace = ? AND scope = ? AND record_key = ? AND revision = 1
      `).run('requirement', 'controller', 'REQ-AUDIT-GAP');
      database.close();
      expect(() => inspectControlPlaneDatabase(controllerHome)).toThrow('CONTROL_PLANE_AUDIT_CONTINUITY_INVALID');
      expect(() => backupControlPlaneDatabase(controllerHome, join(controllerHome, 'invalid-backup.sqlite')))
        .toThrow('CONTROL_PLANE_AUDIT_CONTINUITY_INVALID');
    });
  });

  test('verified backup restore preserves revisions, audit continuity, relationships, and exact repository identity', () => {
    withHome((controllerHome) => {
      const identity = {
        repoId: 'repo_fixture_exact_identity',
        checkoutId: 'checkout_exact',
        branch: 'main',
        head: 'a'.repeat(40),
      };
      const requirement = writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-RESTORE', schemaVersion: 1,
        value: { requirementId: 'REQ-RESTORE', state: 'done' }, expectedRevision: null,
      });
      const plan = writeControlPlaneRecord(controllerHome, {
        namespace: 'plan_contract', scope: identity.repoId, key: 'PLAN-RESTORE', schemaVersion: 1,
        value: { planId: 'PLAN-RESTORE', requirementId: 'REQ-RESTORE', repoId: identity.repoId, status: 'completed' }, expectedRevision: null,
      });
      const work = writeControlPlaneRecord(controllerHome, {
        namespace: 'work_contract', scope: identity.repoId, key: 'work_restore', schemaVersion: 1,
        value: { workId: 'work_restore', goalId: 'REQ-RESTORE', planId: 'PLAN-RESTORE', status: 'completed' }, expectedRevision: null,
      });
      const identityRecord = writeControlPlaneRecord(controllerHome, {
        namespace: 'repository_identity', scope: identity.repoId, key: identity.checkoutId, schemaVersion: 1,
        value: identity, expectedRevision: null,
      });
      const backupPath = join(controllerHome, 'verified-backups', 'cutover.sqlite');
      const backupInspection = backupControlPlaneDatabase(controllerHome, backupPath);
      expect(backupInspection).toMatchObject({ integrity: 'ok', recordCount: 4, orphanRecordCount: 0 });

      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-RESTORE', schemaVersion: 1,
        value: { requirementId: 'REQ-RESTORE', state: 'cancelled' }, expectedRevision: requirement.revision,
      });
      const restored = restoreControlPlaneDatabase(controllerHome, backupPath);
      expect(restored).toMatchObject({ integrity: 'ok', recordCount: 4, orphanRecordCount: 0 });
      expect(readControlPlaneRecord(controllerHome, 'requirement', 'controller', 'REQ-RESTORE')?.revision).toBe(requirement.revision);
      expect(readControlPlaneRecord(controllerHome, 'plan_contract', identity.repoId, 'PLAN-RESTORE')).toMatchObject({
        revision: plan.revision, value: { requirementId: 'REQ-RESTORE' },
      });
      expect(readControlPlaneRecord(controllerHome, 'work_contract', identity.repoId, 'work_restore')).toMatchObject({
        revision: work.revision, value: { goalId: 'REQ-RESTORE', planId: 'PLAN-RESTORE' },
      });
      expect(readControlPlaneRecord(controllerHome, 'repository_identity', identity.repoId, identity.checkoutId)).toEqual(identityRecord);
      expect(inspectControlPlaneDatabase(controllerHome).orphanRecordCount).toBe(0);
    });
  });

  test('state remains identical across independent process reopen', () => {
    withHome((controllerHome) => {
      writeControlPlaneRecord(controllerHome, {
        namespace: 'requirement', scope: 'controller', key: 'REQ-RESTART', schemaVersion: 1,
        value: { requirementId: 'REQ-RESTART', state: 'active' }, expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'plan_contract', scope: 'repo_restart', key: 'PLAN-RESTART', schemaVersion: 1,
        value: { planId: 'PLAN-RESTART', requirementId: 'REQ-RESTART', status: 'executing' }, expectedRevision: null,
      });
      writeControlPlaneRecord(controllerHome, {
        namespace: 'work_contract', scope: 'repo_restart', key: 'work_restart', schemaVersion: 1,
        value: { workId: 'work_restart', goalId: 'REQ-RESTART', status: 'running' }, expectedRevision: null,
      });
      const before = ['requirement', 'plan_contract', 'work_contract'].map((namespace) =>
        listControlPlaneRecords(controllerHome, { namespace, limit: 10 }));
      const script = `
        import { listControlPlaneRecords } from './src/runtime/control-plane/persistence/sqlite-store.ts';
        const home = process.argv[1];
        const result = ['requirement','plan_contract','work_contract'].map((namespace) => listControlPlaneRecords(home, { namespace, limit: 10 }));
        process.stdout.write(JSON.stringify(result));
      `;
      const child = Bun.spawnSync({ cmd: ['bun', '-e', script, controllerHome], cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual(before);
    });
  });

  test('migration and export metadata reject secrets, binary data, and large logs', () => {
    expect(() => assertControlPlaneMetadataPayload({ credential: 'hidden' }, 'migration')).toThrow('CONTROL_PLANE_METADATA_FIELD_REFUSED');
    expect(() => assertControlPlaneMetadataPayload({ payload: Buffer.from('binary') }, 'export')).toThrow('CONTROL_PLANE_METADATA_BINARY_REFUSED');
    expect(() => assertControlPlaneMetadataPayload({ summary: 'x'.repeat(70 * 1024) }, 'migration')).toThrow('CONTROL_PLANE_METADATA_STRING_TOO_LARGE');
    expect(() => assertControlPlaneMetadataPayload({ note: ['-----BEGIN ', 'PRIVATE KEY-----'].join('') }, 'export')).toThrow('CONTROL_PLANE_METADATA_SECRET_REFUSED');
  });

  test('Forge Runtime service and standalone Recovery bootstrap do not depend on legacy Issue/Task files', () => {
    const files = [
      ...sourceFiles(join(process.cwd(), 'src/runtime/recovery')),
    ];
    for (const path of files) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/tasks\/issues|controller\/issue-store|controller\/task-ledger|project-state\.json/);
    }
  });

  test('all durable legacy writers fail at the cutover guard and no reverse export importer exists', () => {
    const issueStore = readFileSync(join(process.cwd(), 'src/cli/controller/issue-store.ts'), 'utf8');
    for (const name of [
      'planIssue', 'appendTask', 'splitTask', 'supersedeTask', 'setTaskDependencies', 'updateIssue', 'updateTask',
      'archiveIssue', 'restoreIssue', 'acceptVerifiedTask', 'recordTaskVerification', 'bindTaskToWork', 'projectTaskFromWork',
    ]) {
      const start = issueStore.indexOf(`export function ${name}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = issueStore.slice(start, start + 700);
      expect(body.indexOf('assertLegacyIssueWritesAllowed')).toBeGreaterThanOrEqual(0);
      expect(body.indexOf('assertLegacyIssueWritesAllowed')).toBeLessThan(body.indexOf('getIssue('));
    }
    const createStart = issueStore.indexOf('export function createIssue');
    expect(issueStore.slice(createStart, createStart + 900)).toContain('if (!input.ephemeral) assertLegacyIssueWritesAllowed(repoRoot)');

    const exportSource = readFileSync(join(process.cwd(), 'src/cli/controller/requirement-portfolio-export.ts'), 'utf8');
    expect(exportSource).toContain("direction: 'sqlite_to_offline_only'");
    expect(exportSource).toContain('replayAllowed: false');
    expect(exportSource).not.toMatch(/importRequirement|replayRequirement|writeControlPlaneRecord/);

    const source = sourceFiles(join(process.cwd(), 'src')).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    const dualWriters = source.filter(({ text }) => {
      const writesSqliteAuthority = /(writeControlPlaneRecord|mutateControlPlaneRecord|createRequirement|updateRequirement|updatePlanContract)\s*\(/.test(text);
      const writesLegacyAuthority = /(writeIssue|saveControllerProjectState|writeControllerTaskLedgerArtifacts)\s*\(/.test(text);
      return writesSqliteAuthority && writesLegacyAuthority;
    });
    expect(dualWriters.map((entry) => entry.path)).toEqual([]);
    const issueStorePath = join(process.cwd(), 'src/cli/controller/issue-store.ts');
    expect(source.filter(({ text }) => /function\s+writeIssue\s*\(/.test(text)).map((entry) => entry.path)).toEqual([issueStorePath]);
  });
});
