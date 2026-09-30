import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { openControlPlaneDatabaseChangeObserver, withControlPlaneTransaction } from '../../src/runtime/control-plane/persistence/sqlite-store';
import {
  ensureActiveRuntimeRelease,
  migrateRuntimeReleaseAuthorityState,
  prepareRuntimeReleaseDatabaseBackup,
  publishRuntimeRelease,
  readRuntimeReleaseAuthority,
  rollbackRuntimeRelease,
  rollbackRuntimeReleaseWithResult,
} from '../../src/runtime/root/release-store';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const controllerHome = mkdtempSync(join(tmpdir(), 'runtime-release-store-'));
  roots.push(controllerHome);
  const manifests = join(controllerHome, 'manifests');
  mkdirSync(manifests, { recursive: true });
  const manifest = (releaseId: string, artifactIdentity: string, protocol = 1) => {
    const path = join(manifests, `${releaseId}.json`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      releaseId,
      artifactIdentity,
      entrypoint: 'forge-runtime',
      arguments: [],
      configurationSchemaVersion: 1,
      controllerHome: resolve(controllerHome),
      databaseSchemaCompatibility: { minimum: 1, maximum: 1 },
      workerProtocolVersion: protocol,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return path;
  };
  return { controllerHome, manifest };
}

describe('whole Runtime release store', () => {
  test('initializes one active authority and rejects a mismatched startup manifest', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b');
    expect(ensureActiveRuntimeRelease(fx.controllerHome, first)).toMatchObject({ revision: 1, active: { releaseId: 'release-a' } });
    expect(() => ensureActiveRuntimeRelease(fx.controllerHome, second)).toThrow(/RUNTIME_RELEASE_AUTHORITY_MISMATCH/);
  });

  test('migrates v1 authority once and removes historical activation state from the physical pointer store', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b');
    ensureActiveRuntimeRelease(fx.controllerHome, first);
    const dependencies = {
      backupDatabase: (_home: string, path: string) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'sqlite-backup');
        return { path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 };
      },
      restoreDatabase: (_home: string, path: string) => ({ path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 }),
    };
    publishRuntimeRelease(fx.controllerHome, second, 'publish-b', dependencies);
    const authorityPath = join(fx.controllerHome, 'runtime', 'releases', 'authority.json');
    const raw = JSON.parse(readFileSync(authorityPath, 'utf8')) as Record<string, any>;
    raw.schemaVersion = 1;
    raw.activation = {
      schemaVersion: 1,
      operationId: 'physical-cutover',
      releaseSessionId: 'release-session-legacy-1234',
      candidateReleaseId: raw.active.releaseId,
      preActivationRevision: 1,
      preActivationActive: raw.previous,
      startedAt: raw.committedAt,
    };
    writeFileSync(authorityPath, `${JSON.stringify(raw, null, 2)}\n`);

    expect(readRuntimeReleaseAuthority(fx.controllerHome)).toBeUndefined();
    const migrated = migrateRuntimeReleaseAuthorityState(fx.controllerHome);
    expect(migrated).toMatchObject({ schemaVersion: 2, active: { releaseId: 'release-b' } });
    expect(migrated as unknown as Record<string, unknown>).not.toHaveProperty('activation');
    expect(migrateRuntimeReleaseAuthorityState(fx.controllerHome)).toMatchObject({ schemaVersion: 2, revision: migrated?.revision });
  });

  test('database-wide change observation notices direct domain-table commits outside control_plane_audit', () => {
    const fx = fixture();
    withControlPlaneTransaction(fx.controllerHome, (database) => {
      database.exec('CREATE TABLE direct_domain_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    });
    const observer = openControlPlaneDatabaseChangeObserver(fx.controllerHome);
    try {
      const before = observer.dataVersion();
      withControlPlaneTransaction(fx.controllerHome, (database) => {
        database.exec("INSERT INTO direct_domain_state (value) VALUES ('changed')");
      });
      expect(observer.dataVersion()).toBeGreaterThan(before);
    } finally {
      observer.close();
    }
  });

  test('reuses a prepared rollback database snapshot when no SQLite commit occurs before publish', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b');
    ensureActiveRuntimeRelease(fx.controllerHome, first);
    let dataVersion = 7;
    let observerCloses = 0;
    const backups: string[] = [];
    const dependencies = {
      backupDatabase: (_home: string, path: string) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `sqlite-backup-${backups.length}`);
        backups.push(path);
        return { path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 3, auditEventCount: 5, orphanRecordCount: 0 };
      },
      restoreDatabase: (_home: string, path: string) => ({ path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 3, auditEventCount: 5, orphanRecordCount: 0 }),
      openDatabaseChangeObserver: () => ({
        path: join(fx.controllerHome, 'control-plane.sqlite'),
        dataVersion: () => dataVersion,
        close: () => { observerCloses += 1; },
      }),
    };
    const prepared = prepareRuntimeReleaseDatabaseBackup(fx.controllerHome, 'publish-b', dependencies);
    expect(prepared).toBeDefined();
    const published = publishRuntimeRelease(fx.controllerHome, second, 'publish-b', dependencies, prepared);
    expect(backups).toHaveLength(1);
    expect(published.previous?.databaseBackup?.path).toBe(resolve(backups[0]!));
    expect(observerCloses).toBe(1);
    expect(dataVersion).toBe(7);
  });

  test('discards a prepared snapshot and falls back to a stopped backup after any SQLite commit', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b');
    ensureActiveRuntimeRelease(fx.controllerHome, first);
    let dataVersion = 11;
    const backups: string[] = [];
    const dependencies = {
      backupDatabase: (_home: string, path: string) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `sqlite-backup-${backups.length}`);
        backups.push(path);
        return { path, integrity: 'ok' as const, schemaVersion: 1, recordCount: backups.length, auditEventCount: backups.length, orphanRecordCount: 0 };
      },
      restoreDatabase: (_home: string, path: string) => ({ path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 }),
      openDatabaseChangeObserver: () => ({
        path: join(fx.controllerHome, 'control-plane.sqlite'),
        dataVersion: () => dataVersion,
        close: () => undefined,
      }),
    };
    const prepared = prepareRuntimeReleaseDatabaseBackup(fx.controllerHome, 'publish-b', dependencies);
    expect(prepared).toBeDefined();
    const speculativePath = prepared!.path;
    dataVersion += 1;
    const published = publishRuntimeRelease(fx.controllerHome, second, 'publish-b', dependencies, prepared);
    expect(backups).toHaveLength(2);
    expect(existsSync(speculativePath)).toBe(false);
    expect(published.previous?.databaseBackup?.path).toBe(resolve(backups[1]!));
  });

  test('rollback preserves live SQLite state when a non-audited domain table changed after cutover', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b');
    ensureActiveRuntimeRelease(fx.controllerHome, first);
    withControlPlaneTransaction(fx.controllerHome, (database) => {
      database.exec("CREATE TABLE direct_domain_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO direct_domain_state (id, value) VALUES (1, 'before')");
    });
    const published = publishRuntimeRelease(fx.controllerHome, second, 'publish-b');
    expect(published.previous?.databaseBackup?.databaseSha256).toMatch(/^[a-f0-9]{64}$/);
    const rollbackAuditCount = published.previous!.databaseBackup!.auditEventCount;
    withControlPlaneTransaction(fx.controllerHome, (database) => {
      database.exec("UPDATE direct_domain_state SET value = 'after' WHERE id = 1");
    });
    const rolled = rollbackRuntimeReleaseWithResult(fx.controllerHome, 'rollback-a');
    expect(rolled.databaseDisposition).toBe('preserved_newer_live_state');
    expect(rollbackAuditCount).toBeDefined();
    expect(rolled.liveAuditEventCount).toBe(rollbackAuditCount!);
    const value = withControlPlaneTransaction(fx.controllerHome, (database) => {
      const statement = database.prepare('SELECT value FROM direct_domain_state WHERE id = 1');
      try { return (statement.get() as { value: string }).value; }
      finally { statement.finalize?.(); }
    });
    expect(value).toBe('after');
  });

  test('real unchanged SQLite snapshots retain identical whole-database identity and restore on rollback', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b');
    ensureActiveRuntimeRelease(fx.controllerHome, first);
    withControlPlaneTransaction(fx.controllerHome, (database) => {
      database.exec("CREATE TABLE direct_domain_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO direct_domain_state (id, value) VALUES (1, 'stable')");
    });
    const published = publishRuntimeRelease(fx.controllerHome, second, 'publish-b');
    const rollbackHash = published.previous?.databaseBackup?.databaseSha256;
    expect(rollbackHash).toMatch(/^[a-f0-9]{64}$/);
    const rolled = rollbackRuntimeReleaseWithResult(fx.controllerHome, 'rollback-a');
    expect(rolled.databaseDisposition).toBe('restored_backup');
    expect(rolled.authority.active.releaseId).toBe('release-a');
    expect(rolled.authority.previous?.databaseBackup?.databaseSha256).toBe(rollbackHash);
  });

  test('publishes and rolls back the whole Runtime with database backups', () => {
    const fx = fixture();
    const first = fx.manifest('release-a', 'artifact-a');
    const second = fx.manifest('release-b', 'artifact-b', 2);
    ensureActiveRuntimeRelease(fx.controllerHome, first);
    const backups: string[] = [];
    const restores: string[] = [];
    const dependencies = {
      backupDatabase: (_home: string, path: string) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'sqlite-backup');
        backups.push(path);
        return { path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 };
      },
      restoreDatabase: (_home: string, path: string) => {
        restores.push(path);
        expect(readFileSync(path, 'utf8')).toBe('sqlite-backup');
        return { path, integrity: 'ok' as const, schemaVersion: 1, recordCount: 0, auditEventCount: 0, orphanRecordCount: 0 };
      },
    };
    const published = publishRuntimeRelease(fx.controllerHome, second, 'publish-b', dependencies);
    expect(published).toMatchObject({ revision: 2, active: { releaseId: 'release-b', workerProtocolVersion: 2 }, previous: { releaseId: 'release-a' } });
    expect(published.previous?.databaseBackup?.path).toBe(backups[0]);
    const rolled = rollbackRuntimeRelease(fx.controllerHome, 'rollback-a', dependencies);
    expect(rolled).toMatchObject({ revision: 3, active: { releaseId: 'release-a' }, previous: { releaseId: 'release-b' } });
    expect(restores).toEqual([published.previous!.databaseBackup!.path]);
    expect(readRuntimeReleaseAuthority(fx.controllerHome)?.active.releaseId).toBe('release-a');
  });
});
